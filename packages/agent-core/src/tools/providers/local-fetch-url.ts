/**
 * LocalFetchURLProvider — host-side URL fetcher.
 *
 * Flow:
 *   1. GET the URL with a Chrome-like UA.
 *   2. Reject HTTP >= 400 with the status code in the message.
 *   3. Reject responses larger than `maxBytes` (content-length first,
 *      then measured body length as a defensive second check).
 *   4. `text/plain` / `text/markdown` → passthrough verbatim.
 *   5. Otherwise (assumed HTML) → run Readability over a linkedom
 *      document. Return `# ${title}\n\n${text}` (title omitted when
 *      absent). If extraction yields no meaningful text, fall back to
 *      common content containers (`<article>` / `<main>` / `<body>`)
 *      before throwing a "meaningful content" error.
 */

import { Readability } from '@mozilla/readability';
// Dynaically imported — see getLinkedom() below.

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';
import { FetchCache } from './fetch-cache';

export interface LocalFetchURLProviderOptions {
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly cache?: FetchCache;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// Cap on the number of redirect hops we will follow before giving up.
// Each hop is re-validated by `assertSafeFetchTarget`, so this also bounds
// the cost of a malicious redirect chain.
const MAX_REDIRECTS = 5;

// Readability's .d.ts references the global `Document` type, but this
// package compiles with `lib: ES2023` (no DOM). Extracting the
// constructor parameter type keeps us off the global `Document` name
// while still accepting whatever Readability wants.
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// linkedom's published types depend on DOM libs we don't load. Declare
// the minimal surface we actually use so the rest of the file stays
// type-safe without pulling lib.dom.d.ts into the host build.
interface DomElementLike {
  querySelector(selectors: string): { textContent: string | null } | null;
  textContent: string | null;
}
interface DomParseResult {
  document: DomElementLike;
}
let linkedomModule:
  | { parseHTML: (html: string) => DomParseResult }
  | undefined;

async function getLinkedom(): Promise<{
  parseHTML: (html: string) => DomParseResult;
}> {
  if (!linkedomModule) {
    linkedomModule = (await import('linkedom')) as any;
  }
  return linkedomModule!;
}

type Ipv4Octets = readonly [number, number, number, number];

/**
 * SSRF guard — reject non-http(s) schemes and (by default) any hostname
 * that is, or parses as, a private / loopback / link-local / ULA IP
 * literal. This is a *static* check against the URL string; it does NOT
 * do DNS resolution, so a domain that resolves to a private IP via
 * DNS-rebinding is **not** caught here. That attack is a known
 * limitation; mitigations (e.g. pinning the resolved IP through to
 * fetch) are left for a follow-up.
 *
 * IPv6 unique-local prefixes (`fc` / `fd`) are only matched on literals
 * that contain `:`. A prefix check on the raw hostname would block public
 * domains such as `fda.gov` and `fcbarcelona.com`.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1` / `::ffff:7f00:1`) is expanded and
 * run through the same private-IPv4 table. Node canonicalizes the dotted
 * form to hex in `URL.hostname`, so both spellings must be handled.
 */
function assertSafeFetchTarget(url: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`);
  }
  if (allowPrivate) return;
  // URL hostname preserves surrounding `[ ]` for IPv6 literals on some
  // Node versions (and not others). Strip them for uniform comparison.
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  if (host.includes(':')) {
    if (isPrivateIpv6Literal(host)) {
      throw new Error(`Refusing to fetch private host: "${host}"`);
    }
    const mapped = parseIpv4MappedIpv6(host);
    if (mapped !== null && isPrivateIpv4(mapped)) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
    return;
  }
  const v4 = parseIpv4Literal(host);
  if (v4 !== null && isPrivateIpv4(v4)) {
    throw new Error(`Refusing to fetch private address: "${host}"`);
  }
}

function isPrivateIpv6Literal(host: string): boolean {
  return (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  );
}

function parseIpv4Literal(host: string): Ipv4Octets | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return null;
  const octets: Ipv4Octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 literal: "${host}"`);
  }
  return octets;
}

