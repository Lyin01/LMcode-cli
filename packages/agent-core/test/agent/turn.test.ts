import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { setTimeout as delay } from 'node:timers/promises';

import type { Jian } from '@lmcode-cli/jian';
import {
  APIConnectionError,
  APIStatusError,
  type ChatProvider,
  type GenerateResult,
  type ToolCall,
} from '@lmcode-cli/ltod';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DreamTracker } from '@lmcode/memory';

import { HookEngine } from '../../src/session/hooks';
import type { AgentOptions } from '../../src/agent';
import type { Logger, LogPayload } from '../../src/logging';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../../src/utils/tokens';
import { createFakeJian } from '../tools/fixtures/fake-jian';
import { createCommandJian, testAgent, type TestAgentOptions } from './harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';

type GenerateFn = NonNullable<AgentOptions['generate']>;

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    createChild: () => logger,
  };
  return { logger, entries };
}

describe('Agent turn flow', () => {
  beforeEach(() => {
    vi.spyOn(DreamTracker.prototype, 'shouldSuggest').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a dream session on the first turn only for the main agent', async () => {
    const initSpy = vi.spyOn(DreamTracker.prototype, 'init');
    const recordSpy = vi.spyOn(DreamTracker.prototype, 'recordNewSession');

    const sub = testAgent({ type: 'sub' });
    sub.configure();
    sub.mockNextResponse({ type: 'text', text: 'sub reply' });
    await sub.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await sub.untilTurnEnd();

    // Subagents share the main agent's dream-lock.json — counting their
    // first turns as sessions would inflate the consolidation reminder.
    expect(recordSpy).not.toHaveBeenCalled();
    expect(initSpy).not.toHaveBeenCalled();

    const main = testAgent();
    main.configure();
    main.mockNextResponse({ type: 'text', text: 'main reply' });
    await main.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await main.untilTurnEnd();

    // Main agents kick off init at construction, again in launch(), and
    // await it at step 1 — the real tracker shares one in-flight load
    // across those calls, so the contract is "started early", not "once".
    expect(initSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // launch() records via a fire-and-forget promise chain — wait for it.
    await vi.waitFor(() => {
      expect(recordSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('fires PostToolUse for same-step dups with the original real output, not the dedup placeholder', async () => {
    // Hook command asserts the dup's PostToolUse payload carries the real
    // stdout ('dup'), not the placeholder ('').
    const assertScript = [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  const payload = JSON.parse(input);',
      "  if (typeof payload.tool_output === 'string' && payload.tool_output.includes('dup')) process.exit(0);",
      "  console.error('bad tool_output: ' + JSON.stringify(payload.tool_output));",
      '  process.exit(2);',
      '});',
    ].join('');
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: `node -e ${JSON.stringify(assertScript)}`,
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent({ jian: createCommandJian('dup'), hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    await vi.waitFor(
      () => {
        expect(resolved).toEqual([
          ['PostToolUse', 'Bash', 'allow'],
          ['PostToolUse', 'Bash', 'allow'],
        ]);
      },
      { timeout: 5_000 },
    );
  });

  it('executes a same-file Read again after an authorized Edit changes it', async () => {
    let content = 'alpha\n';
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* () {
      yield content;
    });
    const jian = createFakeJian({
      stat: vi.fn<Jian['stat']>().mockResolvedValue({
        stMode: 0o100644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 1000,
        stGid: 1000,
        stSize: content.length,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      }),
      readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async () => Buffer.from(content)),
      readLines,
      readText: vi.fn<Jian['readText']>().mockImplementation(async () => content),
      writeText: vi.fn<Jian['writeText']>().mockImplementation(async (_path, next) => {
        content = next;
        return next.length;
      }),
    });
    const ctx = testAgent({
      jian,
      initialConfig: {
        providers: {},
        enableSelfHealing: false,
        enableSpecCritic: false,
      },
    });
    ctx.configure({ tools: ['Read', 'Edit'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    const readArguments = JSON.stringify({ path: 'a.txt', line_offset: 1, n_lines: 10 });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_read_before',
      name: 'Read',
      arguments: readArguments,
    });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_edit',
      name: 'Edit',
      arguments: JSON.stringify({
        path: 'a.txt',
        old_string: 'alpha\n',
        new_string: 'beta\n',
      }),
    });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_read_after',
      name: 'Read',
      arguments: readArguments,
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read, edit, and verify a.txt' }] });
    await ctx.untilTurnEnd();

    expect(readLines).toHaveBeenCalledTimes(2);
    const toolResults = ctx.agent.context.history.filter((message) => message.role === 'tool');
    expect(toolResults).toHaveLength(3);
    expect(toolResults.at(-1)?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('beta') }),
      ]),
    );
  });

  it('does not suppress repeated Reads while a prior-turn background task is active', async () => {
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* () {
      yield 'alpha\n';
    });
    const jian = createFakeJian({
      stat: vi.fn<Jian['stat']>().mockResolvedValue({
        stMode: 0o100644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 1000,
        stGid: 1000,
        stSize: 6,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      }),
      readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(Buffer.from('alpha\n')),
      readLines,
    });
    const ctx = testAgent({
      jian,
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Read'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'ready' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Prepare' }] });
    await ctx.untilTurnEnd();

    ctx.agent.background.registerAgentTask(new Promise(() => {}), 'background writer');
    const readArguments = JSON.stringify({ path: 'a.txt', line_offset: 1, n_lines: 10 });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_background_read_1',
      name: 'Read',
      arguments: readArguments,
    });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_background_read_2',
      name: 'Read',
      arguments: readArguments,
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read twice while it runs' }] });
    await ctx.untilTurnEnd();

    expect(readLines).toHaveBeenCalledTimes(2);
    ctx.agent.background._reset();
  });

  it('invalidates Read coverage when a PostToolUse hook command runs', async () => {
    const readLines = vi.fn<Jian['readLines']>().mockImplementation(async function* () {
      yield 'alpha\n';
    });
    const jian = createFakeJian({
      stat: vi.fn<Jian['stat']>().mockResolvedValue({
        stMode: 0o100644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 1000,
        stGid: 1000,
        stSize: 6,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      }),
      readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(Buffer.from('alpha\n')),
      readLines,
    });
    const hookEngine = new HookEngine([
      {
        event: 'PostToolUse',
        matcher: 'Read',
        command: 'node -e "process.exit(0)"',
      },
    ]);
    const ctx = testAgent({
      jian,
      hookEngine,
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Read'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    const readArguments = JSON.stringify({ path: 'a.txt', line_offset: 1, n_lines: 10 });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_hook_read_1',
      name: 'Read',
      arguments: readArguments,
    });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_hook_read_2',
      name: 'Read',
      arguments: readArguments,
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read twice around the hook' }] });
    await ctx.untilTurnEnd();

    expect(readLines).toHaveBeenCalledTimes(2);
    expect(hookEngine.executionRevision).toBeGreaterThan(0);
    await vi.waitFor(
      () => {
        expect(hookEngine.hasActiveExecutions).toBe(false);
      },
      { timeout: 5_000 },
    );
  });

  it('emits a failed turn and error when generation fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Trigger generate failure" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Trigger generate failure" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "error", "message": "Unexpected generate call #1" }
      [emit] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "retryable": false, "details": { "turnId": 0 } } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "retryable": false, "details": { "turnId": 0 } }`,
    );
    await ctx.expectResumeMatches();
  });

  it('emits a friendly model.not_configured error when no model is configured', async () => {
    const ctx = testAgent();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] metadata                 { "protocol_version": "1.3", "created_at": "<time>" }
      [wire] turn.prompt              { "input": [ { "type": "text", "text": "Hello without login" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started             { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello without login" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] turn.ended               { "turnId": 0, "reason": "failed", "error": { "code": "model.not_configured", "message": "No model configured. Run \`lm config\` or use \`/model\` to set a default model.", "name": "LmcodeError", "details": { "turnId": 0 }, "retryable": false } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "model.not_configured", "message": "No model configured. Run \`lm config\` or use \`/model\` to set a default model.", "name": "LmcodeError", "details": { "turnId": 0 }, "retryable": false }`,
    );
  });

  it('continues the turn after projecting UserPromptSubmit hook output', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command:
          'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);if(Array.isArray(o.prompt)&&o.prompt[0]?.text===\\"hooked input\\"){process.stdout.write(\\"hook response 1\\");process.exit(0);}console.error(\\"bad prompt\\");process.exit(1);})"',
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: "echo 'hook response 2'",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "hooked input"
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 1\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 2\\n</hook_result>"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'hook response 1\n\nhook response 2',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: 'model saw original prompt only' }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects structured UserPromptSubmit stdout', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: "echo '{}'",
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: 'echo \'{"hookSpecificOutput":{}}\'',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "hooked input"
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\n{}\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\n{\\"hookSpecificOutput\\":{}}\\n</hook_result>"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: '{}\n\n{"hookSpecificOutput":{}}',
        }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\n{"hookSpecificOutput":{}}\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('stops the turn when a UserPromptSubmit hook blocks', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'bad words',
        command: "echo 'no profanity' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'bad words here' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult = '<hook_result hook_event="UserPromptSubmit">\nno profanity\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'no profanity',
          blocked: true,
        }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'bad words here' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'safe answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'safe followup' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "bad words here"
        assistant: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nno profanity\\n</hook_result>"
        user: text "safe followup"
    `);
  });

  it('cancels while waiting for a UserPromptSubmit hook without appending stale output', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        command: 'node -e "setTimeout(() => process.stdout.write(\\"late hook\\"), 250)"',
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hook will sleep' }] });
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: expect.stringContaining('late hook') }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hook will sleep' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    ]);
  });

  it('uses a Stop hook block reason as a one-shot turn continuation', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: "echo 'continue from hook' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const stopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: 'stop_hook' },
    };
    const llmStopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
    };
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('continue from hook');
    expect(ctx.agent.context.data().history).toContainEqual(stopHookMessage);
    expect(ctx.llmCalls[1]?.history).toContainEqual(llmStopHookMessage);
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('Second answer.');
  });

  it('cancels while waiting for a Stop hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lmcode-stop-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stderr.write('late stop hook'), 250);",
    ].join('');
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'Answer before stop hook.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.agent.context.data().history)).not.toContain('late stop hook');
  });

  it('cancels while waiting for a PreToolUse hook inside permission evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lmcode-pre-tool-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stdout.write('late pre tool hook'), 250);",
    ].join('');
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent({
      jian: createFakeJian({ execWithEnv }),
      hookEngine,
    });
    const beforeToolCall = vi.spyOn(ctx.agent.permission, 'beforeToolCall');
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    ctx.newEvents();
    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash while hook sleeps' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(JSON.stringify(ctx.agent.context.data().history)).not.toContain('late pre tool hook');
  });

  it('fires StopFailure when a turn fails', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'StopFailure',
          matcher: 'Error',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['StopFailure', 'Error', 1]]);
  });

  it('resolves the latest request-scoped OAuth auth before each generation', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const tokens = ['first-turn-token', 'second-turn-token'];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      const token = tokens.shift();
      if (token === undefined) throw new Error('unexpected token request');
      return token;
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'lmcode' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const firstEvents = await ctx.untilTurnEnd();
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello again' }] });
    const secondEvents = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['first-turn-token', 'second-turn-token']);
    expect(tokenCalls).toEqual([undefined, undefined]);
    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with first-turn-token' },
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 1, delta: 'Generated with second-turn-token' },
      }),
    );
    expect(firstEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
    expect(secondEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
  });

  it('emits LLM stream timing on step completion', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'timed answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      llmFirstTokenLatencyMs: expect.any(Number),
      llmStreamDurationMs: expect.any(Number),
    });
  });

  it('logs LLM request metadata without message bodies', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'secret prompt body should stay out of logs' }],
    });
    await ctx.untilTurnEnd();

    const configLogs = entries.filter((entry) => entry.message === 'llm config');
    expect(configLogs).toHaveLength(1);
    const configPayload = configLogs[0]?.payload as Record<string, unknown>;
    expect(configPayload).toMatchObject({
      turnStep: '0.1',
      provider: 'lmcode',
      model: 'mock-model',
      modelAlias: 'mock-model',
      toolCount: 0,
    });
    expect(configPayload['systemPromptChars']).toEqual(expect.any(Number));

    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    expect(requestLogs).toHaveLength(1);
    const payload = requestLogs[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      turnStep: '0.1',
    });
    expect(payload['estimatedInputTokens']).toEqual(expect.any(Number));
    expect(payload).not.toHaveProperty('turnId');
    expect(payload).not.toHaveProperty('step');
    expect(payload).not.toHaveProperty('attempt');
    expect(payload).not.toHaveProperty('maxAttempts');
    expect(payload).not.toHaveProperty('stepUuid');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('modelAlias');
    expect(payload).not.toHaveProperty('thinkingEffort');
    expect(payload).not.toHaveProperty('systemPromptChars');
    expect(payload).not.toHaveProperty('partialMessageCount');
    expect(payload).not.toHaveProperty('messageCount');
    expect(payload).not.toHaveProperty('toolCallCount');
    expect(payload).not.toHaveProperty('toolCount');
    expect(payload).not.toHaveProperty('systemPromptHash');
    expect(payload).not.toHaveProperty('toolsHash');
    expect(payload).not.toHaveProperty('messageRoles');
    expect(payload).not.toHaveProperty('contentPartTypes');
    expect(payload).not.toHaveProperty('toolNames');
    expect(payload).not.toHaveProperty('history');
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(entries)).not.toContain('secret prompt body should stay out of logs');
  });

  it('does not repeat unchanged LLM config metadata', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    expect(entries.filter((entry) => entry.message === 'llm config')).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === 'llm request')).toHaveLength(2);
  });

  it('logs changed LLM config when same-size system prompt content changes', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();

    ctx.agent.config.update({ systemPrompt: 'alpha' });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.agent.config.update({ systemPrompt: 'bravo' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    const configPayloads = entries
      .filter((entry) => entry.message === 'llm config')
      .map((entry) => entry.payload as Record<string, unknown>);
    expect(configPayloads).toHaveLength(2);
    expect(configPayloads.map((payload) => payload['systemPromptChars'])).toEqual([5, 5]);
    // systemPromptHash is included for cache-stability diagnostics.
    for (const payload of configPayloads) {
      expect(payload).toHaveProperty('systemPromptHash');
      expect(payload).not.toHaveProperty('toolsHash');
    }
  });

  it('includes tool schemas in estimated LLM request tokens', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();
    await ctx.rpc.setActiveTools({ names: ['Bash'] });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use bash' }] });
    await ctx.untilTurnEnd();

    const input = ctx.llmCalls[0];
    expect(input?.tools.length).toBeGreaterThan(0);
    const expectedTokens =
      estimateTokens(input!.systemPrompt) +
      estimateTokensForMessages(input!.history) +
      estimateTokensForTools(input!.tools);
    const requestPayload = entries.find((entry) => entry.message === 'llm request')?.payload as
      | Record<string, unknown>
      | undefined;
    expect(requestPayload?.['estimatedInputTokens']).toBe(expectedTokens);
  });

  it('classifies OAuth resolver failures as auth errors', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new Error('refresh token expired');
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'lmcode' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'auth.login_required',
          }),
        }),
      }),
    );
  });

  it('honors configured maxStepsPerTurn in agent turns', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
      jian: createCommandJian('loop-output'),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.newEvents();

    const bashCall: ToolCall = {
      id: 'call_bash',
      type: 'function',
      name: 'Bash',
      arguments: '{"command":"printf loop-output","timeout":60}',
    };
    ctx.mockNextResponse(bashCall);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command once' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'loop.max_steps_exceeded',
            details: expect.objectContaining({
              maxSteps: 1,
            }),
          }),
        }),
      }),
    );
  });

  it('force-refreshes OAuth credentials and replays the request on 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      if (authKeys.length === 1) throw new APIStatusError(401, 'Unauthorized', 'req-401');
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'lmcode' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with forced-refresh-token' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('falls back to login_required when force-refresh and replay both 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      _callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      throw new APIStatusError(401, 'Unauthorized', 'req-401');
    };
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'lmcode' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'auth.login_required',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-401',
            }),
          }),
        }),
      }),
    );
  });

  it('keeps non-OAuth provider 401 as provider auth error', async () => {
    const generate: GenerateFn = async () => {
      throw new APIStatusError(401, 'Unauthorized', 'req-api-key-401');
    };
    const ctx = testAgent({ generate });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.auth_error',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-api-key-401',
            }),
          }),
        }),
      }),
    );
  });


  it('keeps transient retry handling with request-scoped OAuth auth', async () => {
    const { logger, entries } = captureLogs();
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async () => 'fresh-token');
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      if (authKeys.length === 1) {
        throw new APIConnectionError('socket hang up');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'Recovered after retry' });
      return textResult('Recovered after retry');
    };
    const ctx = testAgent({ ...oauthOptions, generate, log: logger });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'lmcode' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'fresh-token']);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.retrying',
        args: expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          errorName: 'APIConnectionError',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Recovered after retry' },
      }),
    );
    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    const payloads = requestLogs.map((entry) => entry.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ turnStep: '0.1' });
    expect(payloads[0]).not.toHaveProperty('attempt');
    expect(payloads[1]).toMatchObject({ turnStep: '0.1', attempt: '2/3' });
  });

  it('force-refreshes OAuth credentials on video upload 401 and falls back to login_required when replay 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const provider = {
      uploadVideo: vi.fn().mockImplementation(async (_input, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        throw new APIStatusError(401, 'Unauthorized', 'req-upload-401');
      }),
    } as unknown as ChatProvider;
    const ctx = testAgent({
      ...oauthOptions,
      jian: createVideoJian(),
    });
    ctx.agent.config.update({
      cwd: process.cwd(),
      modelAlias: 'lmcode',
      systemPrompt: 'test system prompt',
      thinkingLevel: 'off',
    });
    Object.defineProperty(ctx.agent.config, 'provider', {
      configurable: true,
      get: () => provider,
    });
    ctx.agent.tools.initializeBuiltinTools();
    ctx.agent.tools.setActiveTools(['ReadMediaFile']);

    const tool = ctx.agent.tools.loopTools.find((candidate) => candidate.name === 'ReadMediaFile');
    if (tool === undefined) throw new Error('ReadMediaFile tool was not initialized');
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_media',
      args: { path: '/workspace/sample.mp4' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(result.output).toContain('OAuth provider credentials were rejected');
    expect(result.output).toContain('Send /login to login');
  });

  it('autonomously continues a goal created during a standalone turn', async () => {
    let generateCalls = 0;
    let completedTurns: number | undefined;
    const ctx = testAgent({
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          await ctx.agent.goal.createGoal({ objective: 'Finish the batch' }, 'model');
          return textResult('goal created');
        }
        const completed = await ctx.agent.goal.markComplete({ reason: 'batch done' });
        completedTurns = completed?.turnsUsed;
        return textResult('goal completed');
      },
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create a durable goal' }] });
    const end = await ctx.agent.turn.waitForCurrentTurn();

    expect(end.event).toMatchObject({ turnId: 1, reason: 'completed' });
    expect(generateCalls).toBe(2);
    expect(completedTurns).toBe(1);
    expect(ctx.agent.goal.getGoal().goal).toBeNull();
  });

  it('stops after a successful UpdateGoal terminal result without another model step', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['UpdateGoal'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Finish the batch' });
    ctx.mockNextResponse(
      { type: 'text', text: 'The goal is blocked.' },
      {
        type: 'function',
        id: 'call_goal_blocked',
        name: 'UpdateGoal',
        arguments: JSON.stringify({ status: 'blocked' }),
      },
    );
    ctx.mockNextResponse({ type: 'text', text: 'This response must not be requested.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the goal' }] });
    const end = await ctx.agent.turn.waitForCurrentTurn();

    expect(end).toMatchObject({
      event: { turnId: 0, reason: 'completed' },
      stopReason: 'end_turn',
    });
    expect(ctx.llmCalls).toHaveLength(1);
    const blockedGoal = ctx.agent.goal.getGoal().goal;
    expect(blockedGoal?.status).toBe('blocked');
    expect(blockedGoal?.tokensUsed).toBeGreaterThan(0);
    expect(blockedGoal?.tokensUsed).toBe(ctx.agent.usage.stats().totalTokens);
  });

  it('does not charge a replacement goal for a model request started by the original goal', async () => {
    let replacementGoalId: string | undefined;
    const ctx = testAgent({
      initialConfig: { providers: {}, enableSpecCritic: false },
      generate: async () => {
        const replacement = await ctx.agent.goal.createGoal(
          { objective: 'Replacement goal', replace: true },
          'user',
        );
        replacementGoalId = replacement.goalId;
        await ctx.agent.goal.pauseGoal({ reason: 'Replacement parked by the user' });
        return {
          id: 'replacement-during-generation',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Parking the replacement.' }],
            toolCalls: [],
          },
          usage: {
            inputOther: 9,
            output: 4,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
    });
    ctx.configure();
    const original = await ctx.agent.goal.createGoal({ objective: 'Original goal' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the original goal' }] });
    await ctx.agent.turn.waitForCurrentTurn();

    expect(replacementGoalId).not.toBe(original.goalId);
    expect(ctx.agent.usage.stats().totalTokens).toBe(13);
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      goalId: replacementGoalId,
      objective: 'Replacement goal',
      status: 'paused',
      tokensUsed: 0,
    });
  });

  it('does not execute tools from a model response after its goal is paused', async () => {
    const response = deferred<GenerateResult>();
    const generateStarted = deferred<void>();
    let generateCalls = 0;
    const ctx = testAgent({
      jian: createCommandJian('stale-goal-tool-ran'),
      initialConfig: { providers: {}, enableSpecCritic: false },
      generate: () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          generateStarted.resolve();
          return response.promise;
        }
        return Promise.resolve(textResult('A stale follow-up model step ran.'));
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Do not work after pause' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the active goal' }] });
    await generateStarted.promise;
    await ctx.agent.goal.pauseGoal({ reason: 'Paused during generation' });
    const toolCall = bashCallWithId('call_stale_goal_bash', 'printf stale');
    response.resolve({
      id: 'stale-goal-tool-response',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Running a now-stale tool.' }],
        toolCalls: [toolCall],
      },
      usage: {
        inputOther: 9,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    });
    await ctx.agent.turn.waitForCurrentTurn();

    const toolOutput = ctx.agent.context.history
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(generateCalls).toBe(1);
    expect(toolOutput).not.toContain('stale-goal-tool-ran');
    expect(toolOutput).toContain('active goal changed');
    expect(ctx.agent.usage.stats().totalTokens).toBe(13);
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused during generation',
      turnsUsed: 1,
      tokensUsed: 13,
    });
  });

  it('withdraws a pending tool approval when the user pauses its goal', async () => {
    const ctx = testAgent({
      jian: createCommandJian('paused-goal-tool-ran'),
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'manual' });
    await ctx.agent.goal.createGoal({ objective: 'Pause safely during approval' });
    ctx.mockNextResponse(
      { type: 'text', text: 'Waiting for permission.' },
      bashCallWithId('call_paused_goal_approval', 'printf paused'),
    );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the active goal' }] });
    await ctx.untilApprovalRequest();
    const turn = ctx.agent.turn.waitForCurrentTurn();
    let turnEnded = false;

    try {
      await ctx.rpc.updateGoalStatus({ status: 'paused' });
      const endedWithoutApprovalResponse = await Promise.race([
        turn.then(() => {
          turnEnded = true;
          return true;
        }),
        delay(250).then(() => false),
      ]);

      expect(endedWithoutApprovalResponse).toBe(true);
    } finally {
      if (!turnEnded) {
        ctx.agent.permission.cancelAllApprovals();
        await turn;
      }
    }

    const toolOutput = ctx.agent.context.history
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(toolOutput).not.toContain('paused-goal-tool-ran');
    expect(ctx.agent.permission.getPendingApprovals()).toEqual([]);
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      status: 'paused',
      turnsUsed: 1,
    });
  });

  it('cancels permission resolution when the user pauses before approval registration', async () => {
    const authorizationStarted = deferred<void>();
    const authorizationAborted = deferred<void>();
    const ctx = testAgent({
      jian: createCommandJian('policy-race-tool-ran'),
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'manual' });
    await ctx.agent.goal.createGoal({ objective: 'Pause during policy resolution' });
    vi.spyOn(ctx.agent.permission, 'beforeToolCall').mockImplementation(async (context) => {
      authorizationStarted.resolve();
      if (context.signal.aborted) {
        authorizationAborted.resolve();
      } else {
        context.signal.addEventListener('abort', () => authorizationAborted.resolve(), {
          once: true,
        });
      }
      await authorizationAborted.promise;
      context.signal.throwIfAborted();
    });
    ctx.mockNextResponse(
      { type: 'text', text: 'Resolving permission policy.' },
      bashCallWithId('call_goal_policy_race', 'printf policy-race'),
    );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the active goal' }] });
    await authorizationStarted.promise;
    const turn = ctx.agent.turn.waitForCurrentTurn();
    let turnEnded = false;

    try {
      await ctx.rpc.updateGoalStatus({ status: 'paused' });
      const endedWithoutApprovalRegistration = await Promise.race([
        turn.then(() => {
          turnEnded = true;
          return true;
        }),
        delay(250).then(() => false),
      ]);

      expect(endedWithoutApprovalRegistration).toBe(true);
    } finally {
      if (!turnEnded) {
        ctx.agent.turn.cancel();
        await turn;
      }
    }

    const toolOutput = ctx.agent.context.history
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(toolOutput).not.toContain('policy-race-tool-ran');
    expect(ctx.agent.permission.getPendingApprovals()).toEqual([]);
    expect(ctx.agent.goal.getGoal().goal?.status).toBe('paused');
  });

  it('stops before another model step when a goal reaches its token budget mid-turn', async () => {
    const ctx = testAgent({
      jian: createCommandJian('budget-tool-ran'),
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Run one bounded tool step' });
    await ctx.agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } });
    ctx.mockNextResponse(
      { type: 'text', text: 'Running the bounded tool.' },
      bashCallWithId('call_budget_bash', 'printf bounded'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'This response must not be requested.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue within the budget' }] });
    const end = await ctx.agent.turn.waitForCurrentTurn();

    const toolOutput = ctx.agent.context.history
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    const goal = ctx.agent.goal.getGoal().goal;
    expect(end).toMatchObject({
      event: { turnId: 0, reason: 'completed' },
      stopReason: 'end_turn',
    });
    expect(ctx.llmCalls).toHaveLength(1);
    expect(toolOutput).toContain('budget-tool-ran');
    expect(goal).toMatchObject({
      status: 'blocked',
      terminalReason: 'A configured budget was reached',
      turnsUsed: 1,
    });
    expect(goal?.tokensUsed).toBe(ctx.agent.usage.stats().totalTokens);
  });

  it('normalizes malformed provider usage before recording and enforcing a goal budget', async () => {
    const ctx = testAgent({
      generate: async () => ({
        ...textResult('The bounded response is complete.'),
        usage: {
          inputOther: Number.NaN,
          output: -3,
          inputCacheRead: 4.9,
          inputCacheCreation: Number.POSITIVE_INFINITY,
        },
      }),
    });
    ctx.configure();
    await ctx.agent.goal.createGoal({ objective: 'Keep malformed usage bounded' });
    await ctx.agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Finish within the budget' }] });
    await ctx.agent.turn.waitForCurrentTurn();

    const normalizedUsage = {
      inputOther: 0,
      output: 0,
      inputCacheRead: 4,
      inputCacheCreation: Number.MAX_SAFE_INTEGER - 4,
    };
    const usageRecord = ctx.allEvents.find(
      (event) => event.type === '[wire]' && event.event === 'usage.record',
    );
    expect((usageRecord?.args as { usage?: unknown } | undefined)?.usage).toEqual(
      normalizedUsage,
    );
    expect(ctx.agent.usage.stats()).toMatchObject({
      total: normalizedUsage,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      status: 'blocked',
      tokensUsed: Number.MAX_SAFE_INTEGER,
      budget: { tokenBudgetReached: true },
    });
    await ctx.expectResumeMatches();
  });

  it('allows the final permitted goal turn to finish its multi-step tool exchange', async () => {
    const ctx = testAgent({
      jian: createCommandJian('turn-budget-tool-ran'),
      initialConfig: { providers: {}, enableSpecCritic: false },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Use one complete turn' });
    await ctx.agent.goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } });
    ctx.mockNextResponse(
      { type: 'text', text: 'Running the turn-budget tool.' },
      bashCallWithId('call_turn_budget_bash', 'printf bounded'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'The permitted turn is finished.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use the permitted turn' }] });
    await ctx.agent.turn.waitForCurrentTurn();

    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      status: 'blocked',
      terminalReason: 'A configured budget was reached',
      turnsUsed: 1,
    });
  });

  it('keeps a resumed goal drive cancellable after the standalone first turn releases', async () => {
    const secondCall = deferred<GenerateResult>();
    let generateCalls = 0;
    const ctx = testAgent({
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          // The model reactivates the paused goal during the first turn.
          await ctx.agent.goal.resumeGoal({ reason: 'reactivated' });
          return textResult('resuming the goal');
        }
        return secondCall.promise;
      },
    });
    ctx.configure();
    await ctx.agent.goal.createGoal({ objective: 'Finish the batch' });
    await ctx.agent.goal.pauseGoal({ reason: 'hold' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await vi.waitFor(() => {
      expect(generateCalls).toBe(2);
    });

    // The standalone first turn released the active turn at turn.ended; the
    // goal drive after it must still be observable (no 'No active turn'
    // rejection) and cancellable.
    const drive = ctx.agent.turn.waitForCurrentTurn();
    ctx.agent.turn.cancel();
    secondCall.resolve(textResult('late reply'));

    const end = await drive;
    expect(end.event.reason).toBe('cancelled');
    expect(ctx.agent.goal.getGoal().goal?.status).toBe('paused');
  });

  it('cancels an active turn', async () => {
    const ctx = testAgent({
      jian: createCommandJian('should-not-run'),
    });
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });

    expect(await ctx.untilApprovalRequest()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run a command" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run a command" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will run Bash." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run Bash." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run a command"
    `);
    await ctx.rpc.cancel({ turnId: 0 });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.cancel                 { "turnId": 0, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "aborted" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "cancelled" }
    `);
    await ctx.expectResumeMatches();
  });

  it('does not apply a provider response that arrives after agent close', async () => {
    const response = deferred<GenerateResult>();
    const generateStarted = deferred<void>();
    const ctx = testAgent({
      generate: () => {
        generateStarted.resolve();
        return response.promise;
      },
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'wait for the late response' }] });
    await generateStarted.promise;
    const turn = ctx.agent.turn.waitForCurrentTurn();
    ctx.agent.turn.cancel(0);
    await ctx.agent.close();
    const historyAtClose = structuredClone(ctx.agent.context.history);
    const usageAtClose = ctx.agent.usage.stats();
    const eventCountAtClose = ctx.allEvents.length;

    response.resolve(textResult('must not be replayed after close'));
    await turn;

    expect(ctx.agent.context.history).toEqual(historyAtClose);
    expect(ctx.agent.usage.stats()).toEqual(usageAtClose);
    expect(ctx.allEvents).toHaveLength(eventCountAtClose);
  });

  it('buffers steer input and includes it in the same turn after approval', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf approved","timeout":60}',
    };
    const ctx = testAgent({
      jian: createCommandJian('approved'),
    });
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will ask first.' }, bashCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash, then listen' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash, then listen" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash, then listen" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will ask first." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf approved\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will ask first." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run Bash, then listen"
    `);
    expect(ctx.llmCalls).toHaveLength(1);

    await ctx.rpc.steer({ input: [{ type: 'text', text: 'Also mention the steer.' }] });
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.newEvents()).toMatchInlineSnapshot(`[wire] turn.steer   { "input": [ { "type": "text", "text": "Also mention the steer." } ], "origin": { "kind": "user" }, "time": "<time>" }`);

    ctx.mockNextResponse({ type: 'text', text: 'Approved, and I saw the steer.' });
    approval.respond({
      decision: 'approved',
      selectedLabel: 'approve',
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 }, "description": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 }, "description": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "approved" } }, "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "approved" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 29, "maxContextTokens": 1000000, "contextUsage": 0.000029, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "Also mention the steer." } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "Approved, and I saw the steer." }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "Approved, and I saw the steer." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 50, "maxContextTokens": 1000000, "contextUsage": 0.00005, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will ask first."  calls call_bash:Bash { "command": "printf approved", "timeout": 60 }
        tool[call_bash]: text "approved"
        user: text "Also mention the steer."
    `);
    expect(ctx.llmCalls).toHaveLength(2);
    await ctx.expectResumeMatches();
  });

  it('rejects a non-steer prompt while a turn is active', async () => {
    const ctx = testAgent({ jian: createCommandJian('should-not-run') });
    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will wait for approval.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the active turn' }] });

    expect(await ctx.untilApprovalRequest()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Start the active turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Start the active turn" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will wait for approval." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will wait for approval." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Start the active turn"
    `);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'This should not start a new turn' }] });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] turn.prompt   { "input": [ { "type": "text", "text": "This should not start a new turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] error         { "code": "turn.agent_busy", "message": "Cannot launch a new turn while another turn (ID 0) is active", "details": { "turnId": 0 }, "retryable": true }
    `);
    await ctx.rpc.cancel({ turnId: 0 });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.cancel                 { "turnId": 0, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "aborted" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "cancelled" }
    `);
    await ctx.expectResumeMatches();
  });
});

