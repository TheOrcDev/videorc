//! Plan 220 S3.0f: the session's toasts, driven through the Studio from a
//! scripted backend. Every answer is queued and every event handed in by
//! the test; what the Studio posts on `notices()` is asserted word for word,
//! with its id, its duration and its buttons.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::broadcast;
use videorc_app_core::Logger;
use videorc_app_core::client::methods::RemoteIntentAckParams;
use videorc_app_core::client::{BackendEvent, RpcError};
use videorc_app_core::notices::{
    NoticeAction, NoticeButton, NoticeClose, NoticeCommand, NoticeLifetime,
};
use videorc_app_core::studio::{
    StartOutcome, StopOrigin, StopOutcome, Studio, StudioBackend, StudioConfig,
};
use videorc_protocol::ui_settings::{
    UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams, UiSettingsSnapshot,
};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendConnection, BackendHealth,
    DeviceList, HealthEvent, HealthLevel, PreviewScreenStartParams, PreviewScreenStatus,
    RecordingFinalizationEvent, RecordingFinalizationState, RecordingState, RecordingStatus, Scene,
    SessionDetailListParams, SessionHealthEventsPage, SessionListPage, SessionListParams,
    SessionStopParams, StartSessionParams, ToolStatus,
};

#[derive(Default)]
struct Script {
    start_answers: VecDeque<Result<RecordingStatus, RpcError>>,
    status_answers: VecDeque<RecordingStatus>,
    sessions: Vec<Value>,
    health_events: Vec<HealthEvent>,
    calls: Vec<String>,
}

struct Scripted {
    script: Mutex<Script>,
}

impl Scripted {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(Script::default()),
        })
    }

    fn with(&self, edit: impl FnOnce(&mut Script)) {
        edit(&mut self.script.lock().unwrap());
    }

    fn note(&self, method: &str) {
        self.script.lock().unwrap().calls.push(method.to_string());
    }

    fn calls(&self) -> Vec<String> {
        self.script.lock().unwrap().calls.clone()
    }
}

impl StudioBackend for Scripted {
    async fn health(&self) -> Result<BackendHealth, RpcError> {
        Ok(BackendHealth {
            status: "ok".to_string(),
            version: "0.0.0-test".to_string(),
            platform: "test".to_string(),
            ffmpeg: ToolStatus {
                path: "ffmpeg".to_string(),
                available: true,
                version: None,
                message: None,
            },
            database_path: String::new(),
            secret_store_backend: "test".to_string(),
        })
    }

    async fn devices(&self) -> Result<DeviceList, RpcError> {
        Ok(DeviceList {
            devices: Vec::new(),
            warnings: Vec::new(),
        })
    }

    async fn recording_status(&self) -> Result<RecordingStatus, RpcError> {
        let next = self.script.lock().unwrap().status_answers.pop_front();
        Ok(next.unwrap_or_else(|| status(RecordingState::Idle, None)))
    }

    async fn scene(&self) -> Result<Scene, RpcError> {
        const HIGH_RISK: &str = include_str!("../../../protocol-fixtures/high-risk-contracts.json");
        let fixture: Value = serde_json::from_str(HIGH_RISK).unwrap();
        Ok(serde_json::from_value(fixture["scene"]["wire"].clone()).unwrap())
    }

    async fn settings_get(&self, _: UiSettingsGetParams) -> Result<UiSettingsSnapshot, RpcError> {
        Ok(UiSettingsSnapshot {
            entries: Default::default(),
            revision: 1,
            local_storage_migrated: true,
        })
    }

    async fn settings_set(
        &self,
        params: UiSettingsSetParams,
    ) -> Result<UiSettingsChange, RpcError> {
        Ok(UiSettingsChange {
            revision: 2,
            put: params.put,
            delete: params.delete,
            writer: params.writer,
        })
    }

    async fn session_start(&self, _: StartSessionParams) -> Result<RecordingStatus, RpcError> {
        self.note("session.start");
        let next = self.script.lock().unwrap().start_answers.pop_front();
        next.unwrap_or_else(|| Ok(status(RecordingState::Recording, Some("s1"))))
    }

