// Apply the persisted theme before first paint without requiring CSP unsafe-inline.
(() => {
  try {
    const preference = localStorage.getItem('lmcode-theme') || 'light'
    const dark =
      preference === 'dark' ||
      (preference === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  } catch {
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()
