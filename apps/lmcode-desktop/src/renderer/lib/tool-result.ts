/**
 * Projection of a raw tool output onto the transcript card view model.
 *
 * Tool outputs are either a plain string or a liumir content-part array (a
 * computer-use screenshot, for example). Image parts carry full `data:` URLs,
 * so they must never be serialized into `result` — one screenshot would put
 * hundreds of kilobytes of base64 into the card body. They travel in
 * `resultImages` instead and are rendered as real images.
 */

export interface ToolResultView {
  readonly result: string
  readonly resultImages?: string[]
}

/** Shown in place of empty text when a result carries images and nothing else. */
const IMAGE_ONLY_RESULT_TEXT = '（工具返回了图片输出）'

interface ContentPartLike {
  readonly type?: string
  readonly text?: string
  readonly think?: string
  readonly imageUrl?: { readonly url?: string }
}

/** Every part type of the liumir `ContentPart` union. */
const CONTENT_PART_TYPES: ReadonlySet<string> = new Set([
  'text',
  'think',
  'image_url',
  'audio_url',
  'video_url',
])

function isContentPart(value: unknown): value is ContentPartLike {
  if (value === null || typeof value !== 'object') return false
  const type = (value as ContentPartLike).type
  return typeof type === 'string' && CONTENT_PART_TYPES.has(type)
}

/**
 * Map one tool output onto the card view. Strings pass through untouched.
 * Content-part arrays split into joined text/think parts (`result`) plus the
 * image URLs (`resultImages`). Anything else keeps the JSON fallback.
 */
export function projectToolResult(output: unknown): ToolResultView {
  if (typeof output === 'string') return { result: output }

  if (Array.isArray(output) && output.every(isContentPart)) {
    const parts = output as ContentPartLike[]
    const result = parts
      .map((part) =>
        part.type === 'text' ? part.text ?? '' : part.type === 'think' ? part.think ?? '' : '',
      )
      .join('')
    const resultImages = parts
      .filter((part) => part.type === 'image_url')
      .map((part) => part.imageUrl?.url)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)

    if (result.trim().length > 0) {
      return { result, resultImages: resultImages.length > 0 ? resultImages : undefined }
    }
    if (resultImages.length > 0) return { result: IMAGE_ONLY_RESULT_TEXT, resultImages }
    return { result: '' }
  }

  if (output === undefined) return { result: '' }
  return { result: JSON.stringify(output, null, 2) }
}
