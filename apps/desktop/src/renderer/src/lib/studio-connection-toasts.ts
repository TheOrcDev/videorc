import { beginVideorcSignIn } from '@/lib/videorc-web-links'
import { toast } from '@/lib/toast'
import { userErrorMessage } from '@/lib/user-error'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { copyText } from '@/lib/copy-text'
import { BROWSER_APPROVAL_TOAST_ID, X_MEDIA_STUDIO_URL } from '@/lib/studio-toasts'

// Connection notices load when needed, outside the Studio startup bundle.

function openXMediaStudio(): void {
  void window.videorc?.openOAuthUrl?.(X_MEDIA_STUDIO_URL)
}

/**
 * An X broadcast step that failed while the stream goes on, so a warning
 * (plan 174 S2.4). The words match the YouTube broadcast toast.
 */
export function showXBroadcastProblem(
  step: 'start' | 'end' | 'chat',
  target: { id: string; label: string },
  error: unknown
): void {
  const copy = userErrorMessage(error, {
    action: step === 'end' ? 'end' : 'start',
    object: 'the X broadcast'
  })
  console.warn(`[x] ${step} failed for ${target.label}:`, copy.raw)
  if (step === 'chat') {
    toast.warning(`X chat isn't connected for ${target.label}`, {
      id: `x-chat:${target.id}`,
      description: 'Your stream is fine. Check X in Livestream.',
      action: { label: 'Open Livestream', onClick: () => openWorkspaceTab('live') }
    })
    return
  }
  if (step === 'end') {
    toast.warning(copy.title, {
      id: `x-broadcast-end:${target.id}`,
      description: 'End it in X Media Studio.',
      action: { label: 'Open Media Studio', onClick: openXMediaStudio }
    })
    return
  }
  toast.warning(copy.title, { id: `x-broadcast-start:${target.id}`, description: copy.description })
}

/**
 * A step to take, so info (plan 174 S2.4, D-16): approve in the browser.
 * Auto-open uses the default browser, which is often not the one the
 * streamer is signed into, so the link stays copyable until dismissed.
 */
export function showBrowserApproval(title: string, authUrl: string): void {
  toast.info(title, {
    id: BROWSER_APPROVAL_TOAST_ID,
    description: 'Signed in on a different browser? Copy the link and open it there instead.',
    duration: Infinity,
    action: {
      label: 'Copy link',
      // The toast closes on the click, so success still says so here.
      onClick: () => {
        void copyText(authUrl, {
          title: "Couldn't copy the link",
          description: 'The page is already open in your default browser.'
        }).then((copied) => copied && toast.success('Link copied'))
      }
    }
  })
}

/**
 * A chat connector waits on the Videorc sign-in (plan 215 A3). The toast
 * names the account, never X: X is fine, and "Open Livestream" would show it
 * healthy. Sign in is the fix, and it attaches chat without a restart (A4).
 * One id per platform, so X and Kick each say it once and a repeat replaces.
 */
export function showChatNeedsVideorcSignIn(platformLabel: string): void {
  toast.warning(`${platformLabel} chat needs your Videorc sign-in`, {
    id: `chat-videorc-sign-in:${platformLabel}`,
    description: 'Your stream is fine. Sign in to read chat.',
    action: { label: 'Sign in', onClick: beginVideorcSignIn }
  })
}

/**
 * The server refused the stored session and the desktop signed itself out
 * (plan 215 A5, D7). Until now that was silent: the sidebar read "Sign in"
 * and chat failed at the next Go Live.
 */
export function showVideorcSignInExpired(): void {
  toast.warning('Your Videorc sign-in expired', {
    id: 'account-session-expired',
    description: 'Sign in again.',
    action: { label: 'Sign in', onClick: beginVideorcSignIn }
  })
}
