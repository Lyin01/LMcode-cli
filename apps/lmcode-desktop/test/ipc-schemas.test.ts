import { describe, expect, it } from 'vitest'

import {
  activateSkillArgsSchema,
  createCronJobArgsSchema,
  createSessionArgsSchema,
  compactSessionArgsSchema,
  openExternalArgsSchema,
  openPathArgsSchema,
  parseIpcArgs,
  promptArgsSchema,
  searchMemoriesArgsSchema,
  sessionNamedArgsSchema,
  setAllGitFilesStagedArgsSchema,
  setPermissionArgsSchema,
  setRemotePortArgsSchema,
  undoHistoryArgsSchema,
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

  it('rejects a stringy boolean for staging every git file', () => {
    expect(
      parseIpcArgs(setAllGitFilesStagedArgsSchema, ['session-1', true], 'lmcode:setAllGitFilesStaged'),
    ).toEqual(['session-1', true])
    expect(() =>
      parseIpcArgs(
        setAllGitFilesStagedArgsSchema,
        ['session-1', 'false'],
        'lmcode:setAllGitFilesStaged',
      ),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('accepts compactSession with or without an instruction', () => {
    expect(parseIpcArgs(compactSessionArgsSchema, ['session-1'], 'lmcode:compactSession')).toEqual([
      'session-1',
    ])
    expect(
      parseIpcArgs(compactSessionArgsSchema, ['session-1', 'keep decisions'], 'lmcode:compactSession'),
    ).toEqual(['session-1', 'keep decisions'])
  })

  it('rejects a non-positive undo count', () => {
    expect(() =>
      parseIpcArgs(undoHistoryArgsSchema, ['session-1', 0], 'lmcode:undoHistory'),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('accepts activateSkill with or without optional args', () => {
    expect(
      parseIpcArgs(activateSkillArgsSchema, ['session-1', 'dream'], 'lmcode:activateSkill'),
    ).toEqual(['session-1', 'dream'])
    expect(
      parseIpcArgs(
        activateSkillArgsSchema,
        ['session-1', 'dream', 'focus on tags'],
        'lmcode:activateSkill',
      ),
    ).toEqual(['session-1', 'dream', 'focus on tags'])
    expect(() =>
      parseIpcArgs(activateSkillArgsSchema, ['session-1', '  '], 'lmcode:activateSkill'),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('rejects a blank MCP/skill name and an oversized memory search', () => {
    expect(() =>
      parseIpcArgs(sessionNamedArgsSchema, ['session-1', '  '], 'lmcode:stopMcpServer'),
    ).toThrow(/Invalid IPC arguments/)
    expect(() =>
      parseIpcArgs(searchMemoriesArgsSchema, ['x'.repeat(4_001)], 'lmcode:searchMemories'),
    ).toThrow(/Invalid IPC arguments/)
  })

  it('rejects a remote port outside the allowed range', () => {
    expect(parseIpcArgs(setRemotePortArgsSchema, [37_991], 'lmcode:setRemotePort')).toEqual([37_991])
    expect(() => parseIpcArgs(setRemotePortArgsSchema, [80], 'lmcode:setRemotePort')).toThrow(
      /Invalid IPC arguments/,
    )
  })

  it('requires openPath and openExternal to receive a string', () => {
    expect(parseIpcArgs(openPathArgsSchema, ['C:/repo/out.html'], 'lmcode:openPath')).toEqual([
      'C:/repo/out.html',
    ])
    expect(() => parseIpcArgs(openPathArgsSchema, [null], 'lmcode:openPath')).toThrow(
      /Invalid IPC arguments/,
    )
    expect(parseIpcArgs(openExternalArgsSchema, ['https://example.com'], 'lmcode:openExternal')).toEqual([
      'https://example.com',
    ])
  })
})
