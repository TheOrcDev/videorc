// The D key and the sidebar's theme button (plan 174 S3.17, I-30): each press
// flips what the window shows, light or dark. It used to save the flipped
// theme outright, so one press quietly dropped "System" and the app stopped
// following the computer for good. Landing on the look the computer already
// asks for hands control back to System instead.

export type ThemeChoice = 'light' | 'dark' | 'system'

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
