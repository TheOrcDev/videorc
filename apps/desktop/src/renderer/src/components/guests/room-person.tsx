import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import {
  DesktopIcon,
  DisplayIcon,
  MobileIcon,
  WaveformIcon,
  WaveformMutedIcon
} from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { ListRow } from '@/components/list-row'
import { CameraOffAvatar } from '@/components/studio/camera-off-avatar'
import { StatusDot } from '@/components/status-dot'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Toggle } from '@/components/ui/toggle'
import { useStudioCloud } from '@/hooks/use-studio'
import type { CloudRoomRequest } from '@/lib/backend'
import {
  guestScreenShare,
  micToggleLabel,
  personMicView,
  qualityStatus,
  requestDevice,
  requestTitle,
  type MicView,
  type RoomPerson
} from '@/lib/guests-view'
import type { TalkShowContextValue } from '@/lib/talk-show-context'
import { cameraPicture, nameInitial } from '@/lib/talk-show-tile'
import { cn } from '@/lib/utils'

// Plan 252: the parts of a person's row that the Show stage's lists and the
// Guests page share, so a guest looks and acts the same in both: their
// picture, their connection, their mic, their screen, and "wants to join".
// A picture or an icon says the state; the sentence is its tooltip, and
// every icon keeps its words for a screen reader.

/** A row with a picture in it: 40 px, between the 32 px fact row and a card. */
export const PERSON_ROW_CLASS = 'group/kebab-host h-10'

/** A `MediaStreamTrack` in a muted `<video>`, cover-fitted; nothing without one. */
function TrackPicture({ track }: { track: MediaStreamTrack | null }): ReactElement | null {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.srcObject = track ? new MediaStream([track]) : null
    if (track) void video.play().catch(() => {})
    return () => {
      video.srcObject = null
    }
  }, [track])
  if (!track) return null
  return <video autoPlay className="size-full object-cover" muted playsInline ref={ref} />
}

/**
 * A person's picture on their row: their camera, live, or the camera-off
 * letter the viewers see. A green rim while they talk: the one colour on the
 * row, and it is information.
 */
export function PersonThumb({
  name,
  track,
  cameraOff,
  speaking = false,
  className
}: {
  name: string
  track: MediaStreamTrack | null
  cameraOff: boolean
  speaking?: boolean
  className?: string
}): ReactElement {
  return (
    <span
      className={cn(
        'relative flex h-7 w-[50px] shrink-0 overflow-hidden rounded-chip bg-video-ground outline-2 outline-offset-1 outline-transparent',
        speaking && 'tone-success outline-(--chip-tone)',
        className
      )}
      data-slot="person-thumb"
      data-speaking={speaking || undefined}
    >
      <TrackPicture track={track} />
      {track ? null : (
        <CameraOffAvatar
          circle="20px"
          label={cameraOff ? 'Camera off' : 'No picture yet'}
          letter="11px"
          name={name}
        />
      )}
    </span>
  )
}

/** A shared screen, live, in a 16:9 frame: the picture a Screens card shows. */
export function ScreenThumb({ track }: { track: MediaStreamTrack | null }): ReactElement {
  return (
    <span
      className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-chip bg-video-ground"
      data-slot="screen-thumb"
    >
      <TrackPicture track={track} />
      {track ? null : <DisplayIcon aria-hidden className="size-5 text-video-ground-muted" />}
    </span>
  )
}

/** The connection: a dot only when it is not fine, its words always there for a screen reader. */
export function ConnectionDot({ person }: { person: RoomPerson }): ReactElement {
  const quality = qualityStatus(person.quality)
  if (quality.tone === 'good') return <span className="sr-only">{quality.label}</span>
  return (
    <InfoTooltip content={quality.label}>
      <span className="flex size-4 items-center justify-center" data-testid="person-connection">
        <StatusDot tone={quality.tone} />
        <span className="sr-only">{quality.label}</span>
      </span>
    </InfoTooltip>
  )
}

/**
 * The words a row needs beside the icons: the host's hold and a mic the guest
 * turned off read alike as icons, so each says which it is (D14), and "Away"
 * names a guest whose camera stopped sending.
 */
export function PersonStateBadges({
  person,
  mic,
  testId
}: {
  person: RoomPerson
  mic: MicView
  /** The mic badge's test id. */
  testId?: string
}): ReactElement {
  return (
    <>
      {person.away ? (
        <InfoTooltip
          content={`${person.name}'s camera stopped sending. Viewers see “Back in a moment”.`}
        >
          <Badge data-testid="person-away" variant="warning">
            Away
          </Badge>
        </InfoTooltip>
      ) : null}
      {mic.state === 'held' || mic.state === 'off' ? (
        <InfoTooltip content={mic.hint}>
          <Badge data-mic={mic.state} data-testid={testId} variant="outline">
            {mic.label}
          </Badge>
        </InfoTooltip>
      ) : null}
    </>
  )
}

/**
 * The mic on a row, as one control: its icon is the state (talking, quiet,
 * muted) and pressing it is the host's hold on a guest's mic, or the host's
 * own mute. Pressed means muted, as the mixer's mute buttons do.
 */
