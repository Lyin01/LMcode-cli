import type { ContentPart, Message, TextPart } from '@lmcode-cli/ltod';

import type { ContextMessage } from './types';

export function project(history: readonly ContextMessage[]): Message[] {
  // Keep partial or empty assistant placeholders away from providers.
  // They can appear when a turn is aborted or errors before any content
  // or tool call is appended.
  const usable = history.filter((message) => {
    return (
      message.partial !== true &&
      !(message.role === 'assistant' && message.content.length === 0 && message.toolCalls.length === 0)
    );
  });
  return mergeAdjacentUserMessages(repairToolExchanges(usable));
}

const MISSING_TOOL_RESULT =
  '<system>ERROR: This tool call was interrupted before its result was recorded. Treat it as failed and retry the tool call with complete arguments if it is still needed.</system>';

/**
 * Provider APIs require every assistant tool call to be followed by exactly
 * one matching tool result. WAL recovery and older transcripts can contain a
 * partially recorded batch, so normalize each contiguous exchange here.
 */
function repairToolExchanges(history: readonly ContextMessage[]): ContextMessage[] {
  const out: ContextMessage[] = [];

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]!;
    if (message.role === 'tool') continue;

    out.push(message);
    if (message.role !== 'assistant' || message.toolCalls.length === 0) continue;

    const expectedIds = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    const results = new Map<string, ContextMessage>();
    while (history[index + 1]?.role === 'tool') {
      const result = history[index + 1]!;
      index += 1;
      const id = result.toolCallId;
      if (id !== undefined && expectedIds.has(id) && !results.has(id)) {
        results.set(id, result);
      }
    }

    for (const toolCall of message.toolCalls) {
      out.push(results.get(toolCall.id) ?? missingToolResult(toolCall.id));
    }
  }

  return out;
}

function missingToolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: MISSING_TOOL_RESULT }],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function mergeAdjacentUserMessages(history: readonly ContextMessage[]): Message[] {
  const out: ContextMessage[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}
