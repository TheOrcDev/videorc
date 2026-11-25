//! Settings is a projection of app-core; writes go through the Studio or
//! the backend, never through a second settings file. Only the selected tab
//! is device-local. The kit owns every control and section.
mod about;
mod changelog;
pub mod connect_agent;
mod general;
mod obs;
mod permissions;
mod phone;
mod remote;
mod setup;
mod shortcuts;

use crate::app::permissions::Permissions;
use gpui::{App, Context, EventEmitter, Window, prelude::*};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use videorc_app_core::settings_page::{self as view, ChatEmotes, Loaded, SettingsTab, UsageStats};
use videorc_app_core::settings_page::{
    agents::{ACTIVITY_ROWS, ActivityEntry, AgentsStatus, with_last_action},
    remote::{RemoteControlStatus, RemoteLanStatus},
};
use videorc_app_core::studio::ui_local::UiLocal;
use videorc_app_core::{BackendClient, BackendEvent, Studio};
use videorc_kit::dialog::DialogHandle;

pub const EVENTS: [&str; 6] = [
    "liveChat.emotes",
    "remote.control.status",
    "remote.lan.status",
    "agents.status",
    "agents.activity",
    "account.changed",
];
/// The remote settings couldn't be read (`remote.control.status`,
/// `remote.lan.status`, `agents.status`, `agents.activity.list`).
const REMOTE_READ_FAILED: &str = "Couldn't read the remote settings. Reopen Settings to try again.";

pub struct Navigate(pub videorc_app_core::nav::PageId);
impl EventEmitter<Navigate> for SettingsScreen {}

/// Shell opens the full-window first-run setup (replay from Settings / ⌘K).
#[derive(Debug, Clone, Copy)]
pub struct OpenSetup;
impl EventEmitter<OpenSetup> for SettingsScreen {}

pub struct SettingsScreen {
    studio: Arc<Studio<BackendClient>>,
    backend: tokio::sync::watch::Receiver<videorc_app_core::supervisor::BackendState>,
    runtime: tokio::runtime::Handle,
    permissions: Arc<Permissions>,
    local_dir: PathBuf,
    os_release: Option<String>,
    applied_theme: Option<videorc_app_core::nav::ThemeChoice>,
    tab: SettingsTab,
    chat: Loaded<ChatEmotes>,
    usage: Loaded<UsageStats>,
    remote: Option<RemoteControlStatus>,
    phone: Option<RemoteLanStatus>,
    agents: Option<AgentsStatus>,
    activity: Option<Vec<ActivityEntry>>,
    activity_filter: Option<String>,
    error: Option<String>,
    busy: bool,
    // A read cannot replace a newer event, write or connection. Events
    // invalidate only their own field, so an active agent cannot cause
    // endless full-page reads; commands and reconnects invalidate the batch.
    revision: u64,
    event_revisions: [u64; 6],
    reading: bool,
    read_again: bool,
    pending_permission: Option<videorc_app_core::desktop::permissions::SystemPermissionPane>,
    confirm: DialogHandle,
    rename: DialogHandle,
    pair: DialogHandle,
    phone_edit: Option<(
        videorc_app_core::settings_page::remote::RemoteLanDevice,
        gpui::Entity<videorc_kit::input::InputState>,
    )>,
    pairing: Option<(
        videorc_app_core::settings_page::remote::RemoteLanPairing,
        i64,
    )>,
    pairing_revealed: bool,
    pairing_link_copied: bool,
    pair_need_open: bool,
    pair_need_close: bool,
    pair_tick_generation: u64,
    confirmation: Option<remote::Confirmation>,
    obs: obs::ObsImport,
    hotkeys: crate::app::hotkeys::Hotkeys,
    shortcut: shortcuts::Recorder,
    applied_shortcuts: Option<Value>,
    setup: setup::Replay,
    changelog: changelog::Changelog,
    account: Option<videorc_app_core::protocol::VideorcAccountSnapshot>,
    /// Connect an agent… (P1424, P1425), made on first use.
    connect_agent: Option<gpui::Entity<connect_agent::ConnectAgentDialog>>,
}

