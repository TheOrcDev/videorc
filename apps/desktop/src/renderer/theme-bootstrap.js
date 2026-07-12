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
    document.documentElement.classList.add(dark ? 'dark' : 'light')
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  } catch {
    document.documentElement.classList.add('dark')
  }
})()
