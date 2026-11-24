//! The Studio's session controls (P147–P157; `session-panel.tsx`
//! `SessionTransport`), moved here from S2.4's `app/session.rs`. The view
//! reads the Studio driver's snapshot through the store bridge and calls the
//! driver on the core's runtime; it decides nothing itself. The words, the
//! states and what each click does are the core's (`studio::transport`,
//! `Studio::start_recording`, `Studio::start_livestream`,
//! `Studio::request_stop`).
//!
//! No state word or clock here (plan 235 D1): those are the status bar's.
//! Go Live starts the livestream to the saved destinations until S1.6c's
//! Go Live dialog lands, and End livestream asks inline until the shell's
//! dialog (P157) does.

use std::sync::Arc;

use gpui::{Context, Entity, EventEmitter, Window, div, prelude::*, px};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::inspector::StartGates;
use videorc_app_core::studio::session::{
    KEEP_STREAMING_LABEL, StopConfirmation, end_livestream_body, end_livestream_confirm_label,
    end_livestream_title,
};
use videorc_app_core::studio::transport::{RecordButtonState, TransportView};
use videorc_app_core::{BackendClient, StopOrigin, Studio, StudioSnapshot};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_kit::{Button, ButtonSize, ButtonVariant, ShortcutKeys};

use super::space::ToggleRecord;
use crate::app::bridge::Mirror;

/// The Studio the app drives: the core's driver on the typed client.
pub type AppStudio = Studio<BackendClient>;

/// What the transport draws, mapped from one snapshot (pure, so the bridge
/// notifies only when one of these changed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionControls {
    pub transport: TransportView,
    /// The End livestream question, while it waits.
    pub stop_question: Option<StopConfirmation>,
}

impl SessionControls {
    pub fn of(snapshot: &StudioSnapshot) -> Self {
        Self {
            // The entitlement, destination and topology gates are inputs the
            // app doesn't hold yet (S1.6c, #1814); none of them is on.
            transport: TransportView::from_snapshot(snapshot, &StartGates::default(), false),
            stop_question: snapshot.session.stop_confirmation.clone(),
        }
    }
}

/// Record's face: its words, whether it is lit, and why it is off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordFace {
    pub label: &'static str,
    /// Space's chip beside the words, at idle and while it starts.
    pub shortcut: bool,
    /// Lit from the click that starts a session until it has stopped.
    pub lit: bool,
    pub disabled: bool,
    /// A click stops the session instead of starting one.
    pub stops: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoLiveFace {
    pub label: &'static str,
    pub disabled: bool,
    pub reason: Option<String>,
}

impl RecordFace {
    pub fn of(view: &TransportView) -> Self {
        let starting = matches!(
            view.record_state,
            RecordButtonState::Idle | RecordButtonState::Starting
        );
        Self {
            label: if starting {
                view.record_label
            } else {
                view.stop_label
            },
            shortcut: starting,
            lit: view.record_state != RecordButtonState::Idle,
            disabled: !view.record_enabled,
            stops: view.active,
            reason: (!view.active)
                .then(|| view.record_blocked.clone())
                .flatten(),
        }
    }
}

impl GoLiveFace {
    /// Hidden while a session holds the transport (P152).
    pub fn of(view: &TransportView) -> Option<Self> {
        view.go_live_shown.then(|| Self {
            label: view.go_live_label,
            disabled: !view.go_live_enabled,
            reason: view.go_live_blocked.clone(),
        })
    }
}

/// A row of the transport asks the shell to open a page (the blocked line's
/// jump).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPage(pub PageId);

pub struct Transport {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    controls: Entity<Mirror<SessionControls>>,
}

impl EventEmitter<OpenPage> for Transport {}

impl Transport {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        controls: Entity<Mirror<SessionControls>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&controls, |_, _, cx| cx.notify()).detach();
        Self {
            studio,
            runtime,
            controls,
        }
    }

    pub fn view(&self, cx: &gpui::App) -> TransportView {
        self.controls.read(cx).value().transport.clone()
    }

    pub fn record(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let outcome = studio.start_recording().await;
            eprintln!("[videorc-app] Record: {outcome:?}");
        });
    }

    fn go_live(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            // The saved destinations; the Go Live dialog is S1.6c's.
            let outcome = studio.start_livestream(None).await;
            eprintln!("[videorc-app] Go Live: {outcome:?}");
        });
    }

    /// A stop from `origin`; while live, the core asks End livestream first.
    pub fn stop(&self, origin: StopOrigin) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let outcome = studio.request_stop(origin).await;
            eprintln!("[videorc-app] Stop: {outcome:?}");
        });
    }

    fn end_livestream(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let (answered, _) = studio.confirm_stop().await;
            eprintln!("[videorc-app] End livestream: answered {answered}");
        });
    }

    fn keep_streaming(&self) {
        self.studio.cancel_stop();
    }
}

impl Render for Transport {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let muted = hsla(theme.muted_foreground);
        let controls = self.controls.read(cx).value().clone();
        let view = &controls.transport;
        let record = RecordFace::of(view);

