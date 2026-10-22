//! Overlay layout (plan 164, Phase B): where the comment-highlight card, the
//! caption bar, the Buddy and the poll card (plan 188) sit on each output
//! orientation, and which outputs (stream, recording) carry them.
//!
//! Backend-owned, stored under one `app_settings` row (`overlayLayout`) and
//! served through `overlays.layout.get` / `overlays.layout.set`. Placement is
//! a normalized rect per orientation in canvas units (0..1); the renderer
//! rasterizes each overlay to the rect's width and the compositor blits the
//! bitmap inside the rect (see `overlay_blit_layout`).

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::comment_highlight::CommentHighlightAnchor;
use crate::state::AppState;
use crate::storage::Database;

pub const OVERLAY_LAYOUT_KEY: &str = "overlayLayout";
/// Sibling row recording one-time migrations into the layout, so a wire
/// shape with `allowUnknown: false` never carries bookkeeping.
const OVERLAY_LAYOUT_MIGRATION_KEY: &str = "overlayLayoutMigration";
/// Smallest side a placed rect may have (canvas units).
pub const OVERLAY_RECT_MIN_SIZE: f64 = 0.02;
pub(crate) const RECT_EPSILON: f64 = 1e-6;

/// Landscape side margin: 4% of the canvas height, expressed against a 16:9
/// width (43 px of 1920 at 1080p, the pre-plan-164 corner margin). The
/// margins are shared with the banner default places (plan 186, `banners.rs`).
pub(crate) const LANDSCAPE_SIDE_MARGIN: f64 = 0.04 * 9.0 / 16.0;
pub(crate) const LANDSCAPE_EDGE_MARGIN: f64 = 0.04;
/// Portrait side margin: 4% of the canvas height against a 9:16 width (77 px
/// of 1080 on a 1080x1920 leg).
pub(crate) const PORTRAIT_SIDE_MARGIN: f64 = 0.04 * 16.0 / 9.0;
/// Portrait platform safe area (plan 077): 8% top, 22% bottom.
pub(crate) const PORTRAIT_TOP_MARGIN: f64 = 0.08;
pub(crate) const PORTRAIT_BOTTOM_MARGIN: f64 = 0.22;

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

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayItemLayout {
    pub horizontal: OverlayRect,
    pub vertical: OverlayRect,
    pub show_on_stream: bool,
    pub show_in_recording: bool,
}

/// The four placeable overlay items. `buddy` is carried from Phase B on so
/// the leg plan and the canvas already know it; Phase C adds its slot. `poll`
/// (plan 188 S3) has a serde default: a layout stored before it loads with
/// its three placements intact and the poll at its default, instead of
/// failing to parse and resetting everyone to defaults.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OverlayLayout {
    pub highlight: OverlayItemLayout,
    pub captions: OverlayItemLayout,
    pub buddy: OverlayItemLayout,
    #[serde(default = "default_poll_item")]
    pub poll: OverlayItemLayout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayItem {
    Highlight,
    Captions,
    Buddy,
    /// The poll card (plan 188): between the Buddy and the highlight card.
    Poll,
}

impl OverlayItem {
    pub const ALL: [OverlayItem; 4] = [
        OverlayItem::Highlight,
        OverlayItem::Captions,
        OverlayItem::Buddy,
        OverlayItem::Poll,
    ];

    /// How the Go Live sheet names the item mid-sentence.
    pub fn label(self) -> &'static str {
        match self {
            OverlayItem::Highlight => "highlights",
            OverlayItem::Captions => "captions",
            OverlayItem::Buddy => "the Buddy",
            OverlayItem::Poll => "polls",
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

/// The snap presets the Stream Manager menu and the Scene inspector write:
/// the four corners plus the centred bottom bar position captions use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlaySnap {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    BottomCenter,
    TopCenter,
}

impl From<CommentHighlightAnchor> for OverlaySnap {
    fn from(anchor: CommentHighlightAnchor) -> Self {
        match anchor {
            CommentHighlightAnchor::TopLeft => OverlaySnap::TopLeft,
            CommentHighlightAnchor::TopRight => OverlaySnap::TopRight,
            CommentHighlightAnchor::BottomLeft => OverlaySnap::BottomLeft,
            CommentHighlightAnchor::BottomRight => OverlaySnap::BottomRight,
        }
    }
}

/// Default size `(w, h)` of an item on an orientation, in canvas units. The
/// highlight and caption widths are the rasterizers' width fractions
/// (`lib/comment-highlight.ts`, `lib/caption-overlay.ts`); their heights bound
/// a content-driven bitmap. The Buddy is a square in pixels. The poll card
/// (plan 188 D12) is rasterized to the rect's width; its height bounds a card
/// of up to seven rows (`lib/poll-card.ts`).
pub fn overlay_default_size(item: OverlayItem, orientation: OverlayOrientation) -> (f64, f64) {
    match (item, orientation) {
        (OverlayItem::Highlight, OverlayOrientation::Horizontal) => (0.60, 0.26),
        (OverlayItem::Highlight, OverlayOrientation::Vertical) => (0.78, 0.20),
        (OverlayItem::Captions, OverlayOrientation::Horizontal) => (0.92, 0.16),
        (OverlayItem::Captions, OverlayOrientation::Vertical) => (0.76, 0.14),
        (OverlayItem::Buddy, OverlayOrientation::Horizontal) => (0.18, 0.18 * 16.0 / 9.0),
        (OverlayItem::Buddy, OverlayOrientation::Vertical) => (0.32, 0.32 * 9.0 / 16.0),
        (OverlayItem::Poll, OverlayOrientation::Horizontal) => (0.30, 0.40),
        (OverlayItem::Poll, OverlayOrientation::Vertical) => (0.78, 0.30),
    }
}

/// The rect a snap preset produces for an item on an orientation: the
/// item's default size against the orientation's margins (landscape 4% edges;
/// portrait the platform safe area and a 4%-of-height side margin).
pub fn overlay_snap_rect(
    item: OverlayItem,
    orientation: OverlayOrientation,
    snap: OverlaySnap,
) -> OverlayRect {
    let (w, h) = overlay_default_size(item, orientation);
    let (side, top, bottom) = match orientation {
        OverlayOrientation::Horizontal => (
            LANDSCAPE_SIDE_MARGIN,
            LANDSCAPE_EDGE_MARGIN,
            LANDSCAPE_EDGE_MARGIN,
        ),
        OverlayOrientation::Vertical => (
            PORTRAIT_SIDE_MARGIN,
            PORTRAIT_TOP_MARGIN,
            PORTRAIT_BOTTOM_MARGIN,
        ),
    };
    let x = match snap {
        OverlaySnap::TopLeft | OverlaySnap::BottomLeft => side,
        OverlaySnap::TopRight | OverlaySnap::BottomRight => 1.0 - side - w,
        OverlaySnap::BottomCenter | OverlaySnap::TopCenter => (1.0 - w) / 2.0,
    };
    let y = match snap {
        OverlaySnap::TopLeft | OverlaySnap::TopRight | OverlaySnap::TopCenter => top,
        OverlaySnap::BottomLeft | OverlaySnap::BottomRight | OverlaySnap::BottomCenter => {
            1.0 - bottom - h
        }
    };
    OverlayRect::new(round6(x.max(0.0)), round6(y.max(0.0)), round6(w), round6(h))
}

pub(crate) fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn snapped_item(
    item: OverlayItem,
    snap: OverlaySnap,
    show_on_stream: bool,
    show_in_recording: bool,
) -> OverlayItemLayout {
    OverlayItemLayout {
        horizontal: overlay_snap_rect(item, OverlayOrientation::Horizontal, snap),
        vertical: overlay_snap_rect(item, OverlayOrientation::Vertical, snap),
        show_on_stream,
        show_in_recording,
    }
}

/// The poll card's default place (plan 188 D12): top left on landscape (the
/// one free corner: the highlight sits bottom left, the Buddy bottom right and
/// the camera usually top right), top centre inside the portrait safe area on
/// a vertical canvas, on both outputs. Also the serde default of
/// `OverlayLayout::poll`, so a layout stored before plan 188 loads.
fn default_poll_item() -> OverlayItemLayout {
    OverlayItemLayout {
        horizontal: overlay_snap_rect(
            OverlayItem::Poll,
            OverlayOrientation::Horizontal,
            OverlaySnap::TopLeft,
        ),
        vertical: overlay_snap_rect(
            OverlayItem::Poll,
            OverlayOrientation::Vertical,
            OverlaySnap::TopCenter,
        ),
        show_on_stream: true,
        show_in_recording: true,
    }
}

impl Default for OverlayLayout {
    /// Highlight: the pre-plan-164 default corner (bottom left), on both
    /// outputs. Captions: the bottom bar; their switches mirror the shipped
    /// `burnTarget` default (`off`), so a fresh install burns nothing until
    /// the streamer turns captions on. Buddy: bottom right, on both. Poll:
    /// top left (top centre on portrait), on both (plan 188 D12).
    fn default() -> Self {
        Self {
            highlight: snapped_item(
                OverlayItem::Highlight,
                OverlaySnap::from(CommentHighlightAnchor::default()),
                true,
                true,
            ),
            captions: snapped_item(
                OverlayItem::Captions,
                OverlaySnap::BottomCenter,
                false,
                false,
            ),
            buddy: snapped_item(OverlayItem::Buddy, OverlaySnap::BottomRight, false, false),
            poll: default_poll_item(),
        }
    }
}

impl OverlayLayout {
    pub fn item(&self, item: OverlayItem) -> &OverlayItemLayout {
        match item {
            OverlayItem::Highlight => &self.highlight,
            OverlayItem::Captions => &self.captions,
            OverlayItem::Buddy => &self.buddy,
            OverlayItem::Poll => &self.poll,
        }
    }

