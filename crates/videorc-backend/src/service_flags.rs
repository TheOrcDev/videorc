//! Remote service flags (plan 094, S7): the owner's lever that needs no release.
//!
//! The desktop reads `GET https://www.videorc.com/api/desktop/service-flags`
//! (videorc-web PR #67) at startup and every 30 minutes, and lets the owner
//! throttle YouTube for every updated client by editing one JSON document:
//!
//! ```json
//! { "version": 1, "youtube": { "chatTransport": "list", "minPollMs": 5000,
//!   "viewerSampleMs": 60000, "dailyBudgetUnits": 2500,
//!   "pausedUntil": "2026-10-03T07:00:00Z" } }
//! ```
//!
//! Every key is optional (missing = compiled default) and unknown keys are
//! ignored. The client FAILS OPEN: a non-200, unreadable JSON, `version != 1`
//! or a network error means the compiled defaults, never a stuck throttle.
//! Values are clamped to safe bounds (`minPollMs` ≥ 5,000; `viewerSampleMs`
//! ≥ 30,000; `dailyBudgetUnits` 0..=10,000), a `pausedUntil` in the past is
//! ignored and one in the future feeds the S1 breaker as a remote pause.
//! `chatTransport: "stream"` must not enable anything until S5 exists: it is
//! treated as `list` and logged. `"off"` parks the chat reader with a clear
//! Waiting message. The flags in effect are logged to the backend log and to
//! the session log (`youtube-service-flags`).

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

pub const SERVICE_FLAGS_PATH: &str = "/api/desktop/service-flags";
/// The only document version this client understands.
pub const SERVICE_FLAGS_VERSION: u64 = 1;
pub const SERVICE_FLAGS_REFRESH_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// A slow edge must never hold the refresher; failing open is fine.
pub const SERVICE_FLAGS_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Session log code for the flags in effect.
pub const SERVICE_FLAGS_LOG_CODE: &str = "youtube-service-flags";

/// Clamp floors and ceilings: a flag can only make a client gentler than its
/// compiled defaults allow, never faster or bigger.
pub const MIN_POLL_FLOOR_MS: u64 = crate::youtube_chat::MIN_POLLING_INTERVAL_MS;
pub const VIEWER_SAMPLE_FLOOR_MS: u64 = 30_000;
pub const DAILY_BUDGET_UNITS_MAX: u64 = 10_000;

/// Compiled defaults the flags start from.
pub const DEFAULT_MIN_POLL_MS: u64 = crate::youtube_chat::MIN_POLLING_INTERVAL_MS;
pub const DEFAULT_VIEWER_SAMPLE_MS: u64 = 120_000;

/// The chat reader transport a flag may ask for. `Stream` is not here on
/// purpose: until S5 lands it is read as `List` and noted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatTransportFlag {
    List,
    /// Park the YouTube chat reader with a Waiting message.
    Off,
}

/// Where the flags in effect came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum ServiceFlagsSource {
    /// Compiled defaults (never fetched, fetch failed, or an empty document).
    Compiled,
    /// The remote document, fetched at `fetchedAt` (RFC 3339).
    Remote { fetched_at: String },
}

/// The Orcle kill switches (plan 140, contract part D): the document's
/// optional top-level `orcle` object. A missing object or field means enabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcleServiceFlags {
    /// `false` stops command detection.
    pub voice_commands: bool,
    /// `false` refuses every `orcle-voice` removal with `disabled`. Manual
    /// removal is unaffected.
    pub remove: bool,
}

impl Default for OrcleServiceFlags {
    fn default() -> Self {
        Self {
            voice_commands: true,
            remove: true,
        }
    }
}

