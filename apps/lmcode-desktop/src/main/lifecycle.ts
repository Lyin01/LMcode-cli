export interface BeforeQuitEvent {
  preventDefault(): void
}

export type BudgetOutcome = 'completed' | 'budget-exceeded'

/**
 * Race an async cleanup against a hard time budget. The work keeps running
 * in the background either way (its own handlers log failures); callers use
 * this to bound how long process shutdown waits for best-effort cleanup.
 */
export function withTimeoutBudget(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<BudgetOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('budget-exceeded'), budgetMs)
    void work.then(
      () => {
        clearTimeout(timer)
        resolve('completed')
      },
      () => {
        clearTimeout(timer)
        resolve('completed')
      },
    )
  })
}

export function onceAsync(task: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined
  return () => {
    result ??= Promise.resolve().then(task)
    return result
  }
}

export class ShutdownCoordinator {
  private cleanup: Promise<void> | undefined
  private quitAllowed = false

  constructor(
    private readonly cleanupApplication: () => Promise<void>,
    private readonly requestQuit: () => void,
    private readonly reportError: (error: unknown) => void,
  ) {}

  handleBeforeQuit(event: BeforeQuitEvent): void {
    if (this.quitAllowed) return
    event.preventDefault()
    if (this.cleanup !== undefined) return

    this.cleanup = this.runCleanup()
  }

  waitForCleanup(): Promise<void> {
    return this.cleanup ?? Promise.resolve()
  }

  private async runCleanup(): Promise<void> {
    try {
      await this.cleanupApplication()
    } catch (error) {
      this.reportError(error)
    } finally {
      this.quitAllowed = true
      this.requestQuit()
    }
  }
}
