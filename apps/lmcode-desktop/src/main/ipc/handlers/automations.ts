import type {
  BackgroundTaskInfo,
  CronJobInfo,
} from '@lmcode-cli/lmcode-sdk'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * Scheduled automations and background tasks: cron jobs and long-running
 * background task lifecycle.
 */
export function registerAutomationHandlers(ctx: DesktopHandlerContext): void {
  const { secureInvoke } = ctx

  secureInvoke(
    'lmcode:listCronJobs',
    async (_event, sessionId: string): Promise<readonly CronJobInfo[]> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.listCronJobs()
    },
  )

  secureInvoke(
    'lmcode:createCronJob',
    async (
      _event,
      sessionId: string,
      input: {
        readonly cron: string
        readonly prompt: string
        readonly recurring?: boolean | undefined
      },
    ): Promise<CronJobInfo> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.createCronJob(input)
    },
  )

  secureInvoke(
    'lmcode:deleteCronJob',
    async (_event, sessionId: string, id: string): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.deleteCronJob(id)
    },
  )

  secureInvoke(
    'lmcode:listBackgroundTasks',
    async (_event, sessionId: string): Promise<readonly BackgroundTaskInfo[]> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.listBackgroundTasks({ activeOnly: false })
    },
  )

  secureInvoke(
    'lmcode:stopTask',
    async (_event, sessionId: string, taskId: string): Promise<void> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      await entry.session.stopBackgroundTask(taskId, { reason: 'Stopped from LMCODE Desktop' })
    },
  )

  secureInvoke(
    'lmcode:getTaskOutput',
    async (_event, sessionId: string, taskId: string): Promise<string> => {
      const entry = await ctx.ensureActiveSession(sessionId)
      return entry.session.getBackgroundTaskOutput(taskId)
    },
  )
}
