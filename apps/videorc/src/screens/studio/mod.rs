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
pub mod background;
pub mod chat;
pub mod layout;
pub mod quick_settings;
pub mod scenes;
pub mod session;
pub mod show_stage;
pub mod soundboard;
pub mod space;
pub mod takeover;
pub mod talk_show_host;
pub mod transport;
pub mod vertical_stream;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding,
    KeyDownEvent, KeyUpEvent, Role, Window, canvas, div, prelude::*, px,
};
use videorc_app_core::StopOrigin;
#[cfg(target_os = "macos")]
use videorc_app_core::studio::screen_views::{CLOSE_PREVIEW_LABEL, OPEN_IN_ITS_OWN_WINDOW_LABEL};
use videorc_app_core::studio::screen_views::{
    PreviewMode, PreviewStageView, PreviewWindowState, SHOW_HERE_LABEL, preview_stage,
};
#[cfg(target_os = "macos")]
use videorc_kit::ShortcutKeys;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_kit::{Button, ButtonVariant, Spinner};
use videorc_preview::lifecycle::WindowMode;

#[cfg(target_os = "macos")]
use crate::app::menus::TogglePreview;
use crate::preview::Preview;

use alerts::{CloudResumeSlot, PreviewNotes, StudioRequest};
use audio::AudioSection;
use chat::ChatSection;
use layout::{INSPECTOR_MAX_PX, StudioLayout};
use quick_settings::QuickSettingsSection;
use scenes::ScenesSection;
use session::SessionSection;
use show_stage::ShowStage;
use soundboard::SoundboardSection;
use space::{KEY_CONTEXT, SPACE, SpaceAction, SpacePress, ToggleRecord, space_action};
use takeover::TakeoverSection;
use talk_show_host::TalkShowRoomHost;
use transport::{OpenPage, Transport};
use vertical_stream::VerticalStreamSection;

/// Binds the page's keys; call once at start.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(SPACE, ToggleRecord, Some(KEY_CONTEXT))]);
    audio::bind_keys(cx);
}

pub struct StudioPage {
    focus: FocusHandle,
    transport: Entity<Transport>,
    preview: Entity<Preview>,
    /// The degraded preview's alert under the stage (P117/P118) and the
    /// performance check's line on the docked row (P138).
    preview_notes: Entity<PreviewNotes>,
    /// The cloud's Resume notice above Session; draws nothing until a show
    /// waits.
    cloud_resume: Entity<CloudResumeSlot>,
    session: Entity<SessionSection>,
    /// Chat in Studio (P188): draws nothing until it shows.
    chat: Entity<ChatSection>,
    audio: Entity<AudioSection>,
    /// Camera / Captions / Chat mirrors (P248–P263).
    quick_settings: Entity<QuickSettingsSection>,
    takeover: Entity<TakeoverSection>,
    /// The Scenes section under the preview (P273: Scenes first in the
    /// bottom row; Soundboard and the vertical leg fill in after it).
    scenes: Entity<ScenesSection>,
    /// Soundboard under Scenes (P273 / P340–P350).
    soundboard: Entity<SoundboardSection>,
    /// Vertical stream panel (P273 / P334–P339); draws nothing until armed.
    vertical_stream: Entity<VerticalStreamSection>,
    /// Show stage (P357–P394): replaces the Preview while the room is open.
    show_stage: Entity<ShowStage>,
    /// Talk-show room host (P395–P399): no chrome; recording watch + retire.
    talk_show_host: Entity<TalkShowRoomHost>,
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
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        transport: Entity<Transport>,
        preview: Entity<Preview>,
        cloud_resume: Entity<CloudResumeSlot>,
        session: Entity<SessionSection>,
        chat: Entity<ChatSection>,
        audio: Entity<AudioSection>,
        quick_settings: Entity<QuickSettingsSection>,
        takeover: Entity<TakeoverSection>,
        scenes: Entity<ScenesSection>,
        soundboard: Entity<SoundboardSection>,
        vertical_stream: Entity<VerticalStreamSection>,
        show_stage: Entity<ShowStage>,
        talk_show_host: Entity<TalkShowRoomHost>,
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
        cx.subscribe(&quick_settings, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&takeover, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&scenes, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&soundboard, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&show_stage, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        // The preview notifies only when its slot's words or its window
        // change, never per video frame. The transport also carries the
        // talk-show room (P122): the Preview yields to the Show stage.
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        cx.observe(&transport, |_, _, cx| cx.notify()).detach();
        cx.observe(&vertical_stream, |_, _, cx| cx.notify())
            .detach();
        cx.observe(&show_stage, |_, _, cx| cx.notify()).detach();
        cx.observe(&talk_show_host, |_, _, cx| cx.notify()).detach();
        // The preview's notes: Open Health goes through the page's door, and
        // the check's line redraws the docked row.
        let studio = transport.read(cx).studio();
        let preview_notes = cx.new(|cx| PreviewNotes::new(studio, cx));
        cx.subscribe(&preview_notes, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.observe(&preview_notes, |_, _, cx| cx.notify()).detach();
        // Release While held pads when the window blurs (P343).
        cx.observe_window_activation(window, |page, window, cx| {
            if !window.is_window_active() {
                soundboard::release_held(&page.soundboard, cx);
            }
        })
        .detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            focus,
            transport,
            preview,
            preview_notes,
            cloud_resume,
            session,
            chat,
            audio,
            quick_settings,
            takeover,
            scenes,
            soundboard,
            vertical_stream,
            show_stage,
            talk_show_host,
            width: 0.,
            space_held: false,
        }
    }

