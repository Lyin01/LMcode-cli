import { create } from 'zustand'

/**
 * Inbox 通知中心：汇总后台会话完成、审批、子代理/后台任务终态、目标状态
 * 变更等需要用户知晓的事件。只在页面生命周期内有效，不持久化到磁盘。
 */

export type InboxItemType =
  | 'turn-completed'
  | 'approval-pending'
  | 'subagent-finished'
  | 'task-finished'
  | 'goal-update'
  | 'artifact-updated'

export type InboxOutcome = 'success' | 'failure' | 'info'

export interface InboxItem {
  readonly id: string
  readonly type: InboxItemType
  readonly sessionId?: string
  readonly projectDir?: string
  readonly title: string
  readonly body?: string
  readonly createdAt: number
  readonly read: boolean
  readonly outcome?: InboxOutcome
  /**
   * 合并键：携带相同 mergeKey 的未读条目会被新条目替换（同一会话的连续
   * 完成只保留最新一条）。已读条目不参与合并——再次发生时必须重新以
   * 未读形式浮现。
   */
  readonly mergeKey?: string
}

export interface InboxItemInput {
  readonly type: InboxItemType
  readonly sessionId?: string
  readonly projectDir?: string
  readonly title: string
  readonly body?: string
  readonly outcome?: InboxOutcome
  /** 显式 id（如审批条目用 requestId 派生，便于解决后精确标记已读）。 */
  readonly id?: string
  readonly mergeKey?: string
}

/** 上限，防止长时间运行后条目无限增长。超出时丢弃最旧的条目。 */
export const INBOX_MAX_ITEMS = 100

let inboxCounter = 0
function nextInboxId(): string {
  inboxCounter += 1
  return `inbox_${Date.now()}_${inboxCounter}`
}

export interface InboxStore {
  readonly items: readonly InboxItem[]
  /** 新增条目；带 mergeKey 且已有同键未读条目时合并为最新一条。 */
  add: (input: InboxItemInput) => InboxItem
  markRead: (id: string) => void
  /** 把某个会话的所有条目标记为已读（查看会话后清除角标）。 */
  markSessionRead: (sessionId: string) => void
  markAllRead: () => void
  remove: (id: string) => void
  clear: () => void
}

export const useInboxStore = create<InboxStore>((set, get) => ({
  items: [],

  add: (input) => {
    const existing = input.mergeKey
      ? get().items.find((item) => !item.read && item.mergeKey === input.mergeKey)
      : undefined
    const item: InboxItem = {
      id: input.id ?? existing?.id ?? nextInboxId(),
      type: input.type,
      sessionId: input.sessionId,
      projectDir: input.projectDir,
      title: input.title,
      body: input.body,
      createdAt: Date.now(),
      read: false,
      outcome: input.outcome,
      mergeKey: input.mergeKey,
    }
    set((state) => ({
      items: [item, ...state.items.filter((entry) => entry.id !== item.id)].slice(
        0,
        INBOX_MAX_ITEMS,
      ),
    }))
    return item
  },

  markRead: (id) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    })),

  markSessionRead: (sessionId) =>
    set((state) => {
      if (!state.items.some((item) => item.sessionId === sessionId && !item.read)) {
        return state
      }
      return {
        items: state.items.map((item) =>
          item.sessionId === sessionId ? { ...item, read: true } : item,
        ),
      }
    }),

  markAllRead: () =>
    set((state) => {
      if (!state.items.some((item) => !item.read)) return state
      return { items: state.items.map((item) => ({ ...item, read: true })) }
    }),

  remove: (id) =>
    set((state) => ({ items: state.items.filter((item) => item.id !== id) })),

  clear: () => set({ items: [] }),
}))

/** 某个会话的未读条目数（侧边栏角标用）。 */
export function unreadCountForSession(
  items: readonly InboxItem[],
  sessionId: string,
): number {
  let count = 0
  for (const item of items) {
    if (!item.read && item.sessionId === sessionId) count += 1
  }
  return count
}

/** 全部未读条目数（TopBar 铃铛角标用）。 */
export function totalUnreadCount(items: readonly InboxItem[]): number {
  let count = 0
  for (const item of items) {
    if (!item.read) count += 1
  }
  return count
}
