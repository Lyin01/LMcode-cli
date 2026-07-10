/**
 * External-editor helper — spawn $VISUAL / $EDITOR (or a configured
 * command) on a temp file seeded with the current editor buffer, then
 * read the edited contents back.
 *
 * Resolution priority:
 *   configured (from Core/SDK defaults or `/editor`) >
 *   $VISUAL > $EDITOR > undefined (caller handles "no editor" toast).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Launch `command` (tokenised via a shell) against a temp file seeded
 * with `initialText`. Returns the edited contents on success, or
 * `undefined` if the editor exited non-zero / the file disappeared.
 *
 * The command is passed to the platform shell so users can supply argv-style
 * strings like `"code --wait"` or `"nvim +set ft=markdown"`.
 */
export async function editInExternalEditor(
  initialText: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'lmcode-edit-'));
  const file = join(dir, 'prompt.md');
  await writeFile(file, initialText, 'utf-8');
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const target = editorShellTarget(command, file, platform);
      const child = spawn(target.cmd, target.args, {
        stdio: 'inherit',
        windowsVerbatimArguments: platform === 'win32',
      });
      child.on('exit', (exitCode, signal) => {
        resolve(exitCode ?? (signal === null ? 0 : 1));
      });
      child.on('error', reject);
    });
    if (code !== 0) return undefined;
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}

interface EditorShellTarget {
  readonly cmd: string;
  readonly args: string[];
}

function editorShellTarget(
  command: string,
  file: string,
  platform: NodeJS.Platform,
): EditorShellTarget {
  if (platform === 'win32') {
    const shellCmd = `"${command} ${cmdQuote(file)}"`;
    return {
      cmd: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', shellCmd],
    };
  }
  return { cmd: '/bin/sh', args: ['-c', `${command} ${shellQuote(file)}`] };
}

function shellQuote(path: string): string {
  // Single-quote and escape any embedded single quotes.
  return `'${path.replaceAll('\'', "'\\''")}'`;
}

function cmdQuote(path: string): string {
  return `"${path}"`;
}
