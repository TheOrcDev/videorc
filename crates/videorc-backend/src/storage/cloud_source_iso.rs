//! Plan 249 S22: the cloud ISO import journal and the files it staged.
//!
//! One row per program take keeps `cloud_source_iso::IsoDownloadJournal` as
//! JSON. One row per ISO file names the staging file this desktop created
//! (its object identity is recorded before the first byte), so recovery
//! removes only files this journal created, through S20's quarantine. A
//! completed file is journalled with its bound identity before it is
//! published without replacing anything, then registered as one Library row
//! per ISO file. Callers hold S21c's take claim around publication.
use super::*;
use crate::cloud_control_web::{CloudIsoImportRow, CloudIsoLocalFile, CloudIsoRegistration};
use crate::cloud_source_iso::{IsoDownloadJournal, IsoDownloadState};

const MAX_ISO_JOURNAL_JSON: usize = 512 * 1024;
const MAX_ISO_IMPORT_ROWS: i64 = 64;
const MAX_ISO_RECOVERY_FILES: i64 = 128;

impl Database {
    /// Persist one take's journal. A take never moves to another show or
    /// program recording: such a write is refused, never merged.
    pub(crate) fn save_cloud_iso_import(
        &self,
        show_id: &str,
        program_recording_id: &str,
        journal: &IsoDownloadJournal,
    ) -> Result<()> {
        let json = serde_json::to_string(journal)?;
        anyhow::ensure!(
            json.len() <= MAX_ISO_JOURNAL_JSON,
            "The ISO import journal is too large."
        );
        let changed = self.lock()?.execute(
            "INSERT INTO cloud_iso_imports(take_id, show_id, program_recording_id, journal_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(take_id) DO UPDATE SET journal_json = excluded.journal_json, updated_at = excluded.updated_at
             WHERE cloud_iso_imports.show_id = excluded.show_id
               AND cloud_iso_imports.program_recording_id = excluded.program_recording_id",
            params![
                journal.take_id,
                show_id,
                program_recording_id,
                json,
                Utc::now().to_rfc3339()
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "This take's ISO files belong to another show or recording."
        );
        Ok(())
    }

    pub(crate) fn cloud_iso_import(&self, take_id: &str) -> Result<Option<CloudIsoImportRow>> {
        let row: Option<(String, String, String)> = self
            .lock()?
            .query_row(
                "SELECT show_id, program_recording_id, journal_json FROM cloud_iso_imports WHERE take_id = ?1",
                [take_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        row.map(
            |(show_id, program_recording_id, json)| -> Result<CloudIsoImportRow> {
                Ok(CloudIsoImportRow {
                    show_id,
                    program_recording_id,
                    journal: serde_json::from_str(&json)?,
                })
            },
        )
        .transpose()
    }

    /// The newest journals, for `cloud.iso.imports`.
    pub(crate) fn cloud_iso_imports(&self) -> Result<Vec<CloudIsoImportRow>> {
        // One statement: the connection is released before any JSON parse.
        let rows: Vec<(String, String, String)> = self
            .lock()?
            .prepare(
                "SELECT show_id, program_recording_id, journal_json FROM cloud_iso_imports
                 ORDER BY updated_at DESC, take_id LIMIT ?1",
            )?
            .query_map([MAX_ISO_IMPORT_ROWS], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        rows.into_iter()
            .map(
                |(show_id, program_recording_id, json)| -> Result<CloudIsoImportRow> {
                    Ok(CloudIsoImportRow {
                        show_id,
                        program_recording_id,
                        journal: serde_json::from_str(&json)?,
                    })
                },
            )
            .collect()
    }

    /// Ownership of a staging file, recorded before any byte is written: a
    /// killed transfer is never adopted, and recovery removes only this
    /// filesystem object.
    pub(crate) fn prepare_cloud_iso_partial(
        &self,
        take_id: &str,
        entry_id: &str,
        object_key: &str,
        path: &Path,
    ) -> Result<()> {
        let identity = capture_session_file_object_identity(path)?
            .context("The ISO staging file is missing.")?;
        self.lock()?.execute(
            "INSERT INTO cloud_iso_import_files(take_id, entry_id, object_key, staging_path, staging_object_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(take_id, entry_id) DO UPDATE SET object_key = excluded.object_key,
               staging_path = excluded.staging_path, staging_object_json = excluded.staging_object_json,
               final_path = NULL, identity_json = NULL, registration_json = NULL",
            params![
                take_id,
                entry_id,
                object_key,
                path.to_string_lossy(),
                serde_json::to_string(&identity)?
            ],
        )?;
        Ok(())
    }

    fn discard_cloud_iso_partial(&self, take_id: &str, entry_id: &str) -> Result<()> {
        let partial: Option<(String, String)> = self
            .lock()?
            .query_row(
                "SELECT staging_path, staging_object_json FROM cloud_iso_import_files
                 WHERE take_id = ?1 AND entry_id = ?2 AND identity_json IS NULL
                   AND staging_path IS NOT NULL AND staging_object_json IS NOT NULL",
                params![take_id, entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((path, identity)) = partial {
            let path = PathBuf::from(path);
            let expected: SessionFileObjectIdentity = serde_json::from_str(&identity)?;
            if path.try_exists()? {
                let quarantine =
                    path.with_file_name(format!(".cloud-iso-partial-{}", uuid::Uuid::new_v4()));
                crate::session_ops::rename_session_file_no_replace(&path, &quarantine)?;
                let same = capture_session_file_object_identity(&quarantine)?
                    .is_some_and(|actual| actual == expected);
                if !same {
                    crate::session_ops::rename_session_file_no_replace(&quarantine, &path)?;
                    anyhow::bail!("The unfinished ISO file changed. It was left untouched.");
                }
                std::fs::remove_file(quarantine)?;
                crate::session_ops::sync_session_file_parent(&path)?;
            }
            self.lock()?.execute(
                "UPDATE cloud_iso_import_files SET staging_path = NULL, staging_object_json = NULL
                 WHERE take_id = ?1 AND entry_id = ?2",
                params![take_id, entry_id],
            )?;
        }
        Ok(())
    }

    /// A complete transfer, journalled before it is published: from here
    /// the journal owns the file, including a process death between
    /// publication and Library registration.
    pub(crate) fn prepare_cloud_iso_file(
        &self,
        registration: &CloudIsoRegistration,
        object_key: &str,
        staging: &Path,
        destination: &Path,
    ) -> Result<()> {
        let identity = capture_session_file_bound_identity(staging)?
            .context("The downloaded ISO file is missing.")?;
        let changed = self.lock()?.execute(
            "UPDATE cloud_iso_import_files SET staging_path = ?3, final_path = ?4, identity_json = ?5,
               registration_json = ?6
             WHERE take_id = ?1 AND entry_id = ?2 AND object_key = ?7",
            params![
                registration.take_id,
                registration.entry_id,
                staging.to_string_lossy(),
                destination.to_string_lossy(),
                serde_json::to_string(&identity)?,
                serde_json::to_string(registration)?,
                object_key
            ],
        )?;
        anyhow::ensure!(changed == 1, "The ISO import lost its journal row.");
        Ok(())
    }

    /// The Library row and file of one ISO entry, while its file is there.
    pub(crate) fn cloud_iso_local_file(
        &self,
        take_id: &str,
        entry_id: &str,
    ) -> Result<Option<CloudIsoLocalFile>> {
        let row: Option<(String, String, Option<String>)> = self
            .lock()?
            .query_row(
                "SELECT f.session_id, f.object_key, COALESCE(f.final_path, s.mp4_path) FROM cloud_iso_import_files f
                 JOIN sessions s ON s.id = f.session_id
                 WHERE f.take_id = ?1 AND f.entry_id = ?2",
                params![take_id, entry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(row.and_then(|(session_id, object_key, path)| {
            let path = PathBuf::from(path?);
            path.is_file().then_some(CloudIsoLocalFile {
                session_id,
                object_key,
                path,
            })
        }))
    }

    /// Idempotent: an entry already in Library answers its row; a journalled
    /// completion is published (never over an existing file) and registered
    /// once; an unfinished staging file this journal created is removed.
    /// The caller holds the take's claim (`cloud_archive::claim_take_file`).
    pub(crate) fn recover_cloud_iso_file(
        &self,
        take_id: &str,
        entry_id: &str,
    ) -> Result<Option<CloudIsoLocalFile>> {
        self.discard_cloud_iso_partial(take_id, entry_id)?;
        if let Some(found) = self.cloud_iso_local_file(take_id, entry_id)? {
            return Ok(Some(found));
        }
        type Pending = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let pending: Option<Pending> = self
            .lock()?
            .query_row(
                "SELECT object_key, staging_path, final_path, identity_json, registration_json
                 FROM cloud_iso_import_files WHERE take_id = ?1 AND entry_id = ?2",
                params![take_id, entry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((
            object_key,
            Some(staging),
            Some(destination),
            Some(identity),
            Some(registration),
        )) = pending
        else {
            return Ok(None);
        };
        let expected: SessionFileBoundIdentity = serde_json::from_str(&identity)?;
        let registration: CloudIsoRegistration = serde_json::from_str(&registration)?;
        let staging = PathBuf::from(staging);
        let destination = PathBuf::from(destination);
        let matches = |path: &Path| -> Result<bool> {
            Ok(
                capture_session_file_bound_identity(path)?.is_some_and(|actual| {
                    session_file_bound_identity_matches(
                        &actual,
                        &expected.content_identity,
                        Some(&expected.object_identity),
                    )
                }),
            )
        };
        if !destination.try_exists()? {
            if !staging.try_exists()? {
                return Ok(None);
            }
            anyhow::ensure!(
                matches(&staging)?,
                "The downloaded ISO file changed. It was left untouched."
            );
            crate::session_ops::rename_session_file_no_replace(&staging, &destination)?;
            crate::session_ops::sync_session_file_parent(&destination)?;
        }
        anyhow::ensure!(
            matches(&destination)?,
            "Another file already has this ISO file's name. It was left untouched."
        );
        self.register_cloud_iso_file(&registration, &destination)?;
        Ok(Some(CloudIsoLocalFile {
            session_id: registration.session_id,
            object_key,
            path: destination,
        }))
    }

    /// One Library row per ISO file, in the take of the program recording's
    /// own Library row when there is one (S20), else of its canonical id.
    fn register_cloud_iso_file(
        &self,
        registration: &CloudIsoRegistration,
        path: &Path,
    ) -> Result<()> {
        // Asked before the transaction: it takes the connection itself.
        let take_group = self
            .cloud_recording_session(&registration.program_recording_id)?
            .unwrap_or_else(|| registration.program_recording_id.clone());
        let file_size = std::fs::metadata(path)?.len() as i64;
        // Keep unknown/packed camera bytes in the ISO journal, but never
        // expose them via the generic Library video/thumbnail/export path.
        let playable_path = if registration.diagnostics["cloudIsoLayoutUnknown"] == true {
            None
        } else {
            Some(path.to_string_lossy().into_owned())
        };
        let output = OutputSettings {
            record_enabled: false,
            stream_enabled: false,
            output_directory: None,
            ffmpeg_path: None,
            keep_original_mkv: false,
            separate_source_recordings: None,
            video: crate::protocol::VideoSettings {
                preset: crate::protocol::VideoPreset::StreamSafe1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            },
            rtmp: crate::protocol::RtmpSettings {
                preset: crate::protocol::RtmpPreset::Custom,
                server_url: String::new(),
                stream_key: String::new(),
            },
        };
        let sources = SourceSelection {
            screen_id: None,
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "INSERT INTO sessions(id, title, started_at, ended_at, status, mode, mp4_path, duration_ms,
               sources_json, layout_json, output_json, diagnostics_json, file_size_bytes, take_id, recording_role)
             VALUES (?1, ?2, ?3, ?4, 'completed', 'cloud-recording', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET mp4_path = excluded.mp4_path,
               file_size_bytes = excluded.file_size_bytes, diagnostics_json = excluded.diagnostics_json,
               take_id = excluded.take_id, recording_role = excluded.recording_role
             WHERE sessions.mode = 'cloud-recording'",
            params![
                registration.session_id,
                registration.title,
                registration.started_at,
                registration.ended_at,
                playable_path,
                registration.duration_ms,
                serde_json::to_string(&sources)?,
                serde_json::to_string(&crate::protocol::default_layout_settings())?,
                session_output_json(&output)?,
                serde_json::to_string(&registration.diagnostics)?,
                file_size,
                take_group,
                registration.role
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "Another Library row already uses this ISO file's id."
        );
        tx.execute(
            "UPDATE cloud_iso_import_files SET session_id = ?3, staging_path = NULL,
               staging_object_json = NULL
             WHERE take_id = ?1 AND entry_id = ?2",
            params![
                registration.take_id,
                registration.entry_id,
                registration.session_id
            ],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_session_associations(session_id, show_id) VALUES (?1, ?2)",
            params![registration.session_id, registration.show_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Startup: a transfer the previous run left `downloading` is retried,
    /// not trusted; staged files are finished or removed, each under its
    /// take's claim. Journal only: no provider, credential or network.
    pub(crate) fn recover_cloud_iso_imports(&self) -> Result<()> {
        for row in self.cloud_iso_imports()? {
            if row
                .journal
                .records
                .iter()
                .any(|record| record.state == IsoDownloadState::Downloading)
            {
                let mut journal = row.journal;
                journal.recover_interrupted();
                self.save_cloud_iso_import(&row.show_id, &row.program_recording_id, &journal)?;
            }
        }
        let staged: Vec<(String, String, String)> = self
            .lock()?
            .prepare(
                "SELECT f.take_id, f.entry_id, i.program_recording_id FROM cloud_iso_import_files f
                 JOIN cloud_iso_imports i ON i.take_id = f.take_id
                 WHERE f.staging_path IS NOT NULL LIMIT ?1",
            )?
            .query_map([MAX_ISO_RECOVERY_FILES], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        for (take_id, entry_id, program_recording_id) in staged {
            let Ok(_claim) = crate::cloud_archive::claim_take_file(&program_recording_id) else {
                continue;
            };
            if let Err(error) = self.recover_cloud_iso_file(&take_id, &entry_id) {
                tracing::warn!(
                    take_id = %take_id,
                    entry_id = %entry_id,
                    "Cloud ISO recovery retained its files: {error}"
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_source_iso::{IsoDownloadRecord, parse_iso_manifest, plan_iso_import};

    const FIXTURE: &str = include_str!("../../../../protocol-fixtures/cloud-source-iso.json");
    const SHOW: &str = "sh_aaaaaaaaaaaaaaaaaaaaaa";
    const TAKE: &str = "tk_AbCdEf123456";

    fn journal() -> IsoDownloadJournal {
        let doc: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let manifest = parse_iso_manifest(&doc["valid"]).unwrap();
        let mut journal = IsoDownloadJournal::new(&manifest.take_id);
        journal.sync(&manifest, manifest.created_at_ms + 1).unwrap();
        journal
    }

    fn registration(program: &str, entry: &str, layout: Option<&str>) -> CloudIsoRegistration {
        CloudIsoRegistration {
            session_id: format!("cloud-iso-{TAKE}-host-host-camera-g1-{program}"),
            show_id: SHOW.into(),
            take_id: TAKE.into(),
            entry_id: entry.into(),
            program_recording_id: program.into(),
            title: "Host camera (layout unknown)".into(),
            started_at: "2027-01-15T08:00:00.400Z".into(),
            ended_at: Some("2027-01-15T08:01:00.400Z".into()),
            duration_ms: Some(60_000),
            role: "iso:host-camera".into(),
            diagnostics: serde_json::json!({
                "cloudIso": { "entryId": entry, "frameLayout": layout },
                "cloudIsoLayoutUnknown": layout == Some("unknown"),
            }),
        }
    }

    fn row(db: &Database, id: &str) -> (String, Option<String>, Option<String>, String) {
        db.lock()
            .unwrap()
            .query_row(
                "SELECT mode, take_id, recording_role, COALESCE(diagnostics_json, '{}') FROM sessions WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
    }

    #[test]
    fn the_journal_survives_a_schema_rerun_and_an_older_database() {
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-iso-schema");
        let path = folder.join("videorc.sqlite3");
        let journal = journal();
        {
            let db = Database::open_file_for_tests(&path);
            db.save_cloud_iso_import(SHOW, "rec_schema", &journal)
                .unwrap();
        }
        // Reopening reruns every migration over the existing tables.
        let db = Database::open_file_for_tests(&path);
        let saved = db.cloud_iso_import(TAKE).unwrap().unwrap();
        assert_eq!(saved.journal, journal);
        assert_eq!(saved.program_recording_id, "rec_schema");
        // A database from before S22 gains the tables on its next open.
        db.lock()
            .unwrap()
            .execute_batch("DROP TABLE cloud_iso_import_files; DROP TABLE cloud_iso_imports;")
            .unwrap();
        db.migrate_for_marker_test();
        assert!(db.cloud_iso_import(TAKE).unwrap().is_none());
        assert!(db.cloud_iso_imports().unwrap().is_empty());
    }

    #[test]
    fn a_take_never_moves_to_another_show_or_program_recording() {
        let db = Database::open_in_memory_for_tests();
        let journal = journal();
        db.save_cloud_iso_import(SHOW, "rec_owner", &journal)
            .unwrap();
        db.save_cloud_iso_import(SHOW, "rec_owner", &journal)
            .unwrap();
        assert!(
            db.save_cloud_iso_import("sh_bbbbbbbbbbbbbbbbbbbbbb", "rec_owner", &journal)
                .is_err()
        );
        assert!(
            db.save_cloud_iso_import(SHOW, "rec_other", &journal)
                .is_err()
        );
        assert_eq!(db.cloud_iso_imports().unwrap().len(), 1);
    }

    #[test]
    fn a_completed_file_registers_once_in_the_program_take_and_is_flagged() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-iso-register");
        let entry = "host/host-camera/g1";
        let part = folder.join(".iso.part");
        let destination = folder.join("tk_AbCdEf123456-iso-host-camera-host-g1.webm");
        std::fs::write(&part, b"").unwrap();
        db.prepare_cloud_iso_partial(TAKE, entry, "key-1", &part)
            .unwrap();
        std::fs::write(&part, b"iso camera fixture").unwrap();
        let reg = registration("rec_register", entry, Some("unknown"));
        db.prepare_cloud_iso_file(&reg, "key-1", &part, &destination)
            .unwrap();
        let first = db.recover_cloud_iso_file(TAKE, entry).unwrap().unwrap();
        let again = db.recover_cloud_iso_file(TAKE, entry).unwrap().unwrap();
        assert_eq!(first, again, "a repeat import answers the same row");
        assert_eq!(first.path, destination);
        assert_eq!(first.object_key, "key-1");
        assert!(!part.exists());
        let rows = db.list_sessions(10).unwrap();
        assert_eq!(rows.len(), 1, "one Library row per ISO file");
        let (mode, take, role, diagnostics) = row(&db, &reg.session_id);
        assert_eq!(mode, "cloud-recording");
        // No S20 row for the program recording yet: grouped by its canonical id.
        assert_eq!(take.as_deref(), Some("rec_register"));
        assert_eq!(role.as_deref(), Some("iso:host-camera"));
        let diagnostics: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();
        assert_eq!(diagnostics["cloudIsoLayoutUnknown"], true);
        let playback: Option<String> = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT mp4_path FROM sessions WHERE id = ?1",
                [&reg.session_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            playback, None,
            "unknown camera bytes are not ordinary Library video"
        );
        assert_eq!(rows[0].started_at, "2027-01-15T08:00:00.400Z");
    }

    #[test]
    fn the_take_group_is_the_program_recordings_own_library_row() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-iso-group");
        let program = crate::cloud_control_web::CloudRecordingItem {
            id: "rec_grouped".into(),
            show_id: SHOW.into(),
            take_id: TAKE.into(),
            started_at: "2027-01-15T08:00:00Z".into(),
            seconds: 60.0,
            orientation: "h".into(),
            ..Default::default()
        };
        let program_part = folder.join("program.part");
        let program_file = folder.join("program.mp4");
        std::fs::write(&program_part, b"program take fixture").unwrap();
        db.prepare_cloud_recording_file(&program, &program_part, &program_file)
            .unwrap();
        let program_session = db
            .recover_cloud_recording_file(&program)
            .unwrap()
            .and_then(|_| db.cloud_recording_session(&program.id).unwrap())
            .unwrap();
        let entry = "host/host-microphone/g1";
        let part = folder.join(".mic.part");
        std::fs::write(&part, b"").unwrap();
        db.prepare_cloud_iso_partial(TAKE, entry, "key-mic", &part)
            .unwrap();
        std::fs::write(&part, b"iso microphone fixture").unwrap();
        let mut reg = registration("rec_grouped", entry, None);
        reg.session_id = "cloud-iso-tk_AbCdEf123456-host-host-microphone-g1".into();
        reg.role = "iso:host-microphone".into();
        db.prepare_cloud_iso_file(&reg, "key-mic", &part, &folder.join("mic.ogg"))
            .unwrap();
        db.recover_cloud_iso_file(TAKE, entry).unwrap().unwrap();
        let (_, take, _, diagnostics) = row(&db, &reg.session_id);
        assert_eq!(take, Some(program_session));
        let diagnostics: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();
        assert_eq!(diagnostics["cloudIsoLayoutUnknown"], false);
    }

    #[test]
    fn an_existing_file_is_never_overwritten_or_adopted() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-iso-no-overwrite");
        let entry = "host/host-aux/g1";
        let part = folder.join(".aux.part");
        let destination = folder.join("aux.ogg");
        std::fs::write(&part, b"").unwrap();
        db.prepare_cloud_iso_partial(TAKE, entry, "key-aux", &part)
            .unwrap();
        std::fs::write(&part, b"iso aux fixture").unwrap();
        let reg = registration("rec_no_overwrite", entry, None);
        db.prepare_cloud_iso_file(&reg, "key-aux", &part, &destination)
            .unwrap();
        std::fs::write(&destination, b"someone else's file").unwrap();
        assert!(db.recover_cloud_iso_file(TAKE, entry).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"someone else's file");
        assert!(part.exists(), "the owned download stays journalled");
        assert!(db.list_sessions(10).unwrap().is_empty());
        std::fs::remove_file(&destination).unwrap();
        assert!(db.recover_cloud_iso_file(TAKE, entry).unwrap().is_some());
        assert_eq!(db.list_sessions(10).unwrap().len(), 1);
    }

    #[test]
    fn startup_removes_only_its_own_partials_and_retries_interrupted_transfers() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-iso-recovery");
        let mut journal = journal();
        let running: IsoDownloadRecord = journal.begin_next().unwrap();
        db.save_cloud_iso_import(SHOW, "rec_recovery", &journal)
            .unwrap();
        let ours = folder.join(".ours.part");
        std::fs::write(&ours, b"").unwrap();
        db.prepare_cloud_iso_partial(TAKE, &running.entry_id, "key-a", &ours)
            .unwrap();
        std::fs::write(&ours, b"half a file").unwrap();
        // A staging path whose file was replaced by someone else is kept.
        let replaced = folder.join(".replaced.part");
        std::fs::write(&replaced, b"").unwrap();
        db.prepare_cloud_iso_partial(TAKE, "host/host-aux/g1", "key-b", &replaced)
            .unwrap();
        std::fs::rename(&replaced, folder.join("moved-away")).unwrap();
        std::fs::write(&replaced, b"unrelated").unwrap();
        db.recover_cloud_iso_imports().unwrap();
        assert!(!ours.exists());
        assert_eq!(std::fs::read(&replaced).unwrap(), b"unrelated");
        let saved = db.cloud_iso_import(TAKE).unwrap().unwrap();
        let record = saved
            .journal
            .records
            .iter()
            .find(|record| record.entry_id == running.entry_id)
            .unwrap();
        assert_eq!(record.state, IsoDownloadState::Failed);
        assert!(db.list_sessions(10).unwrap().is_empty());
    }

    #[test]
    fn the_fixture_plan_names_files_the_journal_keeps() {
        let doc: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let manifest = parse_iso_manifest(&doc["valid"]).unwrap();
        let plan = plan_iso_import(&manifest, manifest.created_at_ms + 1);
        let journal = journal();
        for (item, record) in plan.iter().zip(&journal.records) {
            assert_eq!(item.entry_id, record.entry_id);
            assert_eq!(item.file_name, record.local_file_name);
        }
    }
}
