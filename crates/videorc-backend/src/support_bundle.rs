use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{
    AiArtifactKind, AiArtifactStatus, BackendHealth, BackendLogEvent, DiagnosticStats,
    EntitlementsSnapshot, HealthEvent, RecordingStatus, SessionLogEntry, SessionSummary,
};
use crate::repair::GateStatus;

const SCHEMA_VERSION: u32 = 1;
const SECRET_REDACTION: &str = "<redacted:secret>";
const DATABASE_PATH_REDACTION: &str = "<redacted:database-path>";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleExportParams {
    pub output_directory: Option<String>,
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleExportResult {
    pub path: String,
    pub included_sections: Vec<String>,
    pub redaction_summary: SupportBundleRedactionSummary,
}

#[derive(Debug, Clone)]
pub struct SupportBundleExportInput {
    pub output_directory: Option<PathBuf>,
    pub database_path: PathBuf,
    pub health: BackendHealth,
    pub entitlements: EntitlementsSnapshot,
    pub recording: RecordingStatus,
    pub diagnostics: DiagnosticStats,
    pub logs: Vec<BackendLogEvent>,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundle {
    pub schema_version: u32,
    pub generated_at: String,
    pub app: SupportBundleApp,
    pub health: Value,
    pub entitlements: Value,
    pub recording: Value,
    pub diagnostics: Value,
    pub logs: Value,
    pub sessions: Vec<SupportBundleSessionSummary>,
    pub redaction_summary: SupportBundleRedactionSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleApp {
    pub version: String,
    pub commit: Option<String>,
    pub platform: String,
    pub run_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleSessionSummary {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub mode: String,
    pub output_file: Option<String>,
    pub mp4_file: Option<String>,
    pub stream_preset: Option<String>,
    pub container: Option<String>,
    pub duration_ms: Option<i64>,
    pub quality_status: Option<GateStatus>,
    pub final_diagnostics: Option<DiagnosticStats>,
    pub health_events: Vec<HealthEvent>,
    pub session_logs: Vec<SessionLogEntry>,
    pub ai_artifacts: Vec<SupportBundleAiArtifact>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleAiArtifact {
    pub id: String,
    pub session_id: String,
    pub kind: AiArtifactKind,
    pub status: AiArtifactStatus,
    pub file: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleRedactionSummary {
    pub secret_values: u32,
    pub database_paths: u32,
    pub media_paths: u32,
    pub home_paths: u32,
    pub url_credentials: u32,
    pub ai_artifact_bodies: u32,
}

impl SupportBundleRedactionSummary {
    fn merge(&mut self, other: SupportBundleRedactionSummary) {
        self.secret_values += other.secret_values;
        self.database_paths += other.database_paths;
        self.media_paths += other.media_paths;
        self.home_paths += other.home_paths;
        self.url_credentials += other.url_credentials;
        self.ai_artifact_bodies += other.ai_artifact_bodies;
    }
}

pub fn export_support_bundle(input: SupportBundleExportInput) -> Result<SupportBundleExportResult> {
    let directory = input
        .output_directory
        .clone()
        .unwrap_or_else(|| default_support_bundle_directory(&input.database_path));
    std::fs::create_dir_all(&directory).with_context(|| {
        format!(
            "Could not create support bundle directory {}",
            directory.display()
        )
    })?;

    let bundle = build_support_bundle(input)?;
    let filename = format!(
        "videorc-support-bundle-{}.json",
        Utc::now().format("%Y%m%d-%H%M%SZ")
    );
    let path = directory.join(filename);
    let json = serde_json::to_vec_pretty(&bundle)?;
    std::fs::write(&path, json)
        .with_context(|| format!("Could not write support bundle {}", path.display()))?;

    Ok(SupportBundleExportResult {
        path: path.display().to_string(),
        included_sections: included_sections(),
        redaction_summary: bundle.redaction_summary,
    })
}

pub fn build_support_bundle(input: SupportBundleExportInput) -> Result<SupportBundle> {
    let mut redaction_summary = SupportBundleRedactionSummary::default();
    let mut health = serde_json::to_value(input.health)?;
    let mut entitlements = serde_json::to_value(input.entitlements)?;
    let mut recording = serde_json::to_value(input.recording)?;
    let mut diagnostics = serde_json::to_value(input.diagnostics)?;
    let mut logs = serde_json::to_value(input.logs)?;

    redact_value(&mut health, &mut redaction_summary);
    redact_value(&mut entitlements, &mut redaction_summary);
    redact_value(&mut recording, &mut redaction_summary);
    redact_value(&mut diagnostics, &mut redaction_summary);
    redact_value(&mut logs, &mut redaction_summary);

    let (sessions, session_redactions) = redact_sessions(input.sessions);
    redaction_summary.merge(session_redactions);

    Ok(SupportBundle {
        schema_version: SCHEMA_VERSION,
        generated_at: Utc::now().to_rfc3339(),
        app: SupportBundleApp {
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: support_bundle_commit(),
            platform: std::env::consts::OS.to_string(),
            run_mode: backend_run_mode(),
        },
        health,
        entitlements,
        recording,
        diagnostics,
        logs,
        sessions,
        redaction_summary,
    })
}

pub fn redact_value(value: &mut Value, summary: &mut SupportBundleRedactionSummary) {
    redact_value_with_key(None, value, summary);
}

fn redact_value_with_key(
    key: Option<&str>,
    value: &mut Value,
    summary: &mut SupportBundleRedactionSummary,
) {
    match value {
        Value::Object(map) => {
            for (child_key, child_value) in map.iter_mut() {
                redact_value_with_key(Some(child_key), child_value, summary);
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_value_with_key(key, item, summary);
            }
        }
        Value::String(text) => {
            let redacted = redact_string(key, text, summary);
            if let Some(redacted) = redacted {
                *text = redacted;
            }
        }
        _ => {}
    }
}

fn redact_string(
    key: Option<&str>,
    text: &str,
    summary: &mut SupportBundleRedactionSummary,
) -> Option<String> {
    let key = key.unwrap_or_default();
    let normalized_key = normalize_key(key);
    if is_secret_key(&normalized_key) {
        summary.secret_values += 1;
        return Some(SECRET_REDACTION.to_string());
    }
    if normalized_key == "databasepath" {
        summary.database_paths += 1;
        return Some(DATABASE_PATH_REDACTION.to_string());
    }
    if is_media_path_key(&normalized_key) {
        summary.media_paths += 1;
        return Some(redact_to_basename(text));
    }
    if normalized_key.contains("url")
        && let Some(redacted) = redact_url(text)
    {
        summary.url_credentials += 1;
        return Some(redacted);
    }
    if let Some(redacted) = redact_inline_sensitive_text(text, summary) {
        return Some(redacted);
    }
    let redacted = redact_home_path(text)?;
    summary.home_paths += 1;
    Some(redacted)
}

fn redact_sessions(
    sessions: Vec<SessionSummary>,
) -> (
    Vec<SupportBundleSessionSummary>,
    SupportBundleRedactionSummary,
) {
    let mut summary = SupportBundleRedactionSummary::default();
    let sessions = sessions
        .into_iter()
        .map(|session| {
            let output_file = session.output_path.as_deref().map(|path| {
                summary.media_paths += 1;
                redact_to_basename(path)
            });
            let mp4_file = session.mp4_path.as_deref().map(|path| {
                summary.media_paths += 1;
                redact_to_basename(path)
            });
            let ai_artifacts = session
                .ai_artifacts
                .into_iter()
                .map(|artifact| {
                    summary.ai_artifact_bodies += 1;
                    let file = artifact.file_path.as_deref().map(|path| {
                        summary.media_paths += 1;
                        redact_to_basename(path)
                    });
                    SupportBundleAiArtifact {
                        id: artifact.id,
                        session_id: artifact.session_id,
                        kind: artifact.kind,
                        status: artifact.status,
                        file,
                        created_at: artifact.created_at,
                    }
                })
                .collect();
            SupportBundleSessionSummary {
                id: session.id,
                title: session.title,
                started_at: session.started_at,
                ended_at: session.ended_at,
                status: session.status,
                mode: session.mode,
                output_file,
                mp4_file,
                stream_preset: session.stream_preset,
                container: session.container,
                duration_ms: session.duration_ms,
                quality_status: session.quality_status,
                final_diagnostics: session.final_diagnostics,
                health_events: session
                    .health_events
                    .into_iter()
                    .map(|event| redact_health_event(event, &mut summary))
                    .collect(),
                session_logs: session
                    .session_logs
                    .into_iter()
                    .map(|entry| redact_session_log(entry, &mut summary))
                    .collect(),
                ai_artifacts,
            }
        })
        .collect();
    (sessions, summary)
}

fn redact_health_event(
    mut event: HealthEvent,
    summary: &mut SupportBundleRedactionSummary,
) -> HealthEvent {
    event.message = redact_message(event.message, summary);
    event
}

fn redact_session_log(
    mut entry: SessionLogEntry,
    summary: &mut SupportBundleRedactionSummary,
) -> SessionLogEntry {
    entry.message = redact_message(entry.message, summary);
    entry
}

fn redact_message(message: String, summary: &mut SupportBundleRedactionSummary) -> String {
    redact_string(Some("message"), &message, summary).unwrap_or(message)
}

fn included_sections() -> Vec<String> {
    [
        "app",
        "health",
        "entitlements",
        "recording",
        "diagnostics",
        "logs",
        "sessions",
    ]
    .iter()
    .map(|section| (*section).to_string())
    .collect()
}

fn default_support_bundle_directory(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .map(|parent| parent.join("support-bundles"))
        .unwrap_or_else(|| std::env::temp_dir().join("videorc-support-bundles"))
}

fn support_bundle_commit() -> Option<String> {
    option_env!("VIDEORC_GIT_SHA")
        .or(option_env!("GIT_SHA"))
        .or(option_env!("VERGEN_GIT_SHA"))
        .map(str::to_string)
}

fn backend_run_mode() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.to_str().map(str::to_string))
        .map(|path| {
            if path.contains("/target/") || path.contains("\\target\\") {
                "dev"
            } else {
                "packaged"
            }
        })
        .unwrap_or("unknown")
        .to_string()
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|ch| *ch != '_' && *ch != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    if key == "secretstorebackend" {
        return false;
    }
    key.contains("token")
        || key.contains("secret")
        || key.contains("streamkey")
        || key.contains("apikey")
        || key.contains("authorization")
        || key.contains("password")
}

fn is_media_path_key(key: &str) -> bool {
    key == "outputpath"
        || key == "mp4path"
        || key == "filepath"
        || key == "audiopath"
        || key == "markdownpath"
        || key == "recordingpath"
}

fn redact_to_basename(path: &str) -> String {
    let basename = basename(path).unwrap_or("file");
    format!("<redacted:path:{basename}>")
}

fn basename(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
}

fn redact_url(text: &str) -> Option<String> {
    let scheme_end = text.find("://")?;
    let after_scheme = scheme_end + 3;
    let tail = &text[after_scheme..];
    let authority_end = tail.find('/').unwrap_or(tail.len());
    let authority = &tail[..authority_end];
    if authority.contains('@') {
        let host = authority.rsplit('@').next().unwrap_or(authority);
        return Some(format!(
            "{}://<redacted:credentials>@{}{}",
            &text[..scheme_end],
            host,
            &tail[authority_end..]
        ));
    }
    if text.starts_with("rtmp://") && !text.contains('•') {
        return Some(format!("{}://<redacted:rtmp-url>", &text[..scheme_end]));
    }
    None
}

fn redact_inline_sensitive_text(
    text: &str,
    summary: &mut SupportBundleRedactionSummary,
) -> Option<String> {
    let mut redacted = text.to_string();
    let mut changed = false;
    for token in text.split_whitespace() {
        let trimmed =
            token.trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == ',' || ch == ';');
        if let Some(redacted_url) = redact_url(trimmed) {
            redacted = redacted.replace(trimmed, &redacted_url);
            summary.url_credentials += 1;
            changed = true;
            continue;
        }
        if looks_like_inline_secret(trimmed) {
            redacted = redacted.replace(trimmed, SECRET_REDACTION);
            summary.secret_values += 1;
            changed = true;
        }
    }
    changed.then_some(redacted)
}

fn looks_like_inline_secret(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    token.starts_with("sk-")
        || token.starts_with("ghp_")
        || token.starts_with("xoxb-")
        || lower.starts_with("access_token=")
        || lower.starts_with("refresh_token=")
        || lower.starts_with("api_key=")
        || lower.starts_with("stream_key=")
        || lower.starts_with("streamkey=")
}

fn redact_home_path(text: &str) -> Option<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    if home.is_empty() || !text.contains(&home) {
        return None;
    }
    Some(text.replace(&home, "~"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::diagnostics::idle_diagnostics;
    use crate::entitlements::current_entitlements;
    use crate::protocol::{
        AiArtifact, AiArtifactStatus, BackendHealth, RecordingState, ToolStatus,
    };
    use crate::recording::idle_status;

    #[test]
    fn support_bundle_redacts_secret_shaped_fields_and_urls() {
        let mut value = json!({
            "streamKey": "abc123",
            "oauthToken": "tok_live",
            "openaiApiKey": "sk-test",
            "callbackUrl": "https://user:password@example.test/callback",
            "streamUrl": "rtmp://127.0.0.1/live/plain-key"
        });
        let mut summary = SupportBundleRedactionSummary::default();

        redact_value(&mut value, &mut summary);

        assert_eq!(value["streamKey"], SECRET_REDACTION);
        assert_eq!(value["oauthToken"], SECRET_REDACTION);
        assert_eq!(value["openaiApiKey"], SECRET_REDACTION);
        assert_eq!(
            value["callbackUrl"],
            "https://<redacted:credentials>@example.test/callback"
        );
        assert_eq!(value["streamUrl"], "rtmp://<redacted:rtmp-url>");
        assert_eq!(summary.secret_values, 3);
        assert_eq!(summary.url_credentials, 2);
    }

    #[test]
    fn support_bundle_redacts_database_and_media_paths() {
        let mut value = json!({
            "databasePath": "/Users/orcdev/Library/Application Support/Videorc/videorc.sqlite3",
            "outputPath": "/Users/orcdev/Movies/Videorc/Recordings/session.mp4",
            "ffmpeg": { "path": "/opt/homebrew/bin/ffmpeg" }
        });
        let mut summary = SupportBundleRedactionSummary::default();

        redact_value(&mut value, &mut summary);

        assert_eq!(value["databasePath"], DATABASE_PATH_REDACTION);
        assert_eq!(value["outputPath"], "<redacted:path:session.mp4>");
        assert_eq!(value["ffmpeg"]["path"], "/opt/homebrew/bin/ffmpeg");
        assert_eq!(summary.database_paths, 1);
        assert_eq!(summary.media_paths, 1);
    }

    #[test]
    fn support_bundle_sessions_drop_ai_content_and_keep_media_basenames_only() {
        let session = SessionSummary {
            id: "session-1".to_string(),
            title: "Test".to_string(),
            started_at: "2026-06-13T00:00:00Z".to_string(),
            ended_at: None,
            status: "complete".to_string(),
            mode: "recording".to_string(),
            output_path: Some("/Users/orcdev/Movies/Videorc/Recordings/raw.mkv".to_string()),
            mp4_path: Some("/Users/orcdev/Movies/Videorc/Recordings/final.mp4".to_string()),
            stream_preset: None,
            container: Some("mp4".to_string()),
            duration_ms: Some(1000),
            quality_status: None,
            final_diagnostics: None,
            layout: crate::protocol::default_layout_settings(),
            sources: crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            health_events: vec![],
            session_logs: vec![],
            ai_artifacts: vec![AiArtifact {
                id: "artifact-1".to_string(),
                session_id: "session-1".to_string(),
                kind: crate::protocol::AiArtifactKind::Transcript,
                status: AiArtifactStatus::Ready,
                content: json!({ "text": "private transcript body" }),
                file_path: Some(
                    "/Users/orcdev/Library/Application Support/Videorc/transcript.json".to_string(),
                ),
                created_at: "2026-06-13T00:00:01Z".to_string(),
            }],
            comment_count: 0,
        };

        let (sessions, summary) = redact_sessions(vec![session]);

        assert_eq!(
            sessions[0].output_file.as_deref(),
            Some("<redacted:path:raw.mkv>")
        );
        assert_eq!(
            sessions[0].mp4_file.as_deref(),
            Some("<redacted:path:final.mp4>")
        );
        assert_eq!(
            sessions[0].ai_artifacts[0].file.as_deref(),
            Some("<redacted:path:transcript.json>")
        );
        let json = serde_json::to_string(&sessions).unwrap();
        assert!(!json.contains("private transcript body"));
        assert_eq!(summary.ai_artifact_bodies, 1);
        assert_eq!(summary.media_paths, 3);
    }

    #[test]
    fn support_bundle_export_writes_redacted_json() {
        let directory = std::env::temp_dir().join(format!(
            "videorc-support-bundle-test-{}",
            uuid::Uuid::new_v4()
        ));
        let input = SupportBundleExportInput {
            output_directory: Some(directory.clone()),
            database_path: directory.join("videorc.sqlite3"),
            health: BackendHealth {
                status: "ok".to_string(),
                version: "test".to_string(),
                platform: "macos".to_string(),
                ffmpeg: ToolStatus {
                    path: "/opt/homebrew/bin/ffmpeg".to_string(),
                    available: true,
                    version: Some("ffmpeg test".to_string()),
                    message: None,
                },
                database_path: "/Users/orcdev/Library/Application Support/Videorc/videorc.sqlite3"
                    .to_string(),
                secret_store_backend: "json-file".to_string(),
            },
            entitlements: current_entitlements(),
            recording: RecordingStatus {
                state: RecordingState::Idle,
                stream_url: Some("rtmp://127.0.0.1/live/plain-key".to_string()),
                ..idle_status()
            },
            diagnostics: idle_diagnostics(),
            logs: vec![BackendLogEvent {
                level: "warn".to_string(),
                message: "token sk-test appeared".to_string(),
                timestamp: "2026-06-13T00:00:00Z".to_string(),
            }],
            sessions: vec![],
        };

        let result = export_support_bundle(input).unwrap();
        let text = std::fs::read_to_string(&result.path).unwrap();

        assert!(text.contains("\"schemaVersion\": 1"));
        assert!(text.contains(DATABASE_PATH_REDACTION));
        assert!(!text.contains("plain-key"));
        assert!(!text.contains("sk-test"));
        assert!(!text.contains("videorc.sqlite3"));
        assert!(
            result
                .included_sections
                .contains(&"diagnostics".to_string())
        );
        let _ = std::fs::remove_dir_all(directory);
    }
}
