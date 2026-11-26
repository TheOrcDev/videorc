//! Debug/harness fixtures for the screen gallery's Show stage shots
//! (plan 260 C4). Pure: builds a `CloudStatus` the Studio can commit without
//! LiveKit, X or YouTube. The smoke command `gallery-seed-show-stage` is the
//! only caller; release product paths never invoke it.

use serde_json::{Value, json};

use crate::livestream::cloud_status::{CloudShow, CloudStatus};
use crate::studio::room_media::{RoomMedia, RoomPerson, RoomScreen};

/// Which Show stage look the gallery wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GalleryShowStage {
    /// Room closed: Preview stays; Show stage is not on screen.
    Closed,
    /// Room open: host + two guests, side-by-side; Screen + people is disabled
    /// (no screen shared yet) so a layout card shows the pre-blend fade.
    Open,
    /// Room open with the host sharing a screen: Screens cards have a
    /// selected "Your screen" and a guest screen to put on stage.
    Screens,
    /// Room open, host camera off: the talk-show host camera-off avatar.
    HostCameraOff,
}

impl GalleryShowStage {
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "closed" => Some(Self::Closed),
            "open" => Some(Self::Open),
            "screens" => Some(Self::Screens),
            "host-camera-off" => Some(Self::HostCameraOff),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
            Self::Screens => "screens",
            Self::HostCameraOff => "host-camera-off",
        }
    }
}

const SHOW_ID: &str = "sh_gallery_show_stage";
const HOST: &str = "host:sh_gallery_show_stage";

/// A `CloudStatus` for the gallery's Show stage seed. No network; the room
/// facts are enough for Show stage, Guests strip and talk-show transport.
pub fn gallery_cloud_status(kind: GalleryShowStage) -> CloudStatus {
    let mut status = CloudStatus {
        phase: "live".into(),
        entitled: true,
        plan: Some("max".into()),
        connected: true,
        show: Some(CloudShow {
            id: SHOW_ID.into(),
            node_id: "node_gallery".into(),
            kind: Some("talk".into()),
            ..CloudShow::default()
        }),
        ..CloudStatus::default()
    };
    status.room = Some(match kind {
        GalleryShowStage::Closed => room_closed(),
        GalleryShowStage::Open => room_open(),
        GalleryShowStage::Screens => room_screens(),
        GalleryShowStage::HostCameraOff => room_host_camera_off(),
    });
    status
}

fn room_closed() -> Value {
    json!({
        "phase": "closed",
        "doorOpen": false,
        "platforms": ["youtube"],
        "guests": [],
        "participants": [],
        "stage": { "layout": "solo", "onStage": [] },
        "connected": false,
        "stageSet": false,
        "live": false,
    })
}

fn room_open() -> Value {
    json!({
        "phase": "open",
        "doorOpen": true,
        "inviteUrl": "https://videorc.com/guest/galleryShowStage",
        "platforms": ["youtube", "twitch"],
        "guests": [
            {
                "guestId": "g_ada",
                "name": "Ada",
                "joinedAt": "2026-11-25T12:00:00Z",
                "muted": false,
                "screenShareAllowed": false
            },
            {
                "guestId": "g_grace",
                "name": "Grace",
                "joinedAt": "2026-11-25T12:01:00Z",
                "muted": true,
                "screenShareAllowed": true
            }
        ],
        "participants": [
            {
                "identity": HOST,
                "name": "You",
                "role": "host",
                "onStage": true,
                "video": true,
                "audio": true,
                "muted": false,
                "screen": false,
                "quality": "excellent",
                "sinceMs": 1000,
                "away": false
            },
            {
                "identity": "g_ada",
                "name": "Ada",
                "role": "guest",
                "onStage": true,
                "video": true,
                "audio": true,
                "muted": false,
                "screen": false,
                "quality": "good",
                "sinceMs": 2000,
                "away": false
            },
            {
                "identity": "g_grace",
                "name": "Grace",
                "role": "guest",
                "onStage": false,
                "video": false,
                "audio": true,
                "muted": true,
                "screen": false,
                "quality": "good",
                "sinceMs": 3000,
                "away": false
            }
        ],
        "stage": {
            "layout": "side-by-side",
            "onStage": [HOST, "g_ada"],
            "hostShape": "rounded"
        },
        "connected": true,
        "client": "connected",
        "limits": {
            "guestsOnStage": 5,
            "roomSize": 10,
            "recordingRetentionDays": 30
        },
        "stageSet": true,
        "live": false,
    })
}

fn room_host_camera_off() -> Value {
    let mut room = room_open();
    let Some(obj) = room.as_object_mut() else {
        return room;
    };
    if let Some(participants) = obj.get_mut("participants").and_then(|v| v.as_array_mut()) {
        for person in participants {
            let identity = person
                .get("identity")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            if identity.as_deref() == Some(HOST)
                && let Some(entry) = person.as_object_mut()
            {
                entry.insert("video".into(), json!(false));
            }
        }
    }
    room
}

