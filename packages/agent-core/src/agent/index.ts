import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import { ErrorCodes, LmcodeError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type {
  AgentAPI,
  AgentEvent,
  LmcodeConfig,
  RPCOperationOptions,
  SDKAgentRPC,
  UsageStatus,
} from '#/rpc';
import {
  generate,
  type ChatProvider,
  type Message,
  type Tool,
} from '@lmcode-cli/ltod';

import type { EnabledPluginSessionStart } from '#/plugin';

import type { McpConnectionManager } from '../mcp';
import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../profile';
import { SESSION_CONTEXT_TEMPLATE } from '../profile/default';
import { buildTemplateVars } from '../profile/resolve';
import type { SystemPromptContext } from '../profile/types';
import { renderPrompt } from '../utils/render-prompt';
import { linkAbortSignal } from '../utils/abort';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import type { SkillRegistry } from '../skill';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../utils/tokens';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager } from './background';
import { FullCompaction, MicroCompaction, type CompactionStrategy } from './compaction';
import { CronManager } from './cron';
import { ConfigState } from './config';
import { ContextMemory } from './context';
import { GoalMode } from './goal';
import { HookEngine } from '../session/hooks';
import { InjectionManager } from './injection/manager';
import { DreamTracker, EXIT_EXTRACTION_SYSTEM_PROMPT, MemoryMemoStore, buildExitExtractionPrompt, createFastEmbedEngine, parseMemoryMemos } from '@lmcode/memory';
import { PermissionManager, type PermissionManagerOptions } from './permission';
import { PlanMode } from './plan';
import { WolfPackMode } from './wolfpack';
import { SessionMemory } from './session-memory';
import { WorkingSet } from './working-set';
import {
  AgentRecords,
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
} from './records';
import { ReplayBuilder } from './replay';
import { SkillManager } from './skill';
import { ToolManager } from './tool/index';
import { TurnFlow } from './turn';
import {
  GENERATE_REQUEST_LOG_CONTEXT,
  LtodLLM,
  type GenerateOptionsWithRequestLog,
} from './turn/ltod-llm';
import { UsageRecorder } from './usage';
import { resolveCompletionBudget } from '../utils/completion-budget';
import type { Jian } from '@lmcode-cli/jian';
import type { ToolServices } from '../tools/support/services';

export type { AgentRecord, AgentRecordPersistence } from './records';
export type { BuiltinTool, ToolInfo, ToolSource, UserToolRegistration } from './tool';

export type AgentType = 'main' | 'sub' | 'independent';

const SIDE_QUESTION_SYSTEM =
  'You are a helpful coding assistant answering a quick side question. The user is in the middle of a coding session and needs a fast, concise answer. Keep your response short and focused — this is a side question, not the main task.';

const EXIT_MEMORY_CLOSE_GRACE_MS = 1_000;

interface ExitMemoryExtraction {
  readonly abortController: AbortController;
  promise: Promise<void>;
  writingMemo: boolean;
}

export interface AgentOptions {
  readonly jian: Jian;
  readonly config?: LmcodeConfig;
  readonly homedir?: string;
  readonly lmcodeHomeDir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly persistence?: AgentRecordPersistence;
  readonly type?: AgentType;
  readonly generate?: typeof generate;
  readonly toolServices?: ToolServices;
  readonly compactionStrategy?: CompactionStrategy;
  readonly modelProvider?: ModelProvider | undefined;
  readonly subagentHost?: SessionSubagentHost | undefined;
  readonly skills?: SkillRegistry;
  readonly mcp?: McpConnectionManager;
  readonly hookEngine?: HookEngine;
  readonly permission?: PermissionManagerOptions | undefined;
  readonly log?: Logger;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
}

export class Agent {
  readonly type: AgentType;
  readonly jian: Jian;
  readonly lmcodeConfig?: LmcodeConfig;
  readonly homedir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly toolServices?: ToolServices;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider;
  readonly subagentHost?: SessionSubagentHost;
  readonly mcp?: McpConnectionManager;
  readonly hooks?: HookEngine;
  readonly log: Logger;

  readonly blobStore: BlobStore | undefined;
  readonly records: AgentRecords;
  readonly fullCompaction: FullCompaction;
  readonly microCompaction: MicroCompaction;
  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly injection: InjectionManager;
  readonly permission: PermissionManager;
  readonly planMode: PlanMode;
  readonly wolfpackMode: WolfPackMode;
  readonly usage: UsageRecorder;
  readonly skills: SkillManager | null;
  readonly tools: ToolManager;
  readonly background: BackgroundManager;
  readonly cron: CronManager | null;
  readonly goal: GoalMode;
  readonly memoStore: MemoryMemoStore | undefined;
  readonly sessionMemory: SessionMemory;
  readonly workingSet: WorkingSet;
  readonly dreamTracker: DreamTracker;
  readonly replayBuilder: ReplayBuilder;

  private lastLlmConfigLogSignature?: string;
  private readonly memoStoreReady: Promise<void> | undefined;
  private exitMemoryExtraction: ExitMemoryExtraction | undefined;
  /**
   * History length at the last successful memory extraction. Idle and exit
   * extractions share this watermark so an unchanged history is never
   * re-extracted (which would re-store the same content under new ids).
   */
  private lastMemoryExtractionHistoryLength: number | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: AgentOptions) {
    this.type = options.type ?? 'main';
    this.jian = options.jian;
    this.lmcodeConfig = options.config;
    this.homedir = options.homedir;
    this.rpc = options.rpc;
    this.toolServices = options.toolServices;
    this.pluginSessionStarts = options.pluginSessionStarts ?? [];
    this.rawGenerate = options.generate ?? generate;
    this.modelProvider = options.modelProvider;
    this.subagentHost = options.subagentHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.log = options.log ?? log;

    this.blobStore = options.homedir
      ? new BlobStore({ blobsDir: join(options.homedir, 'blobs') })
      : undefined;
    this.records = new AgentRecords(
      this,
      options.persistence ??
        (options.homedir
          ? new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), {
              onError: (error) => {
                this.emitRecordsWriteError(error);
              },
              blobStore: this.blobStore,
            })
          : undefined),
    );
    this.fullCompaction = new FullCompaction(this, options.compactionStrategy);
    this.microCompaction = new MicroCompaction(this);
    this.context = new ContextMemory(this);
    this.config = new ConfigState(this);
    this.turn = new TurnFlow(this);
    this.injection = new InjectionManager(this);
    this.planMode = new PlanMode(this);
    this.wolfpackMode = new WolfPackMode(this);
    this.permission = new PermissionManager(this, options.permission);
    this.usage = new UsageRecorder(this);
    this.skills = options.skills ? new SkillManager(this, options.skills) : null;
    this.tools = new ToolManager(this);
    this.background = new BackgroundManager(this);
    this.cron = this.type === 'sub' ? null : new CronManager(this);
    this.goal = new GoalMode(this);
    // Use a global memory store shared across all sessions/workDirs.
    const lmcodeHomeDir = options.lmcodeHomeDir;
    this.memoStore = lmcodeHomeDir
      ? new MemoryMemoStore(lmcodeHomeDir)
      : undefined;
    if (this.memoStore !== undefined && lmcodeHomeDir !== undefined) {
      this.memoStoreReady = this.memoStore.init().then(
        () =>
          MemoryMemoStore.migrateLegacyStores(lmcodeHomeDir, this.memoStore).catch(
            (error: unknown) => {
              this.log.warn('legacy memory migration failed', { error });
            },
          ),
        (error: unknown) => {
          this.log.warn('memory store initialization failed', { error });
        },
      );
      // Attach embedding engine for semantic search. Best-effort — gracefully
      // degrades to keyword-only if fastembed fails to load.
      try {
        this.memoStore.setEmbeddingEngine(createFastEmbedEngine());
      } catch {
        // fastembed not available — keyword search still works.
      }
    } else {
      this.memoStoreReady = undefined;
    }
    this.sessionMemory = new SessionMemory();
    this.workingSet = new WorkingSet();
    this.dreamTracker = new DreamTracker(lmcodeHomeDir ?? '');
    // Start loading the persisted dream state immediately so the first
    // turn's step-1 check (which awaits the same promise) sees the real
    // counters instead of the defaults — without this a single-turn
    // session never surfaces the /dream suggestion. Main agents only:
    // subagents never surface the suggestion and share the same lock file.
    if (this.type === 'main') void this.dreamTracker.init();
    this.replayBuilder = new ReplayBuilder(this);
  }

  get generate(): typeof generate {
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      if (options?.auth !== undefined) {
        this.logLlmRequest(provider, systemPrompt, tools, history, options);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, options);
      }
      const modelAlias = this.config.modelAlias;
      const withAuth =
        modelAlias === undefined
          ? undefined
          : this.modelProvider?.resolveAuth?.(modelAlias, { log: this.log });
      if (withAuth === undefined) {
        this.logLlmRequest(provider, systemPrompt, tools, history, options);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, options);
      }
      return withAuth((auth) => {
        const requestOptions = { ...options, auth };
        this.logLlmRequest(provider, systemPrompt, tools, history, requestOptions);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, requestOptions);
      });
    };
  }

  get llm(): LtodLLM {
    const model = this.config.model;
    const provider = this.config.provider.withThinking(this.config.thinkingLevel);
    const loopControl = this.lmcodeConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new LtodLLM({
      provider,
      modelName: model,
      systemPrompt: this.config.systemPrompt,
      capability: this.config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
    });
  }

  private logLlmRequest(
    provider: ChatProvider,
    systemPrompt: string,
    tools: readonly Tool[],
    history: readonly Message[],
    options: Parameters<typeof generate>[5],
  ): void {
    const context = buildLlmRequestContext(options);
    const configMetadata = buildLlmConfigMetadata(
      provider,
      this.config.modelAlias,
      systemPrompt,
      tools,
    );
    this.logLlmConfigIfChanged(
      context,
      configMetadata,
      buildLlmConfigSignature(configMetadata, systemPrompt, tools),
    );

    let partialMessageCount = 0;
    for (const message of history) {
      if (message.partial === true) partialMessageCount += 1;
    }
    const requestMetadata: LlmRequestMetadata = {
      estimatedInputTokens:
        estimateTokens(systemPrompt) +
        estimateTokensForMessages(history) +
        estimateTokensForTools(tools),
    };
    if (partialMessageCount > 0) {
      requestMetadata.partialMessageCount = partialMessageCount;
    }
    this.log.info('llm request', {
      ...context,
      ...requestMetadata,
    });
  }

  private logLlmConfigIfChanged(
    context: LlmRequestContextFields,
    metadata: LlmConfigMetadata,
    signature: string,
  ): void {
    if (signature === this.lastLlmConfigLogSignature) return;
    this.lastLlmConfigLogSignature = signature;
    this.log.info('llm config', {
      ...context,
      ...metadata,
    });
  }

  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void {
    const promptContext: SystemPromptContext = {
      osEnv: this.jian.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
      agentsMdPaths: context?.agentsMdPaths,
    };
    const systemPrompt = profile.systemPrompt(promptContext);
    this.config.update({ profileName: profile.name, systemPrompt });
    this.tools.setActiveTools(profile.tools);

    // Inject session context as first user message to keep system prompt
    // byte-stable across sessions (DeepSeek prefix-cache optimization).
    // Dynamic content (date, cwd listing, AGENTS.md, skills) lives here
    // instead of the system prompt, so the system prompt prefix stays
    // cacheable across sessions.
    if (this.context.history.length === 0) {
      const vars = buildTemplateVars(promptContext, {});
      const sessionContext = renderPrompt(SESSION_CONTEXT_TEMPLATE, vars);
      this.context.appendSystemReminder(sessionContext, {
        kind: 'injection',
        variant: 'session_context',
      });
    }
  }

  async resume(): Promise<{ warning?: string }> {
    const result = await this.records.replay();
    this.goal.normalizeAfterReplay();
    await this.background.loadFromDisk();
    await this.background.reconcile();
    await this.cron?.loadFromDisk();
    this.turn.finishResume();
    return result;
  }

  get rpcMethods(): PromisableMethods<AgentAPI> {
    return {
      prompt: (payload) => {
        this.turn.prompt(payload.input);
      },
      steer: (payload) => {
        this.turn.steer(payload.input);
      },
      cancel: (payload) => {
        this.turn.cancel(payload.turnId);
      },
      setThinking: (payload) => {
        this.config.update({ thinkingLevel: payload.level });
      },
      setPermission: (payload) => {
        this.permission.setMode(payload.mode);
      },
      setModel: (payload) => {
        // Validate the alias resolves before recording it so resume / runtime
        // callers fail fast on missing aliases instead of deferring to the
        // next prompt.
        const resolved = this.modelProvider?.resolveProviderConfig(payload.model);
        if (this.config.modelAlias !== payload.model) {
          this.config.update({ modelAlias: payload.model });
        }
        return {
          model: payload.model,
          providerName: resolved?.providerName,
        };
      },
      getModel: () => {
        return this.config.modelAlias ?? '';
      },
      enterPlan: async () => {
        await this.planMode.enter();
      },
      enterWolfpack: () => {
        this.wolfpackMode.enter();
      },
      exitWolfpack: () => {
        this.wolfpackMode.exit();
      },
      cancelPlan: (payload) => {
        this.planMode.cancel(payload.id);
      },
      clearPlan: () => this.planMode.clear(),
      beginCompaction: (payload) => {
        this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
      },
      cancelCompaction: () => {
        this.fullCompaction.cancel();
      },
      registerTool: (payload) => {
        this.tools.registerUserTool(payload);
      },
      unregisterTool: (payload) => {
        this.tools.unregisterUserTool(payload.name);
      },
      setActiveTools: (payload) => {
        this.tools.setActiveTools(payload.names);
      },
      stopBackground: (payload) => {
        void this.background.stop(payload.taskId, payload.reason);
      },
      clearContext: () => {
        this.context.clear();
      },
      undoHistory: (payload) => {
        this.context.undo(payload.count);
      },
      activateSkill: (payload) => {
        if (this.skills === null) {
          throw new LmcodeError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.skills.activate(payload);
      },
      getBackgroundOutput: (payload) => this.background.readOutput(payload.taskId, payload.tail),
      getBackgroundOutputPath: (payload) => this.background.getOutputPath(payload.taskId),
      getContext: () => this.context.data(),
      getConfig: () => this.config.data(),
      getPermission: () => this.permission.data(),
      getPlan: () => this.planMode.data(),
      getUsage: () => this.usage.data(),
      getStats: () => this.usage.stats(),
      getTools: () => this.tools.data(),
      getBackground: (payload) => this.background.list(payload.activeOnly ?? false, payload.limit),
      extractMemoriesOnExit: async (_payload, options?: RPCOperationOptions) => {
        await this.extractMemoriesOnExit(options?.signal);
      },
      sideQuestion: async (payload) => {
        const answer = await this.sideQuestion(payload.question);
        return { answer };
      },
      createGoal: async (payload) => {
        const snapshot = await this.goal.createGoal(
          {
            objective: payload.objective,
            completionCriterion: payload.completionCriterion,
            replace: payload.replace,
          },
          'user',
        );
        return snapshot;
      },
      updateGoalStatus: async (payload) => {
        const { status } = payload;
        if (status === 'complete') {
          return this.goal.markComplete({}, 'user');
        }
        if (status === 'blocked') {
          return this.goal.markBlocked({}, 'user');
        }
        if (status === 'paused') {
          return this.goal.pauseGoal({}, 'user');
        }
        // status === 'active'
        return this.goal.resumeGoal({}, 'user');
      },
      cancelGoal: async () => {
        return this.goal.cancelGoal('user');
      },
      getGoal: () => {
        return this.goal.getGoal();
      },
      setGoalBudget: async (payload) => {
        const { value, unit } = payload;
        let budgetLimits: import('./goal').GoalBudgetLimits;
        if (unit === 'turns') {
          budgetLimits = { turnBudget: value };
        } else if (unit === 'tokens') {
          budgetLimits = { tokenBudget: value };
        } else {
          let ms = value;
          if (unit === 'seconds') ms *= 1000;
          else if (unit === 'minutes') ms *= 60_000;
          else if (unit === 'hours') ms *= 3_600_000;
          budgetLimits = { wallClockBudgetMs: ms };
        }
        return this.goal.setBudgetLimits({ budgetLimits }, 'user');
      },
    };
  }

  /** Read session title from state.json (if available). */
  async getSessionTitle(): Promise<string | undefined> {
    if (!this.homedir) return undefined;
    const sessionDir = dirname(dirname(this.homedir));
    try {
      const text = await readFile(join(sessionDir, 'state.json'), 'utf-8');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed['title'] === 'string' && parsed['title'].length > 0) return parsed['title'];
      if (typeof parsed['customTitle'] === 'string' && parsed['customTitle'].length > 0) return parsed['customTitle'];
    } catch {
      // ignore — state.json may not exist
    }
    return undefined;
  }

  /** Extract memory memos from the full conversation history on session exit. */
  extractMemoriesOnExit(signal?: AbortSignal): Promise<void> {
    if (this.closing !== undefined) {
      return Promise.reject(new LmcodeError(ErrorCodes.SESSION_CLOSED, 'Agent is closed'));
    }

    const current = this.exitMemoryExtraction;
    if (current !== undefined) {
      if (signal === undefined) return current.promise;
      const unlinkAbortSignal = linkAbortSignal(signal, current.abortController);
      return current.promise.finally(unlinkAbortSignal);
    }

    const abortController = new AbortController();
    const unlinkAbortSignal =
      signal === undefined ? undefined : linkAbortSignal(signal, abortController);
    const active = {
      abortController,
      promise: Promise.resolve(),
      writingMemo: false,
    };
    this.exitMemoryExtraction = active;
    active.promise = Promise.resolve()
      .then(() => this.extractMemoriesOnExitWorker(active))
      .finally(() => {
        unlinkAbortSignal?.();
        if (this.exitMemoryExtraction === active) {
          this.exitMemoryExtraction = undefined;
        }
      });
    return active.promise;
  }

  private async extractMemoriesOnExitWorker(active: ExitMemoryExtraction): Promise<void> {
    const signal = active.abortController.signal;
    if (!this.memoStore) return;
    signal.throwIfAborted();
    await this.memoStore.init();
    signal.throwIfAborted();

    const history = this.context.history;
    if (history.length < 4) return; // Too short to contain meaningful task loops
    // History has not changed since the last extraction (e.g. idle timer
    // firing after an exit extraction already ran) — nothing new to learn.
    if (history.length === this.lastMemoryExtractionHistoryLength) return;

    // homedir = <projectDir>/<sessionId>/agents/<agentId>
    const sessionId = this.homedir
      ? basename(dirname(dirname(this.homedir)))
      : 'unknown';

    const sessionTitle = await this.getSessionTitle();
    signal.throwIfAborted();

    // Adaptive sampling: prioritize turns containing tool errors (pitfalls) and their surrounding context,
    // plus the latest 10 messages to keep the final output/summary.
    const recentCount = 10;
    const maxPitfallMessages = 20;

    const selectedIndices = new Set<number>();
    
    // 1. Always select the last 10 messages
    const startIndex = Math.max(0, history.length - recentCount);
    for (let i = startIndex; i < history.length; i++) {
      selectedIndices.add(i);
    }

    // 2. Identify and select errors along with their surrounding context (2 turns before and 2 turns after)
    const pitfallIndicesSet = new Set<number>();
    for (let i = 0; i < startIndex; i++) {
      const msg = history[i];
      if (msg !== undefined && msg.role === 'tool' && msg.isError === true) {
        const start = Math.max(0, i - 2);
        const end = Math.min(startIndex - 1, i + 2);
        for (let j = start; j <= end; j++) {
          pitfallIndicesSet.add(j);
        }
      }
    }

    // 3. Limit pitfall messages to prevent token budget overflow, keeping the newest ones
    const pitfallIndices = Array.from(pitfallIndicesSet).sort((a, b) => a - b);
    const keptPitfalls = pitfallIndices.slice(-maxPitfallMessages);

    // 4. Combine and sort selected message indices to preserve chronological order
    const finalIndices = [...keptPitfalls, ...Array.from(selectedIndices)].sort((a, b) => a - b);
    const sampleMessages = finalIndices.map(idx => history[idx]!);

    const sampleText = sampleMessages
      .map((m) => {
        const text = m.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
        return `[${m.role}] ${text.slice(0, 300)}`;
      })
      .join('\n');

    const userPrompt = buildExitExtractionPrompt(sessionId, history.length, sampleText);

    try {
      const response = await this.generate(
        this.config.utilityProvider,
        EXIT_EXTRACTION_SYSTEM_PROMPT,
        [], // no tools — extraction only
        [
          {
            role: 'user',
            content: [{ type: 'text', text: userPrompt }],
            toolCalls: [],
          },
        ],
        undefined,
        { signal },
      );
      signal.throwIfAborted();

      const summary = typeof response.message.content === 'string'
        ? response.message.content
        : response.message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

      const memos = parseMemoryMemos(summary);
      if (memos.length === 0) {
        this.lastMemoryExtractionHistoryLength = history.length;
        return;
      }

      const store = this.memoStore;
      let failed = 0;
      for (const memo of memos) {
        signal.throwIfAborted();
        memo.sourceSessionId = sessionId;
        memo.sourceSessionTitle = sessionTitle ?? '';
        memo.extractionSource = 'exit';
        memo.projectDir = this.config.cwd;
        active.writingMemo = true;
        try {
          await store.append(memo);
        } catch {
          failed += 1;
        } finally {
          active.writingMemo = false;
        }
      }
      if (failed > 0) {
        this.log.warn('Some memory memos failed to store from exit extraction', {
          failed,
          total: memos.length,
        });
      }

      this.log.info('Extracted memory memos on session exit', {
        count: memos.length,
        sessionId,
      });
      this.lastMemoryExtractionHistoryLength = history.length;
    } catch (error) {
      if (!signal.aborted) {
        this.log.warn('Exit memory extraction failed', { error: String(error) });
      }
    }
  }

  async sideQuestion(question: string): Promise<string> {
    const contextParts: string[] = [];
    let charBudget = 2000;

    for (let i = this.context.history.length - 1; i >= 0 && charBudget > 0; i--) {
      const msg = this.context.history[i];
      if (msg === undefined) continue;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (!text) continue;
      const snippet = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      contextParts.unshift(`[${msg.role}]: ${snippet}`);
      charBudget -= snippet.length;
    }

    const conversationContext = contextParts.join('\n\n');

    const system = conversationContext
      ? `${SIDE_QUESTION_SYSTEM}\n\n<conversation_context>\n${conversationContext}\n</conversation_context>`
      : SIDE_QUESTION_SYSTEM;

    const response = await this.generate(
      this.config.utilityProvider,
      system,
      [],
      [{ role: 'user', content: [{ type: 'text' as const, text: question }], toolCalls: [] }],
    );

    const text = response.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    return text || '(no response)';
  }

  /** Release resources held by this agent, including background workers. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const closing = Promise.resolve().then(() => this.closeInternal());
    this.closing = closing;
    return closing;
  }

  get isClosing(): boolean {
    return this.closing !== undefined;
  }

  private async closeInternal(): Promise<void> {
    const extraction = this.exitMemoryExtraction;
    extraction?.abortController.abort();
    try {
      // Stop the agent-owned CronManager first (idempotent). The normal
      // session close path already stops it; this covers agents torn down
      // via the createAgent error fallback, which would otherwise leak the
      // 1s tick interval and the SIGUSR1 hook for the process's lifetime.
      await this.cron?.stop();
    } finally {
      try {
        await this.fullCompaction.close();
      } finally {
        try {
          await this.settleExitMemoryExtractionForClose(extraction);
        } finally {
          try {
            await this.records.flush();
          } finally {
            try {
              await this.tools.close();
            } finally {
              await this.memoStoreReady;
              await this.memoStore?.close();
            }
          }
        }
      }
    }
  }

  private async settleExitMemoryExtractionForClose(
    extraction: ExitMemoryExtraction | undefined,
  ): Promise<void> {
    if (extraction === undefined) return;

    let resolveGrace!: () => void;
    const graceElapsed = new Promise<void>((resolve) => {
      resolveGrace = resolve;
    });
    const timeoutId = setTimeout(resolveGrace, EXIT_MEMORY_CLOSE_GRACE_MS);
    try {
      await Promise.race([extraction.promise.catch(() => {}), graceElapsed]);
    } finally {
      clearTimeout(timeoutId);
    }

    // Once abort is visible, a worker that is still inside provider generation
    // cannot enter the write phase. If it was already appending a memo, however,
    // keep the store alive until that local write has settled.
    if (extraction.writingMemo) {
      await extraction.promise.catch(() => {});
    }
  }

  emitEvent(event: AgentEvent): void {
    if (this.isClosing) return;
    if (this.records.restoring) return;
    void this.rpc?.emitEvent?.(event);
  }

  emitStatusUpdated(): void {
    if (this.isClosing) return;
    if (this.records.restoring) return;
    if (!this.config.hasModel) return;

    const contextTokens = this.context.tokenCount;
    const maxContextTokens = this.config.modelCapabilities.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usage: UsageStatus | undefined = this.usage.status();
    const model = this.config.model;

    this.emitEvent({
      type: 'agent.status.updated',
      model,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: this.planMode.isActive,
      permission: this.permission.mode,
      usage,
    });
  }

  private emitRecordsWriteError(error: unknown, record?: AgentRecord | undefined): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('wire record persist failed', {
      agentHomedir: this.homedir,
      recordType: record?.type,
      error,
    });
    this.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.RECORDS_WRITE_FAILED,
        `Failed to write agent records: ${message}`,
        {
          details: { recordType: record?.type },
        },
      ),
    });
  }
}

interface LlmRequestContextFields {
  turnStep?: string;
  attempt?: string;
}

interface LlmRequestMetadata {
  estimatedInputTokens: number;
  partialMessageCount?: number;
}

/**
 * Fields that identify an LLM configuration for deduplication.
 * Keep this interface simple and avoid dynamic keys — the shape is
 * serialized with `JSON.stringify` to produce a stable signature in
 * `logLlmConfigIfChanged`.
 */
