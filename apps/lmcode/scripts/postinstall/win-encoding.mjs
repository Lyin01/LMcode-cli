/**
 * Windows PowerShell UTF-8 shim patch.
 *
 * Problem: the CLI emits UTF-8, but Windows PowerShell on a GBK/ANSI
 * system codepage (e.g. zh-CN ACP 936) decodes captured or piped native
 * output with the console codepage, so Chinese text turns into mojibake
 * the moment `lm` output is redirected, piped, or assigned to a variable.
 * `$OutputEncoding` also defaults to US-ASCII on PS 5.1, destroying
 * Chinese piped INTO the CLI.
 *
 * Fix: npm generates a `lm.ps1` shim in the global bin dir on install.
 * We inject a small prologue into that shim that forces UTF-8 for the
 * duration of the invocation and restores the previous console encoding
 * on exit. The patch is idempotent (marker comment), only touches the
 * known npm cmd-shim template, and never fails the install.
 */

import fs from 'node:fs';
import path from 'node:path';

const MARKER = '# lmcode: force UTF-8';

const HEADER_BLOCK = [
  '',
  `${MARKER} - PowerShell on GBK/ANSI codepages garbles the CLI's UTF-8`,
  '# output when it is captured or piped. Force UTF-8 for this invocation',
  '# and restore the previous console encoding on exit.',
  'try { $__lmPrevOut = [Console]::OutputEncoding } catch {}',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '',
].join('\n');

const RESTORE_LINE =
  'try { if ($__lmPrevOut) { [Console]::OutputEncoding = $__lmPrevOut } } catch {}\n';

/** Candidate global-bin directories that may hold the generated shim. */
function candidateBinDirs() {
  const dirs = new Set();
  if (process.env.npm_config_prefix) dirs.add(process.env.npm_config_prefix);
  if (process.env.PNPM_HOME) dirs.add(process.env.PNPM_HOME);
  // Default npm-on-Windows global prefix is the node.exe directory.
  dirs.add(path.dirname(process.execPath));
  // Classic npm user prefix (%APPDATA%\npm).
  if (process.env.APPDATA) dirs.add(path.join(process.env.APPDATA, 'npm'));
  return [...dirs];
}

/** Patch a single shim file. Returns true when a patch was written. */
function patchShim(shimPath) {
  const original = fs.readFileSync(shimPath, 'utf8');
  if (original.includes(MARKER)) return false; // already patched
  // Only touch the npm cmd-shim template we know how to patch safely.
  if (!/^\$basedir=Split-Path /m.test(original) || !/^exit \$ret/m.test(original)) {
    return false;
  }
  let patched = original.replace(
    /^(\$basedir=Split-Path .*)$/m,
    (line) => line + '\n' + HEADER_BLOCK,
  );
  patched = patched.replace(/^exit \$ret/m, () => RESTORE_LINE + 'exit $ret');
  fs.writeFileSync(shimPath, patched, 'utf8');
  return true;
}

/**
 * Entry point, called from postinstall. Windows-only; silent no-op
 * everywhere else and on any error - an encoding nicety must never
 * fail an install.
 */
export function fixWindowsShimEncoding() {
  if (process.platform !== 'win32') return;
  for (const dir of candidateBinDirs()) {
    try {
      const shim = path.join(dir, 'lm.ps1');
      if (fs.existsSync(shim)) patchShim(shim);
    } catch {
      // Never fail the install over an encoding patch.
    }
  }
}
