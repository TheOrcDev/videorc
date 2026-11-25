//! Sidekick → Clean cut: the card (`clean-cut-card.tsx`, its consent dialog
//! `clean-cut-consent-dialog.tsx`) and the kept drafts' storage, from
//! `cleanCut.*`, `buddy::clean_cut_view` and `clean_cut_drafts`. The open
//! review takes the card's place (`clean_cut_review.rs`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, EventEmitter, FontWeight, Window, div,
    prelude::*, px,
};
use videorc_app_core::account::entitlements::cloud_ai_upload_gate;
use videorc_app_core::buddy::clean_cut_drafts::{self, STORAGE_KEY};
use videorc_app_core::buddy::clean_cut_view::{
    self as view, AutoStatusKind, CLEAN_CUT_AUTO_LABEL, CLEAN_CUT_CONSENT_ALSO,
    CLEAN_CUT_DESCRIPTION, CLEAN_CUT_LIST_CAP, CLEAN_CUT_NO_RECORDINGS, CLEAN_CUT_TITLE,
    CONDENSED_DEFAULT_TARGET_MINUTES, CONDENSED_TARGET_MINUTES, ChipTone, CleanCutCapabilities,
    ConsentAsk, Retry, RowChip, StatusKind, Unlock, UnlockAction,
};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::client::RpcError;
use videorc_app_core::library::page::{CleanCutCapture, reveal_in_file_manager_label};
use videorc_app_core::notices::{NoticeCommand, ToastRequest};
use videorc_app_core::stream_manager::buddy::CLOUD_AI_KEEPS;
use videorc_app_core::studio::session::session_is_live;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::InputState;
use videorc_kit::input_group::{InputGroup, InputGroupAddon};
use videorc_kit::label::Label;
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::spinner::Spinner;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, size, text};
use videorc_protocol::{CleanCutJob, CleanCutMode, EntitlementsSnapshot, SessionListItem};

use super::SidekickScreen;
use super::clean_cut_review::ReviewState;
use crate::app::posters::{self, Posters};

const RECORDINGS: &str = "Recordings";
const SEARCH_RECORDINGS: &str = "Search recordings…";
const SEARCH_LABEL: &str = "Search recordings";
const KIND_OF_CUT: &str = "Kind of cut";
const CONDENSED_LENGTH: &str = "Condensed length";
const LENGTH: &str = "Length";
const MAKE_AGAIN: &str = "Make again";
const NOT_FOR_THIS_RECORDING: &str = "Not for this recording";
const ALLOW_CLOUD: &str = "Allow cloud AI…";
const REVIEW: &str = "Review";
const CANCEL: &str = "Cancel";
const RETRY: &str = "Retry";
const OPEN_IN_LIBRARY: &str = "Open in Library";
/// Clean cut's name as a user of the app-wide poster cache.
pub(super) const POSTER_USER: &str = "clean-cut";
/// A recording row's poster (`SessionPoster className="h-9 w-16"`): 64 × 36.
const POSTER_WIDTH: f32 = 64.;
const POSTER_HEIGHT: f32 = 36.;
/// A recording row's `h-auto gap-3 py-1.5`: 48 px around the poster.
const RECORDING_ROW_GAP: f32 = 12.;
const RECORDING_ROW_PADDING_Y: f32 = 6.;

/// "Open in Library" on a cut: the shell opens Library on this session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenLibrarySession(pub String);

impl EventEmitter<OpenLibrarySession> for SidekickScreen {}

pub struct CleanCutState {
    pub jobs: Vec<CleanCutJob>,
    /// Until the jobs are listed, a recording that already has its cut
    /// would look uncut, so Make waits for them.
    pub jobs_loaded: bool,
    /// Every Library row (`sessions.list`): the recordings it can cut, and
    /// the cut copies Show in Finder reveals.
    pub sessions: Vec<SessionListItem>,
    /// `ai.capabilities.get`'s Clean cut block.
    pub capabilities: Option<CleanCutCapabilities>,
    /// `entitlements.get`: the cloud-AI Premium gate.
    pub entitlements: Option<EntitlementsSnapshot>,
    pub search: Entity<InputState>,
    pub show_all: bool,
    pub mode: CleanCutMode,
    pub target_minutes: u32,
    /// `None` follows the newest recording, so the next one that ends takes
    /// its place.
    pub picked: Option<String>,
    pub pending: bool,
    /// What asked for cloud AI consent while the dialog is open.
    pub ask: Option<ConsentAsk>,
    pub consent: DialogHandle,
    /// The open review, in place of the card.
    pub review: Option<ReviewState>,
    pub drafts_path: PathBuf,
    pub loaded: bool,
}

