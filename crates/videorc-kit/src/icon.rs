//! The few icons the primitives draw themselves (`components/icons.tsx`
//! names them): Phosphor, MIT, in the weight the React twin draws (regular,
//! fill for an alert's tone, bold for the kebab's dots), as SVG masks the
//! element's text colour tints. Screens bring their own icons.

use gpui::{Hsla, IntoElement, Styled, Svg, px, svg};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconName {
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
    LockFill,
    /// `MoreIcon` at Phosphor's bold weight: the kebab menu's dots.
    DotsThreeBold,
    /// `SpinnerIcon` (Phosphor's CircleNotch): work that is running.
    CircleNotch,
}

impl IconName {
    fn bytes(self) -> &'static [u8] {
        match self {
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
            IconName::LockFill => include_bytes!("../icons/lock-key-fill.svg"),
            IconName::DotsThreeBold => include_bytes!("../icons/dots-three-bold.svg"),
            IconName::CircleNotch => include_bytes!("../icons/circle-notch.svg"),
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
