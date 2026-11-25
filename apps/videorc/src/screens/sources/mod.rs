//! The Sources page (plan 260 Phase 3, L4): video and audio capture homes,
//! permission alerts, and Refresh. Words and state come from
//! `videorc_app_core::studio::{sources_page, sources_audio}`; this module
//! draws them with `videorc_kit` and calls the Studio and Permissions.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, KeyBinding, SharedString, WeakEntity,
    Window, actions, div, prelude::*, px,
};
use serde_json::json;
use tokio::sync::oneshot;
use videorc_app_core::desktop::permissions::{
    MediaAccessSnapshot, PermissionPlatform, SystemPermissionPane,
};
use videorc_app_core::desktop::system_access::{
    SystemAccessAction, SystemAccessContext, SystemAccessInput, SystemAccessRow, SystemAccessRowId,
    SystemAccessState, is_media_access_snapshot_ready, row_action, system_access_rows,
    system_access_visible_detail,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::protocol::SoundboardSettingsParams;
use videorc_app_core::studio::audio_levels::MicLevels;
use videorc_app_core::studio::audio_mixer;
use videorc_app_core::studio::audio_section::{AudioMeters, AudioMetersView, IssueAction};
use videorc_app_core::studio::health::HealthTelemetry;
use videorc_app_core::studio::health_page::OPEN_HEALTH_LABEL;
use videorc_app_core::studio::source_selection::{PICKER_NONE_VALUE, PickerView, SourceKind};
use videorc_app_core::studio::sources;
use videorc_app_core::studio::sources_audio::{
    SOUNDS_VOLUME_DEFAULT, SOUNDS_VOLUME_RANGE, SoundsBoard, SourcesAudioInputs, SourcesAudioView,
    copy as audio_copy,
};
use videorc_app_core::studio::sources_page::{
    ChipTone, GrantAction, GrantRow, GrantState, PermissionInputs, SourcePermissionAlert,
    SourcesPageInput, SourcesPageView, VideoSourceView, copy as page_copy, sources_page_view,
};
use videorc_app_core::studio::sources_section::copy as section_copy;
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::navigable_row::NavigableRow;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::select::Select;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use crate::app::permissions::Permissions;
use crate::app::shell::Shell;
use crate::screens::studio::audio::meter::{lcd_meter, segmented_meter};

pub type AppStudio = Studio<BackendClient>;

actions!(sources_audio, [FocusPreviousStrip, FocusNextStrip]);

/// Key context while focus is inside the Sources Audio mixer (P429).
pub const KEY_CONTEXT: &str = "SourcesAudio";

/// How often a falling meter redraws while nothing new arrives.
const METER_TICK: Duration = Duration::from_millis(33);

/// Binds ⌘/Ctrl+↑/↓ for the Sources Audio column; call once at start.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("secondary-up", FocusPreviousStrip, Some(KEY_CONTEXT)),
        KeyBinding::new("secondary-down", FocusNextStrip, Some(KEY_CONTEXT)),
    ]);
}

fn runtime_platform() -> &'static str {
    match PermissionPlatform::current() {
        PermissionPlatform::MacOs => "darwin",
        PermissionPlatform::Windows => "win32",
        PermissionPlatform::Other => "linux",
    }
}

fn grant_state(state: SystemAccessState) -> GrantState {
    match state {
        SystemAccessState::Granted => GrantState::Granted,
        SystemAccessState::NotGranted => GrantState::NotGranted,
        SystemAccessState::FirstUse => GrantState::FirstUse,
        SystemAccessState::DeviceIssue => GrantState::DeviceIssue,
        SystemAccessState::Waiting => GrantState::Waiting,
        SystemAccessState::NeedsRelaunch => GrantState::NeedsRelaunch,
        SystemAccessState::NotRequired => GrantState::NotRequired,
        SystemAccessState::Unavailable => GrantState::Unavailable,
    }
}

fn grant_action(action: SystemAccessAction) -> GrantAction {
    match action {
        SystemAccessAction::RequestMediaAccess => GrantAction::RequestMediaAccess,
        SystemAccessAction::OpenSettings => GrantAction::OpenSettings,
        SystemAccessAction::Relaunch => GrantAction::Relaunch,
    }
}

fn grant_row(row: &SystemAccessRow, action: Option<SystemAccessAction>) -> GrantRow {
    GrantRow {
        state: grant_state(row.state),
        checking: row.checking,
        detail: system_access_visible_detail(row).unwrap_or("").to_string(),
        action: action.map(grant_action),
    }
}

fn permission_inputs<'a>(
    snapshot: &'a StudioSnapshot,
    media: Option<&'a MediaAccessSnapshot>,
) -> PermissionInputs<'a> {
    let platform = runtime_platform();
    let perm = PermissionPlatform::current();
    let rows = system_access_rows(&SystemAccessInput {
        devices: &snapshot.sources.devices.devices,
        audio_meter: None,
        platform: perm,
        os_release: None,
        permission_target_name: "Videorc",
        media_access: media,
        context: SystemAccessContext::default(),
    });
    let one = |id: SystemAccessRowId| {
        rows.iter()
            .find(|row| row.id == id)
            .map(|row| grant_row(row, row_action(row, perm, media)))
    };
    PermissionInputs {
        platform,
        target_name: "Videorc",
        screen: one(SystemAccessRowId::ScreenRecording),
        camera: one(SystemAccessRowId::Camera),
        microphone: one(SystemAccessRowId::Microphone),
        media_known: is_media_access_snapshot_ready(media),
    }
}

fn chip_tone(tone: ChipTone) -> StatusTone {
    match tone {
        ChipTone::Neutral => StatusTone::Neutral,
        ChipTone::Good => StatusTone::Good,
        ChipTone::Warn => StatusTone::Warn,
        ChipTone::Error => StatusTone::Error,
    }
}

