//! Clip that (plan 068 D6): a spoken "clip that" or a manual mark stamps a
//! recording-file time the streamer wants clipped.
//!
//! Detection is a pure phrase matcher over transcript finals and their word
//! segments. The previous final's last words are kept so a phrase split across
//! a chunk boundary ("clip" | "that") still matches. Marks persist in the
//! `clip_marks` table only when the active session records to a file; a
//! stream-only session keeps nothing and the event says so.
//!
//! The caption task calls [`note_transcript_final`], which locks, matches, and
//! returns; the recording lock and the database write happen on a spawned task.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use chrono::Utc;

use crate::captions::CaptionSegment;
use crate::protocol::{ClipMark, ClipMarkSource, ClipMarkedEvent};
use crate::replay_buffer::{DEFAULT_CLIP_SECONDS, LONG_CLIP_SECONDS};
use crate::state::AppState;

/// English phrases that place a mark, as normalized words, and the clip
/// length each one saves (plan 199 D7: "clip the last minute" and "long
/// clip" save the minute; every older phrase stays today's 30 s).
pub const CLIP_PHRASES: &[(&[&str], u32)] = &[
    (&["clip", "that"], DEFAULT_CLIP_SECONDS),
    (&["clip", "it"], DEFAULT_CLIP_SECONDS),
    (&["clip", "this"], DEFAULT_CLIP_SECONDS),
    (&["thats", "a", "clip"], DEFAULT_CLIP_SECONDS),
    (&["make", "a", "clip"], DEFAULT_CLIP_SECONDS),
    (&["clip", "the", "last", "minute"], LONG_CLIP_SECONDS),
    (&["long", "clip"], LONG_CLIP_SECONDS),
];

/// A voice match within this many seconds of the previous mark (voice or
/// manual) is the same moment said twice.
pub const CLIP_MARK_DEDUPE_SECONDS: f64 = 10.0;

/// The words in the longest phrase of [`CLIP_PHRASES`].
const fn longest_phrase_words() -> usize {
    let mut longest = 0;
    let mut index = 0;
    while index < CLIP_PHRASES.len() {
        if CLIP_PHRASES[index].0.len() > longest {
            longest = CLIP_PHRASES[index].0.len();
        }
        index += 1;
    }
    longest
}

/// One word fewer than the longest phrase (four words since plan 199), so
/// the carried words complete any phrase that started in the previous final.
/// Derived from the table, so a longer phrase can never outgrow the tail.
const TAIL_WORDS: usize = longest_phrase_words() - 1;

/// Carried words older than this, or ahead of this final, are not its sentence.
const TAIL_MAX_AGE_SECONDS: f64 = 6.0;

/// One active capture and its most recently drained predecessor. A provider
/// drain may still own the first while the next owner is registered in tests
/// or a future transport; neither undrained owner may be evicted.
const MAX_RETAINED_RECORDINGS: usize = 2;

/// Why `clip.mark` produced no mark.
#[derive(Debug, thiserror::Error)]
pub enum ClipMarkError {
    #[error("No session is running, so there is nothing to mark.")]
    NoActiveSession,
    /// Plan 199: a length that is not 30 or 60 s. Refused before any mark.
    #[error("{}", crate::replay_buffer::INVALID_CLIP_LENGTH_MESSAGE)]
    InvalidLength,
    #[error("{0}")]
    Storage(#[from] anyhow::Error),
}

impl ClipMarkError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoActiveSession => "no-active-session",
            Self::InvalidLength => crate::replay_buffer::INVALID_CLIP_LENGTH_CODE,
            Self::Storage(_) => "clip-mark-failed",
        }
    }
}

/// One transcript word with its recording-file time.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    pub word: String,
    pub at_seconds: f64,
}

/// A phrase found in the transcript and the file time of its first word.
#[derive(Debug, Clone, PartialEq)]
pub struct PhraseMatch {
    /// The phrase as spoken, normalized ("clip that").
    pub phrase: String,
    pub at_seconds: f64,
    /// The clip length the phrase saves (plan 199): 30 or 60.
    pub seconds: u32,
}

/// Lowercase ASCII letters and digits only: "That's," → "thats", "Clip!" →
/// "clip". Whole words compare, so "eclipse", "clipboard" and "clipped"
/// never equal "clip".
pub fn normalize_word(raw: &str) -> Option<String> {
    let word: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    (!word.is_empty()).then_some(word)
}

/// The final's words with file times: each word takes the start of the
/// segment it came from; without segments every word takes the final's
/// offset.
pub fn timed_words(text: &str, segments: &[CaptionSegment], offset_seconds: f64) -> Vec<TimedWord> {
    if segments.is_empty() {
        return text
            .split_whitespace()
            .filter_map(normalize_word)
            .map(|word| TimedWord {
                word,
                at_seconds: offset_seconds,
            })
            .collect();
    }
    segments
        .iter()
        .flat_map(|segment| {
            let at_seconds = offset_seconds + segment.start_second.max(0.0);
            segment
                .text
                .split_whitespace()
                .filter_map(normalize_word)
                .map(move |word| TimedWord { word, at_seconds })
        })
        .collect()
}

