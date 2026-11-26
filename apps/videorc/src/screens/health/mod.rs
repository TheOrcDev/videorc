//! Health projects app-core's verdict, checks and metric groups. Reads are
//! bounded and refresh on entry/session changes; telemetry stays core-owned.
mod actions;
mod render;

use crate::app::{camera::Camera, permissions::Permissions};
use crate::screens::linux_setup;
use gpui::Context;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};
use videorc_app_core::client::methods::{CompositorStatusGet, SessionLogsList, SessionsList};
use videorc_app_core::protocol::{
    CompositorFramePipelineStatus, SessionDetailListParams, SessionListParams, SessionLogEntry,
    VirtualCameraStatus,
};
use videorc_app_core::studio::cloud_program_health::{self as cloud_health, ProgramHealthRow};
use videorc_app_core::studio::health_page::{
    self as h, CameraGroupInputs, Fields, PageInputs, RecordingLog,
};
use videorc_app_core::studio::linux_desktop::LinuxKeyringStatus;
use videorc_app_core::{
    AppPaths, BackendClient, BackendEvent, Logger, Studio,
    crash_log::{self, CrashRecord},
};
use videorc_kit::dialog::DialogHandle;

pub struct HealthScreen {
    studio: Arc<Studio<BackendClient>>,
    runtime: tokio::runtime::Handle,
    logger: Logger,
    paths: AppPaths,
    permissions: Arc<Permissions>,
    camera: Arc<Camera>,
    active: bool,
    reading: bool,
    read_again: bool,
    view: h::HealthPageView,
    warning_events: Vec<String>,
    connected: bool,
    recording_log: RecordingLog,
    crash: Option<CrashRecord>,
    camera_status: Option<VirtualCameraStatus>,
    camera_revision: u64,
    compositor: Option<CompositorFramePipelineStatus>,
    compositor_revision: u64,
    error: Option<String>,
    show_all: bool,
    details: bool,
    groups: BTreeMap<String, bool>,
    dismissed: HashSet<String>,
    permission_pending: Option<videorc_app_core::desktop::permissions::SystemPermissionPane>,
    export_pending: bool,
    exported: Option<PathBuf>,
    removing: bool,
    confirm: DialogHandle,
    /// Plan 257 / P1489: Linux desktop diagnostics + keyring probe.
    linux_keyring: Option<LinuxKeyringStatus>,
    linux_desktop: Option<Value>,
    /// P070: Cloud room program-health while a room is open (`None` when closed).
    cloud_room: Option<Vec<ProgramHealthRow>>,
}

