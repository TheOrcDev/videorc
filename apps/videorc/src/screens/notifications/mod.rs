//! One app-core notice store for both windows. Only Store effects and the
//! explicitly named press answers reach a toaster; legacy automatic notices
//! without a typed source remain behind the bell.
mod render;
mod routing;
mod watchdog;

use gpui::{
    Context, Entity, EventEmitter, FocusHandle, Global, KeyBinding, Window, actions, prelude::*,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    rc::Rc,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use videorc_app_core::notices::{
    self as n, ActionKind, Effect, Entry, Notice, NoticeAction, NoticeCommand, NoticeKind,
    NoticeLifetime, Store, Tone, sources,
};
use videorc_app_core::studio::session::{SessionEffect, session_is_replay_only};
use videorc_app_core::{BackendClient, BackendEvent, BackendState, Studio};
use videorc_kit::toast::{ToastData, ToastKind, Toaster};

actions!(notifications, [ToggleNotifications]);
#[derive(Clone)]
pub struct Shared(pub Entity<Hub>);
impl Global for Shared {}
#[derive(Clone)]
pub enum Delivery {
    Store(Effect),
    Press(Notice),
    Dismiss(String),
}
#[derive(Clone)]
pub enum Navigate {
    Action(NoticeAction),
    Settings(videorc_app_core::settings_page::SettingsTab),
}
impl EventEmitter<Delivery> for Hub {}
impl EventEmitter<Navigate> for Hub {}

pub struct Hub {
    store: Store,
    studio: Arc<Studio<BackendClient>>,
    runtime: tokio::runtime::Handle,
    quality: HashSet<String>,
    targets: BTreeMap<String, videorc_app_core::protocol::streaming::StreamTargetState>,
    legacy_actions: HashMap<(String, String), NoticeAction>,
    microphone: Option<n::MicrophoneNotice>,
    last_session: Option<String>,
    busy: HashSet<String>,
    shown: Vec<Entry>,
    watchdog: Vec<sources::watchdog::WatchdogAlert>,
}

impl Hub {
    pub fn new(
        studio: Arc<Studio<BackendClient>>,
        runtime: tokio::runtime::Handle,
        mut backend: tokio::sync::watch::Receiver<BackendState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let initial_backend = backend.borrow().clone();
        let mut snapshots = studio.watch();
        let mut events = studio.backend().subscribe();
        let mut effects = studio.effects();
        let mut legacy = studio.notices();
        let mut watchdog = studio.watchdog();
        cx.spawn(async move |entity, cx| {
            loop {
                enum Incoming { Snapshot, Watchdog, Backend, Event(BackendEvent), Session(SessionEffect), Legacy(NoticeCommand), Lagged }
                let incoming = tokio::select! {
                    changed = watchdog.changed() => { if changed.is_err() { break; } watchdog.borrow_and_update(); Incoming::Watchdog },
                    changed = snapshots.changed() => { if changed.is_err() { break; } snapshots.borrow_and_update(); Incoming::Snapshot },
                    changed = backend.changed() => { if changed.is_err() { break; } Incoming::Backend },
                    next = events.recv() => match next { Ok(e) => Incoming::Event(e), Err(tokio::sync::broadcast::error::RecvError::Closed) => break, Err(_) => Incoming::Lagged },
                    next = effects.recv() => match next { Ok(e) => Incoming::Session(e), Err(tokio::sync::broadcast::error::RecvError::Closed) => break, Err(_) => Incoming::Lagged },
                    next = legacy.recv() => match next { Ok(e) => Incoming::Legacy(e), Err(tokio::sync::broadcast::error::RecvError::Closed) => break, Err(_) => Incoming::Lagged },
                };
                if let Incoming::Event(event) = &incoming {
                    let relevant = match event {
                        BackendEvent::HealthEvent(_) | BackendEvent::RecordingFinalization(_) | BackendEvent::EventsLagged(_) | BackendEvent::ClientLagged {..} => true,
                        BackendEvent::Untyped {event, ..} => matches!(event.as_str(), "stream.targets" | "replay.saved" | "replay.saveFailed" | "replay.state"),
                        _ => false,
                    };
                    if !relevant { continue; }
                }
                let state = backend.borrow().clone();
                if matches!(&incoming, Incoming::Backend) { backend.borrow_and_update(); }
                if entity.update(cx, |this, cx| {
                    this.refresh();
                    match incoming {
                        Incoming::Snapshot => {},
                        Incoming::Watchdog => this.sync_watchdog(),
                        Incoming::Backend => this.backend(state),
                        Incoming::Event(event) => this.event(event, cx),
                        Incoming::Session(effect) => this.session(effect),
                        Incoming::Legacy(notice) => this.legacy(notice, cx),
                        Incoming::Lagged => this.store.publish(sources::app::backend_error(), now()),
                    }
                    this.flush(cx);
                }).is_err() { break; }
            }
        }).detach();
        let mut this = Self {
            store: Store::new(now(), n::LAUNCH_QUIET_MS),
            studio,
            runtime,
            quality: HashSet::new(),
            targets: BTreeMap::new(),
            legacy_actions: HashMap::new(),
            microphone: None,
            last_session: None,
            busy: HashSet::new(),
            shown: Vec::new(),
            watchdog: Vec::new(),
        };
        this.backend(initial_backend);
        this.refresh();
        this.sync_watchdog();
        if let Some(failure) = this.studio.snapshot().session.notice {
            this.store
                .publish(sources::health::recording_failure(&failure), now());
        }
        this.store.take_effects(); // Launch state is bell-only.
        this.shown = this.store.snapshot().to_vec();
        this
    }
    fn refresh(&mut self) {
        let snapshot = self.studio.snapshot();
        let status = &snapshot.session.status;
        if status.session_id.is_some() {
            self.last_session = status.session_id.clone();
        }
        let active = matches!(
            status.state,
            videorc_app_core::protocol::RecordingState::Recording
                | videorc_app_core::protocol::RecordingState::Streaming
        ) && !session_is_replay_only(status);
        self.store.set_live(active);
        if snapshot.session.microphone_notice != self.microphone {
            if let Some(notice) = &snapshot.session.microphone_notice {
                if notice.phase != n::MicrophonePhase::Ended {
                    if let Some(input) = sources::devices::microphone_loss(notice) {
                        self.store.publish(input, now());
                    }
                }
            }
            // Only the typed health recovery clears a loss. A start attempt
            // also clears the legacy snapshot; that is not a recovered mic.
            self.microphone = snapshot.session.microphone_notice.clone();
        }
    }
    fn flush(&mut self, cx: &mut Context<Self>) {
        for effect in self.store.take_effects() {
            if let Effect::Cleared { key } = &effect {
                self.acknowledge(key);
            }
            cx.emit(Delivery::Store(effect));
        }
        // Forget action payloads (including Copy details) when their entry leaves.
        let keys: HashSet<_> = self
            .store
            .snapshot()
            .iter()
            .map(|e| e.key.clone())
            .collect();
        self.legacy_actions.retain(|(key, _), _| keys.contains(key));
        if self.shown != self.store.snapshot() {
            self.shown = self.store.snapshot().to_vec();
            cx.notify();
        }
    }
    pub fn attach_library(
        &mut self,
        mut notices: tokio::sync::broadcast::Receiver<videorc_app_core::library::LibraryNotice>,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |entity, cx| {
            loop {
                let notice = match notices.recv().await {
                    Ok(notice) => notice,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                if entity
                    .update(cx, |this, cx| {
                        use videorc_app_core::library::{
                            LibraryNotice, cloud::CloudDownloadNotice,
                        };
                        let input = match notice {
                            LibraryNotice::NoiseCleanupCompleted(done) => {
                                sources::session::noise_cleanup_completed(
                                    &done.job_id,
                                    &done.output_session_id,
                                )
                            }
                            LibraryNotice::CloudDownload(CloudDownloadNotice::Saved {
                                recording_id,
                                ..
                            }) => sources::work::cloud_download_saved(&recording_id),
                            LibraryNotice::CloudDownload(CloudDownloadNotice::Failed {
                                recording_id,
                                known,
                                ..
                            }) => sources::work::cloud_download_failed(
                                &recording_id,
                                "Couldn't download the cloud recording.",
                                known.as_deref(),
                            ),
                        };
                        this.store.publish(input, now());
                        this.flush(cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }
    pub fn pressed(&mut self) {
        self.store.set_pressed();
    }
    fn set_open(&mut self, who: &str, open: bool, cx: &mut Context<Self>) {
        self.store.set_list_open(open, who);
        if !open {
            self.store.mark_all_read(now());
        }
        self.flush(cx);
    }
    fn clear(&mut self, key: Option<&str>, cx: &mut Context<Self>) {
        match key {
            Some(key) => self.store.clear(key, now()),
            None => self.store.clear_all(now()),
        }
        self.flush(cx);
    }
    fn read(&mut self, key: &str, cx: &mut Context<Self>) {
        self.store.mark_read(key, now());
        self.flush(cx);
    }
    fn action(&self, key: &str, id: &str) -> Option<NoticeAction> {
        if let Some(action) = self.legacy_actions.get(&(key.to_owned(), id.to_owned())) {
            return Some(action.clone());
        }
        use videorc_app_core::nav::PageId;
        match id.strip_prefix("fix:").unwrap_or(id) {
            "open-health" => Some(NoticeAction::OpenHealth),
            "open-sources" => Some(NoticeAction::OpenPage(PageId::Sources)),
            "open-audio" => Some(NoticeAction::OpenPage(PageId::Studio)),
            "open-output" => Some(NoticeAction::OpenPage(PageId::Recording)),
            "open-permissions" | "open-shortcuts" => None,
            "resume-system-audio" | "resume" if key == sources::devices::SYSTEM_AUDIO_ECHO_KEY => {
                Some(NoticeAction::ResumeSystemAudio)
            }
            _ => None,
        }
    }
    fn can_run(&self, key: &str, id: &str) -> bool {
        matches!(id, "open-permissions" | "open-shortcuts")
            || self.watchdog_job(key, id).is_some()
            || self.action(key, id).as_ref().is_some_and(Self::supported)
    }
    fn supported(action: &NoticeAction) -> bool {
        use videorc_app_core::nav::PageId;
        matches!(
            action,
            NoticeAction::RetryStart
                | NoticeAction::OpenLibrary { .. }
                | NoticeAction::Copy { .. }
                | NoticeAction::OpenHealth
                | NoticeAction::ResumeSystemAudio
                | NoticeAction::OpenUrl { .. }
                | NoticeAction::OpenPage(
                    PageId::Studio
                        | PageId::Library
                        | PageId::Sources
                        | PageId::Recording
                        | PageId::Settings
                        | PageId::Diagnostics
                )
        )
    }
    fn run(&mut self, key: &str, id: &str, cx: &mut Context<Self>) -> Option<ActionKind> {
        if self.busy.contains(key) {
            return None;
        }
        if !self.can_run(key, id) {
            return None;
        }
        let kind = self.store.run_action(key, id, now())?.kind;
        match id {
            "open-permissions" => cx.emit(Navigate::Settings(
                videorc_app_core::settings_page::SettingsTab::Permissions,
            )),
            "open-shortcuts" => cx.emit(Navigate::Settings(
                videorc_app_core::settings_page::SettingsTab::Shortcuts,
            )),
            _ => {
                if let Some(job) = self.watchdog_job(key, id) {
                    self.run_watchdog(job, key, cx);
                } else if let Some(action) = self.action(key, id) {
                    self.perform(action, Some(key.to_owned()), cx);
                }
            }
        }
        self.flush(cx);
        Some(kind)
    }
    fn perform(&mut self, action: NoticeAction, key: Option<String>, cx: &mut Context<Self>) {
        match action {
            NoticeAction::RetryStart | NoticeAction::ResumeSystemAudio => {
                if let Some(key) = &key {
                    self.busy.insert(key.clone());
                    cx.notify();
                }
                let studio = self.studio.clone();
                let task = self.runtime.spawn(async move {
                    match action {
                        NoticeAction::RetryStart => {
                            studio.retry_start().await;
                        }
                        _ => studio.set_system_audio_enabled(true).await,
                    }
                });
                cx.spawn(async move |entity, cx| {
                    let _ = task.await;
                    let _ = entity.update(cx, |this, cx| {
                        if let Some(key) = key {
                            this.busy.remove(&key);
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
            _ => cx.emit(Navigate::Action(action)),
        }
    }
}

pub struct Centre {
    hub: Entity<Hub>,
    who: &'static str,
    open: bool,
    ticking: bool,
    toaster: Entity<Toaster>,
    focuses: HashMap<String, FocusHandle>,
}
impl Centre {
    pub fn new(
        hub: Entity<Hub>,
        who: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let toaster = cx.new(Toaster::new);
        cx.observe(&hub, |_, _, cx| cx.notify()).detach();
        cx.subscribe_in(&hub, window, |this, _, delivery: &Delivery, window, cx| {
            // Automatic pops have one home, even with both windows open.
            if this.who == "main" {
                this.deliver(delivery.clone(), window, cx);
            }
        })
        .detach();
        let closing = hub.clone();
        cx.on_release(move |this, cx| {
            if this.open {
                closing.update(cx, |hub, cx| hub.set_open(this.who, false, cx));
            }
        })
        .detach();
        Self {
            hub,
            who,
            open: false,
            ticking: false,
            toaster,
            focuses: HashMap::new(),
        }
    }
    pub fn toggle(&mut self, cx: &mut Context<Self>) {
        self.set_open(!self.open, cx);
    }
    fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.open == open {
            return;
        }
        self.open = open;
        self.hub.update(cx, |hub, cx| {
            hub.pressed();
            hub.set_open(self.who, open, cx);
        });
        if open && !self.ticking {
            self.ticking = true;
            cx.spawn(async move |entity, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    if !entity
                        .update(cx, |this, cx| {
                            if this.open {
                                cx.notify();
                            } else {
                                this.ticking = false;
                            }
                            this.open
                        })
                        .unwrap_or(false)
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        cx.notify();
    }
    pub fn toasts(&self) -> Entity<Toaster> {
        self.toaster.clone()
    }
    fn act(&mut self, key: &str, id: &str, cx: &mut Context<Self>) {
        if self.hub.update(cx, |hub, cx| hub.run(key, id, cx)) == Some(ActionKind::Door) {
            self.set_open(false, cx);
        }
    }
    fn deliver(&mut self, delivery: Delivery, window: &mut Window, cx: &mut Context<Self>) {
        match delivery {
            Delivery::Store(Effect::Show {
                entry, duration_ms, ..
            }) => self.popup(entry, duration_ms, window, cx),
            Delivery::Store(Effect::Recovered { entry }) => {
                if self.toaster.read(cx).contains(&entry.key.clone().into()) {
                    self.popup(entry, 8_000, window, cx);
                }
            }
            Delivery::Store(Effect::Dismiss { key }) | Delivery::Dismiss(key) => self
                .toaster
                .update(cx, |toaster, cx| toaster.dismiss(&key.into(), window, cx)),
            Delivery::Press(notice) => {
                let id = notice
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("press:{}", notice.title));
                let mut data = ToastData::new(
                    match notice.kind {
                        NoticeKind::Error => ToastKind::Error,
                        NoticeKind::Warning => ToastKind::Warning,
                        NoticeKind::Success => ToastKind::Success,
                        NoticeKind::Info => ToastKind::Info,
                        _ => ToastKind::Plain,
                    },
                    notice.title,
                );
                data.description = notice.description.map(Into::into);
                data.timeout = Some(match notice.lifetime {
                    NoticeLifetime::For(duration) => Some(duration),
                    NoticeLifetime::UntilClosed => None,
                });
                if let Some(button) = notice.action.filter(|b| Hub::supported(&b.action)) {
                    let hub = self.hub.clone();
                    data = data.action(button.label, move |_, cx| {
                        hub.update(cx, |hub, cx| hub.perform(button.action.clone(), None, cx))
                    });
                }
                if notice.on_close == Some(n::NoticeClose::DismissStartFailure) {
                    let studio = self.hub.read(cx).studio.clone();
                    data.on_close = Some(Rc::new(move |_, _| studio.dismiss_start_failure()));
                }
                self.toaster
                    .update(cx, |toaster, cx| toaster.show(id, data, window, cx));
            }
            _ => {}
        }
    }
    fn popup(
        &mut self,
        entry: Entry,
        duration_ms: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut data = ToastData::new(
            match entry.tone {
                Tone::Urgent => ToastKind::Error,
                Tone::Warning => ToastKind::Warning,
                Tone::News => ToastKind::Info,
                Tone::Done => ToastKind::Success,
            },
            entry.title,
        );
        data.description = entry.detail.map(Into::into);
        data.timeout = Some(Some(Duration::from_millis(duration_ms)));
        let hub = self.hub.clone();
        let key = entry.key.clone();
        data.on_close = Some(Rc::new(move |_, cx| {
            hub.update(cx, |hub, cx| hub.read(&key, cx))
        }));
        if let Some(action) = entry
            .actions
            .first()
            .filter(|a| self.hub.read(cx).can_run(&entry.key, &a.id))
        {
            let hub = self.hub.clone();
            let key = entry.key.clone();
            let id = action.id.clone();
            data = data.action(action.label.clone(), move |_, cx| {
                hub.update(cx, |hub, cx| {
                    hub.run(&key, &id, cx);
                });
            });
        }
        self.toaster
            .update(cx, |toaster, cx| toaster.show(entry.key, data, window, cx));
    }
}
pub fn install_keys(cx: &mut gpui::App) {
    cx.bind_keys([KeyBinding::new(
        "secondary-shift-b",
        ToggleNotifications,
        Some("!Dialog && !Menu && !Select"),
    )]);
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
