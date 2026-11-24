//! Plan 260 S1.2 (plan 220 S1.2a, ported from `videorc-rust`): the backend
//! draws what the renderer's OffscreenCanvas draws.
//!
//! Today the renderer paints the caption bar, the chat highlight card, the
//! Sidekick bubble and the chat box with `OffscreenCanvas`
//! (`renderer/src/lib/caption-overlay.ts`, `buddy-overlay.ts`, with the
//! layouts in `comment-highlight*.ts` and `chat-overlay.ts`) and sends each
//! here as a PNG (`captions.overlay.set`, `comments.highlight.set`,
//! `buddy.overlay.set`, `chat.overlay.set`). This module is the same painting
//! in Rust, layout for layout: text through parley (fontique's system fonts
//! with the renderer's font stack, per-script fallback and colour emoji)
//! rasterised with swash, shapes (rounded rects, gradients, strokes, canvas
//! shadows) on tiny-skia. Its output is the straight-alpha RGBA the PNG path
//! decodes to.
//!
//! S1.2a landed the painter for the caption bar and the captioned copy's cue
//! frames, and S1.2b switched the live caption bar to it. S1.2c adds the
//! chat highlight card, the milestone card and the chat box (`highlight`,
//! `milestone`, `chat`, with their avatars and emotes decoded by `images`
//! and the platforms' own marks in `marks`), held to the renderer's PNGs
//! like the caption; the switch of those overlays comes after. S1.2d switched
//! the Sidekick bubble: `buddy.overlay.set` with the bubble's text and style
//! draws it here for the target's canvas (`buddy_bubble`).
//!
//! The goldens (`tests/fixtures/overlay-raster/`) are the renderer's own PNGs
//! (`node scripts/overlay-raster-goldens.mjs`); `golden_tests` holds the
//! drawing to them.

mod buddy;
mod canvas;
mod caption;
mod card;
mod card_text;
mod chat;
mod highlight;
mod images;
mod marks;
mod milestone;
mod text;

#[cfg(test)]
mod golden_tests;

use serde::Deserialize;
use tiny_skia::Pixmap;

pub(crate) use buddy::BuddyBubbleState;
use canvas::Rgba;
pub(crate) use caption::CaptionFrameState;
use caption::{CaptionBarState, CaptionOverlayPosition, CaptionStyleId, CaptionTextSize};
pub(crate) use chat::{ChatBoxMessage, ChatBoxState};
pub(crate) use highlight::HighlightCardState;
pub(crate) use images::DecodedImages;
pub(crate) use milestone::MilestoneCardState;

use crate::live_chat::LiveChatMessage;
pub(crate) use crate::overlay_layout::OverlayRect;

/// One overlay to draw, tagged as the golden cases are.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "overlay", rename_all = "lowercase")]
pub(crate) enum OverlayState {
    Caption(CaptionBarState),
    /// A captioned copy's cue frame, or the Captions page's preview.
    #[serde(rename = "captionFrame")]
    CaptionFrame(CaptionFrameState),
    Highlight(HighlightCardState),
    Milestone(MilestoneCardState),
    Buddy(BuddyBubbleState),
    Chat(ChatBoxState),
}

/// A drawn overlay: straight-alpha RGBA rows, as a decoded PNG.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OverlayImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl OverlayImage {
    fn from_pixmap(pixmap: Pixmap) -> Self {
        Self {
            width: pixmap.width(),
            height: pixmap.height(),
            rgba: pixmap.take_demultiplied(),
        }
    }
}

/// The image files an overlay draws, decoded: viewers' avatars by their URL,
/// emotes by the URL their fragment carries (the bytes are the card's own
/// size, `wanted_images`).
#[derive(Debug, Default)]
pub(crate) struct OverlayImages {
    pub avatars: DecodedImages,
    pub emotes: DecodedImages,
}

/// Which image files an overlay draws.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct WantedImages {
    /// Avatar URLs, fetched and read as they are.
    pub avatars: Vec<String>,
    /// Emote URLs as their fragments carry them, at most 20 distinct.
    pub emotes: Vec<String>,
}

impl WantedImages {
    /// The URL whose bytes an emote is drawn from: Twitch's 112 px `/3.0`
    /// rather than the chat row's 28 px one (`highlightEmoteImageUrl`).
    pub(crate) fn emote_file_url(url: &str) -> String {
        card::emote_image_url(url)
    }
}

impl OverlayState {
    /// The image files this overlay draws.
    pub(crate) fn wanted_images(&self) -> WantedImages {
        match self {
            Self::Highlight(state) => WantedImages {
                avatars: state.avatar_url.iter().cloned().collect(),
                emotes: card::emote_urls(&state.tokens()),
            },
            Self::Milestone(state) => WantedImages {
                avatars: state.avatar_url.iter().cloned().collect(),
                emotes: Vec::new(),
            },
            Self::Chat(state) => WantedImages {
                avatars: state.avatar_urls(),
                emotes: card::emote_urls(&state.tokens()),
            },
            Self::Caption(_) | Self::CaptionFrame(_) | Self::Buddy(_) => WantedImages::default(),
        }
    }
}

/// Draws one overlay that needs no image files the way the renderer would,
/// or None where the renderer sends nothing (empty text, no room).
pub(crate) fn render(state: &OverlayState) -> Option<OverlayImage> {
    render_with_images(state, &OverlayImages::default())
}

