import { beforeEach, describe, expect, it } from 'vitest'
import {
  INBOX_MAX_ITEMS,
  totalUnreadCount,
  unreadCountForSession,
  useInboxStore,
} from '../src/renderer/stores/inbox-store'

describe('desktop inbox store', () => {
  beforeEach(() => {
    useInboxStore.setState({ items: [] })
  })

  it('adds unread entries newest-first', () => {
    const store = useInboxStore.getState()
    store.add({ type: 'task-finished', sessionId: 'session-a', title: 'first' })
    store.add({ type: 'subagent-finished', sessionId: 'session-b', title: 'second' })

    const items = useInboxStore.getState().items
    expect(items.map((item) => item.title)).toEqual(['second', 'first'])
    expect(items.every((item) => !item.read)).toBe(true)
    expect(totalUnreadCount(items)).toBe(2)
  })

  it('merges an unread entry with the same merge key into the latest one', () => {
    const store = useInboxStore.getState()
    store.add({
      type: 'turn-completed',
      sessionId: 'session-a',
      title: '回合已完成：旧',
      mergeKey: 'turn-completed:session-a',
    })
    store.add({
      type: 'turn-completed',
      sessionId: 'session-a',
      title: '回合已完成：新',
      mergeKey: 'turn-completed:session-a',
    })

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: '回合已完成：新', read: false })
  })

  it('does not merge into an already-read entry: a new occurrence resurfaces as unread', () => {
    const store = useInboxStore.getState()
    const first = store.add({
      type: 'turn-completed',
      sessionId: 'session-a',
      title: 'first completion',
      mergeKey: 'turn-completed:session-a',
    })
    store.markRead(first.id)
    store.add({
      type: 'turn-completed',
      sessionId: 'session-a',
      title: 'second completion',
      mergeKey: 'turn-completed:session-a',
    })

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ title: 'second completion', read: false })
    expect(items[1]).toMatchObject({ title: 'first completion', read: true })
  })

  it('caps the backlog at INBOX_MAX_ITEMS, dropping the oldest entries', () => {
    const store = useInboxStore.getState()
    for (let index = 0; index < INBOX_MAX_ITEMS + 5; index += 1) {
      store.add({ type: 'task-finished', title: `entry-${index}` })
    }

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(INBOX_MAX_ITEMS)
    expect(items[0]?.title).toBe(`entry-${INBOX_MAX_ITEMS + 4}`)
    expect(items.at(-1)?.title).toBe('entry-5')
  })

  it('marks a single entry, a whole session, or everything as read', () => {
    const store = useInboxStore.getState()
    const first = store.add({ type: 'task-finished', sessionId: 'session-a', title: 'a1' })
    store.add({ type: 'goal-update', sessionId: 'session-a', title: 'a2' })
    store.add({ type: 'task-finished', sessionId: 'session-b', title: 'b1' })

    store.markRead(first.id)
    expect(unreadCountForSession(useInboxStore.getState().items, 'session-a')).toBe(1)

    store.markSessionRead('session-a')
    expect(unreadCountForSession(useInboxStore.getState().items, 'session-a')).toBe(0)
    expect(unreadCountForSession(useInboxStore.getState().items, 'session-b')).toBe(1)

    store.markAllRead()
    expect(totalUnreadCount(useInboxStore.getState().items)).toBe(0)
  })

  it('removes a single entry and clears the whole inbox', () => {
    const store = useInboxStore.getState()
    const keep = store.add({ type: 'task-finished', title: 'keep' })
    const drop = store.add({ type: 'task-finished', title: 'drop' })

    store.remove(drop.id)
    expect(useInboxStore.getState().items.map((item) => item.id)).toEqual([keep.id])

    store.clear()
    expect(useInboxStore.getState().items).toEqual([])
  })

  it('aggregates unread counts per session for the sidebar badge', () => {
    const store = useInboxStore.getState()
    store.add({ type: 'turn-completed', sessionId: 'session-a', title: 'a' })
    store.add({ type: 'subagent-finished', sessionId: 'session-a', title: 'a2' })
    const readEntry = store.add({ type: 'task-finished', sessionId: 'session-b', title: 'b' })
    store.markRead(readEntry.id)

    const items = useInboxStore.getState().items
    expect(unreadCountForSession(items, 'session-a')).toBe(2)
    expect(unreadCountForSession(items, 'session-b')).toBe(0)
    expect(unreadCountForSession(items, 'session-unknown')).toBe(0)
  })
})
