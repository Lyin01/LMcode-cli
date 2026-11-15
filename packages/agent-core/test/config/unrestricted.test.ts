import { describe, expect, it } from 'vitest';
import { isUnrestrictedMode } from '../../src/config/unrestricted';

describe('isUnrestrictedMode', () => {
  it('默认关闭（库自身不加锁）', () => {
    expect(isUnrestrictedMode({})).toBe(false);
  });

  it('LMCODE_UNRESTRICTED=1 打开', () => {
    expect(isUnrestrictedMode({ LMCODE_UNRESTRICTED: '1' })).toBe(true);
    expect(isUnrestrictedMode({ LMCODE_UNRESTRICTED: 'true' })).toBe(true);
    expect(isUnrestrictedMode({ LMCODE_UNRESTRICTED: 'ON' })).toBe(true);
  });

  it('0 / false / off / no 关闭', () => {
    for (const value of ['0', 'false', 'off', 'no', ' FALSE ']) {
      expect(isUnrestrictedMode({ LMCODE_UNRESTRICTED: value })).toBe(false);
    }
  });

  it('空字符串按默认（关闭）处理', () => {
    expect(isUnrestrictedMode({ LMCODE_UNRESTRICTED: '' })).toBe(false);
  });
});
