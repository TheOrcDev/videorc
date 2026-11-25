//! Destinations ⌘6 (plan 260 Phase 3, Sweep A): Setup trail (destinations,
//! stream details, chat commands, output quality, Videorc Cloud, Watchdog,
//! After the stream, ready), Upcoming, and Discord. Words from
//! `livestream::copy` and section modules.

mod category;
mod chat_commands;
mod cloud;
mod details;
mod discord;
mod oauth_extras;
mod quality;
mod ready;
mod schedule;
mod stream_report;
mod thumbnail;
mod upcoming;
mod watchdog;
mod youtube_consent;

use std::sync::Arc;

use gpui::{Context, Entity, SharedString, Window, div, prelude::*, px, relative};
use serde_json::json;
use videorc_app_core::livestream::DetailsState;
use videorc_app_core::livestream::cloud_view::{self, SectionView as CloudSectionView};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::discord::{DiscordMemory, discord_view};
use videorc_app_core::livestream::ready::ReadyView;
use videorc_app_core::livestream::setup::{
    self as setup, DestinationView, PageMemory, SetupInput, SetupView, Tone,
};
use videorc_app_core::livestream::targets::TargetPatch;
use videorc_app_core::studio::chat_commands_store::ChatCommandsStore;
use videorc_app_core::studio::scheduled::ScheduledState;
use videorc_app_core::studio::stream_report_store::StreamReportStore;
use videorc_app_core::studio::watchdog_settings::WatchdogSettingsStore;
use videorc_app_core::{BackendClient, StopOrigin, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::DialogHandle;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::page_tabs::PageTabs;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

pub type AppStudio = Studio<BackendClient>;

/// `LIVESTREAM_SETUP_GRID`'s one breakpoint: two columns from 940 px of page.
const SETUP_SPLIT_MIN: f32 = 940.;
/// The shell's sidebar (`app/shell.rs`, L7's): a page is the window less it.
const SIDEBAR_WIDTH: f32 = 220.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DestinationsTab {
    Setup,
    Upcoming,
    Discord,
}

impl DestinationsTab {
    fn index(self) -> usize {
        match self {
            Self::Setup => 0,
            Self::Upcoming => 1,
            Self::Discord => 2,
        }
    }

    fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Upcoming,
            2 => Self::Discord,
            _ => Self::Setup,
        }
    }
}

fn badge_variant(tone: Tone) -> BadgeVariant {
    match tone {
        Tone::Success => BadgeVariant::Success,
        Tone::Warning => BadgeVariant::Warning,
        Tone::Destructive => BadgeVariant::Destructive,
        Tone::Live => BadgeVariant::Live,
        Tone::Outline => BadgeVariant::Outline,
    }
}

pub struct DestinationsPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    tab: DestinationsTab,
    memory: PageMemory,
    setup: SetupView,
    cloud: Option<CloudSectionView>,
    details: DetailsState,
    details_inputs: Option<details::DetailsInputs>,
    details_dirty: bool,
    chat_commands: ChatCommandsStore,
    command_editor: Option<chat_commands::CommandEditor>,
    watchdog: WatchdogSettingsStore,
    stream_report: StreamReportStore,
    ready: ReadyView,
    scheduled: ScheduledState,
    discord_memory: DiscordMemory,
    discord_paste: Option<Entity<InputState>>,
    /// Per-destination draft for the stream key field while expanded.
    manual_key_drafts: std::collections::BTreeMap<String, Entity<InputState>>,
    manual_url_drafts: std::collections::BTreeMap<String, Entity<InputState>>,
    /// P1493: keyring LinuxSetupAlert before sign-in (Linux only).
    keyring_issue: Option<videorc_app_core::studio::linux_desktop::LinuxSetupIssue>,
    youtube_consent: DialogHandle,
    youtube_consent_accepted: bool,
    /// Disconnect confirm (P720); platform while the dialog is open.
    disconnect_confirm: DialogHandle,
    disconnect_platform: Option<String>,
    category_picker: Option<category::CategoryPicker>,
    thumbnail_field: thumbnail::Field,
    schedule: Option<schedule::ScheduleEditor>,
}

