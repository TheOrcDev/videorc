//! The Session section (`session-panel.tsx`'s `SessionPanel`): the facts
//! that go to their pages, then the notices under them. It has no title
//! (plan 235 D3): the rows name themselves.
//!
//! The runtime alert's Open Audio asks the page for the Microphone strip
//! (`StudioRequest::FocusAudio`), and its Show in Finder reveals the saved
//! file.
//!
//! The rows are `SessionPanel`'s: Livestream, Output, the live rows, then
//! the talk-show room's Guests row (`GuestsSessionSlot`) and the agents line
//! with its Stop (`AgentsSessionRow`), which this section reads itself
//! (`cloud.status` through the Studio, `agents.status`).
//!
//! The watchdog's cards (`alerts::WatchdogCards`) sit under the facts and
//! above the refused start, as `SessionNotices` draws them.

use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use gpui::{
    AnyElement, ClickEvent, Context, Entity, EventEmitter, Hsla, Window, div, prelude::*, px,
};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::watch;
use videorc_app_core::library::page::reveal_in_file_manager_label;
use videorc_app_core::livestream::cloud_status::CloudStatus;
use videorc_app_core::livestream::watchdog::{top_watchdog_alert, watchdog_chip_label};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::inspector::{
    AgentsState, FactRow, RuntimeAlertView, SessionInputs, SessionSectionView, StartFailureAlert,
    copy::{CAMERA_SHARED_TITLE, DISMISS, OPEN_AUDIO, OPEN_LIBRARY, RETRY},
    session_cloud_show,
};
use videorc_app_core::studio::screen_views::{GUESTS_ROW_LABEL, guests_session_row};
use videorc_app_core::studio::watchdog_alerts::WatchdogState;
use videorc_app_core::studio::{HealthTelemetry, StudioBackend};
use videorc_app_core::user_error::{UserErrorContext, backend_error_toast};
use videorc_app_core::{BackendEvent, StudioSnapshot};

/// `agents.status`: the answer and the event (`useAgents`).
const AGENTS_STATUS: &str = "agents.status";
/// The agents line's button and its name (`agents-session-row.tsx:50`,
/// `STOP_AGENTS_COMMAND` in `lib/agents-view.ts:43`).
const STOP_LABEL: &str = "Stop";
const STOP_AGENTS_COMMAND: &str = "Stop agents";
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, hsla};
use videorc_kit::{
    Alert, AlertVariant, Button, ButtonSize, ButtonVariant, GroupedList, NavigableRow,
    PanelSection, StatusDot, StatusTone,
};

use super::alerts::{StudioRequest, WatchdogCards};
use super::transport::{AppStudio, OpenPage};

/// The Electron row's `pl-9.5`: a destination under the Destinations row.
const NESTED_INDENT_PX: f32 = 38.;

/// A fact's tone (`live`, `good`, `warn`, `error`, `neutral`), or none for a
/// plain value.
pub fn fact_tone(tone: &str) -> Option<StatusTone> {
    match tone {
        "live" => Some(StatusTone::Live),
        "good" => Some(StatusTone::Good),
        "warn" => Some(StatusTone::Warn),
        "error" => Some(StatusTone::Error),
        "neutral" => Some(StatusTone::Neutral),
        _ => None,
    }
}

/// The section's view now. The Stream row names the watchdog's top alert
/// (`watchdogChipLabel(topWatchdogAlert(watchdogAlerts))`) and the cloud
/// show carrying this session (`useSessionCloud`); the other areas' facts
/// (Sidekick, the on-air encode) join as their lanes hand them over; each
/// `None` leaves its row or reading out. The agents line and the Guests row
/// are the section's own (see [`SessionSection`]).
pub fn section_view(
    snapshot: &StudioSnapshot,
    telemetry: &HealthTelemetry,
    watchdog: &WatchdogState,
    cloud: Option<&CloudStatus>,
) -> SessionSectionView {
    let inputs = SessionInputs {
        watchdog_chip: top_watchdog_alert(&watchdog.alerts).map(watchdog_chip_label),
        cloud: session_cloud_show(cloud, snapshot.session.status.session_id.as_deref()),
        ..SessionInputs::default()
    };
    SessionSectionView::from_snapshot(snapshot, telemetry, &inputs, Utc::now(), Instant::now())
}

