import { describe, expect, it } from 'vitest'

import {
  buildUpdaterFeed,
  extractReleaseNotes,
  parseArguments,
} from '../scripts/complete-release.mjs'

/**
 * The updater feed is what every installed client polls to discover a new
 * version, so its shape and its digests are a real external contract. A feed
 * that describes a different build than the published installer is the failure
 * that motivated deriving it from the artifact instead of reusing a file left
 * behind by a previous release.
 */
describe('buildUpdaterFeed', () => {
  it('writes the fields electron-updater reads, in its expected shape', () => {
    const feed = buildUpdaterFeed({
      version: '9.9.9',
      fileName: 'LMCODE-Setup-9.9.9.exe',
      sha512: 'digest==',
      size: 1234,
      releaseDate: '2026-01-02T03:04:05.000Z',
    })

    expect(feed).toBe(
      [
        'version: 9.9.9',
        'files:',
        '  - url: LMCODE-Setup-9.9.9.exe',
        '    sha512: digest==',
        '    size: 1234',
        'path: LMCODE-Setup-9.9.9.exe',
        'sha512: digest==',
        "releaseDate: '2026-01-02T03:04:05.000Z'",
        '',
      ].join('\n'),
    )
  })
})

/**
 * The release body comes from the README's version section. Losing that means
 * shipping a blank release page, and leaking the next section means publishing
 * an older version's notes as if they were new.
 */
describe('extractReleaseNotes', () => {
  const README = [
    '# LMCODE Desktop',
    '',
    'Intro line.',
    '',
    '## 0.9.0',
    '',
    'Paragraph one.',
    '',
    'Paragraph two.',
    '',
    '## 0.8.2',
    '',
    'Old paragraph.',
    '',
  ].join('\n')

  it('returns exactly the requested version section', () => {
    expect(extractReleaseNotes(README, '0.9.0')).toBe('Paragraph one.\n\nParagraph two.')
  })

  it('stops at the next section and keeps the older one out', () => {
    const notes = extractReleaseNotes(README, '0.9.0')

    expect(notes).not.toContain('Old paragraph')
    expect(extractReleaseNotes(README, '0.8.2')).toBe('Old paragraph.')
  })

  it('refuses to publish a release with no notes', () => {
    expect(() => extractReleaseNotes(README, '1.0.0')).toThrow(/no "## 1.0.0" section/u)
    expect(() => extractReleaseNotes('## 1.0.0\n\n## 0.9.0\n', '1.0.0')).toThrow(/is empty/u)
  })
})

/**
 * The script is normally reached through pnpm, which forwards a literal `--`
 * when flags are passed. Rejecting it would make the documented resume command
 * fail, so the separator is tolerated while genuinely unknown flags still stop
 * the run instead of being silently ignored.
 */
describe('parseArguments', () => {
  it('accepts flags with or without the pnpm separator', () => {
    expect(parseArguments(['--verify-only']).verifyOnly).toBe(true)
    expect(parseArguments(['--', '--verify-only']).verifyOnly).toBe(true)
    expect(parseArguments(['--notes', 'notes.md', '--', '--dry-run'])).toEqual({
      notes: 'notes.md',
      verifyOnly: false,
      dryRun: true,
      repo: undefined,
    })
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArguments(['--nope'])).toThrow(/unknown argument: --nope/u)
  })
})
