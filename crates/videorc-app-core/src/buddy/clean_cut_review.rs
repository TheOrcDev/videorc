//! Clean cut's review (plan 220 S3.10f; Electron's `lib/clean-cut-review.ts`,
//! `lib/skip-ranges.ts`): what the player skips, what the transcript strikes
//! through, the per-kind chips, and the one `cleanCut.updateEdl` payload
//! "Save changes" sends. Edits stay a local draft over the saved cut list
//! until they are saved, so a toggle is instant and the preview of the cut
//! follows it at once. Pure: the app's `clean_cut_review` draws it.

use std::collections::{HashMap, HashSet};

use videorc_protocol::{
    CleanCutCondensedKeep, CleanCutManualRange, CleanCutRemoval, CleanCutRemovalKind,
    CleanCutRemovalToggle, CleanCutTranscriptSegment, CleanCutTranscriptWord,
    CleanCutUpdateEdlParams,
};

use super::moments::{Moment, moment_label};

// --- Kinds ----------------------------------------------------------------------

/// Semantic tones only: the strike colour says what a cut is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Warning,
    Destructive,
    Info,
}

impl Tone {
    pub fn as_str(self) -> &'static str {
        match self {
            Tone::Neutral => "neutral",
            Tone::Warning => "warning",
            Tone::Destructive => "destructive",
            Tone::Info => "info",
        }
    }
}

/// `CleanCutKindGroupId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GroupId {
    Silences,
    Fillers,
    Retakes,
    FalseStarts,
    StartEnd,
    Manual,
}

impl GroupId {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupId::Silences => "silences",
            GroupId::Fillers => "fillers",
            GroupId::Retakes => "retakes",
            GroupId::FalseStarts => "false-starts",
            GroupId::StartEnd => "start-end",
            GroupId::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<GroupId> {
        KIND_GROUPS
            .iter()
            .map(|group| group.id)
            .find(|id| id.as_str() == value)
    }
}

/// `CleanCutKindGroup`: one chip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindGroup {
    pub id: GroupId,
    pub label: &'static str,
    pub kinds: &'static [CleanCutRemovalKind],
    pub tone: Tone,
    /// Shown even when nothing of the kind was found, so the chips never move.
    pub always: bool,
}

/// `CLEAN_CUT_KIND_GROUPS`, in the plan's order.
pub const KIND_GROUPS: [KindGroup; 6] = [
    KindGroup {
        id: GroupId::Silences,
        label: "Silences",
        kinds: &[CleanCutRemovalKind::Silence, CleanCutRemovalKind::Gap],
        tone: Tone::Neutral,
        always: true,
    },
    KindGroup {
        id: GroupId::Fillers,
        label: "Ums",
        kinds: &[CleanCutRemovalKind::Filler],
        tone: Tone::Warning,
        always: true,
    },
    KindGroup {
        id: GroupId::Retakes,
        label: "Retakes",
        kinds: &[CleanCutRemovalKind::Retake],
        tone: Tone::Destructive,
        always: true,
    },
    KindGroup {
        id: GroupId::FalseStarts,
        label: "False starts",
        kinds: &[CleanCutRemovalKind::FalseStart],
        tone: Tone::Info,
        always: true,
    },
    KindGroup {
        id: GroupId::StartEnd,
        label: "Start/end",
        kinds: &[CleanCutRemovalKind::Head, CleanCutRemovalKind::Tail],
        tone: Tone::Neutral,
        always: true,
    },
    KindGroup {
        id: GroupId::Manual,
        label: "Your cuts",
        kinds: &[CleanCutRemovalKind::Manual],
        tone: Tone::Neutral,
        always: false,
    },
];

/// `removalTone`.
pub fn removal_tone(kind: CleanCutRemovalKind) -> Tone {
    match kind {
        CleanCutRemovalKind::Filler => Tone::Warning,
        CleanCutRemovalKind::Retake => Tone::Destructive,
        CleanCutRemovalKind::FalseStart => Tone::Info,
        _ => Tone::Neutral,
    }
}

/// `removalKindName`: "Retake", "Um".
pub fn removal_kind_name(kind: CleanCutRemovalKind) -> &'static str {
    match kind {
        CleanCutRemovalKind::Head => "Start",
        CleanCutRemovalKind::Tail => "End",
        CleanCutRemovalKind::Silence => "Silence",
        CleanCutRemovalKind::Gap => "Pause",
        CleanCutRemovalKind::Filler => "Um",
        CleanCutRemovalKind::Retake => "Retake",
        CleanCutRemovalKind::FalseStart => "False start",
        CleanCutRemovalKind::Condensed => "Left out",
        CleanCutRemovalKind::Manual => "Your cut",
    }
}

fn length_of(removal: &CleanCutRemoval) -> u64 {
    removal.end_ms.saturating_sub(removal.start_ms)
}

/// `removalAnnouncement`: what a screen reader hears when a cut is selected
/// or flipped ("Um 0.4 s, cut. 2 of 14. Enter keeps it.").
pub fn removal_announcement(removal: &CleanCutRemoval, position: usize, total: usize) -> String {
    let what = format!(
        "{} {}",
        removal_kind_name(removal.kind),
        format_cut_length(length_of(removal))
    );
    let place = if position > 0 && total > 0 {
        format!(" {position} of {total}.")
    } else {
        String::new()
    };
    if removal.enabled {
        format!("{what}, cut.{place} Enter keeps it.")
    } else {
        format!("{what}, kept.{place} Enter cuts it.")
    }
}

/// JavaScript's `(ms / 1000).toFixed(1)`: the nearest tenth of the double,
/// an exact tie rounded up (Rust's own formatting rounds a tie to even).
fn tenths_of_seconds(ms: u64) -> String {
    let seconds = ms as f64 / 1000.0;
    let mut tenths = (ms / 100) as u128;
    let rest = ms % 100;
    let up = match rest.cmp(&50) {
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Greater => true,
        // `ms / 1000` is a tie: the double's own value decides.
        std::cmp::Ordering::Equal => !double_below(seconds, ms),
    };
    if up {
        tenths += 1;
    }
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// Whether the double `value` is below `ms / 1000` exactly.
fn double_below(value: f64, ms: u64) -> bool {
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    if exponent == 0 {
        return false;
    }
    let mantissa = u128::from((bits & ((1u64 << 52) - 1)) | (1u64 << 52));
    // value = mantissa · 2^(exponent − 1075); compare mantissa · 1000 with
    // ms · 2^(1075 − exponent).
    let shift = 1075 - exponent;
    if !(0..=70).contains(&shift) {
        return false;
    }
    mantissa * 1000 < u128::from(ms) << shift
}

/// `formatCutLength`: "1.8 s", "12 s", "1 min 30 s".
pub fn format_cut_length(ms: u64) -> String {
    let seconds = ms as f64 / 1000.0;
    if seconds < 10.0 {
        return format!("{} s", tenths_of_seconds(ms));
    }
    if seconds < 60.0 {
        return format!("{} s", seconds.round() as u64);
    }
    let minutes = (seconds / 60.0).floor() as u64;
    let rest = (seconds % 60.0).round() as u64;
    if rest == 0 {
        format!("{minutes} min")
    } else {
        format!("{minutes} min {rest} s")
    }
}

// --- Draft ----------------------------------------------------------------------

/// Keys of ranges the draft cuts that the saved list does not have yet.
pub const DRAFT_MANUAL_PREFIX: &str = "draft:";

/// `CleanCutDraftManual`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftManual {
    pub key: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `CleanCutDraft`. The toggles and the deletions keep the order they were
/// first made in (a `Map`'s and a `Set`'s), which the payload follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    /// Removal id → the state wanted, only where it differs from the saved list.
    pub toggles: Vec<(String, bool)>,
    /// New ranges to cut (a selection, a dropped Condensed part).
    pub add_manual: Vec<DraftManual>,
    /// Saved manual removals to delete (a dropped part kept again).
    pub remove_manual: Vec<String>,
    pub next_key: u32,
}

impl Default for Draft {
    /// `EMPTY_CLEAN_CUT_DRAFT`.
    fn default() -> Self {
        Self {
            toggles: Vec::new(),
            add_manual: Vec::new(),
            remove_manual: Vec::new(),
            next_key: 1,
        }
    }
}

impl Draft {
    /// `draftChangeCount`.
    pub fn change_count(&self) -> usize {
        self.toggles.len() + self.add_manual.len() + self.remove_manual.len()
    }

    pub fn toggle(&self, id: &str) -> Option<bool> {
        self.toggles
            .iter()
            .find(|(each, _)| each == id)
            .map(|(_, enabled)| *enabled)
    }

    fn set_toggle(&mut self, id: &str, enabled: bool) {
        match self.toggles.iter_mut().find(|(each, _)| each == id) {
            Some(entry) => entry.1 = enabled,
            None => self.toggles.push((id.to_string(), enabled)),
        }
    }

    fn drop_toggle(&mut self, id: &str) {
        self.toggles.retain(|(each, _)| each != id);
    }
}

fn by_time(left: &CleanCutRemoval, right: &CleanCutRemoval) -> std::cmp::Ordering {
    left.start_ms
        .cmp(&right.start_ms)
        .then(left.end_ms.cmp(&right.end_ms))
}

/// `effectiveRemovals`: the cut list as it stands with the draft applied, in
/// time order.
pub fn effective_removals(saved: &[CleanCutRemoval], draft: &Draft) -> Vec<CleanCutRemoval> {
    let mut out: Vec<CleanCutRemoval> = saved
        .iter()
        .filter(|removal| !draft.remove_manual.contains(&removal.id))
        .map(|removal| match draft.toggle(&removal.id) {
            Some(wanted) if wanted != removal.enabled => CleanCutRemoval {
                enabled: wanted,
                ..removal.clone()
            },
            _ => removal.clone(),
        })
        .collect();
    out.extend(draft_manual_removals(draft));
    out.sort_by(by_time);
    out
}

/// `draftManualRemovals`: the draft's own new cuts as removals, so the
/// transcript strikes them too.
pub fn draft_manual_removals(draft: &Draft) -> Vec<CleanCutRemoval> {
    draft
        .add_manual
        .iter()
        .map(|manual| CleanCutRemoval {
            id: manual.key.clone(),
            start_ms: manual.start_ms,
            end_ms: manual.end_ms,
            start_frame: 0,
            end_frame: 0,
            kind: CleanCutRemovalKind::Manual,
            reason: "Removed by you".into(),
            confidence: None,
            enabled: true,
        })
        .collect()
}

// --- Editing ----------------------------------------------------------------------

/// `CleanCutSaveStep` (QA F16, Electron #1490): what one Save sent and the
/// saved lists either side of it.
#[derive(Debug, Clone, Copy)]
pub struct SaveStep<'a> {
    /// The draft the save sent.
    pub submitted: &'a Draft,
    /// The saved list the draft was made on.
    pub before: &'a [CleanCutRemoval],
    /// The saved list the save returned.
    pub after: &'a [CleanCutRemoval],
}

