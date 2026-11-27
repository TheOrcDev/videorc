//! Sidekick → Clean cut → the review (`clean-cut-review.tsx`,
//! `clean-cut-transcript.tsx`): the source recording plays in the shared
//! embedded player with the cut list as a virtual preview (removed spans are
//! skipped), the transcript below shows every cut, and edits stay a draft
//! until "Save changes" sends one `cleanCut.updateEdl` and renders the cut
//! again. Keyboard-first: Space plays, ← → seek, ↑ ↓ walk the cuts, Enter
//! keeps or cuts one, ⌘S saves, ⌘Z and ⇧⌘Z undo and redo.
//!
//! The draft is kept per job (`clean_cut_drafts`), so leaving the tab or the
//! page never loses it; only the back button drops it, after the leave guard
//! asks. The model is `buddy::clean_cut_review`; this file draws it.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, FontWeight, KeyDownEvent, ListAlignment,
    ListState, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, SharedString,
    StrikethroughStyle, Subscription, UnderlineStyle, WeakEntity, Window, div, list, prelude::*,
    px,
};
use gpui_base::input as text_actions;
use serde_json::json;
use videorc_app_core::BackendClient;
use videorc_app_core::buddy::clean_cut_drafts;
use videorc_app_core::buddy::clean_cut_review::{
    self as model, Block, BlockKind, ChipState, Draft, GroupId, HISTORY_MAX, History, Item,
    KindChip, Paragraph, Pin, SaveStep, Span, Stats, Token, Tone,
};
use videorc_app_core::buddy::clean_cut_view::{self as view, Retry, StatusKind};
use videorc_app_core::buddy::moments::Moment;
use videorc_app_core::client::RpcError;
use videorc_app_core::format::plural;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::spinner::Spinner;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::toggle_group::{ToggleGroup, ToggleItem};
use videorc_kit::tokens::{Color, Theme, radius, size, text};
use videorc_kit::tooltip::tooltip;
use videorc_protocol::{
    CleanCutCondensedKeep, CleanCutEdl, CleanCutGetResult, CleanCutJob, CleanCutJobDetail,
    CleanCutMode, CleanCutRemoval, CleanCutRemovalKind, CleanCutTranscript,
    CleanCutTranscriptSegment, CleanCutTranscriptWord, RecordingFinalizationState, SessionListItem,
};

use super::SidekickScreen;
use super::clean_cut::OpenLibrarySession;
use crate::screens::session_player::{self, Player, PlayheadMoved};

const BACK_TO_CLEAN_CUT: &str = "Back to Clean cut";
const KIND_OF_CUT: &str = "Kind of cut";
const WHAT_PLAYS: &str = "What plays";
const PREVIEW_THE_CUT: &str = "Preview the cut";
const ORIGINAL: &str = "Original";
const KINDS_OF_CUTS: &str = "Kinds of cuts";
const CUT_SELECTION: &str = "Cut selection";
const SELECT_WORDS_FIRST: &str = "Select words in the transcript first.";
const UNDO: &str = "Undo";
const NOTHING_TO_UNDO: &str = "Nothing to undo yet.";
const REDO: &str = "Redo";
const NOTHING_TO_REDO: &str = "Nothing to redo.";
const FOLLOW_PLAYBACK: &str = "Follow playback";
const KEYS_HINT: &str = "↑ ↓ move between cuts · Enter keeps or cuts one · Space plays · click a word to jump there · select words to cut them";
const TRANSCRIPT_UNREADABLE: &str = "The transcript couldn't be read, so only the cuts show.";
const TRY_AGAIN: &str = "Try again";
const NO_SPEECH: &str = "No speech found";
const NO_SPEECH_DESCRIPTION: &str = "Only the start and the end can be trimmed.";
const COULDNT_OPEN: &str = "Couldn't open the cut";
const LOADING_TITLE: &str = "Loading the cut…";
const LOADING_DESCRIPTION: &str = "Reading the cut list and the transcript.";
const WAITING_DESCRIPTION: &str = "The review opens when the cut list is ready.";
const NO_CUT_TITLE: &str = "No cut yet";
const NO_CUT_DESCRIPTION: &str = "Make one from the list of recordings in Clean cut.";
const OPEN_CLEAN_CUT: &str = "Open Clean cut";
const RETRY: &str = "Retry";
const OPEN_IN_LIBRARY: &str = "Open in Library";
const DISCARD: &str = "Discard";
const SAVE_CHANGES: &str = "Save changes";
const SAVED_READY: &str = "Saved. The cut copy is in your Library.";
const SAVE_WHEN_FINISHED: &str = "You can save when this cut finishes.";
const LEAVE_TITLE: &str = "Leave without saving?";
const KEEP_EDITING: &str = "Keep editing";
const DISCARD_CHANGES: &str = "Discard changes";
const MOMENTS: &str = "Moments";
const DROPPED: &str = "Dropped";
const PLAYER_LOADING: &str = "Loading the player…";
const PLAYER_WAITS: &str = "Playback opens as soon as the recording is finished.";
const CUT_LIST_CHANGED: &str = "The cut list changed. Reload the review to see it.";
const CUT_LIST_REBASED: &str =
    "The cut list changed while you edited. Your changes are on the newest one; save again.";
/// `REFUSAL_EDL_REVISION_CONFLICT`: the cut list moved on under the draft.
const REVISION_CONFLICT: &str = "edl-revision-conflict";

/// The picture's height in the review (the player sits beside its controls).
const PLAYER_HEIGHT: f32 = 240.;
/// 16:9 of the picture's height.
const PLAYER_WIDTH: f32 = PLAYER_HEIGHT * 16. / 9.;
/// How far the transcript list measures past its edges.
const OVERDRAW_PX: f32 = 400.;
/// ← → seek this far.
const SEEK_STEP_MS: f64 = 5_000.;

/// What a click on a word does when the press never moved: a plain word
/// seeks there, a word inside a cut keeps or cuts it.
#[derive(Debug, Clone)]
enum WordClick {
    Seek(u64),
    Toggle(String),
}

/// A press on a word: a drag from it selects words, a click does its
/// [`WordClick`] on release.
struct Press {
    anchor: usize,
    moved: bool,
    click: Option<WordClick>,
}

/// One job's cut list, its Condensed parts and its transcript.
struct ReviewData {
    job: CleanCutJob,
    edl: CleanCutEdl,
    keeps: Vec<CleanCutCondensedKeep>,
    /// In time order (`normalizeTranscriptWords`).
    words: Vec<CleanCutTranscriptWord>,
    segments: Vec<CleanCutTranscriptSegment>,
    /// False when the transcript couldn't be read: the cuts still show.
    transcript_read: bool,
}

/// `ReviewLoad`.
enum Load {
    Loading,
    /// The cut list couldn't be read: why, in plain words.
    Error(String),
    /// No cut list yet (or no job of this kind): the job, if any.
    Waiting(Option<Box<CleanCutJob>>),
    Ready(Box<ReviewData>),
}

/// What "Save changes" answered.
enum SaveAnswer {
    Saved {
        detail: Box<CleanCutJobDetail>,
        render: Result<Box<CleanCutJob>, RpcError>,
    },
    /// The cut list moved on: the newest one, if it could be read.
    Conflict(Result<Option<Box<CleanCutJobDetail>>, RpcError>),
    Failed(RpcError),
}

/// Everything the transcript and the strip read, worked out once per edit.
struct Derived {
    effective: Vec<CleanCutRemoval>,
    by_id: HashMap<String, CleanCutRemoval>,
    items: Vec<Item>,
    rows: HashMap<String, usize>,
    word_rows: HashMap<usize, usize>,
    order: Vec<CleanCutRemoval>,
    chips: Vec<KindChip>,
    stats: Stats,
    blocks: Option<Vec<Block>>,
}

/// What the paragraphs were laid out from: the saved list (job, revision),
/// a Clean draft's own new cuts, and the pins.
type ParagraphsKey = (String, u32, Vec<model::DraftManual>, usize);

/// The open review (Electron's `CleanCutReview` state).
pub struct ReviewState {
    session_id: String,
    mode: CleanCutMode,
    /// The job asked for; `None` follows the newest job of `mode`.
    job_id: Option<String>,
    load: Load,
    /// Only the newest load lands.
    generation: u64,
    draft: Draft,
    /// The job `draft` belongs to.
    draft_job: Option<String>,
    history: History,
    pins: Vec<Pin>,
    paragraphs: Rc<Vec<Paragraph>>,
    paragraphs_key: Option<ParagraphsKey>,
    derived: Option<Rc<Derived>>,
    selected_id: Option<String>,
    /// Words selected in the transcript, as (anchor, focus) word indexes.
    selection: Option<(usize, usize)>,
    press: Option<Press>,
    follow: bool,
    followed_row: Option<usize>,
    preview: bool,
    position_ms: u64,
    saving: bool,
    retrying: bool,
    notice: Option<String>,
    leave: DialogHandle,
    focus: FocusHandle,
    list: ListState,
    player: Option<Entity<Player>>,
    /// The player shows this review's recording now.
    player_open: bool,
    _playhead: Option<Subscription>,
}

