//! Remote control surface (issue #143 — Stream Deck et al).
//!
//! Security model: the surface is OFF by default. When enabled, a dedicated
//! token authenticates a third transport role (`BackendRole::Remote`) whose
//! method admission is a hard allowlist (`remote.describe`, `remote.intent`)
//! and whose event stream is locked to `remote.state`/`remote.ack`. The
//! backend validates and RELAYS intents; the renderer executes them through
//! the exact same code paths as the on-screen buttons — there is no second
//! way to start a session, and no validation bypass.
//!
//! Same-machine pairing uses a discovery file next to the app database
//! (mode 0600, deleted when disabled or at shutdown) — the Discord-IPC local
//! trust model. The token additionally lives in the secret store so it
//! survives restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::secrets;

pub const REMOTE_TOKEN_SECRET: &str = "remote-control.token";
pub const REMOTE_ENABLED_SECRET: &str = "remote-control.enabled";

/// Minimum spacing between accepted intents of the SAME kind. A deck key
/// bounce must not double-toggle recording.
pub const REMOTE_INTENT_DEBOUNCE: Duration = Duration::from_millis(150);
/// The sound bucket's own window (plan 189): a fast drummer still gets every
/// press, and a key bounce is far under it.
pub const REMOTE_SOUND_INTENT_DEBOUNCE: Duration = Duration::from_millis(80);

#[derive(Debug, Default)]
pub struct RemoteControlRuntime {
    pub enabled: bool,
    pub token: Option<String>,
    /// Renderer-published catalog (scenes, takeover assets, windows, mics)
    /// served to remote clients via `remote.describe`.
    pub describe: Option<serde_json::Value>,
    /// Renderer-published state projection (recording/live/mic/scene/
    /// takeover) — the ONLY state remote clients ever see.
    pub state: Option<serde_json::Value>,
    pub connected_clients: usize,
    last_intent_at: HashMap<String, Instant>,
    next_intent_sequence: u64,
}

pub type RemoteControlSlot = std::sync::Arc<StdMutex<RemoteControlRuntime>>;

