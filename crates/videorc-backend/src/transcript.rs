//! The `<recording>.srt` transcript as timed cues (plan 119 S1).
//!
//! Live captions and Orcle listening write one `.srt` next to the finished
//! recording (`captions.rs`). Everything that reads it back (clip moments,
//! the Orcle report, the Publish workflow until it is removed) shares this
//! parser so a cue means the same thing everywhere.

/// One caption cue from a live-captions `.srt` (kept with timing for
/// chapter/clip ranking, not just the joined text).
#[derive(Debug, Clone, PartialEq)]
pub struct CaptionCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

pub fn parse_srt(content: &str) -> Vec<CaptionCue> {
    let mut cues = Vec::new();
    for block in content.replace("\r\n", "\n").split("\n\n") {
        let mut lines = block.lines().filter(|line| !line.trim().is_empty());
        let Some(first) = lines.next() else { continue };
        // The numeric cue index line is optional in practice; the timecode
        // line is the anchor.
        let timing_line = if first.contains("-->") {
            first
        } else {
            match lines.next() {
                Some(line) if line.contains("-->") => line,
                _ => continue,
            }
        };
        let mut parts = timing_line.splitn(2, "-->");
        let (Some(start), Some(end)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Some(start_ms), Some(end_ms)) = (srt_timestamp_ms(start), srt_timestamp_ms(end))
        else {
            continue;
        };
        let text = lines.collect::<Vec<_>>().join(" ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        cues.push(CaptionCue {
            start_ms,
            end_ms,
            text,
        });
    }
    cues
}

fn srt_timestamp_ms(value: &str) -> Option<u64> {
    // "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm".
    let value = value.trim();
    let mut clock_and_millis = value.split([',', '.']);
    let clock = clock_and_millis.next()?;
    let millis: u64 = clock_and_millis.next().unwrap_or("0").trim().parse().ok()?;
    let mut parts = clock.split(':').rev();
    let seconds: u64 = parts.next()?.trim().parse().ok()?;
    let minutes: u64 = parts.next()?.trim().parse().ok()?;
    let hours: u64 = parts.next().unwrap_or("0").trim().parse().ok()?;
    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + millis)
}

/// Plain prose, one cue per line.
pub fn caption_cues_text(cues: &[CaptionCue]) -> String {
    cues.iter()
        .map(|cue| cue.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A kept span of a source recording, `[start_ms, end_ms)`, in time order
/// and non-overlapping: what Clean cut's render keeps (plan 119 S13).
pub type KeptSpanMs = (u64, u64);

/// Map cues from the source timeline onto the timeline of a cut that keeps
/// only `kept`. A cue fully inside a removal is dropped; one that straddles a
/// removal is clipped to its kept part (the removal collapses, so the mapped
/// cue stays contiguous); every cue after a removal shifts earlier by the
/// removed time before it. Pure.
pub fn retime_cues(cues: &[CaptionCue], kept: &[KeptSpanMs]) -> Vec<CaptionCue> {
    let mut offsets = Vec::with_capacity(kept.len());
    let mut kept_before = 0_u64;
    for (start_ms, end_ms) in kept {
        offsets.push(kept_before);
        kept_before += end_ms.saturating_sub(*start_ms);
    }
    cues.iter()
        .filter_map(|cue| {
            // The first kept instant at or after the cue's start ...
            let start = kept
                .iter()
                .zip(&offsets)
                .find(|((_, end_ms), _)| cue.start_ms < *end_ms)
                .map(|((start_ms, _), offset)| offset + cue.start_ms.max(*start_ms) - start_ms)?;
            // ... and the last kept instant at or before its end.
            let end = kept
                .iter()
                .zip(&offsets)
                .rev()
                .find(|((start_ms, _), _)| cue.end_ms > *start_ms)
                .map(|((start_ms, end_ms), offset)| offset + cue.end_ms.min(*end_ms) - start_ms)?;
            (end > start).then(|| CaptionCue {
                start_ms: start,
                end_ms: end,
                text: cue.text.clone(),
            })
        })
        .collect()
}

/// Cues as an SRT document: numbered blocks with `HH:MM:SS,mmm` timings.
/// `parse_srt` reads it back to the same cues.
pub fn format_srt(cues: &[CaptionCue]) -> String {
    let mut out = String::new();
    for (index, cue) in cues.iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            srt_timestamp(cue.start_ms),
            srt_timestamp(cue.end_ms),
            cue.text.trim()
        ));
    }
    out
}

