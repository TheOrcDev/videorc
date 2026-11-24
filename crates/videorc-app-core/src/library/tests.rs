//! `library-view.test.ts`, `session-finalization.test.ts` and
//! `separate-source-recordings-view.test.ts`'s cases.

use std::collections::BTreeSet;

use serde_json::{Value, json};
use videorc_protocol::repair::GateStatus;
use videorc_protocol::{
    RecordingFinalizationEvent, RecordingFinalizationState, RecordingState, RecordingStatus,
    SessionListItem, SessionLogEntry,
};

use super::view::*;

fn session(overrides: Value) -> SessionListItem {
    let mut base = json!({
        "id": "id",
        "title": "Weekly Dev Update",
        "startedAt": "2026-07-01T10:00:00Z",
        "status": "completed",
        "mode": "record",
        "healthEventCount": 0,
        "sessionLogCount": 0,
        "aiArtifactCount": 0,
        "commentCount": 0
    });
    for (key, value) in overrides.as_object().unwrap() {
        base[key] = value.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn ids(rows: &[&SessionListItem]) -> Vec<String> {
    rows.iter().map(|row| row.id.clone()).collect()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn filters_by_mode_family_and_searches_titles() {
    let sessions = vec![
        session(json!({"id": "a", "mode": "record", "title": "Weekly Dev Update"})),
        session(json!({"id": "b", "mode": "stream", "title": "Community Q&A"})),
        session(json!({"id": "c", "mode": "record+stream", "title": "Behind the Build"})),
        session(json!({"id": "d", "mode": "imported", "title": "Conference Talk"})),
    ];
    assert_eq!(
        ids(&filter_sessions(&sessions, LibraryFilter::Recordings, "")),
        ["a", "c", "d"]
    );
    assert_eq!(
        ids(&filter_sessions(&sessions, LibraryFilter::Streams, "")),
        ["b", "c"]
    );
    assert_eq!(filter_sessions(&sessions, LibraryFilter::All, "").len(), 4);
    assert_eq!(
        ids(&filter_sessions(&sessions, LibraryFilter::All, "community")),
        ["b"]
    );
    assert_eq!(
        ids(&filter_sessions(
            &sessions,
            LibraryFilter::Recordings,
            "BUILD"
        )),
        ["c"]
    );
    let older = vec![
        session(json!({"id": "old-recording", "mode": "recording"})),
        session(json!({"id": "old-stream", "mode": "streaming"})),
    ];
    assert_eq!(
        ids(&filter_sessions(&older, LibraryFilter::Recordings, "")),
        ["old-recording"]
    );
    assert_eq!(
        ids(&filter_sessions(&older, LibraryFilter::Streams, "")),
        ["old-stream"]
    );
}

#[test]
fn sorts_by_start_both_ways() {
    let rows = [
        session(json!({"id": "old", "startedAt": "2026-06-01T00:00:00Z"})),
        session(json!({"id": "new", "startedAt": "2026-07-01T00:00:00Z"})),
    ];
    let all: Vec<&SessionListItem> = rows.iter().collect();
    assert_eq!(sort_sessions(all.clone(), LibrarySort::Newest)[0].id, "new");
    assert_eq!(sort_sessions(all, LibrarySort::Oldest)[0].id, "old");
}

#[test]
fn names_the_visible_file_and_builds_the_poster_path() {
    assert_eq!(
        session_format_label(&session(json!({"mp4Path": "/x.mp4"}))).as_deref(),
        Some("MP4")
    );
    assert_eq!(
        session_format_label(&session(json!({"container": "mkv"}))).as_deref(),
        Some("MKV")
    );
    assert_eq!(
        session_format_label(&session(json!({"container": "tee"}))).as_deref(),
        Some("MKV + stream")
    );
    assert_eq!(session_format_label(&session(json!({}))), None);
    let path = poster_path("ab/12", "tok", Some(9000));
    assert!(path.starts_with("/sessions/ab%2F12/poster?"), "{path}");
    assert!(path.contains("token=tok"));
    assert!(path.contains("v=9000"));
}

#[test]
fn toggles_one_id_and_select_all_over_the_visible_set() {
    assert_eq!(toggle_selection(&[], "a"), ["a"]);
    assert!(toggle_selection(&strings(&["a"]), "a").is_empty());
    assert_eq!(toggle_all_selection(&[], &strings(&["a", "b"])), ["a", "b"]);
    assert!(toggle_all_selection(&strings(&["a", "b"]), &strings(&["a", "b"])).is_empty());
    assert_eq!(
        toggle_all_selection(&strings(&["a"]), &strings(&["a", "b"])),
        ["a", "b"]
    );
    assert!(toggle_all_selection(&strings(&["a"]), &[]).is_empty());
}

fn status(state: RecordingState, session_id: Option<&str>) -> RecordingStatus {
    serde_json::from_value(json!({
        "state": match state {
            RecordingState::Idle => "idle",
            RecordingState::Starting => "starting",
            RecordingState::Recording => "recording",
            RecordingState::Streaming => "streaming",
            RecordingState::Stopping => "stopping",
            RecordingState::Failed => "failed",
        },
        "sessionId": session_id,
    }))
    .unwrap()
}

#[test]
fn is_live_only_for_the_running_row_of_the_active_capture() {
    let row = session(json!({"id": "live-1", "status": "running"}));
    for state in [
        RecordingState::Recording,
        RecordingState::Streaming,
        RecordingState::Stopping,
    ] {
        assert!(is_live_session(&row, &status(state, Some("live-1"))));
    }
    assert!(!is_live_session(
        &row,
        &status(RecordingState::Recording, Some("other"))
    ));
    assert!(!is_live_session(
        &row,
        &status(RecordingState::Idle, Some("live-1"))
    ));
    assert!(!is_live_session(
        &session(json!({"id": "live-1", "status": "completed"})),
        &status(RecordingState::Recording, Some("live-1"))
    ));
}

#[test]
fn states_real_totals_and_free_space() {
    let gib = 1024_i64.pow(3);
    assert_eq!(
        storage_label(32, 175 * gib, Some(500 * gib)),
        "32 recordings · 175 GB · 500 GB free"
    );
    assert_eq!(storage_label(1, 0, None), "1 recording · 0 B");
    assert_eq!(format_bytes(Some(269_312.0)), "263 KB");
    assert_eq!(format_bytes(Some((1023 * 1024 + 1000) as f64)), "1 MB");
    assert_eq!(format_bytes(None), "-");
    assert_eq!(duration_ms_label(Some(3_400)), "0:03");
    assert_eq!(duration_ms_label(None), "–");
    assert_eq!(plural(1204, "viewer", None), "1,204 viewers");
}

#[test]
fn what_the_list_shows() {
    assert_eq!(list_state(0, false, true), ListState::Loading);
    assert_eq!(list_state(0, false, false), ListState::Offline);
    assert_eq!(list_state(0, true, false), ListState::Offline);
    assert_eq!(list_state(0, true, true), ListState::Empty);
    assert_eq!(list_state(3, false, false), ListState::Rows);
    let notice = |query: &str, filter, sort, more| partial_notice(50, more, filter, query, sort);
    assert_eq!(
        notice("", LibraryFilter::All, LibrarySort::Newest, true),
        None
    );
    assert_eq!(
        notice("rust", LibraryFilter::All, LibrarySort::Newest, true).as_deref(),
        Some("Searched the 50 newest recordings.")
    );
    assert_eq!(
        notice("", LibraryFilter::Streams, LibrarySort::Newest, true).as_deref(),
        Some("Filtered the 50 newest recordings.")
    );
    assert_eq!(
        notice("", LibraryFilter::All, LibrarySort::Oldest, true).as_deref(),
        Some("Sorted the 50 newest recordings.")
    );
    assert_eq!(
        notice("rust", LibraryFilter::All, LibrarySort::Newest, false),
        None
    );
    assert_eq!(
        notice("   ", LibraryFilter::All, LibrarySort::Newest, true),
        None
    );
    assert_eq!(clear_label(LibraryFilter::All, "rust"), "Clear search");
    assert_eq!(clear_label(LibraryFilter::Streams, ""), "Clear filter");
    assert_eq!(
        clear_label(LibraryFilter::Streams, "rust"),
        "Clear search and filter"
    );
    assert_eq!(library_title("  "), "Untitled recording");
    assert_eq!(library_title("Rust tutorial"), "Rust tutorial");
}

#[test]
fn desktop_selection_picks_moves_and_keys() {
    let ordered = strings(&["a", "b", "c", "d", "e"]);
    let selectable: BTreeSet<String> = strings(&["a", "b", "d", "e"]).into_iter().collect();
    let pick = |selected: &[&str], anchor: Option<&str>, id: &str, modifier| {
        pick_row(
            &Selection {
                selected: strings(selected),
                anchor: anchor.map(str::to_string),
            },
            id,
            modifier,
            &ordered,
            &selectable,
        )
    };
    let replace = pick(&["a", "b"], Some("a"), "d", PickModifier::Replace);
    assert_eq!(replace.selected, ["d"]);
    assert_eq!(replace.anchor.as_deref(), Some("d"));
    let locked = pick(&["a"], Some("a"), "c", PickModifier::Replace);
    assert!(locked.selected.is_empty());
    assert_eq!(locked.anchor.as_deref(), Some("c"));
    assert_eq!(
        pick(&["a"], Some("a"), "d", PickModifier::Toggle).selected,
        ["a", "d"]
    );
    assert_eq!(
        pick(&["a", "d"], Some("d"), "a", PickModifier::Toggle).selected,
        ["d"]
    );
    assert_eq!(
        pick(&["a"], Some("a"), "c", PickModifier::Toggle).selected,
        ["a"]
    );
    assert_eq!(
        pick(&["a"], Some("a"), "e", PickModifier::Range).selected,
        ["a", "b", "d", "e"]
    );
    assert_eq!(
        pick(&[], Some("e"), "b", PickModifier::Range).selected,
        ["b", "d", "e"]
    );
    let first = pick(&[], None, "b", PickModifier::Range);
    assert_eq!(first.selected, ["b"]);
    assert_eq!(first.anchor.as_deref(), Some("b"));
    assert_eq!(pick_modifier(false, false), PickModifier::Replace);
    assert_eq!(pick_modifier(false, true), PickModifier::Toggle);
    assert_eq!(pick_modifier(true, true), PickModifier::Range);

    let step = |active: Option<&str>, step| row_after_move(&ordered, active, step);
    assert_eq!(step(Some("b"), RowMove::Next).as_deref(), Some("c"));
    assert_eq!(step(Some("b"), RowMove::Previous).as_deref(), Some("a"));
    assert_eq!(step(Some("a"), RowMove::Previous).as_deref(), Some("a"));
    assert_eq!(step(Some("e"), RowMove::Next).as_deref(), Some("e"));
    assert_eq!(step(Some("c"), RowMove::First).as_deref(), Some("a"));
    assert_eq!(step(Some("c"), RowMove::Last).as_deref(), Some("e"));
    assert_eq!(step(None, RowMove::Next).as_deref(), Some("a"));
    assert_eq!(row_after_move(&[], Some("a"), RowMove::Next), None);

    assert_eq!(
        key_command("ArrowDown", false, false, false),
        Some(KeyCommand::Move {
            step: RowMove::Next,
            extend: false
        })
    );
    assert_eq!(
        key_command("ArrowUp", true, false, false),
        Some(KeyCommand::Move {
            step: RowMove::Previous,
            extend: true
        })
    );
    assert_eq!(
        key_command(" ", false, false, false),
        Some(KeyCommand::Toggle)
    );
    assert_eq!(
        key_command("Enter", false, false, false),
        Some(KeyCommand::Rename)
    );
    assert_eq!(
        key_command("Escape", false, false, false),
        Some(KeyCommand::Clear)
    );
    assert_eq!(
        key_command("Backspace", false, true, false),
        Some(KeyCommand::Delete)
    );
    assert_eq!(
        key_command("Delete", false, false, false),
        Some(KeyCommand::Delete)
    );
    assert_eq!(key_command("Backspace", false, false, false), None);
    assert_eq!(
        key_command("a", false, true, false),
        Some(KeyCommand::SelectAll)
    );
    assert_eq!(key_command("ArrowDown", false, false, true), None);
    assert_eq!(key_command("k", false, false, false), None);

    let in_view: BTreeSet<String> = strings(&["a", "b"]).into_iter().collect();
    assert_eq!(
        prune_selection(&strings(&["a", "x", "b"]), &in_view),
        ["a", "b"]
    );
    assert_eq!(
        select_all_state(&[], &strings(&["a", "b"])),
        SelectAllState::None
    );
    assert_eq!(
        select_all_state(&strings(&["a"]), &strings(&["a", "b"])),
        SelectAllState::Some
    );
    assert_eq!(
        select_all_state(&strings(&["b", "a"]), &strings(&["a", "b"])),
        SelectAllState::All
    );
    let titles = strings(&["One", "Two", "", "Four", "Five", "Six", "Seven"]);
    let (names, more) = delete_names(&titles);
    assert_eq!(names, ["One", "Two", "Untitled recording", "Four", "Five"]);
    assert_eq!(more, 2);
}

#[test]
fn the_quality_chip_is_quiet_when_fine() {
    assert_eq!(quality_chip(None), None);
    assert_eq!(
        quality_chip(Some(&GateStatus::Ready {
            path: "/x.mp4".into(),
            sampled: true
        })),
        None
    );
    assert_eq!(
        quality_chip(Some(&GateStatus::Repaired {
            path: "/x.mp4".into(),
            interpolated: false
        })),
        None
    );
    let issues = |sampled| {
        quality_chip(Some(&GateStatus::NotHundredPercent {
            path: "/x.mp4".into(),
            reasons: vec!["frames".into()],
            needs_attention: false,
            sampled,
        }))
        .unwrap()
    };
    assert_eq!(issues(false).label, "Quality issues");
    assert!(issues(true).detail.contains("Quick check (long recording)"));
    assert!(!issues(false).detail.contains("Quick check"));
    let failed = quality_chip(Some(&GateStatus::Failed {
        path: "/x.mp4".into(),
        reason: "ffprobe: EOF".into(),
    }))
    .unwrap();
    assert_eq!(failed.label, "Not checked");
    assert!(!failed.detail.contains("ffprobe"));
}

fn finalization(session_id: &str, state: RecordingFinalizationState) -> RecordingFinalizationEvent {
    RecordingFinalizationEvent {
        session_id: session_id.to_string(),
        state,
        progress_percent: None,
        mp4_path: None,
        output_path: None,
        duration_ms: None,
        file_size_bytes: None,
        error: None,
        interruption_recovery: None,
        updated_at: "2026-11-12T10:00:00Z".to_string(),
    }
}

#[test]
fn finalization_patches_rows_and_journals_late_pages() {
    let finalizing =
        session(json!({"finalizationState": "finalizing", "finalizationProgressPercent": 40}));
    assert!(is_finalizing(&finalizing));
    assert_eq!(finalizing_badge_label(Some(40)), "Saving MP4 · 40%");
    assert_eq!(finalizing_badge_label(None), "Saving MP4…");
    assert_eq!(finalizing_badge_label(Some(100)), "Saving MP4…");

    let mut rows = vec![session(
        json!({"id": "s1", "outputPath": "/a.mkv", "finalizationState": "finalizing"}),
    )];
    let mut done = finalization("s1", RecordingFinalizationState::Finalized);
    done.mp4_path = Some("/a.mp4".into());
    done.file_size_bytes = Some(4096);
    done.duration_ms = Some(3000);
    done.interruption_recovery = Some("recovered".into());
    assert!(apply_finalization_event(&mut rows, &done));
    assert_eq!(rows[0].mp4_path.as_deref(), Some("/a.mp4"));
    assert_eq!(rows[0].file_size_bytes, Some(4096));
    assert_eq!(rows[0].finalization_progress_percent, None);
    assert_eq!(interrupted_take_badge(&rows[0]).unwrap().label, "Recovered");
    assert!(!apply_finalization_event(
        &mut rows,
        &finalization("other", RecordingFinalizationState::Finalized)
    ));
    assert!(finalization_event_needs_refresh(
        &rows,
        &finalization("other", RecordingFinalizationState::Finalized)
    ));
    assert!(!finalization_event_needs_refresh(
        &rows,
        &finalization("other", RecordingFinalizationState::Finalizing)
    ));

    // A page asked for before the event lands after it: the event wins.
    let mut journal = FinalizationJournal::default();
    let checkpoint = journal.checkpoint();
    journal.record(&done);
    let mut late = vec![session(
        json!({"id": "s1", "outputPath": "/a.mkv", "finalizationState": "finalizing"}),
    )];
    journal.reconcile(&mut late, checkpoint);
    assert_eq!(late[0].mp4_path.as_deref(), Some("/a.mp4"));
    let mut later = vec![session(
        json!({"id": "s1", "finalizationState": "finalizing"}),
    )];
    journal.reconcile(&mut later, journal.checkpoint());
    assert!(is_finalizing(&later[0]));
}

fn log(code: &str, message: &str) -> SessionLogEntry {
    serde_json::from_value(json!({
        "id": "l1", "sessionId": "s1", "level": "error", "code": code,
        "message": message, "sourceId": null, "permissionPane": null,
        "createdAt": "2026-11-12T10:00:00Z"
    }))
    .unwrap()
}

#[test]
fn a_refused_record_badges_its_row_from_its_log() {
    let row = session(json!({"status": "failed", "sessionLogCount": 2}));
    assert!(may_be_start_failed(&row));
    assert_eq!(start_failed_badge(&row, None), None);
    let badge = start_failed_badge(
        &row,
        Some(&[log(
            "session-start-failed",
            "Record was refused; the session was marked failed: No screen chosen.",
        )]),
    )
    .unwrap();
    assert_eq!(badge.label, "Didn't start");
    assert_eq!(
        badge.detail,
        "This recording stopped before it started, so there is no file. No screen chosen."
    );
    let plain = start_failed_badge(&row, Some(&[log("session-start-failed", "refused")])).unwrap();
    assert_eq!(
        plain.detail,
        "This recording stopped before it started, so there is no file."
    );
    assert_eq!(start_failed_badge(&row, Some(&[log("other", "x")])), None);
    let with_file = session(json!({"status": "failed", "sessionLogCount": 2, "mp4Path": "/x.mp4"}));
    assert!(!may_be_start_failed(&with_file));
}

#[test]
fn a_stopped_separate_file_says_what_it_kept() {
    let row = |overrides: Value| {
        let mut base = json!({
            "recordingRole": "camera",
            "finalizationState": "failed",
            "finalizationError": "camera capture failed after source recovery",
            "durationMs": 61_000,
            "status": "completed",
            "outputPath": "/c.mkv"
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        session(base)
    };
    let stopped = separate_file_stopped(&row(json!({}))).unwrap();
    assert_eq!(stopped.label, "Stopped early");
    assert_eq!(
        stopped.detail,
        "The camera stopped sending video and couldn't be restarted. The first 1:01 is kept."
    );
    assert!(stopped.exportable);
    assert!(can_export_mp4(&row(json!({}))));
    let short = separate_file_stopped(&row(json!({"durationMs": 400}))).unwrap();
    assert!(!short.exportable);
    assert!(!can_export_mp4(&row(json!({"durationMs": 400}))));
    let missing = separate_file_stopped(&row(
        json!({"finalizationError": "the file was missing after stop"}),
    ))
    .unwrap();
    assert_eq!(missing.label, "Not saved");
    assert_eq!(
        separate_file_stopped(&row(json!({"recordingRole": "combined"}))),
        None
    );
    assert_eq!(recording_role_label("screen"), Some("Screen"));
    assert_eq!(
        recording_role_row_note("camera"),
        Some("camera, microphone track")
    );
}

/// Electron since the `videorc-rust` sync: cloud shows and cloud recordings
/// count (efa5872ea, d3f6a6dcb); an imported .mov reads MOV and an imported
/// .MKV exports MP4 (57dbfabb1).
#[test]
fn cloud_modes_mov_imports_and_upper_case_mkv() {
    assert!(session_mode_streamed("cloud-stream"));
    assert!(session_mode_recorded("cloud-recording"));
    assert!(!session_mode_recorded("cloud-stream"));
    let show = session(json!({"mode": "cloud-stream", "streamPreset": "1080p30"}));
    assert_eq!(
        session_format_label(&show).as_deref(),
        Some("Cloud show · 1080p30")
    );
    let room = session(json!({"mode": "cloud-room"}));
    assert_eq!(session_format_label(&room).as_deref(), Some("Cloud show"));
    let mov = session(json!({"mode": "imported", "mp4Path": "/m/Clip.MOV"}));
    assert_eq!(session_format_label(&mov).as_deref(), Some("MOV"));
    let mkv = session(json!({"mode": "imported", "outputPath": "/m/Take.MKV"}));
    assert!(can_export_mp4(&mkv));
}
