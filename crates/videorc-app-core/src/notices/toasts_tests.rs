//! The words, ids, durations and buttons of every toast `notices` raises,
//! case for case with the renderer's (`session-runtime-recovery.test.ts`,
//! `stream-target-notices.test.ts`, `studio-health.test.ts`,
//! `toast.test.ts`, `finalization-toast.test.ts`, `replay-buffer.test.ts`).

use super::*;
use crate::studio::session::StopConfirmation;
use crate::studio::session::{SessionStartFailureKind, SessionStartIntent, StopOrigin};
use videorc_protocol::{ClipMarkSource, PermissionPane};

fn status(state: RecordingState, session_id: Option<&str>) -> RecordingStatus {
    RecordingStatus {
        state,
        session_id: session_id.map(str::to_string),
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

fn live(session_id: &str) -> RecordingStatus {
    RecordingStatus {
        stream_url: Some("rtmp://127.0.0.1/live".to_string()),
        ..status(RecordingState::Recording, Some(session_id))
    }
}

fn event(code: &str, level: HealthLevel, session_id: Option<&str>, message: &str) -> HealthEvent {
    HealthEvent {
        id: format!("h-{code}"),
        session_id: session_id.map(str::to_string),
        level,
        code: code.to_string(),
        message: message.to_string(),
        permission_pane: None::<PermissionPane>,
        created_at: "2026-11-09T00:00:00Z".to_string(),
    }
}

fn shown(commands: &[NoticeCommand]) -> Vec<&Notice> {
    commands.iter().filter_map(NoticeCommand::notice).collect()
}

fn dismissed(commands: &[NoticeCommand]) -> Vec<&str> {
    commands
        .iter()
        .filter_map(|command| match command {
            NoticeCommand::Dismiss(id) => Some(id.as_str()),
            NoticeCommand::Show(_) => None,
        })
        .collect()
}

fn secs(n: u64) -> NoticeLifetime {
    NoticeLifetime::For(Duration::from_secs(n))
}

fn button(label: &str, action: NoticeAction) -> Option<NoticeButton> {
    Some(NoticeButton {
        label: label.to_string(),
        action,
    })
}

fn context<'a>(status: &'a RecordingStatus, last: Option<&'a str>) -> SessionContext<'a> {
    SessionContext {
        status,
        last_session_id: last,
        activity: SessionActivity::Recording,
        failure_notice: false,
    }
}

// ── lib/toast.ts ────────────────────────────────────────────────────────

#[test]
fn the_durations_follow_the_final_shape() {
    assert_eq!(ToastRequest::success("Saved").finish().lifetime, secs(4));
    assert_eq!(
        ToastRequest::info("Saved")
            .description("x")
            .finish()
            .lifetime,
        secs(8)
    );
    let acted = ToastRequest::success("Saved")
        .action("Play", NoticeAction::RetryStart)
        .finish();
    assert_eq!(acted.lifetime, NoticeLifetime::UntilClosed);
    // An explicit duration wins over the action.
    let timed = ToastRequest::success("Saved")
        .action("Play", NoticeAction::RetryStart)
        .duration(secs(12))
        .finish();
    assert_eq!(timed.lifetime, secs(12));
    // A loading toast takes no default: it stays.
    assert_eq!(
        ToastRequest::loading("Saving MP4…").finish().lifetime,
        NoticeLifetime::UntilClosed
    );
}

#[test]
fn an_error_offers_copy_after_its_duration_is_settled() {
    // Copy alone never keeps an error up: a described error keeps 8 s.
    let error = ToastRequest::error("MP4 export failed")
        .description("Your original recording is safe.")
        .finish();
    assert_eq!(error.lifetime, secs(8));
    assert_eq!(
        error.action,
        button(
            "Copy",
            NoticeAction::Copy {
                text: "MP4 export failed\nYour original recording is safe.".to_string()
            }
        )
    );
    assert_eq!(error.cancel, None);
    // With its own action, Copy takes the cancel slot.
    let retry = ToastRequest::error("Couldn't start recording")
        .description("No camera.")
        .action("Retry", NoticeAction::RetryStart)
        .finish();
    assert_eq!(retry.action, button("Retry", NoticeAction::RetryStart));
    assert_eq!(
        retry.cancel,
        button(
            "Copy",
            NoticeAction::Copy {
                text: "Couldn't start recording\nNo camera.".to_string()
            }
        )
    );
    // Other types never get Copy.
    assert_eq!(ToastRequest::warning("Careful").finish().action, None);
}

// The exact texts from the owner's 2026-10-02 screenshot (Stop) and the
// other user's screen recording (YouTube connect), as `toast.test.ts` has them.
// Marked test-only so the UI lint, which reads this file's items, skips them.
#[cfg(test)]
const OWNER_STOP_BODY: &str = "YouTube broadcast transition failed (403 Forbidden): {\n  \"error\": {\n    \"code\": 403,\n    \"message\": \"The request cannot be completed because you have exceeded your \\u003ca href=\\\"/youtube/v3/getting-started#quota\\\"\\u003equota\\u003c/a\\u003e.\",\n    \"errors\": [\n      {\n        \"message\": \"The request cannot be completed because you have exceeded your \\u003ca href=\\\"/youtube/v3/getting-started#quota\\\"\\u003equota\\u003c/a\\u003e.\",\n        \"domain\": \"youtube.quota\",\n        \"reason\": \"quotaExceeded\"\n      }\n    ]\n  }\n}";
#[cfg(test)]
const CONNECT_BODY: &str = "OAuth account preparation failed and will be retried from its protected token checkpoint: YouTube profile lookup failed with HTTP 403 Forbidden: quotaExceeded: The request cannot be completed because you have exceeded your &lt;a href=&quot;/youtube/v3/getting-started#quota&quot;&gt;quota&lt;/a&gt;.";

#[test]
fn the_guard_replaces_a_json_blob_with_the_support_pointer() {
    let guarded = guard_toast_text(OWNER_STOP_BODY);
    assert_eq!(guarded.text, "Details were saved for support.");
    assert!(!guarded.text.contains("{\"error\""));
    assert!(!guarded.text.contains('<'));
    assert_eq!(guarded.withheld.as_deref(), Some(OWNER_STOP_BODY));
    // Never "diagnostics" (plan 174 A-20).
    assert!(!guarded.text.to_lowercase().contains("diagnostics"));
}

#[test]
fn the_guard_strips_escaped_html_and_keeps_the_sentence() {
    let guarded = guard_toast_text(CONNECT_BODY);
    assert!(!guarded.text.contains("<a"));
    assert!(!guarded.text.contains('<'));
    assert!(!guarded.text.contains("&lt;"));
    assert!(!guarded.text.contains("&quot;"));
    assert!(
        guarded.text.contains("exceeded your quota ."),
        "{}",
        guarded.text
    );
    assert_eq!(guarded.withheld.as_deref(), Some(CONNECT_BODY));
}

#[test]
fn the_guard_strips_literal_tags_and_leaves_clean_copy_alone() {
    assert_eq!(
        guard_toast_text("Please <b>reconnect</b> YouTube.").text,
        "Please reconnect YouTube."
    );
    assert_eq!(
        guard_toast_text("<html><body>boom</body></html>").text,
        "boom"
    );
    assert_eq!(
        guard_toast_text("<br/>").text,
        "Details were saved for support."
    );
    let clean = "Couldn't end the YouTube broadcast.";
    assert_eq!(
        guard_toast_text(clean),
        GuardedText {
            text: clean.to_string(),
            withheld: None
        }
    );
    assert_eq!(
        guard_toast_text("Streaming to Twitch stopped at 12:30 (reconnecting).").withheld,
        None
    );
    // The IPC wrapper backstop (plan 174 S2.4).
    assert_eq!(
        guard_toast_text(
            "Error invoking remote method 'comments-window:clear': Error: Clear failed."
        )
        .text,
        "Clear failed."
    );
    // A code point decodes; an unknown entity stays as written.
    assert_eq!(
        guard_toast_text("Tom &amp; Jerry &#39;s").text,
        "Tom & Jerry 's"
    );
}

#[test]
fn a_withheld_message_offers_the_support_bundle_and_copy_keeps_the_raw_text() {
    let error = ToastRequest::error("Couldn't end the YouTube broadcast")
        .description(OWNER_STOP_BODY)
        .finish();
    assert_eq!(
        error.description.as_deref(),
        Some("Details were saved for support.")
    );
    assert_eq!(
        error.action,
        button("Export support bundle", NoticeAction::ExportSupportBundle)
    );
    // An offered action keeps the toast up, like any toast with an action.
    assert_eq!(error.lifetime, NoticeLifetime::UntilClosed);
    assert_eq!(
        error.cancel,
        button(
            "Copy",
            NoticeAction::Copy {
                text: format!(
                    "Couldn't end the YouTube broadcast\nDetails were saved for support.\nDetails: {OWNER_STOP_BODY}"
                )
            }
        )
    );
    // The support bundle action's one name (plan 174 S1.6b, I-1).
    assert_eq!(
        copy::EXPORT_SUPPORT_BUNDLE,
        crate::studio::health_page::SUPPORT_BUNDLE_LABEL
    );
    // A toast's own action stays.
    let own = ToastRequest::error("Couldn't end the YouTube broadcast")
        .description(OWNER_STOP_BODY)
        .action("Retry", NoticeAction::RetryStart)
        .finish();
    assert_eq!(own.action, button("Retry", NoticeAction::RetryStart));
    // A warning's title is guarded too, and clean toasts are untouched.
    let warning = ToastRequest::warning(CONNECT_BODY).id("x").finish();
    assert!(!warning.title.contains('<'));
    assert_eq!(warning.id.as_deref(), Some("x"));
    let success = ToastRequest::success("Account connected.").finish();
    assert_eq!(success.title, "Account connected.");
    assert_eq!(success.action, None);
}

#[test]
fn notify_once_keeps_one_toast_per_key_within_thirty_seconds() {
    let mut once = NotifyOnce::default();
    let start = Instant::now();
    let first = once.id("audio-output-stalled", start);
    assert_eq!(first, "once:audio-output-stalled:1");
    assert_eq!(
        once.id("audio-output-stalled", start + Duration::from_secs(29)),
        first
    );
    // The window refreshed at 29 s: 58 s is still inside it.
    assert_eq!(
        once.id("audio-output-stalled", start + Duration::from_secs(58)),
        first
    );
    assert_eq!(
        once.id("audio-output-stalled", start + Duration::from_secs(89)),
        "once:audio-output-stalled:2"
    );
    assert_eq!(once.id("other", start), "once:other:3");
}

// ── the session's end and its failure ───────────────────────────────────

#[test]
fn a_saved_recording_says_so_with_play_for_twelve_seconds() {
    // The toast shape stays on the builder; SessionNotices only dismisses
    // live-output keys. The Hub publishes "Recording saved" via sources::session.
    let saved = recording_saved(Some("s1"));
    assert_eq!(saved.kind, NoticeKind::Success);
    assert_eq!(saved.title, "Recording saved");
    assert_eq!(saved.description, None);
    assert_eq!(saved.id, None, "every take gets its own");
    assert_eq!(saved.lifetime, secs(12));
    assert_eq!(
        saved.action,
        button(
            "Play",
            NoticeAction::PlayRecording {
                session_id: Some("s1".to_string())
            }
        )
    );
    assert_eq!(
        saved.cancel,
        button(
            "Open in Library",
            NoticeAction::OpenLibrary {
                session_id: Some("s1".to_string())
            }
        )
    );

    let mut notices = SessionNotices::new();
    for activity in [
        SessionActivity::Recording,
        SessionActivity::RecordAndStream,
        SessionActivity::LiveStream,
    ] {
        let commands = notices.on_effect(&SessionEffect::SessionFinished {
            session_id: Some("s1".to_string()),
            activity,
        });
        assert!(shown(&commands).is_empty());
        assert_eq!(
            dismissed(&commands),
            ["stream-delivery", "stream-uplink"],
            "the live stream's news ends with it"
        );
    }
}

#[test]
fn a_failed_session_is_one_persistent_error_with_its_file() {
    let notice = RecordingFailedNotice {
        activity: SessionActivity::Recording,
        message: "The encoder quit.".to_string(),
        session_id: Some("s1".to_string()),
        output_path: Some("/tmp/take.mkv".to_string()),
        at: Instant::now(),
    };
    let commands = recording_failure(&notice);
    assert_eq!(dismissed(&commands), ["microphone-input-lost"]);
    let toast = shown(&commands)[0];
    assert_eq!(toast.kind, NoticeKind::Error);
    assert_eq!(toast.title, "Recording stopped unexpectedly");
    assert_eq!(toast.description.as_deref(), Some("The encoder quit."));
    assert_eq!(toast.id.as_deref(), Some("recording-stopped-unexpectedly"));
    assert_eq!(toast.lifetime, NoticeLifetime::UntilClosed);
    // S3.7a: Open in Library takes the action; the reveal keeps the cancel
    // slot.
    assert_eq!(
        toast.cancel,
        button(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: "s1".to_string()
            }
        )
    );
    assert_eq!(
        toast.action,
        button(
            "Open in Library",
            NoticeAction::OpenLibrary {
                session_id: Some("s1".to_string())
            }
        )
    );

    // A livestream has no file to reveal.
    let live = RecordingFailedNotice {
        activity: SessionActivity::LiveStream,
        output_path: None,
        ..notice
    };
    let commands = recording_failure(&live);
    let toast = shown(&commands)[0];
    assert_eq!(toast.title, "Livestream stopped unexpectedly");
    assert_eq!(toast.cancel, None);
}

#[test]
fn a_refused_start_keeps_retry_and_closing_it_dismisses_the_line() {
    let failure = SessionStartFailure {
        message: "No camera is connected.".to_string(),
        kind: SessionStartFailureKind::Record,
        intent: SessionStartIntent::RECORD,
        at: Instant::now(),
    };
    let toast = start_failure(&failure);
    assert_eq!(toast.kind, NoticeKind::Error);
    assert_eq!(toast.title, "Couldn't start recording");
    assert_eq!(
        toast.description.as_deref(),
        Some("No camera is connected.")
    );
    assert_eq!(toast.id.as_deref(), Some("session-start-failed"));
    assert_eq!(toast.lifetime, NoticeLifetime::UntilClosed);
    assert_eq!(toast.action, button("Retry", NoticeAction::RetryStart));
    assert!(matches!(
        &toast.cancel,
        Some(NoticeButton { label, .. }) if label == "Copy"
    ));
    assert_eq!(toast.on_close, Some(NoticeClose::DismissStartFailure));
    let live = start_failure(&SessionStartFailure {
        kind: SessionStartFailureKind::Live,
        ..failure.clone()
    });
    assert_eq!(live.title, "Couldn't go live");
    let resume = start_failure(&SessionStartFailure {
        kind: SessionStartFailureKind::Resume,
        ..failure.clone()
    });
    assert_eq!(resume.title, "Couldn't resume the stream");

    // A plan limit is news about Premium, not a failure.
    let premium = start_failure(&SessionStartFailure {
        message: "4K recording needs Videorc Premium.".to_string(),
        ..failure
    });
    assert_eq!(premium.kind, NoticeKind::Info);
    assert_eq!(premium.title, "4K recording needs Videorc Premium.");
    assert_eq!(premium.lifetime, secs(15));
    assert_eq!(
        premium.action,
        button(
            "View Premium",
            NoticeAction::OpenUrl {
                url: "https://www.videorc.com/premium".to_string()
            }
        )
    );
    assert!(is_premium_upgrade_message("premium only"));
    assert!(!is_premium_upgrade_message("premiums"));
    assert!(!is_premium_upgrade_message("nonpremium"));
}

#[test]
fn the_start_attempt_and_the_stop_door_clear_and_arm() {
    let mut notices = SessionNotices::new();
    let commands = notices.start_attempted();
    assert_eq!(
        dismissed(&commands),
        [
            "session-start-failed",
            "recording-stopped-unexpectedly",
            "microphone-input-lost"
        ]
    );
    let armed = SessionNotices::stop_requested(&StopRequest::Armed);
    let toast = shown(&armed)[0];
    assert_eq!(toast.kind, NoticeKind::Message);
    assert_eq!(toast.title, "Press again to end the livestream");
    assert_eq!(toast.id.as_deref(), Some("end-livestream-armed"));
    assert_eq!(toast.lifetime, secs(2));
    assert_eq!(
        dismissed(&SessionNotices::stop_requested(&StopRequest::Stop)),
        ["end-livestream-armed"]
    );
    let question = StopRequest::Confirm(StopConfirmation {
        origin: StopOrigin::Button,
        session_id: None,
        platforms: Vec::new(),
        also_records: false,
    });
    assert!(SessionNotices::stop_requested(&question).is_empty());
}

#[test]
fn the_backend_lifecycle_reads_as_electrons() {
    use crate::supervisor::ExitSummary;
    let restarting = BackendState::Restarting {
        generation: 1,
        attempt: 2,
        delay: Duration::from_millis(500),
        exit: ExitSummary {
            code: Some(1),
            signal: None,
        },
    };
    let NoticeCommand::Show(toast) = backend_lifecycle(&restarting).unwrap() else {
        panic!("a toast");
    };
    assert_eq!(toast.kind, NoticeKind::Warning);
    assert_eq!(toast.title, "Videorc is recovering");
    assert_eq!(
        toast.description.as_deref(),
        Some("Restarting automatically (attempt 2)…")
    );
    assert_eq!(toast.id.as_deref(), Some("backend-lifecycle"));
    assert_eq!(toast.lifetime, secs(8));

    let gave_up = BackendState::Failed {
        generation: 1,
        reason: GAVE_UP_REASON.to_string(),
    };
    let NoticeCommand::Show(toast) = backend_lifecycle(&gave_up).unwrap() else {
        panic!("a toast");
    };
    assert_eq!(toast.title, "Videorc can't recover on its own");
    assert_eq!(
        toast.description.as_deref(),
        Some("Quit and reopen Videorc.")
    );
    assert_eq!(toast.lifetime, NoticeLifetime::UntilClosed);

    let lost = BackendState::Failed {
        generation: 1,
        reason: "An earlier Videorc backend is still running.".to_string(),
    };
    let NoticeCommand::Show(toast) = backend_lifecycle(&lost).unwrap() else {
        panic!("a toast");
    };
    assert_eq!(toast.title, "Videorc needs a restart");
    assert_eq!(toast.kind, NoticeKind::Error);

    assert_eq!(
        backend_lifecycle(&BackendState::Stopping { generation: 1 }),
        None
    );
}

// ── the microphone notice ───────────────────────────────────────────────

#[test]
fn the_microphone_notice_says_what_the_session_lost() {
    let mut notices = SessionNotices::new();
    let running = status(RecordingState::Recording, Some("s1"));
    let lost = event(
        "microphone-input-lost",
        HealthLevel::Warn,
        Some("s1"),
        "The microphone stopped.",
    );
    // Snapshot only; the Hub publishes the entry (#1859).
    assert!(
        notices
            .on_health_event(&lost, context(&running, Some("s1")), Instant::now())
            .is_empty()
    );
    let notice = notices.microphone_notice().expect("the loss");
    assert_eq!(
        microphone_notice_title(notice),
        "Microphone stopped: recording continues with silence"
    );
    assert_eq!(notice.message, "The microphone stopped.");
    assert!(
        notices
            .on_health_event(&lost, context(&running, Some("s1")), Instant::now())
            .is_empty()
    );
    let system = event(
        "system-audio-lost",
        HealthLevel::Warn,
        Some("s1"),
        "System audio stopped.",
    );
    assert!(
        notices
            .on_health_event(&system, context(&running, Some("s1")), Instant::now())
            .is_empty()
    );
    let notice = notices.microphone_notice().expect("both losses");
    assert_eq!(
        microphone_notice_title(notice),
        "Microphone and system audio lost"
    );
    assert_eq!(
        notice.message,
        "The microphone stopped. System audio stopped."
    );

    let commands = notices.on_effect(&SessionEffect::SessionFinished {
        session_id: Some("s1".to_string()),
        activity: SessionActivity::Recording,
    });
    assert!(shown(&commands).is_empty());
    assert_eq!(dismissed(&commands), ["stream-delivery", "stream-uplink"]);
    assert_eq!(
        notices.microphone_notice().map(|notice| notice.phase),
        Some(MicrophonePhase::Ended)
    );
    assert_eq!(
        microphone_notice_title(notices.microphone_notice().unwrap()),
        "Microphone and system audio lost: saved session has missing audio"
    );
}

#[test]
fn the_microphone_titles_are_the_renderers() {
    let notice = |codes: &[&str], activity, phase| MicrophoneNotice {
        audio_issues: codes
            .iter()
            .map(|code| AudioIssue {
                code: code.to_string(),
                message: String::new(),
            })
            .collect(),
        activity,
        phase,
        message: String::new(),
        session_id: None,
    };
    use MicrophonePhase::{Active, Ended, Ending};
    use RuntimeActivity::{Clips, LiveStream, RecordAndStream, Recording};
    for (codes, activity, phase, title) in [
        (
            &["microphone-silent"][..],
            Recording,
            Active,
            "Your microphone is silent in the recording",
        ),
        (
            &["microphone-silent"],
            LiveStream,
            Active,
            "Your microphone is silent on the livestream",
        ),
        (
            &["microphone-silent"],
            Clips,
            Ended,
            "Microphone was silent: Clips contain silence",
        ),
        (
            &["microphone-silent"],
            Recording,
            Ended,
            "Microphone was silent: saved recording contains silence",
        ),
        (
            &["system-audio-lost"],
            Recording,
            Active,
            "System audio lost",
        ),
        (
            &["microphone-timeline-lost"],
            Recording,
            Ended,
            "Microphone audio couldn't be recorded: saved session has missing audio",
        ),
        (
            &["microphone-input-lost"],
            Clips,
            Ending,
            "Microphone stopped: Clips finishing with silence",
        ),
        (
            &["microphone-input-lost"],
            RecordAndStream,
            Ending,
            "Microphone stopped as the livestream ends",
        ),
        (
            &["microphone-input-lost"],
            Recording,
            Ending,
            "Microphone stopped: finishing recording with silence",
        ),
        (
            &["microphone-input-lost"],
            LiveStream,
            Active,
            "Microphone stopped: livestream continues with silence",
        ),
        (
            &["microphone-input-lost"],
            LiveStream,
            Ended,
            "Microphone stopped during the livestream",
        ),
    ] {
        assert_eq!(
            microphone_notice_title(&notice(codes, activity, phase)),
            title
        );
    }
}

#[test]
fn a_failure_outranks_the_microphone_and_system_only_losses_stay_quiet() {
    let mut notices = SessionNotices::new();
    let running = live("s1");
    let mut failed = context(&running, Some("s1"));
    failed.failure_notice = true;
    let lost = event("microphone-input-lost", HealthLevel::Warn, Some("s1"), "x");
    assert!(
        notices
            .on_health_event(&lost, failed, Instant::now())
            .is_empty()
    );
    let mut notices = SessionNotices::new();
    let system = event("system-audio-lost", HealthLevel::Warn, Some("s1"), "x");
    assert!(
        notices
            .on_health_event(&system, context(&running, Some("s1")), Instant::now())
            .is_empty(),
        "the mixer shows a system-only loss"
    );
    // Another session's loss is not this one's.
    let mut notices = SessionNotices::new();
    let other = event("microphone-input-lost", HealthLevel::Warn, Some("s9"), "x");
    assert!(
        notices
            .on_health_event(&other, context(&running, Some("s1")), Instant::now())
            .is_empty()
    );
    // #1528: another recovery (the disk, the connection) leaves it up.
    let mut notices = SessionNotices::new();
    notices.on_health_event(&lost, context(&running, Some("s1")), Instant::now());
    let disk = event(
        "disk-space-recovered",
        HealthLevel::Info,
        Some("s1"),
        "Space is back.",
    );
    let commands = notices.on_health_event(&disk, context(&running, Some("s1")), Instant::now());
    assert!(dismissed(&commands).is_empty());
    assert!(notices.microphone_notice().is_some());
    // An audio recovery clears the notice.
    let mut notices = SessionNotices::new();
    notices.on_health_event(&lost, context(&running, Some("s1")), Instant::now());
    let back = event(
        "microphone-timeline-recovered",
        HealthLevel::Info,
        Some("s1"),
        "The microphone is back.",
    );
    let commands = notices.on_health_event(&back, context(&running, Some("s1")), Instant::now());
    assert_eq!(
        dismissed(&commands),
        ["recording-stopped-unexpectedly", "microphone-input-lost"]
    );
    // "Microphone is back" is the store's entry (`sources::devices`, #1865),
    // never a SessionNotices toast (Electron's `showSessionHealthEvent`).
    assert!(shown(&commands).is_empty());
    assert_eq!(notices.microphone_notice(), None);
}

// ── showSessionHealthEvent ──────────────────────────────────────────────

/// Electron's `showSessionHealthEvent` toasts only the Error barrier
/// timeout; every other health code is an L6 store entry (#1865, tested in
/// `sources::health` and `health_kinds`), so SessionNotices shows nothing.
#[test]
fn only_the_barrier_timeout_stays_a_session_toast() {
    let mut notices = SessionNotices::new();
    let running = live("s1");
    let warn = HealthLevel::Warn;
    for (code, level, kind, title, id, lifetime) in [
        (
            "stream-output-failed",
            HealthLevel::Error,
            NoticeKind::Error,
            "Your stream stopped",
            "stream-output",
            NoticeLifetime::UntilClosed,
        ),
        (
            "stream-output-stalled",
            warn.clone(),
            NoticeKind::Warning,
            "Your stream is frozen",
            "stream-output",
            NoticeLifetime::UntilClosed,
        ),
        (
            "stream-output-resumed",
            HealthLevel::Info,
            NoticeKind::Success,
            "Your stream is moving again",
            "stream-output",
            secs(8),
        ),
        (
            "stream-delivery-degraded",
            warn.clone(),
            NoticeKind::Warning,
            "Your stream is choppy",
            "stream-delivery",
            NoticeLifetime::UntilClosed,
        ),
        (
            "stream-delivery-recovered",
            HealthLevel::Info,
            NoticeKind::Success,
            "Your stream is smooth again",
            "stream-delivery",
            secs(8),
        ),
        (
            "stream-leg-overflow",
            warn.clone(),
            NoticeKind::Warning,
            "Your connection can’t keep up",
            "stream-uplink",
            secs(20),
        ),
        (
            "stream-bitrate-lowered",
            warn.clone(),
            NoticeKind::Warning,
            "Stream quality lowered to fit your connection",
            "stream-uplink",
            secs(15),
        ),
        (
            "stream-bitrate-floor",
            warn.clone(),
            NoticeKind::Warning,
            "Your connection can’t carry this stream",
            "stream-uplink",
            secs(30),
        ),
        (
            "stream-bitrate-restored",
            HealthLevel::Info,
            NoticeKind::Success,
            "Stream quality is back",
            "stream-uplink",
            secs(8),
        ),
        (
            "screen-capture-stopped",
            HealthLevel::Error,
            NoticeKind::Error,
            "Screen capture stopped",
            "screen-capture",
            NoticeLifetime::UntilClosed,
        ),
        (
            "screen-capture-stopped",
            warn.clone(),
            NoticeKind::Warning,
            "Screen capture stopped",
            "screen-capture",
            secs(20),
        ),
        (
            "screen-capture-restored",
            HealthLevel::Info,
            NoticeKind::Success,
            "Screen capture is back",
            "screen-capture",
            secs(8),
        ),
        (
            "screen-window-out-of-sight",
            warn.clone(),
            NoticeKind::Warning,
            "Window out of sight",
            "screen-capture",
            secs(20),
        ),
        (
            "screen-window-back",
            HealthLevel::Info,
            NoticeKind::Success,
            "The window is back",
            "screen-capture",
            secs(8),
        ),
        (
            "host-overloaded",
            warn.clone(),
            NoticeKind::Warning,
            "This computer is overloaded",
            "host-overloaded",
            secs(20),
        ),
        (
            "disk-space-low",
            warn.clone(),
            NoticeKind::Warning,
            "Recording space is low",
            "disk-space-low",
            secs(20),
        ),
        (
            "recording-startup-cadence-unsteady",
            warn.clone(),
            NoticeKind::Warning,
            "The first seconds may stutter",
            "recording-startup-cadence-unsteady",
            secs(15),
        ),
        (
            "recording-output-stepped-down",
            warn.clone(),
            NoticeKind::Warning,
            "Recording at a lower resolution",
            "recording-output-stepped-down",
            secs(20),
        ),
        (
            "recording-degraded",
            warn.clone(),
            NoticeKind::Warning,
            "Recording is falling behind",
            "recording-degraded",
            secs(20),
        ),
        (
            "microphone-capture-worker-fallback",
            warn.clone(),
            NoticeKind::Warning,
            "Microphone can't be changed until you stop",
            "microphone-capture-worker-fallback",
            secs(15),
        ),
        (
            "microphone-capture-worker-unavailable",
            warn.clone(),
            NoticeKind::Warning,
            "Going on without a microphone",
            "microphone-capture-worker-unavailable",
            secs(20),
        ),
        (
            "recording-startup-barrier-timeout",
            HealthLevel::Error,
            NoticeKind::Error,
            "Couldn't start",
            "session-start-failed",
            NoticeLifetime::UntilClosed,
        ),
        (
            "system-audio-echo-paused",
            warn.clone(),
            NoticeKind::Warning,
            "System audio paused: your stream was echoing",
            "system-audio-echo-paused",
            NoticeLifetime::UntilClosed,
        ),
    ] {
        let health = event(code, level, Some("s1"), "What happened.");
        let commands =
            notices.on_health_event(&health, context(&running, Some("s1")), Instant::now());
        let toasts = shown(&commands);
        if code != "recording-startup-barrier-timeout" {
            assert!(toasts.is_empty(), "{code}: a store entry, not a toast");
            continue;
        }
        assert_eq!(toasts.len(), 1, "{code}");
        let toast = toasts[0];
        assert_eq!(toast.kind, kind, "{code}");
        assert_eq!(toast.title, title, "{code}");
        assert_eq!(toast.id.as_deref(), Some(id), "{code}");
        assert_eq!(toast.lifetime, lifetime, "{code}");
        assert_eq!(
            toast.description.as_deref(),
            Some("What happened."),
            "{code}"
        );
    }
    // A code nobody toasts.
    let quiet = event("recording-started", HealthLevel::Info, Some("s1"), "x");
    assert!(
        notices
            .on_health_event(&quiet, context(&running, Some("s1")), Instant::now())
            .is_empty()
    );
}

#[test]
fn the_keyed_audio_news_and_the_quality_toast_say_it_once() {
    // Health / devices news is an L6 store entry (#1865). SessionNotices
    // only keeps the Error barrier-timeout toast.
    let mut notices = SessionNotices::new();
    let running = status(RecordingState::Recording, Some("s1"));
    let now = Instant::now();
    for (code, level) in [
        ("audio-output-stalled", HealthLevel::Warn),
        ("microphone-noise-reduction-silenced", HealthLevel::Warn),
        ("microphone-signal-recovered", HealthLevel::Info),
        ("recording-quality-not-100", HealthLevel::Warn),
        ("mic-silent", HealthLevel::Error),
        ("mic-silent", HealthLevel::Warn),
        ("recording-degraded", HealthLevel::Warn),
    ] {
        assert!(
            notices
                .on_health_event(
                    &event(code, level, Some("s1"), "x"),
                    context(&running, Some("s1")),
                    now,
                )
                .is_empty(),
            "{code}"
        );
    }
    // A recovery still clears a held mic notice.
    notices.on_health_event(
        &event(
            "microphone-input-lost",
            HealthLevel::Warn,
            Some("s1"),
            "gone",
        ),
        context(&running, Some("s1")),
        now,
    );
    assert!(notices.microphone_notice().is_some());
    let recovered = notices.on_health_event(
        &event(
            "microphone-input-recovered",
            HealthLevel::Info,
            Some("s1"),
            "back",
        ),
        context(&running, Some("s1")),
        now,
    );
    assert_eq!(
        dismissed(&recovered),
        ["recording-stopped-unexpectedly", "microphone-input-lost"]
    );
    assert!(notices.microphone_notice().is_none());
}

#[test]
fn a_separate_file_says_which_and_why() {
    assert_eq!(
        separate_file_failed_copy("camera capture failed after source recovery", true),
        (
            "Camera file stopped".to_string(),
            "The camera stopped sending video and couldn't be restarted. Your Combined recording keeps going."
                .to_string()
        )
    );
    assert_eq!(
        separate_file_failed_copy("screen file was missing after stop", false),
        (
            "Screen file wasn't saved".to_string(),
            "This file wasn't there when you stopped recording.".to_string()
        )
    );
    assert_eq!(
        separate_file_failed_copy("Screen: could not reap the screen muxer", false),
        (
            "Screen file stopped early".to_string(),
            "Videorc couldn't keep writing this file.".to_string()
        )
    );
    assert_eq!(
        separate_file_failed_copy("something else", false),
        (
            "Separate file stopped early".to_string(),
            "Videorc couldn't finish this file.".to_string()
        )
    );
    let mut notices = SessionNotices::new();
    let running = status(RecordingState::Recording, Some("s1"));
    for code in [
        "separate-source-recordings-role-failed",
        "separate-source-recordings-shed",
    ] {
        assert!(
            notices
                .on_health_event(
                    &event(code, HealthLevel::Warn, Some("s1"), "camera encoder failed"),
                    context(&running, Some("s1")),
                    Instant::now(),
                )
                .is_empty(),
            "health table owns {code}"
        );
    }
}

#[test]
fn the_support_bundle_says_where_it_went_or_what_to_do() {
    let NoticeCommand::Show(done) = support_bundle_exported(
        "/data/support-bundles/videorc-support-bundle-20261109-100000Z.json",
    ) else {
        panic!("a toast");
    };
    assert_eq!(done.kind, NoticeKind::Success);
    assert_eq!(done.title, "Support bundle exported");
    assert_eq!(
        done.description.as_deref(),
        Some("videorc-support-bundle-20261109-100000Z.json")
    );
    assert_eq!(done.lifetime, secs(15));
    assert_eq!(
        done.action.as_ref().map(|button| &button.action),
        Some(&NoticeAction::RevealSupportBundle {
            path: "/data/support-bundles/videorc-support-bundle-20261109-100000Z.json".to_string()
        })
    );
    let NoticeCommand::Show(away) = support_bundle_export_failed(true) else {
        panic!("a toast");
    };
    assert_eq!(away.title, "Couldn't export a support bundle");
    assert_eq!(
        away.description.as_deref(),
        Some("Videorc is reconnecting. Try again in a moment.")
    );
    let NoticeCommand::Show(failed) = support_bundle_export_failed(false) else {
        panic!("a toast");
    };
    assert_eq!(
        failed.description.as_deref(),
        Some("Try again. If it keeps happening, export a support bundle from Health.")
    );
    assert_eq!(
        failed
            .action
            .as_ref()
            .map(|button| (button.label.as_str(), &button.action)),
        Some(("Open Health", &NoticeAction::OpenHealth))
    );
    assert_eq!(
        failed.cancel.as_ref().map(|button| button.label.as_str()),
        Some("Copy"),
        "the error toast's Copy takes the cancel slot"
    );
    assert_eq!(failed.lifetime, secs(8));
}

// ── the destinations ────────────────────────────────────────────────────

fn target(id: &str, label: &str, state: StreamTargetState) -> StreamTargetRuntime {
    StreamTargetRuntime {
        target_id: id.to_string(),
        label: label.to_string(),
        state,
        message: None,
    }
}

#[test]
fn a_destination_is_news_when_it_stops_reconnects_or_comes_back() {
    use StreamTargetState::{Connecting, Failed, Live, Reconnecting, Warning};
    // Notice copy stays on the pure helper; SessionNotices only tracks state
    // for SessionEnded reset. The Hub publishes via sources::stream_targets.
    use std::collections::BTreeMap;
    let mut states = BTreeMap::new();
    assert!(stream_target_notices(&states, &[target("t", "Twitch", Connecting)]).is_empty());
    let live = [
        target("t", "Twitch", Live),
        target("y", "YouTube", Live),
        target("x", "X / Twitter", Live),
    ];
    assert!(
        stream_target_notices(&states, &live).is_empty(),
        "going live is not news"
    );
    states = live
        .iter()
        .map(|t| (t.target_id.clone(), t.state))
        .collect();
    let reconnecting = [
        target("t", "Twitch", Reconnecting),
        target("y", "YouTube", Live),
        target("x", "X / Twitter", Live),
    ];
    let notices = stream_target_notices(&states, &reconnecting);
    assert_eq!(notices[0].title, "Twitch is reconnecting");
    assert_eq!(
        notices[0].description.as_deref(),
        Some("Viewers there see nothing until it's back. The other 2 destinations keep streaming.")
    );
    assert_eq!(notices[0].id.as_deref(), Some("stream-target:t"));
    assert_eq!(notices[0].kind, NoticeKind::Warning);
    assert_eq!(notices[0].lifetime, NoticeLifetime::UntilClosed);

    states = reconnecting
        .iter()
        .map(|t| (t.target_id.clone(), t.state))
        .collect();
    let after = [
        target("t", "Twitch", Live),
        target("y", "YouTube", Live),
        target("x", "X / Twitter", Failed),
    ];
    let notices = stream_target_notices(&states, &after);
    assert_eq!(notices[0].title, "Twitch is back");
    assert_eq!(
        notices[0].description.as_deref(),
        Some("Streaming to Twitch resumed.")
    );
    assert_eq!(notices[0].lifetime, secs(8));
    assert_eq!(notices[1].title, "Streaming to X stopped");
    assert_eq!(
        notices[1].description.as_deref(),
        Some("The other 2 destinations keep streaming.")
    );
    assert_eq!(notices[1].kind, NoticeKind::Error);

    states = BTreeMap::from([("t".into(), Live)]);
    let alone = stream_target_notices(&states, &[target("t", "Twitch", Reconnecting)]);
    assert_eq!(
        alone[0].description.as_deref(),
        Some("Viewers see nothing until it's back.")
    );
    states = BTreeMap::from([("t".into(), Reconnecting)]);
    let alone = stream_target_notices(&states, &[target("t", "Twitch", Warning)]);
    assert_eq!(alone[0].title, "Twitch isn't receiving your stream");
    assert_eq!(
        alone[0].description.as_deref(),
        Some("Videorc is still sending it. Check the platform’s live dashboard.")
    );
    states = BTreeMap::from([("t".into(), Warning)]);
    let alone = stream_target_notices(
        &states,
        &[StreamTargetRuntime {
            message: None,
            ..target("t", "Twitch", Failed)
        }],
    );
    assert_eq!(
        alone[0].description.as_deref(),
        Some("No other destination is streaming, so viewers see nothing.")
    );

    let mut session = SessionNotices::new();
    assert!(
        session
            .on_stream_targets(&[target("t", "Twitch", Live)])
            .is_empty()
    );
    assert!(
        session
            .on_stream_targets(&[target("t", "Twitch", Reconnecting)])
            .is_empty(),
        "legacy channel stays quiet"
    );
    session.on_effect(&SessionEffect::SessionEnded);
    assert!(
        session
            .on_stream_targets(&[target("t", "Twitch", Live)])
            .is_empty()
    );
}

fn finalization(
    state: RecordingFinalizationState,
    percent: Option<u8>,
) -> RecordingFinalizationEvent {
    RecordingFinalizationEvent {
        session_id: "s1".to_string(),
        state,
        progress_percent: percent,
        mp4_path: None,
        output_path: None,
        duration_ms: None,
        file_size_bytes: None,
        error: None,
        interruption_recovery: None,
        updated_at: "2026-11-09T00:00:00Z".to_string(),
    }
}

#[test]
fn the_mp4_export_spins_then_is_ready_once() {
    let mut notices = SessionNotices::new();
    let commands = notices.on_finalization(&finalization(
        RecordingFinalizationState::Finalizing,
        Some(0),
    ));
    let toast = shown(&commands)[0];
    assert_eq!(toast.kind, NoticeKind::Loading);
    assert_eq!(toast.title, "Saving MP4…");
    assert_eq!(
        toast.description.as_deref(),
        Some("Your recording is safe. Long recordings can take several minutes to save as MP4.")
    );
    assert_eq!(toast.id.as_deref(), Some("finalization-s1"));
    assert_eq!(toast.lifetime, NoticeLifetime::UntilClosed);
    let commands = notices.on_finalization(&finalization(
        RecordingFinalizationState::Finalizing,
        Some(42),
    ));
    assert_eq!(shown(&commands)[0].title, "Saving MP4 · 42%");
    let commands =
        notices.on_finalization(&finalization(RecordingFinalizationState::Finalized, None));
    let toast = shown(&commands)[0];
    assert_eq!(toast.title, "MP4 ready");
    assert_eq!(toast.kind, NoticeKind::Success);
    assert_eq!(toast.description, None);
    assert_eq!(toast.lifetime, secs(15));
    assert_eq!(
        toast.action,
        button(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: "s1".to_string()
            }
        )
    );
    assert!(
        notices
            .on_finalization(&finalization(RecordingFinalizationState::Finalized, None))
            .is_empty(),
        "announced once"
    );
}

