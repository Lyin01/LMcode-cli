/**
 * Global-install detection for the postinstall hook.
 *
 * The hook must only act on true global installs; local installs,
 * `npx`, `pnpm dlx`, and workspace bootstraps must stay silent
 * no-ops. Detection is purely in-band via the environment the package
 * manager sets for lifecycle scripts:
 *
 *   - npm ≥ 7: `npm_config_location=global` (and older npm sets
 *     `npm_config_global=true`).
 *   - pnpm: `pnpm_config_global=true` (pnpm also mirrors
 *     `npm_config_global` on recent versions).
 *   - yarn classic (v1.x): neither of the above; the only reliable
 *     signal is the original command line in `npm_config_argv` — see
 *     `isYarnClassicGlobalAdd`. Verified on yarn 1.22.22.
 *
 * Yarn berry (v2+) intentionally has no global-install concept, so it
 * doesn't matter here: postinstall on yarn berry runs in local context.
 */

export function isGlobalInstall() {
  return (
    process.env['npm_config_global'] === 'true' ||
    process.env['pnpm_config_global'] === 'true' ||
    process.env['npm_config_location'] === 'global' ||
    isYarnClassicGlobalAdd()
  );
}

/**
 * `yarn global add` (yarn classic, v1.x) runs lifecycle scripts but
 * leaves both `npm_config_global` and `npm_config_location` unset.
 * The only reliable in-band signal is `npm_config_argv`, which yarn
 * populates with the original command line as JSON:
 *   { original: ["global", "add", "<pkg>", "--prefix=..."] }
 * Parse it and require both:
 *   - `npm_config_user_agent` starts with `yarn/1.` (yarn classic;
 *     yarn berry has no global concept anyway).
 *   - Some token in argv is literally `"global"` AND the very next
 *     token is a known yarn-global subcommand (`add`, `remove`,
 *     etc). This handles the simple case (`yarn global add foo` →
 *     argv `["global","add",...]`) and the value-taking-flag case
 *     (`yarn --cwd /tmp global add foo` → argv `["--cwd","/tmp",
 *     "global","add",...]`) without having to maintain yarn's full
 *     flag table. It rejects `yarn add global` (the next token is
 *     undefined) and `yarn add @scope/global` (the literal string
 *     `"global"` doesn't appear).
 */
function isYarnClassicGlobalAdd() {
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (!ua.startsWith('yarn/1.')) return false;
  const raw = process.env['npm_config_argv'];
  if (!raw) return false;
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(argv?.original)) return false;
  const globalIdx = argv.original.indexOf('global');
  if (globalIdx === -1) return false;
  const next = argv.original[globalIdx + 1];
  return typeof next === 'string' && YARN_GLOBAL_SUBCOMMANDS.has(next);
}

// Yarn 1.x global subcommands. The install-class ones (`add`,
// `upgrade`, `upgrade-interactive`) are the ones that actually run
// our postinstall, but the read-only ones are included so the
// detection is consistent across all `yarn global ...` invocations.
const YARN_GLOBAL_SUBCOMMANDS = new Set([
  'add',
  'remove',
  'upgrade',
  'upgrade-interactive',
  'list',
  'bin',
  'dir',
]);
