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

// A file, never a data URI (plan 174 S4.1): under Vite's 4 KB inline limit
// this 2.6 KB picture became 2.7 KB of base64 in the eager bundle. Every
// importer must use the same query, or the bundle carries both copies.
import buddyEmblemUrl from '../assets/buddy/buddy-emblem-64.webp?no-inline'
import {
  YOUTUBE_ARTBOARD,
  YOUTUBE_ICON_URL,
  YOUTUBE_MARK,
  YOUTUBE_MARK_ASPECT,
  YOUTUBE_MARK_MIN_PX
} from '../lib/youtube-mark'
import { X_MARK_PATH } from '../lib/x-mark'

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
// whole registry into the initial renderer asset graph. Per-icon package
// exports also keep Vite development reloads from evaluating every unused
// glyph and weight in the package barrel while a performance check runs.
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
    | 'BookmarkSimple'
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
    | 'EyeSlash'
    | 'FacebookLogo'
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
    | 'LinkSimple'
    | 'LockKey'
    | 'MagnifyingGlass'
    | 'MagnifyingGlassPlus'
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
  >
>

/**
 * Navigation — one slot per sidebar destination. These are the icons the
 * 2026-08-25 semantic audit reviews first: several are placeholders inherited
 * from the pre-audit set (see the audit table in the Nucleo plan). The Buddy
 * tab's slot is `BuddyIcon`, the Buddy emblem, below.
 */
export { VideoCamera as StudioIcon } from '@phosphor-icons/react/dist/csr/VideoCamera'
export { Monitor as SourcesIcon } from '@phosphor-icons/react/dist/csr/Monitor'
export { SquaresFour as SceneIcon } from '@phosphor-icons/react/dist/csr/SquaresFour'
export { ImageSquare as AssetsIcon } from '@phosphor-icons/react/dist/csr/ImageSquare'
export { Broadcast as LivestreamIcon } from '@phosphor-icons/react/dist/csr/Broadcast'
export { ClosedCaptioning as CaptionsIcon } from '@phosphor-icons/react/dist/csr/ClosedCaptioning'
export { Record as OutputIcon } from '@phosphor-icons/react/dist/csr/Record'
export { FilmReel as LibraryIcon } from '@phosphor-icons/react/dist/csr/FilmReel'
export { GearSix as SettingsIcon } from '@phosphor-icons/react/dist/csr/GearSix'
export { Pulse as HealthIcon } from '@phosphor-icons/react/dist/csr/Pulse'
/**
 * Status and feedback. One glyph per meaning: a triangle warns, a circle
 * alerts, a crossed circle is an error. Never introduce a second variant of
 * an existing meaning — that is how the set grew to 100 icons.
 */
