import * as path from 'node:path'

export type DesktopEnvironmentName = 'development' | 'production'

export interface DesktopRuntimeEnvironment {
  readonly name: DesktopEnvironmentName
  readonly isDevelopment: boolean
  readonly userDataDir: string
  readonly configPath: string
  /** Sentinel workspace for sessions that are not tied to a project directory. */
  readonly noProjectWorkDir: string
  readonly rendererUrl: string | undefined
  readonly devToolsEnabled: boolean
}

export interface DesktopRuntimeEnvironmentInput {
  readonly isPackaged: boolean
  readonly defaultUserDataDir: string
  readonly nodeEnv: string | undefined
  readonly rendererUrl: string | undefined
}

const DEVELOPMENT_DATA_SUFFIX = '-development'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function resolveDesktopRuntimeEnvironment(
  input: DesktopRuntimeEnvironmentInput,
): DesktopRuntimeEnvironment {
  const isDevelopment = !input.isPackaged
  const name: DesktopEnvironmentName = isDevelopment ? 'development' : 'production'
  const userDataDir = isDevelopment
    ? `${input.defaultUserDataDir}${DEVELOPMENT_DATA_SUFFIX}`
    : input.defaultUserDataDir
  const launchedByDevelopmentScript =
    isDevelopment && input.nodeEnv === 'development'

  return {
    name,
    isDevelopment,
    userDataDir,
    configPath: path.join(userDataDir, 'config.toml'),
    noProjectWorkDir: path.join(userDataDir, 'no-project-workspace'),
    rendererUrl: launchedByDevelopmentScript
      ? validateDevelopmentRendererUrl(input.rendererUrl)
      : undefined,
    devToolsEnabled: launchedByDevelopmentScript,
  }
}

function validateDevelopmentRendererUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('ELECTRON_RENDERER_URL must be a valid loopback HTTP URL')
  }

  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('ELECTRON_RENDERER_URL must use loopback HTTP without credentials')
  }

  return url.href
}
