import { describe, expect, it } from 'vitest';

import {
  abnormalTurnMessage,
  waitForSessionIdle,
  type EvalSessionEvent,
} from './session-idle';

class FakeSession {
  private readonly listeners = new Set<(event: EvalSessionEvent) => void>();

  onEvent(listener: (event: EvalSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: EvalSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function started(turnId: number): EvalSessionEvent {
  return { type: 'turn.started', turnId };
}

function ended(
  turnId: number,
  reason: 'completed' | 'cancelled' | 'failed',
  error?: { message: string },
): EvalSessionEvent {
  return {
    type: 'turn.ended',
    turnId,
    reason,
    ...(error === undefined ? {} : { error }),
  };
}

describe('waitForSessionIdle', () => {
  it('resolves on the first completed turn when no follow-up starts', async () => {
    const session = new FakeSession();
    const idle = waitForSessionIdle(session, 1_000);
    session.emit(started(1));
    session.emit(ended(1, 'completed'));
    await expect(idle).resolves.toMatchObject({ type: 'turn.ended', turnId: 1, reason: 'completed' });
  });

  it('does not settle on the standalone turn.ended if goal drive starts synchronously', async () => {
    const session = new FakeSession();
    const idle = waitForSessionIdle(session, 1_000);
    session.emit(started(1));
    session.emit(ended(1, 'completed'));
    session.emit(started(2));
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    session.emit(ended(2, 'completed'));
    await expect(idle).resolves.toMatchObject({ type: 'turn.ended', turnId: 2, reason: 'completed' });
  });

  it('returns the last ended event after several goal continuations', async () => {
    const session = new FakeSession();
    const idle = waitForSessionIdle(session, 1_000);
    session.emit(started(1));
    session.emit(ended(1, 'completed'));
    session.emit(started(2));
    session.emit(ended(2, 'completed'));
    session.emit(started(3));
    session.emit(ended(3, 'failed', { message: 'budget exceeded' }));
    await expect(idle).resolves.toMatchObject({
      type: 'turn.ended',
      turnId: 3,
      reason: 'failed',
    });
  });

  it('times out if a turn never ends', async () => {
    const session = new FakeSession();
    const idle = waitForSessionIdle(session, 30);
    session.emit(started(1));
    await expect(idle).rejects.toThrow(/Timed out after 30ms waiting for session idle/);
  });

  it('rejects when aborted before the session goes idle', async () => {
    const session = new FakeSession();
    const abort = new AbortController();
    const idle = waitForSessionIdle(session, 1_000, abort.signal);
    session.emit(started(1));
    abort.abort();
    await expect(idle).rejects.toThrow(/session idle wait aborted/);
  });
});

describe('abnormalTurnMessage', () => {
  it('ignores a completed turn', () => {
    expect(abnormalTurnMessage(ended(1, 'completed'))).toBeUndefined();
  });

  it('reports cancelled turns', () => {
    expect(abnormalTurnMessage(ended(1, 'cancelled'))).toBe('turn cancelled');
  });

  it('reports failed turns with the payload message', () => {
    expect(abnormalTurnMessage(ended(1, 'failed', { message: 'context overflow' }))).toBe(
      'context overflow',
    );
  });

  it('falls back when a failed turn has no message', () => {
    expect(abnormalTurnMessage(ended(1, 'failed'))).toBe('turn ended with failure');
  });
});
