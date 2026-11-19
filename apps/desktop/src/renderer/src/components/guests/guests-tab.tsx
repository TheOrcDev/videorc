import { talkShowOutputPlan } from '@/lib/talk-show-outputs'
import { managedProfileDescription } from '../../../../shared/cloud-output-profile'
import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { useGuestModeration } from '@/components/guests/guest-moderation'
import { CloseRoomButton } from '@/components/guests/close-room-button'
import { CloudIsoSection } from '@/components/guests/cloud-iso-section'
import { CountLabel, PersonRow, RequestRow } from '@/components/guests/room-person'
import {
  CheckIcon,
  CopyIcon,
  ImageIcon,
  LinkIcon,
  OutputIcon,
  RefreshIcon,
  SparkleIcon,
  type AppIcon
} from '@/components/icons'
import { GroupedList } from '@/components/list-row'
import { LockAlert, OfflineAlert, SessionLockAlert } from '@/components/lock-alert'
import { PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { SectionLabel } from '@/components/section-label'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty } from '@/components/ui/empty'
import {
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSet,
  SettingsRow
} from '@/components/ui/field'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
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
  outputProfileChips,
  roomCounts,
  roomIsFull,
  roomLimits,
  roomLimitsLine,
  liveRoomQuality,
  roomPeople,
  roomPhaseLabel,
  type RoomPerson
} from '@/lib/guests-view'
import { VIDEORC_PREMIUM_URL } from '@/lib/videorc-web-links'
import {
  roomAvatarDescription,
  roomGraphicsDescription,
  roomOptInTone,
  type RoomProgramOptIn
} from '@/lib/room-program-opt-ins'
import { guestGraphicsLine, isManagedShow } from '@/lib/talk-show-managed'
import type { CloudRoomRequest } from '@/lib/backend'

/**
 * The Guests page (plan 224 C-G2, D16; its own page since 0.31.1): the room, the invite link and who
 * is in it. One home for Open the room, Close the room, the link and the door
 * switch; the stage itself (Bring on, Send backstage, the layout, the
 * screens) is the Show stage in the Studio (C-G3). People are rows with
 * their picture, in On stage and Backstage, as on the Show stage (plan 252). Locked means disabled, with
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
  const outputPlan = talkShowOutputPlan(captureConfig)
  const disabled = offline || locked || sessionLocked || (!roomOpen && !!outputPlan.problem)
  const limits = roomLimits(cloudStatus)
  const limitsLine = roomLimitsLine(limits)
  const people = roomPeople(
    room,
    talkShow.hostIdentity,
    // Plan 253 S4: a managed show's dot reads LiveKit's own quality.
    isManagedShow(cloudStatus) ? liveRoomQuality(talkShow.room) : undefined
  )
  const requests = room?.requests ?? []
  const full = roomOpen && roomIsFull(people, limits)
  const roomPending = opening || phase === 'opening'
  // Plan 249 S4/S9: a managed show's program takes the room's avatar and
  // graphics once the streamer turns them on here (their one home).
  const programOptIns = isManagedShow(cloudStatus)
  const counts = roomCounts(room, people)
  const profileChips = outputProfileChips(cloudStatus?.show?.outputProfile)

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
            label={
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot
                  pulse={roomPending || phase === 'closing'}
                  tone={roomOpen ? 'good' : 'neutral'}
                />
                <span className="truncate">{roomPhaseLabel(room)}</span>
              </span>
            }
          >
            {/* The room in numbers: who is where, and who waits on the host. */}
            {roomOpen ? (
              <span
                className="flex shrink-0 flex-wrap items-center justify-end gap-1"
                data-testid="guests-room-counts"
              >
                {counts.asking > 0 ? (
                  <Badge variant="warning">
                    {counts.asking === 1 ? '1 wants to join' : `${counts.asking} want to join`}
                  </Badge>
                ) : null}
                <Badge variant="outline">{counts.onStage} on stage</Badge>
                <Badge variant="outline">{counts.backstage} backstage</Badge>
              </span>
            ) : null}
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
        </FieldGroup>
        {/* Plan 249 S17: before the room opens, what it will send (or why it
            can't open); once open, what the room reported it sends, as short
            facts with the whole sentence on hover. */}
        {roomOpen && profileChips.length > 0 ? (
          <InfoTooltip content={managedProfileDescription(cloudStatus?.show?.outputProfile)}>
            <span
              className="flex min-w-0 flex-wrap items-center gap-1 px-1 text-meta text-muted-foreground"
              data-testid="cloud-output-profile"
            >
              <OutputIcon aria-hidden className="size-3.5 shrink-0" />
              <span>Sends</span>
              {profileChips.map((output) => (
                <Badge key={output.orientation} variant={output.differs ? 'warning' : 'outline'}>
                  {output.facts.join(' · ')}
                </Badge>
              ))}
              <span className="sr-only">
                {managedProfileDescription(cloudStatus?.show?.outputProfile)}
              </span>
            </span>
          </InfoTooltip>
        ) : !roomOpen || cloudStatus?.show?.outputProfile ? (
          <FieldDescription data-testid="cloud-output-profile">
            {roomOpen
              ? managedProfileDescription(cloudStatus?.show?.outputProfile)
              : outputPlan.description}
          </FieldDescription>
        ) : null}
        {programOptIns ? (
          <RoomProgramOptIns
            disabledReason={disabled ? null : !roomOpen ? OPEN_THE_ROOM_FIRST : null}
            disabled={disabled || !roomOpen}
          />
        ) : null}
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

      {/* Plan 249 S22: opt-in separate files per person and source. */}
      <CloudIsoSection />
    </PageStack>
  )
}