#[test]
fn a_failed_export_names_the_space_it_needs_and_nothing_else() {
    let refusal = "Not enough disk space to finish the MP4 (needs 2.1 GB, 900 MB free). Your recording is safe as MKV; free some space and use Export MP4.";
    let toast = mp4_export_failed("s1", Some(refusal));
    assert_eq!(toast.title, "MP4 export failed");
    assert_eq!(toast.description.as_deref(), Some(refusal));
    assert_eq!(toast.lifetime, NoticeLifetime::UntilClosed);
    assert_eq!(
        toast.action,
        button(
            "Retry export",
            NoticeAction::RetryExport {
                session_id: "s1".to_string()
            }
        )
    );
    let toast = mp4_export_failed("s1", Some("ffmpeg exited with status 1"));
    assert_eq!(
        toast.description.as_deref(),
        Some("Your original recording is safe.")
    );
    assert_eq!(export_space_refusal(None), None);
}

#[test]
fn the_clips_say_what_was_kept() {
    let saved = ReplaySavedEvent {
        save_id: "c1".to_string(),
        session_id: "s1".to_string(),
        replay_session_id: "r1".to_string(),
        path: "/tmp/clip.mp4".to_string(),
        seconds: 30,
        covered_seconds: 29.6,
        complete: true,
        source: None,
    };
    let toast = clip_saved(&saved);
    assert_eq!(toast.title, "Clip saved");
    assert_eq!(toast.description.as_deref(), Some("Last 0:30."));
    assert_eq!(toast.id.as_deref(), Some("clips-saved-c1"));
    assert_eq!(toast.lifetime, secs(12));
    let partial = clip_saved(&ReplaySavedEvent {
        covered_seconds: 12.2,
        complete: false,
        ..saved
    });
    assert_eq!(
        partial.description.as_deref(),
        Some("Last 0:12, the buffer was still filling.")
    );
    let failed = clip_save_failed(&ReplaySaveFailedEvent {
        save_id: "c2".to_string(),
        session_id: None,
        reason: "disk".to_string(),
        message: "The disk is full.".to_string(),
    });
    assert_eq!(failed.title, "Couldn't save the clip");
    assert_eq!(failed.lifetime, secs(10));
    assert_eq!(failed.id.as_deref(), Some("clips-failed-c2"));
    let stopped = clips_stopped(None);
    assert_eq!(stopped.title, "Clips stopped");
    assert_eq!(
        stopped.description.as_deref(),
        Some("Turn on Keep the last seconds again on the Output page.")
    );

    let mark = ClipMarkedEvent {
        session_id: "s1".to_string(),
        at_seconds: 125.4,
        source: ClipMarkSource::Manual,
        saved: true,
        reason: None,
    };
    let marked = clip_marked(&mark, true, "Open Output").unwrap();
    assert_eq!(marked.title, "Clip marked at 2:05");
    assert_eq!(
        marked.description.as_deref(),
        Some("It's in your stream report in Buddy.")
    );
    assert_eq!(marked.id.as_deref(), Some("clip-marked"));
    assert_eq!(
        clip_marked(&mark, false, "Open Output")
            .unwrap()
            .description,
        None
    );
    let off = clip_marked(
        &ClipMarkedEvent {
            saved: false,
            reason: Some("recording-off".to_string()),
            ..mark.clone()
        },
        false,
        "Open Output",
    )
    .unwrap();
    assert_eq!(off.kind, NoticeKind::Warning);
    assert_eq!(off.title, "Clips are off, and nothing is recording.");
    // S3.6a: the warning's door to the Output page.
    assert_eq!(
        off.action
            .as_ref()
            .map(|button| (button.label.as_str(), &button.action)),
        Some((
            "Open Output",
            &NoticeAction::OpenPage(crate::nav::PageId::Recording)
        ))
    );
    assert_eq!(marked.action, None, "a saved mark has no door");
    assert_eq!(
        clip_marked(
            &ClipMarkedEvent {
                reason: Some("clip-saved".to_string()),
                ..mark
            },
            true,
            "Open Output"
        ),
        None,
        "the ring's own save says Clip saved"
    );
}

