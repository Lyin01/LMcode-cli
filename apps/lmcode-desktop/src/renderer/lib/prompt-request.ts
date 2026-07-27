import type {
  DesktopPromptRequest,
  PromptAttachmentInput,
} from '../../shared/file-types'
import type { UserAttachment } from '@/types'

export function createDesktopPromptRequest(
  text: string,
  attachments: readonly UserAttachment[],
): DesktopPromptRequest {
  const promptAttachments: PromptAttachmentInput[] = []
  for (const attachment of attachments) {
    if (attachment.filePath) {
      promptAttachments.push({
        source: 'path',
        kind: attachment.kind,
        filePath: attachment.filePath,
      })
      continue
    }
    if (attachment.kind === 'image' && attachment.previewUrl?.startsWith('data:image/')) {
      promptAttachments.push({
        source: 'inline',
        kind: 'image',
        name: attachment.name,
        dataUrl: attachment.previewUrl,
      })
      continue
    }
    throw new Error(`附件“${attachment.name}”的数据不可用，请重新添加`)
  }

  return {
    text: text.trim(),
    attachments: promptAttachments,
  }
}
