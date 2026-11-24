//! Plan 260 S1.8b: the program pages' and guests' capability receipts
//! (plan 249 S3, `videorc.media-capability.v2`), read by the backend once it
//! holds the host seat (`room_host`). The renderer's `room-media-v2.ts` with
//! the capability parsers of `cloud-avatar.ts`, `cloud-scene.ts`,
//! `cloud-html-layer.ts`, in Rust: the same refusals, the same lanes.
//!
//! A receipt is accepted only when the server relays it (a participant
//! cannot send one in another's name), and only within its size bound. Every
//! presentation topic (graphics, avatar, scene, HTML layers) is sent only to
//! a consumer whose fresh receipt says it draws that lane; LiveKit leaves the
//! hidden `EG_` program pages out of the participant list, so they are known
//! by their receipt alone.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value};

pub(crate) const CAPABILITY_TOPIC: &str = "videorc.media-capability.v2";
/// A receipt stays current this long.
pub(crate) const CAPABILITY_TTL_MS: i64 = 25_000;
/// A relayed receipt's byte bound (plan 249 S11).
pub(crate) const CAPABILITY_RECEIPT_MAX_BYTES: usize = 2048;

/// The background's still reasons (`BACKGROUND_STILL_REASONS`).
const BACKGROUND_STILL_REASONS: [&str; 7] = [
    "no-webgl2",
    "shader-compile-failed",
    "context-lost",
    "gpu-budget",
    "unknown-look",
    "asset-missing",
    "asset-invalid",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Applied {
    #[serde(rename = "publisherSid")]
    pub publisher_sid: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct StaticCapability {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captions: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refs: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<Applied>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct AvatarCapability {
    pub version: u8,
    pub output: String,
    pub orientation: String,
    #[serde(rename = "static", skip_serializing_if = "Option::is_none")]
    pub static_layer: Option<StaticCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<Applied>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refs: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct BackgroundDrawn {
    pub key: String,
    pub rendering: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct BackgroundCapability {
    pub version: u8,
    pub live: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drawn: Option<BackgroundDrawn>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct SceneCapability {
    pub version: u8,
    pub output: String,
    pub orientation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<Applied>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<BackgroundCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct HtmlApplied {
    #[serde(rename = "publisherSid")]
    pub publisher_sid: String,
    #[serde(rename = "trackSid")]
    pub track_sid: String,
    pub generation: u64,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct HtmlLayerCapability {
    pub version: u8,
    pub output: String,
    pub orientation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<HtmlApplied>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct AuxiliaryReport {
    #[serde(rename = "trackSid")]
    pub track_sid: String,
    pub rms: f64,
    #[serde(rename = "observedAt")]
    pub observed_at: u64,
}

/// `ConsumerCapability`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ConsumerCapability {
    pub v: u8,
    pub identity: String,
    #[serde(rename = "participantSid")]
    pub participant_sid: String,
    #[serde(rename = "audioRouting", skip_serializing_if = "Option::is_none")]
    pub audio_routing: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graphics: Option<AvatarCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<SceneCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<HtmlLayerCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auxiliary: Option<AuxiliaryReport>,
}

/// A receipt and when it arrived (ms since the epoch).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CapabilityReceipt {
    pub capability: ConsumerCapability,
    pub at: i64,
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `^PREFIX_[A-Za-z0-9]{1,64}$`.
fn sid_with(value: &Value, prefix: &str) -> Option<String> {
    let text = value.as_str()?;
    let rest = text.strip_prefix(prefix)?.strip_prefix('_')?;
    (!rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
        .then(|| text.to_string())
}

fn sid(value: &Value) -> Option<String> {
    sid_with(value, "PA")
}

/// A safe integer at least `min`.
fn count(value: &Value, min: u64) -> Option<u64> {
    const MAX_SAFE: u64 = (1 << 53) - 1;
    let number = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.fract() == 0.0 && *f >= 0.0)
            .map(|f| f as u64)
    })?;
    (number >= min && number <= MAX_SAFE).then_some(number)
}

fn positive(value: &Value) -> Option<u64> {
    count(value, 1)
}

/// The JavaScript `=== 1` on a number field.
fn is_one(value: &Value) -> bool {
    value.as_f64() == Some(1.0)
}

fn lane(output: &Value, orientation: &Value) -> Option<(String, String)> {
    let output = output
        .as_str()
        .filter(|o| *o == "stream" || *o == "recording")?;
    let orientation = orientation.as_str().filter(|o| *o == "h" || *o == "v")?;
    Some((output.to_string(), orientation.to_string()))
}

fn applied(value: &Value) -> Option<Applied> {
    let applied = object(value)?;
    Some(Applied {
        publisher_sid: sid(applied.get("publisherSid")?)?,
        revision: positive(applied.get("revision")?)?,
    })
}

/// An optional `1` flag: absent, or exactly 1; anything else refuses.
fn flag(fields: &Map<String, Value>, key: &str) -> Result<Option<u8>, ()> {
    match fields.get(key) {
        None => Ok(None),
        Some(value) if is_one(value) => Ok(Some(1)),
        Some(_) => Err(()),
    }
}

/// `parseStaticCapability`.
pub(crate) fn parse_static_capability(value: &Value) -> Option<StaticCapability> {
    let fields = object(value)?;
    if !is_one(fields.get("version")?) {
        return None;
    }
    let captions = flag(fields, "captions").ok()?;
    let refs = flag(fields, "refs").ok()?;
    let applied = match fields.get("applied") {
        None => None,
        Some(value) => Some(applied(value)?),
    };
    Some(StaticCapability {
        version: 1,
        captions,
        refs,
        applied,
    })
}

/// `parseAvatarCapability`.
pub(crate) fn parse_avatar_capability(value: &Value) -> Option<AvatarCapability> {
    let fields = object(value)?;
    if !is_one(fields.get("version")?) {
        return None;
    }
    let (output, orientation) = lane(fields.get("output")?, fields.get("orientation")?)?;
    let animation = flag(fields, "animation").ok()?;
    let refs = flag(fields, "refs").ok()?;
    let static_layer = match fields.get("static") {
        None => None,
        Some(value) => Some(parse_static_capability(value)?),
    };
    let applied = match fields.get("applied") {
        None => None,
        Some(value) => Some(applied(value)?),
    };
    Some(AvatarCapability {
        version: 1,
        output,
        orientation,
        static_layer,
        applied,
        animation,
        refs,
    })
}

/// `parseBackgroundCapability`.
pub(crate) fn parse_background_capability(value: &Value) -> Option<BackgroundCapability> {
    let fields = object(value)?;
    if !is_one(fields.get("version")?) {
        return None;
    }
    let live = match fields.get("live")?.as_f64() {
        Some(0.0) => 0,
        Some(1.0) => 1,
        _ => return None,
    };
    let drawn = match fields.get("drawn") {
        None => None,
        Some(value) => {
            let drawn = object(value)?;
            let key = drawn.get("key")?.as_str()?;
            let hex8 =
                key.len() == 8 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
            if key != "none" && !hex8 {
                return None;
            }
            let rendering = drawn.get("rendering")?.as_str()?;
            if !["picture", "shader", "half", "still", "none"].contains(&rendering) {
                return None;
            }
            let reason = match drawn.get("reason") {
                None => None,
                Some(reason) => {
                    let reason = reason.as_str()?;
                    if !BACKGROUND_STILL_REASONS.contains(&reason) {
                        return None;
                    }
                    Some(reason.to_string())
                }
            };
            Some(BackgroundDrawn {
                key: key.to_string(),
                rendering: rendering.to_string(),
                reason,
            })
        }
    };
    Some(BackgroundCapability {
        version: 1,
        live,
        drawn,
    })
}

/// `parseSceneCapability`.
pub(crate) fn parse_scene_capability(value: &Value) -> Option<SceneCapability> {
    let fields = object(value)?;
    if !is_one(fields.get("version")?) {
        return None;
    }
    let (output, orientation) = lane(fields.get("output")?, fields.get("orientation")?)?;
    let applied = match fields.get("applied") {
        None => None,
        Some(value) => Some(applied(value)?),
    };
    let background = match fields.get("background") {
        None => None,
        Some(value) => Some(parse_background_capability(value)?),
    };
    Some(SceneCapability {
        version: 1,
        output,
        orientation,
        applied,
        background,
    })
}

/// `parseHtmlLayerCapability`.
pub(crate) fn parse_html_layer_capability(value: &Value) -> Option<HtmlLayerCapability> {
    let fields = object(value)?;
    if !is_one(fields.get("version")?) {
        return None;
    }
    let (output, orientation) = lane(fields.get("output")?, fields.get("orientation")?)?;
    let applied = match fields.get("applied") {
        None => None,
        Some(value) => {
            let applied = object(value)?;
            Some(HtmlApplied {
                publisher_sid: sid_with(applied.get("publisherSid")?, "PA")?,
                track_sid: sid_with(applied.get("trackSid")?, "TR")?,
                generation: count(applied.get("generation")?, 1)?,
                revision: count(applied.get("revision")?, 1)?,
            })
        }
    };
    Some(HtmlLayerCapability {
        version: 1,
        output,
        orientation,
        applied,
    })
}

/// `graphicsLaneAllowed`: an egress takes its token's lane; a guest only the
/// landscape stream lane (plan 249 S6, D4).
pub(crate) fn graphics_lane_allowed(identity: &str, graphics: &AvatarCapability) -> bool {
    identity.starts_with("EG_")
        || (identity.starts_with("g_")
            && graphics.output == "stream"
            && graphics.orientation == "h")
}

/// `^(g_|EG_)[A-Za-z0-9_-]{1,128}$`.
fn consumer_identity(identity: &str) -> bool {
    let rest = identity
        .strip_prefix("g_")
        .or_else(|| identity.strip_prefix("EG_"));
    rest.is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 128
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// `parseConsumerCapability`.
pub(crate) fn parse_consumer_capability(value: &Value) -> Option<ConsumerCapability> {
    let fields = object(value)?;
    if fields.get("v")?.as_f64() != Some(2.0) {
        return None;
    }
    let identity = fields.get("identity")?.as_str()?;
    if !consumer_identity(identity) {
        return None;
    }
    let participant_sid = sid(fields.get("participantSid")?)?;
    let egress = identity.starts_with("EG_");
    let audio_routing = match fields.get("audioRouting") {
        None => None,
        Some(value) if is_one(value) && egress => Some(1),
        Some(_) => return None,
    };
    let graphics = match fields.get("graphics") {
        None => None,
        Some(value) => {
            let graphics = parse_avatar_capability(value)?;
            if !graphics_lane_allowed(identity, &graphics) {
                return None;
            }
            Some(graphics)
        }
    };
    let scene = match fields.get("scene") {
        None => None,
        Some(value) if egress => Some(parse_scene_capability(value)?),
        Some(_) => return None,
    };
    let html = match fields.get("html") {
        None => None,
        Some(value) if egress => Some(parse_html_layer_capability(value)?),
        Some(_) => return None,
    };
    let auxiliary = match fields.get("auxiliary") {
        None => None,
        Some(value) => {
            let aux = object(value)?;
            let rms = aux
                .get("rms")?
                .as_f64()
                .filter(|r| r.is_finite() && *r > 0.0 && *r <= 1.0)?;
            Some(AuxiliaryReport {
                track_sid: sid_with(aux.get("trackSid")?, "TR")?,
                rms,
                observed_at: positive(aux.get("observedAt")?)?,
            })
        }
    };
    Some(ConsumerCapability {
        v: 2,
        identity: identity.to_string(),
        participant_sid,
        audio_routing,
        graphics,
        scene,
        html,
        auxiliary,
    })
}

/// `capabilityCurrent`: this session's, not from the future, within the TTL.
pub(crate) fn capability_current(receipt: Option<&CapabilityReceipt>, sid: &str, now: i64) -> bool {
    receipt.is_some_and(|receipt| {
        receipt.capability.participant_sid == sid
            && receipt.at <= now + 1000
            && now - receipt.at < CAPABILITY_TTL_MS
    })
}

/// The receipts the host holds, by identity: the latest relayed one each.
#[derive(Debug, Default)]
pub(crate) struct CapabilityReceipts {
    receipts: HashMap<String, CapabilityReceipt>,
}

impl CapabilityReceipts {
    /// A relayed receipt (no sending participant: the server's). Returns the
    /// capability it carried, or None for one refused.
    pub(crate) fn received(
        &mut self,
        payload: &[u8],
        from_participant: bool,
        now: i64,
    ) -> Option<ConsumerCapability> {
        if from_participant || payload.len() > CAPABILITY_RECEIPT_MAX_BYTES {
            return None;
        }
        let value: Value = serde_json::from_slice(payload).ok()?;
        let capability = parse_consumer_capability(&value)?;
        self.receipts.insert(
            capability.identity.clone(),
            CapabilityReceipt {
                capability: capability.clone(),
                at: now,
            },
        );
        Some(capability)
    }

    pub(crate) fn get(&self, identity: &str) -> Option<&CapabilityReceipt> {
        self.receipts.get(identity)
    }

    /// `consumerSid`: the session a publisher may serve under `identity`, or
    /// None. A visible session wins; a hidden `EG_` page is known by its
    /// fresh receipt; a guest only while visible.
    pub(crate) fn consumer_sid(
        &self,
        visible: &HashMap<String, String>,
        identity: &str,
        now: i64,
    ) -> Option<String> {
        if let Some(sid) = visible.get(identity) {
            return Some(sid.clone());
        }
        let receipt = self.receipts.get(identity)?;
        (identity.starts_with("EG_")
            && capability_current(Some(receipt), &receipt.capability.participant_sid, now))
        .then(|| receipt.capability.participant_sid.clone())
    }

    /// `roomConsumers`: every visible participant, then each hidden `EG_`
    /// page with a fresh receipt. `(identity, sid)`.
    pub(crate) fn consumers(
        &self,
        visible: &HashMap<String, String>,
        now: i64,
    ) -> Vec<(String, String)> {
        let mut consumers: Vec<(String, String)> = visible
            .iter()
            .map(|(identity, sid)| (identity.clone(), sid.clone()))
            .collect();
        for identity in self.receipts.keys() {
            if !visible.contains_key(identity)
                && let Some(sid) = self.consumer_sid(visible, identity, now)
            {
                consumers.push((identity.clone(), sid));
            }
        }
        consumers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({
            "v": 2,
            "identity": "EG_program_wide",
            "participantSid": "PA_abc123",
            "graphics": { "version": 1, "output": "stream", "orientation": "h" }
        })
    }

    #[test]
    fn a_receipt_keeps_what_the_renderer_keeps() {
        let mut with_refs = base();
        with_refs["graphics"]["refs"] = json!(1);
        with_refs["graphics"]["static"] = json!({ "version": 1, "captions": 1, "refs": 1 });
        let parsed = parse_consumer_capability(&with_refs).unwrap();
        assert_eq!(
            serde_json::to_value(parsed.graphics.unwrap()).unwrap(),
            json!({
                "version": 1, "output": "stream", "orientation": "h",
                "static": { "version": 1, "captions": 1, "refs": 1 }, "refs": 1
            })
        );
        // `refs: 2` refuses the whole receipt.
        let mut wrong = base();
        wrong["graphics"]["refs"] = json!(2);
        assert!(parse_consumer_capability(&wrong).is_none());
        assert!(
            parse_consumer_capability(&base())
                .unwrap()
                .graphics
                .unwrap()
                .refs
                .is_none()
        );
    }

    #[test]
    fn guests_take_only_the_landscape_stream_lane_and_no_scene() {
        let mut guest = base();
        guest["identity"] = json!("g_ada");
        assert!(parse_consumer_capability(&guest).is_some());
        guest["graphics"]["orientation"] = json!("v");
        assert!(parse_consumer_capability(&guest).is_none());
        let mut guest_scene = base();
        guest_scene["identity"] = json!("g_ada");
        guest_scene["scene"] = json!({ "version": 1, "output": "stream", "orientation": "h" });
        assert!(parse_consumer_capability(&guest_scene).is_none());
        let mut guest_routing = base();
        guest_routing["identity"] = json!("g_ada");
        guest_routing["audioRouting"] = json!(1);
        assert!(parse_consumer_capability(&guest_routing).is_none());
        for identity in ["host:s", "guest-7", "EG_", "g_bad id"] {
            let mut other = base();
            other["identity"] = json!(identity);
            assert!(parse_consumer_capability(&other).is_none(), "{identity}");
        }
    }

    #[test]
    fn the_background_fixture_parses_as_in_typescript() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/cloud-parity-background.json"
        ))
        .unwrap();
        for valid in fixture["capability"]["valid"].as_array().unwrap() {
            let parsed = parse_background_capability(valid).expect("valid");
            assert_eq!(&serde_json::to_value(parsed).unwrap(), valid);
        }
        for invalid in fixture["capability"]["invalid"].as_array().unwrap() {
            assert!(parse_background_capability(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn html_and_auxiliary_reports_are_checked() {
        let mut html = base();
        html["html"] = json!({
            "version": 1, "output": "recording", "orientation": "v",
            "applied": { "publisherSid": "PA_x", "trackSid": "TR_y", "generation": 1, "revision": 3 }
        });
        assert!(
            parse_consumer_capability(&html)
                .unwrap()
                .html
                .unwrap()
                .applied
                .is_some()
        );
        html["html"]["applied"]["trackSid"] = json!("PA_y");
        assert!(parse_consumer_capability(&html).is_none());
        let mut aux = base();
        aux["auxiliary"] = json!({ "trackSid": "TR_a", "rms": 0.2, "observedAt": 5 });
        assert!(parse_consumer_capability(&aux).unwrap().auxiliary.is_some());
        aux["auxiliary"]["rms"] = json!(0);
        assert!(parse_consumer_capability(&aux).is_none());
    }

    #[test]
    fn receipts_are_relayed_bounded_and_fresh() {
        let mut receipts = CapabilityReceipts::default();
        let payload = serde_json::to_vec(&base()).unwrap();
        assert!(
            receipts.received(&payload, true, 1_000).is_none(),
            "a participant cannot send one"
        );
        assert!(
            receipts
                .received(&vec![b' '; CAPABILITY_RECEIPT_MAX_BYTES + 1], false, 1_000)
                .is_none()
        );
        assert!(receipts.received(&payload, false, 1_000).is_some());
        let visible = HashMap::new();
        // The hidden program page is a consumer while its receipt is fresh.
        assert_eq!(
            receipts.consumers(&visible, 2_000),
            vec![("EG_program_wide".to_string(), "PA_abc123".to_string())]
        );
        assert!(
            receipts
                .consumers(&visible, 1_000 + CAPABILITY_TTL_MS)
                .is_empty()
        );
        // A visible session wins.
        let visible = HashMap::from([("EG_program_wide".to_string(), "PA_new".to_string())]);
        assert_eq!(
            receipts
                .consumer_sid(&visible, "EG_program_wide", 2_000)
                .as_deref(),
            Some("PA_new")
        );
    }
}