impl CleanCutState {
    pub fn new(local_dir: &Path, window: &mut Window, cx: &mut Context<SidekickScreen>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_RECORDINGS));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        Self {
            jobs: Vec::new(),
            jobs_loaded: false,
            sessions: Vec::new(),
            capabilities: None,
            entitlements: None,
            search,
            show_all: false,
            mode: CleanCutMode::Clean,
            target_minutes: CONDENSED_DEFAULT_TARGET_MINUTES,
            picked: None,
            pending: false,
            ask: None,
            consent: DialogHandle::new(false),
            review: None,
            drafts_path: local_dir.join(format!("{STORAGE_KEY}.json")),
            loaded: false,
        }
    }

    pub fn load_drafts(&self) -> Vec<clean_cut_drafts::Stored> {
        let raw = std::fs::read_to_string(&self.drafts_path).ok();
        clean_cut_drafts::parse(raw.as_deref())
    }

    pub fn persist_drafts(&self, drafts: &[clean_cut_drafts::Stored]) {
        let _ = std::fs::write(&self.drafts_path, clean_cut_drafts::serialize(drafts));
    }

    /// The chosen recording, else the newest one it can cut.
    fn selected(&self) -> Option<&SessionListItem> {
        self.picked
            .as_deref()
            .and_then(|id| self.sessions.iter().find(|session| session.id == id))
            .or_else(|| view::recent_recordings(&self.sessions, 1).first().copied())
    }
}

/// Everything the card reads from the page, worked out once per frame.
struct Card<'a> {
    state: &'a CleanCutState,
    /// The app-wide poster cache, once installed.
    posters: Option<&'a Entity<Posters>>,
    capture: CleanCutCapture,
    unlock: Option<Unlock>,
    consented: bool,
    signed_in: bool,
    account_locked: bool,
}

impl Card<'_> {
    /// Make is off while the jobs are unlisted, the account or the server
    /// says no, a start is on its way, or Condensed can't cut this one.
    fn cannot_start(&self, condensed_blocked: bool) -> bool {
        let state = self.state;
        !state.jobs_loaded
            || self.account_locked
            || state
                .capabilities
                .as_ref()
                .is_some_and(|caps| !caps.available)
            || state.pending
            || condensed_blocked
    }
}

impl SidekickScreen {
    /// `CleanCutCaptureContext`: heavy work waits while a capture runs.
    pub(super) fn clean_cut_capture(&self) -> CleanCutCapture {
        CleanCutCapture {
            active: self.studio.session_owns_transport(),
            // The watch borrows the snapshot; `snapshot()` would clone it.
            streaming: session_is_live(&self.studio.watch().borrow().session.status),
        }
    }

    /// Make: asks for cloud AI consent first when it isn't given.
    pub(crate) fn make_clean_cut(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let consented = self.consented;
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let Some(session_id) = clean.selected().map(|session| session.id.clone()) else {
            return;
        };
        let (mode, target_minutes) = (clean.mode, clean.target_minutes);
        if !consented {
            clean.ask = Some(ConsentAsk::Start {
                session_id,
                mode,
                target_minutes,
            });
            clean.consent.open(window, cx);
            cx.notify();
            return;
        }
        self.start_clean_cut(session_id, mode, target_minutes, cx);
    }

    /// The "every recording" switch: on asks for consent first.
    pub(crate) fn turn_clean_cut_auto(
        &mut self,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if on && !self.consented {
            self.ask_clean_cut_consent(window, cx);
            return;
        }
        self.set_clean_cut_auto(on, cx);
    }