/**
 * Plan 249 S4/S9: the room's avatar and graphics on the program, each off
 * until turned on for this room. Guests see the avatar only once it is on.
 */
function RoomProgramOptIns({
  disabled,
  disabledReason
}: {
  disabled: boolean
  disabledReason: string | null
}): ReactElement {
  const { talkShow } = useStudioCloud()
  const { avatar, graphics } = talkShow.room
  const avatarOn = avatar?.enabled === true
  return (
    <FieldSet className="min-w-0 gap-0" data-testid="guests-program">
      <FieldLegend className="mb-1.5 px-1" variant="label">
        <SectionLabel>On the program</SectionLabel>
      </FieldLegend>
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="guests-program-avatar"
          description={roomAvatarDescription(avatar)}
          label={<OptInLabel icon={SparkleIcon} optIn={avatar} title="Avatar" />}
        >
          <DisabledReason reason={disabledReason}>
            <Switch
              aria-label="Avatar on the program"
              checked={avatarOn}
              disabled={disabled}
              onCheckedChange={(on) => void talkShow.setAvatarEnabled(on).catch(() => {})}
            />
          </DisabledReason>
        </SettingsRow>
        {avatarOn ? (
          <SettingsRow
            data-testid="guests-program-avatar-guests"
            description={guestGraphicsLine(avatar?.guests, avatar?.preview?.output ?? null)}
            label="Show the avatar to guests"
          >
            <Switch
              aria-label="Show the avatar to guests"
              checked={avatar?.guests?.enabled === true}
              disabled={disabled}
              onCheckedChange={(on) => void talkShow.setAvatarGuests(on).catch(() => {})}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          data-testid="guests-program-graphics"
          description={roomGraphicsDescription(graphics)}
          label={<OptInLabel icon={ImageIcon} optIn={graphics} title="Graphics" />}
        >
          <DisabledReason reason={disabledReason}>
            <Switch
              aria-label="Graphics on the program"
              checked={graphics?.enabled === true}
              disabled={disabled}
              onCheckedChange={(on) => void talkShow.setGraphicsEnabled(on).catch(() => {})}
            />
          </DisabledReason>
        </SettingsRow>
      </FieldGroup>
    </FieldSet>
  )
}

/** An opt-in's name with its icon and its state as a dot; the sentence is the description. */
function OptInLabel({
  icon: Icon,
  title,
  optIn
}: {
  icon: AppIcon
  title: string
  optIn: RoomProgramOptIn | null | undefined
}): ReactElement {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      <span className="truncate">{title}</span>
      {/* Off needs no dot: the switch says it. */}
      {optIn?.enabled ? <StatusDot tone={roomOptInTone(optIn)} /> : null}
    </span>
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
        <InputGroup className="min-w-0 flex-1" data-disabled={disabled || noLink}>
          <InputGroupAddon>
            <LinkIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Invite link"
            className="min-w-0 select-text"
            data-testid="guests-invite-url"
            disabled={disabled || noLink}
            placeholder="The link appears when the room opens."
            readOnly
            value={inviteUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </InputGroup>
        <DisabledReason reason={linkReason}>
          <Button
            data-testid="guests-invite-copy"
            disabled={disabled || noLink}
            type="button"
            variant="secondary"
            onClick={() => void copy(inviteUrl, "Couldn't copy the link.")}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
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
            {rotating ? (
              <Spinner aria-hidden data-icon="inline-start" />
            ) : (
              <RefreshIcon data-icon="inline-start" />
            )}
            {rotating ? 'Making…' : 'New link'}
          </Button>
        </DisabledReason>
      </div>
      {/* The door belongs to the link: who it lets in without asking. */}
      <FieldGroup variant="grouped">
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
  const { moderationItems, toggleMute, toggleScreenShare, dialogs } = useGuestModeration(talkShow)
  const guests = people.filter((person) => !person.host)
  const declined = declinedLine(declinedCount)

  if (requests.length === 0 && guests.length === 0) {
    return (
      <>
        <Empty className="rounded-row border border-border bg-inset p-5" data-testid="guests-empty">
          <span className="text-meta text-muted-foreground">{NOBODY_YET}</span>
        </Empty>
        {declined ? <p className="text-meta text-muted-foreground">{declined}</p> : null}
      </>
    )
  }

  // The host is always on stage (H2), whatever the stage names yet.
  const onStage = people.filter((person) => person.host || person.onStage)
  const backstage = people.filter((person) => !person.host && !person.onStage)
  const row = (person: RoomPerson): ReactElement => (
    <PersonRow
      disabled={disabled}
      key={person.identity}
      menuItems={moderationItems(person)}
      micBadgeTestId="guests-person-mic"
      person={person}
      talkShow={talkShow}
      testId="guests-person"
      onToggleMute={toggleMute}
      onToggleScreenShare={toggleScreenShare}
    />
  )

  return (
    <div className="flex flex-col gap-4" data-testid="guests-list">
      {requests.length > 0 ? (
        <GroupedList
          aria-label="Wants to join"
          label={
            <span className="flex items-center gap-1.5">
              <StatusDot pulse tone="warn" />
              <CountLabel count={requests.length}>Wants to join</CountLabel>
            </span>
          }
        >
          {requests.map((request) => (
            <RequestRow disabled={disabled} key={request.requestId} request={request} />
          ))}
        </GroupedList>
      ) : null}
      {onStage.length > 0 ? (
        <GroupedList
          aria-label="On stage"
          label={<CountLabel count={onStage.length}>On stage</CountLabel>}
        >
          {onStage.map(row)}
        </GroupedList>
      ) : null}
      {backstage.length > 0 ? (
        <GroupedList
          aria-label="Backstage"
          label={<CountLabel count={backstage.length}>Backstage</CountLabel>}
        >
          {backstage.map(row)}
        </GroupedList>
      ) : null}
      {declined ? <p className="text-meta text-muted-foreground">{declined}</p> : null}
      {dialogs}
    </div>
  )
}
