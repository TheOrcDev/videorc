// The going-live vocabulary (plan 174 S2.2, owner decision D3): one verb pair
// on every surface, as the "Going live" table in docs/ui-copy.md sets it out.
// The Studio transport, the Go Live dialog, ⌘K, Settings → Shortcuts and
// Upcoming read their words from here, and smoke:start-labels pins them.
// Pure strings with no imports, so the smoke loads this file without a
// bundler. Stopping keeps its own words in session-stop.ts (S0.1):
// "End livestream", "Your recording stops too.".

/** The Studio transport's record button. Its Space key chip rides beside it. */
export const RECORD_LABEL = 'Record'

/** The Studio transport's Go Live button. It opens the Go Live dialog, hence the "…". */
export const GO_LIVE_LABEL = 'Go Live…'

/** ⌘K's start commands, one per transport button. */
export const START_RECORDING_COMMAND = 'Start recording'
export const GO_LIVE_COMMAND = 'Go live…'

/** The Go Live dialog's title. */
export const GO_LIVE_DIALOG_TITLE = 'Go live'

/**
 * The Go Live dialog's primary button: "Go live", or "Go live on 3
 * destinations" when it starts more than one.
 */
export function goLiveConfirmLabel(destinationCount: number): string {
  return destinationCount > 1 ? `Go live on ${destinationCount} destinations` : 'Go live'
}

/**
 * The primary button after a partial setup. It goes live on the destinations
 * that are ready and leaves the others out, so one ready destination is named
 * ("Go live on Twitch").
 */
export function goLiveOnReadyLabel(readyLabels: readonly string[]): string {
  return readyLabels.length === 1
    ? `Go live on ${readyLabels[0]}`
    : goLiveConfirmLabel(readyLabels.length)
}

/**
 * An Upcoming event's action. It picks the event and its destination for the
 * next Go Live (a dialog asks which destination), and starts nothing.
 */
export const USE_FOR_GO_LIVE_LABEL = 'Use for Go Live…'

/** Settings → Shortcuts: the record key and the global Go Live hotkey. */
export const RECORD_SHORTCUT_LABEL = 'Record / stop recording'
export const GO_LIVE_SHORTCUT_LABEL = 'Go Live / end livestream'