    pub fn validate(&self) -> Result<()> {
        for item in OverlayItem::ALL {
            let layout = self.item(item);
            layout
                .horizontal
                .validate(item, OverlayOrientation::Horizontal)?;
            layout
                .vertical
                .validate(item, OverlayOrientation::Vertical)?;
        }
        Ok(())
    }
}

// --- Blit layout -------------------------------------------------------------

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

/// Where an overlay bitmap lands on a canvas: the single layout oracle shared
/// by the CPU blit, the Metal source placement and the Windows D3D11 layer
/// transform. Returns `(source_left, dest_left, dest_top, draw_width)`.
///
/// The bitmap keeps its pixel size: wider than the rect (or the canvas) it is
/// centre-cropped to fit, narrower it hugs the rect edge its gravity picks
/// (`horizontal_gravity`, `bottom_gravity`). `safe_inset` pushes a yielding
/// overlay further inside its rect (the caption bar stepping above a card).
pub fn overlay_blit_layout(
    overlay_width: usize,
    overlay_height: usize,
    canvas_width: usize,
    canvas_height: usize,
    rect: OverlayRect,
    safe_inset: usize,
) -> (usize, usize, usize, usize) {
    let canvas_width = canvas_width.max(1);
    let canvas_height = canvas_height.max(1);
    let (left, top, right, bottom) = rect.pixels(canvas_width, canvas_height);
    let rect_width = (right - left).max(1);
    let draw_width = overlay_width.min(rect_width).min(canvas_width).max(1);
    let draw_height = overlay_height.min(canvas_height).max(1);
    let source_left = overlay_width.saturating_sub(draw_width) / 2;
    let max_dest_left = canvas_width - draw_width;
    let dest_left = match rect.horizontal_gravity() {
        OverlayHorizontalGravity::Left => left,
        OverlayHorizontalGravity::Center => left + (rect_width.saturating_sub(draw_width)) / 2,
        OverlayHorizontalGravity::Right => right.saturating_sub(draw_width),
    }
    .min(max_dest_left);
    let max_dest_top = canvas_height - draw_height;
    let dest_top = if rect.bottom_gravity() {
        bottom
            .saturating_sub(draw_height)
            .saturating_sub(safe_inset)
            .min(max_dest_top)
    } else {
        top.saturating_add(safe_inset).min(max_dest_top)
    };
    (source_left, dest_left, dest_top, draw_width)
}

// --- Leg plan (plan 164, D12) ------------------------------------------------

/// What a session's auxiliary compositor leg carries, as far as overlays are
/// concerned. One leg plan serves captions, the highlight card, the Buddy and
/// the poll card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAuxLeg {
    /// One leg: the primary carries every output.
    None,
    /// A split horizontal stream leg beside a clean recording.
    Stream,
    /// The dual-orientation vertical leg. Horizontal viewers ride the primary
    /// leg with the recording, so the primary burns for the stream too.
    VerticalSimulcast,
}

/// Per-leg plan for one overlay item. `needs_split` says the two switches
/// disagree on a shared record+stream leg: honouring both needs a separate
/// stream leg (captions force it; highlight and Buddy fall back to both).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OverlayLegPlan {
    pub primary: bool,
    pub aux: bool,
    pub needs_split: bool,
}

impl OverlayLegPlan {
    pub const NONE: Self = Self {
        primary: false,
        aux: false,
        needs_split: false,
    };

    /// The D13 fallback for a session that cannot split: whatever either
    /// switch wanted lands on the one shared leg.
    pub fn shared_leg_fallback(self) -> Self {
        Self {
            primary: self.primary || self.aux,
            aux: false,
            needs_split: false,
        }
    }

    pub fn burns_anywhere(self) -> bool {
        self.primary || self.aux
    }
}

/// The one leg plan for every overlay item (D12). Pure; the exhaustive table
/// is the unit test below.
///
/// | session            | aux leg           | primary                    | aux           | needs_split |
/// |--------------------|-------------------|----------------------------|---------------|-------------|
/// | idle               | any               | false                      | false         | false       |
/// | record only        | any               | in_recording               | false         | false       |
/// | stream only        | None / Stream     | on_stream                  | false         | false       |
/// | stream only        | VerticalSimulcast | on_stream                  | on_stream     | false       |
/// | record + stream    | None, agree       | on_stream (== in_recording)| false         | false       |
/// | record + stream    | None, disagree    | in_recording               | on_stream     | true        |
/// | record + stream    | Stream            | in_recording               | on_stream     | false       |
/// | record + stream    | VerticalSimulcast | in_recording OR on_stream  | on_stream     | false       |
pub fn overlay_leg_plan(
    record_enabled: bool,
    stream_enabled: bool,
    aux_leg: OverlayAuxLeg,
    show_on_stream: bool,
    show_in_recording: bool,
) -> OverlayLegPlan {
    match (record_enabled, stream_enabled) {
        (false, false) => OverlayLegPlan::NONE,
        (true, false) => OverlayLegPlan {
            primary: show_in_recording,
            aux: false,
            needs_split: false,
        },
        (false, true) => OverlayLegPlan {
            primary: show_on_stream,
            aux: aux_leg == OverlayAuxLeg::VerticalSimulcast && show_on_stream,
            needs_split: false,
        },
        (true, true) => match aux_leg {
            OverlayAuxLeg::None if show_on_stream == show_in_recording => OverlayLegPlan {
                primary: show_on_stream,
                aux: false,
                needs_split: false,
            },
            OverlayAuxLeg::None => OverlayLegPlan {
                primary: show_in_recording,
                aux: show_on_stream,
                needs_split: true,
            },
            OverlayAuxLeg::Stream => OverlayLegPlan {
                primary: show_in_recording,
                aux: show_on_stream,
                needs_split: false,
            },
            OverlayAuxLeg::VerticalSimulcast => OverlayLegPlan {
                primary: show_in_recording || show_on_stream,
                aux: show_on_stream,
                needs_split: false,
            },
        },
    }
}

