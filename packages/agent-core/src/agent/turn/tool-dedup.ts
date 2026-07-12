import type { ContentPart } from '@lmcode-cli/ltod';

import type { ToolAccesses } from '../../loop/tool-access';
import type { ExecutableToolResult } from '../../loop/types';
import { MAX_LINES as READ_MAX_LINES } from '../../tools/builtin/file/read';
import { canonicalizePath, type PathClass } from '../../tools/policies/path-access';
import { estimateTokens } from '../../utils/tokens';
import { MAX_TOOL_RESULT_TOKENS } from '../context/tool-output-limits';

import { canonicalDedupArgs, isPlainRecord } from './canonical-args';

const REMINDER_TEXT_1 =
  '\n\n<system-reminder>\n' +
  'You are repeating the exact same tool call with identical parameters.' +
  ' Please carefully analyze the previous result. If the task is not yet complete,' +
  ' try a different method or parameters instead of repeating the same call.' +
  '\n</system-reminder>';

function makeReminderText2(toolName: string, repeatCount: number, args: unknown): string {
  const argsStr = canonicalDedupArgs(args);
  return (
    '\n\n<system-reminder>\n' +
    'You have repeatedly called the same tool with identical parameters many times.\n' +
    'Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- repeated_times: ${String(repeatCount)}\n` +
    `- arguments: ${argsStr}\n` +
    'The previous repeated calls did not make progress. Do not call this exact same tool with the exact same arguments again.\n' +
    'Carefully inspect the latest tool result and choose a different next action, different parameters, or finish the task if enough evidence has been gathered.' +
    '\n</system-reminder>'
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeKey(toolName: string, args: unknown): string {
  return `${toolName} ${canonicalDedupArgs(args)}`;
}

function appendReminder(result: ExecutableToolResult, reminderText: string): ExecutableToolResult {
  const output = result.output;
  let newOutput: string | ContentPart[];
  if (typeof output === 'string') {
    newOutput = output + reminderText;
  } else {
    const arr: ContentPart[] = [...output];
    const last = arr.at(-1);
    if (last !== undefined && last.type === 'text') {
      arr[arr.length - 1] = { type: 'text', text: last.text + reminderText };
    } else {
      arr.push({ type: 'text', text: reminderText });
    }
    newOutput = arr;
  }
  return result.isError === true
    ? { ...result, output: newOutput, isError: true }
    : { ...result, output: newOutput };
}

/**
 * Placeholder result returned from `checkSameStep` for a duplicate call. Never
 * reaches the model — it is replaced in `finalizeResult` by awaiting the
 * original's deferred result. The loop dispatches `tool.result` events using
 * the finalized value, so this content is purely internal bookkeeping.
 *
 * It remains a non-error result so no downstream hook mistakes internal
 * bookkeeping for a real tool failure.
 */
const DEDUP_PLACEHOLDER_RESULT: ExecutableToolResult = { output: '' };

const FILE_MUTATING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
/** Tools that mutate state — Storm Breaker only suppresses these. */
const MUTATING_TOOLS = new Set([...FILE_MUTATING_TOOLS, 'Bash']);

const EXACT_MUTATION_STORM_THRESHOLD = 3;
const TARGET_MUTATION_STORM_THRESHOLD = 6;

interface ReadRange {
  readonly start: number;
  readonly end: number;
}

interface ReadRequest {
  readonly pathKey: string;
  readonly displayPath: string;
  readonly lineOffset: number;
  readonly count: number;
}

interface StormCall {
  readonly exactKey: string;
  readonly targetKey: string;
  readonly displayTarget: string;
}

interface ReadObservation {
  readonly range?: ReadRange | undefined;
  readonly totalLines: number;
}

interface ReadLedgerEntry {
  readonly ranges: readonly ReadRange[];
  readonly totalLines: number;
}

interface ReadInvalidation {
  readonly all: true;
}

interface ResolvedReadWindow {
  readonly range?: ReadRange | undefined;
  readonly knownEmpty: boolean;
}

function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

function toolPath(args: unknown): string | undefined {
  if (!isPlainRecord(args)) return undefined;
  const path = args['path'] ?? args['file_path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function expandHomePath(path: string, homeDir: string | undefined, pathClass: PathClass): string {
  if (homeDir === undefined) return path;
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || (pathClass === 'win32' && path.startsWith('~\\'))) {
    return `${homeDir}/${path.slice(2)}`;
  }
  return path;
}

function normalizedPathKey(
  path: string,
  cwd: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): string | undefined {
  try {
    const canonical = canonicalizePath(expandHomePath(path, homeDir, pathClass), cwd, pathClass);
    return pathClass === 'win32' ? canonical.toLowerCase() : canonical;
  } catch {
    return undefined;
  }
}

function readRequest(
  args: unknown,
  cwd: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): ReadRequest | undefined {
  if (!isPlainRecord(args)) return undefined;
  const path = toolPath(args);
  if (path === undefined) return undefined;

  const pathKey = normalizedPathKey(path, cwd, pathClass, homeDir);
  if (pathKey === undefined) return undefined;

  const rawOffset = args['line_offset'];
  const rawCount = args['n_lines'];
  const start = rawOffset === undefined ? 1 : rawOffset;
  const requestedCount = rawCount === undefined ? READ_MAX_LINES : rawCount;
  if (typeof start !== 'number' || typeof requestedCount !== 'number') return undefined;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedCount) ||
    start === 0 ||
    start < -READ_MAX_LINES ||
    requestedCount < 1
  ) {
    return undefined;
  }
  const count = Math.min(requestedCount, READ_MAX_LINES);
  return {
    pathKey,
    displayPath: path,
    lineOffset: start,
    count,
  };
}