export function MicToggle({
  mic,
  label,
  pressed,
  disabled,
  testId,
  onToggle
}: {
  mic: MicView
  /** What a press does: "Mute Ada", "Let Ada unmute". */
  label: string
  pressed: boolean
  disabled: boolean
  testId?: string
  onToggle: () => void
}): ReactElement {
  const silent = mic.state === 'held' || mic.state === 'off' || mic.state === 'muted'
  return (
    <InfoTooltip content={label} focusable={false}>
      <Toggle
        aria-label={label}
        data-mic={mic.state}
        data-testid={testId}
        disabled={disabled}
        pressed={pressed}
        size="xs"
        onPressedChange={() => onToggle()}
      >
        {silent ? (
          <WaveformMutedIcon aria-hidden />
        ) : (
          <WaveformIcon
            aria-hidden
            className={mic.state === 'talking' ? 'tone-success text-(--chip-tone)' : undefined}
          />
        )}
        <span className="sr-only" data-slot="mic-state">
          {mic.label}
        </span>
      </Toggle>
    </InfoTooltip>
  )
}

/**
 * A guest's screen share on their row (plan 252): off, allowed, or sharing.
 * Pressed means they may share; a green dot means they are sharing now.
 * Which screen the program shows is chosen under Screens on the Show stage.
 */
export function ScreenShareToggle({
  person,
  disabled,
  onToggle
}: {
  person: RoomPerson
  disabled: boolean
  onToggle: () => void
}): ReactElement {
  const share = guestScreenShare(person)
  return (
    <InfoTooltip content={share.hint} focusable={false}>
      <Toggle
        aria-label={share.actionLabel}
        className="relative"
        data-screen-share={share.state}
        data-testid="person-screen-share"
        disabled={disabled}
        pressed={share.state !== 'off'}
        size="xs"
        onPressedChange={() => onToggle()}
      >
        <DisplayIcon aria-hidden />
        {share.state === 'sharing' ? (
          <span
            aria-hidden
            className="tone-success glass-dot absolute top-0.5 right-0.5 size-1.5 rounded-full"
          />
        ) : null}
        <span className="sr-only">{share.label}</span>
      </Toggle>
    </InfoTooltip>
  )
}

/** "Ada wants to join" with Let in and Decline (D4), on the Show stage and on Guests. */
export function RequestRow({
  request,
  disabled,
  testId = 'guests-request'
}: {
  request: CloudRoomRequest
  disabled: boolean
  testId?: string
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
  const DeviceIcon = request.device === 'phone' ? MobileIcon : DesktopIcon
  return (
    <ListRow
      className={PERSON_ROW_CLASS}
      data-testid={testId}
      leading={
        // No camera yet: a letter, never an empty picture frame.
        <Avatar size="sm">
          <AvatarFallback aria-hidden>{nameInitial(request.name)}</AvatarFallback>
        </Avatar>
      }
      alias={
        <InfoTooltip className="self-center" content={requestDevice(request)}>
          <span className="flex text-muted-foreground">
            <DeviceIcon aria-label={requestDevice(request)} className="size-4" role="img" />
          </span>
        </InfoTooltip>
      }
      title={requestTitle(request)}
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

/** A list's label with its count, as the sidebar counts things: "On stage 3". */
export function CountLabel({
  children,
  count
}: {
  children: ReactNode
  count: number
}): ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      {children}
      <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
    </span>
  )
}

/**
 * One person's row, the same on the Show stage and on Guests: their picture
 * (live, with a green rim while they talk), their name, what is wrong when
 * something is (a weak connection, away, a mic that is off), then the mic,
 * a guest's screen share, whatever the page adds (the stage move), and ⋯.
 */
export function PersonRow({
  person,
  talkShow,
  disabled,
  menuItems,
  testId,
  micTestId,
  micBadgeTestId,
  onToggleMute,
  onToggleScreenShare,
  children
}: {
  person: RoomPerson
  talkShow: TalkShowContextValue
  /** The room is not open, or the page is locked. */
  disabled: boolean
  menuItems: KebabMenuItem[]
  testId: string
  micTestId?: string
  micBadgeTestId?: string
  /** The host's hold on a guest's mic; the host's own mute is the row's. */
  onToggleMute: (person: RoomPerson) => void
  onToggleScreenShare: (person: RoomPerson) => void
  /** The page's own controls, between the toggles and ⋯. */
  children?: ReactNode
}): ReactElement {
  const local = talkShow.room.local
  const remote = talkShow.room.people.find((entry) => entry.identity === person.identity)
  const picture = person.host
    ? cameraPicture(local.camera, local.cameraOff)
    : cameraPicture(remote?.video, remote?.cameraOff)
  const mic = personMicView(person, {
    localMicMuted: local.micMuted,
    roomMicMuted: Boolean(remote?.micMuted),
    speaking: Boolean(remote?.speaking)
  })
  return (
    <ListRow
      alias={
        <span className="flex shrink-0 items-center gap-1.5 self-center">
          <ConnectionDot person={person} />
          <PersonStateBadges mic={mic} person={person} testId={micBadgeTestId} />
        </span>
      }
      className={PERSON_ROW_CLASS}
      data-stage-identity={person.identity}
      data-testid={testId}
      leading={
        <PersonThumb
          cameraOff={picture.cameraOff}
          name={person.name}
          speaking={mic.state === 'talking'}
          track={picture.track}
        />
      }
      title={person.name}
    >
      <MicToggle
        disabled={disabled}
        label={micToggleLabel(person, local.micMuted)}
        mic={mic}
        pressed={person.host ? local.micMuted : person.muted}
        testId={micTestId}
        onToggle={() =>
          person.host
            ? void talkShow.setMicrophoneMuted(!local.micMuted).catch(() => {})
            : onToggleMute(person)
        }
      />
      {person.host || !person.guestId ? null : (
        <ScreenShareToggle
          disabled={disabled}
          person={person}
          onToggle={() => onToggleScreenShare(person)}
        />
      )}
      {children}
      {menuItems.length > 0 ? (
        <KebabMenu disabled={disabled} items={menuItems} label={`More for ${person.name}`} />
      ) : null}
    </ListRow>
  )
}
