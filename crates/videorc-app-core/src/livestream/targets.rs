//! The destinations as the capture config holds them (`streaming.targets`),
//! and the renderer's rules for them: `patchStreamTargetForEdit`,
//! `streamingWithTargetPatch`, `bridgeStreamingToLegacy`,
//! `applyStoredManualStreamKeyResult` (`lib/capture.ts`, use-studio),
//! `destinationSetup` (`lib/destination-readiness.ts`), `streamServerUrlIssue`,
//! `isStreamTargetReady`, and the stream quality (`lib/output-quality.ts`,
//! `stream-quality-control.tsx`).
//!
//! The config is the Studio's JSON (S3.0d keeps it as Electron's document),
//! so a patch is a list of fields to set or remove: `None` is the renderer's
//! `undefined`, which `JSON.stringify` drops.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::accounts::{AccountStatus, PlatformAccount, is_oauth_available, platform_label};
use super::copy;

/// One destination, as the page reads it (every field optional on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    pub id: String,
    pub platform: String,
    pub label: String,
    pub enabled: bool,
    pub server_url: String,
    pub url_mode: Option<String>,
    pub stream_key: String,
    pub stream_key_secret_ref: Option<String>,
    pub stream_key_present: bool,
    pub stream_key_hint: Option<String>,
    pub previous_stream_key_present: bool,
    pub previous_stream_key_hint: Option<String>,
    pub auth_mode: String,
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub output_preset: Option<String>,
    pub output_bitrate_kbps: Option<u32>,
    pub output_orientation: Option<String>,
    pub status: Option<TargetStatus>,
    pub scheduled_event_id: Option<String>,
    pub scheduled_event_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetStatus {
    pub state: String,
    pub message: Option<String>,
}

impl Target {
    pub fn full_url(&self) -> bool {
        self.url_mode.as_deref() == Some("full-url")
    }
    pub fn oauth(&self) -> bool {
        self.auth_mode == "oauth"
    }
    pub fn vertical(&self) -> bool {
        self.output_orientation.as_deref() == Some("vertical")
    }
    fn has_key(&self) -> bool {
        !self.stream_key.trim().is_empty()
            || self
                .stream_key_secret_ref
                .as_deref()
                .is_some_and(|r| !r.is_empty())
            || self.stream_key_present
    }
}

/// The streaming settings' targets, in the config's order.
pub fn targets(capture: &Value) -> Vec<Target> {
    capture
        .get("streaming")
        .and_then(|s| s.get("targets"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|t| serde_json::from_value(t.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// `streaming.defaultOutputPreset`.
pub fn default_output_preset(capture: &Value) -> String {
    capture
        .get("streaming")
        .and_then(|s| s.get("defaultOutputPreset"))
        .and_then(Value::as_str)
        .unwrap_or("tutorial-1080p30")
        .to_string()
}

/// The ids of the destinations that are on.
pub fn enabled_ids(targets: &[Target]) -> Vec<String> {
    targets
        .iter()
        .filter(|t| t.enabled)
        .map(|t| t.id.clone())
        .collect()
}

// --- Readiness ----------------------------------------------------------

/// `streamServerUrlIssue`: why a stream URL can't work, or `None` when it
/// can (or is still empty).
pub fn stream_server_url_issue(url: &str, full: bool) -> Option<&'static str> {
    let value = url.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("rtmp://")
        .or_else(|| lower.strip_prefix("rtmps://"));
    let Some(rest) = rest else {
        return Some(if full {
            copy::FULL_URLS_START
        } else {
            copy::SERVER_URLS_START
        });
    };
    // `new URL(value).hostname`: the authority up to the path, without
    // credentials and port.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = if host.starts_with('[') {
        host.split(']')
            .next()
            .unwrap_or_default()
            .trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or_default()
    };
    if host.is_empty() {
        Some(copy::ADD_SERVER_NAME)
    } else {
        None
    }
}

/// `isStreamTargetReady`.
pub fn is_stream_target_ready(target: &Target) -> bool {
    if target.full_url() {
        return !target.server_url.trim().is_empty()
            || target
                .stream_key_secret_ref
                .as_deref()
                .is_some_and(|r| !r.is_empty())
            || target.stream_key_present;
    }
    if target.server_url.trim().is_empty()
        || stream_server_url_issue(&target.server_url, false).is_some()
    {
        return false;
    }
    target.has_key()
}

/// `DestinationSetup`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setup {
    Ready,
    SignIn,
    Reconnect,
    StreamKey,
    ServerUrl,
    ServerUrlMissing,
}

/// `destinationSetup`: signed-in destinations need a connected account;
/// stream-key ones a saved key and a server.
pub fn destination_setup(target: &Target, account: Option<&PlatformAccount>) -> Setup {
    let sign_in =
        target.platform != "custom" && target.oauth() && is_oauth_available(&target.platform);
    if sign_in {
        return match account {
            None => Setup::SignIn,
            Some(account) if account.status == AccountStatus::Connected => Setup::Ready,
            Some(_) => Setup::Reconnect,
        };
    }
    if !target.full_url() && stream_server_url_issue(&target.server_url, false).is_some() {
        return Setup::ServerUrl;
    }
    if !target.full_url() && target.has_key() && target.server_url.trim().is_empty() {
        return Setup::ServerUrlMissing;
    }
    if is_stream_target_ready(target) {
        Setup::Ready
    } else {
        Setup::StreamKey
    }
}

/// `destinationSetupHint`.
pub fn setup_hint(setup: Setup) -> Option<&'static str> {
    match setup {
        Setup::Ready => None,
        Setup::SignIn => Some(copy::HINT_SIGN_IN),
        Setup::Reconnect => Some(copy::HINT_RECONNECT),
        Setup::StreamKey => Some(copy::HINT_STREAM_KEY),
        Setup::ServerUrl => Some(copy::HINT_SERVER_URL),
        Setup::ServerUrlMissing => Some(copy::HINT_SERVER_URL_MISSING),
    }
}

