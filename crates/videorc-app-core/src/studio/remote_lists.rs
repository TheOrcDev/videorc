//! The lists and states the remotes show past the scene: the takeovers and
//! the one on air, the banners, the sounds and which play, Hide screen, and
//! Sidekick Live. Electron's renderer keeps them for its own pages and hands
//! them to `RemoteSurfacePublisher`; here the Studio follows them for the
//! surface alone ([`super::remote::RemoteExtras`]).
//!
//! Each is read once per connection (after the bootstrap, and again after a
//! lag) and then follows its pushed event, as the renderer's do: no polling.
//! A read that answers after an event of the same list on the same
//! connection never overwrites it (the renderer's revision checks), and one
//! that answers after a reconnect is dropped. A failed read leaves the list
//! as it was.
//!
//! Sidekick Live has no pushed event: the Studio reads it per connection,
//! keeps what its own key saved, and the app reports its own saves
//! ([`Studio::note_cohost_settings`]).

use std::sync::Arc;

use serde_json::{Value, json};

use super::remote::{RemoteBanner, RemoteNamed, RemotePublisher, RemoteSound};
use super::remote_app::COHOST_SETTINGS_GET_METHOD;
use super::scene_on_stream::{SCREEN_PRIVACY_CHANGED_EVENT, SCREEN_PRIVACY_GET_METHOD};
use super::{Studio, StudioBackend};

/// `screens.changed`: every takeover, the whole list.
pub const TAKEOVERS_CHANGED_EVENT: &str = "screens.changed";
/// `banners.changed`: every banner, the whole list.
pub const BANNERS_CHANGED_EVENT: &str = "banners.changed";
/// `sounds.changed`: the whole soundboard.
pub const SOUNDS_CHANGED_EVENT: &str = "sounds.changed";
/// `sounds.playback`: every sound playing now.
pub const SOUNDS_PLAYBACK_EVENT: &str = "sounds.playback";

/// The events the surface's lists follow (the takeover on air rides
/// `screens.active.changed`, which the Studio reads for its mute already).
pub const EVENTS: [&str; 5] = [
    TAKEOVERS_CHANGED_EVENT,
    BANNERS_CHANGED_EVENT,
    SOUNDS_CHANGED_EVENT,
    SOUNDS_PLAYBACK_EVENT,
    SCREEN_PRIVACY_CHANGED_EVENT,
];

/// Whether `event` is one of [`EVENTS`].
pub fn follows(event: &str) -> bool {
    EVENTS.contains(&event)
}

/// Which lists this connection already heard pushed (or saved), so a read
/// that answers later leaves them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ListsHeard {
    pub(super) takeovers: bool,
    pub(super) active_takeover: bool,
    pub(super) banners: bool,
    pub(super) board: bool,
    pub(super) screen_hidden: bool,
    pub(super) buddy_live: bool,
}

