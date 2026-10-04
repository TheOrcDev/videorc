//! The cut list (plan 119 S12b): sentences from words, the local rules of
//! decision 16, the server's drops and keeps mapped to time, and the merge
//! that snaps every boundary to the source frame grid. Pure: no I/O, no
//! clock. Every constant lives in `rules.rs`.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use super::rules::{
    ANALYSIS_MAX_SEGMENT_CHARS, ANALYSIS_MAX_SEGMENTS, DROP_CONFIDENCE_ON, FILLER_PAD_MS,
    HEAD_LEAD_MS, NOISY_GAP_KEEP_MS, NOISY_GAP_MIN_MS, SENTENCE_MAX_WORDS, SENTENCE_PAUSE_MS,
    SILENCE_FLOOR_DBFS, SILENCE_GAP_PERCENTILE, SILENCE_KEEP_MS, SILENCE_MIN_GAP_MS, SLIVER_MAX_MS,
    TAIL_TRAIL_MS,
};
use super::silence::{RmsFrames, silence_threshold_dbfs, speech_bounds_ms};
use super::transcribe::{TranscriptWord, is_filler};
use crate::protocol::{
    CleanCutCondensedKeep, CleanCutEdl, CleanCutEdlStats, CleanCutFrameRate, CleanCutKindStat,
    CleanCutRemoval, CleanCutRemovalKind, CleanCutSourceIdentity, CleanCutUpdateEdlParams,
};

pub const EDL_VERSION: u32 = 1;
const MAX_REASON_CHARS: usize = 200;

/// One sentence of the transcript: the analysis job's `segments[]` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// A removal before merging and frame snapping.
#[derive(Debug, Clone, PartialEq)]
pub struct RawRemoval {
    pub start_ms: u64,
    pub end_ms: u64,
    pub kind: CleanCutRemovalKind,
    pub reason: String,
    pub confidence: Option<f64>,
    pub enabled: bool,
}

/// `artifacts.cleanCut.drops[]` (contract part C). Every field defaults so
/// one odd entry never fails the whole result; `kind` stays a string and
/// unknown kinds are skipped when mapped.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudDrop {
    #[serde(default)]
    pub from_id: String,
    #[serde(default)]
    pub to_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub reason: String,
}

/// `artifacts.cleanCut.keeps[]`: the condensed selection.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudKeep {
    #[serde(default)]
    pub from_id: String,
    #[serde(default)]
    pub to_id: String,
    #[serde(default)]
    pub title: String,
}

// --- Sentences ----------------------------------------------------------------

/// Sentences with ids `s1, s2, ...`, split after sentence punctuation, at a
/// pause of `SENTENCE_PAUSE_MS` or more, or at `SENTENCE_MAX_WORDS`, then
/// capped to the analysis job's limits. Deterministic for the same words,
/// which is what lets the cut-list phase regroup instead of storing them.
pub fn sentences(words: &[TranscriptWord]) -> Vec<Segment> {
    cap_segments(group_sentences(words))
}

pub fn group_sentences(words: &[TranscriptWord]) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    let mut current: Vec<&TranscriptWord> = Vec::new();
    for (index, word) in words.iter().enumerate() {
        current.push(word);
        let long_pause = words
            .get(index + 1)
            .is_some_and(|next| next.start_ms.saturating_sub(word.end_ms) >= SENTENCE_PAUSE_MS);
        if ends_sentence(&word.text) || long_pause || current.len() >= SENTENCE_MAX_WORDS {
            push_segment(&mut segments, &current);
            current.clear();
        }
    }
    push_segment(&mut segments, &current);
    segments
}

fn push_segment(segments: &mut Vec<Segment>, words: &[&TranscriptWord]) {
    let text = words
        .iter()
        .map(|word| word.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let Some(first) = words.first() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    let start_ms = first.start_ms;
    let end_ms = words
        .iter()
        .map(|word| word.end_ms)
        .max()
        .unwrap_or(start_ms)
        .max(start_ms);
    segments.push(Segment {
        id: format!("s{}", segments.len() + 1),
        start_ms,
        end_ms,
        text,
    });
}

const CLOSING_QUOTES: [char; 6] = ['"', '\'', ')', ']', '\u{201D}', '\u{2019}'];
const SENTENCE_ENDS: [char; 4] = ['.', '?', '!', '\u{2026}'];

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(CLOSING_QUOTES)
        .ends_with(SENTENCE_ENDS)
}

/// Merge neighbouring sentences until the count fits the contract, then
/// renumber and trim every text to the per-segment cap.
pub fn cap_segments(mut segments: Vec<Segment>) -> Vec<Segment> {
    while segments.len() > ANALYSIS_MAX_SEGMENTS {
        let mut merged = Vec::with_capacity(segments.len() / 2 + 1);
        let mut pending = segments.into_iter();
        while let Some(first) = pending.next() {
            match pending.next() {
                Some(second) => merged.push(Segment {
                    id: String::new(),
                    start_ms: first.start_ms.min(second.start_ms),
                    end_ms: first.end_ms.max(second.end_ms),
                    text: format!("{} {}", first.text, second.text),
                }),
                None => merged.push(first),
            }
        }
        segments = merged;
    }
    for (index, segment) in segments.iter_mut().enumerate() {
        segment.id = format!("s{}", index + 1);
        segment.text = truncate_chars(&segment.text, ANALYSIS_MAX_SEGMENT_CHARS);
    }
    segments
}

pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars()
        .take(max_chars)
        .collect::<String>()
        .trim_end()
        .to_string()
}

pub fn total_text_chars(segments: &[Segment]) -> usize {
    segments
        .iter()
        .map(|segment| segment.text.chars().count())
        .sum()
}

// --- Local rules (decision 16) ------------------------------------------------

