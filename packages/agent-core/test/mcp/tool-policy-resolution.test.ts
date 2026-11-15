import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import { McpConnectionManager } from '../../src/mcp/connection-manager';

const here = import.meta.dirname;
const stdioFixture = join(here, 'fixtures', 'mock-stdio-server.mjs');

function stdioConfig(toolPolicy?: {
  readonly default?: 'allow' | 'ask' | 'blocked';
  readonly tools?: Record<string, 'allow' | 'ask' | 'blocked'>;
}) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args: [stdioFixture],
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
  };
}

describe('McpConnectionManager tool policy', () => {
  it('resolves per-tool overrides ahead of the server default', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        alpha: stdioConfig({ default: 'ask', tools: { boom: 'blocked' } }),
      });

      expect(cm.get('alpha')?.status).toBe('connected');
      expect(cm.resolveToolPolicy('mcp__alpha__echo')).toEqual({
        serverName: 'alpha',
        toolName: 'echo',
        mode: 'ask',
      });
      expect(cm.resolveToolPolicy('mcp__alpha__boom')?.mode).toBe('blocked');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('returns undefined for servers without a policy and for unknown tools', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({ plain: stdioConfig() });

      expect(cm.get('plain')?.toolPolicy).toBeUndefined();
      expect(cm.resolveToolPolicy('mcp__plain__echo')).toBeUndefined();
      expect(cm.resolveToolPolicy('mcp__plain__does_not_exist')).toBeUndefined();
      expect(cm.resolveToolPolicy('mcp__other__echo')).toBeUndefined();
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('replaces and clears a running server policy without reconnecting', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({ alpha: stdioConfig({ default: 'ask' }) });

      cm.setToolPolicy('alpha', { default: 'allow' });
      expect(cm.get('alpha')?.toolPolicy).toEqual({ default: 'allow' });
      expect(cm.resolveToolPolicy('mcp__alpha__echo')?.mode).toBe('allow');
      // Still connected — a policy edit must not tear the transport down.
      expect(cm.get('alpha')?.status).toBe('connected');

      cm.setToolPolicy('alpha', undefined);
      expect(cm.get('alpha')?.toolPolicy).toBeUndefined();
      expect(cm.resolveToolPolicy('mcp__alpha__echo')).toBeUndefined();
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('rejects unknown servers', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({});
      expect(() => cm.setToolPolicy('missing', { default: 'ask' })).toThrow(/Unknown MCP server/);
    } finally {
      await cm.shutdown();
    }
  }, 20000);
});
