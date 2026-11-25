//! Plan 260 S1.8 (L1): the GPUI app's side of the backend's talk-show room.
//! The backend holds the room for this app (it has no renderer room,
//! `VIDEORC_ROOM_HOST=backend`), so the app does what the renderer's
//! `use-talk-show-room.ts` does for a backend that holds the seat: it says
//! which microphone and camera to publish (`cloud.room.microphone.set`,
//! `cloud.room.camera.set`), whether the HTML layers' sheet goes out
//! (`cloud.room.html.set`), and it reads back what the room publishes and
//! who is in it (`cloud.room.presentation`'s `media` entry).
//!
//! Plan 249 S24 (D9): after this computer took the show over from another
//! device, nothing that captures here starts by itself. The devices are held
//! (no microphone, no camera, no sheet) until the streamer turns them on
//! ([`devices_held`]).
//!
//! Pure: the GPUI `TalkShowRoomHost` sends and listens.

use serde::Deserialize;
use serde_json::{Value, json};
use videorc_protocol::AudioSettings;

use crate::guests::session::ControllerFacts;

/// The backend's event for what the room publishes and who is in it.
pub const PRESENTATION_EVENT: &str = "cloud.room.presentation";
pub const MICROPHONE_SET: &str = "cloud.room.microphone.set";
pub const CAMERA_SET: &str = "cloud.room.camera.set";
pub const HTML_SET: &str = "cloud.room.html.set";

/// The room microphone's gain bounds (`room_microphone::Settings`).
const GAIN_DB_MIN: f64 = -24.0;
const GAIN_DB_MAX: f64 = 24.0;
/// Its sync offset bounds, in milliseconds.
const OFFSET_MS_MAX: f64 = 1000.0;

/// What the backend's room publishes of the host's media, and the room's
/// other people (Rust `RoomMediaStatus`, read leniently).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomMedia {
    pub camera: bool,
    pub microphone: bool,
    pub screen: Option<RoomScreen>,
    /// Everyone else in the room as the host receives them: their pictures
    /// are at `/room/remote/latest.bmp?identity=&source=camera|screen`.
    pub people: Vec<RoomPerson>,
    /// The runner's return while the Program monitor takes it
    /// (`source=monitor`).
    pub monitor: Option<RoomMonitor>,
}

/// One person in the room (Rust `RoomRemotePerson`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomPerson {
    pub identity: String,
    pub name: String,
    /// A camera picture is coming in.
    pub camera: bool,
    /// A shared screen is coming in.
    pub screen: bool,
    /// Their microphone is coming in.
    pub audio: bool,
    pub mic_muted: bool,
    pub camera_off: bool,
    pub speaking: bool,
    /// `excellent`, `good`, `poor` or `lost`.
    pub quality: String,
}

/// The Program monitor's return (Rust `RoomRemoteMonitor`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct RoomMonitor {
    pub video: bool,
    pub audio: bool,
}

/// The shared screen and its Hide screen state (Rust `RoomScreenStatus`,
/// the parts the Studio reads).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomScreen {
    pub source_id: String,
    pub hidden: bool,
    pub published: bool,
    /// `visible`, `hiding`, `observed`, `unconfirmed` or `paused`.
    pub status: String,
}

/// A `cloud.room.presentation` payload's show and its `media` entry, when
/// it has one (a graphics-only update leaves the media as it was).
pub fn presentation_media(payload: &Value) -> Option<(String, RoomMedia)> {
    let show_id = payload.get("showId")?.as_str()?.to_string();
    let media = serde_json::from_value(payload.get("media")?.clone()).ok()?;
    Some((show_id, media))
}

/// `takeoverDeviceHoldEpoch`: the controller epoch whose devices wait for
/// the streamer, after a takeover from another device; 0 otherwise.
pub fn device_hold_epoch(controller: Option<&ControllerFacts>) -> u64 {
    match controller {
        Some(controller)
            if controller
                .taken_over_from
                .as_deref()
                .is_some_and(|from| from != "this-device") =>
        {
            controller.controller_epoch
        }
        _ => 0,
    }
}

/// The devices are held: a takeover from another device that the streamer
/// has not turned the devices on for (`enabled_epoch` is the hold epoch
/// they last turned on).
pub fn devices_held(controller: Option<&ControllerFacts>, enabled_epoch: u64) -> bool {
    let hold = device_hold_epoch(controller);
    hold > 0 && enabled_epoch != hold
}

