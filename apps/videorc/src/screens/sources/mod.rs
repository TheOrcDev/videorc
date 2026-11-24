//! The Sources page (plan 260 Phase 3, L4): video and audio capture homes,
//! permission alerts, and Refresh. Words and state come from
//! `videorc_app_core::studio::{sources_page, sources_audio}`; this module
//! draws them and calls the Studio and Permissions.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use gpui::{Context, FontWeight, SharedString, WeakEntity, Window, div, prelude::*, px, rgb};
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
    self, SourcesAudioInputs, SourcesAudioView, copy as audio_copy,
};
use videorc_app_core::studio::sources_page::{
    self, ChipTone, GrantAction, GrantRow, GrantState, PermissionInputs, SourcePermissionAlert,
    SourcesPageInput, SourcesPageView, VideoSourceView, copy as page_copy, sources_page_view,
};
use videorc_app_core::studio::sources_section::copy as section_copy;
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};

use crate::app::permissions::Permissions;
use crate::app::shell::Shell;

pub type AppStudio = Studio<BackendClient>;

const TEXT: u32 = 0xe8e8ea;
const MUTED: u32 = 0x8e8e93;
const BUTTON: u32 = 0x2f2f35;
const HAIRLINE: u32 = 0x2c2c30;
const WARN: u32 = 0xffd60a;
const GOOD: u32 = 0x30d158;
const ERROR: u32 = 0xff453a;
const CHIP: u32 = 0x3a3a40;
const METER: u32 = 0x48484e;

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

fn chip_colour(tone: ChipTone) -> u32 {
    match tone {
        ChipTone::Neutral => MUTED,
        ChipTone::Good => GOOD,
        ChipTone::Warn => WARN,
        ChipTone::Error => ERROR,
    }
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
}

fn status_chip(label: impl Into<SharedString>, tone: ChipTone) -> impl IntoElement {
    div()
        .px(px(8.))
        .py(px(2.))
        .rounded(px(6.))
        .bg(rgb(CHIP))
        .text_size(px(11.))
        .text_color(rgb(chip_colour(tone)))
        .child(label.into())
}

fn section_heading(title: &'static str, description: &'static str) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .text_size(px(15.))
                .font_weight(FontWeight::MEDIUM)
                .child(title),
        )
        .child(
            div()
                .text_size(px(12.))
                .text_color(rgb(MUTED))
                .child(description),
        )
}

