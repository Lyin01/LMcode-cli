import type { Agent } from '..';

export abstract class DynamicInjector {
  protected injectedAt: number | null = null;

  constructor(protected readonly agent: Agent) {}

  onContextClear(): void {
    this.injectedAt = null;
  }

  onContextCompacted(compactedCount: number): void {
    if (this.injectedAt !== null) {
      const newInjectedAt = this.injectedAt - compactedCount + 1;
      this.injectedAt = newInjectedAt >= 0 ? newInjectedAt : null;
    }
  }

  /**
   * Called when a single message is removed from the context history (e.g.
   * by `/undo`). Adjusts the injection position so future injections don't
   * reference a stale index or re-inject too early.
   */
  onContextMessageRemoved(index: number): void {
    if (this.injectedAt === null) return;
    if (index < this.injectedAt) {
      this.injectedAt--;
    } else if (index === this.injectedAt) {
      this.injectedAt = null;
    }
  }

  /**
   * Collect the injection string without appending it to context.
   * Returns the string content or undefined if no injection is needed.
   */
  async collectInjection(): Promise<string | undefined> {
    return this.getInjection();
  }

  /**
   * Mark this injector as having been injected at the given history position.
   */
  markInjected(position: number): void {
    this.injectedAt = position;
  }

  async inject(): Promise<void> {
    const injection = await this.getInjection();
    if (injection) {
      this.injectedAt = this.agent.context.history.length;
      this.agent.context.appendSystemReminder(injection, {
        kind: 'injection',
        variant: this.injectionVariant,
      });
    }
  }

  abstract readonly injectionVariant: string;

  protected abstract getInjection(): string | Promise<string | undefined> | undefined;
}
