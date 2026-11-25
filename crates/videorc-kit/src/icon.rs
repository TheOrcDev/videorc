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
