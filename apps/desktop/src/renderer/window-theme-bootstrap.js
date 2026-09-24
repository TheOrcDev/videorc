// Theme for the secondary windows (Stream Manager, Notes, Captions). They have
// no theme provider: they follow the app theme through prefers-color-scheme,
// which main drives from the main window's toggle (nativeTheme.themeSource).
// That is the same signal the window's vibrancy material follows, so the text
// tokens and the glass always agree, and a toggle in the main window restyles
// every open window live. Kept external so the CSP can reject inline scripts.
;(() => {
  const root = document.documentElement
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    // No inline color-scheme on the root: in light theme it makes Chromium
    // paint an opaque canvas over the window glass (styles.css sets it on body).
    root.classList.toggle('dark', query.matches)
    root.classList.toggle('light', !query.matches)
  }
  apply()
  query.addEventListener('change', apply)
  // The platform before first paint: Windows (Mica) takes its own coats.
  root.dataset.platform = /Win/i.test(navigator.platform)
    ? 'win32'
    : /Mac/i.test(navigator.platform)
      ? 'darwin'
      : 'linux'
})()
