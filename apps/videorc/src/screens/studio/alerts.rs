//! The Studio's two alert cards (plan 260 Phase 3):
//!
//! - the watchdog's cards in the Session section (`SessionNotices`'
//!   `WatchdogAlertCard`, plan 223 A5): one `Alert` per open problem, under
//!   the Session facts and above the refused start;
//! - the cloud's Resume notice above Session (`CloudResumeSlot` and
//!   `cloud-resume-notice.tsx`, plan 184 C5 and plan 243 C5).
//!
//! Every word, tone and enabled state is app-core's
//! (`studio::screen_views`); these draw them and run the named actions. The
//! tone rides on the Alert's icon; nothing else is tinted.
//!
//! Not here yet: a solo show's Resume (`resumeCloudShow`, the session start
//! bound to the show through `cloud.show.resume`) has no app-core start, so
//! its click only says so in the log; and the talk show's own rejoin after a
//! backend restart (`talkShow.rejoining`) is not in app-core, so the notice
//! never reads "Reconnecting…".

use std::sync::Arc;

use gpui::{Context, Entity, EventEmitter, FontWeight, SharedString, Window, div, prelude::*, px};
use videorc_app_core::StudioSnapshot;
use videorc_app_core::livestream::cloud_show::NoticeTone;
use videorc_app_core::livestream::watchdog::{WatchdogAlert, WatchdogAlertFix};
use videorc_app_core::nav::PageId;
use videorc_app_core::notices::{NoticeCommand, ToastRequest};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::studio::cloud::CloudState;
use videorc_app_core::studio::inspector::{StartGates, live_stream_blocked_reason};
use videorc_app_core::studio::screen_views::{
    CardTone, CloudResumeCardView, CloudResumeInputs, END_TAKEOVER_FIX_FAILED, QuietAction,
    ResumeTarget, UNMUTE_FIX_FAILED, WatchdogCardView, WatchdogFixAction, cloud_resume_card,
    end_cloud_show_question, silence_notice_shown, watchdog_cards, watchdog_fix_action,
};
use videorc_app_core::studio::transport::transport_active;
use videorc_app_core::studio::watchdog_alerts::{SnoozeScope, WatchdogState};
use videorc_kit::kebab_menu::{KebabMenu, KebabMenuItem};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_kit::{Alert, AlertVariant, Button, ButtonSize, ButtonVariant};

use super::transport::{AppStudio, OpenPage};
use crate::screens::dialogs::{ConfirmRequest, ConfirmVariant, DialogsHost};

/// What a watchdog fix asks of the Studio page besides a page door.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioRequest {
    /// `openStudioAudio`: the door to the Microphone row on this page, not
    /// the bare tab (a card on the Studio page would open the page it is on).
    FocusAudio,
    /// The End takeover fix ran: the Takeover section reads the takeover on
    /// air again.
    TakeoverEnded,
}

/// The card's tone, on the Alert's icon.
pub fn card_variant(tone: CardTone) -> AlertVariant {
    match tone {
        CardTone::Destructive => AlertVariant::Destructive,
        CardTone::Warning => AlertVariant::Warning,
        CardTone::Default => AlertVariant::Default,
    }
}

/// The Resume notice's tone, on the Alert's icon.
pub fn notice_variant(tone: NoticeTone) -> AlertVariant {
    match tone {
        NoticeTone::Warning => AlertVariant::Warning,
        NoticeTone::Default => AlertVariant::Default,
    }
}

/// The page a watchdog fix's door opens (`runWatchdogFix`), or none for a
/// fix that runs in place.
pub fn fix_page(action: &WatchdogFixAction) -> Option<PageId> {
    match action {
        // The Takeover list is the Images page (`assets`); the chosen
        // takeover is the streamer's pick.
        WatchdogFixAction::OpenTakeovers => Some(PageId::Assets),
        // Re-applying the sources is the Scenes list's job (`layouts`).
        WatchdogFixAction::OpenScenes => Some(PageId::Layouts),
        WatchdogFixAction::OpenHealth => Some(PageId::Diagnostics),
        WatchdogFixAction::OpenLivestream => Some(PageId::Live),
        WatchdogFixAction::Unmute
        | WatchdogFixAction::EndTakeover
        | WatchdogFixAction::OpenAudio
        | WatchdogFixAction::OpenUrl(_)
        | WatchdogFixAction::ReconnectDestination(_) => None,
    }
}

/// A notice's buttons (`flex flex-wrap gap-1 pt-2`).
fn actions() -> gpui::Div {
    div().flex().flex_wrap().gap(px(4.)).pt(px(8.))
}

/// The warning toast of a fix the Studio refused (`toast.warning(message)`).
fn warning(title: &'static str) -> NoticeCommand {
    NoticeCommand::Show(ToastRequest::warning(title).finish())
}

