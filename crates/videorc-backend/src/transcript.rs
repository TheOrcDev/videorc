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
}
