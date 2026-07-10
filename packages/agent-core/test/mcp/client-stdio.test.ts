import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import { LmcodeError } from '../../src/errors';
import { StdioMcpClient } from '../../src/mcp/client-stdio';

const here = import.meta.dirname;
const fixture = join(here, 'fixtures', 'mock-stdio-server.mjs');
const stderrThenExitFixture = join(here, 'fixtures', 'stderr-then-exit-stdio-server.mjs');
const crashAfterConnectFixture = join(here, 'fixtures', 'crash-after-connect-stdio-server.mjs');

describe('StdioMcpClient', () => {
  it('rejects unsupported executor at construction time', () => {
    expect(
      () =>
        new StdioMcpClient({
          transport: 'stdio',
          command: 'true',
          executor: 'jian',
        }),
    ).toThrow(
      expect.objectContaining({ name: 'LmcodeError', code: 'not_implemented' }) as unknown as Error,
    );
    // Sanity-check the error class identity too.
    let thrown: unknown;
    try {
      const client = new StdioMcpClient({ transport: 'stdio', command: 'true', executor: 'jian' });
      void client;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LmcodeError);
  });

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(['boom', 'echo', 'read_env']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { LMCODE_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'LMCODE_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards allowlisted env vars; config.env overrides on conflict', async () => {
    // Use TERM prefix which is in the allowlist.
    const parentOnly = `TERM_LMCODE_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `TERM_LMCODE_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('does not forward non-allowlisted env vars', async () => {
    const secret = `LMCODE_TEST_SECRET_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[secret] = 'should-not-leak';
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: secret });
      expect(result.content).toEqual([{ type: 'text', text: '' }]);
    } finally {
      delete process.env[secret];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `lmcode-test-stderr-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { LMCODE_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      // Even when connect fails, the buffered stderr must be retrievable so
      // higher layers can include it in the user-facing error message.
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      // Confirm the buffer cap is documented and finite (4 KB is plenty for a
      // useful tail). The exact value is an implementation detail but
      // exposing it for tests prevents unbounded growth from regressing.
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `lmcode-test-crash-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { LMCODE_TEST_MCP_EXIT_AFTER_MS: '50', LMCODE_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ stderr: reason.stderr, error: reason.error?.message });
    });
    try {
      await client.connect();
      // Wait for the child to exit and onclose to fire.
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `lmcode-test-early-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { LMCODE_TEST_MCP_STDERR: banner, LMCODE_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      // Drive the child to exit AFTER a successful tool response. The fixture
      // schedules `process.exit` via setImmediate so the reply is fully
      // flushed before the pipe closes; this exercises the post-handshake
      // disconnect path with no startup-timing race.
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      // Wait deterministically for the child to actually exit. The fixture
      // writes `banner\n` to stderr sync-before `process.exit`, so observing
      // the banner is proof the exit syscall has been issued.
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);
      // Drain probe: send a fresh request that the dead transport must
      // reject. Once it does, we know the SDK has processed `_onclose`,
      // which means our hook has already populated `pendingUnexpectedClose`.
      // This is what gives us a buffer to replay — registering the listener
      // first would intercept the close as a live fire instead.
      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch {
          transportConfirmedDead = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);
      // `pendingUnexpectedClose` is set; registering the listener must
      // invoke it synchronously inside the call.
      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onUnexpectedClose((reason) => {
        syncedOnRegister = true;
        received = { stderr: reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    // Give any pending onclose listener a chance to fire so we are sure it is
    // suppressed and not merely racing.
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);
});

// Unit tests for the command adaptation live in test/utils/spawn-command.test.ts
// (the adapter is shared with the LSP client).

describe('StdioMcpClient — Windows .cmd shim', () => {
  // Regression: without the cmd.exe /c adaptation, spawning a .cmd shim (how
  // npx/npm launch MCP servers) fails on Windows with `spawn ... ENOENT`.
  it.runIf(process.platform === 'win32')(
    'connects to a server launched via a .cmd shim',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lmcode-mcp-cmd-'));
      const cmdPath = join(dir, 'server.cmd');
      // A .cmd that launches the mock stdio server through node.
      writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
      const client = new StdioMcpClient({ transport: 'stdio', command: cmdPath });
      try {
        await client.connect();
        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
      } finally {
        await client.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );
});