/// Source status words use StatusDot (the second kit batch): ambient tone,
/// monochrome label. Sync tags stay a Badge — a tag, not a status.
fn status_chip(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    tone: ChipTone,
) -> StatusDot {
    let label = label.into();
    let live = label.as_ref().eq_ignore_ascii_case("Live")
        || label.as_ref().eq_ignore_ascii_case("Receiving");
    StatusDot::new(id)
        .tone(if live {
            StatusTone::Live
        } else {
            chip_tone(tone)
        })
        .label(label)
        .pulse(live)
}

fn tag_badge(label: impl Into<SharedString>) -> Badge {
    Badge::new(label).variant(BadgeVariant::Neutral)
}

fn more_button(
    id: impl Into<gpui::ElementId>,
    open: bool,
    t: &videorc_kit::tokens::Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Button {
    Button::new(id)
        .size(ButtonSize::IconXs)
        .variant(ButtonVariant::Ghost)
        .accessibility_label(if open { "Less" } else { "More" })
        .tooltip(if open {
            "Less settings"
        } else {
            "More settings"
        })
        .child(icon(IconName::CaretDown, 12.0, hsla(t.muted_foreground)))
        .on_click(on_click)
}

fn fill_select(id: impl Into<gpui::ElementId>, picker: &PickerView, disabled: bool) -> Select {
    let selected = picker
        .items
        .iter()
        .find(|item| item.selected && item.heading.is_empty())
        .map(|item| item.value.clone());
    let mut select = Select::new(id)
        .placeholder(if picker.placeholder {
            picker.label.clone()
        } else {
            "Choose…".to_string()
        })
        .disabled(disabled)
        .width(280.0)
        .value(selected.map(SharedString::from));
    for item in &picker.items {
        if !item.heading.is_empty() {
            continue;
        }
        if item.disabled && !item.selected {
            continue;
        }
        select = select.option(item.value.clone(), item.label.clone());
    }
    select
}

#[derive(Debug, Clone, PartialEq)]
struct SourcesModel {
    page: SourcesPageView,
    audio: SourcesAudioView,
    levels: MicLevels,
}

impl SourcesModel {
    fn of(
        snapshot: &StudioSnapshot,
        telemetry: &HealthTelemetry,
        levels: &MicLevels,
        media: &MediaAccessSnapshot,
        refreshing: bool,
        board: Option<SoundsBoard>,
    ) -> Self {
        let permissions = permission_inputs(snapshot, Some(media));
        Self {
            page: sources_page_view(&SourcesPageInput {
                snapshot,
                telemetry,
                permissions,
                development: cfg!(debug_assertions),
                refreshing,
            }),
            audio: SourcesAudioView::from_snapshot(
                snapshot,
                levels,
                Instant::now(),
                &SourcesAudioInputs {
                    platform: runtime_platform(),
                    audio: Default::default(),
                    board,
                    warm_microphone_armed: None,
                    warm_microphone_open_failed: false,
                },
            ),
            levels: levels.clone(),
        }
    }
}

#[derive(Default)]
struct SourcesUi {
    more: HashSet<&'static str>,
    pending_alert: Option<SystemPermissionPane>,
    mic_gain_live: bool,
    sys_gain_live: bool,
    sounds_gain_live: bool,
    sync_live: bool,
}

pub struct SourcesPanel {
    studio: Arc<AppStudio>,
    permissions: Arc<Permissions>,
    runtime: tokio::runtime::Handle,
    model: SourcesModel,
    shell: Option<WeakEntity<Shell>>,
    ui: SourcesUi,
    refreshing: bool,
    board: Option<SoundsBoard>,
    board_loading: bool,
    meters: AudioMeters,
    meters_view: AudioMetersView,
    retro: bool,
    settling: bool,
    mic_gain: Entity<SliderState>,
    sys_gain: Entity<SliderState>,
    sounds_gain: Entity<SliderState>,
    sync_ms: Entity<SliderState>,
    mic_focus: FocusHandle,
    sys_focus: FocusHandle,
    sounds_focus: FocusHandle,
}

impl Focusable for SourcesPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.mic_focus.clone()
    }
}

