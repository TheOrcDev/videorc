//! The bubble sample (`buddy-bubble-sample.tsx`) and its zoom (the "Bubble"
//! dialog in `buddy-persona-section.tsx`): the stream's own bubble painter
//! draws the sample line (`buddy.bubble.render`), and the page stands the
//! talk pose under it, as the composite on stream does. Zoomed, it is drawn
//! again on a canvas twice the size, never a small bitmap scaled up.

use std::sync::Arc;

use gpui::{AnyElement, Context, Image, ImageFormat, ImageSource, ObjectFit, SharedString, Window};
use gpui::{div, img, prelude::*, px};
use serde_json::{Value, json};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::persona::bubble_word;
use videorc_app_core::captions::decode_base64;
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::skeleton::Skeleton;
use videorc_kit::theme::{self, hsla};
use videorc_kit::tokens::radius;
use videorc_protocol::cohost::CohostBubbleStyle;

use super::{AvatarScreen, pictures, sync_handle};

/// `BUDDY_BUBBLE_SAMPLE_CANVAS` and `BUDDY_BUBBLE_SAMPLE_ZOOM`.
const CANVAS: (u32, u32) = (1920, 1080);
const ZOOM: u32 = 2;
/// The avatar's default rect on a landscape stream
/// (`DEFAULT_OVERLAY_LAYOUT.buddy.horizontal`: bottom right, 4% margins,
/// 0.18 wide; the backend's `overlay_snap_rect`).
const SAMPLE_RECT: [f64; 4] = [0.78, 0.64, 0.18, 0.32];
/// The inline sample's box (`h-40 w-36`) and the zoom's (`h-112`).
const INLINE_BOX: (f32, f32) = (144., 160.);
const ZOOM_HEIGHT: f32 = 448.;

/// One drawn bubble: what it was drawn for, and the picture.
#[derive(Clone)]
struct Drawn {
    key: (String, bool),
    image: Arc<Image>,
    size: (u32, u32),
}

pub(super) struct Bubbles {
    inline: Option<Drawn>,
    zoomed: Option<Drawn>,
    /// Requests in flight, by key.
    asked: Vec<(String, bool)>,
    zoom_handle: DialogHandle,
    zoom_want_open: bool,
    zoom_was_open: bool,
}

impl Bubbles {
    pub(super) fn new() -> Self {
        Self {
            inline: None,
            zoomed: None,
            asked: Vec::new(),
            zoom_handle: DialogHandle::new(false),
            zoom_want_open: false,
            zoom_was_open: false,
        }
    }
}

/// `buddyOverlayMetrics`' two numbers the composite needs: the avatar's
/// side and the pad under the bubble, on the sample's canvas.
fn metrics(zoomed: bool) -> (f64, f64) {
    let scale = if zoomed { ZOOM } else { 1 };
    let (width, height) = (CANVAS.0 * scale, CANVAS.1 * scale);
    let long_edge = f64::from(width.max(height).max(1));
    let font = (long_edge * 18.0 / 1920.0).round().max(14.0);
    let pad = (font * 0.6).round();
    let avatar = (SAMPLE_RECT[2] * f64::from(width))
        .min(f64::from(width))
        .floor()
        .max(1.0);
    (avatar, pad)
}

impl AvatarScreen {
    fn bubble_key(&self) -> Option<String> {
        let persona = self.persona.as_ref()?;
        Some(format!(
            "{}\u{1f}{}",
            bubble_word(persona.bubble_style),
            persona.name
        ))
    }