/// The YouTube flags in effect, after clamping. Compiled defaults by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeServiceFlags {
    pub chat_transport: ChatTransportFlag,
    pub min_poll_ms: u64,
    pub viewer_sample_ms: u64,
    /// `None` keeps the compiled budget (`youtube_quota::DEFAULT_DAILY_BUDGET_UNITS`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_budget_units: Option<u64>,
    /// An owner-set global pause, UTC. Fed to the breaker while in the future.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_until: Option<DateTime<Utc>>,
    /// The Orcle switches ride the same document and the same refresh.
    #[serde(default)]
    pub orcle: OrcleServiceFlags,
    pub source: ServiceFlagsSource,
    /// What was clamped, ignored or translated, for the log.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl Default for YouTubeServiceFlags {
    fn default() -> Self {
        Self {
            chat_transport: ChatTransportFlag::List,
            min_poll_ms: DEFAULT_MIN_POLL_MS,
            viewer_sample_ms: DEFAULT_VIEWER_SAMPLE_MS,
            daily_budget_units: None,
            paused_until: None,
            orcle: OrcleServiceFlags::default(),
            source: ServiceFlagsSource::Compiled,
            notes: Vec::new(),
        }
    }
}

/// Whether Orcle voice commands are allowed right now (contract part D).
/// (`YouTubeQuota::flags` is private to `youtube_quota`; read the copy in
/// effect through its public accessor.)
pub fn orcle_voice_commands_enabled(state: &AppState) -> bool {
    crate::youtube_quota::service_flags_in_effect(state)
        .orcle
        .voice_commands
}

/// Whether `orcle-voice` removals are allowed right now. Manual removal never
/// consults this.
pub fn orcle_remove_enabled(state: &AppState) -> bool {
    crate::youtube_quota::service_flags_in_effect(state)
        .orcle
        .remove
}

impl YouTubeServiceFlags {
    /// The compiled defaults, with a reason for the log.
    pub fn compiled(why: impl Into<String>) -> Self {
        Self {
            notes: vec![why.into()],
            ..Self::default()
        }
    }

    /// Whether anything differs from the compiled defaults (ignoring notes and source).
    pub fn is_default_behaviour(&self) -> bool {
        let defaults = Self::default();
        self.chat_transport == defaults.chat_transport
            && self.min_poll_ms == defaults.min_poll_ms
            && self.viewer_sample_ms == defaults.viewer_sample_ms
            && self.daily_budget_units.is_none()
            && self.paused_until.is_none()
            && self.orcle == defaults.orcle
    }

    /// One line for the backend log.
    pub fn summary(&self) -> String {
        let source = match &self.source {
            ServiceFlagsSource::Compiled => "compiled defaults".to_string(),
            ServiceFlagsSource::Remote { fetched_at } => format!("remote, fetched {fetched_at}"),
        };
        let transport = match self.chat_transport {
            ChatTransportFlag::List => "list",
            ChatTransportFlag::Off => "off",
        };
        let budget = match self.daily_budget_units {
            Some(0) => "off".to_string(),
            Some(units) => format!("{units} units"),
            None => format!(
                "{} units (compiled)",
                crate::youtube_quota::DEFAULT_DAILY_BUDGET_UNITS
            ),
        };
        let paused = match self.paused_until {
            Some(until) => format!("paused until {}", until.to_rfc3339()),
            None => "no remote pause".to_string(),
        };
        let orcle = match (self.orcle.voice_commands, self.orcle.remove) {
            (true, true) => String::new(),
            (voice_commands, remove) => format!(
                ", Orcle voice commands {}, Orcle removals {}",
                if voice_commands { "on" } else { "paused" },
                if remove { "on" } else { "paused" }
            ),
        };
        let notes = if self.notes.is_empty() {
            String::new()
        } else {
            format!("; notes: {}", self.notes.join(" | "))
        };
        format!(
            "YouTube service flags in effect ({source}): chat {transport}, poll floor {} ms, viewers every {} ms, daily budget {budget}, {paused}{orcle}{notes}",
            self.min_poll_ms, self.viewer_sample_ms
        )
    }
}

// --- Parsing (pure) ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WireDocument {
    version: serde_json::Value,
    /// Judged below: an object becomes [`WireYouTube`], anything else is noted.
    #[serde(default)]
    youtube: Option<serde_json::Value>,
    /// Plan 140: `{ "voiceCommands": bool, "remove": bool }`, judged below.
    #[serde(default)]
    orcle: Option<serde_json::Value>,
}

