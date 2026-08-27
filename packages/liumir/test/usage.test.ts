import type { ModelPricing, TokenUsage } from '#/usage';
import { addUsage, emptyUsage, grandTotal, inputTotal, usageCost } from '#/usage';
import { describe, expect, it } from 'vitest';

describe('emptyUsage', () => {
  it('returns all zeros', () => {
    const usage = emptyUsage();
    expect(usage.inputOther).toBe(0);
    expect(usage.output).toBe(0);
    expect(usage.inputCacheRead).toBe(0);
    expect(usage.inputCacheCreation).toBe(0);
  });
});

describe('inputTotal', () => {
  it('sums all input fields', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 30,
    };
    expect(inputTotal(usage)).toBe(330);
  });

  it('returns 0 for empty usage', () => {
    expect(inputTotal(emptyUsage())).toBe(0);
  });
});

describe('grandTotal', () => {
  it('sums input total and output', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 30,
    };
    expect(grandTotal(usage)).toBe(380);
  });

  it('returns 0 for empty usage', () => {
    expect(grandTotal(emptyUsage())).toBe(0);
  });
});

describe('addUsage', () => {
  it('sums two usage values', () => {
    const a: TokenUsage = {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    };
    const b: TokenUsage = {
      inputOther: 5,
      output: 15,
      inputCacheRead: 25,
      inputCacheCreation: 35,
    };
    const result = addUsage(a, b);
    expect(result.inputOther).toBe(15);
    expect(result.output).toBe(35);
    expect(result.inputCacheRead).toBe(55);
    expect(result.inputCacheCreation).toBe(75);
  });

  it('adding empty usage returns the other', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    };
    const result = addUsage(usage, emptyUsage());
    expect(result).toEqual(usage);
  });
});

describe('usageCost', () => {
  const usage: TokenUsage = {
    inputOther: 1_000_000,
    output: 500_000,
    inputCacheRead: 2_000_000,
    inputCacheCreation: 250_000,
  };

  it('returns undefined when no pricing is provided', () => {
    expect(usageCost(usage, undefined)).toBeUndefined();
  });

  it('returns 0 for empty usage with pricing', () => {
    const pricing: ModelPricing = { input: 3, output: 15 };
    expect(usageCost(emptyUsage(), pricing)).toBe(0);
  });

  it('prices input and output per million tokens', () => {
    const pricing: ModelPricing = { input: 3, output: 15 };
    // input billed at 3/M: (1M other + 2M cacheRead + 0.25M cacheWrite) * 3
    //   = 3.25M * 3 = 9.75; output 0.5M * 15 = 7.5 -> 17.25
    expect(usageCost(usage, pricing)).toBeCloseTo(17.25, 10);
  });

  it('uses dedicated cache rates when provided', () => {
    const pricing: ModelPricing = {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    };
    // other 1M*3 = 3
    // cacheRead 2M*0.3 = 0.6
    // cacheWrite 0.25M*3.75 = 0.9375
    // output 0.5M*15 = 7.5
    expect(usageCost(usage, pricing)).toBeCloseTo(3 + 0.6 + 0.9375 + 7.5, 10);
  });

  it('falls back to the input rate when only one cache rate is set', () => {
    const pricing: ModelPricing = { input: 3, output: 15, cacheRead: 0.3 };
    // cacheWrite falls back to input rate (3)
    // other 1M*3=3, cacheRead 2M*0.3=0.6, cacheWrite 0.25M*3=0.75, output 0.5M*15=7.5
    expect(usageCost(usage, pricing)).toBeCloseTo(3 + 0.6 + 0.75 + 7.5, 10);
  });

  it('handles fractional sub-million token counts', () => {
    const pricing: ModelPricing = { input: 2, output: 6 };
    const small: TokenUsage = {
      inputOther: 1_500,
      output: 500,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    // 1500/1e6*2 + 500/1e6*6 = 0.003 + 0.003 = 0.006
    expect(usageCost(small, pricing)).toBeCloseTo(0.006, 12);
  });
});
