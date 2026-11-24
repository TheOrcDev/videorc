//! Chat on stream, `renderChatOverlayPng` in `caption-overlay.ts` with
//! `layoutChatOverlay` in `chat-overlay.ts`: one row per message (the
//! platform's icon, the viewer's avatar, the name, up to three lines of
//! words and emotes), oldest at the top, the box the placed rect's width;
//! when the rows are taller than the rect the oldest leave first and the
//! newest always stays. The avatar (#1281, plan 220 S3.2f) is a circle a
//! little taller than the name and never taller than a text line, so the
//! identity line keeps its height; a viewer with no picture gets their
//! initials.

use serde::Deserialize;
use tiny_skia::Pixmap;

use super::canvas;
use super::card::{self, Line, NAME_COLOR, NAME_WEIGHT, Token};
use super::images::DecodedImages;
use super::marks::{self, Mark};
use super::text::{self, Align, Baseline, Font, TextPlacement};
use super::{OverlayRect, js_round};
use crate::live_chat::LiveChatMessageFragment;
use crate::streaming::StreamPlatform;

/// One message in the box.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatBoxMessage {
    pub author_name: String,
    pub platform: StreamPlatform,
    /// `messageText`.
    pub text: String,
    #[serde(default)]
    pub fragments: Option<Vec<LiveChatMessageFragment>>,
    /// The viewer's picture (`authorAvatarUrl`); absent paints the initials.
    #[serde(default)]
    pub author_avatar_url: Option<String>,
}

impl ChatBoxMessage {
    pub(crate) fn tokens(&self) -> Vec<Token> {
        card::tokens(&self.text, self.fragments.as_deref())
    }
}

/// What the chat box is drawn from: the messages oldest first.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatBoxState {
    pub messages: Vec<ChatBoxMessage>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// The placed chat rect: the box takes its width, never more height.
    pub rect: OverlayRect,
}

impl ChatBoxState {
    /// Every emote the box draws, decoded once for both rasters.
    pub(crate) fn tokens(&self) -> Vec<Token> {
        self.messages
            .iter()
            .flat_map(ChatBoxMessage::tokens)
            .collect()
    }

    /// Every viewer's picture the box draws, once each (a regular's picture
    /// is decoded once per box, however many rows they have).
    pub(crate) fn avatar_urls(&self) -> Vec<String> {
        let mut urls: Vec<String> = Vec::new();
        for url in self
            .messages
            .iter()
            .filter_map(|message| message.author_avatar_url.as_deref())
        {
            if !urls.iter().any(|seen| seen == url) {
                urls.push(url.to_string());
            }
        }
        urls
    }
}

struct Metrics {
    name_font_px: f64,
    text_font_px: f64,
    line_height_px: f64,
    padding_px: f64,
    identity_gap_px: f64,
    row_gap_px: f64,
    radius_px: f64,
    max_text_width_px: f64,
    icon_px: f64,
    /// The viewer's picture: a circle a little taller than the name and
    /// never taller than a text line.
    avatar_px: f64,
    message_gap_px: f64,
    box_width_px: f64,
}

/// `chatOverlayMetrics`: the highlight card's scale off the long edge, smaller.
fn metrics(canvas_width: u32, canvas_height: u32, rect_width_px: f64) -> Metrics {
    let long_edge = f64::from(canvas_width.max(canvas_height));
    let text_font_px = js_round(long_edge / 72.0).max(16.0);
    let name_font_px = js_round(text_font_px * 0.95);
    let padding_px = js_round(text_font_px * 0.7);
    let line_height_px = js_round(text_font_px * 1.3);
    let box_width_px = rect_width_px.min(f64::from(canvas_width)).floor().max(0.0);
    Metrics {
        name_font_px,
        text_font_px,
        line_height_px,
        padding_px,
        identity_gap_px: js_round(text_font_px * 0.4).max(6.0),
        row_gap_px: js_round(text_font_px * 0.15),
        radius_px: js_round(text_font_px * 0.6),
        max_text_width_px: box_width_px - padding_px * 2.0,
        icon_px: marks::YOUTUBE_MARK_MIN_PX.max(name_font_px),
        avatar_px: line_height_px.min(js_round(name_font_px * 1.15)),
        message_gap_px: js_round(text_font_px * 0.55),
        box_width_px,
    }
}

/// What leads a row (`ChatOverlayRowIcon`): the platform's own file mark,
/// the highlight's drawn badge, or nothing (the name then says the platform).
#[derive(Clone, Copy)]
enum Icon {
    Mark(Mark),
    Badge(card::Badge),
    None,
}