    async fn session_stop(&self, _: SessionStopParams) -> Result<RecordingStatus, RpcError> {
        self.note("session.stop");
        Ok(status(RecordingState::Stopping, Some("s1")))
    }

    async fn audio_processing_update(
        &self,
        params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        Err(RpcError::not_connected(&params.session_id))
    }

    async fn remote_intent_ack(&self, _: RemoteIntentAckParams) -> Result<(), RpcError> {
        Ok(())
    }

    async fn remote_surface_publish(&self, _: Value) -> Result<(), RpcError> {
        Ok(())
    }

    async fn preview_screen_start(
        &self,
        _: PreviewScreenStartParams,
    ) -> Result<PreviewScreenStatus, RpcError> {
        Err(RpcError::not_connected("preview.screen.start"))
    }

    async fn sessions_list(&self, params: SessionListParams) -> Result<SessionListPage, RpcError> {
        self.note(&format!("sessions.list {}", params.limit));
        let rows = self.script.lock().unwrap().sessions.clone();
        Ok(serde_json::from_value(json!({ "items": rows })).unwrap())
    }

    async fn session_health_events(
        &self,
        params: SessionDetailListParams,
    ) -> Result<SessionHealthEventsPage, RpcError> {
        self.note(&format!(
            "sessions.healthEvents.list {} {}",
            params.session_id, params.limit
        ));
        let events = self.script.lock().unwrap().health_events.clone();
        Ok(SessionHealthEventsPage {
            events,
            next_cursor: None,
        })
    }
}

