import { homedir } from 'node:os';

/**
 * Path helpers for TUI display.
 *
 * Both the footer cwd and the session-picker list shorten an absolute path by
 * aliasing the user's home directory to `~`. Two Windows hazards made the old
 * inline copies no-ops there:
 *   1. `process.env.HOME` is undefined on Windows (it uses `USERPROFILE`), so
 *      the home prefix never matched — `os.homedir()` resolves correctly on
 *      every platform.
 *   2. `process.cwd()` / stored work dirs use `\` on Windows, so `/`-based
 *      prefix checks and segment splitting silently failed.
 *
 * Comparison is done on a forward-slash view of both paths. Display output is
 * therefore always forward-slash, which matches the existing footer convention
 * and is the conventional way to render paths in a TUI.
 */

function toForwardSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Replace a leading home-directory prefix with `~`.
 *
 * @param path The absolute path to alias (native separators are accepted).
 * @param home The home directory to match against. Defaults to
 *   `os.homedir()`; injectable so callers/tests can be platform-deterministic.
 * @returns The forward-slash display path, with the home prefix replaced by
 *   `~` when it matches on a path-segment boundary.
 */
export function aliasHome(path: string, home: string = homedir()): string {
  if (!path) return path;
  const p = toForwardSlashes(path);
  const h = toForwardSlashes(home);
  if (!h) return p;
  if (p === h) return '~';
  if (p.startsWith(h + '/')) return '~' + p.slice(h.length);
  return p;
}