/// `cloud.room.microphone.set`'s params: the Sources microphone in the
/// session's own settings, bounded as the bridge bounds them, or `null`
/// (none chosen, or the devices held).
pub fn microphone_params(device_id: Option<&str>, audio: &AudioSettings, held: bool) -> Value {
    let Some(device_id) = device_id.filter(|id| !id.is_empty() && !held) else {
        return json!({ "microphone": null });
    };
    let noise = serde_json::to_value(audio.microphone_noise_suppression)
        .unwrap_or_else(|_| Value::String("off".into()));
    json!({
        "microphone": {
            "deviceId": device_id,
            "gainDb": f64::from(audio.microphone_gain_db).clamp(GAIN_DB_MIN, GAIN_DB_MAX),
            "muted": audio.microphone_muted,
            "noise": noise,
            "offsetMs": f64::from(audio.microphone_sync_offset_ms)
                .round()
                .clamp(0.0, OFFSET_MS_MAX) as i64,
        }
    })
}

/// `cloud.room.camera.set`'s params: the Sources camera while it is on in
/// the Studio (chosen, shown, not held), or `null`. Its key, look and
/// background are the backend's own scene layout, so only the device goes.
pub fn camera_params(camera_id: Option<&str>, camera_shown: bool, held: bool) -> Value {
    match camera_id.filter(|id| !id.is_empty() && camera_shown && !held) {
        Some(id) => json!({ "camera": { "deviceId": id } }),
        None => json!({ "camera": null }),
    }
}

/// `cloud.room.html.set`'s params: the sheet goes out only while this
/// computer's devices are on (plan 249 S24).
pub fn html_params(held: bool) -> Value {
    json!({ "enabled": !held })
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_protocol::MicrophoneNoiseSuppression;

    fn audio() -> AudioSettings {
        AudioSettings::default()
    }

    fn controller(epoch: u64, from: Option<&str>) -> ControllerFacts {
        ControllerFacts {
            controller_epoch: epoch,
            taken_over_from: from.map(str::to_string),
            lost: false,
        }
    }

    #[test]
    fn the_presentation_media_is_read_with_its_people() {
        let payload = json!({
            "showId": "show-1",
            "media": {
                "camera": true,
                "microphone": true,
                "people": [{
                    "identity": "guest:g1",
                    "name": "Ada",
                    "camera": true,
                    "screen": false,
                    "audio": true,
                    "micMuted": false,
                    "cameraOff": false,
                    "speaking": true,
                    "quality": "good"
                }],
                "monitor": { "video": true, "audio": false },
                "aux": { "enabled": true }
            }
        });
        let (show, media) = presentation_media(&payload).expect("media");
        assert_eq!(show, "show-1");
        assert!(media.camera && media.microphone);
        assert_eq!(media.people.len(), 1);
        assert_eq!(media.people[0].name, "Ada");
        assert!(media.people[0].speaking);
        assert_eq!(
            media.monitor,
            Some(RoomMonitor {
                video: true,
                audio: false
            })
        );
        // A graphics-only update says nothing about the media.
        assert_eq!(
            presentation_media(&json!({ "showId": "show-1", "graphics": {} })),
            None
        );
    }

    #[test]
    fn only_a_takeover_from_another_device_holds_the_devices() {
        assert!(!devices_held(None, 0));
        assert!(!devices_held(Some(&controller(4, None)), 0));
        assert!(!devices_held(Some(&controller(4, Some("this-device"))), 0));
        assert!(devices_held(
            Some(&controller(4, Some("another-device"))),
            0
        ));
        // Turned on for this epoch: no longer held; a later takeover holds
        // again.
        assert!(!devices_held(
            Some(&controller(4, Some("another-device"))),
            4
        ));
        assert!(devices_held(
            Some(&controller(5, Some("another-device"))),
            4
        ));
    }

    #[test]
    fn the_microphone_goes_in_the_bridges_bounds() {
        let mut settings = audio();
        settings.microphone_gain_db = 40.0;
        settings.microphone_sync_offset_ms = 1500;
        settings.microphone_muted = true;
        settings.microphone_noise_suppression = MicrophoneNoiseSuppression::Rnnoise;
        assert_eq!(
            microphone_params(Some("mic-1"), &settings, false),
            json!({ "microphone": {
                "deviceId": "mic-1",
                "gainDb": 24.0,
                "muted": true,
                "noise": "rnnoise",
                "offsetMs": 1000
            }})
        );
        assert_eq!(
            microphone_params(Some("mic-1"), &settings, true),
            json!({ "microphone": null })
        );
        assert_eq!(
            microphone_params(None, &settings, false),
            json!({ "microphone": null })
        );
    }

    #[test]
    fn the_camera_goes_while_it_is_shown_and_not_held() {
        assert_eq!(
            camera_params(Some("cam-1"), true, false),
            json!({ "camera": { "deviceId": "cam-1" } })
        );
        assert_eq!(
            camera_params(Some("cam-1"), false, false),
            json!({ "camera": null })
        );
        assert_eq!(
            camera_params(Some("cam-1"), true, true),
            json!({ "camera": null })
        );
        assert_eq!(
            camera_params(Some(""), true, false),
            json!({ "camera": null })
        );
        assert_eq!(html_params(true), json!({ "enabled": false }));
    }
}
