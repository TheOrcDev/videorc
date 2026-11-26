//! Test your avatar (`buddy-test-dialog.tsx`, plan 169 D14): a sandbox that
//! shows each state as the stream does, plays each of the pack's reactions,
//! and shows the sample bubble while Talking. Nothing here reaches the
//! stream, chat or the settings; the backend only draws its sample bubble.

use std::sync::Arc;

use gpui::{
    AnyElement, Context, Entity, Image, ImageFormat, KeyDownEvent, ObjectFit, SharedString, Window,
    div, img, prelude::*, px,
};
use serde_json::json;
use videorc_app_core::buddy::persona::bubble_word;
use videorc_app_core::buddy::reactions::reaction_label;
use videorc_app_core::buddy::test_view::{
    self as test_view, BUBBLE_CANVAS, BUBBLE_LINE, PREVIEW_PX, STATES, TestState,
};
use videorc_app_core::captions::decode_base64;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::look::still_pictures;
use super::preview::PetPreview;
use super::{AvatarScreen, sync_handle};

/// The dialog's state: a fresh test on every open (Idle, the bubble on).
pub(super) struct TestUi {
    handle: DialogHandle,
    want_open: bool,
    was_open: bool,
    preview: Option<Entity<PetPreview>>,
    state: TestState,
    show_bubble: bool,
    bubble: Option<Arc<Image>>,
}

impl TestUi {
    pub fn new() -> Self {
        Self {
            handle: DialogHandle::new(false),
            want_open: false,
            was_open: false,
            preview: None,
            state: TestState::Idle,
            show_bubble: true,
            bubble: None,
        }
    }
}

impl AvatarScreen {
    /// Test (key T): the pack the section shows, at 320 px.
    pub(super) fn open_test(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.clone() else {
            return;
        };
        let preview =
            cx.new(|_| PetPreview::new(PREVIEW_PX as f32, test_view::title(&persona.name)));
        let user_data = self.user_data_dir.clone();
        let worn = match &persona.avatar {
            videorc_protocol::buddy_pet::BuddyAvatar::Alive { pack_id } => Some(pack_id.clone()),
            videorc_protocol::buddy_pet::BuddyAvatar::Still => None,
        };
        preview.update(cx, |preview, cx| {
            preview.set_motion(persona.motion);
            match worn {
                Some(pack_id) => preview.show_pack(&user_data, &persona.id, &pack_id, cx),
                None => {
                    let pictures = still_pictures(&persona, &user_data);
                    preview.show_still(format!("test:{}", persona.id), pictures, cx);
                }
            }
        });
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        self.test = TestUi::new();
        self.test.preview = Some(preview);
        self.test.want_open = true;
        self.fetch_test_bubble(cx);
        cx.notify();
    }

    /// The sample bubble, drawn by the stream's painter for the dialog's
    /// canvas.
    fn fetch_test_bubble(&mut self, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let params = json!({
            "text": BUBBLE_LINE,
            "style": bubble_word(persona.bubble_style),
            "canvasWidth": BUBBLE_CANVAS.0,
            "canvasHeight": BUBBLE_CANVAS.1,
            "rect": { "x": 0.78, "y": 0.64, "w": 0.18, "h": 0.32 },
        });
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("buddy.bubble.render", params).await });
        cx.spawn(async move |this, cx| {
            let png = job.await.ok().and_then(Result::ok);
            let image = png
                .as_ref()
                .and_then(|png| png.get("pngBase64")?.as_str())
                .and_then(decode_base64)
                .map(|bytes| Arc::new(Image::from_bytes(ImageFormat::Png, bytes)));
            let _ = this.update(cx, |screen, cx| {
                screen.test.bubble = image;
                cx.notify();
            });
        })
        .detach();
    }

    /// Picks a state: the pose it holds, talk, and the reaction it plays.
    fn pick_test_state(&mut self, state: TestState, cx: &mut Context<Self>) {
        self.test.state = state;
        let Some(preview) = self.test.preview.clone() else {
            return;
        };
        let pack = preview.read(cx).test_pack();
        let plan = test_view::state_plan(state, pack.as_ref());
        preview.update(cx, |preview, cx| {
            preview.set_pose(plan.pose.as_deref(), plan.talking, cx);
            if let Some(reaction) = plan.react.as_deref() {
                preview.react(reaction, cx);
            }
        });
        cx.notify();
    }

    fn play_test_reaction(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(preview) = self.test.preview.clone() {
            preview.update(cx, |preview, cx| {
                preview.react(id, cx);
            });
        }
    }

    /// Digits 1 to 4 pick a state.
    fn test_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let modifiers = event.keystroke.modifiers;
        if modifiers.control || modifiers.alt || modifiers.platform {
            return;
        }
        if let Some(state) = test_view::state_for_key(&event.keystroke.key) {
            cx.stop_propagation();
            self.pick_test_state(state, cx);
        }
    }

    pub(super) fn sync_test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        sync_handle(
            &self.test.handle,
            &mut self.test.want_open,
            &mut self.test.was_open,
            window,
            cx,
        );
        if !self.test.want_open && !self.test.handle.is_open() && self.test.preview.is_some() {
            // Closed: the sandbox's preview stops.
            self.test.preview = None;
        }
    }
}

