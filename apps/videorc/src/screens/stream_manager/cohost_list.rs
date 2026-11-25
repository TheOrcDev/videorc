//! The Co-host pane's body (P1256–P1274; `components/cohost-pane.tsx`,
//! `cohost-question-row.tsx`, `cohost-flag-row.tsx`, `cohost-nudge.tsx`,
//! `cohost-status.tsx`): the Premium and cloud-AI notices, viewers'
//! alerts, the chat's weather, the triage list with its action bar, and
//! the cards under it (answered on air, Say hi, Welcome back, promises,
//! the recap). The status pill sits in the pane's header, the nudge under
//! the chat composer.

use chrono::{DateTime, Utc};
use gpui::{AnyElement, Div, SharedString, Stateful, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy::VIEW_PREMIUM;
use videorc_app_core::chat::arrival::{ArrivalChipKind, arrival_chip};
use videorc_app_core::format::format_relative_time;
use videorc_app_core::stream_manager::buddy::{
    ACTS_ON_ASK_HINT, CLOUD_AI_KEEPS, CohostFlag, CohostQuestion, CohostRecentlyResolved, PaneMode,
    PresenceKind, RowKey, active_alerts, active_recap, active_spotlight, acts_on_ask_copy,
    alert_label, answered_on_air, askers_label, cloud_ai_uses, empty_state_copy, error_detail_text,
    flag_action_label, flag_chip_label, flag_detail, flag_row_key, highlight_message_id, pane_mode,
    pane_rows, presence_view, priority_label, promise_trigger_label, question_row_key,
    resolve_selection, sorted_flags, sorted_questions, weather, words as pane_words,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::chat_platform::ChatPlatform;
use videorc_kit::chrome::focus_ring;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::platform_glyph::PlatformMark;
use videorc_kit::separator::Separator;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, radius, size, text};
use videorc_kit::tooltip::tooltip;

use super::cohost::{
    ANSWERED_KEY, DISMISS_KEY, DismissRow, LIST_CONTEXT, MarkRowAnswered, OPEN_KEY, OpenRow,
    REMOVE_FLAGGED_KEY, REPLY_KEY, RemoveFlagged, ReplyToRow, SHOW_KEY, SelectNext, SelectPrevious,
    ShowRowOnStream,
};
use super::sidekick::SidekickPane;

/// The status pill's widest (`max-w-40`).
const STATUS_MAX_W: f32 = 160.;
/// A platform mark in a row (`ChatPlatformIcon`, `size-3.5`).
const MARK_PX: f32 = 14.;
/// The arrival chip's icon (`badge.tsx`'s `[&>svg]:size-3`).
const CHIP_ICON_PX: f32 = 12.;
/// The askers' widest (`max-w-32`).
const ASKERS_MAX_W: f32 = 128.;

/// A chat platform's mark (`ChatPlatformIcon`).
fn platform(id: &str) -> ChatPlatform {
    match id {
        "youtube" => ChatPlatform::Youtube,
        "twitch" => ChatPlatform::Twitch,
        "x" => ChatPlatform::X,
        "facebook" => ChatPlatform::Facebook,
        "tiktok" => ChatPlatform::Tiktok,
        "instagram" => ChatPlatform::Instagram,
        "kick" => ChatPlatform::Kick,
        _ => ChatPlatform::Custom,
    }
}

/// `ChatPlatformIcon`: YouTube's official mark (never under 20 px, with its
/// `mr-1` clear space), every other platform its glyph in the brand tint.
fn mark(id: &str) -> AnyElement {
    let platform = platform(id);
    let glyph = PlatformMark::new(platform).size(MARK_PX);
    if platform == ChatPlatform::Youtube {
        div().flex_none().mr(px(4.)).child(glyph).into_any_element()
    } else {
        glyph.into_any_element()
    }
}

/// 11 px words (`text-[11px]`).
fn small(element: Div) -> Div {
    element.text_size(px(11.)).line_height(px(16.))
}

/// A card's heading (`text-[11px] font-semibold text-subtle`), with its
/// hint on hover.
fn heading(id: &'static str, words: &'static str, hint: &'static str, t: &Theme) -> AnyElement {
    div()
        .id(id)
        .px(px(8.))
        .pt(px(6.))
        .pb(px(2.))
        .type_scale(text::LABEL)
        .text_color(hsla(t.subtle))
        .tooltip(tooltip(hint))
        .child(words)
        .into_any_element()
}

/// A 28 px card row (`h-7`).
fn card_row(id: impl Into<gpui::ElementId>) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(size::ROW_COMPACT))
        .min_w(px(0.))
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(8.))
        .type_scale(text::META)
}

