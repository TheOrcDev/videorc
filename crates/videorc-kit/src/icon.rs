//! The icons the primitives draw themselves, and the Studio's, under the
//! slot names `components/icons.tsx` gives them: Phosphor, MIT, in the
//! weight the React twin draws (regular, fill for an alert's tone, bold for
//! the kebab's dots), as SVG masks the element's text colour tints.

use gpui::{Hsla, IntoElement, Styled, Svg, px, svg};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconName {
    /// SearchIcon.
    MagnifyingGlass,
    /// NotificationsIcon.
    Bell,
    /// `SuccessIcon`.
    CheckCircle,
    /// `ErrorIcon`.
    XCircle,
    /// `WarningIcon`.
    Warning,
    /// `InfoIcon`.
    Info,
    /// `CloseIcon`.
    X,
    /// A select's chevron.
    CaretDown,
    /// A chosen option.
    Check,
    /// `ChevronRightIcon`: a row that jumps to another page.
    CaretRight,
    /// An alert's tones, at Phosphor's fill weight: `InfoIcon`.
    InfoFill,
    /// `ErrorIcon`.
    XCircleFill,
    /// `SuccessIcon`.
    CheckCircleFill,
    /// `WarningIcon`.
    WarningFill,
    /// `LockIcon` (Phosphor's LockKey).
    LockKey,
    /// `LockIcon` at Phosphor's fill weight (Phosphor's LockKey).
    LockFill,
    /// `MoreIcon` at Phosphor's bold weight: the kebab menu's dots.
    DotsThreeBold,
    /// `SpinnerIcon` (Phosphor's CircleNotch): work that is running.
    CircleNotch,
    /// `LivestreamIcon` (Phosphor's Broadcast).
    Broadcast,
    /// `FrameIcon` (Phosphor's FrameCorners).
    FrameCorners,
    /// `AlertIcon` (Phosphor's WarningCircle).
    WarningCircle,
    /// `ExternalLinkIcon` (Phosphor's ArrowSquareOut): the preview's Pop out.
    ArrowSquareOut,
    /// `SettingsIcon` (Phosphor's GearSix).
    GearSix,
    /// `ImageIcon` and `AssetsIcon` (Phosphor's ImageSquare).
    ImageSquare,
    /// `PinIcon` (Phosphor's PushPin): Keep on top, unpinned.
    PushPin,
    /// `PinIcon` at Phosphor's fill weight: Keep on top, pinned.
    PushPinFill,
    /// `SourcesIcon` / `DisplayIcon` (Phosphor's Monitor).
    Monitor,
    /// `MobileIcon` (Phosphor's DeviceMobile).
    DeviceMobile,
    /// `LayoutIcon` (Phosphor's Layout).
    Layout,
    /// `StudioIcon` / `CameraIcon` (Phosphor's VideoCamera).
    VideoCamera,
    /// `SceneIcon` (Phosphor's SquaresFour).
    SquaresFour,
    /// `SparkleIcon` / `PublishIcon` (Phosphor's Sparkle).
    Sparkle,
    /// `UploadIcon` (Phosphor's UploadSimple).
    UploadSimple,
    /// `SyncIcon` (Phosphor's ArrowsClockwise).
    ArrowsClockwise,
    /// `CohostIcon` (Phosphor's Robot).
    Robot,
    /// `DeleteIcon` (Phosphor's Trash).
    Trash,
    /// `ImageBrokenIcon` (Phosphor's ImageBroken).
    ImageBroken,
    /// `MicrophoneIcon` (Phosphor's Microphone).
    Microphone,
    /// `RecordIcon` / `OutputIcon` (Phosphor's Record).
    Record,
    /// `SaveIcon` (Phosphor's FloppyDisk).
    FloppyDisk,
    /// `SpeakerOnIcon` (Phosphor's SpeakerHigh).
    SpeakerHigh,
    /// `SpeakerOffIcon` (Phosphor's SpeakerSlash).
    SpeakerSlash,
    /// `StopIcon` (Phosphor's Stop).
    Stop,
    /// `PlayIcon` (Phosphor's Play).
    Play,
    /// `BrainIcon` (Phosphor's Brain).
    Brain,
    /// `ClipIcon` (Phosphor's Scissors).
    Scissors,
    /// `CopyIcon` (Phosphor's Copy).
    Copy,
    /// `CrosshairIcon` (Phosphor's Crosshair).
    Crosshair,
    /// `DownloadIcon` (Phosphor's DownloadSimple).
    DownloadSimple,
    /// `FastIcon` (Phosphor's Lightning).
    Lightning,
    /// `VerifiedIcon` (Phosphor's ShieldCheck).
    ShieldCheck,
    /// `VideoFileIcon` (Phosphor's FileVideo).
    FileVideo,
    /// `WaveformIcon` (Phosphor's Waveform).
    Waveform,
    /// `CaptionsIcon` (Phosphor's ClosedCaptioning).
    ClosedCaptioning,
    /// `ResetIcon` (Phosphor's ArrowCounterClockwise).
    ArrowCounterClockwise,
    /// `SignInIcon` (Phosphor's SignIn).
    SignIn,
    /// `SignOutIcon` (Phosphor's SignOut): account menu Sign out.
    SignOut,
    /// `EditIcon` (Phosphor's PencilSimple).
    PencilSimple,
    /// `PreviewIcon` (Phosphor's Eye).
    Eye,
    /// `ChevronUpIcon` (Phosphor's CaretUp).
    CaretUp,
    /// `ArrowLeftIcon` (Phosphor's ArrowLeft).
    ArrowLeft,
    /// `ArrowRightIcon` (Phosphor's ArrowRight).
    ArrowRight,
    /// `ChatIcon` (Phosphor's ChatCircle).
    ChatCircle,
    /// `AccountIcon` (Phosphor's UserCircle).
    UserCircle,
    /// `BuddyPageIcon` / Sidekick mark (Phosphor's UserSound).
    UserSound,
    /// `AvatarPageIcon` (Phosphor's Smiley): the Avatar page's sidebar row.
    Smiley,
    /// `LibraryIcon` / `LibraryRowIcon` (Phosphor's FilmReel).
    FilmReel,
    /// `HealthIcon` / `HealthRowIcon` (Phosphor's Pulse): account menu Health.
    Pulse,
    /// `HeartbeatIcon` (Phosphor's Heartbeat): distinct from Pulse/Health.
    Heartbeat,
    /// `TerminalIcon` / Agents row (Phosphor's Terminal).
    Terminal,
    /// `FolderIcon` (Phosphor's FolderOpen).
    FolderOpen,
    /// `WaveformMutedIcon` (Phosphor's WaveformSlash).
    WaveformSlash,
    /// `DesktopIcon` (Phosphor's Desktop).
    Desktop,
    /// `EyeSlashIcon` for Screen hidden (Phosphor's EyeSlash).
    EyeSlash,
    /// `ArrowDownIcon` for jump chips (Phosphor's ArrowDown).
    ArrowDown,
    /// YouTube platform mark.
    YoutubeLogo,
    /// Twitch platform mark.
    TwitchLogo,
    /// X platform mark.
    XLogo,
    /// Instagram platform mark.
    InstagramLogo,
    /// TikTok platform mark.
    TiktokLogo,
    /// Facebook platform mark.
    FacebookLogo,
    /// Kick platform mark (Simple Icons, CC0).
    KickLogo,
    /// `StopIcon` at Phosphor's fill weight.
    StopFill,
}

