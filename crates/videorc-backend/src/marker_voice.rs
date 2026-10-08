//! Local marker grammar and bounded acoustic utterance assembly. No command-parser request.
use crate::captions::CaptionSegment;
use crate::session_markers::normalize_label;

#[derive(Debug, PartialEq)]
pub struct VoiceMarker {
    pub label: Option<String>,
    pub at_seconds: f64,
}

struct Token<'a> {
    word: String,
    start: usize,
    raw: &'a str,
}
fn tokens(text: &str) -> Vec<Token<'_>> {
    let mut result = Vec::new();
    let mut start = None;
    for (index, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if c.is_alphanumeric() || c == '\'' || c == '’' {
            start.get_or_insert(index);
        } else if let Some(start) = start.take() {
            let raw = &text[start..index];
            result.push(Token {
                word: raw.to_lowercase().replace('’', "'"),
                start,
                raw,
            });
        }
    }
    result
}
fn wake(word: &str) -> bool {
    crate::cohost_command::is_any_wake_word(word)
}
fn quiet_complete(seconds: f64) -> bool {
    // PCM windows can sum to just below the exact 500 ms boundary.
    seconds >= 0.5 - 1e-9
}
fn wake_only(text: &str) -> bool {
    let words = tokens(text);
    let Some(index) = words.iter().take(3).position(|t| wake(&t.word)) else {
        return false;
    };
    words[..index].iter().all(|t| t.word == "please")
        && words[index + 1..].iter().all(|t| t.word == "please")
}

pub fn marker_candidate(text: &str) -> bool {
    let words = tokens(text);
    let Some(index) = words.iter().take(3).position(|t| wake(&t.word)) else {
        return false;
    };
    if words[..index].iter().any(|t| t.word != "please") {
        return false;
    }
    let tail: Vec<_> = words[index + 1..]
        .iter()
        .skip_while(|t| t.word == "please" || crate::cohost_command::is_command_negation(&t.word))
        .collect();
    // Reserve only marker grammar (including incomplete prefixes). Other Golem
    // actions, especially the existing "mark clip" command, retain their owner.
    match tail.first().map(|t| t.word.as_str()) {
        // A wake-only final belongs to the shared command detector too. It
        // does not produce an Unknown card there, and the next marker chunk
        // will still be recognized from this utterance's retained raw text.
        None => false,
        Some("make" | "create" | "add") => {
            let next = if tail.get(1).is_some_and(|t| t.word == "a") {
                tail.get(2)
            } else {
                tail.get(1)
            };
            next.is_none_or(|t| t.word == "marker")
        }
        Some("mark") => tail
            .get(1)
            .is_none_or(|t| t.word == "here" || t.word == "this"),
        _ => false,
    }
}

pub fn parse_marker(
    text: &str,
    offset: f64,
    segments: &[CaptionSegment],
) -> Result<Option<VoiceMarker>, String> {
    let words = tokens(text);
    let Some(w) = words.iter().take(3).position(|t| wake(&t.word)) else {
        return Ok(None);
    };
    if words[..w].iter().any(|t| t.word != "please") {
        return Ok(None);
    }
    let mut i = w + 1;
    if words.get(i).is_some_and(|t| t.word == "please") {
        i += 1
    }
    if words
        .iter()
        .take(i + 1)
        .any(|t| crate::cohost_command::is_command_negation(&t.word))
    {
        return Ok(None);
    }
    let verb = i;
    match words.get(i).map(|t| t.word.as_str()) {
        Some("make" | "create" | "add") => {
            i += 1;
            if words.get(i).is_some_and(|t| t.word == "a") {
                i += 1
            }
            if !words.get(i).is_some_and(|t| t.word == "marker") {
                return Ok(None);
            }
            i += 1;
            if words.get(i).is_some_and(|t| t.word == "here") {
                i += 1
            }
        }
        Some("mark") => {
            i += 1;
            if !words
                .get(i)
                .is_some_and(|t| t.word == "this" || t.word == "here")
            {
                return Ok(None);
            }
            i += 1;
        }
        _ => return Ok(None),
    }
    let label = if i == words.len() {
        None
    } else {
        if !words
            .get(i)
            .is_some_and(|t| matches!(t.word.as_str(), "for" | "called" | "named" | "as"))
        {
            return Ok(None);
        }
        i += 1;
        let Some(_title) = words.get(i) else {
            return Err("Say the title after ‘for’, or repeat the command without a title.".into());
        };
        normalize_label(Some(&text[words[i - 1].start + words[i - 1].raw.len()..]))
            .map_err(|e| e.to_string())?
    };
    let verb_text = words[verb].raw;
    let at_seconds = segments
        .iter()
        .find(|s| {
            tokens(&s.text)
                .iter()
                .any(|t| t.word.eq_ignore_ascii_case(verb_text))
        })
        .map(|s| offset + s.start_second)
        .filter(|s| s.is_finite() && *s >= offset)
        .unwrap_or(offset);
    Ok(Some(VoiceMarker { label, at_seconds }))
}

