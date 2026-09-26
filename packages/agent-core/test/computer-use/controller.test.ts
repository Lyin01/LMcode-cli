import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import { ComputerUseController } from '../../src/computer-use/controller';
import { McpConnectionManager } from '../../src/mcp/connection-manager';

const here = import.meta.dirname;
const driverFixture = join(here, 'fixtures', 'cua-driver-mock.mjs');

/** The provider is configured to run the fixture through the real node binary. */
function controller(overrides: { exists?: (candidate: string) => boolean } = {}) {
  const mcp = new McpConnectionManager({ envLookup: () => undefined });
  const controller = new ComputerUseController({
    mcp,
    platform: 'linux',
    env: {},
    exists: overrides.exists ?? (() => false),
  });
  return { mcp, controller };
}

function activate(controller: ComputerUseController) {
  return controller.activate({ command: process.execPath, args: [driverFixture] });
}

/** Read the CUA_DRIVER_* environment the fixture process was launched with. */
async function permissionEnv(
  mcp: McpConnectionManager,
): Promise<{ mode: string | null; bypass: string | null }> {
  const client = mcp.resolved('cua-driver-mcp')?.client;
  if (client === undefined) throw new Error('provider client is missing');
  const result = (await client.callTool('permission_env', {})) as {
    content?: readonly { type?: unknown; text?: unknown }[];
  };
  const text = result.content?.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  return JSON.parse(String(text)) as { mode: string | null; bypass: string | null };
}

describe('ComputerUseController activation', () => {
  it('reserves the slot, connects the provider, and reports its tools', async () => {
    const { mcp, controller: subject } = controller();
    try {
      const status = await activate(subject);

      expect(status.phase).toBe('active');
      expect(status.providerId).toBe('cua-driver-mcp');
      expect(status.serverName).toBe('cua-driver-mcp');
      expect(status.toolCount).toBe(4);
      expect(subject.isActive()).toBe(true);
      expect(subject.providerName).toBe('cua-driver-mcp');

      const entry = mcp.get('cua-driver-mcp');
      expect(entry?.status).toBe('connected');
      expect(entry?.transport).toBe('stdio');
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('acknowledges unrestricted mode with the driver bypass variable', async () => {
    const { mcp, controller: subject } = controller();
    try {
      const status = await subject.activate({
        command: process.execPath,
        args: [driverFixture],
        permissionMode: 'unrestricted',
      });

      expect(status.phase).toBe('active');
      expect(status.permissionMode).toBe('unrestricted');
      // The driver refuses to serve unrestricted without this acknowledgement;
      // passing it is the whole difference between `active` and `failed` here.
      expect(await permissionEnv(mcp)).toEqual({ mode: 'unrestricted', bypass: '1' });
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('does not send the bypass acknowledgement in standard mode', async () => {
    const { mcp, controller: subject } = controller();
    try {
      await activate(subject);

      expect(await permissionEnv(mcp)).toEqual({ mode: 'standard', bypass: null });
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('is idempotent, so a repeated enable does not spawn a second driver', async () => {
    const { mcp, controller: subject } = controller();
    try {
      await activate(subject);
      const second = await activate(subject);

      expect(second.phase).toBe('active');
      expect(mcp.list()).toHaveLength(1);
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('releases the slot on deactivate and can be re-activated afterwards', async () => {
    const { mcp, controller: subject } = controller();
    try {
      await activate(subject);
      await subject.deactivate();

      expect(subject.isActive()).toBe(false);
      expect(subject.providerName).toBeUndefined();
      // The entry this capability created is gone, not left as a husk.
      expect(mcp.get('cua-driver-mcp')).toBeUndefined();
      expect(subject.status().phase).toBe('idle');

      const reactivated = await activate(subject);
      expect(reactivated.phase).toBe('active');
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('leaves the slot free when activation fails, so a retry is possible', async () => {
    const mcp = new McpConnectionManager({ envLookup: () => undefined });
    const subject = new ComputerUseController({ mcp, platform: 'linux', env: {}, exists: () => false });
    try {
      const failed = await subject.activate({
        command: process.execPath,
        args: [join(here, 'fixtures', 'does-not-exist.mjs')],
      });

      expect(failed.phase).toBe('failed');
      expect(subject.providerName).toBeUndefined();

      // Nothing is holding the slot, so the same controller can recover.
      const recovered = await activate(subject);
      expect(recovered.phase).toBe('active');
      expect(recovered.error).toBeUndefined();
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('reports an unknown provider as a failure instead of rejecting', async () => {
    const mcp = new McpConnectionManager({ envLookup: () => undefined });
    const subject = new ComputerUseController({ mcp, platform: 'linux', env: {}, exists: () => false });
    try {
      // A typo in `[computer_use] provider` must surface as a status the
      // settings card can render, not as an unhandled rejection.
      const status = await subject.activate({ providerId: 'not-a-provider' as never });

      expect(status.phase).toBe('failed');
      expect(status.error).toContain('not-a-provider');
      expect(subject.providerName).toBeUndefined();
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('clears a stale failure when the operator disables the capability', async () => {
    const mcp = new McpConnectionManager({ envLookup: () => undefined });
    const subject = new ComputerUseController({ mcp, platform: 'linux', env: {}, exists: () => false });
    try {
      await subject.activate({ command: 'cua-driver-not-installed' });
      expect(subject.status().phase).toBe('failed');

      await subject.deactivate();

      expect(subject.status().phase).toBe('idle');
      expect(subject.status().error).toBeUndefined();
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('names the install command when no driver is installed', async () => {
    const mcp = new McpConnectionManager({ envLookup: () => undefined });
    const subject = new ComputerUseController({ mcp, platform: 'linux', env: {}, exists: () => false });
    try {
      const status = await subject.activate({ command: 'cua-driver-not-installed' });

      expect(status.phase).toBe('failed');
      expect(status.error).toContain('Cua Driver');
      expect(status.error).toContain('install');
      expect(subject.providerName).toBeUndefined();
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });
});

describe('ComputerUseController ownership', () => {
  it('stops an operator-owned entry instead of deleting it', async () => {
    const { mcp, controller: subject } = controller();
    try {
      // A server of this name already exists because the operator put it in
      // mcp.json; the capability adopts it and must not remove their entry.
      await mcp.addServer('cua-driver-mcp', {
        transport: 'stdio',
        command: process.execPath,
        args: [driverFixture],
      });

      const status = await activate(subject);
      expect(status.phase).toBe('active');

      await subject.deactivate();

      const entry = mcp.get('cua-driver-mcp');
      expect(entry?.status).toBe('disabled');
      expect(subject.providerName).toBeUndefined();
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('refuses a second provider while one holds the slot', async () => {
    const { mcp, controller: subject } = controller();
    try {
      await activate(subject);

      let thrown: unknown;
      try {
        subject.providerRegistry.register('cua-driver-mcp');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('already registered');
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });

  it('reports a lost provider as failed while keeping the reservation', async () => {
    const { mcp, controller: subject } = controller();
    try {
      await activate(subject);

      // The fixture exits on this call, which is the provider-side failure the
      // capability has to notice without silently dropping its reservation.
      const client = mcp.resolved('cua-driver-mcp')?.client;
      expect(client).toBeDefined();
      await client?.callTool('disconnect', {});

      await expect
        .poll(() => subject.status().phase, { timeout: 10_000 })
        .toBe('failed');
      expect(subject.providerName).toBe('cua-driver-mcp');
    } finally {
      await subject.dispose();
      await mcp.shutdown();
    }
  });
});
