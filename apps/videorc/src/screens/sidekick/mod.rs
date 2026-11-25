//! Sidekick ⌘9 (plan 260 Phase 3): Overview, Chat, Community, Voice,
//! Reports and Clean cut from `videorc_app_core::buddy` and
//! `stream_manager::buddy`, drawn with `videorc-kit`. Words match Electron's
//! `tabs/buddy-tab.tsx`.

mod chat;
mod clean_cut;
mod clean_cut_review;
mod community;
mod community_preview;
mod live;
mod overview;
mod reports;
mod voice;

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{AnyElement, Context, FontWeight, Hsla, SharedString, Window, div, prelude::*, px};
use serde_json::json;
use videorc_app_core::account::entitlements::{live_cohost_gate, read_snapshot};
use videorc_app_core::buddy::chat::{self as buddy_chat, RULES_MAX};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::{
    CLOUD_AI_KEEPS, CohostSettingsView, CohostState, cloud_ai_uses, command_availability_lines,
    listen_allowance_label,
};
use videorc_app_core::studio::families::{
    self, clean_cut_auto, write_ai_consent, write_clean_cut_auto,
};
use videorc_app_core::studio::ui_local::UiLocal;
use videorc_app_core::user_error::{
    Failure, UserErrorContext, UserErrorKind, toast_user_error, user_error_message,
};
use videorc_app_core::{BackendClient, BackendEvent, BackendState, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::DialogHandle;
use videorc_kit::page_tabs::PageTabs;
use videorc_kit::theme::{FONT, TypeScale, hsla};
use videorc_kit::toast::{ToastData, ToastKind};
use videorc_kit::tokens::{Theme, size, text};
use videorc_protocol::cohost::CohostAutoChat;
use videorc_protocol::{CleanCutJob, CleanCutMode};

use chat::{ChatWidgets, render_chat};
use clean_cut::CleanCutState;
pub use clean_cut::OpenLibrarySession;
use community::{CommunityState, LinkSuggestion, PersonDetail, PersonRow, render_community};
use live::{LiveInput, LiveView, Unlock, UnlockAction, live_view};
use overview::{OverviewState, render_overview};
use reports::{ReportsState, render_reports};
use videorc_app_core::buddy::community::CommunitySummary;
use voice::{remove_messages_rows, render_voice};

pub type AppStudio = Studio<BackendClient>;

/// The events the page follows; `main.rs` adds them to the client's filter
/// (the backend drops the rest). `cohost.settings.changed` and
/// `account.changed` come with Avatar's and Settings' lists.
pub const EVENTS: [&str; 5] = [
    "cohost.state",
    "cleanCut.status",
    "cohost.report.saved",
    "cohost.community.changed",
    ENTITLEMENTS_UPDATED,
];
/// Premium changed (a purchase, a refresh): the locks read again.
const ENTITLEMENTS_UPDATED: &str = "entitlements.updated";

/// `PAGE_WIDE_MIN_PX` (`lib/page-layout.ts`): from this much page width a
/// config grid puts its two sections side by side (`@min-[940px]/page`).
const PAGE_WIDE_MIN: f32 = 940.;

/// `ConfigGrid` with `CONFIG_GRID_PAIR` (`components/page.tsx`): two flush
/// columns from 940 px of page that fill the visible height, so the column
/// hairline runs the full height however short the tab is; stacked below
/// that, in the same order. A column's last section passes
/// `PanelSection::last(wide)` for the lead (`[&>*]:border-b-0`; stacked, its
/// hairline splits the two) and `last(true)` for the trail.
pub(crate) fn config_grid_pair(
    lead: impl IntoElement,
    trail: impl IntoElement,
    wide: bool,
    border: Hsla,
) -> gpui::Div {
    if wide {
        div()
            .flex()
            .flex_1()
            .w_full()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .border_r_1()
                    .border_color(border)
                    .child(lead),
            )
            .child(div().flex().flex_col().flex_1().min_w_0().child(trail))
    } else {
        div().flex().flex_col().w_full().child(lead).child(trail)
    }
}

/// A tab's lead strip (`border-b border-border p-gutter`, `gap-2`): the
/// locked reason and any notes above the grid.
pub(crate) fn tab_lead(border: Hsla) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .p(px(size::GUTTER))
        .border_b_1()
        .border_color(border)
}

/// `LockAlert` with `lockAlertAction(view.unlock.action)`: why Sidekick is
/// locked, in the locked tone, and its one way out (Sign in or View
/// Premium).
pub(crate) fn unlock_alert(
    id: &'static str,
    action_id: &'static str,
    unlock: &Unlock,
    reason: impl Into<SharedString>,
) -> Alert {
    let mut alert = Alert::new(id).variant(AlertVariant::Locked).title(reason);
    if let Some(action) = unlock.action {
        let label = match action {
            UnlockAction::SignIn => words::SIGN_IN,
            UnlockAction::ViewPremium => words::VIEW_PREMIUM,
        };
        alert = alert.action(
            Button::new(action_id)
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(label)
                .on_click(move |_, _, cx| match action {
                    UnlockAction::SignIn => crate::app::accounts::sign_in(cx),
                    UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                }),
        );
    }
    alert
}

