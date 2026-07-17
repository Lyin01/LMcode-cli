import type { Jian, JianProcess } from '@lmcode-cli/jian';

import { adaptSpawnCommandForWindows, platformFromOsKind } from '#/utils/spawn-command';

export interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface LspDiagnostic {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const SEVERITY_LABELS = ['Error', 'Warning', 'Information', 'Hint'];
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class LspClient {
  private process: JianProcess | undefined;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private collectedDiagnostics = new Map<string, LspDiagnostic[]>();
  private buffer = '';
  private contentLength = -1;
  private started = false;
  /** URIs currently open on the server, mapped to their last sync version. */
  private readonly openDocuments = new Map<string, number>();

  constructor(
    private readonly command: string[],
    private readonly workspaceRoot: string,
    private readonly jian: Jian,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.command.length === 0) {
      this.started = false;
      throw new Error('LSP command is empty');
    }

    // Language servers from npm (typescript-language-server, pyright) are
    // .cmd shims on Windows, which a shell-less spawn cannot execute — wrap
    // via cmd.exe /c. Platform comes from the jian's host OS, not the local
    // process: the server runs wherever the jian executes.
    const adapted = adaptSpawnCommandForWindows(
      this.command[0]!,
      this.command.slice(1),
      platformFromOsKind(this.jian.osEnv.osKind),
    );
    let spawnedProcess: JianProcess;
    try {
      spawnedProcess = await this.jian.exec(adapted.command, ...adapted.args);
    } catch (error) {
      this.started = false;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start language server ${this.command[0]}: ${message}`, {
        cause: error,
      });
    }

    // stop() may overtake an asynchronous spawn. Do not publish or initialize
    // a process that was launched for a client which teardown already stopped.
    if (!this.started) {
      try {
        await spawnedProcess.kill('SIGTERM');
      } catch {
        // The child may already have exited while startup was being cancelled.
      }
      throw new Error('LSP client stopped during startup');
    }
    this.process = spawnedProcess;

    spawnedProcess.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.processMessages();
    });

    spawnedProcess.stderr.on('data', (chunk: Buffer) => {
      // Ignore stderr noise from language servers.
      void chunk;
    });

    try {
      await this.request('initialize', {
        processId: process.pid,
        rootUri: pathToUri(this.workspaceRoot),
        capabilities: {},
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (!this.started) throw new Error('LSP client stopped during startup');
    this.notify('initialized', {});
  }

  async stop(): Promise<void> {
    this.started = false;
    this.openDocuments.clear();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('LSP client stopped'));
    }
    this.pending.clear();

    if (this.process === undefined) return;
    try {
      this.notify('shutdown', {});
      this.notify('exit', {});
      await this.process.kill('SIGTERM');
    } catch {
      // Already exited or not killable.
    }
    this.process = undefined;
  }

  didOpen(path: string, content: string, languageId: string): void {
    // The LSP forbids sending didOpen twice for the same document. Track
    // opened URIs and sync later reads with didChange + a bumped version,
    // so servers (e.g. pyright) don't see duplicate opens or stale text
    // after the file was edited between calls.
    const uri = pathToUri(path);
    const version = this.openDocuments.get(uri);
    if (version === undefined) {
      this.openDocuments.set(uri, 1);
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: content,
        },
      });
      return;
    }
    const next = version + 1;
    this.openDocuments.set(uri, next);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: next },
      // Full-document replacement (no range) — the servers we support all
      // accept TextDocumentSyncKind.Full.
      contentChanges: [{ text: content }],
    });
  }

  async references(
    path: string,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Promise<LspLocation[]> {
    const result = (await this.request('textDocument/references', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character },
      context: { includeDeclaration },
    })) as LspLocation[] | null;
    return result ?? [];
  }

  async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
    const result = (await this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character },
    })) as LspLocation | LspLocation[] | null;
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  }

  async diagnostics(path: string, timeoutMs = 5000): Promise<LspDiagnostic[]> {
    const uri = pathToUri(path);
    this.collectedDiagnostics.delete(uri);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const collected = this.collectedDiagnostics.get(uri);
      if (collected !== undefined) {
        return collected;
      }
      await sleep(100);
    }

    return this.collectedDiagnostics.get(uri) ?? [];
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: Omit<JsonRpcMessage, 'jsonrpc'>): void {
    if (this.process === undefined) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
    const data = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    this.process.stdin.write(data);
  }

  private processMessages(): void {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = this.buffer.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (match === null) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = Number(match[1]);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;
      const raw = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(raw) as JsonRpcMessage;
        this.handleMessage(message);
      } catch {
        // Ignore malformed messages.
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics' && message.params !== undefined) {
      const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.collectedDiagnostics.set(params.uri, params.diagnostics);
    }
  }
}

export function pathToUri(path: string): string {
  if (path.startsWith('file://')) return path;

  const windowsDriveMatch = /^([A-Za-z]):[\\/]/.exec(path);
  if (windowsDriveMatch !== null) {
    const drive = windowsDriveMatch[1]!.toUpperCase();
    const rest = path.slice(windowsDriveMatch[0].length).replaceAll('\\', '/');
    return `file:///${drive}:${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  const absolute = path.startsWith('/') ? path : `/${path}`;
  return `file://${absolute}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function formatLocation(location: LspLocation): string {
  const uri = location.uri.startsWith('file://') ? location.uri.slice(7) : location.uri;
  const { start } = location.range;
  return `- ${uri}:${start.line + 1}:${start.character + 1}`;
}

export function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const { start } = diagnostic.range;
  const severity =
    diagnostic.severity !== undefined ? SEVERITY_LABELS[diagnostic.severity - 1] ?? 'Unknown' : 'Diagnostic';
  return `- ${severity} at ${start.line + 1}:${start.character + 1}: ${diagnostic.message}`;
}
