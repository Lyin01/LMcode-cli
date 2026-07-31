export type NavigationAction = 'allow-local' | 'open-external' | 'deny'

const PRODUCTION_CONNECT_SOURCE = "'none'"

interface SenderFrameLike {
  readonly url: string
}

interface IpcSenderEventLike {
  readonly sender: object
  readonly senderFrame?: SenderFrameLike | null
}

interface TrustedWebContentsLike {
  getURL(): string
  isDestroyed(): boolean
}

export function classifyNavigation(targetUrl: string, rendererUrl: string): NavigationAction {
  if (isTrustedRendererUrl(targetUrl, rendererUrl)) return 'allow-local'

  const target = parseUrl(targetUrl)
  if (
    target !== null &&
    target.protocol === 'https:' &&
    target.hostname.length > 0 &&
    target.username.length === 0 &&
    target.password.length === 0
  ) {
    return 'open-external'
  }

  return 'deny'
}

export function isTrustedRendererUrl(candidateUrl: string, rendererUrl: string): boolean {
  const candidate = parseUrl(candidateUrl)
  const renderer = parseUrl(rendererUrl)
  if (candidate === null || renderer === null) return false

  if (renderer.protocol === 'file:') {
    return (
      candidate.protocol === 'file:' &&
      candidate.host === renderer.host &&
      candidate.pathname === renderer.pathname
    )
  }

  if (renderer.protocol === 'http:' || renderer.protocol === 'https:') {
    return candidate.origin === renderer.origin
  }

  return candidate.href === renderer.href
}

export function isTrustedIpcSender(
  event: IpcSenderEventLike,
  trustedContents: TrustedWebContentsLike,
  rendererUrl: string,
): boolean {
  if (trustedContents.isDestroyed() || event.sender !== trustedContents) return false

  try {
    const senderFrameUrl = event.senderFrame?.url
    return (
      senderFrameUrl !== undefined &&
      isTrustedRendererUrl(senderFrameUrl, rendererUrl) &&
      isTrustedRendererUrl(trustedContents.getURL(), rendererUrl)
    )
  } catch {
    return false
  }
}

export function createRendererContentSecurityPolicy(
  rendererUrl: string,
  isDevelopment: boolean,
): string {
  const renderer = parseUrl(rendererUrl)
  const connectSource = isDevelopment && renderer !== null
    ? developmentConnectSource(renderer)
    : PRODUCTION_CONNECT_SOURCE

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSource}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
  ].join('; ')
}

function developmentConnectSource(renderer: URL): string {
  if (renderer.protocol !== 'http:' && renderer.protocol !== 'https:') {
    return "'self'"
  }
  const websocketProtocol = renderer.protocol === 'https:' ? 'wss:' : 'ws:'
  return `'self' ${websocketProtocol}//${renderer.host}`
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
