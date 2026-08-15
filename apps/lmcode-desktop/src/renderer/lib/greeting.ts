/** Time-of-day salutation shared by the welcome screen and the empty-chat greeting. */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}
