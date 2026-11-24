//! Plan 260 S1.8b: overlays on a managed talk show go from the backend
//! straight to the room (plan 234 T3, wire contract 6.3), once the backend
//! holds the host seat (`room_host`). Before S1.8 the backend handed each one
//! to the renderer (`cloud.room.overlay`), which fetched the bytes by id and
//! sent them (`lib/talk-show-overlays.ts`); this is that module, in Rust.
//!
//! A set is a byte stream on `videorc.overlay.set` with string attributes
//! (`v`, `slot`, `o`, the rect as six-place fractions, and `ttl` only when
//! timed), in 16 KiB writes; a clear is `videorc.overlay.clear` with the JSON
//! body `{ "v": 1, "slot", "o" }`. The page drops an image over 2 MiB or of
//! another type, so neither is sent. A write that takes over 5 s, or a set
//! over 90 s, is dropped before its last write: the declared length makes the
//! page refuse a short stream (S0.8). Nothing is remembered here: the backend
//! keeps what is up and hands the untimed overlays over again when the
//! connection comes back.

use std::collections::HashMap;
use std::time::Duration;

use livekit::data_stream::api::{StreamByteOptions, StreamWriter};
use livekit::prelude::LocalParticipant;
use serde_json::Value;

use crate::state::AppState;

pub(crate) const OVERLAY_SET_TOPIC: &str = "videorc.overlay.set";
pub(crate) const OVERLAY_CLEAR_TOPIC: &str = "videorc.overlay.clear";
/// On a byte stream every attribute is a string, so `v` is "1".
const OVERLAY_SET_VERSION: &str = "1";
/// The page drops an image over 2 MiB.
const OVERLAY_MAX_BYTES: usize = 2 * 1024 * 1024;
const OVERLAY_MIME_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];
const OVERLAY_CHUNK_BYTES: usize = 16 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(90);

/// What one hand-off came to, as the renderer's `OverlaySendResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverlaySent {
    Sent,
    /// The overlay came down before its bytes were read: nothing to send.
    Gone,
    /// The page would drop it (no bytes, over 2 MiB, not an image it takes).
    Refused,
}

/// `overlayFraction`: a plain decimal from 0 to 1 with six places (the page
/// refuses an exponent).
pub(crate) fn overlay_fraction(value: f64) -> String {
    let clamped = if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    };
    format!("{clamped:.6}")
}

/// `overlaySetAttributes`, from a `cloud.room.overlay` set event.
pub(crate) fn overlay_set_attributes(event: &Value) -> Option<HashMap<String, String>> {
    let text = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_string);
    let rect = event.get("rect")?;
    let fraction =
        |key: &str| overlay_fraction(rect.get(key).and_then(Value::as_f64).unwrap_or(0.0));
    let mut attributes = HashMap::from([
        ("v".to_string(), OVERLAY_SET_VERSION.to_string()),
        ("slot".to_string(), text("slot")?),
        ("o".to_string(), text("orientation")?),
        ("x".to_string(), fraction("x")),
        ("y".to_string(), fraction("y")),
        ("w".to_string(), fraction("w")),
        ("h".to_string(), fraction("h")),
    ]);
    if let Some(ttl) = event.get("ttlSeconds").and_then(Value::as_f64) {
        // A whole number of 1 or more.
        attributes.insert("ttl".to_string(), (ttl.round().max(1.0) as u64).to_string());
    }
    Some(attributes)
}

/// `overlayClearBody`.
pub(crate) fn overlay_clear_body(event: &Value) -> Option<Vec<u8>> {
    let slot = event.get("slot").and_then(Value::as_str)?;
    let orientation = event.get("orientation").and_then(Value::as_str)?;
    serde_json::to_vec(&serde_json::json!({ "v": 1, "slot": slot, "o": orientation })).ok()
}

/// The type the page takes for this set: the event's, else the stored
/// image's; None when neither is one it takes.
fn overlay_mime_type(event: &Value, stored: &str) -> Option<&'static str> {
    let declared = event.get("mimeType").and_then(Value::as_str);
    OVERLAY_MIME_TYPES
        .into_iter()
        .find(|kind| Some(*kind) == declared)
        .or_else(|| OVERLAY_MIME_TYPES.into_iter().find(|kind| *kind == stored))
}

/// Whether an overlay event is this room's: the show the backend holds.
pub(crate) fn overlay_is_for_show(event: &Value, show_id: &str) -> bool {
    event.get("showId").and_then(Value::as_str) == Some(show_id)
}