/// `rebaseDraftAfterSave` (QA F16, Electron #1490): a Save answered while the
/// review kept editing. `draft` is what the review shows now, made on
/// `step.before`; it becomes the changes still to save on `step.after`, so
/// an edit the save did not carry stays unsaved instead of being dropped.
/// Exactly the submitted draft comes back empty.
pub fn rebase_draft_after_save(draft: &Draft, step: SaveStep<'_>) -> Draft {
    let after_by_id: HashMap<&str, &CleanCutRemoval> = step
        .after
        .iter()
        .map(|removal| (removal.id.as_str(), removal))
        .collect();
    let wanted: HashMap<String, bool> = effective_removals(step.before, draft)
        .into_iter()
        .map(|removal| (removal.id, removal.enabled))
        .collect();
    let mut toggles: Vec<(String, bool)> = Vec::new();
    let mut remove_manual: Vec<String> = Vec::new();
    for removal in step.before {
        let Some(now) = after_by_id.get(removal.id.as_str()) else {
            continue;
        };
        if draft.remove_manual.contains(&removal.id) {
            if now.kind == CleanCutRemovalKind::Manual && !remove_manual.contains(&removal.id) {
                remove_manual.push(removal.id.clone());
            }
            continue;
        }
        if let Some(&enabled) = wanted.get(&removal.id)
            && enabled != now.enabled
        {
            toggles.push((removal.id.clone(), enabled));
        }
    }
    // The new cuts the save made leave the draft; one made since stays.
    let sent: HashSet<&str> = step
        .submitted
        .add_manual
        .iter()
        .map(|manual| manual.key.as_str())
        .collect();
    let mut add_manual: Vec<DraftManual> = draft
        .add_manual
        .iter()
        .filter(|manual| !sent.contains(manual.key.as_str()))
        .cloned()
        .collect();
    // A new cut taken back while the save ran: delete the one the save made.
    let before_ids: HashSet<&str> = step
        .before
        .iter()
        .map(|removal| removal.id.as_str())
        .collect();
    let made: Vec<&CleanCutRemoval> = step
        .after
        .iter()
        .filter(|removal| {
            removal.kind == CleanCutRemovalKind::Manual && !before_ids.contains(removal.id.as_str())
        })
        .collect();
    for manual in &step.submitted.add_manual {
        if draft.add_manual.iter().any(|entry| entry.key == manual.key) {
            continue;
        }
        let span = (manual.start_ms, manual.end_ms);
        let mut best: Option<(&CleanCutRemoval, u64)> = None;
        for removal in &made {
            let overlap = overlap_ms(span, (removal.start_ms, removal.end_ms));
            if overlap > 0 && best.is_none_or(|(_, most)| overlap > most) {
                best = Some((removal, overlap));
            }
        }
        if let Some((removal, _)) = best
            && !remove_manual.contains(&removal.id)
        {
            remove_manual.push(removal.id.clone());
        }
    }
    // A cut the save deleted but the review brought back: cut that range again.
    let mut next_key = draft.next_key;
    for id in &step.submitted.remove_manual {
        let Some(removal) = step.before.iter().find(|entry| &entry.id == id) else {
            continue;
        };
        if draft.remove_manual.contains(id)
            || after_by_id.contains_key(id.as_str())
            || !wanted.get(id).copied().unwrap_or(false)
        {
            continue;
        }
        add_manual.push(DraftManual {
            key: format!("{DRAFT_MANUAL_PREFIX}{next_key}"),
            start_ms: removal.start_ms,
            end_ms: removal.end_ms,
        });
        next_key += 1;
    }
    Draft {
        toggles,
        add_manual,
        remove_manual,
        next_key,
    }
}

/// `rebaseHistoryAfterSave` (QA F16): the undo history after a Save answered
/// while the review kept editing. The steps from before the save leave it,
/// as a save always clears them; every step taken since is carried onto the
/// saved list like the draft.
pub fn rebase_history_after_save(
    history: &History,
    at_save: &History,
    step: SaveStep<'_>,
) -> History {
    let since_save = at_save.past.len() <= history.past.len()
        && history.past[..at_save.past.len()] == at_save.past[..];
    let past = if since_save {
        &history.past[at_save.past.len()..]
    } else {
        &history.past[..]
    };
    let carry = |entry: &Draft| rebase_draft_after_save(entry, step);
    History {
        past: past.iter().map(carry).collect(),
        future: history.future.iter().map(carry).collect(),
    }
}

/// `CLEAN_CUT_HISTORY_MAX`.
pub const HISTORY_MAX: usize = 100;

/// `CleanCutHistory`: undo and redo over drafts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct History {
    pub past: Vec<Draft>,
    pub future: Vec<Draft>,
}

impl History {
    /// `recordCleanCutEdit`: an edit replaced `previous`; it can be undone
    /// and nothing is left to redo.
    pub fn record(&mut self, previous: Draft, max: usize) {
        self.past.push(previous);
        if self.past.len() > max {
            let excess = self.past.len() - max;
            self.past.drain(..excess);
        }
        self.future.clear();
    }

    /// `undoCleanCutEdit`: the draft before `current`.
    pub fn undo(&mut self, current: Draft) -> Option<Draft> {
        let draft = self.past.pop()?;
        self.future.insert(0, current);
        Some(draft)
    }

    /// `redoCleanCutEdit`: the draft an undo left.
    pub fn redo(&mut self, current: Draft) -> Option<Draft> {
        if self.future.is_empty() {
            return None;
        }
        let draft = self.future.remove(0);
        self.past.push(current);
        Some(draft)
    }
}

/// A span of the recording (ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `selectionCutRange`: from the first selected word's start to the last
/// one's end; None without a word.
pub fn selection_cut_range(words: &[CleanCutTranscriptWord], indexes: &[usize]) -> Option<Span> {
    let known: Vec<usize> = indexes
        .iter()
        .copied()
        .filter(|index| *index < words.len())
        .collect();
    let first = &words[*known.iter().min()?];
    let last = &words[*known.iter().max()?];
    (last.end_ms > first.start_ms).then_some(Span {
        start_ms: first.start_ms,
        end_ms: last.end_ms,
    })
}

/// `setRemovalsEnabled`: removals on or off; back at its saved state, a
/// removal leaves the draft.
pub fn set_removals_enabled(
    draft: &Draft,
    saved: &[CleanCutRemoval],
    ids: &[String],
    enabled: bool,
) -> Draft {
    let mut next = draft.clone();
    for id in ids {
        if id.starts_with(DRAFT_MANUAL_PREFIX) {
            if !enabled {
                next.add_manual.retain(|manual| manual.key != *id);
            }
            continue;
        }
        let Some(removal) = saved.iter().find(|removal| removal.id == *id) else {
            continue;
        };
        if removal.enabled == enabled {
            next.drop_toggle(id);
        } else {
            next.set_toggle(id, enabled);
        }
    }
    next
}

/// `toggleRemoval`: flip one removal.
pub fn toggle_removal(draft: &Draft, saved: &[CleanCutRemoval], id: &str) -> Draft {
    let Some(current) = effective_removals(saved, draft)
        .into_iter()
        .find(|removal| removal.id == id)
    else {
        return draft.clone();
    };
    set_removals_enabled(draft, saved, &[id.to_string()], !current.enabled)
}

/// `toggleKindGroup`: every removal of the kind cut → keep them all; else
/// cut them all.
pub fn toggle_kind_group(draft: &Draft, saved: &[CleanCutRemoval], group: GroupId) -> Draft {
    let Some(group) = KIND_GROUPS.iter().find(|entry| entry.id == group) else {
        return draft.clone();
    };
    let members: Vec<CleanCutRemoval> = effective_removals(saved, draft)
        .into_iter()
        .filter(|removal| group.kinds.contains(&removal.kind))
        .collect();
    if members.is_empty() {
        return draft.clone();
    }
    let all_cut = members.iter().all(|removal| removal.enabled);
    let ids: Vec<String> = members.into_iter().map(|removal| removal.id).collect();
    set_removals_enabled(draft, saved, &ids, !all_cut)
}

/// `addDraftManual`: cut a new range.
pub fn add_draft_manual(draft: &Draft, span: Span) -> Draft {
    if span.end_ms <= span.start_ms {
        return draft.clone();
    }
    let mut next = draft.clone();
    next.add_manual.push(DraftManual {
        key: format!("{DRAFT_MANUAL_PREFIX}{}", draft.next_key),
        start_ms: span.start_ms,
        end_ms: span.end_ms,
    });
    next.next_key = draft.next_key + 1;
    next
}

/// `removeManualRemovals`: draft ones leave the draft, saved ones are queued.
pub fn remove_manual_removals(draft: &Draft, ids: &[String]) -> Draft {
    let mut next = draft.clone();
    for id in ids {
        if !id.starts_with(DRAFT_MANUAL_PREFIX) && !next.remove_manual.contains(id) {
            next.remove_manual.push(id.clone());
        }
    }
    let queued = next.remove_manual.clone();
    for id in &queued {
        next.drop_toggle(id);
    }
    next.add_manual.retain(|manual| !ids.contains(&manual.key));
    next
}

/// `updateEdlPayload`: the one `cleanCut.updateEdl` "Save changes" sends,
/// against the saved revision; empty lists are left out.
pub fn update_edl_payload(job_id: &str, revision: u32, draft: &Draft) -> CleanCutUpdateEdlParams {
    CleanCutUpdateEdlParams {
        job_id: job_id.to_string(),
        revision,
        removals: draft
            .toggles
            .iter()
            .map(|(id, enabled)| CleanCutRemovalToggle {
                id: id.clone(),
                enabled: *enabled,
            })
            .collect(),
        add_manual: draft
            .add_manual
            .iter()
            .map(|manual| CleanCutManualRange {
                start_ms: manual.start_ms,
                end_ms: manual.end_ms,
            })
            .collect(),
        remove_manual: draft.remove_manual.clone(),
    }
}

/// `rebaseDraft`: the draft carried onto a newer saved list. A toggle
/// survives while its removal still exists and still differs; a queued
/// manual deletion survives while its removal does.
pub fn rebase_draft(draft: &Draft, saved: &[CleanCutRemoval]) -> Draft {
    let find = |id: &str| saved.iter().find(|removal| removal.id == id);
    Draft {
        toggles: draft
            .toggles
            .iter()
            .filter(|(id, enabled)| find(id).is_some_and(|removal| removal.enabled != *enabled))
            .cloned()
            .collect(),
        remove_manual: draft
            .remove_manual
            .iter()
            .filter(|id| {
                find(id).is_some_and(|removal| removal.kind == CleanCutRemovalKind::Manual)
            })
            .cloned()
            .collect(),
        ..draft.clone()
    }
}