fn status(state: RecordingState, session_id: Option<&str>) -> RecordingStatus {
    RecordingStatus {
        state,
        session_id: session_id.map(str::to_string),
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

fn live(session_id: &str) -> RecordingStatus {
    RecordingStatus {
        stream_url: Some("rtmp://127.0.0.1:1935/live".to_string()),
        ..status(RecordingState::Recording, Some(session_id))
    }
}

fn health(code: &str, level: HealthLevel, session_id: &str, message: &str) -> HealthEvent {
    HealthEvent {
        id: format!("h-{code}"),
        session_id: Some(session_id.to_string()),
        level,
        code: code.to_string(),
        message: message.to_string(),
        permission_pane: None,
        created_at: "2026-11-09T00:00:00Z".to_string(),
    }
}

fn ready() -> BackendEvent {
    BackendEvent::Ready(BackendConnection {
        host: "127.0.0.1".to_string(),
        port: 1,
        token: "t".to_string(),
        pid: 42,
        parent_pid: None,
    })
}

fn untyped(event: &str, payload: Value) -> BackendEvent {
    BackendEvent::Untyped {
        event: event.to_string(),
        payload,
    }
}

fn studio_on(backend: &Arc<Scripted>) -> Arc<Studio<Scripted>> {
    Arc::new(Studio::new(
        backend.clone(),
        StudioConfig {
            logger: Logger::silent(),
            writer_id: "studio:test".to_string(),
            ..StudioConfig::default()
        },
    ))
}

fn drain(notices: &mut broadcast::Receiver<NoticeCommand>) -> Vec<NoticeCommand> {
    let mut out = Vec::new();
    while let Ok(command) = notices.try_recv() {
        out.push(command);
    }
    out
}

/// One line per command, so a sequence reads as it shows: `show <kind>
/// <id> "<title>" | "<description>" [<duration>] (<action>, <cancel>)` or
/// `dismiss <id>`.
fn lines(commands: &[NoticeCommand]) -> Vec<String> {
    commands
        .iter()
        .map(|command| match command {
            NoticeCommand::Dismiss(id) => format!("dismiss {id}"),
            NoticeCommand::Show(notice) => {
                let label = |button: &Option<NoticeButton>| {
                    button
                        .as_ref()
                        .map(|button| button.label.clone())
                        .unwrap_or_default()
                };
                format!(
                    "show {:?} {} \"{}\" | \"{}\" [{}] ({}, {})",
                    notice.kind,
                    notice.id.as_deref().unwrap_or("-"),
                    notice.title,
                    notice.description.as_deref().unwrap_or(""),
                    match notice.lifetime {
                        NoticeLifetime::UntilClosed => "until closed".to_string(),
                        NoticeLifetime::For(duration) => format!("{} ms", duration.as_millis()),
                    },
                    label(&notice.action),
                    label(&notice.cancel),
                )
            }
        })
        .collect()
}

#[tokio::test]
async fn a_take_ends_with_recording_saved_and_the_mp4_toasts() {
    let backend = Scripted::new();
    let studio = studio_on(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;
    assert!(
        drain(&mut notices).is_empty(),
        "a quiet launch toasts nothing"
    );

    // Record: the attempt clears the last refusal and the runtime notices.
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(
        lines(&drain(&mut notices)),
        [
            "dismiss session-start-failed",
            "dismiss recording-stopped-unexpectedly",
            "dismiss microphone-input-lost",
            // The new session (SessionStarted) clears them too.
            "dismiss recording-stopped-unexpectedly",
            "dismiss microphone-input-lost",
        ]
    );

    // A recording stops at once; the export starts before the Idle.
    assert!(matches!(
        studio.request_stop(StopOrigin::Button).await,
        StopOutcome::Stopped(true)
    ));
    drain(&mut notices);
    let finalizing = |state, percent| RecordingFinalizationEvent {
        session_id: "s1".to_string(),
        state,
        progress_percent: percent,
        mp4_path: None,
        output_path: None,
        duration_ms: None,
        file_size_bytes: None,
        error: None,
        interruption_recovery: None,
        updated_at: "2026-11-09T00:00:00Z".to_string(),
    };
    studio
        .handle_event(BackendEvent::RecordingFinalization(Box::new(finalizing(
            RecordingFinalizationState::Finalizing,
            Some(0),
        ))))
        .await;
    let mut saved = status(RecordingState::Idle, Some("s1"));
    saved.output_path = Some("/tmp/take.mkv".to_string());
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(saved)))
        .await;
    let commands = drain(&mut notices);
    assert_eq!(
        lines(&commands),
        [
            "show Loading finalization-s1 \"Saving MP4…\" | \"Your recording is safe. Long recordings can take several minutes to save as MP4.\" [until closed] (, )",
            "dismiss end-livestream-armed",
            "dismiss stream-delivery",
            "dismiss stream-uplink",
        ]
    );

    studio
        .handle_event(BackendEvent::RecordingFinalization(Box::new(finalizing(
            RecordingFinalizationState::Finalizing,
            Some(57),
        ))))
        .await;
    studio
        .handle_event(BackendEvent::RecordingFinalization(Box::new(finalizing(
            RecordingFinalizationState::Finalized,
            None,
        ))))
        .await;
    let reveal = videorc_app_core::notices::reveal_in_file_manager_label();
    assert_eq!(
        lines(&drain(&mut notices)),
        [
            "show Loading finalization-s1 \"Saving MP4 · 57%\" | \"Your recording is safe. Long recordings can take several minutes to save as MP4.\" [until closed] (, )".to_string(),
            format!("show Success finalization-s1 \"MP4 ready\" | \"\" [15000 ms] ({reveal}, )"),
        ]
    );
}

#[tokio::test]
async fn a_refused_start_toasts_retry_and_a_dismiss_takes_it_away() {
    let backend = Scripted::new();
    backend.with(|script| {
        script.start_answers.push_back(Err(RpcError::new(
            "session.start",
            "no-source",
            "No video source is selected.",
        )))
    });
    let studio = studio_on(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;
    assert!(matches!(
        studio.start_recording().await,
        StartOutcome::Refused { .. }
    ));
    let commands = drain(&mut notices);
    let last = lines(&commands).pop().unwrap();
    assert_eq!(
        last,
        "show Error session-start-failed \"Couldn't start recording\" | \"No video source is selected.\" [until closed] (Retry, Copy)"
    );
    let NoticeCommand::Show(toast) = commands.last().unwrap() else {
        panic!()
    };
    assert_eq!(toast.on_close, Some(NoticeClose::DismissStartFailure));
    assert_eq!(
        toast.cancel.as_ref().map(|button| &button.action),
        Some(&NoticeAction::Copy {
            text: "Couldn't start recording\nNo video source is selected.".to_string()
        })
    );
    // The Session line's dismiss takes the toast with it.
    studio.dismiss_start_failure();
    assert_eq!(
        lines(&drain(&mut notices)),
        ["dismiss session-start-failed"]
    );
    assert_eq!(studio.snapshot().session.start_failure, None);
}

#[tokio::test]
async fn a_livestream_arms_the_hotkey_and_its_news_ends_with_it() {
    let backend = Scripted::new();
    backend.with(|script| script.start_answers.push_back(Ok(live("s2"))));
    let studio = studio_on(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(live("s2"))))
        .await;
    drain(&mut notices);

    // The global hotkey arms first.
    assert_eq!(
        studio.request_stop(StopOrigin::GlobalHotkey).await,
        StopOutcome::Armed
    );
    assert_eq!(
        lines(&drain(&mut notices)),
        [
            "show Message end-livestream-armed \"Press again to end the livestream\" | \"\" [2000 ms] (, )"
        ]
    );

    // The destinations' news.
    let targets = |twitch: &str, youtube: &str| {
        untyped(
            "stream.targets",
            json!({
                "sessionId": "s2",
                "targets": [
                    {"targetId": "twitch", "platform": "twitch", "label": "Twitch", "state": twitch},
                    {"targetId": "yt", "platform": "youtube", "label": "YouTube", "state": youtube}
                ]
            }),
        )
    };
    studio.handle_event(targets("live", "live")).await;
    studio.handle_event(targets("reconnecting", "live")).await;
    studio.handle_event(targets("live", "live")).await;
    assert!(
        drain(&mut notices).is_empty(),
        "stream.targets news is an L6 store entry (#1869)"
    );

    // Plan 218: a choppy stream and a thin uplink.
    for (code, message) in [
        ("stream-delivery-degraded", "The stream runs at 22 fps."),
        ("stream-bitrate-lowered", "Now 4,500 kbps."),
    ] {
        studio
            .handle_event(BackendEvent::HealthEvent(Box::new(health(
                code,
                HealthLevel::Warn,
                "s2",
                message,
            ))))
            .await;
    }
    assert!(
        drain(&mut notices).is_empty(),
        "live-output health news is an L6 store entry (#1865)"
    );

    // The microphone drops mid-stream.
    studio
        .handle_event(BackendEvent::HealthEvent(Box::new(health(
            "microphone-input-lost",
            HealthLevel::Warn,
            "s2",
            "The microphone stopped.",
        ))))
        .await;
    assert!(
        drain(&mut notices).is_empty(),
        "microphone loss is an L6 store entry (#1859)"
    );
    assert!(studio.snapshot().session.microphone_notice.is_some());

    // The livestream (with its recording) ends.
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Stopping,
            Some("s2"),
        ))))
        .await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s2"),
        ))))
        .await;
    assert_eq!(
        lines(&drain(&mut notices)),
        [
            "dismiss end-livestream-armed",
            "dismiss stream-delivery",
            "dismiss stream-uplink",
        ]
    );
    assert_eq!(
        studio
            .snapshot()
            .session
            .microphone_notice
            .as_ref()
            .map(|notice| notice.phase),
        Some(videorc_app_core::notices::MicrophonePhase::Ended)
    );
}

