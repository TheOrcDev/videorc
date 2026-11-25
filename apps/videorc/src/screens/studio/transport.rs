//! The Studio's session controls (P147–P157; `session-panel.tsx`
//! `SessionTransport`), moved here from S2.4's `app/session.rs`. The view
//! reads the Studio driver's snapshot through the store bridge and calls the
//! driver on the core's runtime; it decides nothing itself. The words, the
//! states and what each click does are the core's (`studio::transport`,
//! `Studio::start_recording`, `Studio::start_livestream`,
//! `Studio::request_stop`).
//!
//! While a talk-show room is open (P123, P151), Record and Go Live follow
//! `talkShowOutputs`: cloud recording and the room's live legs. Stop recording
//! stops the cloud recording (`Studio::stop_cloud_recording`).
//!
//! No state word or clock here (plan 235 D1): those are the status bar's.
//! Go Live opens the confirmation dialog (`studio::go_live::open_go_live`);
//! End livestream is the shell's dialog (`screens::dialogs`, P1436–P1439).

use std::sync::Arc;

use gpui::{
    AnyElement, Context, Entity, EventEmitter, FontWeight, Keystroke, SharedString, Window, div,
    prelude::*, px,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::studio::cloud::CloudState;
use videorc_app_core::studio::inspector::StartGates;
use videorc_app_core::studio::screen_views::{
    STOP_CLOUD_RECORDING_LABEL, STOPPING_LABEL, TalkShowOutputs, TalkShowRoomView,
    talk_show_room_in,
};
use videorc_app_core::studio::session::{END_LIVESTREAM_LABEL, StopConfirmation};
use videorc_app_core::studio::transport::{RecordButtonState, TransportView, stop_overrun_copy};
use videorc_app_core::{BackendClient, StopOrigin, Studio, StudioSnapshot};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::shortcut_keys;
use videorc_kit::theme::{self, TypeScale, faded_over, hsla};
use videorc_kit::tokens::{size, text};
use videorc_kit::{Alert, AlertVariant, Button, ButtonSize, ButtonVariant, ShortcutKeys};

use super::space::SPACE;
use crate::app::bridge::Mirror;
use crate::lcd;

/// The Studio the app drives: the core's driver on the typed client.
pub type AppStudio = Studio<BackendClient>;

/// What the transport draws, mapped from one snapshot (pure, so the bridge
/// notifies only when one of these changed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionControls {
    pub transport: TransportView,
    /// The End livestream question, while it waits.
    pub stop_question: Option<StopConfirmation>,
    /// Settings → General → Retro LCD: the transport draws as LCD keys.
    pub retro: bool,
}

impl SessionControls {
    pub fn of(snapshot: &StudioSnapshot) -> Self {
        Self {
            // The entitlement, destination and topology gates are inputs the
            // app doesn't hold yet (S1.6c, #1814); none of them is on.
            transport: TransportView::from_snapshot(snapshot, &StartGates::default(), false),
            stop_question: snapshot.session.stop_confirmation.clone(),
            retro: snapshot.settings.studio.retro_lcd_studio(),
        }
    }
}

