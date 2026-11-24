//! The chat highlight card, `renderCommentHighlightPng` with
//! `layoutCommentHighlightTokens`: the identity row (the viewer's avatar or
//! monogram, the platform's drawn badge over it, the name, X's verified
//! check after the name, YouTube's or X's own mark closing the row) over up
//! to three lines of words and emotes on the glass plate.

use serde::Deserialize;
use tiny_skia::Pixmap;

use super::canvas::{self, Rgba, Shadow};
use super::card::{self, Line, NAME_COLOR, NAME_WEIGHT, Token};
use super::images::DecodedImages;
use super::marks::{self, Mark};
use super::text::{self, Align, Baseline, Font, TextPlacement};
use super::{OverlayRect, js_round, measure};
use crate::live_chat::{LiveChatAuthorVerified, LiveChatMessageFragment};
use crate::streaming::StreamPlatform;

/// What the highlight card is drawn from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HighlightCardState {
    pub author_name: String,
    /// The card's text (`commentHighlightCardText`: an activity's line and
    /// words already joined).
    pub text: String,
    /// The fragments emotes are drawn from; None for an activity card, which
    /// stays text.
    #[serde(default)]
    pub fragments: Option<Vec<LiveChatMessageFragment>>,
    pub platform: StreamPlatform,
    /// The viewer's picture (`authorAvatarUrl`); None or missing bytes draw
    /// the monogram.
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// X's verified check after the name (plan 167).
    #[serde(default)]
    pub author_verified: Option<LiveChatAuthorVerified>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// The placed highlight rect (plan 164): the card wraps to its width.
    #[serde(default)]
    pub rect: Option<OverlayRect>,
}

impl HighlightCardState {
    pub(crate) fn tokens(&self) -> Vec<Token> {
        card::tokens(&self.text, self.fragments.as_deref())
    }

    /// The platform's own file mark, for YouTube and X.
    fn platform_mark(&self) -> Option<Mark> {
        match self.platform {
            StreamPlatform::Youtube => Some(Mark::Youtube),
            StreamPlatform::X => Some(Mark::X),
            _ => None,
        }
        .filter(|mark| mark.available())
    }

    fn verified_mark(&self) -> Option<Mark> {
        self.author_verified
            .map(Mark::Verified)
            .filter(|mark| mark.available())
    }
}

const MAX_CARD_WIDTH_FRACTION: f64 = 0.6;
const MAX_PORTRAIT_CARD_WIDTH_FRACTION: f64 = 0.78;

/// `HighlightMetrics`.
pub(crate) struct Metrics {
    pub name_font_px: f64,
    pub text_font_px: f64,
    pub line_height_px: f64,
    pub padding_px: f64,
    pub avatar_px: f64,
    pub identity_gap_px: f64,
    pub row_gap_px: f64,
    pub radius_px: f64,
    pub max_text_width_px: f64,
    pub max_name_width_px: f64,
}

/// `highlightMetrics`: type off the long edge, the card at most 60 % of a
/// landscape canvas (78 % of a portrait one) or the placed rect's width.
pub(crate) fn metrics(
    canvas_width: u32,
    canvas_height: u32,
    max_card_width_px: Option<f64>,
) -> Metrics {
    let portrait = canvas_height > canvas_width;
    let long_edge = f64::from(if portrait {
        canvas_height
    } else {
        canvas_width
    });
    let canvas_width = f64::from(canvas_width);
    let text_font_px = js_round(long_edge / 48.0).max(20.0);
    let padding_px = js_round(text_font_px * 0.8);
    let avatar_px = js_round(text_font_px * 1.5);
    let identity_gap_px = js_round(text_font_px * 0.5);
    let fraction = if portrait {
        MAX_PORTRAIT_CARD_WIDTH_FRACTION
    } else {
        MAX_CARD_WIDTH_FRACTION
    };
    let max_card_px = match max_card_width_px.filter(|width| width.is_finite() && *width > 0.0) {
        Some(width) => width.min(canvas_width).floor(),
        None => (canvas_width * fraction).floor(),
    };
    let max_text_width_px = max_card_px - padding_px * 2.0;
    Metrics {
        name_font_px: js_round(text_font_px * 0.95),
        text_font_px,
        line_height_px: js_round(text_font_px * 1.3),
        padding_px,
        avatar_px,
        identity_gap_px,
        row_gap_px: js_round(text_font_px * 0.45),
        radius_px: js_round(text_font_px * 0.6),
        max_text_width_px,
        max_name_width_px: max_text_width_px - avatar_px - identity_gap_px,
    }
}

