/**
 * The Videorc icon registry — the single place the app names an icon.
 *
 * Every renderer module imports icons from here, never from an icon package
 * directly (`no-restricted-imports` enforces it). Two reasons:
 *
 * 1. **Meaning over shape.** Call sites ask for `SourcesIcon` or `AlertIcon`,
 *    so swapping the underlying glyph is a one-line change here instead of a
 *    hunt through 50+ files.
 * 2. **A countable set.** Icon licences are counted in glyphs (Nucleo's
 *    open-source allowance is 100). Before this registry the app had grown to
 *    100 distinct imports with duplicates of the same meaning — three warning
 *    variants, two pins, two locks. The set is now reviewable in one file.
 *
 * Adding an icon: check whether an existing slot already means what you need.
 * If it does, reuse it. Only add a slot for a genuinely new meaning.
 */
import type { ComponentType, SVGProps } from 'react'

import type * as PhosphorIcons from '@phosphor-icons/react'

import orcleEmblemUrl from '../assets/golem/golem-emblem-64.webp'
import {
  YOUTUBE_ARTBOARD,
  YOUTUBE_ICON_URL,
  YOUTUBE_MARK,
  YOUTUBE_MARK_ASPECT,
  YOUTUBE_MARK_MIN_PX
} from '../lib/youtube-mark'

/**
 * The props every registry icon accepts.
 *
 * Declared structurally rather than re-exported from the icon package, so the
 * app's own type is what call sites depend on: swapping icon sets then means
 * changing this file, not 50 others. `weight` stays in the surface because
 * ~113 call sites pass it; a single-weight set may accept and ignore it.
 */
export type AppIconProps = {
  size?: number | string
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'
} & Omit<SVGProps<SVGSVGElement>, 'ref' | 'weight'>

/**
 * An icon component. Modules that store an icon in metadata — the workspace
 * nav, row primitives — type the field as `AppIcon`.
 */
export type AppIcon = ComponentType<AppIconProps>

// The compile-only check preserves the app prop contract. Direct re-exports
// let each consumer own its glyph chunks; optional panels must not pull the
// whole registry into the initial renderer asset graph.
type _AssertIconProps<T extends Record<string, AppIcon>> = T
type _RegistryIconProps = _AssertIconProps<
  Pick<
    typeof PhosphorIcons,
    | 'ArrowClockwise'
    | 'ArrowCounterClockwise'
    | 'ArrowDown'
    | 'ArrowLeft'
    | 'ArrowRight'
    | 'ArrowSquareOut'
    | 'ArrowUp'
    | 'ArrowsClockwise'
    | 'ArrowsDownUp'
    | 'Brain'
    | 'Broadcast'
    | 'Bug'
    | 'CaretDown'
    | 'CaretRight'
    | 'CaretUpIcon'
    | 'ChatCircle'
    | 'Check'
    | 'CheckCircle'
    | 'CircleNotch'
    | 'ClosedCaptioning'
    | 'Copy'
    | 'Crosshair'
    | 'Desktop'
    | 'DeviceMobile'
    | 'DotsThree'
    | 'DownloadSimple'
    | 'Eye'
    | 'FileVideo'
    | 'FilmReel'
    | 'FilmSlate'
    | 'FloppyDisk'
    | 'FolderOpen'
    | 'FrameCorners'
    | 'Gauge'
    | 'GearSix'
    | 'Heartbeat'
    | 'ImageBroken'
    | 'ImageSquare'
    | 'Info'
    | 'InstagramLogo'
    | 'Layout'
    | 'Lightning'
    | 'LinkSimple'
    | 'LockKey'
    | 'MagnifyingGlass'
    | 'Microphone'
    | 'MinusCircle'
    | 'Monitor'
    | 'Moon'
    | 'NotePencil'
    | 'PaperPlaneRight'
    | 'Pause'
    | 'PencilSimple'
    | 'Play'
    | 'Pulse'
    | 'PushPin'
    | 'Record'
    | 'Scissors'
    | 'ShieldCheck'
    | 'SignIn'
    | 'SignOut'
    | 'SlidersHorizontal'
    | 'Sparkle'
    | 'SpeakerHigh'
    | 'SpeakerSlash'
    | 'SquaresFour'
    | 'Stop'
    | 'Sun'
    | 'TerminalWindow'
    | 'TextAa'
    | 'TiktokLogo'
    | 'Trash'
    | 'TwitchLogo'
    | 'UploadSimple'
    | 'UserCircle'
    | 'VideoCamera'
    | 'Warning'
    | 'WarningCircle'
    | 'Waveform'
    | 'WaveformSlash'
    | 'Wrench'
    | 'X'
    | 'XCircle'
    | 'XLogo'
  >
