import type { ContentPart, Message, TokenUsage } from '@lmcode-cli/liumir';

import type { Agent } from '..';
import type { ExecutableToolResult, FinalizeToolResultContext } from '../../loop/types';
import { resolveRealPathAccessPath } from '../../tools/policies/path-access';
import {
  MAX_SELF_HEALING_SOURCE_BYTES,
  validateFileSyntaxWithScreenshots,
  type FileValidationResult,
} from '../../utils/self-healing';
import type { UsageRecordScope } from '../usage';
import CRITIC_SYSTEM_PROMPT from './critic-system.md';
import { escapeXmlText, withReviewDeadline } from './review-deadline';
import VISUAL_AUDITOR_SYSTEM_PROMPT from './visual-auditor-system.md';

const DEFAULT_MAX_REVIEWS = 2;
const MAX_CONVERSATION_CHARS = 16_000;
const MAX_CONVERSATION_MESSAGES = 8;
const FILE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

type Check = 'syntax' | 'runtime' | 'visual' | 'source' | 'overall';
type Verdict =
  | { outcome: 'approved'; notes: string | undefined }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'inconclusive' };

type RecordUsage = (
  model: string,
  goalId: string | undefined,
  usage: TokenUsage | null,
  scope: UsageRecordScope,
) => Promise<void>;

interface ReviewRun {
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly number: number;
  readonly notices: string[];
  path: string;
  key: string;
}

export class PostWriteReview {
  private readonly changed = new Set<string>();
  private readonly warnings = new Map<string, string>();
  private readonly limit: number;
  private used = 0;
  private warned = false;

  constructor(
    private readonly agent: Agent,
    private readonly turnId: number,
    private readonly recordUsage: RecordUsage,
  ) {
    this.limit = agent.lmcodeConfig?.loopControl?.maxPostWriteReviewsPerTurn ?? DEFAULT_MAX_REVIEWS;
  }

  get mutatedPaths(): ReadonlySet<string> {
    return this.changed;
  }

  get limitations(): ReadonlyMap<string, string> {
    return this.warnings;
  }

  async observe(
    ctx: FinalizeToolResultContext,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    if (result.isError === true || !FILE_MUTATION_TOOLS.has(ctx.toolCall.name)) return result;
    const path = getPath(ctx.args);
    if (path === undefined) return result;
    this.changed.add(path);
    if (this.agent.lmcodeConfig?.enableSelfHealing === false) return result;

    ctx.signal.throwIfAborted();
    const run: ReviewRun = {
      toolCallId: ctx.toolCall.id,
      signal: ctx.signal,
      number: this.used + 1,
      notices: [],
      path,
      key: this.pathKey(path),
    };
    if (this.used >= this.limit) {
      this.limitReached(run);
      return this.warned ? result : this.announceLimit(run, result);
    }

    this.used++;
    this.progress(run, 'checking syntax and runtime');
    let error: string | undefined;
    try {
      const { content, validation } = await withReviewDeadline(
        run.signal, 'Automatic post-write stage', async (signal) => {
          const resolvedPath = await resolveRealPathAccessPath(path, {
            jian: this.agent.jian,
            workspace: { workspaceDir: this.agent.config.cwd, additionalDirs: [] },
            operation: 'write',
          });
          signal.throwIfAborted();
          run.path = resolvedPath;
          run.key = this.pathKey(resolvedPath);
          const content = await this.agent.jian.readText(resolvedPath);
          signal.throwIfAborted();
          const validation = await validateFileSyntaxWithScreenshots(resolvedPath, content, { signal });
          return { content, validation };
        },
      );
      this.clear(path, 'overall');
      this.clear(run.key, 'overall');
      error = this.localEvidence(run, validation);
      if (error === undefined) {
        error = (await this.visualReview(run, validation)) ?? (await this.sourceReview(run, content));
      }
    } catch (failure) {
      run.signal.throwIfAborted();
      this.agent.log.warn('Self-healing code validation skipped or failed internally', {
        error: describeError(failure),
        path,
      });
      this.limitEvidence(run, 'overall',
        'Automatic post-write validation did not complete, so its overall result is inconclusive. ' +
          'Do not claim syntax, runtime, or visual verification based on this check.',
      );
    }
    const reviewed = error === undefined ? result : { ...result, isError: true, output: error };
    return appendNotices(reviewed, run.notices);
  }

  private pathKey(path: string): string {
    return this.agent.jian.pathClass() === 'win32' ? path.toLowerCase() : path;
  }

  private limitReached(run: ReviewRun): void {
    this.limitEvidence(run, 'overall',
      `Automatic post-write review was skipped because this turn reached its ${this.limit}-review limit. ` +
        'The write remains successful. Do not rewrite the file solely to trigger another automatic review; ' +
        'use a targeted build or test if more evidence is required.',
    );
  }