/// The Guests row (P165) as a fact: it opens the Guests page, the room's one
/// home (`guests-session-row.tsx:18`).
fn guests_fact(value: String) -> FactRow {
    FactRow {
        id: "guests",
        label: GUESTS_ROW_LABEL.to_string(),
        value,
        tone: "",
        nested: false,
        opens: Some(PageId::Guests),
    }
}

pub struct SessionSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    view: SessionSectionView,
    /// The watchdog's cards; drawn only while there is one.
    watchdog: Entity<WatchdogCards>,
    /// P165: the Guests row's value while the talk-show room is open.
    guests: Option<String>,
    /// P166: `agents.status` (answer and event), for the agents line.
    agents: AgentsState,
    /// Stop's request is out (`stopping`).
    agents_stopping: bool,
}

impl EventEmitter<OpenPage> for SessionSection {}
impl EventEmitter<StudioRequest> for SessionSection {}

impl SessionSection {
    /// Follows the snapshot, the telemetry, the watchdog and the cloud; it
    /// redraws only when the view they make changes.
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        mut telemetry: watch::Receiver<HealthTelemetry>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut alerts = studio.watchdog();
        let mut cloud = studio.cloud();
        let snap = snapshot.borrow().clone();
        let cloud_status = cloud.borrow().status.clone();
        let view = section_view(
            &snap,
            &telemetry.borrow(),
            &alerts.borrow(),
            cloud_status.as_ref(),
        );
        let guests = guests_session_row(cloud_status.as_ref());
        let watchdog = cx.new(|cx| WatchdogCards::new(studio.clone(), runtime.clone(), cx));
        cx.observe(&watchdog, |_, _, cx| cx.notify()).detach();
        cx.subscribe(&watchdog, |_, _, open: &OpenPage, cx| cx.emit(*open))
            .detach();
        cx.subscribe(&watchdog, |_, _, request: &StudioRequest, cx| {
            cx.emit(*request)
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = snapshot.changed() => changed.is_ok(),
                    changed = telemetry.changed() => changed.is_ok(),
                    changed = alerts.changed() => changed.is_ok(),
                    changed = cloud.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let snap = snapshot.borrow_and_update().clone();
                let cloud_status = cloud.borrow_and_update().status.clone();
                let next = section_view(
                    &snap,
                    &telemetry.borrow_and_update(),
                    &alerts.borrow_and_update(),
                    cloud_status.as_ref(),
                );
                let guests = guests_session_row(cloud_status.as_ref());
                let alive = this.update(cx, |section, cx| {
                    if section.view != next || section.guests != guests {
                        section.view = next;
                        section.guests = guests;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        // `useAgents`: the status on every connection, then its events.
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(RecvError::Lagged(skipped)) => BackendEvent::ClientLagged { skipped },
                    Err(RecvError::Closed) => break,
                };
                if this
                    .update(cx, |section, cx| section.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let mut section = Self {
            studio,
            runtime,
            view,
            watchdog,

            guests,
            agents: AgentsState::default(),
            agents_stopping: false,
        };
        section.read_agents(cx);
        section
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::Untyped { event, payload } if event == AGENTS_STATUS => {
                self.set_agents(AgentsState::read(&payload), cx);
            }
            BackendEvent::ConnectionClosed { .. } => self.set_agents(AgentsState::default(), cx),
            BackendEvent::Ready(_)
            | BackendEvent::EventsLagged(_)
            | BackendEvent::ClientLagged { .. } => self.read_agents(cx),
            _ => {}
        }
    }

    fn set_agents(&mut self, agents: AgentsState, cx: &mut Context<Self>) {
        if self.agents != agents {
            self.agents = agents;
            cx.notify();
        }
    }

    /// `agents.status`: a failed read leaves the line as it was.
    fn read_agents(&mut self, cx: &mut Context<Self>) {
        let client = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { client.request(AGENTS_STATUS, json!({})).await });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(status)) = job.await else {
                return;
            };
            let _ = this.update(cx, |section, cx| {
                section.set_agents(AgentsState::read(&status), cx)
            });
        })
        .detach();
    }

    /// The agents line's Stop (plan 209 D12): cuts every agent and turns
    /// Agents off at once, never asking. The status event clears the line.
    fn stop_agents(&mut self, cx: &mut Context<Self>) {
        if self.agents_stopping {
            return;
        }
        self.agents_stopping = true;
        cx.notify();
        let studio = self.studio.clone();
        // A failed stop is `toastUserError(error, { action: 'stop', object:
        // 'the agents' })` (`agents-session-row.tsx:27`).
        let job = self.runtime.spawn(async move {
            if let Err(error) = studio.backend().agents_stop().await {
                let context = UserErrorContext {
                    action: "stop",
                    object: "the agents",
                };
                if let Some(command) = backend_error_toast(&error, studio.is_connected(), context) {
                    studio.post_notices(vec![command]);
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |section, cx| {
                section.agents_stopping = false;
                cx.notify();
                section.read_agents(cx);
            });
        })
        .detach();
    }

    /// P166 (`AgentsSessionRow`): "Claude Desktop connected" with Stop, in
    /// either look; nothing while no agent is connected.
    fn agents_row(
        &self,
        theme: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let line = self.agents.session_line()?;
        let stop = cx.listener(|section, _: &ClickEvent, _, cx| section.stop_agents(cx));

        Some(
            NavigableRow::with_control(
                "session-agents",
                line,
                Button::new("session-agents-stop")
                    .label(STOP_LABEL)
                    .accessibility_label(STOP_AGENTS_COMMAND)
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .disabled(self.agents_stopping)
                    .on_click(stop),
            )
            // `agents-session-row.tsx:55`, `icon={TerminalIcon}`: the
            // NavigableRow's leading icon, 16 px, secondary gray.
            .icon(icon(IconName::Terminal, 16., hsla(theme.muted_foreground)))
            .grouped()
            .into_any_element(),
        )
    }

    fn row(&self, fact: &FactRow, muted: Hsla, cx: &mut Context<Self>) -> NavigableRow {
        // A toned value is the status dot and its words, at the row's own
        // size and colour (`dotClassName`: `text-sm text-foreground`).
        let mut row = match fact_tone(fact.tone) {
            Some(tone) => NavigableRow::with_control(
                fact.id,
                fact.label.clone(),
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(StatusDot::new((fact.id, 0usize)).tone(tone))
                    .child(div().min_w_0().truncate().child(fact.value.clone())),
            ),
            None => NavigableRow::new(fact.id, fact.label.clone(), fact.value.clone()),
        };
        // Electron's NavigableRow leading icon: 16 px, secondary gray.
        if let Some(name) = row_icon(fact.id) {
            row = row.icon(icon(name, 16., muted));
        }
        if let Some(page) = fact.opens {
            let this = cx.entity().downgrade();
            row = row.on_navigate(move |_, _, cx| {
                this.update(cx, |_, cx| cx.emit(OpenPage::of(page))).ok();
            });
        }
        row
    }

    fn retry_start(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let outcome = studio.retry_start().await;
            eprintln!("[videorc-app] Retry start: {outcome:?}");
        });
    }

    /// The refused start (`session-start-failure`): the one place chrome
    /// shows destructive red, with the backend's reason verbatim.
    fn start_failure(&self, failure: &StartFailureAlert, cx: &mut Context<Self>) -> Alert {
        let retry = Button::new("session-start-retry")
            .label(RETRY)
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
            .disabled(!failure.retry_enabled)
            .on_click(cx.listener(|this, _, _, _| this.retry_start()));
        let dismiss = Button::new("session-start-dismiss")
            .label(DISMISS)
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
            .on_click(cx.listener(|this, _, _, _| this.studio.dismiss_start_failure()));
        Alert::new("session-start-failure")
            .variant(AlertVariant::Destructive)
            .title(failure.title)
            .description(notice_body(&failure.message).child(actions().child(retry).child(dismiss)))
    }

    /// `SessionRuntimeAlert`: a mid-session notice, in the destructive tone
    /// for a failed recording and the warning tone otherwise.
    fn runtime_alert(&self, alert: &RuntimeAlertView, cx: &mut Context<Self>) -> Alert {
        let mut row = actions();
        // P172: the watchdog card's door, which this notice hides while it is
        // up: the Microphone strip (`session-runtime-alert.tsx:50-58`).
        if alert.open_audio {
            row = row.child(
                Button::new("session-runtime-open-audio")
                    .label(OPEN_AUDIO)
                    .variant(ButtonVariant::Default)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(StudioRequest::FocusAudio))),
            );
        }
        if alert.open_library {
            row = row.child(
                Button::new("session-runtime-open-library")
                    .label(OPEN_LIBRARY)
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Library)))),
            );
        }
        // P174: Show in Finder / Explorer / folder for the saved file
        // (`session-runtime-alert.tsx:64-68`).
        if let Some(path) = alert.reveal_path.clone() {
            row = row.child(
                Button::new("session-runtime-reveal")
                    .label(reveal_in_file_manager_label())
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.reveal_path(std::path::Path::new(&path));
                    })),
            );
        }
        row = row.child(
            Button::new("session-runtime-dismiss")
                .label(DISMISS)
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .on_click(cx.listener(|this, _, _, _| this.studio.dismiss_notice())),
        );
        Alert::new("session-runtime-notice")
            .variant(if alert.failed {
                AlertVariant::Destructive
            } else {
                AlertVariant::Warning
            })
            .title(alert.title.clone())
            .description(notice_body(&alert.message).child(row))
    }
}

