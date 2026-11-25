//! The Studio page (plan 260 Phase 3: preview and session;
//! `studio-tab.tsx`). Owns this file, `transport.rs`, `space.rs`, the
//! preview stage, session, audio and takeover; `scenes/` and `chat/` fill
//! their slots as they land.
//!
//! The grid follows the page's own width (P113): from 720 px the preview
//! column spans the left and the transport heads the inspector on the
//! right; narrower, the transport leads, then the preview, then the
//! inspector. The page scrolls as one (`PaneBody`, `pane.tsx:80`), and a
//! narrow page keeps its transport pinned unless the preview is docked
//! (`studioTransportRowClass`). Doors bring Scenes (P283) and Audio
//! (P172 / P180) into view on that scroll.

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

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight, KeyBinding,
    KeyDownEvent, KeyUpEvent, Role, ScrollHandle, Task, Window, canvas, div, point, prelude::*, px,
    relative,
};
use videorc_app_core::StopOrigin;
use videorc_app_core::desktop::permissions::{PermissionPlatform, SystemPermissionPane};
use videorc_app_core::desktop::system_access::{
    SystemAccessAction, SystemAccessContext, SystemAccessInput, SystemAccessRowId,
    media_access_status_for_pane, system_access_action, system_access_action_label,
    system_access_rows,
};
use videorc_app_core::livestream::plan;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::preview_startup::{
    OPEN_SOURCES_LABEL, PREVIEW_STARTUP_STEPS, PreviewStartupAction, PreviewStartupInputs,
    StallClock, preview_startup_segment_state, step_words,
};
#[cfg(target_os = "macos")]
use videorc_app_core::studio::screen_views::KEEP_ON_TOP_LABEL;
use videorc_app_core::studio::screen_views::{
    BRING_TO_FRONT_LABEL, ButtonLook, CLOSE_PREVIEW_LABEL, PreviewAction, PreviewMode,
    PreviewStageView, PreviewWindowState, RETRY_PREVIEW_LABEL, SHOW_HERE_LABEL, preview_stage,
};
use videorc_kit::ShortcutKeys;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::theme::{self, Appearance, TypeScale, hsla};
use videorc_kit::tokens::{radius, size, text};
use videorc_kit::{Button, ButtonVariant, Progress, Spinner};
use videorc_preview::element::Phase;
use videorc_preview::lifecycle::{PermissionStatus, WindowMode};
use videorc_preview::words;

use crate::app::menus::TogglePreview;
use crate::app::permissions::PermissionsGlobal;
use crate::preview::Preview;

