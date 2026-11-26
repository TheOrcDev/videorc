use std::sync::Arc;

use serde_json::json;
use videorc_protocol::{RecordingState, RecordingStatus};

use super::*;
use crate::studio::StudioConfig;
use crate::studio::session::initial_status;
use crate::studio::test_support::{Silent, ready_snapshot, set_status};

fn status(state: RecordingState, stream: bool) -> RecordingStatus {
    RecordingStatus {
        state,
        session_id: Some("s1".to_string()),
        stream_url: stream.then(|| "rtmp://127.0.0.1/live".to_string()),
        ..initial_status()
    }
}

fn wire(surface: &RemoteSurface) -> Value {
    serde_json::to_value(surface).expect("the surface serializes")
}

#[test]
fn an_idle_studio_shows_its_saved_mode_and_every_layout() {
    let mut snapshot = ready_snapshot();
    snapshot.settings.capture.record_enabled = true;
    snapshot.settings.capture.stream_enabled = false;
    let surface = wire(&surface_of(&snapshot, &RemoteExtras::default()));
    let state = &surface["state"];
    assert_eq!(state["sessionState"], json!("idle"));
    assert_eq!(state["sessionActive"], json!(false));
    assert_eq!(state["recordEnabled"], json!(true));
    assert_eq!(state["streamEnabled"], json!(false));
    assert_eq!(state["activeTakeoverId"], json!(null));
    assert_eq!(state["activeSavedSceneId"], json!(null));
    assert_eq!(
        state["windows"],
        json!({"notes": false, "comments": false, "preview": false})
    );
    assert_eq!(
        state["outputSession"],
        json!({
            "owner": "native", "freshness": "fresh", "roomOpen": false,
            "microphoneConfirmed": true, "cameraOff": null
        })
    );
    assert_eq!(
        state["streamManager"],
        json!({"screenId": null, "visible": false, "hiddenFromStream": false})
    );
    // No devices read: System audio is not available, so never on.
    assert_eq!(state["systemAudioAvailable"], json!(false));
    assert_eq!(state["systemAudioOn"], json!(false));

    let describe = &surface["describe"];
    let presets = describe["layoutPresets"].as_array().expect("presets");
    assert_eq!(
        presets.len(),
        HORIZONTAL_LAYOUT_PRESETS.len() + VERTICAL_LAYOUT_PRESETS.len()
    );
    for preset in presets {
        let id = preset.as_str().expect("an id");
        assert!(describe["layoutLabels"][id].is_string(), "{id} has a name");
    }
    assert_eq!(describe["windows"], json!(["notes", "comments", "preview"]));
    assert_eq!(describe["screenMoves"], json!("supported"));
    assert_eq!(describe["banners"], json!([]));
    assert_eq!(describe["sounds"], json!([]));
}

#[test]
fn system_audio_is_available_only_once_a_list_names_its_device() {
    // Electron's `systemAudioStatus`: the listed device's own status. The
    // Studio row's Mac stand-in ("Available until the first list") is not
    // the remotes' word.
    let mut snapshot = ready_snapshot();
    snapshot.settings.capture.audio.system_audio_enabled = true;
    let state = wire(&surface_of(&snapshot, &RemoteExtras::default()))["state"].clone();
    assert_eq!(state["systemAudioAvailable"], json!(false));
    assert_eq!(state["systemAudioOn"], json!(false));

    let device: videorc_protocol::Device = serde_json::from_value(json!({
        "id": "system-audio", "name": "System audio",
        "kind": "system-audio", "status": "available"
    }))
    .expect("a device");
    snapshot.sources.devices.devices = vec![device];
    snapshot.sources.devices_known = true;
    let state = wire(&surface_of(&snapshot, &RemoteExtras::default()))["state"].clone();
    assert_eq!(state["systemAudioAvailable"], json!(true));
    assert_eq!(
        state["systemAudioOn"],
        json!(true),
        "the switch's request, unconfirmed"
    );

    snapshot.sources.devices.devices[0].status = DeviceStatus::PermissionRequired;
    let state = wire(&surface_of(&snapshot, &RemoteExtras::default()))["state"].clone();
    assert_eq!(state["systemAudioAvailable"], json!(false));
    assert_eq!(state["systemAudioOn"], json!(false));
}