/// `FieldLabel`: 14 px / 500 in primary text.
fn field_label(label: SharedString, t: &Theme) -> gpui::Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(t.foreground))
        .child(label)
}

/// `FieldDescription`: 12 px secondary text at `leading-normal` (18 px), so
/// a wrapped description reads as Electron's.
pub(crate) fn field_description(description: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    let description: SharedString = description.into();
    div()
        .text_size(px(12.))
        .line_height(px(18.))
        .text_color(hsla(t.muted_foreground))
        .child(description)
}

/// A Field's words beside its control: `FieldLabel` over a
/// `FieldDescription`, `gap-0.5`.
pub(crate) fn field_text(
    label: impl Into<SharedString>,
    description: Option<SharedString>,
    t: &Theme,
) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .gap(px(2.))
        .child(field_label(label.into(), t))
        .children(description.map(|description| field_description(description, t)))
}

/// The same words with a plain `text-xs` line under the label (16 px line
/// height), as the listening and wake-word fields write theirs.
pub(crate) fn field_text_xs(
    label: impl Into<SharedString>,
    description: impl Into<SharedString>,
    t: &Theme,
) -> gpui::Div {
    let description: SharedString = description.into();
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .gap(px(2.))
        .child(field_label(label.into(), t))
        .child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(description),
        )
}

/// A vertical `Field` (`flex-col gap-3`): the label, its description, then
/// `rest` (the control and anything after it). The description pulls up
/// 4 px when it is the second-to-last child (`nth-last-2:-mt-1`), so the
/// words sit 8 px apart over a lone control and 12 px over more.
pub(crate) fn field_stack(
    label: impl Into<SharedString>,
    description: impl Into<SharedString>,
    rest: Vec<AnyElement>,
    t: &Theme,
) -> gpui::Div {
    let description_gap = if rest.len() == 1 { 8. } else { 12. };
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .child(field_label(label.into(), t))
        .child(field_description(description, t).mt(px(description_gap)))
        .children(rest.into_iter().map(|child| div().mt(px(12.)).child(child)))
}

/// `FieldError`: a failed save under its card, monochrome text after the
/// destructive icon.
pub(crate) fn save_error_line(message: Option<&str>, t: &Theme) -> Option<gpui::Div> {
    message.map(|message| {
        div()
            .flex()
            .items_start()
            .gap(px(6.))
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(hsla(t.foreground))
            .child(videorc_kit::icon::icon(
                videorc_kit::icon::IconName::XCircleFill,
                14.,
                hsla(t.destructive),
            ))
            .child(div().min_w_0().child(message.to_string()))
    })
}

/// A Field whose control sits beside its words (`flex items-center
/// justify-between gap-3`).
pub(crate) fn field_beside(head: gpui::Div, control: impl IntoElement) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .child(div().flex_1().min_w_0().child(head))
        .child(control)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Overview,
    Chat,
    Community,
    Voice,
    Reports,
    CleanCut,
}

impl Tab {
    fn id(self) -> &'static str {
        match self {
            Self::Overview => "live",
            Self::Chat => "chat",
            Self::Community => "community",
            Self::Voice => "voice",
            Self::Reports => "reports",
            Self::CleanCut => "clean-cut",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Overview => 0,
            Self::Chat => 1,
            Self::Community => 2,
            Self::Voice => 3,
            Self::Reports => 4,
            Self::CleanCut => 5,
        }
    }

    fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Chat,
            2 => Self::Community,
            3 => Self::Voice,
            4 => Self::Reports,
            5 => Self::CleanCut,
            _ => Self::Overview,
        }
    }

    fn from_id(id: &str) -> Self {
        match id {
            "chat" => Self::Chat,
            "community" => Self::Community,
            "voice" => Self::Voice,
            "reports" => Self::Reports,
            "clean-cut" => Self::CleanCut,
            _ => Self::Overview,
        }
    }

    fn label(self) -> &'static str {
        words::tab_label(self.id())
    }
}

/// Where a failed settings save shows: under its section's card (Overview's
/// listening, Replies, Moderation), or as a toast (Voice).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveSection {
    Listen,
    Replies,
    Moderation,
    Voice,
}

const SAVE_SETTINGS: UserErrorContext = UserErrorContext {
    action: "save",
    object: "Sidekick settings",
};
const SAVE_VOICE_SETTING: UserErrorContext = UserErrorContext {
    action: "save",
    object: "the voice command setting",
};
const TURN_ON_LIVE: UserErrorContext = UserErrorContext {
    action: "turn on",
    object: "Sidekick Live",
};
const TURN_OFF_LIVE: UserErrorContext = UserErrorContext {
    action: "turn off",
    object: "Sidekick Live",
};

