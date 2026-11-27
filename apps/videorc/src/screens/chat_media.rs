//! Chat row pictures (P198): avatars, emotes and Twitch GIFs through the
//! backend's `chatImages.cache` route, as Electron's `useCachedAvatar` does.
//! Studio and Stream Manager share the cache and the message-body drawing.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    AnyElement, Image, ImageFormat, ImageSource, IntoElement, ObjectFit, div, img, prelude::*, px,
};
use videorc_app_core::chat::images::{self, ImageKind};
use videorc_app_core::stream_manager::rows::{Gif, Piece};
use videorc_kit::badge::{Badge, BadgeVariant};

/// A cached chat picture: loading, ready, or refused.
#[derive(Clone)]
pub enum Picture {
    Loading,
    Ready(Arc<Image>),
    /// Decoded route data used by Stream Manager and its paint evidence.
    Decoded {
        image: Arc<gpui::RenderImage>,
        route: String,
    },
    Failed,
}

impl Picture {
    pub fn ready(&self) -> Option<ImageSource> {
        match self {
            Self::Ready(image) => Some(image.clone().into()),
            Self::Decoded { image, .. } => Some(image.clone().into()),
            Self::Loading | Self::Failed => None,
        }
    }
}

/// Decode route bytes into a [`Picture`].
pub fn picture_from_bytes(bytes: Vec<u8>) -> Picture {
    match images::image_kind(&bytes) {
        Some(kind) => {
            let format = match kind {
                ImageKind::Png => ImageFormat::Png,
                ImageKind::Jpeg => ImageFormat::Jpeg,
                ImageKind::Gif => ImageFormat::Gif,
                ImageKind::Webp => ImageFormat::Webp,
            };
            Picture::Ready(Arc::new(Image::from_bytes(format, bytes)))
        }
        None => Picture::Failed,
    }
}

/// Decode with GPUI's own decoder off the UI thread. Retain the authenticated
/// local route that supplied these exact bytes, never the remote CDN URL.
pub fn decoded_picture(bytes: Vec<u8>, route: String, renderer: gpui::SvgRenderer) -> Picture {
    let Picture::Ready(image) = picture_from_bytes(bytes) else {
        return Picture::Failed;
    };
    match image.to_image_data(renderer) {
        Ok(image) if image.frame_count() > 0 => Picture::Decoded { image, route },
        _ => Picture::Failed,
    }
}

/// Which `chatImages.cache` kind to ask for.
pub fn cache_kind_for_url(url: &str, as_gif: bool) -> &'static str {
    if as_gif {
        "gif"
    } else {
        let _ = url;
        "avatar"
    }
}

/// Emote / GIF / text pieces for a chat row (Electron `CommentMessageBody`).
pub fn message_body(
    pieces: &[Piece],
    gifs: &[Gif],
    pictures: &HashMap<String, Picture>,
    text_px: f32,
    // Studio compact = 64 px GIF slot; Stream Manager comfortable = 96 px.
    gif_height_px: f32,
) -> AnyElement {
    message_body_observed(pieces, gifs, pictures, text_px, gif_height_px, None)
}

pub type ImageObserver<'a> = dyn Fn(&str, &'static str, AnyElement) -> AnyElement + 'a;

pub fn message_body_observed(
    pieces: &[Piece],
    gifs: &[Gif],
    pictures: &HashMap<String, Picture>,
    text_px: f32,
    gif_height_px: f32,
    observer: Option<&ImageObserver<'_>>,
) -> AnyElement {
    let mut line = div()
        .flex()
        .flex_wrap()
        .items_end()
        .gap(px(2.))
        .min_w(px(0.));
    for piece in pieces {
        match piece {
            Piece::Text(words) => {
                line = line.child(
                    div()
                        .text_size(px(text_px))
                        .line_height(px(text_px + 5.))
                        .child(words.clone()),
                );
            }
            Piece::Link(link) => {
                line = line.child(
                    div()
                        .text_size(px(text_px))
                        .underline()
                        .child(link.text.clone()),
                );
            }
            Piece::Emote {
                text,
                url,
                overlays,
            } => {
                line = line.child(emote_stack(
                    text, url, overlays, pictures, text_px, observer,
                ));
            }
        }
    }
    let mut col = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .min_w(px(0.))
        .child(line);
    for gif in gifs {
        let element = gif_block(gif, pictures, gif_height_px);
        col = col.child(observe(observer, &gif.url, "comment-gif-image", element));
    }
    col.into_any_element()
}

fn emote_stack(
    text: &str,
    url: &str,
    overlays: &[(String, String)],
    pictures: &HashMap<String, Picture>,
    height_px: f32,
    observer: Option<&ImageObserver<'_>>,
) -> AnyElement {
    let base = observe(
        observer,
        url,
        "comment-emote",
        emote_img(text, url, pictures, height_px),
    );
    if overlays.is_empty() {
        return base;
    }
    let mut stack = div().relative().flex_none().h(px(height_px)).child(base);
    for (_name, overlay_url) in overlays {
        if let Some(image) = pictures.get(overlay_url).and_then(Picture::ready) {
            stack = stack.child(
                div().absolute().inset_0().child(observe(
                    observer,
                    overlay_url,
                    "comment-emote",
                    img(ImageSource::from(image))
                        .h(px(height_px))
                        .w_auto()
                        .max_w(px(96.))
                        .object_fit(ObjectFit::Contain)
                        .into_any_element(),
                )),
            );
        }
    }
    stack.into_any_element()
}

fn emote_img(
    text: &str,
    url: &str,
    pictures: &HashMap<String, Picture>,
    height_px: f32,
) -> AnyElement {
    match pictures.get(url).and_then(Picture::ready) {
        Some(image) => img(ImageSource::from(image))
            .h(px(height_px))
            .w_auto()
            .max_w(px(96.))
            .object_fit(ObjectFit::Contain)
            .flex_none()
            .into_any_element(),
        None => div()
            .flex_none()
            .text_size(px(height_px * 0.85))
            .child(text.to_string())
            .into_any_element(),
    }
}

fn gif_block(gif: &Gif, pictures: &HashMap<String, Picture>, height_px: f32) -> AnyElement {
    let title = gif.title.clone();
    match pictures.get(&gif.url).and_then(Picture::ready) {
        Some(image) => div()
            .flex()
            .items_center()
            .h(px(height_px))
            .child(
                img(ImageSource::from(image))
                    .h_full()
                    .w_auto()
                    .max_w_full()
                    .object_fit(ObjectFit::Contain)
                    .rounded(px(videorc_kit::tokens::radius::CHIP)),
            )
            .into_any_element(),
        None => div()
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(height_px))
            .child(Badge::new("GIF").variant(BadgeVariant::Outline))
            .child(div().text_size(px(12.)).truncate().child(title))
            .into_any_element(),
    }
}

/// Every remote URL a row needs for emotes and GIFs.
pub fn media_urls(pieces: &[Piece], gifs: &[Gif]) -> Vec<(String, bool)> {
    let mut urls = Vec::new();
    for piece in pieces {
        if let Piece::Emote { url, overlays, .. } = piece {
            urls.push((url.clone(), false));
            for (_, overlay) in overlays {
                urls.push((overlay.clone(), false));
            }
        }
    }
    for gif in gifs {
        urls.push((gif.url.clone(), true));
    }
    urls
}

fn observe(
    observer: Option<&ImageObserver<'_>>,
    url: &str,
    slot: &'static str,
    element: AnyElement,
) -> AnyElement {
    match observer {
        Some(observe) => observe(url, slot, element),
        None => element,
    }
}
