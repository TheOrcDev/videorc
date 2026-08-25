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
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowUp,
  ArrowsClockwise,
  ArrowsDownUp,
  Brain,
  Broadcast,
  Bug,
  CaretDown,
  CaretRight,
  CaretUpIcon,
  ChatCircle,
  Check,
  CheckCircle,
  CircleNotch,
  ClosedCaptioning,
  Copy,
  Crosshair,
  Desktop,
  DeviceMobile,
  DotsThree,
  DownloadSimple,
  Eye,
  FileVideo,
  FilmReel,
  FilmSlate,
  FloppyDisk,
  FolderOpen,
  FrameCorners,
  Gauge,
  GearSix,
  Heartbeat,
  ImageBroken,
  ImageSquare,
  Info,
  Keyboard,
  Layout,
  Lightning,
  LinkSimple,
  LockKey,
  MagnifyingGlass,
  Microphone,
  MinusCircle,
  Monitor,
  Moon,
  NotePencil,
  PaintBrush,
  PaperPlaneRight,
  PencilSimple,
  Play,
  Pulse,
  PushPin,
  Record,
  Robot,
  Scissors,
  ShieldCheck,
  SignIn,
  SignOut,
  SlidersHorizontal,
  Sparkle,
  SpeakerHigh,
  SpeakerSlash,
  SquaresFour,
  Stop,
  Sun,
  TerminalWindow,
  TextAa,
  Trash,
  TwitchLogo,
  UploadSimple,
  UserCircle,
  VideoCamera,
  Warning,
  WarningCircle,
  Waveform,
  WaveformSlash,
  Wrench,
  X,
  XCircle,
  XLogo,
  YoutubeLogo,
  type Icon
} from '@phosphor-icons/react'

/**
 * The shape every registry icon satisfies: a component taking `className`,
 * `size` and (today) a Phosphor `weight`. Modules that store an icon in
 * metadata — the workspace nav, row primitives — type the field as `AppIcon`.
 */
export type AppIcon = Icon

/**
 * Navigation — one slot per sidebar destination. These are the icons the
 * 2026-08-25 semantic audit reviews first: several are placeholders inherited
 * from the pre-audit set (see the audit table in the Nucleo plan).
 */
export const StudioIcon: AppIcon = VideoCamera
export const SourcesIcon: AppIcon = Monitor
export const SceneIcon: AppIcon = SquaresFour
export const AssetsIcon: AppIcon = ImageSquare
export const LivestreamIcon: AppIcon = Broadcast
export const CaptionsIcon: AppIcon = ClosedCaptioning
export const OutputIcon: AppIcon = Record
export const LibraryIcon: AppIcon = FilmReel
export const PublishIcon: AppIcon = Sparkle
export const SettingsIcon: AppIcon = GearSix
export const HealthIcon: AppIcon = Pulse

/**
 * Status and feedback. One glyph per meaning: a triangle warns, a circle
 * alerts, a crossed circle is an error. Never introduce a second variant of
 * an existing meaning — that is how the set grew to 100 icons.
 */
export const WarningIcon: AppIcon = Warning
export const AlertIcon: AppIcon = WarningCircle
export const ErrorIcon: AppIcon = XCircle
export const SuccessIcon: AppIcon = CheckCircle
export const CheckIcon: AppIcon = Check
export const InfoIcon: AppIcon = Info
export const SpinnerIcon: AppIcon = CircleNotch
export const HeartbeatIcon: AppIcon = Heartbeat
export const GaugeIcon: AppIcon = Gauge
export const VerifiedIcon: AppIcon = ShieldCheck
export const DisabledIcon: AppIcon = MinusCircle

/**
 * Chrome and controls.
 */
export const ChevronDownIcon: AppIcon = CaretDown
export const ChevronUpIcon: AppIcon = CaretUpIcon
export const ChevronRightIcon: AppIcon = CaretRight
export const CloseIcon: AppIcon = X
export const MoreIcon: AppIcon = DotsThree
export const SearchIcon: AppIcon = MagnifyingGlass
export const AdjustIcon: AppIcon = SlidersHorizontal
export const KeyboardIcon: AppIcon = Keyboard
export const LayoutIcon: AppIcon = Layout

