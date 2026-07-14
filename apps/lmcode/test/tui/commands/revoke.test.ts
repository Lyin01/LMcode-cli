import { Container } from '@earendil-works/pi-tui';
import type { ContextMessage } from '@lmcode-cli/lmcode-sdk';
import { describe, expect, it, type Mock, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleRevokeCommand } from '#/tui/commands/revoke';
import {
  TranscriptController,
  type TranscriptControllerHost,
} from '#/tui/controllers/transcript-controller';
import { createLmcodeTUIThemeBundle } from '#/tui/theme/bundle';
import type { TUIState } from '#/tui/tui-state';
import type { TranscriptEntry } from '#/tui/types';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

function entry(
  id: string,
  kind: TranscriptEntry['kind'],
  extras: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    kind,
    renderMode: 'plain',
    content: id,
    ...extras,
  };
}

function message(
  role: ContextMessage['role'],
  origin: ContextMessage['origin'],
): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text: role }],
    toolCalls: [],
    origin,
  };
}

interface RevokeHarness {
  readonly host: SlashCommandHost;
  readonly transcriptController: TranscriptController;
  readonly undoHistory: Mock<(count: number) => Promise<void>>;
  readonly errors: string[];
}

function createHarness(
  transcriptEntries: TranscriptEntry[],
  history: readonly ContextMessage[],
): RevokeHarness {
  const undoHistory = vi.fn(async (_count: number): Promise<void> => {});
  const errors: string[] = [];
  const state = {
    appState: { streamingPhase: 'idle', workDir: '/workspace' },
    transcriptEntries,
    transcriptContainer: new Container(),
    theme: createLmcodeTUIThemeBundle('dark', 'dark'),
    ui: { requestRender: vi.fn() },
    terminal: { write: vi.fn() },
    toolOutputExpanded: false,
    planExpanded: false,
    editor: { hasFirstInputFired: () => true },
  } as unknown as TUIState;
  const controllerHost = {
    state,
    imageStore: new ImageAttachmentStore(),
    streamingUI: {},
    showStatus: vi.fn(),
  } as unknown as TranscriptControllerHost;
  const transcriptController = new TranscriptController(controllerHost);
  transcriptController.replaceEntriesAndRebuild(transcriptEntries);
  const host = {
    state,
    transcriptController,
    session: {
      getContext: vi.fn(async () => ({ history, tokenCount: 0 })),
      undoHistory,
    },
    showError: (text: string) => errors.push(text),
  } as unknown as SlashCommandHost;
  return { host, transcriptController, undoHistory, errors };
}

describe('/revoke', () => {
  it('anchors model-triggered skill activations to the preceding user turn', async () => {
    const entries = [
      entry('welcome', 'welcome'),
      entry('user-1', 'user'),
      entry('assistant-1', 'assistant'),
      entry('model-skill', 'skill_activation', { skillTrigger: 'model-tool' }),
      entry('assistant-2', 'assistant'),
    ];
    const harness = createHarness(entries, [
      message('user', { kind: 'user' }),
      message('assistant', undefined),
      message('user', {
        kind: 'skill_activation',
        activationId: 'activation-1',
        skillName: 'review',
        trigger: 'model-tool',
      }),
      message('assistant', undefined),
    ]);

    await handleRevokeCommand(harness.host);

    expect(harness.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.id)).toEqual(['welcome']);
    expect(harness.errors).toEqual([]);
  });

  it('treats user slash skill activations as their own undoable turn', async () => {
    const entries = [
      entry('welcome', 'welcome'),
      entry('user-1', 'user'),
      entry('assistant-1', 'assistant'),
      entry('user-skill', 'skill_activation', { skillTrigger: 'user-slash' }),
      entry('assistant-2', 'assistant'),
    ];
    const harness = createHarness(entries, [
      message('user', { kind: 'user' }),
      message('assistant', undefined),
      message('user', {
        kind: 'skill_activation',
        activationId: 'activation-2',
        skillName: 'review',
        trigger: 'user-slash',
      }),
      message('assistant', undefined),
    ]);

    await handleRevokeCommand(harness.host);

    expect(harness.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.id)).toEqual(['welcome', 'user-1', 'assistant-1']);
  });

  it('does not remove transcript turns beyond the latest compaction summary', async () => {
    const entries = [
      entry('welcome', 'welcome'),
      entry('old-user', 'user'),
      entry('old-assistant', 'assistant'),
      entry('compaction', 'tool_call', {
        compactionData: { tokensBefore: 100, tokensAfter: 20 },
      }),
      entry('recent-user', 'user'),
      entry('recent-assistant', 'assistant'),
    ];
    const harness = createHarness(entries, [
      message('assistant', { kind: 'compaction_summary' }),
      message('user', { kind: 'user' }),
      message('assistant', undefined),
    ]);

    await handleRevokeCommand(harness.host, '5');

    expect(harness.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.id)).toEqual([
      'welcome',
      'old-user',
      'old-assistant',
      'compaction',
    ]);
  });

  it('rebuilds UI and entries consistently when revoke crosses the committed boundary', async () => {
    const entries = Array.from({ length: 160 }, (_, index) =>
      entry(`user-${String(index)}`, 'user'),
    );
    const history = Array.from({ length: 160 }, () =>
      message('user', { kind: 'user' }),
    );
    const harness = createHarness(entries, history);

    expect(harness.transcriptController.getCommittedCount()).toBeGreaterThan(0);
    expect(harness.host.state.transcriptContainer.children.length).toBeLessThan(entries.length);

    await handleRevokeCommand(harness.host, '155');

    expect(harness.undoHistory).toHaveBeenCalledWith(155);
    expect(entries.map((item) => item.id)).toEqual([
      'user-0',
      'user-1',
      'user-2',
      'user-3',
      'user-4',
    ]);
    expect(harness.transcriptController.getCommittedCount()).toBe(0);
    expect(harness.host.state.transcriptContainer.children).toHaveLength(5);
    expect(
      harness.host.state.transcriptContainer.children.map(
        (component) => harness.transcriptController.findEntryForComponent(component)?.id,
      ),
    ).toEqual(entries.map((item) => item.id));
    expect(harness.errors).toEqual([]);
  });
});
