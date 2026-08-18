import { describe, expect, it } from 'vitest';

import { resolveRealModel } from './providers';

describe('resolveRealModel', () => {

  it('skips when model or key is missing', () => {
    expect(resolveRealModel({}).skipReason).toMatch(/LMCODE_EVAL_MODEL/);
    expect(
      resolveRealModel({
        LMCODE_EVAL_MODEL: 'gpt-4o-mini',
      }).skipReason,
    ).toMatch(/LMCODE_EVAL_API_KEY/);
  });

  it('skips when the context window is unset', () => {
    const resolved = resolveRealModel({
      LMCODE_EVAL_MODEL: 'gpt-4o-mini',
      LMCODE_EVAL_API_KEY: 'sk-test',
      LMCODE_EVAL_PROVIDER: 'openai',
    });
    expect(resolved.setup).toBeUndefined();
    expect(resolved.skipReason).toMatch(/LMCODE_EVAL_MAX_CONTEXT/);
  });

  it('uses an explicit context window', () => {
    const resolved = resolveRealModel({
      LMCODE_EVAL_MODEL: 'gpt-4o-mini',
      LMCODE_EVAL_API_KEY: 'sk-test',
      LMCODE_EVAL_PROVIDER: 'openai',
      LMCODE_EVAL_MAX_CONTEXT: '128000',
    });
    expect(resolved.setup?.config.models?.['eval-model']?.maxContextSize).toBe(128000);
  });
});