  private announceLimit(run: ReviewRun, result: ExecutableToolResult): ExecutableToolResult {
    this.warned = true;
    this.agent.emitEvent({
      type: 'warning',
      code: 'post_write_review_limit_reached',
      message:
        `Automatic post-write review stopped after ${this.limit} complete ` +
        `${this.limit === 1 ? 'pass' : 'passes'} in this turn. ` +
        'Later writes remain available but will not trigger another automatic review.',
    });
    return appendNotices(result, run.notices);
  }

  private progress(run: ReviewRun, text: string): void {
    this.agent.emitEvent({
      type: 'tool.progress',
      turnId: this.turnId,
      toolCallId: run.toolCallId,
      update: { kind: 'status', text: `Automatic review ${run.number}/${this.limit}: ${text}` },
    });
  }

  private localEvidence(run: ReviewRun, validation: FileValidationResult): string | undefined {
    if (validation.syntax?.status === 'passed') this.clear(run.key, 'syntax');
    if (validation.syntax?.status === 'skipped') {
      this.limitEvidence(run, 'syntax',
        `Automatic syntax validation was skipped (${validation.syntax.reason}). ` +
          'Do not claim that syntax was verified unless a separate parser or build check succeeds.',
      );
    }
    if (validation.runtime?.status === 'passed') this.clear(run.key, 'runtime');
    if (validation.runtime?.status === 'skipped') {
      this.limitEvidence(run, 'runtime',
        `Automatic browser validation was skipped (${validation.runtime.reason}). ` +
          'Runtime behavior and visual output were not verified. ' +
          'Do not claim browser or visual verification unless a separate observable browser check succeeds.',
      );
    }
    if (!validation.error) return undefined;

    const check = validation.syntax?.status === 'failed' ? 'syntax'
      : validation.runtime?.status === 'failed' ? 'runtime' : 'overall';
    this.limitEvidence(run, check, `Automatic ${check} validation failed: ${summarize(validation.error)}`);
    return `Code validation failed. Please fix the following issue:\n${validation.error}`;
  }

  private async visualReview(run: ReviewRun, validation: FileValidationResult): Promise<string | undefined> {
    const { screenshots, keyframeTimesMs } = validation;
    if (screenshots === undefined || screenshots.length === 0) return undefined;
    if (!this.agent.config.modelCapabilities.image_in) {
      this.limitEvidence(run, 'visual',
        'Browser runtime validation passed and keyframe screenshots were captured, ' +
          'but visual compliance was not reviewed because the active model cannot inspect images. ' +
          'Do not claim that appearance, animation timing, or the terminal frame was visually verified.',
      );
      return undefined;
    }

    this.progress(run, 'inspecting rendered keyframes');
    const frameLines = screenshots.map((_, index) => {
      const timestamp = keyframeTimesMs?.[index];
      const at = timestamp === undefined ? 'capture time unknown' : `${(timestamp / 1000).toFixed(1)}s`;
      const terminal = screenshots.length > 1 && index === screenshots.length - 1;
      return `- Screenshot ${index + 1}: ${at}${terminal ? ' — TERMINAL / end state' : ''}`;
    }).join('\n');
    const content: ContentPart[] = [{
      type: 'text',
      text: 'Here are the rendered keyframe screenshots, in order. Verify them against the user request above.',
    }];
    for (const screenshot of screenshots) {
      content.push({ type: 'image_url', imageUrl: { url: `data:image/png;base64,${screenshot}` } });
    }
    return this.modelReview(run, 'visual',
      VISUAL_AUDITOR_SYSTEM_PROMPT.replace('{{FRAME_LINES}}', frameLines), content,
    );
  }

  private async sourceReview(run: ReviewRun, content: string): Promise<string | undefined> {
    if (Buffer.byteLength(content, 'utf8') > MAX_SELF_HEALING_SOURCE_BYTES) {
      this.limitEvidence(run, 'source',
        'Automatic source review was skipped because the file exceeds the safe validation size limit. ' +
          'Do not describe automated code review as passed.',
      );
      return undefined;
    }

    this.progress(run, 'reviewing source');
    return this.modelReview(run, 'source', CRITIC_SYSTEM_PROMPT, [{
      type: 'text',
      text: `File Path: ${run.path}\n\nReview this file snapshot against the user's request.\n\n` +
        `\`\`\`\n${content}\n\`\`\``,
    }]);
  }

