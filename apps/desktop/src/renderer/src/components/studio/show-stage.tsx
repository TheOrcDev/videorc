import { managedProfileDescription } from '../../../../shared/cloud-output-profile'
import { createGraphicsView } from '../../../../shared/cloud-graphics-view'
import type { GraphicsSnapshot } from '../../../../shared/cloud-graphics'
import type { ReactNode } from 'react'
import { createAvatarView, type AvatarMotionSource } from '../../../../shared/cloud-avatar-view'
import type { AvatarSnapshot } from '../../../../shared/cloud-avatar'
import { Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { useGuestModeration } from '@/components/guests/guest-moderation'
import { CloseRoomButton } from '@/components/guests/close-room-button'
import { CountLabel, PersonRow, RequestRow, ScreenThumb } from '@/components/guests/room-person'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  DisplayIcon,
  HiddenIcon,
  LinkIcon,
  OutputIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  WaveformMutedIcon
} from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { GroupedList } from '@/components/list-row'
import { MediaCard } from '@/components/media-card'
import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { SectionLabel } from '@/components/section-label'
import { SceneCard } from '@/components/studio/scene-card'
import {
  ScreenHiddenChip,
  type ScreenPrivacyControl,
  useScreenPrivacyControl
} from '@/components/studio/screen-privacy-control'
import { StageLayoutThumb } from '@/components/studio/stage-layout-thumb'
import { CameraOffAvatar } from '@/components/studio/camera-off-avatar'
import { PREVIEW_REPLACED_BY_SHOW_STAGE } from '@/components/preview-stage'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCloud, useStudioCore } from '@/hooks/use-studio'
import { TAKEOVER_MUTED_HINT, TAKEOVER_MUTED_LABEL } from '@/lib/takeover-microphone'
import {
  roomProgramCamera,
  useRoomProgramCamera,
  useRoomProgramCameraAvailable,
  useRoomProgramCameraProducer
} from '@/hooks/use-room-program-camera'
import { useVirtualCamera } from '@/hooks/use-virtual-camera'
import type {
  CloudHostShape,
  CloudRoomParticipant,
  CloudRoomRequest,
  TalkShowDisplaySource
} from '@/lib/backend'
import {
  NOBODY_BACKSTAGE,
  NO_SCREENS_YET,
  SCREENS_GUEST_HINT,
  bringOnBlockedReason,
  layoutOptions,
  layoutReasonsLine,
  outputProfileChips,
  roomLimits,
  liveRoomQuality,
  roomPeople,
  roomScreens,
  selectedLayout,
  stageWithScreenCard,
  type RoomPerson,
  type RoomScreen
} from '@/lib/guests-view'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { managedScreenAssetUrl } from '@/lib/screen-asset-url'
import { SCREEN_HIDDEN_LABEL, screenPrivacyActionLabel } from '@/lib/screen-privacy-view'
import type { TalkShowContextValue } from '@/lib/talk-show-context'
import type { CameraFrameMedia } from '@/lib/camera-frame-media'
import type { TalkShowLocalMedia, TalkShowPerson } from '@/lib/talk-show-room'
import { setAgentRoomProgram } from '@/lib/agent-room-program'
import { stageSharers } from '@/lib/stage-screens'
import {
  PROGRAM_PREVIEW_COPY,
  agentRoomProgram,
  isManagedShow,
  managedProgramPreview,
  managedProgramStageInput,
  programMonitorView
} from '@/lib/talk-show-managed'
import { PROGRAM_MONITOR_EMPTY } from '@/lib/talk-show-session'
import {
  HOST_CIRCLE_CLIP,
  cameraOffLook,
  cameraPicture,
  hostCircle,
  showsAway
} from '@/lib/talk-show-tile'
import {
  planStage,
  showStageInput,
  stageRectPercent,
  type StageCanvas,
  type StageTile
} from '@/lib/talk-show-layout'
import { cn } from '@/lib/utils'
import { programScenePreview, scenePreviewPicture, sceneStatusLine } from '@/lib/room-scene-preview'
import {
  VIEW_SOURCE,
  isPortrait,
  personFit,
  tileFit,
  type Size
} from '../../../../shared/cloud-presentation-views'
import { PORTRAIT_FILL_INTERVAL_MS, drawPortraitFill } from '@/lib/portrait-fill'
import type { SceneTile } from '../../../../shared/cloud-scene'
import { roomProgramCameraLine } from '../../../../shared/room-program-camera'
import { roomProgramChips, roomProgramSummary } from '@/lib/room-program-opt-ins'

// The Show stage (plan 224 C-G3, D7, D8): while the room is open it replaces
// the Studio's Preview. The renderer draws the room's tracks with the
// runner's own geometry, so the host acts on the picture the cloud sends,
// 150 to 300 ms behind the room instead of the return's half second. Under
// it (plan 252): "Ada wants to join"; then what goes on the picture, as
// pictures: the layouts as cards, the shared screens as cards, and the people
// On stage and Backstage, the one home of Bring on and Send backstage; and
// beside them the Program monitor (the return, or on a managed show the
// stage as the program page draws it, plan 234 D6). Loaded only while the
// room is open.

/** The stage's own canvas: the runner's 16:9 horizontal output. */
const STAGE_CANVAS: StageCanvas = { width: 1920, height: 1080 }
/** At most this many join requests stand above the strip; the rest wait on Guests. */
const REQUESTS_SHOWN = 3

const cqw = (px: number): string => `${(px / STAGE_CANVAS.width) * 100}cqw`

