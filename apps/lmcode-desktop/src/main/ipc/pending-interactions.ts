interface PendingEntry<T> {
  readonly sessionId: string
  readonly resolve: (value: T) => void
}

interface PendingRequestOptions<T> {
  readonly timeoutMs: number
  readonly timeoutValue: T
  readonly onSettled: (requestId: string, sessionId: string) => void
}

export class PendingInteractionRegistry<T> {
  private readonly entries = new Map<string, PendingEntry<T>>()

  get size(): number {
    return this.entries.size
  }

  add(requestId: string, sessionId: string, resolve: (value: T) => void): void {
    if (this.entries.has(requestId)) {
      throw new Error(`Pending interaction "${requestId}" already exists`)
    }
    this.entries.set(requestId, { sessionId, resolve })
  }

  request(
    requestId: string,
    sessionId: string,
    options: PendingRequestOptions<T>,
  ): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<T>()
    this.add(requestId, sessionId, resolve)
    const timeout = setTimeout(() => {
      this.settle(requestId, options.timeoutValue)
    }, options.timeoutMs)
    timeout.unref()

    return promise.finally(() => {
      clearTimeout(timeout)
      this.entries.delete(requestId)
      options.onSettled(requestId, sessionId)
    })
  }

  settle(requestId: string, value: T): boolean {
    const entry = this.entries.get(requestId)
    if (entry === undefined) return false

    this.entries.delete(requestId)
    entry.resolve(value)
    return true
  }

  settleSession(sessionId: string, value: T): number {
    return this.settleMatching((entry) => entry.sessionId === sessionId, value)
  }

  settleAll(value: T): number {
    return this.settleMatching(() => true, value)
  }

  private settleMatching(predicate: (entry: PendingEntry<T>) => boolean, value: T): number {
    let settled = 0
    for (const [requestId, entry] of this.entries) {
      if (!predicate(entry)) continue
      this.entries.delete(requestId)
      entry.resolve(value)
      settled += 1
    }
    return settled
  }
}
