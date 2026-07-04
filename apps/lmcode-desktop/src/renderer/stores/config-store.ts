import { create } from 'zustand'
import type { LmcodeConfig, LmcodeConfigPatch } from '@lmcode-cli/lmcode-sdk'

export interface ConfigStore {
  config: LmcodeConfig | null
  homeDir: string
  loadConfig: () => Promise<void>
  updateConfig: (patch: LmcodeConfigPatch) => Promise<void>
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  homeDir: '',

  loadConfig: async () => {
    try {
      const [config, homeDir] = await Promise.all([
        window.lmcodeAPI.getConfig(),
        window.lmcodeAPI.getHomeDir(),
      ])
      set({ config, homeDir })
    } catch (err) {
      console.error('Failed to load config:', err)
    }
  },

  updateConfig: async (patch) => {
    try {
      const config = await window.lmcodeAPI.setConfig(patch)
      set({ config })
    } catch (err) {
      console.error('Failed to update config:', err)
    }
  },
}))
