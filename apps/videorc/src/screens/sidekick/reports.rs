//! Sidekick → Reports (`components/buddy-report-card.tsx`, loading rules
//! from `hooks/use-buddy-report.ts`): what Sidekick caught in the stream that
//! ended last, or in any recent stream the picker names. The view and every
//! word come from `videorc_app_core::buddy::report_view`.

use std::collections::HashSet;

use gpui::{
    AnyElement, Context, Entity, FontWeight, SharedString, Svg, Window, div, prelude::*, px,
};
use serde_json::json;
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::report_view::{
    self as rv, ReportSession, ReportView, ReportViewInput, SessionOption, ShownReport, Stat,
};
use videorc_app_core::format::is_auto_session_title;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::chat_platform::ChatPlatform;
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::select::{Select, SelectOption, SelectSize};
use videorc_kit::spinner::Spinner;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::tooltip;
use videorc_protocol::streaming::StreamPlatform;
use videorc_protocol::{ClipMomentSource, CohostReportPayload};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};
use crate::screens::session_player;

/// A platform mark in a row or the stream line (`ChatPlatformIcon`'s
/// `size-5`: YouTube's official icon may not go below 20 px, plan 165).
const MARK_PX: f32 = 20.;
/// A row's icon tile glyph.
const ICON_PX: f32 = 16.;
/// `lg:grid-cols-2`: the report's lists sit side by side from this window
/// width (a viewport breakpoint, not the report's).
const LISTS_SIDE_BY_SIDE_MIN_WIDTH: f32 = 1024.;

/// The tab's state (`useBuddyReport` and the card's own).
#[derive(Debug, Clone, Default)]
pub struct ReportsState {
    /// The last answer. It stays while another session loads, so switching
    /// never flashes the card empty; read the session from its `session_id`.
    pub payload: Option<CohostReportPayload>,
    /// The Library's recent sessions (`sessions.list`), for the picker and
    /// the shown stream's row.
    pub sessions: Vec<ReportSession>,
    /// The picked session; none follows the newest stream that ended.
    pub choice: Option<String>,
    /// An ask is in flight.
    pub loading: bool,
    /// Why the current ask failed; none once one succeeds.
    pub error: Option<String>,
    pub loaded: bool,
    /// The lists past "Show all", by id; cleared when the stream changes.
    pub expanded: HashSet<&'static str>,
    /// Drops an answer a newer ask overtook.
    generation: u64,
    /// The Library's recording dialog with the session's markers
    /// (`SessionMarkersDialog`), made on the first Markers click.
    pub markers: Option<Entity<session_player::Player>>,
    /// The report's own width (`@container/buddy-report`), measured each
    /// frame: the stat tiles' columns follow it.
    pub width: f32,
}

/// The stat tiles' columns at the report's width: 2, 3 from 30 rem, 5 from
/// 52 rem, then all 9 in one row from 90 rem.
fn stat_columns(width: f32) -> u16 {
    if width >= 1440. {
        9
    } else if width >= 832. {
        5
    } else if width >= 480. {
        3
    } else {
        2
    }
}

impl SidekickScreen {
    /// Markers: the shared player's dialog on the report's stream. Closing
    /// it stops playback.
    fn open_report_markers(
        &mut self,
        session_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(reports) = self.reports.as_mut() else {
            return;
        };
        if reports.markers.is_none() {
            reports.markers = session_player::hosted(session_player::Mode::Dialog, window, cx);
        }
        let Some(player) = reports.markers.clone() else {
            return;
        };
        let opened = player.update(cx, |player, cx| player.open_session(session_id, window, cx));
        if !opened {
            eprintln!("[videorc-app] Sidekick Reports: the Library has no session {session_id}");
        }
        cx.notify();
    }