/// A notice's message, at most three lines (`line-clamp-3`).
fn notice_body(message: &str) -> gpui::Div {
    div()
        .min_w_0()
        .child(div().line_clamp(3).child(message.to_string()))
}

/// The notice's buttons (`flex flex-wrap gap-1 pt-2`).
fn actions() -> gpui::Div {
    div().flex().flex_wrap().gap(px(4.)).pt(px(8.))
}

/// The Session row's leading icon (`session-panel.tsx`): Livestream and
/// Destinations share Broadcast, Output is FrameCorners, Stream is
/// WarningCircle. Nested destination problems and Sidekick have none here
/// (Electron's problem rows have no icon; Sidekick waits for Buddy).
fn row_icon(id: &str) -> Option<IconName> {
    match id {
        "livestream" | "destinations" => Some(IconName::Broadcast),
        "output" => Some(IconName::FrameCorners),
        "stream" => Some(IconName::WarningCircle),
        // `GuestsSessionRow`'s AccountIcon (Phosphor's UserCircle).
        "guests" => Some(IconName::UserCircle),
        _ => None,
    }
}

impl Render for SessionSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let muted = hsla(theme.muted_foreground);
        let start_failure = self
            .view
            .start_failure
            .clone()
            .map(|failure| self.start_failure(&failure, cx));
        let camera_notice = self.view.camera_notice.clone().map(|notice| {
            Alert::new("session-camera-shared")
                .variant(AlertVariant::Warning)
                .title(CAMERA_SHARED_TITLE)
                .description(notice)
        });
        let runtime_alert = self
            .view
            .runtime_alert
            .clone()
            .map(|alert| self.runtime_alert(&alert, cx));
        // `SessionPanel`'s order: the facts, the Guests row (P165), then the
        // agents line (P166).
        let mut rows = self.view.rows.clone();
        rows.extend(self.guests.clone().map(guests_fact));
        let agents = self.agents_row(theme, cx);
        let facts: AnyElement = {
            let mut list = GroupedList::new();
            for (index, fact) in rows.iter().enumerate() {
                let row = self.row(fact, muted, cx);
                list = if fact.nested {
                    // Each problem row needs its own id: several share "destination".
                    list.item(
                        div()
                            .id(("session-destination", index))
                            .pl(px(NESTED_INDENT_PX))
                            .child(row.grouped()),
                    )
                } else {
                    list.row(row)
                };
            }
            if let Some(agents) = agents {
                list = list.item(agents);
            }
            list.into_any_element()
        };
        let watchdog = (!self.watchdog.read(cx).is_empty()).then(|| self.watchdog.clone());
        PanelSection::new("studio-session")
            .child(facts)
            .children(watchdog)
            .children(start_failure)
            .children(camera_notice)
            .children(runtime_alert)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_core_tone_has_a_dot_and_a_plain_value_none() {
        assert_eq!(fact_tone("live"), Some(StatusTone::Live));
        assert_eq!(fact_tone("good"), Some(StatusTone::Good));
        assert_eq!(fact_tone("warn"), Some(StatusTone::Warn));
        assert_eq!(fact_tone("error"), Some(StatusTone::Error));
        assert_eq!(fact_tone("neutral"), Some(StatusTone::Neutral));
        assert_eq!(fact_tone(""), None);
    }

    #[test]
    fn the_session_rows_keep_electron_s_icons() {
        assert_eq!(row_icon("livestream"), Some(IconName::Broadcast));
        assert_eq!(row_icon("destinations"), Some(IconName::Broadcast));
        assert_eq!(row_icon("output"), Some(IconName::FrameCorners));
        assert_eq!(row_icon("stream"), Some(IconName::WarningCircle));
        assert_eq!(row_icon("guests"), Some(IconName::UserCircle));
        assert_eq!(row_icon("destination"), None);
        assert_eq!(row_icon("sidekick"), None);
    }
}
