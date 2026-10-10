import type { MemoryMemoSummary } from '@lmcode/memory'

import type { AppServerClient } from './client.js'
import type { DesktopMemoryStore } from './types.js'

interface RawMemo {
  readonly id?: string
  readonly sourceSessionId?: string
  readonly sourceSessionTitle?: string
  readonly userNeed?: string
  readonly approach?: string
  readonly outcome?: string
  readonly whatFailed?: string
  readonly whatWorked?: string
  readonly extractionSource?: string
  readonly recordedAt?: number
  readonly projectDir?: string
  readonly tags?: string[]
  readonly kind?: MemoryMemoSummary['kind']
}

function toSummary(memo: RawMemo | undefined): MemoryMemoSummary | undefined {
  if (memo?.id === undefined || memo.userNeed === undefined) return undefined
  return {
    id: memo.id,
    sourceSessionId: memo.sourceSessionId ?? '',
    sourceSessionTitle: memo.sourceSessionTitle,
    userNeed: memo.userNeed,
    approach: memo.approach ?? '',
    outcome: memo.outcome ?? '',
    whatFailed: memo.whatFailed ?? '',
    whatWorked: memo.whatWorked ?? '',
    extractionSource: memo.extractionSource ?? '',
    recordedAt: memo.recordedAt ?? 0,
    projectDir: memo.projectDir ?? '',
    tags: memo.tags,
    kind: memo.kind,
  }
}

/** Memory panel over `memory/list`, `memory/search`, and `memory/delete`. */
export class RustMemoryStore implements DesktopMemoryStore {
  constructor(private readonly client: AppServerClient) {}

  async list(query?: { readonly limit?: number; readonly search?: string }): Promise<{
    readonly memos: readonly MemoryMemoSummary[]
    readonly total: number
  }> {
    const limit = query?.limit ?? 100
    const search = query?.search?.trim()
    if (search !== undefined && search.length > 0) {
      const result = await this.client.request<{ memories?: Array<{ memo?: RawMemo }> }>('memory/search', {
        query: search,
        limit,
      })
      const memos = (result.memories ?? [])
        .map((row) => toSummary(row.memo))
        .filter((memo): memo is MemoryMemoSummary => memo !== undefined)
      return { memos, total: memos.length }
    }
    const result = await this.client.request<{ memories?: RawMemo[] }>('memory/list', {})
    const memos = (result.memories ?? [])
      .map((memo) => toSummary(memo))
      .filter((memo): memo is MemoryMemoSummary => memo !== undefined)
      .slice(0, limit)
    return { memos, total: memos.length }
  }

  async delete(id: string): Promise<void> {
    await this.client.request('memory/delete', { id })
  }

  async close(): Promise<void> {
    // The app-server opens SQLite per call. Closing the store does not stop
    // the process; the harness owns that.
  }
}