export { Warning as WarningIcon } from '@phosphor-icons/react/dist/csr/Warning'
export { WarningCircle as AlertIcon } from '@phosphor-icons/react/dist/csr/WarningCircle'
export { XCircle as ErrorIcon } from '@phosphor-icons/react/dist/csr/XCircle'
export { CheckCircle as SuccessIcon } from '@phosphor-icons/react/dist/csr/CheckCircle'
export { Check as CheckIcon } from '@phosphor-icons/react/dist/csr/Check'
export { Info as InfoIcon } from '@phosphor-icons/react/dist/csr/Info'
export { CircleNotch as SpinnerIcon } from '@phosphor-icons/react/dist/csr/CircleNotch'
export { Heartbeat as HeartbeatIcon } from '@phosphor-icons/react/dist/csr/Heartbeat'
export { Gauge as GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge'
export { MinusCircle as DisabledIcon } from '@phosphor-icons/react/dist/csr/MinusCircle'
/**
 * Chrome and controls.
 */
export { CaretDown as ChevronDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown'
export { CaretUpIcon as ChevronUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp'
export { CaretRight as ChevronRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight'
export { X as CloseIcon } from '@phosphor-icons/react/dist/csr/X'
export { DotsThree as MoreIcon } from '@phosphor-icons/react/dist/csr/DotsThree'
export { MagnifyingGlass as SearchIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
// Opens a small picture larger to look at it (the Buddy's bubble sample
// and its preview); never a zoom level control.
export { MagnifyingGlassPlus as ZoomInIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassPlus'
export { SlidersHorizontal as AdjustIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal'
export { Layout as LayoutIcon } from '@phosphor-icons/react/dist/csr/Layout'
/**
 * Arrows and movement.
 */
export { ArrowUp as ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp'
export { ArrowDown as ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown'
export { ArrowLeft as ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft'
export { ArrowRight as ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight'
export { ArrowSquareOut as ExternalLinkIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut'
export { ArrowClockwise as RefreshIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
export { ArrowsClockwise as SyncIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise'
export { ArrowCounterClockwise as ResetIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
export { ArrowsDownUp as SortIcon } from '@phosphor-icons/react/dist/csr/ArrowsDownUp'
/**
 * Capture, media and playback.
 */
export { VideoCamera as CameraIcon } from '@phosphor-icons/react/dist/csr/VideoCamera'
export { Monitor as DisplayIcon } from '@phosphor-icons/react/dist/csr/Monitor'
export { Desktop as DesktopIcon } from '@phosphor-icons/react/dist/csr/Desktop'
export { DeviceMobile as MobileIcon } from '@phosphor-icons/react/dist/csr/DeviceMobile'
export { Microphone as MicrophoneIcon } from '@phosphor-icons/react/dist/csr/Microphone'
export { SpeakerHigh as SpeakerOnIcon } from '@phosphor-icons/react/dist/csr/SpeakerHigh'
export { SpeakerSlash as SpeakerOffIcon } from '@phosphor-icons/react/dist/csr/SpeakerSlash'
export { Waveform as WaveformIcon } from '@phosphor-icons/react/dist/csr/Waveform'
export { WaveformSlash as WaveformMutedIcon } from '@phosphor-icons/react/dist/csr/WaveformSlash'
export { Record as RecordIcon } from '@phosphor-icons/react/dist/csr/Record'
export { Stop as StopIcon } from '@phosphor-icons/react/dist/csr/Stop'
export { Play as PlayIcon } from '@phosphor-icons/react/dist/csr/Play'
// The in-app player's pause (plan 119, S11); Stop is the capture action.
export { Pause as PauseIcon } from '@phosphor-icons/react/dist/csr/Pause'
export { FileVideo as VideoFileIcon } from '@phosphor-icons/react/dist/csr/FileVideo'
export { FilmSlate as ClapperboardIcon } from '@phosphor-icons/react/dist/csr/FilmSlate'
export { FrameCorners as FrameIcon } from '@phosphor-icons/react/dist/csr/FrameCorners'
export { Crosshair as CrosshairIcon } from '@phosphor-icons/react/dist/csr/Crosshair'
// A marker: a point on a recording's timeline its owner wants to find
// again (CONTEXT.md). Never scissors, which mean a cut (plan 174 S3.12).
export { BookmarkSimple as MarkerIcon } from '@phosphor-icons/react/dist/csr/BookmarkSimple'
// Hide screen (plan 210): the screen is hidden from viewers. Never the
// Preview's eye, which opens a window.
export { EyeSlash as HiddenIcon } from '@phosphor-icons/react/dist/csr/EyeSlash'
/**
 * Files, assets and editing.
 */
export { FolderOpen as FolderIcon } from '@phosphor-icons/react/dist/csr/FolderOpen'
export { DownloadSimple as DownloadIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple'
export { UploadSimple as UploadIcon } from '@phosphor-icons/react/dist/csr/UploadSimple'
export { FloppyDisk as SaveIcon } from '@phosphor-icons/react/dist/csr/FloppyDisk'
export { Trash as DeleteIcon } from '@phosphor-icons/react/dist/csr/Trash'
export { Copy as CopyIcon } from '@phosphor-icons/react/dist/csr/Copy'
export { PencilSimple as EditIcon } from '@phosphor-icons/react/dist/csr/PencilSimple'
export { NotePencil as NoteIcon } from '@phosphor-icons/react/dist/csr/NotePencil'
export { ImageSquare as ImageIcon } from '@phosphor-icons/react/dist/csr/ImageSquare'
export { ImageBroken as ImageBrokenIcon } from '@phosphor-icons/react/dist/csr/ImageBroken'
export { Eye as PreviewIcon } from '@phosphor-icons/react/dist/csr/Eye'
/**
 * Account, access and links.
 */
export { LockKey as LockIcon } from '@phosphor-icons/react/dist/csr/LockKey'
export { SignIn as SignInIcon } from '@phosphor-icons/react/dist/csr/SignIn'
export { SignOut as SignOutIcon } from '@phosphor-icons/react/dist/csr/SignOut'
export { UserCircle as AccountIcon } from '@phosphor-icons/react/dist/csr/UserCircle'
export { LinkSimple as LinkIcon } from '@phosphor-icons/react/dist/csr/LinkSimple'
/**
 * AI, tooling and appearance. Buddy (code name `cohost`) has its own mark,
 * the real Buddy artwork: `BuddyIcon` below at icon size, `BuddyEmblem` larger.
 */
export { Sparkle as SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle'
// Scissors means cutting only: Clean cut and clips (plan 174 S3.12, J1-22).
export { Scissors as ClipIcon } from '@phosphor-icons/react/dist/csr/Scissors'
export { Wrench as RepairIcon } from '@phosphor-icons/react/dist/csr/Wrench'
export { Bug as BugIcon } from '@phosphor-icons/react/dist/csr/Bug'
export { TerminalWindow as TerminalIcon } from '@phosphor-icons/react/dist/csr/TerminalWindow'
export { TextAa as TextIcon } from '@phosphor-icons/react/dist/csr/TextAa'
export { ChatCircle as ChatIcon } from '@phosphor-icons/react/dist/csr/ChatCircle'
export { PaperPlaneRight as SendIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneRight'
export { PushPin as PinIcon } from '@phosphor-icons/react/dist/csr/PushPin'
export { Sun as LightModeIcon } from '@phosphor-icons/react/dist/csr/Sun'
export { Moon as DarkModeIcon } from '@phosphor-icons/react/dist/csr/Moon'
/**
 * Platform brand marks. NOT part of the Nucleo migration: these are third-party
 * logos with their own trademark rules, and the design language keeps app/source
 * marks as the only full-colour icons on screen.
 */
export { TwitchLogo as TwitchIcon } from '@phosphor-icons/react/dist/csr/TwitchLogo'
export { TiktokLogo as TiktokIcon } from '@phosphor-icons/react/dist/csr/TiktokLogo'
export { InstagramLogo as InstagramIcon } from '@phosphor-icons/react/dist/csr/InstagramLogo'
export { FacebookLogo as FacebookIcon } from '@phosphor-icons/react/dist/csr/FacebookLogo'

export { YOUTUBE_MARK_ASPECT, YOUTUBE_MARK_MIN_PX }

/**
 * YouTube's mark (plan 165): the official full-colour icon from YouTube's
 * brand site, unmodified (`assets/brand/youtube/`), never a redrawn glyph.
 *
 * Like `BuddyIcon` it is an `<svg>` around an `<image>`, so `currentColor`,
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
 * X's mark (plan 167): the path from X's partner icon kit
 * (`assets/brand/x/`), never a redrawn glyph. X's rule is one solid colour,
 * black on light surfaces and white on dark, so it is pure black or pure
 * white by theme, never the `foreground` token or a caller's tint (the fill
 * classes win over an inherited `text-*`). `weight` is accepted and ignored.
 */
export const XPlatformIcon: AppIcon = ({ size, weight: _weight, children, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size ?? '1em'}
    height={size ?? '1em'}
    data-slot="platform-mark"
    data-platform="x"
    {...props}
  >
    {children}
    <path className="fill-black dark:fill-white" d={X_MARK_PATH} />
  </svg>
)
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
 * Buddy's mark (plans 149 and 164): the owner's stone golem, the full-colour
 * artwork in `assets/brand/buddy/`, at icon size. The owner's call: it appears
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
export const BuddyIcon: AppIcon = ({ size, weight: _weight, children, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 256 256"
    width={size ?? '1em'}
    height={size ?? '1em'}
    data-slot="buddy-icon"
    {...props}
  >
    {children}
    <image href={buddyEmblemUrl} width="256" height="256" preserveAspectRatio="xMidYMid meet" />
  </svg>
)
