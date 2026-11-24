//! The Sources page (plan 260 Phase 3, L4): video and audio capture homes,
//! permission alerts, and Refresh. Words and state come from
//! `videorc_app_core::studio::{sources_page, sources_audio}`.
//!
//! Kit use is limited to the #1935 sync (Alert, GroupedList/ListRow,
//! PanelSection, theme/tokens). Button, Switch, Select, Slider, Badge and
//! ScrollArea wait on the rest of the kit sync; those controls stay kit-free
//! here until that lands.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use gpui::{AnyElement, Context, SharedString, WeakEntity, Window, div, prelude::*, px};
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
use videorc_app_core::studio::audio_levels::MicLevels;
use videorc_app_core::studio::audio_mixer;
use videorc_app_core::studio::audio_section::IssueAction;
use videorc_app_core::studio::health::HealthTelemetry;
use videorc_app_core::studio::health_page::OPEN_HEALTH_LABEL;
use videorc_app_core::studio::source_selection::{PICKER_NONE_VALUE, PickerView, SourceKind};
use videorc_app_core::studio::sources;
use videorc_app_core::studio::sources_audio::{
    SourcesAudioInputs, SourcesAudioView, copy as audio_copy,
};
use videorc_app_core::studio::sources_page::{
    ChipTone, GrantAction, GrantRow, GrantState, PermissionInputs, SourcePermissionAlert,
    SourcesPageInput, SourcesPageView, VideoSourceView, copy as page_copy, sources_page_view,
};
use videorc_app_core::studio::sources_section::copy as section_copy;
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{Color, Theme, size, text};

use crate::app::permissions::Permissions;
use crate::app::shell::Shell;

pub type AppStudio = Studio<BackendClient>;

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

fn chip_tone_color(t: &Theme, tone: ChipTone) -> Color {
    match tone {
        ChipTone::Neutral => t.muted_foreground,
        ChipTone::Good => t.success,
        ChipTone::Warn => t.warning,
        ChipTone::Error => t.destructive,
    }
}

fn status_chip(t: &Theme, label: impl Into<SharedString>, tone: ChipTone) -> impl IntoElement {
    div()
        .px(px(8.))
        .py(px(2.))
        .rounded(px(6.))
        .bg(hsla(t.muted))
        .type_scale(text::META)
        .text_color(hsla(chip_tone_color(t, tone)))
        .child(label.into())
}

fn meter_bar(t: &Theme, peak_db: Option<f64>, show: bool) -> impl IntoElement {
    let amount = if show {
        peak_db
            .map(|db| ((db + 60.0) / 60.0).clamp(0.0, 1.0))
            .unwrap_or(0.0)
    } else {
        0.0
    };
    div()
        .h(px(8.))
        .w_full()
        .rounded(px(4.))
        .bg(hsla(t.border))
        .child(
            div()
                .h_full()
                .w(px((amount * 220.0) as f32))
                .rounded(px(4.))
                .bg(hsla(t.muted_foreground)),
        )
}

fn ghost_button(
    t: &Theme,
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(SharedString::from(id.into().to_string()))
        .px(px(10.))
        .py(px(5.))
        .rounded(px(6.))
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.secondary))
        .type_scale(text::META)
        .cursor_pointer()
        .child(label.into())
}

fn muted_line(t: &Theme, value: impl Into<SharedString>) -> impl IntoElement {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(value.into())
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
                    board: None,
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
    open_picker: Option<&'static str>,
    more: HashSet<&'static str>,
    pending_alert: Option<SystemPermissionPane>,
}

pub struct SourcesPanel {
    studio: Arc<AppStudio>,
    permissions: Arc<Permissions>,
    runtime: tokio::runtime::Handle,
    model: SourcesModel,
    shell: Option<WeakEntity<Shell>>,
    ui: SourcesUi,
    refreshing: bool,
}

