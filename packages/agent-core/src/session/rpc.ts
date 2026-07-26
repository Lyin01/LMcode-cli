import { ErrorCodes, LmcodeError } from '#/errors';
import type {
  ActivateSkillPayload,
  AgentAPI,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  EmptyPayload,
  GetBackgroundOutputPathPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  McpServerInfo,
  McpStartupMetrics,
  PromptPayload,
  ReconnectMcpServerPayload,
  AddMcpServerPayload,
  StopMcpServerPayload,
  RemoveMcpServerPayload,
  RenameSessionPayload,
  RPCOperationOptions,
  RegisterToolPayload,
  SessionAPI,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SkillSummary,
  SteerPayload,
  StopBackgroundPayload,
  SideQuestionPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
  CreateGoalPayload,
  CreateCronPayload,
  CronJobInfo,
  DeleteCronPayload,
  UpdateGoalStatusPayload,
  SetGoalBudgetPayload,
} from '#/rpc';
import type { PromisableMethods } from '#/utils/types';
import type { CronManager } from '#/agent/cron';
import { CronCreateInputSchema, CronCreateTool } from '#/tools/cron/cron-create';
import { cronToHuman, parseCronExpression } from '#/tools/cron/cron-expr';
import type { CronTask } from '#/tools/cron/types';

import type { Session, SessionMeta } from '.';
import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromSkill,
  titleFromPromptMetadataText,
} from './prompt-metadata';

type AgentScopedPayload<T> = T & { agentId: string };

export class SessionAPIImpl implements PromisableMethods<SessionAPI> {
  constructor(protected readonly session: Session) {}

  async renameSession(payload: RenameSessionPayload): Promise<void> {
    this.session.assertOpen();
    const title = payload.title.trim();
    if (title.length === 0) {
      throw new LmcodeError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    this.session.metadata = {
      ...this.session.metadata,
      title,
      isCustomTitle: true,
      updatedAt: new Date().toISOString(),
    };
    await this.session.writeMetadata();
  }

  async updateSessionMetadata(payload: UpdateSessionMetadataPayload): Promise<void> {
    this.session.assertOpen();
    this.session.metadata = {
      ...this.session.metadata,
      ...payload.metadata,
      agents: this.session.metadata.agents,
    };
    await this.session.writeMetadata();
  }

  getSessionMetadata(_payload: EmptyPayload): SessionMeta {
    this.session.assertOpen();
    return this.session.metadata;
  }

  listSkills(_payload: EmptyPayload): Promise<readonly SkillSummary[]> {
    this.session.assertOpen();
    return this.session.listSkills();
  }

  listMcpServers(_payload: EmptyPayload): readonly McpServerInfo[] {
    this.session.assertOpen();
    return this.session.mcp.list();
  }

  async getMcpStartupMetrics(_payload: EmptyPayload): Promise<McpStartupMetrics> {
    this.session.assertOpen();
    await this.session.mcp.waitForInitialLoad();
    this.session.assertOpen();
    return { durationMs: this.session.mcp.initialLoadDurationMs() };
  }

  async reconnectMcpServer(payload: ReconnectMcpServerPayload): Promise<void> {
    this.session.assertOpen();
    await this.session.mcp.reconnect(payload.name);
  }

  async addMcpServer(payload: AddMcpServerPayload): Promise<void> {
    this.session.assertOpen();
    await this.session.mcp.addServer(payload.name, payload.config);
  }

  async stopMcpServer(payload: StopMcpServerPayload): Promise<void> {
    this.session.assertOpen();
    await this.session.mcp.stopServer(payload.name);
  }

  async removeMcpServer(payload: RemoveMcpServerPayload): Promise<void> {
    this.session.assertOpen();
    await this.session.mcp.removeServer(payload.name);
  }

  generateAgentsMd(_payload: EmptyPayload): Promise<void> {
    this.session.assertOpen();
    return this.session.generateAgentsMd();
  }

  async createCron(payload: CreateCronPayload): Promise<CronJobInfo> {
    const manager = this.getCronManager();
    const parsedInput = CronCreateInputSchema.safeParse(payload);
    if (!parsedInput.success) {
      throw new LmcodeError(
        ErrorCodes.REQUEST_INVALID,
        parsedInput.error.issues[0]?.message ?? 'Invalid cron request',
      );
    }

    const execution = new CronCreateTool(manager).resolveExecution(parsedInput.data);
    if (!('execute' in execution)) {
      throw new LmcodeError(
        ErrorCodes.REQUEST_INVALID,
        typeof execution.output === 'string' ? execution.output : 'Cron request failed',
      );
    }
    const result = await execution.execute({
      turnId: 'rpc-cron-create',
      toolCallId: 'rpc-cron-create',
      signal: new AbortController().signal,
    });
    if (result.isError || typeof result.output !== 'string') {
      throw new LmcodeError(
        ErrorCodes.REQUEST_INVALID,
        typeof result.output === 'string' ? result.output : 'Cron request failed',
      );
    }

    const id = /^id: ([0-9a-f]{8})$/m.exec(result.output)?.[1];
    const task = id === undefined ? undefined : manager.store.get(id);
    if (task === undefined) {
      throw new LmcodeError(ErrorCodes.INTERNAL, 'Cron job was created without a readable record');
    }
    return projectCronJob(manager, task);
  }

  listCron(_payload: EmptyPayload): readonly CronJobInfo[] {
    const manager = this.getCronManager();
    return manager.store.list().map((task) => projectCronJob(manager, task));
  }

  deleteCron(payload: DeleteCronPayload): void {
    if (!/^[0-9a-f]{8}$/.test(payload.id)) {
      throw new LmcodeError(ErrorCodes.REQUEST_INVALID, 'Cron job id must be 8 lowercase hex characters');
    }
    const removed = this.getCronManager().removeTasks([payload.id]);
    if (removed.length === 0) {
      throw new LmcodeError(ErrorCodes.REQUEST_INVALID, `No cron job with id ${payload.id}`);
    }
  }

  async prompt({ agentId, ...payload }: AgentScopedPayload<PromptPayload>) {
    this.session.assertOpen();
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return this.getAgent(agentId).prompt(payload);
  }

  steer({ agentId, ...payload }: AgentScopedPayload<SteerPayload>) {
    return this.getAgent(agentId).steer(payload);
  }

  cancel({ agentId, ...payload }: AgentScopedPayload<CancelPayload>) {
    return this.getAgent(agentId).cancel(payload);
  }

  setModel({ agentId, ...payload }: AgentScopedPayload<SetModelPayload>) {
    return this.getAgent(agentId).setModel(payload);
  }

  setThinking({ agentId, ...payload }: AgentScopedPayload<SetThinkingPayload>) {
    return this.getAgent(agentId).setThinking(payload);
  }

  setPermission({ agentId, ...payload }: AgentScopedPayload<SetPermissionPayload>) {
    return this.getAgent(agentId).setPermission(payload);
  }

  getModel({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getModel(payload);
  }

  enterPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).enterPlan(payload);
  }