/// Read one Orcle switch: only a JSON boolean counts; anything else keeps the
/// switch on and leaves a note.
fn orcle_switch(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    notes: &mut Vec<String>,
) -> bool {
    match object.get(key) {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Bool(enabled)) => *enabled,
        Some(other) => {
            notes.push(format!(
                "orcle.{key} {other} is not a boolean; keeping it enabled"
            ));
            true
        }
    }
}

/// The `orcle` block, parsed on its own so a broken YouTube block never hides it.
fn parse_orcle_flags(
    value: Option<serde_json::Value>,
    notes: &mut Vec<String>,
) -> OrcleServiceFlags {
    match value {
        None | Some(serde_json::Value::Null) => OrcleServiceFlags::default(),
        Some(serde_json::Value::Object(object)) => OrcleServiceFlags {
            voice_commands: orcle_switch(&object, "voiceCommands", notes),
            remove: orcle_switch(&object, "remove", notes),
        },
        Some(other) => {
            notes.push(format!(
                "orcle {other} is not an object; keeping Orcle enabled"
            ));
            OrcleServiceFlags::default()
        }
    }
}

/// Loose on purpose: every field optional, any JSON type accepted and judged
/// below, unknown keys ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireYouTube {
    #[serde(default)]
    chat_transport: Option<serde_json::Value>,
    #[serde(default)]
    min_poll_ms: Option<serde_json::Value>,
    #[serde(default)]
    viewer_sample_ms: Option<serde_json::Value>,
    #[serde(default)]
    daily_budget_units: Option<serde_json::Value>,
    #[serde(default)]
    paused_until: Option<serde_json::Value>,
}

fn integer(value: &serde_json::Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.fract() == 0.0)
            .map(|f| f as i64)
    })
}