// ── the recovery after a reconnect ──────────────────────────────────────

fn row(id: &str, status: &str, mode: &str, health: u64) -> SessionListItem {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "title": id,
        "startedAt": "2026-11-09T00:00:00Z",
        "status": status,
        "mode": mode,
        "outputPath": format!("/tmp/{id}.mkv"),
        "healthEventCount": health,
        "sessionLogCount": 0,
        "aiArtifactCount": 0,
        "commentCount": 0
    }))
    .expect("a Library row")
}

#[test]
fn a_failure_the_status_no_longer_reports_comes_from_the_library() {
    let idle = status(RecordingState::Idle, None);
    let rows = [row("s1", "failed", "record+stream", 2)];
    let plan = session_runtime_recovery_plan(&idle, &rows, Some("s1"), &RecordingState::Recording);
    assert_eq!(plan.failure_session_id.as_deref(), Some("s1"));
    assert_eq!(plan.health_session_id.as_deref(), Some("s1"));
    let events = [event(
        "recording-encoder-failed",
        HealthLevel::Error,
        Some("s1"),
        "The encoder quit.",
    )];
    let Some(RuntimeRecovery::RecordingFailed { status, activity }) =
        complete_session_runtime_recovery(&plan, &idle, &events, &RecordingState::Recording, None)
    else {
        panic!("a failure");
    };
    assert!(matches!(status.state, RecordingState::Failed));
    assert_eq!(status.session_id.as_deref(), Some("s1"));
    assert_eq!(status.message.as_deref(), Some("The encoder quit."));
    assert_eq!(status.output_path.as_deref(), Some("/tmp/s1.mkv"));
    assert_eq!(activity, SessionActivity::RecordAndStream);

    // A completed row is no failure; an idle prior session has none.
    let rows = [row("s1", "completed", "record", 0)];
    let plan = session_runtime_recovery_plan(&idle, &rows, Some("s1"), &RecordingState::Recording);
    assert_eq!(plan.failure_session_id, None);
    let plan = session_runtime_recovery_plan(
        &idle,
        &[row("s1", "failed", "record", 0)],
        Some("s1"),
        &RecordingState::Idle,
    );
    assert_eq!(plan.failure_session_id, None);
    assert_eq!(session_mode_activity("stream"), SessionActivity::LiveStream);
    assert_eq!(
        session_mode_activity("recording"),
        SessionActivity::Recording
    );
}

