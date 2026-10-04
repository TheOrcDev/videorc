//! The re-timed `.srt` beside a Clean cut output (plan 119 S13): the
//! source's live-caption cues mapped through the kept ranges, or cues built
//! from the stitched words when the source has no `.srt`.

use std::path::{Path, PathBuf};

use super::edl::frame_to_ms;
use super::render::KeptRange;
use super::rules::{SENTENCE_PAUSE_MS, SRT_CUE_MAX_CHARS, SRT_CUE_MAX_MS};
use super::transcribe::{TRANSCRIPT_VERSION, TranscriptFile, TranscriptWord, read_json};
use crate::atomic_file::replace_file;
use crate::protocol::CleanCutFrameRate;
use crate::transcript::{CaptionCue, KeptSpanMs, format_srt, parse_srt, retime_cues};

/// The kept ranges as millisecond spans, one rounding per boundary.
pub fn kept_spans_ms(ranges: &[KeptRange], frame_rate: CleanCutFrameRate) -> Vec<KeptSpanMs> {
    ranges
        .iter()
        .map(|range| {
            (
                frame_to_ms(range.start_frame, frame_rate),
                frame_to_ms(range.end_frame, frame_rate),
            )
        })
        .filter(|(start_ms, end_ms)| end_ms > start_ms)
        .collect()
}

fn is_kept(word: &TranscriptWord, kept: &[KeptSpanMs]) -> bool {
    let midpoint = word.start_ms + (word.end_ms.saturating_sub(word.start_ms)) / 2;
    kept.iter()
        .any(|(start_ms, end_ms)| midpoint >= *start_ms && midpoint < *end_ms)
}

/// Cues from the words that survive the cut, in source time: at most
/// `SRT_CUE_MAX_MS` long and `SRT_CUE_MAX_CHARS` wide, split at pauses of
/// `SENTENCE_PAUSE_MS` or more. Removed words (fillers, retakes) never reach
/// a cue, so the captions match what is heard. Pure.
pub fn cues_from_words(words: &[TranscriptWord], kept: &[KeptSpanMs]) -> Vec<CaptionCue> {
    let mut cues = Vec::new();
    let mut current: Vec<&TranscriptWord> = Vec::new();
    let mut chars = 0_usize;
    let flush = |current: &mut Vec<&TranscriptWord>, cues: &mut Vec<CaptionCue>| {
        if let Some(first) = current.first() {
            let end_ms = current
                .iter()
                .map(|word| word.end_ms)
                .max()
                .unwrap_or(first.start_ms)
                .max(first.start_ms + 1);
            cues.push(CaptionCue {
                start_ms: first.start_ms,
                end_ms,
                text: current
                    .iter()
                    .map(|word| word.text.trim())
                    .collect::<Vec<_>>()
                    .join(" "),
            });
        }
        current.clear();
    };
    for word in words.iter().filter(|word| is_kept(word, kept)) {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }
        let word_chars = text.chars().count();
        let too_long = current
            .first()
            .is_some_and(|first| word.end_ms.saturating_sub(first.start_ms) > SRT_CUE_MAX_MS);
        let too_wide = !current.is_empty() && chars + 1 + word_chars > SRT_CUE_MAX_CHARS;
        let pause = current
            .last()
            .is_some_and(|last| word.start_ms.saturating_sub(last.end_ms) >= SENTENCE_PAUSE_MS);
        if too_long || too_wide || pause {
            flush(&mut current, &mut cues);
            chars = 0;
        }
        chars += if current.is_empty() {
            word_chars
        } else {
            1 + word_chars
        };
        current.push(word);
    }
    flush(&mut current, &mut cues);
    cues
}

/// The cues to write beside the output, already on the output timeline:
/// the source `.srt` when it has cues, else the stitched words.
pub fn output_cues(
    source_srt: Option<&str>,
    transcript: Option<&TranscriptFile>,
    kept: &[KeptSpanMs],
) -> Vec<CaptionCue> {
    let from_srt = source_srt.map(parse_srt).unwrap_or_default();
    if !from_srt.is_empty() {
        return retime_cues(&from_srt, kept);
    }
    let from_words = transcript
        .map(|transcript| cues_from_words(&transcript.words, kept))
        .unwrap_or_default();
    retime_cues(&from_words, kept)
}