    /// The status line's "Allow cloud AI…": the switch's own question.
    pub(crate) fn ask_clean_cut_consent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(clean) = self.clean_cut.as_mut() {
            clean.ask = Some(ConsentAsk::Auto);
            clean.consent.open(window, cx);
        }
        cx.notify();
    }

    /// Declining changes nothing; allowing grants cloud AI and does what
    /// asked.
    pub(crate) fn answer_clean_cut_consent(
        &mut self,
        accepted: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let ask = clean.ask.take();
        clean.consent.close(window, cx);
        cx.notify();
        let (true, Some(ask)) = (accepted, ask) else {
            return;
        };
        self.set_consent(true, cx);
        match ask {
            ConsentAsk::Auto => self.set_clean_cut_auto(true, cx),
            ConsentAsk::Start {
                session_id,
                mode,
                target_minutes,
            } => self.start_clean_cut(session_id, mode, target_minutes, cx),
        }
    }

    /// Retry: cut the list again (local work), or start over.
    pub(crate) fn retry_clean_cut(
        &mut self,
        job_id: String,
        retry: Option<Retry>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if retry != Some(Retry::Render) {
            self.make_clean_cut(window, cx);
            return;
        }
        if let Some(clean) = self.clean_cut.as_mut() {
            clean.pending = true;
        }
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cleanCut.render", serde_json::json!({ "jobId": job_id }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(clean) = screen.clean_cut.as_mut() {
                    clean.pending = false;
                    if let Ok(Ok(value)) = &result
                        && let Ok(job) = serde_json::from_value::<CleanCutJob>(value.clone())
                    {
                        clean.jobs = view::upsert_job(&clean.jobs, job);
                    }
                }
                if let Ok(Err(error)) = &result {
                    screen.clean_cut_failed("clean-cut-start", view::RENDER_FAILED_TITLE, error);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// A failed call as a toast in plain words; the raw text goes to the log.
    pub(crate) fn clean_cut_failed(&self, id: &str, title: &str, error: &RpcError) {
        eprintln!(
            "[videorc-app] Clean cut: {} failed ({}): {}",
            error.method, error.code, error.message
        );
        let toast = ToastRequest::error(title)
            .id(id)
            .description(view::error_reason(error))
            .finish();
        self.studio.post_notices(vec![NoticeCommand::Show(toast)]);
    }

    /// Show in Finder / Show in Explorer: the cut copy's file.
    fn reveal_clean_cut_output(&self, output_session_id: &str, cx: &mut Context<Self>) {
        let path = self.clean_cut.as_ref().and_then(|clean| {
            clean
                .sessions
                .iter()
                .find(|session| session.id == output_session_id)
                .and_then(|session| session.mp4_path.as_ref().or(session.output_path.as_ref()))
                .cloned()
        });
        match path.map(PathBuf::from).filter(|path| path.is_absolute()) {
            Some(path) => cx.reveal_path(&path),
            None => eprintln!(
                "[videorc-app] Clean cut: no file to show for session {output_session_id}"
            ),
        }
    }

    pub(super) fn render_clean_cut(
        &self,
        auto: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(state) = self.clean_cut.as_ref() else {
            return div().into_any_element();
        };
        if state.review.is_some() {
            return self.render_clean_cut_review(window, cx);
        }
        let t = theme::resolve(None, window, cx);
        let gate = cloud_ai_upload_gate(state.entitlements.as_ref());
        let card = Card {
            state,
            posters: self.posters.as_ref(),
            capture: self.clean_cut_capture(),
            unlock: view::unlock(self.signed_in, &gate, state.capabilities.as_ref()),
            consented: self.consented,
            signed_in: self.signed_in,
            account_locked: !self.signed_in || !gate.allowed(),
        };

        let mut page = div().flex().flex_1().flex_col().w_full();
        // Locked means disabled with one reason, in the strip every Sidekick
        // tab leads with (plan 174 E-31): the switch and Make are off under it.
        if let Some(unlock) = card.unlock.as_ref() {
            page = page.child(
                div()
                    .flex_none()
                    .p(px(size::GUTTER))
                    .border_b_1()
                    .border_color(hsla(t.border))
                    .child(lock_alert(unlock)),
            );
        }
        // `ConfigGrid` + `CONFIG_GRID_PAIR`: flush sections, side by side
        // from 940 px of page (the kit measures it), filling the height with
        // the hairline between the columns and none under them.
        let switch = auto_section(&card, auto, t, cx).last(true);
        let recordings = recordings_section(&card, t, cx).last(true);
        page.child(super::config_grid_pair(
            "clean-cut-grid",
            switch,
            recordings,
        ))
        .child(consent_dialog(state, t, cx))
        .into_any_element()
    }
}