    /// Asks for the report again (every `cohost.report.saved` too): the
    /// Library's sessions first (the picker and "Last stream"), then
    /// `cohost.report.get` for the picked or newest stream, or
    /// `cohost.report.latest` while the Library holds none.
    pub(crate) fn refresh_reports(&mut self, cx: &mut Context<Self>) {
        let Some(reports) = self.reports.as_mut() else {
            return;
        };
        reports.loading = true;
        reports.generation += 1;
        let generation = reports.generation;
        let choice = reports.choice.clone();
        cx.notify();
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            let sessions = backend
                .request("sessions.list", json!({ "limit": 50 }))
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("sessions")
                        .cloned()
                        .or_else(|| value.get("items").cloned())
                })
                .and_then(|value| serde_json::from_value::<Vec<ReportSession>>(value).ok());
            let ask =
                choice.or_else(|| sessions.as_deref().and_then(rv::newest_streamed_session_id));
            let answer = match ask.as_deref() {
                Some(id) => {
                    backend
                        .request("cohost.report.get", json!({ "sessionId": id }))
                        .await
                }
                None => backend.request("cohost.report.latest", json!({})).await,
            };
            let payload = answer.ok().and_then(|value| {
                if value.is_null() {
                    Some(None)
                } else {
                    serde_json::from_value::<CohostReportPayload>(value)
                        .ok()
                        .map(Some)
                }
            });
            (sessions, payload)
        });
        cx.spawn(async move |this, cx| {
            let (sessions, payload) = job.await.unwrap_or((None, None));
            let _ = this.update(cx, |screen, cx| {
                if let Some(reports) = screen.reports.as_mut()
                    && reports.generation == generation
                {
                    reports.loading = false;
                    reports.loaded = true;
                    if let Some(sessions) = sessions {
                        reports.sessions = sessions;
                    }
                    match payload {
                        Some(payload) => {
                            let was = reports.payload.as_ref().map(|p| p.session_id.as_str());
                            let now = payload.as_ref().map(|p| p.session_id.as_str());
                            if was != now {
                                reports.expanded.clear();
                            }
                            reports.payload = payload;
                            reports.error = None;
                        }
                        // Keep what the card shows; the error row says this
                        // ask failed.
                        None => reports.error = Some(rv::READ_ERROR.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The picker's choice (`reportSessionChoice`): the newest stream
    /// follows "Last stream" again; any other holds that session.
    pub(crate) fn choose_report_session(&mut self, session_id: &str, cx: &mut Context<Self>) {
        let Some(reports) = self.reports.as_mut() else {
            return;
        };
        let newest = rv::newest_streamed_session_id(&reports.sessions);
        reports.choice = rv::report_session_choice(session_id, newest.as_deref());
        self.refresh_reports(cx);
    }

    /// The report's measured width; draws again only when the tiles'
    /// columns change.
    fn measure_report(&mut self, width: f32, cx: &mut Context<Self>) {
        let Some(reports) = self.reports.as_mut() else {
            return;
        };
        let flips = stat_columns(reports.width) != stat_columns(width);
        reports.width = width;
        if flips {
            cx.notify();
        }
    }

    /// "Show all {n}" / "Show fewer".
    pub(crate) fn toggle_report_list(&mut self, list: &'static str, cx: &mut Context<Self>) {
        if let Some(reports) = self.reports.as_mut()
            && !reports.expanded.remove(list)
        {
            reports.expanded.insert(list);
        }
        cx.notify();
    }
}

pub fn render_reports(
    view: &LiveView,
    state: &ReportsState,
    buddy_on: bool,
    name: Option<&str>,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let session = state.payload.as_ref().and_then(|payload| {
        state
            .sessions
            .iter()
            .find(|session| session.id == payload.session_id)
    });
    let report = rv::report_view(ReportViewInput {
        payload: state.payload.as_ref(),
        session,
        buddy_on,
        name,
    });
    let shown = match &report {
        ReportView::Shown(shown) => Some(shown.as_ref()),
        ReportView::Empty { .. } => None,
    };
    let newest = rv::newest_streamed_session_id(&state.sessions);
    let ask = state.choice.clone().or(newest);
    let options = rv::report_session_options(
        &state.sessions,
        shown.map(|shown| SessionOption {
            id: shown.session_id.clone(),
            title: shown.title.clone(),
            date: shown.date.clone().unwrap_or_default(),
        }),
    );
    let selected = ask.or_else(|| shown.map(|shown| shown.session_id.clone()));

    // The tab's one section (`PageStack`): flush to the pane, and as its
    // last section it has no hairline under it.
    let mut section = PanelSection::new("sidekick-stream-report")
        .title(rv::STREAM_REPORT)
        .description(rv::DESCRIPTION)
        .last(true);
    // P1219: the shown stream's markers, in the Library's own dialog.
    if let (Some(shown), Some(_)) = (shown, session) {
        let session_id = shown.session_id.clone();
        let open = entity.clone();
        section = section.action(
            Button::new("report-markers")
                .variant(ButtonVariant::Ghost)
                .icon(IconName::BookmarkSimple)
                .label(rv::MARKERS)
                .on_click(move |_, window, cx| {
                    open.update(cx, |screen, cx| {
                        screen.open_report_markers(&session_id, window, cx);
                    });
                }),
        );
    }
    if let Some(selected) = selected
        && !options.is_empty()
    {
        section = section.action(stream_picker(&options, selected, &entity, t));
    }

    // `@container/buddy-report`: the tiles' columns follow this block's width.
    let measured = entity.downgrade();
    let measure = gpui::canvas(
        move |bounds, _, cx| {
            let width = f32::from(bounds.size.width);
            measured
                .update(cx, |screen, cx| screen.measure_report(width, cx))
                .ok();
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full();
    let mut body = div()
        .relative()
        .flex()
        .flex_col()
        .min_w(px(0.))
        .gap(px(16.))
        .child(measure);
    if let Some(error) = state.error.as_ref() {
        body = body.child(
            Alert::new("sidekick-report-error")
                .variant(AlertVariant::Warning)
                .title(error.clone())
                .action(
                    Button::new("report-try-again")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(rv::TRY_AGAIN)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| screen.refresh_reports(cx));
                            }
                        }),
                ),
        );
    }
    match &report {
        ReportView::Shown(shown) => {
            let wide = f32::from(window.viewport_size().width) >= LISTS_SIDE_BY_SIDE_MIN_WIDTH;
            body = body.child(report_body(shown, view, state, wide, t, &entity));
        }
        ReportView::Empty { .. } if state.error.is_some() => {}
        ReportView::Empty { .. } if state.loading || !state.loaded => {
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(
                        Spinner::new("sidekick-report-loading")
                            .size(14.)
                            .color(t.muted_foreground)
                            .hidden(true),
                    )
                    .child(rv::LOADING),
            );
        }
        ReportView::Empty { message } => {
            body = body.child(Empty::new().title(rv::EMPTY_TITLE).description(*message));
        }
    }

    div()
        .flex()
        .flex_col()
        .child(section.child(body))
        .into_any_element()
}

/// The stream picker: recent streams, newest first, named by when they ran.
/// The trigger reads the date (the title when there is none); a row reads
/// the title, then the date in secondary text.
fn stream_picker(
    options: &[SessionOption],
    selected: String,
    entity: &Entity<SidekickScreen>,
    t: &'static Theme,
) -> Select {
    // `SelectTrigger size="xs" className="max-w-56"`.
    let mut select = Select::new("sidekick-report-stream")
        .size(SelectSize::Xs)
        .max_width(224.)
        .accessibility_label(rv::STREAM)
        .placeholder(rv::STREAM)
        .value(Some(SharedString::from(selected)));
    for option in options {
        let label = match (option.date.is_empty(), option.title.is_empty()) {
            (false, _) => option.date.clone(),
            (true, false) => option.title.clone(),
            (true, true) => rv::STREAM.to_string(),
        };
        let row = div()
            .flex()
            .min_w(px(0.))
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .min_w(px(0.))
                    .max_w(px(256.))
                    .truncate()
                    .child(option.title.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(option.date.clone()),
            );
        select = select.option_item(SelectOption::new(option.id.clone(), label).child(row));
    }
    let entity = entity.clone();
    select.on_change(move |id, _, cx| {
        entity.update(cx, |screen, cx| screen.choose_report_session(&id, cx));
    })
}

fn report_body(
    view: &ShownReport,
    live: &LiveView,
    state: &ReportsState,
    wide: bool,
    t: &'static Theme,
    entity: &Entity<SidekickScreen>,
) -> impl IntoElement {
    let muted = hsla(t.muted_foreground);
    let columns = stat_columns(state.width);
    let mut body = div()
        .flex()
        .flex_col()
        .min_w(px(0.))
        .gap(px(16.))
        .child(stream_line(view, t));
    match &view.note {
        Some(note) => {
            body = body.child(
                Alert::new("sidekick-report-off")
                    .title(note.title)
                    .description(note.hint),
            );
        }
        None => body = body.child(stat_tiles(&view.stats, columns, t)),
    }
    if let Some(community) = view.community.as_ref() {
        let mut block = div()
            .flex()
            .flex_col()
            .min_w(px(0.))
            .gap(px(12.))
            .child(
                div()
                    .type_scale(text::SECTION)
                    .text_color(hsla(t.foreground))
                    .child(rv::COMMUNITY),
            )
            .child(stat_tiles(&community.stats, columns, t));
        if let Some(line) = community.line.as_ref() {
            block = block.child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(line.clone()),
            );
        }
        // P1226: the summary is Premium's; a lock without it, never hidden.
        match (live.unlock.as_ref(), community.summary.as_ref()) {
            (Some(unlock), _) => {
                let mut lock = Alert::new("sidekick-report-community-lock")
                    .variant(AlertVariant::Locked)
                    .title(rv::SUMMARY_LOCK_REASON);
                if let Some(action) = unlock.action {
                    lock = lock.action(unlock_button("report-summary-unlock", action));
                }
                block = block.child(lock);
            }
            (None, Some(summary)) => {
                block = block.child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .text_color(muted)
                        .child(summary.clone()),
                );
            }
            (None, None) => {}
        }
        let regulars = report_list(
            "regulars",
            rv::REGULARS_BACK,
            &community.regulars,
            state,
            entity,
            |index, person| {
                let mut row = ListRow::new(row_id("regulars", index), person.name.clone())
                    .meta(person.streams.clone());
                for platform in &person.platforms {
                    row = row.status_icon(platform_mark(*platform, t));
                }
                row
            },
        );
        let milestones = report_list(
            "milestones",
            rv::MILESTONES,
            &community.milestones,
            state,
            entity,
            |index, entry| {
                ListRow::new(row_id("milestones", index), entry.name.clone())
                    .meta(entry.label.clone())
                    .status_icon(platform_mark(entry.platform, t))
            },
        );
        // Side by side at `lg` when both have rows.
        block = block.children(list_columns(
            regulars.map(|list| vec![list]).unwrap_or_default(),
            milestones.map(|list| vec![list]).unwrap_or_default(),
            wide,
        ));
        body = body.child(block);
    }
    if let Some(commands) = view.commands.as_ref() {
        let counts = commands
            .counts
            .iter()
            .map(|count| format!("{} {}", count.label, count.value))
            .collect::<Vec<_>>()
            .join(" · ");
        body = body.child(
            GroupedList::new().row(
                ListRow::new("report-commands", rv::COMMANDS)
                    .icon(icon(IconName::Microphone, ICON_PX, muted))
                    .context(counts)
                    .meta(commands.total.clone()),
            ),
        );
    }
    body = body
        .children(report_list(
            "said",
            rv::SAID_ON_STREAM,
            &view.said,
            state,
            entity,
            |index, line| {
                let mut row =
                    ListRow::new(row_id("said", index), line.trigger).context(line.text.clone());
                if let Some(source) = line.source {
                    row = row.alias(Badge::new(source).variant(BadgeVariant::Outline));
                }
                if let Some(at) = line.at.as_ref() {
                    row = row.meta(at.clone());
                }
                row
            },
        ))
        .children(report_list(
            "posts",
            rv::POSTED_AS_YOU,
            &view.posts,
            state,
            entity,
            |index, post| {
                let mut row = ListRow::new(row_id("posts", index), post.trigger)
                    .context(post.text.clone())
                    .meta(match post.at.as_ref() {
                        Some(at) => format!("{} {at}", post.result_label),
                        None => post.result_label.to_string(),
                    });
                if let Some(source) = post.source {
                    row = row.alias(Badge::new(source).variant(BadgeVariant::Outline));
                }
                for platform in &post.platforms {
                    row = row.status_icon(platform_mark(*platform, t));
                }
                row
            },
        ));
    if let Some(skips) = view.greeting_skips.as_ref() {
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(skips.sentence.clone()),
        );
    }
    // What needs you (questions, promises) beside what happened (moments,
    // alerts), two columns at `lg` when both sides have rows.
    let needs_you = [
        report_list(
            "missed",
            rv::MISSED_QUESTIONS,
            &view.missed,
            state,
            entity,
            |index, question| {
                let mut row = ListRow::new(row_id("missed", index), question.text.clone());
                if !question.askers.is_empty() {
                    row = row.context(question.askers.clone());
                }
                if question.high {
                    row = row.alias(Badge::new(rv::HIGH).variant(BadgeVariant::Outline));
                }
                for platform in &question.platforms {
                    row = row.status_icon(platform_mark(*platform, t));
                }
                if let Some(at) = question.at.as_ref() {
                    row = row.meta(at.clone());
                }
                row
            },
        ),
        report_list(
            "promises",
            rv::OPEN_PROMISES,
            &view.promises,
            state,
            entity,
            |index, promise| {
                let row = ListRow::new(row_id("promises", index), promise.text.clone());
                match promise.at.as_ref() {
                    Some(at) => row.meta(at.clone()),
                    None => row,
                }
            },
        ),
    ];
    let happened = [
        report_list(
            "moments",
            rv::MOMENTS,
            &view.moments,
            state,
            entity,
            |index, moment| {
                let glyph = match moment.kind {
                    ClipMomentSource::Voice => IconName::Microphone,
                    ClipMomentSource::Manual => IconName::Scissors,
                    ClipMomentSource::Chat => IconName::ChatCircle,
                };
                let row = ListRow::new(row_id("moments", index), moment.label.clone())
                    .icon(icon(glyph, ICON_PX, muted))
                    .meta(moment.range.clone());
                if moment.excerpt.is_empty() {
                    row
                } else {
                    row.context(moment.excerpt.clone())
                }
            },
        ),
        report_list(
            "alerts",
            rv::ALERTS,
            &view.alerts,
            state,
            entity,
            |index, alert| {
                let row = ListRow::new(row_id("alerts", index), alert.label)
                    .icon(icon(IconName::WarningCircle, ICON_PX, muted))
                    .context(alert.viewers.clone());
                match alert.at.as_ref() {
                    Some(at) => row.meta(at.clone()),
                    None => row,
                }
            },
        ),
    ];
    body.children(list_columns(
        needs_you.into_iter().flatten().collect(),
        happened.into_iter().flatten().collect(),
        wide,
    ))
}

