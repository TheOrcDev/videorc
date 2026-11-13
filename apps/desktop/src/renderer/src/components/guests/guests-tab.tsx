import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { useGuestModeration } from '@/components/guests/guest-moderation'
import { CloseRoomButton } from '@/components/guests/close-room-button'
import { KebabMenu } from '@/components/kebab-menu'
import { GroupedList, ListRow } from '@/components/list-row'
import { LockAlert, OfflineAlert, SessionLockAlert } from '@/components/lock-alert'
import { PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { FieldDescription, FieldGroup, SettingsRow } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useStudioCloud, useStudioCore } from '@/hooks/use-studio'
import { useCopyText } from '@/lib/copy-text'
import {
  DOOR_SWITCH_DESCRIPTION,
  DOOR_SWITCH_LABEL,
  NEW_LINK_CONFIRM_DESCRIPTION,
  NOBODY_YET,
  OPEN_THE_ROOM_FIRST,
  OPEN_THE_ROOM_LABEL,
  ROOM_BACKSTAGE_TIME_LINE,
  ROOM_FULL_LINE,
  ROOM_WAITS_FOR_SESSION,
  declinedLine,
  guestConsentLine,
  guestsAccess,
  newLinkAsksFirst,
  qualityStatus,
  requestDevice,
  roomIsFull,
  roomLimits,
  roomLimitsLine,
  roomPeople,
  roomPhaseLabel,
  stageChipLabel,
  type RoomPerson
} from '@/lib/guests-view'
import { VIDEORC_PREMIUM_URL } from '@/lib/videorc-web-links'
import type { CloudRoomRequest } from '@/lib/backend'

/**
 * Livestream → Guests (plan 224 C-G2, D16): the room, the invite link and who
 * is in it. One home for Open the room, Close the room, the link and the door
 * switch; the stage itself (Bring on, Send backstage, the layout) is the Show
 * stage's backstage strip in the Studio (C-G3). Locked means disabled, with
 * one reason leading the tab: a Premium feature stays on screen behind its
 * lock. Loaded with the tab, never eager.
 */
export default function GuestsTab(): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const { captureConfig, streamMetadataDraft, isSessionActive, wsStatus } = useStudioCore()
  const [opening, setOpening] = useState(false)
  const room = cloudStatus?.room
  const phase = room?.phase ?? 'closed'
  const roomOpen = phase === 'open'
  const access = guestsAccess(cloudStatus)
  const offline = wsStatus !== 'connected'
  const locked = access.kind === 'locked'
  // A recording or a livestream on this computer holds the camera: a room
  // opens between sessions. An open room's own show never locks the tab.
  const sessionLocked = isSessionActive && phase === 'closed'
  const disabled = offline || locked || sessionLocked
  const limits = roomLimits(cloudStatus)
  const limitsLine = roomLimitsLine(limits)
  const people = roomPeople(room, talkShow.hostIdentity)
  const requests = room?.requests ?? []
  const full = roomOpen && roomIsFull(people, limits)

  const openRoom = async (): Promise<void> => {
    setOpening(true)
    try {
      const platforms = [
        ...new Set(
          captureConfig.streaming.targets
            .filter((target) => target.enabled)
            .map((target) => target.platform)
        )
      ]
      const title = streamMetadataDraft?.title?.trim()
      await talkShow.openRoom({ ...(title ? { title } : {}), platforms })
    } catch {
      // The controller's toast says why.
    } finally {
      setOpening(false)
    }
  }

  const roomPending = opening || phase === 'opening'

  return (
    <PageStack>
      <PanelSection
        data-testid="guests-room"
        description="Guests join from a link in their browser. Nothing to install."
        title="Room"
      >
        {offline ? (
          <OfflineAlert />
        ) : locked ? (
          <LockAlert
            action={access.upsell ? { kind: 'view-premium', url: VIDEORC_PREMIUM_URL } : null}
            data-testid="guests-lock"
            reason={access.reason}
          />
        ) : sessionLocked ? (
          <SessionLockAlert reason={ROOM_WAITS_FOR_SESSION} />
        ) : null}
        <FieldGroup variant="grouped">
          <SettingsRow
            data-testid="guests-room-row"
            description={ROOM_BACKSTAGE_TIME_LINE}
            label={roomPhaseLabel(room)}
          >
            {roomOpen || phase === 'closing' ? (
              <CloseRoomButton />
            ) : (
              <Button
                data-testid="guests-open-room"
                disabled={disabled || roomPending}
                type="button"
                onClick={() => void openRoom()}
              >
                {roomPending ? (
                  <>
                    <Spinner aria-hidden data-icon="inline-start" />
                    Opening…
                  </>
                ) : (
                  OPEN_THE_ROOM_LABEL
                )}
              </Button>
            )}
          </SettingsRow>
          <SettingsRow
            data-testid="guests-door"
            description={DOOR_SWITCH_DESCRIPTION}
            label={DOOR_SWITCH_LABEL}
          >
            <DisabledReason reason={!disabled && !roomOpen ? OPEN_THE_ROOM_FIRST : null}>
              <Switch
                checked={room?.doorOpen ?? false}
                disabled={disabled || !roomOpen}
                onCheckedChange={(open) => void talkShow.setDoor(open).catch(() => {})}
              />
            </DisabledReason>
          </SettingsRow>
        </FieldGroup>
        {room?.message ? (
          <Alert variant="warning">
            <AlertTitle>{room.message}</AlertTitle>
          </Alert>
        ) : null}
      </PanelSection>

      <InviteLinkSection disabled={disabled} limitsLine={limitsLine} />

      <PanelSection data-testid="guests-people" title="Who's here">
        {full ? (
          <Alert data-testid="guests-room-full" variant="quiet">
            <AlertTitle>{ROOM_FULL_LINE}</AlertTitle>
          </Alert>
        ) : null}
        <WhoIsHere
          declinedCount={room?.declinedCount ?? 0}
          disabled={disabled || !roomOpen}
          people={people}
          requests={requests}
        />
      </PanelSection>
    </PageStack>
  )
}