// ---------------------------------------------------------------------------
// The watchdog's cards
// ---------------------------------------------------------------------------

/// The alerts as listed (a fix reads its alert's target) and the cards
/// they make.
fn cards_of(
    state: &WatchdogState,
    snapshot: &StudioSnapshot,
) -> (Vec<WatchdogAlert>, Vec<WatchdogCardView>) {
    (
        state.alerts.clone(),
        watchdog_cards(&state.alerts, silence_notice_shown(snapshot)),
    )
}

/// `SessionNotices`' watchdog cards, worst and oldest first. The Session
/// section draws this only while it has a card.
pub struct WatchdogCards {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    alerts: Vec<WatchdogAlert>,
    cards: Vec<WatchdogCardView>,
}

impl EventEmitter<OpenPage> for WatchdogCards {}
impl EventEmitter<StudioRequest> for WatchdogCards {}

impl WatchdogCards {
    /// Follows the watchdog's list and the snapshot (the silence notice);
    /// it redraws only when the cards change.
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut watchdog = studio.watchdog();
        let mut snapshot = studio.watch();
        let (alerts, cards) = cards_of(&watchdog.borrow(), &snapshot.borrow());
        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = watchdog.changed() => changed.is_ok(),
                    changed = snapshot.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let (alerts, cards) =
                    cards_of(&watchdog.borrow_and_update(), &snapshot.borrow_and_update());
                let alive = this.update(cx, |section, cx| {
                    if section.cards != cards || section.alerts != alerts {
                        section.alerts = alerts;
                        section.cards = cards;
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
            alerts,
            cards,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.cards.is_empty()
    }

    /// Got it (`Studio::acknowledge_watchdog_alert`), or I meant to
    /// (`Studio::snooze_watchdog_alert` for the stream).
    fn quiet(&self, id: String, action: QuietAction) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            match action {
                QuietAction::Acknowledge => studio.acknowledge_watchdog_alert(&id).await,
                QuietAction::Snooze(scope) => studio.snooze_watchdog_alert(&id, scope).await,
            }
        });
    }

    /// `runWatchdogFix`: the Studio's own actions, nothing new of its own.
    fn run_fix(&self, id: &str, fix: &WatchdogAlertFix, cx: &mut Context<Self>) {
        let Some(alert) = self.alerts.iter().find(|alert| alert.id == id) else {
            return;
        };
        let Some(action) = watchdog_fix_action(alert, fix) else {
            return;
        };
        if let Some(page) = fix_page(&action) {
            cx.emit(OpenPage::of(page));
            return;
        }
        let studio = self.studio.clone();
        match action {
            // The deck's `micUnmute`.
            WatchdogFixAction::Unmute => {
                self.runtime.spawn(async move {
                    if !studio.request_microphone_mute(false).await {
                        studio.post_notices(vec![warning(UNMUTE_FIX_FAILED)]);
                    }
                });
            }
            // The deck's `takeoverHide`: `screens.clear`, as the Takeover
            // section's own click; then that section reads it again.
            WatchdogFixAction::EndTakeover => {
                let cleared = self.runtime.spawn(async move {
                    if let Err(error) = studio.backend().screens_clear().await {
                        eprintln!("[videorc-app] Watchdog end takeover: {error}");
                        studio.post_notices(vec![warning(END_TAKEOVER_FIX_FAILED)]);
                    }
                });
                cx.spawn(async move |this, cx| {
                    let _ = cleared.await;
                    this.update(cx, |_, cx| cx.emit(StudioRequest::TakeoverEnded))
                        .ok();
                })
                .detach();
            }
            WatchdogFixAction::OpenAudio => cx.emit(StudioRequest::FocusAudio),
            WatchdogFixAction::OpenUrl(url) => cx.open_url(&url),
            WatchdogFixAction::ReconnectDestination(target_id) => {
                self.runtime.spawn(async move {
                    studio.reconnect_watchdog_destination(&target_id).await;
                });
            }
            WatchdogFixAction::OpenTakeovers
            | WatchdogFixAction::OpenScenes
            | WatchdogFixAction::OpenHealth
            | WatchdogFixAction::OpenLivestream => {}
        }
    }

    fn fix_button(
        &self,
        alert_id: &str,
        fix: &WatchdogAlertFix,
        variant: ButtonVariant,
        cx: &mut Context<Self>,
    ) -> Button {
        let id = alert_id.to_string();
        let target = fix.clone();
        Button::new(SharedString::from(format!(
            "watchdog-alert-fix-{alert_id}-{}",
            fix.kind
        )))
        .label(fix.label.clone())
        .variant(variant)
        .size(ButtonSize::Xs)
        .on_click(cx.listener(move |this, _, _, cx| this.run_fix(&id, &target, cx)))
    }

    /// `WatchdogAlertCard`: the backend's title with the kebab on its line,
    /// the detail, the cloud's source line, then the fixes and the quiet
    /// button.
    fn card(&self, card: &WatchdogCardView, muted: gpui::Hsla, cx: &mut Context<Self>) -> Alert {
        let mut row = actions();
        if let Some(fix) = &card.primary_fix {
            row = row.child(self.fix_button(&card.id, fix, ButtonVariant::Default, cx));
        }
        for fix in &card.more_fixes {
            row = row.child(self.fix_button(&card.id, fix, ButtonVariant::Ghost, cx));
        }
        if let Some(quiet) = &card.quiet {
            let id = card.id.clone();
            let action = quiet.action;
            row = row.child(
                Button::new(SharedString::from(format!(
                    "watchdog-alert-quiet-{}",
                    card.id
                )))
                .label(quiet.label)
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .disabled(!quiet.enabled)
                .on_click(cx.listener(move |this, _, _, _| this.quiet(id.clone(), action))),
            );
        }
        let body = div()
            .min_w_0()
            .child(div().child(card.detail.clone()))
            .when_some(card.source_line, |body, line| {
                // `text-[11px] text-muted-foreground`: the label size in
                // regular weight.
                body.child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(FontWeight::NORMAL)
                        .text_color(muted)
                        .child(line),
                )
            })
            .child(row);
        let alert = Alert::new(SharedString::from(format!("watchdog-alert-{}", card.id)))
            .variant(card_variant(card.tone))
            .title(card.title.clone())
            .description(body);
        let Some(snooze) = &card.snooze else {
            return alert;
        };
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let id = card.id.clone();
        let scope: SnoozeScope = snooze.scope;
        let item = KebabMenuItem::new("snooze", snooze.label, move |_, _| {
            let studio = studio.clone();
            let id = id.clone();
            runtime.spawn(async move { studio.snooze_watchdog_alert(&id, scope).await });
        });
        alert.action(
            KebabMenu::new(
                SharedString::from(format!("watchdog-alert-more-{}", card.id)),
                vec![item],
            )
            .label(snooze.menu_label.clone()),
        )
    }
}