/// The earliest clip phrase in `tail ++ words` that ends inside `words`, so
/// a phrase already matched from the tail alone is never matched again.
pub fn find_clip_phrase(tail: &[TimedWord], words: &[TimedWord]) -> Option<PhraseMatch> {
    let all: Vec<&TimedWord> = tail.iter().chain(words.iter()).collect();
    for start in 0..all.len() {
        for (phrase, seconds) in CLIP_PHRASES {
            let end = start + phrase.len();
            if end > all.len() || end <= tail.len() {
                continue;
            }
            if phrase
                .iter()
                .zip(&all[start..end])
                .all(|(expected, word)| word.word == *expected)
            {
                return Some(PhraseMatch {
                    phrase: phrase.join(" "),
                    at_seconds: all[start].at_seconds,
                    seconds: *seconds,
                });
            }
        }
    }
    None
}

/// Matcher state inside one explicitly owned recording.
#[derive(Debug, Default)]
struct RecordingMatcher {
    tail: Vec<TimedWord>,
    last_mark_at_seconds: Option<f64>,
}

impl RecordingMatcher {
    /// One settled final. Returns a match that is not a repeat of the last
    /// mark; the tail always advances.
    fn note_final(
        &mut self,
        text: &str,
        segments: &[CaptionSegment],
        offset_seconds: f64,
    ) -> Option<PhraseMatch> {
        let words = timed_words(text, segments, offset_seconds);
        self.tail.retain(|word| {
            word.at_seconds <= offset_seconds + 0.001
                && offset_seconds - word.at_seconds <= TAIL_MAX_AGE_SECONDS
        });
        let found = find_clip_phrase(&self.tail, &words);
        let mut carried: Vec<TimedWord> = self.tail.drain(..).chain(words).collect();
        if carried.len() > TAIL_WORDS {
            carried.drain(..carried.len() - TAIL_WORDS);
        }
        self.tail = carried;
        found.filter(|found| self.accept_voice_mark(found.at_seconds))
    }

    /// Dedupe: a voice mark within [`CLIP_MARK_DEDUPE_SECONDS`] after the
    /// previous mark is dropped, including an out-of-order final. File time
    /// is a coordinate inside this recording, never evidence of a new owner.
    fn accept_voice_mark(&mut self, at_seconds: f64) -> bool {
        if let Some(last) = self.last_mark_at_seconds
            && (at_seconds - last).abs() < CLIP_MARK_DEDUPE_SECONDS
        {
            return false;
        }
        self.last_mark_at_seconds = Some(at_seconds);
        true
    }

    /// A manual mark always lands; it only moves the dedupe window.
    fn note_manual_mark(&mut self, at_seconds: f64) {
        self.last_mark_at_seconds = Some(at_seconds);
    }
}

#[derive(Debug)]
struct RecordingMatcherOwner {
    session_id: String,
    matcher: RecordingMatcher,
    drained: bool,
    retirement_deferred: bool,
    provider_join_unproven: bool,
}

/// Recording owners are registered by caption startup or a manual mark's
/// confirmed active slot, before any transcript can match. Finals never
/// create owners: a pruned/unknown target cannot revive old words or dedupe.
/// Capture end retires only its exact owner after its caption task is joined.
/// Keep the most recent drained recording alongside the active owner so a
/// controlled late final from A cannot borrow B's tail/window. Capacity is
/// fixed; undrained owners are never evicted to make space.
#[derive(Debug, Default)]
pub struct ClipMarkDetector {
    recordings: VecDeque<RecordingMatcherOwner>,
}

impl ClipMarkDetector {
    pub fn register_recording(&mut self, session_id: &str) -> bool {
        if let Some(owner) = self
            .recordings
            .iter()
            .find(|owner| owner.session_id == session_id)
        {
            return !owner.drained;
        }
        if self.recordings.len() == MAX_RETAINED_RECORDINGS {
            let Some(retired) = self.recordings.iter().position(|owner| owner.drained) else {
                return false;
            };
            self.recordings.remove(retired);
        }
        self.recordings.push_back(RecordingMatcherOwner {
            session_id: session_id.to_string(),
            matcher: RecordingMatcher::default(),
            drained: false,
            retirement_deferred: false,
            provider_join_unproven: false,
        });
        true
    }

    pub fn note_final(
        &mut self,
        session_id: &str,
        text: &str,
        segments: &[CaptionSegment],
        offset_seconds: f64,
    ) -> Option<PhraseMatch> {
        self.recordings
            .iter_mut()
            .find(|owner| owner.session_id == session_id && !owner.provider_join_unproven)?
            .matcher
            .note_final(text, segments, offset_seconds)
    }

    pub fn note_manual_mark(&mut self, session_id: &str, at_seconds: f64) {
        if let Some(owner) = self
            .recordings
            .iter_mut()
            .find(|owner| owner.session_id == session_id)
        {
            owner.matcher.note_manual_mark(at_seconds);
        }
    }

    pub fn retire_recording(&mut self, session_id: &str) -> bool {
        if let Some(owner) = self
            .recordings
            .iter_mut()
            .find(|owner| owner.session_id == session_id)
        {
            if owner.provider_join_unproven {
                return false;
            }
            owner.drained = true;
        }
        self.prune_drained_recordings();
        true
    }

    pub fn defer_retirement(&mut self, session_id: &str) {
        if let Some(owner) = self
            .recordings
            .iter_mut()
            .find(|owner| owner.session_id == session_id)
        {
            owner.retirement_deferred = true;
        }
    }