function stormCall(
  toolName: string,
  args: unknown,
  exactKey: string,
  cwd: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): StormCall | undefined {
  if (!isMutatingTool(toolName)) return undefined;
  const path = FILE_MUTATING_TOOLS.has(toolName) ? toolPath(args) : undefined;
  const pathKey =
    path === undefined ? undefined : normalizedPathKey(path, cwd, pathClass, homeDir);
  return {
    exactKey,
    targetKey: pathKey === undefined ? exactKey : `file ${pathKey}`,
    displayTarget: path ?? canonicalDedupArgs(args),
  };
}

function outputText(result: ExecutableToolResult): string {
  if (typeof result.output === 'string') return result.output;
  return result.output
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

function successfulReadObservation(result: ExecutableToolResult): ReadObservation | undefined {
  if (result.isError === true) return undefined;
  const statusMatch = /<system>([^<>]*)<\/system>\s*$/.exec(outputText(result));
  if (statusMatch === null) return undefined;
  const status = statusMatch[1]!;
  const totalMatch = /(?:^|\s)Total lines in file: (\d+)\./.exec(status);
  if (totalMatch === null) return undefined;
  const totalLines = Number(totalMatch[1]);
  if (!Number.isSafeInteger(totalLines) || totalLines < 0) return undefined;

  const rangeMatch = /(?:^|\s)(\d+) lines? read from file starting from line (\d+)\./.exec(status);
  if (rangeMatch === null) {
    return /(?:^|\s)No lines read from file\./.test(status)
      ? { totalLines }
      : undefined;
  }
  const count = Number(rangeMatch[1]);
  const start = Number(rangeMatch[2]);
  if (
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(start) ||
    count < 1 ||
    start < 1 ||
    start + count - 1 > totalLines
  ) {
    return undefined;
  }
  return { range: { start, end: start + count - 1 }, totalLines };
}

function resolveReadWindow(
  request: ReadRequest,
  totalLines: number | undefined,
): ResolvedReadWindow | undefined {
  let start: number;
  if (request.lineOffset < 0) {
    if (totalLines === undefined) return undefined;
    start = Math.max(1, totalLines - Math.abs(request.lineOffset) + 1);
  } else {
    start = request.lineOffset;
  }

  let end = start + request.count - 1;
  if (totalLines !== undefined) end = Math.min(end, totalLines);
  if (end < start) return { knownEmpty: true };
  return { knownEmpty: false, range: { start, end } };
}

function isRangeCovered(ranges: readonly ReadRange[], requested: ReadRange): boolean {
  let next = requested.start;
  for (const range of ranges) {
    if (range.end < next) continue;
    if (range.start > next) return false;
    next = Math.max(next, range.end + 1);
    if (next > requested.end) return true;
  }
  return false;
}

function mergeReadRange(ranges: readonly ReadRange[], incoming: ReadRange): ReadRange[] {
  const merged: ReadRange[] = [];
  let current = incoming;
  for (const range of ranges) {
    if (range.end + 1 < current.start) {
      merged.push(range);
    } else if (current.end + 1 < range.start) {
      merged.push(current);
      current = range;
    } else {
      current = {
        start: Math.min(current.start, range.start),
        end: Math.max(current.end, range.end),
      };
    }
  }
  merged.push(current);
  return merged;
}

function coveredReadWindow(
  entry: ReadLedgerEntry,
  request: ReadRequest,
): ResolvedReadWindow | undefined {
  const window = resolveReadWindow(request, entry.totalLines);
  if (window === undefined) return undefined;
  if (window.knownEmpty) return window;
  return window.range !== undefined && isRangeCovered(entry.ranges, window.range)
    ? window
    : undefined;
}

function readInvalidation(accesses: ToolAccesses | undefined): ReadInvalidation | undefined {
  if (accesses === undefined) return { all: true };
  for (const access of accesses) {
    if (access.kind === 'all') return { all: true };
    if (access.operation === 'write' || access.operation === 'readwrite') {
      // Lexical paths cannot prove that two names are not symlink or hard-link
      // aliases. Clear all coverage rather than risk returning stale content.
      return { all: true };
    }
  }
  return undefined;
}

function readDedupKey(request: ReadRequest, globalGeneration: number): string {
  return (
    `Read ${canonicalDedupArgs({
      path: request.pathKey,
      line_offset: request.lineOffset,
      n_lines: request.count,
    })}` + `\0read-generation:${String(globalGeneration)}`
  );
}

function describeReadWindow(window: ResolvedReadWindow): string {
  if (window.knownEmpty) return 'the requested range beyond the known end of file';
  const range = window.range;
  return range === undefined
    ? 'the requested range'
    : `lines ${String(range.start)}-${String(range.end)}`;
}

/**
 * Detects and suppresses repetitive tool calls within a single turn.
 *
 * Four behaviours are layered:
 * - Same-step dedup: duplicate calls reuse the original result. Read identity
 *   uses lexical canonical paths, effective ranges, and a workspace mutation
 *   generation.
 * - Read coverage guard: a successful, model-visible Read records the actual
 *   interval returned. An authorized writer immediately isolates later reads
 *   from stale in-flight results; finalization removes all stored coverage even
 *   if the tool reports failure because paths can alias and failed commands can
 *   still have partial effects.
 *   Compaction clears coverage, while asynchronous workspace tasks disable the
 *   guard for the remainder of the turn.
 * - Cross-step dedup: when the exact same call is repeated consecutively
 *   across steps, the result returned to the model is suffixed with a system
 *   reminder at specific streak thresholds (3, 5, and 8) to nudge the model
 *   to try a different approach.
 * - Storm Breaker: within the last eight recognized mutation attempts, the
 *   third identical attempt or sixth attempt against one lexical canonical
 *   file is suppressed entirely and returned as an error result.
 */
export class ToolCallDeduplicator {
  private stepDeferreds = new Map<string, Deferred<ExecutableToolResult>>();
  private stepCalls: string[] = [];
  private originalCallIndex = new Map<string, number>();
  private syntheticCallIds = new Set<string>();
  private readonly finalizedResults = new Map<string, ExecutableToolResult>();
  /**
   * Records the dedup key used at `checkSameStep` time, keyed by `toolCallId`.
   * The loop is allowed to rewrite args between `prepareToolExecution` and
   * `finalizeToolResult` via `PrepareToolExecutionResult.updatedArgs`, so the
   * `(toolName, args)` pair available at finalize may differ from what was
   * registered. We pin the key at registration time and look it up by call id
   * during finalize.
   */
  private callKeyByCallId = new Map<string, string>();
  private consecutiveKey: string | null = null;
  private consecutiveCount = 0;
  private readCoverageDisabled = false;
  private readonly readCoverage = new Map<string, ReadLedgerEntry>();
  private globalReadGeneration = 0;
  private readonly pendingReadInvalidations = new Map<string, ReadInvalidation>();
  private stepReadInvalidations: ReadInvalidation[] = [];

  // Storm Breaker sliding window (persisted across steps within one turn).
  private stepStormCalls: StormCall[] = [];
  private readonly stormWindow: StormCall[] = [];
  private readonly stormWindowSize = 8;

  constructor(
    private readonly cwd = process.cwd(),
    private readonly pathClass: PathClass = process.platform === 'win32' ? 'win32' : 'posix',
    private readonly homeDir?: string,
  ) {}

  /**
   * Records the scheduler-level resources of an authorized execution. Epochs
   * change immediately so later reads in the same provider batch cannot reuse
   * a result from before the write. Finalization removes coverage regardless
   * of result status because failed commands can still have partial effects.
   */
  observeAuthorizedExecution(toolCallId: string, accesses: ToolAccesses | undefined): void {
    const invalidation = readInvalidation(accesses);
    if (invalidation === undefined) return;

    this.pendingReadInvalidations.set(toolCallId, invalidation);
    this.stepReadInvalidations.push(invalidation);
    this.globalReadGeneration += 1;
  }

  /** Clear guards when prior Read output may no longer be visible to the model. */
  clearReadCoverage(): void {
    this.readCoverage.clear();
    this.globalReadGeneration += 1;
  }

  /** Disable cross-step Read guards after asynchronous workspace side effects start. */
  disableReadCoverage(): void {
    if (this.readCoverageDisabled) return;
    this.clearReadCoverage();
    this.readCoverageDisabled = true;
  }

  beginStep(): void {
    for (const deferred of this.stepDeferreds.values()) {
      deferred.resolve({
        output: 'Tool call deduplicated but original result was lost',
        isError: true,
      });
    }
    this.stepDeferreds.clear();
    this.stepCalls = [];
    this.originalCallIndex.clear();
    this.syntheticCallIds.clear();
    this.finalizedResults.clear();
    this.callKeyByCallId.clear();
    this.pendingReadInvalidations.clear();
    this.stepReadInvalidations = [];
    this.stepStormCalls = [];
  }

  isSameStepDuplicate(toolCallId: string): boolean {
    return this.syntheticCallIds.has(toolCallId);
  }

  /** Save the result after post-tool validation so duplicates reuse it verbatim. */
  recordFinalResult(toolCallId: string, result: ExecutableToolResult): void {
    if (this.syntheticCallIds.has(toolCallId)) return;
    const key = this.callKeyByCallId.get(toolCallId);
    if (key !== undefined) this.finalizedResults.set(key, result);
  }

  finalResultForCall(
    toolCallId: string,
    fallback: ExecutableToolResult,
  ): ExecutableToolResult {
    const key = this.callKeyByCallId.get(toolCallId);
    return key === undefined ? fallback : (this.finalizedResults.get(key) ?? fallback);
  }

  endStep(): void {
    for (const key of this.stepCalls) {
      if (key === this.consecutiveKey) {
        this.consecutiveCount += 1;
      } else {
        this.consecutiveKey = key;
        this.consecutiveCount = 1;
      }
    }

    // Storm Breaker: record mutating calls in the sliding window.
    for (const call of this.stepStormCalls) {
      this.stormWindow.push(call);
      if (this.stormWindow.length > this.stormWindowSize) {
        this.stormWindow.shift();
      }
    }
  }

  /**
   * Called from `prepareToolExecution`. A same-step duplicate returns a
   * placeholder whose real result is patched in during `finalizeResult`.
   * Coverage and storm guards return explanatory synthetic errors. Otherwise
   * the call is registered and `null` lets normal execution proceed.
   *
   * This method is intentionally synchronous to avoid deadlocking the prepare
   * loop on a deferred that only resolves in the finalize phase.
   */
  checkSameStep(toolCallId: string, toolName: string, args: unknown): ExecutableToolResult | null {
    const exactKey = makeKey(toolName, args);
    const request =
      toolName === 'Read'
        ? readRequest(args, this.cwd, this.pathClass, this.homeDir)
        : undefined;
    const key =
      request === undefined
        ? exactKey
        : readDedupKey(request, this.globalReadGeneration);

    const existing = this.stepDeferreds.get(key);
    if (existing !== undefined) {
      this.stepCalls.push(key);
      this.callKeyByCallId.set(toolCallId, key);
      this.syntheticCallIds.add(toolCallId);
      return DEDUP_PLACEHOLDER_RESULT;
    }

    if (request !== undefined && !this.readCoverageDisabled) {
      const mayHaveChanged = this.stepReadInvalidations.length > 0;
      const entry = mayHaveChanged ? undefined : this.readCoverage.get(request.pathKey);
      const covered = entry === undefined ? undefined : coveredReadWindow(entry, request);
      if (covered !== undefined) {
        return {
          output:
            `Read coverage guard: ${request.displayPath} ${describeReadWindow(covered)} ` +
            'was already read successfully in this turn. Reuse the earlier result or request an uncovered range.',
          isError: true,
        };
      }
    }

    // Storm Breaker: suppress repetitive mutating calls before execution.
    const candidateStormCall = stormCall(
      toolName,
      args,
      exactKey,
      this.cwd,
      this.pathClass,
      this.homeDir,
    );
    if (candidateStormCall !== undefined) {
      const priorCalls = [...this.stormWindow, ...this.stepStormCalls].slice(
        -this.stormWindowSize,
      );
      const exactCount = priorCalls.filter((call) => call.exactKey === exactKey).length;
      if (exactCount >= EXACT_MUTATION_STORM_THRESHOLD - 1) {
        return {
          output:
            `Storm Breaker: ${toolName} was called with identical arguments ${String(exactCount + 1)} times. ` +
            'Inspect the previous result and choose a different action.',
          isError: true,
        };
      }
      const targetCount = priorCalls.filter(
        (call) => call.targetKey === candidateStormCall.targetKey,
      ).length;
      if (targetCount >= TARGET_MUTATION_STORM_THRESHOLD - 1) {
        return {
          output:
            `Storm Breaker: ${candidateStormCall.displayTarget} already had ${String(targetCount)} mutation attempts in the recent window. ` +
            'Re-read only the unresolved section, identify a concrete remaining defect, or finish if validation already passed.',
          isError: true,
        };
      }
    }

    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);

    this.stepDeferreds.set(key, makeDeferred<ExecutableToolResult>());
    this.originalCallIndex.set(toolCallId, index);
    if (candidateStormCall !== undefined) this.stepStormCalls.push(candidateStormCall);
    return null;
  }

  /**
   * Called from `finalizeToolResult`, in provider order. For first-occurrence
   * calls, projects the consecutive streak ending at this call and, if the
   * threshold is reached, appends the system reminder, then resolves the
   * deferred so subsequent same-step dups can fetch the real result. For
   * synthetic duplicates, awaits the original's deferred and returns its
   * value, discarding the placeholder.
   */
  async finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    const invalidation = this.pendingReadInvalidations.get(toolCallId);
    this.pendingReadInvalidations.delete(toolCallId);

    // Use the key recorded at registration time, NOT a fresh key from the args
    // passed here — the loop may have rewritten args via updatedArgs.
    const key = this.callKeyByCallId.get(toolCallId);
    if (key === undefined) return result;

    if (this.syntheticCallIds.has(toolCallId)) {
      const deferred = this.stepDeferreds.get(key);
      if (deferred === undefined) return result;
      return deferred.promise;
    }
    const index = this.originalCallIndex.get(toolCallId);
    if (index === undefined) return result;
    this.originalCallIndex.delete(toolCallId);

    let lastKey = this.consecutiveKey;
    let streak = this.consecutiveCount;
    for (let i = 0; i <= index; i += 1) {
      const k = this.stepCalls[i]!;
      if (k === lastKey) {
        streak += 1;
      } else {
        lastKey = k;
        streak = 1;
      }
    }

    let finalResult = result;
    if (streak === 3) {
      finalResult = appendReminder(result, REMINDER_TEXT_1);
    } else if (streak === 5 || streak === 8) {
      finalResult = appendReminder(result, makeReminderText2(toolName, streak, args));
    }

    this.recordToolProgress(toolName, args, result, finalResult, invalidation);
    this.stepDeferreds.get(key)?.resolve(finalResult);
    return finalResult;
  }

  private recordToolProgress(
    toolName: string,
    args: unknown,
    executionResult: ExecutableToolResult,
    persistedResult: ExecutableToolResult,
    invalidation: ReadInvalidation | undefined,
  ): void {
    if (invalidation !== undefined) this.applyReadInvalidation(invalidation);
    if (executionResult.isError === true) return;
    if (toolName === 'Read') {
      if (this.readCoverageDisabled) return;
      // Oversized results are truncated before reaching conversation history;
      // blocking a reread would leave the model without the omitted content.
      if (estimateTokens(outputText(persistedResult)) > MAX_TOOL_RESULT_TOKENS) return;
      const request = readRequest(args, this.cwd, this.pathClass, this.homeDir);
      const observation = successfulReadObservation(executionResult);
      if (request === undefined || observation === undefined) return;
      const previous = this.readCoverage.get(request.pathKey);
      const priorRanges =
        previous?.totalLines === observation.totalLines ? previous.ranges : [];
      const ranges =
        observation.range === undefined
          ? [...priorRanges]
          : mergeReadRange(priorRanges, observation.range);
      this.readCoverage.set(request.pathKey, {
        ranges,
        totalLines: observation.totalLines,
      });
    }
  }

  private applyReadInvalidation(invalidation: ReadInvalidation): void {
    if (invalidation.all) this.readCoverage.clear();
  }
}

export const __testing = {
  REMINDER_TEXT_1,
  makeReminderText2,
};