interface LlmConfigMetadata {
  provider: string;
  model: string;
  modelAlias?: string;
  thinkingEffort?: string;
  systemPromptChars: number;
  /** SHA-256 prefix (12 hex chars) for cross-session cache stability diagnostics. */
  systemPromptHash: string;
  toolCount: number;
}

function buildLlmRequestContext(options: Parameters<typeof generate>[5]): LlmRequestContextFields {
  const context = requestLogContext(options);
  if (context === undefined) return {};

  const fields: LlmRequestContextFields = {
    turnStep:
      context.turnId === undefined || context.step === undefined
        ? undefined
        : `${context.turnId}.${String(context.step)}`,
  };
  if (
    context.attempt !== undefined &&
    context.maxAttempts !== undefined &&
    context.attempt > 1
  ) {
    fields.attempt = `${String(context.attempt)}/${String(context.maxAttempts)}`;
  }
  return fields;
}

function buildLlmConfigMetadata(
  provider: ChatProvider,
  modelAlias: string | undefined,
  systemPrompt: string,
  tools: readonly Tool[],
): LlmConfigMetadata {
  return {
    provider: provider.name,
    model: provider.modelName,
    modelAlias,
    thinkingEffort: provider.thinkingEffort ?? undefined,
    systemPromptChars: systemPrompt.length,
    systemPromptHash: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12),
    toolCount: tools.length,
  };
}

function buildLlmConfigSignature(
  metadata: LlmConfigMetadata,
  systemPrompt: string,
  tools: readonly Tool[],
): string {
  const toolsForSignature = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return JSON.stringify({
    ...metadata,
    systemPromptHash: fingerprint(systemPrompt),
    toolsHash: fingerprint(JSON.stringify(toolsForSignature)),
  });
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function requestLogContext(options: Parameters<typeof generate>[5]) {
  return (options as GenerateOptionsWithRequestLog | undefined)?.[GENERATE_REQUEST_LOG_CONTEXT];
}
