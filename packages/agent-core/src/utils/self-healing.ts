import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { parseHTML } from 'linkedom';
import type { Browser, BrowserType } from 'playwright-core';

export interface TypeScriptRuntime {
  readonly ScriptTarget: { readonly Latest: number };
  readonly ScriptKind: { readonly JS: number };
  createSourceFile(
    filepath: string,
    code: string,
    target: number,
    setParentNodes: boolean,
    scriptKind?: number,
  ): {
    readonly parseDiagnostics?: readonly {
      readonly messageText: unknown;
      readonly start?: number | undefined;
    }[];
    getLineAndCharacterOfPosition(position: number): { readonly line: number; readonly character: number };
  };
  flattenDiagnosticMessageText(messageText: unknown, newLine: string): string;
}

let tsModule: TypeScriptRuntime | null | undefined;
let playwrightModule: PlaywrightRuntime | null | undefined;

// Keyframe capture schedule (ms from page load) for canvas animations.
// NOTE: the last entry intentionally sits *past* the point where most
// animations finish, so the auditor sees the terminal/end state — that is
// where uncleared-buffer ghosts, never-ending particle fields and leftover
// shapes show up. Capturing only up to ~15s misses that entire class of bugs.
export const RUNTIME_KEYFRAME_TIMES_MS = [0, 4000, 9000, 15000, 20000];

export type HtmlRuntimeValidation =
  | { readonly status: 'passed' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'skipped';
      readonly reason: 'playwright-unavailable' | 'runtime-validation-error';
      readonly detail: string | undefined;
    };

export type SyntaxValidation =
  | { readonly status: 'passed' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'skipped';
      readonly reason: 'typescript-unavailable' | 'syntax-validation-error';
      readonly detail: string | undefined;
    };

export interface FileValidationResult {
  readonly error: string | null;
  readonly syntax: SyntaxValidation | undefined;
  readonly runtime: HtmlRuntimeValidation | undefined;
  readonly screenshots: string[] | undefined;
  readonly keyframeTimesMs: number[] | undefined;
}

interface SyntaxCheckResult {
  readonly error: string | null;
  readonly syntax: SyntaxValidation;
}

export interface HtmlRuntimeValidationOptions {
  readonly loadPlaywright?: (() => Promise<PlaywrightRuntime | null>) | undefined;
}

export interface SyntaxValidationOptions {
  readonly loadTypeScript?: (() => Promise<TypeScriptRuntime | null>) | undefined;
}

export interface FileValidationOptions
  extends HtmlRuntimeValidationOptions,
    SyntaxValidationOptions {}

export interface PlaywrightRuntime {
  readonly chromium: BrowserType;
}

// Lazy dynamic imports for optional dependencies
async function getTs() {
  if (tsModule === undefined) {
    try {
      tsModule = (await import('typescript')) as unknown as TypeScriptRuntime;
    } catch {
      tsModule = null;
    }
  }
  return tsModule;
}

// Prefer the full `playwright` package; fall back to `playwright-core` (which
// ships no browser binaries — we locate a cached chromium ourselves).
async function getPlaywright() {
  if (playwrightModule === undefined) {
    try {
      // @ts-ignore
      playwrightModule = await import('playwright');
    } catch {
      try {
        // @ts-ignore
        playwrightModule = await import('playwright-core');
      } catch {
        playwrightModule = null;
      }
    }
  }
  return playwrightModule;
}

function playwrightCacheDir(): string {
  const fromEnv = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (fromEnv && fromEnv !== '0') return fromEnv;
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return join(process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'ms-playwright');
    case 'darwin':
      return join(home, 'Library', 'Caches', 'ms-playwright');
    default:
      return join(home, '.cache', 'ms-playwright');
  }
}

function chromiumRelPaths(): string[] {
  switch (process.platform) {
    case 'win32':
      return ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];
    case 'darwin':
      return ['chrome-mac/Chromium.app/Contents/MacOS/Chromium'];
    default:
      return ['chrome-linux/chrome'];
  }
}

function headlessShellRelPaths(): string[] {
  switch (process.platform) {
    case 'win32':
      return ['chrome-headless-shell-win64/chrome-headless-shell.exe'];
    case 'darwin':
      return ['chrome-headless-shell-mac/chrome-headless-shell'];
    default:
      return ['chrome-headless-shell-linux/chrome-headless-shell'];
  }
}

