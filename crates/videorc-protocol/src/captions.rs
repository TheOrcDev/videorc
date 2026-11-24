//! Wire types from `videorc-backend`'s `captions` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::Serialize;

/// Caption text size for the burned copy (mirrors the renderer knob).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionTextSize {
    S,
    #[default]
    M,
    L,
}

/// Visual preset captured with each session. The renderer owns the actual
/// recipe, while Rust persists the stable identity for artifact/session parity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionStyleId {
    #[default]
    Classic,
    Glass,
    LowerThird,
    HighContrast,
}

/// Which caption products the user selected for this session. `Recording`
/// means a non-destructive aligned `(captioned)` copy; the source recording is
/// never a live burn target.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionBurnTarget {
    #[default]
    Off,
    Stream,
    Recording,
    Both,
}

impl CaptionBurnTarget {
    pub fn burns_stream(self) -> bool {
        matches!(self, CaptionBurnTarget::Stream | CaptionBurnTarget::Both)
    }

    pub fn requests_captioned_copy(self) -> bool {
        matches!(self, CaptionBurnTarget::Recording | CaptionBurnTarget::Both)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionOverlayPosition {
    Top,
    #[default]
    Bottom,
}