// --- Stream quality -----------------------------------------------------

/// The streaming presets the page offers (`streamQualityOptions`) and the
/// ones a destination may carry: (preset, width, height, fps, kbps).
const PRESETS: [(&str, u32, u32, u32, u32); 13] = [
    ("tutorial-540p30", 960, 540, 30, 2500),
    ("tutorial-720p30", 1280, 720, 30, 4000),
    ("tutorial-1080p30", 1920, 1080, 30, 6000),
    ("tutorial-1440p30", 2560, 1440, 30, 8000),
    ("record-4k30", 3840, 2160, 30, 30000),
    ("record-4k60-experimental", 3840, 2160, 60, 50000),
    ("stream-safe-1080p30", 1920, 1080, 30, 6000),
    ("stream-safe-1080p60", 1920, 1080, 60, 6000),
    ("stream-youtube-1080p30", 1920, 1080, 30, 10000),
    ("stream-youtube-1080p60", 1920, 1080, 60, 12000),
    ("stream-youtube-4k30", 3840, 2160, 30, 30000),
    ("stream-1080p60", 1920, 1080, 60, 9000),
    // The Vertical scene's portrait canvas (`VIDEO_PRESETS`).
    ("vertical-1080x1920", 1080, 1920, 30, 9000),
];

/// A preset's (width, height, fps, kbps), for the output plan.
pub fn preset_spec(name: &str) -> Option<(u32, u32, u32, u32)> {
    preset(name)
}

fn preset(name: &str) -> Option<(u32, u32, u32, u32)> {
    PRESETS
        .iter()
        .find(|(preset, ..)| *preset == name)
        .map(|(_, w, h, fps, kbps)| (*w, *h, *fps, *kbps))
}

/// `formatVideoQuality(video)`: "1080p · 30 fps"; a portrait canvas keeps
/// both sides.
pub fn format_quality(width: u32, height: u32, fps: u32) -> String {
    super::on_air::format_video_quality(width, height, fps)
}

/// `formatBitrate(kbps)`: "6 Mbps", "4.5 Mbps".
pub fn format_bitrate(kbps: u32) -> String {
    let mbps = (f64::from(kbps) / 100.0).round() / 10.0;
    if mbps.fract() == 0.0 {
        format!("{mbps:.0} Mbps")
    } else {
        format!("{mbps:.1} Mbps")
    }
}