/// Two groups of report lists (`grid min-w-0 gap-4`): side by side, each a
/// column of its lists, when `wide` and both have rows; else one under the
/// other. None when neither has a row.
fn list_columns(first: Vec<AnyElement>, second: Vec<AnyElement>, wide: bool) -> Option<AnyElement> {
    if first.is_empty() && second.is_empty() {
        return None;
    }
    let column = |lists: Vec<AnyElement>| {
        div()
            .flex()
            .flex_col()
            .min_w(px(0.))
            .gap(px(16.))
            .children(lists)
    };
    let side_by_side = wide && !first.is_empty() && !second.is_empty();
    let grid = if side_by_side {
        div()
            .flex()
            .items_start()
            .min_w(px(0.))
            .gap(px(16.))
            .child(column(first).flex_1())
            .child(column(second).flex_1())
    } else {
        div()
            .flex()
            .flex_col()
            .min_w(px(0.))
            .gap(px(16.))
            .when(!first.is_empty(), |grid| grid.child(column(first)))
            .when(!second.is_empty(), |grid| grid.child(column(second)))
    };
    Some(grid.into_any_element())
}

/// Title, then how long it ran and where the chat came from (P1224: one
/// mark per platform, its count in the tooltip).
fn stream_line(view: &ShownReport, t: &'static Theme) -> impl IntoElement {
    let muted = hsla(t.muted_foreground);
    // Each fact its own span, a "·" between them, all 6 px apart.
    let facts = [view.duration.clone(), Some(view.chat.label.clone())]
        .into_iter()
        .flatten()
        .enumerate()
        .flat_map(|(index, fact)| {
            let dot = (index > 0).then(|| div().child("·"));
            dot.into_iter().chain([div().child(fact)])
        })
        .collect::<Vec<_>>();
    let several = view.chat.platforms.len() > 1;
    let platforms = view
        .chat
        .platforms
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            div()
                .id(("sidekick-report-platform", index))
                .flex()
                .items_center()
                .gap(px(4.))
                .tooltip(tooltip(entry.label.clone()))
                .child(platform_mark(entry.platform, t))
                // One platform's count is the total already said.
                .when(several, |chip| {
                    chip.child(rv::format_report_count(entry.messages))
                })
        });
    div()
        .flex()
        .flex_col()
        .min_w(px(0.))
        .gap(px(2.))
        .when(!is_auto_session_title(&view.title), |line| {
            line.child(
                div()
                    .truncate()
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(t.foreground))
                    .child(view.title.clone()),
            )
        })
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_x(px(6.))
                .gap_y(px(2.))
                .type_scale(text::META)
                .text_color(muted)
                .children(facts)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .ml(px(4.))
                        .children(platforms),
                ),
        )
}