impl ReviewState {
    fn data(&self) -> Option<&ReviewData> {
        match &self.load {
            Load::Ready(data) => Some(data),
            _ => None,
        }
    }

    fn condensed(&self) -> bool {
        self.data()
            .is_some_and(|data| data.job.mode == CleanCutMode::Condensed)
    }

    /// The job the status reads: the cut's, or the one being waited for.
    fn job(&self) -> Option<&CleanCutJob> {
        match &self.load {
            Load::Ready(data) => Some(&data.job),
            Load::Waiting(job) => job.as_deref(),
            _ => None,
        }
    }

    /// `selectionCutRange`: the selected words as one span (Clean only:
    /// Condensed lays out from its saved parts).
    fn selection_range(&self) -> Option<Span> {
        let data = self.data()?;
        if data.job.mode == CleanCutMode::Condensed {
            return None;
        }
        let (anchor, focus) = self.selection?;
        let indexes: Vec<usize> = (anchor.min(focus)..=anchor.max(focus)).collect();
        model::selection_cut_range(&data.words, &indexes)
    }

    fn active_word(&self) -> Option<usize> {
        model::active_word_index(&self.data()?.words, self.position_ms as f64)
    }

    /// A job opens on its kept draft (E-5), carried onto the saved list as
    /// it stands now: a change the list already has leaves the draft.
    fn adopt_draft(&mut self, stored: &[clean_cut_drafts::Stored]) {
        if let Load::Ready(data) = &self.load
            && self.draft_job.as_deref() != Some(data.job.id.as_str())
        {
            self.draft_job = Some(data.job.id.clone());
            self.draft = model::rebase_draft(
                &clean_cut_drafts::read(stored, &data.job.id),
                &data.edl.removals,
            );
            self.history = History::default();
            self.selected_id = None;
            self.selection = None;
        }
    }

    /// Works the transcript and the strip out again after an edit or a load.
    /// The paragraphs come from the saved list, so a toggle never re-runs
    /// their layout.
    fn relayout(&mut self) {
        let Load::Ready(data) = &self.load else {
            self.derived = None;
            self.list.reset(0);
            return;
        };
        let saved = &data.edl.removals;
        let condensed = data.job.mode == CleanCutMode::Condensed;
        let effective = model::effective_removals(saved, &self.draft);
        let key: ParagraphsKey = (
            data.job.id.clone(),
            data.job.edl_revision,
            if condensed {
                Vec::new()
            } else {
                self.draft.add_manual.clone()
            },
            self.pins.len(),
        );
        if self.paragraphs_key.as_ref() != Some(&key) {
            let saved_blocks = condensed.then(|| {
                model::condensed_blocks(data.edl.duration_ms, &data.keeps, saved, &data.words)
            });
            let breaks: Vec<u64> = saved_blocks
                .iter()
                .flatten()
                .map(|block| block.start_ms)
                .collect();
            // A cut made from a selection is struck like the saved ones.
            let mut removals = saved.clone();
            if !condensed {
                removals.extend(model::draft_manual_removals(&self.draft));
            }
            let skip: &[CleanCutRemovalKind] = if condensed {
                &[CleanCutRemovalKind::Condensed]
            } else {
                &[]
            };
            self.paragraphs = Rc::new(model::build_paragraphs(model::LayoutInput {
                words: &data.words,
                segments: &data.segments,
                removals: &removals,
                pins: &self.pins,
                breaks_ms: &breaks,
                skip_kinds: skip,
            }));
            self.paragraphs_key = Some(key);
        }
        let blocks = condensed.then(|| {
            model::condensed_blocks(data.edl.duration_ms, &data.keeps, &effective, &data.words)
        });
        let items = model::transcript_items(&self.paragraphs, blocks.as_deref());
        let rows = model::removal_row_index(&items);
        let word_rows = model::word_rows(&items);
        let order = model::navigable_removals(&effective, &rows);
        let chips = model::kind_chips(&effective);
        let stats = model::stats(
            data.edl.duration_ms,
            saved,
            &effective,
            Some(data.edl.stats.kept_ms),
        );
        let by_id = effective
            .iter()
            .map(|removal| (removal.id.clone(), removal.clone()))
            .collect();
        let count = items.len();
        self.derived = Some(Rc::new(Derived {
            effective,
            by_id,
            items,
            rows,
            word_rows,
            order,
            chips,
            stats,
            blocks,
        }));
        if self.list.item_count() == count {
            self.list.remeasure();
        } else {
            self.list.reset(count);
        }
    }

    /// The ranges the player skips: every cut, or none for "Original".
    fn skip_ranges(&self) -> Vec<Span> {
        match (&self.derived, self.preview) {
            (Some(derived), true) => model::cut_skip_ranges(&derived.effective),
            _ => Vec::new(),
        }
    }
}

/// `pickDetail`: the job asked for, else the newest of the kind.
fn pick_detail(
    mut jobs: Vec<CleanCutJobDetail>,
    mode: CleanCutMode,
    job_id: Option<&str>,
) -> Option<CleanCutJobDetail> {
    let index = job_id
        .and_then(|id| jobs.iter().position(|detail| detail.job.id == id))
        .or_else(|| jobs.iter().position(|detail| detail.job.mode == mode))?;
    Some(jobs.swap_remove(index))
}

fn invalid(method: &str, error: serde_json::Error) -> RpcError {
    RpcError::new(method, "invalid-response", error.to_string())
}

/// `cleanCut.get` for the recording, then the chosen job's transcript.
async fn load_review(
    backend: Arc<BackendClient>,
    session_id: String,
    mode: CleanCutMode,
    job_id: Option<String>,
) -> Load {
    let answer = backend
        .request("cleanCut.get", json!({ "sessionId": session_id }))
        .await
        .and_then(|value| {
            serde_json::from_value::<CleanCutGetResult>(value)
                .map_err(|error| invalid("cleanCut.get", error))
        });
    let jobs = match answer {
        Ok(result) => result.jobs,
        Err(error) => {
            log_failure(&error);
            return Load::Error(view::error_reason(&error));
        }
    };
    let Some(detail) = pick_detail(jobs, mode, job_id.as_deref()) else {
        return Load::Waiting(None);
    };
    let Some(edl) = detail.edl else {
        return Load::Waiting(Some(Box::new(detail.job)));
    };
    let transcript = backend
        .request("cleanCut.transcript", json!({ "jobId": detail.job.id }))
        .await
        .ok()
        .and_then(|value| serde_json::from_value::<CleanCutTranscript>(value).ok());
    let transcript_read = transcript.is_some();
    let (words, segments) = transcript
        .map(|transcript| (transcript.words, transcript.segments))
        .unwrap_or_default();
    Load::Ready(Box::new(ReviewData {
        job: detail.job,
        edl,
        keeps: detail.condensed_keeps,
        words: model::normalize_words(words),
        segments,
        transcript_read,
    }))
}

/// `cleanCut.updateEdl`, then `cleanCut.render`; on a revision conflict,
/// the newest cut list.
async fn save_review(
    backend: Arc<BackendClient>,
    params: serde_json::Value,
    job_id: String,
    session_id: String,
    mode: CleanCutMode,
) -> SaveAnswer {
    let detail = backend
        .request("cleanCut.updateEdl", params)
        .await
        .and_then(|value| {
            serde_json::from_value::<CleanCutJobDetail>(value)
                .map_err(|error| invalid("cleanCut.updateEdl", error))
        });
    match detail {
        Ok(detail) => {
            let render = backend
                .request("cleanCut.render", json!({ "jobId": job_id }))
                .await
                .and_then(|value| {
                    serde_json::from_value::<CleanCutJob>(value)
                        .map(Box::new)
                        .map_err(|error| invalid("cleanCut.render", error))
                });
            SaveAnswer::Saved {
                detail: Box::new(detail),
                render,
            }
        }
        Err(error) if error.code == REVISION_CONFLICT => {
            let fresh = backend
                .request("cleanCut.get", json!({ "sessionId": session_id }))
                .await
                .and_then(|value| {
                    serde_json::from_value::<CleanCutGetResult>(value)
                        .map_err(|error| invalid("cleanCut.get", error))
                })
                .map(|result| pick_detail(result.jobs, mode, Some(job_id.as_str())).map(Box::new));
            SaveAnswer::Conflict(fresh)
        }
        Err(error) => SaveAnswer::Failed(error),
    }
}

/// The raw failure goes to the log; the review says it in plain words.
fn log_failure(error: &RpcError) {
    eprintln!(
        "[videorc-app] Clean cut review: {} failed ({}): {}",
        error.method, error.code, error.message
    );
}

fn tone_color(tone: Tone, t: &Theme) -> Color {
    match tone {
        Tone::Neutral => t.muted_foreground,
        Tone::Warning => t.warning,
        Tone::Destructive => t.destructive,
        Tone::Info => t.info,
    }
}