/// `destinationQualityTag`: the quality a destination overrides the
/// default with; `None` when it uses the default.
pub fn destination_quality_tag(target: &Target) -> Option<String> {
    if let Some((w, h, fps, _)) = target.output_preset.as_deref().and_then(preset) {
        return Some(format_quality(w, h, fps));
    }
    target
        .output_bitrate_kbps
        .filter(|kbps| *kbps > 0)
        .map(format_bitrate)
}

/// One segment of the Stream quality control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityOption {
    /// The preset, or `default` (a destination's "Use default").
    pub value: String,
    pub label: String,
}

/// `StreamQualityControl`'s view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityView {
    pub options: Vec<QualityOption>,
    /// The selected segment, or -1 for a custom profile.
    pub selected: i32,
    pub description: String,
}

/// `StreamQualityControl({value, youtube, inherit})`.
pub fn quality_view(value: &str, youtube: bool, inherit: bool) -> QualityView {
    let mut options = Vec::new();
    if inherit {
        options.push(QualityOption {
            value: "default".into(),
            label: copy::USE_DEFAULT.into(),
        });
    }
    for (name, prefix) in [
        ("stream-safe-1080p30", ""),
        ("stream-safe-1080p60", ""),
        ("stream-youtube-4k30", "YouTube · "),
    ] {
        if name == "stream-youtube-4k30" && !youtube {
            continue;
        }
        let (w, h, fps, _) = preset(name).expect("a known preset");
        options.push(QualityOption {
            value: name.into(),
            label: format!("{prefix}{}", format_quality(w, h, fps)),
        });
    }
    // The untouched default (`tutorial-1080p30`) shows as 1080p30.
    let selected_value = if value == "tutorial-1080p30" {
        "stream-safe-1080p30"
    } else {
        value
    };
    let selected = options
        .iter()
        .position(|option| option.value == selected_value)
        .map_or(-1, |i| i as i32);
    let custom = selected_value != "default" && selected < 0;
    let mut description = String::new();
    if custom {
        description.push_str(copy::CUSTOM_PROFILE);
    }
    description.push_str(if value == "stream-youtube-4k30" {
        copy::QUALITY_4K_NOTE
    } else {
        copy::QUALITY_NOTE
    });
    QualityView {
        options,
        selected,
        description,
    }
}

// --- Patches ------------------------------------------------------------

/// A `Partial<StreamTargetSettings>`: each field set, or removed (`None`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TargetPatch(pub Vec<(&'static str, Option<Value>)>);

impl TargetPatch {
    pub fn set(mut self, key: &'static str, value: Value) -> Self {
        self.0.push((key, Some(value)));
        self
    }
    pub fn unset(mut self, key: &'static str) -> Self {
        self.0.push((key, None));
        self
    }
    fn get(&self, key: &str) -> Option<&Option<Value>> {
        self.0.iter().rev().find(|(k, _)| *k == key).map(|(_, v)| v)
    }
    /// `streamQualityOverride(preset)`.
    pub fn quality(value: &str) -> Self {
        match preset(value) {
            Some((.., kbps)) if value != "default" => TargetPatch::default()
                .set("outputPreset", json!(value))
                .set("outputBitrateKbps", json!(kbps)),
            _ => TargetPatch::default()
                .unset("outputPreset")
                .unset("outputBitrateKbps"),
        }
    }
    /// The scheduled event let go (`Use instant broadcast`).
    pub fn instant_broadcast() -> Self {
        TargetPatch::default()
            .unset("scheduledEventId")
            .unset("scheduledEventTitle")
            .unset("scheduledPrivacy")
            .unset("scheduledStartUtc")
    }
}

const SCHEDULED_FIELDS: [&str; 5] = [
    "scheduledEventId",
    "scheduledAttemptId",
    "scheduledEventTitle",
    "scheduledStartUtc",
    "scheduledPrivacy",
];

fn text<'a>(target: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    target.get(key).and_then(Value::as_str)
}

fn not_configured() -> Value {
    json!({ "state": "not-configured" })
}

