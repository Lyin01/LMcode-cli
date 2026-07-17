import type { Component, Focusable } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DialogManager, type DialogManagerHost } from '#/tui/managers/dialog-manager';
import type { TUIState } from '#/tui/tui-state';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import { getColorPalette } from '#/tui/theme/colors';

type FakeComponent = Component & Focusable;

interface Harness {
  readonly host: DialogManagerHost;
  readonly manager: DialogManager;
  readonly state: TUIState;
  readonly containerChildren: Component[];
  readonly editor: FakeComponent;
  readonly tasksBrowserClose: ReturnType<typeof vi.fn>;
}

function makeApprovalPayload(): ApprovalPanelData {
  return {
    id: 'approval_1',
    tool_call_id: 'tool_1',
    tool_name: 'WriteFile',
    action: 'write a file',
    description: 'Update README.md',
    display: [],
    choices: [
      { label: 'Approve once', response: 'approved' },
      { label: 'Reject', response: 'rejected' },
    ],
  } as ApprovalPanelData;
}

function makeHarness(): Harness {
  const containerChildren: Component[] = [];
  const editor = { kind: 'editor' } as unknown as FakeComponent;
  const tasksBrowserClose = vi.fn();
  const state = {
    activeDialog: null,
    editorContainer: {
      children: containerChildren,
      clear: () => {
        containerChildren.length = 0;
      },
      addChild: (child: Component) => {
        containerChildren.push(child);
      },
    },
    editor,
    ui: { setFocus: vi.fn(), requestRender: vi.fn() },
    tasksBrowser: undefined as unknown,
    appState: { notifications: { enabled: false, condition: 'always' } },
    terminalState: { notificationKeys: new Set<string>() },
    terminal: { write: vi.fn() },
    theme: { colors: getColorPalette('dark') },
  } as unknown as TUIState;

  const host = {
    state,
    approvalController: { respond: vi.fn() },
    questionController: { respond: vi.fn() },
    harness: {},
    tasksBrowserController: {
      close: tasksBrowserClose.mockImplementation(() => {
        state.tasksBrowser = undefined;
      }),
    },
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    resumeSession: vi.fn(),
    switchToSession: vi.fn(),
    deleteSession: vi.fn(),
    fetchSessions: vi.fn(),
    getSessions: () => [],
    getIsLoadingSessions: () => false,
    getCurrentSessionId: () => 'session-1',
    getCurrentWorkDir: () => '/workspace',
    toggleToolOutputExpansion: vi.fn(),
    togglePlanExpansion: vi.fn(),
    patchLivePane: vi.fn(),
  } as unknown as DialogManagerHost;

  return {
    host,
    manager: new DialogManager(host),
    state,
    containerChildren,
    editor,
    tasksBrowserClose,
  };
}

describe('DialogManager modal overlay handling', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.manager.dispose();
    harness = undefined;
  });

  it('restores the editor when no dialog was suspended', () => {
    harness = makeHarness();
    harness.containerChildren.push(harness.editor);

    harness.manager.showApprovalPanel(makeApprovalPayload());
    expect(harness.containerChildren).toHaveLength(1);
    expect(harness.containerChildren[0]).not.toBe(harness.editor);

    harness.manager.hideApprovalPanel();
    expect(harness.containerChildren).toEqual([harness.editor]);
    expect(harness.state.activeDialog).toBeNull();
  });

  it('restores the suspended picker and its activeDialog after the modal hides', () => {
    harness = makeHarness();
    const picker = { kind: 'session-picker' } as unknown as FakeComponent;
    harness.containerChildren.push(picker);
    harness.state.activeDialog = 'session-picker';

    harness.manager.showApprovalPanel(makeApprovalPayload());
    expect(harness.containerChildren).not.toContain(picker);

    harness.manager.hideApprovalPanel();

    // The picker the panel replaced must come back — leaving activeDialog
    // dangling hides the activity pane for the rest of the session.
    expect(harness.containerChildren).toEqual([picker]);
    expect(harness.state.activeDialog).toBe('session-picker');
  });

  it('closes the fullscreen tasks browser before mounting the modal', () => {
    harness = makeHarness();
    harness.containerChildren.push(harness.editor);
    harness.state.tasksBrowser = { component: {} } as unknown as TUIState['tasksBrowser'];

    harness.manager.showApprovalPanel(makeApprovalPayload());

    // Mounting into the detached editor container would leave the panel
    // invisible while the agent waits for an answer.
    expect(harness.tasksBrowserClose).toHaveBeenCalledTimes(1);
    expect(harness.containerChildren).toHaveLength(1);
    expect(harness.containerChildren[0]).not.toBe(harness.editor);
  });

  it('applies the same restore semantics to the question dialog', () => {
    harness = makeHarness();
    const picker = { kind: 'memory-picker' } as unknown as FakeComponent;
    harness.containerChildren.push(picker);
    harness.state.activeDialog = 'memory-picker';

    const payload: QuestionPanelData = {
      id: 'question_1',
      tool_call_id: 'tool_1',
      questions: [{ question: '继续吗？', multi_select: false, options: [{ label: '是' }, { label: '否' }] }],
    };
    harness.manager.showQuestionDialog(payload);
    harness.manager.hideQuestionDialog();

    expect(harness.containerChildren).toEqual([picker]);
    expect(harness.state.activeDialog).toBe('memory-picker');
  });
});