fn srt_timestamp(total_millis: u64) -> String {
    let hours = total_millis / 3_600_000;
    let minutes = (total_millis % 3_600_000) / 60_000;
    let seconds = (total_millis % 60_000) / 1_000;
    let millis = total_millis % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_with_and_without_cue_indices() {
        let srt = "1\n00:00:01,000 --> 00:00:03,240\nWelcome back everyone\n\n00:00:03,500 --> 00:00:06.100\ntoday we build the thing\nfrom scratch\n\n2\n00:00:07,000 --> 00:00:08,000\n\n";
        let cues = parse_srt(srt);

        assert_eq!(
            cues,
            vec![
                CaptionCue {
                    start_ms: 1_000,
                    end_ms: 3_240,
                    text: "Welcome back everyone".to_string(),
                },
                CaptionCue {
                    start_ms: 3_500,
                    end_ms: 6_100,
                    text: "today we build the thing from scratch".to_string(),
                },
            ]
        );
        assert_eq!(
            caption_cues_text(&cues),
            "Welcome back everyone\ntoday we build the thing from scratch"
        );
    }

    #[test]
    fn srt_timestamps_cover_hours_and_dot_millis() {
        assert_eq!(srt_timestamp_ms("01:02:03,456"), Some(3_723_456));
        assert_eq!(srt_timestamp_ms(" 00:00:00.001 "), Some(1));
        assert_eq!(srt_timestamp_ms("garbage"), None);
    }

    #[test]
    fn an_empty_srt_has_no_cues() {
        assert!(parse_srt("").is_empty());
        assert_eq!(caption_cues_text(&[]), "");
    }

    fn cue(start_ms: u64, end_ms: u64, text: &str) -> CaptionCue {
        CaptionCue {
            start_ms,
            end_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn retiming_drops_removed_cues_clips_straddlers_and_shifts_the_rest() {
        // Keep [0, 10 s) and [20 s, 30 s): the second 10 s are removed.
        let kept = [(0, 10_000), (20_000, 30_000)];
        let cues = [
            cue(1_000, 3_000, "inside the first kept span"),
            cue(12_000, 15_000, "fully removed"),
            cue(8_000, 23_000, "straddles the removal"),
            cue(25_000, 28_000, "after the removal"),
            cue(29_500, 31_000, "runs past the end"),
            cue(9_990, 10_000, "ends exactly at the cut"),
        ];
        let retimed = retime_cues(&cues, &kept);
        assert_eq!(
            retimed,
            vec![
                cue(1_000, 3_000, "inside the first kept span"),
                // 8 s stays; 23 s becomes 10 s + 3 s: the gap collapses.
                cue(8_000, 13_000, "straddles the removal"),
                cue(15_000, 18_000, "after the removal"),
                cue(19_500, 20_000, "runs past the end"),
                cue(9_990, 10_000, "ends exactly at the cut"),
            ]
        );
        assert!(retime_cues(&cues, &[]).is_empty(), "nothing kept, no cues");
        assert_eq!(
            retime_cues(&cues, &[(0, 40_000)]),
            cues.to_vec(),
            "an uncut timeline leaves every cue alone"
        );
    }

    #[test]
    fn srt_formatting_round_trips_through_the_parser() {
        let cues = vec![
            cue(0, 1_500, "Welcome back"),
            cue(3_723_456, 3_725_000, "an hour in"),
        ];
        let srt = format_srt(&cues);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:01,500\nWelcome back\n\n"));
        assert!(srt.contains("2\n01:02:03,456 --> 01:02:05,000\nan hour in\n\n"));
        assert_eq!(parse_srt(&srt), cues);
        assert_eq!(format_srt(&[]), "");
    }
}
