import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LmcodeConfig, LmcodeConfigPatch } from '@lmcode-cli/lmcode-sdk'
import { useConfigStore } from '../src/renderer/stores/config-store'

const fakeConfig = { model: 'glm-5', provider: 'zhipu' } as unknown as LmcodeConfig

describe('desktop config store', () => {
  beforeEach(() => {
    useConfigStore.setState({ config: null, homeDir: '' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads config and home dir from the main process', async () => {
    vi.stubGlobal('window', {
      lmcodeAPI: {
        getConfig: vi.fn().mockResolvedValue(fakeConfig),
        getHomeDir: vi.fn().mockResolvedValue('C:/Users/test/.lmcode'),
      },
    })

    await useConfigStore.getState().loadConfig()

    expect(useConfigStore.getState().config).toEqual(fakeConfig)
    expect(useConfigStore.getState().homeDir).toBe('C:/Users/test/.lmcode')
  })

  it('keeps the previous config when loading fails', async () => {
    useConfigStore.setState({ config: fakeConfig, homeDir: '/home' })
    vi.stubGlobal('window', {
      lmcodeAPI: {
        getConfig: vi.fn().mockRejectedValue(new Error('ipc down')),
        getHomeDir: vi.fn().mockRejectedValue(new Error('ipc down')),
      },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await useConfigStore.getState().loadConfig()

    expect(useConfigStore.getState().config).toEqual(fakeConfig)
    expect(useConfigStore.getState().homeDir).toBe('/home')
  })

  it('applies a patch through the main process and stores the result', async () => {
    const updated = { ...fakeConfig, model: 'gpt-5' } as LmcodeConfig
    const setConfig = vi.fn().mockResolvedValue(updated)
    vi.stubGlobal('window', { lmcodeAPI: { setConfig } })

    await useConfigStore.getState().updateConfig({ model: 'gpt-5' } as LmcodeConfigPatch)

    expect(setConfig).toHaveBeenCalledWith({ model: 'gpt-5' })
    expect(useConfigStore.getState().config).toEqual(updated)
  })
})
