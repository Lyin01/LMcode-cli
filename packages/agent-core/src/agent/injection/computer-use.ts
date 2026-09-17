import { DynamicInjector } from './injector';
import COMPUTER_USE_GUIDANCE from './computer-use.md';

/**
 * Address the target with a handle from the current snapshot, not a guess.
 * Repeated as the sparse variant so the invariant survives compaction.
 */
const SPARSE_REMINDER = [
  'Computer use is still active (full operating contract given earlier).',
  'Before acting on a window: re-read its state with get_window_state and use a handle from that',
  'snapshot. Keep background delivery as the first attempt, verify the outcome from fresh state,',
  'and remember that cancelled or delivered input is not rolled back.',
].join('\n');

const EXIT_REMINDER = [
  'Computer use is no longer active. The desktop tools are gone and you can no longer observe or',
  'operate the user\'s applications.',
  '  - Do not claim to have seen the screen or acted on a window after this point.',
  '  - Anything already delivered to the desktop stays delivered; ask the user to confirm state.',
].join('\n');

/**
 * Assistant messages allowed to accumulate before the full contract is
 * re-stated. The operating contract is safety-relevant (it governs input
 * delivery and verification), so it is refreshed rather than injected once.
 */
const FULL_REFRESH_TURNS = 5;

/** Assistant messages before a compressed reminder is worth repeating. */
const SPARSE_REMINDER_TURNS = 2;

export class ComputerUseInjector extends DynamicInjector {
  readonly injectionVariant = 'computer_use';
  private wasActive = false;

  getInjection(): string | undefined {
    const isActive = this.agent.computerUse?.isActive() ?? false;

    if (!isActive) {
      if (!this.wasActive) return undefined;
      this.wasActive = false;
      this.injectedAt = null;
      return EXIT_REMINDER;
    }

    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
      return COMPUTER_USE_GUIDANCE;
    }

    if (this.injectedAt === null) return COMPUTER_USE_GUIDANCE;

    let assistantTurnsSince = 0;
    const history = this.agent.context.history;
    for (let i = this.injectedAt + 1; i < history.length; i++) {
      const message = history[i];
      if (message === undefined) continue;
      if (message.role === 'assistant') {
        assistantTurnsSince += 1;
        continue;
      }
      if (message.role === 'user') return COMPUTER_USE_GUIDANCE;
    }

    if (assistantTurnsSince >= FULL_REFRESH_TURNS) return COMPUTER_USE_GUIDANCE;
    if (assistantTurnsSince >= SPARSE_REMINDER_TURNS) return SPARSE_REMINDER;
    return undefined;
  }
}
