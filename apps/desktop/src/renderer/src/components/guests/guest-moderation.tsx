import { useCallback, useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import type { KebabMenuItem } from '@/components/kebab-menu'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { CloudGuestAction } from '@/lib/backend'
import {
  banGuestCopy,
  GUEST_NAME_MAX_CHARS,
  NEW_LINK_AFTER_BAN,
  removeGuestCopy,
  renamedGuestName,
  type RoomPerson
} from '@/lib/guests-view'
import type { TalkShowContextValue } from '@/lib/talk-show-context'
import { toast } from '@/lib/toast'

// One moderation kit for a guest (plan 224 D5, D14), shared by Livestream →
// Guests (C-G2) and the Show stage's backstage strip (C-G3): Rename…, the
// host's mute hold, screen share per guest, Remove and Ban. Remove and Ban ask
// first (a destructive action asks or can be undone); a Ban rotates the link,
// and the toast says so once. A failure is already the controller's toast.

type Pending =
  | { kind: 'rename'; person: RoomPerson }
  | { kind: 'remove'; person: RoomPerson }
  | { kind: 'ban'; person: RoomPerson }
  | null

const NEW_LINK_TOAST_ID = 'videorc-guests-new-link'

export function useGuestModeration(talkShow: TalkShowContextValue): {
  /** The guest's ⋯ items; the host gets none here. */
  moderationItems: (person: RoomPerson) => KebabMenuItem[]
  /** Mute holds the guest's mic at the server; Unmute lets them unmute. */
  toggleMute: (person: RoomPerson) => void
  dialogs: ReactElement
} {
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)

  const act = useCallback(
    async (person: RoomPerson, action: CloudGuestAction, name?: string): Promise<boolean> => {
      if (!person.guestId) return false
      try {
        await talkShow.actOnGuest(person.guestId, action, name)
        return true
      } catch {
        return false
      }
    },
    [talkShow]
  )

  const toggleMute = useCallback(
    (person: RoomPerson) => {
      void act(person, person.muted ? 'unmute' : 'mute')
    },
    [act]
  )

  const moderationItems = useCallback(
    (person: RoomPerson): KebabMenuItem[] => {
      if (person.host || !person.guestId) return []
      return [
        {
          id: 'rename',
          label: 'Rename…',
          group: 'guest',
          onSelect: () => setPending({ kind: 'rename', person })
        },
        {
          id: 'mute',
          label: person.muted ? 'Let them unmute' : 'Mute',
          group: 'guest',
          onSelect: () => toggleMute(person)
        },
        {
          id: 'screen-share',
          label: person.screenShareAllowed ? 'Stop their screen share' : 'Allow screen share',
          group: 'guest',
          onSelect: () =>
            void act(
              person,
              person.screenShareAllowed ? 'disallow-screen-share' : 'allow-screen-share'
            )
        },
        {
          id: 'remove',
          label: 'Remove…',
          destructive: true,
          onSelect: () => setPending({ kind: 'remove', person })
        },
        {
          id: 'ban',
          label: 'Ban…',
          destructive: true,
          onSelect: () => setPending({ kind: 'ban', person })
        }
      ]
    },
    [act, toggleMute]
  )

  const close = (): void => {
    setPending(null)
    setBusy(false)
  }

  const run = async (work: () => Promise<boolean>, after?: () => void): Promise<void> => {
    setBusy(true)
    const done = await work()
    close()
    if (done) after?.()
  }

  let dialogs: ReactElement = <></>
  if (pending?.kind === 'rename') {
    dialogs = (
      <RenameGuestDialog
        key={pending.person.identity}
        person={pending.person}
        onClose={close}
        onRename={(name) => void run(() => act(pending.person, 'rename', name))}
      />
    )
  } else if (pending?.kind === 'remove') {
    const copy = removeGuestCopy(pending.person.name)
    dialogs = (
      <ConfirmDialog
        confirmDisabled={busy}
        confirmLabel={busy ? 'Removing…' : copy.confirm}
        description={copy.description}
        open
        testId="guest-remove"
        title={copy.title}
        onCancel={close}
        onConfirm={() => void run(() => act(pending.person, 'remove'))}
      />
    )
  } else if (pending?.kind === 'ban') {
    const copy = banGuestCopy(pending.person.name)
    dialogs = (
      <ConfirmDialog
        confirmDisabled={busy}
        confirmLabel={busy ? 'Banning…' : copy.confirm}
        description={copy.description}
        open
        testId="guest-ban"
        title={copy.title}
        onCancel={close}
        onConfirm={() =>
          void run(
            () => act(pending.person, 'ban'),
            () => toast.info(NEW_LINK_AFTER_BAN, { id: NEW_LINK_TOAST_ID })
          )
        }
      />
    )
  }

  return { moderationItems, toggleMute, dialogs }
}

function RenameGuestDialog({
  person,
  onRename,
  onClose
}: {
  person: RoomPerson
  onRename: (name: string) => void
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(person.name)
  const next = renamedGuestName(person.name, name)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} data-testid="guest-rename-dialog" size="sm">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (next !== null) onRename(next)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename guest</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="guest-rename-name">Name</FieldLabel>
            <Input
              autoFocus
              id="guest-rename-name"
              maxLength={GUEST_NAME_MAX_CHARS}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>
              Viewers see it under their tile, and so does the guest.
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button data-testid="guest-rename-save" disabled={next === null} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
