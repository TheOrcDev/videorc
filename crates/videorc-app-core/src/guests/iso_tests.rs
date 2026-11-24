//! Ported from `lib/cloud-iso-view.test.ts`, on the shared fixture
//! `protocol-fixtures/cloud-source-iso.json`.

use super::*;

fn fixture_manifest() -> Value {
    let path = format!(
        "{}/../../protocol-fixtures/cloud-source-iso.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fixture["valid"].clone()
}

fn ann() -> RoomGuest {
    RoomGuest {
        guest_id: "g_ann".into(),
        name: "Ann".into(),
        ..RoomGuest::default()
    }
}

#[test]
fn limits_and_cost_say_the_worst_case_in_dollars() {
    assert_eq!(
        iso_limits_line(ISO_DEFAULT_LIMITS),
        "Up to 12 files at once, for up to 2 hours."
    );
    assert_eq!(
        iso_limits_line(IsoLimits {
            max_active_entries: 1,
            max_minutes: 45
        }),
        "Up to 1 file at once, for up to 45 minutes."
    );
    assert_eq!(
        iso_cost_line(ISO_DEFAULT_LIMITS, ISO_MICROS_PER_FILE_MINUTE),
        "Estimated cost: up to $1.44 (12 files × 120 minutes at $0.001 a minute, the published price). An estimate, not a bill."
    );
    assert_eq!(format_usd_micros(0.0), "$0.00");
    assert_eq!(format_usd_micros(2_500.0), "$0.003");
    assert_eq!(format_usd_micros(1_234_567.0), "$1.23");
    let params =
        iso_enable_params("sh_talk", ISO_DEFAULT_LIMITS, ISO_MICROS_PER_FILE_MINUTE).unwrap();
    assert!(params.consent);
    assert_eq!(params.cost_ceiling_micros, 1_440_000);
    // The backend's `IsoEnableParams` takes the ceiling as a `u64`: the
    // request carries a JSON integer, as Electron's JSON.stringify did,
    // never `1440000.0`.
    let wire = serde_json::to_value(&params).unwrap();
    assert_eq!(
        wire,
        serde_json::json!({
            "showId": "sh_talk",
            "consent": true,
            "maxActiveEntries": 12,
            "maxMinutes": 120,
            "costCeilingMicros": 1_440_000
        })
    );
    assert!(wire["costCeilingMicros"].is_u64());
    assert_eq!(iso_ceiling_micros(1_440_000.4), Some(1_440_001));
    assert_eq!(iso_ceiling_micros(0.0), Some(0));
    assert_eq!(iso_ceiling_micros(-1.0), None);
    assert_eq!(iso_ceiling_micros(f64::NAN), None);
    assert_eq!(iso_ceiling_micros(f64::INFINITY), None);
    assert_eq!(iso_ceiling_micros(1e30), None);
    assert_eq!(
        iso_enable_params("sh_talk", ISO_DEFAULT_LIMITS, f64::NAN),
        None
    );
    // The web's published price wins when it sends one.
    let availability: IsoAvailability = serde_json::from_value(serde_json::json!({
        "enabled": true,
        "productionQualified": true,
        "provider": { "adapter": "x", "sdkSupport": "y", "facts": { "microsPerTrackEgressMinute": 2000 } }
    }))
    .unwrap();
    assert_eq!(iso_micros_per_file_minute(Some(&availability)), 2_000.0);
    assert_eq!(iso_micros_per_file_minute(None), ISO_MICROS_PER_FILE_MINUTE);
}

#[test]
fn turn_on_says_why_it_waits() {
    let gate =
        |offline: bool, room_open: bool, answer: Option<&IsoAnswer>, error_code: Option<&str>| {
            iso_enable_blocked_reason(IsoRoomGate {
                offline,
                room_open,
                answer,
                error_code,
            })
        };
    assert_eq!(gate(true, true, None, None), Some(OFFLINE_LOCK_REASON));
    assert_eq!(gate(false, false, None, None), Some(ISO_OPEN_ROOM_FIRST));
    assert_eq!(
        gate(false, true, None, Some("cloud-iso-plan")),
        Some(ISO_NOT_ON_PLAN)
    );
    assert_eq!(gate(false, true, None, None), Some(ISO_CHECKING));
    assert_eq!(
        gate(false, true, None, Some("other")),
        Some(ISO_NOT_AVAILABLE)
    );
    let unqualified = IsoAnswer::default();
    assert_eq!(
        gate(false, true, Some(&unqualified), None),
        Some(ISO_NOT_AVAILABLE)
    );
    let ready = IsoAnswer {
        availability: IsoAvailability {
            enabled: true,
            production_qualified: true,
            ..IsoAvailability::default()
        },
        iso: None,
    };
    assert_eq!(gate(false, true, Some(&ready), None), None);
    assert_eq!(
        iso_error_text(Some("cloud-iso-plan")),
        Some(ISO_NOT_ON_PLAN)
    );
    assert_eq!(iso_error_text(Some("unknown")), None);
    assert_eq!(iso_error_text(None), None);
}

#[test]
fn takes_read_through_the_strict_parser_and_an_unreadable_one_stays_listed() {
    let valid = fixture_manifest();
    let mut broken = valid.clone();
    broken["entries"][3]["role"] = Value::from("host-microphone");
    let status = IsoStatus {
        takes: vec![
            IsoTakeWire {
                manifest: valid,
                program_recording_id: "rec-1".into(),
            },
            IsoTakeWire {
                manifest: broken,
                program_recording_id: "rec-2".into(),
            },
        ],
        ..IsoStatus::default()
    };
    let takes = iso_parsed_takes(Some(&status));
    assert_eq!(takes.len(), 2);
    assert!(takes[0].take.is_some());
    assert!(takes[1].take.is_none());
    assert_eq!(takes[1].program_recording_id, "rec-2");
    let current = iso_current_take(&takes).unwrap();
    assert_eq!(current.manifest.take_id, "tk_AbCdEf123456");
    // Stopped by the take's end: no stop note. Two sources were refused.
    assert_eq!(
        iso_take_notes(current),
        vec![
            "2 sources weren't recorded separately: a guest who hasn't agreed, or audio Videorc can't tell apart."
                .to_string()
        ]
    );
    let budget = IsoTake {
        stop_reason: Some("budget-exhausted".into()),
        refused: 1,
        ..current.clone()
    };
    assert_eq!(
        iso_take_notes(&budget)[0],
        "Separate files stopped: the cost limit was reached."
    );
    assert!(iso_take_notes(&budget)[1].starts_with("1 source wasn't"));
}

#[test]
fn the_rooms_list_names_each_file_the_host_first() {
    let take = iso_parse_take(&fixture_manifest()).unwrap();
    let rows = iso_room_rows(&take.manifest, &[ann()]);
    let titles: Vec<&str> = rows.iter().map(|row| row.title.as_str()).collect();
    assert_eq!(
        titles,
        vec![
            "Your camera",
            "Your microphone",
            "Your microphone (part 2)",
            "Your show sounds",
            "Ann's camera",
            "Ann's microphone",
        ]
    );
    assert_eq!(rows[0].status, word("Saved", Tone::Good));
    assert_eq!(rows[4].status, word("Partial", Tone::Warn));
    assert_eq!(rows[4].detail, Some("Reached the cloud's time limit"));
    assert_eq!(rows[5].status, word("Failed", Tone::Error));
    assert_eq!(rows[5].detail, Some("Couldn't start"));
    // A guest the room no longer names.
    assert_eq!(
        iso_room_rows(&take.manifest, &[])[4].title,
        "A guest's camera"
    );
}

#[test]
fn guests_say_whether_they_agreed_and_refusals_have_words() {
    let bo = RoomGuest {
        guest_id: "g_bo".into(),
        name: "Bo".into(),
        ..RoomGuest::default()
    };
    let rows = iso_guest_consent_rows(
        &[ann(), bo],
        &[IsoGuestConsent {
            identity: "g_ann".into(),
            at_ms: 1,
        }],
    );
    assert!(rows[0].agreed);
    assert_eq!(rows[0].status, word("Agreed", Tone::Good));
    assert_eq!(rows[1].status, word("Hasn't agreed", Tone::Neutral));
    let refused = |reason: &str| IsoStatus {
        last_refusal: Some(IsoRefusal {
            reason: reason.into(),
            ..IsoRefusal::default()
        }),
        ..IsoStatus::default()
    };
    assert_eq!(
        iso_refusal_text(Some(&refused("no-program-take"))).as_deref(),
        Some("Separate files start once the show is recording.")
    );
    assert_eq!(
        iso_refusal_text(Some(&refused("odd"))).as_deref(),
        Some("Separate files couldn't start for this recording (odd).")
    );
    assert_eq!(iso_refusal_text(Some(&IsoStatus::default())), None);
}

#[test]
fn the_library_lists_every_file_importable_or_not() {
    let take = iso_parse_take(&fixture_manifest()).unwrap();
    let now = take.manifest.created_at_ms + 120_000;
    let rows = iso_library_rows(&take.manifest, now);
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0].title, "Host camera");
    assert!(rows[0].importable);
    assert!(rows[0].layout_unknown);
    assert_eq!(
        rows[0].local_session_id,
        "cloud-iso-tk_AbCdEf123456-host-host-camera-g1"
    );
    assert_eq!(rows[2].title, "Host microphone (part 2)");
    assert_eq!(rows[4].context, None, "one guest: no ordinal");
    assert!(rows[4].partial);
    assert_eq!(
        rows[5].unavailable.as_deref(),
        Some("Not recorded: Couldn't start")
    );
    let later = iso_library_rows(&take.manifest, take.manifest.expires_at_ms);
    assert!(later.iter().all(|row| !row.importable));
    assert!(
        later
            .iter()
            .all(|row| row.unavailable.as_deref() == Some("Expired in the cloud"))
    );
}

