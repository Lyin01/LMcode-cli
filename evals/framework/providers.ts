/**
 * Provider wiring builders for the two run modes.
 *
 * - `fakeProviderSetup`: a keyless `lmcode` provider pointed at a local stub
 *   server (see `fake-provider.ts`). Used by `smoke-plumbing`.
 * - `resolveRealModel`: reads env to build a real provider/model setup. Returns
 *   `undefined` (with a reason) when nothing is configured, so real-model tasks
 *   skip cleanly instead of failing.
 *
 * Env contract for real-model mode:
 *   LMCODE_EVAL_MODEL     model id to send to the provider (e.g. `gpt-4o-mini`,
 *                         `claude-sonnet-4-5`, `kimi-k2-...`). REQUIRED to run.
 *   LMCODE_EVAL_PROVIDER  provider type: anthropic | openai | openai_responses |
 *                         lmcode | google-genai. Default: `lmcode`.
 *   LMCODE_EVAL_API_KEY   API key for the provider. REQUIRED to run (never hardcoded).
 *   LMCODE_EVAL_BASE_URL  optional base URL override (e.g. self-hosted gateway).
 *   LMCODE_EVAL_MAX_CONTEXT  optional max context size; default 262144.
 */

import type { LmcodeConfigPatch } from '@lmcode-cli/lmcode-sdk';

import type { ProviderSetup } from './runner';

const FAKE_API_KEY = 'sk-eval-fake';

export function fakeProviderSetup(baseUrl: string): ProviderSetup {
  return {
    model: 'fake-model',
    config: {
      providers: {
        local: {
          type: 'lmcode',
          apiKey: FAKE_API_KEY,
          baseUrl,
        },
      },
      models: {
        'fake-model': {
          provider: 'local',
          model: 'fake-model',
          maxContextSize: 262144,
        },
      },
      defaultModel: 'fake-model',
    },
  };
}

type RealProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai_responses'
  | 'lmcode'
  | 'google-genai';

const SUPPORTED: readonly RealProviderType[] = [
  'anthropic',
  'openai',
  'openai_responses',
  'lmcode',
  'google-genai',
];

export interface RealModelResolution {
  readonly setup?: ProviderSetup;
  /** Present when the model could not be resolved; explains why (for SKIP). */
  readonly skipReason?: string;
}

export function resolveRealModel(env: NodeJS.ProcessEnv = process.env): RealModelResolution {
  const model = env['LMCODE_EVAL_MODEL']?.trim();
  const apiKey = env['LMCODE_EVAL_API_KEY']?.trim();
  if (!model || !apiKey) {
    return {
      skipReason:
        'real-model not configured — set LMCODE_EVAL_MODEL and LMCODE_EVAL_API_KEY ' +
        '(see evals/README.md)',
    };
  }

  const providerType = (env['LMCODE_EVAL_PROVIDER']?.trim() || 'lmcode') as RealProviderType;
  if (!SUPPORTED.includes(providerType)) {
    return {
      skipReason: `unsupported LMCODE_EVAL_PROVIDER "${providerType}" (expected one of: ${SUPPORTED.join(', ')})`,
    };
  }

  const baseUrl = env['LMCODE_EVAL_BASE_URL']?.trim();
  const maxContextRaw = env['LMCODE_EVAL_MAX_CONTEXT']?.trim();
  const maxContextSize = maxContextRaw ? Number(maxContextRaw) : 262144;
  if (!Number.isInteger(maxContextSize) || maxContextSize <= 0) {
    return { skipReason: `invalid LMCODE_EVAL_MAX_CONTEXT "${maxContextRaw}"` };
  }

  const config: LmcodeConfigPatch = {
    providers: {
      eval: {
        type: providerType,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      },
    },
    models: {
      'eval-model': {
        provider: 'eval',
        model,
        maxContextSize,
      },
    },
    defaultModel: 'eval-model',
  };

  return { setup: { model: 'eval-model', config } };
}