#[derive(Default)]
pub struct UtteranceBuffer {
    text: String,
    offset: f64,
    segments: Vec<CaptionSegment>,
    next_offset: Option<f64>,
    quiet_seconds: f64,
    invalid: bool,
    last_seq: Option<u64>,
    heard_voice: bool,
    suppress_until_boundary: bool,
    cancelled_wake: bool,
}
#[derive(Default)]
pub struct UtteranceOutcome {
    pub consumed: bool,
    pub markers: Vec<VoiceMarker>,
    pub refusal: Option<String>,
}
impl UtteranceBuffer {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn cancel(&mut self) -> bool {
        let suppress =
            self.suppress_until_boundary || marker_candidate(&self.text) || wake_only(&self.text);
        let cancelled_wake = self.cancelled_wake;
        let quiet_seconds = self.quiet_seconds;
        self.clear();
        self.suppress_until_boundary = suppress;
        self.cancelled_wake = cancelled_wake;
        self.quiet_seconds = quiet_seconds;
        suppress
    }
    pub fn observe_cancelled(&mut self, samples: &[i16], text: &str) -> bool {
        // Retain only grammar ownership after cancellation, never private words.
        // A blocked wake-only chunk still reaches ordinary command handling;
        // its following marker header reserves the rest of this speech turn.
        self.suppress_until_boundary |= marker_candidate(text)
            || (self.cancelled_wake && marker_candidate(&format!("Golem {text}")));
        if !text.trim().is_empty() {
            self.cancelled_wake = !self.suppress_until_boundary && wake_only(text);
        }
        let consumed = self.suppress_until_boundary;
        for window in samples.chunks(800) {
            if crate::captions::pcm_has_voice(window) {
                self.quiet_seconds = 0.0
            } else {
                self.quiet_seconds += window.len() as f64 / 16_000.0;
                if quiet_complete(self.quiet_seconds) {
                    self.suppress_until_boundary = false;
                    self.cancelled_wake = false;
                }
            }
        }
        consumed
    }