fn record(entry_id: &str, state: IsoDownloadState) -> IsoDownloadRecord {
    IsoDownloadRecord {
        entry_id: entry_id.into(),
        object_key: format!("k/{entry_id}"),
        expected_bytes: Some(1_000),
        state,
        attempts: 1,
        local_file_name: "f".into(),
        bytes: Some(500),
        error: None,
    }
}

#[test]
fn the_journal_alone_lists_an_expired_takes_files() {
    let journal = IsoImportJournal {
        show_id: "sh".into(),
        take_id: "tk_x".into(),
        program_recording_id: "rec".into(),
        records: vec![
            record("host/host-camera/g1", IsoDownloadState::Complete),
            record("g_a/guest-microphone/g2", IsoDownloadState::Failed),
            record("g_b/guest-camera/g1", IsoDownloadState::Complete),
            record("not an entry", IsoDownloadState::Complete),
        ],
    };
    let rows = iso_journal_rows(&journal);
    assert_eq!(rows.len(), 3);
    assert!(rows[0].layout_unknown);
    assert_eq!(rows[0].unavailable, None);
    assert_eq!(rows[1].title, "Guest microphone (part 2)");
    assert_eq!(rows[1].context.as_deref(), Some("Guest 1"));
    assert_eq!(rows[1].unavailable.as_deref(), Some("Expired in the cloud"));
    assert_eq!(rows[2].context.as_deref(), Some("Guest 2"));
    assert_eq!(
        rows[2].local_session_id,
        "cloud-iso-tk_x-g_b-guest-camera-g1"
    );
}

