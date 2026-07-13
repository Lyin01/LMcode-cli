#!/usr/bin/env node
/**
 * Postinstall hook for @liumir/lmcode.
 *
 * Runs only for global installs across npm, yarn (classic), and pnpm
 * (`isGlobalInstall` in `./postinstall/reach.mjs`). Non-global contexts
 * (npx, local project deps, workspace bootstraps, `pnpm dlx`) are
 * silent no-ops. Never fails the install: any error is reported as a
 * warning and the script exits 0.
 *
 * Steps (both Windows-only inside their helpers):
 *   1. Patch the npm-generated `lm.ps1` shim so UTF-8 output survives
 *      capture/piping on GBK/ANSI consoles (`fixWindowsShimEncoding`).
 *   2. Create a desktop shortcut that launches `lm` in a UTF-8 console
 *      (`createDesktopShortcut`; opt out with
 *      `LMCODE_NO_DESKTOP_SHORTCUT=1`).
 *
 * History: this hook used to carry a 1,200-line PATH-takeover
 * migration that renamed legacy Python `lmcode` shims out of the way.
 * The rewritten CLI's bin is `lm`, which never collides with `lmcode`,
 * so the takeover could never trigger (its "our shim wins PATH" gate
 * required a `lmcode` bin this package no longer installs) and it cost
 * a login-shell PATH probe on every POSIX global install. Removed
 * 2026-07-13; see git history for `postinstall/{reach,migrate,ui}.mjs`
 * originals.
 */

import { isGlobalInstall } from './postinstall/reach.mjs';
import { createDesktopShortcut } from './postinstall/shortcut.mjs';
import { fixWindowsShimEncoding } from './postinstall/win-encoding.mjs';
import { notify } from './postinstall/ui.mjs';

try {
  if (isGlobalInstall()) {
    fixWindowsShimEncoding();
    createDesktopShortcut();
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  notify(`[lmcode] postinstall warning: ${message}`);
}
