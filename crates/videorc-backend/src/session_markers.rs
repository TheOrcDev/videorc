//! Titled points on capture timelines. Clip ranges retain their own semantics.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::protocol::ClipMarkSource;
use crate::state::AppState;
use crate::storage::Database;

pub const MARKER_LABEL_MAX_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMarker {
    pub id: String,
    pub session_id: String,
    pub at_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub source: ClipMarkSource,
    pub created_at: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum MarkerLookup {
    Found { marker: SessionMarker },
    Deleted { revision: u64 },
    Absent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkerPage {
    pub markers: Vec<SessionMarker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkerChanged {
    pub session_id: String,
    pub marker_id: String,
    pub revision: u64,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<SessionMarker>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMarkerParams {
    pub operation_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkerParams {
    pub session_id: String,
    pub marker_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameMarkerParams {
    pub session_id: String,
    pub marker_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListMarkersParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, thiserror::Error)]
pub enum MarkerError {
    #[error("{message}")]
    Refused { code: &'static str, message: String },
    #[error("Could not save the marker: {0}")]
    Storage(#[from] anyhow::Error),
}

impl MarkerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused { code, .. } => code,
            Self::Storage(_) => "marker-storage-failed",
        }
    }
}

impl From<serde_json::Error> for MarkerError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.into())
    }
}

fn refused(code: &'static str, message: &str) -> MarkerError {
    MarkerError::Refused {
        code,
        message: message.to_string(),
    }
}

pub fn normalize_label(label: Option<&str>) -> std::result::Result<Option<String>, MarkerError> {
    let Some(label) = label else { return Ok(None) };
    if label
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err(refused(
            "invalid-params",
            "A marker title must be one line without control characters.",
        ));
    }
    let label = label.trim();
    if label.chars().count() > MARKER_LABEL_MAX_CHARS {
        return Err(refused(
            "invalid-params",
            "A marker title can have at most 120 characters.",
        ));
    }
    Ok((!label.is_empty()).then(|| label.to_string()))
}

fn validate_id(value: &str) -> std::result::Result<(), MarkerError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(refused(
            "invalid-params",
            "The marker session or ID is invalid.",
        ));
    }
    Ok(())
}

fn create_hash(params: &CreateMarkerParams, source: ClipMarkSource) -> String {
    // Structured encoding distinguishes absent titles and delimiters safely.
    let bytes = serde_json::to_vec(&(&params.session_id, &params.label, source)).unwrap();
    format!("{:x}", Sha256::digest(bytes))
}

fn normalize_create(
    mut params: CreateMarkerParams,
) -> std::result::Result<CreateMarkerParams, MarkerError> {
    validate_id(&params.session_id)?;
    let uuid = uuid::Uuid::parse_str(&params.operation_id)
        .map_err(|_| refused("invalid-params", "The marker operation ID must be a UUID."))?;
    if uuid.to_string() != params.operation_id {
        return Err(refused(
            "invalid-params",
            "The marker operation ID must be a canonical UUID.",
        ));
    }
    params.label = normalize_label(params.label.as_deref())?;
    Ok(params)
}

fn marker_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionMarker> {
    let source: String = row.get(4)?;
    Ok(SessionMarker {
        id: row.get(0)?,
        session_id: row.get(1)?,
        at_seconds: row.get(2)?,
        label: row.get(3)?,
        source: if source == "voice" {
            ClipMarkSource::Voice
        } else {
            ClipMarkSource::Manual
        },
        created_at: row.get(5)?,
        revision: row.get(6)?,
    })
}

fn lookup(conn: &Connection, session: &str, id: &str) -> Result<MarkerLookup> {
    let row = conn
        .query_row(
            "SELECT id, session_id, at_seconds, label, source, created_at, revision, deleted_at
         FROM clip_marks WHERE session_id=?1 AND id=?2 AND mark_kind='marker'",
            params![session, id],
            |row| Ok((marker_row(row)?, row.get::<_, Option<String>>(7)?)),
        )
        .optional()?;
    Ok(match row {
        Some((marker, Some(_))) => MarkerLookup::Deleted {
            revision: marker.revision,
        },
        Some((marker, None)) => MarkerLookup::Found { marker },
        None => MarkerLookup::Absent,
    })
}

impl Database {
    pub(crate) fn marker_lookup(&self, session: &str, id: &str) -> Result<MarkerLookup> {
        lookup(&*self.lock()?, session, id)
    }

