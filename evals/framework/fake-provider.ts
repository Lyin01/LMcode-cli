/**
 * Keyless fake provider for the smoke task.
 *
 * The `lmcode` provider type in `@lmcode-cli/ltod` talks to an OpenAI-compatible
 * Chat Completions endpoint via the `openai` SDK, pointed at `baseUrl`. So
 * instead of mocking `createProvider` (which only works under vitest), we stand
 * up a tiny local HTTP server that *speaks* that wire protocol and point a real
 * `lmcode` provider at it. This exercises the genuine SDK path — session →
 * provider-manager → ltod → openai client → HTTP — end to end, with no network
 * and no API key beyond a throwaway placeholder.
 *
 * The server returns a fixed assistant message as a streaming SSE response
 * (the provider defaults to `stream: true` and sets `include_usage`).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeProviderServer {
  /** Base URL to hand to the `lmcode` provider, e.g. `http://127.0.0.1:PORT/v1`. */
  readonly baseUrl: string;
  /** Number of chat-completions requests the server has handled. */
  readonly requestCount: () => number;
  /** Shut the server down. */
  readonly close: () => Promise<void>;
}

export interface FakeProviderOptions {
  /** Deterministic assistant text the fake model "generates". */
  readonly responseText: string;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Start a local OpenAI-compatible chat-completions server that streams a single
 * deterministic assistant message. Resolves once the server is listening.
 */
export async function startFakeProvider(
  options: FakeProviderOptions,
): Promise<FakeProviderServer> {
  let requests = 0;

  const server: Server = createServer((req, res) => {
    // Accept any path ending in /chat/completions so we don't depend on how the
    // openai client joins baseUrl + route.
    if (req.method !== 'POST' || !req.url || !req.url.endsWith('/chat/completions')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    // Drain the request body (we don't need it, but must consume it).
    req.resume();
    req.on('end', () => {
      requests += 1;
      const id = `fake-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // First chunk: the assistant text content.
      res.write(
        sseChunk({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'fake-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: options.responseText },
              finish_reason: null,
            },
          ],
        }),
      );

      // Final chunk: finish_reason + usage (provider requests include_usage).
      res.write(
        sseChunk({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'fake-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
          },
        }),
      );

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
