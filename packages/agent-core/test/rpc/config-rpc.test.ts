import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { createRPC, LmcodeCore, type CoreAPI, type SDKAPI } from '../../src';
import { readConfigFile } from '../../src/config';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

const CONFIG_TOML = `default_model = "alpha"
utility_model = "beta"

[providers.test]
type = "lmcode"
api_key = "test-key"

[models.alpha]
provider = "test"
model = "alpha-model"
max_context_size = 100000

[models.beta]
provider = "test"
model = "beta-model"
max_context_size = 100000

[models.gamma]
provider = "test"
model = "gamma-model"
max_context_size = 100000
`;

async function createCore(): Promise<LmcodeCore> {
  const homeDir = await mkdtemp(join(tmpdir(), 'lmcode-core-config-rpc-'));
  tempDirs.push(homeDir);
  await writeFile(join(homeDir, 'config.toml'), CONFIG_TOML);
  const [coreRpc] = createRPC<CoreAPI, SDKAPI>();
  return new LmcodeCore(coreRpc, { homeDir });
}

describe('LmcodeCore removeModel', () => {
  it('removes the alias and persists the change without touching other models or defaults', async () => {
    const core = await createCore();

    const config = await core.removeModel({ modelId: 'gamma' });

    expect(config.models?.['gamma']).toBeUndefined();
    expect(Object.keys(config.models ?? {}).sort()).toEqual(['alpha', 'beta']);
    expect(config.defaultModel).toBe('alpha');
    expect(config.utilityModel).toBe('beta');

    const onDisk = readConfigFile(core.configPath);
    expect(onDisk.models?.['gamma']).toBeUndefined();
    expect(Object.keys(onDisk.models ?? {}).sort()).toEqual(['alpha', 'beta']);
  });

  it('clears defaultModel and utilityModel that point at the removed alias', async () => {
    const core = await createCore();

    const afterAlpha = await core.removeModel({ modelId: 'alpha' });
    expect(afterAlpha.models?.['alpha']).toBeUndefined();
    expect(afterAlpha.defaultModel).toBeUndefined();
    expect(afterAlpha.utilityModel).toBe('beta');

    const afterBeta = await core.removeModel({ modelId: 'beta' });
    expect(afterBeta.models?.['beta']).toBeUndefined();
    expect(afterBeta.utilityModel).toBeUndefined();

    const onDisk = readConfigFile(core.configPath);
    expect(onDisk.defaultModel).toBeUndefined();
    expect(onDisk.utilityModel).toBeUndefined();
  });
});