/// `LockAlert`: why Clean cut is locked, and the one way to unlock it.
fn lock_alert(unlock: &Unlock) -> Alert {
    let mut alert = Alert::new("clean-cut-unlock")
        .variant(AlertVariant::Locked)
        .title(unlock.reason.clone());
    if let Some(action) = unlock.action.clone() {
        let label = match &action {
            UnlockAction::SignIn => words::SIGN_IN,
            UnlockAction::ViewPremium { .. } => words::VIEW_PREMIUM,
        };
        alert = alert.action(
            Button::new("clean-cut-unlock-action")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(label)
                .on_click(move |_, _, cx| match &action {
                    UnlockAction::SignIn => crate::app::accounts::sign_in(cx),
                    UnlockAction::ViewPremium { url } => cx.open_url(url),
                }),
        );
    }
    alert
}

/// Section "Clean cut": the "every recording" switch, its status line and
/// the minutes left this month.
fn auto_section(
    card: &Card<'_>,
    auto: bool,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> PanelSection {
    let entity = cx.entity();
    let muted = hsla(t.muted_foreground);
    let status = view::auto_status(
        auto,
        card.unlock.as_ref(),
        card.consented,
        card.capture.active,
    );
    // On is a choice, not a health state, so only attention takes a colour.
    let tone = if status.kind == AutoStatusKind::Attention {
        StatusTone::Warn
    } else {
        StatusTone::Neutral
    };
    let mut line = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.))
        .type_scale(text::META)
        .text_color(muted)
        .child(StatusDot::new("clean-cut-auto-dot").tone(tone))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .text_color(hsla(t.foreground))
                .child(status.label),
        );
    if let Some(reason) = status.reason {
        line = line.child(div().child("·")).child(div().child(reason));
    }
    if status.allow_cloud_ai {
        let entity = entity.clone();
        line = line.child(
            Button::new("clean-cut-allow-cloud-ai")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(ALLOW_CLOUD)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| screen.ask_clean_cut_consent(window, cx));
                }),
        );
    }
    // A horizontal `Field` with a `FieldContent`: the label (14 px / 500)
    // over the status line, the switch at the top of the row.
    let field = div()
        .flex()
        .items_start()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_1()
                .min_w(px(0.))
                .flex_col()
                .gap(px(4.))
                .child(Label::new(CLEAN_CUT_AUTO_LABEL))
                .child(line),
        )
        .child(
            Switch::new("clean-cut-auto-switch")
                .accessibility_label(CLEAN_CUT_AUTO_LABEL)
                .checked(auto)
                .disabled(!auto && card.unlock.is_some())
                .on_change(move |on, window, cx| {
                    entity.update(cx, |screen, cx| screen.turn_clean_cut_auto(on, window, cx));
                }),
        );
    let mut section = PanelSection::new("sidekick-clean-cut")
        .title(CLEAN_CUT_TITLE)
        .description(CLEAN_CUT_DESCRIPTION)
        .child(field);
    let minutes_left = card
        .signed_in
        .then(|| view::minutes_left_label(card.state.capabilities.as_ref()))
        .flatten();
    if let Some(minutes_left) = minutes_left {
        section = section.action(Badge::new(minutes_left).variant(BadgeVariant::Outline));
    }
    section
}