/**
 * Arrows and movement.
 */
export const ArrowUpIcon: AppIcon = ArrowUp
export const ArrowDownIcon: AppIcon = ArrowDown
export const ArrowLeftIcon: AppIcon = ArrowLeft
export const ArrowRightIcon: AppIcon = ArrowRight
export const ExternalLinkIcon: AppIcon = ArrowSquareOut
export const RefreshIcon: AppIcon = ArrowClockwise
export const SyncIcon: AppIcon = ArrowsClockwise
export const ResetIcon: AppIcon = ArrowCounterClockwise
export const SortIcon: AppIcon = ArrowsDownUp

/**
 * Capture, media and playback.
 */
export const CameraIcon: AppIcon = VideoCamera
export const DisplayIcon: AppIcon = Monitor
export const DesktopIcon: AppIcon = Desktop
export const MobileIcon: AppIcon = DeviceMobile
export const MicrophoneIcon: AppIcon = Microphone
export const SpeakerOnIcon: AppIcon = SpeakerHigh
export const SpeakerOffIcon: AppIcon = SpeakerSlash
export const WaveformIcon: AppIcon = Waveform
export const WaveformMutedIcon: AppIcon = WaveformSlash
export const RecordIcon: AppIcon = Record
export const StopIcon: AppIcon = Stop
export const PlayIcon: AppIcon = Play
export const VideoFileIcon: AppIcon = FileVideo
export const ClapperboardIcon: AppIcon = FilmSlate
export const FrameIcon: AppIcon = FrameCorners
export const CrosshairIcon: AppIcon = Crosshair

/**
 * Files, assets and editing.
 */
export const FolderIcon: AppIcon = FolderOpen
export const DownloadIcon: AppIcon = DownloadSimple
export const UploadIcon: AppIcon = UploadSimple
export const SaveIcon: AppIcon = FloppyDisk
export const DeleteIcon: AppIcon = Trash
export const CopyIcon: AppIcon = Copy
export const EditIcon: AppIcon = PencilSimple
export const NoteIcon: AppIcon = NotePencil
export const ImageIcon: AppIcon = ImageSquare
export const ImageBrokenIcon: AppIcon = ImageBroken
export const PreviewIcon: AppIcon = Eye

/**
 * Account, access and links.
 */
export const LockIcon: AppIcon = LockKey
export const SignInIcon: AppIcon = SignIn
export const SignOutIcon: AppIcon = SignOut
export const AccountIcon: AppIcon = UserCircle
export const LinkIcon: AppIcon = LinkSimple

/**
 * AI, tooling and appearance.
 */
export const CohostIcon: AppIcon = Robot
export const BrainIcon: AppIcon = Brain
export const SparkleIcon: AppIcon = Sparkle
export const FastIcon: AppIcon = Lightning
export const ClipIcon: AppIcon = Scissors
export const RepairIcon: AppIcon = Wrench
export const BugIcon: AppIcon = Bug
export const TerminalIcon: AppIcon = TerminalWindow
export const ThemeIcon: AppIcon = PaintBrush
export const TextIcon: AppIcon = TextAa
export const ChatIcon: AppIcon = ChatCircle
export const SendIcon: AppIcon = PaperPlaneRight
export const PinIcon: AppIcon = PushPin
export const LightModeIcon: AppIcon = Sun
export const DarkModeIcon: AppIcon = Moon

/**
 * Platform brand marks. NOT part of the Nucleo migration: these are third-party
 * logos with their own trademark rules, and the design language keeps app/source
 * marks as the only full-colour icons on screen.
 */
export const TwitchIcon: AppIcon = TwitchLogo
export const XPlatformIcon: AppIcon = XLogo
export const YoutubeIcon: AppIcon = YoutubeLogo