// --- Chips and stats --------------------------------------------------------------

/// `CleanCutChipState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipState {
    On,
    Off,
    Mixed,
    Empty,
}

impl ChipState {
    pub fn as_str(self) -> &'static str {
        match self {
            ChipState::On => "on",
            ChipState::Off => "off",
            ChipState::Mixed => "mixed",
            ChipState::Empty => "empty",
        }
    }
}

/// `CleanCutKindChip`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindChip {
    pub group: KindGroup,
    /// Every removal of the kind, suggestions included.
    pub total: usize,
    /// The ones that are cut.
    pub cut: usize,
    pub cut_ms: u64,
    pub state: ChipState,
}

impl KindChip {
    /// The count the chip shows: "3", or "2/5" when mixed.
    pub fn count_label(&self) -> String {
        if self.state == ChipState::Mixed {
            format!("{}/{}", self.cut, self.total)
        } else {
            self.total.to_string()
        }
    }

    /// What a click does, on hover and on focus; an empty chip says why it
    /// can't.
    pub fn tooltip(&self) -> String {
        match self.state {
            ChipState::Empty => format!("No {} found.", self.group.label.to_lowercase()),
            ChipState::On => format!("Keep all {}", self.total),
            _ => format!("Cut all {}", self.total),
        }
    }
}

/// `cleanCutKindChips`.
pub fn kind_chips(effective: &[CleanCutRemoval]) -> Vec<KindChip> {
    KIND_GROUPS
        .iter()
        .filter_map(|group| {
            let mut total = 0;
            let mut cut = 0;
            let mut cut_ms = 0;
            for removal in effective {
                if !group.kinds.contains(&removal.kind) {
                    continue;
                }
                total += 1;
                if removal.enabled {
                    cut += 1;
                    cut_ms += length_of(removal);
                }
            }
            if total == 0 && !group.always {
                return None;
            }
            let state = if total == 0 {
                ChipState::Empty
            } else if cut == total {
                ChipState::On
            } else if cut == 0 {
                ChipState::Off
            } else {
                ChipState::Mixed
            };
            Some(KindChip {
                group: *group,
                total,
                cut,
                cut_ms,
                state,
            })
        })
        .collect()
}

/// `cutSkipRanges`: what the player skips, every removal that is cut.
pub fn cut_skip_ranges(effective: &[CleanCutRemoval]) -> Vec<Span> {
    effective
        .iter()
        .filter(|removal| removal.enabled)
        .map(|removal| Span {
            start_ms: removal.start_ms,
            end_ms: removal.end_ms,
        })
        .collect()
}

/// `CleanCutStats`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub duration_ms: u64,
    pub kept_ms: u64,
    pub saved_ms: u64,
    pub cuts: usize,
}

/// `cleanCutStats`: the saved, frame-exact `keptMs` is the base; a draft
/// moves it by exactly what it adds or gives back.
pub fn stats(
    duration_ms: u64,
    saved: &[CleanCutRemoval],
    effective: &[CleanCutRemoval],
    saved_kept_ms: Option<u64>,
) -> Stats {
    let draft_kept = kept_duration_ms(duration_ms, &cut_skip_ranges(effective));
    let kept_ms = match saved_kept_ms {
        Some(saved_kept) => {
            let moved = saved_kept as i64 + draft_kept as i64
                - kept_duration_ms(duration_ms, &cut_skip_ranges(saved)) as i64;
            (moved.max(0) as u64).min(duration_ms)
        }
        None => draft_kept,
    };
    Stats {
        duration_ms,
        kept_ms,
        saved_ms: duration_ms.saturating_sub(kept_ms),
        cuts: effective
            .iter()
            .filter(|removal| removal.enabled && removal.kind != CleanCutRemovalKind::Condensed)
            .count(),
    }
}

// --- Skip ranges (`lib/skip-ranges.ts`) --------------------------------------------

/// `normalizeSkipRanges`: sorted, merged, non-empty ranges within
/// `[0, duration]` (no limit when the duration is unknown); touching and
/// overlapping ranges become one.
pub fn normalize_skip_ranges(ranges: &[Span], duration_ms: Option<u64>) -> Vec<Span> {
    let limit = duration_ms.filter(|ms| *ms > 0).unwrap_or(u64::MAX);
    let mut cleaned: Vec<Span> = ranges
        .iter()
        .map(|range| Span {
            start_ms: range.start_ms,
            end_ms: range.end_ms.min(limit),
        })
        .filter(|range| range.end_ms > range.start_ms)
        .collect();
    cleaned.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
    let mut merged: Vec<Span> = Vec::with_capacity(cleaned.len());
    for range in cleaned {
        match merged.last_mut() {
            Some(last) if range.start_ms <= last.end_ms => {
                last.end_ms = last.end_ms.max(range.end_ms);
            }
            _ => merged.push(range),
        }
    }
    merged
}

/// `skipTargetMs`: where playback jumps when `position` sits inside a
/// removed range (its end), or None on kept content. `ranges` normalized;
/// `lookahead_ms` treats a position that close before a range as inside it.
pub fn skip_target_ms(ranges: &[Span], position_ms: f64, lookahead_ms: f64) -> Option<u64> {
    if !position_ms.is_finite() {
        return None;
    }
    let mut low = 0usize;
    let mut high = ranges.len();
    while low < high {
        let middle = (low + high) / 2;
        let range = ranges[middle];
        if position_ms < range.start_ms as f64 - lookahead_ms {
            high = middle;
        } else if position_ms >= range.end_ms as f64 {
            low = middle + 1;
        } else {
            return Some(range.end_ms);
        }
    }
    None
}

/// `skippedDurationMs`.
pub fn skipped_duration_ms(ranges: &[Span]) -> u64 {
    ranges
        .iter()
        .map(|range| range.end_ms - range.start_ms)
        .sum()
}

/// `keptDurationMs`: the recording minus what is skipped.
pub fn kept_duration_ms(duration_ms: u64, ranges: &[Span]) -> u64 {
    if duration_ms == 0 {
        return 0;
    }
    duration_ms.saturating_sub(skipped_duration_ms(&normalize_skip_ranges(
        ranges,
        Some(duration_ms),
    )))
}

// --- Pins -------------------------------------------------------------------------

/// `CleanCutPin`: a moment of the stream report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub key: String,
    /// `voice`, `manual` or `chat`.
    pub kind: String,
    pub label: String,
    pub start_ms: u64,
    pub excerpt: String,
}

impl Pin {
    /// The pin's tooltip: "Label: excerpt", or the label.
    pub fn tooltip(&self) -> String {
        if self.excerpt.is_empty() {
            self.label.clone()
        } else {
            format!("{}: {}", self.label, self.excerpt)
        }
    }
}

/// `cleanCutPins`: the report's moments as pins, in time order.
pub fn pins(moments: &[Moment]) -> Vec<Pin> {
    let mut sorted: Vec<&Moment> = moments.iter().collect();
    sorted.sort_by_key(|moment| moment.start_ms);
    sorted
        .into_iter()
        .enumerate()
        .map(|(index, moment)| {
            let kind = moment.source.clone().unwrap_or_else(|| "chat".into());
            Pin {
                key: format!("{index}-{kind}-{}", moment.start_ms),
                kind,
                label: moment_label(moment),
                start_ms: moment.start_ms,
                excerpt: moment.excerpt.trim().to_string(),
            }
        })
        .collect()
}

// --- Transcript layout --------------------------------------------------------------

const PARAGRAPH_PAUSE_MS: i64 = 2_000;
const PARAGRAPH_MAX_SENTENCES: usize = 5;
const PARAGRAPH_MAX_WORDS: usize = 90;
const FALLBACK_SENTENCE_PAUSE_MS: i64 = 1_200;
const FALLBACK_SENTENCE_MAX_WORDS: usize = 40;
/// A part boundary lands on a sentence start, give or take frame snapping.
const BOUNDARY_TOLERANCE_MS: i64 = 250;

/// `CleanCutTranscriptToken`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Word {
        index: usize,
        text: String,
        start_ms: u64,
        end_ms: u64,
        /// Removals covering the word, innermost first.
        removal_ids: Vec<String>,
    },
    /// A removal that covers no word: a silence, a pause, the start or the end.
    Marker {
        removal_id: String,
        kind: CleanCutRemovalKind,
        start_ms: u64,
        end_ms: u64,
    },
    Pin(Pin),
}

/// `CleanCutParagraph`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraph {
    pub key: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub tokens: Vec<Token>,
    /// Every removal the paragraph shows.
    pub removal_ids: Vec<String>,
}

impl Paragraph {
    /// The first and last word index it shows.
    pub fn word_span(&self) -> Option<(usize, usize)> {
        let mut words = self.tokens.iter().filter_map(|token| match token {
            Token::Word { index, .. } => Some(*index),
            _ => None,
        });
        let first = words.next()?;
        Some((first, words.next_back().unwrap_or(first)))
    }
}

/// `normalizeTranscriptWords`: words in time order.
pub fn normalize_words(mut words: Vec<CleanCutTranscriptWord>) -> Vec<CleanCutTranscriptWord> {
    if words
        .windows(2)
        .any(|pair| pair[1].start_ms < pair[0].start_ms)
    {
        words.sort_by_key(|word| word.start_ms);
    }
    words
}

/// `SENTENCE_END`: `/[.?!…]["')\]]*$/` on the trimmed word.
fn ends_sentence(text: &str) -> bool {
    let trimmed = text.trim().trim_end_matches(['"', '\'', ')', ']']);
    trimmed.ends_with(['.', '?', '!', '…'])
}

/// Word indices that start a sentence: from the segments, or from
/// punctuation and pauses when there are none.
fn sentence_starts(
    words: &[CleanCutTranscriptWord],
    segments: &[CleanCutTranscriptSegment],
) -> Vec<usize> {
    if words.is_empty() {
        return Vec::new();
    }
    let mut starts = vec![0usize];
    if segments.len() > 1 {
        let mut sorted: Vec<&CleanCutTranscriptSegment> = segments.iter().collect();
        sorted.sort_by_key(|segment| segment.start_ms);
        let mut word = 0usize;
        for segment in sorted.iter().skip(1) {
            while word < words.len() && words[word].start_ms + 1 < segment.start_ms {
                word += 1;
            }
            if word >= words.len() {
                break;
            }
            if word > *starts.last().unwrap_or(&0) {
                starts.push(word);
            }
        }
        return starts;
    }
    let mut count = 0usize;
    for index in 1..words.len() {
        count += 1;
        let previous = &words[index - 1];
        let pause = words[index].start_ms as i64 - previous.end_ms as i64;
        if ends_sentence(&previous.text)
            || pause >= FALLBACK_SENTENCE_PAUSE_MS
            || count >= FALLBACK_SENTENCE_MAX_WORDS
        {
            starts.push(index);
            count = 0;
        }
    }
    starts
}

