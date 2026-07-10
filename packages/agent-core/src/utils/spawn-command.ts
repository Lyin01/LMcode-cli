/**
 * Windows adaptation for spawning external commands with `shell: false`.
 *
 * Node/libuv cannot execute the `.cmd`/`.bat` shims that npm-installed CLIs
 * resolve to (`npx`, `typescript-language-server`, `pyright-langserver`, …):
 * PATH lookup only appends `.exe`, never the PATHEXT shims, so
 * `spawn('npx')` fails with ENOENT on Windows. Wrapping the command in
 * `cmd.exe /c` lets PATHEXT resolution run. Direct `.exe` targets and every
 * non-Windows platform pass through unchanged.
 *
 * Shared by the MCP stdio client and the LSP client so the two spawn paths
 * cannot drift apart (a past `which`-vs-`where` divergence in the CLI came
 * from exactly this kind of copy).
 */

/**
 * Map a Jian `Environment.osKind` ('Windows' | 'Linux' | 'macOS' | raw
 * platform string) to the NodeJS.Platform this module branches on. Use this
 * when the command will run inside a Jian, whose host OS may differ from the
 * local `process.platform`.
 */
export function platformFromOsKind(osKind: string): NodeJS.Platform {
  return osKind === 'Windows' ? 'win32' : 'linux';
}

/**
 * Adapt a command + args for spawning on Windows.
 *
 * Args are forwarded to `cmd.exe` without metacharacter escaping (`&`, `|`,
 * `<`, `>`, `^`); this mirrors common MCP-client behavior and is safe for the
 * usual command / flag / path arguments found in server configs.
 */
export function adaptSpawnCommandForWindows(
  command: string,
  args: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const argv = args === undefined ? [] : [...args];
  if (platform !== 'win32' || /\.exe$/i.test(command)) {
    return { command, args: argv };
  }
  const comspec = process.env['ComSpec'] ?? 'cmd.exe';
  return { command: comspec, args: ['/c', command, ...argv] };
}
