import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseStatus, LmcodeConfig } from '@lmcode-cli/lmcode-sdk'
import {
  applyComputerUseEnabled,
  COMPUTER_USE_INSTALL_CONFIRM_MS,
  runComputerUseInstall,
} from '../src/renderer/lib/computer-use'
import { useConfigStore } from '../src/renderer/stores/config-store'

const existingConfig = {
  providers: {},
  computerUse: { permissionMode: 'bounded', command: 'C:/Tools/cua-driver.exe' },
} as LmcodeConfig

const activeStatus: ComputerUseStatus = {
  phase: 'active',
  providerId: 'cua-driver-mcp',
  label: 'Cua Driver (MCP)',
  serverName: 'cua-driver-mcp',
  toolCount: 12,
  permissionMode: 'bounded',
}

describe('desktop computer-use enable toggle', () => {
  beforeEach(() => {
    useConfigStore.setState({ config: existingConfig, homeDir: '' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('persists the merged preference before applying it to the live session', async () => {
    const order: string[] = []
    const setConfig = vi.fn(async () => {
      order.push('persist')
      return existingConfig
    })
    const setComputerUseEnabled = vi.fn(async () => {
      order.push('apply')
      return activeStatus
    })
    vi.stubGlobal('window', { lmcodeAPI: { setConfig, setComputerUseEnabled } })

    const outcome = await applyComputerUseEnabled('session-a', true)

    expect(setConfig).toHaveBeenCalledWith({
      computerUse: { permissionMode: 'bounded', command: 'C:/Tools/cua-driver.exe', enabled: true },
    })
    expect(setComputerUseEnabled).toHaveBeenCalledWith('session-a', true)
    expect(order).toEqual(['persist', 'apply'])
    expect(outcome).toEqual({ status: activeStatus, sessionApplied: true })
  })

  it('only persists when no session is open, so callers can surface that instead of failing', async () => {
    const setConfig = vi.fn().mockResolvedValue(existingConfig)
    const setComputerUseEnabled = vi.fn()
    vi.stubGlobal('window', { lmcodeAPI: { setConfig, setComputerUseEnabled } })

    const outcome = await applyComputerUseEnabled(null, false)

    expect(setConfig).toHaveBeenCalledWith({
      computerUse: { permissionMode: 'bounded', command: 'C:/Tools/cua-driver.exe', enabled: false },
    })
    expect(setComputerUseEnabled).not.toHaveBeenCalled()
    expect(outcome).toEqual({ status: null, sessionApplied: false })
  })

  it('does not touch the live session when persisting the preference fails', async () => {
    const setConfig = vi.fn().mockRejectedValue(new Error('config write failed'))
    const setComputerUseEnabled = vi.fn()
    vi.stubGlobal('window', { lmcodeAPI: { setConfig, setComputerUseEnabled } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(applyComputerUseEnabled('session-a', true)).rejects.toThrow('config write failed')

    expect(setComputerUseEnabled).not.toHaveBeenCalled()
  })
})

describe('desktop computer-use installer confirmation gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('arms the confirmation instead of running the vendor installer on the first click', async () => {
    const installComputerUseDriver = vi.fn()
    vi.stubGlobal('window', { lmcodeAPI: { installComputerUseDriver } })

    const attempt = await runComputerUseInstall(null, 1_000)

    expect(installComputerUseDriver).not.toHaveBeenCalled()
    expect(attempt).toEqual({
      started: false,
      pending: { expiresAt: 1_000 + COMPUTER_USE_INSTALL_CONFIRM_MS },
      result: null,
    })
  })

  it('runs the vendor installer only for a second click inside the window', async () => {
    const result = { ok: true, output: '' }
    const installComputerUseDriver = vi.fn().mockResolvedValue(result)
    vi.stubGlobal('window', { lmcodeAPI: { installComputerUseDriver } })

    const attempt = await runComputerUseInstall({ expiresAt: 1_500 }, 1_400)

    expect(installComputerUseDriver).toHaveBeenCalledTimes(1)
    expect(attempt).toEqual({ started: true, pending: null, result })
  })

  it('requires a fresh confirmation once the window has lapsed', async () => {
    const installComputerUseDriver = vi.fn()
    vi.stubGlobal('window', { lmcodeAPI: { installComputerUseDriver } })

    const attempt = await runComputerUseInstall({ expiresAt: 1_000 + COMPUTER_USE_INSTALL_CONFIRM_MS }, 1_000 + COMPUTER_USE_INSTALL_CONFIRM_MS)

    expect(installComputerUseDriver).not.toHaveBeenCalled()
    expect(attempt).toEqual({
      started: false,
      pending: { expiresAt: 1_000 + COMPUTER_USE_INSTALL_CONFIRM_MS * 2 },
      result: null,
    })
  })
})