export default function ShowStage(): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const room = cloudStatus?.room
  const people = roomPeople(
    room,
    talkShow.hostIdentity,
    // Plan 253 S4: a managed show's dot reads LiveKit's own quality.
    isManagedShow(cloudStatus) ? liveRoomQuality(talkShow.room) : undefined
  )
  const limits = roomLimits(cloudStatus)
  const requests = room?.requests ?? []
  const connected = talkShow.room.state === 'connected'

  // The Program monitor subscribes to the return while the stage is on
  // screen and the room is joined (D7); it lets go when the stage goes. A
  // managed show has no return (plan 234 D6): nothing is asked for.
  const setMonitorRef = useRef(talkShow.setMonitor)
  setMonitorRef.current = talkShow.setMonitor
  const hasReturn = programMonitorView(cloudStatus).source === 'return'
  useEffect(() => {
    if (!connected || !hasReturn) return
    void setMonitorRef.current(true).catch(() => {})
    return () => void setMonitorRef.current(false).catch(() => {})
  }, [connected, hasReturn])

  // Plan 249 S6: agents read the program as the page reports it, labelled
  // with its source; the store dedupes, and the stage going clears it.
  const now = usePreviewClock(Boolean(room?.live || cloudStatus?.recording?.active))
  useEffect(() => {
    setAgentRoomProgram(agentRoomProgram(cloudStatus, talkShow.hostIdentity, STAGE_CANVAS, now))
  }, [cloudStatus, talkShow.hostIdentity, now])
  useEffect(() => () => setAgentRoomProgram(undefined), [])

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
      {talkShow.room.local.problem ? (
        <Alert variant="warning">
          <AlertTitle>{talkShow.room.local.problem}</AlertTitle>
        </Alert>
      ) : null}
      <JoinRequests disabled={room?.phase !== 'open'} requests={requests} />
      {/* Plan 252: what goes on the picture on the left (the layout, the
          screens, the people); what the cloud sends on the right. Narrow, the
          Program leads so it stays beside the stage it mirrors. */}
      <div className="flex min-w-0 flex-col gap-4 @min-[44rem]/show-stage:flex-row @min-[44rem]/show-stage:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <StageLayouts talkShow={talkShow} />
          <StageScreens people={people} talkShow={talkShow} />
          <StagePeople limitsBlocked={bringOnBlockedReason(people, limits)} people={people} />
        </div>
        <ProgramMonitor talkShow={talkShow} />
      </div>
    </PanelSection>
  )
}

// --- The stage -----------------------------------------------------------------