pub(super) fn test_dialog(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let (Some(persona), Some(preview)) = (screen.persona.as_ref(), screen.test.preview.clone())
    else {
        return div().into_any_element();
    };
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let state = screen.test.state;
    let pack = preview.read(cx).test_pack();
    let plan = test_view::state_plan(state, pack.as_ref());

    let pick = entity.clone();
    let mut states = SegmentedControl::new("avatar-test-state")
        // Electron fills it (`w-full`, or a vertical Field's `*:w-full`).
        .full(true)
        .small(true)
        .accessibility_label("State")
        .value(Some(STATES[test_view::state_index(state)].2))
        .on_change(move |value, _, cx| {
            if let Some(state) = test_view::state_for_key(value.as_ref()) {
                pick.update(cx, |screen, cx| screen.pick_test_state(state, cx));
            }
        });
    for (_, label, key) in STATES {
        states = states.option(Segment::new(key, format!("{label} {key}")));
    }

    let mut reactions = div().flex().flex_wrap().gap(px(6.));
    match pack.as_ref() {
        Some(pack) => {
            for id in test_view::reactions(&pack.reactions) {
                let play = entity.clone();
                let reaction = id.clone();
                reactions = reactions.child(
                    Button::new(SharedString::from(format!("avatar-test-reaction-{id}")))
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(reaction_label(&id))
                        .on_click(move |_, _, cx| {
                            let reaction = reaction.clone();
                            play.update(cx, |screen, cx| screen.play_test_reaction(&reaction, cx))
                        }),
                );
            }
        }
        None => {
            reactions = reactions.child(meta(test_view::loading_line(&persona.name), t));
        }
    }

    let toggle = entity.clone();
    let bubble_switch = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .child(
            div()
                .text_size(px(14.))
                .text_color(hsla(t.foreground))
                .child("Show the bubble while Talking"),
        )
        .child(
            Switch::new("avatar-test-bubble")
                .accessibility_label("Show the bubble while Talking")
                .checked(screen.test.show_bubble)
                .on_change(move |on, _, cx| {
                    toggle.update(cx, |screen, cx| {
                        screen.test.show_bubble = on;
                        cx.notify();
                    })
                }),
        );

    let bubble_shown = screen.test.show_bubble && state == TestState::Talk && pack.is_some();
    let stage = div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(4.))
        .children(
            screen
                .test
                .bubble
                .clone()
                .filter(|_| bubble_shown)
                .map(|bubble| {
                    img(bubble)
                        .max_w(px(PREVIEW_PX as f32))
                        .max_h(px(96.))
                        .object_fit(ObjectFit::Contain)
                }),
        )
        .child(preview);

    let key_entity = entity;
    Dialog::new(
        "avatar-test",
        &screen.test.handle,
        test_view::title(&persona.name),
    )
    .size(DialogSize::Lg)
    .child(
        div()
            .id("avatar-test-body")
            .flex()
            .flex_col()
            .items_center()
            .gap(px(12.))
            .on_key_down(move |event: &KeyDownEvent, _, cx| {
                key_entity.update(cx, |screen, cx| screen.test_key(event, cx))
            })
            .child(stage)
            .child(states)
            .children(plan.note.map(|note| meta(note, t)))
            .child(reactions)
            .child(bubble_switch),
    )
    .into_any_element()
}

fn meta(line: impl Into<SharedString>, t: &videorc_kit::tokens::Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}