#[test]
fn a_running_session_shows_what_it_does() {
    let mut snapshot = ready_snapshot();
    snapshot.settings.capture.record_enabled = false;
    snapshot.settings.capture.stream_enabled = true;
    set_status(&mut snapshot, status(RecordingState::Recording, false));
    let state = wire(&surface_of(&snapshot, &RemoteExtras::default()))["state"].clone();
    assert_eq!(state["sessionState"], json!("recording"));
    assert_eq!(state["sessionActive"], json!(true));
    // A recording, whatever the saved mode says.
    assert_eq!(state["recordEnabled"], json!(true));
    assert_eq!(state["streamEnabled"], json!(false));

    set_status(&mut snapshot, status(RecordingState::Streaming, true));
    let state = wire(&surface_of(&snapshot, &RemoteExtras::default()))["state"].clone();
    assert_eq!(state["sessionState"], json!("streaming"));
    assert_eq!(state["recordEnabled"], json!(false));
    assert_eq!(state["streamEnabled"], json!(true));
}

#[test]
fn a_clips_ring_session_is_not_a_session_for_the_keys() {
    let mut snapshot = ready_snapshot();
    let mut ring = status(RecordingState::Recording, false);
    ring.replay_only = true;
    set_status(&mut snapshot, ring);
    let state = wire(&surface_of(&snapshot, &RemoteExtras::default()))["state"].clone();
    assert_eq!(state["sessionActive"], json!(false));
}

#[test]
fn the_apps_extras_reach_the_surface() {
    let extras = RemoteExtras {
        screen_hidden: true,
        active_takeover_id: Some("t1".to_string()),
        windows: RemoteWindows {
            notes: true,
            comments: false,
            preview: true,
        },
        takeovers: vec![RemoteNamed {
            id: "t1".to_string(),
            name: "Be right back".to_string(),
        }],
        banners: vec![RemoteBanner {
            id: "b1".to_string(),
            name: "Sale".to_string(),
            shown: true,
        }],
        sounds: vec![RemoteSound {
            id: "s1".to_string(),
            name: "Airhorn".to_string(),
            playing: false,
        }],
        buddy_live: true,
        stream_manager: RemoteStreamManager {
            screen_id: Some("2".to_string()),
            visible: true,
            hidden_from_stream: true,
        },
        screens: vec![RemoteNamed {
            id: "2".to_string(),
            name: "Studio Display".to_string(),
        }],
        screen_moves: ScreenMoves::Wayland,
    };
    let surface = wire(&surface_of(&ready_snapshot(), &extras));
    assert_eq!(surface["state"]["screenHidden"], json!(true));
    assert_eq!(surface["state"]["activeTakeoverId"], json!("t1"));
    assert_eq!(surface["state"]["buddyLive"], json!(true));
    assert_eq!(
        surface["state"]["streamManager"],
        json!({"screenId": "2", "visible": true, "hiddenFromStream": true})
    );
    assert_eq!(
        surface["describe"]["takeovers"],
        json!([{"id": "t1", "name": "Be right back"}])
    );
    assert_eq!(
        surface["describe"]["banners"],
        json!([{"id": "b1", "name": "Sale", "shown": true}])
    );
    assert_eq!(
        surface["describe"]["sounds"],
        json!([{"id": "s1", "name": "Airhorn", "playing": false}])
    );
    assert_eq!(surface["describe"]["screenMoves"], json!("wayland"));
}

#[test]
fn the_publisher_sends_a_body_once_per_connection() {
    let snapshot = ready_snapshot();
    let surface = surface_of(&snapshot, &RemoteExtras::default());
    let mut publisher = RemotePublisher::default();
    assert!(publisher.note(&surface), "the first surface is news");
    assert!(!publisher.note(&surface), "the same surface is not");
    let (body, _, generation) = publisher.due().expect("due");
    publisher.published = Some(body);
    assert!(publisher.due().is_none(), "the backend holds it");
    assert_eq!(publisher.generation, generation);

    // A reconnect: the new backend holds nothing, so the same body is news.
    publisher.forget_connection();
    assert!(publisher.due().is_none(), "nothing until the next surface");
    assert!(publisher.note(&surface));
    assert!(publisher.due().is_some());

    // Flipping back to what the backend holds is not news, and nothing is due.
    let (body, _, _) = publisher.due().expect("due");
    publisher.published = Some(body);
    let mut changed = snapshot.clone();
    changed.settings.capture.record_enabled = !changed.settings.capture.record_enabled;
    assert!(publisher.note(&surface_of(&changed, &RemoteExtras::default())));
    assert!(!publisher.note(&surface));
    assert!(publisher.due().is_none());
}