>

/**
 * Navigation — one slot per sidebar destination. These are the icons the
 * 2026-08-25 semantic audit reviews first: several are placeholders inherited
 * from the pre-audit set (see the audit table in the Nucleo plan). The Orcle
 * tab's slot is `OrcleIcon`, the Golem emblem, below.
 */
export {
  VideoCamera as StudioIcon,
  Monitor as SourcesIcon,
  SquaresFour as SceneIcon,
  ImageSquare as AssetsIcon,
  Broadcast as LivestreamIcon,
  ClosedCaptioning as CaptionsIcon,
  Record as OutputIcon,
  FilmReel as LibraryIcon,
  GearSix as SettingsIcon,
  Pulse as HealthIcon
} from '@phosphor-icons/react'
/**
 * Status and feedback. One glyph per meaning: a triangle warns, a circle
 * alerts, a crossed circle is an error. Never introduce a second variant of
 * an existing meaning — that is how the set grew to 100 icons.
 */
export {
  Warning as WarningIcon,
  WarningCircle as AlertIcon,
  XCircle as ErrorIcon,
  CheckCircle as SuccessIcon,
  Check as CheckIcon,
  Info as InfoIcon,
  CircleNotch as SpinnerIcon,
  Heartbeat as HeartbeatIcon,
  Gauge as GaugeIcon,
  ShieldCheck as VerifiedIcon,
  MinusCircle as DisabledIcon
} from '@phosphor-icons/react'
/**
 * Chrome and controls.
 */
export {
  CaretDown as ChevronDownIcon,
  CaretUpIcon as ChevronUpIcon,
  CaretRight as ChevronRightIcon,
  X as CloseIcon,
  DotsThree as MoreIcon,
  MagnifyingGlass as SearchIcon,
  SlidersHorizontal as AdjustIcon,
  Layout as LayoutIcon
} from '@phosphor-icons/react'
/**
 * Arrows and movement.
 */
export {
  ArrowUp as ArrowUpIcon,
  ArrowDown as ArrowDownIcon,
  ArrowLeft as ArrowLeftIcon,
  ArrowRight as ArrowRightIcon,
  ArrowSquareOut as ExternalLinkIcon,
  ArrowClockwise as RefreshIcon,
  ArrowsClockwise as SyncIcon,
  ArrowCounterClockwise as ResetIcon,
  ArrowsDownUp as SortIcon
} from '@phosphor-icons/react'
/**
 * Capture, media and playback.
 */
export {
  VideoCamera as CameraIcon,
  Monitor as DisplayIcon,
  Desktop as DesktopIcon,
  DeviceMobile as MobileIcon,
  Microphone as MicrophoneIcon,
  SpeakerHigh as SpeakerOnIcon,
  SpeakerSlash as SpeakerOffIcon,
  Waveform as WaveformIcon,
  WaveformSlash as WaveformMutedIcon,
  Record as RecordIcon,
  Stop as StopIcon,
  Play as PlayIcon,
  // The in-app player's pause (plan 119, S11); Stop is the capture action.
  Pause as PauseIcon,
  FileVideo as VideoFileIcon,
  FilmSlate as ClapperboardIcon,
  FrameCorners as FrameIcon,
  Crosshair as CrosshairIcon
} from '@phosphor-icons/react'
/**
 * Files, assets and editing.
 */
export {
  FolderOpen as FolderIcon,
  DownloadSimple as DownloadIcon,
  UploadSimple as UploadIcon,
  FloppyDisk as SaveIcon,
  Trash as DeleteIcon,
  Copy as CopyIcon,
  PencilSimple as EditIcon,
  NotePencil as NoteIcon,
  ImageSquare as ImageIcon,
  ImageBroken as ImageBrokenIcon,
  Eye as PreviewIcon
} from '@phosphor-icons/react'
/**
 * Account, access and links.
 */
export {
  LockKey as LockIcon,
  SignIn as SignInIcon,
  SignOut as SignOutIcon,
  UserCircle as AccountIcon,
  LinkSimple as LinkIcon
} from '@phosphor-icons/react'
/**
 * AI, tooling and appearance. Orcle (code name `cohost`) has its own mark,
 * the real Golem artwork: `OrcleIcon` below at icon size, `OrcleEmblem` larger.
 */