fn meter_bar(peak_db: Option<f64>, show: bool) -> impl IntoElement {
    let fill = if show {
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
        .bg(rgb(HAIRLINE))
        .child(
            div()
                .h_full()
                .w(px((fill * 220.0) as f32))
                .rounded(px(4.))
                .bg(rgb(METER)),
        )
}

fn ghost_button(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(SharedString::from(id.into().to_string()))
        .px(px(10.))
        .py(px(5.))
        .rounded(px(6.))
        .border_1()
        .border_color(rgb(HAIRLINE))
        .bg(rgb(BUTTON))
        .text_size(px(12.))
        .cursor_pointer()
        .child(label.into())
}

impl SourcesPanel {
    fn render_alerts(
        &self,
        alerts: &[SourcePermissionAlert],
        device_problem: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut column = div().flex().flex_col().gap(px(8.));
        for alert in alerts {
            let pane = alert.pane;
            let pending = self.ui.pending_alert == Some(pane);
            column = column.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .p(px(12.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(rgb(HAIRLINE))
                    .bg(rgb(BUTTON))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(alert.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .child(alert.description.clone()),
                    )
                    .child(
                        ghost_button(
                            format!("alert-{}", pane.as_str()),
                            if pending {
                                "…".into()
                            } else {
                                alert.action_label.clone()
                            },
                        )
                        .on_click(cx.listener(move |panel, _, _, cx| panel.run_alert(pane, cx))),
                    ),
            );
        }
        if device_problem {
            column = column.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .p(px(12.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(rgb(HAIRLINE))
                    .child(div().text_size(px(13.)).child(page_copy::DEVICE_PROBLEM))
                    .child(
                        div()
                            .id("open-health")
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .cursor_pointer()
                            .child(OPEN_HEALTH_LABEL)
                            .on_click(cx.listener(|panel, _, window, cx| {
                                panel.open_page(PageId::Diagnostics, window, cx);
                            })),
                    ),
            );
        }
        column
    }

    fn render_picker_list(
        &mut self,
        id: &'static str,
        kind: SourceKind,
        picker: &PickerView,
        disabled: bool,
        disabled_reason: Option<&str>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
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
                .border_color(rgb(HAIRLINE))
                .bg(rgb(BUTTON))
                .when(!disabled, |row| {
                    row.cursor_pointer()
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.ui.open_picker = if panel.ui.open_picker == Some(id) {
                                None
                            } else {
                                Some(id)
                            };
                            cx.notify();
                        }))
                })
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(rgb(if picker.placeholder { MUTED } else { TEXT }))
                        .child(picker.label.clone()),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(rgb(MUTED))
                        .child(if open { "▲" } else { "▼" }),
                ),
        );
        if let Some(reason) = disabled_reason {
            block = block.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(reason.to_string()),
            );
        }
        if open && !disabled {
            let mut list = div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .p(px(6.))
                .rounded(px(8.))
                .border_1()
                .border_color(rgb(HAIRLINE))
                .bg(rgb(BUTTON));
            if !picker.list_status.is_empty() {
                list = list.child(
                    div()
                        .px(px(8.))
                        .py(px(4.))
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(picker.list_status.clone()),
                );
            }
            for (index, item) in picker.items.iter().enumerate() {
                if !item.heading.is_empty() {
                    list = list.child(
                        div()
                            .px(px(8.))
                            .pt(px(8.))
                            .pb(px(2.))
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
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
                        .when(item.selected, |row| row.bg(rgb(CHIP)))
                        .when(!item_disabled, |row| {
                            row.cursor_pointer()
                                .on_click(cx.listener(move |panel, _, _, cx| {
                                    panel.select_device(kind, value.clone(), cx);
                                }))
                        })
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(rgb(if item_disabled { MUTED } else { TEXT }))
                                .child(item.label.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(rgb(MUTED))
                                .child(item.status.clone()),
                        ),
                );
            }
            block = block.child(list);
        }
        block
    }

    fn render_video_row(
        &mut self,
        title: &'static str,
        kind: SourceKind,
        picker_id: &'static str,
        video: &VideoSourceView,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let disabled = video.disabled || video.row.disabled_reason.is_some();
        let mut row = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .rounded(px(10.))
            .border_1()
            .border_color(rgb(HAIRLINE));
        let mut header = div().flex().items_center().gap(px(8.)).child(
            div()
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .child(title),
        );
        if let Some(status) = video.status.as_ref() {
            header = header.child(status_chip(status.label.clone(), status.tone));
        }
        if let Some(line) = video.row.status.as_ref() {
            header = header.child(status_chip(line.message.clone(), ChipTone::Warn));
        }
        row = row.child(header);
        if let Some(hint) = video.status.as_ref().and_then(|s| s.hint.as_ref()) {
            row = row.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(hint.clone()),
            );
        }
        row = row.child(self.render_picker_list(
            picker_id,
            kind,
            &video.row.picker,
            disabled,
            video.row.disabled_reason.as_deref(),
            cx,
        ));
        if let Some(shortfall) = video.shortfall.as_ref() {
            row = row.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(WARN))
                    .child(shortfall.clone()),
            );
        } else if let Some(facts) = video.facts.as_ref() {
            row = row.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(facts.clone()),
            );
        }
        if let Some(scene) = video.scene.as_ref() {
            row = row.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .child(scene.line.clone()),
                    )
                    .child(
                        div()
                            .id("open-scenes")
                            .text_size(px(12.))
                            .cursor_pointer()
                            .child(scene.open_label)
                            .on_click(cx.listener(|panel, _, window, cx| {
                                panel.open_page(PageId::Studio, window, cx);
                            })),
                    ),
            );
        }
        if let Some(low_light) = video.low_light.as_ref() {
            let checked = low_light.checked;
            let disabled = low_light.disabled;
            row = row.child(
                div()
                    .id("low-light")
                    .flex()
                    .justify_between()
                    .when(!disabled, |el| {
                        el.cursor_pointer()
                            .on_click(cx.listener(move |panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    let _ = studio.set_camera_low_light(!checked).await;
                                });
                            }))
                    })
                    .child(div().text_size(px(13.)).child(low_light.label))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(if checked { GOOD } else { MUTED }))
                            .child(if checked { "On" } else { "Off" }),
                    ),
            );
            row = row.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(low_light.description),
            );
        }
        row
    }
}