    /// Asks the backend for the sample when its line or style changed.
    pub(super) fn ensure_bubble(&mut self, zoomed: bool, cx: &mut Context<Self>) {
        let (Some(key), Some(persona)) = (self.bubble_key(), self.persona.as_ref()) else {
            return;
        };
        let key = (key, zoomed);
        let drawn = if zoomed {
            &self.bubbles.zoomed
        } else {
            &self.bubbles.inline
        };
        if drawn.as_ref().is_some_and(|drawn| drawn.key == key) || self.bubbles.asked.contains(&key)
        {
            return;
        }
        self.bubbles.asked.push(key.clone());
        let scale = if zoomed { ZOOM } else { 1 };
        let params = json!({
            "text": words::bubble_sample_line(&persona.name),
            "style": bubble_word(persona.bubble_style),
            "canvasWidth": CANVAS.0 * scale,
            "canvasHeight": CANVAS.1 * scale,
            "rect": { "x": SAMPLE_RECT[0], "y": SAMPLE_RECT[1], "w": SAMPLE_RECT[2], "h": SAMPLE_RECT[3] },
        });
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("buddy.bubble.render", params).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await.ok().and_then(Result::ok);
            let drawn = answer.and_then(|png| drawn_from(&png, key.clone()));
            let _ = this.update(cx, |screen, cx| {
                screen.bubbles.asked.retain(|asked| *asked != key);
                if let Some(drawn) = drawn {
                    if key.1 {
                        screen.bubbles.zoomed = Some(drawn);
                    } else {
                        screen.bubbles.inline = Some(drawn);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn open_bubble_zoom(&mut self, cx: &mut Context<Self>) {
        self.bubbles.zoom_want_open = true;
        self.ensure_bubble(true, cx);
        cx.notify();
    }

    pub(super) fn sync_bubble_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        sync_handle(
            &self.bubbles.zoom_handle,
            &mut self.bubbles.zoom_want_open,
            &mut self.bubbles.zoom_was_open,
            window,
            cx,
        );
    }

    /// The talk pose the sample stands under (`buddyStateImageUrl(…, 'talk')`):
    /// the avatar's own, its idle, else the default pack's.
    fn talk_picture(&self) -> Option<ImageSource> {
        let persona = self.persona.as_ref()?;
        let own = persona
            .images
            .talk
            .as_deref()
            .or(persona.images.idle.as_deref())
            .and_then(|picture| pictures::managed_path(&self.user_data_dir, picture));
        match own {
            Some(path) => Some(path.into()),
            None => pictures::default_state("talk").map(Into::into),
        }
    }
}

fn drawn_from(png: &Value, key: (String, bool)) -> Option<Drawn> {
    let bytes = decode_base64(png.get("pngBase64")?.as_str()?)?;
    let width = u32::try_from(png.get("width")?.as_u64()?).ok()?;
    let height = u32::try_from(png.get("height")?.as_u64()?).ok()?;
    Some(Drawn {
        key,
        image: Arc::new(Image::from_bytes(ImageFormat::Png, bytes)),
        size: (width, height),
    })
}

/// The composite in a box: the bubble on top, the talk pose under it, both
/// scaled as one picture and standing on the box's floor.
pub(super) fn sample(screen: &AvatarScreen, zoomed: bool, box_size: (f32, f32)) -> AnyElement {
    let drawn = if zoomed {
        screen.bubbles.zoomed.as_ref()
    } else {
        screen.bubbles.inline.as_ref()
    };
    let current = screen.bubble_key();
    let Some(drawn) = drawn.filter(|drawn| Some(&drawn.key.0) == current.as_ref()) else {
        return Skeleton::new(if zoomed {
            "avatar-bubble-sample-zoomed-loading"
        } else {
            "avatar-bubble-sample-loading"
        })
        .w(px(box_size.0 * 0.75))
        .h(px(box_size.1))
        .rounded(px(radius::ROW))
        .into_any_element();
    };
    let (avatar, pad) = metrics(zoomed);
    let total_w = f64::from(drawn.size.0);
    let total_h = f64::from(drawn.size.1) + avatar + pad;
    let scale = (f64::from(box_size.0) / total_w).min(f64::from(box_size.1) / total_h);
    let at = |value: f64| px((value * scale) as f32);
    let mut picture = div().relative().w(at(total_w)).h(at(total_h)).child(
        img(drawn.image.clone())
            .absolute()
            .top_0()
            .left_0()
            .w(at(total_w))
            .h(at(f64::from(drawn.size.1)))
            .object_fit(ObjectFit::Fill),
    );
    if let Some(talk) = screen.talk_picture() {
        picture = picture.child(
            img(talk)
                .absolute()
                .left(at(pad))
                .top(at(f64::from(drawn.size.1)))
                .size(at(avatar))
                .object_fit(ObjectFit::Contain),
        );
    }
    div()
        .flex()
        .items_end()
        .justify_center()
        .w(px(box_size.0))
        .h(px(box_size.1))
        .child(picture)
        .into_any_element()
}

/// The inline sample, beside the style picker.
pub(super) fn inline_sample(screen: &AvatarScreen) -> AnyElement {
    sample(screen, false, INLINE_BOX)
}

/// "Bubble" (lg): the picker again, and the sample drawn at twice the size.
pub(super) fn zoom_dialog(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let Some(persona) = screen.persona.as_ref() else {
        return div().into_any_element();
    };
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let mut picker = style_picker("avatar-bubble-zoom-style", persona.bubble_style, entity);
    picker = picker.accessibility_label(words::BUBBLE_STYLE_LABEL);
    Dialog::new(
        "avatar-bubble-zoom",
        &screen.bubbles.zoom_handle,
        words::BUBBLE_LABEL,
    )
    .description(words::bubble_zoom_description(&persona.name))
    .size(DialogSize::Lg)
    .child(
        div().flex().flex_col().gap(px(12.)).child(picker).child(
            div()
                .flex()
                .items_end()
                .justify_center()
                .h(px(ZOOM_HEIGHT))
                .p(px(12.))
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.inset))
                .child(sample(screen, true, (512., ZOOM_HEIGHT - 24.))),
        ),
    )
    .into_any_element()
}

/// Speech, Thought or Shout: beside the sample, and again in its zoom.
pub(super) fn style_picker(
    id: &'static str,
    style: CohostBubbleStyle,
    entity: gpui::Entity<AvatarScreen>,
) -> SegmentedControl {
    // `w-fit`: the strip hugs its words beside the sample.
    let mut picker = SegmentedControl::new(id)
        .small(true)
        .fit(true)
        .value(Some(bubble_word(style)))
        .on_change(move |value: SharedString, _, cx| {
            let index = words::BUBBLE_STYLES
                .iter()
                .position(|(id, _)| *id == value.as_ref())
                .unwrap_or(0);
            entity.update(cx, |screen, cx| screen.set_bubble(index, cx));
        });
    for (id, label) in words::BUBBLE_STYLES {
        picker = picker.option(Segment::new(id, label));
    }
    picker
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sample_measures_as_the_stream_does() {
        // 1920 wide: 18 px type, an 11 px pad, a 345 px avatar.
        assert_eq!(metrics(false), (345.0, 11.0));
        // Twice the canvas: 36 px type, a 22 px pad, a 691 px avatar.
        assert_eq!(metrics(true), (691.0, 22.0));
    }
}