#[test]
fn the_running_sessions_lost_inputs_come_back_as_one_notice() {
    let running = live("s2");
    let rows = [row("s2", "running", "record+stream", 3)];
    let plan =
        session_runtime_recovery_plan(&running, &rows, Some("s2"), &RecordingState::Recording);
    assert_eq!(plan.failure_session_id, None);
    assert_eq!(plan.health_session_id.as_deref(), Some("s2"));
    let events = [
        event(
            "microphone-input-lost",
            HealthLevel::Warn,
            Some("s2"),
            "Mic gone.",
        ),
        event(
            "system-audio-lost",
            HealthLevel::Warn,
            Some("s2"),
            "System gone.",
        ),
    ];
    let Some(RuntimeRecovery::MicrophoneLost(lost)) = complete_session_runtime_recovery(
        &plan,
        &running,
        &events,
        &RecordingState::Recording,
        None,
    ) else {
        panic!("a loss");
    };
    assert_eq!(lost.code, "audio-inputs-lost");
    assert_eq!(lost.message, "Mic gone. System gone.");
    let mut notices = SessionNotices::new();
    let mut ctx = context(&running, Some("s2"));
    ctx.activity = SessionActivity::RecordAndStream;
    let commands = notices.microphone_loss(&lost, ctx);
    assert!(shown(&commands).is_empty());
    let notice = notices.microphone_notice().expect("the loss");
    assert_eq!(
        microphone_notice_title(notice),
        "Microphone and system audio lost"
    );
    assert_eq!(notice.message, "Mic gone. System gone.");

    // #1528: a source's own recovery closes its loss, so a reconnect never
    // brings back a problem that already ended.
    let mut closed = events.to_vec();
    closed.push(event(
        "microphone-input-recovered",
        HealthLevel::Info,
        Some("s2"),
        "Mic back.",
    ));
    let Some(RuntimeRecovery::MicrophoneLost(lost)) = complete_session_runtime_recovery(
        &plan,
        &running,
        &closed,
        &RecordingState::Recording,
        None,
    ) else {
        panic!("the system loss is still open");
    };
    assert_eq!(lost.code, "system-audio-lost");
    closed.push(event(
        "system-audio-recovered",
        HealthLevel::Info,
        Some("s2"),
        "System back.",
    ));
    assert!(
        complete_session_runtime_recovery(
            &plan,
            &running,
            &closed,
            &RecordingState::Recording,
            None
        )
        .is_none()
    );
}

