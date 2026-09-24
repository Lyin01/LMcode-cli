/**
 * Tests for MemoryWriteTool — active memory memo creation by the model.
 */

import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  MemoryWriteInputSchema,
  MemoryWriteTool,
} from '../../src/tools/builtin/memory/memory-write';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeAgent(options: {
  homedir?: string;
  sessionTitle?: string;
  cwd?: string;
  append?: (memo: { userNeed: string; approach: string; outcome: string }) => Promise<void>;
} = {}): { agent: Agent } {
  return {
    agent: {
      homedir: options.homedir,
      getSessionTitle: async () => options.sessionTitle,
      config: { cwd: options.cwd ?? '/workspace/project' },
      memoStore: {
        append: options.append ?? (async () => {}),
      },
    } as unknown as Agent,
  };
}

describe('MemoryWriteTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { agent } = makeAgent();
    const tool = new MemoryWriteTool(agent);

    expect(tool.name).toBe('MemoryWrite');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain('memory memo store');
    expect(MemoryWriteInputSchema.safeParse({
      userNeed: 'Fix auth',
      approach: 'Add refresh logic',
      outcome: '完成',
    }).success).toBe(true);
    expect(MemoryWriteInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        userNeed: { type: 'string' },
        approach: { type: 'string' },
        outcome: { type: 'string' },
      },
    });
  });

  it('writes a memory memo with manual extraction source', async () => {
    let appended: {
      userNeed: string;
      approach: string;
      outcome: string;
      whatFailed: string;
      whatWorked: string;
      extractionSource: string;
      sourceSessionId: string;
      sourceSessionTitle?: string;
      projectDir: string;
      tags?: string[];
    } | undefined;

    const { agent } = makeAgent({
      homedir: '/home/user/project/sessions/session-abc/agents/main',
      sessionTitle: 'Auth refactor',
      cwd: '/workspace/auth-project',
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        userNeed: 'Fix JWT token rotation',
        approach: 'Use redis to store refresh tokens with TTL',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'Redis TTL reduced token leaks',
        tags: ['auth', 'redis', 'jwt'],
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('已保存记忆');
    expect(result.output).toContain('Fix JWT token rotation');
    expect(appended).toBeDefined();
    expect(appended!.userNeed).toBe('Fix JWT token rotation');
    expect(appended!.approach).toBe('Use redis to store refresh tokens with TTL');
    expect(appended!.outcome).toBe('完成');
    expect(appended!.whatFailed).toBe('none');
    expect(appended!.whatWorked).toBe('Redis TTL reduced token leaks');
    expect(appended!.extractionSource).toBe('manual');
    expect(appended!.sourceSessionId).toBe('session-abc');
    expect(appended!.sourceSessionTitle).toBe('Auth refactor');
    expect(appended!.projectDir).toBe('/workspace/auth-project');
    expect(appended!.tags).toEqual(['auth', 'redis', 'jwt']);
  });

  it('records a preference memo when kind is set', async () => {
    let appended: { kind?: string; approach?: string; userNeed?: string } | undefined;

    const { agent } = makeAgent({
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        kind: 'preference',
        userNeed: '所有会话',
        approach: '回复用中文，结论先行',
        outcome: '已记录为长期偏好',
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(appended).toBeDefined();
    expect(appended!.kind).toBe('preference');
    expect(appended!.approach).toBe('回复用中文，结论先行');
  });

  it('records a pending memo when kind is set', async () => {
    let appended: { kind?: string; output?: string } | undefined;

    const { agent } = makeAgent({
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        kind: 'pending',
        userNeed: '修复 flaky test',
        approach: '已定位到文件锁，下一步验证重试预算',
        outcome: '未完成',
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(appended).toBeDefined();
    expect(appended!.kind).toBe('pending');
  });

  it('records a task memo when kind is omitted', async () => {
    let appended: { kind?: string } | undefined;

    const { agent } = makeAgent({
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { userNeed: 'Fix auth', approach: 'Add refresh logic', outcome: '完成' },
      signal,
    });

    expect(appended!.kind).toBe('task');
  });

  it('generates fallback tags when none are provided', async () => {
    let appended: { tags?: string[] } | undefined;

    const { agent } = makeAgent({
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        userNeed: 'Configure TypeScript strict mode',
        approach: 'Update tsconfig and fix type errors',
        outcome: '完成',
      },
      signal,
    });

    expect(appended).toBeDefined();
    expect(appended!.tags).toBeDefined();
    expect(appended!.tags!.length).toBeGreaterThan(0);
    expect(appended!.tags!.length).toBeLessThanOrEqual(5);
  });

  it('defaults optional fields to "none"', async () => {
    let appended: { whatFailed: string; whatWorked: string } | undefined;

    const { agent } = makeAgent({
      homedir: '/home/user/project/sessions/session-xyz/agents/main',
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_2',
      args: {
        userNeed: 'Simple task',
        approach: 'Simple approach',
        outcome: '完成',
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(appended).toBeDefined();
    expect(appended!.whatFailed).toBe('none');
    expect(appended!.whatWorked).toBe('none');
  });

  it('normalizes empty optional fields to "none"', async () => {
    let appended: { whatFailed: string; whatWorked: string } | undefined;

    const { agent } = makeAgent({
      homedir: '/home/user/project/sessions/session-empty/agents/main',
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_empty',
      args: {
        userNeed: 'Task with empty fields',
        approach: 'Approach',
        outcome: '完成',
        whatFailed: '   ',
        whatWorked: '',
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(appended).toBeDefined();
    expect(appended!.whatFailed).toBe('none');
    expect(appended!.whatWorked).toBe('none');
  });

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryWriteTool({ memoStore: undefined } as unknown as Agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_3',
      args: {
        userNeed: 'Anything',
        approach: 'Anything',
        outcome: '完成',
      },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not available');
  });

  it('uses "unknown" session id when homedir is missing', async () => {
    let appended: { sourceSessionId: string } | undefined;

    const { agent } = makeAgent({
      append: async (memo) => {
        appended = memo as unknown as typeof appended;
      },
    });
    const tool = new MemoryWriteTool(agent);

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_4',
      args: {
        userNeed: 'No session',
        approach: 'Nothing',
        outcome: '失败',
      },
      signal,
    });

    expect(appended).toBeDefined();
    expect(appended!.sourceSessionId).toBe('unknown');
  });

  it('resolveExecution description is stable', () => {
    const { agent } = makeAgent();
    const execution = new MemoryWriteTool(agent).resolveExecution({
      userNeed: 'x',
      approach: 'y',
      outcome: 'z',
    });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Writing memory memo');
  });
});
