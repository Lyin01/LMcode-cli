import { describe, expect, it } from 'vitest';

import { SessionMemory } from '../../src/agent/session-memory';

describe('SessionMemory', () => {
  it('reports new events after the turn step counter resets', () => {
    const memory = new SessionMemory();
    memory.recordToolExecution('Read', 'first.ts', false, 3);

    const firstSummary = memory.getSessionSummary();
    expect(firstSummary).toContain('Read');
    expect(firstSummary).toContain('first.ts');
    expect(memory.getSessionSummary()).toBe('');

    // Loop step numbers restart at one for each turn. This event is newer even
    // though its step is lower than the previously injected event.
    memory.recordToolExecution('Edit', 'second.ts', false, 1);

    const nextSummary = memory.getSessionSummary();
    expect(nextSummary).toContain('Edit');
    expect(nextSummary).toContain('second.ts');
    expect(nextSummary).not.toContain('first.ts');
  });

  it('starts a fresh sequence after clear', () => {
    const memory = new SessionMemory();
    memory.recordError('old failure', 2);
    expect(memory.getSessionSummary()).toContain('old failure');

    memory.clear();
    memory.recordError('new failure', 1);

    const summary = memory.getSessionSummary();
    expect(summary).toContain('new failure');
    expect(summary).not.toContain('old failure');
  });
});
