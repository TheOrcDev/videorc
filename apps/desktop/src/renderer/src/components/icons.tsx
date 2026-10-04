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
    | 'YoutubeLogo'
  >
>

/**
 * Navigation — one slot per sidebar destination. These are the icons the
 * 2026-08-25 semantic audit reviews first: several are placeholders inherited
 * from the pre-audit set (see the audit table in the Nucleo plan). The Orcle
 * tab's slot is `OrcleIcon`, the Orcle eye, drawn below.
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
 * the eye: `OrcleIcon` below at icon size, `OrcleEmblem` in full colour.
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
  YoutubeLogo as YoutubeIcon,
  TiktokLogo as TiktokIcon,
  InstagramLogo as InstagramIcon
} from '@phosphor-icons/react'
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

// The Orcle eye (plan 149), drawn from the emblem in
// `assets/brand/orcle/`: a wide almond with the emblem's horn spiking up
// from its top-left corner.
const ORCLE_EYE = 'M14 134L42 104Q30 76 18 44Q44 60 72 72Q112 58 154 64L242 136Q150 238 14 134Z'

// The outline's features, stroked: the scowling brow that runs on from the
// horn's base, the iris below it, and one plate seam for the cyber half.
const ORCLE_EYE_FEATURES = 'M42 104L166 122M108 114A32 32 0 1 0 151 120M180 88L196 160'

const ORCLE_PUPIL = 'M114 140a12 12 0 1 0 24 0a12 12 0 1 0-24 0Z'

// The solid eye: the outline's outer edge, with the iris knocked out under
// the brow (its flat top is the scowl), a brow slit back to the horn and a
// solid pupil. The seam is dropped: at 16 px it would float as a slot.
const ORCLE_EYE_SOLID =
  'M9 140L6 136L7 131L33 102L11 47L10 41L14 37L17 36L22 37L48 52L72 63L95 58L120 54L146 55L155 56L159 58L249 132L250 137L248 141L229 159L210 174L190 185L168 191L146 194L123 193L100 189L76 180L60 173L43 164L18 147Z' +
  'M56 102L159 117A40 40 0 1 1 94 116L55 110Z' +
  'M112 140a14 14 0 1 0 28 0a14 14 0 1 0-28 0Z'

/**
 * Orcle's glyph (plan 149): the Orcle eye, simplified to read at 16 px. A
 * wide almond with the horn spike, a brow that scowls across the iris, a
 * pupil, and one plate seam. Hand-drawn like `KickIcon` on Phosphor's 256
 * grid in currentColor, so it sizes and tints like the set. One glyph
 * everywhere Orcle appears at icon size: the sidebar, the Stream Manager,
 * the Studio session row, popovers and menus.
 *
 * It is the small tier of Orcle's mark. The full-colour emblem
 * (`OrcleEmblem`) turns to mush below 24 px, so it never shrinks to this
 * slot; and the glyph never carries the emblem's red iris, because red means
 * record, live and destructive here.
 *
 * Unlike `KickIcon` it honours `weight` the way its Phosphor neighbours do,
 * so the sidebar's regular-to-fill swap still reads: an outline at Phosphor's
 * 16-unit stroke (thin, light, regular), the outline over a 20% eye
 * (duotone), and a solid eye with the iris knocked out (fill, bold).
 */
export const OrcleIcon: AppIcon = ({ size, weight, children, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 256 256"
    width={size ?? '1em'}
    height={size ?? '1em'}
    fill="currentColor"
    {...props}
  >
    {children}
    {weight === 'fill' || weight === 'bold' ? (
      <path fillRule="evenodd" d={ORCLE_EYE_SOLID} />
    ) : (
      <>
        {weight === 'duotone' ? <path d={ORCLE_EYE} opacity="0.2" /> : null}
        <path
          d={`${ORCLE_EYE}${ORCLE_EYE_FEATURES}`}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="16"
        />
        <path d={ORCLE_PUPIL} />
      </>
    )}
  </svg>
)