/// `removeUnavailableOAuthState`.
fn remove_unavailable_oauth_state(target: &mut Map<String, Value>) {
    let platform = text(target, "platform").unwrap_or_default().to_string();
    if text(target, "authMode") != Some("oauth") || is_oauth_available(&platform) {
        return;
    }
    target.insert("authMode".into(), json!("manual-rtmp"));
    target.insert("streamKey".into(), json!(""));
    target.remove("streamKeySecretRef");
    target.insert("streamKeyPresent".into(), json!(false));
    for key in [
        "accountId",
        "accountLabel",
        "platformBroadcastId",
        "platformStreamId",
    ] {
        target.remove(key);
    }
    for key in SCHEDULED_FIELDS {
        target.remove(key);
    }
    target.insert("status".into(), not_configured());
}

/// `patchStreamTargetForEdit`.
pub fn patch_stream_target_for_edit(
    target: &Map<String, Value>,
    patch: &TargetPatch,
    now: &str,
) -> Map<String, Value> {
    let platform = text(target, "platform").unwrap_or_default().to_string();
    let mut next = target.clone();
    for (key, value) in &patch.0 {
        if *key == "authMode" {
            continue;
        }
        match value {
            Some(value) => {
                next.insert((*key).to_string(), value.clone());
            }
            None => {
                next.remove(*key);
            }
        }
    }
    let requested = patch
        .get("authMode")
        .and_then(|v| v.as_ref())
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(mode) = &requested
        && (mode != "oauth" || is_oauth_available(&platform))
    {
        next.insert("authMode".into(), json!(mode));
    }
    next.insert("updatedAt".into(), json!(now));
    if let Some(Some(Value::String(key))) = patch.get("streamKey") {
        next.insert("streamKeyPresent".into(), json!(!key.trim().is_empty()));
    }
    if requested.is_some() && next.get("authMode") != target.get("authMode") {
        next.insert("streamKey".into(), json!(""));
        next.remove("streamKeySecretRef");
        next.insert("streamKeyPresent".into(), json!(false));
        next.remove("platformBroadcastId");
        next.remove("platformStreamId");
        next.insert("status".into(), not_configured());
        if text(&next, "authMode") == Some("oauth") {
            for key in ["accountId", "accountLabel"] {
                match target.get(key) {
                    Some(value) => {
                        next.insert(key.into(), value.clone());
                    }
                    None => {
                        next.remove(key);
                    }
                }
            }
        } else {
            next.remove("accountId");
            next.remove("accountLabel");
        }
    }
    if text(&next, "authMode") != Some("oauth")
        || (platform != "youtube" && platform != "x")
        || next.get("accountId") != target.get("accountId")
    {
        for key in SCHEDULED_FIELDS {
            next.remove(key);
        }
    }
    if let Some(event) = patch.get("scheduledEventId")
        && event.as_ref() != target.get("scheduledEventId")
    {
        next.remove("platformBroadcastId");
        next.remove("platformStreamId");
        next.remove("streamKeySecretRef");
        next.insert("streamKeyPresent".into(), json!(false));
        next.remove("scheduledAttemptId");
    }
    if let Some(Some(Value::String(mode))) = patch.get("urlMode")
        && Some(mode.as_str()) != text(target, "urlMode")
    {
        let server = if mode == "full-url" || platform == "custom" {
            String::new()
        } else {
            text(target, "serverUrl").unwrap_or_default().to_string()
        };
        next.insert("serverUrl".into(), json!(server));
        next.insert("streamKey".into(), json!(""));
        next.remove("streamKeySecretRef");
        next.insert("streamKeyPresent".into(), json!(false));
        next.insert("status".into(), not_configured());
    }
    remove_unavailable_oauth_state(&mut next);
    next
}

fn targets_mut(config: &mut Value) -> Option<&mut Vec<Value>> {
    config
        .get_mut("streaming")?
        .get_mut("targets")?
        .as_array_mut()
}

/// `streamingWithTargetPatch` then `bridgeStreamingToLegacy`: the patched
/// destination, and the streaming switch and mode it implies.
pub fn patch_target(config: &mut Value, target_id: &str, patch: &TargetPatch, now: &str) {
    if let Some(list) = targets_mut(config) {
        for target in list.iter_mut() {
            if let Value::Object(map) = target
                && text(map, "id") == Some(target_id)
            {
                *map = patch_stream_target_for_edit(map, patch, now);
            }
        }
    }
    refresh_enabled(config);
    bridge_streaming_to_legacy(config);
}

