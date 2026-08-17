import type { ToolCall } from '@lmcode-cli/ltod';
import { expect, it } from 'vitest';

import { testAgent, createCommandJian } from './harness/agent';

// loopTools is sorted by tool name (localeCompare), so expectations are
// written in that order.
const BOOTSTRAP = ['Bash', 'Edit', 'Read', 'Write'];
const FULL = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoList', 'Write'];
const SESSION_CONTEXT_MARKER = 'AGENTS.md digest + skill catalog (anchored bootstrap test)';
/** LmcodeConfig requires `providers`; the harness merges via configWithProvider. */
const BASE_CONFIG = { providers: {} };
const ANCHORED_CONFIG = { ...BASE_CONFIG, anchoredBootstrap: { enabled: true } };

/** Append the same kind of session-context reminder the runtime injects as
 *  the first message (AGENTS.md + skill-catalog digest). */
function seedSessionContext(ctx: ReturnType<typeof testAgent>): void {
  ctx.agent.context.appendSystemReminder(SESSION_CONTEXT_MARKER, {
    kind: 'injection',
    variant: 'session_context',
  });
}

function hasSessionContext(
  history: readonly { role: string; content: readonly { type: string; text?: string }[] }[],
): boolean {
  return history.some((message) =>
    message.content.some(
      (part) => part.type === 'text' && part.text?.includes(SESSION_CONTEXT_MARKER),
    ),
  );
}

it('anchors the first request on the bootstrap tool subset and preserves session context', async () => {
  const ctx = testAgent({ initialConfig: ANCHORED_CONFIG });
  ctx.configure({ tools: FULL });
  seedSessionContext(ctx);

  ctx.mockNextResponse({ type: 'text', text: 'hello there' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();

  const input = ctx.lastLlmInput().input;
  expect(input.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP);
  expect(hasSessionContext(input.history)).toBe(true);
});

it('suppresses session context only when explicitly configured', async () => {
  const ctx = testAgent({
    initialConfig: {
      ...BASE_CONFIG,
      anchoredBootstrap: { enabled: true, suppressContext: true },
    },
  });
  ctx.configure({ tools: FULL });
  seedSessionContext(ctx);

  ctx.mockNextResponse({ type: 'text', text: 'hello there' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();

  expect(hasSessionContext(ctx.lastLlmInput().input.history)).toBe(false);
});

it('promotes to the full catalog and restores context after the first tool call (either)', async () => {
  const bashCall: ToolCall = {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf lookup-result","timeout":60}',
  };
  const ctx = testAgent({
    initialConfig: ANCHORED_CONFIG,
    jian: createCommandJian('lookup-result'),
  });
  ctx.configure({ tools: FULL });
  seedSessionContext(ctx);

  ctx.mockNextResponse({ type: 'text', text: 'I will run that.' }, bashCall);
  ctx.mockNextResponse({ type: 'text', text: 'The command printed lookup-result.' });
  await ctx.rpc.prompt({
    input: [{ type: 'text', text: 'Run a command that prints lookup-result' }],
  });
  await ctx.untilTurnEnd();

  const inputs = ctx.llmInputs().inputs;
  expect(inputs).toHaveLength(2);
  const first = inputs[0]!;
  const second = inputs[1]!;
  // Request #1: bootstrap catalog with the full instruction context.
  expect(first.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP);
  expect(hasSessionContext(first.history)).toBe(true);
  // Request #2 (after the durable tool call): full catalog, context restored.
  expect(second.tools.map((tool) => tool.name)).toEqual(FULL);
  expect(hasSessionContext(second.history)).toBe(true);
});

it('promotes after the first assistant reply (either), including across turns', async () => {
  const ctx = testAgent({ initialConfig: ANCHORED_CONFIG });
  ctx.configure({ tools: FULL });
  seedSessionContext(ctx);

  ctx.mockNextResponse({ type: 'text', text: 'first reply' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();
  const first = ctx.lastLlmInput().input;
  expect(first.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP);
  expect(hasSessionContext(first.history)).toBe(true);

  // A brand-new turn now sees the promoted surface (durable from history).
  ctx.mockNextResponse({ type: 'text', text: 'second reply' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Again' }] });
  await ctx.untilTurnEnd();
  const second = ctx.lastLlmInput().input;
  expect(second.tools.map((tool) => tool.name)).toEqual(FULL);
  expect(hasSessionContext(second.history)).toBe(true);
});

it('keeps the bootstrap catalog when promoteOn is tool-call and the reply is text-only', async () => {
  const ctx = testAgent({
    initialConfig: { ...BASE_CONFIG, anchoredBootstrap: { enabled: true, promoteOn: 'tool-call' } },
  });
  ctx.configure({ tools: FULL });

  ctx.mockNextResponse({ type: 'text', text: 'first reply' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();
  expect(ctx.lastLlmInput().input.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP);

  // A text-only reply is NOT a promotion signal under 'tool-call'.
  ctx.mockNextResponse({ type: 'text', text: 'second reply' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Again' }] });
  await ctx.untilTurnEnd();
  expect(ctx.lastLlmInput().input.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP);
});

it('leaves subagents on the full catalog', async () => {
  const ctx = testAgent({
    initialConfig: ANCHORED_CONFIG,
    type: 'sub',
  });
  ctx.configure({ tools: FULL });
  seedSessionContext(ctx);

  ctx.mockNextResponse({ type: 'text', text: 'sub reply' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Do it' }] });
  await ctx.untilTurnEnd();

  const input = ctx.lastLlmInput().input;
  expect(input.tools.map((tool) => tool.name)).toEqual(FULL);
  expect(hasSessionContext(input.history)).toBe(true);
});

it('is a no-op when disabled (full catalog and injected context preserved)', async () => {
  const ctx = testAgent();
  ctx.configure({ tools: FULL });
  seedSessionContext(ctx);

  ctx.mockNextResponse({ type: 'text', text: 'plain reply' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();

  const input = ctx.lastLlmInput().input;
  expect(input.tools.map((tool) => tool.name)).toEqual(FULL);
  expect(hasSessionContext(input.history)).toBe(true);
});

it('auto-enables via provider name match', async () => {
  const ctx = testAgent({
    initialConfig: { ...BASE_CONFIG, anchoredBootstrap: { providers: ['openai'] } },
  });
  ctx.configure({
    tools: FULL,
    provider: { type: 'openai', apiKey: 'test-key', model: 'mock-model' },
  });

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();

  expect(ctx.lastLlmInput().input.tools.map((tool) => tool.name)).toEqual(BOOTSTRAP);
});

it('degrades to the full catalog when none of the bootstrap tools exist', async () => {
  const ctx = testAgent({
    initialConfig: {
      ...BASE_CONFIG,
      anchoredBootstrap: { enabled: true, bootstrapTools: ['DoesNotExist'] },
    },
  });
  ctx.configure({ tools: FULL });

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
  await ctx.untilTurnEnd();

  // Never send a zero-tool request: fall back to the full catalog.
  expect(ctx.lastLlmInput().input.tools.map((tool) => tool.name)).toEqual(FULL);
});
