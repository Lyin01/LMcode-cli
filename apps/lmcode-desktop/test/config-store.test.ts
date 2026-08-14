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

  it('does not let a stale initial load overwrite a newer config update', async () => {
    const initial = { ...fakeConfig, model: 'initial' } as LmcodeConfig
    const updated = { ...fakeConfig, model: 'latest' } as LmcodeConfig
    const configLoad = Promise.withResolvers<LmcodeConfig>()
    const homeLoad = Promise.withResolvers<string>()
    vi.stubGlobal('window', {
      lmcodeAPI: {
        getConfig: vi.fn(() => configLoad.promise),
        getHomeDir: vi.fn(() => homeLoad.promise),
        setConfig: vi.fn().mockResolvedValue(updated),
      },
    })

    const load = useConfigStore.getState().loadConfig()
    await useConfigStore.getState().updateConfig({ model: 'latest' } as LmcodeConfigPatch)
    configLoad.resolve(initial)
    homeLoad.resolve('C:/Users/test/.lmcode')
    await load

    expect(useConfigStore.getState()).toMatchObject({
      config: updated,
      homeDir: 'C:/Users/test/.lmcode',
    })
  })

  it('serializes overlapping mutations and only commits the latest response', async () => {
    const firstResult = { ...fakeConfig, model: 'first' } as LmcodeConfig
    const secondResult = { ...fakeConfig, model: 'second' } as LmcodeConfig
    const first = Promise.withResolvers<LmcodeConfig>()
    const second = Promise.withResolvers<LmcodeConfig>()
    const setConfig = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { lmcodeAPI: { setConfig } })

    const firstUpdate = useConfigStore
      .getState()
      .updateConfig({ model: 'first' } as LmcodeConfigPatch)
    const secondUpdate = useConfigStore
      .getState()
      .updateConfig({ model: 'second' } as LmcodeConfigPatch)
    await Promise.resolve()

    expect(setConfig).toHaveBeenCalledTimes(1)
    first.resolve(firstResult)
    await firstUpdate
    await Promise.resolve()

    expect(setConfig).toHaveBeenCalledTimes(2)
    expect(useConfigStore.getState().config).toBeNull()

    second.resolve(secondResult)
    await secondUpdate

    expect(useConfigStore.getState().config).toEqual(secondResult)
  })

  it('continues the mutation queue after an earlier request fails', async () => {
    const first = Promise.withResolvers<LmcodeConfig>()
    const recovered = { ...fakeConfig, model: 'recovered' } as LmcodeConfig
    const setConfig = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(recovered)
    vi.stubGlobal('window', { lmcodeAPI: { setConfig } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const failedUpdate = useConfigStore
      .getState()
      .updateConfig({ model: 'failed' } as LmcodeConfigPatch)
    const recoveredUpdate = useConfigStore
      .getState()
      .updateConfig({ model: 'recovered' } as LmcodeConfigPatch)
    const failedAssertion = expect(failedUpdate).rejects.toThrow('write failed')
    first.reject(new Error('write failed'))

    await failedAssertion
    await recoveredUpdate

    expect(setConfig).toHaveBeenCalledTimes(2)
    expect(useConfigStore.getState().config).toEqual(recovered)
  })

  it('waits for an in-flight mutation before reloading authoritative config', async () => {
    const mutation = Promise.withResolvers<LmcodeConfig>()
    const authoritative = { ...fakeConfig, model: 'authoritative' } as LmcodeConfig
    const setConfig = vi.fn(() => mutation.promise)
    const getConfig = vi.fn().mockResolvedValue(authoritative)
    vi.stubGlobal('window', {
      lmcodeAPI: {
        setConfig,
        getConfig,
        getHomeDir: vi.fn().mockResolvedValue('C:/Users/test/.lmcode'),
      },
    })

    const update = useConfigStore
      .getState()
      .updateConfig({ model: 'pending' } as LmcodeConfigPatch)
    const load = useConfigStore.getState().loadConfig()
    await Promise.resolve()

    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(getConfig).not.toHaveBeenCalled()

    mutation.resolve({ ...fakeConfig, model: 'pending' } as LmcodeConfig)
    await update
    await load

    expect(getConfig).toHaveBeenCalledTimes(1)
    expect(useConfigStore.getState().config).toEqual(authoritative)
  })
})
