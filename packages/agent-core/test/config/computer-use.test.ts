import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LmcodeConfigSchema,
  LmcodeConfigPatchSchema,
  parseConfigString,
  readConfigFile,
  writeConfigFile,
} from '../../src/config';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lmcode-computer-use-config-'));
  tempDirs.push(dir);
  return join(dir, 'config.toml');
}

const COMPUTER_USE_TOML = `
[computer_use]
enabled = true
provider = "cua-driver-mcp"
command = "C:\\\\Tools\\\\cua-driver.exe"
args = ["mcp"]
permission_mode = "bounded"
`;

describe('computer use config section', () => {
  it('reads the section into the typed config', () => {
    const config = parseConfigString(COMPUTER_USE_TOML, 'config.toml');

    expect(config.computerUse).toEqual({
      enabled: true,
      provider: 'cua-driver-mcp',
      command: 'C:\\Tools\\cua-driver.exe',
      args: ['mcp'],
      permissionMode: 'bounded',
    });
  });

  it('defaults to disabled when the section only names a provider', () => {
    const config = LmcodeConfigSchema.parse({ computerUse: {} });

    expect(config.computerUse?.enabled).toBe(false);
  });

  it('survives a write and read round trip', async () => {
    const configPath = tempConfigPath();
    const config = parseConfigString(COMPUTER_USE_TOML, configPath);

    await writeConfigFile(configPath, config);
    const reread = readConfigFile(configPath);

    // The section has to reach disk as snake_case `[computer_use]`; a missing
    // serialization entry would silently drop it and the toggle would revert
    // on the next launch.
    expect(reread.computerUse).toEqual(config.computerUse);
  });

  it('accepts the camelCase patch shape the settings UI sends', () => {
    const patch = LmcodeConfigPatchSchema.parse({
      computerUse: { enabled: true, permissionMode: 'bounded' },
    });

    expect(patch.computerUse).toEqual({ enabled: true, permissionMode: 'bounded' });
  });
});
