import { appPlatform, revealInFileManagerLabel } from '@/lib/platform'
import { systemAccessActionLabel } from '@/lib/system-access-view'
import { platformCopy } from '@/lib/platform-copy'
import type { SystemAccessAction, SystemAccessState, SystemAccessRow } from '@/lib/system-access'

// Plan 174 S3.8 (C-8, C-14): what the Sources page says about a missing
// permission. One curated alert per permission, each with the one action that
// fixes it, in the platform's own words. Sources used to show four recovery
// styles (column alerts, raw backend warnings quoting the helper's path, a
// "Check Settings → Permissions." line, a row button) and none for the
// microphone.

export type SourcePermissionId = 'screen-recording' | 'camera' | 'microphone'

export interface SourcePermissionAlert {
  id: SourcePermissionId
  title: string
  description: string
  /** The fix: the OS's own prompt ("Allow access…") or its settings pane. */
  actionLabel: string
  /** Screen Recording only: shows the capture helper the grant belongs to. */
  revealLabel: string | null
}

/** A camera or microphone grant, as Settings → Permissions reads it. */
export interface MediaPermissionInput {
  state: SystemAccessState | undefined
  /** `systemAccessAction` for the pane: null when nothing is left to do. */
  action: SystemAccessAction
  /** Someone chose this source. No alert for a camera nobody chose. */
  chosen: boolean
  detail?: string
}

const PANE_NAMES: Record<SourcePermissionId, string> = {
  'screen-recording': 'Screen Recording',
  camera: 'Camera',
  microphone: 'Microphone'
}

/** "Open Camera settings": the button names the pane it opens. */
export function openPermissionSettingsLabel(id: SourcePermissionId): string {
  return `Open ${PANE_NAMES[id]} settings`
}

/** "Show helper in Finder" (or Explorer, or the folder elsewhere). */
export function showHelperLabel(platform: string | undefined): string {
  return revealInFileManagerLabel(platform).replace(/^Show in /, 'Show helper in ')
}

/** Where the grant lives: "System Settings → Privacy & Security → Camera". */
function privacyPath(platform: string | undefined, id: SourcePermissionId): string {
  const settings = platformCopy(platform).osSettingsName
  const os = appPlatform(platform)
  if (os === 'darwin') return `${settings} → Privacy & Security → ${PANE_NAMES[id]}`
  if (os === 'win32') return `${settings} → Privacy & security → ${PANE_NAMES[id]}`
  return settings
}

function mediaAlert(
  id: 'camera' | 'microphone',
  input: MediaPermissionInput,
  platform: string | undefined,
  targetName: string
): SourcePermissionAlert | null {
  const missing =
    input.state === 'first-use' || input.state === 'not-granted' || input.state === 'waiting'
  if (!missing || !input.chosen || input.action === null) return null
  const noun = id === 'camera' ? 'camera' : 'microphone'
  const os = appPlatform(platform)
  const description =
    input.detail ||
    (input.action === 'request-media-access'
      ? `${platformCopy(platform).osName} asks once. Choose Allow.`
      : os === 'win32'
        ? // Windows lists desktop apps under one switch, never by name (plan 174 S3.17).
          `In ${privacyPath(platform, id)}, turn on access and “Let desktop apps access your ${noun}”.`
        : `Turn on ${targetName} in ${privacyPath(platform, id)}.`)
  return {
    id,
    title: `${PANE_NAMES[id]} permission is required for ${targetName}.`,
    description,
    actionLabel:
      input.action === 'request-media-access' ? 'Allow…' : openPermissionSettingsLabel(id),
    revealLabel: null
  }
}

/**
 * The page's permission alerts, in page order: Screen Recording, Camera,
 * Microphone. Screen Recording comes from the device list (a screen, window
 * or System audio waiting on the grant), which never asks on Windows or
 * Linux. Camera and microphone follow Settings → Permissions, and only for a
 * source someone chose.
 */
export function sourcePermissionAlerts(input: {
  platform: string | undefined
  /** The name listed by the OS, from runtimeInfo.permissionTargetName. */
  targetName: string
  screenRecording: boolean
  screen?: { row: SystemAccessRow; action: SystemAccessAction }
  camera: MediaPermissionInput
  microphone: MediaPermissionInput
}): SourcePermissionAlert[] {
  const { platform, targetName } = input
  const alerts: SourcePermissionAlert[] = []
  const screen = input.screen
  if (screen) {
    const actionLabel = systemAccessActionLabel(screen.action, platform)
    if (!screen.row.checking && actionLabel) {
      alerts.push({
        id: 'screen-recording',
        title:
          screen.row.state === 'needs-relaunch'
            ? 'Reopen Videorc to record your screen.'
            : `Screen Recording permission is required for ${targetName}.`,
        description:
          screen.row.detail || `${platformCopy(platform).osName} asks once. Choose Allow.`,
        actionLabel,
        revealLabel: null
      })
    }
  } else if (input.screenRecording) {
    alerts.push({
      id: 'screen-recording',
      title: `Screen Recording permission is required for ${targetName}.`,
      description: `Turn on ${targetName} in ${privacyPath(platform, 'screen-recording')}, then come back here.`,
      actionLabel: openPermissionSettingsLabel('screen-recording'),
      revealLabel: null
    })
  }
  for (const id of ['camera', 'microphone'] as const) {
    const alert = mediaAlert(id, input[id], platform, targetName)
    if (alert) alerts.push(alert)
  }
  return alerts
}