/// `highlightPlatformMarkSize`: the name's size, never under 20 px tall;
/// YouTube's at its aspect, X's square.
fn platform_mark_size(metrics: &Metrics, mark: Mark) -> (f64, f64) {
    let height_px = marks::YOUTUBE_MARK_MIN_PX.max(metrics.name_font_px);
    match mark {
        Mark::Youtube => ((height_px * marks::youtube_mark_aspect()).ceil(), height_px),
        _ => (height_px.ceil(), height_px.ceil()),
    }
}

/// `highlightVerifiedMarkSize`: the check's size and its gap after the name.
fn verified_mark_size(metrics: &Metrics) -> (f64, f64) {
    (
        js_round(metrics.name_font_px).max(16.0),
        js_round(metrics.name_font_px * 0.25).max(4.0),
    )
}

struct Layout {
    metrics: Metrics,
    name: String,
    name_width_px: f64,
    lines: Vec<Line>,
    card_width_px: f64,
    card_height_px: f64,
    /// The platform mark's box (width, height), when one is drawn.
    platform_mark: Option<(Mark, f64, f64)>,
    /// The verified check (size, gap), when one is drawn.
    verified_mark: Option<(Mark, f64, f64)>,
}

/// `layoutCommentHighlightTokens`.
fn layout(state: &HighlightCardState, emotes: &DecodedImages) -> Option<Layout> {
    let metrics = metrics(
        state.canvas_width,
        state.canvas_height,
        state
            .rect
            .map(|rect| (rect.w * f64::from(state.canvas_width)).floor()),
    );
    if metrics.max_text_width_px <= 0.0 {
        return None;
    }
    let lines = card::wrap_tokens(
        &state.tokens(),
        metrics.text_font_px,
        metrics.max_text_width_px,
        emotes,
    );
    let platform_mark = state.platform_mark().map(|mark| {
        let (w, h) = platform_mark_size(&metrics, mark);
        (mark, w, h)
    });
    // The mark and its gap (on the row's right end) come out of the name's
    // share of the row.
    let mark_lead_px = platform_mark.map_or(0.0, |(_, w, _)| w + metrics.identity_gap_px);
    let verified_mark = state.verified_mark().map(|mark| {
        let (size, gap) = verified_mark_size(&metrics);
        (mark, size, gap)
    });
    let verified_lead_px = verified_mark.map_or(0.0, |(_, size, gap)| gap + size);
    let max_name_width_px = (metrics.max_name_width_px - mark_lead_px - verified_lead_px).max(0.0);
    let name = card::fit_name(
        &card::identity(&state.author_name, state.platform, platform_mark.is_some()),
        metrics.name_font_px,
        max_name_width_px,
    );
    let name_width_px =
        measure(&name, Font::new(metrics.name_font_px as f32, NAME_WEIGHT)).min(max_name_width_px);
    let identity_row_width = metrics.avatar_px
        + metrics.identity_gap_px
        + mark_lead_px
        + name_width_px
        + verified_lead_px;
    let widest_line = lines.iter().map(|line| line.width_px).fold(0.0, f64::max);
    let content_width = identity_row_width
        .max(widest_line)
        .min(metrics.max_text_width_px);
    let message_height = if lines.is_empty() {
        0.0
    } else {
        metrics.row_gap_px + lines.len() as f64 * metrics.line_height_px
    };
    Some(Layout {
        card_width_px: (metrics.padding_px * 2.0 + content_width).ceil(),
        card_height_px: (metrics.padding_px * 2.0 + metrics.avatar_px + message_height).ceil(),
        metrics,
        name,
        name_width_px,
        lines,
        platform_mark,
        verified_mark,
    })
}