impl SourcesPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        permissions: Arc<Permissions>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let model = SourcesModel::of(
            &*studio.watch().borrow(),
            &studio.telemetry_now(),
            &*studio.mic_levels().borrow(),
            &permissions.snapshot(),
            false,
        );
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
        Self {
            studio,
            permissions,
            runtime,
            model,
            shell: None,
            ui: SourcesUi::default(),
            refreshing: false,
        }
    }

    pub fn bind_shell(&mut self, shell: WeakEntity<Shell>) {
        self.shell = Some(shell);
    }

    fn rebuild(
        &mut self,
        snapshot: &StudioSnapshot,
        telemetry: &HealthTelemetry,
        levels: &MicLevels,
        media: &MediaAccessSnapshot,
        cx: &mut Context<Self>,
    ) {
        let next = SourcesModel::of(snapshot, telemetry, levels, media, self.refreshing);
        if self.model != next {
            self.model = next;
            cx.notify();
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
        self.ui.open_picker = None;
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

    fn toggle_picker(&mut self, id: &'static str, cx: &mut Context<Self>) {
        self.ui.open_picker = if self.ui.open_picker == Some(id) {
            None
        } else {
            Some(id)
        };
        cx.notify();
    }
}

impl SourcesPanel {
    fn render_alerts(
        &self,
        t: &Theme,
        alerts: &[SourcePermissionAlert],
        device_problem: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(8.));
        for alert in alerts {
            let pane = alert.pane;
            let pending = self.ui.pending_alert == Some(pane);
            column = column.child(
                Alert::new(format!("alert-{}", pane.as_str()))
                    .variant(AlertVariant::Warning)
                    .title(alert.title.clone())
                    .description(alert.description.clone())
                    .action(
                        ghost_button(
                            t,
                            format!("alert-action-{}", pane.as_str()),
                            if pending {
                                SharedString::from("…")
                            } else {
                                alert.action_label.clone().into()
                            },
                        )
                        .on_click(cx.listener(move |panel, _, _, cx| panel.run_alert(pane, cx))),
                    ),
            );
        }
        if device_problem {
            column = column.child(
                Alert::new("device-problem")
                    .variant(AlertVariant::Warning)
                    .title(page_copy::DEVICE_PROBLEM)
                    .action(ghost_button(t, "open-health", OPEN_HEALTH_LABEL).on_click(
                        cx.listener(|panel, _, window, cx| {
                            panel.open_page(PageId::Diagnostics, window, cx);
                        }),
                    )),
            );
        }
        column.into_any_element()
    }

    fn render_picker(
        &mut self,
        t: &Theme,
        id: &'static str,
        kind: SourceKind,
        picker: &PickerView,
        disabled: bool,
        disabled_reason: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = self.ui.open_picker == Some(id);
        let mut block = div().flex().flex_col().gap(px(6.));
        block = block.child(
            div()
                .id(id)
                .flex()
                .items_center()
                .justify_between()
                .px(px(10.))
                .py(px(8.))
                .rounded(px(8.))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.secondary))
                .when(!disabled, |row| {
                    row.cursor_pointer()
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.toggle_picker(id, cx);
                        }))
                })
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(if picker.placeholder {
                            t.muted_foreground
                        } else {
                            t.foreground
                        }))
                        .child(picker.label.clone()),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(if open { "▲" } else { "▼" }),
                ),
        );
        if let Some(reason) = disabled_reason {
            block = block.child(muted_line(t, reason.to_string()));
        }
        if !picker.list_status.is_empty() {
            block = block.child(muted_line(t, picker.list_status.clone()));
        }
        if open && !disabled {
            let mut list = div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .p(px(6.))
                .rounded(px(8.))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.secondary));
            for (index, item) in picker.items.iter().enumerate() {
                if !item.heading.is_empty() {
                    list = list.child(
                        div()
                            .px(px(8.))
                            .pt(px(8.))
                            .pb(px(2.))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(item.heading.clone()),
                    );
                    continue;
                }
                let value = item.value.clone();
                let item_disabled = item.disabled;
                list = list.child(
                    div()
                        .id(SharedString::from(format!("{id}-item-{index}")))
                        .flex()
                        .justify_between()
                        .px(px(8.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .when(item.selected, |row| row.bg(hsla(t.muted)))
                        .when(!item_disabled, |row| {
                            row.cursor_pointer()
                                .on_click(cx.listener(move |panel, _, _, cx| {
                                    panel.select_device(kind, value.clone(), cx);
                                }))
                        })
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(hsla(if item_disabled {
                                    t.muted_foreground
                                } else {
                                    t.foreground
                                }))
                                .child(item.label.clone()),
                        )
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(item.status.clone()),
                        ),
                );
            }
            block = block.child(list);
        }
        block.into_any_element()
    }

    fn render_video_row(
        &mut self,
        t: &Theme,
        title: &'static str,
        kind: SourceKind,
        picker_id: &'static str,
        video: &VideoSourceView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let disabled = video.disabled || video.row.disabled_reason.is_some();
        let mut chips = div().flex().items_center().gap(px(8.));
        if let Some(status) = video.status.as_ref() {
            chips = chips.child(status_chip(t, status.label.clone(), status.tone));
        }
        if let Some(line) = video.row.status.as_ref() {
            chips = chips.child(status_chip(t, line.message.clone(), ChipTone::Warn));
        }
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(ListRow::new(format!("{picker_id}-title"), title).child(chips));
        if let Some(hint) = video.status.as_ref().and_then(|s| s.hint.as_ref()) {
            body = body.child(div().px(px(12.)).child(muted_line(t, hint.clone())));
        }
        body = body.child(div().px(px(12.)).child(self.render_picker(
            t,
            picker_id,
            kind,
            &video.row.picker,
            disabled,
            video.row.disabled_reason.as_deref(),
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
                    .child(muted_line(t, facts.clone())),
            );
        }
        if let Some(scene) = video.scene.as_ref() {
            let open_label = scene.open_label;
            body = body.child(
                ListRow::new(format!("{picker_id}-scene"), scene.line.clone()).child(
                    ghost_button(t, format!("{picker_id}-open-scenes"), open_label).on_click(
                        cx.listener(|panel, _, window, cx| {
                            panel.open_page(PageId::Studio, window, cx);
                        }),
                    ),
                ),
            );
        }
        if let Some(low_light) = video.low_light.as_ref() {
            let checked = low_light.checked;
            let disabled = low_light.disabled;
            body = body.child(
                div()
                    .child(
                        ListRow::new("low-light", low_light.label).child(
                            ghost_button(t, "low-light-toggle", if checked { "On" } else { "Off" })
                                .when(!disabled, |el| {
                                    el.on_click(cx.listener(move |panel, _, _, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            let _ = studio.set_camera_low_light(!checked).await;
                                        });
                                    }))
                                }),
                        ),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .child(muted_line(t, low_light.description)),
                    ),
            );
        }
        GroupedList::new().item(body).into_any_element()
    }
}

