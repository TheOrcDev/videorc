//! The Studio page (plan 260 Phase 3: preview and session;
//! `studio-tab.tsx`). Owns this file, `transport.rs`, `space.rs`, the
//! preview stage, session, audio and takeover; `scenes/` and `chat/` fill
//! their slots as they land.
//!
//! The grid follows the page's own width (P113): from 720 px the preview
//! column spans the left and the transport heads the inspector on the
//! right; narrower, the transport leads, then the preview, then the
//! inspector.

pub mod alerts;
pub mod audio;
pub mod chat;
pub mod layout;
pub mod scenes;
pub mod session;
pub mod space;
pub mod takeover;
pub mod transport;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding,
    KeyDownEvent, Window, canvas, div, prelude::*, px,
};
use videorc_app_core::StopOrigin;
use videorc_app_core::guests::view::CLOSE_THE_ROOM_LABEL;
use videorc_app_core::studio::screen_views::{
    CLOSE_THE_ROOM_UNAVAILABLE, PREVIEW_REPLACED_BY_SHOW_STAGE, SHOW_HERE_LABEL,
};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_kit::{Button, ButtonSize, ButtonVariant};
use videorc_preview::lifecycle::WindowMode;

use crate::preview::Preview;

use alerts::{CloudResumeSlot, StudioRequest};
use audio::AudioSection;
use chat::ChatSection;
use layout::{INSPECTOR_MAX_PX, StudioLayout};
use scenes::ScenesSection;
use session::SessionSection;
use space::{KEY_CONTEXT, SPACE, SpaceAction, SpacePress, ToggleRecord, space_action};
use takeover::TakeoverSection;
use transport::{OpenPage, Transport};

/// Binds the page's keys; call once at start.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(SPACE, ToggleRecord, Some(KEY_CONTEXT))]);
    audio::bind_keys(cx);
}

pub struct StudioPage {
    focus: FocusHandle,
    transport: Entity<Transport>,
    preview: Entity<Preview>,
    /// The cloud's Resume notice above Session; draws nothing until a show
    /// waits.
    cloud_resume: Entity<CloudResumeSlot>,
    session: Entity<SessionSection>,
    /// Chat in Studio (P188): draws nothing until it shows.
    chat: Entity<ChatSection>,
    audio: Entity<AudioSection>,
    takeover: Entity<TakeoverSection>,
    /// The Scenes section under the preview (P273: Scenes first in the
    /// bottom row; Soundboard and the vertical leg fill in after it).
    scenes: Entity<ScenesSection>,
    /// The page's width at the last paint, for the breakpoint.
    width: f32,
    /// The Space now dispatching is a held key's repeat.
    space_held: bool,
}

impl EventEmitter<OpenPage> for StudioPage {}

