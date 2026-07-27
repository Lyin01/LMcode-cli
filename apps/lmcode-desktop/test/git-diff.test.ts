import { describe, expect, it } from 'vitest'
import { parseGitDiff } from '../src/renderer/lib/git-diff'

describe('unified Git diff parsing', () => {
  it('projects old and new line numbers across additions and deletions', () => {
    const parsed = parseGitDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,3 +10,4 @@ function run() {',
      ' keep()',
      '-oldCall()',
      '+newCall()',
      '+extraCall()',
      ' done()',
    ].join('\n'))

    expect(parsed.metadata.map((line) => line.content)).toEqual([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
    ])
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]).toMatchObject({
      index: 0,
      oldStart: 10,
      oldCount: 3,
      newStart: 10,
      newCount: 4,
      context: 'function run() {',
    })
    expect(parsed.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 10, 10],
      ['deletion', 11, null],
      ['addition', null, 11],
      ['addition', null, 12],
      ['context', 12, 13],
    ])
  })

  it('keeps hunk indexes aligned with Git apply actions and handles no-newline markers', () => {
    const parsed = parseGitDiff([
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      '\\ No newline at end of file',
      '@@ -8,0 +9,2 @@ second',
      '+nine',
      '+ten',
      '',
    ].join('\r\n'))

    expect(parsed.hunks.map((hunk) => hunk.index)).toEqual([0, 1])
    expect(parsed.hunks[0]?.lines.at(-1)).toMatchObject({
      kind: 'annotation',
      oldLine: null,
      newLine: null,
    })
    expect(parsed.hunks[1]).toMatchObject({ oldCount: 0, newStart: 9, newCount: 2 })
  })
})
