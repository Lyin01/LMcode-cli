import type { LatestRequestGate } from './latest-request'
import type { ProjectTerminalInfo } from '../../shared/terminal-types'

export interface TerminalLaunchApi {
  startTerminal(sessionId: string): Promise<ProjectTerminalInfo>
  stopTerminal(sessionId: string): Promise<unknown>
}

export type TerminalLaunchResult =
  | { readonly adopted: true; readonly info: ProjectTerminalInfo }
  | { readonly adopted: false; readonly info: null }

/**
 * Starts a project terminal guarded by a latest-wins gate. When the session
 * switches while the main process is still spawning the shell, the switch
 * cannot have stopped that shell yet (it did not exist), so a stale resolve
 * would both leak the shell in the main process and overwrite the newer
 * session's panel state. On a stale resolve the freshly spawned shell is
 * stopped again (best effort) and the result is dropped instead.
 */
export async function launchTerminal(
  api: TerminalLaunchApi,
  gate: LatestRequestGate,
  ticket: number,
  sessionId: string,
): Promise<TerminalLaunchResult> {
  const info = await api.startTerminal(sessionId)
  if (gate.isCurrent(ticket)) return { info, adopted: true }
  await api.stopTerminal(sessionId).catch(() => {})
  return { info: null, adopted: false }
}