#[tokio::test]
async fn a_session_that_died_while_away_comes_back_from_the_library() {
    let backend = Scripted::new();
    let studio = studio_on(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Recording,
            Some("s5"),
        ))))
        .await;
    studio
        .handle_event(BackendEvent::ConnectionClosed {
            reason: "the backend restarted".to_string(),
        })
        .await;
    drain(&mut notices);

    // The restarted backend is idle; its Library says s5 failed.
    backend.with(|script| {
        script.sessions = vec![json!({
            "id": "s5",
            "title": "Take",
            "startedAt": "2026-11-09T00:00:00Z",
            "status": "failed",
            "mode": "record",
            "outputPath": "/tmp/s5.mkv",
            "healthEventCount": 1,
            "sessionLogCount": 0,
            "aiArtifactCount": 0,
            "commentCount": 0
        })];
        script.health_events = vec![health(
            "recording-encoder-failed",
            HealthLevel::Error,
            "s5",
            "The encoder quit.",
        )];
    });
    studio.handle_event(ready()).await;
    assert!(backend.calls().contains(&"sessions.list 50".to_string()));
    assert!(
        backend
            .calls()
            .contains(&"sessions.healthEvents.list s5 120".to_string())
    );
    let commands = drain(&mut notices);
    let reveal = videorc_app_core::notices::reveal_in_file_manager_label();
    assert_eq!(
        lines(&commands),
        [
            // The reconnect's Idle ends the session that ran.
            "dismiss end-livestream-armed".to_string(),
            "dismiss microphone-input-lost".to_string(),
            format!(
                "show Error recording-stopped-unexpectedly \"Recording stopped unexpectedly\" | \"The encoder quit.\" [until closed] (Open in Library, {reveal})"
            ),
        ]
    );
    let notice = studio
        .snapshot()
        .session
        .notice
        .expect("the recovered notice");
    assert_eq!(notice.session_id.as_deref(), Some("s5"));
    assert_eq!(notice.output_path.as_deref(), Some("/tmp/s5.mkv"));

    // Dismissing it takes both runtime toasts away.
    studio.dismiss_notice();
    assert_eq!(
        lines(&drain(&mut notices)),
        [
            "dismiss recording-stopped-unexpectedly",
            "dismiss microphone-input-lost"
        ]
    );
}

