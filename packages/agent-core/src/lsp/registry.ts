import type { Jian } from '@lmcode-cli/jian';

import { LspClient } from './client';

export interface LspCommand {
  readonly command: string[];
  readonly languageId: string;
}

const LANGUAGE_SERVERS: Readonly<Record<string, LspCommand>> = {
  '.ts': { command: ['typescript-language-server', '--stdio'], languageId: 'typescript' },
  '.tsx': { command: ['typescript-language-server', '--stdio'], languageId: 'typescriptreact' },
  '.js': { command: ['typescript-language-server', '--stdio'], languageId: 'javascript' },
  '.jsx': { command: ['typescript-language-server', '--stdio'], languageId: 'javascriptreact' },
  '.py': { command: ['pyright-langserver', '--stdio'], languageId: 'python' },
  '.rs': { command: ['rust-analyzer'], languageId: 'rust' },
  '.go': { command: ['gopls'], languageId: 'go' },
};

interface StartingLspClient {
  readonly client: LspClient;
  readonly promise: Promise<LspClient>;
}

export class LspRegistry {
  private readonly clients = new Map<string, LspClient>();
  private readonly startingClients = new Map<string, StartingLspClient>();
  private stopped = false;

  constructor(private readonly jian: Jian) {}

  /**
   * Get or create an LSP client for the given file path and workspace root.
   * Returns undefined if the file type is not supported.
   */
  async getClient(path: string, workspaceRoot: string): Promise<LspClient | undefined> {
    if (this.stopped) throw new Error('LSP registry is stopped');
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const config = LANGUAGE_SERVERS[ext];
    if (config === undefined) return undefined;

    const physicalWorkspaceRoot = await this.resolveWorkspaceRoot(workspaceRoot);
    if (this.stopped) throw new Error('LSP registry is stopped');
    const key = `${physicalWorkspaceRoot}\0${config.command.join(' ')}`;
    const client = this.clients.get(key);
    if (client !== undefined) return client;

    const starting = this.startingClients.get(key);
    if (starting !== undefined) return starting.promise;

    const createdClient = new LspClient(config.command, physicalWorkspaceRoot, this.jian);
    const startPromise = createdClient
      .start()
      .then(() => {
        if (this.startingClients.get(key)?.client === createdClient) {
          this.clients.set(key, createdClient);
        }
        return createdClient;
      })
      .finally(() => {
        if (this.startingClients.get(key)?.client === createdClient) {
          this.startingClients.delete(key);
        }
      });
    this.startingClients.set(key, { client: createdClient, promise: startPromise });
    return startPromise;
  }

  languageIdForPath(path: string): string | undefined {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_SERVERS[ext]?.languageId;
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const clients = [...this.clients.values()];
    const startingClients = [...this.startingClients.values()];
    this.clients.clear();
    this.startingClients.clear();
    await Promise.allSettled([
      ...clients.map((client) => client.stop()),
      ...startingClients.flatMap(({ client, promise }) => [
        client.stop(),
        promise.then(() => undefined),
      ]),
    ]);
  }

  private async resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
    try {
      return await this.jian.realpath(workspaceRoot);
    } catch {
      return workspaceRoot;
    }
  }
}
