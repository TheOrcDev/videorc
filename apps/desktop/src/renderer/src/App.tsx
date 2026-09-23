import { ThemeProvider, useTheme } from 'next-themes'
import { useEffect, type ReactElement } from 'react'

import { AppShell } from '@/components/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import { StudioProvider } from '@/hooks/use-studio'
import { STORAGE_KEYS } from '@/lib/capture'

// The OS vibrancy material tints by nativeTheme, not by our CSS class; keep
// it in step with the app theme so the glass blur always matches.
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
      <TooltipProvider>
        <BackgroundAssetsProvider>
          <StudioProvider>
            <AppShell />
            {/* Inset above the 26 px status bar: toasts must never cover its
                Search/Preview/Notes/Chat hints (plan 022 Q3, plan 050 S11). */}
            <Toaster offset={{ bottom: 38, right: 16 }} position="bottom-right" richColors />
          </StudioProvider>
        </BackgroundAssetsProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