fn clock(ms: u64) -> String {
    view::format_cut_clock(i64::try_from(ms).unwrap_or(i64::MAX))
}

fn pin_icon(kind: &str) -> IconName {
    match kind {
        "voice" => IconName::Microphone,
        "manual" => IconName::Scissors,
        "chat" => IconName::ChatCircle,
        _ => IconName::PushPin,
    }
}

/// The recording plays once it is finished and no longer being written.
fn playable(source: Option<&SessionListItem>) -> bool {
    source.is_none_or(|session| {
        session.status == "completed"
            && session.finalization_state != Some(RecordingFinalizationState::Finalizing)
    })
}

impl SidekickScreen {
    fn review(&self) -> Option<&ReviewState> {
        self.clean_cut.as_ref()?.review.as_ref()
    }

    fn review_mut(&mut self) -> Option<&mut ReviewState> {
        self.clean_cut.as_mut()?.review.as_mut()
    }

    /// Opens one job's review in place of the card, its recording in the
    /// shared player.
    pub(crate) fn open_clean_cut_review(
        &mut self,
        job_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((session_id, mode)) = self.clean_cut.as_ref().and_then(|clean| {
            clean
                .jobs
                .iter()
                .find(|job| job.id == job_id)
                .map(|job| (job.source_session_id.clone(), job.mode))
        }) else {
            return;
        };
        self.close_clean_cut_review(cx);
        let player = session_player::hosted(session_player::Mode::Embedded, window, cx);
        let playhead = player.as_ref().map(|player| {
            player.update(cx, |player, cx| player.set_slot_height(PLAYER_HEIGHT, cx));
            cx.subscribe(player, |screen, _, moved: &PlayheadMoved, cx| {
                screen.review_playhead(moved.0, cx)
            })
        });
        let review = ReviewState {
            session_id,
            mode,
            job_id: Some(job_id),
            load: Load::Loading,
            generation: 0,
            draft: Draft::default(),
            draft_job: None,
            history: History::default(),
            pins: Vec::new(),
            paragraphs: Rc::new(Vec::new()),
            paragraphs_key: None,
            derived: None,
            selected_id: None,
            selection: None,
            press: None,
            follow: true,
            followed_row: None,
            preview: true,
            position_ms: 0,
            saving: false,
            retrying: false,
            notice: None,
            leave: DialogHandle::new(false),
            focus: cx.focus_handle(),
            list: ListState::new(0, ListAlignment::Top, px(OVERDRAW_PX)),
            player,
            player_open: false,
            _playhead: playhead,
        };
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        clean.review = Some(review);
        // The review opens ready for the keys.
        cx.on_next_frame(window, |screen, window, cx| {
            if let Some(review) = screen.review() {
                review.focus.focus(window, cx);
            }
        });
        self.load_clean_cut_review(cx);
        self.load_clean_cut_review_pins(cx);
        cx.notify();
    }

    /// Leaves the review: the player stops and the card comes back. The kept
    /// draft stays for the next time.
    pub(crate) fn close_clean_cut_review(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self
            .clean_cut
            .as_mut()
            .and_then(|clean| clean.review.take())
        else {
            return;
        };
        if let Some(player) = review.player {
            player.update(cx, |player, cx| player.close(cx));
        }
        cx.notify();
    }

    /// The page or the tab stopped showing the review: the player stops
    /// (its picture is a native layer); it opens again when the review shows.
    pub(crate) fn hide_clean_cut_review_player(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        if !review.player_open {
            return;
        }
        review.player_open = false;
        if let Some(player) = review.player.clone() {
            player.update(cx, |player, cx| player.close(cx));
        }
    }