fn row_icon(platform: StreamPlatform) -> Icon {
    let mark = match platform {
        StreamPlatform::Youtube => Some(Mark::Youtube),
        StreamPlatform::X => Some(Mark::X),
        _ => None,
    };
    if let Some(mark) = mark.filter(|mark| mark.available()) {
        return Icon::Mark(mark);
    }
    card::drawn_badge(platform).map_or(Icon::None, Icon::Badge)
}

struct Row {
    icon: Icon,
    icon_width_px: f64,
    /// Where the avatar circle starts, from the box's content edge: after
    /// the platform icon, right before the name.
    avatar_x_px: f64,
    avatar_url: Option<String>,
    /// The viewer's name as the platform gave it (the monogram's).
    author_name: String,
    name: String,
    name_x_px: f64,
    lines: Vec<Line>,
    top_px: f64,
    height_px: f64,
    identity_height_px: f64,
}

struct Layout {
    metrics: Metrics,
    rows: Vec<Row>,
    box_height_px: f64,
}

/// `layoutChatOverlay`.
fn layout(state: &ChatBoxState, emotes: &DecodedImages) -> Option<Layout> {
    let canvas_width = f64::from(state.canvas_width);
    let canvas_height = f64::from(state.canvas_height);
    let rect_width_px = (state.rect.w * canvas_width).floor();
    let rect_height_px = (state.rect.h * canvas_height).floor();
    let metrics = metrics(state.canvas_width, state.canvas_height, rect_width_px);
    if metrics.max_text_width_px <= 0.0 || state.messages.is_empty() {
        return None;
    }
    let identity_height_px = metrics
        .line_height_px
        .max(metrics.icon_px)
        .max(metrics.avatar_px);
    let measured: Vec<Row> = state
        .messages
        .iter()
        .map(|message| {
            let icon = row_icon(message.platform);
            // Without an icon the name says the platform: "YouTube · name".
            let author = match icon {
                Icon::None => card::identity(&message.author_name, message.platform, false),
                _ => message.author_name.clone(),
            };
            let icon_width_px = match icon {
                Icon::None => 0.0,
                Icon::Mark(Mark::Youtube) => {
                    (metrics.icon_px * marks::youtube_mark_aspect()).ceil()
                }
                _ => metrics.icon_px,
            };
            let avatar_x_px = if icon_width_px > 0.0 {
                icon_width_px + metrics.identity_gap_px
            } else {
                0.0
            };
            let name_x_px = avatar_x_px + metrics.avatar_px + metrics.identity_gap_px;
            let max_name_width_px = (metrics.max_text_width_px - name_x_px).max(1.0);
            let name = card::fit_name(
                card::author(&author),
                metrics.name_font_px,
                max_name_width_px,
            );
            let lines = card::wrap_tokens(
                &message.tokens(),
                metrics.text_font_px,
                metrics.max_text_width_px,
                emotes,
            );
            let height_px = identity_height_px
                + if lines.is_empty() {
                    0.0
                } else {
                    metrics.row_gap_px + lines.len() as f64 * metrics.line_height_px
                };
            Row {
                icon,
                icon_width_px,
                avatar_x_px,
                avatar_url: message.author_avatar_url.clone(),
                author_name: message.author_name.clone(),
                name,
                name_x_px,
                lines,
                top_px: 0.0,
                height_px,
                identity_height_px,
            }
        })
        .collect();
    // Newest first until the rect is full; the newest always stays.
    let mut kept: Vec<Row> = Vec::new();
    let mut content_px = 0.0;
    for row in measured.into_iter().rev() {
        let next = content_px
            + if kept.is_empty() {
                0.0
            } else {
                metrics.message_gap_px
            }
            + row.height_px;
        if !kept.is_empty() && next + metrics.padding_px * 2.0 > rect_height_px {
            break;
        }
        kept.push(row);
        content_px = next;
    }
    kept.reverse();
    let mut top_px = metrics.padding_px;
    for row in &mut kept {
        row.top_px = top_px;
        top_px += row.height_px + metrics.message_gap_px;
    }
    Some(Layout {
        box_height_px: (content_px + metrics.padding_px * 2.0).ceil(),
        metrics,
        rows: kept,
    })
}

