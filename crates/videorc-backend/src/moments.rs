//! Moments of a session (plan 119 S1).
//!
//! A moment is a clip mark the streamer placed by saying "clip that" or
//! pressing Mark clip (plan 068 D6), or one of the top chat-activity peaks,
//! each snapped to the live-captions `.srt` cues with an excerpt. Everything
//! is ranked LOCALLY from data the app already has, computed when a report is
//! read and never stored: the Orcle report shows them, and Clean cut review
//! pins them.

use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::DateTime;

use crate::protocol::{ClipMark, ClipMarkSource, ClipMoment, ClipMomentSource};
use crate::state::AppState;
use crate::transcript::{CaptionCue, parse_srt};

const CHAT_BUCKET_MS: u64 = 30_000;
const CLIP_LEAD_IN_MS: u64 = 10_000;
const CLIP_DEFAULT_LENGTH_MS: u64 = 45_000;
pub(crate) const CLIP_MIN_LENGTH_MS: u64 = 5_000;
const CLIP_MAX_LENGTH_MS: u64 = 90_000;
/// At most this many chat peaks per session.
const MAX_CHAT_PEAKS: usize = 3;
/// A mark points at the moment that just happened: the clip is what led up
/// to it (plan 068 D6).
const CLIP_MARK_LOOKBACK_MS: u64 = 30_000;
/// Chat rows read for the peak ranking (newest first in storage).
const CHAT_ROWS_FOR_PEAKS: usize = 5_000;

/// The moments of one session and the chat the peak ranking read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionMoments {
    /// Marks first (file order), then the chat peaks that overlap none.
    pub moments: Vec<ClipMoment>,
    /// Chat rows that fell inside the session's time span.
    pub chat_message_count: u64,
}

/// The moments of one session, or `None` when its row is gone. Reads the
/// session row, its chat, its clip marks and the `.srt` next to its media.
pub async fn session_moments(state: &AppState, session_id: &str) -> Result<Option<SessionMoments>> {
    let Some(timing) = state.database.session_timing(session_id)? else {
        return Ok(None);
    };
    let session_started_ms = DateTime::parse_from_rfc3339(&timing.started_at)
        .context("Session start time is not a valid timestamp")?
        .timestamp_millis();
    let duration_ms = timing
        .duration_ms
        .and_then(|value| u64::try_from(value).ok());

    let messages = state
        .database
        .list_live_chat_messages_recent(session_id, CHAT_ROWS_FOR_PEAKS)?;
    let message_offsets_ms = chat_message_offsets_ms(
        messages.iter().map(|message| message.received_at.as_str()),
        session_started_ms,
        duration_ms,
    );

    let cues = captions_cues_for_session(state, session_id).await;
    let marks = state.database.list_clip_marks(session_id)?;
    let moments = merge_moments(
        mark_moments(&marks, &cues, duration_ms),
        rank_chat_spike_moments(&message_offsets_ms, &cues, duration_ms),
    );
    Ok(Some(SessionMoments {
        moments,
        chat_message_count: message_offsets_ms.len() as u64,
    }))
}

/// Chat receive times as offsets into the session, dropping rows before the
/// start and rows more than a minute past the recording's end. Pure.
pub fn chat_message_offsets_ms<'a>(
    received_at: impl IntoIterator<Item = &'a str>,
    session_started_ms: i64,
    duration_ms: Option<u64>,
) -> Vec<u64> {
    received_at
        .into_iter()
        .filter_map(|received| DateTime::parse_from_rfc3339(received).ok())
        .filter_map(|received| u64::try_from(received.timestamp_millis() - session_started_ms).ok())
        .filter(|offset| duration_ms.is_none_or(|duration| *offset <= duration + 60_000))
        .collect()
}

/// The cues of the first `.srt` next to one of the session's media files that
/// parses to something; empty when there is none.
pub async fn captions_cues_for_session(state: &AppState, session_id: &str) -> Vec<CaptionCue> {
    let Ok(candidates) = state.database.session_media_candidates(session_id) else {
        return Vec::new();
    };
    for candidate in candidates {
        let srt_path = PathBuf::from(&candidate).with_extension("srt");
        if let Ok(content) = tokio::fs::read_to_string(&srt_path).await {
            let cues = parse_srt(&content);
            if !cues.is_empty() {
                return cues;
            }
        }
    }
    Vec::new()
}

