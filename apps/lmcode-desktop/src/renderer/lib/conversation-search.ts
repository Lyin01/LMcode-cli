import type { Message } from '@/types'

function searchableMessageText(message: Message): string {
  const toolText = message.toolCalls
    ?.flatMap((toolCall) => [
      toolCall.toolName,
      toolCall.args,
      toolCall.result ?? '',
      toolCall.progress ?? '',
    ])
    .join('\n')

  const attachmentText = message.attachments?.map((attachment) => attachment.name).join('\n')
  return [message.content, message.thinking ?? '', toolText ?? '', attachmentText ?? ''].join('\n')
}

export function findConversationMessageIds(
  messages: readonly Message[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return []

  return messages
    .filter((message) =>
      searchableMessageText(message).toLocaleLowerCase().includes(normalizedQuery),
    )
    .map((message) => message.id)
}
