//! Sidekick → Reports: `cohost.report.latest` / `.get` and Electron report copy.

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_protocol::{CohostReportPayload, CohostReportQuestionOutcome, CohostSessionReport};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const STREAM_REPORT: &str = "Stream report";
const MARKERS: &str = "Markers";
const STREAM: &str = "Stream";
const EMPTY_TITLE: &str = "No stream reports yet";
const EMPTY_MESSAGE: &str = "The report appears here after your first stream with Sidekick.";
const OFF_NOTE: &str = "Sidekick was off for this stream.";
const TURN_ON: &str = "Turn on Sidekick to also catch questions.";
const NEXT_STREAM: &str = "It joins your next stream.";
const UNTITLED: &str = "Untitled stream";
const DESCRIPTION: &str = "Sidekick saves a short report on your computer: questions caught and missed, flags, promises, first-timers greeted, and the moments you marked by saying clip that.";
const LOADING: &str = "Loading the report…";
const READ_ERROR: &str = "Couldn't read this report.";
const TRY_AGAIN: &str = "Try again";
const SAID_ON_STREAM: &str = "Said on stream";
const POSTED_AS_YOU: &str = "Posted as you";
const MISSED_QUESTIONS: &str = "Missed questions";
const OPEN_PROMISES: &str = "Open promises";
const MOMENTS: &str = "Moments";
const ALERTS: &str = "Alerts";
const COMMANDS: &str = "Commands";
const REGULARS_BACK: &str = "Regulars back";
const MILESTONES: &str = "Milestones";

#[derive(Debug, Clone, Default)]
pub struct ReportsState {
    pub payload: Option<CohostReportPayload>,
    pub loading: bool,
    pub error: Option<String>,
    pub loaded: bool,
}

pub fn render_reports(
    view: &LiveView,
    state: &ReportsState,
    buddy_on: bool,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let entity = cx.entity();

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if let Some(unlock) = view.unlock.as_ref() {
        let mut alert = Alert::new("sidekick-reports-unlock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("reports-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => {
                            eprintln!("[videorc-app] Sidekick Reports: Sign in (account UI next)")
                        }
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        lead = lead.child(alert);
    }
    lead = lead.child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(DESCRIPTION),
    );

    let mut body = div().flex().flex_col().gap(px(12.));
    if state.loading && state.payload.is_none() {
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(LOADING),
        );
    }
    if let Some(error) = state.error.as_ref() {
        body = body.child(
            Alert::new("sidekick-report-error")
                .variant(AlertVariant::Warning)
                .title(error.clone())
                .action(
                    Button::new("report-try-again")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(TRY_AGAIN)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| screen.refresh_reports(cx));
                            }
                        }),
                ),
        );
    }

    match state.payload.as_ref() {
        None if !state.loading => {
            body = body
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(EMPTY_TITLE),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(EMPTY_MESSAGE),
                );
        }
        Some(payload) => {
            body = body.child(render_payload(payload, buddy_on, muted));
        }
        None => {}
    }

    let report = PanelSection::new("sidekick-stream-report")
        .title(STREAM_REPORT)
        .action(
            Button::new("report-markers")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(MARKERS)
                .disabled(state.payload.is_none()),
        )
        .child(body);

    div()
        .flex()
        .flex_col()
        .child(lead)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(size::GUTTER))
                .p(px(size::GUTTER))
                .child(report),
        )
        .into_any_element()
}

fn render_payload(
    payload: &CohostReportPayload,
    buddy_on: bool,
    muted: gpui::Hsla,
) -> impl IntoElement {
    let title = payload
        .report
        .as_ref()
        .and_then(|r| r.stream_title.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(UNTITLED);
    let off = payload.report.is_none();
    let mut root = div().flex().flex_col().gap(px(10.)).child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(format!("{STREAM}: {title}")),
    );
    if off {
        let hint = if buddy_on { NEXT_STREAM } else { TURN_ON };
        root = root.child(
            Alert::new("sidekick-report-off")
                .variant(AlertVariant::Quiet)
                .title(format!("{OFF_NOTE} {hint}")),
        );
    }
    if let Some(report) = payload.report.as_ref() {
        root = root.child(section_list(report, payload, muted));
    } else {
        root = root.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(format!(
                    "{MOMENTS}: {}",
                    if payload.moments.is_empty() {
                        "Nothing yet.".into()
                    } else {
                        format!("{} marked", payload.moments.len())
                    }
                )),
        );
    }
    root
}

fn section_list(
    report: &CohostSessionReport,
    payload: &CohostReportPayload,
    muted: gpui::Hsla,
) -> impl IntoElement {
    let missed: Vec<_> = report
        .questions
        .items
        .iter()
        .filter(|q| q.outcome == CohostReportQuestionOutcome::Open)
        .collect();
    let promises = report.promises.open.len();
    let said = report.said.len();
    let posts = report.posts.len();
    let alerts = report.alerts.len();
    let moments = payload.moments.len();
    let commands = report
        .commands
        .as_ref()
        .map(|c| {
            (c.highlighted
                + c.cleared
                + c.removed
                + c.hidden_locally
                + c.cancelled
                + c.expired
                + c.failed
                + c.not_found) as usize
        })
        .unwrap_or(0);
    let regulars = report
        .community
        .as_ref()
        .map(|c| c.regulars_back)
        .unwrap_or(0);
    let milestones = report
        .community
        .as_ref()
        .map(|c| c.milestones.len())
        .unwrap_or(0);

    let rows = [
        (SAID_ON_STREAM, said),
        (POSTED_AS_YOU, posts),
        (MISSED_QUESTIONS, missed.len()),
        (OPEN_PROMISES, promises),
        (MOMENTS, moments),
        (ALERTS, alerts),
        (COMMANDS, commands),
        (REGULARS_BACK, regulars as usize),
        (MILESTONES, milestones),
    ];

    let mut block = div().flex().flex_col().gap(px(8.));
    for (label, count) in rows {
        let detail = if count == 0 {
            "Nothing yet.".to_string()
        } else {
            format!("{count}")
        };
        block = block.child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(label),
                )
                .child(div().type_scale(text::META).text_color(muted).child(detail)),
        );
    }
    if !report.said.is_empty() {
        let mut lines = div().flex().flex_col().gap(px(2.));
        for line in report.said.iter().take(5) {
            lines = lines.child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(line.text.clone()),
            );
        }
        block = block.child(lines);
    }
    if !missed.is_empty() {
        let mut lines = div().flex().flex_col().gap(px(2.));
        for question in missed.iter().take(5) {
            lines = lines.child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(question.text.clone()),
            );
        }
        block = block.child(lines);
    }
    block
}
