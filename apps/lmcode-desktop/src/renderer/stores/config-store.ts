import { create } from 'zustand'

export interface ConfigStore {
  config: Record<string, unknown> | null
  homeDir: string
  loadConfig: () => Promise<void>
  updateConfig: (patch: Record<string, unknown>) => Promise<void>
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
      await window.lmcodeAPI.setConfig(patch)
      set((state) => ({
        config: state.config ? { ...state.config, ...patch } : patch,
      }))
    } catch (err) {
      console.error('Failed to update config:', err)
    }
  },
}))