impl SourcesPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        permissions: Arc<Permissions>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let snap = studio.watch().borrow().clone();
        let levels_now = studio.mic_levels().borrow().clone();
        let model = SourcesModel::of(
            &snap,
            &studio.telemetry_now(),
            &levels_now,
            &permissions.snapshot(),
            false,
            None,
        );
        let mut meters = AudioMeters::default();
        let meters_view = meters.step(&snap, &levels_now, Instant::now());
        let mic_gain = cx.new(|_| {
            SliderState::new()
                .min(-24.0)
                .max(24.0)
                .step(1.0)
                .default_value(model.audio.microphone.row.gain_db as f32)
        });
        let sys_gain = cx.new(|_| {
            let gain = model
                .audio
                .system_audio
                .as_ref()
                .map(|s| s.row.gain_db as f32)
                .unwrap_or(-6.0);
            SliderState::new()
                .min(-24.0)
                .max(12.0)
                .step(1.0)
                .default_value(gain)
        });
        let sounds_gain = cx.new(|_| {
            SliderState::new()
                .min(SOUNDS_VOLUME_RANGE.0 as f32)
                .max(SOUNDS_VOLUME_RANGE.1 as f32)
                .step(1.0)
                .default_value(model.audio.sounds.volume_db as f32)
        });
        let sync_ms = cx.new(|_| {
            SliderState::new()
                .min(-1000.0)
                .max(1000.0)
                .step(10.0)
                .default_value(model.audio.microphone.sync_ms as f32)
        });

        cx.subscribe(&mic_gain, |this, state, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
            };
            this.ui.mic_gain_live = matches!(event, SliderEvent::Change(_));
            let studio = this.studio.clone();
            this.run_studio(async move {
                studio.set_microphone_gain(value).await;
            });
            let _ = state;
            cx.notify();
        })
        .detach();
        cx.subscribe(&sys_gain, |this, state, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
            };
            this.ui.sys_gain_live = matches!(event, SliderEvent::Change(_));
            let studio = this.studio.clone();
            this.run_studio(async move {
                studio.set_system_audio_gain(value).await;
            });
            let _ = state;
            cx.notify();
        })
        .detach();
        cx.subscribe(&sounds_gain, |this, state, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end() as i32,
            };
            match event {
                SliderEvent::Change(_) => {
                    this.ui.sounds_gain_live = true;
                    if let Some(board) = this.board.as_mut() {
                        board.volume_db = value;
                    }
                }
                SliderEvent::Release(_) => {
                    this.ui.sounds_gain_live = false;
                    match this.board.as_mut() {
                        Some(board) => board.volume_db = value,
                        None => {
                            this.board = Some(SoundsBoard {
                                volume_db: value,
                                monitor: true,
                            });
                        }
                    }
                    // Push before the next paint so sync_sliders does not snap
                    // the fader back to the previous model value.
                    this.push_model(cx);
                    this.apply_sounds_settings(
                        SoundboardSettingsParams {
                            volume_db: Some(value),
                            ..Default::default()
                        },
                        cx,
                    );
                }
            }
            let _ = state;
            cx.notify();
        })
        .detach();
        cx.subscribe(&sync_ms, |this, state, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end() as i32,
            };
            this.ui.sync_live = matches!(event, SliderEvent::Change(_));
            let studio = this.studio.clone();
            let reset = value == 0;
            this.run_studio(async move {
                studio.set_microphone_sync_offset(value, reset).await;
            });
            let _ = state;
            cx.notify();
        })
        .detach();

        let studio_watch = studio.clone();
        let permissions_watch = permissions.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            let mut telemetry_rx = studio_watch.telemetry();
            let mut levels_rx = studio_watch.mic_levels();
            loop {
                tokio::select! {
                    changed = studio_rx.changed() => if changed.is_err() { break },
                    changed = telemetry_rx.changed() => if changed.is_err() { break },
                    changed = levels_rx.changed() => if changed.is_err() { break },
                }
                let snapshot = studio_rx.borrow().clone();
                let telemetry = telemetry_rx.borrow().clone();
                let levels = levels_rx.borrow().clone();
                let media = permissions_watch.snapshot();
                let _ = this.update(cx, |panel, cx| {
                    panel.rebuild(&snapshot, &telemetry, &levels, &media, cx);
                });
            }
        })
        .detach();
        let mut panel = Self {
            studio,
            permissions,
            runtime,
            model,
            shell: None,
            ui: SourcesUi::default(),
            refreshing: false,
            board: None,
            board_loading: false,
            meters,
            meters_view,
            retro: snap.settings.studio.retro_lcd_studio(),
            settling: false,
            mic_gain,
            sys_gain,
            sounds_gain,
            sync_ms,
            mic_focus: cx.focus_handle(),
            sys_focus: cx.focus_handle(),
            sounds_focus: cx.focus_handle(),
        };
        panel.load_board(cx);
        panel
    }

    pub fn bind_shell(&mut self, shell: WeakEntity<Shell>) {
        self.shell = Some(shell);
    }

    fn load_board(&mut self, cx: &mut Context<Self>) {
        if self.board_loading {
            return;
        }
        self.board_loading = true;
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move { studio.backend().sounds_list().await })
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.board_loading = false;
                match result {
                    Ok(Ok(board)) => {
                        panel.board = Some(SoundsBoard {
                            volume_db: board.volume_db,
                            monitor: board.monitor,
                        });
                        panel.push_model(cx);
                    }
                    Ok(Err(err)) => {
                        eprintln!("[videorc-app] Sources sounds.list: {err}");
                        panel.schedule_board_retry(cx);
                    }
                    Err(err) => {
                        eprintln!("[videorc-app] Sources sounds.list join: {err}");
                        panel.schedule_board_retry(cx);
                    }
                }
            });
        })
        .detach();
    }

    fn schedule_board_retry(&mut self, cx: &mut Context<Self>) {
        if self.board.is_some() || self.board_loading {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(3)).await;
            let _ = this.update(cx, |panel, cx| {
                if panel.board.is_none() {
                    panel.load_board(cx);
                }
            });
        })
        .detach();
    }

    fn apply_sounds_settings(
        &mut self,
        settings: SoundboardSettingsParams,
        cx: &mut Context<Self>,
    ) {
        if let Some(board) = self.board.as_mut() {
            if let Some(volume_db) = settings.volume_db {
                board.volume_db = volume_db;
            }
            if let Some(monitor) = settings.monitor {
                board.monitor = monitor;
            }
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move {
                    studio
                        .backend()
                        .sounds_request("sounds.settings", json!(settings))
                        .await
                })
                .await;
            let _ = this.update(cx, |panel, cx| {
                match result {
                    Ok(Ok(value)) => {
                        if let Ok(board) = serde_json::from_value::<
                            videorc_app_core::protocol::SoundboardState,
                        >(value)
                        {
                            panel.board = Some(SoundsBoard {
                                volume_db: board.volume_db,
                                monitor: board.monitor,
                            });
                        }
                        panel.push_model(cx);
                    }
                    Ok(Err(err)) => {
                        eprintln!("[videorc-app] Sources sounds.settings: {err}");
                        // Drop the optimistic value and reload the board.
                        panel.board = None;
                        panel.load_board(cx);
                    }
                    Err(err) => {
                        eprintln!("[videorc-app] Sources sounds.settings join: {err}");
                        panel.board = None;
                        panel.load_board(cx);
                    }
                }
            });
        })
        .detach();
    }

    fn rebuild(
        &mut self,
        snapshot: &StudioSnapshot,
        telemetry: &HealthTelemetry,
        levels: &MicLevels,
        media: &MediaAccessSnapshot,
        cx: &mut Context<Self>,
    ) {
        self.retro = snapshot.settings.studio.retro_lcd_studio();
        self.meters_view = self.meters.step(snapshot, levels, Instant::now());
        self.ensure_meter_ticks(cx);
        if self.board.is_none() {
            self.load_board(cx);
        }
        let next = SourcesModel::of(
            snapshot,
            telemetry,
            levels,
            media,
            self.refreshing,
            self.board,
        );
        if self.model != next {
            self.model = next;
            cx.notify();
        } else {
            cx.notify();
        }
    }

    fn ensure_meter_ticks(&mut self, cx: &mut Context<Self>) {
        if self.meters.settled() || self.settling {
            return;
        }
        self.settling = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(METER_TICK).await;
                let done = this
                    .update(cx, |panel, cx| {
                        let snapshot = panel.studio.watch().borrow().clone();
                        let levels = panel.studio.mic_levels().borrow().clone();
                        panel.meters_view = panel.meters.step(&snapshot, &levels, Instant::now());
                        let done = panel.meters.settled();
                        cx.notify();
                        done
                    })
                    .ok()
                    .unwrap_or(true);
                if done {
                    let _ = this.update(cx, |panel, _| panel.settling = false);
                    break;
                }
            }
        })
        .detach();
    }

    fn focus_previous_strip(
        &mut self,
        _: &FocusPreviousStrip,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_strip_focus(-1, window, cx);
    }

    fn focus_next_strip(
        &mut self,
        _: &FocusNextStrip,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_strip_focus(1, window, cx);
    }

    fn move_strip_focus(&mut self, direction: i8, window: &mut Window, cx: &mut Context<Self>) {
        let has_system = self.model.audio.system_audio.is_some();
        let strips: Vec<FocusHandle> = if has_system {
            vec![
                self.mic_focus.clone(),
                self.sys_focus.clone(),
                self.sounds_focus.clone(),
            ]
        } else {
            vec![self.mic_focus.clone(), self.sounds_focus.clone()]
        };
        let current = strips
            .iter()
            .position(|handle| handle.contains_focused(window, cx));
        let index = match current {
            Some(i) => i as isize,
            None if direction > 0 => -1,
            None => strips.len() as isize,
        };
        let next = index + direction as isize;
        if next >= 0 && (next as usize) < strips.len() {
            window.focus(&strips[next as usize], cx);
        }
    }

    fn level_meter(
        &self,
        meter: videorc_app_core::studio::audio_mixer::MeterView,
        lcd: &videorc_app_core::studio::audio_mixer::LcdMeterView,
        muted: bool,
        theme: &videorc_kit::tokens::Theme,
    ) -> AnyElement {
        if self.retro {
            lcd_meter(meter, lcd, muted, theme).into_any_element()
        } else {
            segmented_meter(meter, muted, theme).into_any_element()
        }
    }

    fn push_model(&mut self, cx: &mut Context<Self>) {
        self.rebuild(
            &*self.studio.watch().borrow(),
            &self.studio.telemetry_now(),
            &*self.studio.mic_levels().borrow(),
            &self.permissions.snapshot(),
            cx,
        );
    }

    fn sync_sliders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mic = self.model.audio.microphone.row.gain_db as f32;
        if !self.ui.mic_gain_live {
            self.mic_gain.update(cx, |state, cx| {
                if (state.value().end() - mic).abs() >= 0.5 {
                    state.set_value(mic, window, cx);
                }
            });
        }
        if let Some(system) = self.model.audio.system_audio.as_ref() {
            let gain = system.row.gain_db as f32;
            if !self.ui.sys_gain_live {
                self.sys_gain.update(cx, |state, cx| {
                    if (state.value().end() - gain).abs() >= 0.5 {
                        state.set_value(gain, window, cx);
                    }
                });
            }
        }
        let sync = self.model.audio.microphone.sync_ms as f32;
        if !self.ui.sync_live {
            self.sync_ms.update(cx, |state, cx| {
                if (state.value().end() - sync).abs() >= 5.0 {
                    state.set_value(sync, window, cx);
                }
            });
        }
        let sounds = self.model.audio.sounds.volume_db as f32;
        if !self.ui.sounds_gain_live {
            self.sounds_gain.update(cx, |state, cx| {
                if (state.value().end() - sounds).abs() >= 0.5 {
                    state.set_value(sounds, window, cx);
                }
            });
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.refreshing {
            return;
        }
        self.refreshing = true;
        self.push_model(cx);
        let studio = self.studio.clone();
        let (tx, rx) = oneshot::channel();
        self.runtime.spawn(async move {
            let result = studio.refresh_sources().await;
            eprintln!("[videorc-app] Sources Refresh: {result:?}");
            let _ = tx.send(());
        });
        cx.spawn(async move |this, cx| {
            let _ = rx.await;
            let _ = this.update(cx, |panel, cx| {
                panel.refreshing = false;
                panel.push_model(cx);
            });
        })
        .detach();
    }

    fn select_device(&mut self, kind: SourceKind, value: String, cx: &mut Context<Self>) {
        cx.notify();
        let studio = self.studio.clone();
        let picked = (value != PICKER_NONE_VALUE).then_some(value);
        self.runtime.spawn(async move {
            let result = studio.select_source_device(kind, picked.as_deref()).await;
            eprintln!("[videorc-app] Sources select {kind:?}: {result:?}");
        });
    }

    fn mute_toggle(&mut self) {
        let studio = self.studio.clone();
        let muted = !studio
            .watch()
            .borrow()
            .settings
            .capture
            .audio
            .microphone_muted;
        self.runtime.spawn(async move {
            let ok = studio.request_microphone_mute(muted).await;
            eprintln!("[videorc-app] Sources mute: {ok}");
        });
    }

    fn run_studio(&self, job: impl std::future::Future<Output = ()> + Send + 'static) {
        self.runtime.spawn(job);
    }

    fn run_alert(&mut self, pane: SystemPermissionPane, cx: &mut Context<Self>) {
        let media = self.permissions.snapshot();
        let snapshot = self.studio.watch().borrow().clone();
        let inputs = permission_inputs(&snapshot, Some(&media));
        let row = match pane {
            SystemPermissionPane::ScreenRecording => inputs.screen.as_ref(),
            SystemPermissionPane::Camera => inputs.camera.as_ref(),
            SystemPermissionPane::Microphone => inputs.microphone.as_ref(),
            SystemPermissionPane::Privacy => None,
        };
        let Some(action) = row.and_then(|row| row.action) else {
            return;
        };
        self.ui.pending_alert = Some(pane);
        cx.notify();
        match action {
            GrantAction::RequestMediaAccess => {
                let task = self.permissions.request(cx, pane);
                cx.spawn(async move |this, cx| {
                    let _ = task.await;
                    let _ = this.update(cx, |panel, cx| {
                        panel.ui.pending_alert = None;
                        panel.push_model(cx);
                    });
                })
                .detach();
            }
            GrantAction::OpenSettings => {
                let _ = self.permissions.open_settings(cx, pane);
                self.ui.pending_alert = None;
                cx.notify();
            }
            GrantAction::Relaunch => {
                let task = self.permissions.relaunch(cx);
                cx.spawn(async move |this, cx| {
                    let _ = task.await;
                    let _ = this.update(cx, |panel, cx| {
                        panel.ui.pending_alert = None;
                        cx.notify();
                    });
                })
                .detach();
            }
        }
    }

    fn open_page(&mut self, page: PageId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(shell) = self.shell.as_ref() {
            let _ = shell.update(cx, |shell, cx| shell.open_page(page, window, cx));
        }
    }

    fn toggle_more(&mut self, key: &'static str, cx: &mut Context<Self>) {
        if !self.ui.more.insert(key) {
            self.ui.more.remove(key);
        }
        cx.notify();
    }

    fn muted_line(
        &self,
        t: &videorc_kit::tokens::Theme,
        text_value: impl Into<SharedString>,
    ) -> impl IntoElement {
        div()
            .type_scale(text::META)
            .text_color(hsla(t.muted_foreground))
            .child(text_value.into())
    }
}

