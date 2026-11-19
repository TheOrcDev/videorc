// Plan 250 S4: doors. Each opens the page that owns a control and asks the
// section to bring itself into view. One home per control: an entry points
// here, it never grows a control of its own.

import { requestSectionFocus, type SectionFocusId } from '@/lib/section-focus'
import { openDestination, openWorkspaceTab } from '@/lib/workspace-navigation'

function door(section: SectionFocusId, open: () => void): () => void {
  return () => {
    // The request first: a page that is already open answers the event, a
    // page that opens now takes the request when its section mounts.
    requestSectionFocus(section)
    open()
  }
}

/** Studio, the Audio group: microphone picker, level, Gain, mute. */
export const openStudioAudio = door('studio-audio', () => openWorkspaceTab('studio'))
/** Sources → Audio → Microphone. */
export const openSourcesMicrophone = door('sources-microphone', () => openWorkspaceTab('sources'))
/** Sources → Audio → System audio. */
export const openSourcesSystemAudio = door('sources-system-audio', () =>
  openWorkspaceTab('sources')
)
/** Output → Where recordings go. */
export const openOutputRecordings = door('output-recordings', () => openWorkspaceTab('recording'))
/** Output → Clips. */
export const openOutputClips = door('output-clips', () => openWorkspaceTab('recording'))
/** Output → Videorc Camera. */
export const openOutputVideorcCamera = door('output-videorc-camera', () =>
  openWorkspaceTab('recording')
)
/** Settings → General → Notifications, at the quiet switch. */
export const openNotificationSettings = door('settings-notifications', () =>
  openWorkspaceTab('settings', 'general')
)
/** Destinations → Setup → Videorc Cloud. */
export const openDestinationsCloud = door('destinations-cloud', () =>
  openWorkspaceTab('live', 'setup')
)

/** Destinations → Setup, on one destination's card when it is named. */
export function openDestinations(targetId?: string): void {
  if (targetId) openDestination(targetId)
  else openWorkspaceTab('live', 'setup')
}

/** The Library, on one recording. */
export function openLibraryRecording(sessionId: string): void {
  openWorkspaceTab('library', sessionId)
}
