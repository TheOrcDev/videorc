//! Work that finishes out of view (plan 250 S7, Electron's
//! `lib/notifications/sources/work.ts`). An MP4 export is one entry that
//! runs, then is done or failed; a clean cut, a cloud download and a clip
//! are entries with the button their toast had. Idle, a finished one waits
//! behind the bell; nothing is pinned.

use std::sync::OnceLock;

use regex::Regex;

use super::{Door, HealthPage, Transport, reveal_label};
use crate::notices::types::{Action, ActionKind, Input, ProgressState, Resolution};

/// The MP4 export's running words.
pub const MP4_SAFE: &str =
    "Your recording is safe. Long recordings can take several minutes to save as MP4.";
/// A failed export's words when the reason is not the disk.
pub const MP4_ORIGINAL_SAFE: &str = "Your original recording is safe.";
/// `CLIPS_KEY`.
pub const CLIPS_KEY: &str = "clips";

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

fn reveal() -> Action {
    action("reveal", reveal_label(), ActionKind::Fix)
}

fn open_clips() -> Action {
    action("open-output", "Open Output", ActionKind::Door)
}

fn progress(key: String, state: ProgressState, title: &str) -> Input {
    Input {
        key,
        kind: "mp4".into(),
        progress: Some(state),
        title: title.into(),
        ..Input::default()
    }
}

// --- MP4 export -------------------------------------------------------------

/// `mp4Key`.
pub fn mp4_key(session_id: &str) -> String {
    format!("mp4:{session_id}")
}

/// `publishMp4Finalizing`: the export's progress line ("Saving MP4 · 42%"),
/// an entry with a spinner and no toast.
pub fn mp4_finalizing(session_id: &str, label: &str) -> Input {
    Input {
        detail: Some(MP4_SAFE.into()),
        ..progress(mp4_key(session_id), ProgressState::Running, label)
    }
}

/// `publishMp4Ready`: rebuilt, never merged, so no running words stay.
pub fn mp4_ready(session_id: &str) -> Input {
    Input {
        actions: vec![reveal()],
        ..progress(mp4_key(session_id), ProgressState::Done, "MP4 ready")
    }
}

/// `exportSpaceRefusal` (`lib/user-error.ts`): the backend's no-room
/// refusal of an MP4 export, which says how much and what to do.
pub fn export_space_refusal(raw: Option<&str>) -> Option<String> {
    static REFUSAL: OnceLock<Regex> = OnceLock::new();
    let refusal = REFUSAL.get_or_init(|| {
        Regex::new(
            r"^Not enough disk space to finish the MP4 \(needs [^(),]+, [^(),]+ free\)\. Your recording is safe as MKV; free some space and use Export MP4\.$",
        )
        .expect("export space refusal")
    });
    let reason = raw?.trim();
    (!reason.is_empty() && refusal.is_match(reason)).then(|| reason.to_string())
}

/// `publishMp4ExportFailed`: a refusal for want of disk space says so; any
/// other reason stays in the log.
pub fn mp4_export_failed(session_id: &str, reason: Option<&str>) -> Input {
    Input {
        detail: Some(export_space_refusal(reason).unwrap_or_else(|| MP4_ORIGINAL_SAFE.into())),
        actions: vec![action("retry", "Retry export", ActionKind::Fix)],
        ..progress(
            mp4_key(session_id),
            ProgressState::Failed,
            "MP4 export failed",
        )
    }
}

// --- Clean cut and cloud recordings -----------------------------------------

/// `publishCleanCutReady`.
pub fn clean_cut_ready(job_id: &str, title: &str) -> Input {
    Input {
        key: format!("clean-cut:{job_id}"),
        kind: "work-done".into(),
        title: title.into(),
        detail: Some("The original is kept.".into()),
        actions: vec![action("review", "Review", ActionKind::Door)],
        once: true,
        ..Input::default()
    }
}

/// `publishCleanCutAutoFailed`: quiet on purpose; nothing retries by
/// itself, and Clean cut has Make and Retry.
pub fn clean_cut_auto_failed(session_id: &str, reason: &str) -> Input {
    Input {
        key: format!("clean-cut-auto:{session_id}"),
        kind: "work-failed".into(),
        title: "Your clean cut didn't start".into(),
        detail: Some(reason.into()),
        actions: vec![action("open-clean-cut", "Open Clean cut", ActionKind::Door)],
        once: true,
        ..Input::default()
    }
}

