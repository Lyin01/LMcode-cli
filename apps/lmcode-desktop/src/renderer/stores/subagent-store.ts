import { create } from 'zustand'
import type {
  BackgroundTaskInfo,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
} from '@lmcode-cli/lmcode-sdk'

export type SubagentStatus = 'running' | 'completed' | 'failed'

export interface SubagentEntry {
  readonly sessionId: string
  readonly subagentId: string
  readonly name: string
  readonly parentAgentId?: string
  readonly parentToolCallId: string
  readonly description?: string
  readonly runInBackground: boolean
  readonly status: SubagentStatus
  readonly resultSummary?: string
  readonly error?: string
  readonly contextTokens?: number
  readonly startedAt: number
  readonly endedAt?: number
}

export interface SubagentStore {
  readonly agents: readonly SubagentEntry[]
  spawned: (sessionId: string, event: SubagentSpawnedEvent) => void
  completed: (sessionId: string, event: SubagentCompletedEvent) => void
  failed: (sessionId: string, event: SubagentFailedEvent) => void
  hydrateTasks: (sessionId: string, tasks: readonly BackgroundTaskInfo[]) => void
  clearCompleted: (sessionId: string) => void
  /** Drop every agent record owned by a session (e.g. when it is deleted). */
  removeBySession: (sessionId: string) => void
}

export const useSubagentStore = create<SubagentStore>((set) => ({
  agents: [],

  spawned: (sessionId, event) =>
    set((state) => {
      const prior = state.agents.find((agent) => agent.subagentId === event.subagentId)
      const next: SubagentEntry = {
        sessionId,
        subagentId: event.subagentId,
        name: event.subagentName,
        parentAgentId: event.parentAgentId,
        parentToolCallId: event.parentToolCallId,
        description: event.description,
        runInBackground: event.runInBackground,
        status: 'running',
        startedAt: prior?.startedAt ?? Date.now(),
      }
      return {
        agents: [next, ...state.agents.filter((agent) => agent.subagentId !== event.subagentId)],
      }
    }),

  completed: (sessionId, event) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.subagentId === event.subagentId
          ? {
              ...agent,
              sessionId,
              status: 'completed' as const,
              resultSummary: event.resultSummary,
              contextTokens: event.contextTokens,
              endedAt: Date.now(),
            }
          : agent,
      ),
    })),

  failed: (sessionId, event) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.subagentId === event.subagentId
          ? {
              ...agent,
              sessionId,
              status: 'failed' as const,
              error: event.error,
              endedAt: Date.now(),
            }
          : agent,
      ),
    })),

  hydrateTasks: (sessionId, tasks) =>
    set((state) => {
      const agents = [...state.agents]
      for (const task of tasks) {
        if (!task.agentId) continue
        const priorIndex = agents.findIndex((agent) => agent.subagentId === task.agentId)
        const prior = priorIndex < 0 ? undefined : agents[priorIndex]
        const status: SubagentStatus =
          task.status === 'running' || task.status === 'awaiting_approval'
            ? 'running'
            : task.status === 'completed'
              ? 'completed'
              : 'failed'
        const hydrated: SubagentEntry = {
          sessionId,
          subagentId: task.agentId,
          name: task.subagentType ?? prior?.name ?? 'subagent',
          parentAgentId: prior?.parentAgentId,
          parentToolCallId: prior?.parentToolCallId ?? `task:${task.taskId}`,
          description: prior?.description ?? task.description,
          runInBackground: true,
          status,
          resultSummary: prior?.resultSummary,
          error:
            prior?.error ??
            (status === 'failed'
              ? task.failureReason ?? task.stopReason ?? `后台任务状态：${task.status}`
              : undefined),
          contextTokens: prior?.contextTokens,
          startedAt: prior?.startedAt ?? task.startedAt,
          endedAt: prior?.endedAt ?? task.endedAt ?? undefined,
        }
        if (priorIndex < 0) agents.push(hydrated)
        else agents[priorIndex] = hydrated
      }
      return { agents }
    }),

  clearCompleted: (sessionId) =>
    set((state) => ({
      agents: state.agents.filter(
        (agent) => agent.sessionId !== sessionId || agent.status === 'running',
      ),
    })),

  removeBySession: (sessionId) =>
    set((state) => ({
      agents: state.agents.filter((agent) => agent.sessionId !== sessionId),
    })),
}))
