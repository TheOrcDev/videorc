// What a Library session was, from its stored `mode`. The backend writes
// `record`, `stream` and `record+stream` (`output_mode` in
// crates/videorc-backend/src/recording.rs) and `imported` for an imported
// file; derived rows (noise cleanup, clean cut) copy their source's mode.
// Older fixtures spelled `recording…` and `streaming…`, so those still count.
// Every mode test in the renderer goes through here, so a filter can never
// test for a mode the backend does not write (plan 174, E-1).

export const SESSION_MODES = {
  record: 'record',
  stream: 'stream',
  recordAndStream: 'record+stream',
  imported: 'imported'
} as const

/** The session left a file in the Library: it recorded, or it was imported. */
export function sessionModeRecorded(mode: string): boolean {
  return (
    mode === SESSION_MODES.record ||
    mode === SESSION_MODES.recordAndStream ||
    mode === SESSION_MODES.imported ||
    mode.startsWith('recording')
  )
}

/** The session went out live. */
export function sessionModeStreamed(mode: string): boolean {
  return (
    mode === SESSION_MODES.stream ||
    mode === SESSION_MODES.recordAndStream ||
    mode.startsWith('streaming')
  )
}