fn ghost(id: impl Into<gpui::ElementId>, label: impl Into<SharedString>) -> Button {
    Button::new(id)
        .label(label)
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::Xs)
}

/// A question row's place in the list.
struct RowFacts {
    key: String,
    selected: bool,
    /// The streamer is talking about it (the spotlight).
    talking: bool,
    /// Its message is on stream now.
    on_stream: bool,
}

/// An age chip's words: "now", "4m", or nothing for a time that won't read.
fn age(iso: &str, now: DateTime<Utc>) -> Option<String> {
    Some(format_relative_time(iso, now)).filter(|age| !age.is_empty())
}

impl SidekickPane {
    /// The status pill (`CohostStatus`): the dot, the one status word (or
    /// the "grouped 2 questions" flash) and the facts on hover. With the
    /// list on screen it takes you there.
    pub(super) fn cohost_status(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let live = self.chat_session().is_some();
        let view = presence_view(Some(&self.state), Utc::now(), self.cohost_starting(live));
        let label = self
            .cohost
            .flash
            .clone()
            .unwrap_or_else(|| view.label.clone());
        let mut lines = vec![label.clone()];
        lines.extend(view.tooltip_lines.iter().cloned());
        let tone = match view.dot_tone {
            "live" => StatusTone::Good,
            "destructive" => StatusTone::Error,
            _ => StatusTone::Neutral,
        };
        let words = if view.kind == PresenceKind::Off {
            t.subtle
        } else {
            t.muted_foreground
        };
        let opens = live && self.cohost.gate.is_some();
        div()
            .id("cohost-status")
            .flex()
            .flex_shrink(1.)
            .min_w(px(0.))
            .max_w(px(STATUS_MAX_W))
            .items_center()
            .gap(px(6.))
            .px(px(6.))
            .py(px(2.))
            .rounded(px(radius::CHIP))
            .type_scale(text::META)
            .aria_label(label.clone())
            .tooltip(tooltip(lines.join("\n")))
            .child(
                StatusDot::new("cohost-presence-dot")
                    .tone(tone)
                    .pulse(view.pulse),
            )
            .child(
                div()
                    .min_w(px(0.))
                    .truncate()
                    .text_color(hsla(words))
                    .child(label),
            )
            .when(opens, |pill| {
                pill.hover(|style| style.bg(hsla(t.accent)))
                    .on_click(cx.listener(|pane, _, window, cx| pane.focus_list(window, cx)))
            })
            .into_any_element()
    }

    /// The off-but-useful nudge (`CohostNudge`): live, allowed, consented,
    /// and Sidekick Live simply off. It sits under the chat composer.
    pub(super) fn cohost_nudge(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.nudge_visible(self.chat_session().as_deref()) {
            return None;
        }
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        Some(
            small(div())
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .py(px(4.))
                .text_color(muted)
                .child(icon(IconName::UserSound, 16., muted))
                .child(div().flex_1().min_w(px(0.)).child(pane_words::NUDGE))
                .child(
                    ghost("cohost-nudge-turn-on", pane_words::TURN_ON).on_click(
                        cx.listener(|pane, _, window, cx| pane.nudge_turn_on(window, cx)),
                    ),
                )
                .child(
                    ghost("cohost-nudge-dismiss", pane_words::DISMISS)
                        .on_click(cx.listener(|pane, _, _, cx| pane.nudge_dismiss(cx))),
                )
                .into_any_element(),
        )
    }