#[test]
fn imports_follow_the_journal_and_the_events() {
    let take = iso_parse_take(&fixture_manifest()).unwrap();
    let rows = iso_library_rows(&take.manifest, take.manifest.created_at_ms + 1);
    let take_id = take.manifest.take_id.clone();
    let importable: Vec<&IsoLibraryRow> = rows.iter().filter(|row| row.importable).collect();
    assert!(!importable.is_empty());

    let empty = IsoImports::new();
    let summary = iso_take_import_summary(&rows, &iso_take_import(&empty, &take_id));
    assert_eq!(summary.action, Some("Import separate files"));

    let starting = iso_import_starting(&empty, &take_id);
    assert_eq!(
        iso_take_import_summary(&rows, &iso_take_import(&starting, &take_id)).action,
        Some("Starting…")
    );
    let answered = iso_import_answered(&starting, &take_id, Some("job-1"));
    assert_eq!(
        iso_take_import_summary(&rows, &iso_take_import(&answered, &take_id)).action,
        Some("Importing…")
    );
    // Every importable file arrives.
    let mut imports = answered;
    for row in &importable {
        imports = reduce_iso_import_event(
            &imports,
            &IsoImportEvent {
                job_id: "job-1".into(),
                show_id: "sh".into(),
                take_id: take_id.clone(),
                entry_id: Some(row.entry_id.clone()),
                state: IsoDownloadState::Complete,
                bytes: Some(10),
                error: None,
                local_session_id: Some(row.local_session_id.clone()),
            },
        );
    }
    let done = iso_take_import(&imports, &take_id);
    assert_eq!(done.job_id, None);
    let summary = iso_take_import_summary(&rows, &done);
    assert_eq!(summary.imported, importable.len());
    assert_eq!(summary.action, None);
    // A job-level failure names no file.
    let failed = reduce_iso_import_event(
        &iso_import_starting(&IsoImports::new(), &take_id),
        &IsoImportEvent {
            job_id: "job-2".into(),
            show_id: "sh".into(),
            take_id: take_id.clone(),
            entry_id: None,
            state: IsoDownloadState::Failed,
            bytes: None,
            error: Some("boom".into()),
            local_session_id: None,
        },
    );
    let failed = iso_take_import(&failed, &take_id);
    assert!(failed.failed);
    assert_eq!(
        iso_take_import_summary(&rows, &failed).action,
        Some("Import again")
    );
    // The journal is the truth for each file.
    let journal = IsoImportJournal {
        take_id: take_id.clone(),
        records: vec![record(
            &importable[0].entry_id,
            IsoDownloadState::Downloading,
        )],
        ..IsoImportJournal::default()
    };
    let from_journal = iso_imports_from_journal(&IsoImports::new(), &[journal]);
    let file = iso_take_import(&from_journal, &take_id).files[&importable[0].entry_id].clone();
    assert_eq!(
        iso_file_word(Some(&file), None),
        Some(IsoFileWord {
            label: "Downloading 50%".into(),
            tone: Tone::Neutral,
            percent: Some(50)
        })
    );
    assert_eq!(iso_file_word(None, None), None);
}
