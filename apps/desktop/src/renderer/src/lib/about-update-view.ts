import type { UpdateStatus } from '@/lib/backend'
import type { VideorcWebLink } from '@/lib/videorc-web-links'

// Settings → About's update row (plan 174 S3.17, I-20): what it says and
// what its one control does in each state of the main-process updater
// (src/main/updater.ts). Pure, so every state's copy is tested; the
// component only draws it. Lazy: only About reads it.

/** What install waits for while Videorc records or is on air. */
export const UPDATE_INSTALL_BLOCKED =
  'Finish your recording or stream first. Installing restarts Videorc.'

export type UpdateRowControl =
  | { kind: 'check'; label: 'Check for updates' | 'Check again' }
  | { kind: 'checking' }
  | { kind: 'progress'; percent: number }
  | { kind: 'install'; label: string; disabledReason: string | null }
  | { kind: 'link'; label: string; link: VideorcWebLink }

export type UpdateRowView =
  | { kind: 'row'; description: string; control: UpdateRowControl | null }
  /** A failed check or download: an Alert with Try again, never raw updater text. */
  | { kind: 'error'; title: string; description: string }

export function updateRowView(status: UpdateStatus, captureActive: boolean): UpdateRowView {
  switch (status.phase) {
    case 'idle':
      return {
        kind: 'row',
        description:
          'Videorc checks in the background and installs an update the next time you quit.',
        control: { kind: 'check', label: 'Check for updates' }
      }
    case 'checking':
      return { kind: 'row', description: 'Checking for updates…', control: { kind: 'checking' } }
    case 'available':
      return {
        kind: 'row',
        description: `Version ${status.version} is available. Starting the download…`,
        control: null
      }
    case 'downloading':
      return {
        kind: 'row',
        description: status.version
          ? `Downloading version ${status.version}… ${Math.round(status.percent)}%`
          : `Downloading the update… ${Math.round(status.percent)}%`,
        control: { kind: 'progress', percent: status.percent }
      }
    case 'downloaded':
      return {
        kind: 'row',
        description: captureActive
          ? `Version ${status.version} is ready. Finish your recording or stream first, or it installs the next time you quit Videorc.`
          : `Version ${status.version} is ready. Restart to install it now, or it installs the next time you quit Videorc.`,
        control: {
          kind: 'install',
          label: `Restart & install ${status.version}`,
          disabledReason: captureActive ? UPDATE_INSTALL_BLOCKED : null
        }
      }
    case 'not-available':
      return {
        kind: 'row',
        description: `You're on the latest version (${status.currentVersion}).`,
        control: { kind: 'check', label: 'Check again' }
      }
    case 'error':
      // The updater's own message (a URL, an HTTP status) goes to the console
      // in main, never into this line.
      return {
        kind: 'error',
        title: "Couldn't check for updates",
        description:
          'Check your internet connection, then try again. If it keeps happening, export a support bundle below.'
      }
    case 'download-available':
      // Linux: the app never downloads it; the downloads page has it.
      return {
        kind: 'row',
        description: `Videorc ${status.version} is available — download it from videorc.com.`,
        control: { kind: 'link', label: 'Open downloads page', link: 'download' }
      }
    case 'unsupported':
      if (status.reason === 'linux-version-unknown') {
        return {
          kind: 'row',
          description:
            "This build doesn't update itself. Videorc tells you here when a new version is on videorc.com.",
          control: { kind: 'link', label: 'Open downloads page', link: 'download' }
        }
      }
      return status.reason === 'windows-feed-unpublished'
        ? {
            kind: 'row',
            description:
              'No Windows update is published for you yet. Sign in to get Windows Alpha updates on their own, or download the newest build from your account page.',
            control: { kind: 'link', label: 'Open account page', link: 'account' }
          }
        : {
            kind: 'row',
            description:
              "This build doesn't update itself. Download new versions from videorc.com.",
            control: { kind: 'link', label: 'Open downloads page', link: 'download' }
          }
  }
}
