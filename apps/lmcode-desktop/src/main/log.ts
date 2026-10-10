import type { Logger, LogPayload } from '@lmcode-cli/lmcode-sdk'

function formatPayload(payload: LogPayload): string {
  if (payload instanceof Error) return payload.stack ?? payload.message
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

/**
 * Main-process logger. The terminal UI forbids console output; the Electron
 * main process does not, and this keeps the desktop off the TypeScript SDK logger.
 */
export function createDesktopLogger(bound: Record<string, unknown> = {}): Logger {
  const write = (level: 'error' | 'warn' | 'info' | 'debug', message: string, payload?: LogPayload): void => {
    const context = Object.keys(bound).length > 0 ? ` ${JSON.stringify(bound)}` : ''
    const detail = payload === undefined ? '' : ` ${formatPayload(payload)}`
    const line = `[lmcode-desktop] ${level} ${message}${context}${detail}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  }
  return {
    error: (message, payload) => write('error', message, payload),
    warn: (message, payload) => write('warn', message, payload),
    info: (message, payload) => write('info', message, payload),
    debug: (message, payload) => write('debug', message, payload),
    createChild(ctx) {
      return createDesktopLogger({ ...bound, ...ctx })
    },
  }
}