impl HealthScreen {
    pub fn new(
        studio: Arc<Studio<BackendClient>>,
        runtime: tokio::runtime::Handle,
        logger: Logger,
        paths: AppPaths,
        permissions: Arc<Permissions>,
        camera: Arc<Camera>,
        cx: &mut Context<Self>,
    ) -> Self {
        let recording_log = RecordingLog::default();
        let view = page_view(
            &studio,
            &recording_log,
            &logger,
            None,
            None,
            None,
            false,
            None,
            None,
        );
        let mut snapshots = studio.watch();
        let mut telemetry = studio.telemetry();
        let mut cloud = studio.cloud();
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |entity, cx| {
            let mut identity = None;
            let mut log_identity = None;
            loop {
                let event = tokio::select! {
                    changed = snapshots.changed() => { if changed.is_err() { break; } None },
                    changed = telemetry.changed() => { if changed.is_err() { break; } None },
                    changed = cloud.changed() => { if changed.is_err() { break; } None },
                    event = events.recv() => match event { Ok(event) => Some(event), Err(tokio::sync::broadcast::error::RecvError::Closed) => break, Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => Some(BackendEvent::ClientLagged { skipped }) },
                };
                let snapshot = snapshots.borrow_and_update().clone();
                telemetry.borrow_and_update();
                let cloud_state = cloud.borrow_and_update().clone();
                let next = (snapshot.connection_generation, snapshot.session.status.session_id.clone(), snapshot.session.phase);
                let next_log = (snapshot.connection_generation, snapshot.session.status.session_id.clone());
                let log_changed = log_identity.as_ref() != Some(&next_log);
                log_identity = Some(next_log);
                let changed = identity.as_ref() != Some(&next);
                identity = Some(next);
                if entity.update(cx, |this, cx| {
                    this.cloud_room = cloud_state
                        .status
                        .as_ref()
                        .and_then(|status| cloud_health::ProgramHealthInput::from_cloud(status, None))
                        .map(|input| cloud_health::program_health_rows(&input));
                    if log_changed {
                        this.recording_log = RecordingLog {
                            session_id: snapshot.session.status.session_id.clone(),
                            current: snapshot.session.status.session_id.is_some(),
                            ..Default::default()
                        };
                        this.camera_status = None;
                        this.compositor = None;
                        this.compositor_revision = this.compositor_revision.wrapping_add(1);
                        this.camera_revision = this.camera_revision.wrapping_add(1);
                    }
                    let mut reread = changed;
                    match event {
                        Some(BackendEvent::CompositorStatus(status)) => {
                            this.compositor_revision = this.compositor_revision.wrapping_add(1);
                            this.compositor = Some(status.frame_pipeline);
                        }
                        Some(BackendEvent::Untyped { event, payload }) if event == "virtualCamera.changed" => {
                            this.camera_revision = this.camera_revision.wrapping_add(1);
                            this.camera_status = serde_json::from_value(payload).ok();
                        }
                        Some(BackendEvent::Untyped { event, payload }) if event == "session.log" => {
                            if let Ok(entry) = serde_json::from_value::<SessionLogEntry>(payload) {
                                if this.recording_log.session_id.as_ref() == Some(&entry.session_id)
                                    && !this.recording_log.entries.iter().any(|old| old.id == entry.id)
                                {
                                    this.recording_log.log_count = this.recording_log.log_count.saturating_add(1);
                                    this.recording_log.entries.push(entry);
                                    trim_log(&mut this.recording_log.entries);
                                } else if this.recording_log.session_id.is_none()
                                    && snapshot.session.status.session_id.is_none() {
                                    // The last recording may still be finalizing
                                    // while its first log read is in flight.
                                    reread = true;
                                }
                            }
                        }
                        Some(BackendEvent::EventsLagged(_) | BackendEvent::ClientLagged { .. }) => reread = true,
                        _ => {}
                    }
                    if this.active {
                        if reread { this.refresh(cx); }
                        this.rebuild(cx);
                    }
                }).is_err() { break; }
            }
        }).detach();
        Self {
            studio,
            runtime,
            logger,
            paths,
            permissions,
            camera,
            active: false,
            reading: false,
            read_again: false,
            view,
            warning_events: Vec::new(),
            connected: false,
            recording_log,
            crash: None,
            camera_status: None,
            camera_revision: 0,
            compositor: None,
            compositor_revision: 0,
            error: None,
            show_all: false,
            details: false,
            groups: BTreeMap::new(),
            dismissed: HashSet::new(),
            permission_pending: None,
            export_pending: false,
            exported: None,
            removing: false,
            confirm: DialogHandle::new(false),
            linux_keyring: None,
            linux_desktop: None,
            cloud_room: None,
        }
    }
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.active = active;
        if active {
            self.permissions.recheck();
            self.refresh(cx);
            self.rebuild(cx);
        }
    }
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let next = page_view(
            &self.studio,
            &self.recording_log,
            &self.logger,
            self.crash.as_ref(),
            self.camera_status.as_ref(),
            self.compositor.as_ref(),
            self.removing,
            self.linux_keyring.as_ref(),
            self.linux_desktop.as_ref(),
        );
        let warning_events: Vec<_> = self
            .studio
            .snapshot()
            .health
            .events
            .iter()
            .filter(|event| event.permission_pane.is_some())
            .map(|event| event.id.clone())
            .collect();
        let connected = self.studio.is_connected();
        if next != self.view || warning_events != self.warning_events || connected != self.connected
        {
            self.warning_events = warning_events;
            self.connected = connected;
            self.view = next;
            cx.notify();
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            self.read_again = true;
            return;
        }
        if !self.studio.is_connected() {
            cx.notify();
            return;
        }
        self.reading = true;
        self.read_again = false;
        self.recording_log.loading = true;
        self.rebuild(cx);
        let camera_revision = self.camera_revision;
        let compositor_revision = self.compositor_revision;
        let snapshot = self.studio.snapshot();
        let generation = snapshot.connection_generation;
        let wanted = snapshot.session.status.session_id;
        let requested_session = wanted.clone();
        let client = self.studio.backend().clone();
        let crash_path = self.paths.backend_crash_log_file();
        let job = self.runtime.spawn(async move {
            let linux_client = client.clone();
            let (sessions, camera, compositor, linux_desktop) = tokio::join!(
                client.call::<SessionsList>(&SessionListParams {
                    cursor: None,
                    limit: 50
                }),
                client.request("virtualCamera.status", json!({})),
                client.call::<CompositorStatusGet>(&()),
                async move {
                    if cfg!(target_os = "linux") {
                        linux_client
                            .request("diagnostics.linuxDesktop", Value::Null)
                            .await
                            .ok()
                    } else {
                        None
                    }
                }
            );
            let linux_keyring = if cfg!(target_os = "linux") {
                tokio::task::spawn_blocking(linux_setup::probe_keyring_status)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let mut log = RecordingLog::default();
            match sessions {
                Ok(page) => {
                    let selected = page
                        .items
                        .iter()
                        .find(|s| Some(&s.id) == wanted.as_ref())
                        .or_else(|| page.items.first());
                    // An active session may not be in the newest page; never
                    // substitute an older recording's log for that session.
                    let id = wanted.clone().or_else(|| selected.map(|s| s.id.clone()));
                    if let Some(id) = id {
                        let matching = selected.filter(|s| s.id == id);
                        log.current = wanted.as_ref() == Some(&id);
                        log.session_id = Some(id.clone());
                        log.title = matching.map(|s| s.title.clone());
                        log.log_count = matching.map_or(0, |s| s.session_log_count);
                        match client
                            .call::<SessionLogsList>(&SessionDetailListParams {
                                session_id: id,
                                cursor: None,
                                limit: h::RECORDING_LOG_LIMIT,
                            })
                            .await
                        {
                            // The backend selects the newest 120 DESC, then
                            // reverses that page for display. Its cursor is for
                            // older entries; do not walk it for the live tail.
                            Ok(page) => log.entries = page.entries,
                            Err(_) => log.failed = true,
                        }
                    }
                }
                Err(_) => log.failed = true,
            }
            let crash = tokio::task::spawn_blocking(move || {
                crash_log::read_crash_log(&crash_path).into_iter().next()
            })
            .await
            .ok()
            .flatten();
            (
                log,
                camera
                    .ok()
                    .and_then(|v| serde_json::from_value::<VirtualCameraStatus>(v).ok()),
                compositor.ok().map(|v| v.frame_pipeline),
                crash,
                linux_keyring,
                linux_desktop,
            )
        });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.reading = false;
                if this.studio.snapshot().connection_generation == generation
                    && this.studio.snapshot().session.status.session_id == requested_session
                {
                    if let Ok((mut log, camera, compositor, crash, linux_keyring, linux_desktop)) =
                        result
                    {
                        if log.session_id == this.recording_log.session_id {
                            log.log_count = log.log_count.max(this.recording_log.log_count);
                            // Pushed lines may arrive after the snapshot was
                            // read. Keep them, deduplicate and bound the tail.
                            log.entries
                                .extend(this.recording_log.entries.iter().cloned());
                            trim_log(&mut log.entries);
                        }
                        this.recording_log = log;
                        if this.camera_revision == camera_revision {
                            this.camera_status = camera;
                        }
                        if this.compositor_revision == compositor_revision {
                            this.compositor = compositor;
                        }
                        this.crash = crash;
                        this.linux_keyring = linux_keyring;
                        this.linux_desktop = linux_desktop;
                    } else {
                        this.recording_log.loading = false;
                        this.recording_log.failed = true;
                    }
                } else {
                    this.read_again = true;
                }
                this.rebuild(cx);
                if this.read_again && this.active {
                    this.refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Explicit screen assembly inputs keep independent view state and callbacks visible"
)]
fn page_view(
    studio: &Studio<BackendClient>,
    log: &RecordingLog,
    logger: &Logger,
    crash: Option<&CrashRecord>,
    camera: Option<&VirtualCameraStatus>,
    compositor: Option<&CompositorFramePipelineStatus>,
    removing: bool,
    linux_keyring: Option<&LinuxKeyringStatus>,
    linux_desktop: Option<&Value>,
) -> h::HealthPageView {
    let snapshot = studio.snapshot();
    let telemetry = studio.telemetry_now();
    h::health_page(&PageInputs {
        telemetry: &telemetry,
        summary: &snapshot.health,
        capture_sources: Fields::of(snapshot.settings.capture_doc.get("sources")),
        native_preview_surface_enabled: cfg!(target_os = "macos"),
        platform: h::current_platform(),
        development: true,
        pipeline: snapshot.session.status.pipeline.as_ref(),
        device_warnings: &snapshot.sources.devices.warnings,
        recording_log: log,
        app_log: &logger.recent(),
        crash,
        record_latency: &snapshot.record_latency,
        camera: CameraGroupInputs {
            status: camera,
            pipeline: compositor,
            connected: studio.is_connected(),
            removing,
        },
        linux_keyring,
        linux_desktop,
        now: Instant::now(),
    })
}

/// Match the database's (created_at, id) ordering and retain only the tail.
fn trim_log(entries: &mut Vec<SessionLogEntry>) {
    entries.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    entries.dedup_by(|a, b| a.id == b.id);
    let discard = entries.len().saturating_sub(h::RECORDING_LOG_LIMIT);
    entries.drain(..discard);
}
