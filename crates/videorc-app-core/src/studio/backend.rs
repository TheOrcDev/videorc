//! What the Studio asks the backend for: the requests behind
//! `use-studio.tsx`'s bootstrap, start, stop and settings effects, as a
//! trait so the state machine runs against a scripted fake in tests and
//! against [`BackendClient`] in the app.

use std::future::Future;

use serde_json::Value;
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendHealth, DeviceList,
    PreviewScreenStartParams, PreviewScreenStatus, RecordingStatus, Scene, SessionDetailListParams,
    SessionHealthEventsPage, SessionListPage, SessionListParams, SessionLogsPage,
    SessionStopParams, SoundboardState, StartSessionParams, StreamScreen,
};

use super::ui_settings_wire::{
    UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams, UiSettingsSnapshot,
};
use crate::client::methods::Method;
use crate::client::methods::{
    AudioProcessingUpdate, DevicesList, HealthPing, PreviewScreenStart, RecordingStatusGet,
    RemoteIntentAck, RemoteIntentAckParams, RemoteSurfacePublish, SceneGet,
    SessionHealthEventsList, SessionLogsList, SessionStart, SessionStop, SessionsList,
    SupportBundleExport,
};
use crate::client::{BackendClient, RpcError};

/// The backend, as the Studio uses it. Every method is one request; the
/// deadlines are the client's per-method ones.
pub trait StudioBackend: Send + Sync + 'static {
    fn health(&self) -> impl Future<Output = Result<BackendHealth, RpcError>> + Send;
    fn devices(&self) -> impl Future<Output = Result<DeviceList, RpcError>> + Send;
    fn recording_status(&self) -> impl Future<Output = Result<RecordingStatus, RpcError>> + Send;
    fn scene(&self) -> impl Future<Output = Result<Scene, RpcError>> + Send;
    fn settings_get(
        &self,
        params: UiSettingsGetParams,
    ) -> impl Future<Output = Result<UiSettingsSnapshot, RpcError>> + Send;
    fn settings_set(
        &self,
        params: UiSettingsSetParams,
    ) -> impl Future<Output = Result<UiSettingsChange, RpcError>> + Send;
    fn session_start(
        &self,
        params: StartSessionParams,
    ) -> impl Future<Output = Result<RecordingStatus, RpcError>> + Send;
    /// S3.6b: `session.start` with the chosen recordings folder's
    /// capability in `output.outputDirectoryCapability` (the backend swaps
    /// it for the path; the Studio's credential never sends a path). A
    /// backend without it (a test fake) starts as [`Self::session_start`].
    fn session_start_into(
        &self,
        params: StartSessionParams,
        folder_capability: Option<String>,
    ) -> impl Future<Output = Result<RecordingStatus, RpcError>> + Send {
        let _ = folder_capability;
        self.session_start(params)
    }
    fn session_stop(
        &self,
        params: SessionStopParams,
    ) -> impl Future<Output = Result<RecordingStatus, RpcError>> + Send;
    /// Plan 220 S2.4c: the live microphone update for a running session
    /// (`requestRemoteMicrophoneMute` while a session runs).
    fn audio_processing_update(
        &self,
        params: AudioProcessingUpdateParams,
    ) -> impl Future<Output = Result<AudioProcessingUpdateResult, RpcError>> + Send;
    /// Plan 220 S2.4c: the ack of a relayed remote intent.
    fn remote_intent_ack(
        &self,
        params: RemoteIntentAckParams,
    ) -> impl Future<Output = Result<(), RpcError>> + Send;
    /// Plan 220 S2.4c: the remote surface the deck keys render.
    fn remote_surface_publish(
        &self,
        snapshot: Value,
    ) -> impl Future<Output = Result<(), RpcError>> + Send;
    /// Plan 220 S2.6c: the screen capture's start with the exclusion list,
    /// applied in place to a running capture (`preview.screen.start`).
    fn preview_screen_start(
        &self,
        params: PreviewScreenStartParams,
    ) -> impl Future<Output = Result<PreviewScreenStatus, RpcError>> + Send;
    /// Plan 220 S3.0f: the Library's first page, for the recovery after a
    /// reconnect (`recoverSessionRuntime`). A backend without a Library (a
    /// test fake) answers nothing, and the recovery reads the status alone.
    fn sessions_list(
        &self,
        params: SessionListParams,
    ) -> impl Future<Output = Result<SessionListPage, RpcError>> + Send {
        let _ = params;
        async { Err(RpcError::not_connected(SessionsList::NAME)) }
    }
    /// Plan 220 S3.0f: a session's health events, for the same recovery.
    fn session_health_events(
        &self,
        params: SessionDetailListParams,
    ) -> impl Future<Output = Result<SessionHealthEventsPage, RpcError>> + Send {
        let _ = params;
        async { Err(RpcError::not_connected(SessionHealthEventsList::NAME)) }
    }
    /// Plan 220 S3.0g: a session's log lines, for Health's recording log.
    fn session_logs(
        &self,
        params: SessionDetailListParams,
    ) -> impl Future<Output = Result<SessionLogsPage, RpcError>> + Send {
        let _ = params;
        async { Err(RpcError::not_connected(SessionLogsList::NAME)) }
    }
    /// Plan 220 S3.0g: one of Health's telemetry reads by its method name
    /// (`diagnostics.stats`, `preview.live.status` …), as the backend's
    /// JSON. A backend without them (a test fake) answers nothing.
    fn telemetry_read(
        &self,
        method: &'static str,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.0g: `diagnostics.supportBundle.export`.
    fn support_bundle_export(
        &self,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async { Err(RpcError::not_connected(SupportBundleExport::NAME)) }
    }
    /// Plan 220 S3.1a: `agents.stop`, the Session line's Stop; the answer
    /// is the agents' new status.
    fn agents_stop(&self) -> impl Future<Output = Result<Value, RpcError>> + Send {
        async { Err(RpcError::not_connected(super::AGENTS_STOP_METHOD)) }
    }
    /// Plan 220 S3.1f: `screens.list`, every takeover. A backend without
    /// them (a test fake) answers nothing.
    fn screens_list(&self) -> impl Future<Output = Result<Vec<StreamScreen>, RpcError>> + Send {
        async { Err(RpcError::not_connected("screens.list")) }
    }
    /// Plan 220 S3.1f: `screens.active`, the takeover on air or none.
    fn screens_active(
        &self,
    ) -> impl Future<Output = Result<Option<StreamScreen>, RpcError>> + Send {
        async { Err(RpcError::not_connected("screens.active")) }
    }
    /// Plan 220 S3.1f: `screens.activate`; the answer is the takeover.
    fn screens_activate(
        &self,
        screen_id: &str,
    ) -> impl Future<Output = Result<StreamScreen, RpcError>> + Send {
        let _ = screen_id;
        async { Err(RpcError::not_connected("screens.activate")) }
    }
    /// Plan 220 S3.1f: `screens.clear`.
    fn screens_clear(&self) -> impl Future<Output = Result<(), RpcError>> + Send {
        async { Err(RpcError::not_connected("screens.clear")) }
    }
    /// Plan 220 S3.1f: `sounds.list`, the whole soundboard.
    fn sounds_list(&self) -> impl Future<Output = Result<SoundboardState, RpcError>> + Send {
        async { Err(RpcError::not_connected("sounds.list")) }
    }
    /// Plan 220 S3.1f: `sounds.play`, `sounds.press` or `sounds.stop`
    /// ([`super::SoundAction::request`]).
    fn sounds_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.1g: live chat's requests by name (`liveChat.status`,
    /// `comments.highlight.status`, `.set` and `.clear`, `chatImages.cache`,
    /// `overlays.layout.get`), as the backend's JSON. A backend without them
    /// (a test fake) answers nothing.
    fn chat_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.1c: the session's sources (`session.sources.get`,
    /// `session.source.switch`), as the backend's JSON. A backend without
    /// them (a test fake) answers nothing.
    fn sources_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.1e: a scene switch's requests by name
    /// (`scene.layout.apply_preview` and `.apply_live`,
    /// `sources.resolve_app_window`, and the live proof's
    /// `compositor.status` and `diagnostics.stats`), as the backend's JSON.
    fn scene_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.5a: the Livestream page's requests by name (the platform
    /// accounts, the stream keys, X Live), as the backend's JSON. A backend
    /// without them (a test fake) answers nothing.
    fn livestream_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.6c: the performance check's requests by name
    /// (`performance.check.get`, `.run`), as the backend's JSON. A backend
    /// without them (a test fake) answers nothing.
    fn performance_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 220 S3.9a: the captions' requests by name (`captions.start`,
    /// `.stop`, `.status.get`, `.overlay.set`, `.overlay.clear`,
    /// `.style.set`), as the backend's JSON. A backend without them (a test
    /// fake) answers nothing.
    fn captions_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
    /// Plan 260 S1.6a part 6c: the Clips ring's and the clip action's
    /// requests by name (`replay.status`, `clip.mark`), as the backend's
    /// JSON. A backend without them (a test fake) answers nothing, so the
    /// ring is never armed (Electron's failed `replay.status` read).
    fn clips_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send {
        let _ = params;
        async move { Err(RpcError::not_connected(method)) }
    }
}