// Locate a chromium executable in the Playwright browser cache so runtime
// validation works with `playwright-core` (no bundled browser). Returns
// undefined if none is found — callers must degrade gracefully.
export function resolveChromiumExecutable(): string | undefined {
  const cacheDir = playwrightCacheDir();
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return undefined;
  }
  const revisionOf = (name: string) => parseInt(name.split('-').pop() || '0', 10) || 0;
  const pick = (prefix: string, rels: string[]): string | undefined => {
    const dirs = entries
      .filter((e) => e.startsWith(prefix))
      .sort((a, b) => revisionOf(b) - revisionOf(a)); // newest revision first
    for (const dir of dirs) {
      for (const rel of rels) {
        const candidate = join(cacheDir, dir, ...rel.split('/'));
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  };
  // Full chromium gives the most faithful render; headless shell is a fallback.
  return pick('chromium-', chromiumRelPaths()) || pick('chromium_headless_shell-', headlessShellRelPaths());
}

export function cleanStack(stack: string | undefined, filepath: string): string {
  if (!stack) return '';
  const lines = stack.split('\n');
  const cleanedLines: string[] = [];

  for (const line of lines) {
    if (
      line.includes('node:internal') ||
      line.includes('node_modules') ||
      line.includes('chrome-extension://') ||
      line.includes('__playwright_')
    ) {
      continue;
    }
    // Remove absolute paths and file:// wrappers for cleaner, token-efficient output
    let cleaned = line;
    cleaned = cleaned.replace(/file:\/\/\/[A-Za-z]:\/[^)]+\//g, '');
    cleaned = cleaned.replace(/[A-Za-z]:\\[^)]+\\/g, '');
    cleanedLines.push(cleaned);
  }
  return cleanedLines.join('\n');
}

export function extractLineNumber(stack: string | undefined, filepath: string): number | null {
  if (!stack) return null;
  const basename = filepath.split(/[/\\]/).pop();
  if (!basename) return null;
  const escaped = basename.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`${escaped}:(\\d+)`);
  const match = stack.match(regex);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

export function getCodeContext(code: string, lineNum: number, range = 3): string {
  const lines = code.split('\n');
  const start = Math.max(0, lineNum - 1 - range);
  const end = Math.min(lines.length, lineNum - 1 + range + 1);
  const snippetLines: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNo = i + 1;
    const marker = lineNo === lineNum ? ' >>> ' : '     ';
    snippetLines.push(`${marker}${lineNo} | ${lines[i]}`);
  }
  return snippetLines.join('\n');
}

export function validateJavaScript(code: string, filepath: string): string | null {
  try {
    new vm.Script(code, { filename: filepath });
  } catch (err: any) {
    const line = extractLineNumber(err.stack, filepath);
    const context = line ? `\n\nContext around line ${line}:\n${getCodeContext(code, line)}` : '';
    const cleanedStack = cleanStack(err.stack, filepath);
    return `JavaScript syntax error: ${err.message}\n${cleanedStack}${context}`;
  }
  return null;
}

/** V8 messages that mean "this is module-goal syntax", not a real error.
 *  `vm.Script` only parses the script goal, so import/export/import.meta and
 *  top-level await always throw there even when the code is a valid module. */
const MODULE_GOAL_ERROR_RE =
  /Cannot use import statement outside a module|Cannot use 'import\.meta' outside a module|Unexpected token 'export'|await is only valid in async function/;

/**
 * Validate module-goal JavaScript. `vm.Script` cannot parse import/export
 * (and `vm.SourceTextModule` needs a runtime flag), so this uses the
 * TypeScript parser. The public compatibility wrapper fails open, while the
 * evidence-aware path preserves whether validation was skipped.
 */
export async function validateJavaScriptModule(
  code: string,
  filepath: string,
): Promise<string | null> {
  return (await validateJavaScriptModuleWithEvidence(code, filepath)).error;
}