/// Head, tail, silences, noisy gaps and fillers from the words and the audio.
/// With no words at all, head and tail come from the audio alone.
pub fn local_removals(
    words: &[TranscriptWord],
    frames: &RmsFrames,
    duration_ms: u64,
) -> Vec<RawRemoval> {
    if words.is_empty() {
        return head_tail_from_audio(frames, duration_ms);
    }
    let mut out = Vec::new();
    let filler_flags: Vec<bool> = words
        .iter()
        .map(|word| word.filler || is_filler(&word.text))
        .collect();
    let speech_ranges: Vec<(u64, u64)> = words
        .iter()
        .map(|word| (word.start_ms, word.end_ms))
        .collect();
    let threshold = silence_threshold_dbfs(frames, &speech_ranges);

    // Head and tail hug the first and last word that stays.
    let first_kept = words
        .iter()
        .zip(&filler_flags)
        .find(|(_, filler)| !**filler)
        .map(|(word, _)| word)
        .unwrap_or(&words[0]);
    let last_kept = words
        .iter()
        .zip(&filler_flags)
        .rev()
        .find(|(_, filler)| !**filler)
        .map(|(word, _)| word)
        .unwrap_or(&words[words.len() - 1]);
    let head_end = first_kept
        .start_ms
        .saturating_sub(HEAD_LEAD_MS)
        .min(duration_ms);
    if head_end > 0 {
        out.push(RawRemoval {
            start_ms: 0,
            end_ms: head_end,
            kind: CleanCutRemovalKind::Head,
            reason: "Before the first word".to_string(),
            confidence: None,
            enabled: true,
        });
    }
    let tail_start = last_kept.end_ms.saturating_add(TAIL_TRAIL_MS);
    if tail_start < duration_ms {
        out.push(RawRemoval {
            start_ms: tail_start,
            end_ms: duration_ms,
            kind: CleanCutRemovalKind::Tail,
            reason: "After the last word".to_string(),
            confidence: None,
            enabled: true,
        });
    }

    // Wordless gaps: silent ones shrink above 1 s, noisy ones above 4 s.
    for pair in words.windows(2) {
        let (previous, next) = (&pair[0], &pair[1]);
        let gap_start = previous.end_ms;
        let gap_end = next.start_ms;
        if gap_end <= gap_start {
            continue;
        }
        let gap = gap_end - gap_start;
        if gap <= SILENCE_MIN_GAP_MS {
            continue;
        }
        let level = frames.percentile_dbfs(gap_start, gap_end, SILENCE_GAP_PERCENTILE);
        let silent = level.is_none_or(|level| level < threshold);
        if silent {
            let keep_each_side = SILENCE_KEEP_MS / 2;
            out.push(RawRemoval {
                start_ms: gap_start + keep_each_side,
                end_ms: gap_end - keep_each_side,
                kind: CleanCutRemovalKind::Silence,
                reason: format!("Silence of {:.1} s shortened", gap as f64 / 1_000.0),
                confidence: None,
                enabled: true,
            });
        } else if gap > NOISY_GAP_MIN_MS {
            let keep_each_side = NOISY_GAP_KEEP_MS / 2;
            out.push(RawRemoval {
                start_ms: gap_start + keep_each_side,
                end_ms: gap_end - keep_each_side,
                kind: CleanCutRemovalKind::Gap,
                reason: format!(
                    "Pause with sound of {:.1} s shortened",
                    gap as f64 / 1_000.0
                ),
                confidence: None,
                enabled: true,
            });
        }
    }

    // Fillers, padded, clamped to the neighbouring words.
    for (index, word) in words.iter().enumerate() {
        if !filler_flags[index] {
            continue;
        }
        let lower = index
            .checked_sub(1)
            .map(|previous| words[previous].end_ms)
            .unwrap_or(0);
        let upper = words
            .get(index + 1)
            .map(|next| next.start_ms)
            .unwrap_or(duration_ms)
            .min(duration_ms);
        let start = word.start_ms.saturating_sub(FILLER_PAD_MS).max(lower);
        let end = word.end_ms.saturating_add(FILLER_PAD_MS).min(upper);
        if end > start {
            out.push(RawRemoval {
                start_ms: start,
                end_ms: end,
                kind: CleanCutRemovalKind::Filler,
                reason: format!("Filler \"{}\"", word.text.trim()),
                confidence: word.confidence,
                enabled: true,
            });
        }
    }
    out
}

/// No words: trim to the first and last non-silent audio frame. Empty when
/// the whole recording is silent; the caller then reports "no speech".
pub fn head_tail_from_audio(frames: &RmsFrames, duration_ms: u64) -> Vec<RawRemoval> {
    let Some((speech_start, speech_end)) = speech_bounds_ms(frames, SILENCE_FLOOR_DBFS) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let head_end = speech_start.saturating_sub(HEAD_LEAD_MS).min(duration_ms);
    if head_end > 0 {
        out.push(RawRemoval {
            start_ms: 0,
            end_ms: head_end,
            kind: CleanCutRemovalKind::Head,
            reason: "Before the first sound".to_string(),
            confidence: None,
            enabled: true,
        });
    }
    let tail_start = speech_end.saturating_add(TAIL_TRAIL_MS);
    if tail_start < duration_ms {
        out.push(RawRemoval {
            start_ms: tail_start,
            end_ms: duration_ms,
            kind: CleanCutRemovalKind::Tail,
            reason: "After the last sound".to_string(),
            confidence: None,
            enabled: true,
        });
    }
    out
}

// --- Cloud results -------------------------------------------------------------

fn segment_index(segments: &[Segment]) -> HashMap<&str, usize> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| (segment.id.as_str(), index))
        .collect()
}

