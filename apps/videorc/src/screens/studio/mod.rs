//! The Studio page (plan 260 Phase 3, lane L1: preview and session;
//! `studio-tab.tsx`). L1 owns this file, `transport.rs`, `space.rs` and the
//! preview stage and session section as they land; L7 owns `audio/`,
//! `scenes/` and `chat/`, which fill their slots here.
//!
//! The grid follows the page's own width (P113): from 720 px the preview
//! column spans the left and the transport heads the inspector on the
//! right; narrower, the transport leads, then the preview, then the
//! inspector.

pub mod layout;
pub mod session;
pub mod space;
pub mod takeover;
pub mod transport;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding,
    KeyDownEvent, Window, canvas, div, prelude::*, px,
};
use videorc_app_core::StopOrigin;
use videorc_app_core::studio::screen_views::SHOW_HERE_LABEL;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, hsla};
use videorc_kit::tokens::size;
use videorc_kit::{Button, ButtonVariant};
use videorc_preview::lifecycle::WindowMode;

use crate::preview::Preview;

use layout::{INSPECTOR_MAX_PX, StudioLayout};
use session::SessionSection;
use space::{KEY_CONTEXT, SPACE, SpaceAction, SpacePress, ToggleRecord, space_action};
use takeover::TakeoverSection;
use transport::{OpenPage, Transport};

/// Binds the page's keys; call once at start.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(SPACE, ToggleRecord, Some(KEY_CONTEXT))]);
}

pub struct StudioPage {
    focus: FocusHandle,
    transport: Entity<Transport>,
    preview: Entity<Preview>,
    session: Entity<SessionSection>,
    takeover: Entity<TakeoverSection>,
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
        session: Entity<SessionSection>,
        takeover: Entity<TakeoverSection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.subscribe(&transport, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&session, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&takeover, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        // The preview notifies only when its slot's words or its window
        // change, never per video frame.
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            focus,
            transport,
            preview,
            session,
            takeover,
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
        let preview = self.preview.clone();
        Some(
            div()
                .flex()
                .justify_end()
                .items_center()
                .child(button.on_click(move |_, _, cx| {
                    preview.update(cx, |preview, cx| preview.toggle_floating(cx));
                }))
                .into_any_element(),
        )
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

        let preview_column = div()
            .id("studio-preview-column")
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(size::GUTTER))
            .min_w_0()
            .min_h_0()
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .child(Preview::docked_slot(&self.preview, cx)),
            )
            .children(self.dock_row(window, cx));
        // "Session inspector" (P114): cloud resume, the session section,
        // chat, audio, quick settings and takeover, in that order.
        let inspector = div()
            .id("studio-session-inspector")
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .child(self.session.clone())
            .child(self.takeover.clone());
        let transport = self.transport.clone();

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
