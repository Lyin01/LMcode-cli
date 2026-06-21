import {
  APIContextOverflowError,
  grandTotal as ltodGrandTotal,
  type ContentPart,
} from '@lmcode-cli/ltod';

import type { Agent } from '..';
import {
  ErrorCodes,
  type LmcodeErrorPayload,
  isLmcodeError,
  makeErrorPayload,
  toLmcodeErrorPayload,
} from '#/errors';
import { isAbortError, isMaxStepsExceededError } from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent } from '../../rpc';
import { abortable, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '../context';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { ToolCallDeduplicator } from './tool-dedup';
import { resolvePathAccessPath } from '../../tools/policies/path-access';
import { validateFileSyntaxWithScreenshots } from '../../utils/self-healing';

interface ActiveTurn {
  controller: AbortController;
  promise: Promise<TurnEndResult>;
}

interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly event: TurnEndedEvent;
  readonly stopReason?: LoopTurnStopReason;
}

export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';

const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal',
  'with `blocked`. Otherwise keep going — use the existing conversation context and your tools,',
  'and do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly currentStepByTurn = new Map<number, number>();
  private currentStep = 0;

  constructor(protected readonly agent: Agent) {}

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input,
      origin,
    });
    return this.launch(input, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.steer',
      input,
      origin,
    });
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    // Initialize dream tracker and record new session on first turn
    if (this.turnId === -1) {
      void this.agent.dreamTracker.init().then(() =>
        this.agent.dreamTracker.recordNewSession(),
      );
    }

    // Per-turn setup (usage window, `turn.started`, appending the prompt)
    // lives in `runOneTurn`, so a goal-driven run emits a clean start/end
    // pair per continuation turn rather than one mega-turn.
    const turnId = this.allocateTurnId();
    const controller = new AbortController();
    const promise = this.turnWorker(turnId, input, origin, controller.signal);
    this.activeTurn = { controller, promise };
    return turnId;
  }

  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  cancel(turnId?: number, reason?: unknown): void {
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return; // Ignore cancel for non-active turn
    }
    // A direct cancel (RPC / replay) is the user pressing stop. When the cancel
    // is propagated from an aborting signal (e.g. a subagent's deadline via
    // waitForCurrentTurn), carry that original reason instead so a timeout is
    // not mislabeled to the model as a deliberate user interruption.
    const cancelReason = reason ?? userCancellationReason();
    this.abortTurn(cancelReason);
    this.agent.subagentHost?.cancelAll(cancelReason);
  }

  get currentId() {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.activeTurn;
    if (active === null || active === 'resuming') {
      return Promise.reject(new Error('No active turn'));
    }
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  private abortTurn(reason: unknown) {
    if (this.activeTurn !== 'resuming') {
      // The reason (a user cancellation by default, or the originating signal's
      // reason when propagated) travels as signal.reason so tools settling on
      // this signal can report a deliberate user interruption distinctly from a
      // timeout/system abort. linkAbortSignal forwards it to linked subagents.
      this.activeTurn?.controller.abort(reason);
    }
    this.activeTurn = null;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  finishResume(): void {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
  }

  private async turnWorker(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const ownsActiveTurn = (): boolean =>
      this.activeTurn !== null &&
      this.activeTurn !== 'resuming' &&
      this.activeTurn.controller.signal === signal;
    try {
      const initialGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (initialGoalStatus === 'active') {
        return await this.driveGoal(turnId, input, origin, signal);
      }
      const end = await this.runOneTurn(turnId, input, origin, signal, true);
      const resumedFromPausedOrBlocked =
        initialGoalStatus === 'paused' || initialGoalStatus === 'blocked';
      const currentGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (
        resumedFromPausedOrBlocked &&
        currentGoalStatus === 'active' &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'failed'
      ) {
        return await this.driveGoal(
          this.allocateTurnId(),
          [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
          GOAL_CONTINUATION_ORIGIN,
          signal,
        );
      }
      return end;
    } finally {
      if (ownsActiveTurn()) {
        this.activeTurn = null;
      }
    }
  }

  /**
   * Drives an active goal as a sequence of ordinary turns. Each iteration runs
   * one full turn, then reads the goal status the model set via UpdateGoal.
   */
  private async driveGoal(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    let turnId = firstTurnId;
    let turnInput = input;
    let turnOrigin = origin;
    while (true) {
      const goalBeforeTurn = this.agent.goal.getGoal().goal;
      if (goalBeforeTurn?.status === 'active' && goalBeforeTurn.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
        return { event: ended };
      }

      await this.agent.goal.incrementTurn();
      const end = await this.runOneTurn(turnId, turnInput, turnOrigin, signal, false);

      if (end.event.reason === 'cancelled') {
        await this.agent.goal.pauseOnInterrupt({ reason: 'Paused after interruption' });
        return end;
      }
      if (end.event.reason === 'failed') {
        const reason = end.event.error?.message ?? 'Turn failed';
        await this.agent.goal.pauseActiveGoal({ reason });
        return end;
      }

      const goal = this.agent.goal.getGoal().goal;
      if (goal === null || goal.status !== 'active') {
        return end;
      }
      if (goal.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        return end;
      }

      turnId = this.allocateTurnId();
      turnInput = [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }];
      turnOrigin = GOAL_CONTINUATION_ORIGIN;
    }
  }

  private async endGoalTurnWithoutModel(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
  ): Promise<TurnEndedEvent> {
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);
    const ended: TurnEndedEvent = { type: 'turn.ended', turnId, reason: 'completed' };
    this.agent.usage.endTurn();
    this.agent.emitEvent(ended);
    return ended;
  }

  private allocateTurnId(): number {
    this.turnId += 1;
    return this.turnId;
  }

  /**
   * Runs exactly one logical turn end to end: per-turn bookkeeping,
   * `turn.started`, the prompt + goal reminder, the step loop, and `turn.ended`.
   * Goal-agnostic — the driver layers goal semantics on top. Never throws;
   * abnormal ends are mapped to a `cancelled`/`failed` `turn.ended` and returned.
   */
  private async runOneTurn(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    standalone: boolean,
  ): Promise<TurnEndResult> {
    this.currentStep = 0;
    this.agent.workingSet.decay(turnId);
    this.currentStepByTurn.set(turnId, 0);
    this.agent.fullCompaction.resetForTurn();
    this.agent.injection.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);

    let ended: TurnEndedEvent;
    let completedStopReason: LoopTurnStopReason | undefined;
    let errorEvent: AgentEvent | undefined;
    try {
      const promptHookEnded = await this.applyUserPromptHook(
        turnId,
        input,
        origin,
        signal,
      );
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded;
      } else {
        const stopReason = await this.runTurn(turnId, signal);
        completedStopReason = stopReason;
        ended = {
          type: 'turn.ended',
          turnId,
          reason: stopReason === 'aborted' ? 'cancelled' : 'completed',
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'cancelled',
        };
      } else {
        const summary = summarizeTurnError(error, turnId);
        this.agent.sessionMemory.recordError(
          `${summary.name}: ${summary.message}`,
          this.currentStep,
        );
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: {
            errorType: summary.name,
            errorMessage: summary.message,
          },
        });
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'failed',
          error: summary,
        };
        errorEvent = { type: 'error', ...summary };
      }
    }
    // Emit the terminal turn.ended and (for a standalone turn) release the active
    // turn in the SAME synchronous frame, so the session is observably idle the
    // instant turn.ended fires. A goal drive keeps the active turn across its
    // continuation turns and releases it in `turnWorker` instead (`standalone`
    // is false for those).
    if (this.currentId === turnId) {
      this.agent.usage.endTurn();
    }
    this.agent.emitEvent(ended);
    if (standalone && this.currentId === turnId) {
      this.activeTurn = null;
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }
    this.currentStepByTurn.delete(turnId);
    return {
      event: ended,
      stopReason: completedStopReason,
    };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndedEvent | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      return {
        type: 'turn.ended',
        turnId,
        reason: 'completed',
      };
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runTurn(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    const deduper = new ToolCallDeduplicator();
    await this.agent.mcp?.waitForInitialLoad(signal);
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.lmcodeConfig?.loopControl;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          dispatchEvent: this.buildDispatchEvent(turnId),
          tools: this.agent.tools.loopTools,
          log: this.agent.log,
          maxSteps: loopControl?.maxStepsPerTurn,
          maxRetryAttempts: loopControl?.maxRetriesPerStep,
          hooks: {
            beforeStep: async ({ signal: stepSignal, stepNumber }) => {
              this.flushSteerBuffer();
              await this.agent.fullCompaction.beforeStep(stepSignal);

              // Inject session memory summary so the model retains context
              // after compaction strips detailed tool-call history.
              const sessionSummary = this.agent.sessionMemory.getSessionSummary();
              if (sessionSummary.length > 0) {
                this.agent.context.appendSystemReminder(sessionSummary, {
                  kind: 'injection',
                  variant: 'session_memory',
                });
              }

              // Suggest /dream on the first step when conditions are met
              if (stepNumber === 1 && this.agent.dreamTracker.shouldSuggest()) {
                this.agent.context.appendSystemReminder(
                  this.agent.dreamTracker.getSuggestionMessage(),
                  { kind: 'injection', variant: 'dream_suggestion' },
                );
              }

              await this.agent.injection.inject();
              deduper.beginStep();
              return;
            },
            afterStep: async ({ usage }) => {
              this.agent.usage.record(model, usage, 'turn');
              this.agent.usage.recordLlmStep();
              await this.agent.goal.recordTokenUsage(ltodGrandTotal(usage));
              await this.agent.fullCompaction.afterStep();
              deduper.endStep();
            },
            // oxlint-disable-next-line no-loop-func -- stop hook continuation state is scoped to this turn.
            shouldContinueAfterStop: async ({ signal }) => {
              if (this.flushSteerBuffer()) return { continue: true };
              signal.throwIfAborted();

              // Stop hooks get one continuation; otherwise a hook that always blocks would loop forever.
              if (stopHookContinuationUsed) return { continue: false };
              const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                signal,
                inputData: { stopHookActive: stopHookContinuationUsed },
              });
              signal.throwIfAborted();
              if (stopBlock !== undefined) {
                stopHookContinuationUsed = true;
                this.agent.context.appendUserMessage(
                  [{ type: 'text', text: stopBlock.reason }],
                  {
                    kind: 'system_trigger',
                    name: 'stop_hook',
                  },
                );
                return { continue: true };
              }
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };
              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // Resolve dedup BEFORE firing the PostToolUse hook so same-step
              // dups (whose ctx.result is the dedup placeholder) report the
              // original's real outcome, not an empty success.
              let finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );

              // ── Post-write self-healing validation ──
              if (
                finalResult.isError !== true &&
                this.agent.lmcodeConfig?.enableSelfHealing !== false &&
                (ctx.toolCall.name === 'Write' ||
                  ctx.toolCall.name === 'Edit' ||
                  ctx.toolCall.name === 'MultiEdit')
              ) {
                const args = ctx.args as any;
                if (args && typeof args.path === 'string') {
                  try {
                    const workspace = {
                      workspaceDir: this.agent.config.cwd,
                      additionalDirs: [],
                    };
                    const resolvedPath = resolvePathAccessPath(args.path, {
                      jian: this.agent.jian,
                      workspace,
                      operation: 'write',
                    });
                    const content = await this.agent.jian.readText(resolvedPath);
                    const validationRes = await validateFileSyntaxWithScreenshots(resolvedPath, content);
                    if (validationRes.error) {
                      finalResult = {
                        isError: true,
                        output: `Code validation failed. Please fix the following issue:\n${validationRes.error}`,
                      };
                    } else {
                      // 1. Run LMM Visual Auditor if screenshots are captured
                      let visualRejected = false;
                      let visualFeedback = '';
                      if (
                        validationRes.screenshots &&
                        validationRes.screenshots.length > 0 &&
                        this.agent.config.modelCapabilities.image_in
                      ) {
                        try {
                          // Label each frame by its capture time; the last one
                          // is the terminal/end state where uncleared-buffer
                          // ghosts and never-ending particle fields surface.
                          const keyTimes = validationRes.keyframeTimesMs;
                          const frameLines = validationRes.screenshots
                            .map((_, i) => {
                              const isLast = i === validationRes.screenshots!.length - 1;
                              const at =
                                keyTimes && keyTimes[i] != null
                                  ? `${(keyTimes[i] / 1000).toFixed(1)}s`
                                  : `frame ${i + 1}`;
                              return `- Screenshot ${i + 1}: ${at}${isLast ? ' — TERMINAL / end state' : ''}`;
                            })
                            .join('\n');

                          const visualSystemPrompt = `You are a visual quality inspector (LMM Visual Auditor) for generated graphics/animation code (HTML <canvas>, SVG, WebGL, etc.).
The conversation above contains the user's actual request. Judge the rendered output against THAT request — do not assume any particular scene or subject.

You are given keyframe screenshots captured from the running output at increasing timestamps, in order:
${frameLines}

Check for:
1. Faithfulness to the user's request — correct subject, shapes, colours, motion and timing.
2. Rendering/runtime failure — a frame that is blank or a single flat colour when content is expected.
3. THE TERMINAL FRAME especially — once an animation has run to completion, look for artifacts that should NOT be there:
   - ghost/residual shapes or hard-edged rectangles from a shadow or buffer that was never cleared;
   - objects that should have disappeared but still persist;
   - particles that keep spawning forever, leaving a static uniform "starfield"/field that never settles or fades out;
   - an unexpectedly empty frame when remnants/residue were requested.
4. Mechanical vs. organic appearance where realism was requested (e.g. perfectly straight or circular edges where irregular/natural ones were asked for).

If you find ANY visual defect, reply starting with:
VISUAL_REJECT: <specific bugs, naming the screenshot/timestamp>

If the output faithfully matches the request with no artifacts, reply with:
VISUAL_APPROVE`;

                          const { project: projectVisual } = await import('../context/projector');
                          const visualHistory = [...projectVisual(this.agent.context.history)];
                          const contentParts: any[] = [
                            {
                              type: 'text',
                              text: 'Here are the rendered keyframe screenshots, in order. Verify them against the user request above.',
                            },
                          ];
                          for (const base64Img of validationRes.screenshots) {
                            contentParts.push({
                              type: 'image_url',
                              imageUrl: {
                                url: `data:image/png;base64,${base64Img}`,
                              },
                            });
                          }
                          visualHistory.push({ role: 'user', content: contentParts, toolCalls: [] });

                          const visualResponse = await this.agent.rawGenerate(
                            this.agent.config.provider,
                            visualSystemPrompt,
                            [],
                            visualHistory,
                          );
                          const visualText = visualResponse.message.content
                            .filter((p: any) => p.type === 'text')
                            .map((p: any) => p.text)
                            .join('');

                          if (visualText.startsWith('VISUAL_REJECT:')) {
                            visualRejected = true;
                            visualFeedback = `Visual review rejected by LMM Auditor:\n${visualText.substring(14).trim()}`;
                          }
                        } catch (err: any) {
                          this.agent.log.warn('LMM Visual Auditor failed or timed out', {
                            error: err.message,
                          });
                        }
                      }

                      if (visualRejected) {
                        finalResult = {
                          isError: true,
                          output: visualFeedback,
                        };
                      } else {
                        // 2. Syntax and Visual passed! Now run Critic LLM review
                        const systemPrompt = `You are a critical code reviewer (Critic Subagent).
Your goal is to inspect the proposed code changes for bugs, edge cases, type safety issues, boundary condition violations, and potential runtime or performance issues.
Analyze the code carefully and be extremely rigorous. Look for:
1. Missing null/undefined checks, unhandled promise rejections, or TDZ (temporal dead zone) errors.
2. Inefficient rendering or computation loops (e.g. O(N^2) pixel/noise operations inside animation loops).
3. Logical inconsistencies or divergence from the user's instructions.
4. Edge conditions, like what happens when progress variables reach 0 or 1.

If the code has ANY issues, bugs, or improvements needed, reply starting with:
REJECT: [list of bugs and explanations]

If the code is fully robust, correct, and conforms to all requirements, reply with:
APPROVE`;

                        const prompt = `File Path: ${resolvedPath}

Please review the current content of this file:
\`\`\`
${content}
\`\`\`

Evaluate if this file meets high-quality software engineering standards and the original requirements. Reply with APPROVE or REJECT.`;

                        const { project } = await import('../context/projector');
                        const history = [...project(this.agent.context.history)];
                        history.push({
                          role: 'user',
                          content: [{ type: 'text', text: prompt }],
                          toolCalls: [],
                        });

                        const criticResponse = await this.agent.rawGenerate(
                          this.agent.config.provider,
                          systemPrompt,
                          [],
                          history,
                        );
                        const criticText = criticResponse.message.content
                          .filter((p: any) => p.type === 'text')
                          .map((p: any) => p.text)
                          .join('');

                        if (criticText.startsWith('REJECT:')) {
                          finalResult = {
                            isError: true,
                            output: `Code review rejected by Critic:\n${criticText.substring(7).trim()}`,
                          };
                        }
                      }
                    }
                  } catch (err: any) {
                    this.agent.log.warn('Self-healing code validation skipped or failed internally', {
                      error: err.message,
                      path: args.path,
                    });
                  }
                }
              }

              const { isError, output } = finalResult;

              // Count the tool execution for session stats.
              this.agent.usage.recordToolCall(ctx.toolCall.name);

              // Record in session memory for post-compaction context injection
              this.agent.sessionMemory.recordToolExecution(
                ctx.toolCall.name,
                summarizeToolArgs(ctx.args),
                isError === true,
                ctx.stepNumber,
              );

              // Track accessed files for the working-set reminder.
              this.recordWorkingSetPaths(
                ctx.toolCall.name,
                ctx.args,
                Number(ctx.turnId),
              );

              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              void this.agent.hooks?.fireAndForgetTrigger(event, {
                matcherValue: ctx.toolCall.name,
                inputData: {
                  toolName: ctx.toolCall.name,
                  toolInput: toolInputRecord(ctx.args),
                  toolCallId: ctx.toolCall.id,
                  error: isError === true ? toLmcodeErrorPayload(toolOutputText(output)) : undefined,
                  toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
                },
              });
              return finalResult;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        if (
          error instanceof APIContextOverflowError ||
          (isLmcodeError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
        ) {
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // Retry with compacted context
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isLmcodeError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  private recordWorkingSetPaths(toolName: string, args: unknown, turnId: number): void {
    const workingSet = this.agent.workingSet;
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Grep' || toolName === 'Write' || toolName === 'ReadMediaFile') {
      const record = (args as { path?: string }).path;
      if (record !== undefined) workingSet.touch(record, turnId);
    }
    if (toolName === 'ReadGroup') {
      const paths = (args as { paths?: string[] }).paths;
      if (Array.isArray(paths)) {
        for (const path of paths) workingSet.touch(path, turnId);
      }
    }
  }

  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.updateCurrentStepFromLoopEvent(event, turnId);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  private updateCurrentStepFromLoopEvent(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.beginTrackedStep(turnId, event.step);
      return;
    }
    if (event.type === 'step.retrying') {
      this.agent.usage.recordRetry();
      return;
    }
  }

  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
  }

}

function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

const LLM_NOT_SET_MESSAGE =
  'No model configured. Run `lm config` or use `/model` to set a default model.';

function summarizeTurnError(error: unknown, turnId: number): LmcodeErrorPayload {
  const payload = toLmcodeErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

function toolInputRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}



/** Extract a short human-readable summary from tool arguments. */
function summarizeToolArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  // Common tool arg patterns — try each in priority order
  if (typeof a['file_path'] === 'string') return a['file_path'];
  if (typeof a['path'] === 'string') return a['path'];
  if (typeof a['description'] === 'string') return truncateArg(a['description']);
  if (typeof a['subject'] === 'string') return a['subject'];
  if (typeof a['command'] === 'string') return truncateArg(a['command']);
  if (typeof a['query'] === 'string') return truncateArg(a['query']);
  if (typeof a['url'] === 'string') return a['url'];
  return '';
}

function truncateArg(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