/// The talk-show room as the transport and the Preview stage read it.
pub fn talk_show_of(cloud: &CloudState) -> TalkShowRoomView {
    talk_show_room_in(cloud)
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
    /// A click stops the talk-show cloud recording.
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
                // Room open + cloud recording: "Stop recording", lit, and
                // "Stopping…" while its request is out (Electron keeps it
                // clickable; the core ignores a second click).
                return Self {
                    label: if outputs.stopping {
                        STOPPING_LABEL
                    } else {
                        STOP_CLOUD_RECORDING_LABEL
                    },
                    shortcut: false,
                    lit: true,
                    disabled: false,
                    stops: false,
                    stops_cloud: true,
                    reason: None,
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
/// jump). `settings_tab` opens Settings on that tab (Permissions, …);
/// `scene_background` opens Scene on the camera's Background (P575).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPage {
    pub page: PageId,
    pub settings_tab: Option<SettingsTab>,
    pub scene_background: bool,
}

impl OpenPage {
    pub const fn of(page: PageId) -> Self {
        Self {
            page,
            settings_tab: None,
            scene_background: false,
        }
    }

    /// Background settings (Electron `openSceneBackground`): Scene, the
    /// camera selected and its Background in view.
    pub const fn scene_background() -> Self {
        Self {
            page: PageId::Layouts,
            settings_tab: None,
            scene_background: true,
        }
    }

    pub const fn settings(tab: SettingsTab) -> Self {
        Self {
            page: PageId::Settings,
            settings_tab: Some(tab),
            scene_background: false,
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

    /// The Studio the transport drives, for the page's own watchers (the
    /// preview's health alert and the check's line).
    pub fn studio(&self) -> Arc<AppStudio> {
        self.studio.clone()
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

    /// `talkShow.stopCloudRecording`: `cloud.recording.stop`; a stop that
    /// did not happen is the core's toast.
    fn stop_cloud_recording(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let stopped = studio.stop_cloud_recording().await;
            eprintln!("[videorc-app] Stop cloud recording: stopped={stopped}");
        });
    }
}

/// The glyph before a transport button's words (`record-button.tsx`,
/// `go-live-button.tsx`): Record or Broadcast while it starts, Stop once it
/// stops a session, all at Phosphor's fill weight (`record-button.tsx:80`,
/// `go-live-button.tsx:74`, `retro-lcd-studio.tsx:138,157`).
fn record_glyph(face: &RecordFace) -> IconName {
    if face.shortcut {
        IconName::RecordFill
    } else {
        IconName::StopFill
    }
}

fn go_live_glyph(face: &GoLiveFace) -> IconName {
    if face.ends_livestream {
        IconName::StopFill
    } else {
        IconName::BroadcastFill
    }
}

/// Space's chip on Record. The page binds [`SPACE`] to `ToggleRecord` in its
/// own key context, which the keymap only reports while the page holds the
/// focus, so the chip reads the same constant the binding is made from.
fn space_keys() -> ShortcutKeys {
    ShortcutKeys::keystrokes(SPACE)
}

/// Space on the retro Record key, in the screen's caps: Electron's LCD
/// uppercases everything on it, the `ShortcutKeys variant="text"` too
/// ("RECORD SPACE"). The words are the kit's, only the case is the screen's.
fn retro_space_label() -> SharedString {
    let words = Keystroke::parse(SPACE)
        .map(|stroke| {
            shortcut_keys::label(
                [(stroke.modifiers, stroke.key.as_str())],
                cfg!(target_os = "macos"),
            )
        })
        .unwrap_or_default();
    lcd::caps(words)
}

impl Transport {
    fn render_default(
        &self,
        theme: &videorc_kit::tokens::Theme,
        view: &TransportView,
        outputs: Option<&TalkShowOutputs>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = hsla(theme.muted_foreground);
        let record = RecordFace::of(view, outputs);
        let stops = record.stops;
        let stops_cloud = record.stops_cloud;
        // The glyph takes the metal's ink, pre-blended like the words when
        // the button is off.
        let ink = |color, disabled: bool| {
            hsla(if disabled {
                faded_over(color, theme.glass_solid, 0.5)
            } else {
                color
            })
        };
        let record_ink = theme.live_foreground;
        let record_button = Button::new("session-record")
            .variant(ButtonVariant::Record)
            .size(ButtonSize::Lg)
            .lit(record.lit)
            .disabled(record.disabled)
            .accessibility_label(record.label)
            .child(icon(
                record_glyph(&record),
                16.,
                ink(record_ink, record.disabled),
            ))
            .child(record.label)
            // `ml-0.5` beside the words.
            .when(record.shortcut, |button| {
                button.child(div().ml(px(2.)).child(space_keys().on_filled(record_ink)))
            })
            .when_some(record.reason.clone(), |button, reason| {
                button.tooltip(reason)
            })
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
        if let Some(go_live) = GoLiveFace::of(view, outputs) {
            let ends = go_live.ends_livestream;
            let glyph = go_live_glyph(&go_live);
            buttons = buttons.child(
                div().flex_1().min_w_0().child(
                    Button::new("go-live-button")
                        .variant(ButtonVariant::GoLive)
                        .size(ButtonSize::Lg)
                        .disabled(go_live.disabled)
                        .accessibility_label(go_live.label)
                        .child(icon(
                            glyph,
                            16.,
                            ink(theme.chrome_copper_ink, go_live.disabled),
                        ))
                        .child(go_live.label)
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
            .when_some(
                view.stop_note.clone().filter(|_| local_active),
                |section, note| {
                    section.child(
                        div()
                            .id("session-stop-note")
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(note),
                    )
                },
            )
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
            .when(view.stop_overrun, |section| {
                section.child(
                    Alert::new("session-stop-overrun")
                        .variant(AlertVariant::Warning)
                        .title(stop_overrun_copy::TITLE)
                        .description(stop_overrun_copy::DESCRIPTION),
                )
            })
            .into_any_element()
    }

    /// Retro LCD transport (P233–P237): Record / Go Live / Stop as keys on
    /// one screen, with the stop note and blocked line as screen messages.
    fn render_retro(
        &self,
        theme: &videorc_kit::tokens::Theme,
        view: &TransportView,
        outputs: Option<&TalkShowOutputs>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let record = RecordFace::of(view, outputs);
        let stops = record.stops;
        let stops_cloud = record.stops_cloud;
        let go_live = GoLiveFace::of(view, outputs);
        let local_active = view.active;
        let talk_show = outputs.is_some();

        let record_ink = lcd::record_tone(theme);
        let ink = lcd::lit(theme);
        let keys = if local_active && !talk_show {
            // Single stop key while a local session holds the transport.
            div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .py(px(8.))
                .child(lcd::key(
                    "session-record",
                    theme,
                    record.label,
                    lcd::KeyTone::Record,
                    record.disabled,
                    Some(icon(IconName::StopFill, 14., record_ink).into_any_element()),
                    None,
                    cx.listener(move |this, _, _, _| this.stop(StopOrigin::Button)),
                ))
        } else {
            // `ShortcutKeys variant="text"` at 70 %: the key in the key's
            // own ink, quieter than its words.
            let shortcut = record.shortcut.then(|| {
                div()
                    .opacity(0.7)
                    .font_weight(FontWeight::MEDIUM)
                    .child(retro_space_label())
                    .into_any_element()
            });
            let record_icon = record_glyph(&record);
            let mut row = div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .py(px(8.))
                .child(lcd::key(
                    "session-record",
                    theme,
                    record.label,
                    lcd::KeyTone::Record,
                    record.disabled,
                    Some(icon(record_icon, 14., record_ink).into_any_element()),
                    shortcut,
                    cx.listener(move |this, _, _, _| {
                        if stops_cloud {
                            this.stop_cloud_recording();
                        } else if stops {
                            this.stop(StopOrigin::Button);
                        } else {
                            this.record();
                        }
                    }),
                ));
            if let Some(go_live) = go_live {
                let ends = go_live.ends_livestream;
                let glyph = go_live_glyph(&go_live);
                row = row.child(lcd::key(
                    "go-live-button",
                    theme,
                    go_live.label,
                    lcd::KeyTone::Ink,
                    go_live.disabled,
                    Some(icon(glyph, 14., ink).into_any_element()),
                    None,
                    cx.listener(move |this, _, _, _| {
                        if ends {
                            this.stop(StopOrigin::Button);
                        } else {
                            this.go_live();
                        }
                    }),
                ));
            }
            row
        };

        let mut screen = div().flex().flex_col().child(keys);
        if let Some(note) = view.stop_note.clone().filter(|_| local_active) {
            screen = screen.child(lcd::message(theme, note));
        }
        if let Some(reason) = view.blocked_reason.clone().filter(|_| !local_active) {
            let jump = view.blocked_jump;
            let mut blocked = div()
                .id("session-blocked-reason")
                .flex()
                .flex_col()
                .items_start()
                .gap(px(4.))
                .child(lcd::message(theme, reason));
            if let Some(jump) = jump {
                blocked = blocked.child(lcd::action_button(
                    "session-blocked-jump",
                    theme,
                    jump.label,
                    cx.listener(move |_, _, _, cx| cx.emit(OpenPage::of(jump.page))),
                ));
            }
            screen = screen.child(blocked);
        }

        div()
            .id("session-transport")
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(size::GUTTER))
            .border_b_1()
            .border_color(hsla(theme.border))
            .child(lcd::panel(
                "studio-lcd-transport",
                theme,
                "Session controls",
                screen,
            ))
            .when(view.stop_overrun, |section| {
                section.child(
                    Alert::new("session-stop-overrun")
                        .variant(AlertVariant::Warning)
                        .title(stop_overrun_copy::TITLE)
                        .description(stop_overrun_copy::DESCRIPTION),
                )
            })
            .into_any_element()
    }
}

impl Render for Transport {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let controls = self.controls.read(cx).value().clone();
        let view = &controls.transport;
        let outputs = self.talk_show.read(cx).value().transport_outputs();
        if controls.retro {
            self.render_retro(&theme, view, outputs.as_ref(), cx)
        } else {
            self.render_default(&theme, view, outputs.as_ref(), cx)
        }
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
            stopping: false,
        };
        let record = RecordFace::of(&running, Some(&outputs));
        assert_eq!(record.label, "Stop recording");
        assert!(record.lit && record.stops_cloud && !record.stops && !record.disabled);
        assert_eq!(record.reason, None);
        let stopping = RecordFace::of(
            &running,
            Some(&TalkShowOutputs {
                stopping: true,
                ..outputs.clone()
            }),
        );
        assert_eq!(stopping.label, STOPPING_LABEL);
        assert!(stopping.lit && stopping.stops_cloud && !stopping.disabled);
        let go_live = GoLiveFace::of(&running, Some(&outputs)).unwrap();
        assert_eq!(go_live.label, END_LIVESTREAM_LABEL);
        assert!(go_live.ends_livestream);
    }

    #[test]
    fn an_open_room_that_is_not_live_still_shows_go_live() {
        let outputs = TalkShowOutputs {
            recording: false,
            live: false,
            stopping: false,
        };
        let go_live = GoLiveFace::of(&idle(), Some(&outputs)).unwrap();
        assert_eq!(go_live.label, "Go Live");
        assert!(!go_live.ends_livestream);
    }
}