impl SourcesPanel {
    fn render_alerts(
        &self,
        alerts: &[SourcePermissionAlert],
        device_problem: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(8.));
        for alert in alerts {
            let pane = alert.pane;
            let pending = self.ui.pending_alert == Some(pane);
            let entity = cx.entity();
            column = column.child(
                Alert::new(format!("alert-{}", pane.as_str()))
                    .variant(AlertVariant::Warning)
                    .title(alert.title.clone())
                    .description(alert.description.clone())
                    .action(
                        Button::new(format!("alert-action-{}", pane.as_str()))
                            .label(if pending {
                                SharedString::from("…")
                            } else {
                                alert.action_label.clone().into()
                            })
                            .variant(ButtonVariant::Outline)
                            .disabled(pending)
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |panel, cx| panel.run_alert(pane, cx));
                            }),
                    ),
            );
        }
        if device_problem {
            let entity = cx.entity();
            column = column.child(
                Alert::new("device-problem")
                    .variant(AlertVariant::Warning)
                    .title(page_copy::DEVICE_PROBLEM)
                    .action(
                        Button::new("open-health")
                            .label(OPEN_HEALTH_LABEL)
                            .variant(ButtonVariant::Ghost)
                            .on_click(move |_, window, cx| {
                                entity.update(cx, |panel, cx| {
                                    panel.open_page(PageId::Diagnostics, window, cx);
                                });
                            }),
                    ),
            );
        }
        column.into_any_element()
    }

    fn render_picker(
        &self,
        id: &'static str,
        kind: SourceKind,
        picker: &PickerView,
        disabled: bool,
        disabled_reason: Option<&str>,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let mut block = div().flex().flex_col().gap(px(6.));
        if !picker.list_status.is_empty() {
            block = block.child(self.muted_line(t, picker.list_status.clone()));
        }
        if let Some(reason) = disabled_reason {
            block = block.child(self.muted_line(t, reason.to_string()));
        }
        block = block.child(
            fill_select(id, picker, disabled).on_change(move |value, _, cx| {
                entity.update(cx, |panel, cx| {
                    panel.select_device(kind, value.to_string(), cx);
                });
            }),
        );
        block.into_any_element()
    }

    fn render_video_row(
        &self,
        title: &'static str,
        kind: SourceKind,
        picker_id: &'static str,
        video: &VideoSourceView,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let disabled = video.disabled || video.row.disabled_reason.is_some();
        let mut chips = div().flex().items_center().gap(px(8.));
        if let Some(status) = video.status.as_ref() {
            chips = chips.child(status_chip(
                format!("{picker_id}-status"),
                status.label.clone(),
                status.tone,
            ));
        }
        if let Some(line) = video.row.status.as_ref() {
            chips = chips.child(status_chip(
                format!("{picker_id}-row-status"),
                line.message.clone(),
                ChipTone::Warn,
            ));
        }
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(ListRow::new(format!("{picker_id}-title"), title).child(chips));
        if let Some(hint) = video.status.as_ref().and_then(|s| s.hint.as_ref()) {
            body = body.child(div().px(px(12.)).child(self.muted_line(t, hint.clone())));
        }
        body = body.child(div().px(px(12.)).child(self.render_picker(
            picker_id,
            kind,
            &video.row.picker,
            disabled,
            video.row.disabled_reason.as_deref(),
            t,
            cx,
        )));
        if let Some(shortfall) = video.shortfall.as_ref() {
            body = body.child(
                div().px(px(12.)).child(
                    Alert::new(format!("{picker_id}-shortfall"))
                        .variant(AlertVariant::Warning)
                        .title(shortfall.clone()),
                ),
            );
        } else if let Some(facts) = video.facts.as_ref() {
            body = body.child(
                div()
                    .px(px(12.))
                    .pb(px(4.))
                    .child(self.muted_line(t, facts.clone())),
            );
        }
        if let Some(scene) = video.scene.as_ref() {
            let entity = cx.entity();
            body = body.child(
                NavigableRow::new(
                    format!("{picker_id}-scene"),
                    scene.line.clone(),
                    scene.open_label,
                )
                .on_navigate(move |_, window, cx| {
                    entity.update(cx, |panel, cx| {
                        panel.open_page(PageId::Studio, window, cx);
                    });
                }),
            );
        }
        if let Some(low_light) = video.low_light.as_ref() {
            let checked = low_light.checked;
            let disabled = low_light.disabled;
            let entity = cx.entity();
            body = body.child(
                div()
                    .child(
                        ListRow::new("low-light", low_light.label).child(
                            Switch::new("low-light-switch")
                                .accessibility_label(low_light.label)
                                .checked(checked)
                                .disabled(disabled)
                                .on_change(move |value, _, cx| {
                                    entity.update(cx, |panel, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            let _ = studio.set_camera_low_light(value).await;
                                        });
                                    });
                                }),
                        ),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .child(self.muted_line(t, low_light.description)),
                    ),
            );
        }
        GroupedList::new().item(body).into_any_element()
    }
}

