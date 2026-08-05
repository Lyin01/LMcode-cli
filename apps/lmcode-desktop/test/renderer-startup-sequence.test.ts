import { describe, expect, it } from 'vitest'
import { loadRendererAfterReady } from '../src/main/renderer-startup-sequence'

describe('renderer startup barrier', () => {
  it('waits for runtime initialization before loading the renderer', async () => {
    const initialization = Promise.withResolvers<void>()
    const events: string[] = []
    const loading = loadRendererAfterReady(initialization.promise, async () => {
      events.push('renderer-loaded')
    })

    await Promise.resolve()
    expect(events).toEqual([])
    initialization.resolve()
    await expect(loading).resolves.toBe(true)
    expect(events).toEqual(['renderer-loaded'])
  })

  it('never loads the renderer when initialization fails', async () => {
    const failure = new Error('config migration failed')
    let loadCount = 0
    await expect(
      loadRendererAfterReady(Promise.reject(failure), async () => {
        loadCount += 1
      }),
    ).rejects.toBe(failure)
    expect(loadCount).toBe(0)
  })

  it('skips loading when shutdown started after initialization', async () => {
    let loadCount = 0
    const loaded = await loadRendererAfterReady(
      Promise.resolve(),
      async () => {
        loadCount += 1
      },
      () => true,
    )
    expect(loaded).toBe(false)
    expect(loadCount).toBe(0)
  })
})