impl IconName {
    fn bytes(self) -> &'static [u8] {
        match self {
            IconName::MagnifyingGlass => include_bytes!("../icons/magnifying-glass.svg"),
            IconName::Bell => include_bytes!("../icons/bell.svg"),
            IconName::CheckCircle => include_bytes!("../icons/check-circle.svg"),
            IconName::XCircle => include_bytes!("../icons/x-circle.svg"),
            IconName::Warning => include_bytes!("../icons/warning.svg"),
            IconName::Info => include_bytes!("../icons/info.svg"),
            IconName::X => include_bytes!("../icons/x.svg"),
            IconName::CaretDown => include_bytes!("../icons/caret-down.svg"),
            IconName::Check => include_bytes!("../icons/check.svg"),
            IconName::CaretRight => include_bytes!("../icons/caret-right.svg"),
            IconName::InfoFill => include_bytes!("../icons/info-fill.svg"),
            IconName::XCircleFill => include_bytes!("../icons/x-circle-fill.svg"),
            IconName::CheckCircleFill => include_bytes!("../icons/check-circle-fill.svg"),
            IconName::WarningFill => include_bytes!("../icons/warning-fill.svg"),
            IconName::LockKey => include_bytes!("../icons/lock-key.svg"),
            IconName::LockFill => include_bytes!("../icons/lock-key-fill.svg"),
            IconName::DotsThreeBold => include_bytes!("../icons/dots-three-bold.svg"),
            IconName::CircleNotch => include_bytes!("../icons/circle-notch.svg"),
            IconName::Broadcast => include_bytes!("../icons/broadcast.svg"),
            IconName::FrameCorners => include_bytes!("../icons/frame-corners.svg"),
            IconName::WarningCircle => include_bytes!("../icons/warning-circle.svg"),
            IconName::ArrowSquareOut => include_bytes!("../icons/arrow-square-out.svg"),
            IconName::GearSix => include_bytes!("../icons/gear-six.svg"),
            IconName::ImageSquare => include_bytes!("../icons/image-square.svg"),
            IconName::PushPin => include_bytes!("../icons/push-pin.svg"),
            IconName::PushPinFill => include_bytes!("../icons/push-pin-fill.svg"),
            IconName::Monitor => include_bytes!("../icons/monitor.svg"),
            IconName::DeviceMobile => include_bytes!("../icons/device-mobile.svg"),
            IconName::Layout => include_bytes!("../icons/layout.svg"),
            IconName::VideoCamera => include_bytes!("../icons/video-camera.svg"),
            IconName::SquaresFour => include_bytes!("../icons/squares-four.svg"),
            IconName::Sparkle => include_bytes!("../icons/sparkle.svg"),
            IconName::UploadSimple => include_bytes!("../icons/upload-simple.svg"),
            IconName::ArrowsClockwise => include_bytes!("../icons/arrows-clockwise.svg"),
            IconName::Robot => include_bytes!("../icons/robot.svg"),
            IconName::Trash => include_bytes!("../icons/trash.svg"),
            IconName::ImageBroken => include_bytes!("../icons/image-broken.svg"),
            IconName::Microphone => include_bytes!("../icons/microphone.svg"),
            IconName::Record => include_bytes!("../icons/record.svg"),
            IconName::FloppyDisk => include_bytes!("../icons/floppy-disk.svg"),
            IconName::SpeakerHigh => include_bytes!("../icons/speaker-high.svg"),
            IconName::SpeakerSlash => include_bytes!("../icons/speaker-slash.svg"),
            IconName::Stop => include_bytes!("../icons/stop.svg"),
            IconName::Play => include_bytes!("../icons/play.svg"),
            IconName::Brain => include_bytes!("../icons/brain.svg"),
            IconName::Scissors => include_bytes!("../icons/scissors.svg"),
            IconName::Copy => include_bytes!("../icons/copy.svg"),
            IconName::Crosshair => include_bytes!("../icons/crosshair.svg"),
            IconName::DownloadSimple => include_bytes!("../icons/download-simple.svg"),
            IconName::Lightning => include_bytes!("../icons/lightning.svg"),
            IconName::ShieldCheck => include_bytes!("../icons/shield-check.svg"),
            IconName::FileVideo => include_bytes!("../icons/file-video.svg"),
            IconName::Waveform => include_bytes!("../icons/waveform.svg"),
            IconName::ClosedCaptioning => include_bytes!("../icons/closed-captioning.svg"),
            IconName::ArrowCounterClockwise => {
                include_bytes!("../icons/arrow-counter-clockwise.svg")
            }
            IconName::SignIn => include_bytes!("../icons/sign-in.svg"),
            IconName::SignOut => include_bytes!("../icons/sign-out.svg"),
            IconName::PencilSimple => include_bytes!("../icons/pencil-simple.svg"),
            IconName::Eye => include_bytes!("../icons/eye.svg"),
            IconName::CaretUp => include_bytes!("../icons/caret-up.svg"),
            IconName::ArrowLeft => include_bytes!("../icons/arrow-left.svg"),
            IconName::ArrowRight => include_bytes!("../icons/arrow-right.svg"),
            IconName::ChatCircle => include_bytes!("../icons/chat-circle.svg"),
            IconName::UserCircle => include_bytes!("../icons/user-circle.svg"),
            IconName::UserSound => include_bytes!("../icons/user-sound.svg"),
            IconName::Smiley => include_bytes!("../icons/smiley.svg"),
            IconName::FilmReel => include_bytes!("../icons/film-reel.svg"),
            IconName::Pulse => include_bytes!("../icons/pulse.svg"),
            IconName::Heartbeat => include_bytes!("../icons/heartbeat.svg"),
            IconName::Terminal => include_bytes!("../icons/terminal.svg"),
            IconName::FolderOpen => include_bytes!("../icons/folder-open.svg"),
            IconName::WaveformSlash => include_bytes!("../icons/waveform-slash.svg"),
            IconName::Desktop => include_bytes!("../icons/desktop.svg"),
            IconName::EyeSlash => include_bytes!("../icons/eye-slash.svg"),
            IconName::ArrowDown => include_bytes!("../icons/arrow-down.svg"),
            IconName::YoutubeLogo => include_bytes!("../icons/youtube-logo.svg"),
            IconName::TwitchLogo => include_bytes!("../icons/twitch-logo.svg"),
            IconName::XLogo => include_bytes!("../icons/x-logo.svg"),
            IconName::InstagramLogo => include_bytes!("../icons/instagram-logo.svg"),
            IconName::TiktokLogo => include_bytes!("../icons/tiktok-logo.svg"),
            IconName::FacebookLogo => include_bytes!("../icons/facebook-logo.svg"),
            IconName::KickLogo => include_bytes!("../icons/kick-logo.svg"),
            IconName::StopFill => include_bytes!("../icons/stop-fill.svg"),
        }
    }
}

/// `name` at `size` px in `color`.
pub fn icon(name: IconName, size: f32, color: Hsla) -> Svg {
    svg()
        .data(name.bytes())
        .flex_none()
        .size(px(size))
        .text_color(color)
}

/// An icon element, for `child(...)`.
pub fn icon_element(name: IconName, size: f32, color: Hsla) -> impl IntoElement {
    icon(name, size, color)
}