    pub(crate) fn marker_replay(
        &self,
        params: &CreateMarkerParams,
        source: ClipMarkSource,
    ) -> std::result::Result<Option<SessionMarker>, MarkerError> {
        let conn = self.lock()?;
        marker_replay(&conn, params, source)
    }

    pub(crate) fn insert_marker(
        &self,
        params: &CreateMarkerParams,
        source: ClipMarkSource,
        at_seconds: f64,
    ) -> std::result::Result<(SessionMarker, bool), MarkerError> {
        if !at_seconds.is_finite() || !(0.0..=1_000_000_000.0).contains(&at_seconds) {
            return Err(refused("invalid-params", "The marker time is invalid."));
        }
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(anyhow::Error::from)?;
        if let Some(existing) = marker_replay(&tx, params, source)? {
            return Ok((existing, false));
        }
        let marker = SessionMarker {
            id: params.operation_id.clone(),
            session_id: params.session_id.clone(),
            at_seconds,
            label: params.label.clone(),
            source,
            created_at: Utc::now().to_rfc3339(),
            revision: 1,
        };
        tx.execute(
            "INSERT INTO clip_marks (id,session_id,at_seconds,source,created_at,mark_kind,label,create_payload_hash,revision)
             VALUES (?1,?2,?3,?4,?5,'marker',?6,?7,1)",
            params![marker.id,marker.session_id,marker.at_seconds,
                if source == ClipMarkSource::Voice { "voice" } else { "manual" },
                marker.created_at,marker.label,create_hash(params,source)],
        ).map_err(anyhow::Error::from)?;
        tx.commit().map_err(anyhow::Error::from)?;
        Ok((marker, true))
    }

    pub(crate) fn marker_page(
        &self,
        params: &ListMarkersParams,
    ) -> std::result::Result<MarkerPage, MarkerError> {
        validate_id(&params.session_id)?;
        let limit = params.limit.unwrap_or(200);
        if !(1..=500).contains(&limit) {
            return Err(refused(
                "invalid-params",
                "Marker page size must be 1 to 500.",
            ));
        }
        let conn = self.lock()?;
        let cursor = match params.cursor.as_deref() {
            Some(id) => {
                validate_id(id)?;
                Some(conn.query_row("SELECT at_seconds,id FROM clip_marks WHERE session_id=?1 AND id=?2 AND mark_kind='marker'",
                    params![params.session_id,id], |r| Ok((r.get::<_,f64>(0)?, r.get::<_,String>(1)?)))
                    .optional().map_err(anyhow::Error::from)?
                    .ok_or_else(|| refused("invalid-params", "That marker cursor does not belong to this session."))?)
            }
            None => None,
        };
        let mut stmt = conn
            .prepare(
                "SELECT id,session_id,at_seconds,label,source,created_at,revision FROM clip_marks
             WHERE session_id=?1 AND mark_kind='marker' AND deleted_at IS NULL
             AND (?2 IS NULL OR at_seconds>?2 OR (at_seconds=?2 AND id>?3))
             ORDER BY at_seconds,id LIMIT ?4",
            )
            .map_err(anyhow::Error::from)?;
        let mut markers = stmt
            .query_map(
                params![
                    params.session_id,
                    cursor.as_ref().map(|c| c.0),
                    cursor.as_ref().map(|c| c.1.as_str()),
                    limit + 1
                ],
                marker_row,
            )
            .map_err(anyhow::Error::from)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(anyhow::Error::from)?;
        let more = markers.len() > limit;
        markers.truncate(limit);
        let next_cursor = more.then(|| markers.last().unwrap().id.clone());
        Ok(MarkerPage {
            markers,
            next_cursor,
        })
    }