/// The box, exactly the rect's width (no shadow margin: the backend crops a
/// bitmap wider than its rect). None without messages or room.
pub(crate) fn render(
    state: &ChatBoxState,
    avatars: &DecodedImages,
    emotes: &DecodedImages,
) -> Option<Pixmap> {
    let layout = layout(state, emotes)?;
    let metrics = &layout.metrics;
    if metrics.box_width_px <= 0.0 || layout.box_height_px <= 0.0 {
        return None;
    }
    let mut target = Pixmap::new(metrics.box_width_px as u32, layout.box_height_px as u32)?;
    card::paint_glass(
        &mut target,
        0.0,
        0.0,
        metrics.box_width_px as f32,
        layout.box_height_px as f32,
        metrics.radius_px as f32,
        None,
    );
    let content_x = metrics.padding_px;
    let name_font = Font::new(metrics.name_font_px as f32, NAME_WEIGHT);
    for row in &layout.rows {
        let identity_mid_y = row.top_px + row.identity_height_px / 2.0;
        let icon_y = js_round(identity_mid_y - metrics.icon_px / 2.0) as f32;
        match row.icon {
            Icon::Mark(mark) => marks::draw_mark(
                &mut target,
                mark,
                content_x as f32,
                icon_y,
                row.icon_width_px as f32,
                metrics.icon_px as f32,
            ),
            Icon::Badge(badge) => card::paint_badge(
                &mut target,
                badge,
                content_x as f32,
                icon_y,
                metrics.icon_px as f32,
            ),
            Icon::None => {}
        }
        // The viewer's avatar, right before the name: the highlight card's
        // circle, with the viewer's initials when there is no picture.
        card::paint_avatar(
            &mut target,
            row.avatar_url.as_deref().and_then(|url| avatars.get(url)),
            &row.author_name,
            (content_x + row.avatar_x_px) as f32,
            js_round(identity_mid_y - metrics.avatar_px / 2.0) as f32,
            metrics.avatar_px as f32,
        );
        let place = TextPlacement {
            x: (content_x + row.name_x_px) as f32,
            y: (identity_mid_y + 1.0) as f32,
            align: Align::Left,
            baseline: Baseline::Middle,
            max_width: Some((metrics.max_text_width_px - row.name_x_px).max(1.0) as f32),
        };
        canvas::with_shadow(
            &mut target,
            Some(card::text_shadow(metrics.text_font_px)),
            |layer, dx, dy| {
                text::fill_text(layer, &row.name, name_font, place, NAME_COLOR, dx, dy);
            },
        );
        card::paint_lines(
            &mut target,
            &row.lines,
            content_x,
            row.top_px + row.identity_height_px + metrics.row_gap_px,
            metrics.text_font_px,
            metrics.line_height_px,
            metrics.max_text_width_px,
            emotes,
        );
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(text: &str) -> ChatBoxMessage {
        ChatBoxMessage {
            author_name: "pam".to_string(),
            platform: StreamPlatform::Twitch,
            text: text.to_string(),
            fragments: None,
            author_avatar_url: None,
        }
    }

    #[test]
    fn the_oldest_rows_leave_a_short_rect_and_the_newest_stays() {
        let state = ChatBoxState {
            messages: (0..5)
                .map(|index| message(&format!("message {index}")))
                .collect(),
            canvas_width: 1920,
            canvas_height: 1080,
            rect: OverlayRect {
                x: 0.0,
                y: 0.0,
                w: 0.3,
                h: 0.1,
            },
        };
        let emotes = DecodedImages::default();
        let layout = layout(&state, &emotes).expect("layout");
        assert_eq!(layout.rows.len(), 1);
        assert!(matches!(
            &layout.rows[0].lines[0].items[1],
            card::Item::Word { text, .. } if text == "4"
        ));
        assert!(
            render(
                &ChatBoxState {
                    messages: Vec::new(),
                    ..state
                },
                &DecodedImages::default(),
                &emotes
            )
            .is_none()
        );
    }

    /// #1281: the name starts after the avatar circle and its gap, with or
    /// without a platform icon, and a regular's picture is wanted once.
    #[test]
    fn the_avatar_sits_between_the_icon_and_the_name() {
        let mut first = message("hi");
        first.author_avatar_url = Some("https://static-cdn.jtvnw.net/a.png".to_string());
        let mut second = message("again");
        second.author_avatar_url = first.author_avatar_url.clone();
        let mut third = message("no picture");
        third.platform = StreamPlatform::Youtube;
        let state = ChatBoxState {
            messages: vec![first, second, third],
            canvas_width: 1920,
            canvas_height: 1080,
            rect: OverlayRect {
                x: 0.0,
                y: 0.0,
                w: 0.3,
                h: 0.5,
            },
        };
        assert_eq!(
            state.avatar_urls(),
            vec!["https://static-cdn.jtvnw.net/a.png".to_string()]
        );
        let layout = layout(&state, &DecodedImages::default()).expect("layout");
        let metrics = &layout.metrics;
        let twitch = &layout.rows[0];
        assert_eq!(
            twitch.avatar_x_px,
            twitch.icon_width_px + metrics.identity_gap_px
        );
        assert_eq!(
            twitch.name_x_px,
            twitch.avatar_x_px + metrics.avatar_px + metrics.identity_gap_px
        );
        assert!(metrics.avatar_px <= metrics.line_height_px);
        assert!(metrics.avatar_px > metrics.name_font_px);
        assert!(render(&state, &DecodedImages::default(), &DecodedImages::default()).is_some());
    }
}