fn id_range(index: &HashMap<&str, usize>, from_id: &str, to_id: &str) -> Option<(usize, usize)> {
    let from = *index.get(from_id)?;
    let to = *index.get(to_id)?;
    Some(if from <= to { (from, to) } else { (to, from) })
}

/// Retakes and false starts by segment id become removals; confidence at or
/// above `DROP_CONFIDENCE_ON` switches them on, lower ones are suggestions.
/// Unknown kinds and ids are skipped, as the contract asks.
pub fn map_drops(drops: &[CloudDrop], segments: &[Segment]) -> Vec<RawRemoval> {
    let index = segment_index(segments);
    drops
        .iter()
        .filter_map(|drop| {
            let kind = match drop.kind.as_str() {
                "retake" => CleanCutRemovalKind::Retake,
                "false_start" => CleanCutRemovalKind::FalseStart,
                _ => return None,
            };
            let (from, to) = id_range(&index, &drop.from_id, &drop.to_id)?;
            let start_ms = segments[from].start_ms;
            let end_ms = segments[to].end_ms;
            if end_ms <= start_ms {
                return None;
            }
            let confidence = if drop.confidence.is_finite() {
                drop.confidence.clamp(0.0, 1.0)
            } else {
                0.0
            };
            let reason = drop.reason.trim();
            Some(RawRemoval {
                start_ms,
                end_ms,
                kind,
                reason: if reason.is_empty() {
                    default_drop_reason(kind).to_string()
                } else {
                    truncate_chars(reason, MAX_REASON_CHARS)
                },
                confidence: Some(confidence),
                enabled: confidence >= DROP_CONFIDENCE_ON,
            })
        })
        .collect()
}

fn default_drop_reason(kind: CleanCutRemovalKind) -> &'static str {
    match kind {
        CleanCutRemovalKind::FalseStart => "An abandoned start",
        _ => "A restarted sentence; the later take is kept",
    }
}

/// Condensed: everything outside the kept ranges goes. No keeps, no removals
/// (never cut the whole recording on a bad answer).
pub fn condensed_removals(
    keeps: &[CloudKeep],
    segments: &[Segment],
    duration_ms: u64,
) -> Vec<RawRemoval> {
    let index = segment_index(segments);
    let mut kept: Vec<(u64, u64)> = keeps
        .iter()
        .filter_map(|keep| {
            let (from, to) = id_range(&index, &keep.from_id, &keep.to_id)?;
            let range = (
                segments[from].start_ms,
                segments[to].end_ms.min(duration_ms),
            );
            (range.1 > range.0).then_some(range)
        })
        .collect();
    if kept.is_empty() {
        return Vec::new();
    }
    kept.sort_unstable();
    let mut out = Vec::new();
    let mut cursor = 0_u64;
    for (start, end) in kept {
        if start > cursor {
            out.push(condensed_removal(cursor, start));
        }
        cursor = cursor.max(end);
    }
    if cursor < duration_ms {
        out.push(condensed_removal(cursor, duration_ms));
    }
    out
}

/// The Condensed selection in recording time, for `cleanCut.get` (S13/S19):
/// each keep mapped through its segment ids, sorted, unknown ids skipped.
pub fn condensed_keeps(keeps: &[CloudKeep], segments: &[Segment]) -> Vec<CleanCutCondensedKeep> {
    let index = segment_index(segments);
    let mut out: Vec<CleanCutCondensedKeep> = keeps
        .iter()
        .filter_map(|keep| {
            let (from, to) = id_range(&index, &keep.from_id, &keep.to_id)?;
            let start_ms = segments[from].start_ms;
            let end_ms = segments[to].end_ms;
            (end_ms > start_ms).then(|| CleanCutCondensedKeep {
                start_ms,
                end_ms,
                title: truncate_chars(keep.title.trim(), MAX_REASON_CHARS),
            })
        })
        .collect();
    out.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
    out
}

fn condensed_removal(start_ms: u64, end_ms: u64) -> RawRemoval {
    RawRemoval {
        start_ms,
        end_ms,
        kind: CleanCutRemovalKind::Condensed,
        reason: "Outside the condensed selection".to_string(),
        confidence: None,
        enabled: true,
    }
}

// --- Merge and snap -------------------------------------------------------------

/// Sort, merge overlaps of the same enabled state, absorb kept slivers
/// shorter than `SLIVER_MAX_MS` between enabled removals, clamp to the
/// recording. Disabled suggestions stay apart from enabled cuts.
pub fn merge_removals(mut raw: Vec<RawRemoval>, duration_ms: u64) -> Vec<RawRemoval> {
    raw.retain_mut(|removal| {
        removal.end_ms = removal.end_ms.min(duration_ms);
        removal.start_ms = removal.start_ms.min(removal.end_ms);
        removal.end_ms > removal.start_ms
    });
    raw.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));

    // (removal, span of its main contributor)
    let mut enabled: Vec<(RawRemoval, u64)> = Vec::new();
    let mut disabled: Vec<(RawRemoval, u64)> = Vec::new();
    for removal in raw {
        let bucket = if removal.enabled {
            &mut enabled
        } else {
            &mut disabled
        };
        match bucket.last_mut() {
            Some(last) if removal.start_ms <= last.0.end_ms => absorb(last, removal),
            _ => {
                let span = removal.end_ms - removal.start_ms;
                bucket.push((removal, span));
            }
        }
    }

    let mut absorbed: Vec<(RawRemoval, u64)> = Vec::with_capacity(enabled.len());
    for entry in enabled {
        match absorbed.last_mut() {
            Some(last) if entry.0.start_ms.saturating_sub(last.0.end_ms) < SLIVER_MAX_MS => {
                absorb(last, entry.0)
            }
            _ => absorbed.push(entry),
        }
    }
    if let Some(first) = absorbed
        .first_mut()
        .filter(|first| (1..SLIVER_MAX_MS).contains(&first.0.start_ms))
    {
        first.0.start_ms = 0;
    }
    if let Some(last) = absorbed
        .last_mut()
        .filter(|last| last.0.end_ms < duration_ms && duration_ms - last.0.end_ms < SLIVER_MAX_MS)
    {
        last.0.end_ms = duration_ms;
    }

    let mut all: Vec<RawRemoval> = absorbed
        .into_iter()
        .chain(disabled)
        .map(|(removal, _)| removal)
        .collect();
    all.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
    all
}

