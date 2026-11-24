import { ThemeProvider, useTheme } from 'next-themes'
import { useEffect, useRef, type ReactElement } from 'react'

import { AppShell } from '@/components/app-shell'
import { WindowProviders } from '@/components/window-providers'
import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import { StudioProvider } from '@/hooks/use-studio'
import { STORAGE_KEYS } from '@/lib/capture'
import { subscribeUiSetting, uiSettingsStorage } from '@/lib/ui-settings-storage'

// Main repaints every window's opaque base (and, under the clear glass, the
// OS vibrancy material) from nativeTheme, not from our CSS class; keep it in
// step with the app theme so the window always matches.
function NativeThemeSync(): null {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    if (resolvedTheme === 'dark' || resolvedTheme === 'light') {
      void window.videorc?.setNativeTheme?.(resolvedTheme)
    }
  }, [resolvedTheme])
  return null
}

// The theme lives in the UI settings store (plan 220 S1.4b). next-themes keeps
// its own copy under the same key in web storage, because theme-bootstrap.js
// must paint frame one before any script can reach the engine; that copy is a
// cache. On mount the store wins (setTheme also refreshes the copy), a toggle
// writes the store, and a change another window writes is applied here.
function ThemeStoreSync(): null {
  const { theme, setTheme } = useTheme()
  const adopted = useRef(false)
  useEffect(() => {
    if (!theme) return
    const storage = uiSettingsStorage()
    const stored = storage.getItem(STORAGE_KEYS.theme)
    if (!adopted.current) {
      adopted.current = true
      if (stored && stored !== theme) {
        setTheme(stored)
        return
      }
      // Nothing to adopt and nothing chosen: the default stays unstored.
      if (!stored) return
    }
    if (stored === theme) return
    try {
      storage.setItem(STORAGE_KEYS.theme, theme)
    } catch {
      // Not saved: the copy next-themes keeps still holds it on this device.
    }
  }, [theme, setTheme])
  useEffect(
    () =>
      subscribeUiSetting(STORAGE_KEYS.theme, () => {
        const stored = uiSettingsStorage().getItem(STORAGE_KEYS.theme)
        if (stored) setTheme(stored)
      }),
    [setTheme]
  )
  return null
}

export function App(): ReactElement {
  return (
    <ThemeProvider
      attribute="class"
      // Dark glass is the design's default expression; light stays one toggle
      // away as its structural twin (videorc-design skill).
      defaultTheme="dark"
      enableSystem
      // color-scheme lives on body (styles.css); on the root it makes Chromium
      // paint an opaque canvas over the window glass in light theme.
      enableColorScheme={false}
      storageKey={STORAGE_KEYS.theme}
    >
      <ThemeStoreSync />
      <NativeThemeSync />
      {/* Tooltips, and toasts inset above the 26 px status bar so they never
          cover its Search/Preview/Notes/Stream Manager hints (plan 174 S1.1). */}
      <WindowProviders window="main">
        <BackgroundAssetsProvider>
          <StudioProvider>
            <AppShell />
          </StudioProvider>
        </BackgroundAssetsProvider>
      </WindowProviders>
    </ThemeProvider>
  )
}
