/**
 * Wire types for the desktop computer-use settings surface.
 *
 * Driver detection and installation run in the main process; the renderer only
 * ever receives these shapes. The live capability state comes from the session
 * (`Session.getComputerUseStatus`), not from here.
 */
export interface ComputerUseDriverInfo {
  /** True when a driver exists at a known install location. */
  readonly found: boolean
  /** Absolute path of the detected driver. */
  readonly path?: string
  /** Head of `cua-driver --version`, when the probe succeeded. */
  readonly version?: string
  readonly platform: string
}

export interface ComputerUseInstallResult {
  readonly ok: boolean
  /** Tail of the installer output; the success case is usually quiet. */
  readonly output: string
}
