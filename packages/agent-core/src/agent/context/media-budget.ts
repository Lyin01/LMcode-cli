import type { ContentPart, Message } from '@lmcode-cli/liumir';

/**
 * Default per-request budget for inline media payloads, measured in bytes of
 * the base64 data-URL text. Media older than the budget is replaced with a
 * text placeholder before the request leaves the machine, so a conversation
 * that keeps reading large screenshots cannot grow the request body past
 * provider/gateway size limits.
 */
export const DEFAULT_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * Heal budget used to retry after a provider reports the request body is too
 * large: keep only the most recent inline media within this budget.
 */
export const REQUEST_TOO_LARGE_HEAL_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Text that replaces a trimmed media part. The original file is untouched;
 * the surrounding `<image path="...">` text tells the model where to re-read
 * it when the content is needed again.
 */
const MEDIA_OMITTED_PLACEHOLDER =
  '[Media omitted to keep the request under the provider size limit; re-read the original file if it is needed.]';

function omittedPlaceholder(): ContentPart {
  return { type: 'text', text: MEDIA_OMITTED_PLACEHOLDER };
}

function mediaUrlOf(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'image_url':
      return part.imageUrl.url;
    case 'audio_url':
      return part.audioUrl.url;
    case 'video_url':
      return part.videoUrl.url;
    default:
      return undefined;
  }
}

/**
 * Bytes of inline (data-URL) media across the message list. Base64 data-URL
 * text is ASCII, so its string length equals the serialized byte count.
 */
export function mediaPayloadBytes(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.content) {
      const url = mediaUrlOf(part);
      if (url !== undefined && url.startsWith('data:')) {
        total += url.length;
      }
    }
  }
  return total;
}

interface MediaSlot {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly bytes: number;
}

/**
 * Trim inline media so the payload fits `budgetBytes`.
 *
 * Walks newest first: the most recent media part is always kept (it is the
 * visual context the model is most likely to need right now), and older
 * parts are kept only while they fit the remaining budget. Everything beyond
 * that is replaced with a text placeholder. Non-inline URLs (https,
 * `blobref:`) are left untouched — they add no payload bytes.
 *
 * A budget of zero or less drops every inline media part. Returns the input
 * array when nothing needs to change; never mutates the input.
 */
export function applyMediaBudget(
  messages: Message[],
  budgetBytes: number,
): Message[] {
  const slots: MediaSlot[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = messages[messageIndex]!.content;
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const url = mediaUrlOf(content[partIndex]!);
      if (url === undefined || !url.startsWith('data:')) continue;
      slots.push({ messageIndex, partIndex, bytes: url.length });
    }
  }
  if (slots.length === 0) return messages;

  const dropped = new Map<number, Set<number>>();
  let remaining = budgetBytes;
  for (const [index, slot] of slots.entries()) {
    // The newest inline media is exempt from the budget so the model keeps
    // sight of the most recent visual state; every older part must fit.
    const keep = budgetBytes > 0 && (index === 0 || slot.bytes <= remaining);
    if (keep) {
      remaining = Math.max(0, remaining - slot.bytes);
      continue;
    }
    const parts = dropped.get(slot.messageIndex) ?? new Set<number>();
    parts.add(slot.partIndex);
    dropped.set(slot.messageIndex, parts);
  }
  if (dropped.size === 0) return messages;

  return messages.map((message, messageIndex) => {
    const parts = dropped.get(messageIndex);
    if (parts === undefined) return message;
    return {
      ...message,
      content: message.content.map((part, partIndex) =>
        parts.has(partIndex) ? omittedPlaceholder() : part,
      ),
    };
  });
}