fn room_screens() -> Value {
    let mut room = room_open();
    let Some(obj) = room.as_object_mut() else {
        return room;
    };
    obj.insert(
        "stage".into(),
        json!({
            "layout": "screen-people",
            "onStage": [HOST, "g_ada"],
            "screen": HOST,
            "hostShape": "rounded"
        }),
    );
    if let Some(participants) = obj.get_mut("participants").and_then(|v| v.as_array_mut()) {
        for person in participants {
            let identity = person
                .get("identity")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let Some(entry) = person.as_object_mut() else {
                continue;
            };
            if identity.as_deref() == Some(HOST) || identity.as_deref() == Some("g_ada") {
                entry.insert("screen".into(), json!(true));
            }
            if identity.as_deref() == Some("g_ada") {
                entry.insert("onStage".into(), json!(true));
            }
        }
    }
    if let Some(guests) = obj.get_mut("guests").and_then(|v| v.as_array_mut()) {
        for guest in guests {
            let id = guest
                .get("guestId")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            if id.as_deref() == Some("g_ada")
                && let Some(entry) = guest.as_object_mut()
            {
                entry.insert("screenShareAllowed".into(), json!(true));
            }
        }
    }
    room
}

/// What `TalkShowRoomHost::room_media` should hold for the open gallery
/// seeds: host camera on/off, Ada camera on / Grace camera off, optional screens.
pub fn gallery_room_media(kind: GalleryShowStage) -> Option<RoomMedia> {
    match kind {
        GalleryShowStage::Closed => None,
        GalleryShowStage::Open => Some(RoomMedia {
            camera: true,
            microphone: true,
            screen: None,
            people: vec![
                person("g_ada", "Ada", true, false, false),
                person("g_grace", "Grace", false, false, true),
            ],
            monitor: None,
        }),
        GalleryShowStage::Screens => Some(RoomMedia {
            camera: true,
            microphone: true,
            screen: Some(RoomScreen {
                source_id: "screen:gallery:1".into(),
                hidden: false,
                published: true,
                status: "visible".into(),
            }),
            people: vec![person("g_ada", "Ada", true, true, false)],
            monitor: None,
        }),
        GalleryShowStage::HostCameraOff => Some(RoomMedia {
            camera: false,
            microphone: true,
            screen: None,
            people: vec![
                person("g_ada", "Ada", true, false, false),
                person("g_grace", "Grace", false, false, true),
            ],
            monitor: None,
        }),
    }
}

fn person(identity: &str, name: &str, camera: bool, screen: bool, camera_off: bool) -> RoomPerson {
    RoomPerson {
        identity: identity.into(),
        name: name.into(),
        camera,
        screen,
        audio: true,
        mic_muted: camera_off,
        camera_off,
        speaking: false,
        quality: "good".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guests::wire::RoomStatus;
    use crate::studio::screen_views::talk_show_room;

    #[test]
    fn closed_keeps_the_preview() {
        let status = gallery_cloud_status(GalleryShowStage::Closed);
        let talk = talk_show_room(Some(&status));
        assert!(!talk.open);
        assert!(!talk.preview_replaced);
    }

    #[test]
    fn open_replaces_the_preview_and_names_guests() {
        let status = gallery_cloud_status(GalleryShowStage::Open);
        let talk = talk_show_room(Some(&status));
        assert!(talk.open);
        assert!(talk.preview_replaced);
        let room = RoomStatus::from_value(status.room.as_ref().unwrap()).unwrap();
        assert_eq!(room.guests.len(), 2);
        assert!(room.stage.screen.is_none());
    }

    #[test]
    fn screens_names_the_host_screen_on_stage() {
        let status = gallery_cloud_status(GalleryShowStage::Screens);
        let room = RoomStatus::from_value(status.room.as_ref().unwrap()).unwrap();
        assert_eq!(room.stage.screen.as_deref(), Some(HOST));
        assert!(
            room.participants
                .iter()
                .any(|p| p.identity == HOST && p.screen)
        );
    }

    #[test]
    fn host_camera_off_media_turns_the_host_camera_off() {
        let media = gallery_room_media(GalleryShowStage::HostCameraOff).unwrap();
        assert!(!media.camera);
        assert!(
            media
                .people
                .iter()
                .any(|p| p.identity == "g_grace" && p.camera_off)
        );
        let status = gallery_cloud_status(GalleryShowStage::HostCameraOff);
        let room = RoomStatus::from_value(status.room.as_ref().unwrap()).unwrap();
        assert!(
            room.participants
                .iter()
                .any(|p| p.identity == HOST && !p.video)
        );
    }
}