use alerts::{CloudResumeSlot, PreviewNotes, StudioRequest};
use audio::AudioSection;
use chat::ChatSection;
use layout::{
    INSPECTOR_MAX_PX, StudioLayout, StudioSection, reveal_offset, stage_footprint,
    stage_slot_aspect, stage_slot_share,
};
use quick_settings::QuickSettingsSection;
use scenes::ScenesSection;
use session::SessionSection;
use show_stage::ShowStage;
use soundboard::SoundboardSection;
use space::{KEY_CONTEXT, SPACE, SpaceAction, SpacePress, ToggleRecord, space_action};
use takeover::TakeoverSection;
use talk_show_host::TalkShowRoomHost;
use transport::{AppStudio, OpenPage, Transport};
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
    /// The docked slot's startup card (P135), over the slot until the first
    /// frame.
    preview_startup: Entity<PreviewStartup>,
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
    /// The preview's permission fix (P133) is asking the OS or reopening.
    permission_pending: bool,
    /// The page's scroll, so a door can bring its section into view.
    scroll: ScrollHandle,
    /// The section a door asked for, brought into view at its next paint
    /// (the page may open first).
    reveal: Rc<Cell<Option<StudioSection>>>,
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
                StudioRequest::FocusAudio => page.reveal_audio(window, cx),
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
        // C3: Scenes room-open line toggles TalkShowRoomHost::scenes_enabled.
        scenes.update(cx, |scenes, cx| {
            scenes.bind_room_host(talk_show_host.clone(), cx);
        });
        // The preview's notes: Open Health goes through the page's door, and
        // the check's line redraws the docked row.
        let studio = transport.read(cx).studio();
        let startup_studio = studio.clone();
        let notes_preview = preview.clone();
        let preview_notes = cx.new(|cx| PreviewNotes::new(studio, notes_preview, cx));
        cx.subscribe(&preview_notes, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.observe(&preview_notes, |_, _, cx| cx.notify()).detach();
        // P135: the startup card's Open Sources goes through the page's door.
        let startup_preview = preview.clone();
        let preview_startup = cx.new(|cx| PreviewStartup::new(startup_studio, startup_preview, cx));
        cx.subscribe(&preview_startup, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
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
            preview_startup,
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
            permission_pending: false,
            scroll: ScrollHandle::new(),
            reveal: Rc::new(Cell::new(None)),
        }
    }

    /// ⌘K's Add scene… (P283): the Scenes section's picker.
    pub fn open_add_scene(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.scenes
            .update(cx, |scenes, cx| scenes.open_add(window, cx));
    }

    /// Sources' Open Scenes (P283): the Scenes section in view once the
    /// page shows (`scene-presets.tsx:98-105`).
    pub fn reveal_scenes(&mut self, cx: &mut Context<Self>) {
        self.reveal_section(StudioSection::Scenes, cx);
    }

    /// Open Audio (P172 / P180), from the session's door or the bell: the
    /// Microphone strip focused and its row in view.
    pub fn reveal_audio(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let strip = self.audio.read(cx).focus_handle(cx);
        strip.focus(window, cx);
        self.reveal_section(StudioSection::Audio, cx);
    }

    /// Brings `section` (`layout::StudioSection`) into view at the page's
    /// next paint.
    pub fn reveal_section(&mut self, section: StudioSection, cx: &mut Context<Self>) {
        self.reveal.set(Some(section));
        cx.notify();
    }

    /// Scrolls the page so the painted section comes into view, once per
    /// request; drawn over the section's wrapper (the Audio section is not
    /// this file's, so its bounds are the wrapper's).
    fn reveal_probe(&self, section: StudioSection) -> impl IntoElement {
        let reveal = self.reveal.clone();
        let scroll = self.scroll.clone();
        canvas(
            move |bounds, window, _| {
                if reveal.get() != Some(section) {
                    return;
                }
                reveal.set(None);
                let view = scroll.bounds();
                let offset = scroll.offset();
                let Some(y) = reveal_offset(
                    section,
                    (f32::from(view.top()), f32::from(view.bottom())),
                    (f32::from(bounds.top()), f32::from(bounds.bottom())),
                    f32::from(offset.y),
                    f32::from(scroll.max_offset().y),
                ) else {
                    return;
                };
                scroll.set_offset(point(offset.x, px(y)));
                window.refresh();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// The stage's footprint (`previewFootprintRatio`), its slot's real
    /// aspect (`previewSlotRatio`) and the slot's share of the footprint's
    /// width, for the recording profile (`captureConfig.video`).
    fn stage_aspect(&self, cx: &App) -> (f32, f32, f32) {
        let watch = self.transport.read(cx).studio().watch();
        let snapshot = watch.borrow();
        let video = plan::recording_video(&snapshot.settings.capture_doc);
        (
            stage_footprint(video.width, video.height),
            stage_slot_aspect(video.width, video.height),
            stage_slot_share(video.width, video.height),
        )
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
    let reopens_floating = preview.reopens_floating();
    // Keep on top is the macOS Preview window's (its saved frame).
    #[cfg(target_os = "macos")]
    let always_on_top = preview.keep_on_top();
    #[cfg(not(target_os = "macos"))]
    let always_on_top = false;
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
        // The no-surface path's Retry preview: only while there is a native
        // path to re-arm (none without the surface today).
        preview.can_retry(),
    )
}

/// What a detached card's button does (`DetachedPreviewCard`'s handlers).
fn run_stage_action(preview: &mut Preview, action: PreviewAction, cx: &mut Context<Preview>) {
    match action {
        PreviewAction::Stick => preview.show_docked(cx),
        PreviewAction::BringToFront => preview.bring_to_front(cx),
        PreviewAction::Close => preview.close(cx),
        PreviewAction::OpenDocked => preview.open_docked(cx),
        PreviewAction::OpenFloating => preview.open_floating(cx),
        // `openPreviewWindow`: a closed Preview opens where it was.
        PreviewAction::Open => preview.open_or_show(cx),
        PreviewAction::Retry => {
            let _ = preview.retry(cx);
        }
    }
}

/// A detached card button's id.
fn stage_button_id(action: PreviewAction) -> &'static str {
    match action {
        PreviewAction::Stick => "preview-stick",
        PreviewAction::BringToFront => "preview-bring-to-front",
        PreviewAction::Close => "preview-close",
        PreviewAction::OpenDocked => "preview-open-docked",
        PreviewAction::OpenFloating => "preview-open-floating",
        PreviewAction::Open => "preview-open",
        PreviewAction::Retry => "preview-retry",
    }
}

/// `previewPermissionPane` (`preview-stage.tsx:789`): the pane the
/// preview's missing grant lives in.
fn permission_pane(status: PermissionStatus) -> Option<SystemPermissionPane> {
    match status {
        PermissionStatus::CameraRequired => Some(SystemPermissionPane::Camera),
        PermissionStatus::ScreenRecordingRequired => Some(SystemPermissionPane::ScreenRecording),
        PermissionStatus::Unknown => Some(SystemPermissionPane::Privacy),
        PermissionStatus::Ok => None,
    }
}

/// P133: the preview's permission fix, the Permissions list's one action
/// for the pane (`preview-stage.tsx:81-96`), in that list's words
/// (`permissionActionLabel`, `system-access-view.ts:44`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct PermissionFix {
    pane: SystemPermissionPane,
    action: SystemAccessAction,
    label: String,
}