impl Render for WatchdogCards {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let muted = hsla(theme.muted_foreground);
        let cards: Vec<Alert> = self
            .cards
            .iter()
            .map(|card| self.card(card, muted, cx))
            .collect();
        // The Session section's own gap between its notices.
        div()
            .id("watchdog-alerts")
            .flex()
            .flex_col()
            .gap(px(12.))
            .children(cards)
    }
}

// ---------------------------------------------------------------------------
// The cloud's Resume notice
// ---------------------------------------------------------------------------

/// `CloudResumeSlot`'s inputs from the cloud's status and the snapshot.
pub fn resume_card_of(
    cloud: &CloudState,
    snapshot: &StudioSnapshot,
) -> Option<CloudResumeCardView> {
    let blocked = live_stream_blocked_reason(snapshot, &StartGates::default());
    cloud_resume_card(CloudResumeInputs {
        status: cloud.status.as_ref(),
        session_active: transport_active(&snapshot.session),
        // `talkShow.rejoining`: back in the room by itself after a backend
        // restart (`Studio::drive`'s rejoin).
        talk_rejoining: cloud.talk_rejoining,
        // `startsBusy`: a start in flight (Go Live's checks are not in
        // app-core, as for the transport).
        pending: snapshot.session.start_pending,
        blocked_reason: blocked.as_deref(),
    })
}

/// "You're still live through Videorc Cloud." above Session, while a show
/// is live on our servers and this computer isn't feeding it.
pub struct CloudResumeSlot {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    card: Option<CloudResumeCardView>,
    /// The shell's dialogs: End livestream asks there first.
    dialogs: Option<Entity<DialogsHost>>,
}