async function validateJavaScriptModuleWithEvidence(
  code: string,
  filepath: string,
  options: SyntaxValidationOptions = {},
): Promise<SyntaxCheckResult> {
  const ts = await (options.loadTypeScript ?? getTs)();
  if (!ts) {
    return skippedSyntaxValidation('typescript-unavailable', undefined);
  }
  try {
    const sourceFile = ts.createSourceFile(
      filepath,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const diagnostics = sourceFile.parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const first = diagnostics[0]!;
      const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
      const position = first.start !== undefined
        ? sourceFile.getLineAndCharacterOfPosition(first.start)
        : null;
      const lineNum = position ? position.line + 1 : null;
      const lineStr = position ? ` at line ${position.line + 1}, col ${position.character + 1}` : '';
      const context = lineNum ? `\n\nContext around line ${lineNum}:\n${getCodeContext(code, lineNum)}` : '';
      return completedSyntaxValidation(
        `JavaScript syntax error: ${message}${lineStr}${context}`,
      );
    }
  } catch (error: unknown) {
    return skippedSyntaxValidation('syntax-validation-error', errorDetail(error));
  }
  return completedSyntaxValidation(null);
}

/**
 * Validate a `.js` file whose parse goal is ambiguous (script vs module —
 * depends on the nearest package.json `type`, which we do not resolve).
 * Try the script goal first; when the only complaint is module-goal syntax
 * (import/export/import.meta/top-level await), re-validate as a module so
 * plain ESM `.js` files stop being flagged as broken.
 */
export async function validateJavaScriptAuto(
  code: string,
  filepath: string,
): Promise<string | null> {
  return (await validateJavaScriptAutoWithEvidence(code, filepath)).error;
}

async function validateJavaScriptAutoWithEvidence(
  code: string,
  filepath: string,
  options: SyntaxValidationOptions = {},
): Promise<SyntaxCheckResult> {
  const scriptError = validateJavaScript(code, filepath);
  if (scriptError === null) return completedSyntaxValidation(null);
  if (MODULE_GOAL_ERROR_RE.test(scriptError)) {
    return validateJavaScriptModuleWithEvidence(code, filepath, options);
  }
  return completedSyntaxValidation(scriptError);
}

export async function validateTypeScript(code: string, filepath: string): Promise<string | null> {
  return (await validateTypeScriptWithEvidence(code, filepath)).error;
}

async function validateTypeScriptWithEvidence(
  code: string,
  filepath: string,
  options: SyntaxValidationOptions = {},
): Promise<SyntaxCheckResult> {
  const ts = await (options.loadTypeScript ?? getTs)();
  if (!ts) {
    return skippedSyntaxValidation('typescript-unavailable', undefined);
  }
  try {
    const sourceFile = ts.createSourceFile(filepath, code, ts.ScriptTarget.Latest, true);
    const diagnostics = sourceFile.parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const first = diagnostics[0]!;
      const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
      const position = first.start !== undefined
        ? sourceFile.getLineAndCharacterOfPosition(first.start)
        : null;
      const lineNum = position ? position.line + 1 : null;
      const lineStr = position ? ` at line ${position.line + 1}, col ${position.character + 1}` : '';
      const context = lineNum ? `\n\nContext around line ${lineNum}:\n${getCodeContext(code, lineNum)}` : '';
      return completedSyntaxValidation(
        `TypeScript syntax error: ${message}${lineStr}${context}`,
      );
    }
  } catch (error: unknown) {
    return skippedSyntaxValidation('syntax-validation-error', errorDetail(error));
  }
  return completedSyntaxValidation(null);
}

/** JavaScript MIME types that mark a classic script per the HTML spec. */
const JS_MIME_TYPE_RE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/;

type ScriptBlockKind = 'classic' | 'module' | 'typescript' | 'data';

/**
 * Classify a `<script>` element by its `type`/`lang` attributes the way a
 * browser would. Anything that is not JavaScript or TypeScript — importmap,
 * speculationrules, application/json, ld+json, inline templates — is a DATA
 * BLOCK the browser never executes, and must not be parsed as JS. Doing so
 * used to reject every valid page using import maps with
 * "Unexpected token ':'".
 */
function classifyScriptBlock(script: {
  getAttribute(name: string): string | null;
}): ScriptBlockKind {
  if (script.getAttribute('lang') === 'ts') return 'typescript';
  const type = (script.getAttribute('type') ?? '').trim().toLowerCase();
  if (type === 'text/typescript') return 'typescript';
  if (type === '' || JS_MIME_TYPE_RE.test(type)) return 'classic';
  if (type === 'module') return 'module';
  return 'data';
}

