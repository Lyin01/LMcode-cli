import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Component, Focusable } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMcpCommand } from '#/tui/commands/mcp';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { getColorPalette } from '#/tui/theme/colors';
import * as paths from '#/utils/paths';

interface InputTarget {
  handleInput(data: string): void;
  render(width: number): string[];
}

let root: string;
let dataDir: string;
let workDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-mcp-command-'));
  dataDir = path.join(root, 'home');
  workDir = path.join(root, 'repo');
  await fs.mkdir(workDir, { recursive: true });
  vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('/mcp config sources', () => {
  it('removes a project override and switches the running server to the revealed user config', async () => {
    const userPath = path.join(dataDir, 'mcp.json');
    const projectPath = path.join(workDir, '.lmcode', 'mcp.json');
    await writeJson(userPath, {
      mcpServers: { shared: { transport: 'stdio', command: 'user-command' } },
    });
    await writeJson(projectPath, {
      mcpServers: {
        shared: { transport: 'stdio', command: 'project-command' },
        local: { transport: 'stdio', command: 'local-command' },
      },
    });

    const addMcpServer = vi.fn(async (): Promise<void> => {});
    const removeMcpServer = vi.fn(async (): Promise<void> => {});
    const statuses: string[] = [];
    const errors: string[] = [];
    let mounted: InputTarget | undefined;
    const host = {
      state: {
        appState: { workDir },
        theme: { colors: getColorPalette('dark') },
      },
      session: {
        workDir,
        listMcpServers: vi.fn(async () => [
          {
            name: 'shared',
            transport: 'stdio' as const,
            status: 'connected' as const,
            toolCount: 1,
          },
        ]),
        listPlugins: vi.fn(async () => []),
        getPluginInfo: vi.fn(),
        addMcpServer,
        removeMcpServer,
      },
      mountEditorReplacement: (component: Component & Focusable) => {
        mounted = component as InputTarget;
      },
      restoreEditor: vi.fn(),
      showError: (message: string) => errors.push(message),
      showStatus: (message: string) => statuses.push(message),
    } as unknown as SlashCommandHost;

    await handleMcpCommand(host, '');
    expect(mounted?.render(100).join('\n')).toContain('项目配置 .lmcode/mcp.json');

    mounted?.handleInput('d');
    await vi.waitFor(() => {
      expect(mounted?.render(100).join('\n')).toContain(
        '确认从 项目配置 .lmcode/mcp.json 中移除',
      );
    });
    mounted?.handleInput('\u001B[B');
    mounted?.handleInput('\r');

    await vi.waitFor(() => {
      expect(addMcpServer).toHaveBeenCalledWith('shared', {
        transport: 'stdio',
        command: 'user-command',
      });
    });
    expect(removeMcpServer).not.toHaveBeenCalled();
    expect(statuses).toContain('shared 的覆盖已移除，现使用用户配置。');
    expect(errors).toEqual([]);
    expect(JSON.parse(await fs.readFile(projectPath, 'utf-8'))).toEqual({
      mcpServers: {
        local: { transport: 'stdio', command: 'local-command' },
      },
    });
  });

  it('rejects a same-source config change made after the row was opened', async () => {
    const projectPath = path.join(workDir, '.lmcode', 'mcp.json');
    await writeJson(projectPath, {
      mcpServers: {
        shared: { transport: 'stdio', command: 'original-command' },
      },
    });

    const addMcpServer = vi.fn(async (): Promise<void> => {});
    const removeMcpServer = vi.fn(async (): Promise<void> => {});
    const errors: string[] = [];
    let mounted: InputTarget | undefined;
    const host = {
      state: {
        appState: { workDir },
        theme: { colors: getColorPalette('dark') },
      },
      session: {
        workDir,
        listMcpServers: vi.fn(async () => [
          {
            name: 'shared',
            transport: 'stdio' as const,
            status: 'connected' as const,
            toolCount: 1,
          },
        ]),
        listPlugins: vi.fn(async () => []),
        getPluginInfo: vi.fn(),
        addMcpServer,
        removeMcpServer,
      },
      mountEditorReplacement: (component: Component & Focusable) => {
        mounted = component as InputTarget;
      },
      restoreEditor: vi.fn(),
      showError: (message: string) => errors.push(message),
      showStatus: vi.fn(),
    } as unknown as SlashCommandHost;

    await handleMcpCommand(host, '');
    mounted?.handleInput('d');
    await vi.waitFor(() => {
      expect(mounted?.render(100).join('\n')).toContain(
        '确认从 项目配置 .lmcode/mcp.json 中移除',
      );
    });
    await writeJson(projectPath, {
      mcpServers: {
        shared: { transport: 'stdio', command: 'updated-command' },
      },
    });
    mounted?.handleInput('\u001B[B');
    mounted?.handleInput('\r');

    await vi.waitFor(() => {
      expect(errors.some((message) => message.includes('请刷新 MCP 面板后重试'))).toBe(true);
    });
    expect(addMcpServer).not.toHaveBeenCalled();
    expect(removeMcpServer).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(projectPath, 'utf-8'))).toEqual({
      mcpServers: {
        shared: { transport: 'stdio', command: 'updated-command' },
      },
    });
  });
});
