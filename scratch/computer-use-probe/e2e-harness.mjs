// Session-level probe for desktop computer use, run through the public SDK the
// desktop app uses: a real config.toml, a real harness, a real session, and the
// installed Cua Driver. Verifies the wiring the desktop settings toggle relies
// on — config enables the capability at session start, the live toggle applies
// without recreating the session, and teardown releases the provider slot.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('E:/lmcode-desktop-source/packages/node-sdk/package.json');
const { LmcodeHarness } = require('E:/lmcode-desktop-source/packages/node-sdk/dist/index.mjs');

const driverPath = process.argv[2];
const workDir = process.argv[3] ?? process.cwd();
if (driverPath === undefined) throw new Error('usage: node e2e-harness.mjs <driver path> [workDir]');

const home = join(tmpdir(), `lmcode-cu-${Date.now()}`);
mkdirSync(home, { recursive: true });
const configPath = join(home, 'config.toml');
writeFileSync(
  configPath,
  [
    '[computer_use]',
    'enabled = true',
    `command = ${JSON.stringify(driverPath)}`,
    'args = ["mcp"]',
    'permission_mode = "standard"',
    '',
  ].join('\n'),
  'utf8',
);

const harness = new LmcodeHarness({ homeDir: home, configPath, uiMode: 'desktop' });
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function pollUntil(read, settled, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (settled(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

try {
  const session = await harness.createSession({ workDir });

  // Config-driven activation runs alongside session startup, exactly like the
  // MCP server load: a client that polls immediately sees `starting` and must
  // observe the settled state rather than assume the capability is missing.
  const initial = await pollUntil(
    () => session.getComputerUseStatus(),
    (status) => status.phase !== 'starting',
  );
  check('config enables computer use at session start', initial.phase === 'active', `phase=${initial.phase} error=${initial.error ?? 'none'}`);
  check('provider registered under its own name', initial.providerId === 'cua-driver-mcp');
  check('driver tool catalog reached the session', initial.toolCount > 10, `toolCount=${initial.toolCount}`);
  check('permission mode carried from config', initial.permissionMode === 'standard');

  const off = await session.setComputerUseEnabled(false);
  check('live toggle releases the capability', off.phase === 'idle', `phase=${off.phase}`);
  check('no tools served after release', off.toolCount === 0, `toolCount=${off.toolCount}`);

  const on = await session.setComputerUseEnabled(true);
  check('live toggle re-activates without a new session', on.phase === 'active', `phase=${on.phase}`);
  check('catalog restored', on.toolCount > 10, `toolCount=${on.toolCount}`);

  await session.close();
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
} finally {
  await harness.close();
  rmSync(home, { recursive: true, force: true });
}

process.exitCode = failures === 0 ? 0 : 1;