/// Clip marks become moments first: `[mark - 30 s, mark]`, snapped to cues,
/// labelled by who placed them. Pure.
pub fn mark_moments(
    marks: &[ClipMark],
    cues: &[CaptionCue],
    duration_ms: Option<u64>,
) -> Vec<ClipMoment> {
    let mut moments: Vec<ClipMoment> = marks
        .iter()
        .filter_map(|mark| {
            let at_ms = (mark.at_seconds.max(0.0) * 1000.0).round() as u64;
            let mut start_ms = at_ms.saturating_sub(CLIP_MARK_LOOKBACK_MS);
            let mut end_ms = at_ms.max(start_ms + CLIP_MIN_LENGTH_MS);
            if let Some(duration) = duration_ms {
                end_ms = end_ms.min(duration);
                start_ms = start_ms.min(end_ms.saturating_sub(CLIP_MIN_LENGTH_MS));
            }
            let (start_ms, end_ms) = snap_to_cues(start_ms, end_ms, cues);
            if end_ms < start_ms + CLIP_MIN_LENGTH_MS {
                return None;
            }
            let (reason, source) = match mark.source {
                ClipMarkSource::Voice => (
                    format!(
                        "You said '{}'",
                        mark.phrase.as_deref().unwrap_or("clip that")
                    ),
                    ClipMomentSource::Voice,
                ),
                ClipMarkSource::Manual => ("Marked".to_string(), ClipMomentSource::Manual),
            };
            Some(ClipMoment {
                start_ms,
                end_ms,
                reason,
                excerpt: cue_excerpt(cues, start_ms, end_ms),
                source: Some(source),
            })
        })
        .collect();
    moments.sort_by_key(|moment| moment.start_ms);
    moments
}

/// Marks first, in file order; then the chat spikes that do not overlap one.
pub fn merge_moments(marks: Vec<ClipMoment>, chat: Vec<ClipMoment>) -> Vec<ClipMoment> {
    let mut moments = marks;
    for moment in chat {
        let overlaps = moments
            .iter()
            .any(|existing| existing.start_ms < moment.end_ms && moment.start_ms < existing.end_ms);
        if !overlaps {
            moments.push(moment);
        }
    }
    moments
}

/// Snap to caption cue boundaries so a clip never opens or cuts mid-sentence,
/// then cap the length.
pub(crate) fn snap_to_cues(mut start_ms: u64, mut end_ms: u64, cues: &[CaptionCue]) -> (u64, u64) {
    if let Some(cue) = cues
        .iter()
        .find(|cue| cue.start_ms <= start_ms && start_ms < cue.end_ms)
    {
        start_ms = cue.start_ms;
    }
    if let Some(cue) = cues
        .iter()
        .find(|cue| cue.start_ms <= end_ms && end_ms < cue.end_ms)
    {
        end_ms = cue.end_ms;
    }
    (start_ms, end_ms.min(start_ms + CLIP_MAX_LENGTH_MS))
}

