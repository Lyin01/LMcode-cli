import { create } from 'zustand'
import type { GoalSnapshotData } from '@lmcode-cli/lmcode-sdk'

/**
 * Per-session goal state, kept outside the session store so the chat message
 * stream stays decoupled from goal bookkeeping. Hydrated lazily when a session
 * is selected and kept fresh by `goal.updated` events from the event stream.
 */
export interface GoalStore {
  /** sessionId → 最近一次已知的目标快照（null = 该会话当前没有目标）。 */
  goals: Record<string, GoalSnapshotData | null>
  setGoal: (sessionId: string, goal: GoalSnapshotData | null) => void
  /** 从主进程拉取某会话的当前目标（首次进入会话时水合）。 */
  hydrateGoal: (sessionId: string) => Promise<void>
  pauseGoal: (sessionId: string) => Promise<void>
  resumeGoal: (sessionId: string) => Promise<void>
  cancelGoal: (sessionId: string) => Promise<void>
  /** 会话被删除时清理其目标记录。 */
  removeBySession: (sessionId: string) => void
}

export const useGoalStore = create<GoalStore>((set, get) => ({
  goals: {},

  setGoal: (sessionId, goal) =>
    set((state) => ({ goals: { ...state.goals, [sessionId]: goal } })),

  hydrateGoal: async (sessionId) => {
    try {
      const result = await window.lmcodeAPI.getGoal(sessionId)
      get().setGoal(sessionId, result.goal)
    } catch (err) {
      console.error('Failed to load goal:', err)
    }
  },

  pauseGoal: async (sessionId) => {
    const goal = await window.lmcodeAPI.updateGoalStatus(sessionId, 'paused')
    get().setGoal(sessionId, goal)
  },

  resumeGoal: async (sessionId) => {
    const goal = await window.lmcodeAPI.updateGoalStatus(sessionId, 'active')
    get().setGoal(sessionId, goal)
  },

  cancelGoal: async (sessionId) => {
    const goal = await window.lmcodeAPI.cancelGoal(sessionId)
    get().setGoal(sessionId, goal)
  },

  removeBySession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.goals)) return {}
      const goals = { ...state.goals }
      delete goals[sessionId]
      return { goals }
    }),
}))
