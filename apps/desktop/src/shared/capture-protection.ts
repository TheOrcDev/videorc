/**
 * Capture protection's one user-facing reason, shared by main (the rule in
 * `main/window-capture-protection.ts`) and the renderer (the Stream
 * Manager's Hide from stream switch, plan 215 D6, and ⌘K). Electron's
 * `setContentProtection` works on macOS and Windows only, and Videorc's
 * own capture filter is macOS only, so Linux can hide no window.
 */
export const CAPTURE_PROTECTION_UNSUPPORTED_REASON =
  'This system cannot hide a window from screen capture.'
