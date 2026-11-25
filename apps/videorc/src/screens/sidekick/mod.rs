//! Sidekick ⌘9 (plan 260 Phase 3): Overview, Chat, Community, Voice,
//! Reports and Clean cut from `videorc_app_core::buddy` and
//! `stream_manager::buddy`, drawn with `videorc-kit`. Words match Electron's
//! `tabs/buddy-tab.tsx`.

mod chat;
mod clean_cut;
mod community;
mod live;
mod overview;
mod reports;
mod voice;

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{Context, Window, div, prelude::*};
use serde_json::json;
use videorc_app_core::buddy::chat::{self as buddy_chat, RULES_MAX};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::{
    CLOUD_AI_KEEPS, CohostSettingsView, CohostState, cloud_ai_uses,
};
use videorc_app_core::studio::families::{
    self, clean_cut_auto, write_ai_consent, write_clean_cut_auto,
};
use videorc_app_core::studio::ui_local::UiLocal;
use videorc_app_core::{BackendClient, BackendEvent, Studio};
use videorc_kit::dialog::DialogHandle;
use videorc_kit::page_tabs::PageTabs;
use videorc_kit::theme::FONT;
use videorc_protocol::cohost::CohostAutoChat;
use videorc_protocol::{
    CleanCutGetResult, CleanCutJob, CleanCutJobDetail, CleanCutMode, CohostReportPayload,
};

use chat::{ChatWidgets, render_chat};
use clean_cut::{CleanCutState, RecordingRow, render_clean_cut};
use community::{CommunityState, LinkSuggestion, PersonDetail, PersonRow, render_community};
use live::{LiveInput, LiveView, live_view};
use overview::{OverviewState, render_overview};
use reports::{ReportsState, render_reports};
use videorc_app_core::buddy::community::CommunitySummary;
use voice::render_voice;

pub type AppStudio = Studio<BackendClient>;

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

pub struct SidekickScreen {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    local_dir: PathBuf,
    tab: Tab,
    settings: Option<CohostSettingsView>,
    state: CohostState,
    signed_in: bool,
    entitled: bool,
    consented: bool,
    live: bool,
    consent: DialogHandle,
    pending_on: bool,
    chat: Option<ChatWidgets>,
    community: Option<CommunityState>,
    reports: Option<ReportsState>,
    clean_cut: Option<CleanCutState>,
}

impl SidekickScreen {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        local_dir: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let tab = Tab::from_id(UiLocal::in_dir(&local_dir).buddy_tab());
        let consented = studio.read_ui_settings(families::ai_consent);
        let mut screen = Self {
            studio: studio.clone(),
            runtime: runtime.clone(),
            local_dir,
            tab,
            settings: None,
            state: CohostState::default(),
            signed_in: false,
            entitled: false,
            consented,
            live: false,
            consent: DialogHandle::new(false),
            pending_on: false,
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
    }

    fn ensure_clean_cut(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clean_cut.is_none() {
            self.clean_cut = Some(CleanCutState::new(&self.local_dir, window, cx));
        }
        if self.tab == Tab::CleanCut {
            if let Some(clean) = self.clean_cut.as_ref() {
                if !clean.loaded {
                    self.refresh_clean_cut(cx);
                }
            }
        }
    }

