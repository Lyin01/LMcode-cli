/**
 * Latest-wins request gate for async panel refreshes. Each refresh calls
 * `begin()` and only applies its result while `isCurrent(ticket)` holds, so a
 * slow resolve from a superseded request (session/tab switch, manual refresh)
 * can never overwrite newer data. Same pattern as GitReviewPanel's
 * `refreshSequence`, packaged for reuse.
 */
export interface LatestRequestGate {
  /** Starts a new request and invalidates every previous ticket. */
  begin(): number
  /** Whether the ticket still belongs to the most recent request. */
  isCurrent(ticket: number): boolean
}

export function createLatestRequestGate(): LatestRequestGate {
  let sequence = 0
  return {
    begin() {
      sequence += 1
      return sequence
    },
    isCurrent(ticket) {
      return ticket === sequence
    },
  }
}
