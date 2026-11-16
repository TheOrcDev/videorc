import { useSyncExternalStore, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { soundboard } from '@/lib/soundboard-store'

/** Consent is per room, defaults off, and never claims production qualification. */
export function RoomSounds(): ReactElement | null {
  const snapshot = useSyncExternalStore(soundboard.subscribe, soundboard.getSnapshot)
  const aux = snapshot.roomAux
  if (!aux) return null
  const heard = Object.keys(aux.observed).length
  return (
    <Field>
      <FieldLabel>Room sounds · Preview</FieldLabel>
      <FieldDescription role="status">
        {aux.reason ??
          (aux.state === 'published'
            ? `Auxiliary track published. ${heard ? `Audio observed by ${heard} consumer${heard === 1 ? '' : 's'}.` : 'Audibility unconfirmed.'}`
            : `${aux.queuedVoices.length} voices queued.`)}
        {' Live acceptance has not run. Your speaker monitor is separate.'}
      </FieldDescription>
      <Button
        variant="outline"
        size="xs"
        onClick={() => soundboard.setRoomAuxEnabled(!aux.enabled)}
      >
        {aux.enabled ? 'Turn off room sounds' : 'Try room sounds for this room'}
      </Button>
    </Field>
  )
}