/// Fold `other` into `into`: the union span, the kind of the biggest
/// contributor, every distinct reason, the highest confidence.
fn absorb(into: &mut (RawRemoval, u64), other: RawRemoval) {
    let other_span = other.end_ms - other.start_ms;
    into.0.start_ms = into.0.start_ms.min(other.start_ms);
    into.0.end_ms = into.0.end_ms.max(other.end_ms);
    if other_span > into.1 {
        into.0.kind = other.kind;
        into.1 = other_span;
    }
    if !other.reason.is_empty() && !into.0.reason.contains(other.reason.as_str()) {
        let joined = if into.0.reason.is_empty() {
            other.reason
        } else {
            format!("{}; {}", into.0.reason, other.reason)
        };
        into.0.reason = truncate_chars(&joined, MAX_REASON_CHARS);
    }
    into.0.confidence = match (into.0.confidence, other.confidence) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
}

/// Nearest frame on the source grid.
pub fn ms_to_frame(ms: u64, frame_rate: CleanCutFrameRate) -> u64 {
    let frame = ms as f64 * f64::from(frame_rate.num) / (1_000.0 * f64::from(frame_rate.den));
    frame.round().max(0.0) as u64
}

/// The exact time of a frame boundary, rounded to a millisecond for display.
pub fn frame_to_ms(frame: u64, frame_rate: CleanCutFrameRate) -> u64 {
    let ms = frame as f64 * 1_000.0 * f64::from(frame_rate.den) / f64::from(frame_rate.num);
    ms.round().max(0.0) as u64
}

/// Merge, snap every boundary to the frame grid, number the removals and
/// compute the stats: the cut list, version 1.
pub fn build_edl(
    raw: Vec<RawRemoval>,
    duration_ms: u64,
    frame_rate: CleanCutFrameRate,
    source_identity: CleanCutSourceIdentity,
) -> CleanCutEdl {
    let total_frames = ms_to_frame(duration_ms, frame_rate);
    let mut removals: Vec<CleanCutRemoval> = Vec::new();
    for removal in merge_removals(raw, duration_ms) {
        let start_frame = ms_to_frame(removal.start_ms, frame_rate).min(total_frames);
        let end_frame = ms_to_frame(removal.end_ms, frame_rate).min(total_frames);
        if end_frame <= start_frame {
            continue;
        }
        removals.push(CleanCutRemoval {
            id: format!("r{}", removals.len() + 1),
            start_ms: frame_to_ms(start_frame, frame_rate),
            end_ms: frame_to_ms(end_frame, frame_rate),
            start_frame,
            end_frame,
            kind: removal.kind,
            reason: removal.reason,
            confidence: removal.confidence,
            enabled: removal.enabled,
        });
    }
    let stats = edl_stats(&removals, total_frames, frame_rate);
    CleanCutEdl {
        version: EDL_VERSION,
        source_identity,
        frame_rate,
        duration_ms,
        removals,
        stats,
    }
}

/// Stats over the enabled removals. `kept_ms` comes from the union of their
/// frame ranges, so it never drifts with the number of cuts; `by_kind` counts
/// each removal under its own kind.
pub fn edl_stats(
    removals: &[CleanCutRemoval],
    total_frames: u64,
    frame_rate: CleanCutFrameRate,
) -> CleanCutEdlStats {
    let mut by_kind: BTreeMap<CleanCutRemovalKind, (u32, u64)> = BTreeMap::new();
    let mut enabled: Vec<(u64, u64)> = Vec::new();
    for removal in removals.iter().filter(|removal| removal.enabled) {
        let frames = removal.end_frame.saturating_sub(removal.start_frame);
        let entry = by_kind.entry(removal.kind).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += frame_to_ms(frames, frame_rate);
        enabled.push((removal.start_frame, removal.end_frame));
    }
    enabled.sort_unstable();
    let mut removed_frames = 0_u64;
    let mut cursor: Option<(u64, u64)> = None;
    for (start, end) in enabled {
        match cursor {
            Some((current_start, current_end)) if start <= current_end => {
                cursor = Some((current_start, current_end.max(end)));
            }
            Some((current_start, current_end)) => {
                removed_frames += current_end - current_start;
                cursor = Some((start, end));
            }
            None => cursor = Some((start, end)),
        }
    }
    if let Some((current_start, current_end)) = cursor {
        removed_frames += current_end - current_start;
    }
    CleanCutEdlStats {
        by_kind: by_kind
            .into_iter()
            .map(|(kind, (count, ms))| CleanCutKindStat { kind, count, ms })
            .collect(),
        kept_ms: frame_to_ms(total_frames.saturating_sub(removed_frames), frame_rate),
    }
}