async fn bounded<T, E: std::fmt::Display>(
    work: impl std::future::Future<Output = Result<T, E>>,
) -> anyhow::Result<T> {
    match tokio::time::timeout(WRITE_TIMEOUT, work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(anyhow::anyhow!("{error}")),
        Err(_) => Err(anyhow::anyhow!("an overlay write took over 5 s")),
    }
}

/// One hand-off, sent on `local`.
pub(crate) async fn send_overlay(
    state: &AppState,
    local: &LocalParticipant,
    event: &Value,
) -> anyhow::Result<OverlaySent> {
    let op = event.get("op").and_then(Value::as_str);
    if op == Some("clear") {
        let Some(body) = overlay_clear_body(event) else {
            return Ok(OverlaySent::Refused);
        };
        let mut options = StreamByteOptions::new_with_topic(OVERLAY_CLEAR_TOPIC);
        options.mime_type = Some("application/json".to_string());
        options.total_length = Some(body.len() as u64);
        let writer = bounded(local.stream_bytes(options)).await?;
        bounded(writer.write(&body)).await?;
        bounded(writer.close()).await?;
        return Ok(OverlaySent::Sent);
    }
    let Some(image_id) = event.get("imageId").and_then(Value::as_str) else {
        return Ok(OverlaySent::Refused);
    };
    let Some((stored_type, bytes)) =
        crate::cloud_show::lock(&state.cloud_show).overlay_image(image_id)
    else {
        return Ok(OverlaySent::Gone);
    };
    let Some(mime_type) = overlay_mime_type(event, stored_type) else {
        return Ok(OverlaySent::Refused);
    };
    if bytes.is_empty() || bytes.len() > OVERLAY_MAX_BYTES {
        return Ok(OverlaySent::Refused);
    }
    let Some(attributes) = overlay_set_attributes(event) else {
        return Ok(OverlaySent::Refused);
    };
    let mut options = StreamByteOptions::new_with_topic(OVERLAY_SET_TOPIC);
    options.mime_type = Some(mime_type.to_string());
    options.total_length = Some(bytes.len() as u64);
    options.attributes = attributes;
    let upload = async {
        let writer = bounded(local.stream_bytes(options)).await?;
        for chunk in bytes.chunks(OVERLAY_CHUNK_BYTES) {
            bounded(writer.write(chunk)).await?;
        }
        bounded(writer.close()).await?;
        anyhow::Ok(OverlaySent::Sent)
    };
    match tokio::time::timeout(UPLOAD_TIMEOUT, upload).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!("an overlay took over 90 s to send")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ttl: Option<f64>) -> Value {
        let mut event = serde_json::json!({
            "op": "set",
            "showId": "show-1",
            "slot": "card",
            "orientation": "h",
            "rect": { "x": 0.02, "y": 0.6, "w": 0.3, "h": 0.0000001 },
            "mimeType": "image/png",
            "imageId": "img-1"
        });
        if let Some(ttl) = ttl {
            event["ttlSeconds"] = serde_json::json!(ttl);
        }
        event
    }

    // The cases of talk-show-overlays.test.ts.
    #[test]
    fn a_set_carries_string_attributes_with_plain_fractions() {
        let attributes = overlay_set_attributes(&set(None)).unwrap();
        assert_eq!(attributes["v"], "1");
        assert_eq!(attributes["slot"], "card");
        assert_eq!(attributes["o"], "h");
        assert_eq!(attributes["x"], "0.020000");
        // No exponent for a tiny number.
        assert_eq!(attributes["h"], "0.000000");
        assert!(!attributes.contains_key("ttl"));
        let timed = overlay_set_attributes(&set(Some(0.2))).unwrap();
        assert_eq!(timed["ttl"], "1");
        assert_eq!(overlay_fraction(f64::NAN), "0.000000");
        assert_eq!(overlay_fraction(3.0), "1.000000");
    }

    #[test]
    fn a_clear_is_json_with_a_numeric_version() {
        let body = overlay_clear_body(&serde_json::json!({
            "op": "clear", "showId": "show-1", "slot": "hold", "orientation": "v"
        }))
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            serde_json::json!({ "v": 1, "slot": "hold", "o": "v" })
        );
    }

    #[test]
    fn only_the_types_the_page_takes_and_only_this_show() {
        assert_eq!(
            overlay_mime_type(&set(None), "image/gif"),
            Some("image/png")
        );
        let mut undeclared = set(None);
        undeclared["mimeType"] = serde_json::json!("image/gif");
        assert_eq!(
            overlay_mime_type(&undeclared, "image/webp"),
            Some("image/webp")
        );
        assert_eq!(overlay_mime_type(&undeclared, "image/gif"), None);
        assert!(overlay_is_for_show(&set(None), "show-1"));
        assert!(!overlay_is_for_show(&set(None), "show-2"));
    }
}
