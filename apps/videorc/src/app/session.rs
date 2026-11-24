//! The Studio page's session controls (plan 260 S2.4): Record, the clock,
//! Stop, and a plain Go Live. The view reads the Studio driver's snapshot
//! through the store bridge and calls the driver on the core's runtime; it
//! decides nothing itself. The words, the states and what each click does
//! are the core's (`studio::transport`, `Studio::start_recording`,
//! `Studio::start_livestream`, `Studio::request_stop`).
//!
//! Kept minimal on purpose: Go Live starts the livestream to the saved
//! destinations, with no Go Live dialog (S1.6c's preflight and sheet come
//! later), and ending a livestream asks with two plain buttons. The kit's
//! look replaces these plain elements when `videorc-kit` lands.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use gpui::{Context, Entity, FontWeight, SharedString, Window, div, prelude::*, px, rgb};
use videorc_app_core::studio::inspector::StartGates;
use videorc_app_core::studio::transport::{
    RecordButtonState, StatusTone, TransportView, session_clock_label, session_elapsed_ms,
    session_status, session_status_pulses,
};
use videorc_app_core::{BackendClient, StopOrigin, Studio, StudioSnapshot};

use super::bridge::Mirror;

/// The Studio the app drives: the core's driver on the typed client.
pub type AppStudio = Studio<BackendClient>;

/// What the session controls draw, mapped from one snapshot (pure, so the
/// bridge notifies only when one of these changed). The clock is not here:
/// it counts from `started_at` at each frame while the session pulses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionControls {
    pub transport: TransportView,
    /// The session's one word ("Ready", "Recording", "On air"…) and tone.
    pub status: &'static str,
    pub tone: StatusTone,
    /// The status pulses: the clock runs.
    pub pulse: bool,
    /// `startedAt`, for the clock.
    pub started_at: Option<String>,
    /// The End livestream question, while it waits: its destinations.
    pub stop_question: Option<Vec<String>>,
    /// The refused start's words, until the next attempt.
    pub start_failure: Option<String>,
}

impl SessionControls {
    pub fn of(snapshot: &StudioSnapshot) -> Self {
        let session = &snapshot.session;
        let (status, tone) = session_status(session, &snapshot.connection);
        Self {
            // The entitlement, destination and topology gates are inputs the
            // app doesn't hold yet (S1.6c, #1814); none of them is on.
            transport: TransportView::from_snapshot(snapshot, &StartGates::default(), false),
            status,
            tone,
            pulse: session_status_pulses(session, &snapshot.connection),
            started_at: session.status.started_at.clone(),
            stop_question: session
                .stop_confirmation
                .as_ref()
                .map(|question| question.platforms.clone()),
            start_failure: session
                .start_failure
                .as_ref()
                .map(|failure| failure.message.clone()),
        }
    }

    /// The clock's words now, while the session pulses.
    pub fn clock(&self) -> Option<String> {
        self.pulse.then(|| {
            session_clock_label(session_elapsed_ms(self.started_at.as_deref(), Utc::now()))
        })
    }
}

// Plain colours until the kit's tokens land (the shell's dark look).
const TEXT: u32 = 0xe8e8ea;
const MUTED: u32 = 0x8e8e93;
const BUTTON: u32 = 0x2f2f35;
const HAIRLINE: u32 = 0x2c2c30;
const RECORD_RED: u32 = 0xff453a;

fn tone_colour(tone: StatusTone) -> u32 {
    match tone {
        StatusTone::Neutral => MUTED,
        StatusTone::Good => 0x30d158,
        StatusTone::Live => RECORD_RED,
        StatusTone::Warn => 0xffd60a,
        StatusTone::Error => RECORD_RED,
    }
}

pub struct SessionPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    controls: Entity<Mirror<SessionControls>>,
}