export {
  Brain as BrainIcon,
  Sparkle as SparkleIcon,
  Lightning as FastIcon,
  Scissors as ClipIcon,
  Wrench as RepairIcon,
  Bug as BugIcon,
  TerminalWindow as TerminalIcon,
  TextAa as TextIcon,
  ChatCircle as ChatIcon,
  PaperPlaneRight as SendIcon,
  PushPin as PinIcon,
  Sun as LightModeIcon,
  Moon as DarkModeIcon
} from '@phosphor-icons/react'
/**
 * Platform brand marks. NOT part of the Nucleo migration: these are third-party
 * logos with their own trademark rules, and the design language keeps app/source
 * marks as the only full-colour icons on screen.
 */
export {
  TwitchLogo as TwitchIcon,
  XLogo as XPlatformIcon,
  TiktokLogo as TiktokIcon,
  InstagramLogo as InstagramIcon
} from '@phosphor-icons/react'

export { YOUTUBE_MARK_ASPECT, YOUTUBE_MARK_MIN_PX }

/**
 * YouTube's mark (plan 165): the official full-colour icon from YouTube's
 * brand site, unmodified (`assets/brand/youtube/`), never a redrawn glyph.
 *
 * Like `OrcleIcon` it is an `<svg>` around an `<image>`, so `currentColor`,
 * tint classes and hover recolours cannot reach the artwork: the red and the
 * white triangle are YouTube's. Its height is the `size` prop, clamped to at
 * least YOUTUBE_MARK_MIN_PX, and its width follows the mark's aspect. The
 * size is set inline, so a caller's `size-3.5` class cannot shrink it; a
 * surface that has no room for 20px shows the word "YouTube" instead.
 * `weight` is accepted and ignored.
 */
export const YoutubeIcon: AppIcon = ({ size, weight: _weight, children, style, ...props }) => {
  const requested = typeof size === 'number' ? size : Number.parseFloat(size ?? '')
  const height = Math.max(YOUTUBE_MARK_MIN_PX, Number.isFinite(requested) ? requested : 0)
  const width = Math.round(height * YOUTUBE_MARK_ASPECT * 100) / 100
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      // The viewBox crops to the mark, so the svg box IS the visible icon.
      viewBox={`${YOUTUBE_MARK.x} ${YOUTUBE_MARK.y} ${YOUTUBE_MARK.width} ${YOUTUBE_MARK.height}`}
      width={width}
      height={height}
      data-slot="platform-mark"
      data-platform="youtube"
      {...props}
      style={{ ...style, width, height, flexShrink: 0 }}
    >
      {children}
      <image
        href={YOUTUBE_ICON_URL}
        width={YOUTUBE_ARTBOARD.width}
        height={YOUTUBE_ARTBOARD.height}
      />
    </svg>
  )
}
/**
 * Kick's mark (plan 063). Phosphor has no Kick logo, so this is a hand-drawn,
 * simplified version: the stepped "K" knocked out of a rounded square, drawn
 * in currentColor on Phosphor's 256 grid so it sizes and tints like the other
 * brand marks. `weight` is accepted and ignored (one weight only).
 */
export const KickIcon: AppIcon = ({ size, weight: _weight, children, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 256 256"
    width={size ?? '1em'}
    height={size ?? '1em'}
    fill="currentColor"
    {...props}
  >
    {children}
    <path
      fillRule="evenodd"
      d="M56 16h144a40 40 0 0 1 40 40v144a40 40 0 0 1-40 40H56a40 40 0 0 1-40-40V56a40 40 0 0 1 40-40ZM64 56v144h44v-44h20v22h22v22h44v-56h-22v-32h22V56h-44v22h-22v22h-20V56Z"
    />
  </svg>
)

/**
 * Golem's mark (plans 149 and 164): the owner's stone golem, the full-colour
 * artwork in `assets/brand/golem/`, at icon size. The owner's call: it appears
 * as its actual image everywhere, the sidebar, the Stream Manager, the Studio
 * session row, popovers and menus, never as a redrawn glyph.
 *
 * It stays an `<svg>` so every slot that sizes and lays out icons through
 * `svg` selectors (`[&_svg]:size-4`, the Alert's `has-[>svg]` grid) treats it
 * like its neighbours. The raster sits inside as an `<image>`, centred and
 * fitted to the square: the eye is wider than tall, so it fills the width.
 * The 64 px export is the 2x+ source for every icon size up to 32 px.
 *
 * It is the one full-colour icon in the registry. `weight` is accepted and
 * ignored, and `currentColor` never tints it: the red iris is the brand.
 */
export const OrcleIcon: AppIcon = ({ size, weight: _weight, children, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 256 256"
    width={size ?? '1em'}
    height={size ?? '1em'}
    data-slot="orcle-icon"
    {...props}
  >
    {children}
    <image href={orcleEmblemUrl} width="256" height="256" preserveAspectRatio="xMidYMid meet" />
  </svg>
)
