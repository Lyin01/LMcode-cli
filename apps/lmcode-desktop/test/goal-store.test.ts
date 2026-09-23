import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGoalStore } from '../src/renderer/stores/goal-store'

const globals = globalThis as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  delete globals['window']
})

describe('goal store failure containment', () => {
  it('contains a rejected mutation instead of rejecting the caller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    globals['window'] = {
      lmcodeAPI: {
        updateGoalStatus: () => Promise.reject(new Error('ipc down')),
        cancelGoal: () => Promise.reject(new Error('ipc down')),
      },
    }
    useGoalStore.setState({
      goals: { s1: { goalId: 'g1', status: 'active' } as never },
    })

    // GoalChip fires these with `void`; a rejection would surface as an
    // unhandled rejection with no user-visible feedback.
    await expect(useGoalStore.getState().pauseGoal('s1')).resolves.toBeUndefined()
    await expect(useGoalStore.getState().resumeGoal('s1')).resolves.toBeUndefined()
    await expect(useGoalStore.getState().cancelGoal('s1')).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledTimes(3)
    // A failed mutation must not touch the cached goal.
    expect(useGoalStore.getState().goals['s1']).toMatchObject({ status: 'active' })
  })
})
