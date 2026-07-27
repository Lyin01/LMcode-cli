import { useCallback } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { latestSessionInProject } from '@/lib/projects'

/**
 * Shared project-switching behavior used by the sidebar project picker and
 * the composer project chip. All paths reuse the existing IPC surface:
 * `selectWorkDirectory` + `createSession` (via the store action, which falls
 * back to the system directory picker when no workDir is given) and plain
 * session selection when the target project already has conversations.
 */
export function useProjectSwitcher() {
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSession = useSessionStore((s) => s.createSession)

  const switchProject = useCallback(
    (workDir: string) => {
      const state = useSessionStore.getState()
      const currentWorkDir = state.sessions.find(
        (session) => session.id === state.currentSessionId,
      )?.workDir
      if (workDir === currentWorkDir) return
      const target = latestSessionInProject(state.sessions, workDir)
      if (target) {
        selectSession(target.id)
      } else {
        // Project known but without conversations: create one in place.
        // Store action surfaces failures the same way as the directory picker.
        void createSession(workDir)
      }
    },
    [createSession, selectSession],
  )

  const openProject = useCallback(() => {
    // No workDir: the store action opens the system directory picker first.
    void createSession()
  }, [createSession])

  const createSessionInProject = useCallback(
    (workDir: string) => {
      void createSession(workDir)
    },
    [createSession],
  )

  return { switchProject, openProject, createSessionInProject }
}
