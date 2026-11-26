use serde_json::json;
use videorc_protocol::{RecordingState, RecordingStatus};

use super::*;
use crate::studio::session::initial_status;
use crate::studio::test_support::{ready_snapshot, set_status};

fn message(id: &str) -> LiveChatMessage {
    LiveChatMessage {
        id: id.into(),
        session_id: "live-1".into(),
        event_type: "message".into(),
        message_text: format!("hello {id}"),
        ..LiveChatMessage::default()
    }
}

fn layout() -> Value {
    json!({
        "chat": {
            "showOnStream": true,
            "showInRecording": false,
            "horizontal": { "x": 0.02, "y": 0.04, "w": 0.3, "h": 0.44 },
            "vertical": { "x": 0.1, "y": 0.05, "w": 0.8, "h": 0.3 }
        }
    })
}

fn status(state: RecordingState, stream: bool) -> RecordingStatus {
    RecordingStatus {
        state,
        session_id: Some("live-1".to_string()),
        stream_url: stream.then(|| "rtmp://127.0.0.1/live".to_string()),
        ..initial_status()
    }
}

/// Electron's `chat-overlay.test.ts` 'asks the backend to draw the box with
/// the placed rect': the same keys, the same values.
#[test]
fn the_set_params_are_electrons() {
    let (one, two) = (message("1"), message("2"));
    let layout = layout();
    let paint = paint_of(None, (1920, 1080), Some(&layout));
    assert_eq!(
        set_params(&[&one, &two], &paint),
        json!({
            "messageIds": ["1", "2"],
            "canvasWidth": 1920,
            "canvasHeight": 1080,
            "rect": layout["chat"]["horizontal"],
        })
    );

    // 'sends the portrait box when the session has a vertical leg'.
    let canvases = Canvases {
        horizontal: None,
        vertical: Some((1080, 1920)),
    };
    let paint = paint_of(Some(&canvases), (1920, 1080), Some(&layout));
    assert_eq!(
        set_params(&[&one, &two], &paint),
        json!({
            "messageIds": ["1", "2"],
            "canvasWidth": 1920,
            "canvasHeight": 1080,
            "rect": layout["chat"]["horizontal"],
            "verticalRect": layout["chat"]["vertical"],
        })
    );
}

#[test]
fn a_rect_the_layout_lacks_is_left_out() {
    let one = message("1");
    let paint = paint_of(None, (1920, 1080), None);
    assert_eq!(
        set_params(&[&one], &paint),
        json!({ "messageIds": ["1"], "canvasWidth": 1920, "canvasHeight": 1080 })
    );
}

#[test]
fn the_session_canvas_wins_over_the_stream_settings() {
    let layout = layout();
    // With a vertical leg the horizontal stream is the session's own size.
    let canvases = Canvases::read(&json!({
        "horizontal": { "width": 2560, "height": 1440 },
        "vertical": { "width": 1080, "height": 1920 }
    }));
    assert_eq!(
        canvases,
        Canvases {
            horizontal: Some((2560, 1440)),
            vertical: Some((1080, 1920)),
        }
    );
    let paint = paint_of(Some(&canvases), (1920, 1080), Some(&layout));
    assert_eq!((paint.stream.width, paint.stream.height), (2560, 1440));
    assert_eq!(paint.stream.rect, layout["chat"]["horizontal"]);

    // A portrait stream canvas takes the vertical rect.
    let paint = paint_of(None, (1080, 1920), Some(&layout));
    assert_eq!(paint.stream.rect, layout["chat"]["vertical"]);
    assert!(paint.vertical.is_none());

    // Nothing named: the stream settings' canvas.
    assert_eq!(Canvases::read(&json!({})), Canvases::default());
}

#[test]
fn the_box_is_on_while_a_livestream_or_a_recording_is_on_air_and_a_switch_is_on() {
    let layout = layout();
    let mut snapshot = ready_snapshot();
    assert!(!overlay_on(&snapshot, Some(&layout)), "idle");

    set_status(&mut snapshot, status(RecordingState::Streaming, true));
    assert!(overlay_on(&snapshot, Some(&layout)), "live");
    assert!(!overlay_on(&snapshot, None), "no layout read");
    let mut off = layout.clone();
    off["chat"]["showOnStream"] = json!(false);
    assert!(!overlay_on(&snapshot, Some(&off)), "both switches off");
    let mut recording_only = off.clone();
    recording_only["chat"]["showInRecording"] = json!(true);
    assert!(overlay_on(&snapshot, Some(&recording_only)));

    set_status(&mut snapshot, status(RecordingState::Recording, false));
    assert!(overlay_on(&snapshot, Some(&layout)), "a recording");

    let mut ring = status(RecordingState::Recording, false);
    ring.replay_only = true;
    set_status(&mut snapshot, ring);
    assert!(!overlay_on(&snapshot, Some(&layout)), "a Clips ring");

    set_status(&mut snapshot, status(RecordingState::Streaming, true));
    snapshot.connection = crate::studio::Connection::Waiting;
    assert!(
        !overlay_on(&snapshot, Some(&layout)),
        "not connected: stale"
    );
}