#[test]
fn the_conflict_and_playback_toasts() {
    let toast = global_shortcut_conflict("Shortcut unavailable", "Another app uses ⌃⌥H.");
    assert_eq!(toast.id.as_deref(), Some("global-shortcuts-conflict"));
    assert_eq!(toast.kind, NoticeKind::Error);
    // Copy comes after the duration: a described error keeps its 8 s.
    assert_eq!(toast.lifetime, secs(8));
    assert!(matches!(&toast.action, Some(NoticeButton { label, .. }) if label == "Copy"));
    let toast = playback_problem("s1");
    assert_eq!(toast.title, "Couldn't play this recording");
    assert_eq!(toast.id.as_deref(), Some("playback-problem:s1"));
    assert_eq!(
        toast.action,
        button(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: "s1".to_string()
            }
        )
    );
}

#[test]
fn a_clip_press_with_nothing_to_save_says_which_switch() {
    let blocked = nothing_to_clip(ClipsState::Off, true, Some("This Mac encodes in software."));
    assert_eq!(blocked.title, "Clips are off on this computer");
    assert_eq!(
        blocked.description.as_deref(),
        Some("This Mac encodes in software.")
    );
    assert_eq!(blocked.id.as_deref(), Some("clips"));
    let open_output = Some((
        "Open Output",
        &NoticeAction::OpenPage(crate::nav::PageId::Recording),
    ));
    fn door(notice: &Notice) -> Option<(&str, &NoticeAction)> {
        notice
            .action
            .as_ref()
            .map(|button| (button.label.as_str(), &button.action))
    }
    assert_eq!(door(&blocked), open_output);
    let off = nothing_to_clip(ClipsState::Off, false, None);
    assert_eq!(door(&off), open_output);
    assert_eq!(off.title, "Clips are off");
    assert_eq!(
        off.description.as_deref(),
        Some("Turn on Keep the last seconds on the Output page, or start a recording.")
    );
    let starting = nothing_to_clip(ClipsState::Starting, true, None);
    assert_eq!(
        door(&starting),
        None,
        "a ring that is starting needs no door"
    );
    assert_eq!(starting.kind, NoticeKind::Info);
    assert_eq!(starting.title, "Clips are still starting");
    assert_eq!(
        starting.description.as_deref(),
        Some("Try again in a moment.")
    );
    let empty = nothing_to_clip(ClipsState::Error, true, None);
    assert_eq!(empty.title, "Nothing to clip yet");
    assert_eq!(
        empty.description.as_deref(),
        Some("The last seconds are not being kept right now. Start a recording, or go live.")
    );
    let failed = clips_could_not_start("The encoder refused.");
    assert_eq!(failed.title, "Clips couldn't start");
    assert_eq!(failed.lifetime, secs(10));
    assert_eq!(
        clips_stopped(None).description.as_deref(),
        Some("Turn on Keep the last seconds again on the Output page.")
    );
}