fn intent(kind: &str) -> RemoteIntentEnvelope {
    RemoteIntentEnvelope {
        intent_id: "i1".to_string(),
        intent: json!({"kind": kind}),
    }
}

fn intent_with(fields: Value) -> RemoteIntentEnvelope {
    RemoteIntentEnvelope {
        intent_id: "i1".to_string(),
        intent: fields,
    }
}

/// A refusal in the remote's words.
fn no(message: &str) -> IntentOutcome {
    (false, Some(message.to_string()))
}

fn silent_studio() -> Arc<Studio<Silent>> {
    Arc::new(Studio::new(Arc::new(Silent), StudioConfig::default()))
}

#[tokio::test]
async fn refused_intents_say_why_in_the_remotes_words() {
    let studio = silent_studio();
    assert_eq!(
        studio.execute_remote_intent(&intent("recordStop")).await,
        no(copy::NOT_RUNNING)
    );
    assert_eq!(
        studio.execute_remote_intent(&intent("streamStop")).await,
        no(copy::NOT_RUNNING)
    );
    assert_eq!(
        studio.execute_remote_intent(&intent("streamStart")).await,
        no(copy::STREAM_NOT_SET_UP)
    );
    // No devices read: System audio isn't available.
    assert_eq!(
        studio.execute_remote_intent(&intent("systemAudioOn")).await,
        no(copy::SYSTEM_AUDIO)
    );
    let no_kind = RemoteIntentEnvelope {
        intent_id: "i2".to_string(),
        intent: json!({}),
    };
    assert_eq!(
        studio.execute_remote_intent(&no_kind).await,
        no(copy::UNSUPPORTED)
    );
}

#[tokio::test]
async fn the_apps_own_intents_still_ask_for_an_update() {
    // The windows, the Stream Manager's screen and Sidekick Live are the
    // GPUI app's to drive (a follow-up).
    let studio = silent_studio();
    for kind in [
        "windowFront",
        "streamManagerScreenSwap",
        "streamManagerFrontOrClose",
        "buddyLiveOn",
        "buddyLiveOff",
        "buddyLiveToggle",
        "somethingNew",
    ] {
        assert_eq!(
            studio.execute_remote_intent(&intent(kind)).await,
            no(copy::UNSUPPORTED),
            "{kind}"
        );
    }
}

#[tokio::test]
async fn a_scene_key_without_a_known_scene_layout_or_screen_is_refused() {
    let studio = silent_studio();
    let refused_with = |fields: Value, message: &'static str| {
        let studio = studio.clone();
        async move {
            assert_eq!(
                studio
                    .execute_remote_intent(&intent_with(fields.clone()))
                    .await,
                no(message),
                "{fields}"
            );
        }
    };
    refused_with(json!({"kind": "sceneApply"}), copy::SCENE_MISSING).await;
    refused_with(
        json!({"kind": "sceneApply", "sceneId": "   "}),
        copy::SCENE_MISSING,
    )
    .await;
    refused_with(
        json!({"kind": "sceneApply", "sceneId": "x".repeat(129)}),
        copy::SCENE_MISSING,
    )
    .await;
    refused_with(
        json!({"kind": "sceneApply", "layoutPreset": "no-such-layout"}),
        copy::SCENE_MISSING,
    )
    .await;
    // A scene id that isn't a string reads as none: the layout decides.
    refused_with(
        json!({"kind": "sceneApply", "sceneId": 7}),
        copy::SCENE_MISSING,
    )
    .await;
    // A scene the library doesn't hold.
    refused_with(
        json!({"kind": "sceneApply", "sceneId": "gone"}),
        copy::SCENE_FAILED,
    )
    .await;
    // No device list: no screen by that id.
    refused_with(
        json!({"kind": "sceneApply", "screenId": "screen:1"}),
        copy::SCREEN_MISSING,
    )
    .await;
    refused_with(
        json!({"kind": "sceneApply", "sceneId": "default-screen-only", "screenId": "screen:1"}),
        copy::SCREEN_MISSING,
    )
    .await;
}

