import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCloud } from '@/hooks/use-studio'
import {
  CLOSE_ROOM_CONFIRM_DESCRIPTION,
  CLOSE_THE_ROOM_LABEL,
  closeRoomAsksFirst
} from '@/lib/guests-view'

/**
 * "Close the room" (plan 224 D17): it ends everything, so it asks first while
 * anyone is in the room or the show is live or recording; an empty room
 * closes at once. Livestream → Guests and the Show stage share it.
 */
export function CloseRoomButton({
  size = 'default',
  testId = 'guests-close-room'
}: {
  size?: 'default' | 'xs'
  testId?: string
}): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const [asking, setAsking] = useState(false)
  const [closing, setClosing] = useState(false)
  const phase = cloudStatus?.room?.phase
  const pending = closing || phase === 'closing'

  const close = async (): Promise<void> => {
    setClosing(true)
    try {
      await talkShow.closeRoom()
    } catch {
      // The controller's toast says why.
    } finally {
      setClosing(false)
      setAsking(false)
    }
  }

  return (
    <>
      <Button
        data-testid={testId}
        disabled={pending || phase !== 'open'}
        size={size}
        type="button"
        variant="outline"
        onClick={() => {
          if (closeRoomAsksFirst(cloudStatus)) setAsking(true)
          else void close()
        }}
      >
        {pending ? (
          <>
            <Spinner aria-hidden data-icon="inline-start" />
            Closing…
          </>
        ) : (
          CLOSE_THE_ROOM_LABEL
        )}
      </Button>
      <ConfirmDialog
        confirmDisabled={closing}
        confirmLabel={closing ? 'Closing…' : CLOSE_THE_ROOM_LABEL}
        description={CLOSE_ROOM_CONFIRM_DESCRIPTION}
        open={asking}
        testId={testId}
        title="Close the room?"
        onCancel={() => setAsking(false)}
        onConfirm={() => void close()}
      />
    </>
  )
}