    /// The shell shows or hides the Sidekick page.
    pub(crate) fn set_page_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        self.page_shown = shown;
        self.sync_community_preview_active(cx);
        if !shown {
            self.hide_clean_cut_review_player(cx);
        }
    }

    /// The player opens on the recording once the cut list is there and the
    /// review is on screen.
    fn review_wants_player(&self) -> bool {
        let Some(clean) = self.clean_cut.as_ref() else {
            return false;
        };
        let Some(review) = clean.review.as_ref() else {
            return false;
        };
        let source = clean
            .sessions
            .iter()
            .find(|session| session.id == review.session_id);
        review.data().is_some()
            && !review.player_open
            && review.player.is_some()
            && playable(source)
    }

    fn review_open_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.review_wants_player() {
            return;
        }
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let Some(review) = clean.review.as_mut() else {
            return;
        };
        let Some(player) = review.player.clone() else {
            return;
        };
        review.player_open = true;
        let session_id = review.session_id.clone();
        let spans = review.skip_ranges();
        let source = clean
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned();
        player.update(cx, |player, cx| {
            match &source {
                Some(session) => player.open(session, window, cx),
                // Not in the card's list: the Library's own rows.
                None => {
                    if !player.open_session(&session_id, window, cx) {
                        eprintln!(
                            "[videorc-app] Clean cut review: no Library row for session {session_id}"
                        );
                    }
                }
            }
            player.set_skip_ranges(&spans);
        });
    }

    /// `cleanCut.get` (and the transcript) for the review's recording and
    /// kind. A review that shows a cut keeps it until the new one lands.
    fn load_clean_cut_review(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        review.generation += 1;
        let generation = review.generation;
        if review.data().is_none() {
            review.load = Load::Loading;
        }
        let (session_id, mode, job_id) = (
            review.session_id.clone(),
            review.mode,
            review.job_id.clone(),
        );
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(load_review(backend, session_id, mode, job_id));
        cx.spawn(async move |this, cx| {
            let Ok(loaded) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                screen.review_loaded(generation, loaded, cx)
            });
        })
        .detach();
        cx.notify();
    }

    fn review_loaded(&mut self, generation: u64, loaded: Load, cx: &mut Context<Self>) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let stored = clean.load_drafts();
        let Some(review) = clean.review.as_mut() else {
            return;
        };
        if review.generation != generation {
            return;
        }
        review.load = loaded;
        review.adopt_draft(&stored);
        if review.data().is_none() {
            // The Ready layout (and its player slot) is gone.
            self.hide_clean_cut_review_player(cx);
        }
        self.review_changed(cx);
    }

    /// The report's moments, as pins on the transcript and beside the player.
    fn load_clean_cut_review_pins(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.review().map(|review| review.session_id.clone()) else {
            return;
        };
        let backend = self.studio.backend().clone();
        let ask = session_id.clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.report.get", json!({ "sessionId": ask }))
                .await
                .ok()
                .and_then(|value| value.get("moments").cloned())
                .and_then(|moments| serde_json::from_value::<Vec<Moment>>(moments).ok())
                .unwrap_or_default()
        });
        cx.spawn(async move |this, cx| {
            let Ok(moments) = job.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                let Some(review) = screen.review_mut() else {
                    return;
                };
                if review.session_id != session_id {
                    return;
                }
                review.pins = model::pins(&moments);
                review.relayout();
                cx.notify();
            });
        })
        .detach();
    }

    /// A `cleanCut.status` snapshot: render progress on the open cut, and
    /// the cut list arriving while the review waits.
    pub(crate) fn clean_cut_review_job(&mut self, job: &CleanCutJob, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        let waits = job.source_session_id == review.session_id
            && job.mode == review.mode
            && matches!(review.load, Load::Waiting(_));
        if let Load::Ready(data) = &mut review.load
            && data.job.id == job.id
        {
            data.job = job.clone();
        } else if waits && job.edl_summary.is_none() {
            review.load = Load::Waiting(Some(Box::new(job.clone())));
        } else if waits {
            self.load_clean_cut_review(cx);
            return;
        } else {
            return;
        }
        cx.notify();
    }

    /// After every edit or load: the layout, the kept draft on disk, and
    /// what the player skips.
    fn review_changed(&mut self, cx: &mut Context<Self>) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let stored = clean.load_drafts();
        let next = {
            let Some(review) = clean.review.as_mut() else {
                return;
            };
            review.relayout();
            review
                .draft_job
                .as_deref()
                .and_then(|job_id| clean_cut_drafts::write(&stored, job_id, &review.draft))
        };
        // Every change is kept at once, so no way out of the review loses it.
        if let Some(next) = next {
            clean.persist_drafts(&next);
        }
        self.review_sync_skip(cx);
        cx.notify();
    }

    fn review_sync_skip(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review() else {
            return;
        };
        let Some(player) = review.player.clone() else {
            return;
        };
        let spans = review.skip_ranges();
        player.update(cx, |player, _| player.set_skip_ranges(&spans));
    }

    /// Every change to the draft: undoable, and it clears a stale notice.
    fn review_edit(&mut self, next: Draft, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        if next == review.draft {
            return;
        }
        let previous = std::mem::replace(&mut review.draft, next);
        review.history.record(previous, HISTORY_MAX);
        review.notice = None;
        self.review_changed(cx);
    }

    fn review_undo(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        if review.leave.is_open() {
            return;
        }
        let current = review.draft.clone();
        let Some(draft) = review.history.undo(current) else {
            return;
        };
        review.draft = draft;
        review.notice = None;
        self.review_changed(cx);
    }

    fn review_redo(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        if review.leave.is_open() {
            return;
        }
        let current = review.draft.clone();
        let Some(draft) = review.history.redo(current) else {
            return;
        };
        review.draft = draft;
        review.notice = None;
        self.review_changed(cx);
    }

    /// Keep or cut one removal; it becomes the selected one.
    fn review_toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        let Load::Ready(data) = &review.load else {
            return;
        };
        let next = model::toggle_removal(&review.draft, &data.edl.removals, id);
        if next != review.draft {
            let previous = std::mem::replace(&mut review.draft, next);
            review.history.record(previous, HISTORY_MAX);
        }
        review.selected_id = Some(id.to_string());
        review.notice = None;
        self.review_changed(cx);
    }

    fn review_toggle_group(&mut self, group: GroupId, cx: &mut Context<Self>) {
        let Some(next) = self.review().and_then(|review| {
            let data = review.data()?;
            Some(model::toggle_kind_group(
                &review.draft,
                &data.edl.removals,
                group,
            ))
        }) else {
            return;
        };
        self.review_edit(next, cx);
    }

    fn review_toggle_block(&mut self, block: &Block, cx: &mut Context<Self>) {
        let Some(next) = self.review().and_then(|review| {
            let data = review.data()?;
            Some(model::toggle_condensed_block(
                &review.draft,
                &data.edl.removals,
                block,
            ))
        }) else {
            return;
        };
        self.review_edit(next, cx);
    }

    /// "Cut selection": the words selected in the transcript become one cut.
    fn review_cut_selection(&mut self, cx: &mut Context<Self>) {
        let Some(next) = self.review().and_then(|review| {
            let span = review.selection_range()?;
            Some(model::add_draft_manual(&review.draft, span))
        }) else {
            return;
        };
        if let Some(review) = self.review_mut() {
            review.selection = None;
        }
        self.review_edit(next, cx);
    }

    /// Selects a removal: its row scrolls into view, and ↑ ↓ put the
    /// playhead a moment before it.
    fn review_select(&mut self, id: Option<String>, seek: bool, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        review.selected_id = id.clone();
        let Some(id) = id else {
            cx.notify();
            return;
        };
        let Some(derived) = review.derived.clone() else {
            return;
        };
        if let Some(row) = derived.rows.get(&id) {
            review.list.scroll_to_reveal_item(*row);
        }
        if seek
            && let Some(removal) = derived.by_id.get(&id)
            && let Some(player) = review.player.as_ref()
        {
            player.read(cx).seek_to(model::preroll_ms(removal) as f64);
        }
        cx.notify();
    }

    fn review_seek(&self, ms: u64, cx: &mut Context<Self>) {
        if let Some(player) = self.review().and_then(|review| review.player.as_ref()) {
            player.read(cx).seek_to(ms as f64);
        }
    }

    /// Following: the row under the playhead scrolls into view as it plays.
    fn review_playhead(&mut self, ms: u64, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        review.position_ms = ms;
        if review.follow
            && let Some(derived) = review.derived.clone()
            && let Some(row) = review
                .active_word()
                .and_then(|word| derived.word_rows.get(&word).copied())
            && review.followed_row != Some(row)
        {
            review.followed_row = Some(row);
            review.list.scroll_to_reveal_item(row);
        }
        cx.notify();
    }

    fn review_press(
        &mut self,
        index: usize,
        click: WordClick,
        shift: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.review_mut() else {
            return;
        };
        if shift && let Some((anchor, _)) = review.selection {
            review.selection = Some((anchor, index));
            review.press = Some(Press {
                anchor,
                moved: true,
                click: None,
            });
        } else {
            review.press = Some(Press {
                anchor: index,
                moved: false,
                click: Some(click),
            });
        }
        cx.notify();
    }

    /// A drag over the words selects them for "Cut selection".
    fn review_drag(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        let Some(press) = review.press.as_mut() else {
            return;
        };
        if !press.moved && index == press.anchor {
            return;
        }
        press.moved = true;
        let next = Some((press.anchor, index));
        if review.selection != next {
            review.selection = next;
            cx.notify();
        }
    }

    /// A press that never moved is a click: a word seeks, a cut flips.
    fn review_release(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        let Some(press) = review.press.take() else {
            return;
        };
        if press.moved {
            cx.notify();
            return;
        }
        review.selection = None;
        match press.click {
            Some(WordClick::Seek(ms)) => self.review_seek(ms, cx),
            Some(WordClick::Toggle(id)) => self.review_toggle(&id, cx),
            None => {}
        }
        cx.notify();
    }

    /// A press on the transcript outside the words drops the selection.
    fn review_tap_transcript(&mut self, cx: &mut Context<Self>) {
        if let Some(review) = self.review_mut()
            && review.press.is_none()
            && review.selection.take().is_some()
        {
            cx.notify();
        }
    }

    /// "Kind of cut": the other kind's newest job.
    fn review_switch_mode(&mut self, mode: CleanCutMode, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        if review.mode == mode {
            return;
        }
        review.mode = mode;
        review.job_id = None;
        self.load_clean_cut_review(cx);
    }

    fn review_set_preview(&mut self, preview: bool, cx: &mut Context<Self>) {
        if let Some(review) = self.review_mut() {
            review.preview = preview;
        }
        self.review_sync_skip(cx);
        cx.notify();
    }

    fn review_set_follow(&mut self, follow: bool, cx: &mut Context<Self>) {
        if let Some(review) = self.review_mut() {
            review.follow = follow;
            review.followed_row = None;
        }
        cx.notify();
    }

    /// The back button: the leave guard asks first when edits are unsaved.
    fn review_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(review) = self.review() else {
            return;
        };
        if review.draft.change_count() > 0 {
            review.leave.open(window, cx);
            cx.notify();
        } else {
            self.close_clean_cut_review(cx);
        }
    }

    fn review_keep_editing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(review) = self.review() {
            review.leave.close(window, cx);
        }
        cx.notify();
    }

    /// "Discard changes": the kept draft goes, then the review closes.
    fn review_discard_and_leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let stored = clean.load_drafts();
        let Some(review) = clean.review.as_ref() else {
            return;
        };
        review.leave.close(window, cx);
        let next = review
            .draft_job
            .as_deref()
            .and_then(|job_id| clean_cut_drafts::write(&stored, job_id, &Draft::default()));
        if let Some(next) = next {
            clean.persist_drafts(&next);
        }
        self.close_clean_cut_review(cx);
    }

    /// "Save changes": one `cleanCut.updateEdl`, then the cut renders again.
    /// The review stays editable while it saves (QA F16).
    fn save_clean_cut_review(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        let changes = review.draft.change_count();
        let Some(data) = review.data() else {
            return;
        };
        if changes == 0 || review.saving {
            return;
        }
        if !view::job_editable(&data.job) {
            review.notice = Some(SAVE_WHEN_FINISHED.to_string());
            cx.notify();
            return;
        }
        let job_id = data.job.id.clone();
        let params = serde_json::to_value(model::update_edl_payload(
            &job_id,
            data.job.edl_revision,
            &review.draft,
        ))
        .unwrap_or_default();
        let before = data.edl.removals.clone();
        let submitted = review.draft.clone();
        let history_at_save = review.history.clone();
        let (session_id, mode) = (review.session_id.clone(), review.mode);
        review.saving = true;
        review.notice = None;
        let backend = self.studio.backend().clone();
        let saved_job = job_id.clone();
        let job = self
            .runtime
            .spawn(save_review(backend, params, job_id, session_id, mode));
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                let Ok(answer) = answer else {
                    if let Some(review) = screen.review_mut() {
                        review.saving = false;
                    }
                    cx.notify();
                    return;
                };
                screen.review_saved(saved_job, answer, submitted, before, history_at_save, cx);
            });
        })
        .detach();
        cx.notify();
    }

    fn review_saved(
        &mut self,
        job_id: String,
        answer: SaveAnswer,
        submitted: Draft,
        before: Vec<CleanCutRemoval>,
        history_at_save: History,
        cx: &mut Context<Self>,
    ) {
        let Some(clean) = self.clean_cut.as_mut() else {
            return;
        };
        let stored = clean.load_drafts();
        let Some(review) = clean.review.as_mut() else {
            return;
        };
        review.saving = false;
        let mut elsewhere: Option<Vec<clean_cut_drafts::Stored>> = None;
        match answer {
            SaveAnswer::Saved { detail, render } => {
                let detail = *detail;
                if let Load::Ready(data) = &mut review.load
                    && data.job.id == detail.job.id
                {
                    data.job = detail.job.clone();
                    if let Some(edl) = &detail.edl {
                        data.edl = edl.clone();
                    }
                }
                let on_this_job = review.draft_job.as_deref() == Some(job_id.as_str());
                match &detail.edl {
                    Some(after) => {
                        let step = SaveStep {
                            submitted: &submitted,
                            before: &before,
                            after: &after.removals,
                        };
                        if !on_this_job {
                            // The review moved to the other cut while saving: its
                            // draft stays, and the saved cut's kept draft loses
                            // what the save carried.
                            let kept = model::rebase_draft_after_save(
                                &clean_cut_drafts::read(&stored, &job_id),
                                step,
                            );
                            elsewhere = clean_cut_drafts::write(&stored, &job_id, &kept);
                        } else if review.draft == submitted {
                            review.draft = Draft::default();
                            review.history = History::default();
                        } else {
                            review.draft = model::rebase_draft_after_save(&review.draft, step);
                            review.history = model::rebase_history_after_save(
                                &review.history,
                                &history_at_save,
                                step,
                            );
                        }
                    }
                    None if on_this_job => {
                        review.draft = Draft::default();
                        review.history = History::default();
                    }
                    None => {}
                }
                match render {
                    Ok(job) => {
                        if let Load::Ready(data) = &mut review.load
                            && data.job.id == job.id
                        {
                            data.job = *job;
                        }
                    }
                    Err(error) => {
                        log_failure(&error);
                        review.notice = Some(format!(
                            "Your changes are saved, but the cut didn't start. {}",
                            view::error_reason(&error)
                        ));
                    }
                }
            }
            SaveAnswer::Conflict(fresh) => match fresh {
                Ok(Some(fresh)) => match *fresh {
                    CleanCutJobDetail {
                        job,
                        edl: Some(edl),
                        ..
                    } => {
                        review.draft = model::rebase_draft(&review.draft, &edl.removals);
                        review.history = History::default();
                        if let Load::Ready(data) = &mut review.load {
                            data.job = job;
                            data.edl = edl;
                        }
                        review.notice = Some(CUT_LIST_REBASED.to_string());
                    }
                    _ => review.notice = Some(CUT_LIST_CHANGED.to_string()),
                },
                Ok(None) => review.notice = Some(CUT_LIST_CHANGED.to_string()),
                Err(error) => {
                    log_failure(&error);
                    review.notice = Some(format!(
                        "Couldn't load the newest cut list. {}",
                        view::error_reason(&error)
                    ));
                }
            },
            SaveAnswer::Failed(error) => {
                log_failure(&error);
                review.notice = Some(format!(
                    "Couldn't save your changes. {}",
                    view::error_reason(&error)
                ));
            }
        }
        if let Some(next) = elsewhere {
            clean.persist_drafts(&next);
        }
        self.review_changed(cx);
    }

    /// Footer "Retry": a failed render runs again.
    fn review_retry_render(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review_mut() else {
            return;
        };
        let Some(job_id) = review.job().map(|job| job.id.clone()) else {
            return;
        };
        review.retrying = true;
        review.notice = None;
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cleanCut.render", json!({ "jobId": job_id }))
                .await
                .and_then(|value| {
                    serde_json::from_value::<CleanCutJob>(value)
                        .map_err(|error| invalid("cleanCut.render", error))
                })
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                let Some(review) = screen.review_mut() else {
                    return;
                };
                review.retrying = false;
                match answer {
                    Ok(Ok(job)) => {
                        if let Load::Ready(data) = &mut review.load
                            && data.job.id == job.id
                        {
                            data.job = job;
                        }
                    }
                    Ok(Err(error)) => {
                        log_failure(&error);
                        review.notice = Some(format!(
                            "Couldn't cut again. {}",
                            view::error_reason(&error)
                        ));
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The review's keys (`handleKeyDown`). Space, ← → and Enter belong to
    /// the review body itself, so a focused control keeps its own; the rest
    /// work from anywhere in the review. Nothing runs behind the leave guard.
    fn review_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(review) = self.review() else {
            return;
        };
        if review.leave.is_open() {
            return;
        }
        let on_body = review.focus.is_focused(window);
        let has_selection = review.selection_range().is_some();
        let selected = review.selected_id.clone();
        let player = review.player.clone();
        let modifiers = event.keystroke.modifiers;
        let key = event.keystroke.key.as_str();
        let command = if cfg!(target_os = "macos") {
            modifiers.platform
        } else {
            modifiers.control
        };
        if (modifiers.platform || modifiers.control) && key.eq_ignore_ascii_case("s") {
            cx.stop_propagation();
            self.save_clean_cut_review(cx);
            return;
        }
        // ⌘Z / ⇧⌘Z (Ctrl elsewhere) undo and redo the draft. The Edit menu's
        // Undo and Redo land on the review's actions first.
        if key.eq_ignore_ascii_case("z") && command && !modifiers.alt {
            cx.stop_propagation();
            if modifiers.shift {
                self.review_redo(cx);
            } else {
                self.review_undo(cx);
            }
            return;
        }
        if modifiers.platform || modifiers.control || modifiers.alt {
            return;
        }
        match key {
            "backspace" | "delete" if has_selection => {
                cx.stop_propagation();
                self.review_cut_selection(cx);
            }
            "space" if on_body => {
                cx.stop_propagation();
                if let Some(player) = player {
                    player.read(cx).toggle_playback();
                }
            }
            "left" | "right" if on_body => {
                cx.stop_propagation();
                if let Some(player) = player {
                    let delta = if key == "left" {
                        -SEEK_STEP_MS
                    } else {
                        SEEK_STEP_MS
                    };
                    player.read(cx).seek_by(delta);
                }
            }
            "up" | "down" if on_body => {
                cx.stop_propagation();
                let next = self.review().and_then(|review| {
                    let derived = review.derived.as_ref()?;
                    model::step_removal(
                        &derived.order,
                        review.selected_id.as_deref(),
                        key == "down",
                        review.position_ms as f64,
                    )
                });
                self.review_select(next, true, cx);
            }
            "enter" if on_body => {
                if let Some(id) = selected {
                    cx.stop_propagation();
                    self.review_toggle(&id, cx);
                }
            }
            _ => {}
        }
    }

    /// The review in place of the card.
    pub(super) fn render_clean_cut_review(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(clean) = self.clean_cut.as_ref() else {
            return div().into_any_element();
        };
        let Some(review) = clean.review.as_ref() else {
            return div().into_any_element();
        };
        if self.review_wants_player() {
            cx.on_next_frame(window, |screen, window, cx| {
                screen.review_open_player(window, cx)
            });
        }
        let t = theme::resolve(None, window, cx);
        let capture = self.clean_cut_capture();
        let status = view::status_view(review.job(), capture);
        let source = clean
            .sessions
            .iter()
            .find(|session| session.id == review.session_id);

        let body = match &review.load {
            Load::Ready(data) => ready_body(review, data, source, t, cx),
            load => placeholder(load, &status.label, t, cx),
        };

        div()
            .id("clean-cut-review")
            .track_focus(&review.focus)
            .on_key_down(cx.listener(|screen, event: &KeyDownEvent, window, cx| {
                screen.review_key(event, window, cx)
            }))
            .on_action(cx.listener(|screen, _: &text_actions::Undo, _, cx| screen.review_undo(cx)))
            .on_action(cx.listener(|screen, _: &text_actions::Redo, _, cx| screen.review_redo(cx)))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|screen, _: &MouseUpEvent, _, cx| screen.review_release(cx)),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|screen, _: &MouseUpEvent, _, cx| screen.review_release(cx)),
            )
            .flex()
            .flex_col()
            .flex_1()
            .min_h(px(0.))
            .size_full()
            .child(header(clean, review, source, t, cx))
            .child(body)
            .child(footer(review, &status, t, cx))
            .child(leave_dialog(review, cx))
            .into_any_element()
    }
}

