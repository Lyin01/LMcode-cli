import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  McpConfigFileError,
  loadEffectiveMcpServers,
  removeEffectiveMcpServer,
  resolveMcpConfigSources,
  upsertUserMcpServer,
} from '#/tui/utils/mcp-config';

let root: string;
let dataDir: string;
let workDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-mcp-config-'));
  dataDir = path.join(root, 'home');
  workDir = path.join(root, 'repo', 'packages', 'app');
  await fs.mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('MCP config layering', () => {
  it('uses the nearest project declaration and records every shadowed source', async () => {
    const sources = resolveMcpConfigSources({ dataDir, workDir });
    const user = sources[0]!;
    const repo = sources.find((source) => source.filePath === path.join(root, 'repo', '.lmcode', 'mcp.json'))!;
    const project = sources.at(-1)!;
    await writeJson(user.filePath, {
      mcpServers: { shared: { transport: 'stdio', command: 'user' } },
    });
    await writeJson(repo.filePath, {
      mcpServers: { shared: { transport: 'stdio', command: 'repo' } },
    });
    await writeJson(project.filePath, {
      mcpServers: { shared: { transport: 'stdio', command: 'project' } },
    });

    const effective = await loadEffectiveMcpServers({ dataDir, workDir });

    expect(effective.get('shared')).toEqual({
      name: 'shared',
      config: { transport: 'stdio', command: 'project' },
      source: project,
      shadowedSources: [user, repo],
    });
  });

  it('removes only the effective override and exposes the lower-priority declaration', async () => {
    const sources = resolveMcpConfigSources({ dataDir, workDir });
    const user = sources[0]!;
    const project = sources.at(-1)!;
    await writeJson(user.filePath, {
      owner: 'preserved',
      mcpServers: {
        shared: { transport: 'stdio', command: 'user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(project.filePath, {
      projectSetting: true,
      mcpServers: {
        shared: { transport: 'stdio', command: 'project' },
        local: { transport: 'stdio', command: 'local' },
      },
    });

    const result = await removeEffectiveMcpServer({ dataDir, workDir }, 'shared');

    expect(result.removed?.source).toEqual(project);
    expect(result.next?.source).toEqual(user);
    expect(result.next?.config).toEqual({ transport: 'stdio', command: 'user' });
    expect(JSON.parse(await fs.readFile(project.filePath, 'utf-8'))).toEqual({
      projectSetting: true,
      mcpServers: {
        local: { transport: 'stdio', command: 'local' },
      },
    });
    expect(JSON.parse(await fs.readFile(user.filePath, 'utf-8'))).toEqual({
      owner: 'preserved',
      mcpServers: {
        shared: { transport: 'stdio', command: 'user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
  });

  it('rejects malformed user JSON without overwriting the original bytes', async () => {
    const userPath = path.join(dataDir, 'mcp.json');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(userPath, '{broken json', 'utf-8');

    await expect(
      upsertUserMcpServer(
        { dataDir, workDir },
        'new-server',
        { transport: 'stdio', command: 'npx' },
      ),
    ).rejects.toBeInstanceOf(McpConfigFileError);
    await expect(fs.readFile(userPath, 'utf-8')).resolves.toBe('{broken json');
  });

  it('atomically upserts user config while preserving unrelated fields and servers', async () => {
    const userPath = path.join(dataDir, 'mcp.json');
    await writeJson(userPath, {
      owner: 'preserved',
      mcpServers: { existing: { transport: 'stdio', command: 'existing' } },
    });

    await upsertUserMcpServer(
      { dataDir, workDir },
      'new-server',
      { transport: 'stdio', command: 'npx', args: ['-y', 'server'] },
    );

    expect(JSON.parse(await fs.readFile(userPath, 'utf-8'))).toEqual({
      owner: 'preserved',
      mcpServers: {
        existing: { transport: 'stdio', command: 'existing' },
        'new-server': { transport: 'stdio', command: 'npx', args: ['-y', 'server'] },
      },
    });
    const siblings = await fs.readdir(dataDir);
    expect(siblings).toEqual(['mcp.json']);
  });

  it('preserves reserved JavaScript property names as ordinary server names', async () => {
    const userPath = path.join(dataDir, 'mcp.json');
    await writeJson(
      userPath,
      JSON.parse(
        '{"mcpServers":{"__proto__":{"transport":"stdio","command":"safe-command"}}}',
      ),
    );

    const effective = await loadEffectiveMcpServers({ dataDir, workDir });

    expect(effective.get('__proto__')?.config).toEqual({
      transport: 'stdio',
      command: 'safe-command',
    });
    await removeEffectiveMcpServer({ dataDir, workDir }, '__proto__');
    const persisted = JSON.parse(await fs.readFile(userPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.hasOwn(persisted.mcpServers, '__proto__')).toBe(false);
  });

  it('does not remove a declaration when its effective source changed after confirmation', async () => {
    const sources = resolveMcpConfigSources({ dataDir, workDir });
    const user = sources[0]!;
    const project = sources.at(-1)!;
    await writeJson(user.filePath, {
      mcpServers: { shared: { transport: 'stdio', command: 'user' } },
    });
    await writeJson(project.filePath, {
      mcpServers: { shared: { transport: 'stdio', command: 'project' } },
    });

    await expect(
      removeEffectiveMcpServer(
        { dataDir, workDir },
        'shared',
        {
          filePath: user.filePath,
          config: { transport: 'stdio', command: 'user' },
        },
      ),
    ).rejects.toBeInstanceOf(McpConfigFileError);
    expect(JSON.parse(await fs.readFile(project.filePath, 'utf-8'))).toEqual({
      mcpServers: { shared: { transport: 'stdio', command: 'project' } },
    });
  });
});
