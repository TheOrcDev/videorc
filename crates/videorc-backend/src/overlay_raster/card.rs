//! What the highlight card and the chat box share (`comment-highlight.ts`,
//! `comment-highlight-layout.ts`, `chat-emotes.ts`, the painters in
//! `caption-overlay.ts`): the glass plate, the platform badges, the name fit,
//! the message as words and emotes, and their wrap into at most three lines
//! with the head kept.

use tiny_skia::{Mask, Pixmap, PixmapPaint, Transform};

use super::canvas::{self, Fill, Rgba, Shadow, StrokeStyle};
use super::images::{self, DecodedImages};
use super::text::{self, Align, Baseline, Font, TextPlacement};
use super::{GLASS_FILL, GLASS_HAIRLINE, GLASS_SHEEN, js_round, measure};
use crate::live_chat::LiveChatMessageFragment;
use crate::streaming::StreamPlatform;

pub(crate) const NAME_WEIGHT: u16 = 600;
pub(crate) const TEXT_WEIGHT: u16 = 400;
pub(crate) const MAX_TEXT_LINES: usize = 3;
pub(crate) const NAME_COLOR: Rgba = Rgba::hex(0xF5F5F7);
pub(crate) const TEXT_COLOR: Rgba = Rgba::new(244, 244, 245, 0.92);

/// An emote box is this many times the text size high
/// (`HIGHLIGHT_EMOTE_HEIGHT_FACTOR`).
const EMOTE_HEIGHT_FACTOR: f64 = 1.2;
/// Wide emotes are capped at this many box heights
/// (`HIGHLIGHT_EMOTE_MAX_ASPECT`).
const EMOTE_MAX_ASPECT: f64 = 3.0;
/// Distinct emote images one card loads; the rest show their names
/// (`HIGHLIGHT_MAX_EMOTES`).
const MAX_EMOTES: usize = 20;
/// With `textBaseline = 'top'` a line's glyphs centre about this many ems
/// below the line top; an emote box is centred on the same axis.
const EMOTE_AXIS_EM: f64 = 0.58;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Glyph {
    Kick,
    Twitch,
    Dot,
}

/// A drawn badge (`commentHighlightPlatformBadge` entries with a colour).
#[derive(Clone, Copy)]
pub(crate) struct Badge {
    pub color: Rgba,
    pub ink: Rgba,
    pub glyph: Glyph,
}

/// The platform's label (`commentHighlightPlatformBadge(...).label`): None for
/// the platforms the card has no badge or mark for.
pub(crate) fn platform_label(platform: StreamPlatform) -> Option<&'static str> {
    match platform {
        StreamPlatform::Youtube => Some("YouTube"),
        StreamPlatform::X => Some("X"),
        StreamPlatform::Twitch => Some("Twitch"),
        StreamPlatform::Kick => Some("Kick"),
        StreamPlatform::Custom => Some("Custom"),
        StreamPlatform::Facebook | StreamPlatform::Tiktok | StreamPlatform::Instagram => None,
    }
}

/// The drawn badge for the platforms the card never shows a file mark for
/// (Twitch, Kick, a custom destination). YouTube and X are never redrawn.
pub(crate) fn drawn_badge(platform: StreamPlatform) -> Option<Badge> {
    let white = Rgba::hex(0xFFFFFF);
    match platform {
        StreamPlatform::Twitch => Some(Badge {
            color: Rgba::hex(0x9146FF),
            ink: white,
            glyph: Glyph::Twitch,
        }),
        StreamPlatform::Kick => Some(Badge {
            color: Rgba::hex(0x53FC18),
            ink: Rgba::hex(0x0B1A05),
            glyph: Glyph::Kick,
        }),
        StreamPlatform::Custom => Some(Badge {
            color: Rgba::hex(0x52525B),
            ink: white,
            glyph: Glyph::Dot,
        }),
        _ => None,
    }
}

/// The author, "Viewer" when blank.
pub(crate) fn author(name: &str) -> &str {
    let name = name.trim();
    if name.is_empty() { "Viewer" } else { name }
}