/// The header: back, the recording, the stats and "Kind of cut".
fn header(
    clean: &super::clean_cut::CleanCutState,
    review: &ReviewState,
    source: Option<&SessionListItem>,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let fg = hsla(t.foreground);
    let muted = hsla(t.muted_foreground);
    let title = match source.map(|session| session.title.trim()) {
        Some(title) if !title.is_empty() => title.to_string(),
        _ => view::UNTITLED.to_string(),
    };
    let changes = review.draft.change_count();
    let other = match review.mode {
        CleanCutMode::Clean => CleanCutMode::Condensed,
        CleanCutMode::Condensed => CleanCutMode::Clean,
    };
    let other_job = view::latest_job(&clean.jobs, &review.session_id, other);
    let locked = |mode: CleanCutMode| review.mode != mode && (changes > 0 || other_job.is_none());

    let mut row = div()
        .flex()
        .flex_none()
        .flex_wrap()
        .items_center()
        .gap_x(px(12.))
        .gap_y(px(4.))
        .min_h(px(44.))
        .px(px(size::GUTTER))
        .py(px(6.))
        .border_b_1()
        .border_color(hsla(t.border))
        .child(
            Button::new("clean-cut-review-back")
                .variant(ButtonVariant::Ghost)
                .accessibility_label(BACK_TO_CLEAN_CUT)
                .child(icon(IconName::ArrowLeft, 16., fg))
                .child(BACK_TO_CLEAN_CUT)
                .on_click(cx.listener(|screen, _, window, cx| screen.review_back(window, cx))),
        )
        .child(
            div()
                .flex()
                .flex_1()
                .min_w(px(0.))
                .items_baseline()
                .gap(px(8.))
                .child(
                    div()
                        .min_w(px(0.))
                        .truncate()
                        .type_scale(text::SECTION)
                        .text_color(fg)
                        .child(title),
                )
                .child(
                    div()
                        .flex_none()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(view::mode_label(review.mode)),
                ),
        );
    if let Some(derived) = review.derived.as_ref() {
        let stats = derived.stats;
        let tail = match &derived.blocks {
            Some(blocks) => format!(
                " · {} parts",
                blocks.iter().filter(|block| !block.removed).count()
            ),
            None => format!(" · {} cuts", stats.cuts),
        };
        row = row.child(
            div()
                .flex()
                .flex_none()
                .items_baseline()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(15.))
                        .line_height(px(20.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .child(format!(
                            "{} → {}",
                            clock(stats.duration_ms),
                            clock(stats.kept_ms)
                        )),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(format!(
                            "{} shorter{tail}",
                            clock(view::saved_ms(stats.duration_ms, stats.kept_ms))
                        )),
                ),
        );
    }
    let entity = cx.entity();
    row.child(
        SegmentedControl::new("clean-cut-review-mode")
            .accessibility_label(KIND_OF_CUT)
            .value(Some(review.mode.as_str()))
            .option(Segment::new("clean", "Clean").disabled(locked(CleanCutMode::Clean)))
            .option(
                Segment::new("condensed", "Condensed").disabled(locked(CleanCutMode::Condensed)),
            )
            .on_change(move |value, _, cx| {
                let mode = if &*value == "condensed" {
                    CleanCutMode::Condensed
                } else {
                    CleanCutMode::Clean
                };
                entity.update(cx, |screen, cx| screen.review_switch_mode(mode, cx));
            }),
    )
    .into_any_element()
}

