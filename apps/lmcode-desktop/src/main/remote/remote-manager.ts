import { existsSync } from 'node:fs'
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
  /** Built-in mobile page served by the remote HTTP server (`out/remote-app/`). */
  readonly webRoot: string
  readonly version: string
  readonly noProjectWorkDir: string
  readonly logger?: Logger | undefined
  /** Notified on every state change (used to push updates to the renderer). */
  readonly onStateChange?: ((state: RemoteState) => void) | undefined
  /** Fired after a remote client persists config (usage cache, etc.). */
  readonly onConfigChanged?: (() => void) | undefined
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
  private starting: Promise<void> | undefined
  private hostReleaseSession: ((sessionId: string) => Promise<void>) | undefined

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
    if (enabled) {
      try {
        await this.startServer()
      } catch (error) {
        this.config = { ...this.config, enabled: false }
        this.emitStateChange()
        throw error
      }
      this.config = { ...this.config, enabled: true }
    } else {
      this.config = { ...this.config, enabled: false }
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
    this.server?.disconnectAll(4003, 'token rotated')
    this.emitStateChange()
    return this.getState()
  }

  dropSession(sessionId: string): void {
    this.bridge?.dropSession(sessionId)
  }

  setHostReleaseSession(handler: (sessionId: string) => Promise<void>): void {
    this.hostReleaseSession = handler
  }

  async close(): Promise<void> {
    await this.stopServer()
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async startServer(): Promise<void> {
    if (this.server !== undefined) return
    if (this.starting !== undefined) {
      await this.starting
      if (this.server !== undefined) return
    }
    const run = this.openServer()
    this.starting = run
    try {
      await run
    } finally {
      if (this.starting === run) this.starting = undefined
    }
  }

  private async openServer(): Promise<void> {
    if (this.server !== undefined) return
    if (!existsSync(join(this.options.webRoot, 'index.html'))) {
      this.options.logger?.warn(
        'remote mobile page is missing; run the desktop build to populate out/remote-app',
        { webRoot: this.options.webRoot },
      )
    }
    const bridge = new RemoteBridge(
      this.options.harness,
      this.options.hub,
      this.options.noProjectWorkDir,
      this.options.memoryStore,
      this.options.onConfigChanged,
      (sessionId) => this.hostReleaseSession?.(sessionId) ?? Promise.resolve(),
    )
    const server = new RemoteServer({
      bridge,
      hub: this.options.hub,
      getToken: () => this.config.token,
      getState: () => this.getState(),
      webRoot: this.options.webRoot,
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
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8')
  }

  private emitStateChange(): void {
    this.options.onStateChange?.(this.getState())
  }

  private computeLanUrls(port: number): string[] {
    const addresses: string[] = []
    const interfaces = os.networkInterfaces()
    for (const entries of Object.values(interfaces)) {
      if (entries === undefined) continue
      for (const entry of entries) {
        if (entry.family === 'IPv4' && !entry.internal) {
          addresses.push(entry.address)
        }
      }
    }
    // Prefer real LAN addresses: virtual adapters (VPN clients, etc.) are often
    // listed first by the OS but are unreachable from a phone on the same WiFi.
    return rankLanAddresses(addresses).map((address) => `http://${address}:${port}`)
  }
}

/** True for RFC1918 private IPv4 addresses — the ones a phone can normally reach. */
export function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.')
  if (octets.length !== 4) return false
  const first = Number(octets[0])
  const second = Number(octets[1])
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false
  if (first === 10) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  return false
}

/**
 * Order LAN addresses for the pairing QR / address list: private LAN ranges
 * first (reachable from a phone), then everything else, link-local last.
 * Deterministic for equal ranks so the QR does not flap between restarts.
 */
export function rankLanAddresses(addresses: readonly string[]): string[] {
  return [...addresses].sort((left, right) => {
    const rankDifference = lanAddressRank(left) - lanAddressRank(right)
    return rankDifference !== 0 ? rankDifference : left.localeCompare(right)
  })
}

function lanAddressRank(address: string): number {
  if (isPrivateIpv4(address)) return 0
  if (address.startsWith('169.254.')) return 2
  return 1
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