impl DestinationsPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let setup = Self::build_setup(&studio, &PageMemory::default());
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            let mut platforms_rx = studio_watch.platforms();
            let mut telemetry_rx = studio_watch.telemetry();
            let mut go_live_rx = studio_watch.go_live();
            let mut cloud_rx = studio_watch.cloud();
            let mut details_rx = studio_watch.details();
            let mut chat_rx = studio_watch.chat_commands();
            let mut scheduled_rx = studio_watch.scheduled();
            let mut watchdog_rx = studio_watch.watchdog_settings();
            let mut stream_report_rx = studio_watch.stream_report();
            loop {
                tokio::select! {
                    changed = studio_rx.changed() => if changed.is_err() { break },
                    changed = platforms_rx.changed() => if changed.is_err() { break },
                    changed = telemetry_rx.changed() => if changed.is_err() { break },
                    changed = go_live_rx.changed() => if changed.is_err() { break },
                    changed = cloud_rx.changed() => if changed.is_err() { break },
                    changed = details_rx.changed() => if changed.is_err() { break },
                    changed = chat_rx.changed() => if changed.is_err() { break },
                    changed = scheduled_rx.changed() => if changed.is_err() { break },
                    changed = watchdog_rx.changed() => if changed.is_err() { break },
                    changed = stream_report_rx.changed() => if changed.is_err() { break },
                }
                let _ = this.update(cx, |panel, cx| {
                    panel.rebuild(cx);
                });
            }
        })
        .detach();
        // Keyring probe + diagnostics.linuxDesktop (P1489 / P1493).
        if cfg!(target_os = "linux") {
            let studio = studio.clone();
            let runtime = runtime.clone();
            cx.spawn(async move |this, cx| {
                let desktop = runtime
                    .spawn({
                        let studio = studio.clone();
                        async move {
                            studio
                                .backend()
                                .request("diagnostics.linuxDesktop", serde_json::Value::Null)
                                .await
                                .ok()
                        }
                    })
                    .await
                    .ok()
                    .flatten();
                let keyring = runtime
                    .spawn_blocking(crate::screens::linux_setup::probe_keyring_status)
                    .await
                    .ok()
                    .flatten();
                let issue = keyring.and_then(|keyring| {
                    crate::screens::linux_setup::keyring_setup_issue(&keyring, desktop.as_ref())
                });
                let _ = this.update(cx, |panel, cx| {
                    if panel.keyring_issue != issue {
                        panel.keyring_issue = issue;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        let mut panel = Self {
            studio,
            runtime,
            tab: DestinationsTab::Setup,
            memory: PageMemory::default(),
            setup,
            cloud: None,
            details: DetailsState::default(),
            details_inputs: None,
            details_dirty: false,
            chat_commands: ChatCommandsStore::default(),
            command_editor: None,
            watchdog: WatchdogSettingsStore::default(),
            stream_report: StreamReportStore::default(),
            ready: ReadyView {
                rows: Vec::new(),
                not_ready: Vec::new(),
                retry: false,
                warning: None,
            },
            scheduled: ScheduledState::default(),
            discord_memory: DiscordMemory::default(),
            discord_paste: None,
            manual_key_drafts: std::collections::BTreeMap::new(),
            manual_url_drafts: std::collections::BTreeMap::new(),
            keyring_issue: None,
            youtube_consent: DialogHandle::new(false),
            youtube_consent_accepted: false,
            disconnect_confirm: DialogHandle::new(false),
            disconnect_platform: None,
            category_picker: None,
            thumbnail_field: thumbnail::Field::default(),
            schedule: None,
        };
        panel.rebuild_from_studio();
        panel
    }

    fn build_setup(studio: &AppStudio, memory: &PageMemory) -> SetupView {
        let snapshot = studio.snapshot();
        let platforms = studio.platforms_now();
        let telemetry = studio.telemetry_now();
        let runtimes = setup::Runtime::read(&telemetry.stream_targets);
        let go_live = studio.go_live_now();
        setup::setup_view(
            &SetupInput {
                capture: &snapshot.settings.capture_doc,
                platforms: &platforms,
                runtimes: &runtimes,
                entitlements: None,
                session_active: snapshot.session.phase.is_active(),
                go_live_pending: go_live.open || go_live.pending,
                development: cfg!(debug_assertions),
            },
            memory,
        )
    }

    fn rebuild_from_studio(&mut self) {
        self.setup = Self::build_setup(&self.studio, &self.memory);
        let cloud = self.studio.cloud_now();
        self.cloud = cloud_view::section_view(
            cloud.status.as_ref(),
            self.studio.snapshot().session.phase.is_active(),
            self.studio.cloud_upload_plan().as_ref(),
        );
        self.details = self.studio.details_now();
        self.chat_commands = self.studio.chat_commands_now();
        self.watchdog = self.studio.watchdog_settings_now();
        self.stream_report = self.studio.stream_report_now();
        self.scheduled = self.studio.scheduled_now();
        self.ready = self.build_ready();
        let premium = Self::watchdog_premium(&self.studio);
        self.refresh_watchdog_phone_if_needed(premium);
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let before_setup = self.setup.clone();
        let before_cloud = self.cloud.clone();
        let before_details = self.details.clone();
        let before_chat = self.chat_commands.clone();
        let before_watchdog = self.watchdog.clone();
        let before_stream_report = self.stream_report.clone();
        let before_scheduled = self.scheduled.clone();
        let before_ready = self.ready.clone();
        self.rebuild_from_studio();
        if self.setup != before_setup
            || self.cloud != before_cloud
            || self.details != before_details
            || self.chat_commands != before_chat
            || self.watchdog != before_watchdog
            || self.stream_report != before_stream_report
            || self.scheduled != before_scheduled
            || self.ready != before_ready
        {
            cx.notify();
        }
    }

    fn set_tab(&mut self, tab: DestinationsTab, cx: &mut Context<Self>) {
        if self.tab != tab {
            self.tab = tab;
            if tab == DestinationsTab::Upcoming {
                let studio = self.studio.clone();
                self.runtime.spawn(async move {
                    studio.scheduled_focus().await;
                });
            }
            cx.notify();
        }
    }

    fn toggle_expanded(&mut self, id: String, cx: &mut Context<Self>) {
        let open = !self
            .setup
            .destinations
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.expanded)
            .unwrap_or(false);
        self.memory.expanded.insert(id, open);
        self.rebuild(cx);
    }

    fn set_enabled(&mut self, id: String, enabled: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(&id, TargetPatch::default().set("enabled", json!(enabled)))
                .await;
        });
        self.rebuild(cx);
    }

    fn dismiss_failure(&mut self, key: String, cx: &mut Context<Self>) {
        self.memory.dismissed_problems = Some(key);
        self.rebuild(cx);
    }

    /// Failure banner "End livestream" (P686): same stop path as Studio.
    fn end_livestream(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.request_stop(StopOrigin::Button).await;
        });
    }

    fn use_instant(&mut self, target_id: String, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(
                    &target_id,
                    TargetPatch::default().set("scheduledEventId", json!(null)),
                )
                .await;
        });
        self.rebuild(cx);
    }

    fn set_destination_quality(&self, id: String, preset: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(&id, TargetPatch::quality(&preset))
                .await;
        });
    }

    fn set_auth_mode(&self, id: String, mode: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(&id, TargetPatch::default().set("authMode", json!(mode)))
                .await;
        });
    }

    fn set_url_mode(&self, id: String, full_url: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(
                    &id,
                    TargetPatch::default().set(
                        "urlMode",
                        json!(if full_url {
                            "full-url"
                        } else {
                            "server-and-key"
                        }),
                    ),
                )
                .await;
        });
    }

    fn save_manual_url(&self, id: String, url: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(&id, TargetPatch::default().set("serverUrl", json!(url)))
                .await;
        });
    }

    fn save_manual_key(&self, id: String, key: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.save_manual_stream_key(&id, &key).await;
        });
    }

    fn restore_manual_key(&self, id: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.restore_previous_stream_key(&id).await;
        });
    }

    fn ensure_manual_inputs(
        &mut self,
        dest: &DestinationView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(manual) = &dest.manual {
            if !self.manual_url_drafts.contains_key(&dest.id) {
                let value = manual.server_value.clone();
                let input = cx.new(|cx| {
                    let mut state = InputState::new(window, cx);
                    state.set_value(value, window, cx);
                    state
                });
                self.manual_url_drafts.insert(dest.id.clone(), input);
            }
            if !self.manual_key_drafts.contains_key(&dest.id) {
                let value = manual.key_value.clone();
                let input = cx.new(|cx| {
                    let mut state = InputState::new(window, cx);
                    state.set_value(value, window, cx);
                    state
                });
                self.manual_key_drafts.insert(dest.id.clone(), input);
            }
        }
    }

    fn sign_in_pending(
        &self,
        dest_id: &str,
        platform: &str,
        pending: &setup::PendingView,
        t: &videorc_kit::tokens::Theme,
        entity: &Entity<Self>,
    ) -> gpui::AnyElement {
        let platform = platform.to_string();
        let row = div().flex().flex_col().gap(px(6.)).child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(if pending.has_url {
                    page_copy::WAITING_FOR_BROWSER.to_string()
                } else {
                    pending.other_browser.clone()
                }),
        );
        let mut actions = div().flex().items_center().gap(px(8.));
        if pending.has_url {
            actions = actions.child(
                Button::new(format!("dest-copy-link-{}", dest_id))
                    .label(pending.copy_label.clone())
                    .variant(ButtonVariant::Outline)
                    .on_click({
                        let entity = entity.clone();
                        let platform = platform.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.copy_sign_in_link(&platform, cx);
                            });
                        }
                    }),
            );
        }
        actions = actions.child(
            Button::new(format!("dest-cancel-sign-in-{}", dest_id))
                .label(page_copy::CANCEL)
                .variant(ButtonVariant::Ghost)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.cancel_sign_in(&platform, cx);
                        });
                    }
                }),
        );
        row.child(actions).into_any_element()
    }

    fn destination_card(
        &mut self,
        dest: &DestinationView,
        t: &videorc_kit::tokens::Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if dest.expanded {
            self.ensure_manual_inputs(dest, window, cx);
        }
        let id = dest.id.clone();
        let enabled = dest.enabled;
        let switch_enabled = dest.switch_enabled && !dest.disabled;
        let entity = cx.entity();
        let mut trailing = div().flex().items_center().gap(px(8.));
        if let Some((tone, label)) = &dest.badge {
            trailing = trailing.child(Badge::new(label.clone()).variant(badge_variant(*tone)));
        }
        if dest.falling_behind {
            trailing = trailing
                .child(Badge::new(page_copy::FALLING_BEHIND).variant(BadgeVariant::Warning));
        }
        if let Some(tag) = &dest.quality_tag {
            trailing = trailing.child(Badge::new(tag.clone()).variant(BadgeVariant::Outline));
        }
        // `destination-controls`: the switch and the chevron, 12 px apart.
        let controls = div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                Switch::new(format!("dest-enable-{}", dest.id))
                    .accessibility_label(dest.switch_label.clone())
                    .checked(enabled)
                    .disabled(!switch_enabled)
                    .on_change({
                        let entity = entity.clone();
                        let id = id.clone();
                        move |value, _, cx| {
                            entity.update(cx, |this, cx| this.set_enabled(id.clone(), value, cx))
                        }
                    }),
            )
            // `ChevronDownIcon` (14 px), turned over while open.
            .child(icon(
                if dest.expanded {
                    IconName::CaretUp
                } else {
                    IconName::CaretDown
                },
                14.0,
                hsla(t.muted_foreground),
            ));
        trailing = trailing.child(controls);

        let mut card = div().child(
            ListRow::new(format!("dest-{}", dest.id), dest.label.clone())
                .icon(crate::screens::platform_glyph(&dest.platform))
                .context(dest.context.clone())
                .interactive(true)
                .child(trailing)
                .on_click({
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| this.toggle_expanded(id.clone(), cx))
                    }
                }),
        );

        let mut detail = div().flex().flex_col().gap(px(4.)).px(px(12.)).pb(px(8.));
        let mut has_detail = false;
        if let Some(message) = &dest.status_message {
            has_detail = true;
            detail = detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(message.clone()),
            );
        }
        if let Some(line) = &dest.uplink_line {
            has_detail = true;
            detail = detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.warning))
                    .child(line.clone()),
            );
        }
        if !dest.switch_reason.is_empty() && !dest.switch_enabled {
            has_detail = true;
            detail = detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(dest.switch_reason.clone()),
            );
        }
        if dest.expanded {
            has_detail = true;
            if let Some(reason) = &dest.lock_reason {
                detail = detail.child(
                    Alert::new(format!("dest-lock-{}", dest.id))
                        .variant(AlertVariant::Warning)
                        .title(reason.clone()),
                );
            }
            if let Some(line) = &dest.key_only_line {
                detail = detail.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(line.clone()),
                );
            }
            if let Some(quota) = &dest.quota_paused {
                detail = detail.child(
                    Alert::new(format!("dest-quota-{}", dest.id))
                        .variant(AlertVariant::Warning)
                        .title(quota.clone()),
                );
            }
            if let Some((guidance, link)) = &dest.guidance {
                detail = detail.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(guidance.clone()),
                );
                if let Some(link) = link {
                    let url = link.url.clone();
                    detail = detail.child(
                        Button::new(format!("dest-guide-{}", dest.id))
                            .label(link.label.clone())
                            .variant(ButtonVariant::Ghost)
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
            }
            if let Some((labels, selected)) = &dest.auth_mode {
                let mut control = SegmentedControl::new(format!("dest-auth-{}", dest.id))
                    .small(true)
                    .accessibility_label(page_copy::CONNECT_WITH)
                    .disabled(dest.disabled)
                    .value(
                        labels
                            .get(*selected as usize)
                            .cloned()
                            .map(SharedString::from),
                    )
                    .on_change({
                        let entity = entity.clone();
                        let id = id.clone();
                        move |value, _, cx| {
                            let mode = if value.as_ref().contains("Sign in") {
                                "oauth"
                            } else {
                                "manual-rtmp"
                            };
                            entity.update(cx, |this, _| {
                                this.set_auth_mode(id.clone(), mode.to_string())
                            });
                        }
                    });
                for label in labels {
                    control = control.option(Segment::new(label.clone(), label.clone()));
                }
                detail = detail.child(
                    SettingsRow::new(
                        format!("dest-auth-row-{}", dest.id),
                        page_copy::CONNECT_WITH,
                    )
                    .child(control),
                );
            }
            if dest.quality.options.len() > 1 {
                let quality = dest.quality.clone();
                let dest_id = dest.id.clone();
                detail = detail.child(
                    SettingsRow::new(
                        format!("dest-quality-{}", dest.id),
                        page_copy::OUTPUT_QUALITY,
                    )
                    .description(quality.description.clone())
                    .child(quality::quality_control(
                        format!("dest-quality-control-{}", dest.id),
                        &quality,
                        dest.disabled,
                        {
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |this, _| {
                                    this.set_destination_quality(dest_id.clone(), value.to_string())
                                })
                            }
                        },
                    )),
                );
            }
            if let Some(oauth) = &dest.oauth {
                match oauth {
                    setup::OAuthView::Account(account) => {
                        let platform = dest.platform.clone();
                        let mut row = div().flex().items_center().gap(px(8.)).child(
                            Badge::new(if account.reconnect {
                                page_copy::NEEDS_RECONNECT
                            } else {
                                page_copy::CONNECTED
                            })
                            .variant(if account.reconnect {
                                BadgeVariant::Warning
                            } else {
                                BadgeVariant::Success
                            }),
                        );
                        row = row.child(div().type_scale(text::META).child(account.label.clone()));
                        if account.reconnect {
                            let platform = platform.clone();
                            row = row.child(
                                Button::new(format!("dest-reconnect-{}", dest.id))
                                    .label(page_copy::RECONNECT)
                                    .variant(ButtonVariant::Outline)
                                    .disabled(dest.disabled)
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, window, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.begin_connect(platform.clone(), window, cx);
                                            });
                                        }
                                    }),
                            );
                        }
                        if account.can_disconnect {
                            let platform = platform.clone();
                            row = row.child(
                                Button::new(format!("dest-disconnect-{}", dest.id))
                                    .label(page_copy::DISCONNECT)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(dest.disabled)
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, window, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.ask_disconnect(platform.clone(), window, cx);
                                            });
                                        }
                                    }),
                            );
                        }
                        detail = detail.child(row);
                        if !account.handle.is_empty() {
                            detail = detail.child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(account.handle.clone()),
                            );
                        }
                        if account.reconnect && !account.validation_message.is_empty() {
                            detail = detail.child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(page_copy::LOST_ACCESS),
                            );
                        }
                        if let Some(line) = &account.shared_line {
                            detail = detail.child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(line.clone()),
                            );
                        }
                        if let Some((message, action)) = &account.permissions {
                            let platform = platform.clone();
                            detail = detail.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .type_scale(text::META)
                                            .text_color(hsla(t.muted_foreground))
                                            .child(message.clone()),
                                    )
                                    .child(
                                        Button::new(format!("dest-permissions-{}", dest.id))
                                            .label(action.clone())
                                            .variant(ButtonVariant::Outline)
                                            .disabled(dest.disabled)
                                            .on_click({
                                                let entity = entity.clone();
                                                move |_, window, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        this.begin_connect(
                                                            platform.clone(),
                                                            window,
                                                            cx,
                                                        );
                                                    });
                                                }
                                            }),
                                    ),
                            );
                        }
                        if let Some(pending) = &account.pending {
                            detail = detail.child(
                                self.sign_in_pending(&dest.id, &platform, pending, t, &entity),
                            );
                        }
                        if let Some(channel) = &account.channel {
                            detail = detail.child(self.channel_row(
                                &dest.id,
                                channel,
                                dest.disabled,
                                cx,
                            ));
                        }
                        if let Some(x_live) = &account.x_live {
                            detail = detail.child(self.x_live_block(
                                &dest.id,
                                x_live,
                                dest.disabled,
                                t,
                                cx,
                            ));
                        }
                    }
                    setup::OAuthView::SignIn {
                        connect_label,
                        connect_enabled,
                        pending,
                        ..
                    } => {
                        let platform = dest.platform.clone();
                        if let Some(pending) = pending {
                            detail = detail.child(
                                self.sign_in_pending(&dest.id, &platform, pending, t, &entity),
                            );
                        } else {
                            detail = detail.child(
                                Button::new(format!("dest-connect-{}", dest.id))
                                    .label(connect_label.clone())
                                    .variant(ButtonVariant::Outline)
                                    .disabled(!*connect_enabled || dest.disabled)
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, window, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.begin_connect(platform.clone(), window, cx);
                                            });
                                        }
                                    }),
                            );
                        }
                    }
                }
            }
            if let Some(manual) = &dest.manual {
                if let Some(mode) = dest.url_mode {
                    detail = detail.child(
                        SettingsRow::new(format!("dest-url-mode-{}", dest.id), page_copy::URL_MODE)
                            .child(
                                SegmentedControl::new(format!("dest-url-mode-control-{}", dest.id))
                                    .small(true)
                                    .accessibility_label(page_copy::URL_MODE)
                                    .disabled(dest.disabled)
                                    .value(Some(SharedString::from(if mode == 1 {
                                        "full"
                                    } else {
                                        "server"
                                    })))
                                    .option(Segment::new(
                                        "server",
                                        page_copy::URL_MODE_SERVER_AND_KEY,
                                    ))
                                    .option(Segment::new("full", page_copy::URL_MODE_FULL_URL))
                                    .on_change({
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        move |value, _, cx| {
                                            entity.update(cx, |this, _| {
                                                this.set_url_mode(
                                                    id.clone(),
                                                    value.as_ref() == "full",
                                                )
                                            })
                                        }
                                    }),
                            ),
                    );
                }
                if let Some(url_input) = self.manual_url_drafts.get(&dest.id) {
                    detail = detail.child(
                        SettingsGroup::new().row(
                            SettingsRow::new(
                                format!("dest-server-{}", dest.id),
                                manual.server_label.clone(),
                            )
                            .description(manual.server_description.clone().unwrap_or_default())
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        Input::new(
                                            format!("dest-server-input-{}", dest.id),
                                            url_input,
                                        )
                                        .accessibility_label(manual.server_label.clone())
                                        .disabled(dest.disabled)
                                        .invalid(manual.server_issue.is_some()),
                                    )
                                    .when(manual.save_url, |row| {
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        let url_input = url_input.clone();
                                        row.child(
                                            Button::new(format!("dest-save-url-{}", dest.id))
                                                .label(page_copy::SAVE_URL)
                                                .variant(ButtonVariant::Outline)
                                                .disabled(dest.disabled)
                                                .on_click(move |_, _, cx| {
                                                    let url =
                                                        url_input.read(cx).value().to_string();
                                                    entity.update(cx, |this, _| {
                                                        this.save_manual_url(id.clone(), url)
                                                    })
                                                }),
                                        )
                                    }),
                            ),
                        ),
                    );
                    if let Some(issue) = &manual.server_issue {
                        detail = detail.child(
                            div()
                                .type_scale(text::META)
                                .text_color(hsla(t.destructive))
                                .child(issue.clone()),
                        );
                    }
                }
                if let Some(key_input) = self.manual_key_drafts.get(&dest.id) {
                    detail = detail.child(
                        SettingsGroup::new().row(
                            SettingsRow::new(
                                format!("dest-key-{}", dest.id),
                                page_copy::ROW_STREAM_KEY,
                            )
                            .description(manual.key_description.clone().unwrap_or_default())
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        Input::new(
                                            format!("dest-key-input-{}", dest.id),
                                            key_input,
                                        )
                                        .accessibility_label(manual.key_placeholder.clone())
                                        .disabled(dest.disabled),
                                    )
                                    .when(manual.save_key, |row| {
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        let key_input = key_input.clone();
                                        row.child(
                                            Button::new(format!("dest-save-key-{}", dest.id))
                                                .label(page_copy::SAVE_KEY)
                                                .variant(ButtonVariant::Outline)
                                                .disabled(dest.disabled)
                                                .on_click(move |_, _, cx| {
                                                    let key =
                                                        key_input.read(cx).value().to_string();
                                                    entity.update(cx, |this, _| {
                                                        this.save_manual_key(id.clone(), key)
                                                    })
                                                }),
                                        )
                                    }),
                            ),
                        ),
                    );
                    if let Some(restore) = &manual.restore {
                        let entity = entity.clone();
                        let id = id.clone();
                        detail = detail.child(
                            Button::new(format!("dest-restore-key-{}", dest.id))
                                .label(restore.clone())
                                .variant(ButtonVariant::Ghost)
                                .disabled(dest.disabled)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |this, _| this.restore_manual_key(id.clone()))
                                }),
                        );
                    }
                }
            }
        }
        if has_detail {
            card = card.child(detail);
        }
        card
    }
}

