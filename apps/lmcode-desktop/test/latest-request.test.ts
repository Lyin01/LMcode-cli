import { describe, expect, it } from 'vitest'
import { createLatestRequestGate } from '../src/renderer/lib/latest-request'

describe('latest request gate', () => {
  it('invalidates an in-flight request once a newer one starts', () => {
    const gate = createLatestRequestGate()
    const stale = gate.begin()
    const fresh = gate.begin()

    // A slow resolve from the older request must not overwrite newer data.
    expect(gate.isCurrent(stale)).toBe(false)
    expect(gate.isCurrent(fresh)).toBe(true)
  })

  it('keeps the only in-flight request current', () => {
    const gate = createLatestRequestGate()
    const ticket = gate.begin()
    expect(gate.isCurrent(ticket)).toBe(true)
  })

  it('tracks sessions independently per gate instance', () => {
    const first = createLatestRequestGate()
    const second = createLatestRequestGate()
    const firstTicket = first.begin()
    second.begin()
    expect(first.isCurrent(firstTicket)).toBe(true)
  })

  it('invalidates in-flight work when a refresh begins without a session', () => {
    // Regression contract for ExtensionsPanel: when the session is deleted
    // (sessionId -> null) the panel still begins a new ticket, so a slow
    // resolve from the deleted session cannot land afterwards.
    const gate = createLatestRequestGate()
    const staleTicket = gate.begin()
    gate.begin() // refresh with sessionId === null still ticks the gate
    expect(gate.isCurrent(staleTicket)).toBe(false)
  })
})
