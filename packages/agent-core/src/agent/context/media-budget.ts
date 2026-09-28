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
 * Newest-first cap on inline image parts kept from `tool` messages.
 *
 * Tool results are the volume driver in computer-use sessions — every
 * snapshot is a fresh screenshot, and stale ones can be re-captured. A
 * session that keeps every screenshot inflates each request body and its
 * vision-token count, so only the newest few tool images stay inline.
 * `0` drops all tool-result images. User-authored media is not capped by
 * count (it is only subject to the byte budget).
 */
export const DEFAULT_MEDIA_TOOL_RESULT_IMAGE_LIMIT = 6;

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
  readonly isImage: boolean;
  readonly fromTool: boolean;
}

/**
 * Trim inline media so the payload fits `budgetBytes`, keeping at most
 * `toolResultImageLimit` inline images from tool results (newest first).
 *
 * Walks newest first: the most recent media part is always kept (it is the
 * visual context the model is most likely to need right now), and older
 * parts are kept only while they fit the remaining budget. Everything beyond
 * that is replaced with a text placeholder. Non-inline URLs (https,
 * `blobref:`) are left untouched — they add no payload bytes.
 *
 * A budget of zero or less drops every inline media part; a tool-result
 * image limit of zero drops every inline image that came from a tool.
 * Returns the input array when nothing needs to change; never mutates the
 * input.
 */
export function applyMediaBudget(
  messages: Message[],
  budgetBytes: number,
  toolResultImageLimit: number = DEFAULT_MEDIA_TOOL_RESULT_IMAGE_LIMIT,
): Message[] {
  const slots: MediaSlot[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    const content = message.content;
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!;
      const url = mediaUrlOf(part);
      if (url === undefined || !url.startsWith('data:')) continue;
      slots.push({
        messageIndex,
        partIndex,
        bytes: url.length,
        isImage: part.type === 'image_url',
        fromTool: message.role === 'tool',
      });
    }
  }
  if (slots.length === 0) return messages;

  const dropped = new Map<number, Set<number>>();
  let remaining = budgetBytes;
  let keptToolImages = 0;
  for (const [index, slot] of slots.entries()) {
    // The newest inline media is exempt from the budget so the model keeps
    // sight of the most recent visual state; every older part must fit.
    let keep = budgetBytes > 0 && (index === 0 || slot.bytes <= remaining);
    if (keep && slot.fromTool && slot.isImage && keptToolImages >= toolResultImageLimit) {
      keep = false;
    }
    if (keep) {
      if (slot.fromTool && slot.isImage) keptToolImages += 1;
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
