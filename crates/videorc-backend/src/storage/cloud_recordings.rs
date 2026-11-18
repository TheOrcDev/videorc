//! Plan 249 S20. The journal owns completed remuxes before publication; retries
//! register one local session. Neither metadata nor a path alone proves a file.
use super::*;
use crate::cloud_control_web::CloudRecordingItem;

impl Database {
    pub(crate) fn remember_cloud_recording(&self, item: &CloudRecordingItem) -> Result<()> {
        let mut metadata = item.clone();
        metadata.local_session_id = None;
        self.lock()?.execute(
            "INSERT INTO cloud_recording_library(recording_id, show_id, take_id, metadata_json)
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(recording_id) DO UPDATE SET metadata_json = excluded.metadata_json,
             take_id = CASE WHEN excluded.take_id = excluded.recording_id THEN cloud_recording_library.take_id ELSE excluded.take_id END",
            params![item.id, item.show_id, if item.take_id.is_empty() { &item.id } else { &item.take_id }, serde_json::to_string(&metadata)?],
        )?;
        Ok(())
    }

    pub(crate) fn cloud_recording_session(&self, id: &str) -> Result<Option<String>> {
        let row: Option<(String, Option<String>)> = self.lock()?.query_row(
            "SELECT s.id, s.mp4_path FROM cloud_recording_library c JOIN sessions s ON s.id = c.session_id WHERE c.recording_id = ?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        Ok(row.and_then(|(id, path)| path.filter(|p| Path::new(p).is_file()).map(|_| id)))
    }

    /// Persist ownership before FFmpeg writes. A killed remux is never adopted
    /// as a completed file, and retry cleans only this filesystem object.
    pub(crate) fn prepare_cloud_recording_partial(
        &self,
        item: &CloudRecordingItem,
        path: &Path,
    ) -> Result<()> {
        let identity = capture_session_file_bound_identity(path)?
            .context("Download staging file is missing.")?;
        self.remember_cloud_recording(item)?;
        self.lock()?.execute("UPDATE cloud_recording_library SET staging_path = ?2, staging_object_json = ?3, final_path = NULL, identity_json = NULL WHERE recording_id = ?1",
            params![item.id, path.to_string_lossy(), serde_json::to_string(&identity.object_identity)?])?;
        Ok(())
    }

    fn discard_cloud_recording_partial(&self, id: &str) -> Result<()> {
        let partial: Option<(String, String)> = self.lock()?.query_row(
            "SELECT staging_path, staging_object_json FROM cloud_recording_library WHERE recording_id = ?1 AND identity_json IS NULL AND staging_path IS NOT NULL AND staging_object_json IS NOT NULL",
            [id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        if let Some((path, identity)) = partial {
            let path = PathBuf::from(path);
            let expected: SessionFileObjectIdentity = serde_json::from_str(&identity)?;
            if path.try_exists()? {
                let quarantine =
                    path.with_file_name(format!(".cloud-partial-{}", uuid::Uuid::new_v4()));
                crate::session_ops::rename_session_file_no_replace(&path, &quarantine)?;
                let same = capture_session_file_bound_identity(&quarantine)?
                    .is_some_and(|actual| actual.object_identity == expected);
                if !same {
                    crate::session_ops::rename_session_file_no_replace(&quarantine, &path)?;
                    anyhow::bail!("The unfinished recording changed. Its file was left untouched.");
                }
                std::fs::remove_file(quarantine)?;
                crate::session_ops::sync_session_file_parent(&path)?;
            }
            self.lock()?.execute("UPDATE cloud_recording_library SET staging_path = NULL, staging_object_json = NULL WHERE recording_id = ?1", [id])?;
        }
        Ok(())
    }

    /// Previously authorized local completions survive cloud retention expiry.
    /// Startup uses only the durable journal; no provider, credential or network.
    pub(crate) fn recover_cloud_recording_library(&self) -> Result<()> {
        let pending: Vec<String> = {
            let conn = self.lock()?;
            let mut query = conn.prepare("SELECT metadata_json FROM cloud_recording_library WHERE staging_path IS NOT NULL LIMIT 128")?;
            query
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for metadata in pending {
            let item: CloudRecordingItem = serde_json::from_str(&metadata)?;
            if let Err(error) = self.recover_cloud_recording_file(&item) {
                tracing::warn!(recording_id = %item.id, "Cloud Library recovery retained its files: {error}");
            }
        }
        Ok(())
    }

    pub(crate) fn prepare_cloud_recording_file(
        &self,
        item: &CloudRecordingItem,
        staging: &Path,
        destination: &Path,
    ) -> Result<()> {
        let identity = capture_session_file_bound_identity(staging)?
            .context("Completed download is missing.")?;
        self.remember_cloud_recording(item)?;
        self.lock()?.execute(
            "UPDATE cloud_recording_library SET staging_path = ?2, final_path = ?3, identity_json = ?4 WHERE recording_id = ?1",
            params![item.id, staging.to_string_lossy(), destination.to_string_lossy(), serde_json::to_string(&identity)?],
        )?;
        Ok(())
    }

    pub(crate) fn recover_cloud_recording_file(
        &self,
        item: &CloudRecordingItem,
    ) -> Result<Option<PathBuf>> {
        self.discard_cloud_recording_partial(&item.id)?;
        // Existing Library files may have been moved by Library itself.
        if let Some(session) = self.cloud_recording_session(&item.id)? {
            let path: String = self.lock()?.query_row(
                "SELECT mp4_path FROM sessions WHERE id = ?1",
                [session],
                |r| r.get(0),
            )?;
            return Ok(Some(PathBuf::from(path)));
        }
        let pending: Option<(Option<String>, Option<String>, Option<String>)> = self.lock()?.query_row(
            "SELECT staging_path, final_path, identity_json FROM cloud_recording_library WHERE recording_id = ?1",
            [&item.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        let Some((Some(staging), Some(destination), Some(identity))) = pending else {
            return Ok(None);
        };
        let expected: SessionFileBoundIdentity = serde_json::from_str(&identity)?;
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
            if !Path::new(&staging).try_exists()? {
                return Ok(None);
            }
            anyhow::ensure!(
                matches(Path::new(&staging))?,
                "The saved recording changed. Its file was left untouched."
            );
            crate::session_ops::rename_session_file_no_replace(Path::new(&staging), &destination)?;
            crate::session_ops::sync_session_file_parent(&destination)?;
        }
        anyhow::ensure!(
            matches(&destination)?,
            "The saved recording changed. Its file was left untouched."
        );
        self.register_cloud_recording_file(item, &destination)?;
        Ok(Some(destination))
    }

    fn register_cloud_recording_file(&self, item: &CloudRecordingItem, path: &Path) -> Result<()> {
        let id = format!("cloud-take-{}", item.id);
        let start = chrono::DateTime::parse_from_rfc3339(&item.started_at)
            .context("The recording start time is invalid.")?;
        anyhow::ensure!(
            item.seconds.is_finite() && item.seconds >= 0.0 && item.seconds <= 13.0 * 3600.0,
            "The recording duration is invalid."
        );
        let duration = (item.seconds * 1000.0) as i64;
        let end = (start + chrono::Duration::milliseconds(duration)).to_rfc3339();
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
        tx.execute(
            "INSERT INTO sessions(id, title, started_at, ended_at, status, mode, mp4_path, container, duration_ms, sources_json, layout_json, output_json, file_size_bytes)
             VALUES (?1, ?2, ?3, ?4, 'completed', 'cloud-recording', ?5, 'mp4', ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET mp4_path = excluded.mp4_path, file_size_bytes = excluded.file_size_bytes
             WHERE sessions.mode = 'cloud-recording'",
            params![id, format!("Talk show · {} take", if item.orientation == "v" { "Vertical" } else { "Horizontal" }), item.started_at, end, path.to_string_lossy(), duration,
                serde_json::to_string(&sources)?, serde_json::to_string(&crate::protocol::default_layout_settings())?, session_output_json(&output)?, std::fs::metadata(path)?.len() as i64],
        )?;
        tx.execute("UPDATE cloud_recording_library SET session_id = ?2, staging_path = NULL, staging_object_json = NULL WHERE recording_id = ?1", params![item.id, id])?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_session_associations(session_id, show_id) VALUES (?1, ?2)",
            params![id, item.show_id],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take() -> CloudRecordingItem {
        CloudRecordingItem {
            id: "rec_take".into(),
            show_id: "show".into(),
            take_id: "tk_000000000001".into(),
            started_at: "2026-11-16T12:00:00Z".into(),
            seconds: 12.0,
            orientation: "h".into(),
            ..Default::default()
        }
    }

    #[test]
    fn published_file_recovers_once_without_rewriting_start_or_fabricating_capture() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-library");
        let part = folder.join("take.part");
        let final_path = folder.join("take.mp4");
        std::fs::write(&part, b"completed remux fixture").unwrap();
        let item = take();
        db.prepare_cloud_recording_file(&item, &part, &final_path)
            .unwrap();
        // Simulate death after atomic file publication, before DB registration.
        crate::session_ops::rename_session_file_no_replace(&part, &final_path).unwrap();
        assert_eq!(
            db.recover_cloud_recording_file(&item).unwrap(),
            Some(final_path.clone())
        );
        assert_eq!(
            db.recover_cloud_recording_file(&item).unwrap(),
            Some(final_path)
        );
        let rows = db.list_sessions(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].mode, "cloud-recording");
        assert_eq!(rows[0].started_at, item.started_at);
        assert_eq!(rows[0].duration_ms, Some(12000));
        assert_eq!(
            db.cloud_recording_session(&item.id).unwrap(),
            Some(rows[0].id.clone())
        );
    }

    #[test]
    fn staged_completion_recovers_and_replaced_files_are_never_adopted() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-library");
        let part = folder.join("take.part");
        let final_path = folder.join("take.mp4");
        std::fs::write(&part, b"completed remux fixture").unwrap();
        let item = take();
        db.prepare_cloud_recording_file(&item, &part, &final_path)
            .unwrap();
        std::fs::write(&final_path, b"someone else's file").unwrap();
        assert!(db.recover_cloud_recording_file(&item).is_err());
        assert_eq!(std::fs::read(&final_path).unwrap(), b"someone else's file");
        std::fs::remove_file(&final_path).unwrap();
        assert!(db.recover_cloud_recording_file(&item).unwrap().is_some());
        assert!(!part.exists());
    }

    #[test]
    fn interrupted_partial_is_discarded_but_completed_expired_take_recovers_locally() {
        let db = Database::open_in_memory_for_tests();
        let folder = crate::test_temp_dir::TestTempDir::new("cloud-library-interrupted");
        let part = folder.join("take.part");
        let final_path = folder.join("take.mp4");
        let mut item = take();
        item.expires_at = "2020-01-01T00:00:00Z".into();
        std::fs::write(&part, b"").unwrap();
        db.prepare_cloud_recording_partial(&item, &part).unwrap();
        std::fs::write(&part, b"unfinished remux").unwrap();
        db.recover_cloud_recording_library().unwrap();
        assert!(!part.exists());
        assert!(db.list_sessions(10).unwrap().is_empty());
        std::fs::write(&part, b"finished remux").unwrap();
        db.prepare_cloud_recording_file(&item, &part, &final_path)
            .unwrap();
        db.recover_cloud_recording_library().unwrap();
        assert!(final_path.exists());
        assert_eq!(db.list_sessions(10).unwrap().len(), 1);
    }

    #[test]
    fn canonical_intervals_preserve_first_observations_and_never_close_on_end_request() {
        let db = Database::open_in_memory_for_tests();
        let mut status = Database::cloud_show_status_for_tests();
        status.live_interval = Some(crate::cloud_show::CloudLiveInterval {
            id: "interval-a".into(),
            requested_at: "2026-11-16T12:00:00Z".into(),
            live_since: Some("2026-11-16T12:00:01Z".into()),
            end_requested_at: Some("2026-11-16T12:01:00Z".into()),
            ended_at: None,
        });
        db.sync_cloud_show_session(&status).unwrap();
        let ended: Option<String> = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT ended_at FROM cloud_live_intervals WHERE id = 'interval-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ended.is_none());
        status.live_interval.as_mut().unwrap().ended_at = Some("2026-11-16T12:01:01Z".into());
        db.sync_cloud_show_session(&status).unwrap();
        status.live_interval = Some(crate::cloud_show::CloudLiveInterval {
            id: "interval-b".into(),
            requested_at: "2026-11-16T12:02:00Z".into(),
            live_since: None,
            end_requested_at: None,
            ended_at: None,
        });
        db.sync_cloud_show_session(&status).unwrap();
        let conn = db.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM cloud_live_intervals", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        let first: (String, String) = conn
            .query_row(
                "SELECT requested_at, ended_at FROM cloud_live_intervals WHERE id = 'interval-a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            first,
            ("2026-11-16T12:00:00Z".into(), "2026-11-16T12:01:01Z".into())
        );
    }

    #[test]
    fn record_only_room_owns_history_without_a_native_recording() {
        let db = Database::open_in_memory_for_tests();
        let mut status = Database::cloud_show_status_for_tests();
        status.room.as_mut().unwrap().live = false;
        status.room.as_mut().unwrap().live_since = None;
        status.recording = Some(crate::cloud_talk::CloudRecordingStatus {
            active: true,
            since: Some("2026-11-16T11:59:00Z".into()),
            ..Default::default()
        });
        db.sync_cloud_show_session(&status).unwrap();
        let rows = db.list_sessions(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].started_at, "2026-11-16T11:59:00Z");
        assert_eq!(rows[0].mode, "cloud-room");
        assert!(rows[0].mp4_path.is_none());
    }
}
