import {
  publishChatNeedsSignIn,
  publishSignInExpired,
  publishXBroadcastProblem
} from '@/lib/notifications/sources/platforms'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { BROWSER_APPROVAL_TOAST_ID } from '@/lib/studio-toasts'

// Connection notices load when needed, outside the Studio startup bundle.

/**
 * An X broadcast step that failed while the stream goes on. Since plan 250
 * it is an entry behind the bell (`notifications/sources/platforms.ts`).
 */
export function showXBroadcastProblem(
  step: 'start' | 'end' | 'chat',
  target: { id: string; label: string },
  error: unknown
): void {
  publishXBroadcastProblem(step, target, error)
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
 * A chat connector waits on the Videorc sign-in (plan 215 A3): an entry
 * that names the account, with Sign in as its fix.
 */
export function showChatNeedsVideorcSignIn(platformLabel: string): void {
  publishChatNeedsSignIn(platformLabel)
}

/**
 * The server refused the stored session and the desktop signed itself out
 * (plan 215 A5, D7): an entry with Sign in as its fix.
 */
export function showVideorcSignInExpired(): void {
  publishSignInExpired()
}
