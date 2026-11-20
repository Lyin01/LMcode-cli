/** All matches are non-overlapping, and replacement text is always literal. */
export function replaceExact(content: string, oldText: string, newText: string, replaceAll: boolean) {
  if (oldText === '') return { text: content, count: 0 };
  if (replaceAll) {
    const parts = content.split(oldText);
    return { text: parts.join(newText), count: parts.length - 1 };
  }

  const first = content.indexOf(oldText);
  if (first === -1) return { text: content, count: 0 };
  let count = 1;
  let next = content.indexOf(oldText, first + oldText.length);
  while (next !== -1) {
    count += 1;
    next = content.indexOf(oldText, next + oldText.length);
  }
  if (count !== 1) return { text: content, count };
  return { text: content.slice(0, first) + newText + content.slice(first + oldText.length), count };
}