impl CloudResumeSlot {
    /// Follows the cloud's status and the snapshot; it redraws only when
    /// the notice changes.
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut cloud = studio.cloud();
        let mut snapshot = studio.watch();
        let card = resume_card_of(&cloud.borrow(), &snapshot.borrow());
        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = cloud.changed() => changed.is_ok(),
                    changed = snapshot.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let next =
                    resume_card_of(&cloud.borrow_and_update(), &snapshot.borrow_and_update());
                let alive = this.update(cx, |slot, cx| {
                    if slot.card != next {
                        slot.card = next;
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
            card,
            dialogs: None,
        }
    }

    pub fn bind_dialogs(&mut self, dialogs: Entity<DialogsHost>) {
        self.dialogs = Some(dialogs);
    }

    /// Resume or Continue here: a talk show rejoins its room; a solo show
    /// starts again bound to the live show (`cloud.show.resume`). Never Go
    /// Live: no dialog, no preflight, no broadcast.
    fn resume(&self) {
        let Some(card) = &self.card else {
            return;
        };
        if !card.resume_enabled {
            return;
        }
        match card.resume_target {
            ResumeTarget::Room => {
                let studio = self.studio.clone();
                self.runtime
                    .spawn(async move { studio.resume_talk_room().await });
            }
            ResumeTarget::CloudShow => {
                let studio = self.studio.clone();
                self.runtime.spawn(async move {
                    studio.resume_cloud_show().await;
                });
            }
        }
    }

    /// End livestream: the same question every in-app stop asks, then
    /// `Studio::end_cloud_show`. Both answers wait while it ends.
    fn ask_end(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialogs) = self.dialogs.clone() else {
            eprintln!("[videorc-app] End livestream: the dialogs are not bound");
            return;
        };
        let ask = end_cloud_show_question(false);
        let ending = end_cloud_show_question(true);
        let question = ConfirmRequest {
            title: ask.title.to_string(),
            description: ask.description.to_string(),
            cancel_label: ask.cancel_label.to_string(),
            confirm_label: ask.confirm_label.to_string(),
            confirm_variant: ConfirmVariant::Destructive,
            pending_label: Some(ending.confirm_label.to_string()),
        };
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        dialogs.update(cx, |host, cx| {
            host.ask_confirm(
                question,
                move |host, window, cx| {
                    host.set_confirm_pending(true, cx);
                    let ended = runtime.spawn(async move { studio.end_cloud_show().await });
                    cx.spawn_in(window, async move |this, cx| {
                        let _ = ended.await;
                        let _ =
                            this.update_in(cx, |host, window, cx| host.finish_confirm(window, cx));
                    })
                    .detach();
                },
                window,
                cx,
            )
        });
    }
}

impl Render for CloudResumeSlot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(card) = self.card.clone() else {
            return div().id("cloud-resume-slot").into_any_element();
        };
        let theme = theme::resolve(None, window, cx);
        let resume = Button::new("cloud-resume")
            .label(card.resume_label)
            .variant(ButtonVariant::Default)
            .size(ButtonSize::Xs)
            .disabled(!card.resume_enabled)
            .when_some(card.resume_hover.clone(), |button, reason| {
                button.tooltip(reason)
            })
            .on_click(cx.listener(|this, _, _, _| this.resume()));
        let end = Button::new("cloud-end")
            .label(card.end_label)
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
            .disabled(!card.end_enabled)
            .on_click(cx.listener(|this, _, window, cx| this.ask_end(window, cx)));
        let body = div()
            .min_w_0()
            .when_some(card.notice.detail.clone(), |body, detail| {
                body.child(div().child(detail))
            })
            .when_some(card.notice.pointer, |body, pointer| {
                body.child(div().id("cloud-continue-pointer").child(pointer))
            })
            .child(actions().child(resume).child(end));
        div()
            .id("cloud-resume-slot")
            .p(px(size::GUTTER))
            .border_b_1()
            .border_color(hsla(theme.border))
            .child(
                Alert::new("cloud-resume-notice")
                    .variant(notice_variant(card.notice.tone))
                    .title(card.notice.title.clone())
                    .description(body),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tone_is_the_alerts_icon_only() {
        assert_eq!(
            card_variant(CardTone::Destructive),
            AlertVariant::Destructive
        );
        assert_eq!(card_variant(CardTone::Warning), AlertVariant::Warning);
        assert_eq!(card_variant(CardTone::Default), AlertVariant::Default);
        assert_eq!(notice_variant(NoticeTone::Warning), AlertVariant::Warning);
        assert_eq!(notice_variant(NoticeTone::Default), AlertVariant::Default);
    }

    #[test]
    fn the_doors_open_electrons_pages_and_the_rest_run_in_place() {
        assert_eq!(
            fix_page(&WatchdogFixAction::OpenTakeovers),
            Some(PageId::Assets)
        );
        assert_eq!(
            fix_page(&WatchdogFixAction::OpenScenes),
            Some(PageId::Layouts)
        );
        assert_eq!(
            fix_page(&WatchdogFixAction::OpenHealth),
            Some(PageId::Diagnostics)
        );
        assert_eq!(
            fix_page(&WatchdogFixAction::OpenLivestream),
            Some(PageId::Live)
        );
        for action in [
            WatchdogFixAction::Unmute,
            WatchdogFixAction::EndTakeover,
            WatchdogFixAction::OpenAudio,
            WatchdogFixAction::OpenUrl("https://studio.youtube.com".into()),
            WatchdogFixAction::ReconnectDestination("yt".into()),
        ] {
            assert_eq!(fix_page(&action), None, "{action:?}");
        }
    }
}
