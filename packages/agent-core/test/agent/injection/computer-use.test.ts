import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { ComputerUseInjector } from '../../../src/agent/injection/computer-use';

interface ComputerUseStub {
  active: boolean;
}

function computerUseAgent(stub: ComputerUseStub): Agent {
  const history: unknown[] = [];
  return {
    type: 'main',
    computerUse: {
      isActive: () => stub.active,
    },
    context: {
      history,
      appendSystemReminder: (content: string) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }] });
      },
    },
  } as unknown as Agent;
}

function injectionText(agent: Agent, index: number): string {
  const history = agent.context.history as unknown as Array<{
    role: string;
    content?: ReadonlyArray<{ text?: string }>;
  }>;
  return history[index]?.content?.map((part) => part.text ?? '').join('') ?? '';
}

function assistantMessage(agent: Agent): void {
  (agent.context.history as unknown as unknown[]).push({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
  });
}

describe('ComputerUseInjector', () => {
  it('states the desktop operating contract when the capability goes live', async () => {
    const stub: ComputerUseStub = { active: true };
    const agent = computerUseAgent(stub);
    const injector = new ComputerUseInjector(agent);

    await injector.inject();
    const text = injectionText(agent, 0);

    expect(text).toContain('get_window_state');
    expect(text).toContain('element_token');
    expect(text).toContain('background');
    expect(text).toContain('verify_state');
    // The contract must say that delivered input is irreversible.
    expect(text).toContain('not withdrawn');
  });

  it('does not repeat the full contract on the next turn', async () => {
    const stub: ComputerUseStub = { active: true };
    const agent = computerUseAgent(stub);
    const injector = new ComputerUseInjector(agent);

    await injector.inject();
    const afterFirst = agent.context.history.length;
    await injector.inject();

    expect(agent.context.history.length).toBe(afterFirst);
  });

  it('withdraws the contract once the capability is gone, and only once', async () => {
    const stub: ComputerUseStub = { active: true };
    const agent = computerUseAgent(stub);
    const injector = new ComputerUseInjector(agent);

    await injector.inject();
    stub.active = false;

    await injector.inject();
    const exit = injectionText(agent, 1);
    expect(exit).toContain('no longer active');
    expect(exit).toContain('stays delivered');

    const afterExit = agent.context.history.length;
    await injector.inject();
    expect(agent.context.history.length).toBe(afterExit);
  });

  it('refreshes the contract after enough assistant turns', async () => {
    const stub: ComputerUseStub = { active: true };
    const agent = computerUseAgent(stub);
    const injector = new ComputerUseInjector(agent);

    await injector.inject();
    const afterFirst = agent.context.history.length;

    // Five assistant turns since the injection is the documented refresh point.
    for (let i = 0; i < 5; i++) assistantMessage(agent);
    await injector.inject();

    const refresh = injectionText(agent, afterFirst + 5);
    expect(agent.context.history.length).toBe(afterFirst + 6);
    expect(refresh).toContain('get_window_state');
  });

  it('stays silent when the capability was never active', async () => {
    const agent = computerUseAgent({ active: false });
    const injector = new ComputerUseInjector(agent);

    await injector.inject();

    expect(agent.context.history).toHaveLength(0);
  });
});