function StageWell({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const room = cloudStatus?.room
  // Review M2: the stage as the program draws it, never a tile or a
  // screen the viewers don't see.
  const plan = planStage(STAGE_CANVAS, showStageInput(room))
  const state = talkShow.room.state
  const joining = state === 'connecting' || state === 'reconnecting'
  return (
    <div
      aria-label="Room view"
      className="relative w-full overflow-hidden rounded-panel bg-video-ground [container-type:inline-size]"
      data-testid="show-stage-well"
      // Plan 249 S6: the room's own tracks, at room latency. Never the program.
      data-view-source={VIEW_SOURCE.room}
      style={{ aspectRatio: `${STAGE_CANVAS.width} / ${STAGE_CANVAS.height}` }}
    >
      {plan.tiles.map((tile) => (
        <StageTileView
          hostShape={room?.stage.hostShape}
          key={`${tile.kind}:${tile.identity}`}
          participant={room?.participants?.find((entry) => entry.identity === tile.identity)}
          talkShow={talkShow}
          tile={tile}
        />
      ))}
      {plan.tiles.length === 0 ? (
        <Empty className="absolute inset-0 text-video-ground-muted">Nobody is on stage.</Empty>
      ) : null}
      <InfoTooltip
        className="absolute top-3 right-3"
        content="What you and your guests see in the room now. Viewers see the Program."
      >
        <span
          className="inline-flex items-center rounded-full bg-video-ground/80 px-2.5 py-1 text-xs text-video-ground-foreground"
          data-testid="show-stage-room-label"
        >
          Room
        </span>
      </InfoTooltip>
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

/**
 * The track a tile shows: the host's own media, or a guest's from the room.
 * A camera that is off shows no frame (wire contract 5.5): the tile draws
 * the camera-off look instead.
 */
function tileTrack(
  tile: StageTile,
  talkShow: TalkShowContextValue
): {
  track: MediaStreamTrack | null
  cameraOff: boolean
  name: string
  cameraFrame?: TalkShowLocalMedia['cameraFrame']
  /** The host's hidden screen: its frosted still (plan 210 D8 in a room). */
  still?: string
} {
  const host = tile.identity === talkShow.hostIdentity
  if (host) {
    const local = talkShow.room.local
    return tile.kind === 'screen'
      ? { track: local.screen, cameraOff: false, name: 'Your screen', still: local.screenStill }
      : {
          ...cameraPicture(local.camera, local.cameraOff),
          name: 'You',
          // Plan 249 S13a: the host's own packed test camera, drawn unpacked.
          ...(local.cameraFrame ? { cameraFrame: local.cameraFrame } : {})
        }
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
  return { ...cameraPicture(person?.video, person?.cameraOff), name: person?.name ?? '' }
}

function StageTileView({
  tile,
  participant,
  talkShow,
  hostShape,
  monitor = false
}: {
  tile: StageTile
  participant: CloudRoomParticipant | undefined
  talkShow: TalkShowContextValue
  /** The stage's `hostShape`, as sent: the host's circle (plan 247 D-2). */
  hostShape: CloudHostShape | undefined
  /** In the Program monitor: the picture and its geometry, without words. */
  monitor?: boolean
}): ReactElement {
  const { track, cameraOff, name, cameraFrame, still } = tileTrack(tile, talkShow)
  const label = monitor ? '' : name || participant?.name || ''
  const look = cameraOffLook(tile.rect.w, tile.rect.h)
  const circle = hostCircle(tile, talkShow.hostIdentity, hostShape)
  // Plan 254 S2: a phone held upright sends a portrait camera. As on the
  // program page it is drawn whole over a blurred fill of itself, never
  // cropped to its middle third. A packed camera keeps its cover.
  const [portrait, setPortrait] = useState(false)
  const onSize = useCallback((size: Size) => setPortrait((was) => isPortrait(size, was)), [])
  const person = personFit(tile.kind === 'person' && portrait && !cameraFrame)
  const fit =
    tileFit(tile.kind) === 'contain' || person.fit === 'contain' ? 'object-contain' : 'object-cover'
  const voice = tileVoice(tile, participant, talkShow)
  return (
    <>
      <div
        className="absolute overflow-hidden bg-inset"
        data-stage-identity={tile.identity}
        data-stage-kind={tile.kind}
        data-stage-shape={circle ? 'circle' : 'rounded'}
        data-testid="show-stage-tile"
        style={{
          ...stageRectPercent(STAGE_CANVAS, tile.rect),
          ...(circle
            ? { borderRadius: 0, clipPath: HOST_CIRCLE_CLIP }
            : { borderRadius: cqw(tile.cornerRadius) })
        }}
      >
        <TrackVideo
          cameraFrame={cameraFrame}
          className={fit}
          fill={person.fill ? { w: tile.rect.w, h: tile.rect.h } : null}
          onSize={tile.kind === 'person' ? onSize : undefined}
          track={track}
        />
        <ScreenStill className={fit} src={still} />
        {cameraOff ? (
          // The camera-off look, as viewers see it: the circle and the letter.
          <CameraOffAvatar
            circle={cqw(look.diameter)}
            letter={cqw(look.fontPx)}
            name={name === 'You' ? (participant?.name ?? name) : name || (participant?.name ?? '')}
          />
        ) : !track && !still && !monitor ? (
          <span className="absolute inset-0 flex items-center justify-center text-sm text-video-ground-muted">
            {tile.kind === 'screen' ? 'Waiting for the screen' : 'No picture yet'}
          </span>
        ) : null}
        {showsAway(participant?.away, cameraOff) && tile.kind === 'person' ? (
          <span className="absolute inset-0 flex items-center justify-center bg-video-ground/60 text-sm font-medium text-video-ground-foreground">
            {monitor ? null : 'Back in a moment'}
          </span>
        ) : null}
      </div>
      {/* Beside the tile, as on the program page, so the host's circle never clips it. */}
      {tile.plate && label ? (
        <span
          className="absolute flex items-end"
          data-testid="show-stage-plate"
          style={stageRectPercent(STAGE_CANVAS, tile.plate)}
        >
          <span className="flex max-w-full items-center gap-[max(4px,0.4cqw)] rounded-full bg-video-ground/70 px-[max(8px,0.8cqw)] py-[max(2px,0.3cqw)] text-[max(11px,1.3cqw)] font-medium text-video-ground-foreground">
            {/* Who talks and who can't be heard, on the picture itself. */}
            {tile.kind !== 'person' ? null : voice === 'muted' ? (
              <WaveformMutedIcon
                aria-label="Muted"
                className="size-[max(12px,1.3cqw)] shrink-0 text-video-ground-muted"
                data-testid="show-stage-plate-muted"
                role="img"
              />
            ) : voice === 'talking' ? (
              <span
                aria-label="Talking"
                className="tone-success glass-dot size-[max(6px,0.6cqw)] shrink-0 rounded-full"
                data-testid="show-stage-plate-talking"
                role="img"
              />
            ) : null}
            <span className="truncate">{label}</span>
          </span>
        </span>
      ) : null}
    </>
  )
}

/**
 * Plan 210 D8 in a room: while the host's screen is hidden, the frosted still
 * of the last frame the room saw, fitted as the screen was, over the guarded
 * track (whose frames are the wire's grey). Guests and the program draw the
 * same still. Nothing while the screen is visible.
 */
function ScreenStill({
  src,
  className
}: {
  src: string | undefined
  className: string
}): ReactElement | null {
  if (!src) return null
  return (
    <img
      alt=""
      className={cn('absolute inset-0 size-full', className)}
      data-testid="show-stage-screen-still"
      src={src}
    />
  )
}

/** A person's voice on their name plate: muted (their mute or the host's hold), talking, or neither. */
function tileVoice(
  tile: StageTile,
  participant: CloudRoomParticipant | undefined,
  talkShow: TalkShowContextValue
): 'muted' | 'talking' | null {
  if (tile.identity === talkShow.hostIdentity) return talkShow.room.local.micMuted ? 'muted' : null
  const person = talkShow.room.people.find((entry) => entry.identity === tile.identity)
  if (person?.micMuted || participant?.muted) return 'muted'
  return person?.speaking ? 'talking' : null
}

/** A `MediaStreamTrack` in a muted `<video>`; nothing while there is none. */
function TrackVideo({
  track,
  className,
  cameraFrame,
  onSize,
  fill
}: {
  track: MediaStreamTrack | null
  className?: string
  /** Plan 254 S2: a tile of this shape draws the portrait fill behind the video. */
  fill?: Size | null
  /** Packed camera-role source; geometry uses its logical dimensions. */
  cameraFrame?: TalkShowLocalMedia['cameraFrame'] | undefined
  onSize?: (size: { w: number; h: number }) => void
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
  const authority = cameraFrame?.authority
  const logicalWidth = cameraFrame?.descriptor.logicalWidth
  const logicalHeight = cameraFrame?.descriptor.logicalHeight
  useEffect(() => {
    const video = ref.current
    if (!video || !authority) return
    let media: CameraFrameMedia | null = null
    let cancelled = false
    // A packed track is never shown raw, even when the adapter is refused.
    video.style.opacity = '0'
    // Loaded only for the DEV experiment: S10's GPU helper stays out of the eager bundle.
    void import('@/lib/camera-frame-media')
      .then(({ createCameraFrameMedia }) => {
        if (cancelled) return
        media = createCameraFrameMedia({
          page: video.ownerDocument,
          video,
          // The monitor's own publication: the SIDs the SFU returned on publish.
          publication: () => ({
            identity: authority.hostIdentity,
            participantSid: authority.publisherSid,
            trackSid: authority.trackSid,
            source: 'camera'
          }),
          authority: () => authority,
          experiment: true,
          ...(logicalWidth && logicalHeight
            ? { logical: { width: logicalWidth, height: logicalHeight } }
            : {})
        })
        media.canvas.className = cn('absolute inset-0 size-full', className)
        video.after(media.canvas)
        const logical = media.logicalSize()
        if (logical) onSize?.(logical)
      })
      .catch(() => {
        // Never fall back to drawing the packed picture.
      })
    return () => {
      cancelled = true
      media?.close('unmounted')
      video.style.opacity = ''
    }
  }, [authority, className, logicalHeight, logicalWidth, onSize, track])
  useEffect(() => {
    const video = ref.current
    if (!video || !onSize || authority) return
    const report = (): void => {
      if (video.videoWidth > 2 && video.videoHeight > 2)
        onSize({ w: video.videoWidth, h: video.videoHeight })
    }
    report()
    video.addEventListener('loadedmetadata', report)
    video.addEventListener('resize', report)
    return () => {
      video.removeEventListener('loadedmetadata', report)
      video.removeEventListener('resize', report)
    }
  }, [authority, onSize, track])
  const fillRef = useRef<HTMLCanvasElement>(null)
  const fillWidth = fill?.w ?? 0
  const fillHeight = fill?.h ?? 0
  useEffect(() => {
    const video = ref.current
    const canvas = fillRef.current
    if (!video || !canvas || fillWidth <= 0 || fillHeight <= 0) return
    const draw = (): void => {
      drawPortraitFill(canvas, video, { w: fillWidth, h: fillHeight })
    }
    draw()
    video.addEventListener('loadeddata', draw)
    video.addEventListener('resize', draw)
    const timer = window.setInterval(draw, PORTRAIT_FILL_INTERVAL_MS)
    return () => {
      video.removeEventListener('loadeddata', draw)
      video.removeEventListener('resize', draw)
      window.clearInterval(timer)
    }
  }, [fillHeight, fillWidth, track])
  if (!track) return null
  return (
    <>
      {fill ? (
        <canvas
          aria-hidden
          className="absolute inset-0 size-full"
          data-testid="show-stage-portrait-fill"
          ref={fillRef}
        />
      ) : null}
      <video
        autoPlay
        className={cn('size-full', fill && 'relative', className)}
        muted
        playsInline
        ref={ref}
      />
    </>
  )
}

// --- Under the stage -----------------------------------------------------------

/**
 * The room's layouts as cards, each with its diagram, as the Scenes gallery
 * shows scenes (plan 252). A layout that can't apply says why on hover, and
 * the one line under the cards says it for all of them.
 */
function StageLayouts({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const room = cloudStatus?.room
  // Plan 251: the fifth card, Two screens, on a managed show with a screen
  // to start from.
  const options = layoutOptions(room, {
    managed: isManagedShow(cloudStatus),
    sharers: stageSharers(room, talkShow.hostIdentity, talkShow.room.local.screen !== null).length
  })
  const reasons = layoutReasonsLine(options)
  const roomOpen = room?.phase === 'open'
  const current = selectedLayout(room, talkShow.twoScreens)
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="show-stage-layouts">
      <SectionLabel className="px-1">Layout</SectionLabel>
      <div aria-label="Layout" className={CARD_GRID} role="group">
        {options.map((option) => (
          <SceneCard
            data-stage-layout={option.value}
            data-testid="show-stage-layout"
            disabled={!roomOpen || option.disabledReason !== null}
            disabledReason={roomOpen ? option.disabledReason : null}
            key={option.value}
            label={option.label}
            selected={current === option.value}
            size="sm"
            thumb={<StageLayoutThumb layout={option.value} />}
            onSelect={() => {
              if (current !== option.value) void talkShow.setLayout(option.value).catch(() => {})
            }}
          />
        ))}
      </div>
      {roomOpen && reasons ? (
        <p className="px-1 text-meta text-muted-foreground" data-testid="show-stage-layout-reasons">
          {reasons}
        </p>
      ) : null}
    </div>
  )
}

/** Cards in rows of four (a fifth layout wraps); two across when the stage is narrow. */
const CARD_GRID = 'grid grid-cols-2 gap-2 @min-[30rem]/show-stage:grid-cols-4'

/**
 * The screens shared in the room (plan 252), each a card with its live
 * picture: the host's own and every guest's. A card puts its screen on stage
 * or takes it off, the one home of that choice; Share screen… starts the
 * host's own. A layout that takes more than one screen picks from this list.
 */
function StageScreens({
  talkShow,
  people
}: {
  talkShow: TalkShowContextValue
  people: RoomPerson[]
}): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const room = cloudStatus?.room
  const roomOpen = room?.phase === 'open'
  const [sources, setSources] = useState<TalkShowDisplaySource[] | null>(null)
  const [pending, setPending] = useState(false)
  const local = talkShow.room.local
  const sharing = local.screen !== null
  // Plan 251: on Two screens the cards put up to two screens on stage.
  const screens = roomScreens(room, people, sharing, talkShow.twoScreens)
  // Plan 254 D4: the Studio's own Hide screen, the same state as the scene's
  // Screen field, which steps aside with the Scenes while the room is open.
  const privacy = useScreenPrivacyControl()
  const privacyShown =
    sharing || screens.some((screen) => screen.host) || privacy.hidden || !!privacy.statusLabel

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

  const show = (screen: RoomScreen): void => {
    if (!room) return
    void talkShow
      .setStage(stageWithScreenCard(room.stage, screen, talkShow.twoScreens))
      .catch(() => {})
  }

  return (
    <div
      className="@container/stage-screens flex min-w-0 flex-col gap-1.5"
      data-testid="show-stage-screens"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <SectionLabel>Screens</SectionLabel>
        {/* While it holds, the chip says so beside the section's name, as on
            the scene's Screen field; nothing toasts. */}
        {privacy.hidden || privacy.statusLabel ? (
          <ScreenHiddenChip
            detail={privacy.observationDetail}
            value={privacy.statusLabel ?? SCREEN_HIDDEN_LABEL}
          />
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {privacyShown ? <StageScreenPrivacy control={privacy} /> : null}
          {sharing ? (
            <Button
              data-testid="show-stage-stop-share"
              disabled={!roomOpen || pending}
              size="xs"
              type="button"
              variant="outline"
              onClick={() => void talkShow.stopScreenShare().catch(() => {})}
            >
              Stop sharing
            </Button>
          ) : (
            <Button
              data-testid="show-stage-share"
              disabled={!roomOpen || pending}
              size="xs"
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
        </div>
      </div>
      {screens.length === 0 ? (
        <p className="px-1 text-meta text-muted-foreground" data-testid="show-stage-screens-empty">
          {NO_SCREENS_YET} {SCREENS_GUEST_HINT}
        </p>
      ) : (
        <div aria-label="Screens" className={CARD_GRID} role="group">
          {screens.map((screen) => (
            <SceneCard
              data-stage-identity={screen.identity}
              data-testid="show-stage-screen"
              disabled={!roomOpen || screen.blockedReason !== null}
              disabledReason={roomOpen ? screen.blockedReason : null}
              key={screen.identity}
              label={screen.name}
              meta={screen.onProgram ? 'On stage' : 'Put on stage'}
              selected={screen.onProgram}
              size="sm"
              thumb={
                <ScreenThumb
                  track={
                    screen.host
                      ? local.screen
                      : (talkShow.room.people.find((entry) => entry.identity === screen.identity)
                          ?.screen ?? null)
                  }
                />
              }
              onSelect={() => show(screen)}
            />
          ))}
        </div>
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
 * Hide screen on the Show stage (plan 254 D4). While the room is open the
 * stage replaces the Preview and the Scenes step aside, and the scene's
 * Screen field (the Studio's Hide screen since plan 231 D8) goes with them;
 * this is the same action by the same state (`useScreenPrivacyControl`), a
 * mirror and never a second state. It sits in the Screens header beside Stop
 * sharing, over the host's own card (one screen or two, plan 251): a 24 px
 * button with its key, as the Studio's Screen row had it (plan 210 D9). It
 * reads Show screen in the same place while hidden, and the key then lives
 * in the tooltip, because the chip takes the room. The room's phase never
 * holds it: a hide always runs, and only a refused hide is disabled, with its
 * reason. No toast: the chip and the frosted stage say it.
 */
function StageScreenPrivacy({ control }: { control: ScreenPrivacyControl }): ReactElement {
  const { hidden, accelerator, platform, disabledReason, toggle } = control
  const label = screenPrivacyActionLabel(hidden)
  const button = (
    <Button
      data-testid="show-stage-screen-privacy"
      data-videorc-screen-privacy=""
      disabled={disabledReason !== null}
      size="xs"
      type="button"
      variant="outline"
      onClick={toggle}
    >
      <HiddenIcon data-icon="inline-start" />
      {label}
    </Button>
  )
  return (
    <span
      className="flex items-center gap-2"
      data-hidden={hidden || undefined}
      data-slot="screen-privacy"
    >
      {/* The key teaches itself while there is room for it. */}
      {accelerator && !hidden ? (
        <ShortcutKeys
          accelerator={accelerator}
          className="hidden @min-[22rem]/stage-screens:inline-flex"
          platform={platform}
        />
      ) : null}
      {disabledReason ? (
        <DisabledReason reason={disabledReason}>{button}</DisabledReason>
      ) : (
        <ShortcutTooltip accelerator={accelerator} label={label} platform={platform}>
          {button}
        </ShortcutTooltip>
      )}
    </span>
  )
}

/**
 * The Program monitor (D7): the return, what the cloud really sends, about
 * half a second behind. Muted by default; its speaker plays the return so the
 * host can check the mix (their own voice comes back late: a check, not a
 * monitor).
 *
 * A managed show has no return (plan 234 D6). Its monitor keeps the frame,
 * the label and the two waiting lines, and draws the Show stage as the
 * program page reports it. The speaker is not shown: there is no return to
 * listen to, and a control that plays nothing would lie.
 */
function ProgramGraphics({
  snapshot,
  children
}: {
  snapshot: GraphicsSnapshot | null
  children: ReactNode
}): ReactElement {
  const caption = useRef<HTMLDivElement>(null)
  const banner = useRef<HTMLDivElement>(null),
    chat = useRef<HTMLDivElement>(null),
    highlight = useRef<HTMLDivElement>(null)
  const view = useRef<ReturnType<typeof createGraphicsView> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!banner.current || !caption.current || !chat.current || !highlight.current) return
    const current = createGraphicsView({
      banner: banner.current,
      caption: caption.current,
      chat: chat.current,
      highlight: highlight.current
    })
    view.current = current
    const timer = setInterval(() => current.step(), 16)
    return () => {
      clearInterval(timer)
      current.close()
      view.current = null
    }
  }, [])
  useEffect(() => {
    const current = view.current
    current?.receiver.owner(snapshot?.publisherSid ?? null)
    if (!current || !snapshot) return
    let cancelled = false
    setFailed(false)
    void current.receiver.accept(snapshot).catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [snapshot])
  return (
    <>
      <div ref={banner} data-testid="show-stage-banners" />
      <div ref={caption} data-testid="show-stage-captions" />
      <div ref={chat} />
      {children}
      <div ref={highlight} />
      {failed ? (
        <span className="absolute inset-x-0 bottom-0 text-xs text-video-ground-muted">
          Graphics preview failed
        </span>
      ) : null}
    </>
  )
}

function ProgramAvatar({
  snapshot,
  motion
}: {
  snapshot: AvatarSnapshot | null
  motion?: AvatarMotionSource
}): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const view = useRef<ReturnType<typeof createAvatarView> | null>(null)
  const [failure, setFailure] = useState(false)
  // Plan 249 S5: an atlas layer moves with the poses the outputs replay (the
  // producer's own simulation); without one it rests on its neutral cell.
  const motionRef = useRef(motion)
  useEffect(() => {
    motionRef.current = motion
  }, [motion])
  useEffect(() => {
    if (!root.current) return
    const current = createAvatarView(root.current, Date.now, {
      orientation: 'h',
      receiver: {
        advance: () => motionRef.current?.advance(),
        draw: (orientation, atlasHash) => motionRef.current?.draw(orientation, atlasHash) ?? null,
        get sim() {
          return motionRef.current?.sim ?? null
        }
      }
    })
    view.current = current
    const timer = setInterval(() => current.step(), 50)
    return () => {
      clearInterval(timer)
      current.close()
      view.current = null
    }
  }, [])
  useEffect(() => {
    const current = view.current
    current?.receiver.owner(snapshot?.publisherSid ?? null)
    if (!snapshot || !current) return
    let cancelled = false
    setFailure(false)
    void current.receiver.accept(snapshot).catch(() => {
      if (!cancelled) setFailure(true)
    })
    return () => {
      cancelled = true
    }
  }, [snapshot])
  return (
    <>
      <div ref={root} data-testid="show-stage-avatar" />
      {failure ? (
        <span className="absolute inset-x-0 bottom-0 text-xs text-video-ground-muted">
          Avatar preview failed
        </span>
      ) : null}
    </>
  )
}

function ProgramMonitor({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const { activeScreen } = useStudioCore()
  const [listening, setListening] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const { video, audio } = talkShow.room.monitor
  const live = Boolean(cloudStatus?.room?.live || cloudStatus?.recording?.active)
  const view = programMonitorView(cloudStatus)
  // The takeover covers the managed program and silences every voice (the
  // program page's rule), so the monitor draws it over the stage. A node
  // show's return already carries it.
  const takeover = view.source === 'stage' && view.state === 'shown' ? activeScreen : null
  // Plan 249 S6: does the page report drawing the stage this desktop sent?
  const now = usePreviewClock(view.source === 'stage' && live)
  const preview = view.source === 'stage' ? managedProgramPreview(cloudStatus, now) : null
  const previewCopy = preview ? PROGRAM_PREVIEW_COPY[preview.state] : null
  // Plan 249 S23 (D10): this Program preview on Videorc Camera, opt-in per
  // room. Never a node show's return: that is the encoded stream.
  const picture = useRef<HTMLDivElement>(null)
  const virtualCamera = useVirtualCamera()
  const programCameraOffered =
    useRoomProgramCameraAvailable() &&
    view.source === 'stage' &&
    talkShow.hostIdentity !== null &&
    virtualCamera.status?.platformStep !== 'unsupported'
  const programCamera = useRoomProgramCamera()
  const programCameraOn =
    programCameraOffered && programCamera.on && programCamera.hostIdentity === talkShow.hostIdentity
  useRoomProgramCameraProducer(picture, programCameraOn ? programCamera.generation : null)
  const programCameraStatus =
    programCamera.error ??
    roomProgramCameraLine({
      on: programCameraOn,
      source: virtualCamera.status?.source ?? null,
      cameraOn: virtualCamera.status?.on === true,
      cameraAvailable: virtualCamera.status?.available !== false
    }) ??
    'Videorc Camera · Not sending this room'

  useEffect(() => {
    const element = audioRef.current
    if (!element) return
    element.srcObject = audio ? new MediaStream([audio]) : null
    if (audio) void element.play().catch(() => {})
    return () => {
      element.srcObject = null
    }
  }, [audio])

  // The room's opt-ins live in Guests → Room (one home); this column shows
  // the program and links there. Videorc Camera stays here: it sends only
  // while this preview is on screen.
  const programMenu: KebabMenuItem[] = programCameraOffered
    ? [
        {
          id: 'program-camera',
          label: programCameraOn ? 'Stop sending to Videorc Camera' : 'Send to Videorc Camera',
          onSelect: () =>
            void roomProgramCamera.setOn(!programCameraOn, talkShow.hostIdentity).catch(() => {})
        }
      ]
    : []
  const avatar = talkShow.room.avatar
  const graphics = talkShow.room.graphics

  return (
    <div
      // Narrow, the Program leads the column: it mirrors the stage above it.
      className="order-first flex w-1/2 min-w-48 flex-col gap-1.5 @min-[44rem]/show-stage:order-none @min-[44rem]/show-stage:w-[36%] @min-[44rem]/show-stage:shrink-0"
      data-program-source={view.source}
      data-program-stage={preview?.state}
      data-testid="show-stage-program"
      data-view-source={
        view.source === 'return' ? VIEW_SOURCE['runner-return'] : VIEW_SOURCE['program-preview']
      }
    >
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 px-1">
        <SectionLabel className="min-w-0 truncate">
          {view.source === 'return' ? 'Program' : 'Program preview'}
        </SectionLabel>
        {/* The program's state beside its name: a chip, with the sentence on hover. */}
        {previewCopy?.badge ? (
          <InfoTooltip content={previewCopy.detail}>
            <Badge
              data-testid="show-stage-program-state"
              variant={preview?.state === 'applied' ? 'success' : 'warning'}
            >
              {previewCopy.badge}
            </Badge>
          </InfoTooltip>
        ) : null}
        {/* The host's voice included (live show 2026-11-20): one word with the
            mic rows, the sentence on hover. */}
        {takeover ? (
          <InfoTooltip content={TAKEOVER_MUTED_HINT.stream}>
            <Badge data-testid="show-stage-program-muted" variant="outline">
              {TAKEOVER_MUTED_LABEL}
            </Badge>
          </InfoTooltip>
        ) : null}
        <span className="flex-1" />
        {programMenu.length > 0 ? (
          <span
            data-program-camera={
              programCameraOn ? (virtualCamera.status?.source ?? 'starting') : 'off'
            }
            data-testid="show-stage-program-camera"
          >
            <KebabMenu items={programMenu} label="More for the Program" />
          </span>
        ) : null}
        {view.source === 'return' ? (
          <InfoTooltip
            content={listening ? 'Mute the program' : 'Listen to the program'}
            focusable={false}
          >
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
          </InfoTooltip>
        ) : null}
      </div>
      <div
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-row',
          // Empty, the frame is the Preview's inset well: on the dark ground
          // a video-ground box would vanish and leave its words floating.
          programPictured(view, video) ? null : 'bg-inset'
        )}
      >
        {/* What Videorc Camera rasterizes: the picture only, in its own
            stacking context, so the pills below stay off the camera and
            above every scene tile. */}
        <div
          className={cn(
            'absolute inset-0 isolate overflow-hidden [container-type:inline-size]',
            // The camera's ground, as before: the picture's own video ground.
            programPictured(view, video) && 'bg-video-ground'
          )}
          data-testid="show-stage-program-picture"
          ref={picture}
        >
          {view.source === 'return' ? (
            <>
              <TrackVideo className="object-contain" track={video} />
              {!video ? (
                <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
                  {live ? 'Waiting for the program…' : PROGRAM_MONITOR_EMPTY}
                </span>
              ) : null}
            </>
          ) : view.state === 'shown' ? (
            <>
              <ProgramStage talkShow={talkShow} />
              {takeover ? (
                <img
                  alt=""
                  className="absolute inset-0 size-full bg-video-ground object-contain"
                  data-testid="show-stage-program-takeover"
                  src={managedScreenAssetUrl(takeover.imagePath)}
                />
              ) : null}
            </>
          ) : (
            <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
              {view.state === 'waiting' ? 'Waiting for the program…' : PROGRAM_MONITOR_EMPTY}
            </span>
          )}
          {view.source === 'stage' ? (
            <ProgramGraphics snapshot={graphics?.preview ?? null}>
              <ProgramAvatar
                motion={talkShow.avatarMotionSource}
                snapshot={avatar?.preview ?? null}
              />
            </ProgramGraphics>
          ) : null}
        </div>
      </div>
      {/* News stays in words: a refusal, a delivery problem, the scene. */}
      {view.source === 'stage' && avatar?.reason ? (
        <span className="text-label text-subtle" data-testid="show-stage-avatar-reason">
          {avatar.reason}
        </span>
      ) : null}
      {view.source === 'stage' && avatar?.enabled && avatar.animation?.reason ? (
        <span
          className="text-meta text-muted-foreground"
          data-avatar-animation={avatar.animation.state}
          data-testid="show-stage-avatar-animation"
        >
          {avatar.animation.reason}
        </span>
      ) : null}
      {view.source === 'stage' && graphics?.reason ? (
        <span className="text-label text-subtle" data-testid="show-stage-graphics-reason">
          {graphics.reason}
        </span>
      ) : null}
      {view.source === 'stage' && sceneStatusLine(talkShow.room.scene) ? (
        <span className="text-label text-subtle" data-testid="show-stage-scene-status">
          {sceneStatusLine(talkShow.room.scene)}
        </span>
      ) : null}
      {programCameraOn || programCamera.error ? (
        <span
          className="truncate text-label text-subtle"
          data-testid="show-stage-program-camera-status"
        >
          {programCameraStatus}
        </span>
      ) : null}
      {view.source === 'stage' ? (
        // The opt-ins' one home is Guests → Room; these chips take the host there.
        <Button
          aria-label={`${roomProgramSummary(avatar, graphics)}. Open Guests`}
          className="h-auto min-w-0 justify-start gap-1 self-start px-0.5 py-0.5"
          data-testid="show-stage-program-opt-ins"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => openWorkspaceTab('guests')}
        >
          {roomProgramChips(avatar, graphics).map((chip, index) => (
            <Fragment key={chip.id}>
              {index > 0 ? <span className="sr-only"> · </span> : null}
              <Badge data-opt-in={chip.id} variant={chip.on ? 'success' : 'neutral'}>
                {chip.label}
              </Badge>
            </Fragment>
          ))}
          <ChevronRightIcon className="text-muted-foreground" data-icon="inline-end" />
        </Button>
      ) : null}
      {/* Plan 249 S17: what each cloud output really sends, as the room
          reported it: the facts as chips, the whole sentence on hover. */}
      {cloudStatus?.show?.outputProfile ? (
        <InfoTooltip content={managedProfileDescription(cloudStatus.show.outputProfile)}>
          <span
            className="flex min-w-0 flex-wrap items-center gap-1 px-0.5 text-muted-foreground"
            data-testid="show-stage-output-profile"
          >
            <OutputIcon aria-hidden className="size-3.5 shrink-0" />
            {outputProfileChips(cloudStatus.show.outputProfile).map((output) => (
              <Badge
                data-orientation={output.orientation}
                key={output.orientation}
                variant={output.differs ? 'warning' : 'outline'}
              >
                {output.facts.join(' · ')}
              </Badge>
            ))}
            <span className="sr-only">
              {managedProfileDescription(cloudStatus.show.outputProfile)}
            </span>
          </span>
        </InfoTooltip>
      ) : null}
      {view.source === 'return' ? <audio muted={!listening} ref={audioRef} /> : null}
    </div>
  )
}

/** Whether the Program frame holds a picture (else it is the empty inset well). */
function programPictured(
  view: ReturnType<typeof programMonitorView>,
  video: MediaStreamTrack | null
): boolean {
  return view.source === 'return' ? video !== null : view.state === 'shown'
}

/** The Show stage inside the Program monitor: the same tiles, drawn small. */
function ProgramStage({ talkShow }: { talkShow: TalkShowContextValue }): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const room = cloudStatus?.room
  // Plan 249 S12: while the host's scene is on the program, the preview
  // draws it with the program page's own scene geometry.
  const scene = programScenePreview(talkShow.room.scene, room, talkShow.hostIdentity)
  if (scene)
    return (
      <>
        {scene.tiles.map((tile) => (
          <SceneTileView
            key={`${tile.kind}:${tile.identity}`}
            participant={room?.participants?.find((entry) => entry.identity === tile.identity)}
            talkShow={talkShow}
            tile={tile}
          />
        ))}
      </>
    )
  const plan = planStage(STAGE_CANVAS, managedProgramStageInput(room))
  return (
    <>
      {plan.tiles.map((tile) => (
        <StageTileView
          hostShape={room?.stage.hostShape}
          key={`${tile.kind}:${tile.identity}`}
          monitor
          participant={room?.participants?.find((entry) => entry.identity === tile.identity)}
          talkShow={talkShow}
          tile={tile}
        />
      ))}
    </>
  )
}

/**
 * A scene tile in the Program preview: its box, mask and draw order, and its
 * picture cropped, fitted and mirrored as the program page draws it
 * (`scenePreviewPicture`). The picture only, without words, as the monitor.
 */
function SceneTileView({
  tile,
  participant,
  talkShow
}: {
  tile: SceneTile
  participant: CloudRoomParticipant | undefined
  talkShow: TalkShowContextValue
}): ReactElement {
  const [source, setSource] = useState<{ w: number; h: number } | null>(null)
  const { track, cameraOff, name, cameraFrame, still } = tileTrack(
    { identity: tile.identity, kind: tile.kind, rect: tile.rect, cornerRadius: 0 },
    talkShow
  )
  const picture = scenePreviewPicture(tile, source)
  const look = cameraOffLook(tile.rect.w, tile.rect.h)
  const { mask } = tile
  return (
    <div
      className="absolute overflow-hidden bg-inset"
      data-scene-role={tile.role}
      data-stage-identity={tile.identity}
      data-stage-kind={tile.kind}
      data-stage-shape={mask.shape}
      data-testid="show-stage-tile"
      style={{
        ...stageRectPercent(STAGE_CANVAS, tile.rect),
        zIndex: tile.z,
        ...(mask.shape === 'circle'
          ? { borderRadius: 0, clipPath: HOST_CIRCLE_CLIP }
          : { borderRadius: mask.shape === 'rounded' ? cqw(mask.radiusPx) : 0 })
      }}
    >
      <div
        className="absolute overflow-hidden"
        data-testid="show-stage-scene-clip"
        style={{ ...picture.clip, ...(tile.mirror ? { transform: 'scaleX(-1)' } : {}) }}
      >
        <div className="absolute" style={picture.full}>
          <TrackVideo
            cameraFrame={cameraFrame}
            className="object-fill"
            onSize={setSource}
            track={track}
          />
          <ScreenStill className="object-fill" src={still} />
        </div>
      </div>
      {cameraOff ? (
        <CameraOffAvatar
          circle={cqw(look.diameter)}
          letter={cqw(look.fontPx)}
          name={name === 'You' ? (participant?.name ?? name) : name || (participant?.name ?? '')}
        />
      ) : null}
      {showsAway(participant?.away, cameraOff) && tile.kind === 'person' ? (
        <span className="absolute inset-0 bg-video-ground/60" />
      ) : null}
    </div>
  )
}

// --- Requests and the people ---------------------------------------------------

/** "Ada wants to join", above everything the host arranges: it waits on them. */
function JoinRequests({
  requests,
  disabled
}: {
  requests: CloudRoomRequest[]
  disabled: boolean
}): ReactElement | null {
  if (requests.length === 0) return null
  const more = requests.length - REQUESTS_SHOWN
  return (
    <div className="flex flex-col gap-1.5" data-testid="show-stage-requests">
      <GroupedList
        aria-label="Wants to join"
        label={
          <span className="flex items-center gap-1.5">
            <StatusDot pulse tone="warn" />
            <CountLabel count={requests.length}>Wants to join</CountLabel>
          </span>
        }
      >
        {requests.slice(0, REQUESTS_SHOWN).map((request) => (
          <RequestRow
            disabled={disabled}
            key={request.requestId}
            request={request}
            testId="show-stage-request"
          />
        ))}
      </GroupedList>
      {more > 0 ? (
        <Button
          className="self-start"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => openWorkspaceTab('guests')}
        >
          {more === 1 ? '1 more wants to join' : `${more} more want to join`}
          <ChevronRightIcon data-icon="inline-end" />
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Everyone in the room, in two lists: On stage and Backstage. The one home
 * of Bring on and Send backstage (D16). A row per person: their picture,
 * name, what is wrong when something is, the mic, a guest's screen share,
 * the stage move, and ⋯.
 */
function StagePeople({
  people,
  limitsBlocked
}: {
  people: RoomPerson[]
  limitsBlocked: string | null
}): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const { moderationItems, toggleMute, toggleScreenShare, dialogs } = useGuestModeration(talkShow)
  const roomOpen = cloudStatus?.room?.phase === 'open'
  const stage = cloudStatus?.room?.stage
  if (people.length === 0) return <></>
  // The host is always on stage (H2), whatever the stage names yet.
  const onStage = people.filter((person) => person.host || person.onStage)
  const backstage = people.filter((person) => !person.host && !person.onStage)
  const row = (person: RoomPerson): ReactElement => (
    <StageRow
      bringOnBlocked={person.host ? null : limitsBlocked}
      disabled={!roomOpen}
      key={person.identity}
      moderation={moderationItems(person)}
      person={person}
      spotlit={stage?.layout === 'spotlight' && stage.spotlight === person.identity}
      talkShow={talkShow}
      onToggleMute={toggleMute}
      onToggleScreenShare={toggleScreenShare}
    />
  )
  return (
    <div aria-label="In the room" className="flex flex-col gap-4" data-testid="show-stage-strip">
      <GroupedList
        aria-label="On stage"
        label={<CountLabel count={onStage.length}>On stage</CountLabel>}
      >
        {onStage.map(row)}
      </GroupedList>
      {backstage.length > 0 ? (
        <GroupedList
          aria-label="Backstage"
          label={<CountLabel count={backstage.length}>Backstage</CountLabel>}
        >
          {backstage.map(row)}
        </GroupedList>
      ) : (
        <div className="flex flex-col gap-1.5">
          <SectionLabel className="px-1">
            <CountLabel count={0}>Backstage</CountLabel>
          </SectionLabel>
          <div
            className="flex items-center justify-between gap-2 rounded-row border border-border bg-inset py-1.5 pr-1.5 pl-3"
            data-testid="show-stage-backstage-empty"
          >
            <span className="min-w-0 text-meta text-muted-foreground">{NOBODY_BACKSTAGE}</span>
            {/* The link's one home is the Guests page. */}
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => openWorkspaceTab('guests')}
            >
              <LinkIcon data-icon="inline-start" />
              Invite link
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>
      )}
      {dialogs}
    </div>
  )
}

function StageRow({
  person,
  talkShow,
  disabled,
  bringOnBlocked,
  spotlit,
  moderation,
  onToggleMute,
  onToggleScreenShare
}: {
  person: RoomPerson
  talkShow: TalkShowContextValue
  disabled: boolean
  bringOnBlocked: string | null
  spotlit: boolean
  moderation: KebabMenuItem[]
  onToggleMute: (person: RoomPerson) => void
  onToggleScreenShare: (person: RoomPerson) => void
}): ReactElement {
  const local = talkShow.room.local
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
    <PersonRow
      disabled={disabled}
      menuItems={items}
      micBadgeTestId="show-stage-mic"
      micTestId="show-stage-mute"
      person={person}
      talkShow={talkShow}
      testId="show-stage-strip-row"
      onToggleMute={onToggleMute}
      onToggleScreenShare={onToggleScreenShare}
    >
      {/* The host is always on stage (H2): their row has no stage move (L3). */}
      {person.host ? null : (
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
            {person.onStage ? (
              <ArrowDownIcon data-icon="inline-start" />
            ) : (
              <ArrowUpIcon data-icon="inline-start" />
            )}
            {person.onStage ? 'Send backstage' : 'Bring on'}
          </Button>
        </DisabledReason>
      )}
    </PersonRow>
  )
}

/** Plan 249 S6: a coarse clock, so a report can go out of date on screen.
 * Ticks only while something runs; the preview's words change at most every
 * few seconds. */
function usePreviewClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [running])
  return now
}