impl StudioBackend for BackendClient {
    async fn health(&self) -> Result<BackendHealth, RpcError> {
        self.call::<HealthPing>(&()).await
    }

    async fn devices(&self) -> Result<DeviceList, RpcError> {
        self.call::<DevicesList>(&()).await
    }

    async fn recording_status(&self) -> Result<RecordingStatus, RpcError> {
        self.call::<RecordingStatusGet>(&()).await
    }

    async fn scene(&self) -> Result<Scene, RpcError> {
        self.call::<SceneGet>(&()).await
    }

    async fn settings_get(
        &self,
        params: UiSettingsGetParams,
    ) -> Result<UiSettingsSnapshot, RpcError> {
        // L2's S1.4 adds the method to the protocol and the backend; today's
        // backend answers it as unknown, and the Studio keeps the defaults.
        let params = serde_json::to_value(params).unwrap_or(Value::Null);
        read_json(
            "ui.settings.get",
            self.request("ui.settings.get", params).await?,
        )
    }

    async fn settings_set(
        &self,
        params: UiSettingsSetParams,
    ) -> Result<UiSettingsChange, RpcError> {
        let params = serde_json::to_value(params).unwrap_or(Value::Null);
        read_json(
            "ui.settings.set",
            self.request("ui.settings.set", params).await?,
        )
    }

