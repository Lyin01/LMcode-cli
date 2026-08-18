import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { testJian } from '../fixtures/test-jian';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Session resume context', () => {
  it('replaces persisted AGENTS instructions before a resumed turn', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lmcode-resume-context-'));
    tempDirs.push(rootDir);
    const workDir = join(rootDir, 'work');
    const sessionDir = join(rootDir, 'session');
    await mkdir(join(workDir, '.git'), { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(workDir, 'AGENTS.md'), 'obsolete project instruction', 'utf-8');

    const first = createSession(workDir, sessionDir);
    const firstMain = await first.createMain();
    expect(contextText(firstMain)).toContain('obsolete project instruction');
    await first.flushMetadata();
    await first.close();

    await writeFile(join(workDir, 'AGENTS.md'), 'current project instruction', 'utf-8');
    const resumed = createSession(workDir, sessionDir);
    try {
      await resumed.resume();
      const resumedMain = resumed.agents.get('main');
      expect(resumedMain).toBeDefined();
      expect(contextText(resumedMain!)).toContain('current project instruction');
      expect(contextText(resumedMain!)).not.toContain('obsolete project instruction');

      const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
      expect(wire).toContain('current project instruction');
      expect(wire).not.toContain('obsolete project instruction');
    } finally {
      await resumed.close();
    }
  });
});

function createSession(workDir: string, sessionDir: string): Session {
  return new Session({
    id: 'resume-context-test',
    jian: testJian.withCwd(workDir),
    homedir: sessionDir,
    rpc: createSessionRpc(),
    skills: { explicitDirs: [join(workDir, 'missing-skills')] },
  });
}

function contextText(agent: Agent): string {
  return agent.context.history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: 'unsupported in test', isError: true })),
  } as SDKSessionRPC;
}
