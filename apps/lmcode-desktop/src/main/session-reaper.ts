/**
 * Reclaims desktop sessions that have gone idle.
 *
 * A session's MCP servers (and the computer-use driver) are child processes
 * that live exactly as long as the session. The desktop keeps every session
 * the user ever opened alive for fast switching and never closes it on its
 * own, so a long-running app accumulates one process tree per conversation
 * it has touched. This reaper closes sessions that have been untouched past
 * a TTL; the next interaction resumes them on demand through
 * `ensureActiveSession`, which spawns a fresh set of children.
 */

export interface ReapCandidate {
  readonly sessionId: string
  readonly lastActivityAt: number
}

export interface IdleSessionReaperDeps {
  /** Snapshot of currently live sessions with their last activity stamp. */
  readonly listCandidates: () => readonly ReapCandidate[]
  /**
   * Final veto for a candidate, run immediately before `reclaim` so guards
   * see fresh state (cron jobs, background tasks, pending interactions,
   * turns in flight). Returning `false` skips the session for this scan.
   */
  readonly canReclaim: (sessionId: string) => Promise<boolean>
  /** Close the session. Must be idempotent and tolerant of lost races. */
  readonly reclaim: (sessionId: string) => Promise<void>
}

export interface IdleSessionReaperOptions {
  /** Sessions idle for at least this long become eligible. */
  readonly idleTtlMs?: number
  /** Delay between scans. */
  readonly scanIntervalMs?: number
  readonly now?: () => number
  readonly setIntervalFn?: (callback: () => void, intervalMs: number) => NodeJS.Timeout
  readonly clearIntervalFn?: (handle: NodeJS.Timeout) => void
  readonly logWarn?: (message: string, error: unknown) => void
}

/** Default idle TTL before a session is reclaimed: comfortably longer than
 *  "switched away for a moment", short enough to bound process growth. */
export const DEFAULT_IDLE_SESSION_TTL_MS = 30 * 60_000
export const DEFAULT_REAP_SCAN_INTERVAL_MS = 60_000

export class IdleSessionReaper {
  private readonly deps: IdleSessionReaperDeps
  private readonly ttlMs: number
  private readonly scanIntervalMs: number
  private readonly now: () => number
  private readonly setIntervalFn: (callback: () => void, intervalMs: number) => NodeJS.Timeout
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void
  private readonly logWarn: (message: string, error: unknown) => void

  private handle: NodeJS.Timeout | undefined
  private stopped = false
  private inFlight: Promise<void> | undefined

  constructor(deps: IdleSessionReaperDeps, options: IdleSessionReaperOptions = {}) {
    this.deps = deps
    this.ttlMs = options.idleTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_REAP_SCAN_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
    this.setIntervalFn = options.setIntervalFn ?? ((callback, intervalMs) => setInterval(callback, intervalMs))
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle))
    this.logWarn = options.logWarn ?? (() => {})
  }

  /** The idle TTL this reaper was configured with (ms). */
  get idleTtlMs(): number {
    return this.ttlMs
  }

  start(): void {
    if (this.stopped || this.handle !== undefined) return
    this.handle = this.setIntervalFn(() => {
      void this.runOnce()
    }, this.scanIntervalMs)
    this.handle.unref()
  }

  /** Stops future scans. In-flight scans finish, but stop reclaiming. */
  stop(): void {
    this.stopped = true
    if (this.handle !== undefined) {
      this.clearIntervalFn(this.handle)
      this.handle = undefined
    }
  }

  /** Run a single scan; concurrent callers share the in-flight scan. */
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const existing = this.inFlight
    if (existing !== undefined) return existing
    const scan: Promise<void> = this.scan()
      .catch((error) => {
        this.logWarn('desktop idle session scan failed', error)
      })
      .finally(() => {
        this.inFlight = undefined
      })
    this.inFlight = scan
    return scan
  }

  private async scan(): Promise<void> {
    const candidates = [...this.deps.listCandidates()]
    if (candidates.length === 0) return

    // Keep the most recently active session: it is the one the user is most
    // likely still looking at, and the only guaranteed-instant switch
    // target. Everything else must stay fresh to earn its process trees.
    let keep: ReapCandidate | undefined
    for (const candidate of candidates) {
      if (keep === undefined || candidate.lastActivityAt > keep.lastActivityAt) keep = candidate
    }

    const now = this.now()
    const expired = candidates
      .filter((candidate) => candidate.sessionId !== keep?.sessionId)
      .filter((candidate) => now - candidate.lastActivityAt >= this.ttlMs)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)

    for (const candidate of expired) {
      if (this.stopped) return
      try {
        if (!(await this.deps.canReclaim(candidate.sessionId))) continue
        // `stop()` may have flipped mid-await: honour it before reclaiming.
        if (this.stopped) return
        await this.deps.reclaim(candidate.sessionId)
      } catch (error) {
        this.logWarn('desktop idle session reclamation failed', error)
      }
    }
  }
}
