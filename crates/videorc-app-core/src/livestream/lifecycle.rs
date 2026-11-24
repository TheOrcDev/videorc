//! S3.5c: the prepared destinations' lifecycle on the capture config's
//! streaming JSON (`lib/capture.ts`: `patchPreparedStreamTarget`,
//! `preparedYouTubeActivationTargets`, `preparedYouTubeCompletionTargets`,
//! `preparedXActivationTargets`, `readyStreamTargetLabels`;
//! `lib/go-live-exclusions.ts`' `streamingWithoutTargets`;
//! `lib/go-live-flow.ts`' decisions).
//!
//! The Go Live flow edits a copy of `streaming` as it prepares each
//! destination on its platform; the saved config takes the same patches.

use serde_json::{Map, Value, json};

use super::targets::Target;
use super::targets::is_stream_target_ready;
use crate::studio::capture_config::is_platform_oauth_available;

/// `GoLiveSetupFailure`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupFailure {
    pub target_id: String,
    pub platform: String,
    pub label: String,
    pub message: String,
    /// YouTube's API is paused: the stream key is the way (plan 094, G5).
    pub manual_fallback: bool,
}

/// `GoLivePartialSetup`.
#[derive(Debug, Clone, PartialEq)]
pub struct PartialSetup {
    pub streaming: Value,
    pub failures: Vec<SetupFailure>,
    pub ready_labels: Vec<String>,
}

/// `decidePreparedGoLiveSetup`.
#[derive(Debug, Clone, PartialEq)]
pub enum SetupDecision {
    Start(Value),
    Partial(PartialSetup),
    NoReadyDestinations,
}

pub fn decide_prepared_setup(setup: PartialSetup) -> SetupDecision {
    if setup.failures.is_empty() {
        return SetupDecision::Start(setup.streaming);
    }
    if setup.ready_labels.is_empty() {
        return SetupDecision::NoReadyDestinations;
    }
    SetupDecision::Partial(setup)
}

fn targets_mut(streaming: &mut Value) -> Option<&mut Vec<Value>> {
    streaming.get_mut("targets").and_then(Value::as_array_mut)
}

/// `patchPreparedStreamTarget`: the target's fields merged (a `null`
/// removes one), `updatedAt` now.
pub fn patch_prepared_target(
    streaming: &mut Value,
    target_id: &str,
    patch: &Map<String, Value>,
    now: &str,
) {
    let Some(targets) = targets_mut(streaming) else {
        return;
    };
    for target in targets.iter_mut() {
        if target.get("id").and_then(Value::as_str) != Some(target_id) {
            continue;
        }
        let Some(object) = target.as_object_mut() else {
            continue;
        };
        for (key, value) in patch {
            if value.is_null() {
                object.remove(key);
            } else {
                object.insert(key.clone(), value.clone());
            }
        }
        object.insert("updatedAt".into(), Value::String(now.to_string()));
    }
}

/// A `{ status: { state, message } }` patch.
pub fn status_patch(state: &str, message: &str) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert(
        "status".into(),
        json!({ "state": state, "message": message }),
    );
    patch
}

/// The streaming document's destinations, typed.
pub fn typed_targets(streaming: &Value) -> Vec<Target> {
    typed(streaming)
}

fn typed(streaming: &Value) -> Vec<Target> {
    super::targets::targets(&json!({ "streaming": streaming }))
}