    pub(crate) fn change_marker(
        &self,
        params: &MarkerParams,
        label: Option<Option<String>>,
    ) -> std::result::Result<(MarkerChanged, bool), MarkerError> {
        validate_id(&params.session_id)?;
        validate_id(&params.marker_id)?;
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(anyhow::Error::from)?;
        let marker = match lookup(&tx, &params.session_id, &params.marker_id)? {
            MarkerLookup::Found { marker } => marker,
            MarkerLookup::Deleted { revision } if label.is_none() => {
                return Ok((
                    MarkerChanged {
                        session_id: params.session_id.clone(),
                        marker_id: params.marker_id.clone(),
                        revision,
                        deleted: true,
                        marker: None,
                    },
                    false,
                ));
            }
            MarkerLookup::Absent if label.is_none() => {
                return Ok((
                    MarkerChanged {
                        session_id: params.session_id.clone(),
                        marker_id: params.marker_id.clone(),
                        revision: 0,
                        deleted: true,
                        marker: None,
                    },
                    false,
                ));
            }
            _ => {
                return Err(refused(
                    "marker-not-found",
                    "That marker is no longer available.",
                ));
            }
        };
        let mut changed = MarkerChanged {
            session_id: marker.session_id.clone(),
            marker_id: marker.id.clone(),
            revision: marker.revision + 1,
            deleted: label.is_none(),
            marker: None,
        };
        match label {
            Some(label) => {
                if label == marker.label {
                    changed.revision = marker.revision;
                    changed.marker = Some(marker);
                    return Ok((changed, false));
                }
                tx.execute(
                    "UPDATE clip_marks SET label=?1,revision=?2 WHERE id=?3",
                    params![label, changed.revision, marker.id],
                )
                .map_err(anyhow::Error::from)?;
                changed.marker = Some(SessionMarker {
                    label,
                    revision: changed.revision,
                    ..marker
                });
            }
            None => {
                tx.execute("UPDATE clip_marks SET label=NULL,phrase=NULL,deleted_at=?1,revision=?2 WHERE id=?3",
                params![Utc::now().to_rfc3339(),changed.revision,marker.id]).map_err(anyhow::Error::from)?;
            }
        }
        tx.commit().map_err(anyhow::Error::from)?;
        Ok((changed, true))
    }
}