/**
 * Node's URL parser rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1`. Accept
 * both the dotted and hex-pair spellings of an IPv4-mapped IPv6 address.
 */
function parseIpv4MappedIpv6(host: string): Ipv4Octets | null {
  const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(host);
  if (dotted !== null) {
    const octets: Ipv4Octets = [
      Number(dotted[1]),
      Number(dotted[2]),
      Number(dotted[3]),
      Number(dotted[4]),
    ];
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return octets;
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex === null) return null;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isPrivateIpv4([a, b]: Ipv4Octets): boolean {
  // 127.0.0.0/8 loopback, 10.0.0.0/8, 192.168.0.0/16,
  // 172.16.0.0/12, 169.254.0.0/16 link-local / AWS metadata,
  // 0.0.0.0/8 "this network", 100.64.0.0/10 CGNAT.
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function cacheKey(url: string, allowPrivate: boolean, maxBytes: number, userAgent: string): string {
  return `local:${url}:${String(allowPrivate)}:${String(maxBytes)}:${userAgent}`;
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;
  private readonly cache: FetchCache;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
    this.cache = options.cache ?? new FetchCache();
  }

  async fetch(url: string, _options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    assertSafeFetchTarget(url, this.allowPrivateAddresses);

    const key = cacheKey(url, this.allowPrivateAddresses, this.maxBytes, this.userAgent);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.fetchFresh(url);
    this.cache.set(key, result);
    return result;
  }

  /**
   * GET `url`, following redirects manually so the SSRF guard runs on
   * every hop. `redirect: 'manual'` keeps the runtime from auto-following
   * a 3xx into a private address (e.g. a 302 to the cloud metadata
   * endpoint), which would otherwise bypass the initial
   * `assertSafeFetchTarget` check entirely.
   */
  private async followRedirects(url: string): Promise<Response> {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.fetchImpl(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        redirect: 'manual',
      });

      const isRedirect =
        response.status >= 300 && response.status < 400 && response.status !== 304;
      if (!isRedirect) {
        return response;
      }

      const location = response.headers.get('location');
      if (location === null || location === '') {
        // A 3xx without a usable Location is not actionable — return it and
        // let the caller's status handling deal with it.
        return response;
      }

      // Resolve relative redirects against the current URL, then re-run the
      // SSRF guard on the absolute target before following.
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        await response.body?.cancel().catch(() => {
          /* already closed */
        });
        throw new Error(`Invalid redirect Location: "${location}"`);
      }

      assertSafeFetchTarget(nextUrl, this.allowPrivateAddresses);

      // Release the redirect response's body before issuing the next hop so
      // undici can return the socket to the keep-alive pool.
      await response.body?.cancel().catch(() => {
        /* already closed */
      });

      currentUrl = nextUrl;
    }

    throw new Error(`Too many redirects (exceeded ${String(MAX_REDIRECTS)}) fetching "${url}".`);
  }

  private async fetchFresh(url: string): Promise<UrlFetchResult> {
    const response = await this.followRedirects(url);

    if (response.status >= 400) {
      // Drain the unused body so undici can release the socket back to
      // the keep-alive pool instead of leaking it on error paths.
      await response.body?.cancel().catch(() => {
        /* already closed */
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    // Reject oversized responses before buffering the full body.
    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const body = await response.text();

    // Servers may omit content-length — measure again defensively.
    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }

    return { content: await this.extractMainContent(body), kind: 'extracted' };
  }

  private async extractMainContent(html: string): Promise<string> {
    // Readability mutates the DOM it parses, so parse twice — once for
    // the primary extractor and once for the fallback path.
    const { parseHTML } = await getLinkedom();
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {
      // Fall through to the container-based fallback.
    }

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error(
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}