impl SessionPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        controls: Entity<Mirror<SessionControls>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&controls, |_, _, cx| cx.notify()).detach();
        // The clock moves while the session pulses; nothing redraws when it
        // doesn't.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let alive = this.update(cx, |panel, cx| {
                    if panel.controls.read(cx).value().pulse {
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
            controls,
        }
    }

    fn record(&mut self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let outcome = studio.start_recording().await;
            eprintln!("[videorc-app] Record: {outcome:?}");
        });
    }

    fn go_live(&mut self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            // The saved destinations; the Go Live dialog is S1.6c's.
            let outcome = studio.start_livestream(None).await;
            eprintln!("[videorc-app] Go Live: {outcome:?}");
        });
    }

    fn stop(&mut self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let outcome = studio.request_stop(StopOrigin::Button).await;
            eprintln!("[videorc-app] Stop: {outcome:?}");
        });
    }

    fn end_livestream(&mut self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let (answered, _) = studio.confirm_stop().await;
            eprintln!("[videorc-app] End livestream: answered {answered}");
        });
    }

    fn keep_streaming(&mut self) {
        self.studio.cancel_stop();
    }
}

fn button(
    id: &'static str,
    label: impl Into<SharedString>,
    enabled: bool,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px(px(14.))
        .py(px(7.))
        .rounded(px(8.))
        .bg(rgb(BUTTON))
        .border_1()
        .border_color(rgb(HAIRLINE))
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(if enabled { TEXT } else { MUTED }))
        .when(enabled, |button| button.cursor_pointer())
        .child(label.into())
}

impl Render for SessionPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let controls = self.controls.read(cx).value().clone();
        let transport = &controls.transport;
        let clock = controls.clock();

        let mut buttons = div().flex().flex_row().items_center().gap(px(8.));
        if transport.active {
            // A session owns the transport: Record's place holds Stop.
            let enabled = transport.record_enabled;
            let label = match transport.record_state {
                RecordButtonState::Stopping => "Stopping…",
                _ => transport.stop_label,
            };
            buttons = buttons.child(
                button("session-stop", label, enabled)
                    .text_color(rgb(if enabled { RECORD_RED } else { MUTED }))
                    .when(enabled, |stop| {
                        stop.on_click(cx.listener(|this, _, _, _| this.stop()))
                    }),
            );
        } else {
            let enabled = transport.record_enabled;
            let label = match transport.record_state {
                RecordButtonState::Starting => "Starting…",
                _ => transport.record_label,
            };
            buttons = buttons.child(
                button("session-record", label, enabled)
                    .child(div().size(px(8.)).rounded(px(4.)).bg(rgb(RECORD_RED)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .when(enabled, |record| {
                        record.on_click(cx.listener(|this, _, _, _| this.record()))
                    }),
            );
        }
        if transport.go_live_shown {
            let enabled = transport.go_live_enabled;
            buttons = buttons.child(
                button("session-go-live", transport.go_live_label, enabled)
                    .when(enabled, |go_live| {
                        go_live.on_click(cx.listener(|this, _, _, _| this.go_live()))
                    }),
            );
        }

        let mut panel = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .pt(px(12.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .child(
                        div()
                            .size(px(8.))
                            .rounded(px(4.))
                            .bg(rgb(tone_colour(controls.tone))),
                    )
                    .child(controls.status)
                    .when_some(clock, |row, clock| {
                        row.child(
                            div()
                                .id("session-clock")
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(clock),
                        )
                    })
                    // "Your recording stops too." while a livestream runs.
                    .when_some(transport.stop_note, |row, note| {
                        row.child(div().text_color(rgb(MUTED)).child(note))
                    }),
            )
            .child(buttons);

        if let Some(platforms) = controls.stop_question.clone() {
            let question = if platforms.is_empty() {
                "End the livestream?".to_string()
            } else {
                format!("End the livestream on {}?", platforms.join(", "))
            };
            panel = panel.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .child(question)
                    .child(
                        button("session-end-livestream", "End livestream", true)
                            .text_color(rgb(RECORD_RED))
                            .on_click(cx.listener(|this, _, _, _| this.end_livestream())),
                    )
                    .child(
                        button("session-keep-streaming", "Keep streaming", true)
                            .on_click(cx.listener(|this, _, _, _| this.keep_streaming())),
                    ),
            );
        }

        // Why a start waits (or what refused it), in the core's words.
        let reason = controls
            .start_failure
            .clone()
            .or_else(|| transport.blocked_reason.clone());
        if let Some(reason) = reason {
            panel = panel.child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(reason),
            );
        }
        panel
    }
}