/// Section "Recordings": every recording it can cut, the chosen one open
/// with its cut and what to do next.
fn recordings_section(
    card: &Card<'_>,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> PanelSection {
    let state = card.state;
    let section = PanelSection::new("sidekick-clean-cut-recordings")
        .title(RECORDINGS)
        .description(view::RECORDINGS_DESCRIPTION);
    let Some(selected) = state.selected() else {
        return section.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(CLEAN_CUT_NO_RECORDINGS),
        );
    };
    let chosen = selected_recording(card, selected, t, cx);
    section.child(recording_list(card, selected, chosen, t, cx))
}

/// `RecordingList`: six rows, then "Show all"; a search once there are more
/// than that. The chosen recording opens in place with `chosen`.
fn recording_list(
    card: &Card<'_>,
    selected: &SessionListItem,
    chosen: AnyElement,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let state = card.state;
    let entity = cx.entity();
    let muted = hsla(t.muted_foreground);
    let recordings = view::recent_recordings(&state.sessions, usize::MAX);
    let newest = recordings.first().map(|session| session.id.clone());
    let query = state.search.read(cx).value().to_string();
    let searching = !query.trim().is_empty();
    let matches = view::match_recordings(&recordings, &query);
    let mut rows: Vec<&SessionListItem> = if searching || state.show_all {
        matches.clone()
    } else {
        matches.iter().take(CLEAN_CUT_LIST_CAP).copied().collect()
    };
    // The chosen recording stays in view past the cap (a Library ask can
    // pick an older one); a search shows only what it matched.
    if !searching && !rows.iter().any(|session| session.id == selected.id) {
        rows.push(selected);
    }
    let can_expand = !searching && matches.len() > CLEAN_CUT_LIST_CAP;
    // The rows' posters from the Library's cache; a recording Clean cut can
    // cut is finished, so it has one once the backend is connected.
    let posters = card
        .posters
        .filter(|posters| posters.read(cx).serves())
        .cloned();
    if let Some(posters) = posters.as_ref() {
        let keys = rows
            .iter()
            .map(|session| (session.id.clone(), session.duration_ms))
            .collect::<Vec<_>>();
        posters.update(cx, |posters, cx| posters.want(POSTER_USER, keys, cx));
    }

    let mut list = div().flex().flex_col().min_w(px(0.)).gap(px(8.));
    if recordings.len() > CLEAN_CUT_LIST_CAP {
        list = list.child(
            InputGroup::new("clean-cut-search", &state.search)
                .accessibility_label(SEARCH_LABEL)
                .start(InputGroupAddon::start().child(icon(IconName::MagnifyingGlass, 16., muted))),
        );
    }
    if rows.is_empty() {
        list = list.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(view::no_recordings_match(&query)),
        );
    } else {
        let mut group = GroupedList::new();
        let mut chosen = Some(chosen);
        for session in rows {
            let is_chosen = session.id == selected.id;
            let title = match session.title.trim() {
                "" => view::UNTITLED.to_string(),
                title => title.to_string(),
            };
            let pick = (newest.as_deref() != Some(session.id.as_str())).then(|| session.id.clone());
            let poster = posters
                .as_ref()
                .and_then(|posters| posters.read(cx).get(&session.id, session.duration_ms));
            let job = view::latest_job_any_mode(&state.jobs, &session.id);
            let chip = view::row_chip(job, card.capture).map(|chip| row_chip(chip, &session.id, t));
            let row = recording_row(session, title, poster, chip, t, {
                let entity = entity.clone();
                move |_, _, cx| {
                    let pick = pick.clone();
                    entity.update(cx, |screen, cx| {
                        if let Some(clean) = screen.clean_cut.as_mut() {
                            clean.picked = pick;
                        }
                        cx.notify();
                    });
                }
            });
            let mut block = div()
                .flex()
                .flex_col()
                .min_w(px(0.))
                .when(is_chosen, |block| block.bg(hsla(t.accent)))
                .child(row);
            if is_chosen && let Some(chosen) = chosen.take() {
                block = block.child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w(px(0.))
                        .gap(px(8.))
                        .px(px(12.))
                        .pb(px(12.))
                        .child(chosen),
                );
            }
            group = group.item(block);
        }
        list = list.child(group);
    }
    if can_expand {
        list = list.child(
            div().child(
                Button::new("clean-cut-show-all")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label(view::show_all_label(state.show_all, matches.len()))
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |screen, cx| {
                            if let Some(clean) = screen.clean_cut.as_mut() {
                                clean.show_all = !clean.show_all;
                            }
                            cx.notify();
                        });
                    }),
            ),
        );
    }
    list.into_any_element()
}