fn has(target: &Value, key: &str) -> bool {
    target
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn raw_targets(streaming: &Value) -> Vec<&Value> {
    streaming
        .get("targets")
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn field<'a>(target: &'a Value, key: &str) -> &'a str {
    target.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn id_of(target: &Value) -> String {
    field(target, "id").to_string()
}

/// `preparedYouTubeActivationTargets`: the ids.
pub fn youtube_activation_targets(streaming: &Value) -> Vec<String> {
    raw_targets(streaming)
        .into_iter()
        .filter(|t| {
            t.get("enabled").and_then(Value::as_bool).unwrap_or(false)
                && field(t, "authMode") == "oauth"
                && field(t, "platform") == "youtube"
                && is_platform_oauth_available("youtube")
                && has(t, "platformBroadcastId")
                && has(t, "platformStreamId")
        })
        .map(id_of)
        .collect()
}

/// `preparedYouTubeCompletionTargets`: the ids.
pub fn youtube_completion_targets(streaming: &Value) -> Vec<String> {
    raw_targets(streaming)
        .into_iter()
        .filter(|t| {
            field(t, "authMode") == "oauth"
                && field(t, "platform") == "youtube"
                && is_platform_oauth_available("youtube")
                && t.pointer("/status/state").and_then(Value::as_str) != Some("stopped")
                && has(t, "platformBroadcastId")
        })
        .map(id_of)
        .collect()
}

/// Backend error codes a failed YouTube call can carry (plan 094).
pub const YOUTUBE_QUOTA_PAUSED_CODE: &str = "youtube-quota-paused";
pub const YOUTUBE_BROADCAST_NOT_FOUND_CODE: &str = "youtube-broadcast-not-found";

/// A failed YouTube `complete`: the target's status, and whether cleanup
/// still counts as complete. Refused on quota or for a broadcast that no
/// longer exists is settled (`isSettledYouTubeCompletionError`): YouTube ends
/// it on its own (`enableAutoStop`), and retaining it would block every later
/// start. A scheduled event refused on quota is not; network and 5xx keep the
/// retain-and-retry path.
pub fn youtube_completion_failure(
    code: Option<&str>,
    scheduled: bool,
    message: &str,
) -> (Value, bool) {
    let settled = match code {
        Some(YOUTUBE_QUOTA_PAUSED_CODE) => !scheduled,
        Some(YOUTUBE_BROADCAST_NOT_FOUND_CODE) => true,
        _ => false,
    };
    if settled {
        (json!({ "state": "stopped", "message": message }), true)
    } else {
        (
            json!({
                "state": "warning",
                "message": super::lifecycle_copy::youtube_cleanup_review(message),
            }),
            false,
        )
    }
}

/// `assertYouTubeTransitionConfirmed`: a transition answer that doesn't
/// report `expected` (`"live"`, `"complete"`) is a failure.
pub fn youtube_transition_confirmed(result: &Value, expected: &str) -> Result<(), String> {
    let status = result["lifecycleStatus"].as_str();
    if status == Some(expected) {
        return Ok(());
    }
    Err(format!(
        "YouTube didn't confirm {expected}; current broadcast status is {}.",
        status.unwrap_or("unknown")
    ))
}

/// `preparedXActivationTargets`: the ids.
pub fn x_activation_targets(streaming: &Value) -> Vec<String> {
    raw_targets(streaming)
        .into_iter()
        .filter(|t| {
            t.get("enabled").and_then(Value::as_bool).unwrap_or(false)
                && field(t, "authMode") == "oauth"
                && field(t, "platform") == "x"
                && has(t, "platformStreamId")
                && has(t, "platformBroadcastId")
                && t.pointer("/status/state").and_then(Value::as_str) == Some("ready")
        })
        .map(id_of)
        .collect()
}

/// An X broadcast that reached publish: live, or a warning that carries its
/// share URL.
fn x_published(t: &Value) -> bool {
    match t.pointer("/status/state").and_then(Value::as_str) {
        Some("live") => true,
        Some("warning") => t
            .pointer("/status/redactedUrl")
            .and_then(Value::as_str)
            .is_some_and(|url| !url.is_empty()),
        _ => false,
    }
}

/// `preparedXCompletionTargets`: the X broadcasts that reached publish and
/// so need ending. One prepared but never published is not ended.
pub fn x_completion_targets(streaming: &Value) -> Vec<String> {
    raw_targets(streaming)
        .into_iter()
        .filter(|t| {
            field(t, "authMode") == "oauth"
                && field(t, "platform") == "x"
                && x_published(t)
                && has(t, "platformBroadcastId")
        })
        .map(id_of)
        .collect()
}

/// `holdsScheduledXPreparation` (`lib/scheduled-streams.ts`): a saved X
/// destination whose scheduled preparation is still held and never
/// published; ending the livestream releases it.
pub fn holds_scheduled_x_preparation(t: &Value) -> bool {
    field(t, "platform") == "x"
        && field(t, "authMode") == "oauth"
        && has(t, "scheduledEventId")
        && has(t, "scheduledAttemptId")
        && !x_published(t)
}

/// `isStreamTargetStartReady`.
pub fn start_ready(target: &Target) -> bool {
    if target.auth_mode == "oauth" {
        return is_platform_oauth_available(&target.platform);
    }
    is_stream_target_ready(target)
}

/// `readyStreamTargetLabels`.
pub fn ready_labels(streaming: &Value) -> Vec<String> {
    typed(streaming)
        .iter()
        .filter(|t| t.enabled && start_ready(t))
        .map(|t| super::accounts::destination_label(&t.label))
        .collect()
}

/// `streamingWithoutTargets`: the left-out destinations off for this
/// livestream (`enabled` and `enabledTargetIds`); never written back.
pub fn streaming_without_targets(streaming: &Value, excluded: &[String]) -> Value {
    if excluded.is_empty() {
        return streaming.clone();
    }
    let mut next = streaming.clone();
    if let Some(targets) = targets_mut(&mut next) {
        for target in targets.iter_mut() {
            let id = field(target, "id").to_string();
            if excluded.contains(&id)
                && target.get("enabled").and_then(Value::as_bool) == Some(true)
            {
                target["enabled"] = Value::Bool(false);
            }
        }
    }
    let enabled_ids: Vec<Value> = streaming
        .get("enabledTargetIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter(|id| {
                    id.as_str()
                        .is_none_or(|id| !excluded.iter().any(|e| e == id))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    next["enabled"] = Value::Bool(!enabled_ids.is_empty());
    next["mode"] = Value::String(
        if enabled_ids.len() > 1 {
            "multi"
        } else {
            "single"
        }
        .into(),
    );
    next["enabledTargetIds"] = Value::Array(enabled_ids);
    next
}

/// The scheduled events this livestream sends (`scheduledEventIds`).
pub fn scheduled_event_ids(streaming: &Value) -> Value {
    let mut ids = Map::new();
    for target in raw_targets(streaming) {
        if target.get("enabled").and_then(Value::as_bool) == Some(true)
            && let Some(event) = target
                .get("scheduledEventId")
                .and_then(Value::as_str)
                .filter(|event| !event.is_empty())
        {
            ids.insert(id_of(target), Value::String(event.to_string()));
        }
    }
    Value::Object(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, platform: &str, auth: &str, enabled: bool, patch: Value) -> Value {
        let mut base = json!({
            "id": id,
            "platform": platform,
            "label": id,
            "enabled": enabled,
            "serverUrl": "rtmp://example.test/live",
            "urlMode": "server-and-key",
            "streamKey": "",
            "streamKeyPresent": true,
            "streamKeySecretRef": format!("stream-target:{id}:manual-stream-key"),
            "authMode": auth,
            "accountId": format!("{platform}-account"),
            "accountLabel": format!("{platform} account"),
            "status": { "state": "ready", "message": "Prepared." },
            "createdAt": "2026-06-02T00:00:00.000Z",
            "updatedAt": "2026-06-02T00:00:00.000Z",
        });
        for (key, value) in patch.as_object().unwrap() {
            if value.is_null() {
                base.as_object_mut().unwrap().remove(key);
            } else {
                base[key] = value.clone();
            }
        }
        base
    }

    /// smoke:platform-lifecycle's twin.
    #[test]
    fn prepared_targets_are_found_patched_and_named() {
        let mut streaming = json!({
            "enabled": true,
            "mode": "multi",
            "enabledTargetIds": ["youtube-ready", "youtube-no-stream", "twitch-ready", "kick-manual",
                "facebook-manual", "facebook-signed-in", "youtube-disabled", "youtube-manual", "x-missing"],
            "targets": [
                target("youtube-ready", "youtube", "oauth", true, json!({
                    "platformBroadcastId": "broadcast-ready", "platformStreamId": "stream-ready",
                    "status": { "state": "live", "message": "YouTube broadcast is live." } })),
                target("youtube-no-stream", "youtube", "oauth", true, json!({ "platformBroadcastId": "broadcast-no-stream" })),
                target("twitch-ready", "twitch", "oauth", true, json!({})),
                target("kick-manual", "kick", "manual-rtmp", true, json!({
                    "serverUrl": "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app" })),
                target("facebook-manual", "facebook", "manual-rtmp", true, json!({
                    "serverUrl": "rtmps://live-api-s.facebook.com:443/rtmp/" })),
                target("facebook-signed-in", "facebook", "oauth", true, json!({})),
                target("youtube-disabled", "youtube", "oauth", false, json!({
                    "platformBroadcastId": "broadcast-disabled", "platformStreamId": "stream-disabled" })),
                target("youtube-manual", "youtube", "manual-rtmp", true, json!({
                    "platformBroadcastId": "broadcast-manual", "platformStreamId": "stream-manual" })),
                target("x-missing", "x", "manual-rtmp", true, json!({
                    "serverUrl": "", "streamKeyPresent": false, "streamKeySecretRef": null })),
            ],
        });
        assert_eq!(youtube_activation_targets(&streaming), ["youtube-ready"]);
        assert_eq!(
            youtube_completion_targets(&streaming),
            ["youtube-ready", "youtube-no-stream", "youtube-disabled"]
        );
        assert_eq!(
            ready_labels(&streaming),
            [
                "youtube-ready",
                "youtube-no-stream",
                "twitch-ready",
                "kick-manual",
                "facebook-manual",
                "youtube-manual"
            ]
        );
        patch_prepared_target(
            &mut streaming,
            "youtube-no-stream",
            &{
                let mut patch = status_patch("failed", "YouTube setup failed.");
                patch.insert("enabled".into(), Value::Bool(false));
                patch
            },
            "2026-06-03T00:00:00.000Z",
        );
        let failed = &streaming["targets"][1];
        assert_eq!(failed["enabled"], json!(false));
        assert_eq!(failed["status"]["state"], json!("failed"));
        assert_eq!(failed["updatedAt"], json!("2026-06-03T00:00:00.000Z"));
        assert_eq!(
            streaming["targets"][2]["updatedAt"],
            json!("2026-06-02T00:00:00.000Z")
        );
    }

    #[test]
    fn a_left_out_destination_is_off_for_this_livestream_only() {
        let streaming = json!({
            "enabled": true, "mode": "multi", "enabledTargetIds": ["a", "b"],
            "targets": [
                target("a", "twitch", "manual-rtmp", true, json!({})),
                target("b", "kick", "manual-rtmp", true, json!({ "scheduledEventId": "evt" })),
            ],
        });
        let sent = streaming_without_targets(&streaming, &["a".into()]);
        assert_eq!(sent["targets"][0]["enabled"], json!(false));
        assert_eq!(sent["enabledTargetIds"], json!(["b"]));
        assert_eq!(sent["mode"], json!("single"));
        assert_eq!(streaming["targets"][0]["enabled"], json!(true));
        assert_eq!(scheduled_event_ids(&sent), json!({ "b": "evt" }));
        let mut empty = sent.clone();
        empty["targets"][1]["scheduledEventId"] = json!("");
        assert_eq!(scheduled_event_ids(&empty), json!({}));
        let decision = decide_prepared_setup(PartialSetup {
            streaming: sent.clone(),
            failures: vec![SetupFailure {
                target_id: "a".into(),
                platform: "twitch".into(),
                label: "Twitch".into(),
                message: "Nope".into(),
                manual_fallback: false,
            }],
            ready_labels: Vec::new(),
        });
        assert_eq!(decision, SetupDecision::NoReadyDestinations);
        assert!(matches!(
            decide_prepared_setup(PartialSetup {
                streaming: sent,
                failures: Vec::new(),
                ready_labels: Vec::new()
            }),
            SetupDecision::Start(_)
        ));
    }

    #[test]
    fn only_a_published_x_broadcast_is_ended_and_a_held_preparation_released() {
        let streaming = json!({ "targets": [
            { "id": "live", "platform": "x", "authMode": "oauth", "platformBroadcastId": "b1",
              "status": { "state": "live" } },
            { "id": "warn-url", "platform": "x", "authMode": "oauth", "platformBroadcastId": "b2",
              "status": { "state": "warning", "redactedUrl": "https://x.com/i/b2" } },
            { "id": "warn", "platform": "x", "authMode": "oauth", "platformBroadcastId": "b3",
              "status": { "state": "warning" } },
            { "id": "ready", "platform": "x", "authMode": "oauth", "platformBroadcastId": "b4",
              "status": { "state": "ready" } },
            { "id": "no-id", "platform": "x", "authMode": "oauth", "status": { "state": "live" } },
        ] });
        assert_eq!(x_completion_targets(&streaming), ["live", "warn-url"]);

        let held = json!({ "platform": "x", "authMode": "oauth", "scheduledEventId": "e",
            "scheduledAttemptId": "a", "status": { "state": "ready" } });
        assert!(holds_scheduled_x_preparation(&held));
        let mut live = held.clone();
        live["status"]["state"] = json!("live");
        assert!(!holds_scheduled_x_preparation(&live));
        let mut released = held.clone();
        released["scheduledAttemptId"] = json!("");
        assert!(!holds_scheduled_x_preparation(&released));
    }

    #[test]
    fn a_youtube_complete_refused_on_quota_or_for_a_gone_broadcast_is_settled() {
        let (status, complete) =
            youtube_completion_failure(Some(YOUTUBE_QUOTA_PAUSED_CODE), false, "Quota.");
        assert!(complete);
        assert_eq!(status, json!({ "state": "stopped", "message": "Quota." }));
        let (status, complete) =
            youtube_completion_failure(Some(YOUTUBE_QUOTA_PAUSED_CODE), true, "Quota.");
        assert!(!complete);
        assert_eq!(
            status,
            json!({ "state": "warning", "message": "YouTube cleanup needs review: Quota." })
        );
        assert!(
            youtube_completion_failure(Some(YOUTUBE_BROADCAST_NOT_FOUND_CODE), true, "Gone.").1
        );
        assert!(!youtube_completion_failure(None, false, "Network.").1);

        assert_eq!(
            youtube_transition_confirmed(&json!({ "lifecycleStatus": "complete" }), "complete"),
            Ok(())
        );
        assert_eq!(
            youtube_transition_confirmed(&json!({}), "live"),
            Err("YouTube didn't confirm live; current broadcast status is unknown.".into())
        );
    }
}