/// The session shape the leg plan and the start notices are computed for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlaySessionShape {
    pub record_enabled: bool,
    pub stream_enabled: bool,
    /// The auxiliary leg the session actually runs (decided by the encoder
    /// topology, never by an overlay).
    pub aux_leg: OverlayAuxLeg,
}

/// Per-item plans for the session, with the D13 fallbacks already applied:
/// an item whose switches disagree on a shared leg burns on that leg
/// (`highlight`, `buddy`, `poll`). Captions keep their own path
/// (`captions::caption_overlay_leg_plan_with_vertical_leg`), so the plan here
/// is what the compositor flags are built from for the other three items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlaySessionPlans {
    pub highlight: OverlayLegPlan,
    pub buddy: OverlayLegPlan,
    /// The poll card (plan 188 S3): the same plan shape as the Buddy's.
    pub poll: OverlayLegPlan,
}

impl OverlaySessionPlans {
    #[cfg(test)]
    pub fn plan(&self, item: OverlayItem) -> Option<OverlayLegPlan> {
        match item {
            OverlayItem::Highlight => Some(self.highlight),
            OverlayItem::Buddy => Some(self.buddy),
            OverlayItem::Poll => Some(self.poll),
            OverlayItem::Captions => None,
        }
    }
}

fn resolved_item_plan(shape: OverlaySessionShape, item: &OverlayItemLayout) -> OverlayLegPlan {
    let plan = overlay_leg_plan(
        shape.record_enabled,
        shape.stream_enabled,
        shape.aux_leg,
        item.show_on_stream,
        item.show_in_recording,
    );
    if plan.needs_split {
        plan.shared_leg_fallback()
    } else {
        plan
    }
}

pub fn overlay_session_plans(
    shape: OverlaySessionShape,
    layout: &OverlayLayout,
) -> OverlaySessionPlans {
    OverlaySessionPlans {
        highlight: resolved_item_plan(shape, &layout.highlight),
        buddy: resolved_item_plan(shape, &layout.buddy),
        poll: resolved_item_plan(shape, &layout.poll),
    }
}

/// True when any item would need a separate stream leg to honour both of its
/// switches (`force_same_profile_split` is raised for every item, not only
/// captions; S-B2.2).
pub fn overlay_layout_needs_split(shape: OverlaySessionShape, layout: &OverlayLayout) -> bool {
    OverlayItem::ALL.iter().any(|item| {
        let layout = layout.item(*item);
        overlay_leg_plan(
            shape.record_enabled,
            shape.stream_enabled,
            shape.aux_leg,
            layout.show_on_stream,
            layout.show_in_recording,
        )
        .needs_split
    })
}

/// What a start notice names: one of the four placeable items, or every
/// shown banner as one item (plan 186 D6, mid-sentence label `banners`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayNoticeItem {
    Highlight,
    Captions,
    Buddy,
    /// Plan 188 D14: the poll card, mid-sentence label `polls`.
    Poll,
    Banners,
}

impl From<OverlayItem> for OverlayNoticeItem {
    fn from(item: OverlayItem) -> Self {
        match item {
            OverlayItem::Highlight => OverlayNoticeItem::Highlight,
            OverlayItem::Captions => OverlayNoticeItem::Captions,
            OverlayItem::Buddy => OverlayNoticeItem::Buddy,
            OverlayItem::Poll => OverlayNoticeItem::Poll,
        }
    }
}

impl OverlayNoticeItem {
    /// How the Go Live sheet names the item mid-sentence.
    pub fn label(self) -> &'static str {
        match self {
            OverlayNoticeItem::Highlight => OverlayItem::Highlight.label(),
            OverlayNoticeItem::Captions => OverlayItem::Captions.label(),
            OverlayNoticeItem::Buddy => OverlayItem::Buddy.label(),
            OverlayNoticeItem::Poll => OverlayItem::Poll.label(),
            OverlayNoticeItem::Banners => "banners",
        }
    }
}

/// The two output switches of one item, as the notices see them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlaySwitches {
    pub show_on_stream: bool,
    pub show_in_recording: bool,
}

/// A D13 fallback the Go Live sheet shows verbatim before the session
/// starts: the item and one sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStartNotice {
    pub item: OverlayNoticeItem,
    pub notice: String,
}

/// The one sentence for an item whose switches cannot both be honoured on
/// this session shape; `None` when they can (or when captions keep the plan
/// 090 block instead of a notice).
fn start_notice_sentence(
    shape: OverlaySessionShape,
    item: OverlayNoticeItem,
    switches: OverlaySwitches,
) -> Option<String> {
    if !(shape.record_enabled && shape.stream_enabled)
        || switches.show_on_stream == switches.show_in_recording
    {
        return None;
    }
    let notice = match shape.aux_leg {
        OverlayAuxLeg::Stream => return None,
        OverlayAuxLeg::VerticalSimulcast if switches.show_on_stream => format!(
            "Recording will include {} while streaming vertical.",
            item.label()
        ),
        OverlayAuxLeg::VerticalSimulcast => format!(
            "The horizontal stream will include {} while streaming vertical.",
            item.label()
        ),
        OverlayAuxLeg::None if item == OverlayNoticeItem::Captions => return None,
        OverlayAuxLeg::None => format!(
            "Both the stream and the recording will include {}: this computer shares one encode for them.",
            item.label()
        ),
    };
    Some(notice)
}

/// Every impossible-to-honour switch pair for this session shape (D13),
/// decided before start and never silent. Captions on a shared encode keep
/// the plan 090 block instead of a notice, so they never appear here. The
/// shown banners (plan 186 D6) act as one item labelled `banners`, after the
/// four items; each sentence any of them yields appears once.
pub fn overlay_start_notices(
    shape: OverlaySessionShape,
    layout: &OverlayLayout,
    banners: &[OverlaySwitches],
) -> Vec<OverlayStartNotice> {
    let mut notices = Vec::new();
    for item in OverlayItem::ALL {
        let layout = layout.item(item);
        let switches = OverlaySwitches {
            show_on_stream: layout.show_on_stream,
            show_in_recording: layout.show_in_recording,
        };
        if let Some(notice) = start_notice_sentence(shape, item.into(), switches) {
            notices.push(OverlayStartNotice {
                item: item.into(),
                notice,
            });
        }
    }
    for switches in banners {
        let Some(notice) = start_notice_sentence(shape, OverlayNoticeItem::Banners, *switches)
        else {
            continue;
        };
        if notices.iter().any(|existing| {
            existing.item == OverlayNoticeItem::Banners && existing.notice == notice
        }) {
            continue;
        }
        notices.push(OverlayStartNotice {
            item: OverlayNoticeItem::Banners,
            notice,
        });
    }
    notices
}