/// The cut, ready: the player beside its controls, the strip, and the
/// transcript.
fn ready_body(
    review: &ReviewState,
    data: &ReviewData,
    source: Option<&SessionListItem>,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let player = match (&review.player, playable(source)) {
        (Some(player), true) => div()
            .w(px(PLAYER_WIDTH))
            .flex_none()
            .child(player.clone())
            .into_any_element(),
        (None, true) => player_placeholder(PLAYER_LOADING, t),
        (_, false) => player_placeholder(PLAYER_WAITS, t),
    };
    let entity = cx.entity();
    let controls = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w(px(0.))
        .gap(px(12.))
        .child(
            div().flex().child(
                SegmentedControl::new("clean-cut-what-plays")
                    .fit(true)
                    .accessibility_label(WHAT_PLAYS)
                    .value(Some(if review.preview { "cut" } else { "original" }))
                    .option(Segment::new("cut", PREVIEW_THE_CUT))
                    .option(Segment::new("original", ORIGINAL))
                    .on_change(move |value, _, cx| {
                        let preview = &*value == "cut";
                        entity.update(cx, |screen, cx| screen.review_set_preview(preview, cx));
                    }),
            ),
        )
        .children(moments(&review.pins, t, cx));

    let mut column = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_h(px(0.))
        .child(
            div()
                .flex()
                .flex_none()
                .flex_wrap()
                .gap(px(12.))
                .p(px(size::GUTTER))
                .border_b_1()
                .border_color(hsla(t.border))
                .child(player)
                .child(controls),
        )
        .child(strip(review, t, cx));
    if !data.transcript_read {
        column = column.child(
            div().px(px(size::GUTTER)).pt(px(8.)).child(
                Alert::new("clean-cut-transcript-unreadable")
                    .variant(AlertVariant::Warning)
                    .title(TRANSCRIPT_UNREADABLE)
                    .action(
                        Button::new("clean-cut-transcript-retry")
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .label(TRY_AGAIN)
                            .on_click(
                                cx.listener(|screen, _, _, cx| screen.load_clean_cut_review(cx)),
                            ),
                    ),
            ),
        );
    }
    let empty = review
        .derived
        .as_ref()
        .is_none_or(|derived| derived.items.is_empty());
    if empty {
        return column
            .child(
                Empty::new()
                    .title(NO_SPEECH)
                    .description(NO_SPEECH_DESCRIPTION),
            )
            .into_any_element();
    }
    column
        .child(
            div()
                .id("clean-cut-transcript")
                .flex_1()
                .min_h(px(240.))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|screen, _: &MouseDownEvent, _, cx| {
                        screen.review_tap_transcript(cx)
                    }),
                )
                .child(transcript(review, cx)),
        )
        .into_any_element()
}

fn player_placeholder(label: &'static str, t: &Theme) -> AnyElement {
    div()
        .w(px(PLAYER_WIDTH))
        .h(px(PLAYER_HEIGHT))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.video_ground))
        .child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.video_ground_muted))
                .child(label),
        )
        .into_any_element()
}

/// `Moments`: the stream report's moments; a click puts the playhead there.
fn moments(pins: &[Pin], t: &Theme, cx: &mut Context<SidekickScreen>) -> Option<AnyElement> {
    if pins.is_empty() {
        return None;
    }
    let muted = hsla(t.muted_foreground);
    let fg = hsla(t.foreground);
    let mut row = div().flex().flex_wrap().gap(px(4.));
    for (index, pin) in pins.iter().enumerate() {
        let start = pin.start_ms;
        let tip = if pin.excerpt.is_empty() {
            pin.label.clone()
        } else {
            pin.excerpt.clone()
        };
        row = row.child(
            Button::new(("clean-cut-moment", index))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .accessibility_label(pin.label.clone())
                .tooltip(tip)
                .child(icon(pin_icon(&pin.kind), 12., fg))
                .child(clock(start))
                .child(div().min_w(px(0.)).truncate().child(pin.label.clone()))
                .on_click(cx.listener(move |screen, _, _, cx| screen.review_seek(start, cx))),
        );
    }
    Some(
        div()
            .flex()
            .flex_col()
            .min_w(px(0.))
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .gap(px(4.))
                    .px(px(4.))
                    .text_size(px(11.))
                    .line_height(px(16.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hsla(t.subtle))
                    .child(MOMENTS)
                    .child(
                        div()
                            .font_weight(FontWeight::NORMAL)
                            .text_color(muted)
                            .child(format!("· {}", pins.len())),
                    ),
            )
            .child(row)
            .into_any_element(),
    )
}

/// The strip over the transcript: the kinds of cuts, the edit bar and the
/// keys.
fn strip(review: &ReviewState, t: &Theme, cx: &mut Context<SidekickScreen>) -> AnyElement {
    let muted = hsla(t.muted_foreground);
    let fg = hsla(t.foreground);
    let can_undo = !review.history.past.is_empty();
    let can_redo = !review.history.future.is_empty();
    let mut bar = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(6.))
        .gap_y(px(4.));
    if !review.condensed() {
        let can_cut = review.selection_range().is_some();
        let mut cut = Button::new("clean-cut-cut-selection")
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .accessibility_label(CUT_SELECTION)
            .disabled(!can_cut)
            .child(icon(IconName::Scissors, 12., fg))
            .child(CUT_SELECTION)
            .child(ShortcutKeys::accelerator("Backspace"))
            .on_click(cx.listener(|screen, _, _, cx| screen.review_cut_selection(cx)));
        if !can_cut {
            cut = cut.tooltip(SELECT_WORDS_FIRST);
        }
        bar = bar.child(cut);
    }
    let mut undo = Button::new("clean-cut-undo")
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::Xs)
        .accessibility_label(UNDO)
        .disabled(!can_undo)
        .child(UNDO)
        .child(ShortcutKeys::accelerator("CmdOrCtrl+Z"))
        .on_click(cx.listener(|screen, _, _, cx| screen.review_undo(cx)));
    if !can_undo {
        undo = undo.tooltip(NOTHING_TO_UNDO);
    }
    let mut redo = Button::new("clean-cut-redo")
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::Xs)
        .accessibility_label(REDO)
        .disabled(!can_redo)
        .child(REDO)
        .child(ShortcutKeys::accelerator("CmdOrCtrl+Shift+Z"))
        .on_click(cx.listener(|screen, _, _, cx| screen.review_redo(cx)));
    if !can_redo {
        redo = redo.tooltip(NOTHING_TO_REDO);
    }
    let entity = cx.entity();
    bar = bar.child(undo).child(redo).child(
        div()
            .ml_auto()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                Switch::new("clean-cut-follow")
                    .small(true)
                    .accessibility_label(FOLLOW_PLAYBACK)
                    .checked(review.follow)
                    .on_change(move |on, _, cx| {
                        entity.update(cx, |screen, cx| screen.review_set_follow(on, cx));
                    }),
            )
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(FOLLOW_PLAYBACK),
            ),
    );
    let chips = review
        .derived
        .as_ref()
        .map(|derived| kind_chips(&derived.chips, t, cx));
    div()
        .flex()
        .flex_none()
        .flex_col()
        .gap(px(6.))
        .px(px(size::GUTTER))
        .py(px(8.))
        .border_b_1()
        .border_color(hsla(t.border))
        .children(chips)
        .child(bar)
        .child(
            div()
                .text_size(px(11.))
                .line_height(px(16.))
                .text_color(muted)
                .child(KEYS_HINT),
        )
        .into_any_element()
}

