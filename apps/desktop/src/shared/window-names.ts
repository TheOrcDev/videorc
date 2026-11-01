// Plan 174 S2.3a (A-11): each of Videorc's four other windows has one name,
// on every surface: its title bar and HTML <title>, its own header, ⌘K, the
// Window menu, the status bar and Settings → Shortcuts. Main and the renderer
// both read them from here; `window-names.test.ts` holds the HTML titles,
// the menu and the shortcut labels to them.
//
// Smokes and probes find the Preview window by this title (with the owning
// PID): `scripts/smoke-preview-interaction-stress-app.mjs` and
// `scripts/lib/preview-interaction-stress.mjs` match `WINDOW_NAMES.preview`.

export const WINDOW_NAMES = {
  preview: 'Preview',
  notes: 'Notes',
  streamManager: 'Stream Manager',
  captions: 'Captions reader'
} as const

export type WindowNameId = keyof typeof WINDOW_NAMES
