import { useEffect, useRef, useState, type ReactElement } from 'react'

import { useGuestModeration } from '@/components/guests/guest-moderation'
import { CloseRoomButton } from '@/components/guests/close-room-button'
import {
  DisplayIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  WaveformIcon,
  WaveformMutedIcon
} from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { GroupedList, ListRow } from '@/components/list-row'
import { MediaCard } from '@/components/media-card'
import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { PREVIEW_REPLACED_BY_SHOW_STAGE } from '@/components/preview-stage'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Empty } from '@/components/ui/empty'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCloud } from '@/hooks/use-studio'
import type {
  CloudRoomParticipant,
  CloudRoomRequest,
  CloudStageLayout,
  TalkShowDisplaySource
} from '@/lib/backend'
import {
  bringOnBlockedReason,
  layoutOptions,
  layoutReasonsLine,
  qualityStatus,
  requestTitle,
  roomLimits,
  roomPeople,
  shownLayout,
  type RoomPerson
} from '@/lib/guests-view'
import { openLivestreamView } from '@/lib/livestream-tabs'
import type { TalkShowContextValue } from '@/lib/talk-show-context'
import type { TalkShowPerson } from '@/lib/talk-show-room'
import { PROGRAM_MONITOR_EMPTY } from '@/lib/talk-show-session'
import {
  planStage,
  stageRectPercent,
  type StageCanvas,
  type StageTile
} from '@/lib/talk-show-layout'
import { cn } from '@/lib/utils'

// The Show stage (plan 224 C-G3, D7, D8): while the room is open it replaces
// the Studio's Preview. The renderer draws the room's tracks with the
// runner's own geometry, so the host acts on the picture the cloud sends,
// 150 to 300 ms behind the room instead of the return's half second. Under
// it: the layout, the screen share, the Program monitor (the return), "Ada
// wants to join", and the backstage strip, the one home of Bring on and Send
// backstage. Loaded only while the room is open.

/** The stage's own canvas: the runner's 16:9 horizontal output. */
const STAGE_CANVAS: StageCanvas = { width: 1920, height: 1080 }
/** At most this many join requests stand above the strip; the rest wait on Guests. */
const REQUESTS_SHOWN = 3

const cqw = (px: number): string => `${(px / STAGE_CANVAS.width) * 100}cqw`

export default function ShowStage(): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const room = cloudStatus?.room
  const people = roomPeople(room, talkShow.hostIdentity)
  const limits = roomLimits(cloudStatus)
  const requests = room?.requests ?? []
  const connected = talkShow.room.state === 'connected'

  // The Program monitor subscribes to the return while the stage is on
  // screen and the room is joined (D7); it lets go when the stage goes.
  const setMonitorRef = useRef(talkShow.setMonitor)
  setMonitorRef.current = talkShow.setMonitor
  useEffect(() => {
    if (!connected) return
    void setMonitorRef.current(true).catch(() => {})
    return () => void setMonitorRef.current(false).catch(() => {})
  }, [connected])

  return (
    <PanelSection
      action={<CloseRoomButton testId="show-stage-close-room" />}
      className="@container/show-stage"
      data-testid="show-stage"
      description={
        <span data-testid="preview-replaced-by-show-stage">{PREVIEW_REPLACED_BY_SHOW_STAGE}</span>
      }
      title="Show stage"
    >
      <StageWell talkShow={talkShow} />
      <StageControls talkShow={talkShow} />
      {talkShow.room.local.problem ? (
        <Alert variant="warning">
          <AlertTitle>{talkShow.room.local.problem}</AlertTitle>
        </Alert>
      ) : null}
      <JoinRequests requests={requests} talkShow={talkShow} />
      <BackstageStrip limitsBlocked={bringOnBlockedReason(people, limits)} people={people} />
    </PanelSection>
  )
}

// --- The stage -----------------------------------------------------------------

