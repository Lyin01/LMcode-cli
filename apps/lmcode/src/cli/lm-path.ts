import { execSync } from "node:child_process";

/**
 * The shell command that resolves the `lm` executable on PATH.
 *
 * Windows cmd.exe has no `which` and cannot redirect to `/dev/null`, so the
 * POSIX form throws there. This lookup is centralized so the call sites
 * (channel-setup, cc-connect) cannot silently drift apart again — a past
 * divergence left channel-setup running the POSIX form on Windows, where it
 * always failed and skipped PATH resolution entirely.
 *
 * @param platform Defaults to the current platform; injectable for tests.
 */
export function lmPathLookupCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "where lm" : "which lm 2>/dev/null";
}

/**
 * Resolve the first `lm` executable found on PATH, or `undefined` if none.
 *
 * Windows `where` can return multiple matches (one per line); the first is
 * taken since the result feeds single-line TOML / display strings. Any lookup
 * failure (not found, command error) resolves to `undefined`.
 */
export function resolveLmOnPath(): string | undefined {
  try {
    const out = execSync(lmPathLookupCommand(), { encoding: "utf-8", timeout: 3000 }).trim();
    const first = out.split(/[\r\n]+/)[0]?.trim() ?? "";
    return first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}