    pub fn note_provider_join_failed(&mut self, session_id: &str) {
        if let Some(owner) = self
            .recordings
            .iter_mut()
            .find(|owner| owner.session_id == session_id)
        {
            // An unrelated or empty later runtime cannot prove this taken
            // provider handle joined. Keep only this owner's uncertainty.
            owner.provider_join_unproven = true;
        }
    }

    pub(crate) fn provider_join_unproven(&self, session_id: &str) -> bool {
        self.recordings
            .iter()
            .any(|owner| owner.session_id == session_id && owner.provider_join_unproven)
    }

    pub fn retire_deferred_recordings(&mut self) {
        for owner in &mut self.recordings {
            if owner.retirement_deferred && !owner.provider_join_unproven {
                owner.drained = true;
            }
        }
        self.prune_drained_recordings();
    }

    fn prune_drained_recordings(&mut self) {
        let latest_drained = self.recordings.iter().rposition(|owner| owner.drained);
        let mut index = 0;
        self.recordings.retain(|owner| {
            let retain = !owner.drained || Some(index) == latest_drained;
            index += 1;
            retain
        });
    }

    /// Sign-out erases every retained transcript tail, including a late owner.
    pub fn forget_words(&mut self) {
        for owner in &mut self.recordings {
            owner.matcher.tail.clear();
        }
    }
}

pub type ClipMarkDetectorSlot = Arc<StdMutex<ClipMarkDetector>>;

pub fn new_clip_mark_detector_slot() -> ClipMarkDetectorSlot {
    Arc::new(StdMutex::new(ClipMarkDetector::default()))
}

/// The capture a voice mark belongs to, read when the caption task started.
/// The final chunks of a stream are transcribed after the recording slot is
/// retired (the capture-end drain), so a voice mark never re-reads the slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkTarget {
    pub session_id: String,
    /// The session writes a recording file (a stream-only session keeps no
    /// marks).
    pub records_to_file: bool,
}

/// Register the immutable recording owner before its provider task admits any
/// finals. Stream-only/no-capture targets deliberately have no matcher state.
pub(crate) fn register_caption_target(state: &AppState, target: Option<&MarkTarget>) {
    let Some(target) = target.filter(|target| target.records_to_file) else {
        return;
    };
    let registered = state
        .clip_marks
        .lock()
        .is_ok_and(|mut detector| detector.register_recording(&target.session_id));
    if !registered {
        state.emit_log(
            "warn",
            "Voice clip marks are unavailable until the previous caption owners finish draining."
                .to_string(),
        );
    }
}

/// Caption-task hook for every transcript final (both intents, both
/// transports): match under the std lock and return. A hit is recorded on a
/// spawned task so the caller never waits on the recording lock. `target` is
/// immutable capture ownership; `None` means no capture and never falls back
/// to whichever recording happens to be active when the write runs.
pub(crate) fn note_transcript_final(
    state: &AppState,
    text: &str,
    segments: &[CaptionSegment],
    offset_seconds: f64,
    target: Option<MarkTarget>,
) {
    let Some(target) = target else {
        return;
    };
    let found = if target.records_to_file {
        state.clip_marks.lock().ok().and_then(|mut detector| {
            detector.note_final(&target.session_id, text, segments, offset_seconds)
        })
    } else {
        // A stream-only request can explain why a whole phrase was not saved,
        // but it retains no words and changes no recording's dedupe window.
        find_clip_phrase(&[], &timed_words(text, segments, offset_seconds))
    };
    let Some(found) = found else {
        return;
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        tracing::warn!(
            "Heard '{}' at {:.1}s but no runtime is available to record the clip mark.",
            found.phrase,
            found.at_seconds
        );
        return;
    };
    let state = state.clone();
    handle.spawn(async move {
        match record_mark(
            &state,
            Some(target),
            Some(found.at_seconds),
            ClipMarkSource::Voice,
            Some(found.phrase.clone()),
            found.seconds,
        )
        .await
        {
            Ok(event) if event.saved || event.reason.as_deref() == Some(CLIP_SAVED_REASON) => {
                tracing::info!(
                    "Clip marked at {:.1}s: you said '{}'.",
                    event.at_seconds,
                    found.phrase
                );
            }
            Ok(event) => tracing::info!(
                "Heard '{}' at {:.1}s but the clip was not saved ({}).",
                found.phrase,
                event.at_seconds,
                event.reason.as_deref().unwrap_or("unknown")
            ),
            Err(error) => tracing::info!(
                "Heard '{}' at {:.1}s but no clip mark landed: {error}",
                found.phrase,
                found.at_seconds
            ),
        }
    });
}

/// `clip.mark`: a manual mark at the capture's current elapsed time. Plan
/// 199: `seconds` is the press's length (30 or 60; none is 30), refused
/// before anything is marked or saved when it is neither.
pub async fn mark_manual(
    state: &AppState,
    seconds: Option<u32>,
) -> Result<ClipMarkedEvent, ClipMarkError> {
    let seconds = crate::replay_buffer::requested_clip_seconds(seconds)
        .map_err(|_| ClipMarkError::InvalidLength)?;
    record_mark(state, None, None, ClipMarkSource::Manual, None, seconds).await
}