/// `commentHighlightIdentity`: "Twitch · name". When the card draws YouTube's
/// or X's own mark (`mark_shown`), the mark is the attribution and the line
/// is just the name.
pub(crate) fn identity(author_name: &str, platform: StreamPlatform, mark_shown: bool) -> String {
    let author = author(author_name);
    if mark_shown && matches!(platform, StreamPlatform::Youtube | StreamPlatform::X) {
        return author.to_string();
    }
    match platform_label(platform) {
        Some(label) => format!("{label} · {author}"),
        None => author.to_string(),
    }
}

/// `fitHighlightName`: an over-long name keeps its head behind an ellipsis.
pub(crate) fn fit_name(name: &str, font_px: f64, max_width_px: f64) -> String {
    let font = Font::new(font_px as f32, NAME_WEIGHT);
    if measure(name, font) <= max_width_px {
        return name.to_string();
    }
    let mut chars: Vec<char> = name.chars().collect();
    while chars.len() > 1 {
        let candidate: String = chars.iter().collect::<String>() + "…";
        if measure(&candidate, font) <= max_width_px {
            break;
        }
        chars.pop();
    }
    format!("{}…", chars.iter().collect::<String>().trim_end())
}

/// `truncateHighlightWord` (#1281): `text` cut to `max_width_px` with a
/// trailing ellipsis, or unchanged when it fits. A long word (a pasted link)
/// stood alone on its line and the painter squeezed its glyphs into an
/// unreadable sliver; it is cut instead. At least one character stays before
/// the ellipsis; an ellipsis already there is not doubled.
pub(crate) fn truncate_word(text: &str, max_width_px: f64, font: Font) -> (String, f64) {
    let width_px = measure(text, font);
    if width_px <= max_width_px {
        return (text.to_string(), width_px);
    }
    let chars: Vec<char> = text.strip_suffix('…').unwrap_or(text).chars().collect();
    if chars.is_empty() {
        return ("…".to_string(), measure("…", font));
    }
    // The longest head that fits with its ellipsis (binary search: links run
    // to a hundred characters and more).
    let head = |count: usize| format!("{}…", chars[..count].iter().collect::<String>());
    let (mut low, mut high, mut best) = (1usize, chars.len() - 1, 1usize);
    while low <= high {
        let middle = (low + high) / 2;
        if measure(&head(middle), font) <= max_width_px {
            best = middle;
            low = middle + 1;
        } else if middle == 0 {
            break;
        } else {
            high = middle - 1;
        }
    }
    let cut = head(best.clamp(1, chars.len()));
    let width_px = measure(&cut, font);
    (cut, width_px)
}

/// One piece of a message body (`HighlightToken`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Token {
    Word(String),
    Emote {
        /// Drawn as text when the image is missing.
        name: String,
        url: String,
        /// Zero-width 7TV overlays painted in the same box (plan 089).
        overlays: Vec<String>,
    },
}

/// `highlightTokens`: fragments with images become emotes (zero-width
/// overlays folded onto the emote before them), the rest words; `text` when
/// no fragment carries an image. A Twitch GIF is never painted: the card
/// says `GIF: <title>` in its place.
pub(crate) fn tokens(text: &str, fragments: Option<&[LiveChatMessageFragment]>) -> Vec<Token> {
    let Some(fragments) = fragments else {
        return words(text);
    };
    let has_gif = fragments
        .iter()
        .any(|fragment| fragment.fragment_type == "gif");
    let drawable: Vec<(String, Option<&str>, bool)> = fragments
        .iter()
        .map(|fragment| {
            if has_gif && fragment.fragment_type == "gif" {
                (
                    format!(" GIF: {} ", crate::twitch_chat::gif_title(&fragment.text)),
                    None,
                    false,
                )
            } else {
                (
                    fragment.text.clone(),
                    fragment.image_url.as_deref(),
                    fragment.zero_width,
                )
            }
        })
        .collect();
    if !drawable.iter().any(|(_, image, _)| image.is_some()) {
        if has_gif {
            let joined: String = drawable.iter().map(|(text, _, _)| text.as_str()).collect();
            return words(&joined);
        }
        return words(text);
    }
    let mut tokens = Vec::new();
    for piece in group_emote_overlays(&drawable) {
        match piece {
            Piece::Text(text) => tokens.extend(words(text)),
            Piece::Emote {
                name,
                url,
                overlays,
            } => tokens.push(Token::Emote {
                name: name.to_string(),
                url: url.to_string(),
                overlays: overlays.into_iter().map(str::to_string).collect(),
            }),
        }
    }
    tokens
}