    /// ⌘K's Add scene… (P283): the Scenes section's picker.
    pub fn open_add_scene(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.scenes
            .update(cx, |scenes, cx| scenes.open_add(window, cx));
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

/// `StudioPreviewPanel`'s stage as app-core reads it (`preview_stage`):
/// docked while the native surface is open in the Studio, else the section
/// titled "Preview" (P116, `studio-tab.tsx:480`). A closed Preview reads the
/// mode it opens in again.
fn stage_view(preview: &Preview) -> PreviewStageView {
    #[cfg(target_os = "macos")]
    let (reopens_floating, always_on_top) = (preview.reopens_floating(), preview.keep_on_top());
    #[cfg(not(target_os = "macos"))]
    let (reopens_floating, always_on_top) = (false, false);
    let open = !preview.is_closed();
    let floating = if open {
        preview.mode() == WindowMode::Floating
    } else {
        reopens_floating
    };
    preview_stage(
        PreviewWindowState {
            open,
            mode: if floating {
                PreviewMode::Floating
            } else {
                PreviewMode::Docked
            },
            always_on_top,
        },
        preview.can_float(),
        false,
    )
}

/// `preview-stage.tsx`'s floating card.
#[cfg(target_os = "macos")]
const BRING_TO_FRONT_LABEL: &str = "Bring to front";
#[cfg(target_os = "macos")]
const KEEP_ON_TOP_LABEL: &str = "Keep on top of other apps";
/// The docked frame's Close (`preview-stage.tsx:417`).
#[cfg(target_os = "macos")]
const DOCKED_CLOSE_LABEL: &str = "Close";

impl StudioPage {
    /// `preview-stage.tsx`'s dock control under the video: "Pop out" while
    /// docked; "Show here", Bring to front, Close Preview and Keep on top
    /// while the Preview floats; "Show here" and "Open in its own window"
    /// while it is closed (P131).
    fn dock_row(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let preview = self.preview.read(cx);
        if !preview.can_float() {
            return None;
        }
        let theme = theme::resolve(None, window, cx);
        // Secondary's ink (`button.rs`): `secondary_foreground`.
        let secondary_ink = hsla(theme.secondary_foreground);
        #[cfg(target_os = "macos")]
        if preview.is_closed() {
            let here = self.preview.clone();
            let away = self.preview.clone();
            // Outline's ink (`button.rs`): the foreground; Default's is the
            // chrome fill's ink.
            let outline_ink = hsla(theme.foreground);
            let default_ink = hsla(theme.chrome_fill_ink);
            // The shortcut opens the remembered mode, so its keys ride on
            // that button (`preview-stage.tsx:616-637`).
            let floating_next = preview.reopens_floating();
            let keys = || {
                div()
                    .ml(px(4.))
                    .child(ShortcutKeys::for_action(&TogglePreview))
            };
            return Some(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_end()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        Button::new("preview-open-docked")
                            .variant(ButtonVariant::Default)
                            .accessibility_label(SHOW_HERE_LABEL)
                            .child(icon(IconName::PushPin, 16., default_ink))
                            .child(SHOW_HERE_LABEL)
                            .when(!floating_next, |button| button.child(keys()))
                            .on_click(move |_, _, cx| {
                                here.update(cx, |preview, cx| preview.open_docked(cx))
                            }),
                    )
                    .child(
                        Button::new("preview-open-floating")
                            .variant(ButtonVariant::Outline)
                            .accessibility_label(OPEN_IN_ITS_OWN_WINDOW_LABEL)
                            .child(icon(IconName::ArrowSquareOut, 16., outline_ink))
                            .child(OPEN_IN_ITS_OWN_WINDOW_LABEL)
                            .when(floating_next, |button| button.child(keys()))
                            .on_click(move |_, _, cx| {
                                away.update(cx, |preview, cx| preview.open_floating(cx))
                            }),
                    )
                    .into_any_element(),
            );
        }
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
        // P138: while the performance check runs the docked Preview keeps
        // its picture, and the row's start says so (`preview-stage.tsx:397`).
        let checking = (!floating)
            .then(|| self.preview_notes.read(cx).checking())
            .flatten()
            .map(|label| {
                div()
                    .id("preview-checking")
                    .role(Role::Status)
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(
                        Spinner::new("preview-checking-spinner")
                            .size(14.)
                            .color(theme.muted_foreground)
                            .hidden(true),
                    )
                    .child(div().min_w_0().truncate().child(label))
            });
        let entity = self.preview.clone();
        let row = div()
            .flex()
            .flex_wrap()
            .justify_end()
            .items_center()
            .gap(px(8.))
            .children(checking)
            .child(button.on_click(move |_, _, cx| {
                entity.update(cx, |preview, cx| preview.toggle_floating(cx));
            }));
        // `preview-stage.tsx`'s floating card: Bring to front (P130) and
        // "Keep on top of other apps" (P132).
        #[cfg(target_os = "macos")]
        let row = if floating {
            let front = self.preview.clone();
            let shut = self.preview.clone();
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
                Button::new("preview-close")
                    .label(CLOSE_PREVIEW_LABEL)
                    .variant(ButtonVariant::Outline)
                    .on_click(move |_, _, cx| shut.update(cx, |preview, cx| preview.close(cx))),
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
            // P140: the docked frame's Close, after Pop out
            // (`preview-stage.tsx:416-418`): the Preview closes where it is.
            let shut = self.preview.clone();
            row.child(
                Button::new("preview-close-docked")
                    .label(DOCKED_CLOSE_LABEL)
                    .variant(ButtonVariant::Secondary)
                    .on_click(move |_, _, cx| shut.update(cx, |preview, cx| preview.close(cx))),
            )
        };
        #[cfg(not(target_os = "macos"))]
        let _ = (floating, muted);
        Some(row.into_any_element())
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
            // P122 / P357: the Show stage replaces the Preview while the room
            // is open.
            div()
                .flex_1()
                .min_h_0()
                .child(self.show_stage.clone())
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_h_0()
                .child(Preview::docked_slot(&self.preview, cx))
                .into_any_element()
        };
        // P116: "Preview" heads the stage while it isn't docked (in its own
        // window, closed, or without the native surface); docked, the video
        // is the pane, with no title (`studio-tab.tsx:466-485`).
        let title = (!preview_replaced)
            .then(|| stage_view(self.preview.read(cx)).section_title)
            .flatten()
            .map(|title| {
                div()
                    .id("studio-preview-title")
                    .role(Role::Heading)
                    .aria_level(2)
                    .pb(px(4.))
                    .type_scale(text::SECTION)
                    .text_color(hsla(theme.foreground))
                    .child(title)
            });
        // P117/P118: the degraded preview's alert under the stage, in both
        // shapes; the Show stage has none.
        let health = (!preview_replaced && self.preview_notes.read(cx).has_alert())
            .then(|| self.preview_notes.clone());
        let preview_column = div()
            .id("studio-preview-column")
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(size::GUTTER))
            .min_w_0()
            .min_h_0()
            .children(title)
            .child(stage)
            .children(
                (!preview_replaced)
                    .then(|| self.dock_row(window, cx))
                    .flatten(),
            )
            .children(health);
        // "Session inspector" (P114): cloud resume, the session section,
        // chat, audio, quick settings and takeover, in that order.
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
            .child(self.quick_settings.clone())
            .child(self.takeover.clone());
        let transport = self.transport.clone();
        // `StudioDashboardBottomRow` (P273): Scenes, then Soundboard (C3),
        // then Vertical stream. Wide, the stage keeps the room the row leaves.
        let stage_column = match layout {
            StudioLayout::Wide => preview_column.flex_1(),
            StudioLayout::Narrow => preview_column,
        };
        // P273 order: Scenes, Soundboard, Vertical stream.
        let bottom_row = div()
            .id("studio-dashboard-bottom-row")
            .flex()
            .flex_col()
            .flex_none()
            .child(self.scenes.clone())
            .child(self.soundboard.clone())
            .child(self.vertical_stream.clone());
        let preview_column = div()
            .id("studio-preview-and-scenes")
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .child(stage_column)
            .child(bottom_row);

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
            .capture_key_down(cx.listener(|page, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == SPACE {
                    page.space_held = event.is_held;
                }
                let _ = soundboard::handle_key_down(&page.soundboard, event, cx);
            }))
            .capture_key_up(cx.listener(|page, event: &KeyUpEvent, _, cx| {
                let _ = soundboard::handle_key_up(&page.soundboard, event, cx);
            }))
            .relative()
            .size_full()
            .child(measure)
            // P395: talk-show host draws nothing; keep it mounted for watches.
            .child(self.talk_show_host.clone())
            .child(grid)
    }
}