/// Parse and clamp one document. `Err` means "fail open to compiled defaults"
/// with the reason; the caller never trusts a partial read.
pub fn parse_service_flags(body: &str, now: DateTime<Utc>) -> Result<YouTubeServiceFlags, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("service flags are not readable JSON: {error}"))?;
    // serde would read a one-element array as the struct; only an object is a document.
    if !value.is_object() {
        return Err("service flags are not a JSON object".to_string());
    }
    let document: WireDocument = serde_json::from_value(value)
        .map_err(|error| format!("service flags are not readable: {error}"))?;
    match integer(&document.version) {
        Some(version) if version as u64 == SERVICE_FLAGS_VERSION && version > 0 => {}
        Some(version) => {
            return Err(format!(
                "service flags version {version} is not {SERVICE_FLAGS_VERSION}"
            ));
        }
        None => return Err("service flags carry no integer version".to_string()),
    }
    let mut flags = YouTubeServiceFlags {
        source: ServiceFlagsSource::Remote {
            fetched_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        },
        ..YouTubeServiceFlags::default()
    };
    flags.orcle = parse_orcle_flags(document.orcle, &mut flags.notes);
    let youtube = match document.youtube {
        None | Some(serde_json::Value::Null) => return Ok(flags),
        Some(value) if value.is_object() => serde_json::from_value::<WireYouTube>(value)
            .map_err(|error| format!("service flags youtube block is not readable: {error}"))?,
        Some(other) => {
            flags.notes.push(format!(
                "youtube {other} is not an object; keeping the defaults"
            ));
            return Ok(flags);
        }
    };

    if let Some(value) = youtube.chat_transport {
        match value.as_str() {
            Some("list") => flags.chat_transport = ChatTransportFlag::List,
            Some("off") => flags.chat_transport = ChatTransportFlag::Off,
            Some("stream") => {
                flags.chat_transport = ChatTransportFlag::List;
                flags.notes.push(
                    "chatTransport \"stream\" read as \"list\": streamList is not built yet (plan 094, S5)".to_string(),
                );
            }
            _ => flags.notes.push(format!(
                "chatTransport {value} is unknown; keeping \"list\""
            )),
        }
    }
    if let Some(value) = youtube.min_poll_ms {
        match integer(&value) {
            Some(ms) if ms >= 0 && ms as u64 >= MIN_POLL_FLOOR_MS => flags.min_poll_ms = ms as u64,
            Some(ms) => {
                flags.min_poll_ms = MIN_POLL_FLOOR_MS;
                flags.notes.push(format!(
                    "minPollMs {ms} clamped to the {MIN_POLL_FLOOR_MS} ms floor"
                ));
            }
            None => flags.notes.push(format!(
                "minPollMs {value} is not an integer; keeping the default"
            )),
        }
    }
    if let Some(value) = youtube.viewer_sample_ms {
        match integer(&value) {
            Some(ms) if ms >= 0 && ms as u64 >= VIEWER_SAMPLE_FLOOR_MS => {
                flags.viewer_sample_ms = ms as u64
            }
            Some(ms) => {
                flags.viewer_sample_ms = VIEWER_SAMPLE_FLOOR_MS;
                flags.notes.push(format!(
                    "viewerSampleMs {ms} clamped to the {VIEWER_SAMPLE_FLOOR_MS} ms floor"
                ));
            }
            None => flags.notes.push(format!(
                "viewerSampleMs {value} is not an integer; keeping the default"
            )),
        }
    }
    if let Some(value) = youtube.daily_budget_units {
        match integer(&value) {
            Some(units) if (0..=DAILY_BUDGET_UNITS_MAX as i64).contains(&units) => {
                flags.daily_budget_units = Some(units as u64)
            }
            Some(units) => {
                let clamped = units.clamp(0, DAILY_BUDGET_UNITS_MAX as i64) as u64;
                flags.daily_budget_units = Some(clamped);
                flags.notes.push(format!(
                    "dailyBudgetUnits {units} clamped to {clamped} (0..={DAILY_BUDGET_UNITS_MAX})"
                ));
            }
            None => flags.notes.push(format!(
                "dailyBudgetUnits {value} is not an integer; keeping the compiled budget"
            )),
        }
    }
    if let Some(value) = youtube.paused_until {
        match value.as_str().map(DateTime::parse_from_rfc3339) {
            Some(Ok(until)) => {
                let until = until.with_timezone(&Utc);
                if until > now {
                    flags.paused_until = Some(until);
                } else {
                    flags.notes.push(format!(
                        "pausedUntil {} is in the past; ignored",
                        until.to_rfc3339()
                    ));
                }
            }
            Some(Err(error)) => flags.notes.push(format!(
                "pausedUntil {value} is not RFC 3339 ({error}); ignored"
            )),
            None => flags
                .notes
                .push(format!("pausedUntil {value} is not a string; ignored")),
        }
    }
    Ok(flags)
}

// --- Fetching and applying ------------------------------------------------------------

/// Fetch the document from `base_url`. Any failure is a reason to fail open.
pub async fn fetch_service_flags(
    client: &reqwest::Client,
    base_url: &str,
    now: DateTime<Utc>,
) -> Result<YouTubeServiceFlags, String> {
    let url = format!("{}{SERVICE_FLAGS_PATH}", base_url.trim_end_matches('/'));
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("service flags unreachable: {error}"))?;
    let status = response.status();
    if status != reqwest::StatusCode::OK {
        return Err(format!("service flags answered HTTP {status}"));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("service flags body unreadable: {error}"))?;
    if body.len() > 64 * 1024 {
        return Err("service flags document is larger than 64 KiB".to_string());
    }
    parse_service_flags(&body, now)
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(SERVICE_FLAGS_REQUEST_TIMEOUT)
        .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

/// One fetch-and-apply round. Returns the flags now in effect.
pub async fn refresh_service_flags(state: &AppState) -> YouTubeServiceFlags {
    let now = Utc::now();
    let fetched = match http_client() {
        Some(client) => {
            fetch_service_flags(&client, &crate::videorc_api::api_base_url(), now).await
        }
        None => Err("could not build the HTTP client".to_string()),
    };
    let flags = match fetched {
        Ok(flags) => flags,
        Err(why) => {
            tracing::info!("[service-flags] failing open to compiled defaults: {why}");
            YouTubeServiceFlags::compiled(format!("fail-open: {why}"))
        }
    };
    crate::youtube_quota::apply_service_flags(state, flags.clone());
    flags
}