    pub fn observe(
        &mut self,
        seq: u64,
        offset: f64,
        duration: f64,
        samples: &[i16],
        text: &str,
        segments: &[CaptionSegment],
    ) -> UtteranceOutcome {
        if self.suppress_until_boundary || self.cancelled_wake {
            return UtteranceOutcome {
                consumed: self.observe_cancelled(samples, text),
                ..Default::default()
            };
        }
        if self.last_seq == Some(seq) {
            return UtteranceOutcome {
                consumed: marker_candidate(text) || marker_candidate(&self.text),
                ..Default::default()
            };
        }
        let mut outcome = UtteranceOutcome::default();
        if self
            .next_offset
            .is_some_and(|expected| (expected - offset).abs() > 0.1)
        {
            if marker_candidate(&self.text) {
                outcome.refusal = Some(
                    "Some command audio was missed. Please repeat the complete marker command."
                        .into(),
                )
            }
            self.clear();
        }
        self.last_seq = Some(seq);
        self.next_offset = Some(offset + duration);
        let mut boundaries = Vec::new();
        let mut voice_after_close = false;
        for (index, window) in samples.chunks(800).enumerate() {
            if crate::captions::pcm_has_voice(window) {
                self.heard_voice = true;
                voice_after_close |= !boundaries.is_empty();
                self.quiet_seconds = 0.0;
            } else {
                let previous = self.quiet_seconds;
                self.quiet_seconds += window.len() as f64 / 16_000.0;
                if self.heard_voice
                    && !quiet_complete(previous)
                    && quiet_complete(self.quiet_seconds)
                {
                    boundaries.push((index + 1) as f64 * 0.05)
                }
            }
        }
        // Multiple speech turns in one upload need timing to assign the title.
        if (boundaries.len() > 1 || voice_after_close) && !text.trim().is_empty() {
            if segments.is_empty() {
                outcome.consumed = marker_candidate(text) || marker_candidate(&self.text);
                if outcome.consumed {
                    outcome.refusal = Some("The marker command overlapped another speech turn. Please repeat it with a short pause afterward.".into())
                }
                self.clear();
                return outcome;
            }
            let mut start = 0.0;
            for end in boundaries.iter().copied().chain(std::iter::once(duration)) {
                let timed: Vec<_> = segments
                    .iter()
                    .filter(|s| s.start_second >= start && s.start_second < end)
                    .cloned()
                    .collect();
                let part = timed
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                self.append(offset, &part, &timed);
                outcome.consumed |= marker_candidate(&self.text);
                if end < duration || !voice_after_close {
                    self.finish(&mut outcome)
                }
                start = end;
            }
        } else {
            let candidate = marker_candidate(&self.text) || marker_candidate(text);
            self.append(offset, text, segments);
            outcome.consumed = marker_candidate(text)
                || marker_candidate(&self.text)
                || (self.invalid && candidate);
            if self.invalid && outcome.consumed {
                self.suppress_until_boundary = true;
                outcome.refusal = Some("The marker command was too long. Please repeat a shorter command and pause afterward.".into());
            }
            if !boundaries.is_empty() {
                self.finish(&mut outcome)
            }
        }
        if !self.text.is_empty() && offset + duration - self.offset > 10.0 {
            if marker_candidate(&self.text) {
                outcome.consumed = true;
                self.suppress_until_boundary = true;
                outcome.refusal = Some("The marker command was too long. Please repeat a shorter command and pause afterward.".into())
            }
            self.text.clear();
            self.segments.clear();
            self.invalid = true;
        }
        outcome
    }
    pub fn finish_at_capture_end(&mut self) -> UtteranceOutcome {
        let mut outcome = UtteranceOutcome {
            consumed: marker_candidate(&self.text),
            ..Default::default()
        };
        self.finish(&mut outcome);
        outcome
    }
    fn append(&mut self, offset: f64, text: &str, segments: &[CaptionSegment]) {
        if text.trim().is_empty() || self.invalid {
            return;
        }
        if self.text.is_empty() {
            self.offset = offset
        }
        if !self.text.is_empty() {
            self.text.push(' ')
        }
        self.text.push_str(text.trim());
        self.segments.extend(segments.iter().cloned().map(|mut s| {
            s.start_second += offset - self.offset;
            s.end_second += offset - self.offset;
            s
        }));
        if self.text.len() > 4096 {
            self.invalid = true;
            self.text.clear();
            self.segments.clear()
        }
    }
    fn finish(&mut self, outcome: &mut UtteranceOutcome) {
        if !self.invalid {
            match parse_marker(&self.text, self.offset, &self.segments) {
                Ok(Some(marker)) => outcome.markers.push(marker),
                Err(message) => outcome.refusal = Some(message),
                _ => {}
            }
        }
        self.text.clear();
        self.segments.clear();
        self.invalid = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wake_only_chunks_preserve_existing_commands_and_split_marker_prefixes() {
        use crate::cohost_command::{CommandDetector, CommandKind, DetectContext};
        let context = DetectContext {
            require_wake_word: true,
            ..Default::default()
        };
        let mut detector = CommandDetector::default();
        let mut buffer = UtteranceBuffer::default();
        let voice = vec![1000; 48_000];
        let mut closing = vec![1000; 16_000];
        closing.extend(vec![0; 32_000]);
        let at = std::time::Instant::now();
        for (seq, offset, text, samples) in [
            (1, 0.0, "Golem", &voice),
            (2, 3.0, "highlight the last comment.", &closing),
        ] {
            let outcome = buffer.observe(seq, offset, 3.0, samples, text, &[]);
            assert!(!outcome.consumed);
            let command = detector.observe_final("speech", seq, text, at, &context);
            if seq == 1 {
                assert!(command.is_none());
            } else {
                let command = command.unwrap();
                assert_eq!(command.kind, CommandKind::Highlight);
                assert!(command.wake_word);
            }
        }
        let mut buffer = UtteranceBuffer::default();
        assert!(!buffer.observe(1, 0.0, 3.0, &voice, "Golem", &[]).consumed);
        let marker = buffer.observe(
            2,
            3.0,
            3.0,
            &closing,
            "make a marker here for Split wake title",
            &[],
        );
        assert!(marker.consumed);
        assert_eq!(marker.markers.len(), 1);
        assert_eq!(marker.markers[0].label.as_deref(), Some("Split wake title"));
    }
    #[test]
    fn grammar_preserves_titles_and_rejects_negation_and_discussion() {
        for phrase in [
            "Golem make a marker here for Shadcn New Library",
            "Golem add a marker called Shadcn New Library",
            "Golem mark this as Shadcn New Library",
        ] {
            assert_eq!(
                parse_marker(phrase, 12.5, &[]).unwrap(),
                Some(VoiceMarker {
                    label: Some("Shadcn New Library".into()),
                    at_seconds: 12.5
                })
            );
        }
        assert!(
            parse_marker("Golem don't make a marker", 0.0, &[])
                .unwrap()
                .is_none()
        );
        assert!(
            parse_marker("We use markers in the library", 0.0, &[])
                .unwrap()
                .is_none()
        );
        assert!(
            parse_marker("Golem's marker looks nice", 0.0, &[])
                .unwrap()
                .is_none()
        );
        assert!(
            parse_marker("Oracle documentation uses markers", 0.0, &[])
                .unwrap()
                .is_none()
        );
        assert!(parse_marker("Golem make a marker here for", 0.0, &[]).is_err());
        assert!(marker_candidate("Golem don't make a marker for Alpha"));
        assert!(marker_candidate("Golem make a"));
        assert!(!marker_candidate("Golem mark clip"));
        assert!(!marker_candidate("Golem make an announcement"));
    }
    #[test]
    fn chunk_finals_wait_for_silence_and_preserve_first_verb_timing() {
        let mut buffer = UtteranceBuffer::default();
        let voice = vec![1000; 48000];
        assert!(
            buffer
                .observe(
                    1,
                    20.0,
                    3.0,
                    &voice,
                    "Golem make a marker here for Shadcn",
                    &[CaptionSegment {
                        text: "make".into(),
                        start_second: 0.7,
                        end_second: 0.9
                    }]
                )
                .markers
                .is_empty()
        );
        let mut tail = vec![1000; 16000];
        tail.extend(vec![0; 32000]);
        let result = buffer.observe(2, 23.0, 3.0, &tail, "New Library", &[]);
        assert_eq!(
            result.markers,
            vec![VoiceMarker {
                label: Some("Shadcn New Library".into()),
                at_seconds: 20.7
            }]
        );
        assert!(
            buffer
                .observe(2, 23.0, 3.0, &tail, "New Library", &[])
                .markers
                .is_empty()
        );
    }
    #[test]
    fn blocked_marker_turns_reserve_continuations_without_stealing_other_commands() {
        let voice = vec![1000; 48000];
        let quiet = vec![0; 48000];
        let mut blocked = UtteranceBuffer::default();
        assert!(blocked.observe_cancelled(&voice, "Golem make a marker here for"));
        blocked.cancel();
        assert!(blocked.observe_cancelled(&voice, "clip that and remove it from our chat"));
        assert!(blocked.observe_cancelled(&quiet, ""));
        assert!(!blocked.observe_cancelled(&voice, "clip that"));

        let mut split_wake = UtteranceBuffer::default();
        assert!(!split_wake.observe_cancelled(&voice, "Golem"));
        split_wake.cancel();
        assert!(!split_wake.observe_cancelled(&voice, "highlight the last comment"));
        assert!(!split_wake.observe_cancelled(&voice, "Golem"));
        split_wake.cancel();
        assert!(split_wake.observe_cancelled(&voice, "make a marker here for"));
        split_wake.cancel();
        assert!(split_wake.observe_cancelled(&voice, "clip that"));

        let mut regrant = UtteranceBuffer::default();
        assert!(!regrant.observe_cancelled(&voice, "Golem"));
        regrant.cancel();
        let outcome = regrant.observe(1, 0.0, 3.0, &voice, "make a marker for Private title", &[]);
        assert!(outcome.consumed);
        assert!(outcome.markers.is_empty());

        let mut retired_wake = UtteranceBuffer::default();
        retired_wake.observe(1, 0.0, 3.0, &voice, "Golem", &[]);
        assert!(retired_wake.cancel());
        let outcome =
            retired_wake.observe(2, 3.0, 3.0, &voice, "make a marker for Private title", &[]);
        assert!(outcome.consumed);
        assert!(outcome.markers.is_empty());

        let mut split_quiet = UtteranceBuffer::default();
        assert!(split_quiet.observe_cancelled(&voice, "Golem make a marker for"));
        assert!(split_quiet.observe_cancelled(&vec![0; 4800], ""));
        split_quiet.cancel();
        assert!(split_quiet.observe_cancelled(&vec![0; 3200], ""));
        assert!(!split_quiet.observe_cancelled(&voice, "highlight the last comment"));
    }
    #[test]
    fn cancellation_forgets_private_words_and_consumes_label_commands_until_quiet() {
        let mut buffer = UtteranceBuffer::default();
        buffer.observe(
            1,
            0.0,
            3.0,
            &vec![1000; 48000],
            "Golem make a marker for",
            &[],
        );
        assert!(buffer.cancel());
        assert!(buffer.text.is_empty());
        let cancelled = buffer.observe(2, 3.0, 3.0, &vec![1000; 48000], "clip that", &[]);
        assert!(cancelled.consumed);
        assert!(cancelled.markers.is_empty());
        buffer.observe(3, 6.0, 3.0, &vec![0; 48000], "", &[]);
        assert!(!buffer.suppress_until_boundary);
        assert_eq!(
            parse_marker("Golem mark this as \"Don't stop / 新 Library\"", 0.0, &[])
                .unwrap()
                .unwrap()
                .label
                .as_deref(),
            Some("\"Don't stop / 新 Library\"")
        );
    }
    #[test]
    fn successful_empty_final_preserves_audio_progress_and_closes_the_complete_turn() {
        let mut buffer = UtteranceBuffer::default();
        buffer.observe(
            1,
            0.0,
            3.0,
            &vec![1000; 48000],
            "Golem make a marker for Shadcn New Library",
            &[],
        );
        // The provider returned no extra words, but its audio contains the
        // end of this turn. The following quiet chunk must not invent a gap.
        let mut tail = vec![1000; 16000];
        tail.extend(vec![0; 32000]);
        let final_turn = buffer.observe(2, 3.0, 3.0, &tail, "", &[]);
        assert_eq!(final_turn.markers.len(), 1);
        assert_eq!(
            final_turn.markers[0].label.as_deref(),
            Some("Shadcn New Library")
        );
        let quiet = buffer.observe(3, 6.0, 3.0, &vec![0; 48000], "", &[]);
        assert!(quiet.markers.is_empty());
        assert!(quiet.refusal.is_none());
    }
    #[test]
    fn gaps_and_multiple_untimed_turns_never_save_partial_titles() {
        let mut buffer = UtteranceBuffer::default();
        buffer.observe(
            1,
            0.0,
            3.0,
            &vec![1000; 48000],
            "Golem make a marker for Shadcn",
            &[],
        );
        let result = buffer.observe(3, 6.0, 3.0, &vec![0; 48000], "New Library", &[]);
        assert!(result.markers.is_empty());
        assert!(result.refusal.is_some());
        let mut audio = vec![1000; 16000];
        audio.extend(vec![0; 16000]);
        audio.extend(vec![1000; 16000]);
        let result = buffer.observe(
            4,
            9.0,
            3.0,
            &audio,
            "Golem make a marker for Alpha. What is next?",
            &[],
        );
        assert!(result.markers.is_empty());
        assert!(result.refusal.is_some());
    }

    #[test]
    fn the_persona_name_wakes_the_marker_grammar_too() {
        assert!(marker_candidate("Golem make a marker here for Boss fight"));
        assert!(!marker_candidate(
            "Vexlar make a marker here for Boss fight"
        ));
        crate::cohost_command::set_persona_wake_tokens("Vexlar");
        assert!(marker_candidate("Vexlar make a marker here for Boss fight"));
        crate::cohost_command::set_persona_wake_tokens("Golem");
        assert!(!marker_candidate(
            "Vexlar make a marker here for Boss fight"
        ));
    }
}