/// The stats as a row of tiles: each the number over its label, a ratio's
/// whole muted after a slash. `columns` follows the report's width.
fn stat_tiles(stats: &[Stat], columns: u16, t: &'static Theme) -> impl IntoElement {
    let muted = hsla(t.muted_foreground);
    div()
        .grid()
        .grid_cols(columns)
        .gap(px(8.))
        .children(stats.iter().map(|stat| {
            div()
                .flex()
                .flex_col()
                .min_w(px(0.))
                .gap(px(2.))
                .px(px(12.))
                .py(px(10.))
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.inset))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .text_size(px(20.))
                        .line_height(px(28.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hsla(t.foreground))
                        .child(stat.value.clone())
                        .when_some(stat.of.clone(), |value, of| {
                            value.child(
                                div()
                                    .text_size(px(16.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(muted)
                                    .child(format!(" / {of}")),
                            )
                        }),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(stat.label),
                )
        }))
}

/// A grouped list that shows its first rows, with the rest behind "Show
/// all" (P1227). None when it has no rows.
fn report_list<T>(
    id: &'static str,
    label: &'static str,
    items: &[T],
    state: &ReportsState,
    entity: &Entity<SidekickScreen>,
    build: impl Fn(usize, &T) -> ListRow,
) -> Option<AnyElement> {
    if items.is_empty() {
        return None;
    }
    let expanded = state.expanded.contains(id);
    let (visible, _) = rv::cap_report_list(items, expanded, rv::LIST_CAP);
    let mut list = GroupedList::new().label(rv::list_label(label, items.len()));
    for (index, item) in visible.iter().enumerate() {
        list = list.row(build(index, item));
    }
    let mut block = div()
        .flex()
        .flex_col()
        .min_w(px(0.))
        .gap(px(4.))
        .child(list);
    if items.len() > rv::LIST_CAP {
        let entity = entity.clone();
        let words: SharedString = if expanded {
            rv::SHOW_FEWER.into()
        } else {
            rv::show_all(items.len()).into()
        };
        block = block.child(
            div().flex().child(
                Button::new(format!("report-toggle-{id}"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label(words)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |screen, cx| screen.toggle_report_list(id, cx));
                    }),
            ),
        );
    }
    Some(block.into_any_element())
}

