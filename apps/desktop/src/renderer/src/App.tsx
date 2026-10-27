import { ThemeProvider, useTheme } from 'next-themes'
import { useEffect, type ReactElement } from 'react'

import { AppShell } from '@/components/app-shell'
import { WindowProviders } from '@/components/window-providers'
import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import { StudioProvider } from '@/hooks/use-studio'
import { STORAGE_KEYS } from '@/lib/capture'

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