/// Write `<output stem>.srt` next to `output_mp4`. `Ok(None)` when there is
/// nothing to write (no source cues and no transcript).
pub fn write_retimed_srt(
    source_mp4: &Path,
    output_mp4: &Path,
    transcript_path: Option<&str>,
    ranges: &[KeptRange],
    frame_rate: CleanCutFrameRate,
) -> std::io::Result<Option<PathBuf>> {
    let kept = kept_spans_ms(ranges, frame_rate);
    let source_srt = std::fs::read_to_string(source_mp4.with_extension("srt")).ok();
    let transcript = transcript_path
        .map(Path::new)
        .and_then(read_json::<TranscriptFile>)
        .filter(|transcript| transcript.version == TRANSCRIPT_VERSION);
    let cues = output_cues(source_srt.as_deref(), transcript.as_ref(), &kept);
    if cues.is_empty() {
        return Ok(None);
    }
    let destination = output_mp4.with_extension("srt");
    let staging = output_mp4.with_extension("srt.part");
    std::fs::write(&staging, format_srt(&cues))?;
    replace_file(&staging, &destination)?;
    Ok(Some(destination))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start_ms: u64, end_ms: u64) -> TranscriptWord {
        TranscriptWord {
            text: text.to_string(),
            start_ms,
            end_ms,
            confidence: None,
            filler: false,
        }
    }

    #[test]
    fn kept_spans_round_each_frame_boundary_once() {
        let ranges = [
            KeptRange {
                start_frame: 30,
                end_frame: 300,
            },
            KeptRange {
                start_frame: 400,
                end_frame: 400,
            },
            KeptRange {
                start_frame: 1_000,
                end_frame: 1_001,
            },
        ];
        let ntsc = CleanCutFrameRate {
            num: 30_000,
            den: 1_001,
        };
        assert_eq!(
            kept_spans_ms(&ranges, ntsc),
            vec![(1_001, 10_010), (33_367, 33_400)],
            "empty spans vanish, boundaries are the EDL's own millisecond values"
        );
    }

    #[test]
    fn cues_from_words_skip_removed_words_and_respect_the_caps() {
        let words = vec![
            word("So", 0, 200),
            word("um", 250, 500),
            word("today", 600, 900),
            word("we", 950, 1_100),
            word("ship.", 1_150, 1_500),
            // 800 ms pause: a new cue.
            word("Then", 2_300, 2_500),
            word("a", 2_550, 2_600),
            word("quite", 2_650, 2_900),
            word("remarkably", 2_950, 3_400),
            word("long", 3_450, 3_600),
            word("sentence", 3_650, 4_000),
            word("here", 4_050, 4_300),
            word("end", 9_000, 9_300),
        ];
        // The filler at 250..500 is removed.
        let kept = [(0, 250), (500, 20_000)];
        let cues = cues_from_words(&words, &kept);
        assert_eq!(cues[0].text, "So today we ship.");
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (0, 1_500));
        assert_eq!(cues[1].text, "Then a quite remarkably long sentence here");
        assert_eq!((cues[1].start_ms, cues[1].end_ms), (2_300, 4_300));
        assert_eq!(cues[2].text, "end", "a pause of 4.7 s starts a new cue");
        assert_eq!(cues.len(), 3);
        // Width cap: 42 characters.
        let wide: Vec<TranscriptWord> = (0..12)
            .map(|index| word("abcdefgh", index * 300, index * 300 + 200))
            .collect();
        let wide_cues = cues_from_words(&wide, &[(0, 60_000)]);
        assert!(
            wide_cues
                .iter()
                .all(|cue| cue.text.chars().count() <= SRT_CUE_MAX_CHARS)
        );
        assert_eq!(
            wide_cues[0].text.split(' ').count(),
            4,
            "4 x 8 + 3 spaces = 35; a fifth would be 44"
        );
        assert!(cues_from_words(&words, &[]).is_empty());
    }

    #[test]
    fn output_cues_prefer_the_source_srt_and_fall_back_to_words() {
        let kept = [(0, 10_000), (20_000, 30_000)];
        let srt = "1\n00:00:01,000 --> 00:00:03,000\nfrom the srt\n\n2\n00:00:12,000 --> 00:00:14,000\nremoved\n\n3\n00:00:25,000 --> 00:00:26,000\nshifted\n\n";
        let transcript = TranscriptFile {
            version: TRANSCRIPT_VERSION,
            language: Some("en".to_string()),
            words: vec![word("from", 1_000, 1_400), word("words", 1_500, 2_000)],
        };
        let from_srt = output_cues(Some(srt), Some(&transcript), &kept);
        assert_eq!(from_srt.len(), 2);
        assert_eq!(from_srt[0].text, "from the srt");
        assert_eq!((from_srt[1].start_ms, from_srt[1].end_ms), (15_000, 16_000));
        let from_words = output_cues(None, Some(&transcript), &kept);
        assert_eq!(from_words.len(), 1);
        assert_eq!(from_words[0].text, "from words");
        assert_eq!(
            (from_words[0].start_ms, from_words[0].end_ms),
            (1_000, 2_000)
        );
        let empty_srt = output_cues(Some(""), Some(&transcript), &kept);
        assert_eq!(
            empty_srt, from_words,
            "an empty srt falls back to the words"
        );
        assert!(output_cues(None, None, &kept).is_empty());
    }

    #[test]
    fn the_srt_lands_beside_the_output_and_nothing_is_written_without_cues() {
        let dir =
            std::env::temp_dir().join(format!("videorc-clean-cut-srt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("talk.mp4");
        let output = dir.join("talk (Clean cut).mp4");
        std::fs::write(
            source.with_extension("srt"),
            "1\n00:00:05,000 --> 00:00:06,000\nhello\n\n",
        )
        .unwrap();
        let ranges = [KeptRange {
            start_frame: 90,
            end_frame: 300,
        }];
        let fps30 = CleanCutFrameRate { num: 30, den: 1 };
        let written = write_retimed_srt(&source, &output, None, &ranges, fps30).unwrap();
        assert_eq!(written, Some(output.with_extension("srt")));
        let content = std::fs::read_to_string(output.with_extension("srt")).unwrap();
        assert_eq!(content, "1\n00:00:02,000 --> 00:00:03,000\nhello\n\n");
        assert!(!output.with_extension("srt.part").exists());
        // Nothing kept where the cue is, no transcript: nothing written.
        let other = dir.join("other.mp4");
        let none = write_retimed_srt(
            &other,
            &dir.join("other (Clean cut).mp4"),
            Some(dir.join("missing.json").to_str().unwrap()),
            &ranges,
            fps30,
        )
        .unwrap();
        assert_eq!(none, None);
        assert!(!dir.join("other (Clean cut).srt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