/// A recording's row, drawn as the Library draws it (`RecordingList`'s
/// `ListRow` with `className="h-auto gap-3 py-1.5"`): the poster in the icon
/// tile (`SessionPoster`, or the video file glyph while there is none), the
/// title, its length and when it ran, and its newest cut's chip. The 64 × 36
/// poster makes it 48 px; flush in the grouped list, the whole row one
/// button.
fn recording_row(
    session: &SessionListItem,
    title: String,
    poster: Option<Arc<gpui::Image>>,
    chip: Option<Badge>,
    t: &Theme,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> ListRow {
    let mut row = ListRow::new(format!("clean-cut-rec-{}", session.id), title)
        .icon(posters::frame(POSTER_WIDTH, POSTER_HEIGHT, t).child(posters::picture(poster, t)))
        .context(view::recording_facts(session))
        .auto_height(true)
        .py(RECORDING_ROW_PADDING_Y)
        .gap(RECORDING_ROW_GAP)
        .on_click(on_click);
    if let Some(chip) = chip {
        row = row.child(chip);
    }
    row.grouped()
}

/// The chip of a recording's newest cut; the tone lives in its icon.
fn row_chip(chip: RowChip, session_id: &str, t: &Theme) -> Badge {
    let glyph = match chip.tone {
        ChipTone::Working => Spinner::new(format!("clean-cut-chip-spinner-{session_id}"))
            .size(12.)
            .into_any_element(),
        ChipTone::Ready => icon(IconName::CheckCircleFill, 12., hsla(t.success)).into_any_element(),
        ChipTone::Failed => {
            icon(IconName::WarningCircle, 12., hsla(t.destructive)).into_any_element()
        }
    };
    Badge::new(chip.label)
        .variant(BadgeVariant::Outline)
        .icon(glyph)
}

/// The chosen recording, open: the kind of cut, the condensed length, and
/// its cut's status with what to do next.
fn selected_recording(
    card: &Card<'_>,
    selected: &SessionListItem,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let state = card.state;
    let entity = cx.entity();
    let muted = hsla(t.muted_foreground);
    let mode = state.mode;
    let job = view::latest_job(&state.jobs, &selected.id, mode);
    let status = view::status_view(job, card.capture);
    let condensed = view::condensed_eligibility(selected);
    let condensed_blocked = mode == CleanCutMode::Condensed && condensed.is_err();
    let cannot_start = card.cannot_start(condensed_blocked);
    // Cutting again is local work: it needs the connection, not the cloud.
    let cannot_retry = if status.retry == Some(Retry::Render) {
        state.pending
    } else {
        cannot_start
    };

    let mut kind = div().flex().flex_wrap().items_center().gap(px(8.)).child(
        // `w-fit` in a wrapping row, as Electron's default.
        SegmentedControl::new("clean-cut-mode")
            .fit(true)
            .accessibility_label(KIND_OF_CUT)
            .value(Some(mode.as_str()))
            .option(Segment::new("clean", "Clean"))
            .option(Segment::new("condensed", "Condensed"))
            .on_change({
                let entity = entity.clone();
                move |value, _, cx| {
                    let mode = if &*value == "condensed" {
                        CleanCutMode::Condensed
                    } else {
                        CleanCutMode::Clean
                    };
                    entity.update(cx, |screen, cx| {
                        if let Some(clean) = screen.clean_cut.as_mut() {
                            clean.mode = mode;
                        }
                        cx.notify();
                    });
                }
            }),
    );
    if mode == CleanCutMode::Condensed && !condensed_blocked && !status.busy {
        let mut length = SegmentedControl::new("clean-cut-length")
            .small(true)
            .fit(true)
            .accessibility_label(CONDENSED_LENGTH)
            .value(Some(state.target_minutes.to_string()));
        for minutes in CONDENSED_TARGET_MINUTES {
            length = length.option(Segment::new(minutes.to_string(), format!("{minutes} min")));
        }
        let mut target = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(div().type_scale(text::META).text_color(muted).child(LENGTH))
            .child(length.on_change({
                let entity = entity.clone();
                move |value, _, cx| {
                    let Ok(minutes) = value.parse::<u32>() else {
                        return;
                    };
                    entity.update(cx, |screen, cx| {
                        if let Some(clean) = screen.clean_cut.as_mut() {
                            clean.target_minutes = minutes;
                        }
                        cx.notify();
                    });
                }
            }));
        if job.is_some() && !matches!(status.kind, StatusKind::None | StatusKind::Cancelled) {
            let entity = entity.clone();
            target = target.child(
                Button::new("clean-cut-make-again")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(MAKE_AGAIN)
                    .disabled(cannot_start)
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |screen, cx| screen.make_clean_cut(window, cx));
                    }),
            );
        }
        kind = kind.child(target);
    }

    let status_block = if let (true, Err(reason)) = (condensed_blocked, condensed) {
        ListRow::new("clean-cut-status", NOT_FOR_THIS_RECORDING)
            .icon(icon(IconName::Scissors, 16., muted))
            .context(reason)
            .into_any_element()
    } else if let (StatusKind::Failed, Some(job)) = (status.kind, job) {
        let mut actions = div().flex().items_center().gap(px(6.));
        if status.can_review {
            let entity = entity.clone();
            let job_id = job.id.clone();
            actions = actions.child(
                Button::new("clean-cut-failed-review")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label(REVIEW)
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |screen, cx| {
                            screen.open_clean_cut_review(job_id.clone(), window, cx)
                        });
                    }),
            );
        }
        let job_id = job.id.clone();
        let retry = status.retry;
        actions = actions.child(
            Button::new("clean-cut-retry")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .icon(IconName::ArrowCounterClockwise)
                .label(RETRY)
                .disabled(cannot_retry)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| {
                        screen.retry_clean_cut(job_id.clone(), retry, window, cx)
                    });
                }),
        );
        Alert::new("clean-cut-status")
            .variant(AlertVariant::Destructive)
            .title(view::failed_title(mode))
            .description(
                div()
                    .type_scale(text::META)
                    .child(status.detail.clone().unwrap_or_default()),
            )
            .action(actions)
            .into_any_element()
    } else {
        status_row(card, job, &status, cannot_start, t, cx)
    };

    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(kind)
        .child(status_block)
        .into_any_element()
}

