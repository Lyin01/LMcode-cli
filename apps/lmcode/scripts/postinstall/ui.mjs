/**
 * User-facing output for the postinstall hook.
 *
 * npm 7+ captures lifecycle stdout/stderr by default, so a plain
 * `console.log` here would be invisible to a user running
 * `npm install -g`. `notify` writes directly to the platform's
 * terminal device to bypass the manager's capture, falling back to
 * stdout (ANSI-stripped) so the message is still preserved in npm's
 * lifecycle log under `~/.npm/_logs/` in CI / non-TTY contexts.
 */

import { writeFileSync } from 'node:fs';

const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s) {
  return s.replace(ANSI_ESCAPE, '');
}

// Platform-specific path to the controlling terminal device. On POSIX
// it's `/dev/tty`; on Windows it's the special filename `CON`, which
// Node resolves to the console device. (The fully-qualified `\\.\CON`
// form looks equivalent but Node appends a trailing backslash that
// breaks the open call — confirmed empirically on Windows 11 /
// Node 22.)
const TERMINAL_DEVICE = process.platform === 'win32' ? 'CON' : '/dev/tty';

export function notify(line) {
  const text = line + '\n';
  try {
    writeFileSync(TERMINAL_DEVICE, text);
    return;
  } catch {
    // Terminal device not writable (CI, sandboxed environments).
  }
  process.stdout.write(stripAnsi(text));
}
