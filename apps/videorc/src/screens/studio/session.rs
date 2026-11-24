//! The Session section (`session-panel.tsx`'s `SessionPanel`): the facts
//! that go to their pages, then the notices under them. It has no title
//! (plan 235 D3): the rows name themselves.
//!
//! The rows' icons wait for the kit's Livestream, Frame and Alert icons.
//! The runtime alert's Open Audio waits for the Audio
//! section and its reveal for the reveal command, as Electron leaves out a
//! door it has no handler for.

use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use gpui::{Context, EventEmitter, Window, div, prelude::*, px};
use tokio::sync::watch;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::HealthTelemetry;
use videorc_app_core::studio::inspector::{
    FactRow, RuntimeAlertView, SessionInputs, SessionSectionView, StartFailureAlert,
    copy::{CAMERA_SHARED_TITLE, DISMISS, OPEN_LIBRARY, RETRY},
};
use videorc_kit::{
    Alert, AlertVariant, Button, ButtonSize, ButtonVariant, GroupedList, GroupedRow, NavigableRow,
    PanelSection, StatusDot, StatusTone,
};

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

/// The section's view now. The other areas' facts (agents, the watchdog's
/// chip, the cloud show, Sidekick, the on-air encode) join as their lanes
/// hand them over; each `None` leaves its row or reading out.
pub fn section_view(snapshot: &StudioSnapshot, telemetry: &HealthTelemetry) -> SessionSectionView {
    SessionSectionView::from_snapshot(
        snapshot,
        telemetry,
        &SessionInputs::default(),
        Utc::now(),
        Instant::now(),
    )
}

pub struct SessionSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    view: SessionSectionView,
}

impl EventEmitter<OpenPage> for SessionSection {}

impl SessionSection {
    /// Follows the snapshot and the telemetry; it redraws only when the
    /// view they make changes.
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        mut telemetry: watch::Receiver<HealthTelemetry>,
        cx: &mut Context<Self>,
    ) -> Self {
        let view = section_view(&snapshot.borrow(), &telemetry.borrow());
        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = snapshot.changed() => changed.is_ok(),
                    changed = telemetry.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let next = section_view(
                    &snapshot.borrow_and_update(),
                    &telemetry.borrow_and_update(),
                );
                let alive = this.update(cx, |section, cx| {
                    if section.view != next {
                        section.view = next;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            view,
        }
    }

    fn row(&self, fact: &FactRow, cx: &mut Context<Self>) -> NavigableRow {
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
        if let Some(page) = fact.opens {
            let this = cx.entity().downgrade();
            row = row.on_navigate(move |_, _, cx| {
                this.update(cx, |_, cx| cx.emit(OpenPage(page))).ok();
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
        if alert.open_library {
            row = row.child(
                Button::new("session-runtime-open-library")
                    .label(OPEN_LIBRARY)
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(OpenPage(PageId::Library)))),
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

impl Render for SessionSection {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut list = GroupedList::new();
        for (index, fact) in self.view.rows.iter().enumerate() {
            let row = self.row(fact, cx);
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
        PanelSection::new("studio-session")
            .child(list)
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
}