/// The status row: its glyph, its words, and `StatusActions`.
fn status_row(
    card: &Card<'_>,
    job: Option<&CleanCutJob>,
    status: &view::StatusView,
    cannot_start: bool,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let muted = hsla(t.muted_foreground);
    // A spinner while a worker runs; the tone lives in the icon, the words
    // stay monochrome.
    let glyph = match status.kind {
        StatusKind::Ready => {
            icon(IconName::CheckCircleFill, 16., hsla(t.success)).into_any_element()
        }
        kind if kind.working() => Spinner::new("clean-cut-status-spinner")
            .color(t.muted_foreground)
            .into_any_element(),
        _ => icon(IconName::Scissors, 16., muted).into_any_element(),
    };
    // Edits kept from a review left open (E-5): the row says they wait.
    let unsaved = job
        .map(|job| clean_cut_drafts::read(&card.state.load_drafts(), &job.id).change_count())
        .unwrap_or(0);
    // `px-0`: the row sits flush in the chosen recording's block.
    let mut row = ListRow::new("clean-cut-status", status.label.clone())
        .icon(glyph)
        .flush(true);
    if unsaved > 0 {
        row = row.context(view::unsaved_label(unsaved));
    } else if let Some(detail) = status.detail.clone() {
        row = row.context(detail);
    }

    let review = |id: &'static str, variant: ButtonVariant, job: &CleanCutJob| {
        let entity = entity.clone();
        let job_id = job.id.clone();
        Button::new(id)
            .variant(variant)
            .label(REVIEW)
            .on_click(move |_, window, cx| {
                entity.update(cx, |screen, cx| {
                    screen.open_clean_cut_review(job_id.clone(), window, cx)
                });
            })
    };
    match job {
        Some(job) if !matches!(status.kind, StatusKind::None | StatusKind::Cancelled) => {
            if status.busy {
                if status.can_review {
                    row = row.child(review("clean-cut-review", ButtonVariant::Ghost, job));
                }
                let entity = entity.clone();
                let job_id = job.id.clone();
                row = row.child(
                    Button::new("clean-cut-cancel")
                        .variant(ButtonVariant::Ghost)
                        .label(CANCEL)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |screen, cx| {
                                screen.cancel_clean_cut(job_id.clone(), cx)
                            });
                        }),
                );
            } else {
                if status.can_review {
                    row = row.child(review("clean-cut-review", ButtonVariant::Outline, job));
                }
                if let Some(output) = job.output_session_id.clone() {
                    let reveal = entity.clone();
                    let reveal_id = output.clone();
                    let label = reveal_in_file_manager_label();
                    row = row
                        .child(
                            Button::new("clean-cut-reveal")
                                .variant(ButtonVariant::Ghost)
                                .icon(IconName::FolderOpen)
                                .label(label)
                                .on_click(move |_, _, cx| {
                                    reveal.update(cx, |screen, cx| {
                                        screen.reveal_clean_cut_output(&reveal_id, cx)
                                    });
                                }),
                        )
                        .child(
                            Button::new("clean-cut-open-library")
                                .variant(ButtonVariant::Ghost)
                                .icon(IconName::FilmReel)
                                .label(OPEN_IN_LIBRARY)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |_, cx| {
                                        cx.emit(OpenLibrarySession(output.clone()))
                                    });
                                }),
                        );
                }
            }
        }
        _ => {
            let make = view::make_label(card.state.mode);
            row = row.child(
                Button::new("clean-cut-make")
                    .variant(ButtonVariant::Default)
                    .icon(IconName::Scissors)
                    .label(make)
                    .disabled(cannot_start)
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |screen, cx| screen.make_clean_cut(window, cx));
                    }),
            );
        }
    }
    row.into_any_element()
}

