//! S19: show marks use an authorized server timeline, never a fabricated local session/file.
use crate::state::AppState;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MarkTarget {
    NativeTake { session_id: String },
    CloudShow { show_id: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePosition {
    pub source_id: String,
    pub speech_session_id: String,
    pub offset_seconds: f64,
    pub uncertainty_ms: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub show_id: String,
    pub operation_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "marker_kind")]
    pub kind: String,
    #[serde(default)]
    pub lookback_seconds: Option<u32>,
}
fn marker_kind() -> String {
    "marker".into()
}
/// Native takes remain native. A room is preferred only when it actually owns output.
pub fn current_target(state: &AppState) -> Option<MarkTarget> {
    let s = crate::cloud_show_status(state);
    if s.room
        .as_ref()
        .is_some_and(|r| matches!(r.phase, crate::cloud_talk::CloudRoomPhase::Open))
    {
        return s.show.map(|s| MarkTarget::CloudShow { show_id: s.id });
    }
    state.recording.try_lock().ok().and_then(|r| {
        r.as_ref()
            .filter(|r| !r.stop_requested)
            .map(|r| MarkTarget::NativeTake {
                session_id: r.session_id.clone(),
            })
    })
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipRequest {
    pub seconds: Option<u32>,
    pub operation_id: Option<String>,
    pub request_id: Option<String>,
    pub source: Option<String>,
}
pub async fn dispatch_clip(state: &AppState, params: Value, rpc_id: &str) -> Result<Value> {
    let input: ClipRequest =
        serde_json::from_value(if params.is_null() { json!({}) } else { params })?;
    ensure!(
        matches!(input.seconds, None | Some(30 | 60)),
        "Invalid clip length."
    );
    let source = input.source.as_deref().unwrap_or("manual");
    ensure!(
        matches!(source, "manual" | "remote"),
        "Invalid clip caller."
    );
    let show = current_show(state).ok_or_else(|| anyhow::anyhow!("No room is open."))?;
    let request = input.request_id.as_deref().unwrap_or(rpc_id);
    ensure!(
        !request.is_empty() && request.len() <= 160,
        "Invalid request identity."
    );
    let operation = input
        .operation_id
        .unwrap_or_else(|| stable_operation(&[&show, source, request]));
    mark_clip(state, input.seconds, Some(operation), source).await
}
pub fn current_show(state: &AppState) -> Option<String> {
    match current_target(state)? {
        MarkTarget::CloudShow { show_id } => Some(show_id),
        _ => None,
    }
}
pub fn owns_show(state: &AppState, id: &str) -> bool {
    let s = crate::cloud_show_status(state);
    current_show(state).as_deref() == Some(id)
        && s.on_air.as_ref().is_none_or(|o| o.this_device)
        && crate::cloud_controller::ownership_allows(id)
        && !state.process_shutdown_requested()
}
pub fn stable_operation(parts: &[&str]) -> String {
    let digest = Sha256::digest(serde_json::to_vec(parts).expect("strings serialize"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
pub async fn request(
    _state: &AppState,
    show: &str,
    method: &str,
    id: Option<&str>,
    body: Option<Value>,
) -> Result<Value> {
    ensure!(
        show.starts_with("sh_")
            && show.len() <= 160
            && show.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'),
        "Invalid cloud show identity."
    );
    if let Some(id) = id {
        ensure!(
            uuid::Uuid::parse_str(id).is_ok(),
            "Invalid marker identity."
        );
    }
    let bearer = crate::account::stored_session_token()
        .ok_or_else(|| anyhow::anyhow!("Sign in to use show markers."))?;
    let result = crate::videorc_api::VideorcApiClient::new()?
        .show_marker_request(&bearer, show, method, id, body)
        .await?;
    Ok(result)
}
pub async fn create(
    state: &AppState,
    mut input: Create,
    source: &str,
    position: Option<SourcePosition>,
) -> Result<Value> {
    ensure!(
        matches!(source, "manual" | "voice" | "remote" | "agent"),
        "Invalid marker source."
    );
    ensure!(
        uuid::Uuid::parse_str(&input.operation_id)?.to_string() == input.operation_id,
        "Noncanonical marker operation."
    );
    input.label = crate::session_markers::normalize_label(input.label.as_deref())?;
    ensure!(
        input.kind == "marker" && input.lookback_seconds.is_none()
            || input.kind == "clip" && matches!(input.lookback_seconds, Some(30 | 60)),
        "Invalid marker kind or duration."
    );
    // Server performs authoritative replay-before-lifecycle admission. Local loss must still refuse new writes.
    ensure!(
        owns_show(state, &input.show_id),
        "This computer does not own the open show."
    );
    let mut body = json!({"operationId":input.operation_id,"kind":input.kind,"source":source});
    if let Some(label) = input.label {
        body["label"] = json!(label);
    }
    if let Some(seconds) = input.lookback_seconds {
        body["lookbackSeconds"] = json!(seconds);
    }
    if let Some(p) = position {
        ensure!(
            source == "voice"
                && p.offset_seconds.is_finite()
                && p.offset_seconds >= 0.0
                && p.uncertainty_ms.is_none(),
            "Unqualified source time."
        );
        body["sourcePosition"] = serde_json::to_value(p)?;
    }
    let mut mark = request(state, &input.show_id, "POST", None, Some(body)).await?;
    if input.kind == "clip" {
        if let Some(job) = crate::cloud_clips::maybe_save(state, &mark).await {
            mark["clipJob"] = job;
        }
    }
    state.emit_event("cloud.marker.created", mark.clone());
    Ok(mark)
}
pub fn clip_event(mark: &Value) -> Value {
    json!({"showId":mark["showId"],"markerId":mark["id"],"atSeconds":mark["atSeconds"],"source":if mark["source"]=="voice" {"voice"}else{"manual"},"saved":true,"reason":match mark.pointer("/clipJob/state").and_then(Value::as_str) {Some("complete")=>"cloud-clip-saved",Some("interrupted")=>"cloud-clip-interrupted",Some("downloading"|"trimming"|"publishing")=>"cloud-clip-queued",_=>"cloud-marker-no-media"}})
}
pub async fn mark_clip(
    state: &AppState,
    seconds: Option<u32>,
    operation: Option<String>,
    source: &str,
) -> Result<Value> {
    let show_id = current_show(state).ok_or_else(|| anyhow::anyhow!("No cloud room is open."))?;
    create(
        state,
        Create {
            show_id,
            operation_id: operation.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            label: None,
            kind: "clip".into(),
            lookback_seconds: Some(seconds.unwrap_or(30)),
        },
        source,
        None,
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_are_stable_and_distinct() {
        let a = stable_operation(&["show", "speech", "1"]);
        assert_eq!(a, stable_operation(&["show", "speech", "1"]));
        assert_ne!(a, stable_operation(&["show", "speech", "2"]));
        assert_ne!(a, stable_operation(&["other", "speech", "1"]));
        assert!(uuid::Uuid::parse_str(&a).is_ok());
    }
    #[test]
    fn cloud_target_has_no_native_session() {
        let v = serde_json::to_value(MarkTarget::CloudShow {
            show_id: "sh_a".into(),
        })
        .unwrap();
        assert_eq!(v, json!({"kind":"cloud-show","showId":"sh_a"}));
    }
}

/// Narrow agent projection. It is not a native session, file or qualified media range.
pub fn agent_projection(mark: &Value, clip: bool) -> Value {
    let mut v = json!({"markerId":mark["id"],"showId":mark["showId"],"atSeconds":mark["atSeconds"],"mediaAvailable":false});
    if clip {
        v["clip"] = json!(false);
        v["marked"] = json!(true);
        v["seconds"] = mark["lookbackSeconds"].clone();
    }
    if let Some(job) = mark.get("clipJob") {
        v["clipJobId"] = job["id"].clone();
        v["clipState"] = job["state"].clone();
        if job["state"] == "complete" {
            v["mediaAvailable"] = json!(true);
            v["clip"] = json!(true);
            v["localSessionId"] = job["localSessionId"].clone();
        }
    }
    v
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub show_id: String,
    pub marker_id: Option<String>,
}
