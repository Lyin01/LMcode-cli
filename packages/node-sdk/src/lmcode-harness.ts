import {
  ensureConfigFile,
  ErrorCodes,
  LmcodeError,
  getRootLogger,
  resolveConfigPath,
  resolveLmcodeHome,
  resolveLoggingConfig,
  type ExperimentalFlagMap,
} from '@lmcode-cli/agent-core';
import { assertLmcodeHostIdentity } from '@lmcode-cli/config';

import { LmcodeAuthFacade } from '#/auth';
import { SDKRpcClient } from '#/rpc';
import { Session } from '#/session';
import type {
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  LmcodeConfig,
  LmcodeConfigPatch,
  LmcodeHarnessOptions,
  LmcodeHostIdentity,
  ListSessionsOptions,
  RenameSessionInput,
  ResumeSessionInput,
  SessionSummary,
} from '#/types';

export class LmcodeHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: LmcodeAuthFacade;

  private readonly identity: LmcodeHostIdentity | undefined;
  private readonly uiMode: string;
  private readonly activeSessions = new Map<string, Session>();
  private readonly pendingSessionStarts = new Set<Promise<Session>>();
  private readonly pendingResumes = new Map<string, Promise<Session>>();
  private readonly rpc: SDKRpcClient;
  private closeRequested = false;
  private closing: Promise<void> | undefined;

  constructor(options: LmcodeHarnessOptions) {
    this.identity =
      options.identity === undefined ? undefined : assertLmcodeHostIdentity(options.identity);
    this.uiMode = options.uiMode ?? DEFAULT_SESSION_STARTED_UI_MODE;
    this.homeDir = resolveLmcodeHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.configureLogging();
    this.auth = new LmcodeAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
    });
    this.rpc = new SDKRpcClient({
      homeDir: options.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      resolveOAuthTokenProvider: this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
    });
  }

  private configureLogging(): void {
    // Fresh configure completes synchronously on the first-time path; pre-init
    // noop covers any caller that races before this returns.
    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));
  }

  get sessions(): ReadonlyMap<string, Session> {
    return this.activeSessions;
  }

  get interactiveAgentId(): string {
    return this.rpc.interactiveAgentId;
  }

  set interactiveAgentId(agentId: string) {
    this.rpc.interactiveAgentId = agentId;
  }


  async createSession(options: CreateSessionOptions): Promise<Session> {
    this.assertOpen();
    return this.trackSessionStart(this.createSessionInternal(options));
  }

  private async createSessionInternal(options: CreateSessionOptions): Promise<Session> {
    const { planMode, ...coreOptions } = options;
    const summary = await this.rpc.createSession(coreOptions);
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        if (this.activeSessions.get(summary.id) === session) {
          this.activeSessions.delete(summary.id);
        }
      },
    });
    this.activeSessions.set(session.id, session);
    await this.rejectStartedSessionIfClosing(session);
    if (planMode === true) {
      await session.setPlanMode(true);
      await this.rejectStartedSessionIfClosing(session);
    }
    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    this.assertOpen();
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    if (active !== undefined) return Promise.resolve(active);
    const pending = this.pendingResumes.get(id);
    if (pending !== undefined) return pending;

    const resuming = this.trackSessionStart(this.resumeSessionInternal(id));
    this.pendingResumes.set(id, resuming);
    void resuming.then(
      () => this.deletePendingResume(id, resuming),
      () => this.deletePendingResume(id, resuming),
    );
    return resuming;
  }

  private async resumeSessionInternal(id: string): Promise<Session> {
    const summary = await this.rpc.resumeSession({ id });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        if (this.activeSessions.get(summary.id) === session) {
          this.activeSessions.delete(summary.id);
        }
      },
    });
    this.activeSessions.set(session.id, session);
    await this.rejectStartedSessionIfClosing(session);
    return session;
  }

  async forkSession(input: ForkSessionInput): Promise<Session> {
    this.assertOpen();
    return this.trackSessionStart(this.forkSessionInternal(input));
  }

  private async forkSessionInternal(input: ForkSessionInput): Promise<Session> {
    const summary = await this.rpc.forkSession({
      id: normalizeSessionId(input.id),
      forkId: input.forkId,
      title: input.title,
      metadata: input.metadata,
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        if (this.activeSessions.get(summary.id) === session) {
          this.activeSessions.delete(summary.id);
        }
      },
    });
    this.activeSessions.set(session.id, session);
    await this.rejectStartedSessionIfClosing(session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.activeSessions.get(id);
  }

  async closeSession(id: string): Promise<void> {
    await this.activeSessions.get(id)?.close();
  }

  async deleteSession(id: string): Promise<void> {
    await this.rpc.deleteSession({ sessionId: id });
    this.activeSessions.delete(id);
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    await this.rpc.renameSession(input);
    this.activeSessions.get(input.id)?.emitMetaUpdated({ title: input.title });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const result = await this.rpc.exportSession({
      ...input,
      version: input.version ?? this.identity?.version,
    });
    return result;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return this.rpc.listSessions(options);
  }

  async getConfig(options: GetConfigOptions = {}): Promise<LmcodeConfig> {
    return this.rpc.getConfig(options);
  }

  /** Resolved enabled-state of every experimental flag (flag id → enabled). */
  async getExperimentalFlags(): Promise<ExperimentalFlagMap> {
    return this.rpc.getExperimentalFlags();
  }

  /** Validate host environment before starting the UI. */
  async preflight(): Promise<void> {
    await this.rpc.preflight();
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async setConfig(patch: LmcodeConfigPatch): Promise<LmcodeConfig> {
    return this.rpc.setConfig(patch);
  }

  async removeProvider(providerId: string): Promise<LmcodeConfig> {
    return this.rpc.removeProvider(providerId);
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closeRequested = true;
    const closing = this.closeInternal();
    this.closing = closing;
    return closing;
  }

  private async closeInternal(): Promise<void> {
    await Promise.allSettled(this.pendingSessionStarts);
    await Promise.all(Array.from(this.activeSessions.values(), (session) => session.close()));
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
  }

  private trackSessionStart(start: Promise<Session>): Promise<Session> {
    this.pendingSessionStarts.add(start);
    void start.then(
      () => this.pendingSessionStarts.delete(start),
      () => this.pendingSessionStarts.delete(start),
    );
    return start;
  }

  private deletePendingResume(id: string, expected: Promise<Session>): void {
    if (this.pendingResumes.get(id) === expected) {
      this.pendingResumes.delete(id);
    }
  }

  private async rejectStartedSessionIfClosing(session: Session): Promise<void> {
    if (!this.closeRequested) return;
    await session.close();
    throw new LmcodeError(ErrorCodes.SESSION_CLOSED, 'LmcodeHarness is closed');
  }

  private assertOpen(): void {
    if (this.closeRequested) {
      throw new LmcodeError(ErrorCodes.SESSION_CLOSED, 'LmcodeHarness is closed');
    }
  }

}

const DEFAULT_SESSION_STARTED_UI_MODE = 'shell';

function normalizeSessionId(value: string): string {
  if (typeof value !== 'string') {
    throw new LmcodeError(ErrorCodes.SESSION_ID_REQUIRED, 'Session id is required.');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new LmcodeError(ErrorCodes.SESSION_ID_EMPTY, 'Session id cannot be empty.');
  }
  return normalized;
}
