// Theme pre-hydration: next-themes applies its class only after React mounts.
// Keep this parser-blocking and external so the CSP can reject inline scripts
// while frame one still uses the persisted palette.
;(() => {
  try {
    const stored = window.localStorage.getItem('videorc.theme')
    const dark =
      stored === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : stored !== 'light'
    // No inline color-scheme on the root: in light theme it makes Chromium
    // paint an opaque canvas over the window glass (styles.css sets it on body).
    document.documentElement.classList.add(dark ? 'dark' : 'light')
  } catch {
    document.documentElement.classList.add('dark')
  }
})()
