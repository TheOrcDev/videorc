use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCommand {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerResponse {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConnection {
    pub host: String,
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendHealth {
    pub status: String,
    pub version: String,
    pub platform: String,
    pub ffmpeg: ToolStatus,
    pub database_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub path: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendLogEvent {
    pub level: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub devices: Vec<Device>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    pub status: DeviceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceKind {
    Screen,
    Window,
    Camera,
    Microphone,
    SystemAudio,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceStatus {
    Available,
    Unavailable,
    PermissionRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub state: RecordingState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_tracks: Vec<AudioTrack>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<RecordingPipelineStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingState {
    Idle,
    Starting,
    Recording,
    Streaming,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPipelineStatus {
    pub container: RecordingContainer,
    pub finalization: RecordingFinalizationState,
    pub stages: Vec<RecordingPipelineStageStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPipelineStageStatus {
    pub stage: RecordingPipelineStage,
    pub state: RecordingPipelineStageState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingPipelineStage {
    Capture,
    Render,
    VideoEncoder,
    AudioEncoder,
    Muxer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingPipelineStageState {
    Pending,
    Starting,
    Running,
    Finalizing,
    Finished,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingFinalizationState {
    None,
    Finalizing,
    Finalized,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingContainer {
    None,
    Mkv,
    Flv,
    Tee,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub id: String,
    pub label: String,
    pub source: AudioTrackSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AudioTrackSource {
    Microphone,
    TestTone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSelection {
    pub screen_id: Option<String>,
    pub window_id: Option<String>,
    pub camera_id: Option<String>,
    pub microphone_id: Option<String>,
    #[serde(default)]
    pub test_pattern: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    pub camera_corner: CameraCorner,
    pub camera_size: CameraSize,
    pub camera_shape: CameraShape,
    pub camera_margin: u32,
    #[serde(default = "default_camera_fit")]
    pub camera_fit: CameraFit,
    #[serde(default)]
    pub camera_mirror: bool,
    #[serde(default = "default_camera_zoom")]
    pub camera_zoom: u32,
    #[serde(default)]
    pub camera_offset_x: i32,
    #[serde(default)]
    pub camera_offset_y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CameraCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CameraSize {
    Small,
    Medium,
    Large,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CameraShape {
    Rectangle,
    Circle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CameraFit {
    Fit,
    Fill,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub sources: Vec<SceneSource>,
    pub outputs: Vec<SceneOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneSource {
    pub id: String,
    pub name: String,
    pub kind: SceneSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub transform: SceneTransform,
    pub default_transform: SceneTransform,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SceneSourceKind {
    Screen,
    Window,
    Camera,
    TestPattern,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub crop_left: f64,
    #[serde(default)]
    pub crop_top: f64,
    #[serde(default)]
    pub crop_right: f64,
    #[serde(default)]
    pub crop_bottom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransformPatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub crop_left: Option<f64>,
    pub crop_top: Option<f64>,
    pub crop_right: Option<f64>,
    pub crop_bottom: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SceneOutput {
    pub id: String,
    pub kind: SceneOutputKind,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SceneOutputKind {
    Preview,
    Recording,
    Stream,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneConfigParams {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    #[serde(default)]
    pub video: Option<VideoSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransformUpdateParams {
    pub source_id: String,
    pub transform: SceneTransformPatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSourceParams {
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSourceOrderParams {
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSourceNudgeParams {
    pub source_id: String,
    pub direction_x: f64,
    pub direction_y: f64,
    #[serde(default)]
    pub large: bool,
}

fn default_true() -> bool {
    true
}

fn default_camera_fit() -> CameraFit {
    CameraFit::Fill
}

fn default_camera_zoom() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub record_enabled: bool,
    pub stream_enabled: bool,
    pub output_directory: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub video: VideoSettings,
    pub rtmp: RtmpSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub preset: VideoPreset,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VideoPreset {
    #[serde(rename = "tutorial-1080p30")]
    Tutorial1080p30,
    #[serde(rename = "tutorial-1440p30")]
    Tutorial1440p30,
    #[serde(rename = "stream-1080p60")]
    Stream1080p60,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtmpSettings {
    pub preset: RtmpPreset,
    pub server_url: String,
    pub stream_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RtmpPreset {
    #[serde(rename = "youtube")]
    YouTube,
    Twitch,
    X,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionParams {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub output: OutputSettings,
    #[serde(default)]
    pub audio: AudioSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    #[serde(default)]
    pub microphone_gain_db: f32,
    #[serde(default)]
    pub microphone_muted: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            microphone_gain_db: 0.0,
            microphone_muted: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxSessionParams {
    pub session_id: String,
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshotParams {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    pub id: String,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLiveParams {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub video: Option<VideoSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLiveStatus {
    pub state: PreviewLiveState,
    pub source: PreviewLiveSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewLiveState {
    Connecting,
    Live,
    Reconnecting,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewLiveSource {
    IdlePreview,
    RecordingSession,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterParams {
    pub microphone_id: Option<String>,
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub microphone_gain_db: f32,
    #[serde(default)]
    pub microphone_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterResult {
    pub status: AudioMeterStatus,
    pub level: Option<f64>,
    pub peak_db: Option<f64>,
    pub mean_db: Option<f64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamHealth {
    pub session_id: String,
    pub fps: Option<f64>,
    pub dropped_frames: Option<u64>,
    pub speed: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AudioMeterStatus {
    Ready,
    Silent,
    Unavailable,
    PermissionRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub mode: String,
    pub output_path: Option<String>,
    pub mp4_path: Option<String>,
    pub stream_preset: Option<String>,
    pub container: Option<String>,
    pub duration_ms: Option<i64>,
    pub layout: LayoutSettings,
    pub sources: SourceSelection,
    pub health_events: Vec<HealthEvent>,
    pub ai_artifacts: Vec<AiArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthEvent {
    pub id: String,
    pub session_id: Option<String>,
    pub level: HealthLevel,
    pub code: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HealthLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAiWorkflowParams {
    pub session_id: String,
    pub consent_to_upload_audio: bool,
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPublishPackParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPublishPackResult {
    pub session_id: String,
    pub markdown_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkflowResult {
    pub session_id: String,
    pub audio_path: String,
    pub artifacts: Vec<AiArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifact {
    pub id: String,
    pub session_id: String,
    pub kind: AiArtifactKind,
    pub status: AiArtifactStatus,
    pub content: serde_json::Value,
    pub file_path: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiArtifactKind {
    AudioExtract,
    Transcript,
    TitleDescription,
    Summary,
    Chapters,
    Highlights,
    SmartZoom,
    NoiseCleanup,
    SilenceRemoval,
    HealthAssistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiArtifactStatus {
    Ready,
    PendingConsent,
    Failed,
}

impl ServerResponse {
    pub fn ok<T: Serialize>(id: impl Into<String>, payload: T) -> Self {
        Self {
            id: id.into(),
            ok: true,
            payload: Some(serde_json::to_value(payload).expect("serializable response payload")),
            error: None,
        }
    }

    pub fn error(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            ok: false,
            payload: None,
            error: Some(ResponseError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

impl ServerEvent {
    pub fn new<T: Serialize>(event: impl Into<String>, payload: T) -> Self {
        Self {
            event: event.into(),
            payload: serde_json::to_value(payload).expect("serializable event payload"),
        }
    }
}