/// The docked frame's Close (`preview-stage.tsx:417`).
const DOCKED_CLOSE_LABEL: &str = "Close";

/// P135: the docked slot shows the startup card where it would say
/// "Opening preview…": docked, open, the native path up, no grant to wait
/// for and no frame yet (`dockedStageShowsStartup`, `preview-stage.tsx:336`:
/// a normal-toned status; a hidden dock, a failure and a permission wait keep
/// their own words).
fn startup_shows(preview: &Preview) -> bool {
    preview.mode() == WindowMode::Docked && preview.docked_words() == Some(words::OPENING)
}

/// P135 (`DockedPreviewStartup` and `PreviewStartupCard`,
/// `preview-startup-card.tsx:56-124`): what the docked slot says until the
/// first real frame. A title, the step in plain words, three short segments
/// and, when a step is stuck, Open Sources. Every word and state is
/// app-core's (`studio::preview_startup`); it follows the snapshot and the
/// preview statuses and redraws only when what it waits for changes, or
/// when the step's stall clock runs out.
pub struct PreviewStartup {
    inputs: PreviewStartupInputs,
    clock: StallClock,
    /// The slot shows the card; the stall clock runs only while it does.
    shown: bool,
    /// Wakes the card when the running step stalls.
    _stall: Option<Task<()>>,
}

impl EventEmitter<OpenPage> for PreviewStartup {}

impl PreviewStartup {
    fn new(studio: Arc<AppStudio>, preview: Entity<Preview>, cx: &mut Context<Self>) -> Self {
        cx.observe(&preview, |card, preview, cx| {
            let shown = startup_shows(preview.read(cx));
            card.set_shown(shown, cx);
        })
        .detach();
        let mut telemetry = studio.telemetry();
        let mut snapshot = studio.watch();
        let inputs = PreviewStartupInputs::of(&snapshot.borrow(), &telemetry.borrow());
        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = telemetry.changed() => changed.is_ok(),
                    changed = snapshot.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let inputs = PreviewStartupInputs::of(
                    &snapshot.borrow_and_update(),
                    &telemetry.borrow_and_update(),
                );
                let alive = this.update(cx, |card, cx| {
                    if card.inputs != inputs {
                        card.inputs = inputs;
                        card.arm(cx);
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        let mut card = Self {
            inputs,
            clock: StallClock::default(),
            shown: startup_shows(preview.read(cx)),
            _stall: None,
        };
        card.arm(cx);
        card
    }

    fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        // Each showing gives its step a full budget
        // (`usePreviewStartupStalled` runs while the card is mounted).
        self.clock.reset();
        self.arm(cx);
        cx.notify();
    }

    /// Notes the step now running and wakes the card when it stalls.
    fn arm(&mut self, cx: &mut Context<Self>) {
        if !self.shown {
            self.clock.reset();
            self._stall = None;
            return;
        }
        let now = Instant::now();
        let stalled = self.clock.observe(self.inputs.step(), now);
        self._stall = match self.clock.deadline() {
            Some(deadline) if !stalled => Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(deadline.saturating_duration_since(now))
                    .await;
                let _ = this.update(cx, |_, cx| cx.notify());
            })),
            _ => None,
        };
    }
}

