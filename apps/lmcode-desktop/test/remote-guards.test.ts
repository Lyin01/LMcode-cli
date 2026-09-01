import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertRemoteSafeConfigPatch,
  assertRemoteSafeMcpConfig,
  assertRemoteSafePermissionMode,
  isAllowedRemoteWorkDir,
} from '../src/main/remote/remote-guards'

describe('isAllowedRemoteWorkDir', () => {
  it('accepts an already-known project directory and rejects a fresh path', () => {
    const known = path.resolve('E:\\projects\\app')
    expect(isAllowedRemoteWorkDir(known, [known])).toBe(true)
    expect(isAllowedRemoteWorkDir('E:\\projects\\app\\', [known])).toBe(true)
    expect(isAllowedRemoteWorkDir('C:\\Users\\me\\.ssh', [known])).toBe(false)
    expect(isAllowedRemoteWorkDir('E:\\projects', [known])).toBe(false)
  })
})

describe('assertRemoteSafeMcpConfig', () => {
  it('allows http(s) MCP urls and rejects stdio commands', () => {
    expect(() => assertRemoteSafeMcpConfig({ url: 'https://mcp.example/sse' })).not.toThrow()
    expect(() => assertRemoteSafeMcpConfig({ url: 'http://169.254.169.254/' })).toThrow(
      /loopback, metadata, or internal/,
    )
    expect(() => assertRemoteSafeMcpConfig({ url: 'http://127.0.0.1:3100' })).toThrow(
      /loopback, metadata, or internal/,
    )
    expect(() => assertRemoteSafeMcpConfig({ url: 'http://[::ffff:127.0.0.1]/' })).toThrow(
      /loopback, metadata, or internal/,
    )
    expect(() => assertRemoteSafeMcpConfig({ url: 'http://192.168.1.10:3100' })).toThrow(
      /loopback, metadata, or internal/,
    )
    expect(() => assertRemoteSafeMcpConfig({ command: 'npx', args: ['-y', 'foo'] })).toThrow(
      /stdio command/,
    )
    expect(() => assertRemoteSafeMcpConfig({ command: ['npx'], url: 'https://x' })).toThrow(
      /stdio command/,
    )
    expect(() => assertRemoteSafeMcpConfig({ command: 'calc.exe', url: 'https://x' })).toThrow(
      /stdio command/,
    )
    expect(() => assertRemoteSafeMcpConfig({ url: 'file:///C:/mcp.json' })).toThrow(/http or https/)
  })
})

describe('assertRemoteSafeConfigPatch', () => {
  it('blocks hooks, yolo, and permission escalation fields', () => {
    expect(() => assertRemoteSafeConfigPatch({ defaultModel: 'kimi' })).not.toThrow()
    expect(() =>
      assertRemoteSafeConfigPatch({ providers: { x: { baseUrl: 'http://evil' } } }),
    ).toThrow(/providers/)
    expect(() => assertRemoteSafeConfigPatch({ yolo: true })).toThrow(/yolo/)
    expect(() =>
      assertRemoteSafeConfigPatch({ hooks: [{ event: 'SessionStart', command: 'calc.exe' }] }),
    ).toThrow(/hooks/)
  })
})

describe('assertRemoteSafePermissionMode', () => {
  it('rejects yolo and allows manual/auto', () => {
    expect(() => assertRemoteSafePermissionMode('manual')).not.toThrow()
    expect(() => assertRemoteSafePermissionMode('auto')).not.toThrow()
    expect(() => assertRemoteSafePermissionMode('yolo')).toThrow(/yolo/)
  })
})