function bashCall(): ToolCall {
  return bashCallWithId('call_bash', 'printf should-not-run');
}

function bashCallWithId(id: string, command: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('mp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

const DEFAULT_MEDIA_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: MP4_HEADER.length,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

function createVideoJian(): Jian {
  return createFakeJian({
    stat: vi.fn<Jian['stat']>().mockResolvedValue(DEFAULT_MEDIA_STAT),
    readBytes: vi.fn<Jian['readBytes']>().mockResolvedValue(MP4_HEADER),
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function oauthAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
  capabilities?: readonly string[] | undefined,
): Pick<TestAgentOptions, 'initialConfig' | 'providerManagerOverrides'> {
  return {
    initialConfig: {
      defaultModel: 'lmcode',
      providers: {
        'managed:lmcode': {
          type: 'vertexai',
          baseUrl: 'https://api.example/v1',
          oauth: { storage: 'file', key: 'oauth/lmcode' },
        },
      },
      models: {
        'lmcode': {
          provider: 'managed:lmcode',
          model: 'lmcode-for-coding',
          maxContextSize: 1_000_000,
          capabilities: capabilities === undefined ? undefined : [...capabilities],
        },
      },
    },
    providerManagerOverrides: {
      resolveOAuthTokenProvider: vi.fn(() => ({ getAccessToken })),
    },
  };
}

function textResult(text: string): GenerateResult {
  return {
    id: 'mock-oauth-retry',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