/// `cloudDownloadKey`.
pub fn cloud_download_key(recording_id: &str) -> String {
    format!("cloud-download:{recording_id}")
}

/// `publishCloudDownloadSaved`.
pub fn cloud_download_saved(recording_id: &str) -> Input {
    Input {
        key: cloud_download_key(recording_id),
        kind: "work-done".into(),
        title: "Cloud recording saved".into(),
        actions: vec![reveal()],
        ..Input::default()
    }
}

/// `publishCloudDownloadFailed`: the words the download's error gave.
pub fn cloud_download_failed(recording_id: &str, title: &str, description: Option<&str>) -> Input {
    Input {
        key: cloud_download_key(recording_id),
        kind: "work-failed".into(),
        title: title.into(),
        detail: description.map(str::to_string),
        ..Input::default()
    }
}

// --- Clips ------------------------------------------------------------------

/// `publishClipSaved`: `held` is how much the clip holds ("0:30").
pub fn clip_saved(save_id: &str, complete: bool, held: &str) -> Input {
    Input {
        key: format!("clip:{save_id}"),
        kind: "clip".into(),
        title: "Clip saved".into(),
        detail: Some(if complete {
            format!("Last {held}.")
        } else {
            format!("Last {held}, the buffer was still filling.")
        }),
        actions: vec![reveal()],
        ..Input::default()
    }
}

/// `publishClipSaveFailed`.
pub fn clip_save_failed(save_id: &str, message: &str) -> Input {
    Input {
        key: format!("clip:{save_id}"),
        kind: "clip-failed".into(),
        title: "Couldn't save the clip".into(),
        detail: Some(message.into()),
        ..Input::default()
    }
}

/// `publishClipsStopped`: the ring ended with its session, not by the
/// switch.
pub fn clips_stopped(detail: &str) -> Input {
    Input {
        key: CLIPS_KEY.into(),
        kind: "clips".into(),
        title: "Clips stopped".into(),
        detail: Some(detail.into()),
        actions: vec![open_clips()],
        ..Input::default()
    }
}

/// `publishClipsCouldNotStart`.
pub fn clips_could_not_start(reason: &str) -> Input {
    Input {
        key: CLIPS_KEY.into(),
        kind: "clips".into(),
        title: "Clips couldn't start".into(),
        detail: Some(reason.into()),
        actions: vec![open_clips()],
        ..Input::default()
    }
}

/// `resolveClips`: the ring is keeping the last seconds again. Pass it to
/// `Store::resolve` with [`CLIPS_KEY`].
pub fn clips_on_again() -> Resolution {
    Resolution {
        title: Some("Clips are on again".into()),
        was: Some("They were off".into()),
        ..Resolution::default()
    }
}

// --- Buttons ----------------------------------------------------------------