function InviteLinkSection({
  disabled,
  limitsLine
}: {
  disabled: boolean
  limitsLine: string | null
}): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const room = cloudStatus?.room
  const roomOpen = room?.phase === 'open'
  const inviteUrl = room?.inviteUrl ?? ''
  const { copied, copy } = useCopyText()
  const [asking, setAsking] = useState(false)
  const [rotating, setRotating] = useState(false)
  const noLink = !inviteUrl
  const linkReason = !disabled && noLink ? OPEN_THE_ROOM_FIRST : null

  const rotate = async (): Promise<void> => {
    setRotating(true)
    try {
      await talkShow.rotateInvite()
    } catch {
      // The controller's toast says why.
    } finally {
      setRotating(false)
      setAsking(false)
    }
  }

  return (
    <PanelSection data-testid="guests-invite" description={limitsLine} title="Invite link">
      <div className="flex min-w-0 items-center gap-2">
        <Input
          aria-label="Invite link"
          className="min-w-0 flex-1 select-text"
          data-testid="guests-invite-url"
          disabled={disabled || noLink}
          placeholder="The link appears when the room opens."
          readOnly
          value={inviteUrl}
          onFocus={(event) => event.currentTarget.select()}
        />
        <DisabledReason reason={linkReason}>
          <Button
            data-testid="guests-invite-copy"
            disabled={disabled || noLink}
            type="button"
            variant="secondary"
            onClick={() => void copy(inviteUrl, "Couldn't copy the link.")}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </DisabledReason>
        <DisabledReason reason={!disabled && !roomOpen ? OPEN_THE_ROOM_FIRST : null}>
          <Button
            data-testid="guests-invite-rotate"
            disabled={disabled || !roomOpen || rotating}
            type="button"
            variant="outline"
            onClick={() => {
              if (newLinkAsksFirst(room)) setAsking(true)
              else void rotate()
            }}
          >
            {rotating ? 'Making…' : 'New link'}
          </Button>
        </DisabledReason>
      </div>
      <FieldDescription data-testid="guests-consent">
        Guests read this before they ask to join: “{guestConsentLine(room?.platforms)}”
      </FieldDescription>
      <ConfirmDialog
        confirmDisabled={rotating}
        confirmLabel={rotating ? 'Making…' : 'New link'}
        confirmVariant="default"
        description={NEW_LINK_CONFIRM_DESCRIPTION}
        open={asking}
        testId="guests-new-link"
        title="Make a new link?"
        onCancel={() => setAsking(false)}
        onConfirm={() => void rotate()}
      />
    </PanelSection>
  )
}

function WhoIsHere({
  people,
  requests,
  declinedCount,
  disabled
}: {
  people: RoomPerson[]
  requests: CloudRoomRequest[]
  declinedCount: number
  disabled: boolean
}): ReactElement {
  const { talkShow } = useStudioCloud()
  const { moderationItems, dialogs } = useGuestModeration(talkShow)
  const guests = people.filter((person) => !person.host)
  const declined = declinedLine(declinedCount)

  if (requests.length === 0 && guests.length === 0) {
    return (
      <>
        <p className="text-meta text-muted-foreground" data-testid="guests-empty">
          {NOBODY_YET}
        </p>
        {declined ? <p className="text-meta text-muted-foreground">{declined}</p> : null}
      </>
    )
  }

  return (
    <>
      <GroupedList aria-label="People in the room" data-testid="guests-list">
        {requests.map((request) => (
          <RequestRow disabled={disabled} key={request.requestId} request={request} />
        ))}
        {people.map((person) => {
          const quality = qualityStatus(person.quality)
          const items = moderationItems(person)
          return (
            <ListRow
              className="group/kebab-host"
              data-testid="guests-person"
              key={person.identity}
              statusIcons={<StatusDot label={quality.label} tone={quality.tone} />}
              title={person.name}
            >
              {person.muted && !person.host ? <Badge variant="outline">Muted</Badge> : null}
              <Badge variant={person.onStage ? 'default' : 'outline'}>
                {stageChipLabel(person)}
              </Badge>
              {items.length > 0 ? (
                <KebabMenu disabled={disabled} items={items} label={`Actions for ${person.name}`} />
              ) : null}
            </ListRow>
          )
        })}
      </GroupedList>
      {declined ? <p className="text-meta text-muted-foreground">{declined}</p> : null}
      {dialogs}
    </>
  )
}

/** "Ada wants to join" with Let in and Decline (D4). */
export function RequestRow({
  request,
  disabled
}: {
  request: CloudRoomRequest
  disabled: boolean
}): ReactElement {
  const { talkShow } = useStudioCloud()
  const [deciding, setDeciding] = useState(false)
  const decide = (decision: 'let-in' | 'decline'): void => {
    setDeciding(true)
    void talkShow
      .decideGuest(request.requestId, decision)
      .catch(() => {})
      .finally(() => setDeciding(false))
  }
  return (
    <ListRow
      context={requestDevice(request)}
      data-testid="guests-request"
      title={`${request.name} wants to join`}
    >
      <Button
        disabled={disabled || deciding}
        size="xs"
        type="button"
        onClick={() => decide('let-in')}
      >
        Let in
      </Button>
      <Button
        disabled={disabled || deciding}
        size="xs"
        type="button"
        variant="ghost"
        onClick={() => decide('decline')}
      >
        Decline
      </Button>
    </ListRow>
  )
}
