import type { ContentPart, Message, Tool } from '@lmcode-cli/ltod';

/**
 * Estimate token count from text using a character-based heuristic.
 *   - ASCII (~4 chars per token)
 *   - CJK and other non-ASCII (~1 char per token)
 * The estimate is transient — the next LLM call returns the real count
 * and supersedes this value. Used to keep `tokenCountWithPending`
 * monotonic between LLM round-trips without paying for a tokenizer.
 */
export function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message);
  }
  return total;
}

export function estimateTokensForTools(tools: readonly Tool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.parameters));
  }
  return total;
}

export function estimateTokensForMessage(message: Message): number {
  let total = estimateTokens(message.role);
  for (const part of message.content) {
    total += estimateTokensForContentPart(part);
  }
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  return total;
}

/** Conservative floor for a remote/unknown multimodal part. */
const MIN_MEDIA_TOKENS = 765;
/** ~100 decoded bytes per estimated token for inline data URLs. */
const BYTES_PER_MEDIA_TOKEN = 100;

export function estimateTokensForContentPart(part: ContentPart): number {
  if (part.type === 'text') {
    return estimateTokens(part.text);
  } else if (part.type === 'think') {
    return estimateTokens(part.think);
  } else if (part.type === 'image_url') {
    return estimateMediaUrlTokens(part.imageUrl.url);
  } else if (part.type === 'audio_url') {
    return estimateMediaUrlTokens(part.audioUrl.url);
  } else if (part.type === 'video_url') {
    return estimateMediaUrlTokens(part.videoUrl.url);
  }
  return 0;
}

export function estimateMediaUrlTokens(url: string): number {
  const comma = url.indexOf(',');
  if (url.startsWith('data:') && comma !== -1) {
    const payload = url.slice(comma + 1);
    const bytes = Math.floor((payload.length * 3) / 4);
    return Math.max(MIN_MEDIA_TOKENS, Math.ceil(bytes / BYTES_PER_MEDIA_TOKEN));
  }
  return MIN_MEDIA_TOKENS;
}

/** Keep a prefix of `text` whose estimated tokens stay within `budget`. */
export function sliceTextToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  let tokens = 0;
  let end = 0;
  for (const ch of text) {
    const chTokens = ch.codePointAt(0)! <= 127 ? 1 / 4 : 1;
    if (tokens + chTokens > budget) break;
    tokens += chTokens;
    end += ch.length;
  }
  return text.slice(0, end);
}
