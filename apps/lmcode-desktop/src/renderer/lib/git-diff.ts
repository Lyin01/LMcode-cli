export type ParsedDiffLineKind =
  | 'metadata'
  | 'context'
  | 'addition'
  | 'deletion'
  | 'annotation'

export interface ParsedDiffLine {
  readonly id: string
  readonly kind: ParsedDiffLineKind
  readonly marker: string
  readonly content: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

export interface ParsedDiffHunk {
  readonly index: number
  readonly header: string
  readonly context: string
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly ParsedDiffLine[]
}

export interface ParsedGitDiff {
  readonly metadata: readonly ParsedDiffLine[]
  readonly hunks: readonly ParsedDiffHunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function parseCount(value: string | undefined): number {
  return value === undefined ? 1 : Number(value)
}

export function parseGitDiff(patch: string): ParsedGitDiff {
  const sourceLines = patch.replaceAll('\r\n', '\n').split('\n')
  if (sourceLines.at(-1) === '') sourceLines.pop()

  const metadata: ParsedDiffLine[] = []
  const hunks: ParsedDiffHunk[] = []
  let current:
    | {
        readonly index: number
        readonly header: string
        readonly context: string
        readonly oldStart: number
        readonly oldCount: number
        readonly newStart: number
        readonly newCount: number
        readonly lines: ParsedDiffLine[]
        oldLine: number
        newLine: number
      }
    | undefined

  const finishCurrent = (): void => {
    if (!current) return
    hunks.push({
      index: current.index,
      header: current.header,
      context: current.context,
      oldStart: current.oldStart,
      oldCount: current.oldCount,
      newStart: current.newStart,
      newCount: current.newCount,
      lines: current.lines,
    })
  }

  for (const sourceLine of sourceLines) {
    const match = HUNK_HEADER.exec(sourceLine)
    if (match) {
      finishCurrent()
      const oldStart = Number(match[1])
      const newStart = Number(match[3])
      current = {
        index: hunks.length,
        header: sourceLine,
        context: match[5]?.trim() ?? '',
        oldStart,
        oldCount: parseCount(match[2]),
        newStart,
        newCount: parseCount(match[4]),
        lines: [],
        oldLine: oldStart,
        newLine: newStart,
      }
      continue
    }

    if (!current) {
      metadata.push({
        id: `metadata:${metadata.length}`,
        kind: 'metadata',
        marker: '',
        content: sourceLine,
        oldLine: null,
        newLine: null,
      })
      continue
    }

    const id = `hunk:${current.index}:line:${current.lines.length}`
    if (sourceLine.startsWith('+')) {
      current.lines.push({
        id,
        kind: 'addition',
        marker: '+',
        content: sourceLine.slice(1),
        oldLine: null,
        newLine: current.newLine,
      })
      current.newLine += 1
      continue
    }
    if (sourceLine.startsWith('-')) {
      current.lines.push({
        id,
        kind: 'deletion',
        marker: '-',
        content: sourceLine.slice(1),
        oldLine: current.oldLine,
        newLine: null,
      })
      current.oldLine += 1
      continue
    }
    if (sourceLine.startsWith(' ')) {
      current.lines.push({
        id,
        kind: 'context',
        marker: ' ',
        content: sourceLine.slice(1),
        oldLine: current.oldLine,
        newLine: current.newLine,
      })
      current.oldLine += 1
      current.newLine += 1
      continue
    }
    current.lines.push({
      id,
      kind: 'annotation',
      marker: '',
      content: sourceLine,
      oldLine: null,
      newLine: null,
    })
  }

  finishCurrent()
  return { metadata, hunks }
}