#[test]
fn a_source_that_changed_on_its_own_is_named() {
    assert_eq!(source_fallback_title(None), "A source changed");
    assert_eq!(
        source_fallback_title(Some((
            Some(FallbackSource::Camera),
            Some(" FaceTime HD Camera "),
            true
        ))),
        "Camera switched to FaceTime HD Camera"
    );
    assert_eq!(
        source_fallback_title(Some((Some(FallbackSource::Screen), None, true))),
        "Screen switched"
    );
    assert_eq!(
        source_fallback_title(Some((Some(FallbackSource::Microphone), None, false))),
        "Microphone turned off"
    );
    assert_eq!(
        source_fallback_title(Some((None, None, false))),
        "A source turned off"
    );
    let toast = source_fallback_active_session(true, None);
    assert_eq!(
        toast.description.as_deref(),
        Some("Your stream uses it now. Check the output before you continue.")
    );
    assert_eq!(toast.lifetime, secs(10));
    assert_eq!(
        toast.id.as_deref(),
        Some("source-reconciliation:active-session")
    );
    assert_eq!(
        source_fallback_active_session(false, None)
            .description
            .as_deref(),
        Some("Your recording uses it now. Check the output before you continue.")
    );
}

// ── S3.5e: X's playback check ───────────────────────────────────────────