impl Render for SourcesPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = self.model.page.clone();
        let audio = self.model.audio.clone();
        let levels = self.model.levels.clone();
        let refresh_label = if page.refreshing {
            page_copy::REFRESHING
        } else {
            page_copy::REFRESH
        };

        let mut root = div().flex().flex_col().gap(px(16.)).overflow_hidden();
        root = root.child(
            div()
                .flex()
                .items_start()
                .justify_between()
                .gap(px(16.))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(13.))
                        .text_color(rgb(MUTED))
                        .child(page.description),
                )
                .child(
                    ghost_button("sources-refresh", refresh_label)
                        .on_click(cx.listener(|panel, _, _, cx| panel.refresh(cx))),
                ),
        );

        if !page.alerts.is_empty() || page.device_problem {
            root = root.child(self.render_alerts(&page.alerts, page.device_problem, cx));
        }

        let mut columns = div().flex().flex_row().items_start().gap(px(24.));

        let mut video = div()
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(section_heading(page_copy::VIDEO, page.video_description));
        video = video.child(self.render_video_row(
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
                div()
                    .id("synthetic")
                    .flex()
                    .justify_between()
                    .when(!disabled, |el| {
                        el.cursor_pointer()
                            .on_click(cx.listener(move |panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    let _ = studio.set_test_pattern(!checked).await;
                                });
                            }))
                    })
                    .child(div().text_size(px(13.)).child(page_copy::SYNTHETIC))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(if checked { GOOD } else { MUTED }))
                            .child(if checked { "On" } else { "Off" }),
                    ),
            );
            video = video.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(page_copy::SYNTHETIC_DESCRIPTION),
            );
        }
        video = video.child(self.render_video_row(
            section_copy::CAMERA,
            SourceKind::Camera,
            "camera-picker",
            &page.camera,
            cx,
        ));
        columns = columns.child(video);

        let mut audio_col = div()
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(section_heading(audio_copy::AUDIO, audio.description));

        // Microphone
        {
            let mic = &audio.microphone;
            let more = self.ui.more.contains("mic");
            let mut card = div()
                .id(mic.focus)
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .rounded(px(10.))
                .border_1()
                .border_color(rgb(HAIRLINE));
            let mut header = div().flex().items_center().gap(px(8.)).child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(audio_mixer::copy::MICROPHONE),
            );
            if let Some(chip) = mic.chip.as_ref() {
                header = header.child(status_chip(chip.label.clone(), chip.tone));
            }
            if let Some(tag) = mic.sync_tag.as_ref() {
                header = header.child(status_chip(tag.clone(), ChipTone::Neutral));
            }
            let muted = mic.row.muted;
            header = header.child(
                ghost_button(
                    "mute-mic",
                    if muted {
                        audio_mixer::copy::UNMUTE_MICROPHONE
                    } else {
                        audio_mixer::copy::MUTE_MICROPHONE
                    },
                )
                .ml_auto()
                .on_click(cx.listener(|panel, _, _, _| panel.mute_toggle())),
            );
            header = header.child(
                div()
                    .id("more-mic")
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .cursor_pointer()
                    .child(if more { "Less" } else { "More" })
                    .on_click(cx.listener(|panel, _, _, cx| {
                        if !panel.ui.more.insert("mic") {
                            panel.ui.more.remove("mic");
                        }
                        cx.notify();
                    })),
            );
            card = card.child(header);
            card = card.child(self.render_picker_list(
                "mic-picker",
                SourceKind::Microphone,
                &mic.row.picker,
                mic.row.disabled_reason.is_some(),
                mic.row.disabled_reason.as_deref(),
                cx,
            ));
            if !mic.selected {
                card = card.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(audio_copy::NO_MICROPHONE),
                );
            } else {
                card = card.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(audio_mixer::copy::MICROPHONE_LEVEL),
                );
                card = card.child(meter_bar(
                    levels.microphone_peak_db,
                    levels.live_at(Instant::now()) && !muted,
                ));
                if let Some(line) = mic.level_line {
                    card = card.child(div().text_size(px(12.)).text_color(rgb(MUTED)).child(line));
                }
                let gain = mic.row.gain_db;
                card = card.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(div().text_size(px(12.)).child(audio_mixer::copy::GAIN))
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
                                .child(div().text_size(px(12.)).child(mic.row.gain_text.clone()))
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
                    card = card.child(
                        div()
                            .id("mic-gain-reset")
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .cursor_pointer()
                            .child(reset)
                            .on_click(cx.listener(|panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    studio.set_microphone_gain(0.0).await;
                                });
                            })),
                    );
                }
                let noise_on = mic.noise_reduction.checked;
                let noise_disabled = mic.noise_reduction.disabled;
                card = card.child(
                    div()
                        .id("noise-reduction")
                        .flex()
                        .justify_between()
                        .when(!noise_disabled, |el| {
                            el.cursor_pointer()
                                .on_click(cx.listener(move |panel, _, _, _| {
                                    let studio = panel.studio.clone();
                                    panel.run_studio(async move {
                                        studio.set_microphone_noise_suppression(!noise_on).await;
                                    });
                                }))
                        })
                        .child(div().text_size(px(13.)).child(audio_copy::NOISE_REDUCTION))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(rgb(if noise_on { GOOD } else { MUTED }))
                                .child(if noise_on { "On" } else { "Off" }),
                        ),
                );
                card = card.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(mic.noise_reduction.description.clone()),
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
                        .border_color(rgb(HAIRLINE))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .child(audio_copy::MORE_MICROPHONE),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(div().text_size(px(12.)).child(audio_copy::MICROPHONE_SYNC))
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
                                            div().text_size(px(12.)).child(format!("{sync:+} ms")),
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
                                        .child(
                                            div()
                                                .id("sync-reset")
                                                .cursor_pointer()
                                                .text_size(px(12.))
                                                .text_color(rgb(MUTED))
                                                .child("Reset")
                                                .on_click(cx.listener(|panel, _, _, _| {
                                                    let studio = panel.studio.clone();
                                                    panel.run_studio(async move {
                                                        studio
                                                            .set_microphone_sync_offset(0, true)
                                                            .await;
                                                    });
                                                })),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(rgb(MUTED))
                                .child(mic.sync_description.clone()),
                        ),
                );
                if let Some(keep) = mic.keep_ready.as_ref() {
                    let checked = keep.checked;
                    card = card.child(
                        div()
                            .id("keep-ready")
                            .flex()
                            .justify_between()
                            .cursor_pointer()
                            .on_click(cx.listener(move |panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    studio.set_keep_microphone_warm(!checked).await;
                                });
                            }))
                            .child(div().text_size(px(13.)).child(audio_copy::KEEP_READY))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(rgb(if checked { GOOD } else { MUTED }))
                                    .child(if checked { "On" } else { "Off" }),
                            ),
                    );
                    card = card.child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .child(keep.description.clone()),
                    );
                }
            }
            audio_col = audio_col.child(card);
        }

        // System audio
        if let Some(system) = audio.system_audio.clone() {
            let more = self.ui.more.contains("system");
            let mut card = div()
                .id(system.focus)
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .rounded(px(10.))
                .border_1()
                .border_color(rgb(HAIRLINE));
            let mut header = div().flex().items_center().gap(px(8.)).child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(audio_mixer::copy::SYSTEM_AUDIO),
            );
            if let Some(chip) = system.chip.as_ref() {
                header = header.child(status_chip(chip.label.clone(), chip.tone));
            } else if let Some(chip) = system.row.chip.as_ref() {
                header = header.child(status_chip(chip.label, ChipTone::Neutral));
            }
            let checked = system.row.checked;
            let disabled = system.row.disabled;
            header = header.child(
                ghost_button("system-audio-toggle", if checked { "On" } else { "Off" })
                    .ml_auto()
                    .when(!disabled, |el| {
                        el.on_click(cx.listener(move |panel, _, _, _| {
                            let studio = panel.studio.clone();
                            panel.run_studio(async move {
                                studio.set_system_audio_enabled(!checked).await;
                            });
                        }))
                    }),
            );
            header = header.child(
                div()
                    .id("more-system")
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .cursor_pointer()
                    .child(if more { "Less" } else { "More" })
                    .on_click(cx.listener(|panel, _, _, cx| {
                        if !panel.ui.more.insert("system") {
                            panel.ui.more.remove("system");
                        }
                        cx.notify();
                    })),
            );
            card = card.child(header);
            card = card.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(system.facts.clone()),
            );
            if system.row.show_level {
                card = card.child(meter_bar(
                    levels.system_audio_peak_db,
                    levels.live_at(Instant::now()),
                ));
            } else if system.row.idle_line {
                card = card.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(audio_mixer::copy::IDLE_LINE),
                );
            }
            if system.row.show_gain {
                let gain = system.row.gain_db;
                card = card.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(div().text_size(px(12.)).child(audio_mixer::copy::GAIN))
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
                                .child(div().text_size(px(12.)).child(system.row.gain_text.clone()))
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
                    card = card.child(
                        div()
                            .id("sys-gain-reset")
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .cursor_pointer()
                            .child(reset)
                            .on_click(cx.listener(|panel, _, _, _| {
                                let studio = panel.studio.clone();
                                panel.run_studio(async move {
                                    studio.set_system_audio_gain(-6.0).await;
                                });
                            })),
                    );
                }
            }
            if let Some(issue) = system.issue.clone() {
                let action = system.issue_action;
                card = card.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .p(px(8.))
                        .rounded(px(8.))
                        .bg(rgb(BUTTON))
                        .child(div().text_size(px(12.)).child(issue))
                        .when_some(action, |el, action| {
                            el.child(
                                div()
                                    .id("system-issue-action")
                                    .text_size(px(12.))
                                    .cursor_pointer()
                                    .child(match action {
                                        IssueAction::OpenPermissions => {
                                            audio_mixer::copy::OPEN_PERMISSIONS
                                        }
                                        IssueAction::Resume => audio_mixer::copy::RESUME,
                                    })
                                    .on_click(cx.listener(
                                        move |panel, _, window, cx| match action {
                                            IssueAction::OpenPermissions => {
                                                panel.open_page(PageId::Settings, window, cx);
                                            }
                                            IssueAction::Resume => {
                                                let studio = panel.studio.clone();
                                                panel.run_studio(async move {
                                                    studio.resume_system_audio().await;
                                                });
                                            }
                                        },
                                    )),
                            )
                        }),
                );
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
                        .border_color(rgb(HAIRLINE))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .child(audio_copy::MORE_SYSTEM_AUDIO),
                        )
                        .child(
                            div()
                                .id("echo-guard")
                                .flex()
                                .justify_between()
                                .cursor_pointer()
                                .on_click(cx.listener(move |panel, _, _, _| {
                                    let studio = panel.studio.clone();
                                    panel.run_studio(async move {
                                        studio.set_system_audio_echo_guard(!echo).await;
                                    });
                                }))
                                .child(div().text_size(px(13.)).child(audio_copy::ECHO_GUARD))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(rgb(if echo { GOOD } else { MUTED }))
                                        .child(if echo { "On" } else { "Off" }),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(rgb(MUTED))
                                .child(system.echo_guard_description.clone()),
                        ),
                );
                for note in &system.notes {
                    card = card.child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .child(format!("• {note}")),
                    );
                }
            }
            audio_col = audio_col.child(card);
        }

        // Sounds
        {
            let sounds = &audio.sounds;
            let mut card = div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .rounded(px(10.))
                .border_1()
                .border_color(rgb(HAIRLINE));
            card = card.child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(audio_copy::SOUNDS),
            );
            if sounds.show_level {
                card = card.child(meter_bar(levels.sounds_peak_db, true));
            } else {
                card = card.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(audio_copy::SOUNDS_IDLE),
                );
            }
            card = card.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(px(12.)).child(audio_copy::LEVEL))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(if sounds.disabled { MUTED } else { TEXT }))
                            .child(sounds.volume_text.clone()),
                    ),
            );
            card = card.child(
                div()
                    .text_size(px(11.))
                    .text_color(rgb(MUTED))
                    .child(audio_copy::SOUNDS_LEVEL),
            );
            card = card.child(
                div()
                    .id("hear-sounds")
                    .flex()
                    .justify_between()
                    .opacity(if sounds.disabled { 0.5 } else { 1.0 })
                    .child(div().text_size(px(13.)).child(audio_copy::HEAR_SOUNDS))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(if sounds.monitor { GOOD } else { MUTED }))
                            .child(if sounds.monitor { "On" } else { "Off" }),
                    ),
            );
            card = card.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(audio_copy::HEAR_SOUNDS_DESCRIPTION),
            );
            audio_col = audio_col.child(card);
        }

        columns = columns.child(audio_col);
        root.child(columns)
    }
}