function StageWell({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const room = cloudStatus?.room
  const stage = room?.stage
  const plan = planStage(STAGE_CANVAS, {
    layout: stage?.layout ?? 'solo',
    people: stage?.onStage ?? [],
    spotlight: stage?.spotlight ?? null,
    screen: stage?.screen ?? null
  })
  const state = talkShow.room.state
  const joining = state === 'connecting' || state === 'reconnecting'
  return (
    <div
      className="relative w-full overflow-hidden rounded-panel bg-video-ground [container-type:inline-size]"
      data-testid="show-stage-well"
      style={{ aspectRatio: `${STAGE_CANVAS.width} / ${STAGE_CANVAS.height}` }}
    >
      {plan.tiles.map((tile) => (
        <StageTileView
          key={`${tile.kind}:${tile.identity}`}
          participant={room?.participants?.find((entry) => entry.identity === tile.identity)}
          talkShow={talkShow}
          tile={tile}
        />
      ))}
      {plan.tiles.length === 0 ? (
        <Empty className="absolute inset-0 text-video-ground-muted">Nobody is on stage.</Empty>
      ) : null}
      {joining ? (
        <span
          className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-video-ground/80 px-2.5 py-1 text-xs text-video-ground-foreground"
          role="status"
        >
          <Spinner aria-hidden />
          {state === 'connecting' ? 'Joining the room…' : 'Reconnecting…'}
        </span>
      ) : null}
    </div>
  )
}

/** The track a tile shows: the host's own media, or a guest's from the room. */
function tileTrack(
  tile: StageTile,
  talkShow: TalkShowContextValue
): { track: MediaStreamTrack | null; cameraOff: boolean; name: string } {
  const host = tile.identity === talkShow.hostIdentity
  if (host) {
    const local = talkShow.room.local
    return tile.kind === 'screen'
      ? { track: local.screen, cameraOff: false, name: 'Your screen' }
      : { track: local.cameraOff ? null : local.camera, cameraOff: local.cameraOff, name: 'You' }
  }
  const person: TalkShowPerson | undefined = talkShow.room.people.find(
    (entry) => entry.identity === tile.identity
  )
  if (tile.kind === 'screen') {
    return {
      track: person?.screen ?? null,
      cameraOff: false,
      name: `${person?.name ?? ''}'s screen`
    }
  }
  return {
    track: person?.cameraOff ? null : (person?.video ?? null),
    cameraOff: Boolean(person?.cameraOff),
    name: person?.name ?? ''
  }
}

function StageTileView({
  tile,
  participant,
  talkShow
}: {
  tile: StageTile
  participant: CloudRoomParticipant | undefined
  talkShow: TalkShowContextValue
}): ReactElement {
  const { track, cameraOff, name } = tileTrack(tile, talkShow)
  const label = name || participant?.name || ''
  return (
    <div
      className="absolute overflow-hidden bg-inset"
      data-stage-identity={tile.identity}
      data-stage-kind={tile.kind}
      data-testid="show-stage-tile"
      style={{ ...stageRectPercent(STAGE_CANVAS, tile.rect), borderRadius: cqw(tile.cornerRadius) }}
    >
      <TrackVideo
        className={tile.kind === 'screen' ? 'object-contain' : 'object-cover'}
        track={track}
      />
      {!track ? (
        <span className="absolute inset-0 flex items-center justify-center text-sm text-video-ground-muted">
          {cameraOff
            ? 'Camera off'
            : tile.kind === 'screen'
              ? 'Waiting for the screen'
              : 'No picture yet'}
        </span>
      ) : null}
      {participant?.away && tile.kind === 'person' ? (
        <span className="absolute inset-0 flex items-center justify-center bg-video-ground/60 text-sm font-medium text-video-ground-foreground">
          Back in a moment
        </span>
      ) : null}
      {tile.plate && label ? (
        <span
          className="absolute flex items-end"
          style={{
            left: cqw(tile.plate.x - tile.rect.x),
            bottom: cqw(tile.rect.y + tile.rect.h - (tile.plate.y + tile.plate.h)),
            width: cqw(tile.plate.w),
            height: cqw(tile.plate.h)
          }}
        >
          <span className="max-w-full truncate rounded-full bg-video-ground/70 px-[max(8px,0.8cqw)] py-[max(2px,0.3cqw)] text-[max(11px,1.3cqw)] font-medium text-video-ground-foreground">
            {label}
          </span>
        </span>
      ) : null}
    </div>
  )
}

/** A `MediaStreamTrack` in a muted `<video>`; nothing while there is none. */
function TrackVideo({
  track,
  className
}: {
  track: MediaStreamTrack | null
  className?: string
}): ReactElement | null {
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
  return <video autoPlay className={cn('size-full', className)} muted playsInline ref={ref} />
}

// --- Under the stage -----------------------------------------------------------

function StageControls({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const room = cloudStatus?.room
  const options = layoutOptions(room)
  const reasons = layoutReasonsLine(options)
  const roomOpen = room?.phase === 'open'
  // Narrow, the Program monitor goes under the controls instead of beside
  // them, so the four layout chips keep their row.
  return (
    <div className="flex min-w-0 flex-col gap-3 @min-[36rem]/show-stage:flex-row @min-[36rem]/show-stage:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <SegmentedControl<CloudStageLayout>
          aria-label="Layout"
          disabled={!roomOpen}
          options={options.map((option) => ({
            value: option.value,
            label: option.label,
            disabled: option.disabledReason !== null
          }))}
          value={shownLayout(room)}
          onValueChange={(layout) => void talkShow.setLayout(layout).catch(() => {})}
        />
        {roomOpen && reasons ? (
          <p className="text-meta text-muted-foreground" data-testid="show-stage-layout-reasons">
            {reasons}
          </p>
        ) : null}
        <ScreenShareButton disabled={!roomOpen} talkShow={talkShow} />
      </div>
      <ProgramMonitor talkShow={talkShow} />
    </div>
  )
}

function ScreenShareButton({
  talkShow,
  disabled
}: {
  talkShow: TalkShowContextValue
  disabled: boolean
}): ReactElement {
  const [sources, setSources] = useState<TalkShowDisplaySource[] | null>(null)
  const [pending, setPending] = useState(false)
  const sharing = talkShow.room.local.screen !== null

  const pick = async (): Promise<void> => {
    setPending(true)
    try {
      setSources(await talkShow.listDisplaySources())
    } finally {
      setPending(false)
    }
  }

  const share = async (sourceId: string): Promise<void> => {
    setSources(null)
    setPending(true)
    try {
      await talkShow.startScreenShare(sourceId)
    } catch {
      // The controller's toast says why.
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {sharing ? (
        <Button
          data-testid="show-stage-stop-share"
          disabled={disabled || pending}
          type="button"
          variant="outline"
          onClick={() => void talkShow.stopScreenShare().catch(() => {})}
        >
          Stop sharing
        </Button>
      ) : (
        <Button
          data-testid="show-stage-share"
          disabled={disabled || pending}
          type="button"
          variant="outline"
          onClick={() => void pick()}
        >
          {pending ? (
            <Spinner aria-hidden data-icon="inline-start" />
          ) : (
            <DisplayIcon data-icon="inline-start" />
          )}
          Share screen…
        </Button>
      )}
      <Dialog open={sources !== null} onOpenChange={(open) => !open && setSources(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Share a screen</DialogTitle>
            <DialogDescription>
              Your guests and your viewers see it. Pick a screen or one window.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {sources && sources.length === 0 ? (
              <Empty>Nothing to share. Check Screen Recording in System Settings.</Empty>
            ) : (
              <Gallery dense>
                {(sources ?? []).map((source) => (
                  <MediaCard
                    interactive
                    key={source.id}
                    render={<button type="button" onClick={() => void share(source.id)} />}
                  >
                    {source.thumbnailDataUrl ? (
                      <img
                        alt=""
                        className="aspect-video w-full rounded-chip object-cover"
                        src={source.thumbnailDataUrl}
                      />
                    ) : (
                      <span className="flex aspect-video w-full items-center justify-center rounded-chip bg-inset">
                        <DisplayIcon className="size-5 text-muted-foreground" />
                      </span>
                    )}
                    <span className="truncate px-1 pt-1.5 text-left text-sm">{source.name}</span>
                  </MediaCard>
                ))}
              </Gallery>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * The Program monitor (D7): the return, what the cloud really sends, about
 * half a second behind. Muted by default; its speaker plays the return so the
 * host can check the mix (their own voice comes back late: a check, not a
 * monitor).
 */
function ProgramMonitor({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const [listening, setListening] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const { video, audio } = talkShow.room.monitor
  const live = Boolean(cloudStatus?.room?.live || cloudStatus?.recording?.active)

  useEffect(() => {
    const element = audioRef.current
    if (!element) return
    element.srcObject = audio ? new MediaStream([audio]) : null
    if (audio) void element.play().catch(() => {})
    return () => {
      element.srcObject = null
    }
  }, [audio])

  return (
    <div
      className="flex w-1/2 min-w-36 flex-col gap-1.5 self-end @min-[36rem]/show-stage:w-1/4"
      data-testid="show-stage-program"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-label text-subtle">Program</span>
        <Button
          aria-label={listening ? 'Mute the program' : 'Listen to the program'}
          aria-pressed={listening}
          disabled={!audio}
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={() => setListening((value) => !value)}
        >
          {listening ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
        </Button>
      </div>
      <div className="relative aspect-video w-full overflow-hidden rounded-row bg-video-ground">
        <TrackVideo className="object-contain" track={video} />
        {!video ? (
          <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-video-ground-muted">
            {live ? 'Waiting for the program…' : PROGRAM_MONITOR_EMPTY}
          </span>
        ) : null}
      </div>
      <audio muted={!listening} ref={audioRef} />
    </div>
  )
}

// --- Requests and the backstage strip ----------------------------------------

function JoinRequests({
  requests,
  talkShow
}: {
  requests: CloudRoomRequest[]
  talkShow: TalkShowContextValue
}): ReactElement | null {
  const [deciding, setDeciding] = useState<string | null>(null)
  if (requests.length === 0) return null
  const decide = (request: CloudRoomRequest, decision: 'let-in' | 'decline'): void => {
    setDeciding(request.requestId)
    void talkShow
      .decideGuest(request.requestId, decision)
      .catch(() => {})
      .finally(() => setDeciding(null))
  }
  const more = requests.length - REQUESTS_SHOWN
  return (
    <div className="flex flex-col gap-2" data-testid="show-stage-requests">
      {requests.slice(0, REQUESTS_SHOWN).map((request) => (
        <Alert data-testid="show-stage-request" key={request.requestId} variant="warning">
          <AlertTitle>{requestTitle(request)}</AlertTitle>
          <AlertAction className="flex gap-1">
            <Button
              disabled={deciding === request.requestId}
              size="xs"
              type="button"
              onClick={() => decide(request, 'let-in')}
            >
              Let in
            </Button>
            <Button
              disabled={deciding === request.requestId}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => decide(request, 'decline')}
            >
              Decline
            </Button>
          </AlertAction>
        </Alert>
      ))}
      {more > 0 ? (
        <Button
          className="self-start"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => openLivestreamView('guests')}
        >
          {more === 1 ? '1 more wants to join' : `${more} more want to join`}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The backstage strip: everyone in the room, the one home of Bring on and
 * Send backstage (D16). A row per person: their picture, name, connection,
 * whether they're talking, Bring on or Send backstage, Mute, and ⋯.
 */
function BackstageStrip({
  people,
  limitsBlocked
}: {
  people: RoomPerson[]
  limitsBlocked: string | null
}): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const { moderationItems, toggleMute, dialogs } = useGuestModeration(talkShow)
  const roomOpen = cloudStatus?.room?.phase === 'open'
  const stage = cloudStatus?.room?.stage
  if (people.length === 0) return <></>
  return (
    <>
      <GroupedList aria-label="In the room" data-testid="show-stage-strip" label="In the room">
        {people.map((person) => (
          <StripRow
            bringOnBlocked={person.host ? null : limitsBlocked}
            disabled={!roomOpen}
            key={person.identity}
            moderation={moderationItems(person)}
            person={person}
            spotlit={stage?.layout === 'spotlight' && stage.spotlight === person.identity}
            talkShow={talkShow}
            onMute={() => toggleMute(person)}
          />
        ))}
      </GroupedList>
      {dialogs}
    </>
  )
}

function StripRow({
  person,
  talkShow,
  disabled,
  bringOnBlocked,
  spotlit,
  moderation,
  onMute
}: {
  person: RoomPerson
  talkShow: TalkShowContextValue
  disabled: boolean
  bringOnBlocked: string | null
  spotlit: boolean
  moderation: KebabMenuItem[]
  onMute: () => void
}): ReactElement {
  const local = talkShow.room.local
  const remote = talkShow.room.people.find((entry) => entry.identity === person.identity)
  const thumbnail = person.host ? (local.cameraOff ? null : local.camera) : (remote?.video ?? null)
  const muted = person.host ? local.micMuted : person.muted || Boolean(remote?.micMuted)
  const speaking = !muted && Boolean(remote?.speaking)
  const quality = qualityStatus(person.quality)
  const quietQuality = quality.tone === 'good'
  const blocked = !person.onStage ? bringOnBlocked : null

  const items: KebabMenuItem[] = [
    spotlit
      ? {
          id: 'spotlight',
          label: 'End spotlight',
          group: 'stage',
          onSelect: () => void talkShow.setLayout('side-by-side').catch(() => {})
        }
      : {
          id: 'spotlight',
          label: 'Spotlight',
          group: 'stage',
          disabled: !person.onStage,
          disabledReason: person.onStage ? null : 'Bring them on first.',
          onSelect: () => void talkShow.setSpotlight(person.identity).catch(() => {})
        },
    ...(person.host
      ? [
          {
            id: 'camera',
            label: local.cameraOff ? 'Turn camera on' : 'Turn camera off',
            group: 'stage',
            onSelect: () => void talkShow.setCameraOff(!local.cameraOff).catch(() => {})
          }
        ]
      : moderation)
  ]

  return (
    <ListRow
      className="group/kebab-host"
      compact
      data-stage-identity={person.identity}
      data-testid="show-stage-strip-row"
      leading={
        <span className="relative flex h-5 w-9 shrink-0 overflow-hidden rounded-chip bg-video-ground">
          <TrackVideo className="object-cover" track={thumbnail} />
        </span>
      }
      statusIcons={
        <>
          {quietQuality ? (
            <span className="sr-only">{quality.label}</span>
          ) : (
            <InfoTooltip content={quality.label}>
              <span>
                <StatusDot tone={quality.tone} />
                <span className="sr-only">{quality.label}</span>
              </span>
            </InfoTooltip>
          )}
          {muted ? (
            <WaveformMutedIcon aria-label="Muted" role="img" />
          ) : (
            <WaveformIcon
              aria-label={speaking ? 'Talking' : 'Quiet'}
              className={speaking ? 'text-foreground' : undefined}
              role="img"
            />
          )}
        </>
      }
      title={person.name}
    >
      <DisabledReason reason={blocked}>
        <Button
          data-testid={person.onStage ? 'show-stage-send-backstage' : 'show-stage-bring-on'}
          disabled={disabled || blocked !== null}
          size="xs"
          type="button"
          variant={person.onStage ? 'outline' : 'secondary'}
          onClick={() =>
            void (
              person.onStage
                ? talkShow.sendBackstage(person.identity)
                : talkShow.bringOn(person.identity)
            ).catch(() => {})
          }
        >
          {person.onStage ? 'Send backstage' : 'Bring on'}
        </Button>
      </DisabledReason>
      <Button
        aria-label={
          person.host
            ? undefined
            : person.muted
              ? `Let ${person.name} unmute`
              : `Mute ${person.name}`
        }
        data-testid="show-stage-mute"
        disabled={disabled}
        size="xs"
        type="button"
        variant="ghost"
        onClick={() =>
          person.host ? void talkShow.setMicrophoneMuted(!local.micMuted).catch(() => {}) : onMute()
        }
      >
        {person.host ? (local.micMuted ? 'Unmute' : 'Mute') : person.muted ? 'Unmute' : 'Mute'}
      </Button>
      <KebabMenu disabled={disabled} items={items} label={`More for ${person.name}`} />
    </ListRow>
  )
}
