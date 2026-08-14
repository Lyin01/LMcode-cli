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
    // Result events fire before this promise settles, so event handlers still
    // read the round's attribute. Failures surface via the updater's 'error'
    // event; swallow the rejection here to avoid an unhandled promise.
    void this.startCheck()
      .catch(() => {})
      .finally(() => {
        if (this.active === round) this.active = null
      })
  }
}
