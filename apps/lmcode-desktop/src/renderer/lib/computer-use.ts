/**
 * Desktop computer-use settings actions.
 *
 * The panel owns rendering; these helpers own the two operations with a
 * documented ordering contract: persisting the preference and applying it to
 * the live session, and running the vendor installer only after a confirmation.
 */

import type { ComputerUseStatus } from '@lmcode-cli/lmcode-sdk'
import { useConfigStore } from '@/stores/config-store'
import type { ComputerUseInstallResult } from '../../shared/computer-use-types'

/**
 * Install confirmation window. The vendor installer pipes a remote script into
 * the platform shell, so one accidental click must never be enough — the first
 * click only arms the confirmation.
 */
export const COMPUTER_USE_INSTALL_CONFIRM_MS = 30_000

export interface PendingComputerUseInstall {
  readonly expiresAt: number
}

export interface ComputerUseInstallDecision {
  readonly confirmed: boolean
  readonly pending: PendingComputerUseInstall | null
}

/**
 * Two-step gate for the vendor installer: a request confirms only when a
 * previous request armed the confirmation and the window has not lapsed.
 */
export function requestComputerUseInstall(
  pending: PendingComputerUseInstall | null,
  now: number,
): ComputerUseInstallDecision {
  if (pending !== null && now < pending.expiresAt) {
    return { confirmed: true, pending: null }
  }
  return { confirmed: false, pending: { expiresAt: now + COMPUTER_USE_INSTALL_CONFIRM_MS } }
}

export interface ComputerUseInstallAttempt {
  /** True only when the confirmation was honoured and the installer ran. */
  readonly started: boolean
  readonly pending: PendingComputerUseInstall | null
  readonly result: ComputerUseInstallResult | null
}

/** Runs the installer iff this click completes the two-step confirmation. */
export async function runComputerUseInstall(
  pending: PendingComputerUseInstall | null,
  now: number,
): Promise<ComputerUseInstallAttempt> {
  const decision = requestComputerUseInstall(pending, now)
  if (!decision.confirmed) {
    return { started: false, pending: decision.pending, result: null }
  }
  const result = await window.lmcodeAPI.installComputerUseDriver()
  return { started: true, pending: null, result }
}

export interface ComputerUseToggleOutcome {
  readonly status: ComputerUseStatus | null
  /** False when no session was open and only the preference was persisted. */
  readonly sessionApplied: boolean
}

/**
 * Flip the capability: persist the preference first, then apply it to the live
 * session. Without an open session the preference is still saved (the next
 * session picks it up) and the caller can say so instead of failing silently.
 */
export async function applyComputerUseEnabled(
  sessionId: string | null,
  enabled: boolean,
): Promise<ComputerUseToggleOutcome> {
  const store = useConfigStore.getState()
  await store.updateConfig({
    computerUse: { ...store.config?.computerUse, enabled },
  })
  if (sessionId === null) return { status: null, sessionApplied: false }
  const status = await window.lmcodeAPI.setComputerUseEnabled(sessionId, enabled)
  return { status, sessionApplied: true }
}
