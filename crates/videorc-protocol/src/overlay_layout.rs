//! Wire types from `videorc-backend`'s `overlay_layout` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// Smallest side a placed rect may have (canvas units).
pub const OVERLAY_RECT_MIN_SIZE: f64 = 0.02;

pub const RECT_EPSILON: f64 = 1e-6;

/// A normalized rect in canvas units: `x`/`w` over the width, `y`/`h` over the
/// height.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OverlayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl OverlayRect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn validate(&self, item: OverlayItem, orientation: OverlayOrientation) -> Result<()> {
        let fields = [self.x, self.y, self.w, self.h];
        if fields.iter().any(|value| !value.is_finite()) {
            bail!(
                "{} {} rect must be finite.",
                item.label(),
                orientation.label()
            );
        }
        if self.w < OVERLAY_RECT_MIN_SIZE - RECT_EPSILON
            || self.h < OVERLAY_RECT_MIN_SIZE - RECT_EPSILON
        {
            bail!(
                "{} {} rect must be at least {OVERLAY_RECT_MIN_SIZE} wide and tall.",
                item.label(),
                orientation.label()
            );
        }
        if self.x < -RECT_EPSILON
            || self.y < -RECT_EPSILON
            || self.x + self.w > 1.0 + RECT_EPSILON
            || self.y + self.h > 1.0 + RECT_EPSILON
        {
            bail!(
                "{} {} rect must stay inside the canvas (0..1).",
                item.label(),
                orientation.label()
            );
        }
        Ok(())
    }

    /// The rect's centre lies in the lower half of the canvas, so its content
    /// hugs the rect's bottom edge (a caption bar grows upward, a corner card
    /// keeps its bottom margin).
    pub fn bottom_gravity(&self) -> bool {
        self.y + self.h / 2.0 >= 0.5
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayItem {
    Highlight,
    Captions,
    Buddy,
    /// The chat box (plan 215 G): the last few chat messages, off by default
    /// because it shows viewers' names.
    Chat,
}

impl OverlayItem {
    pub const ALL: [OverlayItem; 4] = [
        OverlayItem::Highlight,
        OverlayItem::Captions,
        OverlayItem::Buddy,
        OverlayItem::Chat,
    ];

    /// How the Go Live sheet names the item mid-sentence.
    pub fn label(self) -> &'static str {
        match self {
            OverlayItem::Highlight => "highlights",
            OverlayItem::Captions => "captions",
            OverlayItem::Buddy => "the avatar",
            OverlayItem::Chat => "chat",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayOrientation {
    Horizontal,
    Vertical,
}

impl OverlayOrientation {
    pub fn label(self) -> &'static str {
        match self {
            OverlayOrientation::Horizontal => "horizontal",
            OverlayOrientation::Vertical => "vertical",
        }
    }

    /// A canvas taller than wide is the portrait leg (the vertical simulcast
    /// leg or a vertical scene) and takes the item's vertical rect.
    pub fn for_canvas(width: u32, height: u32) -> Self {
        if height > width {
            OverlayOrientation::Vertical
        } else {
            OverlayOrientation::Horizontal
        }
    }
}

/// Which edge of its rect an overlay bitmap hugs horizontally. Decided by the
/// rect's centre, so the three legacy anchors (left corner, centred bar,
/// right corner) fall out of the rect alone and a rect dragged to the middle
/// centres its content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayHorizontalGravity {
    Left,
    Center,
    Right,
}

const CENTER_GRAVITY_BAND: f64 = 0.02;

impl OverlayRect {
    pub fn horizontal_gravity(&self) -> OverlayHorizontalGravity {
        let center = self.x + self.w / 2.0;
        if center < 0.5 - CENTER_GRAVITY_BAND {
            OverlayHorizontalGravity::Left
        } else if center > 0.5 + CENTER_GRAVITY_BAND {
            OverlayHorizontalGravity::Right
        } else {
            OverlayHorizontalGravity::Center
        }
    }

    /// The rect in canvas pixels: `(left, top, right, bottom)`, rounded and
    /// clamped to the canvas.
    pub fn pixels(
        &self,
        canvas_width: usize,
        canvas_height: usize,
    ) -> (usize, usize, usize, usize) {
        let clamp = |value: f64, max: usize| -> usize {
            (value * max as f64).round().clamp(0.0, max as f64) as usize
        };
        let left = clamp(self.x, canvas_width);
        let right = clamp(self.x + self.w, canvas_width).max(left);
        let top = clamp(self.y, canvas_height);
        let bottom = clamp(self.y + self.h, canvas_height).max(top);
        (left, top, right, bottom)
    }
}
