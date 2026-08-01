import { describe, expect, it, vi } from 'vitest';

import type { SDKRpcClient } from '../src/rpc';
import { Session } from '../src/session';
import type { ResumedSessionState, SessionSummary } from '../src/types';

describe('Session metadata', () => {
  it('persists fresh-session custom metadata without adding a nested custom object', async () => {
    const updateSessionMetadata = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_fresh_metadata',
      workDir: '/workspace',
      summary: summary('ses_fresh_metadata', { source: 'desktop', attempt: 1 }),
      rpc: { updateSessionMetadata } as unknown as SDKRpcClient,
    });
    session.metadata['runId'] = 'run-1';

    await session.writeMetadata();

    expect(session.metadata).toEqual({ source: 'desktop', attempt: 1, runId: 'run-1' });
    expect(updateSessionMetadata).toHaveBeenCalledWith({
      sessionId: session.id,
      metadata: {
        custom: { source: 'desktop', attempt: 1, runId: 'run-1' },
      },
    });
  });

  it('exposes only custom metadata when a persisted session is resumed', async () => {
    const updateSessionMetadata = vi.fn(async () => {});
    const resumeState: ResumedSessionState = {
      sessionMetadata: {
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
        title: 'Existing session',
        isCustomTitle: true,
        agents: {},
        custom: { source: 'desktop', worktree: 'feature/harness' },
      },
      agents: {},
    };
    const session = new Session({
      id: 'ses_resumed_metadata',
      workDir: '/workspace',
      summary: summary('ses_resumed_metadata', { stale: true }),
      resumeState,
      rpc: { updateSessionMetadata } as unknown as SDKRpcClient,
    });

    await session.writeMetadata();

    expect(session.metadata).toEqual({ source: 'desktop', worktree: 'feature/harness' });
    expect(updateSessionMetadata).toHaveBeenCalledWith({
      sessionId: session.id,
      metadata: {
        custom: { source: 'desktop', worktree: 'feature/harness' },
      },
    });
  });
});

function summary(id: string, metadata: SessionSummary['metadata']): SessionSummary {
  return {
    id,
    workDir: '/workspace',
    sessionDir: `/home/sessions/${id}`,
    createdAt: 1,
    updatedAt: 1,
    metadata,
  };
}