impl Render for PreviewStartup {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.shown {
            return div().id("preview-startup").absolute().into_any_element();
        }
        let stalled = self.clock.observe(self.inputs.step(), Instant::now());
        let view = self.inputs.view(stalled);
        // The stage is a dark video ground in both themes, so the card scopes
        // the dark tokens to itself (`className="dark …"`).
        let dark = Appearance {
            dark: true,
            ..theme::current(window, cx)
        };
        let t = dark.theme();
        // `w-10` segments, full or empty (`value={state === 'next' ? 0 : 100}`).
        let segments: Vec<_> = PREVIEW_STARTUP_STEPS
            .iter()
            .enumerate()
            .map(|(index, segment)| {
                let state = preview_startup_segment_state(*segment, &view);
                div().w(px(40.)).child(
                    Progress::new(state.value())
                        .id(("preview-startup-segment", index))
                        .appearance(dark),
                )
            })
            .collect();
        let open_sources = (view.action == Some(PreviewStartupAction::OpenSources)).then(|| {
            Button::new("preview-startup-open-sources")
                .label(OPEN_SOURCES_LABEL)
                .variant(ButtonVariant::Outline)
                .appearance(dark)
                .on_click(cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Sources))))
        });
        div()
            .id("preview-startup")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .rounded(px(radius::PANEL))
            .bg(hsla(t.video_ground))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .max_w_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(12.))
                    .px(px(24.))
                    .child(
                        // `role="status"`, with the sr-only "Step n of 3".
                        div()
                            .id("preview-startup-status")
                            .role(Role::Status)
                            .aria_description(step_words(view.step))
                            .max_w_full()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .line_height(px(20.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(hsla(t.video_ground_foreground))
                                    .child(view.title),
                            )
                            .child(
                                div()
                                    .max_w_full()
                                    .truncate()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.video_ground_muted))
                                    .child(view.detail),
                            ),
                    )
                    .child(div().flex().items_center().gap(px(6.)).children(segments))
                    .children(open_sources),
            )
            .into_any_element()
    }
}

impl StudioPage {
    /// P133: the fix for the grant the open Preview waits for, while it
    /// waits (`previewPermissionPane`, `preview-stage.tsx:81-96`); none once
    /// the Permissions list has nothing to do, or without the app's
    /// permission controller.
    fn permission_fix(&self, cx: &App) -> Option<PermissionFix> {
        let preview = self.preview.read(cx);
        if preview.is_closed() {
            return None;
        }
        let pane = permission_pane(preview.permission_wait()?)?;
        let media = cx.try_global::<PermissionsGlobal>()?.0.snapshot();
        let platform = PermissionPlatform::current();
        let watch = self.transport.read(cx).studio().watch();
        let snapshot = watch.borrow();
        let rows = system_access_rows(&SystemAccessInput {
            devices: &snapshot.sources.devices.devices,
            audio_meter: None,
            platform,
            os_release: None,
            permission_target_name: "Videorc",
            media_access: Some(&media),
            context: SystemAccessContext::default(),
        });
        // `accessRows.find(candidate => candidate.id === permissionPane)`:
        // System audio rides the screen's pane but is not its row.
        let row = rows
            .iter()
            .find(|row| row.id != SystemAccessRowId::SystemAudio && row.id.pane() == pane);
        let action = system_access_action(
            Some(pane),
            row.map(|row| row.state),
            platform,
            media_access_status_for_pane(Some(&media), pane),
            row.is_some_and(|row| row.checking),
        )?;
        let label = system_access_action_label(Some(action), platform)?;
        Some(PermissionFix {
            pane,
            action,
            label,
        })
    }