/// `KindChips`: one chip per kind of cut with its count; a click keeps or
/// cuts them all.
fn kind_chips(chips: &[KindChip], t: &Theme, cx: &mut Context<SidekickScreen>) -> AnyElement {
    let muted = hsla(t.muted_foreground);
    let pressed: Vec<(GroupId, bool)> = chips
        .iter()
        .map(|chip| (chip.group.id, chip.state == ChipState::On))
        .collect();
    let mut group = ToggleGroup::new("clean-cut-chips")
        .multiple(true)
        .xs(true)
        .spacing(4.)
        .accessibility_label(KINDS_OF_CUTS)
        .value(
            pressed
                .iter()
                .filter(|(_, on)| *on)
                .map(|(id, _)| id.as_str()),
        );
    for chip in chips {
        let body = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .flex_none()
                    .size(px(6.))
                    .rounded_full()
                    .bg(hsla(tone_color(chip.group.tone, t))),
            )
            .child(chip.group.label)
            .child(div().text_color(muted).child(chip.count_label()));
        group = group.item(
            ToggleItem::new(chip.group.id.as_str(), chip.group.label)
                .disabled(chip.state == ChipState::Empty)
                // What a click does ("Cut all 3" / "Keep all 3"); an empty
                // chip says why it can't (Electron's DisabledReason).
                .tooltip(chip.tooltip())
                .child(body),
        );
    }
    let entity = cx.entity();
    group
        .on_change(move |values, _, cx| {
            let changed = pressed
                .iter()
                .find(|(id, on)| values.iter().any(|value| &**value == id.as_str()) != *on);
            if let Some((id, _)) = changed {
                let id = *id;
                entity.update(cx, |screen, cx| screen.review_toggle_group(id, cx));
            }
        })
        .into_any_element()
}

/// What one transcript row reads besides its own item.
struct RowContext<'a> {
    by_id: &'a HashMap<String, CleanCutRemoval>,
    selected: Option<&'a str>,
    active: Option<usize>,
    /// The selected words, low to high.
    selection: Option<(usize, usize)>,
    weak: &'a WeakEntity<SidekickScreen>,
}

/// `CleanCutTranscript`: flowing text in virtualized rows, cut words struck
/// through in their kind's tone, kept suggestions underlined, pauses and the
/// start and end as inline markers, and the Condensed parts as headers.
fn transcript(review: &ReviewState, cx: &mut Context<SidekickScreen>) -> AnyElement {
    let Some(derived) = review.derived.clone() else {
        return div().into_any_element();
    };
    let selected = review.selected_id.clone();
    let active = review.active_word();
    let selection = review
        .selection
        .map(|(anchor, focus)| (anchor.min(focus), anchor.max(focus)));
    let weak = cx.weak_entity();
    list(review.list.clone(), move |index, window, cx| {
        let t = theme::resolve(None, window, cx);
        let context = RowContext {
            by_id: &derived.by_id,
            selected: selected.as_deref(),
            active,
            selection,
            weak: &weak,
        };
        match derived.items.get(index) {
            Some(Item::Paragraph(paragraph)) => paragraph_row(paragraph, &context, t),
            Some(Item::Block(block)) => block_row(block, &weak, t),
            None => div().into_any_element(),
        }
    })
    .size_full()
    .into_any_element()
}

fn paragraph_row(paragraph: &Paragraph, context: &RowContext<'_>, t: &Theme) -> AnyElement {
    let mut row = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(4.))
        .px(px(size::GUTTER))
        .py(px(4.))
        .text_size(px(14.))
        .line_height(px(24.))
        .text_color(hsla(t.foreground));
    for token in &paragraph.tokens {
        match token {
            Token::Pin(pin) => row = row.child(pin_marker(pin, context.weak, t)),
            Token::Marker { removal_id, .. } => {
                if let Some(removal) = context.by_id.get(removal_id) {
                    let selected = context.selected == Some(removal_id.as_str());
                    row = row.child(cut_marker(removal, selected, context.weak, t));
                }
            }
            Token::Word {
                index,
                text,
                start_ms,
                removal_ids,
                ..
            } => row = row.child(word(*index, text, *start_ms, removal_ids, context, t)),
        }
    }
    row.into_any_element()
}

/// One word: a click seeks there (or keeps or cuts the cut it sits in), a
/// drag from it selects words.
fn word(
    index: usize,
    text: &str,
    start_ms: u64,
    removal_ids: &[String],
    context: &RowContext<'_>,
    t: &Theme,
) -> AnyElement {
    let accent = hsla(t.accent);
    let state = model::run_state(removal_ids, context.by_id);
    let mut word = div()
        .px(px(1.))
        .rounded(px(radius::CHIP))
        .hover(move |style| style.bg(accent))
        .child(text.to_string());
    let selected_word = context
        .selection
        .is_some_and(|(low, high)| (low..=high).contains(&index));
    let click = match state {
        Some((removal, cut, tone)) => {
            let line = hsla(tone_color(tone, t));
            if cut {
                word = word.text_color(hsla(t.subtle));
                word.text_style().strikethrough = Some(StrikethroughStyle {
                    thickness: px(2.),
                    color: Some(line),
                });
            } else {
                word.text_style().underline = Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(line),
                    wavy: false,
                });
            }
            if context.selected == Some(removal.id.as_str()) {
                word = word.bg(accent);
            }
            WordClick::Toggle(removal.id.clone())
        }
        None => WordClick::Seek(start_ms),
    };
    if context.active == Some(index) {
        word = word.bg(hsla(t.accent_pressed));
    }
    if selected_word {
        word = word.bg(accent);
    }
    let press = {
        let weak = context.weak.clone();
        move |event: &MouseDownEvent, _: &mut Window, cx: &mut App| {
            let shift = event.modifiers.shift;
            let click = click.clone();
            let _ = weak.update(cx, |screen, cx| {
                screen.review_press(index, click, shift, cx)
            });
        }
    };
    let drag = {
        let weak = context.weak.clone();
        move |event: &MouseMoveEvent, _: &mut Window, cx: &mut App| {
            if event.pressed_button == Some(MouseButton::Left) {
                let _ = weak.update(cx, |screen, cx| screen.review_drag(index, cx));
            }
        }
    };
    let word = word
        .on_mouse_down(MouseButton::Left, press)
        .on_mouse_move(drag);
    match state {
        // Why it's a cut and what a click does, on hover.
        Some((removal, cut, _)) => word
            .id(("clean-cut-word", index))
            .tooltip(tooltip(model::removal_title(removal, cut)))
            .into_any_element(),
        None => word.into_any_element(),
    }
}

/// A cut with no words: a silence, a pause with sound, the start or the end.
fn cut_marker(
    removal: &CleanCutRemoval,
    selected: bool,
    weak: &WeakEntity<SidekickScreen>,
    t: &Theme,
) -> AnyElement {
    let id = removal.id.clone();
    let weak = weak.clone();
    let mut badge = Badge::new(model::marker_label(removal)).variant(if removal.enabled {
        BadgeVariant::Outline
    } else {
        BadgeVariant::Ghost
    });
    if removal.kind == CleanCutRemovalKind::Gap {
        badge = badge.icon(icon(IconName::Waveform, 12., hsla(t.muted_foreground)));
    }
    let mut marker = div().rounded(px(radius::TAG));
    if removal.enabled {
        marker = marker.line_through();
    } else {
        marker.text_style().underline = Some(UnderlineStyle {
            thickness: px(1.),
            color: Some(hsla(tone_color(model::removal_tone(removal.kind), t))),
            wavy: false,
        });
    }
    if selected {
        marker = marker.bg(hsla(t.accent));
    }
    marker
        .id(SharedString::from(format!(
            "clean-cut-marker-{}",
            removal.id
        )))
        .tooltip(tooltip(model::removal_title(removal, removal.enabled)))
        .on_click(move |_, _, cx| {
            let _ = weak.update(cx, |screen, cx| screen.review_toggle(&id, cx));
        })
        .child(badge)
        .into_any_element()
}

/// A moment from the stream report: a pin that seeks there.
fn pin_marker(pin: &Pin, weak: &WeakEntity<SidekickScreen>, t: &Theme) -> AnyElement {
    let start = pin.start_ms;
    let weak = weak.clone();
    div()
        .id(SharedString::from(format!("clean-cut-pin-{}", pin.key)))
        .flex()
        .items_center()
        .gap(px(4.))
        .tooltip(tooltip(pin.tooltip()))
        .on_click(move |_, _, cx| {
            let _ = weak.update(cx, |screen, cx| screen.review_seek(start, cx));
        })
        .child(
            Badge::new(pin.label.clone())
                .variant(BadgeVariant::Outline)
                .icon(icon(pin_icon(&pin.kind), 12., hsla(t.muted_foreground))),
        )
        .child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.subtle))
                .child(clock(start)),
        )
        .into_any_element()
}