fn marker_replay(
    conn: &Connection,
    params: &CreateMarkerParams,
    source: ClipMarkSource,
) -> std::result::Result<Option<SessionMarker>, MarkerError> {
    let existing: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT session_id,create_payload_hash,deleted_at FROM clip_marks WHERE id=?1",
            params![params.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(anyhow::Error::from)?;
    let Some((session, hash, deleted)) = existing else {
        return Ok(None);
    };
    if session != params.session_id || hash.as_deref() != Some(create_hash(params, source).as_str())
    {
        return Err(refused(
            "marker-operation-conflict",
            "That operation ID belongs to a different marker request.",
        ));
    }
    if deleted.is_some() {
        return Err(refused(
            "marker-deleted",
            "That marker was deleted. It will not be recreated.",
        ));
    }
    match lookup(conn, &session, &params.operation_id)? {
        MarkerLookup::Found { marker } => Ok(Some(marker)),
        _ => Err(refused(
            "marker-not-found",
            "That marker is no longer available.",
        )),
    }
}

pub async fn create_manual(
    state: &AppState,
    params: CreateMarkerParams,
) -> std::result::Result<SessionMarker, MarkerError> {
    let params = normalize_create(params)?;
    if let Some(marker) = state
        .database
        .marker_replay(&params, ClipMarkSource::Manual)?
    {
        return Ok(marker);
    }
    let status = crate::current_recording_status(state).await;
    if !matches!(
        status.state,
        crate::protocol::RecordingState::Recording | crate::protocol::RecordingState::Streaming
    ) {
        return Err(refused(
            "marker-session-unavailable",
            "Start a recording or livestream before making a marker.",
        ));
    }
    let recording = state.recording.lock().await;
    let active = recording.as_ref().ok_or_else(|| {
        refused(
            "no-active-session",
            "No recording or livestream is running.",
        )
    })?;
    if active.session_id != params.session_id {
        return Err(refused(
            "stale-session",
            "That recording or livestream is no longer active.",
        ));
    }
    if active.stop_requested || state.process_shutdown_requested() {
        return Err(refused(
            "session-stopping",
            "The session is stopping; no new marker was saved.",
        ));
    }
    let (marker, inserted) = state.database.insert_marker(
        &params,
        ClipMarkSource::Manual,
        active.capture_elapsed_seconds(),
    )?;
    drop(recording);
    if inserted {
        state.emit_event("session.marker.created", marker.clone())
    }
    Ok(marker)
}

pub(crate) fn commit_voice(
    state: &AppState,
    params: CreateMarkerParams,
    at_seconds: f64,
) -> std::result::Result<SessionMarker, MarkerError> {
    let params = normalize_create(params)?;
    let (marker, inserted) =
        state
            .database
            .insert_marker(&params, ClipMarkSource::Voice, at_seconds)?;
    if inserted {
        state.emit_event("session.marker.created", marker.clone())
    }
    Ok(marker)
}

pub async fn dispatch(
    state: &AppState,
    method: &str,
    value: serde_json::Value,
) -> std::result::Result<serde_json::Value, MarkerError> {
    fn parse<T: serde::de::DeserializeOwned>(
        value: serde_json::Value,
    ) -> std::result::Result<T, MarkerError> {
        serde_json::from_value(value)
            .map_err(|_| refused("invalid-params", "The marker request is invalid."))
    }
    let result = match method {
        "session.marker.create" => {
            serde_json::to_value(create_manual(state, parse(value)?).await?)?
        }
        "session.markers.list" => {
            serde_json::to_value(state.database.marker_page(&parse(value)?)?)?
        }
        "session.marker.get" => {
            let p: MarkerParams = parse(value)?;
            validate_id(&p.session_id)?;
            validate_id(&p.marker_id)?;
            serde_json::to_value(state.database.marker_lookup(&p.session_id, &p.marker_id)?)?
        }
        "session.marker.rename" => {
            let p: RenameMarkerParams = parse(value)?;
            let (changed, emit) = state.database.change_marker(
                &MarkerParams {
                    session_id: p.session_id,
                    marker_id: p.marker_id,
                },
                Some(normalize_label(p.label.as_deref())?),
            )?;
            if emit {
                state.emit_event("session.marker.changed", changed.clone())
            }
            serde_json::to_value(changed.marker.unwrap())?
        }
        "session.marker.delete" => {
            let (changed, emit) = state.database.change_marker(&parse(value)?, None)?;
            if emit {
                state.emit_event("session.marker.changed", changed.clone())
            }
            serde_json::to_value(changed)?
        }
        _ => return Err(refused("invalid-params", "Unknown marker operation.")),
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Database {
        let db = Database::open_in_memory_for_tests();
        // Minimal existing session owner: no local media is needed.
        db.lock().unwrap().execute("INSERT INTO sessions (id,title,started_at,status,mode,sources_json,layout_json,output_json) VALUES ('a','Stream','2026-10-05T12:00:00Z','completed','stream','{}','{}','{}')",[]).unwrap();
        db
    }
    fn request(label: Option<&str>) -> CreateMarkerParams {
        CreateMarkerParams {
            operation_id: uuid::Uuid::new_v4().to_string(),
            session_id: "a".into(),
            label: label.map(str::to_string),
        }
    }
    #[test]
    fn label_validation_preserves_unicode_and_does_not_truncate() {
        assert_eq!(
            normalize_label(Some("  Shadcn New Library  ")).unwrap(),
            Some("Shadcn New Library".into())
        );
        assert!(normalize_label(Some(&"🦉".repeat(120))).is_ok());
        assert!(normalize_label(Some(&"🦉".repeat(121))).is_err());
        for invalid in ["a\nb", "a\rb", "a\tb", "a\u{2028}b"] {
            assert!(normalize_label(Some(invalid)).is_err())
        }
        assert_eq!(normalize_label(Some("   ")).unwrap(), None);
    }
    #[test]
    fn stream_markers_are_persistent_points_and_not_clip_ranges() {
        let db = database();
        let p = request(Some("Shadcn New Library"));
        let (m, inserted) = db
            .insert_marker(&p, ClipMarkSource::Manual, 12.345)
            .unwrap();
        assert!(inserted);
        assert_eq!(
            db.marker_lookup("a", &m.id).unwrap(),
            MarkerLookup::Found { marker: m.clone() }
        );
        assert!(db.list_clip_marks("a").unwrap().is_empty());
        assert_eq!(m.at_seconds, 12.345);
        db.migrate_for_marker_test();
        assert_eq!(
            db.marker_lookup("a", &m.id).unwrap(),
            MarkerLookup::Found { marker: m }
        );
    }
    #[test]
    fn retries_survive_rename_and_delete_and_conflicting_ids_are_refused() {
        let db = database();
        let p = request(Some("original"));
        let (m, _) = db.insert_marker(&p, ClipMarkSource::Manual, 42.0).unwrap();
        let q = MarkerParams {
            session_id: "a".into(),
            marker_id: m.id,
        };
        db.change_marker(&q, Some(Some("renamed".into()))).unwrap();
        let (replay, new) = db.insert_marker(&p, ClipMarkSource::Manual, 99.0).unwrap();
        assert!(!new);
        assert_eq!(replay.at_seconds, 42.0);
        assert_eq!(replay.label.as_deref(), Some("renamed"));
        let mut conflict = p.clone();
        conflict.label = Some("different".into());
        assert_eq!(
            db.insert_marker(&conflict, ClipMarkSource::Manual, 99.0)
                .unwrap_err()
                .code(),
            "marker-operation-conflict"
        );
        let (deleted, changed) = db.change_marker(&q, None).unwrap();
        assert!(changed);
        assert_eq!(deleted.revision, 3);
        assert!(!db.change_marker(&q, None).unwrap().1);
        assert_eq!(
            db.insert_marker(&p, ClipMarkSource::Manual, 99.0)
                .unwrap_err()
                .code(),
            "marker-deleted"
        );
        assert_eq!(
            db.marker_lookup("a", &q.marker_id).unwrap(),
            MarkerLookup::Deleted { revision: 3 }
        );
        assert!(
            db.marker_page(&ListMarkersParams {
                session_id: "a".into(),
                cursor: None,
                limit: None
            })
            .unwrap()
            .markers
            .is_empty()
        );
    }
    #[test]
    fn pagination_is_stable_when_a_cursor_is_deleted_and_new_intents_do_not_time_dedupe() {
        let db = database();
        for _ in 0..4 {
            db.insert_marker(&request(Some("same")), ClipMarkSource::Voice, 4.0)
                .unwrap();
        }
        let mut q = ListMarkersParams {
            session_id: "a".into(),
            cursor: None,
            limit: Some(2),
        };
        let first = db.marker_page(&q).unwrap();
        assert_eq!(first.markers.len(), 2);
        db.change_marker(
            &MarkerParams {
                session_id: "a".into(),
                marker_id: first.next_cursor.clone().unwrap(),
            },
            None,
        )
        .unwrap();
        q.cursor = first.next_cursor;
        let second = db.marker_page(&q).unwrap();
        assert_eq!(second.markers.len(), 2);
        assert!(second.next_cursor.is_none());
        assert!(
            first
                .markers
                .iter()
                .all(|m| second.markers.iter().all(|n| m.id != n.id))
        );
    }
    #[test]
    fn deletion_cascades_and_storage_failure_never_returns_a_marker() {
        let db = database();
        let p = request(None);
        db.insert_marker(&p, ClipMarkSource::Manual, 1.0).unwrap();
        db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id='a'", [])
            .unwrap();
        assert_eq!(
            db.marker_lookup("a", &p.operation_id).unwrap(),
            MarkerLookup::Absent
        );
        assert!(
            db.insert_marker(&request(None), ClipMarkSource::Manual, 1.0)
                .is_err()
        );
    }
    #[test]
    fn marker_and_deletion_receipt_survive_database_reopen() {
        let directory =
            std::env::temp_dir().join(format!("videorc-marker-reopen-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("markers.sqlite3");
        let p = request(Some("Saved across restart"));
        let db = Database::open_file_for_tests(&path);
        db.lock().unwrap().execute("INSERT INTO sessions (id,title,started_at,status,mode,sources_json,layout_json,output_json) VALUES ('a','Stream','2026-10-05T12:00:00Z','completed','stream','{}','{}','{}')",[]).unwrap();
        let (marker, _) = db.insert_marker(&p, ClipMarkSource::Manual, 22.5).unwrap();
        drop(db);
        let reopened = Database::open_file_for_tests(&path);
        assert_eq!(
            reopened.marker_lookup("a", &marker.id).unwrap(),
            MarkerLookup::Found {
                marker: marker.clone()
            }
        );
        reopened
            .change_marker(
                &MarkerParams {
                    session_id: "a".into(),
                    marker_id: marker.id.clone(),
                },
                None,
            )
            .unwrap();
        drop(reopened);
        let reopened = Database::open_file_for_tests(&path);
        assert_eq!(
            reopened.marker_lookup("a", &marker.id).unwrap(),
            MarkerLookup::Deleted { revision: 2 }
        );
        assert_eq!(
            reopened
                .insert_marker(&p, ClipMarkSource::Manual, 90.0)
                .unwrap_err()
                .code(),
            "marker-deleted"
        );
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn renderer_cannot_supply_time_or_voice_provenance() {
        for field in ["atSeconds", "source", "path"] {
            let mut v = serde_json::to_value(request(None)).unwrap();
            v[field] = serde_json::json!("voice");
            assert!(serde_json::from_value::<CreateMarkerParams>(v).is_err());
        }
    }
}