  private async modelReview(
    run: ReviewRun,
    kind: 'visual' | 'source',
    systemPrompt: string,
    content: ContentPart[],
  ): Promise<string | undefined> {
    let verdict: Verdict;
    try {
      const { provider, model } = this.agent.config;
      const goalId = this.agent.goal.getActiveGoal()?.goalId;
      const history = this.conversation();
      history.push({ role: 'user', content, toolCalls: [] });
      verdict = await withReviewDeadline(run.signal, `Automatic ${kind} review`, async (signal) => {
        const response = await this.agent.generate(provider, systemPrompt, [], history, undefined, { signal });
        await this.recordUsage(model, goalId, response.usage, signal.aborted ? 'session' : 'turn');
        signal.throwIfAborted();
        const text = response.message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        return parseVerdict(text, kind);
      });
    } catch (failure) {
      run.signal.throwIfAborted();
      this.agent.log.warn(`Automatic ${kind} review failed or timed out`, {
        error: describeError(failure),
        path: run.path,
      });
      this.reviewUnavailable(run, kind, 'failed or timed out');
      return undefined;
    }

    if (verdict.outcome === 'inconclusive') {
      this.reviewUnavailable(run, kind, 'returned an inconclusive verdict');
      return undefined;
    }
    if (verdict.outcome === 'rejected') {
      const subject = kind === 'visual' ? 'the rendered output' : 'the file';
      const label = kind === 'visual' ? 'Visual review rejected by LMM Auditor' : 'Code review rejected by Critic';
      this.limitEvidence(run, kind, `Automatic ${kind} review rejected ${subject}: ${summarize(verdict.reason)}`);
      return `${label}:\n${verdict.reason}`;
    }
    this.clear(run.key, kind);
    if (verdict.notes !== undefined) {
      const label = kind === 'visual' ? 'polish' : 'improvement';
      run.notices.push(
        `File ${JSON.stringify(run.path)}: Automatic ${kind} review passed with non-blocking ${label} notes: ${verdict.notes}. ` +
          'Treat them as optional. Mention worthwhile notes briefly and apply only small, clearly correct changes.',
      );
    }
    return undefined;
  }

  private reviewUnavailable(run: ReviewRun, kind: 'visual' | 'source', reason: string): void {
    const notice = kind === 'visual'
      ? `Browser runtime validation passed, but the visual auditor ${reason}. Do not claim that visual compliance was verified.`
      : `Automatic source review ${reason}. Do not describe automated code review as passed.`;
    this.limitEvidence(run, kind, notice);
  }

  private conversation(): Message[] {
    const context = this.agent.context.history;
    const messages: Message[] = [];
    let remaining = MAX_CONVERSATION_CHARS;
    // Skip tool exchanges, whose write arguments and read results can dwarf
    // the actual request. The source snapshot or keyframes are sent separately.
    for (let index = context.length - 1; index >= 0 && remaining > 0; index--) {
      const message = context[index]!;
      if (message.role !== 'user' || message.origin?.kind !== 'user') continue;
      const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
      if (text.length === 0) continue;
      const excerpt = text.slice(0, remaining);
      messages.push({ role: 'user', content: [{ type: 'text', text: excerpt }], toolCalls: [] });
      remaining -= excerpt.length;
      if (messages.length === MAX_CONVERSATION_MESSAGES) break;
    }
    return messages.reverse();
  }

  private limitEvidence(run: ReviewRun, kind: Check, notice: string): void {
    const rendered = `File ${JSON.stringify(run.path)}: ${notice}`;
    this.warnings.set(`${run.key}\0${kind}`, rendered);
    run.notices.push(rendered);
  }

  private clear(key: string, kind: Check): void {
    this.warnings.delete(`${key}\0${kind}`);
  }
}

function getPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const path = record['path'] ?? record['file_path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(text: string): string {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length > 500 ? `${line.slice(0, 497)}...` : line;
}

function parseVerdict(raw: string, kind: 'source' | 'visual'): Verdict {
  const text = raw.trim();
  const prefix = kind === 'visual' ? 'VISUAL_' : '';
  const reject = `${prefix}REJECT:`;
  if (text.startsWith(reject)) {
    const reason = text.slice(reject.length).trim();
    return reason.length > 0 ? { outcome: 'rejected', reason } : { outcome: 'inconclusive' };
  }
  const [firstLine, ...details] = text.split(/\r?\n/u);
  if (firstLine?.trimEnd() !== `${prefix}APPROVE`) return { outcome: 'inconclusive' };
  if (details.some((line) => line.trimStart().startsWith(reject))) return { outcome: 'inconclusive' };
  const noteLine = details.find((line) => line.trimStart().startsWith('NOTES:'));
  const notes = noteLine && summarize(noteLine.trimStart().slice('NOTES:'.length));
  return { outcome: 'approved', notes: notes || undefined };
}

function appendNotices(result: ExecutableToolResult, notices: string[]): ExecutableToolResult {
  if (notices.length === 0) return result;
  const suffix = notices.map((notice) =>
    `\n\n<system>Automatic validation notice: ${escapeXmlText(notice)}</system>`,
  ).join('');
  const output = typeof result.output === 'string'
    ? `${result.output}${suffix}`
    : [...result.output, { type: 'text' as const, text: suffix }];
  return { ...result, output };
}