export async function validateHtmlScripts(html: string, filepath: string): Promise<string | null> {
  return (await validateHtmlScriptsWithEvidence(html, filepath)).error;
}

async function validateHtmlScriptsWithEvidence(
  html: string,
  filepath: string,
  options: SyntaxValidationOptions = {},
): Promise<SyntaxCheckResult> {
  let skippedValidation: SyntaxValidation | undefined;
  try {
    const { document } = parseHTML(html);
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      if (script.hasAttribute('src')) continue;
      const kind = classifyScriptBlock(script);
      if (kind === 'data') continue;
      const code = script.textContent || '';
      const result =
        kind === 'typescript'
          ? await validateTypeScriptWithEvidence(code, filepath, options)
          : kind === 'module'
            ? await validateJavaScriptModuleWithEvidence(code, filepath, options)
            : completedSyntaxValidation(validateJavaScript(code, filepath));
      const error = result.error;
      if (error) {
        // Adjust local line numbers to be absolute line numbers relative to the parent HTML file
        const byteOffset = html.indexOf(code);
        const lineOffset = byteOffset !== -1 ? html.slice(0, byteOffset).split('\n').length - 1 : 0;

        const basename = filepath.split(/[/\\]/).pop() || '';
        const escaped = basename.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regexLine = new RegExp(`${escaped}:(\\d+)`, 'g');

        let adjustedError = error;
        const match = error.match(new RegExp(`${escaped}:(\\d+)`));
        let absoluteLineNum: number | null = null;
        if (match && match[1]) {
          const localLine = parseInt(match[1], 10);
          absoluteLineNum = localLine + lineOffset;
          adjustedError = adjustedError.replace(regexLine, `${basename}:${absoluteLineNum}`);
        }

        const tsMatch = error.match(/at line (\d+)/);
        if (tsMatch && tsMatch[1]) {
          const localLine = parseInt(tsMatch[1], 10);
          absoluteLineNum = localLine + lineOffset;
          adjustedError = adjustedError.replace(/at line \d+/, `at line ${absoluteLineNum}`);
        }

        const contextIndex = adjustedError.indexOf('\n\nContext around line');
        if (contextIndex !== -1) {
          adjustedError = adjustedError.substring(0, contextIndex);
        }

        const context = absoluteLineNum
          ? `\n\nContext around line ${absoluteLineNum} of HTML:\n${getCodeContext(html, absoluteLineNum)}`
          : '';

        return completedSyntaxValidation(
          `HTML Script block error: ${adjustedError}${context}`,
        );
      }
      if (result.syntax.status === 'skipped' && skippedValidation === undefined) {
        skippedValidation = result.syntax;
      }
    }
  } catch (error: unknown) {
    return completedSyntaxValidation(`HTML parse error: ${errorDetail(error)}`);
  }
  return {
    error: null,
    syntax: skippedValidation ?? { status: 'passed' },
  };
}

