import { afterEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp',
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinkingLevel: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    promptCacheHitRatio: null,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FooterComponent — thinking shimmer timer', () => {
  it('starts the 30fps timer when the phase flips to thinking in place, and stops it on idle', () => {
    vi.useFakeTimers();
    const ui = { requestRender: vi.fn() };
    // The host patches appState via Object.assign and then calls
    // footer.setState(appState) with the SAME object, so the footer cannot
    // diff previous/current — the timer must follow the current phase.
    const state = baseState();
    const footer = new FooterComponent(state, darkColors, ui as never);

    state.streamingPhase = 'thinking';
    footer.setState(state);
    vi.advanceTimersByTime(200);
    const thinkingCalls = ui.requestRender.mock.calls.length;
    expect(thinkingCalls).toBeGreaterThan(0);

    state.streamingPhase = 'idle';
    footer.setState(state);
    ui.requestRender.mockClear();
    vi.advanceTimersByTime(200);
    expect(ui.requestRender).not.toHaveBeenCalled();

    footer.dispose();
  });

  it('repeated setState calls while thinking keep exactly one timer running', () => {
    vi.useFakeTimers();
    const ui = { requestRender: vi.fn() };
    const state = baseState({ streamingPhase: 'thinking' });
    const footer = new FooterComponent(state, darkColors, ui as never);

    footer.setState(state);
    footer.setState(state);
    footer.setState(state);
    vi.advanceTimersByTime(1000 / 30 + 5);
    expect(ui.requestRender).toHaveBeenCalledTimes(1);

    footer.dispose();
    ui.requestRender.mockClear();
    vi.advanceTimersByTime(200);
    expect(ui.requestRender).not.toHaveBeenCalled();
  });
});