/// Word index ranges `[start, end)` of the paragraphs.
fn paragraph_ranges(
    words: &[CleanCutTranscriptWord],
    sentences: &[usize],
    breaks_ms: &[u64],
) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut breaks: Vec<i64> = breaks_ms
        .iter()
        .map(|ms| *ms as i64 - BOUNDARY_TOLERANCE_MS)
        .collect();
    breaks.sort_unstable();
    let mut break_index = 0usize;
    let mut start = 0usize;
    let mut sentence_count = 0usize;
    for (index, first) in sentences.iter().copied().enumerate() {
        let end = sentences.get(index + 1).copied().unwrap_or(words.len());
        if index > 0 {
            let previous = &words[first - 1];
            let first_word = &words[first];
            while break_index < breaks.len() && breaks[break_index] <= previous.start_ms as i64 {
                break_index += 1;
            }
            let crosses_break =
                break_index < breaks.len() && breaks[break_index] <= first_word.start_ms as i64;
            let pause = first_word.start_ms as i64 - previous.end_ms as i64 >= PARAGRAPH_PAUSE_MS;
            let full =
                sentence_count >= PARAGRAPH_MAX_SENTENCES || end - start > PARAGRAPH_MAX_WORDS;
            if crosses_break || pause || full {
                ranges.push((start, first));
                start = first;
                sentence_count = 0;
            }
        }
        sentence_count += 1;
    }
    if !words.is_empty() {
        ranges.push((start, words.len()));
    }
    ranges
}

/// The paragraph that owns a time: from its start to the next one's start.
fn paragraph_at(starts: &[u64], ms: u64) -> usize {
    starts
        .partition_point(|start| *start <= ms)
        .saturating_sub(1)
}

/// `CleanCutLayoutInput`.
#[derive(Debug, Clone, Copy)]
pub struct LayoutInput<'a> {
    pub words: &'a [CleanCutTranscriptWord],
    pub segments: &'a [CleanCutTranscriptSegment],
    /// The saved cut list (the layout does not change with the draft).
    pub removals: &'a [CleanCutRemoval],
    pub pins: &'a [Pin],
    /// Times a paragraph must not straddle (Condensed part boundaries).
    pub breaks_ms: &'a [u64],
    /// Kinds the transcript leaves to other UI (Condensed parts).
    pub skip_kinds: &'a [CleanCutRemovalKind],
}

/// `buildCleanCutParagraphs`: the transcript as paragraphs of words, with
/// the removals mapped onto them. A word belongs to every removal that
/// covers its midpoint; a removal that covers no word becomes an inline
/// marker at its start. Linear in words plus removals.
pub fn build_paragraphs(input: LayoutInput<'_>) -> Vec<Paragraph> {
    let words = input.words;
    let mut cuts: Vec<&CleanCutRemoval> = input
        .removals
        .iter()
        .filter(|removal| !input.skip_kinds.contains(&removal.kind))
        .collect();
    cuts.sort_by(|a, b| by_time(a, b));

    // Coverage: a sweep over words and removals, both in time order.
    let mut covering: Vec<Vec<String>> = Vec::with_capacity(words.len());
    let mut covered: HashSet<&str> = HashSet::new();
    let mut open: Vec<&CleanCutRemoval> = Vec::new();
    let mut next = 0usize;
    for word in words {
        let middle = (word.start_ms as f64 + word.end_ms as f64) / 2.0;
        while next < cuts.len() && cuts[next].start_ms as f64 <= middle {
            open.push(cuts[next]);
            next += 1;
        }
        open.retain(|removal| removal.end_ms as f64 > middle);
        if open.is_empty() {
            covering.push(Vec::new());
            continue;
        }
        let mut inner: Vec<&CleanCutRemoval> = open.clone();
        inner.sort_by_key(|removal| length_of(removal));
        let ids: Vec<String> = inner.iter().map(|removal| removal.id.clone()).collect();
        for removal in &inner {
            covered.insert(removal.id.as_str());
        }
        covering.push(ids);
    }

    let ranges = paragraph_ranges(
        words,
        &sentence_starts(words, input.segments),
        input.breaks_ms,
    );
    let mut extras: Vec<(u64, Token)> = cuts
        .iter()
        .filter(|removal| !covered.contains(removal.id.as_str()))
        .map(|removal| {
            (
                removal.start_ms,
                Token::Marker {
                    removal_id: removal.id.clone(),
                    kind: removal.kind,
                    start_ms: removal.start_ms,
                    end_ms: removal.end_ms,
                },
            )
        })
        .chain(
            input
                .pins
                .iter()
                .map(|pin| (pin.start_ms, Token::Pin(pin.clone()))),
        )
        .collect();
    extras.sort_by_key(|(ms, _)| *ms);

    let marker_ids = |tokens: &[Token]| -> Vec<String> {
        tokens
            .iter()
            .filter_map(|token| match token {
                Token::Marker { removal_id, .. } => Some(removal_id.clone()),
                _ => None,
            })
            .collect()
    };

    if ranges.is_empty() {
        if extras.is_empty() {
            return Vec::new();
        }
        let start_ms = extras[0].0;
        let end_ms = extras[extras.len() - 1].0;
        let tokens: Vec<Token> = extras.into_iter().map(|(_, token)| token).collect();
        return vec![Paragraph {
            key: "p-0".into(),
            start_ms,
            end_ms,
            removal_ids: marker_ids(&tokens),
            tokens,
        }];
    }

    let starts: Vec<u64> = ranges
        .iter()
        .map(|(start, _)| words[*start].start_ms)
        .collect();
    let mut by_paragraph: Vec<Vec<(u64, Token)>> = vec![Vec::new(); ranges.len()];
    for extra in extras {
        by_paragraph[paragraph_at(&starts, extra.0)].push(extra);
    }

    ranges
        .iter()
        .zip(by_paragraph)
        .map(|(&(start, end), own)| {
            let mut tokens = Vec::with_capacity(end - start + own.len());
            let mut ids: Vec<String> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            let mut add_id = |id: &str, ids: &mut Vec<String>| {
                if seen.insert(id.to_string()) {
                    ids.push(id.to_string());
                }
            };
            let mut own = own.into_iter().peekable();
            for (index, word) in words.iter().enumerate().take(end).skip(start) {
                while let Some((ms, _)) = own.peek() {
                    if *ms > word.start_ms {
                        break;
                    }
                    let (_, token) = own.next().expect("peeked");
                    if let Token::Marker { removal_id, .. } = &token {
                        add_id(removal_id, &mut ids);
                    }
                    tokens.push(token);
                }
                for id in &covering[index] {
                    add_id(id, &mut ids);
                }
                tokens.push(Token::Word {
                    index,
                    text: word.text.clone(),
                    start_ms: word.start_ms,
                    end_ms: word.end_ms,
                    removal_ids: covering[index].clone(),
                });
            }
            for (_, token) in own {
                if let Token::Marker { removal_id, .. } = &token {
                    add_id(removal_id, &mut ids);
                }
                tokens.push(token);
            }
            Paragraph {
                key: format!("p-{}-{start}", words[start].start_ms),
                start_ms: words[start].start_ms,
                end_ms: words[end - 1].end_ms,
                tokens,
                removal_ids: ids,
            }
        })
        .collect()
}

/// `activeWordIndex`: the word under the playhead (a quarter second of grace
/// after it ends), or None between words.
pub fn active_word_index(words: &[CleanCutTranscriptWord], position_ms: f64) -> Option<usize> {
    if !position_ms.is_finite() || words.is_empty() {
        return None;
    }
    let found = words
        .partition_point(|word| word.start_ms as f64 <= position_ms)
        .checked_sub(1)?;
    (position_ms < words[found].end_ms as f64 + 250.0).then_some(found)
}

// --- Condensed ----------------------------------------------------------------------

/// `CondensedBlock`'s kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Kept,
    LeftOut,
}

/// `CondensedBlock`: a part of a Condensed cut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub key: String,
    pub kind: BlockKind,
    pub start_ms: u64,
    pub end_ms: u64,
    pub title: String,
    /// The first words, to recognise a part without opening it.
    pub excerpt: String,
    /// Cut right now: a part still left out, or a kept part that was dropped.
    pub removed: bool,
    /// The `condensed` removals that leave this part out.
    pub condensed_ids: Vec<String>,
    /// Manual removals (saved ids or draft keys) that drop this part.
    pub manual_ids: Vec<String>,
}

impl Block {
    /// `BlockRow`'s title: a left-out part says whether it was brought back.
    pub fn shown_title(&self) -> &str {
        match (self.kind, self.removed) {
            (BlockKind::LeftOut, true) => "Left out",
            (BlockKind::LeftOut, false) => "Brought back",
            (BlockKind::Kept, _) => &self.title,
        }
    }

    /// `BLOCK_ACTIONS`: the row's one button.
    pub fn action(&self) -> &'static str {
        match (self.kind, self.removed) {
            (BlockKind::Kept, false) => "Drop",
            (BlockKind::Kept, true) => "Keep",
            (BlockKind::LeftOut, false) => "Leave out",
            (BlockKind::LeftOut, true) => "Bring back",
        }
    }
}

const MIN_LEFT_OUT_MS: u64 = 500;
const EXCERPT_WORDS: usize = 12;

fn overlap_ms(a: (u64, u64), b: (u64, u64)) -> u64 {
    a.1.min(b.1).saturating_sub(a.0.max(b.0))
}

fn excerpt_for(words: &[CleanCutTranscriptWord], start_ms: u64, end_ms: u64) -> String {
    let mut inside: Vec<&str> = Vec::new();
    let mut more = false;
    let first = words.partition_point(|word| word.start_ms < start_ms);
    for word in &words[first..] {
        if word.start_ms >= end_ms {
            break;
        }
        if inside.len() == EXCERPT_WORDS {
            more = true;
            break;
        }
        inside.push(word.text.trim());
    }
    let text = inside
        .into_iter()
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if more { format!("{text}…") } else { text }
}

fn complement(removals: &[&CleanCutRemoval], duration_ms: u64) -> Vec<(u64, u64)> {
    let mut sorted: Vec<&&CleanCutRemoval> = removals.iter().collect();
    sorted.sort_by(|a, b| by_time(a, b));
    let mut out = Vec::new();
    let mut cursor = 0u64;
    for removal in sorted {
        if removal.start_ms > cursor {
            out.push((cursor, removal.start_ms));
        }
        cursor = cursor.max(removal.end_ms);
    }
    if cursor < duration_ms {
        out.push((cursor, duration_ms));
    }
    out.retain(|(start, end)| end - start >= MIN_LEFT_OUT_MS);
    out
}