export async function validateHtmlRuntime(
  filepath: string,
  content: string,
  options: HtmlRuntimeValidationOptions = {},
): Promise<FileValidationResult> {
  const playwright = await (options.loadPlaywright ?? getPlaywright)();
  if (!playwright) {
    return {
      error: null,
      syntax: undefined,
      runtime: {
        status: 'skipped',
        reason: 'playwright-unavailable',
        detail: undefined,
      },
      screenshots: undefined,
      keyframeTimesMs: undefined,
    };
  }
  let browser: Browser | undefined;
  try {
    const executablePath = resolveChromiumExecutable();
    const launchedBrowser = await playwright.chromium.launch({
      headless: true,
      executablePath,
    });
    browser = launchedBrowser;
    const context = await launchedBrowser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();

    const errorsMap = new Map<string, number>();
    const registerError = (msg: string) => {
      const cleaned = cleanStack(msg, filepath);
      errorsMap.set(cleaned, (errorsMap.get(cleaned) || 0) + 1);
    };

    page.on('pageerror', (exception) => {
      registerError(`Uncaught Page Exception: ${exception.message}\n${exception.stack || ''}`);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        registerError(`Browser console.error: ${msg.text()}`);
      }
    });

    const fileUrl = `file://${filepath.replace(/\\/g, '/')}`;
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 5000 });

    const screenshots: string[] = [];
    const isCanvasAnimation =
      content.includes('<canvas') &&
      (content.includes('requestAnimationFrame') || content.includes('getContext'));

    if (isCanvasAnimation) {
      let lastAt = 0;
      for (const at of RUNTIME_KEYFRAME_TIMES_MS) {
        const wait = at - lastAt;
        lastAt = at;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const buf = await page.screenshot({ type: 'png' });
        screenshots.push(buf.toString('base64'));
      }
    } else {
      await new Promise((r) => setTimeout(r, 2000));
      const buf = await page.screenshot({ type: 'png' });
      screenshots.push(buf.toString('base64'));
    }

    const keyframeTimesMs = isCanvasAnimation ? [...RUNTIME_KEYFRAME_TIMES_MS] : [2000];

    if (errorsMap.size > 0) {
      const formattedErrors: string[] = [];
      let snippetInjected = false;
      let snippetText = '';

      const uniqueErrors = Array.from(errorsMap.entries()).slice(0, 5);
      for (const [errText, count] of uniqueErrors) {
        const countStr = count > 1 ? ` (occurred ${count} times)` : '';
        const truncatedText = errText.length > 1000 ? errText.substring(0, 997) + '...' : errText;
        formattedErrors.push(`${truncatedText}${countStr}`);

        if (!snippetInjected) {
          const line = extractLineNumber(errText, filepath);
          if (line) {
            snippetText = `\n\nContext around line ${line}:\n${getCodeContext(content, line)}`;
            snippetInjected = true;
          }
        }
      }

      return {
        error: `Headless Playwright captured runtime errors:\n${formattedErrors.join('\n')}${snippetText}`,
        syntax: undefined,
        runtime: { status: 'failed' },
        screenshots,
        keyframeTimesMs,
      };
    }
    return {
      error: null,
      syntax: undefined,
      runtime: { status: 'passed' },
      screenshots,
      keyframeTimesMs,
    };
  } catch (error: unknown) {
    return {
      error: null,
      syntax: undefined,
      runtime: {
        status: 'skipped',
        reason: 'runtime-validation-error',
        detail: error instanceof Error ? error.message : String(error),
      },
      screenshots: undefined,
      keyframeTimesMs: undefined,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

export async function validateFileSyntaxWithScreenshots(
  filepath: string,
  content: string,
  options: FileValidationOptions = {},
): Promise<FileValidationResult> {
  const ext = filepath.split('.').pop()?.toLowerCase();
  if (ext === 'js') {
    // Ambiguous goal: plain ESM `.js` is everywhere, so auto-detect.
    return staticValidationResult(
      await validateJavaScriptAutoWithEvidence(content, filepath, options),
    );
  }
  if (ext === 'mjs') {
    return staticValidationResult(
      await validateJavaScriptModuleWithEvidence(content, filepath, options),
    );
  }
  if (ext === 'cjs') {
    return staticValidationResult(completedSyntaxValidation(validateJavaScript(content, filepath)));
  }
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') {
    return staticValidationResult(await validateTypeScriptWithEvidence(content, filepath, options));
  }
  if (ext === 'html' || ext === 'htm') {
    const htmlValidation = await validateHtmlScriptsWithEvidence(content, filepath, options);
    if (htmlValidation.error) return staticValidationResult(htmlValidation);
    return {
      ...(await validateHtmlRuntime(filepath, content, options)),
      syntax: htmlValidation.syntax,
    };
  }
  return {
    error: null,
    syntax: undefined,
    runtime: undefined,
    screenshots: undefined,
    keyframeTimesMs: undefined,
  };
}

export async function validateFileSyntax(filepath: string, content: string): Promise<string | null> {
  const res = await validateFileSyntaxWithScreenshots(filepath, content);
  return res.error;
}

function completedSyntaxValidation(error: string | null): SyntaxCheckResult {
  return {
    error,
    syntax: { status: error === null ? 'passed' : 'failed' },
  };
}

function skippedSyntaxValidation(
  reason: Extract<SyntaxValidation, { status: 'skipped' }>['reason'],
  detail: string | undefined,
): SyntaxCheckResult {
  return {
    error: null,
    syntax: { status: 'skipped', reason, detail },
  };
}

function staticValidationResult(result: SyntaxCheckResult): FileValidationResult {
  return {
    error: result.error,
    syntax: result.syntax,
    runtime: undefined,
    screenshots: undefined,
    keyframeTimesMs: undefined,
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
