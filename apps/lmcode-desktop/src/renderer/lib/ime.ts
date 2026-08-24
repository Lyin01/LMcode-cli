/** True when Enter is confirming an IME candidate (pinyin/wubi/etc.), not sending. */
export function isImeConfirmKey(event: {
  readonly nativeEvent?: { readonly isComposing?: boolean; readonly keyCode?: number }
  readonly isComposing?: boolean
  readonly keyCode?: number
}): boolean {
  return (
    event.nativeEvent?.isComposing === true ||
    event.isComposing === true ||
    event.nativeEvent?.keyCode === 229 ||
    event.keyCode === 229
  )
}
