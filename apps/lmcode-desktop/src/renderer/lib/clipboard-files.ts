export interface ClipboardFileSource {
  readonly files: ArrayLike<File>
  readonly items?: ArrayLike<{
    readonly kind: string
    readonly type: string
    getAsFile(): File | null
  }>
}

/** Explorer copy often exposes both a File and the path as text/plain. */
export function filesFromClipboardData(data: ClipboardFileSource): File[] {
  const fromList = Array.from(data.files)
  if (fromList.length > 0) return fromList
  if (data.items === undefined) return []
  return Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function shouldCaptureClipboardFiles(data: ClipboardFileSource): boolean {
  return filesFromClipboardData(data).length > 0
}
