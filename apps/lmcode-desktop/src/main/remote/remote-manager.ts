import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import type { LmcodeHarness, Logger } from '@lmcode-cli/lmcode-sdk'
import type { MemoryMemoStore } from '@lmcode/memory'
import type { RemoteConfig, RemoteState } from '../../shared/remote-types.js'
import { RemoteBridge } from './remote-bridge.js'
import { RemoteServer } from './remote-server.js'
import type { InteractionHub } from './interaction-hub.js'

const DEFAULT_PORT = 37_991
const CONFIG_FILENAME = 'remote-config.json'
const MIN_PORT = 1024
const MAX_PORT = 65_535

export interface RemoteManagerOptions {
  readonly harness: LmcodeHarness
  readonly hub: InteractionHub
  readonly memoryStore: MemoryMemoStore
  /** Directory that holds the persisted remote config (the runtime userData). */
  readonly configDir: string
  readonly version: string
  readonly noProjectWorkDir: string
  readonly logger?: Logger | undefined
  /** Notified on every state change (used to push updates to the renderer). */
  readonly onStateChange?: ((state: RemoteState) => void) | undefined
}

function defaultToken(): string {
  return randomBytes(32).toString('hex')
}

function defaultConfig(): RemoteConfig {
  return { enabled: false, port: DEFAULT_PORT, token: defaultToken() }
}

/**
 * Owns the remote service lifecycle: persisted on/off state, the pairing
 * token, LAN URLs and the HTTP+WebSocket server. The service is opt-in —
 * it stays off until the user enables it in the desktop settings panel.
 *
 * The pairing token is read through `getToken` on every authentication, so
 * regenerating it invalidates previously issued tokens immediately. The
 * memory store is borrowed from the app lifecycle and never closed here.
 */
export class RemoteManager {
  private config: RemoteConfig = defaultConfig()
  private readonly configPath: string
  private bridge: RemoteBridge | undefined
  private server: RemoteServer | undefined

  constructor(private readonly options: RemoteManagerOptions) {
    this.configPath = join(options.configDir, CONFIG_FILENAME)
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  get port(): number {
    return this.config.port
  }

  /** Full state snapshot for the renderer and remote clients. */
  getState(): RemoteState {
    return {
      enabled: this.config.enabled,
      port: this.config.port,
      token: this.config.token,
      lanUrls: this.computeLanUrls(this.config.port),
      clientCount: this.server?.clientCount ?? 0,
      version: this.options.version,
    }
  }

  /** Load persisted config and start the service if it was enabled. */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RemoteConfig>
      this.config = {
        enabled: parsed.enabled === true,
        port: isFiniteNumber(parsed.port) ? parsed.port : DEFAULT_PORT,
        token:
          typeof parsed.token === 'string' && parsed.token.length > 0
            ? parsed.token
            : defaultToken(),
      }
    } catch {
      // No config yet: defaults apply.
    }
    if (this.config.enabled) {
      try {
        await this.startServer()
      } catch (error) {
        // A port conflict must not take the whole desktop down: fall back to
        // disabled and persist, so the next launch does not retry a broken
        // configuration silently.
        this.options.logger?.error('remote server failed to start during init', {
          port: this.config.port,
          error: error instanceof Error ? error.message : String(error),
        })
        this.config = { ...this.config, enabled: false }
        await this.persist()
      }
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteState> {
    this.config = { ...this.config, enabled }
    if (enabled) {
      await this.startServer()
    } else {
      await this.stopServer()
    }
    await this.persist()
    this.emitStateChange()
    return this.getState()
  }

  async setPort(port: number): Promise<RemoteState> {
    const normalized = Math.floor(port)
    if (!isFiniteNumber(normalized) || normalized < MIN_PORT || normalized > MAX_PORT) {
      throw new Error(`Remote port must be between ${MIN_PORT} and ${MAX_PORT}`)
    }
    const wasRunning = this.server !== undefined
    const previousPort = this.config.port
    if (wasRunning) await this.stopServer()
    this.config = { ...this.config, port: normalized }
    if (wasRunning) {
      try {
        await this.startServer()
      } catch (error) {
        // Roll the port back and try to restore the previous server, so the
        // reported state never claims a port that is not actually serving.
        this.config = { ...this.config, port: previousPort }
        await this.startServer().catch(() => undefined)
        throw error
      }
    }
    await this.persist()
    this.emitStateChange()
    return this.getState()
  }

  async regenerateToken(): Promise<RemoteState> {
    this.config = { ...this.config, token: defaultToken() }
    await this.persist()
    this.emitStateChange()
    return this.getState()
  }

  async close(): Promise<void> {
    await this.stopServer()
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async startServer(): Promise<void> {
    if (this.server !== undefined) return
    const bridge = new RemoteBridge(
      this.options.harness,
      this.options.hub,
      this.options.noProjectWorkDir,
      this.options.memoryStore,
    )
    const server = new RemoteServer({
      bridge,
      hub: this.options.hub,
      getToken: () => this.config.token,
      getState: () => this.getState(),
      logger: this.options.logger,
    })
    try {
      await server.listen(this.config.port)
    } catch (error) {
      await bridge.close().catch(() => undefined)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法启动远程服务（端口 ${this.config.port}）：${detail}`)
    }
    this.bridge = bridge
    this.server = server
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    const bridge = this.bridge
    this.server = undefined
    this.bridge = undefined
    if (server !== undefined) await server.close()
    if (bridge !== undefined) await bridge.close()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  private emitStateChange(): void {
    this.options.onStateChange?.(this.getState())
  }

  private computeLanUrls(port: number): string[] {
    const urls: string[] = []
    const interfaces = os.networkInterfaces()
    for (const entries of Object.values(interfaces)) {
      if (entries === undefined) continue
      for (const entry of entries) {
        if (entry.family === 'IPv4' && !entry.internal) {
          urls.push(`http://${entry.address}:${port}`)
        }
      }
    }
    return urls
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
