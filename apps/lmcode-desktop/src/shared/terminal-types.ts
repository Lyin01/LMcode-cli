export type TerminalOutputStream = 'stdout' | 'stderr' | 'system'

export interface ProjectTerminalInfo {
  readonly sessionId: string
  readonly workDir: string
  readonly shell: string
  readonly running: boolean
}

export interface TerminalOutputPayload {
  readonly sessionId: string
  readonly stream: TerminalOutputStream
  readonly data: string
}