impl Render for SourcesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_sliders(window, cx);
        let t = theme::current(window, cx).theme();
        let page = self.model.page.clone();
        let audio = self.model.audio.clone();
        let refresh_label = if page.refreshing {
            page_copy::REFRESHING
        } else {
            page_copy::REFRESH
        };
        let entity = cx.entity();

        let header = PanelSection::new("sources-header")
            .description(page.description)
            .action(
                Button::new("sources-refresh")
                    .label(refresh_label)
                    .variant(ButtonVariant::Secondary)
                    .disabled(page.refreshing)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |panel, cx| panel.refresh(cx));
                    }),
            );

        let mut video = PanelSection::new("sources-video")
            .title(page_copy::VIDEO)
            .description(page.video_description)
            .child(self.render_video_row(
                sources::copy::SCREEN,
                SourceKind::Capture,
                "screen-picker",
                &page.screen,
                t,
                cx,
            ));
        if let Some(synthetic) = page.synthetic.as_ref() {
            let checked = synthetic.checked;
            let disabled = synthetic.disabled;
            let entity = cx.entity();
            video = video.child(
                GroupedList::new().item(
                    div()
                        .child(
                            ListRow::new("synthetic", page_copy::SYNTHETIC).child(
                                Switch::new("synthetic-switch")
                                    .accessibility_label(page_copy::SYNTHETIC)
                                    .checked(checked)
                                    .disabled(disabled)
                                    .on_change(move |value, _, cx| {
                                        entity.update(cx, |panel, _| {
                                            let studio = panel.studio.clone();
                                            panel.run_studio(async move {
                                                let _ = studio.set_test_pattern(value).await;
                                            });
                                        });
                                    }),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .child(self.muted_line(t, page_copy::SYNTHETIC_DESCRIPTION)),
                        ),
                ),
            );
        }
        video = video.child(self.render_video_row(
            section_copy::CAMERA,
            SourceKind::Camera,
            "camera-picker",
            &page.camera,
            t,
            cx,
        ));

        let mut audio_col = PanelSection::new("sources-audio")
            .title(audio_copy::AUDIO)
            .description(audio.description);

        // Microphone
        {
            let mic = &audio.microphone;
            let more = self.ui.more.contains("mic");
            let muted = mic.row.muted;
            let mut chips = div().flex().items_center().gap(px(8.));
            if let Some(chip) = mic.chip.as_ref() {
                chips = chips.child(status_chip("mic-chip", chip.label.clone(), chip.tone));
            }
            if let Some(tag) = mic.sync_tag.as_ref() {
                chips = chips.child(tag_badge(tag.clone()));
            }
            let entity = cx.entity();
            let mute = Switch::new("mute-mic")
                .accessibility_label(if muted {
                    audio_mixer::copy::UNMUTE_MICROPHONE
                } else {
                    audio_mixer::copy::MUTE_MICROPHONE
                })
                .checked(muted)
                .on_change(move |_, _, cx| {
                    entity.update(cx, |panel, _| panel.mute_toggle());
                });
            let entity = cx.entity();
            let more_btn = more_button("more-mic", more, t, move |_, _, cx| {
                entity.update(cx, |panel, cx| panel.toggle_more("mic", cx));
            });
            let mut card = div()
                .id(mic.focus)
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    ListRow::new("mic-title", audio_mixer::copy::MICROPHONE)
                        .child(chips)
                        .child(mute)
                        .child(more_btn),
                )
                .child(div().px(px(12.)).child(self.render_picker(
                    "mic-picker",
                    SourceKind::Microphone,
                    &mic.row.picker,
                    mic.row.disabled_reason.is_some(),
                    mic.row.disabled_reason.as_deref(),
                    t,
                    cx,
                )));
            if !mic.selected {
                card = card.child(
                    div()
                        .px(px(12.))
                        .child(self.muted_line(t, audio_copy::NO_MICROPHONE)),
                );
            } else {
                card = card
                    .child(
                        div()
                            .px(px(12.))
                            .child(self.muted_line(t, audio_mixer::copy::MICROPHONE_LEVEL)),
                    )
                    .child(div().px(px(12.)).child(self.level_meter(
                        self.meters_view.microphone,
                        &self.meters_view.microphone_lcd,
                        muted,
                        t,
                    )));
                if let Some(line) = mic.level_line {
                    card = card.child(div().px(px(12.)).child(self.muted_line(t, line)));
                }
                let gain_text = mic.row.gain_text.clone();
                card = card.child(
                    ListRow::new("mic-gain", audio_mixer::copy::GAIN)
                        .meta(gain_text)
                        .child(
                            div().w(px(180.)).child(
                                Slider::new(&self.mic_gain)
                                    .accessibility_label(audio_mixer::copy::GAIN),
                            ),
                        ),
                );
                if let Some(reset) = mic.row.gain_reset.clone() {
                    let entity = cx.entity();
                    card = card.child(
                        div().px(px(12.)).child(
                            Button::new("mic-gain-reset")
                                .label(reset)
                                .variant(ButtonVariant::Ghost)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |panel, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            studio.set_microphone_gain(0.0).await;
                                        });
                                    });
                                }),
                        ),
                    );
                }
                let noise_on = mic.noise_reduction.checked;
                let noise_disabled = mic.noise_reduction.disabled;
                let entity = cx.entity();
                card = card
                    .child(
                        ListRow::new("noise-reduction", audio_copy::NOISE_REDUCTION).child(
                            Switch::new("noise-reduction-switch")
                                .accessibility_label(audio_copy::NOISE_REDUCTION)
                                .checked(noise_on)
                                .disabled(noise_disabled)
                                .on_change(move |value, _, cx| {
                                    entity.update(cx, |panel, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            studio.set_microphone_noise_suppression(value).await;
                                        });
                                    });
                                }),
                        ),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .child(self.muted_line(t, mic.noise_reduction.description.clone())),
                    );
            }
            if more {
                let sync = mic.sync_ms;
                let entity = cx.entity();
                card = card.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .pt(px(8.))
                        .border_t_1()
                        .border_color(hsla(t.border))
                        .child(
                            div()
                                .px(px(12.))
                                .type_scale(text::META)
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(audio_copy::MORE_MICROPHONE),
                        )
                        .child(
                            ListRow::new("mic-sync", audio_copy::MICROPHONE_SYNC)
                                .meta(format!("{sync:+} ms"))
                                .child(
                                    div().w(px(180.)).child(
                                        Slider::new(&self.sync_ms)
                                            .accessibility_label(audio_copy::MICROPHONE_SYNC),
                                    ),
                                )
                                .child(
                                    Button::new("sync-reset")
                                        .label("Reset")
                                        .variant(ButtonVariant::Ghost)
                                        .on_click(move |_, _, cx| {
                                            entity.update(cx, |panel, _| {
                                                let studio = panel.studio.clone();
                                                panel.run_studio(async move {
                                                    studio
                                                        .set_microphone_sync_offset(0, true)
                                                        .await;
                                                });
                                            });
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .child(self.muted_line(t, mic.sync_description.clone())),
                        ),
                );
                if let Some(keep) = mic.keep_ready.as_ref() {
                    let checked = keep.checked;
                    let entity = cx.entity();
                    card = card
                        .child(
                            ListRow::new("keep-ready", audio_copy::KEEP_READY).child(
                                Switch::new("keep-ready-switch")
                                    .accessibility_label(audio_copy::KEEP_READY)
                                    .checked(checked)
                                    .on_change(move |value, _, cx| {
                                        entity.update(cx, |panel, _| {
                                            let studio = panel.studio.clone();
                                            panel.run_studio(async move {
                                                studio.set_keep_microphone_warm(value).await;
                                            });
                                        });
                                    }),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .child(self.muted_line(t, keep.description.clone())),
                        );
                }
            }
            audio_col = audio_col.child(
                GroupedList::new().item(
                    div()
                        .id("sources-channel-strip-microphone")
                        .track_focus(&self.mic_focus)
                        .tab_index(0)
                        .child(card),
                ),
            );
        }

        // System audio
        if let Some(system) = audio.system_audio.clone() {
            let more = self.ui.more.contains("system");
            let mut chips = div().flex().items_center().gap(px(8.));
            if let Some(chip) = system.chip.as_ref() {
                chips = chips.child(status_chip("system-chip", chip.label.clone(), chip.tone));
            } else if let Some(chip) = system.row.chip.as_ref() {
                chips = chips.child(status_chip(
                    "system-row-chip",
                    chip.label,
                    ChipTone::Neutral,
                ));
            }
            let checked = system.row.checked;
            let disabled = system.row.disabled;
            let entity = cx.entity();
            let toggle = Switch::new("system-audio-toggle")
                .accessibility_label(audio_mixer::copy::SYSTEM_AUDIO)
                .checked(checked)
                .disabled(disabled)
                .on_change(move |value, _, cx| {
                    entity.update(cx, |panel, _| {
                        let studio = panel.studio.clone();
                        panel.run_studio(async move {
                            studio.set_system_audio_enabled(value).await;
                        });
                    });
                });
            let entity = cx.entity();
            let more_btn = more_button("more-system", more, t, move |_, _, cx| {
                entity.update(cx, |panel, cx| panel.toggle_more("system", cx));
            });
            let mut card = div()
                .id(system.focus)
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    ListRow::new("system-title", audio_mixer::copy::SYSTEM_AUDIO)
                        .child(chips)
                        .child(toggle)
                        .child(more_btn),
                )
                .child(
                    div()
                        .px(px(12.))
                        .child(self.muted_line(t, system.facts.clone())),
                );
            if system.row.show_level {
                card = card.child(div().px(px(12.)).child(self.level_meter(
                    self.meters_view.system_audio,
                    &self.meters_view.system_audio_lcd,
                    false,
                    t,
                )));
            } else if system.row.idle_line {
                card = card.child(
                    div()
                        .px(px(12.))
                        .child(self.muted_line(t, audio_mixer::copy::IDLE_LINE)),
                );
            }
            if system.row.show_gain {
                card = card.child(
                    ListRow::new("sys-gain", audio_mixer::copy::GAIN)
                        .meta(system.row.gain_text.clone())
                        .child(
                            div().w(px(180.)).child(
                                Slider::new(&self.sys_gain)
                                    .accessibility_label(audio_mixer::copy::GAIN),
                            ),
                        ),
                );
                if let Some(reset) = system.row.gain_reset.clone() {
                    let entity = cx.entity();
                    card = card.child(
                        div().px(px(12.)).child(
                            Button::new("sys-gain-reset")
                                .label(reset)
                                .variant(ButtonVariant::Ghost)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |panel, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            studio.set_system_audio_gain(-6.0).await;
                                        });
                                    });
                                }),
                        ),
                    );
                }
            }
            if let Some(issue) = system.issue.clone() {
                let action = system.issue_action;
                let entity = cx.entity();
                let mut alert = Alert::new("system-issue")
                    .variant(AlertVariant::Warning)
                    .title(issue);
                if let Some(action) = action {
                    let label = match action {
                        IssueAction::OpenPermissions => audio_mixer::copy::OPEN_PERMISSIONS,
                        IssueAction::Resume => audio_mixer::copy::RESUME,
                    };
                    alert = alert.action(
                        Button::new("system-issue-action")
                            .label(label)
                            .variant(ButtonVariant::Outline)
                            .on_click(move |_, window, cx| {
                                entity.update(cx, |panel, cx| match action {
                                    IssueAction::OpenPermissions => {
                                        panel.open_page(PageId::Settings, window, cx);
                                    }
                                    IssueAction::Resume => {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            studio.resume_system_audio().await;
                                        });
                                    }
                                });
                            }),
                    );
                }
                card = card.child(div().px(px(12.)).child(alert));
            }
            if more {
                let echo = system.echo_guard;
                let entity = cx.entity();
                card = card.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .pt(px(8.))
                        .border_t_1()
                        .border_color(hsla(t.border))
                        .child(
                            div()
                                .px(px(12.))
                                .type_scale(text::META)
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(audio_copy::MORE_SYSTEM_AUDIO),
                        )
                        .child(
                            ListRow::new("echo-guard", audio_copy::ECHO_GUARD).child(
                                Switch::new("echo-guard-switch")
                                    .accessibility_label(audio_copy::ECHO_GUARD)
                                    .checked(echo)
                                    .on_change(move |value, _, cx| {
                                        entity.update(cx, |panel, _| {
                                            let studio = panel.studio.clone();
                                            panel.run_studio(async move {
                                                studio.set_system_audio_echo_guard(value).await;
                                            });
                                        });
                                    }),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .child(self.muted_line(t, system.echo_guard_description.clone())),
                        ),
                );
                for note in &system.notes {
                    card = card.child(
                        div()
                            .px(px(12.))
                            .child(self.muted_line(t, format!("• {note}"))),
                    );
                }
            }
            audio_col = audio_col.child(
                GroupedList::new().item(
                    div()
                        .id("sources-channel-strip-system-audio")
                        .track_focus(&self.sys_focus)
                        .tab_index(0)
                        .child(card),
                ),
            );
        }

        // Sounds
        {
            let sounds = &audio.sounds;
            let disabled = sounds.disabled;
            let mut card = div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(ListRow::new("sounds-title", audio_copy::SOUNDS));
            if sounds.show_level {
                card = card.child(div().px(px(12.)).child(self.level_meter(
                    self.meters_view.sounds,
                    &self.meters_view.sounds_lcd,
                    false,
                    t,
                )));
            } else {
                card = card.child(
                    div()
                        .px(px(12.))
                        .child(self.muted_line(t, audio_copy::SOUNDS_IDLE)),
                );
            }
            let volume_text = sounds.volume_text.clone();
            card = card.child(
                ListRow::new("sounds-level", audio_copy::LEVEL)
                    .meta(volume_text)
                    .child(
                        div().w(px(180.)).child(
                            Slider::new(&self.sounds_gain)
                                .accessibility_label(audio_copy::SOUNDS_LEVEL)
                                .disabled(disabled),
                        ),
                    ),
            );
            if let Some(reset) = sounds.volume_reset.clone() {
                let entity = cx.entity();
                card = card.child(
                    div().px(px(12.)).child(
                        Button::new("sounds-level-reset")
                            .label(reset)
                            .variant(ButtonVariant::Ghost)
                            .disabled(disabled)
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |panel, cx| {
                                    panel.apply_sounds_settings(
                                        SoundboardSettingsParams {
                                            volume_db: Some(SOUNDS_VOLUME_DEFAULT),
                                            ..Default::default()
                                        },
                                        cx,
                                    );
                                });
                            }),
                    ),
                );
            }
            let entity = cx.entity();
            let monitor = sounds.monitor;
            card = card
                .child(
                    ListRow::new("hear-sounds", audio_copy::HEAR_SOUNDS).child(
                        Switch::new("hear-sounds-switch")
                            .accessibility_label(audio_copy::HEAR_SOUNDS)
                            .checked(monitor)
                            .disabled(disabled)
                            .on_change(move |value, _, cx| {
                                entity.update(cx, |panel, cx| {
                                    panel.apply_sounds_settings(
                                        SoundboardSettingsParams {
                                            monitor: Some(value),
                                            ..Default::default()
                                        },
                                        cx,
                                    );
                                });
                            }),
                    ),
                )
                .child(
                    div()
                        .px(px(12.))
                        .pb(px(8.))
                        .child(self.muted_line(t, audio_copy::HEAR_SOUNDS_DESCRIPTION)),
                );
            audio_col = audio_col.last(true).child(
                GroupedList::new().item(
                    div()
                        .id("sources-channel-strip-sounds")
                        .track_focus(&self.sounds_focus)
                        .tab_index(0)
                        .child(card),
                ),
            );
        }

        let audio_mixer = div()
            .id("sources-audio-channels")
            .key_context(KEY_CONTEXT)
            .on_action(cx.listener(Self::focus_previous_strip))
            .on_action(cx.listener(Self::focus_next_strip))
            .child(audio_col);

        div()
            .id("sources-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                ScrollArea::new("sources-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .px(px(size::GUTTER))
                        .py(px(8.))
                        .gap(px(8.))
                        .child(header)
                        .children(
                            (!page.alerts.is_empty() || page.device_problem)
                                .then(|| self.render_alerts(&page.alerts, page.device_problem, cx)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_start()
                                .gap(px(8.))
                                .child(div().flex_1().min_w(px(360.)).child(video))
                                .child(div().flex_1().min_w(px(360.)).child(audio_mixer)),
                        ),
                ),
            )
    }
}