fn words(text: &str) -> Vec<Token> {
    text.split_whitespace()
        .map(|word| Token::Word(word.to_string()))
        .collect()
}

enum Piece<'a> {
    Text(&'a str),
    Emote {
        name: &'a str,
        url: &'a str,
        overlays: Vec<&'a str>,
    },
}

/// `groupEmoteOverlays`: each zero-width emote folds onto the emote before
/// it, dropping the whitespace between; one with no emote before it is
/// drawn inline.
fn group_emote_overlays<'a>(fragments: &'a [(String, Option<&'a str>, bool)]) -> Vec<Piece<'a>> {
    let mut pieces: Vec<Piece<'a>> = Vec::new();
    let mut gap: Vec<&'a str> = Vec::new();
    let mut last_emote: Option<usize> = None;
    for (text, image, zero_width) in fragments {
        let Some(url) = image else {
            if last_emote.is_some() && text.trim().is_empty() {
                gap.push(text);
                continue;
            }
            pieces.extend(gap.drain(..).map(Piece::Text));
            pieces.push(Piece::Text(text));
            last_emote = None;
            continue;
        };
        if *zero_width
            && let Some(index) = last_emote
            && let Some(Piece::Emote { overlays, .. }) = pieces.get_mut(index)
        {
            overlays.push(url);
            gap.clear();
            continue;
        }
        pieces.extend(gap.drain(..).map(Piece::Text));
        pieces.push(Piece::Emote {
            name: text,
            url,
            overlays: Vec::new(),
        });
        last_emote = Some(pieces.len() - 1);
    }
    pieces.extend(gap.drain(..).map(Piece::Text));
    pieces
}

/// `highlightEmoteUrls`: the distinct image URLs a card would paint, each
/// emote's base then its overlays, at most `MAX_EMOTES`.
pub(crate) fn emote_urls(tokens: &[Token]) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for token in tokens {
        let Token::Emote { url, overlays, .. } = token else {
            continue;
        };
        for url in std::iter::once(url).chain(overlays) {
            if urls.len() >= MAX_EMOTES {
                return urls;
            }
            if !urls.contains(url) {
                urls.push(url.clone());
            }
        }
    }
    urls
}

/// `highlightEmoteImageUrl`: the card asks Twitch for its 112 px emote
/// (`/3.0`) instead of the chat row's 28 px one.
pub(crate) fn emote_image_url(url: &str) -> String {
    const PREFIX: &str = "https://static-cdn.jtvnw.net/emoticons/v2/";
    if let Some(rest) = url.strip_prefix(PREFIX)
        && let Some(head) = rest.strip_suffix("/1.0")
    {
        let parts: Vec<&str> = head.split('/').collect();
        if parts.len() == 3 && parts.iter().all(|part| !part.is_empty()) {
            return format!("{PREFIX}{head}/3.0");
        }
    }
    url.to_string()
}

/// A placed item on a message line (`PlacedHighlightItem`).
#[derive(Clone, Debug)]
pub(crate) enum Item {
    Word {
        text: String,
        x_px: f64,
        width_px: f64,
    },
    Emote {
        url: String,
        overlays: Vec<String>,
        x_px: f64,
        width_px: f64,
        height_px: f64,
    },
}

impl Item {
    fn x_px(&self) -> f64 {
        match self {
            Self::Word { x_px, .. } | Self::Emote { x_px, .. } => *x_px,
        }
    }

    fn width_px(&self) -> f64 {
        match self {
            Self::Word { width_px, .. } | Self::Emote { width_px, .. } => *width_px,
        }
    }

    fn with_x(mut self, x: f64) -> Self {
        match &mut self {
            Self::Word { x_px, .. } | Self::Emote { x_px, .. } => *x_px = x,
        }
        self
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Line {
    pub items: Vec<Item>,
    pub width_px: f64,
}

/// `highlightEmoteBox`: the card's emote height, the width from the decoded
/// aspect, capped for wide emotes.
fn emote_box(size: (u32, u32), text_font_px: f64) -> Option<(f64, f64)> {
    let (width, height) = size;
    if width == 0 || height == 0 {
        return None;
    }
    let height_px = js_round(text_font_px * EMOTE_HEIGHT_FACTOR);
    let aspect = (f64::from(width) / f64::from(height)).min(EMOTE_MAX_ASPECT);
    Some((js_round(height_px * aspect).max(1.0), height_px))
}

/// `wrapHighlightTokens`: greedy, each token measured on its own and one
/// measured space apart, at most three lines, the head kept with a trailing
/// ellipsis on the cut line. An emote whose image did not load is laid out
/// as its name.
pub(crate) fn wrap_tokens(
    tokens: &[Token],
    text_font_px: f64,
    max_width_px: f64,
    emotes: &DecodedImages,
) -> Vec<Line> {
    let font = Font::new(text_font_px as f32, TEXT_WEIGHT);
    // #1281: a word wider than the line (a pasted link) is cut to the
    // line's width with an ellipsis, never squeezed.
    let word = |text: &str| {
        let (text, width_px) = truncate_word(text, max_width_px, font);
        Item::Word {
            text,
            x_px: 0.0,
            width_px,
        }
    };
    let measured: Vec<Item> = tokens
        .iter()
        .map(|token| match token {
            Token::Word(text) => word(text),
            Token::Emote {
                name,
                url,
                overlays,
            } => match emotes
                .get(url)
                .and_then(|image| emote_box((image.width(), image.height()), text_font_px))
            {
                Some((width_px, height_px)) => Item::Emote {
                    url: url.clone(),
                    overlays: overlays.clone(),
                    x_px: 0.0,
                    width_px,
                    height_px,
                },
                None => word(name),
            },
        })
        .collect();
    if measured.is_empty() {
        return Vec::new();
    }
    let space_px = measure(" ", font);
    let place = |line: &mut Line, item: Item| {
        let x_px = if line.items.is_empty() {
            0.0
        } else {
            line.width_px + space_px
        };
        line.width_px = x_px + item.width_px();
        line.items.push(item.with_x(x_px));
    };
    let mut lines: Vec<Line> = Vec::new();
    let mut current = Line::default();
    let mut overflow = false;
    for item in measured {
        let fits = current.items.is_empty()
            || current.width_px + space_px + item.width_px() <= max_width_px;
        if fits {
            place(&mut current, item);
            continue;
        }
        lines.push(std::mem::take(&mut current));
        if lines.len() == MAX_TEXT_LINES {
            overflow = true;
            break;
        }
        place(&mut current, item);
    }
    if !overflow {
        lines.push(current);
        return lines;
    }
    let cut = lines.pop().unwrap_or_default();
    lines.push(ellipsize(cut, font, max_width_px, space_px));
    lines
}

/// `ellipsize`: a trailing ellipsis on the cut line, glued to a final word or
/// its own item after a final emote; items leave the end until it fits.
fn ellipsize(line: Line, font: Font, max_width_px: f64, space_px: f64) -> Line {
    let ellipsis_px = measure("…", font);
    let mut items = line.items;
    while let Some(last) = items.last() {
        match last {
            Item::Word { text, x_px, .. } => {
                // #1281: an ellipsis already there is not doubled.
                let text = if text.ends_with('…') {
                    text.clone()
                } else {
                    format!("{text}…")
                };
                let width_px = measure(&text, font);
                let x_px = *x_px;
                if x_px + width_px <= max_width_px {
                    let index = items.len() - 1;
                    items[index] = Item::Word {
                        text,
                        x_px,
                        width_px,
                    };
                    return Line {
                        items,
                        width_px: x_px + width_px,
                    };
                }
                if items.len() == 1 {
                    // A lone word on the cut line is cut to fit, never squeezed.
                    let (text, width_px) = truncate_word(&text, max_width_px - x_px, font);
                    items[0] = Item::Word {
                        text,
                        x_px,
                        width_px,
                    };
                    return Line {
                        items,
                        width_px: x_px + width_px,
                    };
                }
            }
            Item::Emote { .. } => {
                let x_px = last.x_px() + last.width_px() + space_px;
                if x_px + ellipsis_px <= max_width_px || items.len() == 1 {
                    items.push(Item::Word {
                        text: "…".to_string(),
                        x_px,
                        width_px: ellipsis_px,
                    });
                    return Line {
                        items,
                        width_px: x_px + ellipsis_px,
                    };
                }
            }
        }
        items.pop();
    }
    Line {
        items: vec![Item::Word {
            text: "…".to_string(),
            x_px: 0.0,
            width_px: ellipsis_px,
        }],
        width_px: ellipsis_px,
    }
}

/// The glass plate: shadowed fill, sheen, hairline (the caption bar's recipe).
/// The chat box draws it without the shadow.
pub(crate) fn paint_glass(
    target: &mut Pixmap,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    radius: f32,
    shadow: Option<Shadow>,
) {
    let Some(plate) = canvas::round_rect(x, y, w, h, radius) else {
        return;
    };
    canvas::with_shadow(target, shadow, |layer, dx, dy| {
        canvas::fill_path(layer, &plate, &Fill::Color(GLASS_FILL), dx, dy);
    });
    canvas::fill_path(
        target,
        &plate,
        &Fill::VerticalGradient {
            y0: y,
            y1: y + h,
            stops: &GLASS_SHEEN,
        },
        0.0,
        0.0,
    );
    if let Some(hairline) = canvas::round_rect(x + 0.5, y + 0.5, w - 1.0, h - 1.0, radius) {
        canvas::stroke_path(
            target,
            &hairline,
            StrokeStyle::new(GLASS_HAIRLINE, 1.0),
            0.0,
            0.0,
        );
    }
}

/// `paintPlatformBadge`: the brand circle with a light ring and the glyph.
pub(crate) fn paint_badge(target: &mut Pixmap, badge: Badge, x: f32, y: f32, size: f32) {
    let (cx, cy) = (x + size / 2.0, y + size / 2.0);
    if let Some(disc) = canvas::circle(cx, cy, size / 2.0) {
        canvas::fill_path(target, &disc, &Fill::Color(badge.color), 0.0, 0.0);
        canvas::stroke_path(
            target,
            &disc,
            StrokeStyle::new(
                Rgba::new(255, 255, 255, 0.28),
                js_round(f64::from(size) * 0.06).max(1.0) as f32,
            ),
            0.0,
            0.0,
        );
    }
    let ink = StrokeStyle::new(badge.ink, (size * 0.1).max(1.5)).round();
    match badge.glyph {
        Glyph::Kick => {
            let path = canvas::polyline(&[
                &[
                    (cx - size * 0.14, cy - size * 0.22),
                    (cx - size * 0.14, cy + size * 0.22),
                ],
                &[
                    (cx + size * 0.16, cy - size * 0.22),
                    (cx - size * 0.1, cy),
                    (cx + size * 0.16, cy + size * 0.22),
                ],
            ]);
            if let Some(path) = path {
                canvas::stroke_path(target, &path, ink, 0.0, 0.0);
            }
        }
        Glyph::Twitch => {
            // `strokeRect` takes the context's round joins.
            if let Some(path) =
                canvas::rect(cx - size * 0.2, cy - size * 0.2, size * 0.4, size * 0.34)
            {
                canvas::stroke_path(target, &path, ink.round_join(), 0.0, 0.0);
            }
            if let Some(path) = canvas::polyline(&[&[
                (cx - size * 0.06, cy + size * 0.14),
                (cx - size * 0.14, cy + size * 0.24),
            ]]) {
                canvas::stroke_path(target, &path, ink, 0.0, 0.0);
            }
        }
        Glyph::Dot => {
            if let Some(dot) = canvas::circle(cx, cy, size * 0.12) {
                canvas::fill_path(target, &dot, &Fill::Color(badge.ink), 0.0, 0.0);
            }
        }
    }
}

/// `monogramInitials`: the first letters of the first two words, upper
/// case. A leading symbol is skipped (`@ramxcodes` is R, not @: YouTube
/// handles start with one); a word of symbols alone (an emoji) keeps its
/// first glyph (#1281).
pub(crate) fn monogram(name: &str) -> String {
    let initials: String = name
        .split_whitespace()
        .take(2)
        .filter_map(|word| {
            word.chars()
                .find(|c| c.is_alphanumeric())
                .or_else(|| word.chars().next())
        })
        .flat_map(char::to_uppercase)
        .collect();
    if initials.is_empty() {
        "?".to_string()
    } else {
        initials
    }
}

/// The circle the avatar is clipped to (`ctx.arc(...)`, `ctx.clip()`).
fn avatar_clip(target: &Pixmap, x: f32, y: f32, size: f32) -> Option<Mask> {
    let disc = canvas::circle(x + size / 2.0, y + size / 2.0, size / 2.0)?;
    let mut clip = Mask::new(target.width(), target.height())?;
    clip.fill_path(
        &disc,
        tiny_skia::FillRule::Winding,
        true,
        Transform::identity(),
    );
    Some(clip)
}

/// The avatar: the viewer's picture clipped to the circle, or (no picture)
/// the monogram, a faint disc and the initials.
pub(crate) fn paint_avatar(
    target: &mut Pixmap,
    picture: Option<&images::DecodedImage>,
    author_name: &str,
    x: f32,
    y: f32,
    size: f32,
) {
    let Some(clip) = avatar_clip(target, x, y, size) else {
        return;
    };
    if let Some(picture) = picture {
        images::draw_image(target, picture, x, y, size, size, Some(&clip), 0.0, 0.0);
        return;
    }
    let Some(disc) = canvas::circle(x + size / 2.0, y + size / 2.0, size / 2.0) else {
        return;
    };
    let Some(mut layer) = Pixmap::new(target.width(), target.height()) else {
        return;
    };
    canvas::fill_path(
        &mut layer,
        &disc,
        &Fill::Color(Rgba::new(255, 255, 255, 0.12)),
        0.0,
        0.0,
    );
    text::fill_text(
        &mut layer,
        &monogram(author(author_name)),
        Font::new(js_round(f64::from(size) * 0.42) as f32, 600),
        TextPlacement {
            x: x + size / 2.0,
            y: y + size / 2.0 + 1.0,
            align: Align::Center,
            baseline: Baseline::Middle,
            max_width: None,
        },
        Rgba::hex(0xA1A1AA),
        0.0,
        0.0,
    );
    layer.apply_mask(&clip);
    target.draw_pixmap(
        0,
        0,
        layer.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        None,
    );
}

/// The message text shadow of both painters.
pub(crate) fn text_shadow(text_font_px: f64) -> Shadow {
    Shadow {
        color: Rgba::new(0, 0, 0, 0.45),
        blur: (text_font_px * 0.08) as f32,
        offset_x: 0.0,
        offset_y: js_round(text_font_px * 0.03).max(1.0) as f32,
    }
}

/// The message lines: consecutive words painted as one `fillText` run (the
/// font's own spacing and kerning), top-aligned, each squeezed into what is
/// left of the line; each emote's image (and its zero-width overlays) in its
/// box, centred on the glyphs' axis. All under the text shadow.
#[allow(clippy::too_many_arguments)]
pub(crate) fn paint_lines(
    target: &mut Pixmap,
    lines: &[Line],
    x: f64,
    top: f64,
    text_font_px: f64,
    line_height_px: f64,
    max_text_width_px: f64,
    emotes: &DecodedImages,
) {
    let font = Font::new(text_font_px as f32, TEXT_WEIGHT);
    let shadow = text_shadow(text_font_px);
    let emote_axis_px = text_font_px * EMOTE_AXIS_EM;
    let flush = |target: &mut Pixmap, run: &mut Option<(f64, Vec<&str>)>, line_top: f64| {
        let Some((run_x, words)) = run.take() else {
            return;
        };
        let text = words.join(" ");
        let place = TextPlacement {
            x: (x + run_x) as f32,
            y: line_top as f32,
            align: Align::Left,
            baseline: Baseline::Top,
            max_width: Some((max_text_width_px - run_x) as f32),
        };
        canvas::with_shadow(target, Some(shadow), |layer, dx, dy| {
            text::fill_text(layer, &text, font, place, TEXT_COLOR, dx, dy);
        });
    };
    for (index, line) in lines.iter().enumerate() {
        let line_top = top + line_height_px * index as f64;
        let mut run: Option<(f64, Vec<&str>)> = None;
        for item in &line.items {
            match item {
                Item::Word { text, x_px, .. } => match &mut run {
                    Some((_, words)) => words.push(text),
                    None => run = Some((*x_px, vec![text])),
                },
                Item::Emote {
                    url,
                    overlays,
                    x_px,
                    width_px,
                    height_px,
                } => {
                    flush(target, &mut run, line_top);
                    let box_x = (x + x_px) as f32;
                    let box_y = js_round(line_top + emote_axis_px - height_px / 2.0) as f32;
                    for url in std::iter::once(url).chain(overlays) {
                        let Some(image) = emotes.get(url) else {
                            continue;
                        };
                        canvas::with_shadow(target, Some(shadow), |layer, dx, dy| {
                            images::draw_image(
                                layer,
                                image,
                                box_x,
                                box_y,
                                *width_px as f32,
                                *height_px as f32,
                                None,
                                dx,
                                dy,
                            );
                        });
                    }
                }
            }
        }
        flush(target, &mut run, line_top);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment(
        kind: &str,
        text: &str,
        image: Option<&str>,
        zero_width: bool,
    ) -> LiveChatMessageFragment {
        LiveChatMessageFragment {
            fragment_type: kind.to_string(),
            text: text.to_string(),
            image_url: image.map(str::to_string),
            zero_width,
        }
    }

    #[test]
    fn the_monogram_takes_two_initials() {
        assert_eq!(monogram("night owl gaming"), "NO");
        assert_eq!(monogram("ömer"), "Ö");
        assert_eq!(monogram("  "), "?");
        // #1281: a leading symbol is skipped; a word of symbols keeps its glyph.
        assert_eq!(monogram("@ramxcodes"), "R");
        assert_eq!(monogram("🔥 fire"), "🔥F");
    }

    #[test]
    fn the_identity_names_the_platform_unless_its_mark_shows() {
        assert_eq!(identity("  ", StreamPlatform::Kick, false), "Kick · Viewer");
        assert_eq!(
            identity("Mira", StreamPlatform::Custom, false),
            "Custom · Mira"
        );
        assert_eq!(
            identity("Mira", StreamPlatform::Youtube, false),
            "YouTube · Mira"
        );
        assert_eq!(identity("Mira", StreamPlatform::Youtube, true), "Mira");
        assert_eq!(identity("Mira", StreamPlatform::X, true), "Mira");
        // A mark is only YouTube's or X's.
        assert_eq!(
            identity("Mira", StreamPlatform::Twitch, true),
            "Twitch · Mira"
        );
        assert_eq!(identity("Mira", StreamPlatform::Facebook, false), "Mira");
    }

    #[test]
    fn fragments_become_words_and_emotes_with_overlays_folded() {
        let fragments = [
            fragment("text", "hi ", None, false),
            fragment(
                "emote",
                "catJAM",
                Some("https://cdn.7tv.app/emote/a/2x.webp"),
                false,
            ),
            fragment("text", " ", None, false),
            fragment(
                "emote",
                "RainTime",
                Some("https://cdn.7tv.app/emote/b/2x.webp"),
                true,
            ),
            fragment("text", " ok", None, false),
        ];
        assert_eq!(
            tokens("ignored", Some(&fragments)),
            vec![
                Token::Word("hi".to_string()),
                Token::Emote {
                    name: "catJAM".to_string(),
                    url: "https://cdn.7tv.app/emote/a/2x.webp".to_string(),
                    overlays: vec!["https://cdn.7tv.app/emote/b/2x.webp".to_string()],
                },
                Token::Word("ok".to_string()),
            ]
        );
        // A zero-width emote first, or after a word, is drawn inline.
        let lonely = [fragment(
            "emote",
            "RainTime",
            Some("https://cdn.7tv.app/emote/b/2x.webp"),
            true,
        )];
        assert!(matches!(
            tokens("", Some(&lonely)).as_slice(),
            [Token::Emote { overlays, .. }] if overlays.is_empty()
        ));
        // No images: the text, word by word.
        let plain = [fragment("text", "a  b", None, false)];
        assert_eq!(
            tokens("x y", Some(&plain)),
            vec![Token::Word("x".to_string()), Token::Word("y".to_string())]
        );
    }

    #[test]
    fn a_gif_is_its_title_never_its_image() {
        let fragments = [
            fragment("text", "look", None, false),
            fragment(
                "gif",
                "[Y A Y Yes GIF]",
                Some("https://media0.giphy.com/a.gif"),
                false,
            ),
        ];
        assert_eq!(
            tokens("look [Y A Y Yes GIF]", Some(&fragments)),
            ["look", "GIF:", "Y", "A", "Y", "Yes"]
                .map(|word| Token::Word(word.to_string()))
                .to_vec()
        );
    }

    #[test]
    fn the_card_asks_twitch_for_its_large_emote() {
        assert_eq!(
            emote_image_url("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"),
            "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0"
        );
        for kept in [
            "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
            "https://files.kick.com/emotes/1/fullsize",
            "https://static-cdn.jtvnw.net/emoticons/v2/25/dark/1.0",
        ] {
            assert_eq!(emote_image_url(kept), kept);
        }
    }

    #[test]
    fn at_most_twenty_emote_images_load() {
        let tokens: Vec<Token> = (0..30)
            .map(|index| Token::Emote {
                name: format!("e{index}"),
                url: format!("https://cdn.7tv.app/emote/{index}/2x.webp"),
                overlays: Vec::new(),
            })
            .collect();
        let urls = emote_urls(&tokens);
        assert_eq!(urls.len(), 20);
        assert_eq!(urls[0], "https://cdn.7tv.app/emote/0/2x.webp");
    }

    /// #1281: a word wider than the line keeps its head behind an ellipsis
    /// and is never squeezed; one that fits is untouched; an ellipsis already
    /// there is not doubled.
    #[test]
    fn an_over_wide_word_is_cut_with_an_ellipsis() {
        let font = Font::new(20.0, TEXT_WEIGHT);
        let (text, width) = truncate_word("hello", 10_000.0, font);
        assert_eq!((text.as_str(), width), ("hello", measure("hello", font)));
        let link = "https://example.com/a/very/long/path/that/never/ends/".repeat(3);
        let (cut, width) = truncate_word(&link, 200.0, font);
        assert!(cut.ends_with('…'));
        assert!(cut.chars().count() < link.chars().count());
        assert!(width <= 200.0);
        assert!(!cut.ends_with("……"));
        let (again, _) = truncate_word(&cut, 200.0, font);
        assert_eq!(again, cut);
        let lines = wrap_tokens(
            &[Token::Word(link.clone())],
            20.0,
            200.0,
            &DecodedImages::default(),
        );
        assert_eq!(lines.len(), 1);
        assert!(lines[0].width_px <= 200.0);
    }
}