#[tokio::test]
async fn the_clips_and_marks_toast_from_their_events() {
    let backend = Scripted::new();
    let studio = studio_on(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;
    studio
        .handle_event(untyped(
            "replay.saved",
            json!({
                "saveId": "c1", "sessionId": "s1", "replaySessionId": "r1",
                "path": "/tmp/clip.mp4", "seconds": 30, "coveredSeconds": 30.0, "complete": true
            }),
        ))
        .await;
    studio
        .handle_event(untyped(
            "replay.saveFailed",
            json!({"saveId": "c2", "reason": "disk", "message": "The disk is full."}),
        ))
        .await;
    studio
        .handle_event(untyped(
            "replay.state",
            json!({"state": "error", "seconds": 30, "bufferedSeconds": 0.0, "reason": "The session failed."}),
        ))
        .await;
    studio
        .handle_event(untyped(
            "replay.state",
            json!({"state": "on", "seconds": 30, "bufferedSeconds": 12.0}),
        ))
        .await;
    studio
        .handle_event(untyped(
            "clip.marked",
            json!({"sessionId": "s1", "atSeconds": 65.0, "source": "voice", "saved": true}),
        ))
        .await;
    // A payload that does not read toasts nothing.
    studio
        .handle_event(untyped("clip.marked", json!({"nope": true})))
        .await;
    let reveal = videorc_app_core::notices::reveal_in_file_manager_label();
    assert_eq!(
        lines(&drain(&mut notices)),
        [
            format!("show Success clips-saved-c1 \"Clip saved\" | \"Last 0:30.\" [12000 ms] ({reveal}, )"),
            "show Error clips-failed-c2 \"Couldn't save the clip\" | \"The disk is full.\" [10000 ms] (Copy, )".to_string(),
            "show Warning clips \"Clips stopped\" | \"The session failed.\" [10000 ms] (, )".to_string(),
            // Not live: no stream report to point at.
            "show Success clip-marked \"Clip marked at 1:05\" | \"\" [4000 ms] (, )".to_string(),
        ]
    );
}