/// Store a mark and emit `clip.marked`. With a `target` (a voice mark, whose
/// time the transcript already carries) the mark lands on that capture even
/// after its recording slot was retired; otherwise it lands on the active
/// session, and `at_seconds` `None` stamps its elapsed time now. Without a
/// recording output nothing is stored and the event says why. `seconds` is
/// the press's length (plan 199), already one of the clip lengths.
async fn record_mark(
    state: &AppState,
    target: Option<MarkTarget>,
    at_seconds: Option<f64>,
    source: ClipMarkSource,
    phrase: Option<String>,
    seconds: u32,
) -> Result<ClipMarkedEvent, ClipMarkError> {
    let (session_id, at_seconds, records_to_file) = match (target, at_seconds) {
        (Some(target), Some(at_seconds)) => {
            if source == ClipMarkSource::Manual {
                note_manual_target(state, &target, at_seconds.max(0.0));
            }
            (target.session_id, at_seconds, target.records_to_file)
        }
        (_, at_seconds) => {
            let recording = state.recording.lock().await;
            let active = recording.as_ref().ok_or(ClipMarkError::NoActiveSession)?;
            let target = MarkTarget {
                session_id: active.session_id.clone(),
                records_to_file: active.output_path.is_some(),
            };
            let at_seconds = at_seconds
                .unwrap_or_else(|| active.capture_elapsed_seconds())
                .max(0.0);
            if source == ClipMarkSource::Manual {
                // Registration and dedupe advance while the exact active
                // slot is still guarded: its monitor cannot retire an absent
                // owner and then have this manual request recreate it.
                note_manual_target(state, &target, at_seconds);
            }
            (target.session_id, at_seconds, target.records_to_file)
        }
    };
    let at_seconds = at_seconds.max(0.0);
    // Plan 181 (owner redesign R4): one action. Whenever the ring holds
    // frames the press saves the last N seconds as a clip, and while a
    // recording runs the moment is also kept as a mark in it, for the report.
    let clip_save = crate::replay_buffer::request_save(state, Some(source), Some(seconds)).ok();
    let mark_stored = if records_to_file {
        state.database.insert_clip_mark(&ClipMark {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            at_seconds,
            source,
            phrase,
            created_at: Utc::now().to_rfc3339(),
            // Plan 199 D8: the mark remembers its press's length, so the
            // report and Clean cut span the minute for a 1-min press.
            lookback_seconds: Some(seconds),
        })?;
        true
    } else {
        false
    };
    if let Some(accepted) = clip_save {
        // The save reports through replay.saved / replay.saveFailed, so no
        // clip.marked event here: one toast per window, never two.
        tracing::info!(
            "Clip mark on {session_id} saves a clip ({}){}.",
            accepted.save_id,
            if mark_stored {
                " and marks the recording"
            } else {
                ""
            }
        );
        return Ok(ClipMarkedEvent {
            session_id,
            at_seconds,
            source,
            saved: mark_stored,
            reason: Some(CLIP_SAVED_REASON.to_string()),
        });
    }
    let event = if mark_stored {
        ClipMarkedEvent {
            session_id,
            at_seconds,
            source,
            saved: true,
            reason: None,
        }
    } else {
        ClipMarkedEvent {
            session_id,
            at_seconds,
            source,
            saved: false,
            reason: Some("recording-off".to_string()),
        }
    };
    state.emit_event("clip.marked", event.clone());
    Ok(event)
}

/// The `clip.mark` reply when the ring saved the last seconds as a clip
/// (plan 181, redesign R4); `saved` then says whether a recording also kept
/// the mark. Mirrored in `shared/clip-marks.ts`.
pub const CLIP_SAVED_REASON: &str = "clip-saved";

fn note_manual_target(state: &AppState, target: &MarkTarget, at_seconds: f64) {
    if target.records_to_file
        && let Ok(mut detector) = state.clip_marks.lock()
        && detector.register_recording(&target.session_id)
    {
        detector.note_manual_mark(&target.session_id, at_seconds);
    }
}