    fn ensure_reports(&mut self, cx: &mut Context<Self>) {
        if self.reports.is_none() {
            self.reports = Some(ReportsState::default());
        }
        if self.tab == Tab::Reports {
            if let Some(reports) = self.reports.as_ref() {
                if !reports.loaded && !reports.loading {
                    self.refresh_reports(cx);
                }
            }
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
                                    "cohost.state" | "cohost.settings.changed" | "account.changed"
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
                                        if let (Some(job), Some(clean)) = (job, screen.clean_cut.as_mut()) {
                                            if let Some(slot) = clean.jobs.iter_mut().find(|j| j.id == job.id) {
                                                *slot = job;
                                            } else {
                                                clean.jobs.insert(0, job);
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
            let entitled = account
                .as_ref()
                .and_then(|value| value.pointer("/entitlements/liveCohost/allowed"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
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

    pub(crate) fn select_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        let tab = Tab::from_index(index);
        if self.tab == tab {
            return;
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
        cx.notify();
    }

    pub(crate) fn refresh_clean_cut(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            let jobs = backend
                .request("cleanCut.list", serde_json::json!({}))
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("jobs")
                        .cloned()
                        .or_else(|| value.as_array().cloned().map(serde_json::Value::Array))
                })
                .and_then(|value| serde_json::from_value::<Vec<CleanCutJob>>(value).ok())
                .unwrap_or_default();
            let recordings = backend
                .request("sessions.list", serde_json::json!({ "limit": 50 }))
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("sessions")
                        .cloned()
                        .or_else(|| value.get("items").cloned())
                })
                .and_then(|value| serde_json::from_value::<Vec<RecordingRow>>(value).ok())
                .unwrap_or_default();
            (jobs, recordings)
        });
        cx.spawn(async move |this, cx| {
            let Ok((jobs, recordings)) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(clean) = screen.clean_cut.as_mut() {
                    clean.jobs = jobs;
                    clean.recordings = recordings;
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

    pub(crate) fn start_clean_cut(&mut self, cx: &mut Context<Self>) {
        let Some(clean) = self.clean_cut.as_ref() else {
            return;
        };
        let Some(session_id) = clean.selected_session.clone() else {
            return;
        };
        let mode = clean.mode;
        let consented = self.consented;
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cleanCut.start",
                    serde_json::json!({
                        "sessionId": session_id,
                        "mode": mode,
                        "consentToUploadAudio": consented
                    }),
                )
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<CleanCutJob>(value).ok())
        });
        cx.spawn(async move |this, cx| {
            let Ok(started) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let (Some(started), Some(clean)) = (started, screen.clean_cut.as_mut()) {
                    clean.jobs.insert(0, started);
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
                .request("cleanCut.cancel", serde_json::json!({ "jobId": job_id }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |screen, cx| screen.refresh_clean_cut(cx));
        })
        .detach();
    }

    pub(crate) fn open_clean_cut_review(&mut self, job_id: String, cx: &mut Context<Self>) {
        let Some(job) = self
            .clean_cut
            .as_ref()
            .and_then(|clean| clean.jobs.iter().find(|job| job.id == job_id).cloned())
        else {
            return;
        };
        let session_id = job.source_session_id.clone();
        let backend = self.studio.backend().clone();
        let fetch = self.runtime.spawn(async move {
            backend
                .request(
                    "cleanCut.get",
                    serde_json::json!({ "sessionId": session_id }),
                )
                .await
                .ok()
        });
        cx.spawn(async move |this, cx| {
            let value = fetch.await.ok().flatten();
            let detail = value
                .and_then(|value| serde_json::from_value::<CleanCutGetResult>(value).ok())
                .and_then(|result| {
                    result
                        .jobs
                        .into_iter()
                        .find(|detail| detail.job.id == job_id)
                })
                .unwrap_or(CleanCutJobDetail {
                    job,
                    edl: None,
                    condensed_keeps: Vec::new(),
                });
            let _ = this.update(cx, |screen, cx| {
                if let Some(clean) = screen.clean_cut.as_mut() {
                    let drafts = clean.load_drafts();
                    clean.draft =
                        videorc_app_core::buddy::clean_cut_drafts::read(&drafts, &detail.job.id);
                    clean.saved_removals = detail
                        .edl
                        .as_ref()
                        .map(|edl| edl.removals.clone())
                        .unwrap_or_default();
                    clean.review_job = Some(detail);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn persist_clean_cut_draft(&mut self, _cx: &mut Context<Self>) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let Some(job_id) = clean
            .review_job
            .as_ref()
            .map(|detail| detail.job.id.clone())
        else {
            return;
        };
        let draft = clean.draft.clone();
        let drafts = clean.load_drafts();
        if let Some(next) =
            videorc_app_core::buddy::clean_cut_drafts::write(&drafts, &job_id, &draft)
        {
            clean.persist_drafts(&next);
        }
    }

    pub(crate) fn discard_clean_cut_review(&mut self, cx: &mut Context<Self>) {
        if let Some(clean) = self.clean_cut.as_mut() {
            if let Some(job_id) = clean
                .review_job
                .as_ref()
                .map(|detail| detail.job.id.clone())
            {
                let empty = videorc_app_core::buddy::clean_cut_review::Draft::default();
                let drafts = clean.load_drafts();
                if let Some(next) =
                    videorc_app_core::buddy::clean_cut_drafts::write(&drafts, &job_id, &empty)
                {
                    clean.persist_drafts(&next);
                }
            }
            clean.draft = videorc_app_core::buddy::clean_cut_review::Draft::default();
            clean.review_job = None;
            clean.saved_removals.clear();
        }
        cx.notify();
    }

    pub(crate) fn save_clean_cut_review(&mut self, job_id: String, cx: &mut Context<Self>) {
        let Some(clean) = self.clean_cut.as_ref() else {
            return;
        };
        let Some(detail) = clean.review_job.as_ref() else {
            return;
        };
        if detail.job.id != job_id {
            return;
        }
        let params = videorc_app_core::buddy::clean_cut_review::update_edl_payload(
            &job_id,
            detail.job.edl_revision,
            &clean.draft,
        );
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cleanCut.updateEdl",
                    serde_json::to_value(params).unwrap_or_default(),
                )
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |screen, cx| {
                screen.discard_clean_cut_review(cx);
                screen.refresh_clean_cut(cx);
            });
        })
        .detach();
    }

    pub(crate) fn refresh_reports(&mut self, cx: &mut Context<Self>) {
        if let Some(reports) = self.reports.as_mut() {
            reports.loading = true;
            reports.error = None;
        }
        cx.notify();
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            match backend
                .request("cohost.report.latest", serde_json::json!({}))
                .await
            {
                Ok(value) => {
                    if value.is_null() {
                        Ok(None)
                    } else {
                        serde_json::from_value::<CohostReportPayload>(value)
                            .map(Some)
                            .map_err(|e| e.to_string())
                    }
                }
                Err(error) => Err(error.to_string()),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(reports) = screen.reports.as_mut() {
                    reports.loading = false;
                    reports.loaded = true;
                    match result {
                        Ok(Ok(payload)) => {
                            reports.payload = payload;
                            reports.error = None;
                        }
                        Ok(Err(error)) => {
                            reports.error = Some(error);
                        }
                        Err(error) => {
                            reports.error = Some(error.to_string());
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn refresh_community(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let query = self
            .community
            .as_ref()
            .map(|c| c.search.read(cx).value().to_string())
            .unwrap_or_default();
        let query = query.trim().to_string();
        let job = self.runtime.spawn(async move {
            let summary = backend
                .request("cohost.community.summary", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<CommunitySummary>(value).ok());
            let mut list_params = json!({ "filter": "everyone", "sort": "streams", "limit": 100 });
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

    pub(crate) fn select_community_person(&mut self, person_id: String, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.community.person", json!({ "personId": person_id }))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<PersonDetail>(value).ok())
        });
        cx.spawn(async move |this, cx| {
            let Ok(person) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.selected = person;
                    community.linking = false;
                    community.link_hits.clear();
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn community_toggle_bot(
        &mut self,
        person_id: String,
        is_bot: bool,
        cx: &mut Context<Self>,
    ) {
        let status = if is_bot { "normal" } else { "bot" };
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cohost.community.update",
                    json!({ "personId": person_id, "status": status }),
                )
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<PersonDetail>(value).ok())
        });
        cx.spawn(async move |this, cx| {
            let Ok(person) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    if let Some(person) = person {
                        community.selected = Some(person);
                    }
                }
                screen.refresh_community(cx);
            });
        })
        .detach();
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
        cx: &mut Context<Self>,
    ) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cohost.community.link",
                    json!({ "personId": person_id, "otherPersonId": other_person_id }),
                )
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<PersonDetail>(value).ok())
        });
        cx.spawn(async move |this, cx| {
            let Ok(person) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.linking = false;
                    community.link_hits.clear();
                    if let Some(person) = person {
                        community.selected = Some(person);
                    }
                }
                screen.refresh_community(cx);
            });
        })
        .detach();
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
        self.apply_live(on, cx);
    }

    pub(crate) fn answer_consent(
        &mut self,
        accept: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.consent.close(window, cx);
        if !accept {
            self.pending_on = false;
            cx.notify();
            return;
        }
        let studio = self.studio.clone();
        let turn_on = self.pending_on;
        self.pending_on = false;
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_ai_consent(true)]).await });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |screen, cx| {
                screen.consented = true;
                if turn_on {
                    screen.apply_live(true, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_live(&mut self, on: bool, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", json!({ "enabled": on }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Ok(Ok(value)) = result {
                    screen.settings = CohostSettingsView::from_json(&value);
                } else if let Ok(Err(error)) = result {
                    eprintln!("[videorc-app] Sidekick Live: {error}");
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn set_listen(&mut self, on: bool, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", json!({ "listen": on }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Ok(Ok(value)) = result {
                    screen.settings = CohostSettingsView::from_json(&value);
                }
                cx.notify();
            });
        })
        .detach();
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
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cohost.settings.set", patch).await });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                match result {
                    Ok(Ok(value)) => {
                        screen.settings = CohostSettingsView::from_json(&value);
                    }
                    Ok(Err(error)) => {
                        eprintln!("[videorc-app] Sidekick settings: {error}");
                    }
                    Err(error) => {
                        eprintln!("[videorc-app] Sidekick settings: {error}");
                    }
                }
                cx.notify();
            });
        })
        .detach();
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
        self.patch_settings(json!({ "autoChat": next }), cx);
    }

    pub(crate) fn add_chat_rule(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(widgets) = self.chat.as_ref() else {
            return;
        };
        let draft = widgets.rule_draft.read(cx).value().to_string();
        let Some(rule) = buddy_chat::rule_to_save(&draft) else {
            return;
        };
        let mut rules: Vec<String> = self
            .settings
            .as_ref()
            .and_then(|s| s.raw.get("rules"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if rules.len() >= RULES_MAX {
            return;
        }
        rules.push(rule);
        if let Some(widgets) = self.chat.as_ref() {
            widgets
                .rule_draft
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
        self.patch_settings(json!({ "rules": rules }), cx);
    }

    pub(crate) fn remove_chat_rule(&mut self, index: usize, cx: &mut Context<Self>) {
        let mut rules: Vec<String> = self
            .settings
            .as_ref()
            .and_then(|s| s.raw.get("rules"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if index >= rules.len() {
            return;
        }
        rules.remove(index);
        self.patch_settings(json!({ "rules": rules }), cx);
    }
}

impl Render for SidekickScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_chat(window, cx);
        self.ensure_community(window, cx);
        self.ensure_reports(cx);
        self.ensure_clean_cut(window, cx);
        let view = self.view();
        let listen = self.settings.as_ref().map(|s| s.listen).unwrap_or(false);
        let remember = self
            .settings
            .as_ref()
            .and_then(|s| s.raw.get("community"))
            .and_then(|c| c.get("remember"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let overview = OverviewState {
            view: &view,
            listen,
            consented: self.consented,
            cloud_uses: cloud_ai_uses(),
            cloud_keeps: CLOUD_AI_KEEPS,
        };
        let settings = self.settings.as_ref();
        let widgets = self.chat.as_ref().expect("chat widgets");
        let community = self.community.as_ref().expect("community state");
        let body = match self.tab {
            Tab::Overview => render_overview(overview, window, cx),
            Tab::Chat => render_chat(&view, settings, widgets, window, cx),
            Tab::Community => {
                render_community(&view, self.entitled, community, remember, window, cx)
            }
            Tab::Voice => render_voice(&view, settings, window, cx),
            Tab::Reports => {
                let reports = self.reports.as_ref().expect("reports state");
                let buddy_on = self.settings.as_ref().map(|s| s.enabled).unwrap_or(false);
                render_reports(&view, reports, buddy_on, window, cx)
            }
            Tab::CleanCut => {
                let clean = self.clean_cut.as_ref().expect("clean cut state");
                let auto = self.studio.read_ui_settings(clean_cut_auto);
                render_clean_cut(&view, self.consented, auto, clean, window, cx)
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

        div()
            .id("sidekick-screen")
            .size_full()
            .flex()
            .flex_col()
            .font_family(FONT)
            .child(tabs.child(body))
            .child(consent)
    }
}