/// `{id, name}` of each entry with a string id (the takeovers, a board's
/// sounds). `None` when it isn't a list.
pub fn named_list(value: &Value) -> Option<Vec<RemoteNamed>> {
    Some(
        value
            .as_array()?
            .iter()
            .filter_map(|entry| {
                Some(RemoteNamed {
                    id: entry.get("id")?.as_str()?.to_string(),
                    name: entry
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .collect(),
    )
}

/// `bannerSummaries`: `{id, name, shown}` of each banner, in Assets order.
pub fn banner_list(value: &Value) -> Option<Vec<RemoteBanner>> {
    Some(
        value
            .as_array()?
            .iter()
            .filter_map(|entry| {
                Some(RemoteBanner {
                    id: entry.get("id")?.as_str()?.to_string(),
                    name: entry
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    shown: entry.get("shown").and_then(Value::as_bool) == Some(true),
                })
            })
            .collect(),
    )
}

/// A soundboard's sounds, in board order (`sounds.list`, `sounds.changed`).
pub fn board_of(value: &Value) -> Option<Vec<RemoteNamed>> {
    named_list(value.get("sounds")?)
}

/// The sounds playing (`sounds.playback`'s voices).
pub fn playing_of(value: &Value) -> Vec<String> {
    value
        .get("voices")
        .and_then(Value::as_array)
        .map(|voices| {
            voices
                .iter()
                .filter_map(|voice| voice.get("soundId")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `remoteSoundSummaries`: the board, each sound saying whether it plays.
pub fn sounds_of(board: &[RemoteNamed], playing: &[String]) -> Vec<RemoteSound> {
    board
        .iter()
        .map(|sound| RemoteSound {
            id: sound.id.clone(),
            name: sound.name.clone(),
            playing: playing.contains(&sound.id),
        })
        .collect()
}

/// The takeover on air (`screens.active.changed`, `screens.active`).
pub fn active_takeover_of(value: &Value) -> Option<String> {
    value.get("id")?.as_str().map(str::to_string)
}

/// Hide screen's state (`screen.privacy.changed`, `screen.privacy.get`).
pub fn screen_hidden_of(value: &Value) -> Option<bool> {
    value.get("hidden")?.as_bool()
}

/// The board changed or a sound started or stopped: the sounds again.
fn resound(remote: &mut RemotePublisher) {
    remote.extras.sounds = sounds_of(&remote.board, &remote.playing);
}

impl<B: StudioBackend> Studio<B> {
    /// One of [`EVENTS`], pushed: the list it carries is the truth.
    pub(super) fn follow_remote_list(&self, event: &str, payload: &Value) {
        match event {
            TAKEOVERS_CHANGED_EVENT => {
                if let Some(takeovers) = named_list(payload) {
                    self.edit_remote(|remote| {
                        remote.heard.takeovers = true;
                        remote.extras.takeovers = takeovers;
                    });
                }
            }
            BANNERS_CHANGED_EVENT => {
                if let Some(banners) = banner_list(payload) {
                    self.edit_remote(|remote| {
                        remote.heard.banners = true;
                        remote.extras.banners = banners;
                    });
                }
            }
            SOUNDS_CHANGED_EVENT => {
                if let Some(board) = board_of(payload) {
                    self.edit_remote(|remote| {
                        remote.heard.board = true;
                        remote.board = board;
                        resound(remote);
                    });
                }
            }
            SOUNDS_PLAYBACK_EVENT => {
                let playing = playing_of(payload);
                self.edit_remote(|remote| {
                    remote.playing = playing;
                    resound(remote);
                });
            }
            SCREEN_PRIVACY_CHANGED_EVENT => {
                if let Some(hidden) = screen_hidden_of(payload) {
                    self.edit_remote(|remote| {
                        remote.heard.screen_hidden = true;
                        remote.extras.screen_hidden = hidden;
                    });
                }
            }
            _ => {}
        }
    }

    /// `screens.active.changed`: the takeover on air, or none.
    pub(super) fn follow_remote_takeover(&self, payload: &Value) {
        let active = active_takeover_of(payload);
        self.edit_remote(|remote| {
            remote.heard.active_takeover = true;
            remote.extras.active_takeover_id = active;
        });
    }

    /// Sidekick Live on or off, as a save just answered it (the app's own
    /// switches call it with their answer, as the Studio's key does).
    pub fn note_buddy_live(&self, enabled: bool) {
        self.edit_remote(|remote| {
            remote.heard.buddy_live = true;
            remote.extras.buddy_live = enabled;
        });
    }

    /// A `cohost.settings.get` or `.set` answer: its `enabled` is Sidekick
    /// Live. Anything else is not one, and changes nothing.
    pub fn note_cohost_settings(&self, settings: &Value) {
        if let Some(enabled) = settings.get("enabled").and_then(Value::as_bool) {
            self.note_buddy_live(enabled);
        }
    }

    /// Reads every list again on this connection (after the bootstrap or a
    /// lag); the driver runs it beside the events.
    pub(super) fn kick_remote_lists(&self, forget_heard: bool) {
        if forget_heard {
            self.remote_lock().heard = ListsHeard::default();
        }
        self.remote_lists_kick.notify_one();
    }

    /// Runs the reads when kicked. [`Self::drive`] runs it.
    pub(super) async fn read_remote_lists_when_kicked(self: &Arc<Self>) {
        loop {
            self.remote_lists_kick.notified().await;
            self.read_remote_lists().await;
        }
    }

    /// One answer of this connection's reads, unless a reconnect came first.
    pub(super) fn take_list_read(&self, generation: u64, apply: impl FnOnce(&mut RemotePublisher)) {
        self.edit_remote(|remote| {
            if remote.generation() == generation {
                apply(remote);
            }
        });
    }

    /// Every list, read once. A test without a driver calls it.
    #[doc(hidden)]
    pub async fn read_remote_lists(&self) {
        let generation = self.remote_lock().generation();
        let warn = |what: &str, error: &crate::client::RpcError| {
            self.config.logger.warn(format!(
                "[remote-control] {what} did not read: {} ({})",
                error.message, error.code
            ));
        };

        match self.backend.screens_list().await {
            Ok(screens) => {
                let takeovers: Vec<RemoteNamed> = screens
                    .into_iter()
                    .map(|screen| RemoteNamed {
                        id: screen.id,
                        name: screen.name,
                    })
                    .collect();
                self.take_list_read(generation, |remote| {
                    if !remote.heard.takeovers {
                        remote.extras.takeovers = takeovers;
                    }
                });
            }
            Err(error) => warn("the takeovers", &error),
        }
        match self.backend.screens_active().await {
            Ok(active) => {
                let active = active.map(|screen| screen.id);
                self.take_list_read(generation, |remote| {
                    if !remote.heard.active_takeover {
                        remote.extras.active_takeover_id = active;
                    }
                });
            }
            Err(error) => warn("the takeover on air", &error),
        }
        match self.banners().await {
            Ok(list) => {
                if let Some(banners) = banner_list(&list) {
                    self.take_list_read(generation, |remote| {
                        if !remote.heard.banners {
                            remote.extras.banners = banners;
                        }
                    });
                }
            }
            Err(error) => warn("the banners", &error),
        }
        match self.backend.sounds_list().await {
            Ok(board) => {
                let board: Vec<RemoteNamed> = board
                    .sounds
                    .into_iter()
                    .map(|sound| RemoteNamed {
                        id: sound.id,
                        name: sound.name,
                    })
                    .collect();
                self.take_list_read(generation, |remote| {
                    if !remote.heard.board {
                        remote.board = board;
                        resound(remote);
                    }
                });
            }
            Err(error) => warn("the soundboard", &error),
        }
        match self
            .backend
            .scene_request(SCREEN_PRIVACY_GET_METHOD, Value::Null)
            .await
        {
            Ok(privacy) => {
                if let Some(hidden) = screen_hidden_of(&privacy) {
                    self.take_list_read(generation, |remote| {
                        if !remote.heard.screen_hidden {
                            remote.extras.screen_hidden = hidden;
                        }
                    });
                }
            }
            Err(error) => warn("Hide screen", &error),
        }
        match self
            .backend
            .buddy_request(COHOST_SETTINGS_GET_METHOD, json!({}))
            .await
        {
            Ok(settings) => {
                if let Some(enabled) = settings.get("enabled").and_then(Value::as_bool) {
                    self.take_list_read(generation, |remote| {
                        if !remote.heard.buddy_live {
                            remote.extras.buddy_live = enabled;
                        }
                    });
                }
            }
            Err(error) => warn("Sidekick's settings", &error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lists_read_only_what_the_remotes_may_see() {
        let takeovers = json!([
            { "id": "brb", "name": "Be right back", "imagePath": "/secret/brb.png" },
            { "name": "no id" }
        ]);
        assert_eq!(
            named_list(&takeovers),
            Some(vec![RemoteNamed {
                id: "brb".to_string(),
                name: "Be right back".to_string()
            }])
        );
        assert_eq!(named_list(&json!({})), None);

        let banners = json!([
            { "id": "sale", "name": "Sale", "shown": true, "imageFile": "sale.png" },
            { "id": "logo", "name": "Logo" }
        ]);
        assert_eq!(
            banner_list(&banners),
            Some(vec![
                RemoteBanner {
                    id: "sale".to_string(),
                    name: "Sale".to_string(),
                    shown: true
                },
                RemoteBanner {
                    id: "logo".to_string(),
                    name: "Logo".to_string(),
                    shown: false
                },
            ])
        );

        let board = board_of(&json!({
            "sounds": [{ "id": "airhorn", "name": "Airhorn", "file": "a.wav" }, { "id": "drum", "name": "Drum" }],
            "volumeDb": 0
        }))
        .expect("a board");
        let playing = playing_of(&json!({ "voices": [{ "voiceId": "v1", "soundId": "drum" }] }));
        assert_eq!(playing, ["drum"]);
        assert_eq!(
            sounds_of(&board, &playing),
            [
                RemoteSound {
                    id: "airhorn".to_string(),
                    name: "Airhorn".to_string(),
                    playing: false
                },
                RemoteSound {
                    id: "drum".to_string(),
                    name: "Drum".to_string(),
                    playing: true
                },
            ]
        );
        assert!(playing_of(&json!({})).is_empty());

        assert_eq!(
            active_takeover_of(&json!({ "id": "brb" })),
            Some("brb".to_string())
        );
        assert_eq!(active_takeover_of(&Value::Null), None);
        assert_eq!(screen_hidden_of(&json!({ "hidden": true })), Some(true));
        assert_eq!(screen_hidden_of(&json!({})), None);
    }

    #[test]
    fn the_list_events_are_the_ones_followed() {
        for event in EVENTS {
            assert!(follows(event), "{event}");
        }
        assert!(!follows("screens.active.changed"));
        assert!(!follows("recording.status"));
    }
}