fn row_id(list: &str, index: usize) -> String {
    format!("report-{list}-{index}")
}

/// A lock's Sign in / View Premium button (Sign in stays log-only until the
/// account UI lands).
fn unlock_button(id: &'static str, action: UnlockAction) -> Button {
    let label = match action {
        UnlockAction::SignIn => words::SIGN_IN,
        UnlockAction::ViewPremium => words::VIEW_PREMIUM,
    };
    Button::new(id)
        .variant(ButtonVariant::Outline)
        .size(ButtonSize::Xs)
        .label(label)
        .on_click(move |_, _, cx| match action {
            UnlockAction::SignIn => crate::app::accounts::sign_in(cx),
            UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
        })
}

/// `ChatPlatformIcon`: the platform's mark in its brand tint.
fn platform_mark(platform: StreamPlatform, t: &Theme) -> Svg {
    let mark = match platform {
        StreamPlatform::Youtube => ChatPlatform::Youtube,
        StreamPlatform::Twitch => ChatPlatform::Twitch,
        StreamPlatform::Kick => ChatPlatform::Kick,
        StreamPlatform::X => ChatPlatform::X,
        StreamPlatform::Facebook => ChatPlatform::Facebook,
        StreamPlatform::Tiktok => ChatPlatform::Tiktok,
        StreamPlatform::Instagram => ChatPlatform::Instagram,
        StreamPlatform::Custom => ChatPlatform::Custom,
    };
    let glyph = icon(mark.icon(), MARK_PX, mark.tint_hsla(t));
    // YouTube keeps clear space of the triangle's width before what
    // follows it (`mr-1`, brand.youtube).
    if mark == ChatPlatform::Youtube {
        glyph.mr(px(4.))
    } else {
        glyph
    }
}