fn x_playback(broadcast: &str, status: &str) -> XPlaybackEvent {
    XPlaybackEvent {
        broadcast_id: broadcast.to_string(),
        status: status.to_string(),
        share_url: "https://x.com/i/broadcasts/1abc".to_string(),
    }
}

#[test]
fn x_playback_says_each_state_once_on_one_toast() {
    let mut notices = SessionNotices::new();
    let now = Instant::now();
    let pending = notices.on_x_playback(&x_playback("b1", "pending"), now);
    let toast = shown(&pending)[0];
    assert_eq!(toast.kind, NoticeKind::Warning);
    assert_eq!(toast.title, "X is still preparing your stream");
    assert_eq!(
        toast.description.as_deref(),
        Some(
            "Viewers may see a loading spinner for a few minutes. Keep streaming. Videorc keeps checking."
        )
    );
    // The backend polls: the same state again is no news.
    assert!(
        notices
            .on_x_playback(&x_playback("b1", "pending"), now)
            .is_empty()
    );
    let verified =
        notices.on_x_playback(&x_playback("b1", "verified"), now + Duration::from_secs(5));
    let watch = shown(&verified)[0];
    assert_eq!(watch.kind, NoticeKind::Success);
    assert_eq!(watch.title, "Viewers can watch your X broadcast");
    assert_eq!(
        watch.description.as_deref(),
        Some("https://x.com/i/broadcasts/1abc")
    );
    // One toast: the verified state replaces the pending one in place.
    assert_eq!(watch.id, toast.id);
    let failed = notices.on_x_playback(&x_playback("b2", "failed"), now + Duration::from_secs(6));
    let never = shown(&failed)[0];
    assert_eq!(never.kind, NoticeKind::Error);
    assert_eq!(never.title, "X never showed your stream");
    assert_eq!(
        never.description.as_deref(),
        Some(
            "Viewers saw a loading spinner. Your local recording is unaffected; the next Go Live uses a replacement source if this repeats."
        )
    );
}