/// Runs a work entry's button, as the store handed it back
/// (`Store::run_action`). The clip's reveal needs the take the clip came
/// from (`replaySessionId`), which its key does not hold, so the caller
/// passes it. False for a key or a button that is not work's.
pub fn run_action(
    key: &str,
    action_id: &str,
    clip_session: Option<&str>,
    transport: &mut dyn Transport,
    pages: &mut dyn HealthPage,
) -> bool {
    let (prefix, id) = key.split_once(':').unwrap_or((key, ""));
    match (prefix, action_id) {
        ("mp4", "reveal") => transport.reveal_session(id),
        ("mp4", "retry") => transport.retry_mp4_export(id),
        ("clean-cut", "review") => pages.open(Door::CleanCutReview { job_id: id.into() }),
        ("clean-cut-auto", "open-clean-cut") => pages.open(Door::CleanCut {
            session_id: id.into(),
        }),
        ("cloud-download", "reveal") => transport.reveal_cloud_download(id),
        ("clip", "reveal") => match clip_session {
            Some(session) => transport.reveal_session(session),
            None => return false,
        },
        (CLIPS_KEY, "open-output") => pages.open(Door::OutputClips),
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::types::{State, Tone};
    use crate::notices::{Effect, Store};

    fn store() -> Store {
        // The launch is over: these tests are about the idle bell.
        Store::new(0, 0)
    }

    fn entry<'a>(store: &'a Store, key: &str) -> &'a crate::notices::Entry {
        store
            .snapshot()
            .iter()
            .find(|item| item.key == key)
            .expect("entry")
    }

    fn shown(effects: &[Effect]) -> usize {
        effects
            .iter()
            .filter(|effect| matches!(effect, Effect::Show { .. }))
            .count()
    }

    #[test]
    fn an_mp4_export_is_one_entry_a_spinner_then_ready() {
        let mut store = store();
        store.publish(mp4_finalizing("take-1", "Saving MP4 · 12%"), 1_000);
        store.publish(mp4_finalizing("take-1", "Saving MP4 · 98%"), 2_000);
        assert_eq!(store.snapshot().len(), 1);
        let running = entry(&store, "mp4:take-1");
        assert_eq!(running.state, State::Running);
        assert_eq!(running.title, "Saving MP4 · 98%");
        assert_eq!(running.detail.as_deref(), Some(MP4_SAFE));
        assert!(running.actions.is_empty());
        assert_eq!(store.count().unread, 0);

        store.publish(mp4_ready("take-1"), 3_000);
        let ready = entry(&store, "mp4:take-1");
        assert_eq!(ready.state, State::Done);
        assert_eq!(ready.tone, Tone::Done);
        assert_eq!(ready.title, "MP4 ready");
        // E2E 2026-11-01: the running words never stay on "MP4 ready".
        assert_eq!(ready.detail, None);
        assert_eq!(ready.actions, vec![reveal()]);
        // Idle, it waits behind the bell (the owner, 2026-11-22).
        assert_eq!(shown(&store.take_effects()), 0);
        assert_eq!(store.count().unread, 1);
    }

    #[test]
    fn a_failed_export_offers_retry_and_names_only_a_disk_refusal() {
        let refusal = "Not enough disk space to finish the MP4 (needs 4.2 GB, 1.1 GB free). Your recording is safe as MKV; free some space and use Export MP4.";
        assert_eq!(
            export_space_refusal(Some(&format!(" {refusal} "))).as_deref(),
            Some(refusal)
        );
        assert_eq!(export_space_refusal(Some("ffmpeg exited 1")), None);
        assert_eq!(export_space_refusal(Some("  ")), None);
        assert_eq!(export_space_refusal(None), None);

        let mut store = store();
        store.publish(mp4_export_failed("take-2", Some("ffmpeg exited 1")), 1_000);
        let failed = entry(&store, "mp4:take-2");
        assert_eq!(failed.state, State::Failed);
        assert_eq!(failed.tone, Tone::Warning);
        assert_eq!(failed.title, "MP4 export failed");
        assert_eq!(failed.detail.as_deref(), Some(MP4_ORIGINAL_SAFE));
        assert_eq!(
            failed.actions,
            vec![action("retry", "Retry export", ActionKind::Fix)]
        );
        store.publish(mp4_export_failed("take-3", Some(refusal)), 1_000);
        assert_eq!(entry(&store, "mp4:take-3").detail.as_deref(), Some(refusal));
    }

    #[test]
    fn clean_cut_cloud_and_clip_entries_keep_their_toasts_button() {
        let mut store = store();
        store.publish(clean_cut_ready("job-1", "Clean cut ready"), 1_000);
        let ready = entry(&store, "clean-cut:job-1");
        assert_eq!(ready.kind, "work-done");
        assert_eq!(ready.detail.as_deref(), Some("The original is kept."));
        assert_eq!(ready.actions[0].kind, ActionKind::Door);

        store.publish(clean_cut_auto_failed("take-1", "No speech found."), 1_000);
        let failed = entry(&store, "clean-cut-auto:take-1");
        assert_eq!(failed.title, "Your clean cut didn't start");
        assert_eq!(failed.actions[0].label, "Open Clean cut");

        store.publish(cloud_download_saved("rec-1"), 1_000);
        assert_eq!(
            entry(&store, "cloud-download:rec-1").title,
            "Cloud recording saved"
        );
        // Another recording: a second event on rec-1's key would be a
        // repeat and read "Twice. Disk full" (`repeatWords`, as Electron).
        store.publish(
            cloud_download_failed("rec-2", "Couldn't download", Some("Disk full")),
            2_000,
        );
        let download = entry(&store, "cloud-download:rec-2");
        assert_eq!(download.kind, "work-failed");
        assert_eq!(download.detail.as_deref(), Some("Disk full"));

        store.publish(clip_saved("s-1", true, "0:30"), 1_000);
        assert_eq!(
            entry(&store, "clip:s-1").detail.as_deref(),
            Some("Last 0:30.")
        );
        store.publish(clip_saved("s-2", false, "0:12"), 1_000);
        assert_eq!(
            entry(&store, "clip:s-2").detail.as_deref(),
            Some("Last 0:12, the buffer was still filling.")
        );
        store.publish(clip_save_failed("s-3", "The ring was empty."), 1_000);
        assert_eq!(entry(&store, "clip:s-3").title, "Couldn't save the clip");
    }

    #[test]
    fn clips_is_a_condition_that_resolves_when_the_ring_is_back() {
        let mut store = store();
        store.publish(clips_stopped("The recording ended."), 1_000);
        let stopped = entry(&store, CLIPS_KEY);
        assert_eq!(stopped.state, State::Open);
        assert_eq!(stopped.actions, vec![open_clips()]);
        store.publish(clips_could_not_start("No source."), 2_000);
        assert_eq!(entry(&store, CLIPS_KEY).title, "Clips couldn't start");
        store.resolve(CLIPS_KEY, clips_on_again(), 40_000);
        let back = entry(&store, CLIPS_KEY);
        assert_eq!(back.state, State::Resolved);
        assert_eq!(back.title, "Clips are on again");
    }

    #[derive(Default)]
    struct Studio {
        calls: Vec<String>,
    }

    impl Transport for Studio {
        fn reveal_session(&mut self, session_id: &str) {
            self.calls.push(format!("reveal {session_id}"));
        }
        fn retry_mp4_export(&mut self, session_id: &str) {
            self.calls.push(format!("retry {session_id}"));
        }
        fn reveal_cloud_download(&mut self, recording_id: &str) {
            self.calls.push(format!("download {recording_id}"));
        }
        fn use_returned_source(&mut self, key: &str) {
            self.calls.push(format!("use {key}"));
        }
        fn resume_system_audio(&mut self) {
            self.calls.push("resume".into());
        }
    }

    impl HealthPage for Studio {
        fn open(&mut self, door: Door) {
            self.calls.push(format!("{door:?}"));
        }
    }

    #[test]
    fn a_pressed_button_reaches_the_studio() {
        let mut transport = Studio::default();
        let mut pages = Studio::default();
        let mut run = |key: &str, id: &str, clip: Option<&str>| {
            run_action(key, id, clip, &mut transport, &mut pages)
        };
        assert!(run("mp4:take-1", "reveal", None));
        assert!(run("mp4:take-1", "retry", None));
        assert!(run("cloud-download:rec-1", "reveal", None));
        assert!(run("clip:s-1", "reveal", Some("ring-1")));
        assert!(!run("clip:s-1", "reveal", None));
        assert!(run("clean-cut:job-1", "review", None));
        assert!(run("clean-cut-auto:take-1", "open-clean-cut", None));
        assert!(run(CLIPS_KEY, "open-output", None));
        assert!(!run("microphone", "reveal", None));
        assert_eq!(
            transport.calls,
            [
                "reveal take-1",
                "retry take-1",
                "download rec-1",
                "reveal ring-1"
            ]
        );
        assert_eq!(
            pages.calls,
            [
                "CleanCutReview { job_id: \"job-1\" }",
                "CleanCut { session_id: \"take-1\" }",
                "OutputClips"
            ]
        );
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const WORK: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/work.ts"
        );
        for words in [
            MP4_SAFE,
            MP4_ORIGINAL_SAFE,
            "'MP4 ready'",
            "'MP4 export failed'",
            "'Retry export'",
            "'The original is kept.'",
            "\"Your clean cut didn't start\"",
            "'Open Clean cut'",
            "'Cloud recording saved'",
            "'Clip saved'",
            "`Last ${held}.`",
            "`Last ${held}, the buffer was still filling.`",
            "\"Couldn't save the clip\"",
            "'Open Output'",
            "'Clips stopped'",
            "\"Clips couldn't start\"",
            "'Clips are on again'",
            "'They were off'",
            "CLIPS_KEY = 'clips'",
            "`mp4:${sessionId}`",
            "`clean-cut:${job.id}`",
            "`clean-cut-auto:${sessionId}`",
            "`cloud-download:${recordingId}`",
            "`clip:${event.saveId}`",
        ] {
            assert!(WORK.contains(words), "work.ts lacks {words}");
        }
        const USER_ERROR: &str =
            include_str!("../../../../../apps/desktop/src/renderer/src/lib/user-error.ts");
        assert!(USER_ERROR.contains(
            r"/^Not enough disk space to finish the MP4 \(needs [^(),]+, [^(),]+ free\)\. Your recording is safe as MKV; free some space and use Export MP4\.$/"
        ));
    }
}
