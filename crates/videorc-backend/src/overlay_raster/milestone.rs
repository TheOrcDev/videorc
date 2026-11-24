//! The milestone card (plan 225 B6), `renderMilestoneCardPng` with
//! `layoutMilestoneCard` (`milestone-card.ts`): the highlight card's glass
//! with the person's avatar as the picture, the platform's badge or mark on
//! its corner, and three rows beside it: the name, the milestone ("10th
//! stream") and the persona's mark ("with Buddy"). It never draws a message:
//! it has no text input.

use serde::Deserialize;
use tiny_skia::Pixmap;

use super::canvas::{self, Rgba, Shadow};
use super::card::{self, NAME_COLOR, NAME_WEIGHT, TEXT_WEIGHT};
use super::highlight::{self, Metrics};
use super::images::DecodedImages;
use super::marks::{self, Mark};
use super::text::{self, Align, Baseline, Font, TextPlacement};
use super::{OverlayRect, js_round, measure};
use crate::streaming::StreamPlatform;

/// What the milestone card is drawn from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MilestoneCardState {
    /// The person's name.
    pub name: String,
    /// "10th stream", "5 in a row", "One year". Blank draws nothing.
    pub label: String,
    /// The persona's name for the footer; None or blank draws no footer.
    #[serde(default)]
    pub persona_name: Option<String>,
    /// The person's picture; None or missing bytes draw the monogram.
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub platform: StreamPlatform,
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// The placed highlight rect (plan 164): the card wraps to its width.
    #[serde(default)]
    pub rect: Option<OverlayRect>,
}

/// The milestone line is a little larger than a message line.
const LABEL_SCALE: f64 = 1.2;
/// The avatar is the card's picture, bigger than a comment's identity avatar.
const AVATAR_SCALE: f64 = 1.6;
/// The persona's mark is small and quiet.
const FOOTER_SCALE: f64 = 0.8;
/// The milestone line's weight as painted (it is measured at the name's).
const LABEL_PAINT_WEIGHT: u16 = 700;

/// `MilestoneCardLayout`.
struct Layout {
    metrics: Metrics,
    card_width_px: f64,
    card_height_px: f64,
    avatar_px: f64,
    name: String,
    label: String,
    label_font_px: f64,
    footer: String,
    footer_font_px: f64,
    text_x: f64,
    name_y: f64,
    label_y: f64,
    footer_y: f64,
}

/// `layoutMilestoneCard`.
fn layout(state: &MilestoneCardState) -> Option<Layout> {
    let label = state.label.trim();
    if label.is_empty() {
        return None;
    }
    let metrics = highlight::metrics(
        state.canvas_width,
        state.canvas_height,
        state
            .rect
            .map(|rect| (rect.w * f64::from(state.canvas_width)).floor()),
    );
    let avatar_px = js_round(metrics.avatar_px * AVATAR_SCALE);
    let label_font_px = js_round(metrics.text_font_px * LABEL_SCALE);
    let footer_font_px = js_round(metrics.text_font_px * FOOTER_SCALE);
    let persona = state.persona_name.as_deref().map(str::trim).unwrap_or("");
    let footer = if persona.is_empty() {
        String::new()
    } else {
        format!("with {persona}")
    };
    let text_x = metrics.padding_px + avatar_px + metrics.identity_gap_px;
    let max_text_width_px =
        (metrics.max_text_width_px + metrics.padding_px * 2.0 - text_x - metrics.padding_px)
            .max(1.0);
    let name = card::fit_name(
        card::author(&state.name),
        metrics.name_font_px,
        max_text_width_px,
    );
    let name_width_px = measure(&name, Font::new(metrics.name_font_px as f32, NAME_WEIGHT));
    let label_width_px =
        measure(label, Font::new(label_font_px as f32, NAME_WEIGHT)).min(max_text_width_px);
    let footer_width_px = if footer.is_empty() {
        0.0
    } else {
        measure(&footer, Font::new(footer_font_px as f32, TEXT_WEIGHT)).min(max_text_width_px)
    };
    let text_width_px = name_width_px.max(label_width_px).max(footer_width_px);
    let card_width_px = js_round(text_x + text_width_px + metrics.padding_px);
    let name_line_px = js_round(metrics.name_font_px * 1.25);
    let label_line_px = js_round(label_font_px * 1.25);
    let footer_line_px = if footer.is_empty() {
        0.0
    } else {
        js_round(footer_font_px * 1.3)
    };
    let text_height_px = name_line_px + label_line_px + footer_line_px;
    let column_px = avatar_px.max(text_height_px);
    let card_height_px = js_round(metrics.padding_px * 2.0 + column_px);
    let text_top = metrics.padding_px + js_round((column_px - text_height_px) / 2.0);
    Some(Layout {
        card_width_px,
        card_height_px,
        avatar_px,
        name,
        label: label.to_string(),
        label_font_px,
        footer,
        footer_font_px,
        text_x,
        name_y: text_top + js_round(name_line_px / 2.0),
        label_y: text_top + name_line_px + js_round(label_line_px / 2.0),
        footer_y: text_top + name_line_px + label_line_px + js_round(footer_line_px / 2.0),
        metrics,
    })
}