/// Startup task: apply once now, then every 30 minutes.
pub async fn run_service_flags_refresher(state: AppState) {
    loop {
        refresh_service_flags(&state).await;
        tokio::time::sleep(SERVICE_FLAGS_REFRESH_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-02T20:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn an_empty_document_means_compiled_defaults_from_a_remote_source() {
        let flags = parse_service_flags(r#"{"version":1}"#, now()).unwrap();
        assert!(flags.is_default_behaviour());
        assert_eq!(flags.chat_transport, ChatTransportFlag::List);
        assert_eq!(flags.min_poll_ms, 5_000);
        assert_eq!(flags.viewer_sample_ms, 120_000);
        assert_eq!(flags.daily_budget_units, None);
        assert_eq!(flags.paused_until, None);
        assert!(matches!(flags.source, ServiceFlagsSource::Remote { .. }));
        assert!(flags.notes.is_empty());
        // A youtube block with only unknown keys is the same.
        let unknown = parse_service_flags(
            r#"{"version":1,"youtube":{"futureKey":true,"another":{"x":1}},"twitch":{}}"#,
            now(),
        )
        .unwrap();
        assert!(unknown.is_default_behaviour());
        assert!(unknown.notes.is_empty());
    }

    #[test]
    fn every_key_parses_and_is_clamped_to_safe_bounds() {
        let body = json!({
            "version": 1,
            "youtube": {
                "chatTransport": "off",
                "minPollMs": 7500,
                "viewerSampleMs": 90000,
                "dailyBudgetUnits": 1200,
                "pausedUntil": "2026-10-03T07:00:00.000Z"
            }
        });
        let flags = parse_service_flags(&body.to_string(), now()).unwrap();
        assert_eq!(flags.chat_transport, ChatTransportFlag::Off);
        assert_eq!(flags.min_poll_ms, 7_500);
        assert_eq!(flags.viewer_sample_ms, 90_000);
        assert_eq!(flags.daily_budget_units, Some(1_200));
        assert_eq!(
            flags.paused_until.map(|until| until.to_rfc3339()),
            Some("2026-10-03T07:00:00+00:00".to_string()),
            "fractional seconds and Z are accepted"
        );
        assert!(flags.notes.is_empty());

        let clamped = parse_service_flags(
            &json!({
                "version": 1,
                "youtube": {
                    "minPollMs": 1000,
                    "viewerSampleMs": 5000,
                    "dailyBudgetUnits": 50000
                }
            })
            .to_string(),
            now(),
        )
        .unwrap();
        assert_eq!(clamped.min_poll_ms, 5_000, "never faster than the floor");
        assert_eq!(clamped.viewer_sample_ms, 30_000);
        assert_eq!(clamped.daily_budget_units, Some(10_000));
        assert_eq!(clamped.notes.len(), 3, "{:?}", clamped.notes);

        let negative = parse_service_flags(
            r#"{"version":1,"youtube":{"minPollMs":-5,"viewerSampleMs":-1,"dailyBudgetUnits":-10}}"#,
            now(),
        )
        .unwrap();
        assert_eq!(negative.min_poll_ms, 5_000);
        assert_eq!(negative.viewer_sample_ms, 30_000);
        assert_eq!(negative.daily_budget_units, Some(0), "clamped to off");

        let wrong_types = parse_service_flags(
            r#"{"version":1,"youtube":{"minPollMs":"fast","viewerSampleMs":12.5,"dailyBudgetUnits":true,"chatTransport":7,"pausedUntil":42}}"#,
            now(),
        )
        .unwrap();
        assert!(wrong_types.is_default_behaviour(), "{wrong_types:?}");
        assert_eq!(wrong_types.notes.len(), 5, "{:?}", wrong_types.notes);
        // A budget of 0 is valid: it switches the budget off.
        let off = parse_service_flags(r#"{"version":1,"youtube":{"dailyBudgetUnits":0}}"#, now())
            .unwrap();
        assert_eq!(off.daily_budget_units, Some(0));
    }

    #[test]
    fn stream_is_read_as_list_until_s5_and_off_parks_chat() {
        let stream = parse_service_flags(
            r#"{"version":1,"youtube":{"chatTransport":"stream"}}"#,
            now(),
        )
        .unwrap();
        assert_eq!(stream.chat_transport, ChatTransportFlag::List);
        assert_eq!(stream.notes.len(), 1);
        assert!(stream.notes[0].contains("streamList is not built yet"));
        // Exact lowercase only.
        let shouting =
            parse_service_flags(r#"{"version":1,"youtube":{"chatTransport":"OFF"}}"#, now())
                .unwrap();
        assert_eq!(shouting.chat_transport, ChatTransportFlag::List);
        assert_eq!(shouting.notes.len(), 1);
        let off = parse_service_flags(r#"{"version":1,"youtube":{"chatTransport":"off"}}"#, now())
            .unwrap();
        assert_eq!(off.chat_transport, ChatTransportFlag::Off);
        assert!(!off.is_default_behaviour());
    }

    #[test]
    fn a_past_pause_is_ignored_and_a_future_one_kept() {
        let past = parse_service_flags(
            r#"{"version":1,"youtube":{"pausedUntil":"2026-10-02T19:59:59Z"}}"#,
            now(),
        )
        .unwrap();
        assert_eq!(past.paused_until, None);
        assert!(past.notes[0].contains("in the past"));
        let future = parse_service_flags(
            r#"{"version":1,"youtube":{"pausedUntil":"2026-10-02T20:00:01+02:00"}}"#,
            now(),
        )
        .unwrap();
        // 20:00:01+02:00 is 18:00:01Z, which is in the past at 20:00Z.
        assert_eq!(future.paused_until, None, "offsets are honoured");
        let really_future = parse_service_flags(
            r#"{"version":1,"youtube":{"pausedUntil":"2026-10-03T09:00:00+02:00"}}"#,
            now(),
        )
        .unwrap();
        assert_eq!(
            really_future.paused_until.map(|until| until.to_rfc3339()),
            Some("2026-10-03T07:00:00+00:00".to_string())
        );
        let garbage = parse_service_flags(
            r#"{"version":1,"youtube":{"pausedUntil":"tomorrow morning"}}"#,
            now(),
        )
        .unwrap();
        assert_eq!(garbage.paused_until, None);
        assert!(garbage.notes[0].contains("not RFC 3339"));
    }

    #[test]
    fn unreadable_or_foreign_documents_fail_open() {
        assert!(parse_service_flags("", now()).is_err());
        assert!(parse_service_flags("<html>502</html>", now()).is_err());
        assert!(
            parse_service_flags(r#"{"youtube":{}}"#, now()).is_err(),
            "no version"
        );
        assert!(parse_service_flags(r#"{"version":2}"#, now()).is_err());
        assert!(parse_service_flags(r#"{"version":"1"}"#, now()).is_err());
        assert!(parse_service_flags(r#"{"version":0}"#, now()).is_err());
        assert!(
            parse_service_flags(r#"[1]"#, now()).is_err(),
            "an array is not a document"
        );
        assert!(parse_service_flags(r#"[1, {"minPollMs": 1}]"#, now()).is_err());
        let not_an_object =
            parse_service_flags(r#"{"version":1,"youtube":[5000]}"#, now()).unwrap();
        assert!(not_an_object.is_default_behaviour());
        assert_eq!(not_an_object.notes.len(), 1, "{:?}", not_an_object.notes);
        assert!(
            parse_service_flags(r#"{"version":1,"youtube":null}"#, now())
                .unwrap()
                .is_default_behaviour()
        );
        let defaults = YouTubeServiceFlags::compiled("fail-open: test");
        assert!(defaults.is_default_behaviour());
        assert_eq!(defaults.source, ServiceFlagsSource::Compiled);
        assert!(defaults.summary().contains("compiled defaults"));
        assert!(defaults.summary().contains("fail-open: test"));
    }

    #[test]
    fn orcle_switches_default_to_enabled_and_read_only_booleans() {
        // Plan 140, contract part D: a missing object or field means enabled.
        let absent = parse_service_flags(r#"{"version":1}"#, now()).unwrap();
        assert_eq!(absent.orcle, OrcleServiceFlags::default());
        assert!(absent.orcle.voice_commands && absent.orcle.remove);
        assert!(absent.is_default_behaviour());
        assert!(!absent.summary().contains("Orcle"));

        let partial =
            parse_service_flags(r#"{"version":1,"orcle":{"remove":false}}"#, now()).unwrap();
        assert!(partial.orcle.voice_commands);
        assert!(!partial.orcle.remove);
        assert!(!partial.is_default_behaviour());
        assert!(
            partial.summary().contains("Orcle removals paused"),
            "{}",
            partial.summary()
        );
        assert!(partial.notes.is_empty());

        let both = parse_service_flags(
            r#"{"version":1,"orcle":{"voiceCommands":false,"remove":false},"youtube":{}}"#,
            now(),
        )
        .unwrap();
        assert!(!both.orcle.voice_commands && !both.orcle.remove);
        assert!(both.summary().contains("Orcle voice commands paused"));

        // Wrong types keep the switch on, with a note; so does a non-object.
        let wrong = parse_service_flags(
            r#"{"version":1,"orcle":{"voiceCommands":"no","remove":0}}"#,
            now(),
        )
        .unwrap();
        assert_eq!(wrong.orcle, OrcleServiceFlags::default());
        assert_eq!(wrong.notes.len(), 2, "{:?}", wrong.notes);
        let not_object = parse_service_flags(r#"{"version":1,"orcle":[false]}"#, now()).unwrap();
        assert_eq!(not_object.orcle, OrcleServiceFlags::default());
        assert_eq!(not_object.notes.len(), 1);
        let null = parse_service_flags(r#"{"version":1,"orcle":null}"#, now()).unwrap();
        assert!(null.is_default_behaviour());

        // The switches round-trip through the persisted/serialized shape and
        // an older document without them still parses.
        let json = serde_json::to_value(&partial).unwrap();
        assert_eq!(json["orcle"]["remove"], false);
        let legacy: YouTubeServiceFlags = serde_json::from_value(serde_json::json!({
            "chatTransport": "list",
            "minPollMs": 5000,
            "viewerSampleMs": 120000,
            "source": { "kind": "compiled" }
        }))
        .unwrap();
        assert_eq!(legacy.orcle, OrcleServiceFlags::default());
    }

    async fn spawn_flags_server(status: StatusCode, body: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            SERVICE_FLAGS_PATH,
            get(move || {
                let body = body.clone();
                async move { (status, body).into_response() }
            }),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn fetching_fails_open_on_non_200_and_parses_a_good_answer() {
        let client = reqwest::Client::new();
        let broken = spawn_flags_server(StatusCode::INTERNAL_SERVER_ERROR, "boom".into()).await;
        let error = fetch_service_flags(&client, &broken, now())
            .await
            .unwrap_err();
        assert!(error.contains("HTTP 500"), "{error}");
        let redirecting = spawn_flags_server(StatusCode::TEMPORARY_REDIRECT, String::new()).await;
        assert!(
            fetch_service_flags(&client, &redirecting, now())
                .await
                .is_err()
        );
        let unreachable = fetch_service_flags(&client, "http://127.0.0.1:9", now())
            .await
            .unwrap_err();
        assert!(unreachable.contains("unreachable"), "{unreachable}");
        let good = spawn_flags_server(
            StatusCode::OK,
            r#"{"version":1,"youtube":{"minPollMs":6000,"dailyBudgetUnits":3000}}"#.into(),
        )
        .await;
        let flags = fetch_service_flags(&client, &format!("{good}/"), now())
            .await
            .unwrap();
        assert_eq!(flags.min_poll_ms, 6_000);
        assert_eq!(flags.daily_budget_units, Some(3_000));
        assert!(flags.summary().contains("remote, fetched"));
    }
}
