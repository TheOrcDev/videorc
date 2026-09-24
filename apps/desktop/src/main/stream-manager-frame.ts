/**
 * The Stream Manager window's frame (plan 053, S8). The window used to be a
 * 420 × 640 chat reader; the dashboard wants room for the stats strip and a
 * right pane. A frame the user never resized (the old default) moves to the
 * new default once; any frame the user sized is kept.
 */
export const STREAM_MANAGER_DEFAULT_SIZE = { width: 1120, height: 720 } as const
export const LEGACY_CHAT_WINDOW_SIZE = { width: 420, height: 640 } as const
export const STREAM_MANAGER_LAYOUT_VERSION = 2

export interface StreamManagerFramePrefs {
  frame?: { x: number; y: number; width: number; height: number }
  layoutVersion?: number
}

export function migrateStreamManagerFrame(prefs: StreamManagerFramePrefs): {
  frame: StreamManagerFramePrefs['frame']
  migrated: boolean
} {
  const frame = prefs.frame
  if (!frame || prefs.layoutVersion === STREAM_MANAGER_LAYOUT_VERSION) {
    return { frame, migrated: false }
  }
  const legacyDefault =
    frame.width === LEGACY_CHAT_WINDOW_SIZE.width && frame.height === LEGACY_CHAT_WINDOW_SIZE.height
  if (!legacyDefault) {
    return { frame, migrated: false }
  }
  return {
    frame: { ...frame, ...STREAM_MANAGER_DEFAULT_SIZE },
    migrated: true
  }
}