/// The target patched as `patchPreparedStreamTarget` does: the fields, and
/// `updatedAt`, nothing else.
fn patch_prepared(config: &mut Value, target_id: &str, patch: &TargetPatch, now: &str) {
    if let Some(list) = targets_mut(config) {
        for target in list.iter_mut() {
            if let Value::Object(map) = target
                && text(map, "id") == Some(target_id)
            {
                for (key, value) in &patch.0 {
                    match value {
                        Some(value) => {
                            map.insert((*key).to_string(), value.clone());
                        }
                        None => {
                            map.remove(*key);
                        }
                    }
                }
                map.insert("updatedAt".into(), json!(now));
            }
        }
    }
}

/// `enabled`, `mode` and `enabledTargetIds` from the targets.
fn refresh_enabled(config: &mut Value) {
    let ids: Vec<Value> = targets(config)
        .into_iter()
        .filter(|t| t.enabled)
        .map(|t| json!(t.id))
        .collect();
    if let Some(Value::Object(streaming)) = config.get_mut("streaming") {
        streaming.insert("enabled".into(), json!(!ids.is_empty()));
        streaming.insert(
            "mode".into(),
            json!(if ids.len() > 1 { "multi" } else { "single" }),
        );
        streaming.insert("enabledTargetIds".into(), Value::Array(ids));
    }
}

/// `isStreamTargetStartReady`.
fn is_start_ready(target: &Target) -> bool {
    if target.oauth() {
        is_oauth_available(&target.platform)
    } else {
        is_stream_target_ready(target)
    }
}

