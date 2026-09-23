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
    /// X only: planned end as a local wall time in `time_zone`. X requires an
    /// end on every update, so a schedule is never created open-ended.
    #[serde(default)]
    pub planned_end_local: Option<String>,
    /// X only: keep the replay available after the broadcast ends.
    #[serde(default)]
    pub available_for_replay: Option<bool>,
}

/// Default planned length of an X broadcast when the form leaves it blank.
pub const DEFAULT_PLANNED_DURATION_HOURS: i64 = 2;

impl EventMetadata {
    pub fn validate_for(&self, provider: &str, future: bool) -> Result<String> {
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
        if let Some(end) = self.planned_end_utc()?
            && end <= utc
        {
            bail!("The planned end must be after the start.");
        }
        if provider == "x" && self.planned_end_local.is_none() {
            bail!("Choose a planned end for the X broadcast.");
        }
        Ok(utc.to_rfc3339_opts(SecondsFormat::Secs, true))
    }
    /// Planned end resolved in the same zone as the start; `None` when unset.
    pub fn planned_end_utc(&self) -> Result<Option<DateTime<Utc>>> {
        match self.planned_end_local.as_deref() {
            Some(end) if !end.trim().is_empty() => Ok(Some(
                resolve_time(end, &self.time_zone, self.offset_choice.as_deref())
                    .map_err(|error| anyhow::anyhow!("Planned end: {error}"))?,
            )),
            _ => Ok(None),
        }
    }
}

/// `%Y-%m-%dT%H:%M` wall time of a UTC instant in an IANA zone.
pub fn local_wall_time(utc: DateTime<Utc>, zone: &str) -> Result<String> {
    let zone: chrono_tz::Tz = zone
        .parse()
        .map_err(|_| anyhow::anyhow!("Choose a valid IANA time zone."))?;
    Ok(utc
        .with_timezone(&zone)
        .format("%Y-%m-%dT%H:%M")
        .to_string())
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
    /// X only: the dedicated ingest source this schedule is bound to. It is
    /// created at schedule time and lives as long as the schedule does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingest: Option<ScheduledIngest>,
    /// X only: provider media id of the last uploaded thumbnail, re-sent on
    /// every full-replacement update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_media_id: Option<String>,
    /// X only: the managed asset id that `thumbnail_media_id` was made from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_uploaded_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledIngest {
    pub source_id: String,
    pub region: String,
    pub server_url: String,
    pub stream_key_secret_ref: String,
}

/// Per-provider ingest credentials owned by one preparation attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PreparedIngest {
    Youtube(crate::youtube::PreparedYouTubeBroadcast),
    X(crate::x_live::PreparedXStreamSource),
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
    pub prepared: Option<PreparedIngest>,
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
    /// Provider of a brand-new draft (`youtube` when absent).
    #[serde(default)]
    pub provider: Option<String>,
}

pub fn valid_provider(provider: &str) -> Result<&'static str> {
    match provider {
        "youtube" => Ok("youtube"),
        "x" => Ok("x"),
        _ => bail!("Unsupported scheduling provider."),
    }
}