/// `clip.marks.list`: every mark of a session, earliest first.
pub fn list_marks(state: &AppState, session_id: &str) -> Result<Vec<ClipMark>> {
    state.database.list_clip_marks(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detector_for_recording() -> ClipMarkDetector {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.register_recording("recording"));
        detector
    }

    fn word(word: &str, at_seconds: f64) -> TimedWord {
        TimedWord {
            word: word.to_string(),
            at_seconds,
        }
    }

    fn segment(text: &str, start_second: f64) -> CaptionSegment {
        CaptionSegment {
            text: text.to_string(),
            start_second,
            end_second: start_second + 0.5,
        }
    }

    #[test]
    fn words_normalize_case_and_punctuation() {
        assert_eq!(normalize_word("That's,"), Some("thats".to_string()));
        assert_eq!(normalize_word("CLIP!"), Some("clip".to_string()));
        assert_eq!(normalize_word("…"), None);
    }

    #[test]
    fn phrase_table() {
        let cases: &[(&str, Option<(&str, u32)>)] = &[
            ("okay clip that", Some(("clip that", 30))),
            ("Clip it.", Some(("clip it", 30))),
            ("please clip this one", Some(("clip this", 30))),
            ("That's a clip!", Some(("thats a clip", 30))),
            ("thats a clip", Some(("thats a clip", 30))),
            ("we should make a clip of that", Some(("make a clip", 30))),
            // Plan 199 D7: the minute. Earliest start wins, so "long clip
            // that" is one 1-min match, not a 30-s "clip that".
            ("okay long clip that", Some(("long clip", 60))),
            ("Clip the last minute!", Some(("clip the last minute", 60))),
            ("that was a long clip", Some(("long clip", 60))),
            ("clip the last bit", None),
            ("the last minute was wild", None),
            ("a long clipboard", None),
            ("look at the eclipse that was cool", None),
            ("copy it to the clipboard that helps", None),
            ("I clipped it yesterday", None),
            ("a clip of that", None),
            ("", None),
        ];
        for (text, expected) in cases {
            let found = find_clip_phrase(&[], &timed_words(text, &[], 100.0));
            assert_eq!(
                found
                    .as_ref()
                    .map(|found| (found.phrase.as_str(), found.seconds)),
                *expected,
                "text: {text:?}"
            );
        }
    }

    /// Plan 199: the tail is one word shorter than the longest phrase, and
    /// every phrase saves one of the clip lengths.
    #[test]
    fn the_tail_follows_the_longest_phrase_and_every_length_is_offered() {
        let longest = CLIP_PHRASES
            .iter()
            .map(|(phrase, _)| phrase.len())
            .max()
            .unwrap();
        assert_eq!(longest, 4, "clip the last minute");
        assert_eq!(TAIL_WORDS, longest - 1);
        for (phrase, seconds) in CLIP_PHRASES {
            assert!(
                crate::replay_buffer::CLIP_LENGTHS.contains(seconds),
                "{phrase:?} saves {seconds} s"
            );
        }
    }

    /// Plan 199: the four-word phrase split across two finals still matches
    /// once, at its first word, as the minute.
    #[test]
    fn the_minute_phrase_split_across_finals_matches_once() {
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final(
                    "recording",
                    "okay clip the last",
                    &[segment("okay", 0.2), segment("clip the last", 1.5)],
                    50.0
                )
                .is_none()
        );
        let found = detector
            .note_final("recording", "minute please", &[], 53.0)
            .expect("boundary match");
        assert_eq!(found.phrase, "clip the last minute");
        assert_eq!(found.seconds, 60);
        assert_eq!(found.at_seconds, 51.5);
        assert!(
            detector
                .note_final("recording", "okay", &[], 55.0)
                .is_none()
        );
        // "long" | "clip" across finals is the minute too.
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final("recording", "that was long", &[], 10.0)
                .is_none()
        );
        let found = detector
            .note_final("recording", "clip that", &[], 12.0)
            .expect("boundary match");
        assert_eq!((found.phrase.as_str(), found.seconds), ("long clip", 60));
        // The "clip that" inside the same words is the same press.
        assert!(
            detector
                .note_final("recording", "right", &[], 14.0)
                .is_none()
        );
    }

    /// Plan 199: the 10-s dedupe swallows a second phrase of either length.
    #[test]
    fn the_dedupe_swallows_a_second_phrase_of_either_length() {
        let mut detector = detector_for_recording();
        assert_eq!(
            detector
                .note_final("recording", "clip that", &[], 100.0)
                .map(|found| found.seconds),
            Some(30)
        );
        assert!(
            detector
                .note_final("recording", "long clip", &[], 104.0)
                .is_none()
        );
        assert_eq!(
            detector
                .note_final("recording", "long clip", &[], 120.0)
                .map(|found| found.seconds),
            Some(60)
        );
        assert!(
            detector
                .note_final("recording", "clip it", &[], 125.0)
                .is_none()
        );
    }

    #[test]
    fn mark_time_is_the_first_word_of_the_phrase() {
        let segments = [
            segment("okay so", 0.2),
            segment("clip", 1.4),
            segment("that", 1.9),
        ];
        let words = timed_words("okay so clip that", &segments, 120.0);
        let found = find_clip_phrase(&[], &words).expect("phrase");
        assert_eq!(found.at_seconds, 121.4);

        let without_segments = timed_words("okay so clip that", &[], 120.0);
        let found = find_clip_phrase(&[], &without_segments).expect("phrase");
        assert_eq!(found.at_seconds, 120.0);
    }

    #[test]
    fn a_phrase_split_across_finals_matches_once_at_the_first_word() {
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final(
                    "recording",
                    "and that was great, clip",
                    &[segment("clip", 2.5)],
                    30.0
                )
                .is_none()
        );
        let found = detector
            .note_final("recording", "that for me", &[segment("that", 0.1)], 33.0)
            .expect("boundary match");
        assert_eq!(found.phrase, "clip that");
        assert_eq!(found.at_seconds, 32.5);
        // The tail alone never matches again on the next silent final.
        assert!(
            detector
                .note_final("recording", "okay", &[], 36.0)
                .is_none()
        );
    }

    #[test]
    fn a_stale_tail_does_not_complete_a_phrase() {
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final("recording", "clip", &[], 30.0)
                .is_none()
        );
        // Ten seconds of other finals later, "that" is a new sentence.
        assert!(
            detector
                .note_final("recording", "that", &[], 40.0)
                .is_none()
        );
        // And a tail from a previous session (file time restarted) is dropped.
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final("recording", "clip", &[], 3000.0)
                .is_none()
        );
        assert!(detector.note_final("recording", "that", &[], 1.0).is_none());
    }

    #[test]
    fn repeats_within_ten_seconds_dedupe_against_voice_and_manual_marks() {
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final("recording", "clip that", &[], 100.0)
                .is_some()
        );
        assert!(
            detector
                .note_final("recording", "clip that", &[], 105.0)
                .is_none()
        );
        assert!(
            detector
                .note_final("recording", "clip that", &[], 110.0)
                .is_some()
        );
        detector.note_manual_mark("recording", 200.0);
        assert!(
            detector
                .note_final("recording", "clip it", &[], 209.0)
                .is_none()
        );
        assert!(
            detector
                .note_final("recording", "clip it", &[], 210.5)
                .is_some()
        );
        // A distant out-of-order moment remains distinct within this recording.
        assert!(
            detector
                .note_final("recording", "clip this", &[], 4.0)
                .is_some()
        );
    }

    #[test]
    fn a_previous_recordings_manual_mark_does_not_suppress_a_new_recording() {
        for new_time in [15.0, 10.0, 4.0] {
            let mut detector = ClipMarkDetector::default();
            assert!(detector.register_recording("a"));
            assert!(detector.register_recording("b"));
            detector.note_manual_mark("a", 10.0);
            assert!(
                detector
                    .note_final("b", "clip that", &[], new_time)
                    .is_some(),
                "A10 and B{new_time} are distinct recordings, not a repeated moment"
            );
        }
    }

    #[test]
    fn late_finals_keep_their_own_recordings_tail_and_dedupe_window() {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.register_recording("a"));
        assert!(detector.note_final("a", "clip that", &[], 10.0).is_some());
        detector.retire_recording("a");
        assert!(detector.register_recording("b"));
        assert!(detector.note_final("b", "clip that", &[], 15.0).is_some());
        assert!(detector.note_final("a", "clip that", &[], 15.0).is_none());
        assert!(detector.note_final("b", "clip", &[], 30.0).is_none());
        assert!(detector.note_final("a", "that", &[], 30.0).is_none());
        assert_eq!(
            detector
                .note_final("b", "that", &[], 31.0)
                .unwrap()
                .at_seconds,
            30.0
        );
        detector.note_manual_mark("b", 40.0);
        assert!(detector.note_final("b", "clip that", &[], 38.0).is_none());
        assert!(detector.note_final("b", "clip that", &[], 45.0).is_none());
        assert!(detector.note_final("a", "clip that", &[], 40.0).is_some());
    }

    #[test]
    fn owner_retention_is_bounded_without_evicting_undrained_recordings() {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.register_recording("a"));
        assert!(detector.register_recording("b"));
        assert!(!detector.register_recording("c"));
        assert!(detector.note_final("a", "clip that", &[], 10.0).is_some());
        assert!(detector.note_final("b", "clip that", &[], 10.0).is_some());
        detector.retire_recording("a");
        assert!(detector.register_recording("c"));
        assert!(detector.note_final("a", "clip that", &[], 30.0).is_none());
        assert!(
            detector
                .note_final("unknown", "clip that", &[], 30.0)
                .is_none()
        );
        assert_eq!(detector.recordings.len(), MAX_RETAINED_RECORDINGS);
        for index in 0..100 {
            detector.retire_recording("c");
            let owner = format!("next-{index}");
            assert!(detector.register_recording(&owner));
            detector.retire_recording(&owner);
            assert!(detector.recordings.len() <= MAX_RETAINED_RECORDINGS);
        }
        // Retiring an old owner cannot retire or prune the still-active B.
        detector.retire_recording("a");
        assert!(detector.note_final("b", "clip that", &[], 40.0).is_some());
    }

    #[test]
    fn sign_out_erases_words_from_every_retained_recording() {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.register_recording("a"));
        assert!(detector.register_recording("b"));
        assert!(detector.note_final("a", "clip", &[], 10.0).is_none());
        assert!(detector.note_final("b", "make a", &[], 20.0).is_none());
        detector.retire_recording("a");
        detector.forget_words();
        assert!(detector.note_final("a", "that", &[], 11.0).is_none());
        assert!(detector.note_final("b", "clip", &[], 21.0).is_none());
    }

    #[test]
    fn deferred_retirement_keeps_failed_join_evidence_owned_and_bounded() {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.register_recording("unjoined-a"));
        assert!(detector.register_recording("manual-b"));
        detector.note_provider_join_failed("unjoined-a");
        detector.defer_retirement("unjoined-a");
        detector.defer_retirement("manual-b");
        detector.retire_deferred_recordings();
        assert!(!detector.retire_recording("unjoined-a"));
        assert!(
            detector
                .note_final("unjoined-a", "clip that", &[], 10.0)
                .is_none()
        );
        assert!(detector.register_recording("new-c"));
        assert!(!detector.register_recording("new-d"));
        detector.retire_recording("new-c");
        assert!(detector.register_recording("new-d"));
        assert_eq!(detector.recordings.len(), MAX_RETAINED_RECORDINGS);
        assert!(
            detector
                .recordings
                .iter()
                .any(|owner| owner.session_id == "unjoined-a"
                    && !owner.drained
                    && owner.provider_join_unproven)
        );
    }

    #[tokio::test]
    async fn manual_capture_owner_is_registered_before_its_slot_can_retire() {
        let _caption_test_guard = crate::captions::caption_lifecycle_test_lock().lock().await;
        let state = mark_test_state();
        persist_session(&state, "manual-a");
        persist_session(&state, "voice-b");
        let mut active = crate::recording::test_active_recording_stub("manual-a");
        active.output_path = Some(std::path::PathBuf::from("/tmp/manual-a.mp4"));
        *state.recording.lock().await = Some(active);
        let manual = mark_manual(&state, None).await.unwrap();
        assert!(manual.saved);
        assert_eq!(manual.session_id, "manual-a");
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("manual-a", "clip that", &[], manual.at_seconds + 5.0)
                .is_none()
        );
        // The real monitor removes the slot before this no-caption finish.
        state.recording.lock().await.take();
        crate::captions::finish_captions_for_capture(&state, "manual-a").await;
        assert!(
            !state
                .clip_marks
                .lock()
                .unwrap()
                .register_recording("manual-a")
        );
        let target_b = MarkTarget {
            session_id: "voice-b".into(),
            records_to_file: true,
        };
        register_caption_target(&state, Some(&target_b));
        let mut events = state.events.subscribe();
        note_transcript_final(&state, "clip that", &[], 15.0, Some(target_b));
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event, "clip.marked");
        assert_eq!(event.payload["sessionId"], "voice-b");
        assert_eq!(list_marks(&state, "manual-a").unwrap().len(), 1);
        assert_eq!(list_marks(&state, "voice-b").unwrap().len(), 1);
        // Explicit no-capture never borrows an active B recording.
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("voice-b"));
        note_transcript_final(&state, "clip that", &[], 40.0, None);
        assert!(events.try_recv().is_err());
        assert_eq!(list_marks(&state, "voice-b").unwrap().len(), 1);
    }

    /// Plan 181 (redesign R4): the ring on, nothing recording: the mark
    /// saves a clip. The ring here has no segments yet, so the save reports
    /// `empty`; the routing, the reply and the missing clip.marked are what
    /// this proves.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mark_with_recording_off_saves_a_clip_when_the_ring_is_on() {
        let _caption_test_guard = crate::captions::caption_lifecycle_test_lock().lock().await;
        let state = mark_test_state();
        let recordings =
            std::env::temp_dir().join(format!("videorc-clip-mark-replay-{}", uuid::Uuid::new_v4()));
        attach_test_ring(&state, "ring-only", true, &recordings);
        let mut active = crate::recording::test_active_recording_stub("ring-only");
        active.output_path = None;
        active.replay_only = true;
        *state.recording.lock().await = Some(active);
        let mut events = state.events.subscribe();
        let reply = mark_manual(&state, None).await.unwrap();
        assert!(!reply.saved);
        assert_eq!(reply.reason.as_deref(), Some(CLIP_SAVED_REASON));
        assert_eq!(reply.session_id, "ring-only");
        // No clip.marked for this press; the save answers by its own event.
        let outcome = wait_for_save_outcome(&mut events).await;
        assert_eq!(outcome.event, "replay.saveFailed");
        assert_eq!(outcome.payload["reason"], "empty");
        assert_eq!(list_marks(&state, "ring-only").unwrap().len(), 0);
        state.recording.lock().await.take();
        crate::replay_buffer::retire(
            &state,
            "ring-only",
            crate::replay_buffer::RetireOutcome::Stopped,
        );
        let _ = std::fs::remove_dir_all(&recordings);
    }

    /// Plan 181 (redesign R4): the ring riding a recording: one press saves
    /// the clip AND keeps the mark in the recording, with one reply and no
    /// clip.marked (the save's own event is the toast).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mark_while_recording_with_the_ring_on_saves_a_clip_and_keeps_the_mark() {
        let _caption_test_guard = crate::captions::caption_lifecycle_test_lock().lock().await;
        let state = mark_test_state();
        let recordings =
            std::env::temp_dir().join(format!("videorc-clip-mark-both-{}", uuid::Uuid::new_v4()));
        persist_session(&state, "ring-rec");
        attach_test_ring(&state, "ring-rec", false, &recordings);
        let mut active = crate::recording::test_active_recording_stub("ring-rec");
        active.output_path = Some(recordings.join("ring-rec.mkv"));
        *state.recording.lock().await = Some(active);
        let mut events = state.events.subscribe();
        let reply = mark_manual(&state, None).await.unwrap();
        assert!(reply.saved, "the recording keeps the mark");
        assert_eq!(reply.reason.as_deref(), Some(CLIP_SAVED_REASON));
        let outcome = wait_for_save_outcome(&mut events).await;
        assert_eq!(outcome.event, "replay.saveFailed");
        let marks = list_marks(&state, "ring-rec").unwrap();
        assert_eq!(marks.len(), 1);
        // No length is today's 30 s, and the mark says so (plan 199).
        assert_eq!(marks[0].lookback_seconds, Some(30));
        state.recording.lock().await.take();
        crate::replay_buffer::retire(
            &state,
            "ring-rec",
            crate::replay_buffer::RetireOutcome::Stopped,
        );
        let _ = std::fs::remove_dir_all(&recordings);
    }

    fn attach_test_ring(
        state: &AppState,
        session_id: &str,
        replay_only: bool,
        recordings: &std::path::Path,
    ) {
        let params = crate::replay_buffer::replay_only_test_params();
        let guard = crate::replay_buffer::prepare(
            state,
            crate::replay_buffer::RingRequest {
                session_id,
                params: &params,
                replay_only,
                recordings_dir: recordings,
                ffmpeg_path: "ffmpeg",
            },
        )
        .unwrap();
        crate::replay_buffer::attach(state, guard);
    }

    /// The save's own event, asserting no clip.marked slipped out before it.
    async fn wait_for_save_outcome(
        events: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> crate::protocol::ServerEvent {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let event = events.recv().await.unwrap();
                assert_ne!(event.event, "clip.marked");
                if event.event == "replay.saveFailed" || event.event == "replay.saved" {
                    return event;
                }
            }
        })
        .await
        .unwrap()
    }

    #[test]
    fn tail_words_keep_their_times() {
        assert_eq!(
            find_clip_phrase(&[word("make", 9.0), word("a", 9.3)], &[word("clip", 12.0)]),
            Some(PhraseMatch {
                phrase: "make a clip".to_string(),
                at_seconds: 9.0,
                seconds: 30,
            })
        );
        // A phrase entirely inside the tail was already reported.
        assert!(
            find_clip_phrase(&[word("clip", 1.0), word("that", 1.5)], &[word("ok", 2.0)]).is_none()
        );
    }

    fn mark_test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            0,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    fn persist_session(state: &AppState, session_id: &str) {
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: session_id.to_string(),
                title: "Clip mark test".to_string(),
                started_at: "2026-09-27T10:00:00Z".to_string(),
                mode: "record+stream".to_string(),
                output_path: Some("/tmp/clip-mark-test.mp4".to_string()),
                container: Some("mp4".to_string()),
                stream_preset: None,
                sources: serde_json::from_str("{}").unwrap(),
                layout: crate::protocol::default_layout_settings(),
                output: serde_json::from_value(serde_json::json!({
                    "recordEnabled": true,
                    "streamEnabled": true,
                    "video": {
                        "preset": "tutorial-1080p30",
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "bitrateKbps": 6000
                    },
                    "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
                }))
                .unwrap(),
            })
            .unwrap();
    }

    /// The last "clip that" of a stream is transcribed by the capture-end
    /// drain, after the recording slot is gone: it still lands on its session.
    #[tokio::test]
    async fn a_voice_mark_heard_during_the_capture_end_drain_lands_on_its_session() {
        let state = mark_test_state();
        persist_session(&state, "stream-a");
        let mut events = state.events.subscribe();
        assert!(state.recording.lock().await.is_none());
        let event = record_mark(
            &state,
            Some(MarkTarget {
                session_id: "stream-a".to_string(),
                records_to_file: true,
            }),
            Some(1_804.5),
            ClipMarkSource::Voice,
            Some("clip that".to_string()),
            30,
        )
        .await
        .expect("a carried target needs no recording slot");
        assert!(event.saved);
        assert_eq!(event.session_id, "stream-a");
        let marks = list_marks(&state, "stream-a").unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].at_seconds, 1_804.5);
        assert_eq!(marks[0].phrase.as_deref(), Some("clip that"));
        assert_eq!(marks[0].lookback_seconds, Some(30));
        assert_eq!(events.try_recv().unwrap().event, "clip.marked");

        // Plan 199 D8: a 1-min phrase keeps a mark that remembers the minute.
        record_mark(
            &state,
            Some(MarkTarget {
                session_id: "stream-a".to_string(),
                records_to_file: true,
            }),
            Some(1_900.0),
            ClipMarkSource::Voice,
            Some("long clip".to_string()),
            60,
        )
        .await
        .unwrap();
        let marks = list_marks(&state, "stream-a").unwrap();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[1].phrase.as_deref(), Some("long clip"));
        assert_eq!(marks[1].lookback_seconds, Some(60));
        assert_eq!(events.try_recv().unwrap().event, "clip.marked");

        // A stream-only capture still keeps nothing, and says why.
        let event = record_mark(
            &state,
            Some(MarkTarget {
                session_id: "stream-b".to_string(),
                records_to_file: false,
            }),
            Some(12.0),
            ClipMarkSource::Voice,
            Some("clip it".to_string()),
            30,
        )
        .await
        .unwrap();
        assert!(!event.saved);
        assert_eq!(event.reason.as_deref(), Some("recording-off"));
        assert!(list_marks(&state, "stream-b").unwrap().is_empty());

        // Without a target (a manual mark) the active slot is still required.
        assert!(matches!(
            record_mark(&state, None, None, ClipMarkSource::Manual, None, 30).await,
            Err(ClipMarkError::NoActiveSession)
        ));
        // Plan 199: a length nobody offers is refused before anything else,
        // even with no session to mark.
        let refused = mark_manual(&state, Some(45)).await.unwrap_err();
        assert!(matches!(refused, ClipMarkError::InvalidLength));
        assert_eq!(refused.code(), "invalid-clip-length");
        assert_eq!(refused.to_string(), "A clip is 30 seconds or 1 minute.");
        assert!(matches!(
            mark_manual(&state, Some(60)).await,
            Err(ClipMarkError::NoActiveSession)
        ));
    }

    #[test]
    fn forgetting_words_drops_a_half_said_phrase() {
        let mut detector = detector_for_recording();
        assert!(
            detector
                .note_final("recording", "okay clip", &[], 10.0)
                .is_none()
        );
        detector.forget_words();
        assert!(
            detector
                .note_final("recording", "that", &[], 11.0)
                .is_none()
        );
    }
}
