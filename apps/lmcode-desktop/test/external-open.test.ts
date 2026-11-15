import { describe, expect, it } from 'vitest'

import { parseExternalOpenTarget } from '../src/shared/security'
import { parseIpcArgs, setMcpToolPolicyArgsSchema } from '../src/shared/ipc-schemas'

describe('parseExternalOpenTarget', () => {
  it('accepts https links and trims whitespace', () => {
    expect(parseExternalOpenTarget('  https://github.com/Lyin01/LMcode-cli  ')).toBe(
      'https://github.com/Lyin01/LMcode-cli',
    )
  })

  it('accepts mailto links', () => {
    expect(parseExternalOpenTarget('mailto:hello@example.com')).toBe('mailto:hello@example.com')
  })

  it('keeps the query and fragment of an https link', () => {
    expect(parseExternalOpenTarget('https://example.com/a?b=1#c')).toBe(
      'https://example.com/a?b=1#c',
    )
  })

  it.each([
    'http://example.com',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-msdt:/id',
    'vbscript:msgbox(1)',
    'lmcode://open',
    'https://user:pass@example.com',
    'https://',
    '',
    '   ',
    'not a url',
  ])('refuses %s', (candidate) => {
    expect(parseExternalOpenTarget(candidate)).toBeUndefined()
  })

  it('refuses oversized payloads', () => {
    expect(parseExternalOpenTarget(`https://example.com/${'a'.repeat(4_096)}`)).toBeUndefined()
  })
})

describe('setMcpToolPolicyArgsSchema', () => {
  it('accepts a policy object', () => {
    expect(
      parseIpcArgs(
        setMcpToolPolicyArgsSchema,
        ['session-1', 'github', { default: 'ask', tools: { create_issue: 'blocked' } }],
        'lmcode:setMcpToolPolicy',
      ),
    ).toEqual(['session-1', 'github', { default: 'ask', tools: { create_issue: 'blocked' } }])
  })

  it('accepts null to clear the policy', () => {
    expect(
      parseIpcArgs(setMcpToolPolicyArgsSchema, ['session-1', 'github', null], 'x'),
    ).toEqual(['session-1', 'github', null])
  })

  it('rejects unknown tiers and empty server names', () => {
    expect(() =>
      parseIpcArgs(setMcpToolPolicyArgsSchema, ['session-1', 'github', { default: 'deny' }], 'x'),
    ).toThrow()
    expect(() => parseIpcArgs(setMcpToolPolicyArgsSchema, ['session-1', '  ', null], 'x')).toThrow()
  })
})
