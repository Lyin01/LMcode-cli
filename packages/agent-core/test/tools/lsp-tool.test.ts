import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { LspClient, LspDiagnostic, LspLocation } from '../../src/lsp/client';
import { LspClient as RuntimeLspClient } from '../../src/lsp/client';
import { LspRegistry } from '../../src/lsp/registry';
import { LspInputSchema, LspTool } from '../../src/tools/builtin/lsp-tool';
import { testAgent } from '../agent/harness/agent';
import { createFakeJian, PERMISSIVE_WORKSPACE } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

function makeLspClient(overrides?: Partial<LspClient>): LspClient {
  return {
    didOpen: vi.fn(),
    references: vi.fn().mockResolvedValue([]),
    definition: vi.fn().mockResolvedValue([]),
    diagnostics: vi.fn().mockResolvedValue([]),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as LspClient;
}

function makeRegistry(client: LspClient | undefined, languageId = 'typescript'): LspRegistry {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    languageIdForPath: vi.fn().mockReturnValue(client === undefined ? undefined : languageId),
    stopAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as LspRegistry;
}

function makeAgent(overrides?: { readText?: (path: string) => Promise<string> }): Agent {
  return {
    jian: createFakeJian({
      readText: overrides?.readText ?? vi.fn().mockResolvedValue('const x = 1;'),
    }),
  } as unknown as Agent;
}

function context(args: Record<string, unknown>) {
  return { turnId: '0', toolCallId: 'call_lsp', args, signal };
}

describe('LspTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(makeLspClient()));

    expect(tool.name).toBe('LSP');
    expect(tool.description).toContain('language server');
    expect(tool.description).toContain('references');
    expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation: 'diagnostics' }).success).toBe(true);
    expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation: 'bad' }).success).toBe(false);
  });

  it('returns an error for unsupported file types', async () => {
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(undefined));

    const result = await executeTool(tool, context({ path: '/tmp/a.unknown', operation: 'diagnostics' }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('No language server configured');
  });

  it('opens the file and returns references', async () => {
    const locations: LspLocation[] = [
      { uri: 'file:///tmp/b.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ];
    const client = makeLspClient({ references: vi.fn().mockResolvedValue(locations) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({
      path: '/tmp/a.ts',
      operation: 'references',
      line: 2,
      character: 5,
      include_declaration: true,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1 reference');
    expect(result.output).toContain('/tmp/b.ts:1:1');
    expect(client.didOpen).toHaveBeenCalledWith('/tmp/a.ts', 'const x = 1;', 'typescript');
    expect(client.references).toHaveBeenCalledWith('/tmp/a.ts', 1, 5, true);
  });

  it('opens the file and returns definitions', async () => {
    const locations: LspLocation[] = [
      { uri: 'file:///tmp/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ];
    const client = makeLspClient({ definition: vi.fn().mockResolvedValue(locations) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({
      path: '/tmp/a.ts',
      operation: 'definition',
      line: 3,
      character: 10,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1 definition');
    expect(result.output).toContain('/tmp/a.ts:1:1');
    expect(client.definition).toHaveBeenCalledWith('/tmp/a.ts', 2, 10);
  });

  it('opens the file and returns diagnostics', async () => {
    const diagnostics: LspDiagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: 'Cannot find name',
      },
    ];
    const client = makeLspClient({ diagnostics: vi.fn().mockResolvedValue(diagnostics) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'diagnostics' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1 diagnostic');
    expect(result.output).toContain('Cannot find name');
  });

  it('returns an error when references/definition are missing line or character', async () => {
    const client = makeLspClient();
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const refs = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'references', line: 1 }));
    expect(refs.isError).toBe(true);
    expect(refs.output).toContain("'references' requires both");

    const def = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'definition', character: 0 }));
    expect(def.isError).toBe(true);
    expect(def.output).toContain("'definition' requires both");
  });
});

describe('LSP lifecycle', () => {
  it('coalesces concurrent startup for physical aliases of one workspace', async () => {
    const started = deferred<void>();
    const start = vi
      .spyOn(RuntimeLspClient.prototype, 'start')
      .mockImplementation(() => started.promise);
    const registry = new LspRegistry(
      createFakeJian({
        realpath: async (path) =>
          path === '/workspace-link' ? '/physical/workspace' : path,
      }),
    );

    const fromLink = registry.getClient('/physical/workspace/a.ts', '/workspace-link');
    const fromPhysical = registry.getClient(
      '/physical/workspace/b.ts',
      '/physical/workspace',
    );

    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    started.resolve();

    const [first, second] = await Promise.all([fromLink, fromPhysical]);
    expect(first).toBe(second);
  });

  it('kills a language server whose spawn finishes after stop overtakes startup', async () => {
    const spawned = deferred<{
      readonly stdin: PassThrough;
      readonly stdout: PassThrough;
      readonly stderr: PassThrough;
      readonly pid: number;
      readonly exitCode: null;
      readonly wait: () => Promise<number>;
      readonly kill: (signal?: NodeJS.Signals) => Promise<void>;
    }>();
    const kill = vi.fn(async () => {});
    const jian = createFakeJian({
      exec: vi.fn(() => spawned.promise),
    });
    const client = new RuntimeLspClient(
      ['typescript-language-server', '--stdio'],
      '/workspace',
      jian,
    );

    const starting = client.start();
    await client.stop();
    spawned.resolve({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 123,
      exitCode: null,
      wait: async () => 0,
      kill,
    });

    await expect(starting).rejects.toThrow('stopped during startup');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps one registry across tool refreshes and stops all clients on agent close', async () => {
    const ctx = testAgent();
    ctx.configure();
    const tools = ctx.agent.tools as unknown as { lspRegistry: LspRegistry };
    const registry = tools.lspRegistry;
    const clients = (registry as unknown as { clients: Map<string, LspClient> }).clients;
    const stop = vi.fn(async () => {});
    const failingStop = vi.fn(async () => {
      throw new Error('language server already exited');
    });
    clients.set('test-client', { stop } as unknown as LspClient);
    clients.set('failed-client', { stop: failingStop } as unknown as LspClient);

    ctx.agent.tools.initializeBuiltinTools();

    expect(tools.lspRegistry).toBe(registry);
    expect(clients.has('test-client')).toBe(true);

    await ctx.agent.close();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(failingStop).toHaveBeenCalledTimes(1);
    expect(clients.size).toBe(0);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
