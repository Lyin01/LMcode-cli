function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Clipboard image data usually arrives nameless. Give it a stable,
 * human-sortable name like `pasted-20260717-214530.png` so the attachment
 * card and the model-facing part id stay meaningful.
 */
export function defaultPastedImageName(mimeType: string, date: Date = new Date()): string {
  const subtype = mimeType.split('/')[1]?.toLowerCase()
  const extension = subtype === 'jpeg' ? 'jpg' : subtype === 'png' || subtype === 'gif' || subtype === 'webp' ? subtype : 'png'
  const stamp = [
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`,
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`,
  ].join('-')
  return `pasted-${stamp}.${extension}`
}
