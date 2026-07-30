import { create } from 'zustand'
import type { LmcodeConfig, LmcodeConfigPatch } from '@lmcode-cli/lmcode-sdk'

export interface ConfigStore {
  config: LmcodeConfig | null
  homeDir: string
  loadConfig: () => Promise<void>
  updateConfig: (patch: LmcodeConfigPatch) => Promise<void>
  removeProvider: (providerId: string) => Promise<void>
  removeModel: (modelId: string) => Promise<void>
}

type ConfigMutation = () => Promise<LmcodeConfig>

export const useConfigStore = create<ConfigStore>((set) => {
  let latestConfigRequest = 0
  let latestHomeRequest = 0
  let mutationQueue: Promise<void> = Promise.resolve()

  const runMutation = (operation: ConfigMutation, action: string): Promise<void> => {
    const requestId = ++latestConfigRequest
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )

    return result
      .then((config) => {
        if (requestId === latestConfigRequest) set({ config })
      })
      .catch((err: unknown) => {
        console.error(`Failed to ${action} config:`, err)
        throw err
      })
  }

  return {
    config: null,
    homeDir: '',

    loadConfig: async () => {
      const configRequest = ++latestConfigRequest
      const homeRequest = ++latestHomeRequest
      try {
        const [config, homeDir] = await Promise.all([
          mutationQueue.then(() => window.lmcodeAPI.getConfig()),
          window.lmcodeAPI.getHomeDir(),
        ])
        set((state) => ({
          config: configRequest === latestConfigRequest ? config : state.config,
          homeDir: homeRequest === latestHomeRequest ? homeDir : state.homeDir,
        }))
      } catch (err) {
        console.error('Failed to load config:', err)
      }
    },

    updateConfig: (patch) =>
      runMutation(() => window.lmcodeAPI.setConfig(patch), 'update'),

    removeProvider: (providerId) =>
      runMutation(() => window.lmcodeAPI.removeProvider(providerId), 'remove provider from'),

    removeModel: (modelId) =>
      runMutation(() => window.lmcodeAPI.removeModel(modelId), 'remove model from'),
  }
})