/// Draws one overlay with its decoded avatars and emotes; a missing one
/// draws the monogram, or the emote's name, as the renderer's fallback did.
pub(crate) fn render_with_images(
    state: &OverlayState,
    images: &OverlayImages,
) -> Option<OverlayImage> {
    render_premultiplied(state, images).map(OverlayImage::from_pixmap)
}

fn render_premultiplied(state: &OverlayState, images: &OverlayImages) -> Option<Pixmap> {
    match state {
        OverlayState::Caption(state) => caption::render(state),
        OverlayState::CaptionFrame(state) => caption::render_frame(state),
        OverlayState::Highlight(state) => highlight::render(state, &images.avatars, &images.emotes),
        OverlayState::Milestone(state) => milestone::render(state, &images.avatars),
        OverlayState::Buddy(state) => buddy::render(state),
        OverlayState::Chat(state) => chat::render(state, &images.avatars, &images.emotes),
    }
}

/// The highlight card for one chat message on a canvas: what
/// `renderCommentHighlightCards` drew for it.
pub(crate) fn highlight_card(
    message: &LiveChatMessage,
    canvas: (u32, u32),
    rect: Option<OverlayRect>,
) -> HighlightCardState {
    HighlightCardState {
        author_name: message.author_name.clone(),
        text: card_text::card_text(message),
        fragments: card_text::card_fragments(message).map(<[_]>::to_vec),
        platform: message.platform,
        avatar_url: message.author_avatar_url.clone(),
        author_verified: message.author_verified,
        canvas_width: canvas.0,
        canvas_height: canvas.1,
        rect,
    }
}

/// The caption bar for one line on a leg's canvas: what the renderer's
/// burn-in driver asked `renderCaptionOverlayPng` for, the bar wrapping to
/// the placed rect's width in whole pixels (plan 164) when there is one.
pub(crate) fn caption_bar(
    text: &str,
    canvas: (u32, u32),
    text_size: CaptionTextSize,
    style_id: CaptionStyleId,
    rect: Option<OverlayRect>,
) -> CaptionBarState {
    CaptionBarState {
        text: text.to_string(),
        canvas_width: canvas.0,
        canvas_height: Some(canvas.1),
        text_size,
        style_id,
        max_bar_width_px: rect.map(|rect| (rect.w * f64::from(canvas.0)).floor()),
    }
}

/// One frame of the captioned copy (or the Captions page's preview): what
/// `renderCaptionCueFramePng` drew for a cue on the session's output canvas,
/// in its frozen caption style. Empty text is the blank gap frame.
pub(crate) fn caption_frame(
    text: &str,
    canvas: (u32, u32),
    position: CaptionOverlayPosition,
    text_size: CaptionTextSize,
    style_id: CaptionStyleId,
) -> CaptionFrameState {
    CaptionFrameState {
        text: text.to_string(),
        canvas_width: canvas.0,
        canvas_height: canvas.1,
        position,
        text_size,
        style_id,
    }
}

/// The Sidekick's bubble for one line on a target's canvas: what the
/// renderer's push asked `renderBuddyBubblePng` for, wrapped to the
/// Sidekick's placed rect on that canvas (plan 168 D16).
pub(crate) fn buddy_bubble(
    text: &str,
    style: videorc_protocol::cohost::CohostBubbleStyle,
    canvas: (u32, u32),
    rect: OverlayRect,
) -> BuddyBubbleState {
    BuddyBubbleState {
        text: text.to_string(),
        style: style.into(),
        canvas_width: canvas.0,
        canvas_height: canvas.1,
        rect,
    }
}

/// The chat box shows this many messages at most (`CHAT_OVERLAY_MAX_MESSAGES`).
pub(crate) const CHAT_BOX_MAX_MESSAGES: usize = 5;

/// The chat box for these messages (oldest first) on a canvas: what
/// `renderChatOverlayCards` drew for them.
pub(crate) fn chat_box(
    messages: &[LiveChatMessage],
    canvas: (u32, u32),
    rect: OverlayRect,
) -> ChatBoxState {
    ChatBoxState {
        messages: messages
            .iter()
            .map(|message| ChatBoxMessage {
                author_name: message.author_name.clone(),
                platform: message.platform,
                text: message.message_text.clone(),
                fragments: Some(message.fragments.clone()),
                author_avatar_url: message.author_avatar_url.clone(),
            })
            .collect(),
        canvas_width: canvas.0,
        canvas_height: canvas.1,
        rect,
    }
}

/// The highlight card's glass (`paintCaptionBar`'s recipe), shared by the
/// glass caption, the highlight card and the chat box.
const GLASS_FILL: Rgba = Rgba::new(16, 16, 18, 0.78);
const GLASS_SHEEN: [(f32, Rgba); 3] = [
    (0.0, Rgba::new(255, 255, 255, 0.07)),
    (0.35, Rgba::new(255, 255, 255, 0.015)),
    (1.0, Rgba::new(255, 255, 255, 0.0)),
];
const GLASS_HAIRLINE: Rgba = Rgba::new(255, 255, 255, 0.1);

/// JavaScript's `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `ctx.measureText(text).width` in the layouts' arithmetic.
fn measure(text: &str, font: text::Font) -> f64 {
    f64::from(text::measure(text, font))
}