        let stops = record.stops;
        let record_button = Button::new("session-record")
            .variant(ButtonVariant::Record)
            .size(ButtonSize::Lg)
            .lit(record.lit)
            .disabled(record.disabled)
            .label(record.label)
            .when(record.shortcut, |button| {
                button.child(ShortcutKeys::for_action(&ToggleRecord))
            })
            .when_some(record.reason, |button, reason| button.tooltip(reason))
            .on_click(cx.listener(move |this, _, _, _| {
                if stops {
                    this.stop(StopOrigin::Button);
                } else {
                    this.record();
                }
            }));
        let mut buttons = div()
            .flex()
            .flex_row()
            .gap(px(8.))
            .child(div().flex_1().min_w_0().child(record_button));
        if let Some(go_live) = GoLiveFace::of(view) {
            buttons = buttons.child(
                div().flex_1().min_w_0().child(
                    Button::new("go-live-button")
                        .variant(ButtonVariant::GoLive)
                        .size(ButtonSize::Lg)
                        .disabled(go_live.disabled)
                        .label(go_live.label)
                        .when_some(go_live.reason, |button, reason| button.tooltip(reason))
                        .on_click(cx.listener(|this, _, _, _| this.go_live())),
                ),
            );
        }

        div()
            .id("session-transport")
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(size::GUTTER))
            .border_b_1()
            .border_color(hsla(theme.border))
            .child(buttons)
            .when_some(view.stop_note.filter(|_| view.active), |section, note| {
                section.child(
                    div()
                        .id("session-stop-note")
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(note),
                )
            })
            .when_some(
                view.blocked_reason.clone().filter(|_| !view.active),
                |section, reason| {
                    let jump = view.blocked_jump;
                    section.child(
                        div()
                            .id("session-blocked-reason")
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(icon(IconName::Info, 14., muted))
                            .child(div().min_w_0().child(reason))
                            .when_some(jump, |line, jump| {
                                line.child(
                                    Button::new("session-blocked-jump")
                                        .variant(ButtonVariant::Link)
                                        .size(ButtonSize::Xs)
                                        .label(jump.label)
                                        .on_click(cx.listener(move |_, _, _, cx| {
                                            cx.emit(OpenPage(jump.page))
                                        })),
                                )
                            }),
                    )
                },
            )
            .when_some(controls.stop_question, |section, question| {
                section.child(
                    div()
                        .id("session-end-livestream")
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .type_scale(text::SECTION)
                                .child(end_livestream_title(question.origin)),
                        )
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(muted)
                                .child(end_livestream_body(&question)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(8.))
                                .child(
                                    Button::new("session-keep-streaming")
                                        .variant(ButtonVariant::Outline)
                                        .label(KEEP_STREAMING_LABEL)
                                        .on_click(
                                            cx.listener(|this, _, _, _| this.keep_streaming()),
                                        ),
                                )
                                .child(
                                    Button::new("session-confirm-end-livestream")
                                        .variant(ButtonVariant::Destructive)
                                        .label(end_livestream_confirm_label(question.origin))
                                        .on_click(
                                            cx.listener(|this, _, _, _| this.end_livestream()),
                                        ),
                                ),
                        ),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_app_core::studio::transport::GoLiveButtonState;

    fn idle() -> TransportView {
        TransportView {
            active: false,
            record_state: RecordButtonState::Idle,
            record_label: "Record",
            stop_label: "Stop recording",
            stop_note: None,
            record_enabled: true,
            record_blocked: None,
            go_live_shown: true,
            go_live_state: GoLiveButtonState::Idle,
            go_live_label: "Go Live",
            go_live_enabled: true,
            go_live_blocked: None,
            blocked_reason: None,
            blocked_jump: None,
            stop_overrun: false,
        }
    }

    #[test]
    fn idle_record_reads_record_with_space_and_go_live_shows() {
        let face = RecordFace::of(&idle());
        assert_eq!(face.label, "Record");
        assert!(face.shortcut && !face.lit && !face.disabled && !face.stops);
        assert_eq!(
            GoLiveFace::of(&idle()),
            Some(GoLiveFace {
                label: "Go Live",
                disabled: false,
                reason: None
            })
        );
    }

    #[test]
    fn a_starting_record_is_lit_and_busy_with_its_record_words() {
        let view = TransportView {
            record_state: RecordButtonState::Starting,
            record_enabled: false,
            go_live_enabled: false,
            ..idle()
        };
        let face = RecordFace::of(&view);
        assert_eq!(face.label, "Record");
        assert!(face.shortcut && face.lit && face.disabled && !face.stops);
    }

    #[test]
    fn a_running_session_shows_the_core_stop_words_and_hides_go_live() {
        for label in [
            "Stop recording",
            "End livestream",
            "Cancel livestream",
            "Force stop",
            "Stopping…",
        ] {
            let view = TransportView {
                active: true,
                record_state: if label == "Stopping…" {
                    RecordButtonState::Stopping
                } else {
                    RecordButtonState::Running
                },
                stop_label: label,
                go_live_shown: false,
                record_blocked: Some("A recording or livestream is already running.".into()),
                ..idle()
            };
            let face = RecordFace::of(&view);
            assert_eq!(face.label, label);
            assert!(!face.shortcut && face.lit && face.stops);
            assert_eq!(face.reason, None, "no tooltip while a session runs");
            assert_eq!(GoLiveFace::of(&view), None);
        }
    }

    #[test]
    fn blocked_reasons_ride_on_their_buttons() {
        let reason = "Turn on a destination in Destinations before you go live.";
        let view = TransportView {
            go_live_enabled: false,
            go_live_blocked: Some(reason.into()),
            ..idle()
        };
        let go_live = GoLiveFace::of(&view).unwrap();
        assert!(go_live.disabled);
        assert_eq!(go_live.reason.as_deref(), Some(reason));
    }
}
