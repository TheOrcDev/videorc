//! The Buddy's comic bubble on stream, `renderBuddyBubblePng` in
//! `buddy-overlay.ts`: wrapped to the placed rect's width (four lines at most,
//! the head kept), speech, shout or thought, cut at the tail's tip so the
//! bitmap's bottom centre is where the tail points (the backend puts that on
//! the pet's head). Since plan 220 S1.2d `buddy.overlay.set` draws the live
//! bubble here from its text and style (`overlay_raster::buddy_bubble`).

use serde::Deserialize;
use tiny_skia::Pixmap;
use videorc_protocol::cohost::CohostBubbleStyle;

use super::canvas::{self, Fill, Rgba, Shadow, StrokeStyle};
use super::text::{self, Align, Baseline, Font, TextPlacement};
use super::{OverlayRect, js_round, measure};

/// `CohostBubbleStyle`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BubbleStyle {
    Speech,
    Thought,
    Shout,
}

impl From<CohostBubbleStyle> for BubbleStyle {
    fn from(style: CohostBubbleStyle) -> Self {
        match style {
            CohostBubbleStyle::Speech => Self::Speech,
            CohostBubbleStyle::Thought => Self::Thought,
            CohostBubbleStyle::Shout => Self::Shout,
        }
    }
}

/// What the bubble is drawn from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuddyBubbleState {
    pub text: String,
    pub style: BubbleStyle,
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// The placed Buddy rect: the bubble wraps to its width.
    pub rect: OverlayRect,
}

const MAX_LINES: usize = 4;
const FONT_FRACTION: f64 = 18.0 / 1920.0;
const FONT_MIN_PX: f64 = 14.0;
const FILL: Rgba = Rgba::hex(0xFAFAFB);
const INK: Rgba = Rgba::hex(0x0D0D0F);
const RING: Rgba = Rgba::new(0, 0, 0, 0.25);
const SHADOW: Rgba = Rgba::new(0, 0, 0, 0.35);

struct Metrics {
    font_px: f64,
    line_height_px: f64,
    padding_px: f64,
    radius_px: f64,
    ring_px: f64,
    tail_px: f64,
    gap_px: f64,
    avatar_px: f64,
    pad_px: f64,
    max_text_width_px: f64,
    weight: u16,
}

/// `buddyOverlayMetrics`.
fn metrics(state: &BuddyBubbleState) -> Metrics {
    let canvas_width = f64::from(state.canvas_width);
    let long_edge = canvas_width.max(f64::from(state.canvas_height)).max(1.0);
    let font_px = js_round(long_edge * FONT_FRACTION).max(FONT_MIN_PX);
    let padding_px = js_round(font_px * 0.7);
    let rect_width_px = (state.rect.w * canvas_width).floor();
    let avatar_px = rect_width_px.min(canvas_width).floor().max(1.0);
    Metrics {
        font_px,
        line_height_px: js_round(font_px * 1.25),
        padding_px,
        radius_px: js_round(
            font_px
                * if state.style == BubbleStyle::Thought {
                    1.4
                } else {
                    0.7
                },
        ),
        ring_px: js_round(font_px / 10.0).max(1.0),
        tail_px: js_round(font_px * 0.9),
        gap_px: js_round(font_px * 0.2),
        avatar_px,
        pad_px: js_round(font_px * 0.6),
        max_text_width_px: avatar_px - padding_px * 2.0,
        weight: if state.style == BubbleStyle::Shout {
            700
        } else {
            500
        },
    }
}

/// `wrapBuddyBubbleText`: greedy, a word wider than the bubble broken by
/// character, four lines at most with the head kept behind a trailing
/// ellipsis. A shout is set in capitals.
fn wrap(state: &BuddyBubbleState, metrics: &Metrics) -> Vec<String> {
    let source = if state.style == BubbleStyle::Shout {
        state.text.to_uppercase()
    } else {
        state.text.clone()
    };
    let words: Vec<&str> = source.split_whitespace().collect();
    if words.is_empty() || metrics.max_text_width_px < metrics.font_px {
        return Vec::new();
    }
    let font = Font::new(metrics.font_px as f32, metrics.weight);
    let fits = |candidate: &str| measure(candidate, font) <= metrics.max_text_width_px;
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut overflow = false;
    let push = |lines: &mut Vec<String>, overflow: &mut bool, line: String| {
        if lines.len() < MAX_LINES {
            lines.push(line);
        } else {
            *overflow = true;
        }
    };
    for word in words {
        if overflow {
            break;
        }
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{current} {word}")
        };
        if fits(&candidate) {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            push(&mut lines, &mut overflow, std::mem::take(&mut current));
        }
        if fits(word) {
            current = word.to_string();
            continue;
        }
        // A single word wider than the bubble: break it by character.
        let mut piece = String::new();
        for character in word.chars() {
            let longer = format!("{piece}{character}");
            if fits(&longer) {
                piece = longer;
            } else {
                if !piece.is_empty() {
                    push(&mut lines, &mut overflow, std::mem::take(&mut piece));
                }
                piece = character.to_string();
            }
        }
        current = piece;
    }
    if !current.is_empty() {
        push(&mut lines, &mut overflow, current);
    }
    if overflow {
        let last = lines.get(MAX_LINES - 1).cloned().unwrap_or_default();
        let mut chars: Vec<char> = last.chars().collect();
        while chars.len() > 1 && !fits(&(chars.iter().collect::<String>() + "…")) {
            chars.pop();
        }
        lines[MAX_LINES - 1] = format!("{}…", chars.iter().collect::<String>().trim_end());
    }
    lines.truncate(MAX_LINES);
    lines
}