impl Render for DestinationsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Escape can close the kit handle before Cancel's owner cleanup runs.
        if self.schedule.as_ref().is_some_and(|e| !e.dialog.is_open()) {
            self.schedule = None;
        }
        self.ensure_details_inputs(window, cx);
        self.ensure_command_editor(window, cx);
        self.ensure_discord_paste(window, cx);
        let details = self.details.clone();
        self.sync_details_inputs(&details, window, cx);

        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let tabs = PageTabs::new("destinations-views", page_copy::VIEWS_LABEL)
            .tab(page_copy::VIEW_SETUP)
            .tab(page_copy::VIEW_UPCOMING)
            .tab(page_copy::VIEW_DISCORD)
            .selected(self.tab.index())
            .on_select(move |index, _, cx| {
                entity.update(cx, |this, cx| {
                    this.set_tab(DestinationsTab::from_index(index), cx)
                });
            });

        let body = match self.tab {
            DestinationsTab::Setup => {
                let setup = self.setup.clone();
                let has_notices = self.keyring_issue.is_some()
                    || setup.notices.entitlement.is_some()
                    || setup.notices.session_lock.is_some()
                    || setup.notices.failure.is_some()
                    || !setup.notices.scheduled.is_empty()
                    || setup.cap_notice.is_some();
                let mut notices = div().flex().flex_col().gap(px(8.));
                if let Some(issue) = &self.keyring_issue {
                    notices = notices.child(crate::screens::linux_setup::linux_setup_alert(issue));
                }
                if let Some((reason, action)) = &setup.notices.entitlement {
                    let mut alert = Alert::new("dest-entitlement")
                        .variant(AlertVariant::Locked)
                        .title(reason.clone());
                    if action.as_deref() == Some(page_copy::VIEW_PREMIUM) {
                        alert = alert.action(
                            Button::new("view-premium")
                                .label(page_copy::VIEW_PREMIUM)
                                .variant(ButtonVariant::Outline)
                                .on_click(|_, _, cx| cx.open_url("https://videorc.com/account")),
                        );
                    }
                    notices = notices.child(alert);
                }
                if let Some(lock) = &setup.notices.session_lock {
                    notices = notices.child(
                        Alert::new("dest-session-lock")
                            .variant(AlertVariant::Locked)
                            .title(lock.clone()),
                    );
                }
                if let Some(failure) = &setup.notices.failure {
                    let key = failure.key.clone();
                    let entity = cx.entity();
                    notices = notices.child(
                        Alert::new("dest-failure")
                            .variant(AlertVariant::Destructive)
                            .title(page_copy::FAILURE_TITLE)
                            .description(failure.lines.join("\n"))
                            .action(
                                Button::new("dest-end-live")
                                    .label(page_copy::END_LIVESTREAM)
                                    .variant(ButtonVariant::Destructive)
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |this, _| this.end_livestream());
                                        }
                                    }),
                            )
                            .action(
                                Button::new("dest-continue")
                                    .label(page_copy::CONTINUE_STREAMING)
                                    .variant(ButtonVariant::Outline)
                                    .on_click(move |_, _, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.dismiss_failure(key.clone(), cx)
                                        })
                                    }),
                            ),
                    );
                }
                for (target_id, line) in &setup.notices.scheduled {
                    let id = target_id.clone();
                    let entity = cx.entity();
                    let mut alert = Alert::new(format!("dest-scheduled-{target_id}"))
                        .variant(AlertVariant::Warning)
                        .title(line.clone());
                    if setup.notices.scheduled_enabled {
                        alert = alert.action(
                            Button::new(format!("instant-{target_id}"))
                                .label(page_copy::USE_INSTANT_BROADCAST)
                                .variant(ButtonVariant::Outline)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |this, cx| this.use_instant(id.clone(), cx))
                                }),
                        );
                    }
                    notices = notices.child(alert);
                }
                if let Some(cap) = &setup.cap_notice {
                    notices = notices.child(
                        Alert::new("dest-cap")
                            .variant(AlertVariant::Warning)
                            .title(cap.clone()),
                    );
                }

                let destinations: Vec<DestinationView> = setup.destinations.clone();
                let mut list = GroupedList::new();
                for dest in &destinations {
                    list = list.item(self.destination_card(dest, t, window, cx));
                }

                // `LIVESTREAM_SETUP_GRID`: the lead column (notices,
                // destinations, stream details, chat commands) and the trail
                // (`GoLivePanel`: output quality, cloud, watchdog, after the
                // stream, ready), side by side from 940 px of page with a
                // hairline between, stacked under a hairline below that.
                // Sections are flush: each carries its own gutter.
                let mut lead = div().flex().flex_col().min_w(px(0.));
                if has_notices {
                    lead = lead.child(
                        notices
                            .p(px(size::GUTTER))
                            .border_b_1()
                            .border_color(hsla(t.border)),
                    );
                }
                let lead = lead
                    .child(
                        PanelSection::new("destinations-list")
                            .title(page_copy::DESTINATIONS)
                            .description(setup.destinations_description.clone())
                            .child(list),
                    )
                    .child(self.details_section(&details, setup.controls_disabled, window, cx))
                    .child(self.chat_commands_section(&self.chat_commands.clone(), window, cx));
                let mut trail = div()
                    .flex()
                    .flex_col()
                    .min_w(px(0.))
                    .child(self.quality_section(window, cx));
                if let Some(cloud) = self.cloud.clone() {
                    trail = trail.child(self.cloud_section(&cloud, window, cx));
                }
                let premium = Self::watchdog_premium(&self.studio);
                if let Some(watchdog) = Self::watchdog_view(&self.watchdog, premium) {
                    trail = trail.child(self.watchdog_section(&watchdog, window, cx));
                }
                let report = Self::stream_report_view(&self.stream_report);
                let trail = trail
                    .child(self.stream_report_section(&report, window, cx))
                    .child(self.ready_section(&self.ready.clone(), window, cx));
                let page_width = window.viewport_size().width - px(SIDEBAR_WIDTH);
                if page_width >= px(SETUP_SPLIT_MIN) {
                    div()
                        .flex()
                        .w_full()
                        .child(
                            lead.w(relative(0.6))
                                .border_r_1()
                                .border_color(hsla(t.border)),
                        )
                        .child(trail.w(relative(0.4)))
                        .into_any_element()
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .w_full()
                        .child(lead)
                        .child(trail.border_t_1().border_color(hsla(t.border)))
                        .into_any_element()
                }
            }
            // Upcoming and Discord keep the gutter they had (not in this
            // design pass).
            DestinationsTab::Upcoming => div()
                .p(px(size::GUTTER))
                .child(self.upcoming_body(&self.scheduled.clone(), window, cx))
                .into_any_element(),
            DestinationsTab::Discord => {
                let details = self.studio.details_now();
                let now_ms = chrono::Utc::now().timestamp_millis();
                let view = discord_view(
                    details.discord.as_ref(),
                    details.discord_preview.as_ref(),
                    details.discord_error.as_deref(),
                    &self.discord_memory,
                    now_ms,
                );
                div()
                    .p(px(size::GUTTER))
                    .child(self.discord_body(&view, window, cx))
                    .into_any_element()
            }
        };

        let command_dialog = self.command_dialog_element(window, cx);
        let youtube_consent = self.youtube_consent_dialog(window, cx);
        let disconnect = self.disconnect_dialog(window, cx);
        let schedule = self.schedule_dialog(window, cx);

        div()
            .id("destinations-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            // `PageTabs`: the strip under the toolbar, and only the view
            // under it scrolls.
            .child(tabs.child(body))
            .child(command_dialog)
            .child(youtube_consent)
            .child(disconnect)
            .child(schedule)
    }
}