impl Render for SourcesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let page = self.model.page.clone();
        let audio = self.model.audio.clone();
        let levels = self.model.levels.clone();
        let refresh_label = if page.refreshing {
            page_copy::REFRESHING
        } else {
            page_copy::REFRESH
        };

        let header = PanelSection::new("sources-header")
            .description(page.description)
            .action(
                ghost_button(t, "sources-refresh", refresh_label).when(!page.refreshing, |el| {
                    el.on_click(cx.listener(|panel, _, _, cx| panel.refresh(cx)))
                }),
            );

        let mut video = PanelSection::new("sources-video")
            .title(page_copy::VIDEO)
            .description(page.video_description)
            .child(self.render_video_row(
                t,
                sources::copy::SCREEN,
                SourceKind::Capture,
                "screen-picker",
                &page.screen,
                cx,
            ));
        if let Some(synthetic) = page.synthetic.as_ref() {
            let checked = synthetic.checked;
            let disabled = synthetic.disabled;
            video = video.child(
                GroupedList::new().item(
                    div()
                        .child(
                            ListRow::new("synthetic", page_copy::SYNTHETIC).child(
                                ghost_button(
                                    t,
                                    "synthetic-toggle",
                                    if checked { "On" } else { "Off" },
                                )
                                .when(!disabled, |el| {
                                    el.on_click(cx.listener(move |panel, _, _, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            let _ = studio.set_test_pattern(!checked).await;
                                        });
                                    }))
                                }),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .child(muted_line(t, page_copy::SYNTHETIC_DESCRIPTION)),
                        ),
                ),
            );
        }
        video = video.child(self.render_video_row(
            t,
            section_copy::CAMERA,
            SourceKind::Camera,
            "camera-picker",
            &page.camera,
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
                chips = chips.child(status_chip(t, chip.label.clone(), chip.tone));
            }
            if let Some(tag) = mic.sync_tag.as_ref() {
                chips = chips.child(status_chip(t, tag.clone(), ChipTone::Neutral));
            }
            let mute = ghost_button(
                t,
                "mute-mic",
                if muted {
                    audio_mixer::copy::UNMUTE_MICROPHONE
                } else {
                    audio_mixer::copy::MUTE_MICROPHONE
                },
            )
            .on_click(cx.listener(|panel, _, _, _| panel.mute_toggle()));
            let more_btn = ghost_button(t, "more-mic", if more { "Less" } else { "More" })
                .on_click(cx.listener(|panel, _, _, cx| panel.toggle_more("mic", cx)));
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
                    t,
                    "mic-picker",
                    SourceKind::Microphone,
                    &mic.row.picker,
                    mic.row.disabled_reason.is_some(),
                    mic.row.disabled_reason.as_deref(),
                    cx,
                )));
            if !mic.selected {
                card = card.child(
                    div()
                        .px(px(12.))
                        .child(muted_line(t, audio_copy::NO_MICROPHONE)),
                );
            } else {
                card = card
                    .child(
                        div()
                            .px(px(12.))
                            .child(muted_line(t, audio_mixer::copy::MICROPHONE_LEVEL)),
                    )
                    .child(div().px(px(12.)).child(meter_bar(
                        t,
                        levels.microphone_peak_db,
                        levels.live_at(Instant::now()) && !muted,
                    )));
                if let Some(line) = mic.level_line {
                    card = card.child(div().px(px(12.)).child(muted_line(t, line)));
                }
                let gain = mic.row.gain_db;
                card = card.child(
                    ListRow::new("mic-gain", audio_mixer::copy::GAIN)
                        .meta(mic.row.gain_text.clone())
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .id("mic-gain-down")
                                        .cursor_pointer()
                                        .child("−")
                                        .on_click(cx.listener(move |panel, _, _, _| {
                                            let studio = panel.studio.clone();
                                            let next = (gain - 1).clamp(-24, 24) as f32;
                                            panel.run_studio(async move {
                                                studio.set_microphone_gain(next).await;
                                            });
                                        })),
                                )
                                .child(
                                    div()
                                        .id("mic-gain-up")
                                        .cursor_pointer()
                                        .child("+")
                                        .on_click(cx.listener(move |panel, _, _, _| {
                                            let studio = panel.studio.clone();
                                            let next = (gain + 1).clamp(-24, 24) as f32;
                                            panel.run_studio(async move {
                                                studio.set_microphone_gain(next).await;
                                            });
                                        })),
                                ),
                        ),
                );
                if let Some(reset) = mic.row.gain_reset.clone() {
                    card = card.child(div().px(px(12.)).child(
                        ghost_button(t, "mic-gain-reset", reset).on_click(cx.listener(
                            |panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    studio.set_microphone_gain(0.0).await;
                                });
                            },
                        )),
                    ));
                }
                let noise_on = mic.noise_reduction.checked;
                let noise_disabled = mic.noise_reduction.disabled;
                card = card
                    .child(
                        ListRow::new("noise-reduction", audio_copy::NOISE_REDUCTION).child(
                            ghost_button(
                                t,
                                "noise-reduction-toggle",
                                if noise_on { "On" } else { "Off" },
                            )
                            .when(!noise_disabled, |el| {
                                el.on_click(cx.listener(move |panel, _, _, _| {
                                    let studio = panel.studio.clone();
                                    panel.run_studio(async move {
                                        studio.set_microphone_noise_suppression(!noise_on).await;
                                    });
                                }))
                            }),
                        ),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .child(muted_line(t, mic.noise_reduction.description.clone())),
                    );
            }
            if more {
                let sync = mic.sync_ms;
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
                                    div()
                                        .flex()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .id("sync-down")
                                                .cursor_pointer()
                                                .child("−")
                                                .on_click(cx.listener(move |panel, _, _, _| {
                                                    let studio = panel.studio.clone();
                                                    let next = (sync - 10).clamp(-1000, 1000);
                                                    panel.run_studio(async move {
                                                        studio
                                                            .set_microphone_sync_offset(next, false)
                                                            .await;
                                                    });
                                                })),
                                        )
                                        .child(
                                            div()
                                                .id("sync-up")
                                                .cursor_pointer()
                                                .child("+")
                                                .on_click(cx.listener(move |panel, _, _, _| {
                                                    let studio = panel.studio.clone();
                                                    let next = (sync + 10).clamp(-1000, 1000);
                                                    panel.run_studio(async move {
                                                        studio
                                                            .set_microphone_sync_offset(next, false)
                                                            .await;
                                                    });
                                                })),
                                        )
                                        .child(ghost_button(t, "sync-reset", "Reset").on_click(
                                            cx.listener(|panel, _, _, _| {
                                                let studio = panel.studio.clone();
                                                panel.run_studio(async move {
                                                    studio
                                                        .set_microphone_sync_offset(0, true)
                                                        .await;
                                                });
                                            }),
                                        )),
                                ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .child(muted_line(t, mic.sync_description.clone())),
                        ),
                );
                if let Some(keep) = mic.keep_ready.as_ref() {
                    let checked = keep.checked;
                    card = card
                        .child(
                            ListRow::new("keep-ready", audio_copy::KEEP_READY).child(
                                ghost_button(
                                    t,
                                    "keep-ready-toggle",
                                    if checked { "On" } else { "Off" },
                                )
                                .on_click(cx.listener(
                                    move |panel, _, _, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            studio.set_keep_microphone_warm(!checked).await;
                                        });
                                    },
                                )),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .child(muted_line(t, keep.description.clone())),
                        );
                }
            }
            audio_col = audio_col.child(GroupedList::new().item(card));
        }

        // System audio
        if let Some(system) = audio.system_audio.clone() {
            let more = self.ui.more.contains("system");
            let mut chips = div().flex().items_center().gap(px(8.));
            if let Some(chip) = system.chip.as_ref() {
                chips = chips.child(status_chip(t, chip.label.clone(), chip.tone));
            } else if let Some(chip) = system.row.chip.as_ref() {
                chips = chips.child(status_chip(t, chip.label, ChipTone::Neutral));
            }
            let checked = system.row.checked;
            let disabled = system.row.disabled;
            let toggle = ghost_button(t, "system-audio-toggle", if checked { "On" } else { "Off" })
                .when(!disabled, |el| {
                    el.on_click(cx.listener(move |panel, _, _, _| {
                        let studio = panel.studio.clone();
                        panel.run_studio(async move {
                            studio.set_system_audio_enabled(!checked).await;
                        });
                    }))
                });
            let more_btn = ghost_button(t, "more-system", if more { "Less" } else { "More" })
                .on_click(cx.listener(|panel, _, _, cx| panel.toggle_more("system", cx)));
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
                .child(div().px(px(12.)).child(muted_line(t, system.facts.clone())));
            if system.row.show_level {
                card = card.child(div().px(px(12.)).child(meter_bar(
                    t,
                    levels.system_audio_peak_db,
                    levels.live_at(Instant::now()),
                )));
            } else if system.row.idle_line {
                card = card.child(
                    div()
                        .px(px(12.))
                        .child(muted_line(t, audio_mixer::copy::IDLE_LINE)),
                );
            }
            if system.row.show_gain {
                let gain = system.row.gain_db;
                card = card.child(
                    ListRow::new("sys-gain", audio_mixer::copy::GAIN)
                        .meta(system.row.gain_text.clone())
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .id("sys-gain-down")
                                        .cursor_pointer()
                                        .child("−")
                                        .on_click(cx.listener(move |panel, _, _, _| {
                                            let studio = panel.studio.clone();
                                            let next = (gain - 1).clamp(-24, 12) as f32;
                                            panel.run_studio(async move {
                                                studio.set_system_audio_gain(next).await;
                                            });
                                        })),
                                )
                                .child(
                                    div()
                                        .id("sys-gain-up")
                                        .cursor_pointer()
                                        .child("+")
                                        .on_click(cx.listener(move |panel, _, _, _| {
                                            let studio = panel.studio.clone();
                                            let next = (gain + 1).clamp(-24, 12) as f32;
                                            panel.run_studio(async move {
                                                studio.set_system_audio_gain(next).await;
                                            });
                                        })),
                                ),
                        ),
                );
                if let Some(reset) = system.row.gain_reset.clone() {
                    card = card.child(div().px(px(12.)).child(
                        ghost_button(t, "sys-gain-reset", reset).on_click(cx.listener(
                            |panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    studio.set_system_audio_gain(-6.0).await;
                                });
                            },
                        )),
                    ));
                }
            }
            if let Some(issue) = system.issue.clone() {
                let action = system.issue_action;
                let mut alert = Alert::new("system-issue")
                    .variant(AlertVariant::Warning)
                    .title(issue);
                if let Some(action) = action {
                    let label = match action {
                        IssueAction::OpenPermissions => audio_mixer::copy::OPEN_PERMISSIONS,
                        IssueAction::Resume => audio_mixer::copy::RESUME,
                    };
                    alert = alert.action(ghost_button(t, "system-issue-action", label).on_click(
                        cx.listener(move |panel, _, window, cx| match action {
                            IssueAction::OpenPermissions => {
                                panel.open_page(PageId::Settings, window, cx);
                            }
                            IssueAction::Resume => {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    studio.resume_system_audio().await;
                                });
                            }
                        }),
                    ));
                }
                card = card.child(div().px(px(12.)).child(alert));
            }
            if more {
                let echo = system.echo_guard;
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
                                ghost_button(
                                    t,
                                    "echo-guard-toggle",
                                    if echo { "On" } else { "Off" },
                                )
                                .on_click(cx.listener(
                                    move |panel, _, _, _| {
                                        let studio = panel.studio.clone();
                                        panel.run_studio(async move {
                                            studio.set_system_audio_echo_guard(!echo).await;
                                        });
                                    },
                                )),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .child(muted_line(t, system.echo_guard_description.clone())),
                        ),
                );
                for note in &system.notes {
                    card = card.child(div().px(px(12.)).child(muted_line(t, format!("• {note}"))));
                }
            }
            audio_col = audio_col.child(GroupedList::new().item(card));
        }

        // Sounds
        {
            let sounds = &audio.sounds;
            let mut card = div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(ListRow::new("sounds-title", audio_copy::SOUNDS));
            if sounds.show_level {
                card = card.child(div().px(px(12.)).child(meter_bar(
                    t,
                    levels.sounds_peak_db,
                    true,
                )));
            } else {
                card = card.child(
                    div()
                        .px(px(12.))
                        .child(muted_line(t, audio_copy::SOUNDS_IDLE)),
                );
            }
            card = card
                .child(
                    ListRow::new("sounds-level", audio_copy::LEVEL)
                        .meta(sounds.volume_text.clone()),
                )
                .child(
                    div()
                        .px(px(12.))
                        .child(muted_line(t, audio_copy::SOUNDS_LEVEL)),
                )
                .child(
                    ListRow::new("hear-sounds", audio_copy::HEAR_SOUNDS).child(
                        div()
                            .opacity(if sounds.disabled { 0.5 } else { 1.0 })
                            .child(ghost_button(
                                t,
                                "hear-sounds-toggle",
                                if sounds.monitor { "On" } else { "Off" },
                            )),
                    ),
                )
                .child(
                    div()
                        .px(px(12.))
                        .pb(px(8.))
                        .child(muted_line(t, audio_copy::HEAR_SOUNDS_DESCRIPTION)),
                );
            audio_col = audio_col.last(true).child(GroupedList::new().item(card));
        }

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
                div()
                    .id("sources-scroll")
                    .flex_1()
                    .min_h(px(0.))
                    .overflow_hidden()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .px(px(size::GUTTER))
                            .py(px(8.))
                            .gap(px(8.))
                            .child(header)
                            .children((!page.alerts.is_empty() || page.device_problem).then(|| {
                                self.render_alerts(t, &page.alerts, page.device_problem, cx)
                            }))
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .items_start()
                                    .gap(px(8.))
                                    .child(div().flex_1().min_w(px(360.)).child(video))
                                    .child(div().flex_1().min_w(px(360.)).child(audio_col)),
                            ),
                    ),
            )
    }
}