    /// The pane's body under its header and cards (`CohostPane`): `None`
    /// until the Premium gate is read or while no live chat runs
    /// (`cohostVisible`), when the pane's empty state shows instead.
    pub(super) fn cohost_body(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.chat_session()?;
        let mode = pane_mode(
            self.cohost.pane_gate()?,
            self.consented,
            self.settings.enabled,
        );
        let t = theme::resolve(None, window, cx);
        let now = Utc::now();
        let welcome_back = self.welcome_back_list(now, t, cx);
        let body = div()
            .id("cohost-pane")
            .flex_1()
            .min_h(px(0.))
            .flex()
            .flex_col();
        Some(match mode {
            // Notices are flush Alerts (plan 174 F-14): the Premium lock
            // with its one action.
            PaneMode::Upsell {
                reason,
                upgrade_url,
            } => {
                let mut alert = Alert::new("cohost-upsell")
                    .variant(AlertVariant::Locked)
                    .title(reason);
                if let Some(url) = upgrade_url {
                    alert = alert.action(
                        Button::new("cohost-view-premium")
                            .label(VIEW_PREMIUM)
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
                body.child(div().flex_none().p(px(8.)).child(alert))
                    .children(welcome_back)
                    .into_any_element()
            }
            // The whole cloud-AI disclosure and an action that opens the
            // consent dialog. Nothing is granted by this click.
            PaneMode::Consent => body
                .child(
                    div()
                        .flex_none()
                        .p(px(8.))
                        .child(self.consent_notice(t, cx)),
                )
                .children(welcome_back)
                .into_any_element(),
            // Sidekick Live off: the header's switch already says so.
            PaneMode::Disabled => body.children(welcome_back).into_any_element(),
            PaneMode::Live => self.live_body(body, welcome_back, now, window, t, cx),
        })
    }

    fn consent_notice(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let muted = hsla(t.muted_foreground);
        let uses = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .children(cloud_ai_uses().into_iter().map(|line| {
                div()
                    .flex()
                    .gap(px(6.))
                    .child(div().flex_none().child("•"))
                    .child(div().flex_1().min_w(px(0.)).child(line))
            }));
        let description = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .type_scale(text::META)
            .child(uses)
            .child(div().text_color(muted).child(CLOUD_AI_KEEPS))
            .child(
                div().pt(px(2.)).child(
                    Button::new("cohost-allow-cloud-ai")
                        .label(pane_words::ALLOW_CLOUD_AI)
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::Xs)
                        .on_click(
                            cx.listener(|pane, _, window, cx| pane.set_live(true, window, cx)),
                        ),
                ),
            );
        Alert::new("cohost-consent")
            .icon(icon(IconName::UserSound, 16., muted))
            .title(pane_words::NEEDS_CLOUD_AI)
            .description(description)
            .into_any_element()
    }

    fn live_body(
        &mut self,
        body: Stateful<Div>,
        welcome_back: Option<AnyElement>,
        now: DateTime<Utc>,
        window: &mut Window,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = hsla(t.muted_foreground);
        let subtle = hsla(t.subtle);
        let pending = self.cohost.pending;

        // Viewers saying something is broken (plan 174 F-7): a flush
        // warning row, never a toast.
        let alerts = active_alerts(&self.state, now);
        let alerts = (!alerts.is_empty()).then(|| {
            div()
                .flex()
                .flex_none()
                .flex_col()
                .gap(px(4.))
                .px(px(8.))
                .pt(px(8.))
                .children(alerts.iter().enumerate().map(|(index, alert)| {
                    Alert::new(("cohost-alert", index))
                        .variant(AlertVariant::Warning)
                        .title(alert_label(alert))
                        .description(div().child(pane_words::TREND_DETAIL))
                }))
        });

        // The chat's weather, one quiet line: its mood, a partial pass, and
        // what you are talking about.
        let climate = weather(&self.state).join(" · ");
        let topic = self
            .state
            .topic
            .as_deref()
            .map(str::trim)
            .filter(|topic| !topic.is_empty())
            .map(str::to_string);
        let weather_line = (!climate.is_empty() || topic.is_some()).then(|| {
            small(div())
                .flex()
                .flex_none()
                .gap(px(4.))
                .px(px(10.))
                .py(px(4.))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_color(muted)
                .when(!climate.is_empty(), |line| line.child(climate.clone()))
                .when(!climate.is_empty() && topic.is_some(), |line| {
                    line.child("·")
                })
                .when_some(topic.clone(), |line, topic| {
                    line.child(div().text_color(subtle).child(pane_words::TALKING_ABOUT))
                        .child(div().min_w(px(0.)).truncate().child(topic))
                })
        });

        // The failed tick in the server's own words, so "AI error" is never
        // the whole story.
        let error = matches!(self.state.status.as_str(), "error" | "paused")
            .then(|| error_detail_text(self.state.detail.as_ref()))
            .flatten()
            .map(|detail| {
                small(div())
                    .id("cohost-error-detail")
                    .flex_none()
                    .px(px(10.))
                    .py(px(4.))
                    .truncate()
                    .text_color(muted)
                    .tooltip(tooltip(detail.clone()))
                    .child(detail)
            });

        let list = self.triage_list(now, window, t, cx);
        let answered = self.answered_card(now, pending, t, cx);
        let say_hi = self.say_hi_list(now, pending, t, cx);
        let promises = self.promises(pending, t, cx);
        let recap = self.recap(now, pending, t, cx);
        let actions = self.action_bar(pending, t, cx);

        body.children(alerts)
            .children(weather_line)
            .children(error)
            .child(list)
            .children(answered)
            .children(say_hi)
            .children(welcome_back)
            .children(promises)
            .children(recap)
            .children(actions)
            .into_any_element()
    }

    /// The triage list (`Sidekick questions and flags`): questions then
    /// flags, ↑ ↓ to walk it, and its keys while it has focus.
    fn triage_list(
        &mut self,
        now: DateTime<Utc>,
        window: &mut Window,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let rows = pane_rows(&self.state);
        let active = resolve_selection(&rows, self.cohost.selected.as_deref());
        let focused = self.cohost.list_focus.is_focused(window);
        let spotlight =
            active_spotlight(&self.state, now).and_then(|spot| spot.question_id.clone());
        let mut list = div()
            .id("cohost-list")
            .key_context(LIST_CONTEXT)
            .track_focus(&self.cohost.list_focus)
            .aria_label(pane_words::LIST_LABEL)
            .flex_1()
            .min_h(px(0.))
            .flex()
            .flex_col()
            .px(px(4.))
            .py(px(4.))
            .overflow_y_scroll()
            .rounded(px(radius::ROW))
            .when(focused, |list| list.shadow(vec![focus_ring(t)]))
            .on_action(cx.listener(|pane, _: &SelectPrevious, _, cx| pane.move_row(-1, cx)))
            .on_action(cx.listener(|pane, _: &SelectNext, _, cx| pane.move_row(1, cx)))
            .on_action(cx.listener(|pane, _: &ReplyToRow, _, cx| pane.row_key(RowKey::Reply, cx)))
            .on_action(cx.listener(|pane, _: &ShowRowOnStream, _, cx| {
                pane.row_key(RowKey::ShowOnStream, cx)
            }))
            .on_action(
                cx.listener(|pane, _: &MarkRowAnswered, _, cx| pane.row_key(RowKey::Answered, cx)),
            )
            .on_action(cx.listener(|pane, _: &DismissRow, _, cx| pane.row_key(RowKey::Dismiss, cx)))
            .on_action(cx.listener(|pane, _: &RemoveFlagged, _, cx| pane.remove_flagged(cx)))
            .on_action(cx.listener(|pane, _: &OpenRow, _, cx| pane.row_key(RowKey::Primary, cx)));
        if rows.is_empty() {
            let presence = presence_view(
                Some(&self.state),
                now,
                self.cohost_starting(self.chat_session().is_some()),
            );
            list = list.child(
                div()
                    .px(px(8.))
                    .py(px(12.))
                    .type_scale(text::META)
                    .text_color(hsla(t.subtle))
                    .child(empty_state_copy(&presence, Some(&self.state))),
            );
        } else {
            for question in sorted_questions(&self.state.questions) {
                let key = question_row_key(&question.id);
                let selected = active.as_deref() == Some(key.as_str());
                let talking = spotlight.as_deref() == Some(question.id.as_str());
                let on_stream = self.cohost.highlighted.is_some()
                    && highlight_message_id(&question) == self.cohost.highlighted.as_deref();
                let facts = RowFacts {
                    key,
                    selected,
                    talking,
                    on_stream,
                };
                list = list.child(self.question_row(&question, facts, now, t, cx));
            }
            for flag in sorted_flags(&self.state.flags) {
                let key = flag_row_key(&flag.message_id);
                let selected = active.as_deref() == Some(key.as_str());
                list = list.child(self.flag_row(&flag, key, selected, now, t, cx));
            }
        }
        list.into_any_element()
    }

    /// One grouped question (`CohostQuestionRow`): what was asked, its
    /// badges, where from, who asked, how old. A click selects and replies.
    fn question_row(
        &self,
        question: &CohostQuestion,
        facts: RowFacts,
        now: DateTime<Utc>,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let RowFacts {
            key,
            selected,
            talking,
            on_stream,
        } = facts;
        let muted = hsla(t.muted_foreground);
        let priority = priority_label(&question.priority)
            .map(|label| Badge::new(label).variant(BadgeVariant::Outline));
        let on_topic = question.on_topic.then(|| {
            div()
                .id(SharedString::from(format!("{key}-on-topic")))
                .flex_none()
                .tooltip(tooltip(pane_words::ON_TOPIC_HINT))
                .child(Badge::new(pane_words::ON_TOPIC).variant(BadgeVariant::Outline))
        });
        let from_notes = question.from_notes.then(|| {
            div()
                .id(SharedString::from(format!("{key}-from-notes")))
                .flex_none()
                .aria_label(pane_words::FROM_NOTES)
                .tooltip(tooltip(pane_words::FROM_NOTES))
                .child(icon(IconName::PencilSimple, MARK_PX, muted))
        });
        let askers = askers_label(&question.askers);
        let talking = talking.then(|| {
            div()
                .id(SharedString::from(format!("{key}-talking")))
                .flex_none()
                .aria_label(pane_words::TALKING_ABOUT_THIS)
                .tooltip(tooltip(pane_words::TALKING_ABOUT_THIS_HINT))
                .child(
                    Badge::new(pane_words::TALKING_ABOUT_THIS)
                        .variant(BadgeVariant::Outline)
                        .icon(icon(IconName::Microphone, CHIP_ICON_PX, muted)),
                )
        });
        let select = key.clone();
        div()
            .id(SharedString::from(key))
            .w_full()
            .h(px(size::ROW))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .rounded(px(radius::ROW))
            .text_size(px(13.))
            .line_height(px(20.))
            .when(selected, |row| row.bg(hsla(t.accent)))
            .hover(|style| style.bg(hsla(t.accent)))
            .children(priority)
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .truncate()
                    .text_color(hsla(t.foreground))
                    .child(question.text.clone()),
            )
            .children(on_topic)
            .children(from_notes)
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.))
                    .children(question.platforms.iter().map(|id| mark(id.as_str()))),
            )
            .when(!askers.is_empty(), |row| {
                row.child(
                    div()
                        .flex_none()
                        .max_w(px(ASKERS_MAX_W))
                        .truncate()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(askers),
                )
            })
            .children(talking)
            .when(on_stream, |row| {
                row.child(Badge::new(pane_words::ON_STREAM).variant(BadgeVariant::Chrome))
            })
            .children(age(&question.updated_at, now).map(|age| {
                div()
                    .flex_none()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(age)
            }))
            .on_click(cx.listener(move |pane, _, window, cx| {
                pane.select_row(select.clone(), window, cx);
                pane.row_key(RowKey::Primary, cx);
            }))
            .into_any_element()
    }

    /// One flagged message (`CohostFlagRow`): Sidekick never acts on it by
    /// itself. A click selects and jumps to the message.
    fn flag_row(
        &self,
        flag: &CohostFlag,
        key: String,
        selected: bool,
        now: DateTime<Utc>,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = hsla(t.muted_foreground);
        let high = flag.severity == "high";
        let select = key.clone();
        let detail = flag_detail(flag);
        div()
            .id(SharedString::from(key))
            .w_full()
            .h(px(size::ROW))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .rounded(px(radius::ROW))
            .text_size(px(13.))
            .line_height(px(20.))
            .when(selected, |row| row.bg(hsla(t.accent)))
            .hover(|style| style.bg(hsla(t.accent)))
            .child(div().flex_none().max_w(gpui::relative(0.55)).child(
                Badge::new(flag_chip_label(flag)).variant(if high {
                    BadgeVariant::Destructive
                } else {
                    BadgeVariant::Outline
                }),
            ))
            .child(
                div()
                    .id(SharedString::from(format!("{}-reason", flag.message_id)))
                    .flex_1()
                    .min_w(px(0.))
                    .truncate()
                    .text_color(muted)
                    .when(!detail.is_empty(), |reason| reason.tooltip(tooltip(detail)))
                    .child(flag.reason.clone()),
            )
            .children(flag_action_label(flag).map(|action| {
                small(div())
                    .flex_none()
                    .text_color(hsla(t.subtle))
                    .child(action)
            }))
            .children(age(&flag.at, now).map(|age| {
                div()
                    .flex_none()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(age)
            }))
            .on_click(cx.listener(move |pane, _, window, cx| {
                pane.select_row(select.clone(), window, cx);
                pane.row_key(RowKey::Primary, cx);
            }))
            .into_any_element()
    }

    /// The selected row's actions with their keys (`cohost-actions`).
    fn action_bar(&self, pending: bool, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let rows = pane_rows(&self.state);
        let active = resolve_selection(&rows, self.cohost.selected.as_deref())?;
        let question = rows.iter().find(|row| row.key == active)?.question;
        let action = |id: &'static str, label: &'static str, key: &'static str, row: RowKey| {
            Button::new(id)
                .label(label)
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .tooltip(label)
                .child(ShortcutKeys::keystrokes(key))
                .on_click(cx.listener(move |pane, _, _, cx| pane.row_key(row, cx)))
        };
        let mut bar = div()
            .flex()
            .flex_none()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(4.))
            .px(px(8.))
            .py(px(4.))
            .child(
                small(div())
                    .id("cohost-acts-on-ask")
                    .flex_1()
                    .min_w(px(0.))
                    .truncate()
                    .text_color(hsla(t.muted_foreground))
                    .tooltip(tooltip(acts_on_ask_copy()))
                    .child(ACTS_ON_ASK_HINT),
            );
        if question {
            bar = bar
                .child(
                    action("cohost-reply", pane_words::REPLY, REPLY_KEY, RowKey::Reply)
                        .disabled(pending),
                )
                .child(
                    action(
                        "cohost-show-on-stream",
                        pane_words::SHOW_ON_STREAM,
                        SHOW_KEY,
                        RowKey::ShowOnStream,
                    )
                    .disabled(pending),
                )
                .child(
                    action(
                        "cohost-answered",
                        pane_words::ANSWERED,
                        ANSWERED_KEY,
                        RowKey::Answered,
                    )
                    .disabled(pending),
                );
        } else {
            bar = bar.child(action(
                "cohost-jump",
                pane_words::JUMP,
                OPEN_KEY,
                RowKey::Primary,
            ));
            let flag_id = rows
                .iter()
                .find(|row| row.key == active)
                .map(|row| row.id.clone());
            if let Some(id) = flag_id.filter(|id| self.flag_removable(id)) {
                bar = bar.child(
                    Button::new("cohost-remove-from-chat")
                        .label(videorc_app_core::stream_manager::removal::REMOVE_FROM_CHAT)
                        .variant(ButtonVariant::Destructive)
                        .size(ButtonSize::Xs)
                        .tooltip(videorc_app_core::stream_manager::removal::REMOVE_FROM_CHAT)
                        .child(ShortcutKeys::keystrokes(REMOVE_FLAGGED_KEY))
                        .disabled(pending)
                        .on_click(cx.listener(move |pane, _, _, cx| {
                            let _ = &id;
                            pane.remove_flagged(cx);
                        })),
                );
            }
        }
        bar = bar.child(
            action(
                "cohost-dismiss",
                pane_words::DISMISS,
                DISMISS_KEY,
                RowKey::Dismiss,
            )
            .disabled(pending),
        );
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(Separator::new())
                .child(bar)
                .into_any_element(),
        )
    }

    /// Questions the streamer answered out loud: the newest on one quiet
    /// line, the others (at most two) behind "+2". Restore puts one back.
    fn answered_card(
        &self,
        now: DateTime<Utc>,
        pending: bool,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let items = answered_on_air(&self.state, now);
        let (newest, older) = items.split_first()?;
        let line = |item: &CohostRecentlyResolved,
                    more: Option<AnyElement>,
                    cx: &mut Context<Self>| {
            let id = item.question.id.clone();
            card_row(SharedString::from(format!("answered-{id}")))
                .child(
                    div()
                        .id(SharedString::from(format!("answered-{id}-text")))
                        .flex()
                        .flex_1()
                        .min_w(px(0.))
                        .gap(px(4.))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_color(hsla(t.muted_foreground))
                        .tooltip(tooltip(item.question.text.clone()))
                        .child(
                            div()
                                .flex_none()
                                .text_color(hsla(t.subtle))
                                .child(pane_words::ANSWERED_ON_AIR),
                        )
                        .child(
                            div()
                                .min_w(px(0.))
                                .truncate()
                                .child(item.question.text.clone()),
                        ),
                )
                .children(more)
                .child(
                    ghost(
                        SharedString::from(format!("answered-{id}-restore")),
                        pane_words::RESTORE,
                    )
                    .disabled(pending)
                    .on_click(
                        cx.listener(move |pane, _, _, cx| pane.restore_question(id.clone(), cx)),
                    ),
                )
                .into_any_element()
        };
        let more = (!older.is_empty()).then(|| {
            ghost("answered-more", format!("+{}", older.len()))
                .accessibility_label(pane_words::answered_more(older.len()))
                .on_click(cx.listener(|pane, _, _, cx| {
                    pane.cohost.answered_open = !pane.cohost.answered_open;
                    cx.notify();
                }))
                .into_any_element()
        });
        let mut card = div()
            .flex_none()
            .flex()
            .flex_col()
            .child(Separator::new())
            .child(line(newest, more, cx));
        if self.cohost.answered_open {
            for item in older {
                card = card.child(line(item, None, cx));
            }
        }
        Some(card.into_any_element())
    }

    /// First-time chatters nobody greeted yet (`CohostSayHiList`).
    fn say_hi_list(
        &self,
        now: DateTime<Utc>,
        pending: bool,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.state.say_hi.is_empty() {
            return None;
        }
        let muted = hsla(t.muted_foreground);
        let rows = self.state.say_hi.iter().map(|entry| {
            let author = entry.author_key.clone();
            card_row(SharedString::from(format!("say-hi-{author}")))
                .child(mark(&entry.platform))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .truncate()
                        .text_color(hsla(t.foreground))
                        .child(entry.name.clone()),
                )
                .children(
                    age(&entry.first_seen_at, now)
                        .map(|age| small(div()).flex_none().text_color(muted).child(age)),
                )
                .child(
                    ghost(
                        SharedString::from(format!("say-hi-{author}-greeted")),
                        pane_words::GREETED,
                    )
                    .disabled(pending)
                    .on_click(cx.listener(move |pane, _, _, cx| pane.greeted(author.clone(), cx))),
                )
        });
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(Separator::new())
                .child(heading(
                    "cohost-say-hi",
                    pane_words::SAY_HI,
                    pane_words::SAY_HI_HINT,
                    t,
                ))
                .children(rows)
                .into_any_element(),
        )
    }

    /// Returning people not welcomed yet (`CohostWelcomeBackList`): free, so
    /// it shows whatever Sidekick Live's state. Wave is bubble-only.
    fn welcome_back_list(
        &self,
        now: DateTime<Utc>,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.state.welcome_back.is_empty() {
            return None;
        }
        let muted = hsla(t.muted_foreground);
        let pending = self.cohost.pending;
        let rows = self.state.welcome_back.iter().map(|entry| {
            let person = entry.person_id.clone();
            let chip = arrival_chip(entry.arrival.as_ref()).map(|chip| {
                let glyph = match chip.kind {
                    ArrivalChipKind::Milestone => IconName::Sparkle,
                    ArrivalChipKind::Back => IconName::ArrowCounterClockwise,
                    ArrivalChipKind::Regular => IconName::UserCircle,
                };
                div()
                    .id(SharedString::from(format!("welcome-back-{person}-arrival")))
                    .flex_none()
                    .tooltip(tooltip(chip.hint.clone()))
                    .child(
                        Badge::new(chip.label.clone())
                            .variant(BadgeVariant::Outline)
                            .icon(icon(glyph, CHIP_ICON_PX, muted)),
                    )
            });
            card_row(SharedString::from(format!("welcome-back-{person}")))
                .child(mark(&entry.platform))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .truncate()
                        .text_color(hsla(t.foreground))
                        .child(entry.name.clone()),
                )
                .children(chip)
                .children(
                    age(&entry.first_seen_at, now)
                        .map(|age| small(div()).flex_none().text_color(muted).child(age)),
                )
                .child(
                    ghost(
                        SharedString::from(format!("welcome-back-{person}-wave")),
                        pane_words::WAVE,
                    )
                    .disabled(pending)
                    .on_click(cx.listener(move |pane, _, _, cx| pane.wave(person.clone(), cx))),
                )
        });
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(Separator::new())
                .child(heading(
                    "cohost-welcome-back",
                    pane_words::WELCOME_BACK,
                    pane_words::WELCOME_BACK_HINT,
                    t,
                ))
                .children(rows)
                .into_any_element(),
        )
    }

    /// What the streamer promised out loud (`CohostPromises`): Done and
    /// Dismiss both close it.
    fn promises(&self, pending: bool, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.state.promises.is_empty() {
            return None;
        }
        let rows = self.state.promises.iter().map(|promise| {
            let id = promise.id.clone();
            let dismiss = id.clone();
            let hint = promise_trigger_label(&promise.trigger);
            let full = match &hint {
                Some(hint) => format!("{} ({hint})", promise.text),
                None => promise.text.clone(),
            };
            card_row(SharedString::from(format!("promise-{id}")))
                .child(
                    div()
                        .id(SharedString::from(format!("promise-{id}-text")))
                        .flex_1()
                        .min_w(px(0.))
                        .truncate()
                        .text_color(hsla(t.foreground))
                        .tooltip(tooltip(full))
                        .child(promise.text.clone()),
                )
                .children(hint.map(|hint| {
                    small(div())
                        .flex_none()
                        .text_color(hsla(t.muted_foreground))
                        .child(hint)
                }))
                .child(
                    ghost(
                        SharedString::from(format!("promise-{id}-done")),
                        pane_words::DONE,
                    )
                    .disabled(pending)
                    .on_click(
                        cx.listener(move |pane, _, _, cx| pane.close_promise(id.clone(), true, cx)),
                    ),
                )
                .child(
                    ghost(
                        SharedString::from(format!("promise-{dismiss}-dismiss")),
                        pane_words::DISMISS,
                    )
                    .disabled(pending)
                    .on_click(cx.listener(move |pane, _, _, cx| {
                        pane.close_promise(dismiss.clone(), false, cx)
                    })),
                )
        });
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(Separator::new())
                .child(
                    div()
                        .px(px(8.))
                        .pt(px(6.))
                        .pb(px(2.))
                        .type_scale(text::LABEL)
                        .text_color(hsla(t.subtle))
                        .child(pane_words::PROMISES),
                )
                .children(rows)
                .into_any_element(),
        )
    }

    /// The recap card (Edit in chat box, Dismiss), or the row that drafts
    /// one. Edit in chat box only fills the composer: Sidekick never sends.
    fn recap(
        &self,
        now: DateTime<Utc>,
        pending: bool,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if let Some(recap) = active_recap(&self.state, now) {
            let actions = div()
                .flex()
                .flex_wrap()
                .gap(px(4.))
                .pt(px(6.))
                .child(
                    Button::new("cohost-recap-post")
                        .label(pane_words::EDIT_IN_CHAT_BOX)
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::Xs)
                        .disabled(pending)
                        .on_click(cx.listener(|pane, _, _, cx| pane.post_recap(cx))),
                )
                .child(
                    ghost("cohost-recap-dismiss", pane_words::DISMISS)
                        .disabled(pending)
                        .on_click(cx.listener(|pane, _, _, cx| pane.dismiss_recap(cx))),
                );
            return Some(
                div()
                    .id("cohost-recap-card")
                    .flex_none()
                    .p(px(8.))
                    .aria_label(pane_words::RECAP_LABEL)
                    .child(
                        Alert::new("cohost-recap")
                            .no_icon()
                            .title(pane_words::RECAP_TITLE)
                            .description(
                                div()
                                    .type_scale(text::META)
                                    .child(recap.text.clone())
                                    .child(actions),
                            ),
                    )
                    .into_any_element(),
            );
        }
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(Separator::new())
                .child(
                    card_row("cohost-recap-draft")
                        .child(
                            small(div())
                                .flex_1()
                                .min_w(px(0.))
                                .truncate()
                                .text_color(hsla(t.subtle))
                                .child(pane_words::RECAP_HINT),
                        )
                        .child(
                            ghost("cohost-draft-recap", pane_words::DRAFT_RECAP)
                                .disabled(pending)
                                .on_click(cx.listener(|pane, _, _, cx| pane.draft_recap(cx))),
                        ),
                )
                .into_any_element(),
        )
    }
}