/// The card inside a transparent margin for its shadow.
pub(crate) fn render(
    state: &HighlightCardState,
    avatars: &DecodedImages,
    emotes: &DecodedImages,
) -> Option<Pixmap> {
    let layout = layout(state, emotes)?;
    let metrics = &layout.metrics;
    let pad = js_round(metrics.text_font_px * 0.6);
    let mut target = Pixmap::new(
        (layout.card_width_px + pad * 2.0) as u32,
        (layout.card_height_px + pad * 2.0) as u32,
    )?;
    let text_font_px = metrics.text_font_px as f32;
    card::paint_glass(
        &mut target,
        pad as f32,
        pad as f32,
        layout.card_width_px as f32,
        layout.card_height_px as f32,
        metrics.radius_px as f32,
        Some(Shadow {
            color: Rgba::new(0, 0, 0, 0.4),
            blur: text_font_px * 0.45,
            offset_x: 0.0,
            offset_y: text_font_px * 0.1,
        }),
    );

    let avatar_x = pad + metrics.padding_px;
    let avatar_y = pad + metrics.padding_px;
    let avatar = metrics.avatar_px as f32;
    card::paint_avatar(
        &mut target,
        state.avatar_url.as_deref().and_then(|url| avatars.get(url)),
        &state.author_name,
        avatar_x as f32,
        avatar_y as f32,
        avatar,
    );
    // The drawn badge over the avatar; YouTube and X are never redrawn.
    if let Some(badge) = card::drawn_badge(state.platform) {
        let badge_size = js_round(metrics.avatar_px * 0.42).max(12.0) as f32;
        card::paint_badge(
            &mut target,
            badge,
            avatar_x as f32 + avatar - badge_size * 0.84,
            avatar_y as f32 + avatar - badge_size * 0.84,
            badge_size,
        );
    }

    // YouTube's icon or X's mark, unmodified, closing the identity row on the
    // card's right edge.
    let mut mark_lead_px = 0.0;
    if let Some((mark, width_px, height_px)) = layout.platform_mark {
        let mark_x = pad + layout.card_width_px - metrics.padding_px - width_px;
        let mark_y = js_round(avatar_y + (metrics.avatar_px - height_px) / 2.0);
        marks::draw_mark(
            &mut target,
            mark,
            mark_x as f32,
            mark_y as f32,
            width_px as f32,
            height_px as f32,
        );
        mark_lead_px = width_px + metrics.identity_gap_px;
    }
    let verified_lead_px = layout
        .verified_mark
        .map_or(0.0, |(_, size, gap)| gap + size);

    // The name beside the avatar (centred on it), the message below.
    let name_x = avatar_x + metrics.avatar_px + metrics.identity_gap_px;
    let place = TextPlacement {
        x: name_x as f32,
        y: (avatar_y + metrics.avatar_px / 2.0 + 1.0) as f32,
        align: Align::Left,
        baseline: Baseline::Middle,
        max_width: Some(
            (metrics.max_name_width_px - mark_lead_px - verified_lead_px).max(1.0) as f32,
        ),
    };
    let font = Font::new(metrics.name_font_px as f32, NAME_WEIGHT);
    canvas::with_shadow(
        &mut target,
        Some(card::text_shadow(metrics.text_font_px)),
        |layer, dx, dy| {
            text::fill_text(layer, &layout.name, font, place, NAME_COLOR, dx, dy);
        },
    );
    // X's own check right after the name, centred on the row, no shadow.
    if let Some((mark, size, gap)) = layout.verified_mark {
        marks::draw_mark(
            &mut target,
            mark,
            (name_x + layout.name_width_px + gap) as f32,
            js_round(avatar_y + (metrics.avatar_px - size) / 2.0) as f32,
            size as f32,
            size as f32,
        );
    }
    card::paint_lines(
        &mut target,
        &layout.lines,
        pad + metrics.padding_px,
        avatar_y + metrics.avatar_px + metrics.row_gap_px,
        metrics.text_font_px,
        metrics.line_height_px,
        metrics.max_text_width_px,
        emotes,
    );
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_type_scales_off_the_long_edge() {
        assert_eq!(metrics(1920, 1080, None).text_font_px, 40.0);
        assert_eq!(metrics(1080, 1920, None).text_font_px, 40.0);
        assert_eq!(metrics(1280, 720, None).text_font_px, 27.0);
        // The rect's width caps the card.
        assert_eq!(
            metrics(1280, 720, Some(460.0)).max_text_width_px,
            460.0 - 44.0
        );
    }

    #[test]
    fn marks_keep_their_floor_and_shape() {
        let small = metrics(1280, 720, None);
        // 26 px name type: YouTube at its aspect, X square.
        assert_eq!(platform_mark_size(&small, Mark::Youtube), (38.0, 26.0));
        assert_eq!(platform_mark_size(&small, Mark::X), (26.0, 26.0));
        assert_eq!(verified_mark_size(&small), (26.0, 7.0));
    }
}
