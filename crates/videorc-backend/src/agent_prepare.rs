//! `schedule_stream` (plan 209 S14): an upcoming livestream on YouTube or X,
//! through the same scheduling service the Upcoming page uses: the local
//! time resolved in the streamer's time zone (`resolveTime`'s function), the
//! event saved as a draft, then scheduled on the platform. A scheduled time is
//! metadata, never a timer: nothing goes live by itself.
//!
//! The answer is allowlisted (D9): the event's id, platform, title, start and
//! public watch link. Never the account id, the ingest or a stream key.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::agent_call::ToolOutcome;
use crate::agent_registry::AgentIdentity;
use crate::scheduled_streams::{DEFAULT_PLANNED_DURATION_HOURS, EventMetadata, local_wall_time};
use crate::state::AppState;
use crate::streaming::{PlatformAccountStatus, StreamPlatform};

/// A schedule call waits this long for the platform before answering that it
/// is still on its way (the Upcoming page shows the rest).
const SCHEDULE_WAIT: Duration = Duration::from_secs(40);

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// Wait for a scheduling operation to end; `Err` carries the service's own
/// sentence, `Ok(false)` that it is still running.
async fn settle(state: &AppState, operation_id: &str, deadline: Instant) -> Result<bool, String> {
    loop {
        let operation = state
            .database
            .scheduled_operation(operation_id)
            .map_err(|error| error.to_string())?;
        match operation.as_ref().map(|operation| operation.state.as_str()) {
            Some("complete") => return Ok(true),
            Some("pending") | None => {}
            Some(_) => {
                return Err(operation
                    .and_then(|operation| operation.error)
                    .map(|error| error.message)
                    .unwrap_or_else(|| "The platform didn't schedule it.".to_string()));
            }
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The scheduling account: the one connected account of the platform, or the
/// one the agent named by its label.
pub fn choose_account(
    accounts: &[crate::streaming::PlatformAccount],
    platform: StreamPlatform,
    named: Option<&str>,
) -> Result<(String, String), String> {
    let label = crate::streaming::stream_platform_label(platform);
    let candidates: Vec<_> = accounts
        .iter()
        .filter(|account| {
            account.platform == platform && account.status == PlatformAccountStatus::Connected
        })
        .collect();
    let chosen = match named {
        Some(name) => candidates
            .iter()
            .find(|account| account.account_label.eq_ignore_ascii_case(name.trim()))
            .copied(),
        None if candidates.len() == 1 => candidates.first().copied(),
        None if candidates.is_empty() => None,
        None => {
            let names: Vec<&str> = candidates
                .iter()
                .map(|account| account.account_label.as_str())
                .collect();
            return Err(format!(
                "Say which {label} account: account, one of {}.",
                names.join(", ")
            ));
        }
    };
    chosen
        .map(|account| (account.account_id.clone(), account.account_label.clone()))
        .ok_or_else(|| match named {
            Some(name) => format!(
                "No connected {label} account is called \"{}\".",
                name.trim()
            ),
            None => format!("Connect {label} in Videorc → Livestream first."),
        })
}

pub async fn schedule_stream(state: &AppState, _agent: &AgentIdentity, args: Value) -> ToolOutcome {
    let provider = match text_of(&args, "platform").unwrap_or("youtube") {
        "x" => "x",
        _ => "youtube",
    };
    let platform = if provider == "x" {
        StreamPlatform::X
    } else {
        StreamPlatform::Youtube
    };
    let Some(title) = text_of(&args, "title") else {
        return ToolOutcome::refused("Say the stream's title: title.");
    };
    let (Some(start), Some(time_zone)) = (text_of(&args, "start"), text_of(&args, "timeZone"))
    else {
        return ToolOutcome::refused(
            "Say when, in the streamer's time: start (2026-11-02T19:30) and timeZone (Europe/Madrid).",
        );
    };
    // YouTube asks every streamer to say who the stream is for; Videorc's
    // form never guesses it, and neither does an agent.
    let made_for_kids = args.get("madeForKids").and_then(Value::as_bool);
    if provider == "youtube" && made_for_kids.is_none() {
        return ToolOutcome::refused(
            "Say whether the stream is made for kids: madeForKids true or false. YouTube asks for it.",
        );
    }

    // The platform must be able to schedule at all, in its own words.
    let capabilities = match crate::scheduled_streams_service::dispatch(
        state,
        "scheduledStreams.capabilities",
        json!({}),
    )
    .await
    {
        Ok(capabilities) => capabilities,
        Err(error) => return ToolOutcome::failed(error.to_string()),
    };
    if let Some(entry) = capabilities["providers"]
        .as_array()
        .and_then(|providers| providers.iter().find(|entry| entry["provider"] == provider))
        && entry["available"] != true
    {
        return ToolOutcome::refused(
            entry["reason"]
                .as_str()
                .unwrap_or("Scheduling isn't available on this platform right now.")
                .to_string(),
        );
    }
    let accounts = match state.database.list_platform_accounts() {
        Ok(accounts) => accounts,
        Err(error) => return ToolOutcome::failed(error.to_string()),
    };
    let (account_id, _) = match choose_account(&accounts, platform, text_of(&args, "account")) {
        Ok(account) => account,
        Err(sentence) => return ToolOutcome::refused(sentence),
    };

    // `resolveTime`'s function: a local time that does not exist, or occurs
    // twice, is refused with its own sentence.
    let start_utc = match crate::scheduled_streams::resolve_time(start, time_zone, None) {
        Ok(utc) => utc,
        Err(error) => return ToolOutcome::refused(error.to_string()),
    };
    let planned_end_local = match (provider, text_of(&args, "plannedEnd")) {
        (_, Some(end)) => Some(end.to_string()),
        // X needs an end on every schedule; the form's default is two hours.
        ("x", None) => match local_wall_time(
            start_utc + chrono::Duration::hours(DEFAULT_PLANNED_DURATION_HOURS),
            time_zone,
        ) {
            Ok(end) => Some(end),
            Err(error) => return ToolOutcome::refused(error.to_string()),
        },
        _ => None,
    };
    let privacy = match text_of(&args, "privacy") {
        Some(privacy @ ("public" | "unlisted" | "private")) => privacy.to_string(),
        _ => "public".to_string(),
    };
    let metadata = EventMetadata {
        title: title.to_string(),
        description: text_of(&args, "description")
            .unwrap_or_default()
            .to_string(),
        privacy,
        made_for_kids: made_for_kids.unwrap_or(false),
        local_start: start.to_string(),
        time_zone: time_zone.to_string(),
        offset_choice: None,
        thumbnail_asset_id: None,
        planned_end_local,
        available_for_replay: (provider == "x").then_some(true),
    };
    if let Err(error) = metadata.validate_for(provider, true) {
        return ToolOutcome::refused(error.to_string());
    }

    // Save the draft, then schedule it on the platform: the Upcoming form's
    // two steps, each an idempotent operation.
    let event_id = uuid::Uuid::new_v4().to_string();
    let deadline = Instant::now() + SCHEDULE_WAIT;
    let draft_operation = uuid::Uuid::new_v4().to_string();
    if let Err(error) = crate::scheduled_streams_service::dispatch(
        state,
        "scheduledStreams.saveDraft",
        json!({
            "operationId": draft_operation,
            "eventId": event_id,
            "expectedRevision": 0,
            "provider": provider,
            "accountId": account_id,
            "metadata": metadata,
        }),
    )
    .await
    {
        return ToolOutcome::refused(error.to_string());
    }
    match settle(state, &draft_operation, deadline).await {
        Ok(true) => {}
        Ok(false) => {
            return ToolOutcome::timeout(
                "Videorc is still saving the event. It shows in Videorc → Upcoming.",
            );
        }
        Err(sentence) => return ToolOutcome::refused(sentence),
    }
    let revision = match state.database.scheduled_event(&event_id) {
        Ok(event) => event.revision,
        Err(error) => return ToolOutcome::failed(error.to_string()),
    };
    let schedule_operation = uuid::Uuid::new_v4().to_string();
    if let Err(error) = crate::scheduled_streams_service::dispatch(
        state,
        "scheduledStreams.schedule",
        json!({
            "operationId": schedule_operation,
            "eventId": event_id,
            "expectedRevision": revision,
        }),
    )
    .await
    {
        return ToolOutcome::refused(error.to_string());
    }
    let scheduled = match settle(state, &schedule_operation, deadline).await {
        Ok(done) => done,
        Err(sentence) => return ToolOutcome::refused(sentence),
    };
    let event = match state.database.scheduled_event(&event_id) {
        Ok(event) => event,
        Err(error) => return ToolOutcome::failed(error.to_string()),
    };
    let label = crate::streaming::stream_platform_label(platform);
    let mut out = serde_json::Map::new();
    out.insert("eventId".into(), json!(event.id));
    out.insert("platform".into(), json!(provider));
    out.insert("title".into(), json!(event.requested.title));
    out.insert("startsAt".into(), json!(event.start_utc));
    out.insert("scheduled".into(), json!(scheduled));
    if let Some(url) = event.watch_url.as_deref() {
        out.insert("watchUrl".into(), json!(url));
    }
    let text = if scheduled {
        format!("Scheduled on {label} for {start} ({time_zone}).")
    } else {
        format!("Saved; {label} is still scheduling it. It shows in Videorc → Upcoming.")
    };
    ToolOutcome::ok(text, Some(serde_json::Value::Object(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_mcp::test_support::{connect_agent, test_state};

    fn account(
        platform: StreamPlatform,
        id: &str,
        label: &str,
    ) -> crate::streaming::PlatformAccount {
        serde_json::from_value(json!({
            "id": format!("{id}-row"),
            "platform": crate::streaming::stream_platform_id(platform),
            "accountId": id,
            "accountLabel": label,
            "scopes": [],
            "accessTokenPresent": true,
            "refreshTokenPresent": true,
            "streamKeyPresent": false,
            "connectedAt": "2026-10-27T10:00:00Z",
            "updatedAt": "2026-10-27T10:00:00Z",
            "status": "connected"
        }))
        .unwrap()
    }

    #[test]
    fn the_account_is_the_only_one_or_the_one_named() {
        let one = vec![account(StreamPlatform::Youtube, "UC1", "Orc Dev")];
        assert_eq!(
            choose_account(&one, StreamPlatform::Youtube, None),
            Ok(("UC1".to_string(), "Orc Dev".to_string()))
        );
        assert_eq!(
            choose_account(&one, StreamPlatform::X, None),
            Err("Connect X in Videorc → Livestream first.".to_string())
        );
        let two = vec![
            account(StreamPlatform::Youtube, "UC1", "Orc Dev"),
            account(StreamPlatform::Youtube, "UC2", "Orc Clips"),
        ];
        assert_eq!(
            choose_account(&two, StreamPlatform::Youtube, None),
            Err("Say which YouTube account: account, one of Orc Dev, Orc Clips.".to_string())
        );
        assert_eq!(
            choose_account(&two, StreamPlatform::Youtube, Some("orc clips")),
            Ok(("UC2".to_string(), "Orc Clips".to_string()))
        );
        assert!(choose_account(&two, StreamPlatform::Youtube, Some("nobody")).is_err());
    }

    #[tokio::test]
    async fn youtube_needs_the_audience_and_a_connected_channel() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Claude Code");
        let outcome = schedule_stream(
            &state,
            &agent,
            json!({ "title": "Building an MCP", "start": "2035-01-01T12:00", "timeZone": "Europe/Madrid" }),
        )
        .await;
        assert_eq!(
            outcome,
            ToolOutcome::refused(
                "Say whether the stream is made for kids: madeForKids true or false. YouTube asks for it."
            )
        );
        let outcome = schedule_stream(
            &state,
            &agent,
            json!({ "title": "Building an MCP", "start": "2035-01-01T12:00",
                    "timeZone": "Europe/Madrid", "madeForKids": false }),
        )
        .await;
        // No channel connected (or no Google sign-in in this build): refused
        // with the service's or the account's own sentence, never scheduled.
        assert_eq!(
            outcome.outcome,
            crate::storage::AgentActivityOutcome::Refused
        );
        assert!(state.database.scheduled_events().unwrap().is_empty());
    }
}