/// `BlockRow`: a Condensed part, its title, when and how long, and one
/// toggle.
fn block_row(block: &Block, weak: &WeakEntity<SidekickScreen>, t: &Theme) -> AnyElement {
    let muted = hsla(t.muted_foreground);
    let title = block.shown_title().to_string();
    let toggled = block.clone();
    let weak = weak.clone();
    let mut row = div()
        .flex()
        .min_w(px(0.))
        .items_center()
        .gap(px(8.))
        .px(px(size::GUTTER))
        .py(px(6.))
        .border_t_1()
        .border_b_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.inset))
        .child(
            div()
                .flex_none()
                .max_w(px(280.))
                .truncate()
                .type_scale(text::SECTION)
                .text_color(if block.removed {
                    muted
                } else {
                    hsla(t.foreground)
                })
                .child(title),
        )
        .child(
            div()
                .flex_none()
                .type_scale(text::META)
                .text_color(muted)
                .child(format!(
                    "{}–{} · {}",
                    clock(block.start_ms),
                    clock(block.end_ms),
                    clock(block.end_ms.saturating_sub(block.start_ms))
                )),
        );
    if block.removed && !block.excerpt.is_empty() {
        row = row.child(
            div()
                .min_w(px(0.))
                .truncate()
                .type_scale(text::META)
                .text_color(hsla(t.subtle))
                .child(block.excerpt.clone()),
        );
    }
    if block.kind == BlockKind::Kept && block.removed {
        row = row.child(Badge::new(DROPPED).variant(BadgeVariant::Outline));
    }
    row.child(
        div().ml_auto().child(
            Button::new(SharedString::from(format!("clean-cut-block-{}", block.key)))
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(block.action())
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |screen, cx| screen.review_toggle_block(&toggled, cx));
                }),
        ),
    )
    .into_any_element()
}

/// `ReviewPlaceholder`: loading, waiting, nothing yet, or why it couldn't
/// open.
fn placeholder(
    load: &Load,
    status_label: &str,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let (title, description) =
        match load {
            Load::Error(message) => {
                return div()
                    .flex_1()
                    .p(px(size::GUTTER))
                    .child(
                        Alert::new("clean-cut-review-error")
                            .variant(AlertVariant::Warning)
                            .title(COULDNT_OPEN)
                            .description(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(message.clone()),
                            )
                            .action(
                                Button::new("clean-cut-review-error-retry")
                                    .variant(ButtonVariant::Outline)
                                    .size(ButtonSize::Xs)
                                    .label(TRY_AGAIN)
                                    .on_click(cx.listener(|screen, _, _, cx| {
                                        screen.load_clean_cut_review(cx)
                                    })),
                            ),
                    )
                    .into_any_element();
            }
            Load::Loading | Load::Ready(_) => (LOADING_TITLE.to_string(), LOADING_DESCRIPTION),
            Load::Waiting(Some(_)) => (status_label.to_string(), WAITING_DESCRIPTION),
            Load::Waiting(None) => (NO_CUT_TITLE.to_string(), NO_CUT_DESCRIPTION),
        };
    let mut empty = Empty::new().title(title).description(description);
    if matches!(load, Load::Waiting(None)) {
        empty = empty.child(
            Button::new("clean-cut-review-open-list")
                .variant(ButtonVariant::Outline)
                .label(OPEN_CLEAN_CUT)
                .on_click(cx.listener(|screen, _, _, cx| screen.close_clean_cut_review(cx))),
        );
    }
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_h(px(0.))
        .justify_center()
        .child(empty)
        .into_any_element()
}

/// The footer: where the cut stands, Retry, Open in Library, Discard and
/// "Save changes".
fn footer(
    review: &ReviewState,
    status: &view::StatusView,
    t: &Theme,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let changes = review.draft.change_count();
    let failed = status.kind == StatusKind::Failed;
    let job = review.job();
    let editable = review
        .data()
        .is_some_and(|data| view::job_editable(&data.job));
    let line = if let Some(notice) = review.notice.clone() {
        notice
    } else if changes > 0 {
        plural(
            i64::try_from(changes).unwrap_or(i64::MAX),
            "unsaved change",
            None,
        )
    } else if status.kind == StatusKind::Ready {
        SAVED_READY.to_string()
    } else if failed {
        // E-24: a failure says why, not just "Failed".
        let mode = job.map_or(review.mode, |job| job.mode);
        format!(
            "{}. {}",
            view::failed_title(mode),
            status.detail.clone().unwrap_or_default()
        )
        .trim_end()
        .to_string()
    } else {
        status.label.clone()
    };
    let mut row = div()
        .flex()
        .flex_none()
        .flex_wrap()
        .items_center()
        .gap_x(px(12.))
        .gap_y(px(4.))
        .min_h(px(44.))
        .px(px(size::GUTTER))
        .py(px(6.))
        .border_t_1()
        .border_color(hsla(t.border))
        .child(
            div()
                .flex()
                .flex_1()
                .min_w(px(0.))
                .items_center()
                .gap(px(8.))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .children(status.busy.then(|| {
                    Spinner::new("clean-cut-review-busy")
                        .size(14.)
                        .color(t.muted_foreground)
                }))
                .child(div().min_w(px(0.)).child(line)),
        );
    let fg = hsla(t.foreground);
    if failed && changes == 0 && status.retry == Some(Retry::Render) && job.is_some() {
        let glyph = if review.retrying {
            Spinner::new("clean-cut-review-retrying")
                .size(14.)
                .into_any_element()
        } else {
            icon(IconName::ArrowCounterClockwise, 14., fg).into_any_element()
        };
        row = row.child(
            Button::new("clean-cut-review-retry")
                .variant(ButtonVariant::Outline)
                .accessibility_label(RETRY)
                .disabled(review.retrying)
                .child(glyph)
                .child(RETRY)
                .on_click(cx.listener(|screen, _, _, cx| screen.review_retry_render(cx))),
        );
    }
    if status.kind == StatusKind::Ready
        && changes == 0
        && let Some(output) = review
            .data()
            .and_then(|data| data.job.output_session_id.clone())
    {
        row = row.child(
            Button::new("clean-cut-review-open-library")
                .variant(ButtonVariant::Outline)
                .label(OPEN_IN_LIBRARY)
                .on_click(
                    cx.listener(move |_, _, _, cx| cx.emit(OpenLibrarySession(output.clone()))),
                ),
        );
    }
    if changes > 0 {
        row = row.child(
            Button::new("clean-cut-review-discard")
                .variant(ButtonVariant::Outline)
                .label(DISCARD)
                .disabled(review.saving)
                .on_click(cx.listener(|screen, _, _, cx| screen.review_edit(Draft::default(), cx))),
        );
    }
    let ink = t.chrome_fill_ink;
    let glyph = if review.saving {
        Spinner::new("clean-cut-review-saving")
            .size(14.)
            .color(ink)
            .into_any_element()
    } else {
        icon(IconName::FloppyDisk, 14., hsla(ink)).into_any_element()
    };
    let mut save = Button::new("clean-cut-review-save")
        .variant(ButtonVariant::Default)
        .accessibility_label(SAVE_CHANGES)
        .disabled(changes == 0 || review.saving || !editable)
        .child(glyph)
        .child(SAVE_CHANGES)
        .child(ShortcutKeys::accelerator("CmdOrCtrl+S").on_filled(ink))
        .on_click(cx.listener(|screen, _, _, cx| screen.save_clean_cut_review(cx)));
    if !editable && changes > 0 {
        save = save.tooltip(SAVE_WHEN_FINISHED);
    }
    row.child(save).into_any_element()
}

/// `ConfirmDialog` "Leave without saving?".
fn leave_dialog(review: &ReviewState, cx: &mut Context<SidekickScreen>) -> AnyElement {
    let changes = review.draft.change_count();
    let what = if changes == 1 {
        "change".to_string()
    } else {
        format!("{changes} changes")
    };
    Dialog::new("clean-cut-leave", &review.leave, LEAVE_TITLE)
        .description(format!("Your {what} to this cut will be lost."))
        .close_button(false)
        .footer(
            Button::new("clean-cut-leave-keep")
                .variant(ButtonVariant::Ghost)
                .label(KEEP_EDITING)
                .on_click(
                    cx.listener(|screen, _, window, cx| screen.review_keep_editing(window, cx)),
                ),
        )
        .footer(
            Button::new("clean-cut-leave-discard")
                .variant(ButtonVariant::Destructive)
                .label(DISCARD_CHANGES)
                .on_click(
                    cx.listener(|screen, _, window, cx| {
                        screen.review_discard_and_leave(window, cx)
                    }),
                ),
        )
        .into_any_element()
}
