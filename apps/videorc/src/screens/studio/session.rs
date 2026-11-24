//! The Session section (`session-panel.tsx`'s `SessionPanel`): the facts
//! that go to their pages, then the notices under them. It has no title
//! (plan 235 D3): the rows name themselves.
//!
//! The rows' icons and the on-air rows' status dots wait for the kit's
//! icons and StatusDot; the start failure's Retry and Dismiss, the agents'
//! Stop and the runtime alert's actions wait for the kit's Button.

use std::time::Instant;

use chrono::Utc;
use gpui::{Context, EventEmitter, Window, div, prelude::*, px};
use tokio::sync::watch;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::studio::HealthTelemetry;
use videorc_app_core::studio::inspector::{
    FactRow, SessionInputs, SessionSectionView, copy::CAMERA_SHARED_TITLE,
};
use videorc_kit::{Alert, AlertVariant, GroupedList, GroupedRow, NavigableRow, PanelSection};

use super::transport::OpenPage;

/// The Electron row's `pl-9.5`: a destination under the Destinations row.
const NESTED_INDENT_PX: f32 = 38.;

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
    view: SessionSectionView,
}

impl EventEmitter<OpenPage> for SessionSection {}

impl SessionSection {
    /// Follows the snapshot and the telemetry; it redraws only when the
    /// view they make changes.
    pub fn new(
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
        Self { view }
    }

    fn row(&self, fact: &FactRow, cx: &mut Context<Self>) -> NavigableRow {
        let mut row = NavigableRow::new(fact.id, fact.label.clone(), fact.value.clone());
        if let Some(page) = fact.opens {
            let this = cx.entity().downgrade();
            row = row.on_navigate(move |_, _, cx| {
                this.update(cx, |_, cx| cx.emit(OpenPage(page))).ok();
            });
        }
        row
    }
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
        let camera_notice = self.view.camera_notice.clone().map(|notice| {
            Alert::new("session-camera-shared")
                .variant(AlertVariant::Warning)
                .title(CAMERA_SHARED_TITLE)
                .description(notice)
        });
        PanelSection::new("studio-session")
            .child(list)
            .children(camera_notice)
    }
}
