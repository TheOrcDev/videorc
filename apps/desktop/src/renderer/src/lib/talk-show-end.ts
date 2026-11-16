import { CLOUD_TOAST_ID } from '@/lib/cloud-toast-id'
import { toastUserError } from '@/lib/user-error'

/**
 * End livestream in a talk show (plan 247 D4). The cloud ends its legs
 * first; the platforms' broadcasts are completed only after that answer. A
 * refused or unanswered end completes nothing and takes no owner, so the
 * next End still has the broadcasts to complete, and YouTube is never
 * marked complete while the cloud keeps pushing. False when the legs did
 * not end.
 */
export async function endTalkShowLivestream<Owner>(
  endLegs: () => Promise<void>,
  onLegsEndFailed: (error: unknown) => void,
  takeOwner: () => Owner | null,
  completePlatforms: (owner: Owner) => Promise<unknown>
): Promise<boolean> {
  try {
    await endLegs()
  } catch (error) {
    onLegsEndFailed(error)
    return false
  }
  const owner = takeOwner()
  if (owner) await completePlatforms(owner)
  return true
}

export function showTalkShowEndFailure(error: unknown, closeRoom: () => Promise<void>): void {
  toastUserError(
    error,
    { action: 'end', object: 'the livestream' },
    {
      id: CLOUD_TOAST_ID,
      action: {
        label: 'Close the room',
        onClick: () => {
          void closeRoom().catch((closeError: unknown) => {
            toastUserError(
              closeError,
              { action: 'close', object: 'the room' },
              { id: CLOUD_TOAST_ID }
            )
          })
        }
      }
    }
  )
}
