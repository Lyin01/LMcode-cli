import { describe, expect, it } from 'vitest'

import {
  createCronJobArgsSchema,
  createSessionArgsSchema,
  parseIpcArgs,
  promptArgsSchema,
  setPermissionArgsSchema,
} from '../src/shared/ipc-schemas'

describe('IPC argument schemas (wire boundary contract)', () => {
  it('accepts a valid createSession payload', () => {
    const args = [{ workDir: 'C:/work', permission: 'auto' }]
    expect(parseIpcArgs(createSessionArgsSchema, args, 'lmcode:createSession')).toEqual(args)
  })

  it('rejects a createSession payload whose workDir is blank', () => {
    expect(() =>
      parseIpcArgs(createSessionArgsSchema, [{ workDir: '   ' }], 'lmcode:createSession'),
    ).toThrow(/project directory is required/)
  })

  it('accepts a no-project createSession payload without a workDir', () => {
    const args = [{ noProject: true }]
    expect(parseIpcArgs(createSessionArgsSchema, args, 'lmcode:createSession')).toEqual(args)
  })

  it('rejects combining noProject with a renderer-supplied workDir', () => {
    expect(() =>
      parseIpcArgs(
        createSessionArgsSchema,
        [{ noProject: true, workDir: 'C:/elsewhere' }],
        'lmcode:createSession',
      ),
    ).toThrow(/no-project/)
  })

  it('rejects an out-of-band permission mode', () => {
    expect(() =>
      parseIpcArgs(setPermissionArgsSchema, ['session-1', 'always'], 'lmcode:setPermission'),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('rejects a cron job with a blank cron expression', () => {
    expect(() =>
      parseIpcArgs(
        createCronJobArgsSchema,
        ['session-1', { cron: '   ', prompt: 'run tests' }],
        'lmcode:createCronJob',
      ),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('rejects a prompt request with a malformed attachment', () => {
    expect(() =>
      parseIpcArgs(
        promptArgsSchema,
        ['session-1', { text: 'hi', attachments: [{ source: 'path', kind: 'text' }] }],
        'lmcode:sendMessage',
      ),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('rejects a channel invoked with the wrong arity', () => {
    expect(() =>
      parseIpcArgs(createSessionArgsSchema, [], 'lmcode:createSession'),
    ).toThrow(/Invalid IPC arguments/)
  })
})