/// `condensedBlocks`: the Condensed cut as parts tiling the recording: the
/// kept parts from the keeps (their titles from the selection) and the parts
/// between them, left out by `condensed` removals. Without keeps the parts
/// come from the `condensed` removals alone.
pub fn condensed_blocks(
    duration_ms: u64,
    keeps: &[CleanCutCondensedKeep],
    effective: &[CleanCutRemoval],
    words: &[CleanCutTranscriptWord],
) -> Vec<Block> {
    let condensed: Vec<&CleanCutRemoval> = effective
        .iter()
        .filter(|removal| removal.kind == CleanCutRemovalKind::Condensed)
        .collect();
    let manual: Vec<&CleanCutRemoval> = effective
        .iter()
        .filter(|removal| removal.kind == CleanCutRemovalKind::Manual && removal.enabled)
        .collect();
    let kept: Vec<(u64, u64, String)> = if keeps.is_empty() {
        complement(&condensed, duration_ms)
            .into_iter()
            .enumerate()
            .map(|(index, (start, end))| (start, end, format!("Part {}", index + 1)))
            .collect()
    } else {
        let mut kept: Vec<(u64, u64, String)> = keeps
            .iter()
            .map(|keep| {
                (
                    keep.start_ms,
                    keep.end_ms.min(duration_ms),
                    keep.title.trim().to_string(),
                )
            })
            .filter(|(start, end, _)| end > start)
            .collect();
        kept.sort_by_key(|(start, _, _)| *start);
        kept
    };

    let mut ranges: Vec<(BlockKind, u64, u64, String)> = Vec::new();
    let mut cursor = 0u64;
    for (start, end, title) in kept {
        if start.saturating_sub(cursor) >= MIN_LEFT_OUT_MS && start > cursor {
            ranges.push((BlockKind::LeftOut, cursor, start, "Left out".into()));
        }
        ranges.push((
            BlockKind::Kept,
            cursor.max(start),
            end,
            if title.is_empty() {
                "Untitled part".into()
            } else {
                title
            },
        ));
        cursor = cursor.max(end);
    }
    if duration_ms.saturating_sub(cursor) >= MIN_LEFT_OUT_MS && duration_ms > cursor {
        ranges.push((BlockKind::LeftOut, cursor, duration_ms, "Left out".into()));
    }

    ranges
        .into_iter()
        .map(|(kind, start_ms, end_ms, title)| {
            let range = (start_ms, end_ms);
            let span = end_ms.saturating_sub(start_ms).max(1);
            let condensed_ids: Vec<String> = condensed
                .iter()
                .filter(|removal| {
                    let overlap = overlap_ms((removal.start_ms, removal.end_ms), range);
                    overlap > 0 && overlap * 2 >= span.min(length_of(removal))
                })
                .map(|removal| removal.id.clone())
                .collect();
            let covering: Vec<&&CleanCutRemoval> = manual
                .iter()
                .filter(|removal| overlap_ms((removal.start_ms, removal.end_ms), range) > 0)
                .collect();
            let manual_covered: u64 = covering
                .iter()
                .map(|removal| overlap_ms((removal.start_ms, removal.end_ms), range))
                .sum();
            let dropped = manual_covered as f64 >= span as f64 * 0.9;
            let left_out = condensed
                .iter()
                .any(|removal| removal.enabled && condensed_ids.contains(&removal.id));
            Block {
                key: format!(
                    "{}-{start_ms}",
                    match kind {
                        BlockKind::Kept => "kept",
                        BlockKind::LeftOut => "left-out",
                    }
                ),
                kind,
                start_ms,
                end_ms,
                title,
                excerpt: excerpt_for(words, start_ms, end_ms),
                removed: left_out || dropped,
                condensed_ids,
                manual_ids: if dropped {
                    covering.iter().map(|removal| removal.id.clone()).collect()
                } else {
                    Vec::new()
                },
            }
        })
        .collect()
}

/// `toggleCondensedBlock`: bringing a part back switches its `condensed`
/// removals off and deletes any manual cut over it; dropping a kept part
/// cuts its whole range as a manual removal.
pub fn toggle_condensed_block(draft: &Draft, saved: &[CleanCutRemoval], block: &Block) -> Draft {
    if block.removed {
        let mut next = set_removals_enabled(draft, saved, &block.condensed_ids, false);
        if !block.manual_ids.is_empty() {
            next = remove_manual_removals(&next, &block.manual_ids);
        }
        return next;
    }
    if !block.condensed_ids.is_empty() {
        return set_removals_enabled(draft, saved, &block.condensed_ids, true);
    }
    add_draft_manual(
        draft,
        Span {
            start_ms: block.start_ms,
            end_ms: block.end_ms,
        },
    )
}

/// `CleanCutTranscriptItem`: one row of the transcript list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Paragraph(Paragraph),
    Block(Block),
}

impl Item {
    pub fn key(&self) -> String {
        match self {
            Item::Paragraph(paragraph) => paragraph.key.clone(),
            Item::Block(block) => format!("block-{}", block.key),
        }
    }
}

/// `cleanCutTranscriptItems`: Clean, the paragraphs; Condensed, each part's
/// header, then its paragraphs unless the part is cut.
pub fn transcript_items(paragraphs: &[Paragraph], blocks: Option<&[Block]>) -> Vec<Item> {
    let Some(blocks) = blocks else {
        return paragraphs.iter().cloned().map(Item::Paragraph).collect();
    };
    let mut items = Vec::new();
    let mut paragraph = 0usize;
    for (index, block) in blocks.iter().enumerate() {
        items.push(Item::Block(block.clone()));
        let last = index + 1 == blocks.len();
        while paragraph < paragraphs.len()
            && (last
                || (paragraphs[paragraph].start_ms as i64)
                    < block.end_ms as i64 - BOUNDARY_TOLERANCE_MS)
        {
            if !block.removed {
                items.push(Item::Paragraph(paragraphs[paragraph].clone()));
            }
            paragraph += 1;
        }
    }
    items
}

/// `removalRowIndex`: removal id → the first row that shows it.
pub fn removal_row_index(items: &[Item]) -> HashMap<String, usize> {
    let mut rows = HashMap::new();
    for (row, item) in items.iter().enumerate() {
        if let Item::Paragraph(paragraph) = item {
            for id in &paragraph.removal_ids {
                rows.entry(id.clone()).or_insert(row);
            }
        }
    }
    rows
}

/// `wordRows`: word index → the row that shows it.
pub fn word_rows(items: &[Item]) -> HashMap<usize, usize> {
    let mut rows = HashMap::new();
    for (row, item) in items.iter().enumerate() {
        if let Item::Paragraph(paragraph) = item {
            for token in &paragraph.tokens {
                if let Token::Word { index, .. } = token {
                    rows.insert(*index, row);
                }
            }
        }
    }
    rows
}

/// `navigableRemovals`: the removals ↑ and ↓ walk, the ones the transcript
/// shows, in time order.
pub fn navigable_removals(
    effective: &[CleanCutRemoval],
    rows: &HashMap<String, usize>,
) -> Vec<CleanCutRemoval> {
    effective
        .iter()
        .filter(|removal| rows.contains_key(&removal.id))
        .cloned()
        .collect()
}

/// `stepRemoval`: ↑ / ↓. With nothing selected, ↓ picks the first removal
/// ending after the playhead and ↑ the last one starting before it; at
/// either end the selection stays.
pub fn step_removal(
    order: &[CleanCutRemoval],
    current: Option<&str>,
    forward: bool,
    position_ms: f64,
) -> Option<String> {
    if order.is_empty() {
        return current.map(str::to_string);
    }
    if let Some(index) = current.and_then(|id| order.iter().position(|removal| removal.id == id)) {
        let next = if forward {
            index.checked_add(1).filter(|next| *next < order.len())
        } else {
            index.checked_sub(1)
        };
        return Some(order[next.unwrap_or(index)].id.clone());
    }
    if forward {
        return Some(
            order
                .iter()
                .find(|removal| removal.end_ms as f64 > position_ms)
                .unwrap_or(&order[order.len() - 1])
                .id
                .clone(),
        );
    }
    Some(
        order
            .iter()
            .rev()
            .find(|removal| (removal.start_ms as f64) < position_ms)
            .unwrap_or(&order[0])
            .id
            .clone(),
    )
}

/// `REVIEW_PREROLL_MS`: ↑ / ↓ put the playhead a moment before the cut.
pub const PREROLL_MS: u64 = 1_500;

pub fn preroll_ms(removal: &CleanCutRemoval) -> u64 {
    removal.start_ms.saturating_sub(PREROLL_MS)
}

// --- What the transcript draws ------------------------------------------------------

/// A cut marker's words (`markerLabel`): "Start 0.7 s", "2.2 s".
pub fn marker_label(removal: &CleanCutRemoval) -> String {
    let length = format_cut_length(length_of(removal));
    match removal.kind {
        CleanCutRemovalKind::Head => format!("Start {length}"),
        CleanCutRemovalKind::Tail => format!("End {length}"),
        _ => length,
    }
}

/// `removalTitle`: why it's a cut and what a click does.
pub fn removal_title(removal: &CleanCutRemoval, cut: bool) -> String {
    let reason = removal.reason.trim();
    let what = if reason.is_empty() {
        removal_kind_name(removal.kind).to_string()
    } else {
        format!("{}: {reason}", removal_kind_name(removal.kind))
    };
    format!(
        "{what}. {}",
        if cut {
            "Click to keep it."
        } else {
            "Click to cut it."
        }
    )
}