  cancelPlan({ agentId, ...payload }: AgentScopedPayload<CancelPlanPayload>) {
    return this.getAgent(agentId).cancelPlan(payload);
  }

  clearPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).clearPlan(payload);
  }

  enterWolfpack({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).enterWolfpack(payload);
  }

  exitWolfpack({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).exitWolfpack(payload);
  }

  beginCompaction({ agentId, ...payload }: AgentScopedPayload<BeginCompactionPayload>) {
    return this.getAgent(agentId).beginCompaction(payload);
  }

  cancelCompaction({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).cancelCompaction(payload);
  }

  registerTool({ agentId, ...payload }: AgentScopedPayload<RegisterToolPayload>) {
    return this.getAgent(agentId).registerTool(payload);
  }

  unregisterTool({ agentId, ...payload }: AgentScopedPayload<UnregisterToolPayload>) {
    return this.getAgent(agentId).unregisterTool(payload);
  }

  setActiveTools({ agentId, ...payload }: AgentScopedPayload<SetActiveToolsPayload>) {
    return this.getAgent(agentId).setActiveTools(payload);
  }

  stopBackground({ agentId, ...payload }: AgentScopedPayload<StopBackgroundPayload>) {
    return this.getAgent(agentId).stopBackground(payload);
  }

  clearContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).clearContext(payload);
  }

  undoHistory({ agentId, ...payload }: AgentScopedPayload<UndoHistoryPayload>) {
    return this.getAgent(agentId).undoHistory(payload);
  }

  async activateSkill({ agentId, ...payload }: AgentScopedPayload<ActivateSkillPayload>) {
    await this.getAgent(agentId).activateSkill(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
    }
  }

  getBackgroundOutput({ agentId, ...payload }: AgentScopedPayload<GetBackgroundOutputPayload>) {
    return this.getAgent(agentId).getBackgroundOutput(payload);
  }

  getBackgroundOutputPath({
    agentId,
    ...payload
  }: AgentScopedPayload<GetBackgroundOutputPathPayload>) {
    return this.getAgent(agentId).getBackgroundOutputPath(payload);
  }

  getContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getContext(payload);
  }

  getConfig({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getConfig(payload);
  }

  getPermission({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getPermission(payload);
  }

  getPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getPlan(payload);
  }

  getUsage({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getUsage(payload);
  }

  getStats({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getStats(payload);
  }

  getTools({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getTools(payload);
  }

  getBackground({ agentId, ...payload }: AgentScopedPayload<GetBackgroundPayload>) {
    return this.getAgent(agentId).getBackground(payload);
  }

  extractMemoriesOnExit(
    { agentId, ...payload }: AgentScopedPayload<EmptyPayload>,
    options?: RPCOperationOptions,
  ) {
    return this.getAgent(agentId).extractMemoriesOnExit(payload, options);
  }

  sideQuestion({ agentId, ...payload }: AgentScopedPayload<SideQuestionPayload>) {
    return this.getAgent(agentId).sideQuestion(payload);
  }

  createGoal({ agentId, ...payload }: AgentScopedPayload<CreateGoalPayload>) {
    return this.getAgent(agentId).createGoal(payload);
  }

  updateGoalStatus({ agentId, ...payload }: AgentScopedPayload<UpdateGoalStatusPayload>) {
    return this.getAgent(agentId).updateGoalStatus(payload);
  }

  cancelGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).cancelGoal(payload);
  }

  getGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getGoal(payload);
  }

  setGoalBudget({ agentId, ...payload }: AgentScopedPayload<SetGoalBudgetPayload>) {
    return this.getAgent(agentId).setGoalBudget(payload);
  }

  private getAgent(agentId: string): PromisableMethods<AgentAPI> {
    this.session.assertOpen();
    const agent = this.session.agents.get(agentId);
    if (agent === undefined) {
      throw new LmcodeError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found`);
    }
    return agent.rpcMethods;
  }

  private getCronManager(): CronManager {
    this.session.assertOpen();
    const manager = this.session.agents.get('main')?.cron;
    if (manager === null || manager === undefined) {
      throw new LmcodeError(ErrorCodes.NOT_IMPLEMENTED, 'Cron scheduling is unavailable');
    }
    return manager;
  }

  private needUpdateEasyTitle(metadata: SessionMeta): boolean {
    if (hasCustomTitle(metadata)) return false;
    if (!isUntitled(metadata.title)) return false;
    return true;
  }

  private async updatePromptMetadata(lastPrompt: string | undefined): Promise<void> {
    if (lastPrompt === undefined) return;
    this.session.assertOpen();

    const title = this.needUpdateEasyTitle(this.session.metadata)
      ? titleFromPromptMetadataText(lastPrompt)
      : undefined;
    const now = new Date().toISOString();
    const nextMetadata = {
      ...this.session.metadata,
      lastPrompt,
      updatedAt: now,
    };
    if (title !== undefined) {
      nextMetadata.title = title;
      nextMetadata.isCustomTitle = false;
    }

    this.session.metadata = nextMetadata;
    await this.session.writeMetadata();
    this.session.assertOpen();
    await this.session.rpc.emitEvent({
      type: 'session.meta.updated',
      agentId: 'main',
      title,
      patch: {
        title,
        isCustomTitle: title === undefined ? undefined : false,
        lastPrompt,
      },
    });
  }
}

function projectCronJob(manager: CronManager, task: CronTask): CronJobInfo {
  let humanSchedule = task.cron;
  try {
    humanSchedule = cronToHuman(parseCronExpression(task.cron));
  } catch {
    // Persisted legacy entries can be malformed; keep the raw expression visible.
  }
  return {
    id: task.id,
    cron: task.cron,
    humanSchedule,
    prompt: task.prompt,
    recurring: task.recurring !== false,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextFireAt: manager.getNextFireForTask(task.id),
    stale: manager.isStale(task),
  };
}

function isUntitled(title: unknown): boolean {
  return typeof title !== 'string' || title.trim().length === 0 || title === 'New Session';
}

function hasCustomTitle(metadata: SessionMeta): boolean {
  if (metadata.isCustomTitle) return true;
  return typeof (metadata as SessionMeta & { customTitle?: unknown }).customTitle === 'string';
}
