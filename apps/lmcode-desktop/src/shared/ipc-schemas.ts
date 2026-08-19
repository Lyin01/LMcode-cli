import { z } from 'zod'

/**
 * Wire-boundary schemas for the desktop IPC surface.
 *
 * The main process validates every structured or enum-constrained argument at
 * the `secureInvoke` boundary (see `main/ipc/handler.ts`) before it reaches
 * business logic. The renderer is sandboxed and CSP-restricted, but the IPC
 * bridge is still a wire boundary: a compromised or buggy renderer must not be
 * able to smuggle malformed payloads (empty ids, invalid enum values, wrong
 * object shapes) past the trust boundary. This mirrors the "validate at the
 * wire boundary" invariant of the deepseek-harness reference.
 */

// ── Scalars and enums ─────────────────────────────────────────────

export const sessionIdSchema = z.string().trim().min(1)

export const permissionModeSchema = z.enum(['yolo', 'manual', 'auto'])

export const goalStatusSchema = z.enum(['active', 'complete', 'paused', 'blocked'])

export const gitDiscardScopeSchema = z.enum(['unstaged', 'all'])

const gitHunkSectionKindSchema = z.enum(['staged', 'unstaged'])

const gitHunkActionSchema = z.enum(['stage', 'unstage', 'revert'])

const approvalDecisionSchema = z.enum(['approved', 'rejected', 'cancelled'])

// ── Structured payloads ───────────────────────────────────────────

const promptAttachmentInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('path'),
    kind: z.enum(['text', 'image']),
    filePath: z.string().trim().min(1),
  }),
  z.object({
    source: z.literal('inline'),
    kind: z.literal('image'),
    name: z.string().trim().min(1),
    dataUrl: z.string().min(1),
  }),
])

export const desktopPromptRequestSchema = z.object({
  text: z.string(),
  attachments: z.array(promptAttachmentInputSchema),
})

export const createSessionOptionsSchema = z
  .object({
    workDir: z.string().trim().min(1).optional(),
    noProject: z.boolean().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    permission: permissionModeSchema.optional(),
  })
  .refine(
    (value) =>
      value.noProject === true || (value.workDir !== undefined && value.workDir.length > 0),
    { message: 'workDir is required unless noProject is true' },
  )

export const createCronJobInputSchema = z.object({
  cron: z.string().trim().min(1),
  prompt: z.string(),
  recurring: z.boolean().optional(),
})

export const gitHunkActionInputSchema = z.object({
  filePath: z.string().trim().min(1),
  sectionKind: gitHunkSectionKindSchema,
  hunkIndex: z.number().int().nonnegative(),
  action: gitHunkActionSchema,
})

export const approvalResponsePayloadSchema = z.object({
  requestId: z.string().trim().min(1),
  response: z.object({
    decision: approvalDecisionSchema,
    scope: z.enum(['session']).optional(),
    feedback: z.string().optional(),
    selectedLabel: z.string().optional(),
  }),
})

export const questionResponsePayloadSchema = z.object({
  requestId: z.string().trim().min(1),
  // The question result is a reverse-RPC response whose shape is owned by the
  // agent-core consumer; the desktop only forwards it. Validate the envelope
  // here and leave the payload to the SDK consumer.
  result: z.unknown(),
})

export const mcpServerConfigSchema = z.record(z.string(), z.unknown())

// ── Argument tuples (one per validated channel) ───────────────────

export const createSessionArgsSchema = z.tuple([createSessionOptionsSchema])

export const promptArgsSchema = z.tuple([sessionIdSchema, desktopPromptRequestSchema])

export const setPermissionArgsSchema = z.tuple([sessionIdSchema, permissionModeSchema])

export const setPlanModeArgsSchema = z.tuple([sessionIdSchema, z.boolean()])

export const createGoalArgsSchema = z.tuple([sessionIdSchema, z.string().trim().min(1), z.boolean()])

export const updateGoalStatusArgsSchema = z.tuple([sessionIdSchema, goalStatusSchema])

export const createCronJobArgsSchema = z.tuple([sessionIdSchema, createCronJobInputSchema])

export const addMcpServerArgsSchema = z.tuple([
  sessionIdSchema,
  z.string().trim().min(1),
  mcpServerConfigSchema,
])

export const applyGitHunkActionArgsSchema = z.tuple([sessionIdSchema, gitHunkActionInputSchema])

export const setGitFileStagedArgsSchema = z.tuple([
  sessionIdSchema,
  z.string().trim().min(1),
  z.boolean(),
])

export const discardGitFileChangesArgsSchema = z.tuple([
  sessionIdSchema,
  z.string().trim().min(1),
  gitDiscardScopeSchema,
])

export const respondApprovalArgsSchema = z.tuple([approvalResponsePayloadSchema])

export const respondQuestionArgsSchema = z.tuple([questionResponsePayloadSchema])

export const worktreeHandoffArgsSchema = z.tuple([sessionIdSchema, z.string().trim().min(1)])

/**
 * Validate an IPC argument list against a tuple schema. Returns the parsed
 * arguments, or throws a descriptive error naming the offending channel.
 * Pure and side-effect free so it can be unit-tested directly.
 */
export function parseIpcArgs(schema: z.ZodType<unknown[]>, args: unknown[], channel: string): unknown[] {
  const result = schema.safeParse(args)
  if (result.success) return result.data

  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new Error(`Invalid IPC arguments on "${channel}": ${detail}`)
}
