//! The Profile tab's status row (`AvatarStatus`, `tabs/avatar-tab.tsx`):
//! the avatar's picture and name, where viewers see it, and the way to the
//! Scene page, where it is placed and switched on. The switches keep their
//! homes (the Scene canvas, the Stream Manager), so the row never holds a
//! third copy of them.

use gpui::{AnyElement, Context, ImageSource, ObjectFit, Window, div, img, prelude::*, px};
use serde_json::Value;
use videorc_app_core::buddy::copy as words;
use videorc_app_core::nav::PageId;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::theme::{self, hsla};
use videorc_kit::tokens::size;

use super::AvatarScreen;

/// The overlay item's two switches (`overlayLayout.buddy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Placement {
    pub show_on_stream: bool,
    pub show_in_recording: bool,
}

impl Placement {
    /// `overlays.layout.get`'s answer, or the `overlays.layout` push.
    pub fn from_layout(layout: &Value) -> Option<Self> {
        let buddy = layout.get("buddy")?;
        Some(Self {
            show_on_stream: buddy.get("showOnStream").and_then(Value::as_bool) == Some(true),
            show_in_recording: buddy.get("showInRecording").and_then(Value::as_bool) == Some(true),
        })
    }

    /// `avatarPlacementView`'s label: where viewers see the avatar.
    pub fn label(self) -> &'static str {
        match (self.show_on_stream, self.show_in_recording) {
            (true, true) => "On stream and in recordings",
            (true, false) => "On stream, not in recordings",
            (false, true) => "In recordings, not on stream",
            (false, false) => "Not on stream or in recordings",
        }
    }

    /// The dot: green while viewers see it, grey otherwise.
    pub fn tone(self) -> StatusTone {
        if self.show_on_stream {
            StatusTone::Good
        } else {
            StatusTone::Neutral
        }
    }
}

/// The emblem: 56 px (`BuddyEmblem size="lg"`, `h-14`).
const EMBLEM: f32 = 56.;

pub fn render_status(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let name = screen.display_name();
    // Until the backend answers, nothing claims the avatar is off stream.
    let placement = screen.placement.unwrap_or(Placement {
        show_on_stream: true,
        show_in_recording: true,
    });

    // `BuddyEmblem size="lg"`: 56 px tall. The default golem is the emblem
    // at its own width (`w-auto`); a picture of the avatar's own fits a
    // 56 px square (`aspect-square object-contain`).
    let (picture, width): (ImageSource, f32) = match screen.persona_picture() {
        Some(path) => (path.into(), EMBLEM),
        None => {
            let (w, h) = super::pictures::EMBLEM_LARGE_SIZE;
            (super::pictures::emblem_large().into(), EMBLEM * w / h)
        }
    };
    let emblem = div()
        .w(px(width))
        .h(px(EMBLEM))
        .flex_none()
        .child(img(picture).size_full().object_fit(ObjectFit::Contain));

    let shortcut = PageId::Layouts
        .key(true)
        .and_then(crate::app::menus::page_action)
        .map(|action| ShortcutKeys::for_action(action.as_ref()));
    let entity = cx.entity();
    // `SceneIcon` leads, the page's key closes it (`ml-0.5`).
    let place = Button::new("avatar-place-on-scene")
        .variant(ButtonVariant::Outline)
        .accessibility_label("Place on Scene")
        .child(icon(IconName::SquaresFour, 16., hsla(t.foreground)))
        .child("Place on Scene")
        .children(shortcut.map(|keys| div().ml(px(2.)).child(keys)))
        .on_click(move |_, window, cx| {
            entity.update(cx, |screen, cx| {
                screen.open_page(PageId::Layouts, window, cx)
            });
        });

    let row = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(12.))
        .child(emblem)
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w(px(0.))
                .gap(px(2.))
                .child(
                    div()
                        .truncate()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .child(name.clone()),
                )
                // The dot in its tone, and where viewers see the avatar in
                // 12 px / 500 primary text (`font-medium text-foreground`).
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.))
                        .child(StatusDot::new("avatar-placement").tone(placement.tone()))
                        .child(
                            div()
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(hsla(t.foreground))
                                .child(placement.label()),
                        ),
                ),
        )
        .child(place);

    let mut column = div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .p(px(size::GUTTER))
        .border_b_1()
        .border_color(hsla(t.border))
        .child(row);
    if !placement.show_on_stream {
        // Plan 174 G-2: nothing else says how an avatar gets on stream.
        column = column.child(
            Alert::new("avatar-on-stream-note")
                .variant(AlertVariant::Quiet)
                .title(words::on_stream_note(&name)),
        );
    }
    column.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_row_says_where_viewers_see_the_avatar() {
        let of = |stream, recording| Placement {
            show_on_stream: stream,
            show_in_recording: recording,
        };
        assert_eq!(of(true, true).label(), "On stream and in recordings");
        assert_eq!(of(true, false).label(), "On stream, not in recordings");
        assert_eq!(of(false, true).label(), "In recordings, not on stream");
        assert_eq!(of(false, false).label(), "Not on stream or in recordings");
        assert_eq!(of(true, false).tone(), StatusTone::Good);
        assert_eq!(of(false, true).tone(), StatusTone::Neutral);
    }

    #[test]
    fn the_layout_answer_carries_the_avatar_switches() {
        let layout = json!({ "buddy": { "showOnStream": false, "showInRecording": true } });
        assert_eq!(
            Placement::from_layout(&layout),
            Some(Placement {
                show_on_stream: false,
                show_in_recording: true
            })
        );
        assert_eq!(Placement::from_layout(&json!({})), None);
    }
}
