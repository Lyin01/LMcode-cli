/**
 * Covers: LocalFetchURLProvider content-kind reporting.
 *
 * Verifies the provider tells callers whether the returned content is a
 * verbatim passthrough of the response body or the main text extracted
 * from an HTML page.
 */

import { describe, expect, it, vi } from 'vitest';
import { FetchCache } from '../../../src/tools/providers/fetch-cache';
import { LocalFetchURLProvider } from '../../../src/tools/providers/local-fetch-url';

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

function redirectResponse(location: string, status = 302): Response {
  // `Response.redirect()` forbids non-redirect status codes and constructs
  // an immutable Location header — build it directly so we control the body.
  return new Response('', { status, headers: { location } });
}

describe('LocalFetchURLProvider content kind', () => {
  it('reports text/plain bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('plain body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/file.txt');

    expect(result).toEqual({ content: 'plain body', kind: 'passthrough' });
  });

  it('reports text/markdown bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('# Title\n\nbody', 'text/markdown'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/readme.md');

    expect(result).toEqual({ content: '# Title\n\nbody', kind: 'passthrough' });
  });

  it('reports HTML bodies as extracted main content', async () => {
    const html =
      '<html><head><title>Doc</title></head><body><article>' +
      '<p>The quick brown fox jumps over the lazy dog. '.repeat(20) +
      '</p></article></body></html>';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(html, 'text/html; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/page');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('quick brown fox');
  });

  it('returns a cached result on the second fetch', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('fresh', 'text/plain; charset=utf-8'));
    const cache = new FetchCache();
    const provider = new LocalFetchURLProvider({ fetchImpl, cache });

    const first = await provider.fetch('https://example.com/file.txt');
    const second = await provider.fetch('https://example.com/file.txt');

    expect(first).toEqual({ content: 'fresh', kind: 'passthrough' });
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not share cache across different URLs', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(htmlResponse('a', 'text/plain; charset=utf-8'))
      .mockResolvedValueOnce(htmlResponse('b', 'text/plain; charset=utf-8'));
    const cache = new FetchCache();
    const provider = new LocalFetchURLProvider({ fetchImpl, cache });

    await provider.fetch('https://example.com/a');
    await provider.fetch('https://example.com/b');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('LocalFetchURLProvider redirect SSRF guard', () => {
  it('rejects a 302 redirect to the cloud metadata endpoint', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('http://169.254.169.254/latest/meta-data/'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/page')).rejects.toThrow(
      /private address/i,
    );
    // The second hop must never be issued — only the initial public URL.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to localhost', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('http://localhost:8080/admin'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/page')).rejects.toThrow(
      /private host/i,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses redirect: manual so the runtime never auto-follows', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/page');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
  });

  it('follows a single redirect to another public URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('https://other.example.com/final'))
      .mockResolvedValueOnce(htmlResponse('final body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/page');

    expect(result).toEqual({ content: 'final body', kind: 'passthrough' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://other.example.com/final');
  });

  it('resolves and follows a relative redirect against the current URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('/redirected/path'))
      .mockResolvedValueOnce(htmlResponse('relative body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/start');

    expect(result).toEqual({ content: 'relative body', kind: 'passthrough' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://example.com/redirected/path');
  });

  it('follows multiple public hops before reaching the final response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('https://a.example.com/2'))
      .mockResolvedValueOnce(redirectResponse('https://b.example.com/3'))
      .mockResolvedValueOnce(htmlResponse('deep body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/1');

    expect(result).toEqual({ content: 'deep body', kind: 'passthrough' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a private redirect that appears partway through a public chain', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('https://a.example.com/2'))
      .mockResolvedValueOnce(redirectResponse('http://169.254.169.254/'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/1')).rejects.toThrow(
      /private address/i,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after exceeding the maximum redirect count', async () => {
    // Always redirect to another public URL so the SSRF guard passes and the
    // hop cap is what stops the loop.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(redirectResponse('https://loop.example.com/next')),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/loop')).rejects.toThrow(
      /too many redirects/i,
    );
  });

  it('allows a redirect to a private address when allowPrivateAddresses is set', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('http://127.0.0.1:9000/local'))
      .mockResolvedValueOnce(htmlResponse('local body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });

    const result = await provider.fetch('http://127.0.0.1:8000/start');

    expect(result).toEqual({ content: 'local body', kind: 'passthrough' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
