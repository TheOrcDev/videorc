//! The Studio's session controls (P147–P157; `session-panel.tsx`
//! `SessionTransport`), moved here from S2.4's `app/session.rs`. The view
//! reads the Studio driver's snapshot through the store bridge and calls the
//! driver on the core's runtime; it decides nothing itself. The words, the
//! states and what each click does are the core's (`studio::transport`,
//! `Studio::start_recording`, `Studio::start_livestream`,
//! `Studio::request_stop`).
//!
//! While a talk-show room is open (P123, P151), Record and Go Live follow
//! `talkShowOutputs`: cloud recording and the room's live legs. Stopping the
//! cloud recording is stubbed until L7 adds it.
//!
//! No state word or clock here (plan 235 D1): those are the status bar's.
//! Go Live opens the confirmation dialog (`studio::go_live::open_go_live`);
//! End livestream asks inline until the shell's dialog (P157) does.

use std::sync::Arc;

use gpui::{Context, Entity, EventEmitter, Window, div, prelude::*, px};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::cloud::CloudState;
use videorc_app_core::studio::inspector::StartGates;
use videorc_app_core::studio::screen_views::{
    STOP_CLOUD_RECORDING_UNAVAILABLE, TalkShowOutputs, TalkShowRoomView, talk_show_room,
};
use videorc_app_core::studio::session::{
    END_LIVESTREAM_LABEL, KEEP_STREAMING_LABEL, StopConfirmation, end_livestream_body,
    end_livestream_confirm_label, end_livestream_title,
};
use videorc_app_core::studio::transport::{RecordButtonState, TransportView, stop_overrun_copy};
use videorc_app_core::{BackendClient, StopOrigin, Studio, StudioSnapshot};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_kit::{Alert, AlertVariant, Button, ButtonSize, ButtonVariant, ShortcutKeys};

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

/// The talk-show room as the transport and the Preview stage read it.
pub fn talk_show_of(cloud: &CloudState) -> TalkShowRoomView {
    talk_show_room(cloud.status.as_ref())
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
    /// A click stops the talk-show cloud recording (stubbed until L7).
    pub stops_cloud: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoLiveFace {
    pub label: &'static str,
    pub disabled: bool,
    pub reason: Option<String>,
    /// The room is live: a click ends the livestream (P151).
    pub ends_livestream: bool,
}

impl RecordFace {
    pub fn of(view: &TransportView, talk_show: Option<&TalkShowOutputs>) -> Self {
        if let Some(outputs) = talk_show {
            if outputs.recording {
                // Room open + cloud recording: fixed "Stop recording", lit.
                // The click is stubbed until L7 adds `stopCloudRecording`.
                return Self {
                    label: "Stop recording",
                    shortcut: false,
                    lit: true,
                    disabled: false,
                    stops: false,
                    stops_cloud: true,
                    reason: Some(STOP_CLOUD_RECORDING_UNAVAILABLE.to_string()),
                };
            }
        }
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
            stops_cloud: false,
            reason: (!view.active)
                .then(|| view.record_blocked.clone())
                .flatten(),
        }
    }
}

impl GoLiveFace {
    /// Hidden while a local session holds the transport (P152), unless a
    /// talk-show room is open (P123): then Go Live stays for the room's live
    /// legs, and reads "End livestream" while they run (P151).
    pub fn of(view: &TransportView, talk_show: Option<&TalkShowOutputs>) -> Option<Self> {
        if view.active && talk_show.is_none() {
            return None;
        }
        if let Some(outputs) = talk_show.filter(|outputs| outputs.live) {
            let _ = outputs;
            return Some(Self {
                label: END_LIVESTREAM_LABEL,
                // Electron: `liveActive ? !canStop : …`. Approximate canStop
                // with the transport's stop enablement while a session runs,
                // else leave it on while the connection is ready for Go Live.
                disabled: if view.active {
                    !view.record_enabled
                } else {
                    false
                },
                reason: None,
                ends_livestream: true,
            });
        }
        view.go_live_shown.then(|| Self {
            label: view.go_live_label,
            disabled: !view.go_live_enabled,
            reason: view.go_live_blocked.clone(),
            ends_livestream: false,
        })
    }
}

/// A row of the transport asks the shell to open a page (the blocked line's
/// jump). `settings_tab` opens Settings on that tab (Permissions, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPage {
    pub page: PageId,
    pub settings_tab: Option<&'static str>,
}

impl OpenPage {
    pub const fn of(page: PageId) -> Self {
        Self {
            page,
            settings_tab: None,
        }
    }

    pub const fn settings(tab: &'static str) -> Self {
        Self {
            page: PageId::Settings,
            settings_tab: Some(tab),
        }
    }
}

pub struct Transport {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    controls: Entity<Mirror<SessionControls>>,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
}

impl EventEmitter<OpenPage> for Transport {}