/// `runState`: the innermost removal decides the click; any cut covering
/// the word strikes it. None when no removal of the word is known.
pub fn run_state<'a>(
    ids: &[String],
    removals: &'a HashMap<String, CleanCutRemoval>,
) -> Option<(&'a CleanCutRemoval, bool, Tone)> {
    let known: Vec<&CleanCutRemoval> = ids.iter().filter_map(|id| removals.get(id)).collect();
    let primary = *known.first()?;
    let cut_by = known.iter().find(|removal| removal.enabled).copied();
    Some((
        primary,
        cut_by.is_some(),
        removal_tone(cut_by.unwrap_or(primary).kind),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn removal(
        id: &str,
        kind: CleanCutRemovalKind,
        start: u64,
        end: u64,
        enabled: bool,
    ) -> CleanCutRemoval {
        CleanCutRemoval {
            id: id.into(),
            start_ms: start,
            end_ms: end,
            start_frame: start * 3 / 100,
            end_frame: end * 3 / 100,
            kind,
            reason: format!("{kind:?} reason"),
            confidence: None,
            enabled,
        }
    }

    /// Words of `text`, 300 ms each with 100 ms between them, from `start`.
    fn speak(text: &str, start: u64) -> Vec<CleanCutTranscriptWord> {
        text.split(' ')
            .enumerate()
            .map(|(index, word)| CleanCutTranscriptWord {
                text: word.into(),
                start_ms: start + index as u64 * 400,
                end_ms: start + index as u64 * 400 + 300,
                filler: false,
            })
            .collect()
    }

    fn words() -> Vec<CleanCutTranscriptWord> {
        let mut words = speak("So today um we build it.", 1_000);
        words.extend(speak("We build it again.", 6_300));
        words
    }

    fn segments() -> Vec<CleanCutTranscriptSegment> {
        vec![
            CleanCutTranscriptSegment {
                id: "s1".into(),
                start_ms: 1_000,
                end_ms: 3_300,
            },
            CleanCutTranscriptSegment {
                id: "s2".into(),
                start_ms: 6_300,
                end_ms: 7_800,
            },
        ]
    }

    use CleanCutRemovalKind as K;

    fn saved() -> Vec<CleanCutRemoval> {
        vec![
            removal("r1", K::Head, 0, 700, true),
            removal("r2", K::Filler, 1_770, 2_130, true),
            removal("r3", K::Silence, 3_700, 5_900, true),
            removal("r4", K::Retake, 1_000, 3_300, false),
            removal("r5", K::Tail, 8_200, 9_000, true),
        ]
    }

    fn word_texts(paragraph: &Paragraph) -> Vec<String> {
        paragraph
            .tokens
            .iter()
            .filter_map(|token| match token {
                Token::Word { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn word_ids(paragraph: &Paragraph) -> Vec<Vec<String>> {
        paragraph
            .tokens
            .iter()
            .filter_map(|token| match token {
                Token::Word { removal_ids, .. } => Some(removal_ids.clone()),
                _ => None,
            })
            .collect()
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn the_chips_keep_the_plan_order_and_each_kind_its_tone() {
        assert_eq!(
            KIND_GROUPS.map(|group| group.label),
            [
                "Silences",
                "Ums",
                "Retakes",
                "False starts",
                "Start/end",
                "Your cuts"
            ]
        );
        assert_eq!(removal_tone(K::Filler), Tone::Warning);
        assert_eq!(removal_tone(K::Retake), Tone::Destructive);
        assert_eq!(removal_tone(K::FalseStart), Tone::Info);
        assert_eq!(removal_tone(K::Silence), Tone::Neutral);
        assert_eq!(GroupId::parse("false-starts"), Some(GroupId::FalseStarts));
    }

    #[test]
    fn short_lengths_read_as_javascript_writes_them() {
        assert_eq!(format_cut_length(1_800), "1.8 s");
        assert_eq!(format_cut_length(12_400), "12 s");
        assert_eq!(format_cut_length(90_000), "1 min 30 s");
        assert_eq!(format_cut_length(120_000), "2 min");
        // `toFixed(1)`: an exact tie rounds up, a double below the tie down.
        assert_eq!(format_cut_length(250), "0.3 s");
        assert_eq!(format_cut_length(1_250), "1.3 s");
        assert_eq!(format_cut_length(1_150), "1.1 s");
        assert_eq!(format_cut_length(400), "0.4 s");
        assert_eq!(format_cut_length(0), "0.0 s");
    }

    #[test]
    fn the_draft_applies_toggles_new_cuts_and_deletions_in_time_order() {
        let mut draft = Draft::default();
        draft.set_toggle("r4", true);
        let draft = add_draft_manual(
            &draft,
            Span {
                start_ms: 6_000,
                end_ms: 6_200,
            },
        );
        let effective = effective_removals(&saved(), &draft);
        assert!(effective.iter().find(|r| r.id == "r4").unwrap().enabled);
        assert_eq!(
            effective.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["r1", "r4", "r2", "r3", "draft:1", "r5"]
        );
        let manual = effective.iter().find(|r| r.id == "draft:1").unwrap();
        assert_eq!(manual.kind, K::Manual);
        assert!(manual.enabled);
    }

    #[test]
    fn a_flip_flipped_back_leaves_nothing_to_save() {
        let once = toggle_removal(&Draft::default(), &saved(), "r2");
        assert_eq!(once.toggle("r2"), Some(false));
        assert_eq!(once.change_count(), 1);
        assert_eq!(toggle_removal(&once, &saved(), "r2").change_count(), 0);
        assert_eq!(
            toggle_removal(&Draft::default(), &saved(), "missing"),
            Draft::default()
        );
    }

    #[test]
    fn a_chip_cuts_or_keeps_its_whole_kind() {
        let saved = vec![
            removal("a", K::Retake, 0, 100, true),
            removal("b", K::Retake, 200, 300, false),
            removal("c", K::Filler, 400, 500, true),
        ];
        let all_cut = toggle_kind_group(&Draft::default(), &saved, GroupId::Retakes);
        assert_eq!(all_cut.toggles, vec![("b".to_string(), true)]);
        let all_kept = toggle_kind_group(&all_cut, &saved, GroupId::Retakes);
        assert_eq!(all_kept.toggles, vec![("a".to_string(), false)]);
        assert_eq!(
            toggle_kind_group(&Draft::default(), &saved, GroupId::FalseStarts),
            Draft::default()
        );
        let pauses = vec![
            removal("s", K::Silence, 0, 100, true),
            removal("g", K::Gap, 200, 300, true),
        ];
        assert_eq!(
            toggle_kind_group(&Draft::default(), &pauses, GroupId::Silences).toggles,
            vec![("s".to_string(), false), ("g".to_string(), false)]
        );
    }

    #[test]
    fn save_sends_one_payload_with_only_what_changed() {
        let empty = update_edl_payload("job-1", 3, &Draft::default());
        assert_eq!(
            serde_json::to_value(&empty).unwrap(),
            serde_json::json!({ "jobId": "job-1", "revision": 3 })
        );
        let mut draft =
            set_removals_enabled(&Draft::default(), &saved(), &ids(&["r2", "r4"]), false);
        draft = add_draft_manual(
            &draft,
            Span {
                start_ms: 6_000,
                end_ms: 6_201,
            },
        );
        draft.remove_manual = ids(&["m1"]);
        assert_eq!(
            serde_json::to_value(update_edl_payload("job-1", 3, &draft)).unwrap(),
            serde_json::json!({
                "jobId": "job-1",
                "revision": 3,
                "removals": [{ "id": "r2", "enabled": false }],
                "addManual": [{ "startMs": 6_000, "endMs": 6_201 }],
                "removeManual": ["m1"]
            })
        );
    }

    #[test]
    fn a_draft_rides_onto_a_newer_list_after_a_conflict() {
        let saved = saved();
        let mut draft = set_removals_enabled(&Draft::default(), &saved, &ids(&["r2"]), false);
        draft = set_removals_enabled(&draft, &saved, &ids(&["r4"]), true);
        draft.remove_manual = ids(&["m1", "m9"]);
        let newer = vec![
            CleanCutRemoval {
                enabled: false,
                ..saved[1].clone()
            },
            saved[3].clone(),
            removal("m1", K::Manual, 7_000, 7_100, true),
        ];
        let rebased = rebase_draft(&draft, &newer);
        assert_eq!(rebased.toggles, vec![("r4".to_string(), true)]);
        assert_eq!(rebased.remove_manual, ids(&["m1"]));
    }

    /// Electron's "a save answered while the review kept editing (QA F16)".
    #[test]
    fn a_save_answered_mid_edit_drops_what_it_carried_and_keeps_the_rest() {
        let saved = saved();
        let off_r2 = set_removals_enabled(&Draft::default(), &saved, &ids(&["r2"]), false);
        let saved_r2: Vec<CleanCutRemoval> = saved
            .iter()
            .map(|entry| {
                if entry.id == "r2" {
                    CleanCutRemoval {
                        enabled: false,
                        ..entry.clone()
                    }
                } else {
                    entry.clone()
                }
            })
            .collect();
        let step = SaveStep {
            submitted: &off_r2,
            before: &saved,
            after: &saved_r2,
        };
        assert_eq!(rebase_draft_after_save(&off_r2, step).change_count(), 0);
        let later = set_removals_enabled(&off_r2, &saved, &ids(&["r3"]), false);
        assert_eq!(
            rebase_draft_after_save(&later, step).toggles,
            vec![("r3".to_string(), false)]
        );
        // Taken back while saving: the saved cut is kept again as a change.
        let back = set_removals_enabled(&off_r2, &saved, &ids(&["r2"]), true);
        assert_eq!(
            rebase_draft_after_save(&back, step).toggles,
            vec![("r2".to_string(), true)]
        );
    }

    #[test]
    fn a_save_answered_mid_edit_reconciles_the_cuts_it_made_and_deleted() {
        use CleanCutRemovalKind as K;
        let saved = saved();
        let mut with_manual = saved.clone();
        with_manual.push(removal("m1", K::Manual, 6_000, 6_200, true));
        let added = add_draft_manual(
            &Draft::default(),
            Span {
                start_ms: 7_010,
                end_ms: 7_490,
            },
        );
        let submitted = remove_manual_removals(&added, &ids(&["m1"]));
        // The backend snaps the new cut to frames and names it.
        let mut after = saved.clone();
        after.push(removal("m2", K::Manual, 7_000, 7_500, true));
        let step = SaveStep {
            submitted: &submitted,
            before: &with_manual,
            after: &after,
        };
        assert_eq!(rebase_draft_after_save(&submitted, step).change_count(), 0);
        // A later new cut stays a draft cut.
        let another = add_draft_manual(
            &submitted,
            Span {
                start_ms: 100,
                end_ms: 200,
            },
        );
        assert_eq!(
            rebase_draft_after_save(&another, step).add_manual,
            vec![DraftManual {
                key: "draft:2".into(),
                start_ms: 100,
                end_ms: 200
            }]
        );
        // The new cut taken back, and m1 kept after all: both are changes again.
        let undone = Draft {
            next_key: 2,
            ..Draft::default()
        };
        let rebased = rebase_draft_after_save(&undone, step);
        assert_eq!(rebased.remove_manual, ids(&["m2"]));
        assert_eq!(
            rebased.add_manual,
            vec![DraftManual {
                key: "draft:2".into(),
                start_ms: 6_000,
                end_ms: 6_200
            }]
        );
        assert_eq!(rebased.next_key, 3);
    }

    #[test]
    fn a_save_answered_mid_edit_keeps_only_the_undo_steps_taken_since() {
        let saved = saved();
        let off_r2 = set_removals_enabled(&Draft::default(), &saved, &ids(&["r2"]), false);
        let saved_r2: Vec<CleanCutRemoval> = saved
            .iter()
            .map(|entry| {
                if entry.id == "r2" {
                    CleanCutRemoval {
                        enabled: false,
                        ..entry.clone()
                    }
                } else {
                    entry.clone()
                }
            })
            .collect();
        let mut at_save = History::default();
        at_save.record(Draft::default(), HISTORY_MAX);
        let later = set_removals_enabled(&off_r2, &saved, &ids(&["r3"]), false);
        let mut history = at_save.clone();
        history.record(off_r2.clone(), HISTORY_MAX);
        let step = SaveStep {
            submitted: &off_r2,
            before: &saved,
            after: &saved_r2,
        };
        let mut carried = rebase_history_after_save(&history, &at_save, step);
        assert_eq!(carried.past.len(), 1);
        assert_eq!(carried.past[0].change_count(), 0);
        let undone = carried.undo(rebase_draft_after_save(&later, step));
        assert_eq!(undone.map(|draft| draft.change_count()), Some(0));
    }

    #[test]
    fn the_chips_count_each_kind_and_say_which_are_cut() {
        let chips = kind_chips(&saved());
        assert_eq!(
            chips
                .iter()
                .map(|chip| (chip.group.id.as_str(), chip.total, chip.cut, chip.state))
                .collect::<Vec<_>>(),
            [
                ("silences", 1, 1, ChipState::On),
                ("fillers", 1, 1, ChipState::On),
                ("retakes", 1, 0, ChipState::Off),
                ("false-starts", 0, 0, ChipState::Empty),
                ("start-end", 2, 2, ChipState::On),
            ]
        );
        assert_eq!(chips[3].tooltip(), "No false starts found.");
        assert_eq!(chips[0].tooltip(), "Keep all 1");
        let mixed = kind_chips(&[
            removal("a", K::Filler, 0, 100, true),
            removal("b", K::Filler, 200, 300, false),
            removal("m", K::Manual, 400, 500, true),
        ]);
        let fillers = mixed
            .iter()
            .find(|c| c.group.id == GroupId::Fillers)
            .unwrap();
        assert_eq!(fillers.state, ChipState::Mixed);
        assert_eq!(fillers.count_label(), "1/2");
        let manual = mixed
            .iter()
            .find(|c| c.group.id == GroupId::Manual)
            .unwrap();
        assert_eq!((manual.total, manual.cut), (1, 1));
    }

    #[test]
    fn the_preview_skips_only_what_is_cut() {
        assert_eq!(
            cut_skip_ranges(&saved())
                .iter()
                .map(|span| (span.start_ms, span.end_ms))
                .collect::<Vec<_>>(),
            [(0, 700), (1_770, 2_130), (3_700, 5_900), (8_200, 9_000)]
        );
        let ranges = normalize_skip_ranges(
            &[
                Span {
                    start_ms: 500,
                    end_ms: 900,
                },
                Span {
                    start_ms: 0,
                    end_ms: 500,
                },
                Span {
                    start_ms: 2_000,
                    end_ms: 9_999,
                },
                Span {
                    start_ms: 30,
                    end_ms: 30,
                },
            ],
            Some(3_000),
        );
        assert_eq!(
            ranges,
            [
                Span {
                    start_ms: 0,
                    end_ms: 900
                },
                Span {
                    start_ms: 2_000,
                    end_ms: 3_000
                }
            ]
        );
        assert_eq!(skip_target_ms(&ranges, 100.0, 0.0), Some(900));
        assert_eq!(skip_target_ms(&ranges, 950.0, 0.0), None);
        assert_eq!(skip_target_ms(&ranges, 1_960.0, 50.0), Some(3_000));
        assert_eq!(skip_target_ms(&ranges, 900.0, 0.0), None);
        assert_eq!(kept_duration_ms(3_000, &ranges), 1_100);
    }

    #[test]
    fn the_numbers_move_by_exactly_what_the_draft_changes() {
        let saved = saved();
        assert_eq!(
            stats(9_000, &saved, &saved, Some(5_000)),
            Stats {
                duration_ms: 9_000,
                kept_ms: 5_000,
                saved_ms: 4_000,
                cuts: 4
            }
        );
        let effective =
            effective_removals(&saved, &toggle_removal(&Draft::default(), &saved, "r3"));
        let moved = stats(9_000, &saved, &effective, Some(5_000));
        assert_eq!(
            (moved.kept_ms, moved.saved_ms, moved.cuts),
            (7_200, 1_800, 3)
        );
        assert_eq!(stats(9_000, &saved, &effective, None).kept_ms, 7_140);
    }

    #[test]
    fn the_reports_moments_pin_in_time_order() {
        let moment = |start: u64, reason: &str, excerpt: &str, source: &str| Moment {
            source: Some(source.into()),
            reason: reason.into(),
            excerpt: excerpt.into(),
            start_ms: start,
            end_ms: start,
        };
        let pins = pins(&[
            moment(9_000, "", " wow ", "chat"),
            moment(2_000, "You said 'clip that'", "", "voice"),
            moment(4_000, "", "", "manual"),
        ]);
        assert_eq!(
            pins.iter()
                .map(|pin| (
                    pin.start_ms,
                    pin.kind.as_str(),
                    pin.label.as_str(),
                    pin.excerpt.as_str()
                ))
                .collect::<Vec<_>>(),
            [
                (2_000, "voice", "You said 'clip that'", ""),
                (4_000, "manual", "Marked", ""),
                (9_000, "chat", "Chat got busy", "wow"),
            ]
        );
        assert_eq!(pins[2].tooltip(), "Chat got busy: wow");
    }

    fn laid_out() -> Vec<Paragraph> {
        let pin = Pin {
            key: "p".into(),
            kind: "voice".into(),
            label: "Marked".into(),
            start_ms: 6_300,
            excerpt: String::new(),
        };
        build_paragraphs(LayoutInput {
            words: &words(),
            segments: &segments(),
            removals: &saved(),
            pins: &[pin],
            breaks_ms: &[],
            skip_kinds: &[],
        })
    }

    #[test]
    fn paragraphs_break_at_long_pauses_and_words_know_their_cuts() {
        let paragraphs = laid_out();
        assert_eq!(paragraphs.len(), 2);
        assert_eq!(
            word_texts(&paragraphs[0]),
            ["So", "today", "um", "we", "build", "it."]
        );
        let first = word_ids(&paragraphs[0]);
        assert_eq!(first[2], ids(&["r2", "r4"]));
        assert_eq!(first[3], ids(&["r4"]));
        assert!(word_ids(&paragraphs[1])[0].is_empty());
    }

    #[test]
    fn wordless_cuts_and_pins_sit_inline_where_they_happen() {
        let paragraphs = laid_out();
        let first = &paragraphs[0].tokens;
        assert!(
            matches!(&first[0], Token::Marker { removal_id, kind: K::Head, .. } if removal_id == "r1")
        );
        assert!(
            matches!(first.last(), Some(Token::Marker { removal_id, .. }) if removal_id == "r3")
        );
        let second = &paragraphs[1].tokens;
        assert!(matches!(second[0], Token::Pin(_)));
        assert!(
            matches!(second.last(), Some(Token::Marker { removal_id, .. }) if removal_id == "r5")
        );
        for id in ["r1", "r2", "r3", "r4"] {
            assert!(paragraphs[0].removal_ids.iter().any(|each| each == id));
        }
        assert_eq!(paragraphs[0].word_span(), Some((0, 5)));
    }

    #[test]
    fn sentences_come_from_punctuation_and_boundaries_hold() {
        let mut words = speak("One two three.", 0);
        words.extend(speak("Four five.", 1_200));
        let laid = build_paragraphs(LayoutInput {
            words: &words,
            segments: &[],
            removals: &[],
            pins: &[],
            breaks_ms: &[],
            skip_kinds: &[],
        });
        assert_eq!(laid.len(), 1);
        assert_eq!(word_texts(&laid[0]).len(), 5);
        let split = build_paragraphs(LayoutInput {
            words: &words,
            segments: &[
                CleanCutTranscriptSegment {
                    id: "s1".into(),
                    start_ms: 0,
                    end_ms: 1_100,
                },
                CleanCutTranscriptSegment {
                    id: "s2".into(),
                    start_ms: 1_200,
                    end_ms: 1_900,
                },
            ],
            removals: &[],
            pins: &[],
            breaks_ms: &[1_200],
            skip_kinds: &[],
        });
        assert_eq!(
            split
                .iter()
                .map(|p| word_texts(p).len())
                .collect::<Vec<_>>(),
            [3, 2]
        );
        assert!(ends_sentence("it.\")"));
        assert!(!ends_sentence("so"));
    }

    #[test]
    fn skipped_kinds_are_left_to_the_parts_and_silence_shows_only_cuts() {
        let laid = build_paragraphs(LayoutInput {
            words: &words(),
            segments: &segments(),
            removals: &[removal("c1", K::Condensed, 3_300, 9_000, true)],
            pins: &[],
            breaks_ms: &[],
            skip_kinds: &[K::Condensed],
        });
        assert!(laid.iter().all(|p| p.removal_ids.is_empty()));
        let only_cuts = build_paragraphs(LayoutInput {
            words: &[],
            segments: &[],
            removals: &[
                removal("h", K::Head, 0, 500, true),
                removal("t", K::Tail, 8_000, 9_000, true),
            ],
            pins: &[],
            breaks_ms: &[],
            skip_kinds: &[],
        });
        assert_eq!(only_cuts.len(), 1);
        assert!(
            only_cuts[0]
                .tokens
                .iter()
                .all(|t| matches!(t, Token::Marker { .. }))
        );
        assert!(
            build_paragraphs(LayoutInput {
                words: &[],
                segments: &[],
                removals: &[],
                pins: &[],
                breaks_ms: &[],
                skip_kinds: &[],
            })
            .is_empty()
        );
    }

    #[test]
    fn a_two_hour_transcript_lays_out_quickly() {
        let mut words = Vec::new();
        let mut removals = Vec::new();
        for index in 0..30_000u64 {
            words.push(CleanCutTranscriptWord {
                text: if index % 50 == 0 { "um" } else { "word" }.into(),
                start_ms: index * 240,
                end_ms: index * 240 + 200,
                filler: false,
            });
            if index % 50 == 0 {
                removals.push(removal(
                    &format!("f{index}"),
                    K::Filler,
                    (index * 240).saturating_sub(10),
                    index * 240 + 210,
                    true,
                ));
            }
        }
        let started = std::time::Instant::now();
        let laid = build_paragraphs(LayoutInput {
            words: &words,
            segments: &[],
            removals: &removals,
            pins: &[],
            breaks_ms: &[],
            skip_kinds: &[],
        });
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(
            laid.iter().map(|p| word_texts(p).len()).sum::<usize>(),
            30_000
        );
    }

    #[test]
    fn words_keep_time_order_and_the_playhead_finds_its_word() {
        let all = words();
        let shuffled = vec![all[2].clone(), all[0].clone(), all[1].clone()];
        assert_eq!(
            normalize_words(shuffled)
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            ["So", "today", "um"]
        );
        assert_eq!(active_word_index(&all, 1_100.0), Some(0));
        assert_eq!(active_word_index(&all, 1_350.0), Some(0));
        assert_eq!(active_word_index(&all, 1_450.0), Some(1));
        assert_eq!(active_word_index(&all, 500.0), None);
        assert_eq!(active_word_index(&all, 4_500.0), None);
    }

    #[test]
    fn the_keys_walk_the_cuts_in_time_order() {
        let paragraphs = build_paragraphs(LayoutInput {
            words: &words(),
            segments: &segments(),
            removals: &saved(),
            pins: &[],
            breaks_ms: &[],
            skip_kinds: &[],
        });
        let items = transcript_items(&paragraphs, None);
        let rows = removal_row_index(&items);
        let order = navigable_removals(&effective_removals(&saved(), &Draft::default()), &rows);
        assert_eq!(
            order.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["r1", "r4", "r2", "r3", "r5"]
        );
        assert_eq!(
            step_removal(&order, Some("r2"), true, 0.0).as_deref(),
            Some("r3")
        );
        assert_eq!(
            step_removal(&order, Some("r2"), false, 0.0).as_deref(),
            Some("r4")
        );
        assert_eq!(
            step_removal(&order, Some("r5"), true, 0.0).as_deref(),
            Some("r5")
        );
        assert_eq!(
            step_removal(&order, Some("r1"), false, 0.0).as_deref(),
            Some("r1")
        );
        assert_eq!(rows.get("r5"), Some(&1));
        assert_eq!(
            step_removal(&order, None, true, 3_000.0).as_deref(),
            Some("r4")
        );
        assert_eq!(
            step_removal(&order, None, true, 6_000.0).as_deref(),
            Some("r5")
        );
        assert_eq!(
            step_removal(&order, None, false, 3_000.0).as_deref(),
            Some("r2")
        );
        assert_eq!(step_removal(&[], None, true, 0.0), None);
        assert_eq!(
            preroll_ms(&removal("x", K::Silence, 3_700, 4_000, true)),
            2_200
        );
        assert_eq!(preroll_ms(&removal("x", K::Silence, 500, 600, true)), 0);
    }

    const MIN: u64 = 60_000;

    fn condensed_case() -> (
        Vec<CleanCutCondensedKeep>,
        Vec<CleanCutTranscriptWord>,
        Vec<CleanCutRemoval>,
    ) {
        let keeps = vec![
            CleanCutCondensedKeep {
                start_ms: 0,
                end_ms: 2 * MIN,
                title: "Intro".into(),
            },
            CleanCutCondensedKeep {
                start_ms: 10 * MIN,
                end_ms: 14 * MIN,
                title: "Deploying to Vercel".into(),
            },
        ];
        let mut words = speak("Welcome back everyone.", 1_000);
        words.extend(speak("This part is left out of the cut.", 5 * MIN));
        words.extend(speak("Now we deploy.", 10 * MIN + 500));
        let saved = vec![
            removal("c1", K::Condensed, 2 * MIN, 10 * MIN, true),
            removal("c2", K::Condensed, 14 * MIN, 20 * MIN, true),
            removal("f1", K::Filler, 10 * MIN + 100, 10 * MIN + 400, true),
        ];
        (keeps, words, saved)
    }

    #[test]
    fn condensed_parts_tile_the_recording() {
        let (keeps, words, saved) = condensed_case();
        let blocks = condensed_blocks(20 * MIN, &keeps, &saved, &words);
        assert_eq!(
            blocks
                .iter()
                .map(|b| (b.kind, b.title.as_str(), b.start_ms, b.end_ms, b.removed))
                .collect::<Vec<_>>(),
            [
                (BlockKind::Kept, "Intro", 0, 2 * MIN, false),
                (BlockKind::LeftOut, "Left out", 2 * MIN, 10 * MIN, true),
                (
                    BlockKind::Kept,
                    "Deploying to Vercel",
                    10 * MIN,
                    14 * MIN,
                    false
                ),
                (BlockKind::LeftOut, "Left out", 14 * MIN, 20 * MIN, true),
            ]
        );
        assert_eq!(blocks[1].condensed_ids, ids(&["c1"]));
        assert_eq!(blocks[1].excerpt, "This part is left out of the cut.");
        let fallback = condensed_blocks(20 * MIN, &[], &saved, &words);
        assert_eq!(
            fallback
                .iter()
                .map(|b| (b.kind, b.title.as_str()))
                .collect::<Vec<_>>(),
            [
                (BlockKind::Kept, "Part 1"),
                (BlockKind::LeftOut, "Left out"),
                (BlockKind::Kept, "Part 2"),
                (BlockKind::LeftOut, "Left out"),
            ]
        );
    }

    #[test]
    fn a_part_comes_back_goes_out_again_and_drops() {
        let (keeps, words, saved) = condensed_case();
        let blocks = condensed_blocks(20 * MIN, &keeps, &saved, &words);
        let back = toggle_condensed_block(&Draft::default(), &saved, &blocks[1]);
        assert_eq!(back.toggles, vec![("c1".to_string(), false)]);
        let back_blocks =
            condensed_blocks(20 * MIN, &keeps, &effective_removals(&saved, &back), &words);
        assert!(!back_blocks[1].removed);
        assert_eq!(back_blocks[1].shown_title(), "Brought back");
        assert_eq!(back_blocks[1].action(), "Leave out");
        assert_eq!(
            toggle_condensed_block(&back, &saved, &back_blocks[1]).change_count(),
            0
        );

        let dropped = toggle_condensed_block(&Draft::default(), &saved, &blocks[0]);
        assert_eq!(
            dropped.add_manual,
            vec![DraftManual {
                key: "draft:1".into(),
                start_ms: 0,
                end_ms: 2 * MIN
            }]
        );
        let dropped_blocks = condensed_blocks(
            20 * MIN,
            &keeps,
            &effective_removals(&saved, &dropped),
            &words,
        );
        assert!(dropped_blocks[0].removed);
        assert_eq!(dropped_blocks[0].manual_ids, ids(&["draft:1"]));
        assert_eq!(dropped_blocks[0].action(), "Keep");
        assert_eq!(
            toggle_condensed_block(&dropped, &saved, &dropped_blocks[0]).change_count(),
            0
        );

        let mut saved_drop = saved.clone();
        saved_drop.push(removal("m1", K::Manual, 0, 2 * MIN, true));
        let saved_blocks = condensed_blocks(20 * MIN, &keeps, &saved_drop, &words);
        let kept = toggle_condensed_block(&Draft::default(), &saved_drop, &saved_blocks[0]);
        assert_eq!(kept.remove_manual, ids(&["m1"]));
        assert_eq!(
            serde_json::to_value(update_edl_payload("job", 1, &kept)).unwrap(),
            serde_json::json!({ "jobId": "job", "revision": 1, "removeManual": ["m1"] })
        );
    }

    #[test]
    fn a_left_out_part_is_one_row_and_a_kept_part_shows_its_words() {
        let (keeps, words, saved) = condensed_case();
        let blocks = condensed_blocks(20 * MIN, &keeps, &saved, &words);
        let breaks: Vec<u64> = blocks.iter().map(|b| b.start_ms).collect();
        let paragraphs = build_paragraphs(LayoutInput {
            words: &words,
            segments: &[],
            removals: &saved,
            pins: &[],
            breaks_ms: &breaks,
            skip_kinds: &[K::Condensed],
        });
        let items = transcript_items(&paragraphs, Some(&blocks));
        assert_eq!(
            items
                .iter()
                .map(|item| match item {
                    Item::Block(block) => format!("[{}]", block.title),
                    Item::Paragraph(_) => "p".into(),
                })
                .collect::<Vec<_>>(),
            [
                "[Intro]",
                "p",
                "[Left out]",
                "[Deploying to Vercel]",
                "p",
                "[Left out]"
            ]
        );
    }

    #[test]
    fn undo_and_redo_walk_the_drafts() {
        let first = add_draft_manual(
            &Draft::default(),
            Span {
                start_ms: 0,
                end_ms: 100,
            },
        );
        let second = add_draft_manual(
            &first,
            Span {
                start_ms: 200,
                end_ms: 300,
            },
        );
        let mut history = History::default();
        history.record(Draft::default(), HISTORY_MAX);
        history.record(first.clone(), HISTORY_MAX);
        let undone = history.undo(second.clone());
        assert_eq!(undone.as_ref(), Some(&first));
        assert_eq!(history.redo(first.clone()).as_ref(), Some(&second));
        assert_eq!(history.redo(second.clone()), None);
        let mut after_undo = history.clone();
        after_undo.undo(second.clone());
        after_undo.record(first.clone(), HISTORY_MAX);
        assert!(after_undo.future.is_empty());
        assert_eq!(History::default().undo(first.clone()), None);
        let mut bounded = History {
            past: vec![first.clone(), first.clone()],
            future: Vec::new(),
        };
        bounded.record(second.clone(), 2);
        assert_eq!(bounded.past, vec![first, second]);
    }

    #[test]
    fn a_selection_cuts_from_its_first_word_to_its_last() {
        let words = vec![
            CleanCutTranscriptWord {
                text: "So".into(),
                start_ms: 1_000,
                end_ms: 1_300,
                filler: false,
            },
            CleanCutTranscriptWord {
                text: "um".into(),
                start_ms: 1_400,
                end_ms: 1_700,
                filler: false,
            },
            CleanCutTranscriptWord {
                text: "today.".into(),
                start_ms: 1_800,
                end_ms: 2_200,
                filler: false,
            },
        ];
        assert_eq!(
            selection_cut_range(&words, &[2, 1]),
            Some(Span {
                start_ms: 1_400,
                end_ms: 2_200
            })
        );
        assert_eq!(selection_cut_range(&words, &[]), None);
        assert_eq!(selection_cut_range(&words, &[9]), None);
        let paragraphs = build_paragraphs(LayoutInput {
            words: &words,
            segments: &[],
            removals: &[],
            pins: &[],
            breaks_ms: &[],
            skip_kinds: &[],
        });
        let rows = word_rows(&transcript_items(&paragraphs, None));
        assert_eq!(rows.get(&0), Some(&0));
        assert_eq!(rows.get(&2), Some(&0));
        assert_eq!(rows.get(&7), None);
    }

    #[test]
    fn a_cut_is_read_out_with_its_place_and_its_key() {
        let cut = removal("u", K::Filler, 1_400, 1_800, true);
        assert_eq!(
            removal_announcement(&cut, 2, 5),
            "Um 0.4 s, cut. 2 of 5. Enter keeps it."
        );
        let kept = CleanCutRemoval {
            enabled: false,
            ..cut
        };
        assert_eq!(
            removal_announcement(&kept, 0, 0),
            "Um 0.4 s, kept. Enter cuts it."
        );
        assert_eq!(
            marker_label(&removal("h", K::Head, 0, 700, true)),
            "Start 0.7 s"
        );
        assert_eq!(
            removal_title(&removal("s", K::Silence, 0, 700, true), true),
            "Silence: Silence reason. Click to keep it."
        );
    }
}