impl SettingsScreen {
    pub fn new(
        studio: Arc<Studio<BackendClient>>,
        backend: tokio::sync::watch::Receiver<videorc_app_core::supervisor::BackendState>,
        hotkeys: crate::app::hotkeys::Hotkeys,
        runtime: tokio::runtime::Handle,
        permissions: Arc<Permissions>,
        local_dir: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let tab = SettingsTab::parse(UiLocal::in_dir(&local_dir).settings_tab())
            .unwrap_or(SettingsTab::General);
        let mut changes = studio.watch();
        cx.spawn(async move |entity, cx| {
            let relevant = |state: &videorc_app_core::studio::StudioSnapshot| {
                (
                    state.settings.theme.clone(),
                    state.settings.studio.doc().clone(),
                    state.settings.hydrated,
                    state.settings.revision,
                    state.sources.devices_revision,
                    state.session.phase,
                    state.connection_generation,
                    state.bootstrapped,
                    state
                        .scenes
                        .scenes
                        .iter()
                        .map(|scene| (scene.id.clone(), scene.name.clone()))
                        .collect::<Vec<_>>(),
                )
            };
            let mut previous = relevant(&changes.borrow());
            while changes.changed().await.is_ok() {
                let next = relevant(&changes.borrow_and_update());
                if next == previous {
                    continue;
                }
                previous = next;
                if entity
                    .update(cx, |this, cx| {
                        this.apply_theme(cx);
                        this.apply_shortcuts();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |entity, cx| {
            loop {
                let event = events.recv().await;
                if matches!(event, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                    break;
                }
                if entity
                    .update(cx, |this, cx| {
                        match event {
                            Ok(BackendEvent::Untyped { event, payload })
                                if EVENTS.contains(&event.as_str()) =>
                            {
                                if let Some(index) = EVENTS.iter().position(|name| *name == event) {
                                    this.event_revisions[index] += 1;
                                }
                                match event.as_str() {
                                    "account.changed" => {
                                        this.account = payload
                                            .get("account")
                                            .cloned()
                                            .and_then(|v| serde_json::from_value(v).ok());
                                    }
                                    "liveChat.emotes" => {
                                        this.chat.value = serde_json::from_value(payload).ok();
                                        this.chat.error = this
                                            .chat
                                            .value
                                            .is_none()
                                            .then_some(view::copy::CHAT_READ_FAILED);
                                    }
                                    "remote.control.status" => {
                                        this.remote = serde_json::from_value(payload).ok()
                                    }
                                    "remote.lan.status" => {
                                        this.phone = serde_json::from_value(payload).ok()
                                    }
                                    "agents.activity" => {
                                        if let Ok(entry) =
                                            serde_json::from_value::<ActivityEntry>(payload)
                                        {
                                            if let Some(status) = &mut this.agents {
                                                with_last_action(status, &entry);
                                            }
                                            if this
                                                .activity_filter
                                                .as_ref()
                                                .is_none_or(|id| *id == entry.agent_id)
                                            {
                                                {
                                                    let rows =
                                                        this.activity.get_or_insert_with(Vec::new);
                                                    rows.retain(|row| row.id != entry.id);
                                                    rows.insert(0, entry);
                                                    rows.truncate(ACTIVITY_ROWS);
                                                }
                                            }
                                        }
                                    }
                                    "agents.status" => {
                                        this.agents = serde_json::from_value(payload).ok()
                                    }
                                    _ => {}
                                }
                            }
                            Ok(BackendEvent::ConnectionClosed { .. }) => {
                                this.revision += 1;
                                this.account = None;
                                this.chat = Loaded::default();
                                this.usage = Loaded::default();
                                this.remote = None;
                                this.phone = None;
                                this.agents = None;
                                this.activity = None;
                            }
                            Ok(
                                BackendEvent::Ready(_)
                                | BackendEvent::EventsLagged(_)
                                | BackendEvent::ClientLagged { .. },
                            )
                            | Err(_) => {
                                this.revision += 1;
                                this.remote = None;
                                this.phone = None;
                                this.agents = None;
                                this.activity = None;
                                this.refresh(cx);
                            }
                            _ => {}
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let os_release = std::process::Command::new("uname")
            .arg("-r")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|s| s.trim().to_string());
        let mut this = Self {
            studio,
            backend,
            runtime,
            permissions,
            local_dir,
            os_release,
            applied_theme: None,
            tab,
            chat: Loaded::default(),
            usage: Loaded::default(),
            remote: None,
            phone: None,
            agents: None,
            activity: None,
            activity_filter: None,
            error: None,
            busy: false,
            revision: 0,
            event_revisions: [0; 6],
            reading: false,
            read_again: false,
            pending_permission: None,
            confirm: DialogHandle::new(false),
            rename: DialogHandle::new(false),
            pair: DialogHandle::new(false),
            phone_edit: None,
            pairing: None,
            pairing_revealed: false,
            pairing_link_copied: false,
            pair_need_open: false,
            pair_need_close: false,
            pair_tick_generation: 0,
            confirmation: None,
            obs: obs::ObsImport::default(),
            hotkeys,
            shortcut: Default::default(),
            applied_shortcuts: None,
            setup: Default::default(),
            changelog: Default::default(),
            account: None,
            connect_agent: None,
        };
        this.apply_theme(cx);
        this.apply_shortcuts();
        this.refresh(cx);
        this
    }

    pub fn select(&mut self, tab: SettingsTab, cx: &mut Context<Self>) {
        self.disarm_shortcut(cx);
        self.tab = tab;
        // Reload before writing: other pages also own keys in ui-local.json.
        if UiLocal::in_dir(&self.local_dir)
            .set_settings_tab(tab.id())
            .is_err()
        {
            self.error = Some("Couldn't save the last Settings tab.".into());
        }
        self.refresh(cx);
        cx.notify();
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.permissions.recheck();
        if self.reading || self.busy {
            self.read_again = true;
            return;
        }
        self.reading = true;
        self.read_again = false;
        let revision = self.revision;
        let event_revisions = self.event_revisions;
        let client = self.studio.backend().clone();
        let studio = self.studio.clone();
        let activity_params = match &self.activity_filter {
            Some(id) => json!({"limit":ACTIVITY_ROWS, "agentId":id}),
            None => json!({"limit":ACTIVITY_ROWS}),
        };
        let refresh_devices = self.tab == SettingsTab::Permissions;
        let job = self.runtime.spawn(async move {
            if refresh_devices {
                let _ = studio.refresh_sources().await;
            }
            tokio::join!(
                client.request("liveChat.emotes.get", json!({})),
                client.request("usageStats.get", json!({})),
                client.request("remote.control.status", json!({})),
                client.request("remote.lan.status", json!({})),
                client.request("agents.status", json!({})),
                client.request("agents.activity.list", activity_params),
                client.request("account.get", json!({}))
            )
        });
        cx.spawn(async move |entity, cx| {
            let answer = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.reading = false;
                if revision == this.revision {
                    if let Ok((chat, usage, remote, phone, agents, activity, account)) = answer {
                        if event_revisions[5] == this.event_revisions[5] {
                            this.account =
                                account.ok().and_then(|v| serde_json::from_value(v).ok());
                        }
                        if event_revisions[0] == this.event_revisions[0] {
                            this.chat.value =
                                chat.ok().and_then(|v| serde_json::from_value(v).ok());
                            this.chat.error = this
                                .chat
                                .value
                                .is_none()
                                .then_some(view::copy::CHAT_READ_FAILED);
                        }
                        this.usage.value = usage.ok().and_then(|v| serde_json::from_value(v).ok());
                        this.usage.error = this
                            .usage
                            .value
                            .is_none()
                            .then_some(view::copy::USAGE_READ_FAILED);
                        if event_revisions[1] == this.event_revisions[1] {
                            this.remote = remote.ok().and_then(|v| serde_json::from_value(v).ok());
                        }
                        if event_revisions[2] == this.event_revisions[2] {
                            this.phone = phone.ok().and_then(|v| serde_json::from_value(v).ok());
                        }
                        if event_revisions[3] == this.event_revisions[3] {
                            this.agents = agents.ok().and_then(|v| serde_json::from_value(v).ok());
                        }
                        let loaded: Option<Vec<ActivityEntry>> = activity
                            .ok()
                            .and_then(|value| value.get("entries").cloned())
                            .and_then(|value| serde_json::from_value(value).ok());
                        if event_revisions[4] == this.event_revisions[4] {
                            this.activity = loaded;
                        } else if let Some(loaded) = loaded {
                            let rows = this.activity.get_or_insert_with(Vec::new);
                            for row in loaded {
                                if !rows.iter().any(|recent| recent.id == row.id) {
                                    rows.push(row);
                                }
                            }
                            rows.truncate(ACTIVITY_ROWS);
                        }
                        // The remote settings' one notice: set while a read
                        // came back short, cleared by the next whole read
                        // (opening Settings reads again), so a failure at
                        // startup doesn't stay for the session.
                        let short = this.remote.is_none()
                            || this.phone.is_none()
                            || this.agents.is_none()
                            || this.activity.is_none();
                        if short {
                            this.error = Some(REMOTE_READ_FAILED.into());
                        } else if this.error.as_deref() == Some(REMOTE_READ_FAILED) {
                            this.error = None;
                        }
                    }
                }
                if this.read_again {
                    this.refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn request(
        &mut self,
        method: &'static str,
        params: Value,
        failure: &'static str,
        cx: &mut Context<Self>,
    ) {
        if self.busy || !self.studio.is_connected() {
            return;
        }
        self.busy = true;
        self.revision += 1;
        self.error = None;
        let client = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { client.request(method, params).await.is_ok() });
        cx.spawn(async move |entity, cx| {
            let ok = job.await.unwrap_or(false);
            let _ = entity.update(cx, |this, cx| {
                this.busy = false;
                if !ok {
                    this.error = Some(failure.into());
                }
                this.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn save_studio(&mut self, key: &'static str, value: bool, cx: &mut Context<Self>) {
        if self.busy || !self.studio.snapshot().settings.hydrated {
            return;
        }
        self.busy = true;
        self.error = None;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .update_studio_settings(|settings| settings.set(key, json!(value)))
                .await
                .is_ok()
        });
        self.finish_save(job, cx);
    }

    fn finish_save(&mut self, job: tokio::task::JoinHandle<bool>, cx: &mut Context<Self>) {
        cx.spawn(async move |entity, cx| {
            let ok = job.await.unwrap_or(false);
            let _ = entity.update(cx, |this, cx| {
                this.busy = false;
                if !ok {
                    this.error = Some("Couldn't save the settings. Try again.".into());
                }
                if this.read_again {
                    this.refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn disabled(&self) -> bool {
        self.busy || !self.studio.is_connected()
    }
}

// Rendering stays in the screen; no kit control is copied here.
use gpui::{div, px};
use videorc_kit::{
    tabs::Tabs,
    theme::{self, FONT, TypeScale, hsla},
    tokens::{size, text},
};
impl Render for SettingsScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.obs.state.open && !self.obs.dialog.is_open() && !self.obs.state.applying {
            self.obs.state.closed();
        }
        self.flush_pair_dialog(window, cx);
        let t = theme::current(window, cx).theme();
        let mut tabs = Tabs::new("settings-tabs").selected(self.tab.index());
        for tab in view::TABS {
            tabs = tabs.tab(tab.label());
        }
        let entity = cx.entity();
        let tabs = tabs.on_select(move |index, _, cx| {
            entity.update(cx, |this, cx| this.select(view::TABS[index], cx))
        });
        let body = match self.tab {
            SettingsTab::General => self.general(window, cx),
            SettingsTab::Permissions => self.permission_page(window, cx),
            SettingsTab::Remote => self.remote_page(window, cx),
            SettingsTab::About => self.about_page(window, cx),
            SettingsTab::Shortcuts => self.shortcuts_page(window, cx),
        };
        div()
            .id("settings-page")
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, _, cx| this.disarm_shortcut(cx)),
            )
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                // A flex strip, so the tab list hugs its labels (`w-fit`,
                // sitting left) instead of stretching as a block child.
                div()
                    .flex_none()
                    .flex()
                    .px(px(size::GUTTER))
                    .py(px(8.))
                    .border_b_1()
                    .border_color(hsla(t.border))
                    .child(tabs),
            )
            .child(
                div().id(self.tab.id()).flex_1().min_h(px(0.)).child(
                    // `fill`: the content is at least the page's height, so a
                    // tab's column pair stretches and its rule runs to the
                    // foot (`CONFIG_GRID_PAIR`'s `flex-1 content-stretch`).
                    videorc_kit::scroll_area::ScrollArea::new(self.tab.id())
                        .fill(true)
                        .children(self.error.clone().map(|error| {
                            videorc_kit::alert::Alert::new("settings-error").title(error)
                        }))
                        .child(body),
                ),
            )
            .child(self.confirmation_dialog(cx))
            .child(self.rename_dialog(cx))
            .child(self.pair_dialog(window, cx))
            .children(self.connect_agent.clone())
            .child(self.obs_dialog(cx))
            .child(self.setup_dialog(window, cx))
            .child(self.changelog_dialog(cx))
    }
}