impl Transport {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        controls: Entity<Mirror<SessionControls>>,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&controls, |_, _, cx| cx.notify()).detach();
        cx.observe(&talk_show, |_, _, cx| cx.notify()).detach();
        Self {
            studio,
            runtime,
            controls,
            talk_show,
        }
    }

    pub fn view(&self, cx: &gpui::App) -> TransportView {
        self.controls.read(cx).value().transport.clone()
    }

    pub fn talk_show(&self, cx: &gpui::App) -> TalkShowRoomView {
        self.talk_show.read(cx).value().clone()
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
            studio.open_go_live().await;
            eprintln!("[videorc-app] Go Live: open confirmation");
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

    /// `talkShow.stopCloudRecording`: L7 adds `cloud.recording.stop`. Until
    /// then the button keeps Electron's words and names why it does nothing.
    fn stop_cloud_recording(&self) {
        eprintln!("[videorc-app] Stop cloud recording: {STOP_CLOUD_RECORDING_UNAVAILABLE}");
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
        let outputs = self.talk_show.read(cx).value().transport_outputs();
        let record = RecordFace::of(view, outputs.as_ref());

        let stops = record.stops;
        let stops_cloud = record.stops_cloud;
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
                if stops_cloud {
                    this.stop_cloud_recording();
                } else if stops {
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
        if let Some(go_live) = GoLiveFace::of(view, outputs.as_ref()) {
            let ends = go_live.ends_livestream;
            buttons = buttons.child(
                div().flex_1().min_w_0().child(
                    Button::new("go-live-button")
                        .variant(ButtonVariant::GoLive)
                        .size(ButtonSize::Lg)
                        .disabled(go_live.disabled)
                        .label(go_live.label)
                        .when_some(go_live.reason, |button, reason| button.tooltip(reason))
                        .on_click(cx.listener(move |this, _, _, _| {
                            if ends {
                                this.stop(StopOrigin::Button);
                            } else {
                                this.go_live();
                            }
                        })),
                ),
            );
        }

        // Stop note and blocked line stay on the local session; a talk-show
        // room's cloud recording does not print "Your recording stops too."
        let local_active = view.active;
        div()
            .id("session-transport")
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(size::GUTTER))
            .border_b_1()
            .border_color(hsla(theme.border))
            .child(buttons)
            .when_some(view.stop_note.filter(|_| local_active), |section, note| {
                section.child(
                    div()
                        .id("session-stop-note")
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(note),
                )
            })
            .when_some(
                view.blocked_reason.clone().filter(|_| !local_active),
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
                                            cx.emit(OpenPage::of(jump.page))
                                        })),
                                )
                            }),
                    )
                },
            )
            // B-16: a stop that drags on says what is happening and what
            // Force stop does.
            .when(view.stop_overrun, |section| {
                section.child(
                    Alert::new("session-stop-overrun")
                        .variant(AlertVariant::Warning)
                        .title(stop_overrun_copy::TITLE)
                        .description(stop_overrun_copy::DESCRIPTION),
                )
            })
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
        let face = RecordFace::of(&idle(), None);
        assert_eq!(face.label, "Record");
        assert!(face.shortcut && !face.lit && !face.disabled && !face.stops && !face.stops_cloud);
        assert_eq!(
            GoLiveFace::of(&idle(), None),
            Some(GoLiveFace {
                label: "Go Live",
                disabled: false,
                reason: None,
                ends_livestream: false,
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
        let face = RecordFace::of(&view, None);
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
            let face = RecordFace::of(&view, None);
            assert_eq!(face.label, label);
            assert!(!face.shortcut && face.lit && face.stops);
            assert_eq!(face.reason, None, "no tooltip while a session runs");
            assert_eq!(GoLiveFace::of(&view, None), None);
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
        let go_live = GoLiveFace::of(&view, None).unwrap();
        assert!(go_live.disabled);
        assert_eq!(go_live.reason.as_deref(), Some(reason));
    }

    #[test]
    fn a_talk_show_room_keeps_go_live_and_ends_it_while_live() {
        let running = TransportView {
            active: true,
            record_state: RecordButtonState::Running,
            go_live_shown: false,
            ..idle()
        };
        let outputs = TalkShowOutputs {
            recording: true,
            live: true,
        };
        let record = RecordFace::of(&running, Some(&outputs));
        assert_eq!(record.label, "Stop recording");
        assert!(record.lit && record.stops_cloud && !record.stops);
        assert_eq!(
            record.reason.as_deref(),
            Some(STOP_CLOUD_RECORDING_UNAVAILABLE)
        );
        let go_live = GoLiveFace::of(&running, Some(&outputs)).unwrap();
        assert_eq!(go_live.label, END_LIVESTREAM_LABEL);
        assert!(go_live.ends_livestream);
    }

    #[test]
    fn an_open_room_that_is_not_live_still_shows_go_live() {
        let outputs = TalkShowOutputs {
            recording: false,
            live: false,
        };
        let go_live = GoLiveFace::of(&idle(), Some(&outputs)).unwrap();
        assert_eq!(go_live.label, "Go Live");
        assert!(!go_live.ends_livestream);
    }
}