#[tokio::test]
async fn takeover_banner_and_sound_keys_need_an_id_and_a_backend() {
    let studio = silent_studio();
    let run = |fields: Value| {
        let studio = studio.clone();
        async move { studio.execute_remote_intent(&intent_with(fields)).await }
    };
    assert_eq!(
        run(json!({"kind": "takeoverShow"})).await,
        no(copy::TAKEOVER_MISSING)
    );
    assert_eq!(
        run(json!({"kind": "takeoverShow", "assetId": ""})).await,
        no(copy::TAKEOVER_MISSING)
    );
    // The takeovers don't read: the plain failure, never "missing".
    assert_eq!(
        run(json!({"kind": "takeoverShow", "assetId": "brb"})).await,
        no(copy::FAILED)
    );
    assert_eq!(
        run(json!({"kind": "takeoverHide"})).await,
        no(copy::TAKEOVER_HIDE)
    );

    assert_eq!(
        run(json!({"kind": "bannerShow"})).await,
        no(copy::BANNER_MISSING)
    );
    assert_eq!(
        run(json!({"kind": "bannerToggle"})).await,
        no(copy::BANNER_MISSING)
    );
    // A hide without an id hides them all.
    assert_eq!(
        run(json!({"kind": "bannerHide"})).await,
        no(copy::BANNERS_HIDE)
    );
    assert_eq!(
        run(json!({"kind": "bannerShow", "bannerId": "b1"})).await,
        no(copy::FAILED)
    );

    assert_eq!(
        run(json!({"kind": "soundPlay"})).await,
        no(copy::SOUND_MISSING)
    );
    assert_eq!(
        run(json!({"kind": "soundPlay", "soundId": 3})).await,
        no(copy::SOUND_MISSING)
    );
    // A stop without an id stops every sound.
    assert_eq!(
        run(json!({"kind": "soundStop"})).await,
        no(crate::soundboard::SOUND_ACTION_STOP_ALL)
    );
    assert_eq!(
        run(json!({"kind": "soundPlay", "soundId": "airhorn"})).await,
        no(copy::FAILED)
    );
}

#[tokio::test]
async fn hide_screen_keys_say_the_plain_failure_without_a_backend() {
    let studio = silent_studio();
    for kind in ["screenHide", "screenShow", "screenHideToggle"] {
        assert_eq!(
            studio.execute_remote_intent(&intent(kind)).await,
            no(copy::FAILED),
            "{kind}"
        );
    }
}

#[tokio::test]
async fn a_clip_key_checks_the_length_then_that_something_runs() {
    let studio = silent_studio();
    let run = |fields: Value| {
        let studio = studio.clone();
        async move { studio.execute_remote_intent(&intent_with(fields)).await }
    };
    let invalid = no(crate::studio::clips::INVALID_CLIP_LENGTH_MESSAGE);
    assert_eq!(
        run(json!({"kind": "clipMark", "seconds": 45})).await,
        invalid
    );
    assert_eq!(
        run(json!({"kind": "clipMark", "seconds": "30"})).await,
        invalid
    );
    // No session and the Clips ring off: nothing to clip.
    assert_eq!(run(json!({"kind": "clipMark"})).await, no(copy::CLIPS_OFF));
    assert_eq!(
        run(json!({"kind": "clipMark", "seconds": 60})).await,
        no(copy::CLIPS_OFF)
    );
    assert_eq!(
        run(json!({"kind": "clipMark", "seconds": null})).await,
        no(copy::CLIPS_OFF)
    );
    assert_eq!(
        copy::CLIPS_OFF,
        "Clips are off, and you're not recording or live."
    );
}

#[tokio::test]
async fn a_comment_key_needs_a_message_the_chat_holds() {
    let studio = silent_studio();
    let run = |fields: Value| {
        let studio = studio.clone();
        async move { studio.execute_remote_intent(&intent_with(fields)).await }
    };
    assert_eq!(
        run(json!({"kind": "commentHighlight"})).await,
        no(copy::MESSAGE_MISSING)
    );
    assert_eq!(
        run(json!({"kind": "commentHighlight", "messageId": ""})).await,
        no(copy::MESSAGE_MISSING)
    );
    assert_eq!(
        run(json!({"kind": "commentHighlight", "messageId": "m1"})).await,
        no(crate::chat::highlight::copy::COMMENT_UNAVAILABLE)
    );
    let (ok, message) = run(json!({"kind": "commentHighlightClear"})).await;
    assert!(!ok);
    assert!(message.is_some_and(|message| !message.is_empty()));
}

#[test]
fn nothing_is_published_before_the_bootstrap() {
    let studio = Studio::new(Arc::new(Silent), StudioConfig::default());
    let mut snapshot = ready_snapshot();
    snapshot.bootstrapped = false;
    studio.note_remote_surface(&snapshot);
    assert!(studio.remote_lock().due().is_none());
    snapshot.bootstrapped = true;
    studio.note_remote_surface(&snapshot);
    assert!(studio.remote_lock().due().is_some());
}
