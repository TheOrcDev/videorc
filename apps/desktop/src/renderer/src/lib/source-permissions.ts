import { appPlatform, revealInFileManagerLabel } from '@/lib/platform'
import { platformCopy } from '@/lib/platform-copy'
import type { SystemAccessAction, SystemAccessState } from '@/lib/system-access'

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
  const missing = input.state === 'first-use' || input.state === 'not-granted'
  if (!missing || !input.chosen || input.action === null) return null
  const noun = id === 'camera' ? 'camera' : 'microphone'
  const os = appPlatform(platform)
  const description =
    input.action === 'request-media-access'
      ? `${platformCopy(platform).osName} asks once. Choose Allow.`
      : os === 'win32'
        ? // Windows lists desktop apps under one switch, never by name (plan 174 S3.17).
          `In ${privacyPath(platform, id)}, turn on access and “Let desktop apps access your ${noun}”.`
        : `Turn on ${targetName} in ${privacyPath(platform, id)}.`
  return {
    id,
    title: `${PANE_NAMES[id]} permission is required for ${targetName}.`,
    description,
    actionLabel:
      input.action === 'request-media-access' ? 'Allow access…' : openPermissionSettingsLabel(id),
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
  /** Who the grant belongs to: the capture helper, or Videorc. */
  targetName: string
  screenRecording: boolean
  camera: MediaPermissionInput
  microphone: MediaPermissionInput
}): SourcePermissionAlert[] {
  const { platform, targetName } = input
  const alerts: SourcePermissionAlert[] = []
  if (input.screenRecording) {
    alerts.push({
      id: 'screen-recording',
      title: `Screen Recording permission is required for ${targetName}.`,
      // macOS reads the grant once per launch, so the fix ends with a relaunch.
      description: `Turn on ${targetName} in ${privacyPath(platform, 'screen-recording')}, then quit and reopen Videorc.`,
      actionLabel: openPermissionSettingsLabel('screen-recording'),
      revealLabel: showHelperLabel(platform)
    })
  }
  for (const id of ['camera', 'microphone'] as const) {
    const alert = mediaAlert(id, input[id], platform, targetName)
    if (alert) alerts.push(alert)
  }
  return alerts
}
