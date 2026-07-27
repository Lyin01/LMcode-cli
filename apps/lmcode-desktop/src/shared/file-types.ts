export interface TextAttachment {
  readonly content: string
  readonly sizeBytes: number
  readonly truncated: boolean
}

export const MAX_PROMPT_ATTACHMENTS = 8

export type FileAttachmentKind = 'text' | 'image'

export interface TextFileAttachmentPreview extends TextAttachment {
  readonly kind: 'text'
  readonly name: string
}

export interface ImageFileAttachmentPreview {
  readonly kind: 'image'
  readonly name: string
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  readonly sizeBytes: number
  readonly dataUrl: string
}

export type FileAttachmentPreview =
  | TextFileAttachmentPreview
  | ImageFileAttachmentPreview

export interface PathPromptAttachmentInput {
  readonly source: 'path'
  readonly kind: FileAttachmentKind
  readonly filePath: string
}

export interface InlineImagePromptAttachmentInput {
  readonly source: 'inline'
  readonly kind: 'image'
  readonly name: string
  readonly dataUrl: string
}

export type PromptAttachmentInput =
  | PathPromptAttachmentInput
  | InlineImagePromptAttachmentInput

export interface DesktopPromptRequest {
  readonly text: string
  readonly attachments: readonly PromptAttachmentInput[]
}

export interface TextAttachmentPromptMetadata {
  readonly name: string
  readonly sizeBytes: number
  readonly truncated: boolean
}

const TEXT_ATTACHMENT_PART_PREFIX = '<lmcode_text_attachment>'

export function serializeTextAttachmentPart(
  attachment: TextFileAttachmentPreview,
): string {
  const metadata: TextAttachmentPromptMetadata = {
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    truncated: attachment.truncated,
  }
  return `${TEXT_ATTACHMENT_PART_PREFIX}${JSON.stringify(metadata)}\n${attachment.content}`
}

export function parseTextAttachmentPart(
  text: string,
): { readonly metadata: TextAttachmentPromptMetadata; readonly content: string } | null {
  if (!text.startsWith(TEXT_ATTACHMENT_PART_PREFIX)) return null
  const lineBreak = text.indexOf('\n', TEXT_ATTACHMENT_PART_PREFIX.length)
  if (lineBreak === -1) return null

  try {
    const value: unknown = JSON.parse(
      text.slice(TEXT_ATTACHMENT_PART_PREFIX.length, lineBreak),
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !('name' in value) ||
      typeof value.name !== 'string' ||
      !('sizeBytes' in value) ||
      typeof value.sizeBytes !== 'number' ||
      !Number.isFinite(value.sizeBytes) ||
      value.sizeBytes < 0 ||
      !('truncated' in value) ||
      typeof value.truncated !== 'boolean'
    ) return null

    return {
      metadata: {
        name: value.name,
        sizeBytes: value.sizeBytes,
        truncated: value.truncated,
      },
      content: text.slice(lineBreak + 1),
    }
  } catch {
    return null
  }
}

export function isDesktopPromptRequest(value: unknown): value is DesktopPromptRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    !('attachments' in value) ||
    !Array.isArray(value.attachments)
  ) return false

  for (const attachment of value.attachments) {
    if (
      typeof attachment !== 'object' ||
      attachment === null ||
      !('source' in attachment) ||
      !('kind' in attachment)
    ) return false
    if (
      attachment.source === 'path' &&
      (attachment.kind === 'text' || attachment.kind === 'image') &&
      'filePath' in attachment &&
      typeof attachment.filePath === 'string'
    ) continue
    if (
      attachment.source === 'inline' &&
      attachment.kind === 'image' &&
      'name' in attachment &&
      typeof attachment.name === 'string' &&
      'dataUrl' in attachment &&
      typeof attachment.dataUrl === 'string'
    ) continue
    return false
  }
  return true
}
