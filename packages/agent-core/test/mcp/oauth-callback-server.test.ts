import { describe, expect, it } from 'vitest';

import { startCallbackServer } from '../../src/mcp/oauth/callback-server';

async function hitCallback(redirectUri: string, query: string): Promise<number> {
  const resp = await fetch(`${redirectUri}?${query}`);
  // Drain so the server can close cleanly.
  await resp.arrayBuffer();
  return resp.status;
}

describe('startCallbackServer', () => {
  it('resolves waitForCode when the callback arrives after waiting starts', async () => {
    const server = await startCallbackServer();
    try {
      const pending = server.waitForCode({ timeoutMs: 5000 });
      const status = await hitCallback(server.redirectUri, 'code=abc123&state=xyz');
      expect(status).toBe(200);
      await expect(pending).resolves.toEqual({ code: 'abc123', state: 'xyz' });
    } finally {
      await server.close();
    }
  });

  it('delivers a code that arrived BEFORE waitForCode was called', async () => {
    // beginAuthorization hands `complete()` to the caller, so the user (or an
    // auto-redirecting already-authorized flow) can hit the callback before
    // anyone is waiting. The code must be buffered, not dropped.
    const server = await startCallbackServer();
    try {
      const status = await hitCallback(server.redirectUri, 'code=early42&state=s1');
      expect(status).toBe(200);
      await expect(server.waitForCode({ timeoutMs: 1000 })).resolves.toEqual({
        code: 'early42',
        state: 's1',
      });
    } finally {
      await server.close();
    }
  });

  it('delivers an OAuth error that arrived before waitForCode was called', async () => {
    const server = await startCallbackServer();
    try {
      const status = await hitCallback(server.redirectUri, 'error=access_denied');
      expect(status).toBe(400);
      await expect(server.waitForCode({ timeoutMs: 1000 })).rejects.toThrow(
        /OAuth error: access_denied/,
      );
    } finally {
      await server.close();
    }
  });

  it('times out when no callback ever arrives', async () => {
    const server = await startCallbackServer();
    try {
      await expect(server.waitForCode({ timeoutMs: 50 })).rejects.toThrow(
        /OAuth callback timed out/,
      );
    } finally {
      await server.close();
    }
  });
});
