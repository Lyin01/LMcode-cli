import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { parseHTML } from 'linkedom';

let tsModule: any;
let playwrightModule: any;

// Keyframe capture schedule (ms from page load) for canvas animations.
// NOTE: the last entry intentionally sits *past* the point where most
// animations finish, so the auditor sees the terminal/end state — that is
// where uncleared-buffer ghosts, never-ending particle fields and leftover
// shapes show up. Capturing only up to ~15s misses that entire class of bugs.
export const RUNTIME_KEYFRAME_TIMES_MS = [0, 4000, 9000, 15000, 20000];

// Lazy dynamic imports for optional dependencies
async function getTs() {
  if (tsModule === undefined) {
    try {
      // @ts-ignore
      tsModule = await import('typescript');
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

export async function validateTypeScript(code: string, filepath: string): Promise<string | null> {
  const ts = await getTs();
  if (!ts) {
    return null;
  }
  try {
    const sourceFile = ts.createSourceFile(filepath, code, ts.ScriptTarget.Latest, true);
    const diagnostics = sourceFile.parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const first = diagnostics[0];
      const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
      const position = first.start !== undefined
        ? sourceFile.getLineAndCharacterOfPosition(first.start)
        : null;
      const lineNum = position ? position.line + 1 : null;
      const lineStr = position ? ` at line ${position.line + 1}, col ${position.character + 1}` : '';
      const context = lineNum ? `\n\nContext around line ${lineNum}:\n${getCodeContext(code, lineNum)}` : '';
      return `TypeScript syntax error: ${message}${lineStr}${context}`;
    }
  } catch (err: any) {
    return `TypeScript parser failed: ${err.message}`;
  }
  return null;
}

export async function validateHtmlScripts(html: string, filepath: string): Promise<string | null> {
  try {
    const { document } = parseHTML(html);
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      if (script.hasAttribute('src')) continue;
      const code = script.textContent || '';
      const isTs = script.getAttribute('lang') === 'ts' || script.getAttribute('type') === 'text/typescript';
      const error = isTs ? await validateTypeScript(code, filepath) : validateJavaScript(code, filepath);
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

        return `HTML Script block error: ${adjustedError}${context}`;
      }
    }
  } catch (err: any) {
    return `HTML parse error: ${err.message}`;
  }
  return null;
}

export async function validateHtmlRuntime(
  filepath: string,
  content: string,
): Promise<{ error: string | null; screenshots?: string[]; keyframeTimesMs?: number[] }> {
  const playwright = await getPlaywright();
  if (!playwright) {
    return { error: null };
  }
  let browser: any;
  try {
    const executablePath = resolveChromiumExecutable();
    browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();

    const errorsMap = new Map<string, number>();
    const registerError = (msg: string) => {
      const cleaned = cleanStack(msg, filepath);
      errorsMap.set(cleaned, (errorsMap.get(cleaned) || 0) + 1);
    };

    page.on('pageerror', (exception: any) => {
      registerError(`Uncaught Page Exception: ${exception.message}\n${exception.stack || ''}`);
    });
    page.on('console', (msg: any) => {
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
    }

    await browser.close();

    const keyframeTimesMs = isCanvasAnimation ? [...RUNTIME_KEYFRAME_TIMES_MS] : undefined;

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
        screenshots,
        keyframeTimesMs,
      };
    }
    return { error: null, screenshots, keyframeTimesMs };
  } catch (err: any) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    return { error: null };
  }
}

export async function validateFileSyntaxWithScreenshots(
  filepath: string,
  content: string,
): Promise<{ error: string | null; screenshots?: string[]; keyframeTimesMs?: number[] }> {
  const ext = filepath.split('.').pop()?.toLowerCase();
  if (ext === 'js') {
    return { error: validateJavaScript(content, filepath) };
  }
  if (ext === 'ts') {
    return { error: await validateTypeScript(content, filepath) };
  }
  if (ext === 'html' || ext === 'htm') {
    const htmlErr = await validateHtmlScripts(content, filepath);
    if (htmlErr) return { error: htmlErr };
    return await validateHtmlRuntime(filepath, content);
  }
  return { error: null };
}

export async function validateFileSyntax(filepath: string, content: string): Promise<string | null> {
  const res = await validateFileSyntaxWithScreenshots(filepath, content);
  return res.error;
}
