import { describe, it, expect } from 'vitest';
import { EchoChatProvider } from './fixtures/echo-provider';
import { createUserMessage } from '#/message';
import {
  createProvider,
  hasProvider,
  listProviderTypes,
  registerProvider,
} from '#/providers/index';
import { ProviderRegistry } from '#/providers/registry';

const BUILT_IN_TYPES = [
  'anthropic',
  'openai',
  'lmcode',
  'google-genai',
  'openai_responses',
  'vertexai',
] as const;

describe('ProviderRegistry（独立实例）', () => {
  it('register 后 create 调用同一工厂并传入原样 config', () => {
    const registry = new ProviderRegistry();
    registry.register<{ model: string }>('custom', (config) => {
      expect(config.model).toBe('m1');
      return new EchoChatProvider();
    });
    const provider = registry.create('custom', { model: 'm1' });
    expect(provider).toBeInstanceOf(EchoChatProvider);
  });

  it('create 未注册 type 抛 Unknown provider type', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.create('missing', {})).toThrow(/Unknown provider type: missing/);
  });

  it('重复注册同名 type 抛错而非静默覆盖', () => {
    const registry = new ProviderRegistry();
    registry.register('dup', () => new EchoChatProvider());
    expect(() => registry.register('dup', () => new EchoChatProvider())).toThrow(
      /already registered/,
    );
  });

  it('has 与 types 反映注册状态与顺序', () => {
    const registry = new ProviderRegistry();
    expect(registry.has('a')).toBe(false);
    registry.register('a', () => new EchoChatProvider());
    registry.register('b', () => new EchoChatProvider());
    expect(registry.has('a')).toBe(true);
    expect(registry.types()).toEqual(['a', 'b']);
  });
});

describe('全局 provider 注册表（内置 + 扩展点）', () => {
  it('内置 6 种 provider type 全部注册', () => {
    for (const type of BUILT_IN_TYPES) {
      expect(hasProvider(type)).toBe(true);
    }
    expect(listProviderTypes()).toContain('anthropic');
    expect(listProviderTypes()).toContain('vertexai');
  });

  it('createProvider 可创建内置 provider 且不触发网络', () => {
    const provider = createProvider({ type: 'anthropic', model: 'claude-test' });
    expect(provider.name).toBe('anthropic');
    expect(provider.modelName).toBe('claude-test');
  });

  it('createProvider 未注册 type 抛 Unknown provider type', () => {
    expect(() => createProvider({ type: 'does-not-exist', model: 'x' } as never)).toThrow(
      /Unknown provider type: does-not-exist/,
    );
  });

  it('重复注册内置 type 抛错', () => {
    expect(() => registerProvider('anthropic', () => new EchoChatProvider())).toThrow(
      /already registered/,
    );
  });

  it('registerProvider 注册的自定义 provider 可端到端生成', async () => {
    registerProvider('echo-end-to-end', () => new EchoChatProvider());
    const provider = createProvider({ type: 'echo-end-to-end', model: 'unused' } as never);
    const stream = await provider.generate('', [], [createUserMessage('text: hello')]);
    const parts: unknown[] = [];
    for await (const part of stream) {
      parts.push(part);
    }
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