/// Remote intents, exactly the issue-#143 surface. `kind` is the wire tag;
/// unknown kinds are rejected before any relay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteIntent {
    RecordStart,
    RecordStop,
    RecordToggle,
    StreamStart,
    StreamStop,
    MicMute,
    MicUnmute,
    MicToggle,
    /// System audio on/off (plan 069). On/Off is the mute: there is no
    /// separate system-audio mute.
    SystemAudioOn,
    SystemAudioOff,
    SystemAudioToggle,
    #[serde(rename_all = "camelCase")]
    SceneApply {
        #[serde(skip_serializing_if = "Option::is_none")]
        screen_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        layout_preset: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TakeoverShow {
        asset_id: String,
    },
    TakeoverHide,
    /// Banners (plan 186). Show and hide are explicit and idempotent; the
    /// toggle is for a single deck key. `bannerHide` without a `bannerId`
    /// hides every banner.
    #[serde(rename_all = "camelCase")]
    BannerShow {
        banner_id: String,
    },
    #[serde(rename_all = "camelCase")]
    BannerHide {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        banner_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    BannerToggle {
        banner_id: String,
    },
    /// Soundboard (plan 189). `soundPlay` has press semantics (the pad's
    /// mode decides: restart, start or stop); `soundStop` without a
    /// `soundId` stops every sound.
    #[serde(rename_all = "camelCase")]
    SoundPlay {
        sound_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SoundStop {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sound_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WindowFront {
        window: RemoteWindow,
    },
    /// Put a chat message on stream. EXPLICIT show — idempotent, never a
    /// toggle: a double tap on a phone must not flash the card off again.
    #[serde(rename_all = "camelCase")]
    CommentHighlight {
        message_id: String,
    },
    CommentHighlightClear,
    /// Save a clip (plan 068 D6; plan 181, the owner's redesign R4): the
    /// last N seconds whenever the ring holds frames, and a mark in the
    /// recording while one runs. Idempotent by time: the backend stamps the
    /// capture clock, never a toggle. Plan 199: `seconds` is 30 or 60; none
    /// is today's 30-second clip, so `{"kind":"clipMark"}` still parses.
    #[serde(rename_all = "camelCase")]
    ClipMark {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<u32>,
    },
}

/// Live-chat message ids are `{platform}:{providerMessageId}`; anything far
/// longer is not an id we minted.
pub const REMOTE_MESSAGE_ID_MAX_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteWindow {
    Notes,
    Comments,
    Preview,
}

impl RemoteIntent {
    /// Debounce bucket: toggles and their explicit forms share one bucket so
    /// a bouncing key cannot interleave `micMute` + `micToggle`.
    pub fn debounce_kind(&self) -> &'static str {
        match self {
            Self::RecordStart | Self::RecordStop | Self::RecordToggle => "record",
            Self::StreamStart | Self::StreamStop => "stream",
            Self::MicMute | Self::MicUnmute | Self::MicToggle => "mic",
            Self::SystemAudioOn | Self::SystemAudioOff | Self::SystemAudioToggle => "system-audio",
            Self::SceneApply { .. } => "scene",
            Self::TakeoverShow { .. } | Self::TakeoverHide => "takeover",
            // A banner key and a takeover key are two keys: a "Be right back"
            // tap must not swallow the "Follow me" tap beside it.
            Self::BannerShow { .. } | Self::BannerHide { .. } | Self::BannerToggle { .. } => {
                "banner"
            }
            // Its own bucket and its own, shorter window (plan 189).
            Self::SoundPlay { .. } | Self::SoundStop { .. } => "sound",
            Self::WindowFront { .. } => "window",
            Self::CommentHighlight { .. } | Self::CommentHighlightClear => "highlight",
            Self::ClipMark { .. } => "clip",
        }
    }

    /// The key `admit_intent` debounces on: the bucket, except that sounds
    /// debounce per sound (release test 147, plan 0004). A bounce is the same
    /// key repeating, so a second press of one sound inside the window is
    /// refused, while two different sound keys hit together both play. A
    /// `soundStop` for one sound shares that sound's key; stop-all has its own.
    pub fn debounce_key(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::SoundPlay { sound_id }
            | Self::SoundStop {
                sound_id: Some(sound_id),
            } => std::borrow::Cow::Owned(format!("sound:{sound_id}")),
            Self::SoundStop { sound_id: None } => std::borrow::Cow::Borrowed("sound:*"),
            _ => std::borrow::Cow::Borrowed(self.debounce_kind()),
        }
    }

    /// How long after an accepted intent the same bucket refuses another.
    pub fn debounce_window(&self) -> Duration {
        match self {
            Self::SoundPlay { .. } | Self::SoundStop { .. } => REMOTE_SOUND_INTENT_DEBOUNCE,
            _ => REMOTE_INTENT_DEBOUNCE,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::SceneApply {
                screen_id,
                layout_preset,
            } => {
                if screen_id.is_none() && layout_preset.is_none() {
                    return Err("sceneApply needs a screenId or a layoutPreset.".to_string());
                }
                Ok(())
            }
            Self::TakeoverShow { asset_id } if asset_id.trim().is_empty() => {
                Err("takeoverShow needs a non-empty assetId.".to_string())
            }
            Self::BannerShow { banner_id } if banner_id.trim().is_empty() => {
                Err("bannerShow needs a non-empty bannerId.".to_string())
            }
            Self::BannerToggle { banner_id } if banner_id.trim().is_empty() => {
                Err("bannerToggle needs a non-empty bannerId.".to_string())
            }
            Self::BannerHide {
                banner_id: Some(banner_id),
            } if banner_id.trim().is_empty() => {
                Err("bannerHide needs a non-empty bannerId, or none to hide all.".to_string())
            }
            Self::SoundPlay { sound_id } if sound_id.trim().is_empty() => {
                Err("soundPlay needs a non-empty soundId.".to_string())
            }
            Self::SoundStop {
                sound_id: Some(sound_id),
            } if sound_id.trim().is_empty() => {
                Err("soundStop needs a non-empty soundId, or none to stop all.".to_string())
            }
            Self::CommentHighlight { message_id }
                if message_id.trim().is_empty()
                    || message_id.len() > REMOTE_MESSAGE_ID_MAX_BYTES =>
            {
                Err("commentHighlight needs a valid messageId.".to_string())
            }
            Self::ClipMark {
                seconds: Some(seconds),
            } if !crate::replay_buffer::CLIP_LENGTHS.contains(seconds) => {
                Err(crate::replay_buffer::INVALID_CLIP_LENGTH_MESSAGE.to_string())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIntentTicket {
    pub intent_id: String,
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RemoteControlRuntime {
    pub fn load_from_secrets() -> Self {
        let enabled = secrets::try_get_secret(REMOTE_ENABLED_SECRET)
            .ok()
            .flatten()
            .as_deref()
            == Some("1");
        let token = secrets::try_get_secret(REMOTE_TOKEN_SECRET).ok().flatten();
        Self {
            // Enabled requires a token to exist — fail closed on partial state.
            enabled: enabled && token.is_some(),
            token,
            ..Self::default()
        }
    }

    /// Accept or debounce an intent. Returns a ticket; only accepted tickets
    /// are relayed to the renderer.
    pub fn admit_intent(&mut self, intent: &RemoteIntent, now: Instant) -> RemoteIntentTicket {
        let kind = intent.debounce_kind();
        let key = intent.debounce_key();
        let window = intent.debounce_window();
        if let Some(last) = self.last_intent_at.get(key.as_ref())
            && now.duration_since(*last) < window
        {
            return RemoteIntentTicket {
                intent_id: String::new(),
                accepted: false,
                message: Some(format!(
                    "Debounced: another {kind} intent arrived less than {}ms ago.",
                    window.as_millis()
                )),
            };
        }
        // Per-sound keys (`sound:<id>`) come from client-supplied ids: drop
        // every key whose window has passed, so the map holds only the keys
        // still debouncing however many ids a client sends (release test 147).
        let longest = REMOTE_INTENT_DEBOUNCE.max(REMOTE_SOUND_INTENT_DEBOUNCE);
        self.last_intent_at
            .retain(|_, at| now.saturating_duration_since(*at) < longest);
        self.last_intent_at.insert(key.into_owned(), now);
        self.next_intent_sequence += 1;
        RemoteIntentTicket {
            intent_id: format!("ri-{}", self.next_intent_sequence),
            accepted: true,
            message: None,
        }
    }
}

pub fn persist_enabled(enabled: bool, token: Option<&str>) -> Result<()> {
    if enabled {
        let token = token.context("Remote control cannot enable without a token")?;
        secrets::put_secrets(&[(REMOTE_ENABLED_SECRET, "1"), (REMOTE_TOKEN_SECRET, token)])
    } else {
        secrets::put_secret(REMOTE_ENABLED_SECRET, "0")
    }
}

pub fn generate_token() -> String {
    // Two UUIDs → 64 hex chars of entropy without a new dependency.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFile<'a> {
    host: &'a str,
    port: u16,
    token: &'a str,
    protocol: u32,
}

pub fn discovery_path(database_path: &Path) -> Option<PathBuf> {
    if database_path.to_string_lossy() == ":memory:" {
        return None;
    }
    Some(database_path.with_file_name("remote-control.json"))
}

/// Write the same-machine pairing file. Mode 0600: readable only by the
/// user's own processes — local software running as the user is trusted the
/// same way the Stream Deck app itself is.
pub fn write_discovery(path: &Path, host: &str, port: u16, token: &str) -> Result<()> {
    let body = serde_json::to_vec_pretty(&DiscoveryFile {
        host,
        port,
        token,
        protocol: 1,
    })?;
    // The file must be born 0600 — a create-then-chmod sequence leaves a
    // umask-dependent window where another local user could read the token.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("Could not write {}", path.display()))?;
        file.write_all(&body)
            .with_context(|| format!("Could not write {}", path.display()))?;
        // mode() only applies at creation; tighten a pre-existing file too.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not restrict permissions on {}", path.display()))?;
    }
    // Windows: %APPDATA% files inherit the user profile's private ACL.
    #[cfg(not(unix))]
    std::fs::write(path, body).with_context(|| format!("Could not write {}", path.display()))?;
    Ok(())
}

pub fn remove_discovery(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intents_round_trip_the_wire_tags() {
        let intent: RemoteIntent = serde_json::from_str(r#"{"kind":"recordToggle"}"#).unwrap();
        assert_eq!(intent, RemoteIntent::RecordToggle);
        let intent: RemoteIntent =
            serde_json::from_str(r#"{"kind":"sceneApply","screenId":"screen-1"}"#).unwrap();
        assert_eq!(
            intent,
            RemoteIntent::SceneApply {
                screen_id: Some("screen-1".to_string()),
                layout_preset: None
            }
        );
        let intent: RemoteIntent =
            serde_json::from_str(r#"{"kind":"windowFront","window":"notes"}"#).unwrap();
        assert_eq!(
            intent,
            RemoteIntent::WindowFront {
                window: RemoteWindow::Notes
            }
        );
        assert!(serde_json::from_str::<RemoteIntent>(r#"{"kind":"fsRead"}"#).is_err());
        let intent: RemoteIntent =
            serde_json::from_str(r#"{"kind":"commentHighlight","messageId":"youtube:abc"}"#)
                .unwrap();
        assert_eq!(
            intent,
            RemoteIntent::CommentHighlight {
                message_id: "youtube:abc".to_string()
            }
        );
        assert_eq!(
            serde_json::to_value(&intent).unwrap(),
            serde_json::json!({ "kind": "commentHighlight", "messageId": "youtube:abc" })
        );
        assert_eq!(
            serde_json::from_str::<RemoteIntent>(r#"{"kind":"commentHighlightClear"}"#).unwrap(),
            RemoteIntent::CommentHighlightClear
        );
        // Plan 199: no length is today's 30-second clip, and it never rides
        // the wire as null.
        let intent = serde_json::from_str::<RemoteIntent>(r#"{"kind":"clipMark"}"#).unwrap();
        assert_eq!(intent, RemoteIntent::ClipMark { seconds: None });
        assert!(intent.validate().is_ok());
        assert_eq!(intent.debounce_kind(), "clip");
        assert_eq!(
            serde_json::to_value(&intent).unwrap(),
            serde_json::json!({ "kind": "clipMark" })
        );
        assert_eq!(
            serde_json::from_str::<RemoteIntent>(r#"{"kind":"clipMark","seconds":null}"#).unwrap(),
            RemoteIntent::ClipMark { seconds: None }
        );
        let long =
            serde_json::from_str::<RemoteIntent>(r#"{"kind":"clipMark","seconds":60}"#).unwrap();
        assert_eq!(long, RemoteIntent::ClipMark { seconds: Some(60) });
        assert!(long.validate().is_ok());
        assert_eq!(
            long.debounce_kind(),
            "clip",
            "both lengths share one bucket"
        );
        assert_eq!(
            serde_json::to_value(&long).unwrap(),
            serde_json::json!({ "kind": "clipMark", "seconds": 60 })
        );
        assert!(
            RemoteIntent::ClipMark { seconds: Some(30) }
                .validate()
                .is_ok()
        );
        assert_eq!(
            RemoteIntent::ClipMark { seconds: Some(45) }.validate(),
            Err("A clip is 30 seconds or 1 minute.".to_string())
        );
        // Plan 181 (owner redesign R4): one action saves the clip, so the
        // separate replaySave intent is gone from the wire.
        assert!(serde_json::from_str::<RemoteIntent>(r#"{"kind":"replaySave"}"#).is_err());
    }

    #[test]
    fn system_audio_intents_use_their_wire_tags_and_one_bucket() {
        for (wire, intent) in [
            ("systemAudioOn", RemoteIntent::SystemAudioOn),
            ("systemAudioOff", RemoteIntent::SystemAudioOff),
            ("systemAudioToggle", RemoteIntent::SystemAudioToggle),
        ] {
            let parsed: RemoteIntent =
                serde_json::from_str(&format!(r#"{{"kind":"{wire}"}}"#)).unwrap();
            assert_eq!(parsed, intent);
            assert!(parsed.validate().is_ok());
            assert_eq!(parsed.debounce_kind(), "system-audio");
            assert_eq!(
                serde_json::to_value(&parsed).unwrap(),
                serde_json::json!({ "kind": wire })
            );
        }
        // Not the mic bucket: a mic key and a system-audio key are two keys.
        assert_ne!(
            RemoteIntent::SystemAudioToggle.debounce_kind(),
            RemoteIntent::MicToggle.debounce_kind()
        );
        assert!(serde_json::from_str::<RemoteIntent>(r#"{"kind":"systemAudioMute"}"#).is_err());
    }

    #[test]
    fn system_audio_bounce_is_debounced_but_the_mic_passes() {
        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        assert!(
            runtime
                .admit_intent(&RemoteIntent::SystemAudioToggle, start)
                .accepted
        );
        // A bouncing key cannot interleave the explicit forms with the toggle.
        for bounce in [RemoteIntent::SystemAudioOn, RemoteIntent::SystemAudioOff] {
            assert!(
                !runtime
                    .admit_intent(&bounce, start + Duration::from_millis(50))
                    .accepted
            );
        }
        assert!(
            runtime
                .admit_intent(&RemoteIntent::MicToggle, start + Duration::from_millis(50))
                .accepted
        );
        assert!(
            runtime
                .admit_intent(
                    &RemoteIntent::SystemAudioOff,
                    start + REMOTE_INTENT_DEBOUNCE + Duration::from_millis(1),
                )
                .accepted
        );
    }

    #[test]
    fn comment_highlight_needs_a_bounded_message_id_and_shares_one_bucket() {
        for message_id in ["", "   ", &"x".repeat(REMOTE_MESSAGE_ID_MAX_BYTES + 1)] {
            assert!(
                RemoteIntent::CommentHighlight {
                    message_id: message_id.to_string()
                }
                .validate()
                .is_err()
            );
        }
        let show = RemoteIntent::CommentHighlight {
            message_id: "twitch:1".to_string(),
        };
        assert!(show.validate().is_ok());
        assert_eq!(
            show.debounce_kind(),
            RemoteIntent::CommentHighlightClear.debounce_kind()
        );
    }

    #[test]
    fn scene_apply_requires_a_target_and_takeover_an_asset() {
        assert!(
            RemoteIntent::SceneApply {
                screen_id: None,
                layout_preset: None
            }
            .validate()
            .is_err()
        );
        assert!(
            RemoteIntent::TakeoverShow {
                asset_id: "  ".to_string()
            }
            .validate()
            .is_err()
        );
        assert!(
            RemoteIntent::SceneApply {
                screen_id: None,
                layout_preset: Some("screen-camera".to_string())
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn banner_intents_use_camel_case_wire_tags_and_one_banner_bucket() {
        let show: RemoteIntent =
            serde_json::from_str(r#"{"kind":"bannerShow","bannerId":"b-1"}"#).unwrap();
        assert_eq!(
            show,
            RemoteIntent::BannerShow {
                banner_id: "b-1".to_string()
            }
        );
        assert_eq!(
            serde_json::to_value(&show).unwrap(),
            serde_json::json!({ "kind": "bannerShow", "bannerId": "b-1" })
        );
        let toggle: RemoteIntent =
            serde_json::from_str(r#"{"kind":"bannerToggle","bannerId":"b-1"}"#).unwrap();
        assert_eq!(
            toggle,
            RemoteIntent::BannerToggle {
                banner_id: "b-1".to_string()
            }
        );
        // Hide all: no bannerId on the wire, in either direction, never null.
        let hide_all: RemoteIntent = serde_json::from_str(r#"{"kind":"bannerHide"}"#).unwrap();
        assert_eq!(hide_all, RemoteIntent::BannerHide { banner_id: None });
        assert_eq!(
            serde_json::to_value(&hide_all).unwrap(),
            serde_json::json!({ "kind": "bannerHide" })
        );
        let hide_one: RemoteIntent =
            serde_json::from_str(r#"{"kind":"bannerHide","bannerId":"b-2"}"#).unwrap();
        assert_eq!(
            serde_json::to_value(&hide_one).unwrap(),
            serde_json::json!({ "kind": "bannerHide", "bannerId": "b-2" })
        );
        for intent in [&show, &toggle, &hide_all, &hide_one] {
            assert!(intent.validate().is_ok());
            assert_eq!(intent.debounce_kind(), "banner");
        }
        // Not the takeover bucket: a banner key beside a takeover key passes.
        assert_ne!(
            show.debounce_kind(),
            RemoteIntent::TakeoverHide.debounce_kind()
        );
        assert!(serde_json::from_str::<RemoteIntent>(r#"{"kind":"bannerShow"}"#).is_err());
        assert!(
            serde_json::from_str::<RemoteIntent>(r#"{"kind":"banner_show","bannerId":"b"}"#)
                .is_err()
        );
    }

    #[test]
    fn banner_show_and_toggle_need_an_id_and_hide_refuses_an_empty_one() {
        for blank in ["", "   "] {
            assert!(
                RemoteIntent::BannerShow {
                    banner_id: blank.to_string()
                }
                .validate()
                .is_err()
            );
            assert!(
                RemoteIntent::BannerToggle {
                    banner_id: blank.to_string()
                }
                .validate()
                .is_err()
            );
            assert!(
                RemoteIntent::BannerHide {
                    banner_id: Some(blank.to_string())
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            RemoteIntent::BannerHide { banner_id: None }
                .validate()
                .is_ok()
        );

        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        assert!(
            runtime
                .admit_intent(
                    &RemoteIntent::BannerToggle {
                        banner_id: "b-1".to_string()
                    },
                    start
                )
                .accepted
        );
        // A bounce within the window is debounced whichever banner form it is.
        assert!(
            !runtime
                .admit_intent(
                    &RemoteIntent::BannerHide { banner_id: None },
                    start + Duration::from_millis(50)
                )
                .accepted
        );
        // A takeover key at the same moment passes: separate buckets.
        assert!(
            runtime
                .admit_intent(
                    &RemoteIntent::TakeoverHide,
                    start + Duration::from_millis(50)
                )
                .accepted
        );
        assert!(
            runtime
                .admit_intent(
                    &RemoteIntent::BannerShow {
                        banner_id: "b-2".to_string()
                    },
                    start + REMOTE_INTENT_DEBOUNCE + Duration::from_millis(1)
                )
                .accepted
        );
    }

    #[test]
    fn sound_intents_use_camel_case_wire_tags_and_one_sound_bucket() {
        let play: RemoteIntent =
            serde_json::from_str(r#"{"kind":"soundPlay","soundId":"s-1"}"#).unwrap();
        assert_eq!(
            play,
            RemoteIntent::SoundPlay {
                sound_id: "s-1".to_string()
            }
        );
        assert_eq!(
            serde_json::to_value(&play).unwrap(),
            serde_json::json!({ "kind": "soundPlay", "soundId": "s-1" })
        );
        // Stop all: no soundId on the wire, in either direction, never null.
        let stop_all: RemoteIntent = serde_json::from_str(r#"{"kind":"soundStop"}"#).unwrap();
        assert_eq!(stop_all, RemoteIntent::SoundStop { sound_id: None });
        assert_eq!(
            serde_json::to_value(&stop_all).unwrap(),
            serde_json::json!({ "kind": "soundStop" })
        );
        let stop_one: RemoteIntent =
            serde_json::from_str(r#"{"kind":"soundStop","soundId":"s-2"}"#).unwrap();
        assert_eq!(
            serde_json::to_value(&stop_one).unwrap(),
            serde_json::json!({ "kind": "soundStop", "soundId": "s-2" })
        );
        for intent in [&play, &stop_all, &stop_one] {
            assert!(intent.validate().is_ok());
            assert_eq!(intent.debounce_kind(), "sound");
            assert_eq!(intent.debounce_window(), REMOTE_SOUND_INTENT_DEBOUNCE);
        }
        // Not the banner or takeover bucket, and not their window.
        assert_ne!(
            play.debounce_kind(),
            RemoteIntent::TakeoverHide.debounce_kind()
        );
        assert_ne!(
            play.debounce_kind(),
            RemoteIntent::BannerHide { banner_id: None }.debounce_kind()
        );
        assert_eq!(
            RemoteIntent::RecordToggle.debounce_window(),
            REMOTE_INTENT_DEBOUNCE
        );
        assert!(serde_json::from_str::<RemoteIntent>(r#"{"kind":"soundPlay"}"#).is_err());
        assert!(
            serde_json::from_str::<RemoteIntent>(r#"{"kind":"sound_play","soundId":"s"}"#).is_err()
        );
        for blank in ["", "   "] {
            assert!(
                RemoteIntent::SoundPlay {
                    sound_id: blank.to_string()
                }
                .validate()
                .is_err()
            );
            assert!(
                RemoteIntent::SoundStop {
                    sound_id: Some(blank.to_string())
                }
                .validate()
                .is_err()
            );
        }
    }

    #[test]
    fn sound_presses_debounce_at_80ms_and_pass_beside_a_banner_key() {
        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        let play = RemoteIntent::SoundPlay {
            sound_id: "s-1".to_string(),
        };
        assert!(runtime.admit_intent(&play, start).accepted);
        // A bounce 50 ms later is refused, whichever form names that sound.
        let bounce = runtime.admit_intent(
            &RemoteIntent::SoundStop {
                sound_id: Some("s-1".to_string()),
            },
            start + Duration::from_millis(50),
        );
        assert!(!bounce.accepted);
        assert!(bounce.message.unwrap().contains("80ms"));
        // A banner key at the same moment passes: separate buckets.
        assert!(
            runtime
                .admit_intent(
                    &RemoteIntent::BannerHide { banner_id: None },
                    start + Duration::from_millis(50)
                )
                .accepted
        );
        // A drummer's next press 81 ms on passes, where a banner would still
        // be inside its 150 ms window.
        assert!(
            runtime
                .admit_intent(
                    &play,
                    start + REMOTE_SOUND_INTENT_DEBOUNCE + Duration::from_millis(1)
                )
                .accepted
        );
        assert!(
            !runtime
                .admit_intent(
                    &RemoteIntent::BannerHide { banner_id: None },
                    start
                        + Duration::from_millis(50)
                        + REMOTE_SOUND_INTENT_DEBOUNCE
                        + Duration::from_millis(1)
                )
                .accepted
        );
    }

    #[test]
    fn different_sounds_pressed_together_both_pass_and_each_still_debounces() {
        // Release test 147, plan 0004: Airhorn 44 ms after Buzzer was refused
        // because every sound shared one bucket.
        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        let press = |id: &str| RemoteIntent::SoundPlay {
            sound_id: id.to_string(),
        };
        assert!(runtime.admit_intent(&press("buzzer"), start).accepted);
        assert!(
            runtime
                .admit_intent(&press("airhorn"), start + Duration::from_millis(10))
                .accepted,
            "a different sound key at the same moment plays"
        );
        assert!(
            !runtime
                .admit_intent(&press("buzzer"), start + Duration::from_millis(50))
                .accepted,
            "the same key bouncing is still refused"
        );
        // Stop all right after a press is its own key, not a bounce.
        assert!(
            runtime
                .admit_intent(
                    &RemoteIntent::SoundStop { sound_id: None },
                    start + Duration::from_millis(20)
                )
                .accepted
        );
        assert!(
            !runtime
                .admit_intent(
                    &RemoteIntent::SoundStop { sound_id: None },
                    start + Duration::from_millis(40)
                )
                .accepted,
            "a bouncing stop-all key is refused"
        );
        assert_eq!(press("buzzer").debounce_kind(), "sound");
        assert_eq!(press("buzzer").debounce_key(), "sound:buzzer");
    }

    #[test]
    fn per_sound_debounce_keys_expire_instead_of_piling_up() {
        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        for index in 0..1_000_u64 {
            let at = start + Duration::from_millis(index * 200);
            assert!(
                runtime
                    .admit_intent(
                        &RemoteIntent::SoundPlay {
                            sound_id: format!("id-{index}"),
                        },
                        at
                    )
                    .accepted
            );
        }
        // Each id's window passed long ago: only the newest key is kept.
        assert_eq!(runtime.last_intent_at.len(), 1);
        // A key still inside its window survives the pruning and debounces.
        let now = start + Duration::from_millis(999 * 200 + 40);
        assert!(
            !runtime
                .admit_intent(
                    &RemoteIntent::SoundPlay {
                        sound_id: "id-999".to_string(),
                    },
                    now
                )
                .accepted
        );
    }

    #[test]
    fn same_kind_intents_debounce_and_different_kinds_pass() {
        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        let first = runtime.admit_intent(&RemoteIntent::RecordToggle, start);
        assert!(first.accepted);
        // A bouncing key 50ms later: rejected — record/stop share the bucket.
        let bounce =
            runtime.admit_intent(&RemoteIntent::RecordStop, start + Duration::from_millis(50));
        assert!(!bounce.accepted);
        // A different kind passes immediately.
        let mic = runtime.admit_intent(&RemoteIntent::MicToggle, start + Duration::from_millis(50));
        assert!(mic.accepted);
        // Past the window the same kind passes again, with a fresh id.
        let later = runtime.admit_intent(
            &RemoteIntent::RecordToggle,
            start + REMOTE_INTENT_DEBOUNCE + Duration::from_millis(1),
        );
        assert!(later.accepted);
        assert_ne!(later.intent_id, first.intent_id);
    }

    #[test]
    fn discovery_file_is_owner_only_and_removable() {
        let dir = std::env::temp_dir().join(format!("videorc-rc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("videorc.sqlite3");
        let path = discovery_path(&db).unwrap();
        write_discovery(&path, "127.0.0.1", 4242, "secret-token").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "discovery file must be owner-only");
        }
        let body: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(body["port"], 4242);
        assert_eq!(body["protocol"], 1);
        remove_discovery(&path);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(discovery_path(Path::new(":memory:")).is_none());
    }
}