    async fn session_start(&self, params: StartSessionParams) -> Result<RecordingStatus, RpcError> {
        self.call::<SessionStart>(&params).await
    }

    async fn session_start_into(
        &self,
        params: StartSessionParams,
        folder_capability: Option<String>,
    ) -> Result<RecordingStatus, RpcError> {
        let Some(capability) = folder_capability else {
            return self.call::<SessionStart>(&params).await;
        };
        let mut value = serde_json::to_value(&params).map_err(|error| {
            RpcError::new(
                SessionStart::NAME,
                crate::client::codes::INVALID_PARAMS,
                error.to_string(),
            )
        })?;
        value["output"]["outputDirectoryCapability"] = Value::String(capability);
        let answer = self.request(SessionStart::NAME, value).await?;
        crate::client::socket::decode_result::<SessionStart>(answer)
    }

    async fn session_stop(&self, params: SessionStopParams) -> Result<RecordingStatus, RpcError> {
        self.call::<SessionStop>(&params).await
    }

    async fn audio_processing_update(
        &self,
        params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        self.call::<AudioProcessingUpdate>(&params).await
    }

    async fn remote_intent_ack(&self, params: RemoteIntentAckParams) -> Result<(), RpcError> {
        self.call::<RemoteIntentAck>(&params).await.map(|_| ())
    }

    async fn remote_surface_publish(&self, snapshot: Value) -> Result<(), RpcError> {
        self.call::<RemoteSurfacePublish>(&snapshot)
            .await
            .map(|_| ())
    }

    async fn preview_screen_start(
        &self,
        params: PreviewScreenStartParams,
    ) -> Result<PreviewScreenStatus, RpcError> {
        self.call::<PreviewScreenStart>(&params).await
    }

    async fn sessions_list(&self, params: SessionListParams) -> Result<SessionListPage, RpcError> {
        self.call::<SessionsList>(&params).await
    }

    async fn session_health_events(
        &self,
        params: SessionDetailListParams,
    ) -> Result<SessionHealthEventsPage, RpcError> {
        self.call::<SessionHealthEventsList>(&params).await
    }

    async fn session_logs(
        &self,
        params: SessionDetailListParams,
    ) -> Result<SessionLogsPage, RpcError> {
        self.call::<SessionLogsList>(&params).await
    }

    async fn telemetry_read(&self, method: &'static str) -> Result<Value, RpcError> {
        self.request(method, Value::Null).await
    }

    async fn support_bundle_export(&self, params: Value) -> Result<Value, RpcError> {
        self.call::<SupportBundleExport>(&params).await
    }

    async fn agents_stop(&self) -> Result<Value, RpcError> {
        self.request(super::AGENTS_STOP_METHOD, Value::Null).await
    }

    async fn screens_list(&self) -> Result<Vec<StreamScreen>, RpcError> {
        read_json(
            "screens.list",
            self.request("screens.list", Value::Null).await?,
        )
    }

    async fn screens_active(&self) -> Result<Option<StreamScreen>, RpcError> {
        read_json(
            "screens.active",
            self.request("screens.active", Value::Null).await?,
        )
    }

    async fn screens_activate(&self, screen_id: &str) -> Result<StreamScreen, RpcError> {
        read_json(
            "screens.activate",
            self.request(
                "screens.activate",
                serde_json::json!({ "screenId": screen_id }),
            )
            .await?,
        )
    }

    async fn screens_clear(&self) -> Result<(), RpcError> {
        self.request("screens.clear", Value::Null).await.map(|_| ())
    }

    async fn sounds_list(&self) -> Result<SoundboardState, RpcError> {
        read_json(
            "sounds.list",
            self.request("sounds.list", Value::Null).await?,
        )
    }

    async fn sounds_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn chat_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn scene_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn livestream_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn performance_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn sources_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn captions_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.request(method, params).await
    }

    async fn clips_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.request(method, params).await
    }
}

/// An answer as its wire type, or `invalid-response` (the typed client's
/// rule for a result that does not match).
pub(super) fn read_json<T: serde::de::DeserializeOwned>(
    method: &str,
    value: Value,
) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|error| {
        RpcError::new(
            method,
            crate::client::codes::INVALID_RESPONSE,
            format!("The {method} answer did not read: {error}"),
        )
    })
}
