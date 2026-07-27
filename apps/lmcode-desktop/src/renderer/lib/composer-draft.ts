import type { ComposerDraftRequest } from '@/lib/menu-command'

export function mergeComposerDraft(
  existing: string,
  request: Pick<ComposerDraftRequest, 'text' | 'mode'>,
): string {
  if (request.mode === 'replace') return request.text
  const current = existing.trimEnd()
  return current ? `${current}\n\n${request.text}` : request.text
}