pub fn load_overlay_layout(database: &Database) -> OverlayLayout {
    match database.load_setting::<OverlayLayout>(OVERLAY_LAYOUT_KEY) {
        Ok(Some(layout)) => match layout.validate() {
            Ok(()) => layout,
            Err(error) => {
                tracing::warn!("Stored overlay layout is invalid; using defaults: {error:#}");
                OverlayLayout::default()
            }
        },
        Ok(None) => OverlayLayout::default(),
        Err(error) => {
            tracing::warn!("Could not read the overlay layout; using defaults: {error:#}");
            OverlayLayout::default()
        }
    }
}

pub fn save_overlay_layout(database: &Database, layout: &OverlayLayout) -> Result<OverlayLayout> {
    layout.validate()?;
    database.save_setting(OVERLAY_LAYOUT_KEY, layout)?;
    Ok(*layout)
}

/// Event every renderer receives when the layout changes (`overlays.layout`).
pub const OVERLAY_LAYOUT_EVENT: &str = "overlays.layout";

/// `overlays.layout.set`: persist the whole layout and tell every window.
pub async fn set_overlay_layout(state: &AppState, layout: OverlayLayout) -> Result<OverlayLayout> {
    let saved = save_overlay_layout(&state.database, &layout)?;
    // Plan 168 S-B1: the pet's box and atlas size follow the Buddy's rect.
    state.buddy_sprite.set_layout(saved.buddy);
    crate::recording::apply_overlay_layout_to_active_session(state, &saved).await;
    state.emit_event(OVERLAY_LAYOUT_EVENT, saved);
    Ok(saved)
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OverlayLayoutMigration {
    #[serde(default)]
    highlight_anchor: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateHighlightAnchorParams {
    #[serde(default)]
    pub anchor: CommentHighlightAnchor,
}

/// Pure core of the one-time `highlightAnchor` migration: the comments-window
/// corner becomes the highlight rect on both orientations, once, and only
/// when nobody has placed the highlight yet. Returns the layout to keep and
/// whether it changed.
pub fn apply_highlight_anchor_migration(
    saved: Option<OverlayLayout>,
    already_migrated: bool,
    anchor: CommentHighlightAnchor,
) -> (OverlayLayout, bool) {
    match saved {
        Some(layout) => (layout, false),
        None if already_migrated => (OverlayLayout::default(), false),
        None => {
            let mut layout = OverlayLayout::default();
            let snap = OverlaySnap::from(anchor);
            layout.highlight.horizontal =
                overlay_snap_rect(OverlayItem::Highlight, OverlayOrientation::Horizontal, snap);
            layout.highlight.vertical =
                overlay_snap_rect(OverlayItem::Highlight, OverlayOrientation::Vertical, snap);
            (layout, true)
        }
    }
}

/// `overlays.layout.migrate_highlight_anchor`: idempotent; main calls it once
/// after the update and deletes its pref key on success.
pub fn migrate_highlight_anchor(
    database: &Database,
    params: MigrateHighlightAnchorParams,
) -> Result<OverlayLayout> {
    let saved = database
        .load_setting::<OverlayLayout>(OVERLAY_LAYOUT_KEY)?
        .filter(|layout| layout.validate().is_ok());
    let migration = database
        .load_setting::<OverlayLayoutMigration>(OVERLAY_LAYOUT_MIGRATION_KEY)?
        .unwrap_or_default();
    let (layout, changed) =
        apply_highlight_anchor_migration(saved, migration.highlight_anchor, params.anchor);
    if changed {
        database.save_setting(OVERLAY_LAYOUT_KEY, &layout)?;
    }
    if !migration.highlight_anchor {
        database.save_setting(
            OVERLAY_LAYOUT_MIGRATION_KEY,
            &OverlayLayoutMigration {
                highlight_anchor: true,
            },
        )?;
    }
    Ok(layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn defaults_match_the_shipped_corners_and_margins() {
        let layout = OverlayLayout::default();
        // Highlight: bottom left, 43 px of 1920 from the side, 4% off the bottom.
        assert_close(layout.highlight.horizontal.x, 43.2 / 1920.0);
        assert_close(
            layout.highlight.horizontal.y + layout.highlight.horizontal.h,
            0.96,
        );
        assert_close(layout.highlight.horizontal.w, 0.60);
        assert!(layout.highlight.show_on_stream && layout.highlight.show_in_recording);
        // Vertical highlight keeps the 22% portrait safe area.
        assert_close(
            layout.highlight.vertical.y + layout.highlight.vertical.h,
            0.78,
        );
        assert_close(layout.highlight.vertical.w, 0.78);
        // Captions: centred bottom bar, off until the streamer turns them on.
        assert_close(layout.captions.horizontal.x, 0.04);
        assert_close(layout.captions.horizontal.w, 0.92);
        assert_close(
            layout.captions.horizontal.y + layout.captions.horizontal.h,
            0.96,
        );
        assert!(!layout.captions.show_on_stream && !layout.captions.show_in_recording);
        assert_close(layout.captions.vertical.x, 0.12);
        // Buddy: bottom right, square in pixels.
        assert_close(
            layout.buddy.horizontal.w * 16.0,
            layout.buddy.horizontal.h * 9.0,
        );
        assert_close(
            layout.buddy.horizontal.x + layout.buddy.horizontal.w,
            1.0 - 43.2 / 1920.0,
        );
        assert_close(
            layout.buddy.vertical.w * 9.0,
            layout.buddy.vertical.h * 16.0,
        );
        // Poll (plan 188 D12): top left on landscape, 43 px of 1920 from the
        // side and 4% off the top; top centre inside the portrait safe area.
        assert_eq!(
            layout.poll.horizontal,
            OverlayRect::new(0.0225, 0.04, 0.30, 0.40)
        );
        assert_eq!(layout.poll.vertical, OverlayRect::new(0.11, 0.08, 0.78, 0.30));
        assert!(layout.poll.show_on_stream && layout.poll.show_in_recording);
        layout.validate().expect("defaults validate");
        for item in OverlayItem::ALL {
            let bottom = item != OverlayItem::Poll;
            assert_eq!(layout.item(item).horizontal.bottom_gravity(), bottom);
            assert_eq!(layout.item(item).vertical.bottom_gravity(), bottom);
        }
    }

    /// Plan 188 D12: the poll's snaps on both orientations, and the defaults
    /// the TS twin (`lib/overlay-layout.ts`) must mirror: horizontal `TopLeft`
    /// at (0.30, 0.40), vertical `TopCenter` at (0.78, 0.30) inside the 8% /
    /// 22% portrait safe area. Both hug the top (top gravity).
    #[test]
    fn poll_snaps_sit_top_left_on_landscape_and_top_centre_on_portrait() {
        assert_eq!(
            overlay_default_size(OverlayItem::Poll, OverlayOrientation::Horizontal),
            (0.30, 0.40)
        );
        assert_eq!(
            overlay_default_size(OverlayItem::Poll, OverlayOrientation::Vertical),
            (0.78, 0.30)
        );
        let top_left = overlay_snap_rect(
            OverlayItem::Poll,
            OverlayOrientation::Horizontal,
            OverlaySnap::TopLeft,
        );
        assert_eq!(top_left, OverlayRect::new(0.0225, 0.04, 0.30, 0.40));
        assert!(!top_left.bottom_gravity());
        assert_eq!(top_left.horizontal_gravity(), OverlayHorizontalGravity::Left);
        // 1920x1080: the card's bitmap lands 43 px in and 43 px down.
        assert_eq!(
            overlay_blit_layout(576, 300, 1920, 1080, top_left, 0),
            (0, 43, 43, 576)
        );
        let top_centre = overlay_snap_rect(
            OverlayItem::Poll,
            OverlayOrientation::Vertical,
            OverlaySnap::TopCenter,
        );
        assert_eq!(top_centre, OverlayRect::new(0.11, 0.08, 0.78, 0.30));
        assert!(!top_centre.bottom_gravity());
        assert_eq!(
            top_centre.horizontal_gravity(),
            OverlayHorizontalGravity::Center
        );
        // Inside the portrait safe area: below the 8% top band, well above
        // the 22% bottom band.
        assert!(top_centre.y >= PORTRAIT_TOP_MARGIN - RECT_EPSILON);
        assert!(top_centre.y + top_centre.h <= 1.0 - PORTRAIT_BOTTOM_MARGIN + RECT_EPSILON);
        // 1080x1920: centred, 154 px down.
        assert_eq!(
            overlay_blit_layout(842, 400, 1080, 1920, top_centre, 0),
            (0, (1080 - 842) / 2, 154, 842)
        );
        let defaults = OverlayLayout::default();
        assert_eq!(defaults.poll.horizontal, top_left);
        assert_eq!(defaults.poll.vertical, top_centre);
        // The other snaps place the poll too, inside the canvas.
        for orientation in [OverlayOrientation::Horizontal, OverlayOrientation::Vertical] {
            for snap in [
                OverlaySnap::TopRight,
                OverlaySnap::BottomLeft,
                OverlaySnap::BottomRight,
                OverlaySnap::BottomCenter,
            ] {
                overlay_snap_rect(OverlayItem::Poll, orientation, snap)
                    .validate(OverlayItem::Poll, orientation)
                    .unwrap();
            }
        }
    }

    /// Plan 188 S3, the quiet trap: a layout stored before the poll existed
    /// (three items, no `poll` key) must load with the streamer's three
    /// placements intact and the poll at its default. `load_overlay_layout`
    /// falls back to the defaults on any parse error, so without the serde
    /// default every placement would silently reset.
    #[test]
    fn an_old_stored_layout_without_poll_keeps_its_placements() {
        const STORED_BEFORE_PLAN_188: &str = r#"{
            "highlight": {
                "horizontal": { "x": 0.05, "y": 0.05, "w": 0.4, "h": 0.2 },
                "vertical": { "x": 0.1, "y": 0.1, "w": 0.8, "h": 0.15 },
                "showOnStream": true,
                "showInRecording": false
            },
            "captions": {
                "horizontal": { "x": 0.04, "y": 0.02, "w": 0.92, "h": 0.16 },
                "vertical": { "x": 0.12, "y": 0.64, "w": 0.76, "h": 0.14 },
                "showOnStream": true,
                "showInRecording": true
            },
            "buddy": {
                "horizontal": { "x": 0.1, "y": 0.2, "w": 0.25, "h": 0.2 },
                "vertical": { "x": 0.6, "y": 0.6, "w": 0.32, "h": 0.18 },
                "showOnStream": false,
                "showInRecording": true
            }
        }"#;
        let parsed: OverlayLayout = serde_json::from_str(STORED_BEFORE_PLAN_188).unwrap();
        assert_eq!(
            parsed.highlight.horizontal,
            OverlayRect::new(0.05, 0.05, 0.4, 0.2)
        );
        assert!(parsed.highlight.show_on_stream && !parsed.highlight.show_in_recording);
        assert_eq!(
            parsed.captions.horizontal,
            OverlayRect::new(0.04, 0.02, 0.92, 0.16)
        );
        assert!(parsed.captions.show_on_stream && parsed.captions.show_in_recording);
        assert_eq!(parsed.buddy.horizontal, OverlayRect::new(0.1, 0.2, 0.25, 0.2));
        assert!(!parsed.buddy.show_on_stream && parsed.buddy.show_in_recording);
        assert_eq!(parsed.poll, default_poll_item());
        parsed.validate().unwrap();

        // Through the store: the row is read back whole, not reset.
        let database = Database::open_in_memory_for_tests();
        let stored: serde_json::Value = serde_json::from_str(STORED_BEFORE_PLAN_188).unwrap();
        database.save_setting(OVERLAY_LAYOUT_KEY, &stored).unwrap();
        let loaded = load_overlay_layout(&database);
        assert_eq!(loaded, parsed);
        assert_ne!(loaded, OverlayLayout::default(), "the placements survived");
        // The next save writes the poll with the rest.
        save_overlay_layout(&database, &loaded).unwrap();
        let raw: serde_json::Value = database.load_setting(OVERLAY_LAYOUT_KEY).unwrap().unwrap();
        assert_eq!(raw["poll"]["showOnStream"], true);
        assert_eq!(raw["poll"]["horizontal"]["x"], 0.0225);
        assert_eq!(load_overlay_layout(&database), loaded);
    }

    #[test]
    fn snap_presets_cover_every_corner() {
        for item in OverlayItem::ALL {
            for orientation in [OverlayOrientation::Horizontal, OverlayOrientation::Vertical] {
                let (w, h) = overlay_default_size(item, orientation);
                let top_left = overlay_snap_rect(item, orientation, OverlaySnap::TopLeft);
                let top_right = overlay_snap_rect(item, orientation, OverlaySnap::TopRight);
                let bottom_left = overlay_snap_rect(item, orientation, OverlaySnap::BottomLeft);
                let bottom_right = overlay_snap_rect(item, orientation, OverlaySnap::BottomRight);
                let bottom_center = overlay_snap_rect(item, orientation, OverlaySnap::BottomCenter);
                for rect in [
                    top_left,
                    top_right,
                    bottom_left,
                    bottom_right,
                    bottom_center,
                ] {
                    rect.validate(item, orientation).unwrap();
                    assert_close(rect.w, w);
                    assert_close(rect.h, h);
                }
                assert_close(top_left.x, bottom_left.x);
                assert_close(top_right.x + w, 1.0 - top_left.x);
                assert_close(top_left.y, top_right.y);
                assert_close(bottom_left.y, bottom_right.y);
                assert_close(bottom_center.x + w / 2.0, 0.5);
                assert!(!top_left.bottom_gravity());
                assert!(bottom_right.bottom_gravity());
            }
        }
    }

    #[test]
    fn validation_rejects_rects_outside_the_canvas_or_too_small() {
        let mut layout = OverlayLayout::default();
        layout.buddy.horizontal = OverlayRect::new(0.9, 0.9, 0.2, 0.2);
        assert!(
            layout
                .validate()
                .unwrap_err()
                .to_string()
                .contains("inside the canvas")
        );
        layout.buddy.horizontal = OverlayRect::new(0.1, 0.1, 0.01, 0.2);
        assert!(
            layout
                .validate()
                .unwrap_err()
                .to_string()
                .contains("at least")
        );
        layout.buddy.horizontal = OverlayRect::new(-0.1, 0.1, 0.2, 0.2);
        assert!(layout.validate().is_err());
        layout.buddy.horizontal = OverlayRect::new(f64::NAN, 0.1, 0.2, 0.2);
        assert!(
            layout
                .validate()
                .unwrap_err()
                .to_string()
                .contains("finite")
        );
        layout.buddy.horizontal = OverlayRect::new(0.0, 0.0, 1.0, 1.0);
        layout.validate().expect("the full canvas is a valid rect");
    }

    fn shape(record: bool, stream: bool, aux_leg: OverlayAuxLeg) -> OverlaySessionShape {
        OverlaySessionShape {
            record_enabled: record,
            stream_enabled: stream,
            aux_leg,
        }
    }

    #[test]
    fn overlay_leg_plan_table_covers_every_session_shape_and_switch_pair() {
        use OverlayAuxLeg::{None, Stream, VerticalSimulcast};
        let plan = |primary, aux, needs_split| OverlayLegPlan {
            primary,
            aux,
            needs_split,
        };
        let switches = [(false, false), (true, false), (false, true), (true, true)];
        // Idle: nothing burns whatever the switches say.
        for aux_leg in [None, Stream, VerticalSimulcast] {
            for (on_stream, in_rec) in switches {
                assert_eq!(
                    overlay_leg_plan(false, false, aux_leg, on_stream, in_rec),
                    OverlayLegPlan::NONE
                );
            }
        }
        // Record only: the primary is the recording.
        for aux_leg in [None, Stream, VerticalSimulcast] {
            for (on_stream, in_rec) in switches {
                assert_eq!(
                    overlay_leg_plan(true, false, aux_leg, on_stream, in_rec),
                    plan(in_rec, false, false),
                    "record-only {aux_leg:?} on_stream={on_stream} in_rec={in_rec}"
                );
            }
        }
        // Stream only: the primary is the stream; a vertical leg mirrors it.
        for (on_stream, in_rec) in switches {
            assert_eq!(
                overlay_leg_plan(false, true, None, on_stream, in_rec),
                plan(on_stream, false, false)
            );
            assert_eq!(
                overlay_leg_plan(false, true, Stream, on_stream, in_rec),
                plan(on_stream, false, false)
            );
            assert_eq!(
                overlay_leg_plan(false, true, VerticalSimulcast, on_stream, in_rec),
                plan(on_stream, on_stream, false)
            );
        }
        // Record + stream on one shared leg: agree → that value; disagree → split.
        assert_eq!(
            overlay_leg_plan(true, true, None, false, false),
            plan(false, false, false)
        );
        assert_eq!(
            overlay_leg_plan(true, true, None, true, true),
            plan(true, false, false)
        );
        assert_eq!(
            overlay_leg_plan(true, true, None, true, false),
            plan(false, true, true)
        );
        assert_eq!(
            overlay_leg_plan(true, true, None, false, true),
            plan(true, false, true)
        );
        // Record + a split stream leg: each output takes its own switch.
        for (on_stream, in_rec) in switches {
            assert_eq!(
                overlay_leg_plan(true, true, Stream, on_stream, in_rec),
                plan(in_rec, on_stream, false)
            );
        }
        // Record + vertical simulcast: recording and horizontal stream share
        // pixels, so the primary burns when either wants it (D13).
        assert_eq!(
            overlay_leg_plan(true, true, VerticalSimulcast, false, false),
            plan(false, false, false)
        );
        assert_eq!(
            overlay_leg_plan(true, true, VerticalSimulcast, true, false),
            plan(true, true, false)
        );
        assert_eq!(
            overlay_leg_plan(true, true, VerticalSimulcast, false, true),
            plan(true, false, false)
        );
        assert_eq!(
            overlay_leg_plan(true, true, VerticalSimulcast, true, true),
            plan(true, true, false)
        );
        // The shared-leg fallback keeps whatever either switch wanted.
        assert_eq!(
            plan(false, true, true).shared_leg_fallback(),
            plan(true, false, false)
        );
        assert_eq!(
            plan(false, false, false).shared_leg_fallback(),
            OverlayLegPlan::NONE
        );
    }

    #[test]
    fn session_plans_apply_the_shared_leg_fallback_and_flag_split_needs() {
        let mut layout = OverlayLayout::default();
        layout.highlight.show_in_recording = false;
        // The Buddy is opt-in: both switches ship off.
        assert!(!layout.buddy.show_on_stream && !layout.buddy.show_in_recording);
        layout.buddy.show_on_stream = true;
        layout.buddy.show_in_recording = true;
        let shared = shape(true, true, OverlayAuxLeg::None);
        let plans = overlay_session_plans(shared, &layout);
        assert_eq!(
            plans.highlight,
            OverlayLegPlan {
                primary: true,
                aux: false,
                needs_split: false
            },
            "a highlight that wants the stream only burns the shared leg"
        );
        assert_eq!(plans.buddy.primary, true);
        assert!(overlay_layout_needs_split(shared, &layout));
        assert_eq!(plans.plan(OverlayItem::Captions), None);
        // The poll ships on/on (plan 188 D12), so it routes like the Buddy:
        // the shared leg burns it, no split needed for it.
        assert!(layout.poll.show_on_stream && layout.poll.show_in_recording);
        assert_eq!(
            plans.poll,
            OverlayLegPlan {
                primary: true,
                aux: false,
                needs_split: false
            }
        );
        assert_eq!(plans.plan(OverlayItem::Poll), Some(plans.poll));

        let split = shape(true, true, OverlayAuxLeg::Stream);
        let plans = overlay_session_plans(split, &layout);
        assert_eq!(
            (plans.highlight.primary, plans.highlight.aux),
            (false, true)
        );
        assert_eq!((plans.poll.primary, plans.poll.aux), (true, true));
        assert!(!overlay_layout_needs_split(split, &layout));

        layout.highlight.show_in_recording = true;
        assert!(!overlay_layout_needs_split(shared, &layout));
        // Captions count too: stream-only captions on a shared leg need a split.
        layout.captions.show_on_stream = true;
        assert!(overlay_layout_needs_split(shared, &layout));
        layout.captions.show_on_stream = false;
        // And the poll: a stream-only poll on a shared leg asks for the split
        // and falls back to the shared leg, exactly like the Buddy.
        layout.poll.show_in_recording = false;
        assert!(overlay_layout_needs_split(shared, &layout));
        let plans = overlay_session_plans(shared, &layout);
        assert_eq!(
            plans.poll,
            OverlayLegPlan {
                primary: true,
                aux: false,
                needs_split: false
            }
        );
        assert_eq!(
            plans.poll,
            overlay_session_plans(shared, &layout).buddy,
            "the poll and the Buddy resolve the same switch pair the same way"
        );
        let vertical = overlay_session_plans(
            shape(true, true, OverlayAuxLeg::VerticalSimulcast),
            &layout,
        );
        assert_eq!((vertical.poll.primary, vertical.poll.aux), (true, true));
        assert_eq!(
            overlay_session_plans(shape(true, false, OverlayAuxLeg::None), &layout).poll,
            OverlayLegPlan::NONE,
            "record-only: a stream-only poll burns nowhere"
        );
    }

    #[test]
    fn start_notices_name_every_impossible_switch_pair_and_nothing_else() {
        let mut layout = OverlayLayout::default();
        assert!(
            overlay_start_notices(shape(true, true, OverlayAuxLeg::None), &layout, &[]).is_empty()
        );
        layout.highlight.show_in_recording = false;
        layout.buddy.show_in_recording = true;
        layout.captions.show_on_stream = true;
        // Plan 188 D14: a stream-only poll, labelled `polls`, after the Buddy.
        layout.poll.show_in_recording = false;
        // A split leg honours everything.
        assert!(
            overlay_start_notices(shape(true, true, OverlayAuxLeg::Stream), &layout, &[])
                .is_empty()
        );
        // Stream-only or record-only sessions never need a notice.
        assert!(
            overlay_start_notices(shape(false, true, OverlayAuxLeg::None), &layout, &[]).is_empty()
        );
        assert!(
            overlay_start_notices(shape(true, false, OverlayAuxLeg::None), &layout, &[]).is_empty()
        );
        // Shared encode: highlight, Buddy and poll burn on both; captions keep the block.
        let shared = overlay_start_notices(shape(true, true, OverlayAuxLeg::None), &layout, &[]);
        assert_eq!(
            shared,
            vec![
                OverlayStartNotice {
                    item: OverlayNoticeItem::Highlight,
                    notice: "Both the stream and the recording will include highlights: this computer shares one encode for them.".to_string(),
                },
                OverlayStartNotice {
                    item: OverlayNoticeItem::Buddy,
                    notice: "Both the stream and the recording will include the Buddy: this computer shares one encode for them.".to_string(),
                },
                OverlayStartNotice {
                    item: OverlayNoticeItem::Poll,
                    notice: "Both the stream and the recording will include polls: this computer shares one encode for them.".to_string(),
                },
            ]
        );
        assert_eq!(serde_json::to_value(&shared[2]).unwrap()["item"], "poll");
        // Vertical simulcast: the recording shares the horizontal pixels.
        let vertical = overlay_start_notices(
            shape(true, true, OverlayAuxLeg::VerticalSimulcast),
            &layout,
            &[],
        );
        assert_eq!(
            vertical
                .iter()
                .map(|notice| notice.notice.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Recording will include highlights while streaming vertical.",
                "Recording will include captions while streaming vertical.",
                "The horizontal stream will include the Buddy while streaming vertical.",
                "Recording will include polls while streaming vertical.",
            ]
        );
        assert_eq!(
            serde_json::to_value(&vertical[0]).unwrap()["item"],
            "highlight"
        );
        // The poll's sentence sits exactly where the highlight's would for
        // the same switch pair: a recording-only poll says what a
        // recording-only highlight says, with its own label.
        let mut mirrored = OverlayLayout::default();
        mirrored.highlight.show_on_stream = false;
        mirrored.poll.show_on_stream = false;
        let notices = overlay_start_notices(
            shape(true, true, OverlayAuxLeg::VerticalSimulcast),
            &mirrored,
            &[],
        );
        assert_eq!(
            notices
                .iter()
                .map(|notice| (notice.item, notice.notice.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (
                    OverlayNoticeItem::Highlight,
                    "The horizontal stream will include highlights while streaming vertical."
                ),
                (
                    OverlayNoticeItem::Poll,
                    "The horizontal stream will include polls while streaming vertical."
                ),
            ]
        );
    }

    /// Plan 186 D6: every shown banner is one item, `banners`; each sentence
    /// any of them yields appears once, after the three items, byte for byte
    /// the strings the renderer's `lib/overlay-layout.ts` builds.
    #[test]
    fn start_notices_name_all_shown_banners_once() {
        let switches = |show_on_stream, show_in_recording| OverlaySwitches {
            show_on_stream,
            show_in_recording,
        };
        let layout = OverlayLayout::default();
        let stream_only = switches(true, false);
        let recording_only = switches(false, true);
        let both = switches(true, true);
        let shared = shape(true, true, OverlayAuxLeg::None);
        // Honoured switches say nothing.
        assert!(overlay_start_notices(shared, &layout, &[both, both]).is_empty());
        // One shared encode: two stream-only banners, one sentence.
        assert_eq!(
            overlay_start_notices(shared, &layout, &[stream_only, both, stream_only]),
            vec![OverlayStartNotice {
                item: OverlayNoticeItem::Banners,
                notice: "Both the stream and the recording will include banners: this computer shares one encode for them.".to_string(),
            }]
        );
        // Recording-only on a shared encode is the same sentence.
        assert_eq!(
            overlay_start_notices(shared, &layout, &[recording_only])[0].notice,
            "Both the stream and the recording will include banners: this computer shares one encode for them."
        );
        // Vertical simulcast: each direction has its own sentence, once each.
        let vertical = shape(true, true, OverlayAuxLeg::VerticalSimulcast);
        assert_eq!(
            overlay_start_notices(
                vertical,
                &layout,
                &[stream_only, recording_only, stream_only]
            )
            .iter()
            .map(|notice| notice.notice.as_str())
            .collect::<Vec<_>>(),
            vec![
                "Recording will include banners while streaming vertical.",
                "The horizontal stream will include banners while streaming vertical.",
            ]
        );
        // A split leg, a stream-only or a record-only session: no sentence.
        for shape in [
            shape(true, true, OverlayAuxLeg::Stream),
            shape(false, true, OverlayAuxLeg::None),
            shape(true, false, OverlayAuxLeg::VerticalSimulcast),
        ] {
            assert!(
                overlay_start_notices(shape, &layout, &[stream_only, recording_only]).is_empty(),
                "{shape:?}"
            );
        }
        // Banners come after the items, and serialize as `banners`.
        let mut layout = OverlayLayout::default();
        layout.highlight.show_in_recording = false;
        let notices = overlay_start_notices(shared, &layout, &[stream_only]);
        assert_eq!(notices.len(), 2);
        assert_eq!(notices[0].item, OverlayNoticeItem::Highlight);
        assert_eq!(
            serde_json::to_value(&notices[1]).unwrap()["item"],
            "banners"
        );
    }

    #[test]
    fn blit_layout_reproduces_the_legacy_corner_and_bar_positions() {
        // 1920x1080, the shipped bottom-left card: 43 px margins on both axes.
        let bottom_left = overlay_snap_rect(
            OverlayItem::Highlight,
            OverlayOrientation::Horizontal,
            OverlaySnap::BottomLeft,
        );
        assert_eq!(
            overlay_blit_layout(600, 200, 1920, 1080, bottom_left, 0),
            (0, 43, 1080 - 200 - 43, 600)
        );
        let bottom_right = overlay_snap_rect(
            OverlayItem::Highlight,
            OverlayOrientation::Horizontal,
            OverlaySnap::BottomRight,
        );
        assert_eq!(
            overlay_blit_layout(600, 200, 1920, 1080, bottom_right, 0),
            (0, 1920 - 600 - 43, 1080 - 200 - 43, 600)
        );
        let top_left = overlay_snap_rect(
            OverlayItem::Highlight,
            OverlayOrientation::Horizontal,
            OverlaySnap::TopLeft,
        );
        assert_eq!(
            overlay_blit_layout(600, 200, 1920, 1080, top_left, 0),
            (0, 43, 43, 600)
        );
        // Portrait 1080x1920: 77 px side margin, the platform safe area vertically.
        let vertical_top_right = overlay_snap_rect(
            OverlayItem::Highlight,
            OverlayOrientation::Vertical,
            OverlaySnap::TopRight,
        );
        assert_eq!(
            overlay_blit_layout(600, 200, 1080, 1920, vertical_top_right, 0),
            (0, 1080 - 600 - 77, 154, 600)
        );
        let vertical_bottom = overlay_snap_rect(
            OverlayItem::Captions,
            OverlayOrientation::Vertical,
            OverlaySnap::BottomCenter,
        );
        assert_eq!(
            overlay_blit_layout(820, 160, 1080, 1920, vertical_bottom, 0),
            (0, (1080 - 820) / 2, 1920 - 422 - 160, 820)
        );
        // A centred caption bar: centred inside its rect, the inset stacks on
        // the margin, and the bar never leaves the canvas.
        let bar = overlay_snap_rect(
            OverlayItem::Captions,
            OverlayOrientation::Horizontal,
            OverlaySnap::BottomCenter,
        );
        assert_eq!(
            overlay_blit_layout(1000, 100, 1920, 1080, bar, 0),
            (0, 460, 1080 - 43 - 100, 1000)
        );
        assert_eq!(
            overlay_blit_layout(1000, 100, 1920, 1080, bar, 222),
            (0, 460, 1080 - 43 - 222 - 100, 1000)
        );
        let top_bar = overlay_snap_rect(
            OverlayItem::Captions,
            OverlayOrientation::Horizontal,
            OverlaySnap::TopCenter,
        );
        assert_eq!(
            overlay_blit_layout(1000, 100, 1920, 1080, top_bar, 222),
            (0, 460, 43 + 222, 1000)
        );
        assert_eq!(
            overlay_blit_layout(1000, 100, 1920, 1080, top_bar, 5000),
            (0, 460, 980, 1000)
        );
        // Wider than the rect: centre-cropped to the rect; wider than the
        // canvas: cropped to the canvas.
        assert_eq!(
            overlay_blit_layout(2400, 100, 1920, 1080, bar, 0),
            (317, 77, 937, 1766)
        );
        let full = OverlayRect::new(0.0, 0.0, 1.0, 1.0);
        assert_eq!(
            overlay_blit_layout(2400, 100, 1920, 1080, full, 0),
            (240, 0, 980, 1920)
        );
        // Degenerate canvases never panic and always draw one pixel.
        assert_eq!(overlay_blit_layout(7, 3, 1, 1, bar, 0), (3, 0, 0, 1));
        assert_eq!(overlay_blit_layout(1, 1, 0, 0, full, 0), (0, 0, 0, 1));
    }

    #[test]
    fn blit_layout_follows_a_free_rect_and_its_gravity() {
        // The parity fixture rect (S-B3.5): (0.1, 0.2, 0.25, 0.2) on 1280x720
        // is a top-left box 128..448 x 144..288; a 200x100 bitmap sits at its
        // top-left corner.
        let rect = OverlayRect::new(0.1, 0.2, 0.25, 0.2);
        assert_eq!(rect.pixels(1280, 720), (128, 144, 448, 288));
        assert_eq!(rect.horizontal_gravity(), OverlayHorizontalGravity::Left);
        assert!(!rect.bottom_gravity());
        assert_eq!(
            overlay_blit_layout(200, 100, 1280, 720, rect, 0),
            (0, 128, 144, 200)
        );
        // The same bitmap in a bottom-right box hugs that corner.
        let corner = OverlayRect::new(0.7, 0.7, 0.25, 0.25);
        assert_eq!(
            overlay_blit_layout(200, 100, 1280, 720, corner, 0),
            (0, 1216 - 200, 684 - 100, 200)
        );
        // A rect straddling the middle centres its content.
        let middle = OverlayRect::new(0.3, 0.4, 0.4, 0.2);
        assert_eq!(
            middle.horizontal_gravity(),
            OverlayHorizontalGravity::Center
        );
        assert_eq!(
            overlay_blit_layout(200, 100, 1280, 720, middle, 0),
            (0, 384 + 156, 432 - 100, 200)
        );
    }

    #[test]
    fn shared_fixture_pins_the_default_layout_across_languages() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("shared high-risk protocol fixture must be valid JSON");
        let expected = fixture
            .pointer("/overlayLayout/defaults")
            .expect("shared protocol fixture is missing /overlayLayout/defaults");
        assert_eq!(
            serde_json::to_value(OverlayLayout::default()).unwrap(),
            *expected,
            "OverlayLayout::default() drifted from protocol-fixtures/high-risk-contracts.json"
        );
        let placed = fixture
            .pointer("/overlayLayout/placed")
            .expect("shared protocol fixture is missing /overlayLayout/placed");
        let layout: OverlayLayout = serde_json::from_value(placed.clone()).unwrap();
        layout.validate().unwrap();
        assert_eq!(serde_json::to_value(layout).unwrap(), *placed);
    }

    #[test]
    fn wire_shape_is_camel_case_with_no_extra_fields() {
        let value = serde_json::to_value(OverlayLayout::default()).unwrap();
        let highlight = &value["highlight"];
        assert!(highlight["showOnStream"].is_boolean());
        assert!(highlight["showInRecording"].is_boolean());
        assert!(highlight["horizontal"]["x"].is_number());
        assert_eq!(highlight.as_object().unwrap().len(), 4);
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["poll"].as_object().unwrap().len(), 4);
        let round_trip: OverlayLayout = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, OverlayLayout::default());
        // A fully placed layout, poll included, round-trips byte for byte.
        let mut placed = OverlayLayout::default();
        placed.poll.horizontal = OverlayRect::new(0.6, 0.1, 0.3, 0.4);
        placed.poll.vertical = OverlayRect::new(0.11, 0.5, 0.78, 0.3);
        placed.poll.show_in_recording = false;
        placed.validate().unwrap();
        let wire = serde_json::to_value(placed).unwrap();
        assert_eq!(wire["poll"]["horizontal"]["x"], 0.6);
        assert_eq!(wire["poll"]["showInRecording"], false);
        let round_trip: OverlayLayout = serde_json::from_value(wire).unwrap();
        assert_eq!(round_trip, placed);
        // Validation covers the poll like any item.
        let mut invalid = placed;
        invalid.poll.vertical = OverlayRect::new(0.5, 0.5, 0.78, 0.3);
        assert!(
            invalid
                .validate()
                .unwrap_err()
                .to_string()
                .starts_with("polls vertical rect")
        );
    }

    #[test]
    fn save_and_load_round_trip_and_reject_invalid_saves() {
        let database = Database::open_in_memory_for_tests();
        assert_eq!(load_overlay_layout(&database), OverlayLayout::default());
        let mut layout = OverlayLayout::default();
        layout.buddy.horizontal = OverlayRect::new(0.1, 0.2, 0.25, 0.3);
        layout.buddy.show_in_recording = false;
        save_overlay_layout(&database, &layout).unwrap();
        assert_eq!(load_overlay_layout(&database), layout);
        let mut invalid = layout;
        invalid.captions.vertical.w = 2.0;
        assert!(save_overlay_layout(&database, &invalid).is_err());
        assert_eq!(
            load_overlay_layout(&database),
            layout,
            "a rejected save changes nothing"
        );
    }

    #[test]
    fn highlight_anchor_migration_runs_once_and_never_overwrites_a_placed_layout() {
        let database = Database::open_in_memory_for_tests();
        let migrated = migrate_highlight_anchor(
            &database,
            MigrateHighlightAnchorParams {
                anchor: CommentHighlightAnchor::TopRight,
            },
        )
        .unwrap();
        let expected = overlay_snap_rect(
            OverlayItem::Highlight,
            OverlayOrientation::Horizontal,
            OverlaySnap::TopRight,
        );
        assert_eq!(migrated.highlight.horizontal, expected);
        assert!(!migrated.highlight.horizontal.bottom_gravity());
        assert_eq!(load_overlay_layout(&database), migrated);

        // A second call with another corner is a no-op: the migration ran.
        let again = migrate_highlight_anchor(
            &database,
            MigrateHighlightAnchorParams {
                anchor: CommentHighlightAnchor::BottomLeft,
            },
        )
        .unwrap();
        assert_eq!(again, migrated);

        // A placed layout is never overwritten by a late migration.
        let fresh = Database::open_in_memory_for_tests();
        let mut placed = OverlayLayout::default();
        placed.highlight.horizontal = OverlayRect::new(0.3, 0.3, 0.2, 0.2);
        save_overlay_layout(&fresh, &placed).unwrap();
        let kept = migrate_highlight_anchor(
            &fresh,
            MigrateHighlightAnchorParams {
                anchor: CommentHighlightAnchor::TopLeft,
            },
        )
        .unwrap();
        assert_eq!(kept, placed);
        assert_eq!(
            apply_highlight_anchor_migration(None, true, CommentHighlightAnchor::TopLeft),
            (OverlayLayout::default(), false)
        );
    }
}
