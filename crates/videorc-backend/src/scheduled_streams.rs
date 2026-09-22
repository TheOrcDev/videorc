//! Backend-owned upcoming broadcasts. A scheduled time is metadata, never a timer.
use anyhow::{Result, bail};
use chrono::{DateTime, LocalResult, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventMetadata {
    pub title: String,
    pub description: String,
    pub privacy: String,
    pub made_for_kids: bool,
    pub local_start: String,
    pub time_zone: String,
    pub offset_choice: Option<String>,
    pub thumbnail_asset_id: Option<String>,
}

impl EventMetadata {
    pub fn validate(&self, future: bool) -> Result<String> {
        if self.title.trim().is_empty()
            || self.title.chars().count() > 100
            || self.title.contains(['<', '>'])
        {
            bail!("Title must contain 1–100 characters and no angle brackets.");
        }
        if self.description.chars().count() > 5_000 || self.description.contains(['<', '>']) {
            bail!("Description must contain at most 5,000 characters and no angle brackets.");
        }
        if !matches!(self.privacy.as_str(), "private" | "unlisted" | "public") {
            bail!("Invalid privacy.");
        }
        if let Some(id) = &self.thumbnail_asset_id {
            crate::resource_authority::validate_asset_id(id)?;
        }
        let utc = resolve_time(
            &self.local_start,
            &self.time_zone,
            self.offset_choice.as_deref(),
        )?;
        if future && utc <= Utc::now() {
            bail!("Choose a start time in the future.");
        }
        Ok(utc.to_rfc3339_opts(SecondsFormat::Secs, true))
    }
}

pub fn resolve_time(local: &str, zone: &str, choice: Option<&str>) -> Result<DateTime<Utc>> {
    let zone: chrono_tz::Tz = zone
        .parse()
        .map_err(|_| anyhow::anyhow!("Choose a valid IANA time zone."))?;
    let local = NaiveDateTime::parse_from_str(local, "%Y-%m-%dT%H:%M")
        .map_err(|_| anyhow::anyhow!("Enter a valid local date and time."))?;
    let time = match zone.from_local_datetime(&local) {
        LocalResult::Single(value) => value,
        LocalResult::None => bail!(
            "This local time does not exist because the clocks move forward. Choose another time."
        ),
        LocalResult::Ambiguous(early, late) => match choice {
            Some("earlier") => early,
            Some("later") => late,
            _ => bail!("This local time occurs twice. Choose the earlier or later offset."),
        },
    };
    Ok(time.with_timezone(&Utc))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledStreamEvent {
    pub id: String,
    pub schema_version: u32,
    pub revision: u64,
    pub provider: String,
    pub account_id: String,
    pub account_label: String,
    pub requested: EventMetadata,
    pub start_utc: String,
    pub confirmed: Option<Value>,
    pub provider_event_id: Option<String>,
    pub watch_url: Option<String>,
    pub lifecycle: String,
    pub operation_state: String,
    pub thumbnail_state: String,
    pub error: Option<ScheduleError>,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub ownership: String,
    pub preparation: Option<Preparation>,
    pub retained_ingest: Option<Preparation>,
    #[serde(default)]
    pub create_uncertain: bool,
    #[serde(default)]
    pub cancel_uncertain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preparation {
    pub attempt_id: String,
    pub target_id: String,
    pub stream_id: Option<String>,
    pub profile: Value,
    pub phase: String,
    pub session_id: Option<String>,
    // Secret references and endpoint stay in backend persistence, not event DTOs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared: Option<crate::youtube::PreparedYouTubeBroadcast>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleOperation {
    pub id: String,
    pub event_id: String,
    pub action: String,
    pub fingerprint: String,
    pub state: String,
    pub stage: String,
    pub result: Option<Value>,
    pub error: Option<ScheduleError>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub operation_id: String,
    pub event_id: String,
    pub expected_revision: u64,
    pub metadata: Option<EventMetadata>,
    pub account_id: Option<String>,
    pub candidate_id: Option<String>,
    pub candidate_kind: Option<String>,
    pub attempt_id: Option<String>,
    pub target_id: Option<String>,
    pub video: Option<crate::protocol::VideoSettings>,
    pub session_id: Option<String>,
    pub confirmation_fingerprint: Option<String>,
}

impl ScheduledStreamEvent {
    pub fn draft(
        id: String,
        account_id: String,
        account_label: String,
        requested: EventMetadata,
    ) -> Result<Self> {
        Uuid::parse_str(&id)?;
        let start_utc = requested.validate(false)?;
        let now = Utc::now().to_rfc3339();
        Ok(Self {
            id,
            schema_version: 1,
            revision: 0,
            provider: "youtube".into(),
            account_id,
            account_label,
            requested,
            start_utc,
            confirmed: None,
            provider_event_id: None,
            watch_url: None,
            lifecycle: "draft".into(),
            operation_state: "idle".into(),
            thumbnail_state: "none".into(),
            error: None,
            last_synced_at: None,
            created_at: now.clone(),
            updated_at: now,
            ownership: "videorc-created".into(),
            preparation: None,
            retained_ingest: None,
            create_uncertain: false,
            cancel_uncertain: false,
        })
    }
    pub fn public(mut self) -> Self {
        self.retained_ingest = None;
        if let Some(preparation) = &mut self.preparation {
            preparation.prepared = None;
        }
        self
    }
    pub fn editable(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!("This event uses a newer schema. Update Videorc.");
        }
        if self.preparation.is_some()
            || matches!(
                self.lifecycle.as_str(),
                "live" | "completed" | "canceled" | "missing"
            )
        {
            bail!("This event cannot be edited or canceled while preparing, live or ended.");
        }
        Ok(())
    }
}

pub fn sanitized_error(error: &anyhow::Error) -> ScheduleError {
    let raw = error.to_string();
    let rejection = error.downcast_ref::<crate::scheduled_youtube::YouTubeRejection>();
    let reason = rejection.map(|r| r.reason.as_str()).unwrap_or("");
    let status = rejection.map(|r| r.status);
    let (code, message) = if reason == "liveStreamingNotEnabled" {
        (
            "enable-live",
            "Enable live streaming for this channel in YouTube Studio, then retry.",
        )
    } else if matches!(
        reason,
        "invalidScheduledStartTime" | "scheduledStartTimeRequired" | "invalidScheduledEndTime"
    ) {
        (
            "invalid-time",
            "Choose a valid upcoming date and time, then retry.",
        )
    } else if matches!(reason, "videoNotFound" | "liveBroadcastNotFound")
        || raw.contains("Event missing")
    {
        (
            "missing",
            "This event no longer exists on YouTube. Refresh the list or create a new event.",
        )
    } else if matches!(
        reason,
        "invalidImage" | "mediaBodyRequired" | "uploadTooLarge"
    ) || raw.contains("Thumbnail")
        || raw.contains("thumbnail")
    {
        (
            "thumbnail",
            "Choose a valid JPEG or PNG under 2 MB and check custom-thumbnail eligibility in YouTube Studio.",
        )
    } else if status == Some(401)
        || raw.contains("Reconnect")
        || raw.contains("different destination/channel")
    {
        (
            "reconnect",
            "Reconnect the exact YouTube channel selected for this event and retry.",
        )
    } else if status == Some(429)
        || matches!(
            reason,
            "quotaExceeded" | "rateLimitExceeded" | "userRateLimitExceeded"
        )
    {
        (
            "rate-limit",
            "YouTube quota or rate limit reached. Wait before retrying.",
        )
    } else if status == Some(403) {
        (
            "permission",
            "YouTube denied this action. Check channel permissions and eligibility in YouTube Studio.",
        )
    } else if raw.contains("external") {
        (
            "external-change",
            "This event changed on YouTube. Reload and review the changes before editing.",
        )
    } else if raw.contains("approval") || raw.contains("paused") {
        (
            "unavailable",
            "YouTube connection is unavailable pending Google approval.",
        )
    } else if error.downcast_ref::<reqwest::Error>().is_some() {
        (
            "connection",
            "YouTube could not be reached. Check your connection, then refresh or recover the event before retrying.",
        )
    } else {
        (
            "needs-attention",
            "The operation could not be confirmed. Refresh or recover the event before retrying.",
        )
    };
    ScheduleError {
        code: code.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actionable_errors_use_bounded_provider_reasons() {
        for (status, reason, expected) in [
            (403, "liveStreamingNotEnabled", "enable-live"),
            (400, "invalidScheduledStartTime", "invalid-time"),
            (404, "liveBroadcastNotFound", "missing"),
            (400, "invalidImage", "thumbnail"),
            (401, "authError", "reconnect"),
            (429, "rateLimitExceeded", "rate-limit"),
        ] {
            let error: anyhow::Error = crate::scheduled_youtube::YouTubeRejection {
                status,
                reason: reason.into(),
            }
            .into();
            assert_eq!(sanitized_error(&error).code, expected);
        }
        assert!(
            !sanitized_error(&anyhow::anyhow!("secret-token fixture-key"))
                .message
                .contains("fixture-key")
        );
    }
    #[test]
    fn dst_gap_fold_and_non_hour_zone() {
        assert!(resolve_time("2027-03-28T02:30", "Europe/Madrid", None).is_err());
        assert!(resolve_time("2027-10-31T02:30", "Europe/Madrid", None).is_err());
        let early = resolve_time("2027-10-31T02:30", "Europe/Madrid", Some("earlier")).unwrap();
        let late = resolve_time("2027-10-31T02:30", "Europe/Madrid", Some("later")).unwrap();
        assert_eq!((late - early).num_hours(), 1);
        assert_eq!(
            resolve_time("2027-01-01T12:00", "Asia/Kolkata", None)
                .unwrap()
                .to_rfc3339(),
            "2027-01-01T06:30:00+00:00"
        );
        assert!(resolve_time("2027-02-30T12:00", "UTC", None).is_err());
    }
    #[test]
    fn unicode_limits_are_characters() {
        let mut meta = EventMetadata {
            title: "🎥".repeat(100),
            description: "".into(),
            privacy: "private".into(),
            made_for_kids: false,
            local_start: "2027-01-01T12:00".into(),
            time_zone: "UTC".into(),
            offset_choice: None,
            thumbnail_asset_id: None,
        };
        assert!(meta.validate(false).is_ok());
        meta.title.push('a');
        assert!(meta.validate(false).is_err());
        meta.title = "<unsafe>".into();
        assert!(meta.validate(false).is_err());
    }
}

pub fn mutation_fingerprint(mutation: &Mutation) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(mutation)?)
    ))
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::storage::Database;
    fn draft() -> (ScheduledStreamEvent, Mutation) {
        let id = Uuid::new_v4().to_string();
        let event = ScheduledStreamEvent::draft(
            id.clone(),
            "channel".into(),
            "Channel".into(),
            EventMetadata {
                title: "Upcoming".into(),
                description: "Description".into(),
                privacy: "private".into(),
                made_for_kids: false,
                local_start: "2035-01-01T12:00".into(),
                time_zone: "Europe/Madrid".into(),
                offset_choice: None,
                thumbnail_asset_id: None,
            },
        )
        .unwrap();
        let mutation = Mutation {
            operation_id: Uuid::new_v4().to_string(),
            event_id: id,
            expected_revision: 0,
            metadata: None,
            account_id: None,
            candidate_id: None,
            candidate_kind: None,
            attempt_id: None,
            target_id: None,
            video: None,
            session_id: None,
            confirmation_fingerprint: None,
        };
        (event, mutation)
    }
    #[test]
    fn dedupe_revision_and_payload_identity() {
        let db = Database::open_in_memory_for_tests();
        let (event, mutation) = draft();
        let (event, op, started) = db
            .begin_scheduled_operation(event, &mutation, "saveDraft")
            .unwrap();
        assert!(started);
        assert!(
            !db.begin_scheduled_operation(event.clone(), &mutation, "saveDraft")
                .unwrap()
                .2
        );
        let mut different = mutation.clone();
        different.candidate_id = Some("other".into());
        assert!(
            db.begin_scheduled_operation(event.clone(), &different, "saveDraft")
                .is_err()
        );
        let mut concurrent = mutation.clone();
        concurrent.operation_id = Uuid::new_v4().to_string();
        concurrent.expected_revision = 1;
        assert!(
            db.begin_scheduled_operation(event.clone(), &concurrent, "saveDraft")
                .is_err()
        );
        db.checkpoint_scheduled_operation(&event, &op, true)
            .unwrap();
        concurrent.expected_revision = 0;
        assert!(
            db.begin_scheduled_operation(event.clone(), &concurrent, "saveDraft")
                .is_err()
        );
        concurrent.expected_revision = 1;
        assert!(
            db.begin_scheduled_operation(event, &concurrent, "saveDraft")
                .is_ok()
        );
    }
    #[test]
    fn real_database_restart_preserves_remote_id_and_unknown_create() {
        let path = std::env::temp_dir().join(format!("scheduled-{}.sqlite", Uuid::new_v4()));
        let db = Database::open_file_for_tests(&path);
        let (event, mutation) = draft();
        let (mut event, mut op, _) = db
            .begin_scheduled_operation(event, &mutation, "saveDraft")
            .unwrap();
        event.provider_event_id = Some("advertised-id".into());
        event.create_uncertain = true;
        op.stage = "creating-event".into();
        db.checkpoint_scheduled_operation(&event, &op, false)
            .unwrap();
        drop(db);
        let db = Database::open_file_for_tests(&path);
        db.recover_scheduled_operations_after_restart().unwrap();
        let restored = db.scheduled_event(&event.id).unwrap();
        assert_eq!(restored.provider_event_id.as_deref(), Some("advertised-id"));
        assert!(restored.create_uncertain);
        assert_eq!(restored.operation_state, "needs-reconciliation");
        let operation = db.scheduled_operation(&op.id).unwrap().unwrap();
        assert_eq!(operation.state, "needs-reconciliation");
        assert!(
            !db.begin_scheduled_operation(restored, &mutation, "saveDraft")
                .unwrap()
                .2
        );
        drop(db);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn channel_changes_and_unknown_schema_are_rejected() {
        let db = Database::open_in_memory_for_tests();
        let (event, mut mutation) = draft();
        let (mut event, op, _) = db
            .begin_scheduled_operation(event, &mutation, "saveDraft")
            .unwrap();
        db.checkpoint_scheduled_operation(&event, &op, true)
            .unwrap();
        mutation.operation_id = Uuid::new_v4().to_string();
        mutation.expected_revision = 1;
        event.account_id = "different".into();
        assert!(
            db.begin_scheduled_operation(event.clone(), &mutation, "update")
                .is_err()
        );
        event.account_id = "channel".into();
        event.schema_version = 2;
        assert!(event.editable().is_err());
    }
    #[test]
    fn public_snapshot_removes_ingest_material() {
        let (mut event, _) = draft();
        event.retained_ingest = Some(Preparation {
            attempt_id: "attempt".into(),
            target_id: "target".into(),
            stream_id: Some("stream".into()),
            profile: serde_json::json!({}),
            phase: "released".into(),
            session_id: None,
            prepared: None,
        });
        assert!(event.public().retained_ingest.is_none());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledConfirmation {
    pub event_id: String,
    pub fingerprint: String,
    pub title: String,
    pub privacy: String,
    pub start_utc: String,
}
pub fn confirmation_fingerprint(remote: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(
            crate::scheduled_youtube::metadata_snapshot(remote)
                .to_string()
                .as_bytes()
        )
    )
}