/// The card inside a transparent margin for its shadow.
pub(crate) fn render(state: &MilestoneCardState, avatars: &DecodedImages) -> Option<Pixmap> {
    let layout = layout(state)?;
    let metrics = &layout.metrics;
    let pad = js_round(metrics.text_font_px * 0.6);
    let mut target = Pixmap::new(
        (layout.card_width_px + pad * 2.0) as u32,
        (layout.card_height_px + pad * 2.0) as u32,
    )?;
    let text_font_px = metrics.text_font_px as f32;
    // The comment card's glass recipe, unchanged.
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

    // The picture: the avatar, centred on the card's height.
    let avatar_x = pad + metrics.padding_px;
    let avatar_y = pad + js_round((layout.card_height_px - layout.avatar_px) / 2.0);
    let avatar = layout.avatar_px as f32;
    card::paint_avatar(
        &mut target,
        state.avatar_url.as_deref().and_then(|url| avatars.get(url)),
        &state.name,
        avatar_x as f32,
        avatar_y as f32,
        avatar,
    );
    if let Some(badge) = card::drawn_badge(state.platform) {
        let badge_size = js_round(layout.avatar_px * 0.3).max(12.0) as f32;
        card::paint_badge(
            &mut target,
            badge,
            avatar_x as f32 + avatar - badge_size * 0.84,
            avatar_y as f32 + avatar - badge_size * 0.84,
            badge_size,
        );
    } else if let Some(mark) = platform_mark(state.platform) {
        // YouTube's icon or X's mark, small, on the avatar's corner (the
        // renderer draws YouTube's mark bounds into the square, as here).
        let mark_px = js_round(layout.avatar_px * 0.3).max(20.0) as f32;
        marks::draw_mark(
            &mut target,
            mark,
            avatar_x as f32 + avatar - mark_px * 0.84,
            avatar_y as f32 + avatar - mark_px * 0.84,
            mark_px,
            mark_px,
        );
    }

    // The words: the name, the milestone, the persona's mark.
    let text_x = (pad + layout.text_x) as f32;
    let row = |y: f64| TextPlacement {
        x: text_x,
        y: (pad + y) as f32,
        align: Align::Left,
        baseline: Baseline::Middle,
        max_width: None,
    };
    canvas::with_shadow(
        &mut target,
        Some(card::text_shadow(metrics.text_font_px)),
        |layer, dx, dy| {
            text::fill_text(
                layer,
                &layout.name,
                Font::new(metrics.name_font_px as f32, NAME_WEIGHT),
                row(layout.name_y),
                NAME_COLOR,
                dx,
                dy,
            );
            text::fill_text(
                layer,
                &layout.label,
                Font::new(layout.label_font_px as f32, LABEL_PAINT_WEIGHT),
                row(layout.label_y),
                Rgba::hex(0xFFFFFF),
                dx,
                dy,
            );
            if !layout.footer.is_empty() {
                text::fill_text(
                    layer,
                    &layout.footer,
                    Font::new(layout.footer_font_px as f32, TEXT_WEIGHT),
                    row(layout.footer_y),
                    Rgba::hex(0xA1A1AA),
                    dx,
                    dy,
                );
            }
        },
    );
    Some(target)
}

/// YouTube's and X's own file marks (the others have a drawn badge).
fn platform_mark(platform: StreamPlatform) -> Option<Mark> {
    match platform {
        StreamPlatform::Youtube => Some(Mark::Youtube),
        StreamPlatform::X => Some(Mark::X),
        _ => None,
    }
    .filter(|mark| mark.available())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(label: &str, persona: Option<&str>) -> MilestoneCardState {
        MilestoneCardState {
            name: "Ada".to_string(),
            label: label.to_string(),
            persona_name: persona.map(str::to_string),
            avatar_url: None,
            platform: StreamPlatform::Twitch,
            canvas_width: 1920,
            canvas_height: 1080,
            rect: None,
        }
    }

    #[test]
    fn a_blank_milestone_draws_nothing() {
        assert!(layout(&state("  ", None)).is_none());
        assert!(render(&state("", Some("Buddy")), &DecodedImages::default()).is_none());
    }

    #[test]
    fn the_footer_names_the_persona_and_adds_a_row() {
        let without = layout(&state("10th stream", None)).unwrap();
        let with = layout(&state("10th stream", Some(" Buddy "))).unwrap();
        assert_eq!(without.footer, "");
        assert_eq!(with.footer, "with Buddy");
        // 1080p: text 40 px, the avatar 60 * 1.6 = 96 px; the three rows
        // (48 + 60 + 42 = 150 px) outgrow it.
        assert_eq!(with.avatar_px, 96.0);
        assert_eq!(with.card_height_px, 32.0 * 2.0 + 150.0);
        assert!(with.card_height_px > without.card_height_px);
    }
}