/// The cue text inside `[start_ms, end_ms)`, at most 200 chars.
pub(crate) fn cue_excerpt(cues: &[CaptionCue], start_ms: u64, end_ms: u64) -> String {
    cues.iter()
        .filter(|cue| cue.end_ms > start_ms && cue.start_ms < end_ms)
        .map(|cue| cue.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// Rank chat-activity spikes into clip moments. Pure so the whole ranking is
/// unit-testable: bucket message offsets, find buckets that stand out from
/// the session's own baseline, merge adjacent spikes, snap to caption cues.
pub fn rank_chat_spike_moments(
    message_offsets_ms: &[u64],
    cues: &[CaptionCue],
    duration_ms: Option<u64>,
) -> Vec<ClipMoment> {
    if message_offsets_ms.is_empty() {
        return Vec::new();
    }
    let max_offset = message_offsets_ms.iter().copied().max().unwrap_or(0);
    let bucket_count = (max_offset / CHAT_BUCKET_MS + 1) as usize;
    let mut buckets = vec![0u32; bucket_count];
    for offset in message_offsets_ms {
        buckets[(offset / CHAT_BUCKET_MS) as usize] += 1;
    }

    let total: u32 = buckets.iter().sum();
    let mean = f64::from(total) / buckets.len() as f64;
    let variance = buckets
        .iter()
        .map(|count| (f64::from(*count) - mean).powi(2))
        .sum::<f64>()
        / buckets.len() as f64;
    let std_dev = variance.sqrt();
    // A spike must stand out from the session's own baseline AND be absolutely
    // busy enough to mean something (3+ messages in 30s).
    let threshold = (mean + 1.5 * std_dev).max(3.0);

    let mut spikes: Vec<(usize, u32)> = buckets
        .iter()
        .enumerate()
        .filter(|(_, count)| f64::from(**count) >= threshold)
        .map(|(index, count)| (index, *count))
        .collect();
    spikes.sort_by_key(|(_, count)| std::cmp::Reverse(*count));

    let mut chosen: Vec<(usize, u32)> = Vec::new();
    for (index, count) in spikes {
        if chosen.len() >= MAX_CHAT_PEAKS {
            break;
        }
        // Adjacent buckets are the same moment — keep the strongest.
        if chosen
            .iter()
            .any(|(existing, _)| existing.abs_diff(index) <= 1)
        {
            continue;
        }
        chosen.push((index, count));
    }
    chosen.sort_by_key(|(index, _)| *index);

    chosen
        .into_iter()
        .map(|(index, count)| {
            let bucket_start = index as u64 * CHAT_BUCKET_MS;
            let mut start_ms = bucket_start.saturating_sub(CLIP_LEAD_IN_MS);
            let mut end_ms = start_ms + CLIP_DEFAULT_LENGTH_MS;
            if let Some(duration) = duration_ms {
                end_ms = end_ms.min(duration);
                start_ms = start_ms.min(end_ms.saturating_sub(CLIP_MIN_LENGTH_MS));
            }
            let (start_ms, end_ms) = snap_to_cues(start_ms, end_ms, cues);
            ClipMoment {
                start_ms,
                end_ms,
                reason: format!("Chat spiked: {count} messages in 30s"),
                excerpt: cue_excerpt(cues, start_ms, end_ms),
                source: Some(ClipMomentSource::Chat),
            }
        })
        .filter(|moment| moment.end_ms > moment.start_ms + CLIP_MIN_LENGTH_MS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(start_ms: u64, end_ms: u64, text: &str) -> CaptionCue {
        CaptionCue {
            start_ms,
            end_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn quiet_sessions_produce_no_suggestions() {
        // Uniform low chatter never crosses the absolute 3-messages floor.
        let offsets: Vec<u64> = (0..10).map(|index| index * 60_000).collect();
        assert!(rank_chat_spike_moments(&offsets, &[], Some(600_000)).is_empty());
        assert!(rank_chat_spike_moments(&[], &[], None).is_empty());
    }

    #[test]
    fn a_chat_spike_becomes_one_cue_snapped_moment() {
        // Baseline: one message a minute. Spike: 8 messages around 5:10.
        let mut offsets: Vec<u64> = (0..10).map(|index| index * 60_000).collect();
        offsets.extend((0..8).map(|index| 310_000 + index * 1_000));
        let cues = [
            cue(280_000, 292_000, "so I tried the risky refactor"),
            cue(292_000, 305_000, "and it actually works first try"),
            cue(305_000, 330_000, "chat is going wild right now"),
        ];

        let moments = rank_chat_spike_moments(&offsets, &cues, Some(900_000));

        assert_eq!(moments.len(), 1);
        let moment = &moments[0];
        // The 10s lead-in (290s) lands inside the first cue → the clip opens
        // at that cue's start so it never begins mid-sentence.
        assert_eq!(moment.start_ms, 280_000);
        assert!(moment.end_ms > moment.start_ms + CLIP_MIN_LENGTH_MS);
        // 8 spike messages + the baseline message sharing the bucket.
        assert!(moment.reason.contains("9 messages"));
        assert!(moment.excerpt.contains("actually works"));
    }

    #[test]
    fn adjacent_spike_buckets_merge_into_the_strongest_moment() {
        let mut offsets = Vec::new();
        // Two adjacent hot buckets at 10:00-10:30 (6 msgs) and 10:30-11:00 (9 msgs).
        offsets.extend((0..6).map(|index| 600_000 + index * 4_000));
        offsets.extend((0..9).map(|index| 630_000 + index * 3_000));
        // Baseline noise so the mean is low.
        offsets.extend((0..20).map(|index| index * 45_000));

        let moments = rank_chat_spike_moments(&offsets, &[], Some(1_500_000));

        assert_eq!(moments.len(), 1);
        // 9 spike messages + the baseline message sharing the stronger bucket.
        assert!(moments[0].reason.contains("10 messages"));
    }

    #[test]
    fn at_most_three_chat_peaks_are_kept_strongest_first_then_in_file_order() {
        let mut offsets: Vec<u64> = (0..40).map(|index| index * 60_000).collect();
        // Four separate spikes of growing strength at 5, 15, 25 and 35 minutes.
        for (minute, count) in [(5u64, 6u64), (15, 7), (25, 8), (35, 9)] {
            offsets.extend((0..count).map(|index| minute * 60_000 + index * 1_000));
        }

        let moments = rank_chat_spike_moments(&offsets, &[], Some(2_700_000));

        assert_eq!(moments.len(), MAX_CHAT_PEAKS);
        // The weakest spike (5:00) is the one dropped; the rest stay in order.
        assert!(moments.iter().all(|moment| moment.start_ms >= 14 * 60_000));
        assert!(
            moments
                .windows(2)
                .all(|pair| pair[0].start_ms < pair[1].start_ms)
        );
    }

    fn mark(at_seconds: f64, source: ClipMarkSource, phrase: Option<&str>) -> ClipMark {
        ClipMark {
            id: format!("mark-{at_seconds}"),
            session_id: "s-1".to_string(),
            at_seconds,
            source,
            phrase: phrase.map(str::to_string),
            created_at: "2026-09-27T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn marks_become_the_thirty_seconds_before_them_snapped_to_cues_and_labelled() {
        let cues = [
            cue(280_000, 292_000, "so I tried the risky refactor"),
            cue(292_000, 305_000, "and it actually works first try"),
            cue(305_000, 312_000, "clip that"),
        ];
        let marks = [
            mark(754.2, ClipMarkSource::Manual, None),
            mark(305.4, ClipMarkSource::Voice, Some("clip that")),
        ];

        let moments = mark_moments(&marks, &cues, Some(900_000));

        assert_eq!(moments.len(), 2);
        // The lookback (275.4 s) lands in no cue and stays; the mark itself
        // is inside the "clip that" cue, so the clip runs to its end.
        assert_eq!(moments[0].start_ms, 275_400);
        assert_eq!(moments[0].end_ms, 312_000);
        assert_eq!(moments[0].reason, "You said 'clip that'");
        assert_eq!(moments[0].source, Some(ClipMomentSource::Voice));
        assert!(moments[0].excerpt.contains("actually works"));
        assert_eq!(moments[1].start_ms, 724_200);
        assert_eq!(moments[1].end_ms, 754_200);
        assert_eq!(moments[1].reason, "Marked");
        assert_eq!(moments[1].source, Some(ClipMomentSource::Manual));

        // A mark right after the start still yields a clip, bounded by the
        // recording; one that cannot reach the minimum length is dropped.
        let early = mark_moments(
            &[mark(2.0, ClipMarkSource::Manual, None)],
            &[],
            Some(900_000),
        );
        assert_eq!((early[0].start_ms, early[0].end_ms), (0, 5_000));
        assert!(
            mark_moments(&[mark(2.0, ClipMarkSource::Manual, None)], &[], Some(3_000)).is_empty()
        );
    }

    #[test]
    fn marks_come_first_and_overlapping_chat_spikes_are_dropped() {
        // Baseline: one message a minute. Spike: 8 messages around 5:10.
        let mut offsets: Vec<u64> = (0..10).map(|index| index * 60_000).collect();
        offsets.extend((0..8).map(|index| 310_000 + index * 1_000));
        let chat = rank_chat_spike_moments(&offsets, &[], Some(900_000));
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].source, Some(ClipMomentSource::Chat));

        // A voice mark at 5:20 covers the same moment as the spike.
        let marks = mark_moments(
            &[mark(320.0, ClipMarkSource::Voice, Some("clip it"))],
            &[],
            Some(900_000),
        );
        let merged = merge_moments(marks.clone(), chat.clone());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].reason, "You said 'clip it'");

        // A mark elsewhere keeps the spike after it.
        let marks = mark_moments(
            &[mark(700.0, ClipMarkSource::Manual, None)],
            &[],
            Some(900_000),
        );
        let merged = merge_moments(marks, chat);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].reason, "Marked");
        assert!(merged[1].reason.starts_with("Chat spiked"));
        // Marks first even though the spike is earlier in the file.
        assert!(merged[0].start_ms > merged[1].start_ms);
    }

    #[test]
    fn chat_offsets_drop_rows_before_the_start_and_long_after_the_end() {
        let started_ms = DateTime::parse_from_rfc3339("2026-10-04T10:00:00Z")
            .unwrap()
            .timestamp_millis();
        let offsets = chat_message_offsets_ms(
            [
                "2026-10-04T09:59:59Z",
                "2026-10-04T10:00:05Z",
                "2026-10-04T10:10:59Z",
                "2026-10-04T10:11:01Z",
                "not a time",
            ],
            started_ms,
            Some(600_000),
        );
        // Before the start: dropped. 10:59 past a 10:00 recording: within the
        // minute of grace. 11:01: out. Garbage: ignored.
        assert_eq!(offsets, vec![5_000, 659_000]);
        assert_eq!(
            chat_message_offsets_ms(["2026-10-04T11:00:00Z"], started_ms, None),
            vec![3_600_000]
        );
    }
}
