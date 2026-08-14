/**
 * Reads a File (usually a clipboard image without a filesystem path) as a
 * data URL so it can be sent to the main process as an inline attachment.
 */
export function fileToDataUrl(file: File): Promise<string> {
  const result = Promise.withResolvers<string>()
  const reader = new FileReader()
  reader.addEventListener('load', () => {
    if (typeof reader.result === 'string') result.resolve(reader.result)
    else result.reject(new Error('无法读取剪贴板图片'))
  }, { once: true })
  reader.addEventListener('error', () => {
    result.reject(reader.error ?? new Error('无法读取剪贴板图片'))
  }, { once: true })
  reader.addEventListener('abort', () => {
    result.reject(new Error('剪贴板图片读取已取消'))
  }, { once: true })
  reader.readAsDataURL(file)
  return result.promise
}
