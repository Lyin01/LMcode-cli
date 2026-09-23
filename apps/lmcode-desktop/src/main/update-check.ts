/**
 * Coordinates electron-updater check rounds so the "manual vs background"
 * attribute survives overlapping requests.
 *
 * The updater emits its result events without saying which request triggered
 * them, and a manual menu click can overlap the silent post-launch check. A
 * single shared flag written before each request races: whichever request
 * writes last wins, so a manual result can be swallowed silently or a
 * background round can pop a "已是最新" dialog. Tracking the attribute per
 * in-flight round instead guarantees a manual check's result is always shown:
 * a manual request upgrades the round already in flight, and the attribute
 * resets as soon as the round settles so later background checks stay silent.
 */

/**
 * How long a round may stay in flight before the coordinator abandons it.
 * `autoUpdater.checkForUpdates()` has no timeout of its own, so a connection
 * that is black-holed would leave the round pending forever and silently
 * swallow every later manual "检查更新". A check only fetches the update feed
 * (downloading the package is a separate, explicitly confirmed step), so three
 * minutes is far above a healthy round while still being short enough that a
 * user who retries the menu gets a real request instead of a no-op.
 */
export const UPDATE_CHECK_ROUND_TIMEOUT_MS = 180_000

export class UpdateCheckCoordinator {
  private active: { manual: boolean } | null = null

  constructor(private readonly startCheck: () => Promise<unknown>) {}

  /** Whether the in-flight check round was requested (or upgraded) manually. */
  get isManual(): boolean {
    return this.active?.manual ?? false
  }

  check(manual: boolean): void {
    if (this.active !== null) {
      // electron-updater runs one round at a time; fold this request into the
      // in-flight round. Manual wins so the user always gets visible feedback.
      this.active.manual = this.active.manual || manual
      return
    }
    const round = { manual }
    this.active = round
    // A round that never settles must not wedge the feature, so the watchdog
    // releases it and lets the next check start a fresh round. Late result
    // events of the abandoned round are then attributed to whichever round is
    // current — acceptable, since they still describe the newest version the
    // updater knows about.
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      if (this.active === round) this.active = null
    }, UPDATE_CHECK_ROUND_TIMEOUT_MS)
    watchdog.unref()
    // Result events fire before this promise settles, so event handlers still
    // read the round's attribute. Failures surface via the updater's 'error'
    // event; swallow the rejection here to avoid an unhandled promise.
    void this.startCheck()
      .catch(() => {})
      .finally(() => {
        // The timer belongs to this round, so clearing it can never disarm a
        // newer round's watchdog.
        clearTimeout(watchdog)
        if (this.active === round) this.active = null
      })
  }
}