/// `cleanCut.updateEdl`: toggles, manual additions (frame snapped, ids
/// `m1, m2, ...`) and manual deletions. Nothing is re-merged; the stats are
/// recomputed.
pub fn apply_edl_update(
    mut edl: CleanCutEdl,
    params: &CleanCutUpdateEdlParams,
) -> Result<CleanCutEdl, String> {
    for toggle in &params.removals {
        let removal = edl
            .removals
            .iter_mut()
            .find(|removal| removal.id == toggle.id)
            .ok_or_else(|| format!("Unknown removal {}.", toggle.id))?;
        removal.enabled = toggle.enabled;
    }
    for id in &params.remove_manual {
        let position = edl
            .removals
            .iter()
            .position(|removal| removal.id == *id)
            .ok_or_else(|| format!("Unknown removal {id}."))?;
        if edl.removals[position].kind != CleanCutRemovalKind::Manual {
            return Err(format!("Only manual removals can be deleted ({id})."));
        }
        edl.removals.remove(position);
    }
    let frame_rate = edl.frame_rate;
    let total_frames = ms_to_frame(edl.duration_ms, frame_rate);
    let mut counter = edl
        .removals
        .iter()
        .filter_map(|removal| removal.id.strip_prefix('m')?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    for range in &params.add_manual {
        if range.end_ms <= range.start_ms {
            return Err("A manual removal must end after it starts.".to_string());
        }
        let start_frame =
            ms_to_frame(range.start_ms.min(edl.duration_ms), frame_rate).min(total_frames);
        let end_frame =
            ms_to_frame(range.end_ms.min(edl.duration_ms), frame_rate).min(total_frames);
        if end_frame <= start_frame {
            return Err("A manual removal must cover at least one frame.".to_string());
        }
        counter += 1;
        edl.removals.push(CleanCutRemoval {
            id: format!("m{counter}"),
            start_ms: frame_to_ms(start_frame, frame_rate),
            end_ms: frame_to_ms(end_frame, frame_rate),
            start_frame,
            end_frame,
            kind: CleanCutRemovalKind::Manual,
            reason: "Removed by you".to_string(),
            confidence: None,
            enabled: true,
        });
    }
    edl.removals.sort_by(|a, b| {
        a.start_frame
            .cmp(&b.start_frame)
            .then(a.end_frame.cmp(&b.end_frame))
    });
    edl.stats = edl_stats(&edl.removals, total_frames, frame_rate);
    Ok(edl)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CleanCutManualRange, CleanCutRemovalToggle};

    const FPS30: CleanCutFrameRate = CleanCutFrameRate { num: 30, den: 1 };
    const NTSC: CleanCutFrameRate = CleanCutFrameRate {
        num: 30_000,
        den: 1_001,
    };

    fn word(text: &str, start_ms: u64, end_ms: u64) -> TranscriptWord {
        TranscriptWord {
            text: text.to_string(),
            start_ms,
            end_ms,
            confidence: None,
            filler: false,
        }
    }

    fn identity() -> CleanCutSourceIdentity {
        CleanCutSourceIdentity {
            path: "source.mp4".to_string(),
            size_bytes: 1,
            modified_unix_ms: None,
        }
    }

    /// -20 dBFS inside the words and the `noisy` ranges (noise at -30), -70
    /// everywhere else: digital room tone.
    fn frames_for(words: &[TranscriptWord], noisy: &[(u64, u64)], duration_ms: u64) -> RmsFrames {
        let frame_ms = 50;
        let count = (duration_ms / frame_ms) as usize;
        let mut dbfs = vec![-70.0; count];
        for (index, level) in dbfs.iter_mut().enumerate() {
            let at = index as u64 * frame_ms;
            if words
                .iter()
                .any(|word| at >= word.start_ms && at < word.end_ms)
            {
                *level = -20.0;
            } else if noisy.iter().any(|(start, end)| at >= *start && at < *end) {
                *level = -30.0;
            }
        }
        RmsFrames { frame_ms, dbfs }
    }

    fn kinds(removals: &[RawRemoval]) -> Vec<(CleanCutRemovalKind, u64, u64)> {
        removals
            .iter()
            .map(|removal| (removal.kind, removal.start_ms, removal.end_ms))
            .collect()
    }

    #[test]
    fn sentences_split_on_punctuation_pauses_and_the_word_cap() {
        let mut words = vec![
            word("So", 0, 200),
            word("today.", 300, 600),
            word("We", 800, 900),
            word("build", 1_000, 1_300),
            // a 700 ms pause ends the sentence even without punctuation
            word("the", 2_000, 2_100),
            word("thing", 2_200, 2_500),
        ];
        // an 800 ms pause before the first "w" ends "the thing" without punctuation
        for index in 0..45 {
            let start = 3_300 + index * 100;
            words.push(word("w", start, start + 50));
        }
        let segments = sentences(&words);
        assert_eq!(segments[0].id, "s1");
        assert_eq!((segments[0].start_ms, segments[0].end_ms), (0, 600));
        assert_eq!(segments[0].text, "So today.");
        assert_eq!(segments[1].text, "We build");
        assert_eq!((segments[1].start_ms, segments[1].end_ms), (800, 1_300));
        assert_eq!(segments[2].text, "the thing");
        assert_eq!(segments[3].text.split(' ').count(), SENTENCE_MAX_WORDS);
        assert_eq!(segments[4].text.split(' ').count(), 5);
        assert_eq!(segments.len(), 5);
        assert_eq!(segments[4].id, "s5");
        assert!(sentences(&[]).is_empty());
        assert!(ends_sentence("done.\""));
        assert!(ends_sentence("why?"));
        assert!(!ends_sentence("because"));
        assert!(!ends_sentence("well,"));
    }

    #[test]
    fn segments_are_capped_by_merging_neighbours() {
        let many: Vec<Segment> = (0..(ANALYSIS_MAX_SEGMENTS + 1))
            .map(|index| Segment {
                id: format!("s{}", index + 1),
                start_ms: index as u64 * 1_000,
                end_ms: index as u64 * 1_000 + 900,
                text: format!("w{index}"),
            })
            .collect();
        let capped = cap_segments(many);
        assert_eq!(capped.len(), ANALYSIS_MAX_SEGMENTS / 2 + 1);
        assert_eq!(capped[0].text, "w0 w1");
        assert_eq!((capped[0].start_ms, capped[0].end_ms), (0, 1_900));
        assert_eq!(capped[0].id, "s1");
        assert_eq!(capped.last().unwrap().id, format!("s{}", capped.len()));
        let long = cap_segments(vec![Segment {
            id: "x".to_string(),
            start_ms: 0,
            end_ms: 1,
            text: "a".repeat(ANALYSIS_MAX_SEGMENT_CHARS + 50),
        }]);
        assert_eq!(long[0].text.chars().count(), ANALYSIS_MAX_SEGMENT_CHARS);
        assert_eq!(total_text_chars(&long), ANALYSIS_MAX_SEGMENT_CHARS);
    }

    #[test]
    fn head_and_tail_hug_the_first_and_last_kept_words() {
        let words = vec![word("Hello", 2_000, 2_400), word("there.", 2_500, 3_000)];
        let frames = frames_for(&words, &[], 10_000);
        let removals = local_removals(&words, &frames, 10_000);
        assert_eq!(
            kinds(&removals),
            vec![
                (CleanCutRemovalKind::Head, 0, 1_700),
                (CleanCutRemovalKind::Tail, 3_600, 10_000),
            ]
        );
        // A filler at either edge is skipped over: head and tail reach the
        // words that stay, and the filler cut merges with them.
        let edged = vec![
            word("um", 1_000, 1_300),
            word("Hello", 2_000, 2_400),
            word("there.", 2_500, 3_000),
            word("uh", 3_200, 3_400),
        ];
        let frames = frames_for(&edged, &[], 10_000);
        let edl = build_edl(
            local_removals(&edged, &frames, 10_000),
            10_000,
            FPS30,
            identity(),
        );
        let spans: Vec<(u64, u64, bool)> = edl
            .removals
            .iter()
            .map(|removal| (removal.start_ms, removal.end_ms, removal.enabled))
            .collect();
        assert_eq!(spans, vec![(0, 1_700, true), (3_167, 10_000, true)]);
        assert_eq!(edl.removals[0].kind, CleanCutRemovalKind::Head);
        assert!(edl.removals[0].reason.contains("Filler \"um\""));
    }

    #[test]
    fn silent_gaps_shrink_to_400ms_and_noisy_gaps_only_above_4s() {
        let words = vec![
            word("one", 1_000, 1_300),
            // 3 s of room tone
            word("two", 4_300, 4_600),
            // 3 s with music: left alone
            word("three", 7_600, 7_900),
            // 5 s with music: shortened to 1.5 s
            word("four", 12_900, 13_200),
            // 0.9 s silence: too short to touch
            word("five", 14_100, 14_400),
        ];
        let frames = frames_for(&words, &[(4_600, 7_600), (7_900, 12_900)], 20_000);
        let removals = local_removals(&words, &frames, 20_000);
        assert_eq!(
            kinds(&removals),
            vec![
                (CleanCutRemovalKind::Head, 0, 700),
                (CleanCutRemovalKind::Tail, 15_000, 20_000),
                (CleanCutRemovalKind::Silence, 1_500, 4_100),
                (CleanCutRemovalKind::Gap, 8_650, 12_150),
            ]
        );
        assert_eq!(
            removals[2].end_ms - removals[2].start_ms,
            3_000 - SILENCE_KEEP_MS
        );
        assert_eq!(
            removals[3].end_ms - removals[3].start_ms,
            5_000 - NOISY_GAP_KEEP_MS
        );
    }

    #[test]
    fn fillers_are_padded_clamped_to_neighbours_and_merge_back_to_back() {
        let words = vec![
            word("So", 1_000, 1_200),
            word("um", 1_210, 1_500),
            word("uh", 1_540, 1_800),
            word("today", 1_900, 2_300),
            word("hmm.", 2_310, 2_500),
            word("Yes", 2_600, 2_900),
        ];
        let frames = frames_for(&words, &[], 4_000);
        let removals = local_removals(&words, &frames, 4_000);
        let fillers: Vec<(u64, u64)> = removals
            .iter()
            .filter(|removal| removal.kind == CleanCutRemovalKind::Filler)
            .map(|removal| (removal.start_ms, removal.end_ms))
            .collect();
        // um: 1180 is clamped to So's end (1200); 1530 stays (uh starts at 1540).
        // uh: 1510 stays (um ends at 1500); 1830 stays (today starts at 1900).
        // hmm: 2280 is clamped to today's end (2300); 2530 stays.
        assert_eq!(
            fillers,
            vec![(1_200, 1_530), (1_510, 1_830), (2_300, 2_530)]
        );
        let merged = merge_removals(removals, 4_000);
        let filler_cuts: Vec<(u64, u64)> = merged
            .iter()
            .filter(|removal| removal.kind == CleanCutRemovalKind::Filler)
            .map(|removal| (removal.start_ms, removal.end_ms))
            .collect();
        assert_eq!(
            filler_cuts,
            vec![(1_200, 1_830), (2_300, 2_530)],
            "back-to-back fillers overlap by their padding and become one cut"
        );
        assert!(merged[0].kind == CleanCutRemovalKind::Head && merged[0].end_ms == 700);
    }

    #[test]
    fn an_empty_transcript_trims_head_and_tail_by_audio_alone() {
        let frames = RmsFrames {
            frame_ms: 50,
            dbfs: {
                let mut levels = vec![-70.0; 200]; // 10 s
                for level in levels.iter_mut().take(100).skip(40) {
                    *level = -25.0; // sound from 2.0 s to 5.0 s
                }
                levels
            },
        };
        assert_eq!(
            kinds(&local_removals(&[], &frames, 10_000)),
            vec![
                (CleanCutRemovalKind::Head, 0, 1_700),
                (CleanCutRemovalKind::Tail, 5_600, 10_000),
            ]
        );
        let silent = RmsFrames {
            frame_ms: 50,
            dbfs: vec![-90.0; 200],
        };
        assert!(local_removals(&[], &silent, 10_000).is_empty());
    }

    #[test]
    fn drops_map_to_segment_times_and_the_confidence_threshold_switches_them() {
        let segments = vec![
            Segment {
                id: "s1".into(),
                start_ms: 0,
                end_ms: 4_000,
                text: "a".into(),
            },
            Segment {
                id: "s2".into(),
                start_ms: 4_200,
                end_ms: 9_000,
                text: "b".into(),
            },
            Segment {
                id: "s3".into(),
                start_ms: 9_300,
                end_ms: 12_000,
                text: "c".into(),
            },
        ];
        let drop = |from: &str, to: &str, kind: &str, confidence: f64| CloudDrop {
            from_id: from.into(),
            to_id: to.into(),
            kind: kind.into(),
            confidence,
            reason: String::new(),
        };
        let mapped = map_drops(
            &[
                drop("s1", "s2", "retake", 0.82),
                drop("s3", "s3", "false_start", 0.59),
                drop("s3", "s2", "retake", 0.6),
                drop("s1", "s1", "mumble", 0.99),
                drop("s9", "s1", "retake", 0.99),
            ],
            &segments,
        );
        assert_eq!(mapped.len(), 3, "unknown kinds and ids are skipped");
        assert_eq!((mapped[0].start_ms, mapped[0].end_ms), (0, 9_000));
        assert!(mapped[0].enabled);
        assert_eq!(mapped[0].kind, CleanCutRemovalKind::Retake);
        assert!(!mapped[1].enabled, "0.59 is a suggestion");
        assert_eq!(mapped[1].kind, CleanCutRemovalKind::FalseStart);
        assert_eq!(mapped[1].reason, "An abandoned start");
        assert!(mapped[2].enabled, "0.6 is on");
        assert_eq!(
            (mapped[2].start_ms, mapped[2].end_ms),
            (4_200, 12_000),
            "a swapped pair is read in order"
        );
        assert_eq!(mapped[2].confidence, Some(0.6));
    }

    #[test]
    fn condensed_keeps_become_the_complement() {
        let segments: Vec<Segment> = (0..6)
            .map(|index| Segment {
                id: format!("s{}", index + 1),
                start_ms: index * 10_000,
                end_ms: index * 10_000 + 9_000,
                text: "x".into(),
            })
            .collect();
        let keep = |from: &str, to: &str| CloudKeep {
            from_id: from.into(),
            to_id: to.into(),
            title: "t".into(),
        };
        let removals = condensed_removals(&[keep("s5", "s5"), keep("s1", "s2")], &segments, 60_000);
        assert_eq!(
            kinds(&removals),
            vec![
                (CleanCutRemovalKind::Condensed, 19_000, 40_000),
                (CleanCutRemovalKind::Condensed, 49_000, 60_000),
            ]
        );
        assert!(condensed_removals(&[], &segments, 60_000).is_empty());
        assert!(condensed_removals(&[keep("nope", "s1")], &segments, 60_000).is_empty());
    }

    #[test]
    fn merge_absorbs_slivers_and_keeps_disabled_suggestions_apart() {
        let raw =
            |start_ms: u64, end_ms: u64, kind: CleanCutRemovalKind, enabled: bool| RawRemoval {
                start_ms,
                end_ms,
                kind,
                reason: format!("{kind:?}"),
                confidence: None,
                enabled,
            };
        let merged = merge_removals(
            vec![
                raw(5_000, 5_400, CleanCutRemovalKind::Filler, true),
                raw(1_000, 2_000, CleanCutRemovalKind::Silence, true),
                raw(2_100, 2_600, CleanCutRemovalKind::Filler, true),
                raw(1_500, 6_000, CleanCutRemovalKind::Retake, false),
                raw(9_900, 10_000, CleanCutRemovalKind::Tail, true),
                raw(100, 150, CleanCutRemovalKind::Filler, true),
                raw(12_000, 11_000, CleanCutRemovalKind::Gap, true),
            ],
            10_000,
        );
        assert_eq!(
            kinds(&merged),
            vec![
                (CleanCutRemovalKind::Filler, 0, 150),
                (CleanCutRemovalKind::Silence, 1_000, 2_600),
                (CleanCutRemovalKind::Retake, 1_500, 6_000),
                (CleanCutRemovalKind::Filler, 5_000, 5_400),
                (CleanCutRemovalKind::Tail, 9_900, 10_000),
            ]
        );
        assert!(!merged[2].enabled, "the suggestion stays its own entry");
        assert!(merged[1].reason.contains("Silence") && merged[1].reason.contains("Filler"));
    }

    #[test]
    fn frame_snapping_keeps_cumulative_drift_at_zero_over_500_cuts() {
        let duration_ms = 3_600_000;
        let raw: Vec<RawRemoval> = (0..500)
            .map(|index| {
                let start = 1_000 + index * 7_000;
                RawRemoval {
                    start_ms: start,
                    end_ms: start + 333,
                    kind: CleanCutRemovalKind::Silence,
                    reason: String::new(),
                    confidence: None,
                    enabled: true,
                }
            })
            .collect();
        let edl = build_edl(raw, duration_ms, NTSC, identity());
        assert_eq!(edl.removals.len(), 500);
        let total_frames = ms_to_frame(duration_ms, NTSC);
        let mut removed_frames = 0;
        for removal in &edl.removals {
            assert_eq!(ms_to_frame(removal.start_ms, NTSC), removal.start_frame);
            assert_eq!(ms_to_frame(removal.end_ms, NTSC), removal.end_frame);
            assert_eq!(frame_to_ms(removal.start_frame, NTSC), removal.start_ms);
            assert!(removal.end_frame > removal.start_frame);
            removed_frames += removal.end_frame - removal.start_frame;
        }
        // Exact: the kept length in frames, as a rational, rounded once.
        let kept_frames = total_frames - removed_frames;
        let exact_kept_ms = (kept_frames as f64 * 1_001.0 / 30.0).round() as u64;
        assert_eq!(edl.stats.kept_ms, exact_kept_ms);
        // The naive per-cut millisecond sum drifts by up to half a millisecond
        // per boundary (a thousand of them here); the frame-based figure is
        // what S13 renders against and it never does.
        let naive_removed_ms: u64 = edl
            .removals
            .iter()
            .map(|removal| removal.end_ms - removal.start_ms)
            .sum();
        let naive_drift =
            (duration_ms as i64 - naive_removed_ms as i64 - edl.stats.kept_ms as i64).abs();
        assert!(
            naive_drift <= 500,
            "naive drift {naive_drift} ms exceeds the rounding bound"
        );
        let exact_removed_frames: u64 = edl
            .removals
            .iter()
            .map(|removal| removal.end_frame - removal.start_frame)
            .sum();
        assert_eq!(exact_removed_frames, removed_frames);
        let removed_from_frames = frame_to_ms(total_frames, NTSC) as i64 - edl.stats.kept_ms as i64;
        let removed_exact = ((removed_frames as f64 * 1_001.0 / 30.0).round()) as i64;
        assert!(
            (removed_from_frames - removed_exact).abs() <= 1,
            "removed time from frames ({removed_from_frames}) matches the rational ({removed_exact}) to the millisecond"
        );
        assert_eq!(edl.stats.by_kind.len(), 1);
        assert_eq!(edl.stats.by_kind[0].count, 500);
        assert_eq!(edl.version, EDL_VERSION);
        assert_eq!(edl.removals[0].id, "r1");
        assert_eq!(edl.removals[499].id, "r500");

        // Every 30 fps boundary is a whole 33.3 ms step; 10 ms snaps to frame 0.
        assert_eq!(ms_to_frame(10, FPS30), 0);
        assert_eq!(ms_to_frame(17, FPS30), 1);
        assert_eq!(frame_to_ms(3, FPS30), 100);
        assert_eq!(ms_to_frame(1_001, NTSC), 30);
    }

    #[test]
    fn edl_update_toggles_adds_manual_removals_and_rejects_unknown_ids() {
        let edl = build_edl(
            vec![
                RawRemoval {
                    start_ms: 0,
                    end_ms: 1_000,
                    kind: CleanCutRemovalKind::Head,
                    reason: "head".into(),
                    confidence: None,
                    enabled: true,
                },
                RawRemoval {
                    start_ms: 5_000,
                    end_ms: 6_000,
                    kind: CleanCutRemovalKind::Retake,
                    reason: "retake".into(),
                    confidence: Some(0.5),
                    enabled: false,
                },
            ],
            10_000,
            FPS30,
            identity(),
        );
        assert_eq!(edl.stats.kept_ms, 9_000);
        let updated = apply_edl_update(
            edl.clone(),
            &CleanCutUpdateEdlParams {
                job_id: "job".into(),
                revision: 0,
                removals: vec![CleanCutRemovalToggle {
                    id: "r2".into(),
                    enabled: true,
                }],
                add_manual: vec![CleanCutManualRange {
                    start_ms: 8_010,
                    end_ms: 8_500,
                }],
                remove_manual: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(updated.removals.len(), 3);
        assert!(updated.removals[1].enabled);
        let manual = &updated.removals[2];
        assert_eq!(manual.id, "m1");
        assert_eq!(manual.kind, CleanCutRemovalKind::Manual);
        assert_eq!((manual.start_frame, manual.end_frame), (240, 255));
        assert_eq!((manual.start_ms, manual.end_ms), (8_000, 8_500));
        assert_eq!(updated.stats.kept_ms, 10_000 - 1_000 - 1_000 - 500);
        assert_eq!(updated.summary().removal_count, 3);

        let removed = apply_edl_update(
            updated.clone(),
            &CleanCutUpdateEdlParams {
                job_id: "job".into(),
                revision: 1,
                removals: Vec::new(),
                add_manual: Vec::new(),
                remove_manual: vec!["m1".into()],
            },
        )
        .unwrap();
        assert_eq!(removed.removals.len(), 2);
        assert!(
            apply_edl_update(
                updated.clone(),
                &CleanCutUpdateEdlParams {
                    job_id: "job".into(),
                    revision: 1,
                    removals: Vec::new(),
                    add_manual: Vec::new(),
                    remove_manual: vec!["r1".into()],
                },
            )
            .is_err(),
            "only manual removals can be deleted"
        );
        assert!(
            apply_edl_update(
                updated.clone(),
                &CleanCutUpdateEdlParams {
                    job_id: "job".into(),
                    revision: 1,
                    removals: vec![CleanCutRemovalToggle {
                        id: "nope".into(),
                        enabled: false,
                    }],
                    add_manual: Vec::new(),
                    remove_manual: Vec::new(),
                },
            )
            .is_err()
        );
        assert!(
            apply_edl_update(
                updated,
                &CleanCutUpdateEdlParams {
                    job_id: "job".into(),
                    revision: 1,
                    removals: Vec::new(),
                    add_manual: vec![CleanCutManualRange {
                        start_ms: 500,
                        end_ms: 500,
                    }],
                    remove_manual: Vec::new(),
                },
            )
            .is_err()
        );
    }
}