pub struct SidekickScreen {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    local_dir: PathBuf,
    /// The backend's bootstrap, for the single-use file capabilities
    /// Community's Export… and Import… hand the backend.
    backend_state: tokio::sync::watch::Receiver<BackendState>,
    tab: Tab,
    settings: Option<CohostSettingsView>,
    state: CohostState,
    signed_in: bool,
    entitled: bool,
    consented: bool,
    live: bool,
    consent: DialogHandle,
    pending_on: bool,
    /// A failed save, under the section it belongs to (`SaveError`).
    save_error: Option<(SaveSection, String)>,
    chat: Option<ChatWidgets>,
    community: Option<CommunityState>,
    reports: Option<ReportsState>,
    clean_cut: Option<CleanCutState>,
    /// The shell has Sidekick on screen (Community's living preview ticks).
    page_shown: bool,
    /// The page's measured width: two columns from [`PAGE_WIDE_MIN`]. It
    /// starts wide, as the default window is, so the first frame doesn't flip.
    page_width: f32,
}

impl SidekickScreen {
    /// Why Sidekick isn't running (`cohost.state`'s reason), for the
    /// account row's needs-sign-in dot (P025).
    pub(crate) fn cohost_reason(&self) -> Option<&str> {
        self.state.reason.as_deref()
    }
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        local_dir: PathBuf,
        backend_state: tokio::sync::watch::Receiver<BackendState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let tab = Tab::from_id(UiLocal::in_dir(&local_dir).buddy_tab());
        let consented = studio.read_ui_settings(families::ai_consent);
        let mut screen = Self {
            studio: studio.clone(),
            runtime: runtime.clone(),
            local_dir,
            backend_state,
            tab,
            settings: None,
            state: CohostState::default(),
            signed_in: false,
            entitled: false,
            consented,
            live: false,
            consent: DialogHandle::new(false),
            pending_on: false,
            save_error: None,
            page_shown: false,
            page_width: PAGE_WIDE_MIN,
            chat: None,
            community: None,
            reports: None,
            clean_cut: None,
        };
        screen.refresh(cx);
        screen.watch(cx);
        screen
    }

    fn ensure_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.chat.is_none() {
            self.chat = Some(ChatWidgets::new(window, cx));
        }
        if let Some(widgets) = self.chat.as_ref() {
            widgets.sync_cooldowns(self.settings.as_ref(), window, cx);
        }
        self.sync_rule_inputs(window, cx);
    }

    fn ensure_clean_cut(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clean_cut.is_none() {
            self.clean_cut = Some(CleanCutState::new(&self.local_dir, window, cx));
        }
        if self.tab == Tab::CleanCut
            && let Some(clean) = self.clean_cut.as_ref()
            && !clean.loaded
        {
            self.refresh_clean_cut(cx);
        }
    }

    fn ensure_reports(&mut self, cx: &mut Context<Self>) {
        let reports = self.reports.get_or_insert_with(ReportsState::default);
        if self.tab == Tab::Reports && !reports.loaded && !reports.loading {
            self.refresh_reports(cx);
        }
    }

    fn ensure_community(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.community.is_none() {
            self.community = Some(CommunityState::new(window, cx));
        }
        if self.tab == Tab::Community {
            if let Some(community) = self.community.as_ref() {
                if !community.loaded {
                    self.refresh_community(cx);
                }
            }
        }
    }

    fn watch(&self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio.watch();
            let mut events = studio.backend().subscribe();
            loop {
                tokio::select! {
                    changed = studio_rx.changed() => {
                        if changed.is_err() { break; }
                        let _ = this.update(cx, |screen, cx| {
                            screen.live = studio_rx.borrow().session.phase.is_active();
                            screen.consented = studio.read_ui_settings(families::ai_consent);
                            cx.notify();
                        });
                    }
                    event = events.recv() => {
                        match event {
                            Ok(BackendEvent::Untyped { event, payload }) => {
                                let refresh = matches!(
                                    event.as_str(),
                                    "cohost.state"
                                        | "cohost.settings.changed"
                                        | "account.changed"
                                        | ENTITLEMENTS_UPDATED
                                );
                                if event == "cohost.state" {
                                    if let Ok(state) =
                                        serde_json::from_value::<CohostState>(payload.clone())
                                    {
                                        let _ = this.update(cx, |screen, cx| {
                                            screen.state = state;
                                            cx.notify();
                                        });
                                    }
                                }
                                if event == "cleanCut.status" {
                                    let job = serde_json::from_value::<CleanCutJob>(payload.clone()).ok();
                                    let _ = this.update(cx, |screen, cx| {
                                        if let Some(job) = job.as_ref() {
                                            screen.clean_cut_review_job(job, cx);
                                        }
                                        if let (Some(job), Some(clean)) = (job, screen.clean_cut.as_mut()) {
                                            // A finished cut adds its copy to the Library and
                                            // spends minutes: read both again.
                                            let finished = job.state == videorc_protocol::CleanCutJobState::Completed;
                                            clean.jobs = videorc_app_core::buddy::clean_cut_view::upsert_job(&clean.jobs, job);
                                            if finished {
                                                screen.refresh_clean_cut(cx);
                                            }
                                        }
                                        cx.notify();
                                    });
                                }
                                if event == "cohost.report.saved" {
                                    let _ = this.update(cx, |screen, cx| {
                                        if screen.tab == Tab::Reports {
                                            screen.refresh_reports(cx);
                                        } else if let Some(reports) = screen.reports.as_mut() {
                                            reports.loaded = false;
                                        }
                                    });
                                }
                                if event == "cohost.community.changed" {
                                    let summary = serde_json::from_value::<CommunitySummary>(
                                        payload.clone(),
                                    )
                                    .ok();
                                    let _ = this.update(cx, |screen, cx| {
                                        if let Some(community) = screen.community.as_mut() {
                                            if let Some(summary) = summary {
                                                community.summary = Some(summary);
                                            }
                                            community.loaded = false;
                                        }
                                        screen.refresh_community(cx);
                                    });
                                }
                                if refresh {
                                    let _ = this.update(cx, |screen, cx| screen.refresh(cx));
                                }
                            }
                            Ok(_) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                            Err(_) => break,
                        }
                    }
                }
            }
        })
        .detach();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let read = self.runtime.spawn(async move {
            let settings = backend
                .request("cohost.settings.get", json!({}))
                .await
                .ok()
                .and_then(|value| CohostSettingsView::from_json(&value));
            let account = backend.request("account.get", json!({})).await.ok();
            let signed_in = account
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(|status| status.as_str())
                == Some("signed-in");
            // Premium comes from `entitlements.get` (`liveCohostGate`):
            // `account.get` carries no entitlements.
            let entitlements = backend
                .request("entitlements.get", serde_json::Value::Null)
                .await
                .ok()
                .and_then(|value| read_snapshot(&value));
            let entitled = live_cohost_gate(entitlements.as_ref()).allowed();
            (settings, signed_in, entitled)
        });
        cx.spawn(async move |this, cx| {
            let Ok((settings, signed_in, entitled)) = read.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                screen.settings = settings;
                screen.signed_in = signed_in;
                screen.entitled = entitled;
                screen.live = screen.studio.snapshot().session.phase.is_active();
                screen.consented = screen.studio.read_ui_settings(families::ai_consent);
                cx.notify();
            });
        })
        .detach();
    }

    fn view(&self) -> LiveView {
        live_view(LiveInput {
            settings_known: self.settings.is_some(),
            enabled: self.settings.as_ref().map(|s| s.enabled).unwrap_or(false),
            signed_in: self.signed_in,
            entitled: self.entitled,
            consented: self.consented,
            live: self.live,
            state: Some(&self.state),
        })
    }

    /// The page's width, measured each frame; draws again only when the
    /// grids flip between one column and two.
    fn measured(&mut self, width: f32, cx: &mut Context<Self>) {
        let flips = (width >= PAGE_WIDE_MIN) != self.wide();
        self.page_width = width;
        if flips {
            cx.notify();
        }
    }

    /// Two columns (`@min-[940px]/page`).
    pub(crate) fn wide(&self) -> bool {
        self.page_width >= PAGE_WIDE_MIN
    }

    pub(crate) fn select_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        let tab = Tab::from_index(index);
        if self.tab == tab {
            return;
        }
        if self.tab == Tab::CleanCut {
            self.hide_clean_cut_review_player(cx);
        }
        self.tab = tab;
        let _ = UiLocal::in_dir(&self.local_dir).set_buddy_tab(tab.id());
        if tab == Tab::Community {
            self.refresh_community(cx);
        }
        if tab == Tab::Reports {
            self.refresh_reports(cx);
        }
        if tab == Tab::CleanCut {
            self.refresh_clean_cut(cx);
        }
        self.sync_community_preview_active(cx);
        cx.notify();
    }

    pub(crate) fn refresh_clean_cut(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            let jobs = backend
                .request("cleanCut.list", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<Vec<CleanCutJob>>(value).ok());
            let sessions = backend
                .request("sessions.list", json!({ "limit": 200 }))
                .await
                .ok()
                .and_then(|value| {
                    serde_json::from_value::<videorc_protocol::SessionListPage>(value).ok()
                })
                .map(|page| page.items);
            let capabilities = backend.request("ai.capabilities.get", json!({})).await.ok();
            let entitlements = backend
                .request("entitlements.get", serde_json::Value::Null)
                .await
                .ok()
                .and_then(|value| {
                    type Snapshot = videorc_protocol::EntitlementsSnapshot;
                    serde_json::from_value::<Snapshot>(value.clone())
                        .ok()
                        .or_else(|| {
                            serde_json::from_value::<Snapshot>(value["snapshot"].clone()).ok()
                        })
                });
            (jobs, sessions, capabilities, entitlements)
        });
        cx.spawn(async move |this, cx| {
            let Ok((jobs, sessions, capabilities, entitlements)) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(clean) = screen.clean_cut.as_mut() {
                    if let Some(jobs) = jobs {
                        clean.jobs = jobs;
                        clean.jobs_loaded = true;
                    }
                    if let Some(sessions) = sessions {
                        clean.sessions = sessions;
                    }
                    clean.capabilities =
                        videorc_app_core::buddy::clean_cut_view::clean_cut_capabilities(
                            capabilities.as_ref(),
                        );
                    if entitlements.is_some() {
                        clean.entitlements = entitlements;
                    }
                    clean.loaded = true;
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn set_clean_cut_auto(&mut self, on: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_clean_cut_auto(on)]).await });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    /// `cleanCut.start` with the consent the card holds and, for Condensed,
    /// the target length in seconds.
    pub(crate) fn start_clean_cut(
        &mut self,
        session_id: String,
        mode: CleanCutMode,
        target_minutes: u32,
        cx: &mut Context<Self>,
    ) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        clean.pending = true;
        let mut params = json!({
            "sessionId": session_id,
            "mode": mode,
            "consentToUploadAudio": true
        });
        if mode == CleanCutMode::Condensed {
            params["targetDurationSeconds"] = json!(
                videorc_app_core::buddy::clean_cut_view::condensed_target_seconds(target_minutes)
            );
        }
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cleanCut.start", params).await });
        cx.spawn(async move |this, cx| {
            let Ok(result) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(clean) = screen.clean_cut.as_mut() {
                    clean.pending = false;
                    if let Ok(value) = &result
                        && let Ok(started) = serde_json::from_value::<CleanCutJob>(value.clone())
                    {
                        clean.jobs = videorc_app_core::buddy::clean_cut_view::upsert_job(
                            &clean.jobs,
                            started,
                        );
                    }
                }
                if let Err(error) = &result {
                    screen.clean_cut_failed(
                        "clean-cut-start",
                        videorc_app_core::buddy::clean_cut_view::start_failed_title(mode),
                        error,
                    );
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn cancel_clean_cut(&mut self, job_id: String, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cleanCut.cancel", json!({ "jobId": job_id }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Ok(Err(error)) = &result {
                    screen.clean_cut_failed(
                        "clean-cut-cancel",
                        videorc_app_core::buddy::clean_cut_view::CANCEL_FAILED_TITLE,
                        error,
                    );
                }
                screen.refresh_clean_cut(cx);
            });
        })
        .detach();
    }

    pub(crate) fn refresh_community(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let (query, filter, sort) = self
            .community
            .as_ref()
            .map(|c| (c.search.read(cx).value().to_string(), c.filter, c.sort))
            .unwrap_or((String::new(), "regulars", "streams"));
        let query = query.trim().to_string();
        let job = self.runtime.spawn(async move {
            let summary = backend
                .request("cohost.community.summary", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<CommunitySummary>(value).ok());
            let mut list_params = json!({ "filter": filter, "sort": sort, "limit": 100 });
            if !query.is_empty() {
                list_params["query"] = json!(query);
            }
            let people = backend
                .request("cohost.community.list", list_params)
                .await
                .ok()
                .and_then(|value| value.get("people").cloned())
                .and_then(|value| serde_json::from_value::<Vec<PersonRow>>(value).ok())
                .unwrap_or_default();
            let suggestions = backend
                .request("cohost.community.suggestions", json!({}))
                .await
                .ok()
                .and_then(|value| value.get("suggestions").cloned().or(Some(value)))
                .and_then(|value| serde_json::from_value::<Vec<LinkSuggestion>>(value).ok())
                .unwrap_or_default();
            (summary, people, suggestions)
        });
        cx.spawn(async move |this, cx| {
            let Ok((summary, people, suggestions)) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.summary = summary;
                    community.people = people;
                    community.suggestions = suggestions;
                    community.loaded = true;
                }
                screen.load_community_avatars(cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn refresh_community_list(&mut self, cx: &mut Context<Self>) {
        self.refresh_community(cx);
    }

    pub(crate) fn refresh_community_link_hits(&mut self, cx: &mut Context<Self>) {
        let Some(community) = self.community.as_ref() else {
            return;
        };
        if !community.linking {
            return;
        }
        let backend = self.studio.backend().clone();
        let query = community.link_search.read(cx).value().to_string();
        let query = query.trim().to_string();
        if query.is_empty() {
            if let Some(community) = self.community.as_mut() {
                community.link_hits.clear();
            }
            cx.notify();
            return;
        }
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cohost.community.list",
                    json!({ "query": query, "filter": "everyone", "sort": "name", "limit": 20 }),
                )
                .await
                .ok()
                .and_then(|value| value.get("people").cloned())
                .and_then(|value| serde_json::from_value::<Vec<PersonRow>>(value).ok())
                .unwrap_or_default()
        });
        cx.spawn(async move |this, cx| {
            let Ok(hits) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.link_hits = hits;
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn select_community_person(
        &mut self,
        person_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let backend = self.studio.backend().clone();
        let asked = person_id.clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.community.person", json!({ "personId": person_id }))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<PersonDetail>(value).ok())
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(person) = job.await else {
                return;
            };
            let _ = this.update_in(cx, |screen, window, cx| {
                // A card opened on someone else since: this answer is stale.
                let current = screen
                    .community
                    .as_ref()
                    .and_then(|community| community.opening.as_ref())
                    .is_some_and(|(id, _)| *id == asked);
                if current {
                    screen.show_community_person(person, window, cx);
                }
            });
        })
        .detach();
    }

    pub(crate) fn community_toggle_bot(
        &mut self,
        person_id: String,
        is_bot: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let status = if is_bot { "normal" } else { "bot" };
        self.community_card_request(
            community::CardCall {
                method: "cohost.community.update",
                params: json!({ "personId": person_id, "status": status }),
                action: "update",
                object: None,
                then: community::CardThen::Person,
            },
            window,
            cx,
        );
    }

    pub(crate) fn ask_forget_person(
        &mut self,
        person_id: String,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(community) = self.community.as_mut() {
            community.forget_id = Some(person_id);
            community.forget_name = name;
            // The question stacks over the card (`Dialog::layer(1)`).
            community.forget.open(window, cx);
        }
        cx.notify();
    }

    pub(crate) fn confirm_forget_person(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(person_id) = self.community.as_ref().and_then(|c| c.forget_id.clone()) else {
            return;
        };
        if let Some(community) = self.community.as_mut() {
            community.forget.close(window, cx);
            community.forget_id = None;
            // The person is gone, so their card goes with the question.
            community.person.close(window, cx);
        }
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.community.forget", json!({ "personId": person_id }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.selected = None;
                }
                screen.refresh_community(cx);
            });
        })
        .detach();
    }

    pub(crate) fn community_forget_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(community) = self.community.as_mut() {
            community.forget_everyone.close(window, cx);
        }
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.community.forgetAll", json!({}))
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.selected = None;
                    community.people.clear();
                }
                screen.refresh_community(cx);
            });
        })
        .detach();
    }

    pub(crate) fn community_link(
        &mut self,
        person_id: String,
        other_person_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.community_card_request(
            community::CardCall {
                method: "cohost.community.link",
                params: json!({ "personId": person_id, "otherPersonId": other_person_id }),
                action: "link",
                object: None,
                then: community::CardThen::Person,
            },
            window,
            cx,
        );
    }

    pub(crate) fn community_accept_suggestion(
        &mut self,
        account_a: String,
        account_b: String,
        cx: &mut Context<Self>,
    ) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cohost.community.suggestion.accept",
                    json!({ "accountA": account_a, "accountB": account_b }),
                )
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |screen, cx| screen.refresh_community(cx));
        })
        .detach();
    }

    pub(crate) fn community_dismiss_suggestion(
        &mut self,
        account_a: String,
        account_b: String,
        cx: &mut Context<Self>,
    ) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cohost.community.suggestion.dismiss",
                    json!({ "accountA": account_a, "accountB": account_b }),
                )
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |screen, cx| screen.refresh_community(cx));
        })
        .detach();
    }

    pub(crate) fn set_live(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on && !self.consented {
            self.pending_on = true;
            self.consent.open(window, cx);
            cx.notify();
            return;
        }
        self.apply_live(on, false, cx);
    }

    pub(crate) fn answer_consent(
        &mut self,
        accept: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.consent.close(window, cx);
        let turn_on = self.pending_on;
        self.pending_on = false;
        if accept {
            self.consent_and_turn_on(turn_on, cx);
        }
        cx.notify();
    }

    /// `answerBuddyConsent(true)`: grants cloud AI, then turns Sidekick Live
    /// on when the switch asked. A failure is one toast with Retry.
    fn consent_and_turn_on(&mut self, turn_on: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_ai_consent(true)]).await });
        cx.spawn(async move |this, cx| {
            let answer = write.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(())) => {
                        screen.consented = true;
                        if turn_on {
                            screen.apply_live(true, true, cx);
                        }
                    }
                    Ok(Err(error)) => screen.consent_failed(&error, turn_on, cx),
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The consent dialog's failure: "Couldn't turn on Sidekick Live" with
    /// Retry (`BuddyTabConsentDialog`, id `buddy-live-consent`).
    fn consent_failed(
        &mut self,
        error: &videorc_app_core::client::RpcError,
        turn_on: bool,
        cx: &mut Context<Self>,
    ) {
        let copy = user_error_message(Failure::Rpc(error), Some(TURN_ON_LIVE));
        if copy.kind == UserErrorKind::Canceled {
            return;
        }
        let kind = if copy.warning {
            ToastKind::Warning
        } else {
            ToastKind::Error
        };
        let entity = cx.entity();
        let toast = ToastData::new(kind, copy.title)
            .description(copy.description)
            .action(words::RETRY, move |_, cx| {
                entity.update(cx, |screen, cx| screen.consent_and_turn_on(turn_on, cx));
            });
        let hub = cx
            .global::<crate::screens::notifications::Shared>()
            .0
            .clone();
        hub.update(cx, |hub, cx| {
            hub.press_toast("buddy-live-consent".to_string(), toast, cx)
        });
    }

    /// `setBuddyLive(on)`. A failed switch is a toast; one that came from
    /// the consent dialog offers Retry.
    fn apply_live(&mut self, on: bool, from_consent: bool, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", json!({ "enabled": on }))
                .await
        });
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                match result {
                    Ok(Ok(value)) => screen.settings = CohostSettingsView::from_json(&value),
                    Ok(Err(error)) if from_consent => screen.consent_failed(&error, true, cx),
                    Ok(Err(error)) => {
                        let context = if on { TURN_ON_LIVE } else { TURN_OFF_LIVE };
                        let id = if on {
                            "buddy-live-on"
                        } else {
                            "buddy-live-off"
                        };
                        if let Some(command) = toast_user_error(Failure::Rpc(&error), context, id) {
                            studio.post_notices(vec![command]);
                        }
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn set_listen(&mut self, on: bool, cx: &mut Context<Self>) {
        self.patch_section(json!({ "listen": on }), SaveSection::Listen, cx);
    }

    pub(crate) fn set_consent(&mut self, on: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_ai_consent(on)]).await });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |screen, cx| {
                screen.consented = on;
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn open_stream_manager(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.dispatch_action(Box::new(crate::app::menus::ToggleStreamManager), cx);
    }

    pub(crate) fn patch_settings(&mut self, patch: serde_json::Value, cx: &mut Context<Self>) {
        self.patch_settings_in(patch, None, cx);
    }

    /// `patchCohostSettings` for one section: its failure shows there.
    pub(crate) fn patch_section(
        &mut self,
        patch: serde_json::Value,
        section: SaveSection,
        cx: &mut Context<Self>,
    ) {
        self.patch_settings_in(patch, Some(section), cx);
    }

    fn patch_settings_in(
        &mut self,
        patch: serde_json::Value,
        section: Option<SaveSection>,
        cx: &mut Context<Self>,
    ) {
        if section.is_some() {
            self.save_error = None;
        }
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cohost.settings.set", patch).await });
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                match (result, section) {
                    (Ok(Ok(value)), _) => {
                        screen.settings = CohostSettingsView::from_json(&value);
                    }
                    (Ok(Err(error)), Some(SaveSection::Voice)) => {
                        if let Some(command) = toast_user_error(
                            Failure::Rpc(&error),
                            SAVE_VOICE_SETTING,
                            "buddy-voice-setting",
                        ) {
                            studio.post_notices(vec![command]);
                        }
                    }
                    (Ok(Err(error)), Some(section)) => {
                        let copy = user_error_message(Failure::Rpc(&error), Some(SAVE_SETTINGS));
                        if copy.kind != UserErrorKind::Canceled {
                            screen.save_error =
                                Some((section, format!("{}. {}", copy.title, copy.description)));
                        }
                    }
                    (Ok(Err(error)), None) => {
                        eprintln!("[videorc-app] Sidekick settings: {error}");
                    }
                    (Err(error), _) => {
                        eprintln!("[videorc-app] Sidekick settings: {error}");
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The failed save under `section`, if that is where it belongs.
    pub(crate) fn save_error(&self, section: SaveSection) -> Option<&str> {
        self.save_error
            .as_ref()
            .filter(|(failed, _)| *failed == section)
            .map(|(_, message)| message.as_str())
    }

    pub(crate) fn patch_auto_behaviour(
        &mut self,
        which: &str,
        enabled: Option<bool>,
        cooldown: Option<u32>,
        cx: &mut Context<Self>,
    ) {
        let mut next = self
            .settings
            .as_ref()
            .and_then(|s| s.auto_chat.clone())
            .unwrap_or_else(CohostAutoChat::default);
        match which {
            "answers" => {
                if let Some(on) = enabled {
                    next.answers.enabled = on;
                }
                if let Some(secs) = cooldown {
                    next.answers.cooldown_seconds = secs;
                }
            }
            "banter" => {
                if let Some(on) = enabled {
                    next.banter.enabled = on;
                }
                if let Some(secs) = cooldown {
                    next.banter.cooldown_seconds = secs;
                }
            }
            _ => return,
        }
        self.patch_section(json!({ "autoChat": next }), SaveSection::Replies, cx);
    }

    /// The saved chat rules.
    pub(crate) fn saved_rules(&self) -> Vec<String> {
        self.settings
            .as_ref()
            .and_then(|settings| settings.raw.get("rules"))
            .and_then(serde_json::Value::as_array)
            .map(|rules| {
                rules
                    .iter()
                    .filter_map(|rule| rule.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn add_chat_rule(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(widgets) = self.chat.as_ref() else {
            return;
        };
        let draft = widgets.rule_draft.read(cx).value().to_string();
        let Some(rule) = buddy_chat::rule_to_save(&draft) else {
            return;
        };
        let mut rules = self.saved_rules();
        if rules.len() >= RULES_MAX {
            return;
        }
        rules.push(rule);
        widgets
            .rule_draft
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.patch_section(json!({ "rules": rules }), SaveSection::Moderation, cx);
    }

    /// A rule edited in place: saved on blur or Enter; emptied, it goes.
    pub(crate) fn edit_chat_rule(&mut self, index: usize, text: &str, cx: &mut Context<Self>) {
        let mut rules = self.saved_rules();
        let Some(current) = rules.get(index).cloned() else {
            return;
        };
        match buddy_chat::rule_to_save(text) {
            Some(next) if next == current => return,
            Some(next) => rules[index] = next,
            None => {
                rules.remove(index);
            }
        }
        self.patch_section(json!({ "rules": rules }), SaveSection::Moderation, cx);
    }

    pub(crate) fn remove_chat_rule(&mut self, index: usize, cx: &mut Context<Self>) {
        let mut rules = self.saved_rules();
        if index >= rules.len() {
            return;
        }
        rules.remove(index);
        self.patch_section(json!({ "rules": rules }), SaveSection::Moderation, cx);
    }
}

impl Render for SidekickScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_chat(window, cx);
        self.ensure_community(window, cx);
        self.ensure_reports(cx);
        self.ensure_clean_cut(window, cx);
        let view = self.view();
        let wide = self.wide();
        let listen = self.settings.as_ref().map(|s| s.listen).unwrap_or(false);
        let community_settings = community::community_settings(self.settings.as_ref());
        let overview = OverviewState {
            view: &view,
            wide,
            listen,
            consented: self.consented,
            cloud_uses: cloud_ai_uses(),
            cloud_keeps: CLOUD_AI_KEEPS,
            allowance: self
                .state
                .listening
                .as_ref()
                .and_then(listen_allowance_label),
            listen_error: self.save_error(SaveSection::Listen),
        };
        let settings = self.settings.as_ref();
        let widgets = self.chat.as_ref().expect("chat widgets");
        let body = match self.tab {
            Tab::Overview => render_overview(overview, window, cx),
            Tab::Chat => {
                let errors = (
                    self.save_error(SaveSection::Replies),
                    self.save_error(SaveSection::Moderation),
                );
                render_chat(&view, settings, widgets, errors, wide, window, cx)
            }
            Tab::Community => {
                let preview = self.render_community_preview(window, cx);
                render_community(
                    self.entitled,
                    self.community.as_ref().expect("community state"),
                    &community_settings,
                    preview,
                    wide,
                    window,
                    cx,
                )
            }
            Tab::Voice => {
                let paused = command_availability_lines(self.state.command_availability.as_ref());
                let rows = remove_messages_rows(&self.studio.platforms_now());
                render_voice(&view, settings, &paused, &rows, wide, window, cx)
            }
            Tab::Reports => {
                let reports = self.reports.as_ref().expect("reports state");
                let buddy_on = self.settings.as_ref().map(|s| s.enabled).unwrap_or(false);
                let name = self
                    .settings
                    .as_ref()
                    .and_then(|s| s.persona.as_ref())
                    .map(|persona| persona.name.as_str());
                render_reports(&view, reports, buddy_on, name, window, cx)
            }
            Tab::CleanCut => {
                self.render_clean_cut(self.studio.read_ui_settings(clean_cut_auto), window, cx)
            }
        };

        let entity = cx.entity();
        let mut tabs = PageTabs::new("sidekick-page", words::TABS_LABEL);
        for tab in [
            Tab::Overview,
            Tab::Chat,
            Tab::Community,
            Tab::Voice,
            Tab::Reports,
            Tab::CleanCut,
        ] {
            tabs = tabs.tab(tab.label());
        }
        tabs = tabs
            .selected(self.tab.index())
            .on_select(move |index, _, cx| {
                entity.update(cx, |screen, cx| screen.select_tab(index, cx));
            });

        let consent = overview::consent_dialog(&self.consent, cx);

        // The page's own width (`@container/page`), never the window's: the
        // config grids put their sections side by side from 940 px.
        let page = cx.entity().downgrade();
        let measure = gpui::canvas(
            move |bounds, _, cx| {
                let width = f32::from(bounds.size.width);
                page.update(cx, |screen, cx| screen.measured(width, cx))
                    .ok();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        div()
            .id("sidekick-screen")
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .font_family(FONT)
            .child(measure)
            .child(tabs.child(body))
            .child(consent)
            // Reports' Markers dialog draws itself when open.
            .children(
                self.reports
                    .as_ref()
                    .and_then(|reports| reports.markers.clone()),
            )
    }
}