/// `bridgeStreamingToLegacy`: the one-destination fields older builds read.
pub fn bridge_streaming_to_legacy(config: &mut Value) {
    let enabled = config
        .get("streaming")
        .and_then(|s| s.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let list = targets(config);
    let primary = enabled
        .then(|| {
            list.iter()
                .find(|t| t.enabled && is_start_ready(t))
                .or_else(|| {
                    list.iter()
                        .find(|t| t.enabled && !(t.oauth() && !is_oauth_available(&t.platform)))
                })
        })
        .flatten()
        .cloned();
    let Value::Object(map) = config else {
        return;
    };
    match primary {
        Some(primary) => {
            let preset = match primary.platform.as_str() {
                "facebook" | "tiktok" | "instagram" => "custom",
                other => other,
            };
            map.insert("streamEnabled".into(), json!(true));
            map.insert("rtmpPreset".into(), json!(preset));
            map.insert("rtmpServerUrl".into(), json!(primary.server_url));
            map.insert("streamKey".into(), json!(primary.stream_key));
        }
        None => {
            map.insert("streamEnabled".into(), json!(false));
        }
    }
}

/// `applyStoredManualStreamKeyResult`.
pub fn apply_stored_key(
    config: &mut Value,
    target_id: &str,
    result: &super::accounts::StoredKey,
    now: &str,
) {
    let full = targets(config)
        .into_iter()
        .find(|t| t.id == target_id)
        .map(|t| (t.full_url(), t.server_url));
    let server = match &full {
        Some((true, _)) => String::new(),
        Some((false, url)) => url.clone(),
        None => String::new(),
    };
    let opt = |value: &Option<String>| value.as_ref().map(|v| json!(v));
    let patch = TargetPatch(vec![
        ("serverUrl", Some(json!(server))),
        ("streamKey", Some(json!(""))),
        ("streamKeySecretRef", opt(&result.stream_key_secret_ref)),
        ("streamKeyPresent", Some(json!(result.stream_key_present))),
        ("streamKeyHint", opt(&result.stream_key_hint)),
        (
            "previousStreamKeyPresent",
            Some(json!(result.previous_stream_key_present)),
        ),
        (
            "previousStreamKeyHint",
            opt(&result.previous_stream_key_hint),
        ),
    ]);
    patch_prepared(config, target_id, &patch, now);
    bridge_streaming_to_legacy(config);
}

/// `disconnectPlatformAccount`'s config edit: the platform's destinations
/// lose the account and what it prepared.
pub fn forget_account(config: &mut Value, platform: &str) {
    if let Some(list) = targets_mut(config) {
        for target in list.iter_mut() {
            if let Value::Object(map) = target
                && text(map, "platform") == Some(platform)
            {
                for key in [
                    "accountId",
                    "accountLabel",
                    "streamKeySecretRef",
                    "platformBroadcastId",
                    "platformStreamId",
                ] {
                    map.remove(key);
                }
            }
        }
    }
    bridge_streaming_to_legacy(config);
}

/// `selectYouTubeChannel`'s config edit: every YouTube destination takes
/// the channel; one that changed account loses what it had prepared.
pub fn take_youtube_channel(config: &mut Value, selected: &PlatformAccount) {
    if let Some(list) = targets_mut(config) {
        for target in list.iter_mut() {
            if let Value::Object(map) = target
                && text(map, "platform") == Some("youtube")
            {
                let same = text(map, "accountId") == Some(selected.account_id.as_str());
                map.insert("accountId".into(), json!(selected.account_id));
                map.insert("accountLabel".into(), json!(selected.account_label));
                if !same {
                    for key in [
                        "streamKeySecretRef",
                        "platformBroadcastId",
                        "platformStreamId",
                        "status",
                    ] {
                        map.remove(key);
                    }
                    map.insert("streamKeyPresent".into(), json!(false));
                }
            }
        }
    }
    bridge_streaming_to_legacy(config);
}

/// `withStreamQuality`: the default quality and its bitrate.
pub fn set_stream_quality(config: &mut Value, preset_name: &str) {
    let Some((.., kbps)) = preset(preset_name) else {
        return;
    };
    if let Some(Value::Object(streaming)) = config.get_mut("streaming") {
        streaming.insert("defaultOutputPreset".into(), json!(preset_name));
        streaming.insert("defaultBitrateKbps".into(), json!(kbps));
    }
}

/// `sharedAccountLabel`: YouTube Vertical signs in with YouTube's account;
/// when the horizontal card signs in too, the channel and Disconnect live
/// there.
pub fn shared_account_label(targets: &[Target], target: &Target) -> Option<String> {
    if !target.vertical() || !target.oauth() {
        return None;
    }
    targets
        .iter()
        .find(|c| c.platform == target.platform && c.id != target.id && !c.vertical() && c.oauth())
        .map(|owner| owner.label.clone())
}

/// `manualKeyGuidance`: the copy, and the link's label and URL.
pub fn manual_key_guidance(platform: &str) -> (&'static str, Option<(&'static str, &'static str)>) {
    match platform {
        "youtube" => (
            copy::GUIDANCE_YOUTUBE,
            Some((copy::GUIDANCE_YOUTUBE_LINK, copy::YOUTUBE_STREAM_KEY_URL)),
        ),
        "twitch" => (
            copy::GUIDANCE_TWITCH,
            Some((copy::GUIDANCE_TWITCH_LINK, copy::GUIDANCE_TWITCH_URL)),
        ),
        "kick" => (
            copy::GUIDANCE_KICK,
            Some((copy::GUIDANCE_KICK_LINK, copy::GUIDANCE_KICK_URL)),
        ),
        "x" => (
            copy::GUIDANCE_X,
            Some((copy::GUIDANCE_X_LINK, copy::GUIDANCE_X_URL)),
        ),
        "tiktok" => (
            copy::GUIDANCE_TIKTOK,
            Some((copy::GUIDANCE_TIKTOK_LINK, copy::GUIDANCE_TIKTOK_URL)),
        ),
        "instagram" => (
            copy::GUIDANCE_INSTAGRAM,
            Some((
                copy::GUIDANCE_LIVE_PRODUCER_LINK,
                copy::GUIDANCE_INSTAGRAM_URL,
            )),
        ),
        "facebook" => (
            copy::GUIDANCE_FACEBOOK,
            Some((
                copy::GUIDANCE_LIVE_PRODUCER_LINK,
                copy::FACEBOOK_LIVE_PRODUCER_URL,
            )),
        ),
        _ => (copy::GUIDANCE_CUSTOM, None),
    }
}

/// The platform's name in the card's sentences.
pub fn platform_name(platform: &str) -> &'static str {
    platform_label(platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Value {
        crate::studio::capture_config::default_capture_config("2026-11-11T00:00:00.000Z")
    }

    fn target(config: &Value, id: &str) -> Target {
        targets(config).into_iter().find(|t| t.id == id).unwrap()
    }

    #[test]
    fn the_nine_built_in_destinations_read_from_the_config() {
        let list = targets(&config());
        let ids: Vec<&str> = list.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "youtube",
                "twitch",
                "kick",
                "x",
                "facebook",
                "youtube-vertical",
                "tiktok",
                "instagram",
                "custom"
            ]
        );
        assert!(list[5].vertical());
    }

    #[test]
    fn server_urls_must_be_rtmp_with_a_host() {
        assert_eq!(stream_server_url_issue("", false), None);
        assert_eq!(
            stream_server_url_issue("https://x", false),
            Some("Server URLs start with rtmp:// or rtmps://.")
        );
        assert_eq!(
            stream_server_url_issue("http://x", true),
            Some("Full URLs start with rtmp:// or rtmps://.")
        );
        assert_eq!(
            stream_server_url_issue("rtmp://", false),
            Some("Add the server name after rtmp://, as your platform shows it.")
        );
        assert_eq!(
            stream_server_url_issue("RTMPS://live.example:443/app", false),
            None
        );
    }

    #[test]
    fn enabling_a_destination_turns_streaming_on_and_bridges_the_legacy_fields() {
        let mut config = config();
        patch_target(
            &mut config,
            "twitch",
            &TargetPatch::default().set("enabled", json!(true)),
            "now",
        );
        assert_eq!(config["streaming"]["enabled"], json!(true));
        assert_eq!(config["streaming"]["mode"], json!("single"));
        assert_eq!(config["streaming"]["enabledTargetIds"], json!(["twitch"]));
        assert_eq!(config["streamEnabled"], json!(true));
        assert_eq!(config["rtmpPreset"], json!("twitch"));
        patch_target(
            &mut config,
            "kick",
            &TargetPatch::default().set("enabled", json!(true)),
            "now",
        );
        assert_eq!(config["streaming"]["mode"], json!("multi"));
        patch_target(
            &mut config,
            "twitch",
            &TargetPatch::default().set("enabled", json!(false)),
            "now",
        );
        patch_target(
            &mut config,
            "kick",
            &TargetPatch::default().set("enabled", json!(false)),
            "now",
        );
        assert_eq!(config["streamEnabled"], json!(false));
    }

    #[test]
    fn a_new_auth_mode_drops_the_key_and_the_prepared_broadcast() {
        let mut config = config();
        let twitch = &mut config["streaming"]["targets"][1];
        twitch["streamKeySecretRef"] = json!("ref");
        twitch["streamKeyPresent"] = json!(true);
        twitch["platformBroadcastId"] = json!("b");
        twitch["accountId"] = json!("acct");
        patch_target(
            &mut config,
            "twitch",
            &TargetPatch::default().set("authMode", json!("oauth")),
            "now",
        );
        let raw = &config["streaming"]["targets"][1];
        assert_eq!(raw["authMode"], json!("oauth"));
        assert_eq!(raw["streamKeyPresent"], json!(false));
        assert!(raw.get("streamKeySecretRef").is_none());
        assert!(raw.get("platformBroadcastId").is_none());
        assert_eq!(raw["accountId"], json!("acct"));
        assert_eq!(raw["status"], json!({"state": "not-configured"}));
        // Facebook can't sign in: the patch keeps the stream key.
        patch_target(
            &mut config,
            "facebook",
            &TargetPatch::default().set("authMode", json!("oauth")),
            "now",
        );
        assert_eq!(target(&config, "facebook").auth_mode, "manual-rtmp");
    }

    #[test]
    fn full_url_mode_clears_the_server_and_the_key() {
        let mut config = config();
        config["streaming"]["targets"][8]["serverUrl"] = json!("rtmp://example/app");
        patch_target(
            &mut config,
            "custom",
            &TargetPatch::default().set("urlMode", json!("full-url")),
            "now",
        );
        let custom = target(&config, "custom");
        assert_eq!(custom.server_url, "");
        assert!(custom.full_url());
    }

    #[test]
    fn readiness_names_what_is_missing() {
        let mut t = Target {
            platform: "twitch".into(),
            auth_mode: "manual-rtmp".into(),
            server_url: "rtmp://live.twitch.tv/app".into(),
            ..Target::default()
        };
        assert_eq!(destination_setup(&t, None), Setup::StreamKey);
        t.stream_key_present = true;
        assert_eq!(destination_setup(&t, None), Setup::Ready);
        t.server_url = String::new();
        assert_eq!(destination_setup(&t, None), Setup::ServerUrlMissing);
        t.server_url = "http://bad".into();
        assert_eq!(destination_setup(&t, None), Setup::ServerUrl);
        t.auth_mode = "oauth".into();
        assert_eq!(destination_setup(&t, None), Setup::SignIn);
        let mut account = PlatformAccount::default();
        assert_eq!(destination_setup(&t, Some(&account)), Setup::Ready);
        account.status = AccountStatus::NeedsReconnect;
        assert_eq!(destination_setup(&t, Some(&account)), Setup::Reconnect);
        assert_eq!(
            setup_hint(Setup::SignIn),
            Some("sign in or add a stream key")
        );
    }

    #[test]
    fn the_quality_control_shows_the_untouched_default_as_1080p30() {
        let view = quality_view("tutorial-1080p30", false, false);
        let labels: Vec<&str> = view.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["1080p · 30 fps", "1080p · 60 fps"]);
        assert_eq!(view.selected, 0);
        let view = quality_view("stream-youtube-4k30", true, false);
        assert_eq!(view.options[2].label, "YouTube · 4K · 30 fps");
        assert_eq!(view.selected, 2);
        assert!(view.description.starts_with("4K needs normal latency"));
        let view = quality_view("default", false, true);
        assert_eq!(view.options[0].label, "Use default");
        assert_eq!(view.selected, 0);
        let view = quality_view("record-4k30", false, false);
        assert_eq!(view.selected, -1);
        assert!(
            view.description
                .starts_with("Using a saved custom profile. ")
        );
    }

    #[test]
    fn a_quality_override_names_itself_on_the_row() {
        let mut config = config();
        patch_target(
            &mut config,
            "kick",
            &TargetPatch::quality("stream-safe-1080p60"),
            "now",
        );
        let kick = target(&config, "kick");
        assert_eq!(kick.output_bitrate_kbps, Some(6000));
        assert_eq!(
            destination_quality_tag(&kick),
            Some("1080p · 60 fps".to_string())
        );
        patch_target(&mut config, "kick", &TargetPatch::quality("default"), "now");
        assert_eq!(destination_quality_tag(&target(&config, "kick")), None);
        patch_target(
            &mut config,
            "kick",
            &TargetPatch::quality("vertical-1080x1920"),
            "now",
        );
        assert_eq!(
            destination_quality_tag(&target(&config, "kick")),
            Some("1080 × 1920 · 30 fps".to_string()),
            "the Vertical scene's preset names its size, not its bitrate"
        );
        patch_target(&mut config, "kick", &TargetPatch::quality("default"), "now");
        assert_eq!(format_bitrate(4500), "4.5 Mbps");
        set_stream_quality(&mut config, "stream-safe-1080p60");
        assert_eq!(default_output_preset(&config), "stream-safe-1080p60");
        assert_eq!(config["streaming"]["defaultBitrateKbps"], json!(6000));
    }

    #[test]
    fn a_stored_key_shows_its_hint_and_never_the_key() {
        let mut config = config();
        config["streaming"]["targets"][1]["streamKey"] = json!("live_1_secret");
        apply_stored_key(
            &mut config,
            "twitch",
            &super::super::accounts::StoredKey {
                stream_key_secret_ref: Some("ref".into()),
                stream_key_present: true,
                stream_key_hint: Some("••••cret".into()),
                previous_stream_key_present: false,
                previous_stream_key_hint: None,
            },
            "now",
        );
        let twitch = target(&config, "twitch");
        assert_eq!(twitch.stream_key, "");
        assert!(twitch.stream_key_present);
        assert_eq!(twitch.stream_key_hint.as_deref(), Some("••••cret"));
    }

    #[test]
    fn the_vertical_youtube_shares_the_horizontal_account() {
        let mut config = config();
        config["streaming"]["targets"][0]["authMode"] = json!("oauth");
        config["streaming"]["targets"][5]["authMode"] = json!("oauth");
        let list = targets(&config);
        assert_eq!(
            shared_account_label(&list, &list[5]),
            Some("YouTube".to_string())
        );
        assert_eq!(shared_account_label(&list, &list[0]), None);
    }
}