impl ScheduledStreamEvent {
    pub fn draft(
        id: String,
        provider: &str,
        account_id: String,
        account_label: String,
        requested: EventMetadata,
    ) -> Result<Self> {
        Uuid::parse_str(&id)?;
        let provider = valid_provider(provider)?;
        let start_utc = requested.validate_for(provider, false)?;
        let now = Utc::now().to_rfc3339();
        Ok(Self {
            id,
            schema_version: 1,
            revision: 0,
            provider: provider.into(),
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
            ingest: None,
            thumbnail_media_id: None,
            thumbnail_uploaded_asset_id: None,
        })
    }
    /// Planned end instant: the requested one, else the default duration.
    pub fn planned_end_utc(&self) -> Result<DateTime<Utc>> {
        if let Some(end) = self.requested.planned_end_utc()? {
            return Ok(end);
        }
        let start = DateTime::parse_from_rfc3339(&self.start_utc)?.with_timezone(&Utc);
        Ok(start + chrono::Duration::hours(DEFAULT_PLANNED_DURATION_HOURS))
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

/// Provider, HTTP status and bounded reason of a definite provider rejection.
pub fn provider_rejection(error: &anyhow::Error) -> Option<(&'static str, u16, &str)> {
    if let Some(rejection) = error.downcast_ref::<crate::scheduled_youtube::YouTubeRejection>() {
        return Some(("youtube", rejection.status, rejection.reason.as_str()));
    }
    if let Some(rejection) = error.downcast_ref::<crate::scheduled_x::XRejection>() {
        return Some(("x", rejection.status, rejection.reason.as_str()));
    }
    None
}

#[cfg(test)]
pub fn sanitized_error(error: &anyhow::Error) -> ScheduleError {
    sanitized_error_for("youtube", error)
}

/// Bounded, provider-worded error for the event journal. Raw provider bodies,
/// URLs and credentials never reach it.
pub fn sanitized_error_for(provider: &str, error: &anyhow::Error) -> ScheduleError {
    let raw = error.to_string();
    let rejection = provider_rejection(error);
    if provider == "x"
        || rejection.is_some_and(|(provider, _, _)| provider == "x")
        || raw.starts_with("X ")
    {
        return sanitized_x_error(error);
    }
    let reason = rejection.map(|(_, _, reason)| reason).unwrap_or("");
    let status = rejection.map(|(_, status, _)| status);
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

fn sanitized_x_error(error: &anyhow::Error) -> ScheduleError {
    let raw = error.to_string();
    let (status, reason) = provider_rejection(error)
        .map(|(_, status, reason)| (Some(status), reason.to_ascii_lowercase()))
        .unwrap_or((None, String::new()));
    let (code, message): (&str, String) = if status == Some(404) || raw.contains("Event missing") {
        (
            "missing",
            "This broadcast no longer exists on X. Refresh the list or schedule a new one.".into(),
        )
    } else if raw.contains("Thumbnail") || raw.contains("thumbnail") {
        (
            "thumbnail",
            "Choose a valid JPEG or PNG under 2 MB. X did not accept the thumbnail upload.".into(),
        )
    } else if status == Some(401) || raw.contains("Authorize X Live") {
        (
            "reconnect",
            "Re-run Authorize X Live for the account selected for this broadcast, then retry."
                .into(),
        )
    } else if status == Some(429) {
        (
            "rate-limit",
            "X rate limit reached. Wait before retrying.".into(),
        )
    } else if status == Some(403) {
        (
            "permission",
            "X denied this action. Check that the Livestream Scheduling API is enabled for your account.".into(),
        )
    } else if status == Some(400)
        && (reason.contains("time") || reason.contains("start") || reason.contains("end"))
    {
        (
            "invalid-time",
            "Choose a valid upcoming start and a later planned end, then retry.".into(),
        )
    } else if status == Some(400) && !reason.is_empty() {
        ("rejected", format!("X rejected this request: {reason}."))
    } else if raw.contains("external") {
        (
            "external-change",
            "This broadcast changed on X. Reload and review the changes before editing.".into(),
        )
    } else if error.downcast_ref::<reqwest::Error>().is_some() || raw.contains("X response unknown")
    {
        (
            "connection",
            "X could not be reached. Check your connection, then refresh or recover the broadcast before retrying.".into(),
        )
    } else {
        (
            "needs-attention",
            "The operation could not be confirmed. Refresh or recover the broadcast before retrying.".into(),
        )
    };
    ScheduleError {
        code: code.into(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn x_errors_map_to_the_same_bounded_codes() {
        for (status, reason, expected) in [
            (404, "not found", "missing"),
            (401, "unauthorized", "reconnect"),
            (429, "too many", "rate-limit"),
            (403, "forbidden", "permission"),
            (400, "invalid scheduled start time", "invalid-time"),
            (400, "manual publish required", "rejected"),
        ] {
            let error: anyhow::Error = crate::scheduled_x::XRejection {
                status,
                reason: reason.into(),
            }
            .into();
            assert_eq!(sanitized_error(&error).code, expected, "{status} {reason}");
        }
        let thumbnail: anyhow::Error = anyhow::Error::from(crate::scheduled_x::XRejection {
            status: 400,
            reason: "media".into(),
        })
        .context("Thumbnail upload failed");
        assert_eq!(sanitized_error(&thumbnail).code, "thumbnail");
    }
    #[test]
    fn x_metadata_requires_a_planned_end_after_start() {
        let mut meta = EventMetadata {
            title: "X".into(),
            description: "".into(),
            privacy: "private".into(),
            made_for_kids: false,
            local_start: "2035-01-01T12:00".into(),
            time_zone: "Europe/Madrid".into(),
            offset_choice: None,
            thumbnail_asset_id: None,
            planned_end_local: None,
            available_for_replay: None,
        };
        assert!(meta.validate_for("x", false).is_err());
        assert!(meta.validate_for("youtube", false).is_ok());
        meta.planned_end_local = Some("2035-01-01T11:00".into());
        assert!(meta.validate_for("x", false).is_err());
        meta.planned_end_local = Some("2035-01-01T14:00".into());
        assert!(meta.validate_for("x", false).is_ok());
        let event = ScheduledStreamEvent::draft(
            Uuid::new_v4().to_string(),
            "x",
            "123".into(),
            "@videorc".into(),
            meta.clone(),
        )
        .unwrap();
        assert_eq!(event.provider, "x");
        assert_eq!(
            event.planned_end_utc().unwrap().to_rfc3339(),
            "2035-01-01T13:00:00+00:00"
        );
        assert!(valid_provider("twitch").is_err());
        assert_eq!(
            local_wall_time(event.planned_end_utc().unwrap(), "Europe/Madrid").unwrap(),
            "2035-01-01T14:00"
        );
    }
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
            planned_end_local: None,
            available_for_replay: None,
        };
        assert!(meta.validate_for("youtube", false).is_ok());
        meta.title.push('a');
        assert!(meta.validate_for("youtube", false).is_err());
        meta.title = "<unsafe>".into();
        assert!(meta.validate_for("youtube", false).is_err());
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
            "youtube",
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
                planned_end_local: None,
                available_for_replay: None,
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
            provider: None,
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
pub fn confirmation_fingerprint(provider: &str, remote: &Value) -> String {
    use sha2::{Digest, Sha256};
    let snapshot = if provider == "x" {
        crate::scheduled_x::metadata_snapshot(remote)
    } else {
        crate::scheduled_youtube::metadata_snapshot(remote)
    };
    format!("{:x}", Sha256::digest(snapshot.to_string().as_bytes()))
}
