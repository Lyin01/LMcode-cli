/**
 * Environment forwarded to spawned helper processes (MCP stdio servers,
 * language servers). Passing `process.env` wholesale leaks API keys and
 * tokens into third-party children.
 *
 * Explicit `overrides` always win, including on Windows where inherited
 * keys may differ only by case.
 */
const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_PATH',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'DISPLAY',
  'SYSTEMROOT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMDRIVE',
  'WINDIR',
  'PROGRAMDATA',
  'OS',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_DIRS',
  'DBUS_SESSION_BUS_ADDRESS',
  'WAYLAND_DISPLAY',
]);

function isEnvAllowed(key: string): boolean {
  const comparableKey = process.platform === 'win32' ? key.toUpperCase() : key;
  return ALLOWED_ENV_KEYS.has(comparableKey);
}

export function mergeSpawnEnv(overrides?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isEnvAllowed(key)) merged[key] = value;
  }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (process.platform === 'win32') {
        const comparableKey = key.toUpperCase();
        const inheritedKey = Object.keys(merged).find(
          (candidate) => candidate.toUpperCase() === comparableKey,
        );
        if (inheritedKey !== undefined) delete merged[inheritedKey];
      }
      merged[key] = value;
    }
  }
  return merged;
}