    /// P133's click (`handleSystemPermission`), as the Sources page runs a
    /// grant: the OS's own prompt, Reopen Videorc, or the settings pane.
    fn run_permission_fix(&mut self, fix: PermissionFix, cx: &mut Context<Self>) {
        let Some(permissions) = cx
            .try_global::<PermissionsGlobal>()
            .map(|global| global.0.clone())
        else {
            return;
        };
        let task = match fix.action {
            SystemAccessAction::OpenSettings => {
                if let Err(error) = permissions.open_settings(cx, fix.pane) {
                    eprintln!("[videorc-app] Studio preview: {}: {error}", fix.label);
                }
                return;
            }
            SystemAccessAction::RequestMediaAccess => permissions.request(cx, fix.pane),
            SystemAccessAction::Relaunch => permissions.relaunch(cx),
        };
        self.permission_pending = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                eprintln!("[videorc-app] Studio preview: {}: {error}", fix.label);
            }
            let _ = this.update(cx, |page, cx| {
                page.permission_pending = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// The detached card's buttons, from app-core's `preview_stage`: a
    /// closed Preview's "Show here" and "Open in its own window"
    /// (`preview-stage.tsx:618-638`, P124–P126), with the Preview shortcut's
    /// keys on the mode it opens in again; without the native surface, "Open
    /// preview" and "Retry preview" (`preview-stage.tsx:648-664`). Every
    /// platform: Open in its own window only where the Preview can float.
    fn stage_buttons(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let view = stage_view(self.preview.read(cx));
        if view.docked || view.buttons.is_empty() {
            return None;
        }
        let theme = theme::resolve(None, window, cx);
        // Each look's ink (`button.rs`): Default's is the chrome fill's ink,
        // Secondary's `secondary_foreground`, Outline's the foreground.
        let default_ink = hsla(theme.chrome_fill_ink);
        let secondary_ink = hsla(theme.secondary_foreground);
        let outline_ink = hsla(theme.foreground);
        let buttons: Vec<Button> = view
            .buttons
            .into_iter()
            .map(|spec| {
                let (variant, ink) = match spec.look {
                    ButtonLook::Primary => (ButtonVariant::Default, default_ink),
                    ButtonLook::Secondary => (ButtonVariant::Secondary, secondary_ink),
                    ButtonLook::Outline => (ButtonVariant::Outline, outline_ink),
                };
                // `PinIcon` and `ExternalLinkIcon` lead the two homes.
                let lead = match spec.action {
                    PreviewAction::OpenDocked => Some(IconName::PushPin),
                    PreviewAction::OpenFloating => Some(IconName::ArrowSquareOut),
                    _ => None,
                };
                let preview = self.preview.clone();
                let action = spec.action;
                Button::new(stage_button_id(action))
                    .variant(variant)
                    .accessibility_label(spec.label)
                    .when_some(lead, |button, name| button.child(icon(name, 16., ink)))
                    .child(spec.label)
                    // The shortcut opens the remembered mode, so its keys
                    // ride on that button (`preview-stage.tsx:616-637`).
                    .when(spec.shortcut, |button| {
                        button.child(
                            div()
                                .ml(px(4.))
                                .child(ShortcutKeys::for_action(&TogglePreview)),
                        )
                    })
                    .on_click(move |_, _, cx| {
                        preview.update(cx, |preview, cx| run_stage_action(preview, action, cx))
                    })
            })
            .collect();
        Some(
            div()
                .flex()
                .flex_wrap()
                .justify_end()
                .items_center()
                .gap(px(8.))
                .children(buttons)
                .into_any_element(),
        )
    }

    /// `preview-stage.tsx`'s dock control under the video: "Pop out" and
    /// Close while docked; "Show here", Bring to front, Close Preview and
    /// (macOS) Keep on top while the Preview floats; the detached card's
    /// buttons while it is closed or has no native surface (P131). Retry
    /// preview while the open Preview failed (P146) and the permission fix
    /// while it waits for a grant (P133) join the row.
    fn dock_row(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (closed, can_float) = {
            let preview = self.preview.read(cx);
            (preview.is_closed(), preview.can_float())
        };
        if closed || !can_float {
            return self.stage_buttons(window, cx);
        }
        let fix = self.permission_fix(cx);
        let preview = self.preview.read(cx);
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
        // P146: the open Preview failed ("Preview failed" in the slot) and
        // its native path can be re-armed: Retry preview, outlined as the
        // card's (`preview-stage.tsx:660-663`).
        let failed = matches!(preview.phase(), Phase::Fallback | Phase::Stalled);
        let retry = (failed && preview.can_retry()).then(|| {
            let again = self.preview.clone();
            Button::new("preview-retry")
                .label(RETRY_PREVIEW_LABEL)
                .variant(ButtonVariant::Outline)
                .on_click(move |_, _, cx| {
                    let _ = again.update(cx, |preview, cx| preview.retry(cx));
                })
        });
        // P133: the permission fix, outlined, in the Permissions list's
        // words (`preview-stage.tsx:407-411`, `:599-603`).
        let fix = fix.map(|fix| {
            Button::new("preview-permission-fix")
                .label(fix.label.clone())
                .variant(ButtonVariant::Outline)
                .disabled(self.permission_pending)
                .on_click(
                    cx.listener(move |page, _, _, cx| page.run_permission_fix(fix.clone(), cx)),
                )
        });
        let extras: Vec<Button> = retry.into_iter().chain(fix).collect();
        let entity = self.preview.clone();
        let button = button.on_click(move |_, _, cx| {
            entity.update(cx, |preview, cx| preview.toggle_floating(cx));
        });
        let row = div()
            .flex()
            .flex_wrap()
            .justify_end()
            .items_center()
            .gap(px(8.))
            .children(checking);
        let row = if floating {
            // `preview-stage.tsx`'s floating card: Show here, Bring to front
            // (P130), Close Preview (P131), the fix; then "Keep on top of
            // other apps" (P132), macOS's Preview window only.
            let front = self.preview.clone();
            let shut = self.preview.clone();
            #[cfg(target_os = "macos")]
            let pin_row = {
                let pin = self.preview.clone();
                Some(
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
            };
            #[cfg(not(target_os = "macos"))]
            let pin_row: Option<gpui::Div> = None;
            row.child(button)
                .child(
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
                .children(extras)
                .children(pin_row)
        } else {
            // The docked frame's row: the fix before Pop out, then Close
            // (P140, `preview-stage.tsx:407-418`): the Preview closes where
            // it is.
            let shut = self.preview.clone();
            row.children(extras).child(button).child(
                Button::new("preview-close-docked")
                    .label(DOCKED_CLOSE_LABEL)
                    .variant(ButtonVariant::Secondary)
                    .on_click(move |_, _, cx| shut.update(cx, |preview, cx| preview.close(cx))),
            )
        };
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
        // P116: "Preview" heads the stage while it isn't docked (in its own
        // window, closed, or without the native surface); docked, the video
        // is the pane, with no title (`studio-tab.tsx:466-485`).
        let stage_shape = (!preview_replaced).then(|| stage_view(self.preview.read(cx)));
        let preview_docked = stage_shape.as_ref().is_some_and(|view| view.docked);
        let stage = if preview_replaced {
            // P122 / P357: the Show stage replaces the Preview while the room
            // is open; its well keeps its own aspect.
            div()
                .w_full()
                .child(self.show_stage.clone())
                .into_any_element()
        } else {
            // The stage keeps the canvas's footprint at the column's width
            // (`previewFootprintRatio`, `preview-stage.tsx:360`), so the page
            // scrolls under a stage of a known height. It is never taller
            // than the scroll view leaves under the column's gutters, so the
            // docked slot fits whole at the top (Linux hides its child while
            // the slot is not wholly in view). The slot holding the native
            // surface takes the canvas's real aspect at the footprint's full
            // height, centred on the video ground (`preview-stage.tsx:357-370`):
            // a portrait canvas gets a true 9:16 slot, never a squeezed one.
            // Not docked, the stage's card keeps the whole footprint.
            let (aspect, slot_aspect, slot_share) = self.stage_aspect(cx);
            let (slot_aspect, slot_share) = if preview_docked {
                (slot_aspect, slot_share)
            } else {
                (aspect, 1.)
            };
            let view_height = f32::from(self.scroll.bounds().size.height);
            let widest =
                (view_height > 0.).then(|| (view_height - 2. * size::GUTTER).max(120.) * aspect);
            div()
                .flex()
                .justify_center()
                .child(
                    div()
                        .relative()
                        .w_full()
                        .when_some(widest, |stage, widest| stage.max_w(px(widest)))
                        .aspect_ratio(aspect)
                        .flex()
                        .justify_center()
                        .rounded(px(radius::PANEL))
                        .bg(hsla(theme.video_ground))
                        .child(
                            div()
                                .relative()
                                .flex_none()
                                .w(relative(slot_share))
                                .aspect_ratio(slot_aspect)
                                .child(Preview::docked_slot(&self.preview, cx)),
                        )
                        // P135: over the slot's "Opening preview…" until the
                        // first frame (`preview-stage.tsx:373-380`).
                        .child(self.preview_startup.clone()),
                )
                .into_any_element()
        };
        let title = stage_shape
            .and_then(|view| view.section_title)
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
        let stage_column = div()
            .id("studio-preview-column")
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(size::GUTTER))
            .min_w_0()
            .children(title)
            .child(stage)
            .children(
                (!preview_replaced)
                    .then(|| self.dock_row(window, cx))
                    .flatten(),
            )
            .children(health);
        // "Session inspector" (P114): cloud resume, the session section,
        // chat, audio, quick settings and takeover, in that order. Open Audio
        // (P172 / P180) brings the Audio section into view: its wrapper
        // carries the probe, the section being another lane's.
        let inspector = div()
            .id("studio-session-inspector")
            .flex()
            .flex_col()
            .min_w_0()
            .child(self.cloud_resume.clone())
            .child(self.session.clone())
            .child(self.chat.clone())
            .child(
                div()
                    .id("studio-audio-reveal")
                    .relative()
                    .child(self.audio.clone())
                    .child(self.reveal_probe(StudioSection::Audio)),
            )
            .child(self.quick_settings.clone())
            .child(self.takeover.clone());
        let transport = self.transport.clone();
        // `StudioDashboardBottomRow` (P273): Scenes, then Soundboard (C3),
        // then Vertical stream, right under the stage. Open Scenes (P283)
        // brings Scenes into view.
        let bottom_row = div()
            .id("studio-dashboard-bottom-row")
            .flex()
            .flex_col()
            .flex_none()
            .child(
                div()
                    .id("studio-scenes-reveal")
                    .relative()
                    .child(self.scenes.clone())
                    .child(self.reveal_probe(StudioSection::Scenes)),
            )
            .child(self.soundboard.clone())
            .child(self.vertical_stream.clone());
        let preview_column = div()
            .id("studio-preview-and-scenes")
            .flex()
            .flex_col()
            .min_w_0()
            .child(stage_column)
            .child(bottom_row);

        // The grid is at least the page's height (`min-h-full`,
        // `studio-layout.ts:22`) and grows with its sections; the page
        // scrolls it. Narrow, the transport stays pinned above the scroll
        // unless the preview is docked (`studioTransportRowClass`).
        let pinned = layout.transport_sticky(preview_docked);
        let (pinned_transport, grid) = match layout {
            StudioLayout::Wide => (
                None,
                div()
                    .flex()
                    .flex_row()
                    .w_full()
                    .min_h_full()
                    .child(preview_column.flex_1().border_r_1().border_color(border))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .w(px(INSPECTOR_MAX_PX))
                            .flex_shrink(0.)
                            .min_w_0()
                            .child(transport)
                            .child(inspector),
                    ),
            ),
            StudioLayout::Narrow => {
                let (pinned_transport, scrolled_transport) = if pinned {
                    (Some(transport), None)
                } else {
                    (None, Some(transport))
                };
                (
                    pinned_transport,
                    div()
                        .flex()
                        .flex_col()
                        .w_full()
                        .min_h_full()
                        .children(scrolled_transport)
                        .child(preview_column)
                        .child(inspector.border_t_1().border_color(border)),
                )
            }
        };
        let body = div().flex_1().min_h_0().child(
            ScrollArea::new("studio-scroll")
                .handle(self.scroll.clone())
                .child(grid),
        );

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
            .flex()
            .flex_col()
            .child(measure)
            // P395: talk-show host draws nothing; keep it mounted for watches.
            .child(self.talk_show_host.clone())
            .children(pinned_transport)
            .child(body)
    }
}
