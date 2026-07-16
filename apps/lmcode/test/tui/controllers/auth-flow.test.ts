import { describe, expect, it, vi } from 'vitest';

import {
  AuthFlowController,
  type AuthFlowHost,
} from '#/tui/controllers/auth-flow';

function createHost() {
  const setAppState = vi.fn();
  const host = {
    harness: {
      getConfig: vi.fn(async () => ({ models: {}, providers: {} })),
    },
    closeSession: vi.fn(async () => {}),
    resetSessionRuntime: vi.fn(),
    setAppState,
    refreshSkillCommands: vi.fn(async () => {}),
  } as unknown as AuthFlowHost;
  return { host, setAppState };
}

describe('AuthFlowController logout state', () => {
  it('clears the prompt cache hit ratio when removing the active session', async () => {
    const { host, setAppState } = createHost();
    const controller = new AuthFlowController(host);

    await controller.clearActiveSessionAfterLogout();

    expect(setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ promptCacheHitRatio: null }),
    );
  });

  it('clears the prompt cache hit ratio when refreshing logged-out config', async () => {
    const { host, setAppState } = createHost();
    const controller = new AuthFlowController(host);

    await controller.refreshConfigAfterLogout();

    expect(setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ promptCacheHitRatio: null }),
    );
  });
});