/// `CleanCutConsentDialog`: cloud AI consent, asked where Clean cut needs
/// it (plan 119 decision 3), with the same one flag and list of uses as
/// Sidekick Live. Clean cut's own line leads, then what the same switch also
/// allows (plan 174 E-13). Declining changes nothing.
fn consent_dialog(
    state: &CleanCutState,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let decline = entity.clone();
    let auto = ConsentAsk::Auto;
    let ask = state.ask.as_ref().unwrap_or(&auto);
    let (lead, others) = view::consent_uses();
    let muted = hsla(t.muted_foreground);
    let mut uses = div().flex().flex_col().gap(px(4.)).pl(px(16.));
    for line in others {
        uses = uses.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(format!("• {line}")),
        );
    }
    Dialog::new(
        "clean-cut-consent",
        &state.consent,
        view::consent_title(ask),
    )
    .description(lead)
    .close_button(false)
    .child(
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(CLEAN_CUT_CONSENT_ALSO),
            )
            .child(uses),
    )
    .child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(CLOUD_AI_KEEPS),
    )
    .footer(
        Button::new("clean-cut-consent-not-now")
            .variant(ButtonVariant::Ghost)
            .label(view::CONSENT_DECLINE)
            .on_click(move |_, window, cx| {
                decline.update(cx, |screen, cx| {
                    screen.answer_clean_cut_consent(false, window, cx)
                });
            }),
    )
    .footer(
        Button::new("clean-cut-consent-allow")
            .variant(ButtonVariant::Default)
            .label(view::consent_accept(ask))
            .on_click(move |_, window, cx| {
                entity.update(cx, |screen, cx| {
                    screen.answer_clean_cut_consent(true, window, cx)
                });
            }),
    )
    .into_any_element()
}
