export type ThemeChoice = 'light' | 'dark' | 'system'

// The D key and the theme button: each press flips what the window shows,
// light or dark. Saving the flipped theme outright would quietly drop
// "System" for good, so landing on the look the computer already asks for
// hands control back to System instead.

export function nextToggledTheme({
  resolvedTheme,
  systemTheme
}: {
  /** What the window shows now. */
  resolvedTheme: string | undefined
  /** What the computer asks for. */
  systemTheme: string | undefined
}): ThemeChoice {
  const target = resolvedTheme === 'dark' ? 'light' : 'dark'
  return target === systemTheme ? 'system' : target
}
