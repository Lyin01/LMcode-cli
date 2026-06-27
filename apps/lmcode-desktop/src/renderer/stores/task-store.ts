import { create } from 'zustand'

export interface TaskEntry {
  taskId: string
  sessionId: string
  command: string
  description: string
  status: BackgroundTaskInfo['status']
  pid: number
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  approvalReason?: string
  timedOut?: boolean
  stopReason?: string
}

export interface TaskStore {
  tasks: TaskEntry[]
  addOrUpdateTask: (sessionId: string, info: BackgroundTaskInfo) => void
  removeTask: (taskId: string) => void
  clearTasks: () => void
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],

  addOrUpdateTask: (sessionId, info) => {
    const existing = get().tasks.find((t) => t.taskId === info.taskId)
    const entry: TaskEntry = {
      taskId: info.taskId,
      sessionId,
      command: info.command,
      description: info.description,
      status: info.status,
      pid: info.pid,
      exitCode: info.exitCode,
      startedAt: info.startedAt,
      endedAt: info.endedAt,
      approvalReason: info.approvalReason,
      timedOut: info.timedOut,
      stopReason: info.stopReason,
    }

    if (existing) {
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.taskId === info.taskId ? entry : t,
        ),
      }))
    } else {
      set((state) => ({
        tasks: [...state.tasks, entry],
      }))
    }
  },

  removeTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.taskId !== taskId),
    }))
  },

  clearTasks: () => {
    set({ tasks: [] })
  },
}))