struct Bubble {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct Layout {
    metrics: Metrics,
    lines: Vec<String>,
    bubble: Bubble,
    tail: Vec<(f64, f64)>,
    thought_dots: Vec<(f64, f64, f64)>,
    width: f64,
    height: f64,
}

/// `layoutBuddyBubble`: `layoutBuddyOverlay` cut at the avatar's top.
fn layout(state: &BuddyBubbleState) -> Option<Layout> {
    let metrics = metrics(state);
    let lines = wrap(state, &metrics);
    if lines.is_empty() {
        return None;
    }
    let font = Font::new(metrics.font_px as f32, metrics.weight);
    let widest = lines
        .iter()
        .map(|line| measure(line, font))
        .fold(0.0, f64::max);
    let content_width = widest
        .max(metrics.font_px * 3.0)
        .min(metrics.max_text_width_px);
    let bubble_w = (content_width + metrics.padding_px * 2.0).ceil();
    let bubble_h = (lines.len() as f64 * metrics.line_height_px + metrics.padding_px * 2.0).ceil();
    let pad = metrics.pad_px;
    let bubble = Bubble {
        x: pad + js_round((metrics.avatar_px - bubble_w) / 2.0),
        y: pad,
        w: bubble_w,
        h: bubble_h,
    };
    let tail_top = bubble.y + bubble.h;
    let avatar_y = tail_top + metrics.tail_px + metrics.gap_px;
    let avatar_center_x = pad + metrics.avatar_px / 2.0;
    let tip_y = tail_top + metrics.tail_px;
    let (tail, thought_dots) = match state.style {
        BubbleStyle::Speech => (
            vec![
                (
                    avatar_center_x - metrics.tail_px * 0.75,
                    tail_top - metrics.ring_px,
                ),
                (
                    avatar_center_x + metrics.tail_px * 0.35,
                    tail_top - metrics.ring_px,
                ),
                (avatar_center_x, tip_y),
            ],
            Vec::new(),
        ),
        BubbleStyle::Shout => (
            vec![
                (
                    avatar_center_x - metrics.tail_px * 0.55,
                    tail_top - metrics.ring_px,
                ),
                (
                    avatar_center_x + metrics.tail_px * 0.25,
                    tail_top - metrics.ring_px,
                ),
                (avatar_center_x - metrics.tail_px * 0.1, tip_y),
            ],
            Vec::new(),
        ),
        BubbleStyle::Thought => {
            let big = metrics.tail_px * 0.34;
            let small = metrics.tail_px * 0.2;
            (
                Vec::new(),
                vec![
                    (
                        avatar_center_x - metrics.font_px * 0.5,
                        tail_top + big + metrics.ring_px,
                        big,
                    ),
                    (
                        avatar_center_x - metrics.font_px * 1.1,
                        tip_y - small,
                        small,
                    ),
                ],
            )
        }
    };
    Some(Layout {
        width: metrics.avatar_px + pad * 2.0,
        height: avatar_y,
        metrics,
        lines,
        bubble,
        tail,
        thought_dots,
    })
}

fn round1(value: f64) -> f64 {
    js_round(value * 10.0) / 10.0
}

/// `shoutBubblePoints`: spikes around the box.
fn shout_points(bubble: &Bubble, spike_px: f64) -> Vec<(f64, f64)> {
    let inner = Bubble {
        x: bubble.x + spike_px,
        y: bubble.y + spike_px,
        w: bubble.w - spike_px * 2.0,
        h: bubble.h - spike_px * 2.0,
    };
    let step = spike_px * 2.2;
    let mut points = Vec::new();
    let mut edge = |from: (f64, f64), to: (f64, f64), outward: (f64, f64)| {
        let length = (to.0 - from.0).hypot(to.1 - from.1);
        let count = js_round(length / step).max(1.0) as usize;
        for index in 0..count {
            let t0 = index as f64 / count as f64;
            let t1 = (index as f64 + 0.5) / count as f64;
            points.push((from.0 + (to.0 - from.0) * t0, from.1 + (to.1 - from.1) * t0));
            points.push((
                from.0 + (to.0 - from.0) * t1 + outward.0 * spike_px,
                from.1 + (to.1 - from.1) * t1 + outward.1 * spike_px,
            ));
        }
    };
    let top_left = (inner.x, inner.y);
    let top_right = (inner.x + inner.w, inner.y);
    let bottom_right = (inner.x + inner.w, inner.y + inner.h);
    let bottom_left = (inner.x, inner.y + inner.h);
    edge(top_left, top_right, (0.0, -1.0));
    edge(top_right, bottom_right, (1.0, 0.0));
    edge(bottom_right, bottom_left, (0.0, 1.0));
    edge(bottom_left, top_left, (-1.0, 0.0));
    points
        .into_iter()
        .map(|(x, y)| (round1(x), round1(y)))
        .collect()
}

fn to_f32(points: &[(f64, f64)]) -> Vec<(f32, f32)> {
    points.iter().map(|(x, y)| (*x as f32, *y as f32)).collect()
}

/// The bubble alone, its tail tip on the bitmap's bottom centre. None without
/// text.
pub(crate) fn render(state: &BuddyBubbleState) -> Option<Pixmap> {
    let layout = layout(state)?;
    let metrics = &layout.metrics;
    let mut target = Pixmap::new(
        (layout.width.max(1.0)) as u32,
        (layout.height.max(1.0)) as u32,
    )?;
    let bubble = &layout.bubble;
    let shape = if state.style == BubbleStyle::Shout {
        canvas::polygon(&to_f32(&shout_points(
            bubble,
            js_round(metrics.font_px * 0.45),
        )))
    } else {
        canvas::round_rect(
            bubble.x as f32,
            bubble.y as f32,
            bubble.w as f32,
            bubble.h as f32,
            metrics.radius_px as f32,
        )
    }?;
    let ring = StrokeStyle::new(RING, metrics.ring_px as f32).round_join();
    let font_px = metrics.font_px as f32;
    // Shadow on the body only; the tail and dots are flat so the join stays clean.
    canvas::with_shadow(
        &mut target,
        Some(Shadow {
            color: SHADOW,
            blur: font_px * 0.5,
            offset_x: 0.0,
            offset_y: font_px * 0.1,
        }),
        |layer, dx, dy| canvas::fill_path(layer, &shape, &Fill::Color(FILL), dx, dy),
    );
    if let Some(tail) = canvas::polygon(&to_f32(&layout.tail)) {
        canvas::fill_path(&mut target, &tail, &Fill::Color(FILL), 0.0, 0.0);
        canvas::stroke_path(&mut target, &tail, ring, 0.0, 0.0);
    }
    // The ring, then the body again so the tail's inner edge disappears.
    canvas::stroke_path(&mut target, &shape, ring, 0.0, 0.0);
    canvas::fill_path(&mut target, &shape, &Fill::Color(FILL), 0.0, 0.0);
    for &(cx, cy, r) in &layout.thought_dots {
        if let Some(dot) = canvas::circle(cx as f32, cy as f32, r as f32) {
            canvas::fill_path(&mut target, &dot, &Fill::Color(FILL), 0.0, 0.0);
            canvas::stroke_path(
                &mut target,
                &dot,
                StrokeStyle::new(RING, metrics.ring_px as f32),
                0.0,
                0.0,
            );
        }
    }
    let font = Font::new(font_px, metrics.weight);
    let center_x = (bubble.x + bubble.w / 2.0) as f32;
    for (index, line) in layout.lines.iter().enumerate() {
        text::fill_text(
            &mut target,
            line,
            font,
            TextPlacement {
                x: center_x,
                y: (bubble.y + metrics.padding_px + metrics.line_height_px * (index as f64 + 0.5))
                    as f32,
                align: Align::Center,
                baseline: Baseline::Middle,
                max_width: Some(metrics.max_text_width_px as f32),
            },
            INK,
            0.0,
            0.0,
        );
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(text: &str, style: BubbleStyle) -> BuddyBubbleState {
        BuddyBubbleState {
            text: text.to_string(),
            style,
            canvas_width: 1920,
            canvas_height: 1080,
            rect: OverlayRect {
                x: 0.8,
                y: 0.6,
                w: 0.18,
                h: 0.36,
            },
        }
    }

    #[test]
    fn the_bubble_is_the_rect_wide_and_ends_at_the_tail_tip() {
        let layout = layout(&state("hello there", BubbleStyle::Speech)).expect("layout");
        // 18 px type at 1080p; the bitmap is the avatar box plus shadow room.
        assert_eq!(layout.metrics.font_px, 18.0);
        assert_eq!(layout.width, 345.0 + 2.0 * 11.0);
        let tip = layout.tail[2];
        assert_eq!(tip.0, layout.width / 2.0);
        assert_eq!(layout.height, tip.1 + layout.metrics.gap_px);
    }

    #[test]
    fn a_shout_is_capitals_and_empty_text_draws_nothing() {
        let shout = layout(&state("go go", BubbleStyle::Shout)).expect("layout");
        assert_eq!(shout.lines, vec!["GO GO".to_string()]);
        assert!(render(&state("  ", BubbleStyle::Thought)).is_none());
    }
}
