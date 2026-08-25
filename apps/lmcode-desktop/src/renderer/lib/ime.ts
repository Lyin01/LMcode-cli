/** True when Enter is confirming an IME candidate (pinyin/wubi/etc.), not sending. */
export function isImeConfirmKey(event: {
  readonly key?: string
  readonly nativeEvent?: { readonly isComposing?: boolean; readonly keyCode?: number }
  readonly isComposing?: boolean
  readonly keyCode?: number
}): boolean {
  if (shouldSuppressEnterAfterComposition(event)) return true
  return (
    event.nativeEvent?.isComposing === true ||
    event.isComposing === true ||
    event.nativeEvent?.keyCode === 229 ||
    event.keyCode === 229
  )
}

let suppressEnterUntil = 0

/** Call from compositionend so the following Enter is not treated as submit. */
export function noteCompositionEnd(): void {
  suppressEnterUntil = Date.now() + 80
}

function shouldSuppressEnterAfterComposition(event: {
  readonly key?: string
  readonly keyCode?: number
  readonly nativeEvent?: { readonly keyCode?: number }
}): boolean {
  const isEnter = event.key === 'Enter' || event.keyCode === 13 || event.nativeEvent?.keyCode === 13
  if (!isEnter || Date.now() > suppressEnterUntil) return false
  suppressEnterUntil = 0
  return true
}
