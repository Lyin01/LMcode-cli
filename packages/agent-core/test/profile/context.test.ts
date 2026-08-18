import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsMd, prepareSystemPromptContext } from '../../src/profile/context';
import { testJian } from '../fixtures/test-jian';

let homeDir: string;
let workDir: string;

const legacyCcConnectBlock = `【重要】你可以通过以下命令向用户发送图片或文件：
  cc-connect send --file /absolute/path/to/file.pdf

You are running inside cc-connect, a bridge that connects you to messaging platforms.

## Formatting
Replies are delivered as plain text to Weixin. Avoid markdown tables; use short paragraphs.
`;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'lmcode-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'lmcode-agents-work-'));
  vi.spyOn(testJian, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testJian, 'getcwd').mockReturnValue(workDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('loadAgentsMd user-level discovery', () => {
  it('loads user-level branded and generic files before project-level', async () => {
    await mkdir(join(homeDir, '.lmcode'), { recursive: true });
    await writeFile(join(homeDir, '.lmcode', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'user generic', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.content).toContain('user branded');
    expect(result.content).toContain('user generic');
    expect(result.content).toContain('project instructions');
    expect(result.content.indexOf('user branded')).toBeLessThan(result.content.indexOf('user generic'));
    expect(result.content.indexOf('user generic')).toBeLessThan(result.content.indexOf('project instructions'));
    expect(result.paths.length).toBe(3);
    expect(result.dirPaths.length).toBe(3);
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.content).toContain('dot-agents generic');
    expect(result.paths.length).toBe(1);
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.content).toContain('project only');
    expect(result.content).not.toContain(homeDir);
    expect(result.paths.length).toBe(1);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testJian, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.lmcode'), { recursive: true });
    await writeFile(join(homeDir, '.lmcode', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.content.split('home branded').length - 1).toBe(1);
    expect(result.paths.length).toBe(1);
  });

  it('filters duplicated legacy cc-connect injections while preserving project instructions', async () => {
    await mkdir(join(workDir, '.lmcode'), { recursive: true });
    const projectFile = join(workDir, '.lmcode', 'AGENTS.md');
    await writeFile(
      projectFile,
      `${legacyCcConnectBlock}\n${legacyCcConnectBlock}\nKeep this real project rule.`,
      'utf-8',
    );

    const result = await loadAgentsMd(testJian);

    expect(result.content).toContain('Keep this real project rule.');
    expect(result.content).not.toContain('You are running inside cc-connect');
    expect(result.paths).toEqual([projectFile]);
  });

  it('ignores an AGENTS.md file containing only stranded cc-connect injections', async () => {
    await mkdir(join(workDir, '.lmcode'), { recursive: true });
    await writeFile(
      join(workDir, '.lmcode', 'AGENTS.md'),
      `${legacyCcConnectBlock}\n${legacyCcConnectBlock}`,
      'utf-8',
    );

    const result = await loadAgentsMd(testJian);

    expect(result.content).toBe('');
    expect(result.paths).toEqual([]);
  });

  it('does not strip the same text from a non-.lmcode project AGENTS.md file', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), legacyCcConnectBlock, 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.content).toContain('You are running inside cc-connect');
    expect(result.paths).toEqual([join(workDir, 'AGENTS.md')]);
  });
});

describe('prepareSystemPromptContext', () => {
  it('maps AGENTS.md contents into agentsMd and file paths into agentsMdPaths', async () => {
    await mkdir(join(homeDir, '.lmcode'), { recursive: true });
    const userFile = join(homeDir, '.lmcode', 'AGENTS.md');
    const projectFile = join(workDir, 'AGENTS.md');
    await writeFile(userFile, 'user level instructions', 'utf-8');
    await writeFile(projectFile, 'project level instructions', 'utf-8');

    const result = await prepareSystemPromptContext(testJian);

    // The system prompt template labels LMCODE_AGENTS_MD as file *contents*
    // and LMCODE_AGENTS_MD_PATHS as file *paths* — swapping either one makes
    // the model see path lists instead of the actual conventions.
    expect(result.agentsMd).toContain('user level instructions');
    expect(result.agentsMd).toContain('project level instructions');
    expect(result.agentsMdPaths).toEqual([userFile, projectFile]);
  });

  it('leaves agentsMd and agentsMdPaths empty when no AGENTS.md exists', async () => {
    const result = await prepareSystemPromptContext(testJian);

    expect(result.agentsMd).toBe('');
    expect(result.agentsMdPaths).toEqual([]);
  });
});