impl Focusable for StudioPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl StudioPage {
    /// The page holds the focus from the start, so Space reaches it before
    /// anything else is clicked.
    pub fn new(
        transport: Entity<Transport>,
        preview: Entity<Preview>,
        cloud_resume: Entity<CloudResumeSlot>,
        session: Entity<SessionSection>,
        chat: Entity<ChatSection>,
        audio: Entity<AudioSection>,
        takeover: Entity<TakeoverSection>,
        scenes: Entity<ScenesSection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.subscribe(&transport, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&session, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        // A watchdog fix's doors on this page: the Microphone strip, and the
        // Takeover section after End takeover.
        cx.subscribe_in(
            &session,
            window,
            |page, _, request: &StudioRequest, window, cx| match request {
                StudioRequest::FocusAudio => {
                    let strip = page.audio.read(cx).focus_handle(cx);
                    strip.focus(window, cx);
                }
                StudioRequest::TakeoverEnded => page
                    .takeover
                    .update(cx, |takeover, cx| takeover.refresh(cx)),
            },
        )
        .detach();
        cx.subscribe(&audio, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&takeover, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&scenes, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        // The preview notifies only when its slot's words or its window
        // change, never per video frame. The transport also carries the
        // talk-show room (P122): the Preview yields to the Show stage card.
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        cx.observe(&transport, |_, _, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            focus,
            transport,
            preview,
            cloud_resume,
            session,
            chat,
            audio,
            takeover,
            scenes,
            width: 0.,
            space_held: false,
        }
    }

    fn measured(&mut self, width: f32, cx: &mut Context<Self>) {
        let flips = StudioLayout::for_width(width) != StudioLayout::for_width(self.width);
        self.width = width;
        if flips {
            cx.notify();
        }
    }

    fn toggle_record(&mut self, _: &ToggleRecord, window: &mut Window, cx: &mut Context<Self>) {
        let press = SpacePress {
            held: self.space_held,
            page_focused: self.focus.is_focused(window),
            // The preview stage's drag and pending phases join with the stage.
            stage_gesture: false,
        };
        let view = self.transport.read(cx).view(cx);
        match space_action(press, &view) {
            SpaceAction::Pass => cx.propagate(),
            SpaceAction::Swallow => {}
            SpaceAction::Stop => self.transport.read(cx).stop(StopOrigin::Space),
            SpaceAction::Record => self.transport.read(cx).record(),
        }
    }
}

/// `preview-stage.tsx`'s floating card.
#[cfg(target_os = "macos")]
const BRING_TO_FRONT_LABEL: &str = "Bring to front";
#[cfg(target_os = "macos")]
const KEEP_ON_TOP_LABEL: &str = "Keep on top of other apps";

impl StudioPage {
    /// `preview-stage.tsx`'s dock control under the video: "Pop out" while
    /// docked, "Show here" while the Preview floats. Close, Bring to front
    /// and Keep on top wait for the preview crate's window controls.
    fn dock_row(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let preview = self.preview.read(cx);
        if !preview.can_float() {
            return None;
        }
        let theme = theme::resolve(None, window, cx);
        // Secondary's ink (`button.rs`): `secondary_foreground`.
        let secondary_ink = hsla(theme.secondary_foreground);
        let button = match preview.mode() {
            WindowMode::Docked => Button::new("preview-pop-out")
                .variant(ButtonVariant::Secondary)
                .accessibility_label("Pop out")
                // Leading ExternalLinkIcon, then the words (label would draw
                // first, so the icon and the words are both children).
                .child(icon(IconName::ArrowSquareOut, 16., secondary_ink))
                .child("Pop out"),
            WindowMode::Floating => Button::new("preview-stick")
                .label(SHOW_HERE_LABEL)
                .variant(ButtonVariant::Default),
        };
        let floating = preview.mode() == WindowMode::Floating;
        #[cfg(target_os = "macos")]
        let keep_on_top = preview.keep_on_top();
        let muted = hsla(theme.muted_foreground);
        let entity = self.preview.clone();
        let row = div()
            .flex()
            .flex_wrap()
            .justify_end()
            .items_center()
            .gap(px(8.))
            .child(button.on_click(move |_, _, cx| {
                entity.update(cx, |preview, cx| preview.toggle_floating(cx));
            }));
        // `preview-stage.tsx`'s floating card: Bring to front (P130) and
        // "Keep on top of other apps" (P132).
        #[cfg(target_os = "macos")]
        let row = if floating {
            let front = self.preview.clone();
            let pin = self.preview.clone();
            row.child(
                Button::new("preview-bring-to-front")
                    .label(BRING_TO_FRONT_LABEL)
                    .variant(ButtonVariant::Secondary)
                    .on_click(move |_, _, cx| {
                        front.update(cx, |preview, cx| preview.bring_to_front(cx))
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        videorc_kit::switch::Switch::new("preview-keep-on-top")
                            .small(true)
                            .accessibility_label(KEEP_ON_TOP_LABEL)
                            .checked(keep_on_top)
                            .on_change(move |on, _, cx| {
                                pin.update(cx, |preview, cx| preview.set_keep_on_top(on, cx));
                            }),
                    )
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(KEEP_ON_TOP_LABEL),
                    ),
            )
        } else {
            row
        };
        #[cfg(not(target_os = "macos"))]
        let _ = (floating, muted);
        Some(row.into_any_element())
    }

    /// `TalkShowPreviewCard`: the Preview's place while the room is open.
    fn show_stage_card(&self, _window: &mut Window, _cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("preview-replaced-by-show-stage")
            .flex()
            .flex_1()
            .min_h_0()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .child(
                div()
                    .type_scale(text::LABEL)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(PREVIEW_REPLACED_BY_SHOW_STAGE),
            )
            .child(
                Button::new("close-the-room")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(CLOSE_THE_ROOM_LABEL)
                    .tooltip(CLOSE_THE_ROOM_UNAVAILABLE)
                    .on_click(|_, _, _| {
                        eprintln!("[videorc-app] Close the room: {CLOSE_THE_ROOM_UNAVAILABLE}");
                    }),
            )
            .into_any_element()
    }
}

impl Render for StudioPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let border = hsla(theme.border);
        let layout = StudioLayout::for_width(self.width);
        let page = cx.entity().downgrade();
        let measure = canvas(
            move |bounds, _, cx| {
                let width = f32::from(bounds.size.width);
                page.update(cx, |page, cx| page.measured(width, cx)).ok();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        let preview_replaced = self.transport.read(cx).talk_show(cx).preview_replaced;
        let stage = if preview_replaced {
            // P122: the Show stage replaces the Preview while the room is
            // open. The Show stage itself is another lane; until it lands,
            // Electron's TalkShowPreviewCard (P147) is the swap.
            self.show_stage_card(window, cx)
        } else {
            div()
                .flex_1()
                .min_h_0()
                .child(Preview::docked_slot(&self.preview, cx))
                .into_any_element()
        };
        let preview_column = div()
            .id("studio-preview-column")
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(size::GUTTER))
            .min_w_0()
            .min_h_0()
            .child(stage)
            .children(
                (!preview_replaced)
                    .then(|| self.dock_row(window, cx))
                    .flatten(),
            );
        // "Session inspector" (P114): cloud resume, the session section,
        // chat, audio, quick settings and takeover, in that order. Chat and
        // quick settings fill their slots as they land.
        let inspector = div()
            .id("studio-session-inspector")
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .child(self.cloud_resume.clone())
            .child(self.session.clone())
            .child(self.chat.clone())
            .child(self.audio.clone())
            .child(self.takeover.clone());
        let transport = self.transport.clone();
        // `StudioDashboardBottomRow`: under the preview stage, in the
        // preview column. Wide, the stage keeps the room the row leaves.
        let stage_column = match layout {
            StudioLayout::Wide => preview_column.flex_1(),
            StudioLayout::Narrow => preview_column,
        };
        let preview_column = div()
            .id("studio-preview-and-scenes")
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .child(stage_column)
            .child(div().flex_none().child(self.scenes.clone()));

        let grid = match layout {
            StudioLayout::Wide => div()
                .flex()
                .flex_row()
                .size_full()
                .child(preview_column.flex_1().border_r_1().border_color(border))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .w(px(INSPECTOR_MAX_PX))
                        .flex_shrink(0.)
                        .min_w_0()
                        .child(transport)
                        .child(inspector.flex_1()),
                ),
            StudioLayout::Narrow => div()
                .flex()
                .flex_col()
                .size_full()
                .child(transport)
                .child(preview_column)
                .child(inspector.border_t_1().border_color(border)),
        };

        div()
            .id("studio-page")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::toggle_record))
            .capture_key_down(cx.listener(|page, event: &KeyDownEvent, _, _| {
                if event.keystroke.key == SPACE {
                    page.space_held = event.is_held;
                }
            }))
            .relative()
            .size_full()
            .child(measure)
            .child(grid)
    }
}
