use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::diagnostics::permission_pane_for_log;
use crate::live_chat::{
    CommentsSendOperation, CommentsSendOperationPhase, LiveChatEventType, LiveChatMessage,
    LiveChatMessageFragment,
};
use crate::process_job::output_owned_std;
use crate::protocol::{
    AiArtifact, AiArtifactKind, AiArtifactStatus, DiagnosticStats, HealthEvent, HealthLevel,
    LayoutSettings, OutputSettings, SessionLogEntry, SessionStorageTotals, SessionSummary,
    SourceSelection, StreamScreen, StreamScreenStatus,
};
use crate::repair::{GateStatus, RepairJob, RepairJobStatus};
use crate::streaming::{
    PlatformAccount, PlatformAccountStatus, StreamMetadataDraft, StreamPlatform,
    UpsertPlatformAccount, default_stream_metadata_draft, stream_platform_from_id,
    stream_platform_id,
};

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SessionCloneFacts {
    pub title: String,
    pub output_path: Option<String>,
    pub mp4_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewSession {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub mode: String,
    pub output_path: Option<String>,
    pub container: Option<String>,
    pub stream_preset: Option<String>,
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub output: OutputSettings,
}

#[derive(Debug, Clone)]
pub struct PlatformAccountCredentials {
    pub account: PlatformAccount,
    pub token_secret_ref: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub stream_key_secret_ref: Option<String>,
}

impl Database {
    pub fn open_default() -> Result<Self> {
        let path = default_database_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Could not create {}", parent.display()))?;
        }

        let conn = Connection::open(&path)
            .with_context(|| format!("Could not open SQLite database {}", path.display()))?;
        let database = Self {
            conn: Arc::new(Mutex::new(conn)),
            path,
        };
        database.migrate()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn open_in_memory_for_tests() -> Self {
        let database = Self {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            path: PathBuf::from(":memory:"),
        };
        database.migrate().unwrap();
        database
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn create_session(&self, session: &NewSession) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO sessions (
                id, title, started_at, status, mode, output_path, container, stream_preset,
                sources_json, layout_json, output_json
            ) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                session.id,
                session.title,
                session.started_at,
                session.mode,
                session.output_path,
                session.container,
                session.stream_preset,
                serde_json::to_string(&session.sources)?,
                serde_json::to_string(&session.layout)?,
                serde_json::to_string(&session.output)?,
            ],
        )?;
        Ok(())
    }

    /// Fake chat is an explicit test/smoke transport. Give it a real session
    /// row so inbound comments and outbound operations exercise the same
    /// SQLite foreign-key/persistence path as production sessions.
    pub fn ensure_fake_live_chat_session(&self, session_id: &str) -> Result<()> {
        if self
            .lock()?
            .query_row(
                "SELECT 1 FROM sessions WHERE id = ?1",
                params![session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Ok(());
        }
        self.create_session(&NewSession {
            id: session_id.to_string(),
            title: "Comments smoke session".to_string(),
            started_at: Utc::now().to_rfc3339(),
            mode: "stream".to_string(),
            output_path: None,
            container: None,
            stream_preset: Some("stream-safe-1080p30".to_string()),
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: crate::protocol::default_layout_settings(),
            output: OutputSettings {
                record_enabled: false,
                stream_enabled: true,
                output_directory: None,
                ffmpeg_path: None,
                video: crate::protocol::VideoSettings {
                    preset: crate::protocol::VideoPreset::StreamSafe1080p30,
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 6_000,
                },
                rtmp: crate::protocol::RtmpSettings {
                    preset: crate::protocol::RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
        })
    }

    pub fn finish_session(
        &self,
        session_id: &str,
        status: &str,
        ended_at: Option<String>,
        mp4_path: Option<String>,
        duration_ms: Option<i64>,
    ) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE sessions
             SET status = ?2,
                 ended_at = COALESCE(?3, ended_at),
                 mp4_path = COALESCE(?4, mp4_path),
                 duration_ms = COALESCE(?5, duration_ms)
             WHERE id = ?1",
            params![session_id, status, ended_at, mp4_path, duration_ms],
        )?;
        Ok(())
    }

    /// A freshly-started backend cannot have running sessions: any 'running'
    /// rows are orphans from a crash or a start that never reached a live
    /// pipeline (F-014/F-017). Flip them to failed so the Library stops
    /// claiming a recording is in flight.
    pub fn reconcile_orphaned_sessions(&self) -> Result<usize> {
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE sessions
             SET status = 'failed',
                 ended_at = COALESCE(ended_at, ?1)
             WHERE status = 'running'",
            params![Utc::now().to_rfc3339()],
        )?;
        Ok(updated)
    }

    pub fn session_recording_path(&self, session_id: &str) -> Result<Option<String>> {
        let conn = self.lock()?;
        let path = conn
            .query_row(
                "SELECT output_path FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(path)
    }

    pub fn save_session_diagnostics(
        &self,
        session_id: &str,
        diagnostics: &DiagnosticStats,
    ) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE sessions
             SET diagnostics_json = ?2
             WHERE id = ?1",
            params![session_id, serde_json::to_string(diagnostics)?],
        )?;
        Ok(())
    }

    /// Every recorded media path for a session, in preference order (mp4 export
    /// first, then the original container). Callers that hand a path to FFmpeg
    /// must pick the first one that still EXISTS on disk — the DB records where
    /// files were written, not whether the user has since moved or deleted them.
    pub fn session_media_candidates(&self, session_id: &str) -> Result<Vec<String>> {
        let conn = self.lock()?;
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT mp4_path, output_path FROM sessions WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((mp4_path, output_path)) = row else {
            return Ok(Vec::new());
        };
        let mut candidates = Vec::new();
        for path in [mp4_path, output_path].into_iter().flatten() {
            if !path.trim().is_empty() && !candidates.contains(&path) {
                candidates.push(path);
            }
        }
        Ok(candidates)
    }

    pub fn save_live_chat_message(&self, message: &LiveChatMessage) -> Result<()> {
        let conn = self.lock()?;
        let session_exists = conn
            .query_row(
                "SELECT 1 FROM sessions WHERE id = ?1",
                params![message.session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !session_exists {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO live_chat_messages (
                id, session_id, provider_message_id, platform, target_id, author_id,
                author_name, author_avatar_url, author_badges_json, author_roles_json,
                published_at, received_at, message_text, fragments_json, event_type,
                amount_text, is_deleted, raw_provider_type
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET
                target_id = excluded.target_id,
                author_id = excluded.author_id,
                author_name = excluded.author_name,
                author_avatar_url = excluded.author_avatar_url,
                author_badges_json = excluded.author_badges_json,
                author_roles_json = excluded.author_roles_json,
                published_at = excluded.published_at,
                received_at = excluded.received_at,
                message_text = excluded.message_text,
                fragments_json = excluded.fragments_json,
                event_type = excluded.event_type,
                amount_text = excluded.amount_text,
                is_deleted = excluded.is_deleted,
                raw_provider_type = excluded.raw_provider_type",
            params![
                message.id,
                message.session_id,
                message.provider_message_id,
                stream_platform_id(message.platform),
                message.target_id,
                message.author_id,
                message.author_name,
                message.author_avatar_url,
                serde_json::to_string(&message.author_badges)?,
                serde_json::to_string(&message.author_roles)?,
                message.published_at,
                message.received_at,
                message.message_text,
                serde_json::to_string(&message.fragments)?,
                serde_json::to_string(&message.event_type)?,
                message.amount_text,
                message.is_deleted,
                message.raw_provider_type,
            ],
        )?;
        Ok(())
    }

    pub fn list_live_chat_messages(&self, session_id: &str) -> Result<Vec<LiveChatMessage>> {
        let conn = self.lock()?;
        self.live_chat_messages_for_session_locked(&conn, session_id)
    }

    pub fn save_chat_send_operation(&self, operation: &CommentsSendOperation) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO live_chat_send_operations (
                id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                phase_json = excluded.phase_json,
                destinations_json = excluded.destinations_json,
                updated_at = excluded.updated_at",
            params![
                operation.id,
                operation.session_id,
                operation.text,
                serde_json::to_string(&operation.phase)?,
                serde_json::to_string(&operation.destinations)?,
                operation.created_at,
                operation.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_chat_send_operation(&self, id: &str) -> Result<Option<CommentsSendOperation>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
             FROM live_chat_send_operations WHERE id = ?1",
            params![id],
            chat_send_operation_from_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_chat_send_operations(
        &self,
        session_id: &str,
    ) -> Result<Vec<CommentsSendOperation>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
             FROM live_chat_send_operations
             WHERE session_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![session_id], chat_send_operation_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn reconcile_orphaned_chat_send_operations(&self) -> Result<usize> {
        let sending = serde_json::to_string(&CommentsSendOperationPhase::Sending)?;
        let operations = {
            let conn = self.lock()?;
            let mut statement = conn.prepare(
                "SELECT id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
                 FROM live_chat_send_operations WHERE phase_json = ?1",
            )?;
            let rows = statement.query_map(params![sending], chat_send_operation_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let count = operations.len();
        let now = Utc::now().to_rfc3339();
        for mut operation in operations {
            operation.mark_interrupted_unknown(now.clone());
            self.save_chat_send_operation(&operation)?;
        }
        Ok(count)
    }

    pub fn save_ai_artifact(
        &self,
        session_id: &str,
        kind: AiArtifactKind,
        status: AiArtifactStatus,
        content: serde_json::Value,
        file_path: Option<String>,
    ) -> Result<AiArtifact> {
        let artifact = AiArtifact {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            kind,
            status,
            content,
            file_path,
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO ai_artifacts (
                id, session_id, kind, status, content_json, file_path, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                artifact.id,
                artifact.session_id,
                serde_json::to_string(&artifact.kind)?,
                serde_json::to_string(&artifact.status)?,
                serde_json::to_string(&artifact.content)?,
                artifact.file_path,
                artifact.created_at,
            ],
        )?;
        Ok(artifact)
    }

    pub fn list_ai_artifacts(&self, session_id: &str) -> Result<Vec<AiArtifact>> {
        let conn = self.lock()?;
        self.ai_artifacts_for_session_locked(&conn, session_id)
    }

    pub fn list_health_events(&self, session_id: &str) -> Result<Vec<HealthEvent>> {
        let conn = self.lock()?;
        self.health_events_for_session_locked(&conn, session_id)
    }

    pub fn add_health_event(
        &self,
        session_id: Option<&str>,
        level: HealthLevel,
        code: &str,
        message: &str,
    ) -> Result<HealthEvent> {
        let permission_pane = permission_pane_for_log(code, message);
        let event = HealthEvent {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.map(str::to_string),
            level,
            code: code.to_string(),
            message: message.to_string(),
            permission_pane,
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO health_events (id, session_id, level, code, message, permission_pane, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.id,
                event.session_id,
                serde_json::to_string(&event.level)?,
                event.code,
                event.message,
                event
                    .permission_pane
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                event.created_at,
            ],
        )?;
        Ok(event)
    }

    pub fn add_session_log(
        &self,
        session_id: &str,
        level: HealthLevel,
        code: &str,
        message: &str,
        source_id: Option<&str>,
    ) -> Result<SessionLogEntry> {
        let permission_pane = permission_pane_for_log(code, message);
        let entry = SessionLogEntry {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            level,
            code: code.to_string(),
            message: message.to_string(),
            source_id: source_id.map(str::to_string),
            permission_pane,
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO session_logs (
                id, session_id, level, code, message, source_id, permission_pane, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.id,
                entry.session_id,
                serde_json::to_string(&entry.level)?,
                entry.code,
                entry.message,
                entry.source_id,
                entry
                    .permission_pane
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                entry.created_at,
            ],
        )?;
        Ok(entry)
    }

    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SessionSummary>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, status, mode, output_path, mp4_path,
                    stream_preset, container, duration_ms, sources_json, layout_json,
                    diagnostics_json, file_size_bytes
             FROM sessions
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let id: String = row.get(0)?;
            let sources_json: String = row.get(11)?;
            let layout_json: String = row.get(12)?;
            let diagnostics_json: Option<String> = row.get(13)?;
            Ok((
                id,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                sources_json,
                layout_json,
                diagnostics_json,
                row.get::<_, Option<i64>>(14)?,
            ))
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            let (
                id,
                title,
                started_at,
                ended_at,
                status,
                mode,
                output_path,
                mp4_path,
                stream_preset,
                container,
                duration_ms,
                sources_json,
                layout_json,
                diagnostics_json,
                stored_file_size,
            ) = row?;

            // Size truth (Library rewrite L1): stat the VISIBLE file live while
            // it exists (repairs and MP4 exports change it), fall back to the
            // last-known size when it has gone missing, and write changes back
            // so missing-file rows keep a truthful number. A stat is microseconds;
            // 200 rows cost less than a frame.
            let visible_path = mp4_path.as_deref().or(output_path.as_deref());
            let live_size = visible_path
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|metadata| metadata.len() as i64);
            let file_size_bytes = live_size.or(stored_file_size);
            if live_size.is_some() && live_size != stored_file_size {
                let _ = conn.execute(
                    "UPDATE sessions SET file_size_bytes = ?2 WHERE id = ?1",
                    params![id, live_size],
                );
            }
            let layout: LayoutSettings = serde_json::from_str(&layout_json)?;
            let scene_label = session_scene_label(&layout, stream_preset.as_deref(), &mode);

            sessions.push(SessionSummary {
                file_size_bytes,
                scene_label,
                health_events: self.health_events_for_session_locked(&conn, &id)?,
                session_logs: self.session_logs_for_session_locked(&conn, &id)?,
                ai_artifacts: self.ai_artifacts_for_session_locked(&conn, &id)?,
                comment_count: self.live_chat_message_count_for_session_locked(&conn, &id)?,
                quality_status: self.latest_quality_status_for_session_locked(
                    &conn,
                    output_path.as_deref(),
                    mp4_path.as_deref(),
                )?,
                id,
                title,
                started_at,
                ended_at,
                status,
                mode,
                output_path,
                mp4_path,
                stream_preset,
                container,
                duration_ms,
                final_diagnostics: diagnostics_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                sources: serde_json::from_str(&sources_json)?,
                layout,
            });
        }

        Ok(sessions)
    }

    /// Rename a session (Library L3). Title is validated at the RPC edge.
    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<bool> {
        let conn = self.lock()?;
        let changed = conn.execute(
            "UPDATE sessions SET title = ?2 WHERE id = ?1",
            params![session_id, title],
        )?;
        Ok(changed > 0)
    }

    /// Delete sessions and their session-keyed satellite rows (Library L3).
    /// FILES are not touched here — the renderer moves them to the system
    /// Trash first (Trash is the undo; the backend never unlinks recordings).
    pub fn delete_sessions(&self, session_ids: &[String]) -> Result<usize> {
        let conn = self.lock()?;
        let mut deleted = 0;
        for id in session_ids {
            conn.execute(
                "DELETE FROM health_events WHERE session_id = ?1",
                params![id],
            )?;
            conn.execute(
                "DELETE FROM session_logs WHERE session_id = ?1",
                params![id],
            )?;
            conn.execute(
                "DELETE FROM ai_artifacts WHERE session_id = ?1",
                params![id],
            )?;
            conn.execute(
                "DELETE FROM live_chat_messages WHERE session_id = ?1",
                params![id],
            )?;
            conn.execute(
                "DELETE FROM live_chat_send_operations WHERE session_id = ?1",
                params![id],
            )?;
            deleted += conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        }
        Ok(deleted)
    }

    /// Clone a session row for Duplicate (Library L3): same config lineage,
    /// new id/title/paths/timestamps; quality history and artifacts stay with
    /// the original.
    #[allow(clippy::too_many_arguments)]
    pub fn clone_session_row(
        &self,
        source_id: &str,
        new_id: &str,
        new_title: &str,
        new_output_path: Option<&str>,
        new_mp4_path: Option<&str>,
        started_at: &str,
        file_size_bytes: Option<i64>,
    ) -> Result<bool> {
        let conn = self.lock()?;
        let inserted = conn.execute(
            "INSERT INTO sessions (id, title, started_at, ended_at, status, mode, output_path,
                                   mp4_path, stream_preset, container, duration_ms, sources_json,
                                   layout_json, output_json, diagnostics_json, file_size_bytes)
             SELECT ?2, ?3, ?6, ?6, 'completed', mode, ?4, ?5, stream_preset, container,
                    duration_ms, sources_json, layout_json, output_json, NULL, ?7
             FROM sessions WHERE id = ?1",
            params![
                source_id,
                new_id,
                new_title,
                new_output_path,
                new_mp4_path,
                started_at,
                file_size_bytes
            ],
        )?;
        Ok(inserted > 0)
    }

    /// Full facts Duplicate needs from the source row (Library L3).
    pub fn session_clone_facts(&self, session_id: &str) -> Result<Option<SessionCloneFacts>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT title, output_path, mp4_path FROM sessions WHERE id = ?1")?;
        let mut rows = stmt.query(params![session_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(SessionCloneFacts {
            title: row.get(0)?,
            output_path: row.get(1)?,
            mp4_path: row.get(2)?,
        }))
    }

    /// The visible file + duration for one session (poster backfill, L2).
    pub fn session_file_facts(&self, session_id: &str) -> Result<Option<(String, Option<i64>)>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(mp4_path, output_path), duration_ms FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![session_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let path: Option<String> = row.get(0)?;
        let duration_ms: Option<i64> = row.get(1)?;
        Ok(path.map(|path| (path, duration_ms)))
    }

    /// Library footer facts (L1): total sessions + the sum of last-known file
    /// sizes. Free disk space comes from the Electron-side directory facts —
    /// the renderer combines the two.
    pub fn session_storage_totals(&self) -> Result<SessionStorageTotals> {
        let conn = self.lock()?;
        let (count, total_bytes) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size_bytes), 0) FROM sessions",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        Ok(SessionStorageTotals { count, total_bytes })
    }

    pub fn load_setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let conn = self.lock()?;
        let value_json: Option<String> = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        value_json
            .map(|value_json| serde_json::from_str(&value_json).map_err(Into::into))
            .transpose()
    }

    pub fn save_setting<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn import_screen_image(&self, image_path: &str, ffmpeg_path: &str) -> Result<StreamScreen> {
        self.import_screen_image_with_optimizer(image_path, |source, destination| {
            optimize_screen_image(source, destination, ffmpeg_path)
        })
    }

    pub fn list_platform_accounts(&self) -> Result<Vec<PlatformAccount>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, platform, account_id, account_label, account_handle, avatar_url,
                    scopes_json, token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref,
                    expires_at, connected_at, updated_at, status
             FROM platform_accounts
             ORDER BY platform ASC",
        )?;
        let rows = stmt.query_map([], |row| self.platform_account_from_row(row))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_platform_account_credentials(&self) -> Result<Vec<PlatformAccountCredentials>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, platform, account_id, account_label, account_handle, avatar_url,
                    scopes_json, token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref,
                    expires_at, connected_at, updated_at, status
             FROM platform_accounts
             ORDER BY platform ASC",
        )?;
        let rows = stmt.query_map([], |row| self.platform_account_credentials_from_row(row))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    #[allow(dead_code)]
    pub fn upsert_platform_account(
        &self,
        account: UpsertPlatformAccount,
    ) -> Result<PlatformAccount> {
        self.validate_platform_account_input(&account)?;
        let conn = self.lock()?;
        let now = Utc::now().to_rfc3339();
        let account_platform = account.platform;
        let platform = stream_platform_id(account_platform);
        let existing_id = conn
            .query_row(
                "SELECT id FROM platform_accounts WHERE platform = ?1",
                params![platform],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let connected_at = conn
            .query_row(
                "SELECT connected_at FROM platform_accounts WHERE platform = ?1",
                params![platform],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| now.clone());

        conn.execute(
            "INSERT INTO platform_accounts (
                id, platform, account_id, account_label, account_handle, avatar_url, scopes_json,
                token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref, expires_at,
                connected_at, updated_at, status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(platform) DO UPDATE SET
                account_id = excluded.account_id,
                account_label = excluded.account_label,
                account_handle = excluded.account_handle,
                avatar_url = excluded.avatar_url,
                scopes_json = excluded.scopes_json,
                token_secret_ref = excluded.token_secret_ref,
                refresh_token_secret_ref = CASE
                    WHEN excluded.refresh_token_secret_ref IS NOT NULL THEN excluded.refresh_token_secret_ref
                    WHEN platform_accounts.account_id = excluded.account_id THEN platform_accounts.refresh_token_secret_ref
                    ELSE NULL
                END,
                stream_key_secret_ref = excluded.stream_key_secret_ref,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at,
                status = excluded.status",
            params![
                id,
                platform,
                account.account_id.trim(),
                account.account_label.trim(),
                account.account_handle,
                account.avatar_url,
                serde_json::to_string(&normalized_scopes(account.scopes))?,
                account.token_secret_ref,
                account.refresh_token_secret_ref,
                account.stream_key_secret_ref,
                account.expires_at,
                connected_at,
                now,
                serde_json::to_string(&account.status)?,
            ],
        )?;

        self.platform_account_by_platform_locked(&conn, account_platform)
    }

    pub fn disconnect_platform_account(
        &self,
        platform: StreamPlatform,
    ) -> Result<Option<PlatformAccount>> {
        self.disconnect_platform_account_with_secret_deleter(
            platform,
            crate::secrets::delete_secret,
        )
    }

    fn disconnect_platform_account_with_secret_deleter<F>(
        &self,
        platform: StreamPlatform,
        mut delete_secret: F,
    ) -> Result<Option<PlatformAccount>>
    where
        F: FnMut(&str) -> Result<()>,
    {
        let conn = self.lock()?;
        let platform_id = stream_platform_id(platform);
        let refs = conn
            .query_row(
                "SELECT token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref
                 FROM platform_accounts
                 WHERE platform = ?1",
                params![platform_id],
                |row| {
                    Ok([
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ])
                },
            )
            .optional()?;
        let Some(refs) = refs else {
            return Ok(None);
        };
        for secret_ref in refs.into_iter().flatten() {
            delete_secret(&secret_ref)?;
        }
        let account = self.platform_account_by_platform_locked(&conn, platform)?;
        conn.execute(
            "DELETE FROM platform_accounts WHERE platform = ?1",
            params![platform_id],
        )?;
        Ok(Some(account))
    }

    pub fn stream_metadata_draft(&self) -> Result<StreamMetadataDraft> {
        let conn = self.lock()?;
        let value_json = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'streamMetadataDraft'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value_json {
            Some(value) => Ok(serde_json::from_str::<StreamMetadataDraft>(&value)
                .unwrap_or_else(|_| default_stream_metadata_draft(Utc::now().to_rfc3339()))),
            None => Ok(default_stream_metadata_draft(Utc::now().to_rfc3339())),
        }
    }

    pub fn save_stream_metadata_draft(
        &self,
        mut draft: StreamMetadataDraft,
    ) -> Result<StreamMetadataDraft> {
        let now = Utc::now().to_rfc3339();
        draft.updated_at = now.clone();
        for target in &mut draft.target_overrides {
            target.updated_at = now.clone();
        }
        self.save_setting("streamMetadataDraft", &draft)?;
        Ok(draft)
    }

    fn import_screen_image_with_optimizer<F>(
        &self,
        image_path: &str,
        optimize: F,
    ) -> Result<StreamScreen>
    where
        F: FnOnce(&Path, &Path) -> Result<()>,
    {
        let source_path = Path::new(image_path);
        validate_screen_image_source(source_path)?;
        let conn = self.lock()?;
        let now = Utc::now().to_rfc3339();
        let next_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM stream_screens",
            [],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let screen_dir = self.screen_assets_dir();
        std::fs::create_dir_all(&screen_dir)
            .with_context(|| format!("Could not create {}", screen_dir.display()))?;
        let optimized_path = screen_dir.join(format!("{id}.png"));
        optimize(source_path, &optimized_path)?;
        let screen = StreamScreen {
            id,
            name: screen_name_from_path(image_path),
            image_path: optimized_path.display().to_string(),
            thumbnail_path: None,
            sort_order: next_order,
            status: StreamScreenStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
        };

        conn.execute(
            "INSERT INTO stream_screens (
                id, name, image_path, thumbnail_path, sort_order, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                screen.id,
                screen.name,
                screen.image_path,
                screen.thumbnail_path,
                screen.sort_order,
                serde_json::to_string(&screen.status)?,
                screen.created_at,
                screen.updated_at,
            ],
        )?;
        Ok(screen)
    }

    pub fn list_stream_screens(&self) -> Result<Vec<StreamScreen>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, image_path, thumbnail_path, sort_order, status, created_at, updated_at
             FROM stream_screens
             ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_json: String = row.get(5)?;
            let image_path: String = row.get(2)?;
            let stored_status =
                serde_json::from_str(&status_json).unwrap_or(StreamScreenStatus::Missing);
            Ok(StreamScreen {
                id: row.get(0)?,
                name: row.get(1)?,
                status: if Path::new(&image_path).exists() {
                    stored_status
                } else {
                    StreamScreenStatus::Missing
                },
                image_path,
                thumbnail_path: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn rename_stream_screen(&self, screen_id: &str, name: &str) -> Result<StreamScreen> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            anyhow::bail!("Screen name cannot be empty.");
        }

        let conn = self.lock()?;
        let updated_at = Utc::now().to_rfc3339();
        let changed = conn.execute(
            "UPDATE stream_screens SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![screen_id, trimmed, updated_at],
        )?;
        if changed == 0 {
            anyhow::bail!("Screen not found.");
        }

        self.stream_screen_by_id_locked(&conn, screen_id)
    }

    pub fn delete_stream_screen(&self, screen_id: &str) -> Result<()> {
        let conn = self.lock()?;
        let image_path = conn
            .query_row(
                "SELECT image_path FROM stream_screens WHERE id = ?1",
                params![screen_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(image_path) = image_path else {
            anyhow::bail!("Screen not found.");
        };

        let path = Path::new(&image_path);
        if path.exists() {
            std::fs::remove_file(path)
                .with_context(|| format!("Could not delete {}", path.display()))?;
        }
        conn.execute(
            "DELETE FROM stream_screens WHERE id = ?1",
            params![screen_id],
        )?;
        if self.active_screen_id_locked(&conn)?.as_deref() == Some(screen_id) {
            self.save_setting_locked(&conn, "activeScreenId", &Option::<String>::None)?;
        }
        Ok(())
    }

    pub fn reorder_stream_screens(&self, screen_ids: &[String]) -> Result<Vec<StreamScreen>> {
        let conn = self.lock()?;
        let existing_ids = {
            let mut stmt = conn.prepare("SELECT id FROM stream_screens")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let existing = existing_ids.iter().collect::<HashSet<_>>();
        let requested = screen_ids.iter().collect::<HashSet<_>>();
        if existing.len() != requested.len()
            || existing_ids.len() != screen_ids.len()
            || existing != requested
        {
            anyhow::bail!("Screen reorder must include every Screen exactly once.");
        }

        let updated_at = Utc::now().to_rfc3339();
        for (index, screen_id) in screen_ids.iter().enumerate() {
            conn.execute(
                "UPDATE stream_screens SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![screen_id, index as i64, updated_at],
            )?;
        }

        drop(conn);
        self.list_stream_screens()
    }

    pub fn active_stream_screen(&self) -> Result<Option<StreamScreen>> {
        let conn = self.lock()?;
        let Some(screen_id) = self.active_screen_id_locked(&conn)? else {
            return Ok(None);
        };
        drop(conn);
        Ok(self
            .list_stream_screens()?
            .into_iter()
            .find(|screen| screen.id == screen_id && screen.status == StreamScreenStatus::Ready))
    }

    pub fn activate_stream_screen(&self, screen_id: &str) -> Result<StreamScreen> {
        let conn = self.lock()?;
        let screen = self.stream_screen_by_id_locked(&conn, screen_id)?;
        if screen.status != StreamScreenStatus::Ready {
            anyhow::bail!("Screen image is missing and cannot be activated.");
        }
        self.save_setting_locked(&conn, "activeScreenId", &Some(screen_id.to_string()))?;
        Ok(screen)
    }

    pub fn clear_active_stream_screen(&self) -> Result<()> {
        let conn = self.lock()?;
        self.save_setting_locked(&conn, "activeScreenId", &Option::<String>::None)
    }

    fn stream_screen_by_id_locked(
        &self,
        conn: &Connection,
        screen_id: &str,
    ) -> Result<StreamScreen> {
        let screen = conn.query_row(
            "SELECT id, name, image_path, thumbnail_path, sort_order, status, created_at, updated_at
             FROM stream_screens
             WHERE id = ?1",
            params![screen_id],
            |row| {
                let image_path: String = row.get(2)?;
                let status_json: String = row.get(5)?;
                let stored_status =
                    serde_json::from_str(&status_json).unwrap_or(StreamScreenStatus::Missing);
                Ok(StreamScreen {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    image_path: image_path.clone(),
                    thumbnail_path: row.get(3)?,
                    sort_order: row.get(4)?,
                    status: if Path::new(&image_path).exists() {
                        stored_status
                    } else {
                        StreamScreenStatus::Missing
                    },
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )?;
        Ok(screen)
    }

    fn active_screen_id_locked(&self, conn: &Connection) -> Result<Option<String>> {
        let value_json = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'activeScreenId'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value_json {
            Some(value) => Ok(serde_json::from_str::<Option<String>>(&value)?),
            None => Ok(None),
        }
    }

    fn save_setting_locked<T: serde::Serialize>(
        &self,
        conn: &Connection,
        key: &str,
        value: &T,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    fn validate_platform_account_input(&self, account: &UpsertPlatformAccount) -> Result<()> {
        if matches!(account.platform, StreamPlatform::Custom) {
            anyhow::bail!("Custom RTMP does not support OAuth accounts.");
        }
        if account.account_id.trim().is_empty() {
            anyhow::bail!("Platform account id cannot be empty.");
        }
        if account.account_label.trim().is_empty() {
            anyhow::bail!("Platform account label cannot be empty.");
        }
        Ok(())
    }

    fn platform_account_by_platform_locked(
        &self,
        conn: &Connection,
        platform: StreamPlatform,
    ) -> Result<PlatformAccount> {
        conn.query_row(
            "SELECT id, platform, account_id, account_label, account_handle, avatar_url,
                    scopes_json, token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref,
                    expires_at, connected_at, updated_at, status
             FROM platform_accounts
             WHERE platform = ?1",
            params![stream_platform_id(platform)],
            |row| self.platform_account_from_row(row),
        )
        .map_err(Into::into)
    }

    fn platform_account_from_row(
        &self,
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<PlatformAccount> {
        let platform_id: String = row.get(1)?;
        let scopes_json: String = row.get(6)?;
        let status_json: String = row.get(13)?;
        Ok(PlatformAccount {
            id: row.get(0)?,
            platform: stream_platform_from_id(&platform_id).unwrap_or(StreamPlatform::Custom),
            account_id: row.get(2)?,
            account_label: row.get(3)?,
            account_handle: row.get(4)?,
            avatar_url: row.get(5)?,
            scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
            access_token_present: row.get::<_, Option<String>>(7)?.is_some(),
            refresh_token_present: row.get::<_, Option<String>>(8)?.is_some(),
            stream_key_present: row.get::<_, Option<String>>(9)?.is_some(),
            expires_at: row.get(10)?,
            connected_at: row.get(11)?,
            updated_at: row.get(12)?,
            status: serde_json::from_str(&status_json)
                .unwrap_or(PlatformAccountStatus::NeedsReconnect),
        })
    }

    fn platform_account_credentials_from_row(
        &self,
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<PlatformAccountCredentials> {
        let account = self.platform_account_from_row(row)?;
        Ok(PlatformAccountCredentials {
            account,
            token_secret_ref: row.get(7)?,
            refresh_token_secret_ref: row.get(8)?,
            stream_key_secret_ref: row.get(9)?,
        })
    }

    fn screen_assets_dir(&self) -> PathBuf {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            return parent.join("Screens");
        }

        std::env::temp_dir().join("videorc-screens")
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.lock()?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                status TEXT NOT NULL,
                mode TEXT NOT NULL,
                output_path TEXT,
                mp4_path TEXT,
                stream_preset TEXT,
                container TEXT,
                duration_ms INTEGER,
                sources_json TEXT NOT NULL,
                layout_json TEXT NOT NULL,
                output_json TEXT NOT NULL,
                diagnostics_json TEXT
            );

            CREATE TABLE IF NOT EXISTS health_events (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                level TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                permission_pane TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_logs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                level TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                source_id TEXT,
                permission_pane TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS ai_artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                content_json TEXT NOT NULL,
                file_path TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS live_chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                provider_message_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                target_id TEXT,
                author_id TEXT,
                author_name TEXT NOT NULL,
                author_avatar_url TEXT,
                author_badges_json TEXT NOT NULL,
                author_roles_json TEXT NOT NULL,
                published_at TEXT NOT NULL,
                received_at TEXT NOT NULL,
                message_text TEXT NOT NULL,
                fragments_json TEXT NOT NULL,
                event_type TEXT NOT NULL,
                amount_text TEXT,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                raw_provider_type TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_live_chat_messages_session_received
                ON live_chat_messages(session_id, received_at, id);

            CREATE TABLE IF NOT EXISTS live_chat_send_operations (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_text TEXT NOT NULL,
                phase_json TEXT NOT NULL,
                destinations_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_live_chat_send_operations_session_created
                ON live_chat_send_operations(session_id, created_at, id);

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stream_screens (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                image_path TEXT NOT NULL,
                thumbnail_path TEXT,
                sort_order INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS platform_accounts (
                id TEXT PRIMARY KEY,
                platform TEXT NOT NULL UNIQUE,
                account_id TEXT NOT NULL,
                account_label TEXT NOT NULL,
                account_handle TEXT,
                avatar_url TEXT,
                scopes_json TEXT NOT NULL,
                token_secret_ref TEXT,
                refresh_token_secret_ref TEXT,
                stream_key_secret_ref TEXT,
                expires_at TEXT,
                connected_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS repair_jobs (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                status TEXT NOT NULL,
                intended_fps REAL,
                expect_audio INTEGER NOT NULL,
                outcome_json TEXT,
                reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )?;
        ensure_column(&conn, "sessions", "container", "container TEXT")?;
        ensure_column(&conn, "sessions", "duration_ms", "duration_ms INTEGER")?;
        ensure_column(
            &conn,
            "sessions",
            "file_size_bytes",
            "file_size_bytes INTEGER",
        )?;
        ensure_column(
            &conn,
            "sessions",
            "diagnostics_json",
            "diagnostics_json TEXT",
        )?;
        ensure_column(
            &conn,
            "health_events",
            "permission_pane",
            "permission_pane TEXT",
        )?;
        Ok(())
    }

    /// Inserts or replaces a persisted repair job so it survives an app restart.
    pub fn upsert_repair_job(&self, job: &RepairJob) -> Result<()> {
        let conn = self.lock()?;
        let outcome_json = match &job.outcome {
            Some(value) => Some(serde_json::to_string(value)?),
            None => None,
        };
        conn.execute(
            "INSERT OR REPLACE INTO repair_jobs
                (id, file_path, status, intended_fps, expect_audio, outcome_json, reason, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                job.id,
                job.file_path,
                job.status.as_str(),
                job.intended_fps,
                job.expect_audio as i64,
                outcome_json,
                job.reason,
                job.created_at,
                job.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Repair jobs that were not finished (pending or running) — the set to resume on the
    /// next launch. Listing all jobs and deleting them are added with the history UI.
    pub fn incomplete_repair_jobs(&self) -> Result<Vec<RepairJob>> {
        let conn = self.lock()?;
        query_repair_jobs(&conn, "WHERE status IN ('pending', 'running')")
    }

    fn ai_artifacts_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<AiArtifact>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, status, content_json, file_path, created_at
             FROM ai_artifacts
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let kind_json: String = row.get(2)?;
            let status_json: String = row.get(3)?;
            let content_json: String = row.get(4)?;
            Ok(AiArtifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                kind: serde_json::from_str(&kind_json).unwrap_or(AiArtifactKind::Transcript),
                status: serde_json::from_str(&status_json).unwrap_or(AiArtifactStatus::Failed),
                content: serde_json::from_str(&content_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
                file_path: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn live_chat_message_count_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<u64> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM live_chat_messages WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }

    fn live_chat_messages_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<LiveChatMessage>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, provider_message_id, platform, target_id, author_id,
                    author_name, author_avatar_url, author_badges_json, author_roles_json,
                    published_at, received_at, message_text, fragments_json, event_type,
                    amount_text, is_deleted, raw_provider_type
             FROM live_chat_messages
             WHERE session_id = ?1
             ORDER BY received_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let platform_id: String = row.get(3)?;
            let author_badges_json: String = row.get(8)?;
            let author_roles_json: String = row.get(9)?;
            let fragments_json: String = row.get(13)?;
            let event_type_json: String = row.get(14)?;
            Ok(LiveChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                provider_message_id: row.get(2)?,
                platform: stream_platform_from_id(&platform_id).unwrap_or(StreamPlatform::Custom),
                target_id: row.get(4)?,
                author_id: row.get(5)?,
                author_name: row.get(6)?,
                author_avatar_url: row.get(7)?,
                author_badges: serde_json::from_str(&author_badges_json).unwrap_or_default(),
                author_roles: serde_json::from_str(&author_roles_json).unwrap_or_default(),
                published_at: row.get(10)?,
                received_at: row.get(11)?,
                message_text: row.get(12)?,
                fragments: serde_json::from_str::<Vec<LiveChatMessageFragment>>(&fragments_json)
                    .unwrap_or_default(),
                event_type: serde_json::from_str::<LiveChatEventType>(&event_type_json)
                    .unwrap_or(LiveChatEventType::Message),
                amount_text: row.get(15)?,
                is_deleted: row.get(16)?,
                raw_provider_type: row.get(17)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn latest_quality_status_for_session_locked(
        &self,
        conn: &Connection,
        output_path: Option<&str>,
        mp4_path: Option<&str>,
    ) -> Result<Option<GateStatus>> {
        let mut latest: Option<(String, GateStatus)> = None;
        let mut seen_paths = HashSet::new();

        for path in [mp4_path, output_path].into_iter().flatten() {
            if !seen_paths.insert(path) {
                continue;
            }
            let Some((updated_at, status)) = latest_quality_status_for_path_locked(conn, path)?
            else {
                continue;
            };
            let replace = latest
                .as_ref()
                .map(|(current_updated_at, _)| updated_at.as_str() > current_updated_at.as_str())
                .unwrap_or(true);
            if replace {
                latest = Some((updated_at, status));
            }
        }

        Ok(latest.map(|(_, status)| status))
    }

    fn health_events_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<HealthEvent>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, level, code, message, permission_pane, created_at
             FROM health_events
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let level_json: String = row.get(2)?;
            let permission_json: Option<String> = row.get(5)?;
            Ok(HealthEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                level: serde_json::from_str(&level_json).unwrap_or(HealthLevel::Warn),
                code: row.get(3)?,
                message: row.get(4)?,
                permission_pane: permission_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                created_at: row.get(6)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn session_logs_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<SessionLogEntry>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, level, code, message, source_id, permission_pane, created_at
             FROM session_logs
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let level_json: String = row.get(2)?;
            let permission_json: Option<String> = row.get(6)?;
            Ok(SessionLogEntry {
                id: row.get(0)?,
                session_id: row.get(1)?,
                level: serde_json::from_str(&level_json).unwrap_or(HealthLevel::Warn),
                code: row.get(3)?,
                message: row.get(4)?,
                source_id: row.get(5)?,
                permission_pane: permission_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                created_at: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("SQLite connection lock was poisoned"))
    }
}

fn chat_send_operation_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CommentsSendOperation> {
    let phase_json: String = row.get(3)?;
    let destinations_json: String = row.get(4)?;
    let phase = serde_json::from_str(&phase_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let destinations = serde_json::from_str(&destinations_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(CommentsSendOperation {
        id: row.get(0)?,
        session_id: row.get(1)?,
        text: row.get(2)?,
        phase,
        destinations,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn query_repair_jobs(conn: &Connection, filter: &str) -> Result<Vec<RepairJob>> {
    let sql = format!(
        "SELECT id, file_path, status, intended_fps, expect_audio, outcome_json, reason, created_at, updated_at
         FROM repair_jobs {filter} ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        let status: String = row.get(2)?;
        let expect_audio: i64 = row.get(4)?;
        let outcome_json: Option<String> = row.get(5)?;
        Ok(RepairJob {
            id: row.get(0)?,
            file_path: row.get(1)?,
            status: RepairJobStatus::from_db(&status),
            intended_fps: row.get(3)?,
            expect_audio: expect_audio != 0,
            outcome: outcome_json
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok()),
            reason: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn latest_quality_status_for_path_locked(
    conn: &Connection,
    file_path: &str,
) -> Result<Option<(String, GateStatus)>> {
    let mut stmt = conn.prepare(
        "SELECT outcome_json, reason, updated_at, status
         FROM repair_jobs
         WHERE file_path = ?1
           AND status IN ('completed', 'running')
           AND outcome_json IS NOT NULL
         ORDER BY updated_at DESC, created_at DESC",
    )?;
    let rows = stmt.query_map(params![file_path], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    for row in rows {
        let (outcome_json, reason, updated_at, job_status) = row?;
        if let Ok(status) = serde_json::from_str::<GateStatus>(&outcome_json) {
            if reason.as_deref().is_some_and(|value| !value.is_empty())
                && matches!(
                    status,
                    GateStatus::Ready { .. } | GateStatus::Repaired { .. }
                )
            {
                continue;
            }
            if job_status == "running"
                && matches!(
                    status,
                    GateStatus::Ready { .. } | GateStatus::Repaired { .. }
                )
            {
                continue;
            }
            return Ok(Some((updated_at, status)));
        }
    }

    Ok(None)
}

/// Human label for a session's composition (Library rewrite L1): the layout
/// preset name, or the stream preset for stream-only sessions. Pure + tested.
pub fn session_scene_label(
    layout: &LayoutSettings,
    stream_preset: Option<&str>,
    mode: &str,
) -> Option<String> {
    if mode == "streaming"
        && let Some(preset) = stream_preset
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return Some(preset.to_string());
    }
    Some(
        match layout.layout_preset {
            crate::protocol::LayoutPreset::ScreenCamera => "Screen + Camera",
            crate::protocol::LayoutPreset::ScreenOnly => "Screen only",
            crate::protocol::LayoutPreset::CameraOnly => "Camera only",
            crate::protocol::LayoutPreset::SideBySide => "Side by side",
            crate::protocol::LayoutPreset::Vertical => "Vertical",
        }
        .to_string(),
    )
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;

    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])?;
    Ok(())
}

#[allow(dead_code)]
fn normalized_scopes(scopes: Vec<String>) -> Vec<String> {
    let mut scopes = scopes
        .into_iter()
        .map(|scope| scope.trim().to_string())
        .filter(|scope| !scope.is_empty())
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

pub fn default_database_path() -> PathBuf {
    // Smokes and probes run alongside the owner's real instance; an isolated
    // database (secrets and preview dirs derive from its parent) keeps their
    // assertions away from real accounts and keys.
    if let Some(custom) = std::env::var_os("VIDEORC_DATABASE_PATH") {
        return PathBuf::from(custom);
    }

    #[cfg(target_os = "macos")]
    {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("Videorc")
            .join("videorc.sqlite3")
    }
    #[cfg(target_os = "windows")]
    {
        // %APPDATA% (roaming) is the conventional per-user app data root.
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("Videorc")
            .join("videorc.sqlite3")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home_dir().join(".videorc").join("videorc.sqlite3")
    }
}

fn home_dir() -> PathBuf {
    let var = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_preview_dir() -> PathBuf {
    default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Previews")
}

pub fn default_artifacts_dir() -> PathBuf {
    default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Artifacts")
}

fn validate_screen_image_source(path: &Path) -> Result<()> {
    if !path.exists() {
        anyhow::bail!("Screen image does not exist: {}", path.display());
    }
    if !path.is_file() {
        anyhow::bail!("Screen image is not a file: {}", path.display());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        anyhow::bail!("Screen image must be PNG, JPEG, or WebP.");
    }

    Ok(())
}

fn optimize_screen_image(
    source_path: &Path,
    destination_path: &Path,
    ffmpeg_path: &str,
) -> Result<()> {
    let filter = concat!(
        "[0:v]scale=3840:2160:force_original_aspect_ratio=increase,",
        "crop=3840:2160,gblur=sigma=30,format=rgba,colorchannelmixer=aa=1[bg];",
        "[0:v]scale=3840:2160:force_original_aspect_ratio=decrease[fg];",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24[out]"
    );
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(source_path)
        .arg("-filter_complex")
        .arg(filter)
        .arg("-map")
        .arg("[out]")
        .arg("-frames:v")
        .arg("1")
        .arg(destination_path);
    let output = output_owned_std(&mut command)
        .with_context(|| format!("Could not start {ffmpeg_path} for Screen image import"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    anyhow::bail!(
        "Could not optimize Screen image{}",
        if stderr.is_empty() {
            ".".to_string()
        } else {
            format!(": {stderr}")
        }
    );
}

fn screen_name_from_path(image_path: &str) -> String {
    let stem = Path::new(image_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Screen");
    let words = stem
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(title_case_word)
        .collect::<Vec<_>>();
    if words.is_empty() {
        "Screen".to_string()
    } else {
        words.join(" ")
    }
}

fn title_case_word(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::session_scene_label;

    #[test]
    fn scene_labels_map_presets_and_stream_presets() {
        let mut layout = crate::protocol::default_layout_settings();
        layout.layout_preset = crate::protocol::LayoutPreset::ScreenCamera;
        assert_eq!(
            session_scene_label(&layout, None, "recording").as_deref(),
            Some("Screen + Camera")
        );
        layout.layout_preset = crate::protocol::LayoutPreset::SideBySide;
        assert_eq!(
            session_scene_label(&layout, None, "recording").as_deref(),
            Some("Side by side")
        );
        // Stream-only sessions prefer the stream preset name.
        assert_eq!(
            session_scene_label(&layout, Some("1080p60"), "streaming").as_deref(),
            Some("1080p60")
        );
        // Blank stream presets fall through to the layout label.
        assert_eq!(
            session_scene_label(&layout, Some("  "), "streaming").as_deref(),
            Some("Side by side")
        );
    }

    use super::*;
    use crate::live_chat::{
        CommentsSendOperation, CommentsSendOperationPhase, DestinationDelivery,
        DestinationDeliveryPhase, LiveChatEventType, LiveChatMessage, LiveChatMessageFragment,
        live_chat_message_id,
    };
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode, LayoutPreset,
        OutputSettings, PermissionPane, RtmpPreset, RtmpSettings, SideBySideCameraSide,
        SideBySideSplit, VideoPreset, VideoSettings,
    };
    use crate::streaming::{
        PlatformAccountStatus, StreamPlatform, StreamPrivacy, UpsertPlatformAccount,
        default_stream_metadata_draft,
    };

    fn test_database() -> Database {
        let database = Database {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            path: PathBuf::from(":memory:"),
        };
        database.migrate().unwrap();
        database
    }

    fn temp_screen_image(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("videorc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, b"not a real image").unwrap();
        path
    }

    fn import_stub_screen(database: &Database, name: &str) -> StreamScreen {
        let path = temp_screen_image(name);
        database
            .import_screen_image_with_optimizer(path.to_str().unwrap(), |_, destination| {
                std::fs::write(destination, b"optimized").unwrap();
                Ok(())
            })
            .unwrap()
    }

    fn sample_session(id: &str) -> NewSession {
        NewSession {
            id: id.to_string(),
            title: "Test session".to_string(),
            started_at: "2026-05-31T00:00:00Z".to_string(),
            mode: "record".to_string(),
            output_path: Some("/tmp/videorc-test.mkv".to_string()),
            container: Some("mkv".to_string()),
            stream_preset: None,
            sources: SourceSelection {
                screen_id: Some("screen:avfoundation:1".to_string()),
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            layout: LayoutSettings {
                layout_preset: LayoutPreset::ScreenCamera,
                camera_transform_mode: CameraTransformMode::Preset,
                camera_transform: None,
                camera_corner: CameraCorner::BottomRight,
                camera_size: CameraSize::Medium,
                camera_shape: CameraShape::Rectangle,
                camera_corner_radius_pct: 12,
                camera_aspect: crate::protocol::CameraAspect::Source,
                camera_margin: 32,
                camera_fit: CameraFit::Fill,
                camera_mirror: false,
                camera_zoom: 100,
                camera_offset_x: 0,
                camera_offset_y: 0,
                side_by_side_split: SideBySideSplit::SeventyThirty,
                side_by_side_camera_side: SideBySideCameraSide::Right,
            },
            output: OutputSettings {
                record_enabled: true,
                stream_enabled: false,
                output_directory: None,
                ffmpeg_path: None,
                video: VideoSettings {
                    preset: VideoPreset::Tutorial1440p30,
                    width: 2560,
                    height: 1440,
                    fps: 30,
                    bitrate_kbps: 8000,
                },
                rtmp: RtmpSettings {
                    preset: RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
        }
    }

    fn sample_live_chat_message(session_id: &str, seq: u32) -> LiveChatMessage {
        let provider_message_id = format!("provider-{seq}");
        LiveChatMessage {
            id: live_chat_message_id(
                session_id,
                StreamPlatform::Youtube,
                Some("target-youtube"),
                &provider_message_id,
            ),
            provider_message_id,
            platform: StreamPlatform::Youtube,
            target_id: Some("target-youtube".to_string()),
            session_id: session_id.to_string(),
            author_id: Some(format!("author-{seq}")),
            author_name: format!("Viewer {seq}"),
            author_avatar_url: None,
            author_badges: vec!["member".to_string()],
            author_roles: Vec::new(),
            published_at: format!("2026-06-06T00:00:0{seq}Z"),
            received_at: format!("2026-06-06T00:00:1{seq}Z"),
            message_text: format!("hello {seq}"),
            fragments: vec![LiveChatMessageFragment {
                fragment_type: "text".to_string(),
                text: format!("hello {seq}"),
                image_url: None,
            }],
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: Some("textMessageEvent".to_string()),
        }
    }

    #[test]
    fn boot_reconcile_fails_orphaned_running_sessions_and_leaves_finished_ones() {
        let database = Database::open_in_memory_for_tests();
        database.create_session(&sample_session("orphan")).unwrap();
        database.create_session(&sample_session("done")).unwrap();
        database
            .finish_session(
                "done",
                "completed",
                Some("2026-05-31T00:01:00Z".to_string()),
                None,
                Some(60_000),
            )
            .unwrap();

        let reconciled = database.reconcile_orphaned_sessions().unwrap();
        assert_eq!(reconciled, 1);

        let sessions = database.list_sessions(10).unwrap();
        let orphan = sessions.iter().find(|s| s.id == "orphan").unwrap();
        let done = sessions.iter().find(|s| s.id == "done").unwrap();
        assert_eq!(orphan.status, "failed");
        assert!(orphan.ended_at.is_some());
        assert_eq!(done.status, "completed");

        // Second boot is a no-op.
        assert_eq!(database.reconcile_orphaned_sessions().unwrap(), 0);
    }

    #[test]
    fn default_database_path_uses_application_support_on_macos() {
        let path = default_database_path();
        let rendered = path.display().to_string();

        assert!(rendered.contains("Videorc"));
        assert!(rendered.ends_with("videorc.sqlite3"));
    }

    #[test]
    fn session_payload_round_trips_through_json() {
        let layout = LayoutSettings {
            layout_preset: LayoutPreset::ScreenOnly,
            camera_transform_mode: CameraTransformMode::Preset,
            camera_transform: None,
            camera_corner: CameraCorner::BottomRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Circle,
            camera_corner_radius_pct: 12,
            camera_aspect: crate::protocol::CameraAspect::Source,
            camera_margin: 32,
            camera_fit: CameraFit::Fill,
            camera_mirror: true,
            camera_zoom: 125,
            camera_offset_x: 10,
            camera_offset_y: -5,
            side_by_side_split: SideBySideSplit::SixtyForty,
            side_by_side_camera_side: SideBySideCameraSide::Left,
        };
        let sources = SourceSelection {
            screen_id: Some("screen:avfoundation:1".to_string()),
            window_id: None,
            camera_id: Some("camera:avfoundation:0".to_string()),
            microphone_id: Some("microphone:avfoundation:0".to_string()),
            test_pattern: false,
        };
        let output = OutputSettings {
            record_enabled: true,
            stream_enabled: true,
            output_directory: None,
            ffmpeg_path: None,
            video: VideoSettings {
                preset: VideoPreset::Tutorial1440p30,
                width: 2560,
                height: 1440,
                fps: 30,
                bitrate_kbps: 8000,
            },
            rtmp: RtmpSettings {
                preset: RtmpPreset::YouTube,
                server_url: "rtmp://a.rtmp.youtube.com/live2".to_string(),
                stream_key: "abc".to_string(),
            },
        };

        assert!(
            serde_json::to_string(&layout)
                .unwrap()
                .contains("bottom-right")
        );
        assert!(serde_json::to_string(&sources).unwrap().contains("screen:"));
        assert!(serde_json::to_string(&output).unwrap().contains("youtube"));
    }

    #[test]
    fn session_logs_and_permission_actions_round_trip() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        database
            .add_health_event(
                Some("session-1"),
                HealthLevel::Warn,
                "camera-source-unavailable",
                "Camera permission denied.",
            )
            .unwrap();
        database
            .add_session_log(
                "session-1",
                HealthLevel::Error,
                "screen-capture-fallback",
                "Screen recording permission denied.",
                Some("screen:avfoundation:1"),
            )
            .unwrap();

        let sessions = database.list_sessions(1).unwrap();
        let session = sessions.first().unwrap();

        assert_eq!(
            session.health_events[0].permission_pane,
            Some(PermissionPane::Camera)
        );
        assert_eq!(
            session.session_logs[0].permission_pane,
            Some(PermissionPane::ScreenRecording)
        );
        assert_eq!(
            session.session_logs[0].source_id.as_deref(),
            Some("screen:avfoundation:1")
        );
    }

    #[test]
    fn live_chat_messages_round_trip_and_count_on_session_summary() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        database
            .save_live_chat_message(&sample_live_chat_message("missing-session", 9))
            .unwrap();
        database
            .save_live_chat_message(&sample_live_chat_message("session-1", 1))
            .unwrap();
        let mut updated = sample_live_chat_message("session-1", 1);
        updated.message_text = "edited/deleted text".to_string();
        updated.is_deleted = true;
        database.save_live_chat_message(&updated).unwrap();
        database
            .save_live_chat_message(&sample_live_chat_message("session-1", 2))
            .unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(sessions[0].comment_count, 2);

        let messages = database.list_live_chat_messages("session-1").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].id,
            "session-1:youtube:target-youtube:provider-1"
        );
        assert_eq!(messages[0].message_text, "edited/deleted text");
        assert!(messages[0].is_deleted);
        assert_eq!(messages[1].fragments[0].text, "hello 2");
    }

    #[test]
    fn chat_send_operations_round_trip_and_recover_without_retrying() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();
        let operation = CommentsSendOperation {
            id: "5b0d17a0-8a49-4ef7-a187-6b115ec9cc48".to_string(),
            session_id: "session-1".to_string(),
            text: "hello all".to_string(),
            phase: CommentsSendOperationPhase::Sending,
            destinations: vec![DestinationDelivery {
                destination_id: "twitch".to_string(),
                platform: StreamPlatform::Twitch,
                phase: DestinationDeliveryPhase::Pending,
                provider_message_id: None,
                reason: None,
            }],
            created_at: "2026-07-10T00:00:00Z".to_string(),
            updated_at: "2026-07-10T00:00:00Z".to_string(),
        };
        database.save_chat_send_operation(&operation).unwrap();
        assert_eq!(
            database.get_chat_send_operation(&operation.id).unwrap(),
            Some(operation.clone())
        );

        assert_eq!(
            database.reconcile_orphaned_chat_send_operations().unwrap(),
            1
        );
        let recovered = database
            .get_chat_send_operation(&operation.id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.phase, CommentsSendOperationPhase::DeliveryUnknown);
        assert_eq!(
            recovered.destinations[0].phase,
            DestinationDeliveryPhase::TimedOutUnknown
        );
        assert_eq!(
            recovered.destinations[0].reason.as_deref(),
            Some("interrupted-before-confirmation")
        );
        assert_eq!(
            database.list_chat_send_operations("session-1").unwrap(),
            vec![recovered]
        );
    }

    #[test]
    fn same_provider_message_id_is_distinct_across_sessions() {
        let database = test_database();
        for session_id in ["session-1", "session-2"] {
            database
                .create_session(&sample_session(session_id))
                .unwrap();
            database
                .save_live_chat_message(&sample_live_chat_message(session_id, 1))
                .unwrap();
        }
        let first = database.list_live_chat_messages("session-1").unwrap();
        let second = database.list_live_chat_messages("session-2").unwrap();
        assert_ne!(first[0].id, second[0].id);
        assert_eq!(first[0].provider_message_id, second[0].provider_message_id);
    }

    #[test]
    fn session_recording_path_stays_on_the_original_container() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        assert_eq!(
            database
                .session_recording_path("session-1")
                .unwrap()
                .as_deref(),
            Some("/tmp/videorc-test.mkv")
        );

        database
            .finish_session(
                "session-1",
                "completed",
                None,
                Some("/tmp/videorc-test.mp4".to_string()),
                None,
            )
            .unwrap();

        assert_eq!(
            database
                .session_recording_path("session-1")
                .unwrap()
                .as_deref(),
            Some("/tmp/videorc-test.mkv")
        );
    }

    #[test]
    fn session_media_candidates_lists_all_paths_in_preference_order() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        // Before the mp4 export exists: only the original container.
        assert_eq!(
            database.session_media_candidates("session-1").unwrap(),
            vec!["/tmp/videorc-test.mkv".to_string()]
        );

        database
            .finish_session(
                "session-1",
                "completed",
                None,
                Some("/tmp/videorc-test.mp4".to_string()),
                None,
            )
            .unwrap();

        // mp4 preferred, but the original stays available as a fallback for
        // callers that check disk existence (AI extraction).
        assert_eq!(
            database.session_media_candidates("session-1").unwrap(),
            vec![
                "/tmp/videorc-test.mp4".to_string(),
                "/tmp/videorc-test.mkv".to_string()
            ]
        );

        assert!(
            database
                .session_media_candidates("missing-session")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn session_summary_includes_saved_final_diagnostics() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        let mut diagnostics = crate::diagnostics::starting_diagnostics("session-1", 30, "record");
        diagnostics.encoder_bridge_repeated_frames = 4;
        diagnostics.encoder_bridge_repeated_frame_bursts = 1;
        diagnostics.encoder_bridge_max_repeated_frame_run = 3;
        diagnostics.recording_at_risk = true;
        diagnostics
            .recording_risk_reasons
            .push("4 duplicate frame(s) re-fed to the encoder".to_string());
        database
            .save_session_diagnostics("session-1", &diagnostics)
            .unwrap();

        let sessions = database.list_sessions(1).unwrap();
        let final_diagnostics = sessions[0]
            .final_diagnostics
            .as_ref()
            .expect("final diagnostics");
        assert_eq!(final_diagnostics.session_id.as_deref(), Some("session-1"));
        assert_eq!(final_diagnostics.encoder_bridge_repeated_frames, 4);
        assert!(final_diagnostics.recording_at_risk);
        assert_eq!(
            final_diagnostics.recording_risk_reasons,
            vec!["4 duplicate frame(s) re-fed to the encoder".to_string()]
        );
    }

    #[test]
    fn session_summary_includes_latest_completed_quality_gate_for_recording_file() {
        use crate::repair::{GateStatus, QualityExpectations, RepairOutcome};

        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();
        database
            .finish_session(
                "session-1",
                "completed",
                None,
                Some("/tmp/videorc-test.mp4".to_string()),
                Some(1000),
            )
            .unwrap();

        let expectations = QualityExpectations {
            intended_fps: Some(30.0),
            expect_audio: true,
        };
        let mut older_output_job = RepairJob::pending(
            "job-output-ready".to_string(),
            "/tmp/videorc-test.mkv".to_string(),
            &expectations,
            "t0".to_string(),
        );
        older_output_job.complete_with_gate(
            &GateStatus::Ready {
                path: "/tmp/videorc-test.mkv".to_string(),
            },
            "t1".to_string(),
        );
        let mut latest_mp4_gate = RepairJob::pending(
            "job-mp4-not-100".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        latest_mp4_gate.complete_with_gate(
            &GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Frozen video segment detected.".to_string()],
                needs_attention: false,
            },
            "t2".to_string(),
        );
        database.upsert_repair_job(&older_output_job).unwrap();
        database.upsert_repair_job(&latest_mp4_gate).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Frozen video segment detected.".to_string()],
                needs_attention: false,
            })
        );

        let mut running_fast_gate = RepairJob::pending(
            "job-running-fast-not-100".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        running_fast_gate.mark_running("t3".to_string());
        running_fast_gate.outcome = serde_json::to_value(&GateStatus::NotHundredPercent {
            path: "/tmp/videorc-test.mp4".to_string(),
            reasons: vec!["Only 8fps observed while live.".to_string()],
            needs_attention: false,
        })
        .ok();
        database.upsert_repair_job(&running_fast_gate).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Only 8fps observed while live.".to_string()],
                needs_attention: false,
            })
        );

        let mut stale_repair_outcome = RepairJob::pending(
            "job-stale-repaired".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        stale_repair_outcome.complete(
            &RepairOutcome::Repaired {
                path: "/tmp/videorc-test.mp4".to_string(),
                interpolated: true,
            },
            "t3".to_string(),
        );
        stale_repair_outcome.reason =
            Some("quality check deferred because capture started".to_string());
        database.upsert_repair_job(&stale_repair_outcome).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Only 8fps observed while live.".to_string()],
                needs_attention: false,
            })
        );

        let mut newer_repair_outcome = RepairJob::pending(
            "job-newer-repaired".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        newer_repair_outcome.complete(
            &RepairOutcome::Repaired {
                path: "/tmp/videorc-test.mp4".to_string(),
                interpolated: true,
            },
            "t4".to_string(),
        );
        database.upsert_repair_job(&newer_repair_outcome).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::Repaired {
                path: "/tmp/videorc-test.mp4".to_string(),
                interpolated: true,
            })
        );
    }

    #[test]
    fn imported_screen_images_infer_names_and_persist_in_order() {
        let database = test_database();
        let first = import_stub_screen(&database, "be-right_back.png");
        let second = import_stub_screen(&database, "ending.png");

        assert_eq!(first.name, "Be Right Back");
        assert_eq!(first.status, StreamScreenStatus::Ready);
        assert_eq!(first.sort_order, 0);
        assert!(first.image_path.ends_with(".png"));
        assert!(Path::new(&first.image_path).exists());
        assert_eq!(second.name, "Ending");
        assert_eq!(second.sort_order, 1);

        let screens = database.list_stream_screens().unwrap();
        assert_eq!(screens.len(), 2);
        assert_eq!(screens[0].id, first.id);
        assert_eq!(screens[1].id, second.id);
    }

    #[test]
    fn imported_screen_images_reject_unsupported_formats() {
        let database = test_database();
        let path = temp_screen_image("notes.txt");

        let error = database
            .import_screen_image_with_optimizer(path.to_str().unwrap(), |_, _| {
                panic!("unsupported inputs should not be optimized");
            })
            .unwrap_err();

        assert!(error.to_string().contains("PNG, JPEG, or WebP"));
    }

    #[test]
    fn stream_screens_can_be_renamed_reordered_and_deleted() {
        let database = test_database();
        let first = import_stub_screen(&database, "first.png");
        let second = import_stub_screen(&database, "second.png");

        let renamed = database
            .rename_stream_screen(&first.id, "  Main Break  ")
            .unwrap();
        assert_eq!(renamed.name, "Main Break");

        let reordered = database
            .reorder_stream_screens(&[second.id.clone(), first.id.clone()])
            .unwrap();
        assert_eq!(reordered[0].id, second.id);
        assert_eq!(reordered[0].sort_order, 0);
        assert_eq!(reordered[1].id, first.id);
        assert_eq!(reordered[1].sort_order, 1);

        let first_image_path = renamed.image_path.clone();
        assert!(Path::new(&first_image_path).exists());
        database.delete_stream_screen(&first.id).unwrap();
        assert!(!Path::new(&first_image_path).exists());

        let screens = database.list_stream_screens().unwrap();
        assert_eq!(screens.len(), 1);
        assert_eq!(screens[0].id, second.id);
    }

    #[test]
    fn stream_screens_report_missing_when_optimized_file_disappears() {
        let database = test_database();
        let screen = import_stub_screen(&database, "break.png");
        std::fs::remove_file(&screen.image_path).unwrap();

        let screens = database.list_stream_screens().unwrap();
        assert_eq!(screens[0].status, StreamScreenStatus::Missing);
    }

    #[test]
    fn active_stream_screen_persists_and_clears() {
        let database = test_database();
        let first = import_stub_screen(&database, "first.png");
        let second = import_stub_screen(&database, "second.png");

        assert!(database.active_stream_screen().unwrap().is_none());

        let active = database.activate_stream_screen(&first.id).unwrap();
        assert_eq!(active.id, first.id);
        assert_eq!(
            database.active_stream_screen().unwrap().unwrap().id,
            first.id
        );

        database.activate_stream_screen(&second.id).unwrap();
        assert_eq!(
            database.active_stream_screen().unwrap().unwrap().id,
            second.id
        );

        database.clear_active_stream_screen().unwrap();
        assert!(database.active_stream_screen().unwrap().is_none());
    }

    #[test]
    fn active_stream_screen_rejects_missing_images_and_clears_on_delete() {
        let database = test_database();
        let screen = import_stub_screen(&database, "break.png");

        database.activate_stream_screen(&screen.id).unwrap();
        database.delete_stream_screen(&screen.id).unwrap();
        assert!(database.active_stream_screen().unwrap().is_none());

        let missing = import_stub_screen(&database, "missing.png");
        std::fs::remove_file(&missing.image_path).unwrap();
        let error = database.activate_stream_screen(&missing.id).unwrap_err();
        assert!(error.to_string().contains("missing"));
    }

    #[test]
    fn stream_metadata_draft_defaults_and_persists() {
        let database = test_database();

        let default_draft = database.stream_metadata_draft().unwrap();
        assert_eq!(default_draft.default_privacy, StreamPrivacy::Private);
        assert_eq!(
            default_draft
                .target_overrides
                .iter()
                .map(|target| target.platform)
                .collect::<Vec<_>>(),
            vec![
                StreamPlatform::Youtube,
                StreamPlatform::Twitch,
                StreamPlatform::X
            ]
        );
        assert_eq!(
            default_draft
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::Twitch)
                .unwrap()
                .twitch_language
                .as_deref(),
            Some("en")
        );

        let mut draft = default_stream_metadata_draft("old".to_string());
        draft.title = "Launch stream".to_string();
        draft.description = "Global description".to_string();
        draft.default_privacy = StreamPrivacy::Unlisted;
        let twitch = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        twitch.customize = true;
        twitch.title = "Twitch launch".to_string();
        twitch.description = "Twitch description".to_string();
        twitch.privacy = StreamPrivacy::Public;
        twitch.twitch_category_id = Some("509658".to_string());
        twitch.twitch_category_name = Some("Just Chatting".to_string());
        twitch.twitch_language = Some("es".to_string());

        let saved = database.save_stream_metadata_draft(draft).unwrap();
        assert_ne!(saved.updated_at, "old");
        assert!(
            saved
                .target_overrides
                .iter()
                .all(|target| target.updated_at == saved.updated_at)
        );
        assert_eq!(
            saved
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::Twitch)
                .unwrap()
                .twitch_category_name
                .as_deref(),
            Some("Just Chatting")
        );

        assert_eq!(database.stream_metadata_draft().unwrap(), saved);
    }

    #[test]
    fn platform_accounts_persist_without_exposing_secret_refs() {
        let database = test_database();

        let account = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: Some("https://example.test/avatar.png".to_string()),
                scopes: vec![
                    "youtube.force-ssl".to_string(),
                    " youtube.readonly ".to_string(),
                    "youtube.force-ssl".to_string(),
                    "".to_string(),
                ],
                token_secret_ref: Some("platform:youtube:channel-123:access".to_string()),
                refresh_token_secret_ref: Some("platform:youtube:channel-123:refresh".to_string()),
                stream_key_secret_ref: Some("platform:youtube:channel-123:stream-key".to_string()),
                expires_at: Some("2026-06-03T12:00:00Z".to_string()),
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        assert_eq!(account.platform, StreamPlatform::Youtube);
        assert_eq!(account.account_label, "Main Channel");
        assert_eq!(
            account.scopes,
            vec![
                "youtube.force-ssl".to_string(),
                "youtube.readonly".to_string()
            ]
        );
        assert!(account.access_token_present);
        assert!(account.refresh_token_present);
        assert!(account.stream_key_present);

        let json = serde_json::to_string(&account).unwrap();
        assert!(!json.contains("secretRef"));
        assert!(!json.contains("platform:youtube"));

        let accounts = database.list_platform_accounts().unwrap();
        assert_eq!(accounts, vec![account]);
    }

    #[test]
    fn platform_accounts_are_one_per_platform_and_disconnect_deletes_secrets() {
        let database = test_database();
        database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Twitch,
                account_id: "first".to_string(),
                account_label: "First Twitch".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: vec!["channel:manage:broadcast".to_string()],
                token_secret_ref: Some("platform:twitch:first:access".to_string()),
                refresh_token_secret_ref: None,
                stream_key_secret_ref: Some("platform:twitch:first:stream-key".to_string()),
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();
        let updated = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Twitch,
                account_id: "second".to_string(),
                account_label: "Second Twitch".to_string(),
                account_handle: Some("second".to_string()),
                avatar_url: None,
                scopes: vec!["channel:read:stream_key".to_string()],
                token_secret_ref: Some("platform:twitch:second:access".to_string()),
                refresh_token_secret_ref: Some("platform:twitch:second:refresh".to_string()),
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::NeedsReconnect,
            })
            .unwrap();

        let accounts = database.list_platform_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, updated.id);
        assert_eq!(accounts[0].account_id, "second");
        assert!(accounts[0].refresh_token_present);
        assert!(!accounts[0].stream_key_present);

        let mut deleted = Vec::new();
        let disconnected = database
            .disconnect_platform_account_with_secret_deleter(StreamPlatform::Twitch, |secret_ref| {
                deleted.push(secret_ref.to_string());
                Ok(())
            })
            .unwrap()
            .unwrap();
        assert_eq!(disconnected.account_id, "second");
        assert_eq!(
            deleted,
            vec![
                "platform:twitch:second:access".to_string(),
                "platform:twitch:second:refresh".to_string()
            ]
        );
        assert!(database.list_platform_accounts().unwrap().is_empty());
    }

    #[test]
    fn platform_account_reconnect_preserves_refresh_token_for_same_account() {
        let database = test_database();
        database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: None,
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: Some("platform:youtube:oauth:refresh".to_string()),
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        let reconnected = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: Some("https://example.test/avatar.png".to_string()),
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        assert!(reconnected.refresh_token_present);
        let credentials = database.list_platform_account_credentials().unwrap();
        assert_eq!(
            credentials[0].refresh_token_secret_ref.as_deref(),
            Some("platform:youtube:oauth:refresh")
        );
    }

    #[test]
    fn platform_account_reconnect_without_refresh_token_clears_other_account_token() {
        let database = test_database();
        database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: None,
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: Some("platform:youtube:oauth:refresh".to_string()),
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        let switched = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-456".to_string(),
                account_label: "Brand Channel".to_string(),
                account_handle: Some("@brand".to_string()),
                avatar_url: None,
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        assert!(!switched.refresh_token_present);
        let credentials = database.list_platform_account_credentials().unwrap();
        assert_eq!(credentials[0].refresh_token_secret_ref, None);
    }

    #[test]
    fn platform_accounts_reject_custom_and_blank_labels() {
        let database = test_database();
        let error = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Custom,
                account_id: "custom".to_string(),
                account_label: "Custom".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: vec![],
                token_secret_ref: None,
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap_err();
        assert!(error.to_string().contains("Custom RTMP"));

        let error = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::X,
                account_id: "x-account".to_string(),
                account_label: " ".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: vec![],
                token_secret_ref: None,
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap_err();
        assert!(error.to_string().contains("label"));
    }

    #[test]
    fn incomplete_repair_jobs_round_trip_and_exclude_finished() {
        use crate::repair::{QualityExpectations, RepairOutcome};

        let database = test_database();
        let expectations = QualityExpectations {
            intended_fps: Some(30.0),
            expect_audio: true,
        };

        let pending = RepairJob::pending(
            "job-pending".to_string(),
            "/m/a.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        let mut running = RepairJob::pending(
            "job-running".to_string(),
            "/m/b.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        running.mark_running("t1".to_string());
        let mut done = RepairJob::pending(
            "job-done".to_string(),
            "/m/c.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        done.complete(
            &RepairOutcome::Repaired {
                path: "/m/c.mp4".to_string(),
                interpolated: true,
            },
            "t1".to_string(),
        );

        database.upsert_repair_job(&pending).unwrap();
        database.upsert_repair_job(&running).unwrap();
        database.upsert_repair_job(&done).unwrap();

        // Only pending + running come back for resume; the completed job is excluded.
        let mut incomplete = database.incomplete_repair_jobs().unwrap();
        incomplete.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<_> = incomplete.iter().map(|job| job.id.clone()).collect();
        assert_eq!(
            ids,
            vec!["job-pending".to_string(), "job-running".to_string()]
        );

        // Fields round-trip through the DB.
        let running_back = incomplete
            .iter()
            .find(|job| job.id == "job-running")
            .unwrap();
        assert_eq!(running_back.status, RepairJobStatus::Running);
        assert_eq!(running_back.intended_fps, Some(30.0));
        assert!(running_back.expect_audio);

        // Upsert updates in place: cancelling the pending job removes it from the set.
        let mut cancelled = pending;
        cancelled.cancel("t2".to_string());
        database.upsert_repair_job(&cancelled).unwrap();
        let incomplete = database.incomplete_repair_jobs().unwrap();
        assert_eq!(incomplete.len(), 1);
        assert_eq!(incomplete[0].id, "job-running");
    }
}
