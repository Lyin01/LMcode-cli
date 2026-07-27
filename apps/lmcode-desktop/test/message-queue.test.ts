import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

describe('desktop message queue', () => {
  beforeEach(() => {
    useSessionStore.setState({ messageQueue: {} })
  })

  it('keeps queued follow-ups editable, reorderable, and removable per session', () => {
    const store = useSessionStore.getState()
    const attachment = {
      id: 'attachment-1',
      kind: 'image' as const,
      name: 'screen.png',
      filePath: 'C:/work/screen.png',
    }
    const first = store.enqueueMessage('session-a', 'first task', [attachment])
    const second = store.enqueueMessage('session-a', 'second task')
    store.enqueueMessage('session-b', 'other session')

    store.updateQueuedMessage('session-a', second, 'edited second task')
    store.moveQueuedMessage('session-a', second, -1)

    expect(useSessionStore.getState().messageQueue['session-a']).toEqual([
      expect.objectContaining({ id: second, text: 'edited second task' }),
      expect.objectContaining({ id: first, text: 'first task', attachments: [attachment] }),
    ])
    expect(useSessionStore.getState().shiftQueuedMessage('session-a')).toEqual(
      expect.objectContaining({ id: second, text: 'edited second task' }),
    )
    useSessionStore.getState().removeQueuedMessage('session-a', first)
    expect(useSessionStore.getState().messageQueue['session-a']).toEqual([])
    expect(useSessionStore.getState().messageQueue['session-b']).toEqual([
      expect.objectContaining({ text: 'other session', attachments: [] }),
    ])
  })
})
