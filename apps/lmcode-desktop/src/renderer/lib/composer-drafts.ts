/**
 * Per-session composer text drafts. The composer textarea is uncontrolled and
 * ChatPanel remounts it keyed by session id, so without this store switching
 * sessions would silently discard an unsent message. Drafts live in memory
 * for the lifetime of the renderer process; attachments are intentionally not
 * persisted (re-attaching is cheap relative to their size).
 *
 * Distinct from `composer-draft.ts`, which merges menu-injected draft text —
 * this module owns persistence across session switches.
 */
const drafts = new Map<string, string>()

/** Saves the draft; blank text drops any stored draft for the session. */
export function saveComposerDraft(sessionId: string, text: string): void {
  if (text.trim()) drafts.set(sessionId, text)
  else drafts.delete(sessionId)
}

export function getComposerDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? ''
}

/** Call once the session's message has actually been sent. */
export function clearComposerDraft(sessionId: string): void {
  drafts.delete(sessionId)
}
