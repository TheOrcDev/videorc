use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::protocol::{
    AiArtifact, AiArtifactKind, AiArtifactStatus, HealthEvent, HealthLevel, LayoutSettings,
    OutputSettings, SessionSummary, SourceSelection,
};

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
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

    pub fn session_output_path(&self, session_id: &str) -> Result<Option<String>> {
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
        let event = HealthEvent {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.map(str::to_string),
            level,
            code: code.to_string(),
            message: message.to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO health_events (id, session_id, level, code, message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.id,
                event.session_id,
                serde_json::to_string(&event.level)?,
                event.code,
                event.message,
                event.created_at,
            ],
        )?;
        Ok(event)
    }

    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SessionSummary>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, status, mode, output_path, mp4_path,
                    stream_preset, container, duration_ms, sources_json, layout_json
             FROM sessions
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let id: String = row.get(0)?;
            let sources_json: String = row.get(11)?;
            let layout_json: String = row.get(12)?;
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
            ) = row?;

            sessions.push(SessionSummary {
                health_events: self.health_events_for_session_locked(&conn, &id)?,
                ai_artifacts: self.ai_artifacts_for_session_locked(&conn, &id)?,
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
                sources: serde_json::from_str(&sources_json)?,
                layout: serde_json::from_str(&layout_json)?,
            });
        }

        Ok(sessions)
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
                output_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS health_events (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                level TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
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

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )?;
        ensure_column(&conn, "sessions", "container", "container TEXT")?;
        ensure_column(&conn, "sessions", "duration_ms", "duration_ms INTEGER")?;
        Ok(())
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

    fn health_events_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<HealthEvent>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, level, code, message, created_at
             FROM health_events
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let level_json: String = row.get(2)?;
            Ok(HealthEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                level: serde_json::from_str(&level_json).unwrap_or(HealthLevel::Warn),
                code: row.get(3)?,
                message: row.get(4)?,
                created_at: row.get(5)?,
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

pub fn default_database_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Videorc")
            .join("videorc.sqlite3")
    } else {
        home.join(".videorc").join("videorc.sqlite3")
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, OutputSettings, RtmpPreset, RtmpSettings,
        VideoPreset, VideoSettings,
    };

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
            camera_corner: CameraCorner::BottomRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Circle,
            camera_margin: 32,
            camera_fit: CameraFit::Fill,
            camera_mirror: true,
            camera_zoom: 125,
            camera_offset_x: 10,
            camera_offset_y: -5,
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
}
