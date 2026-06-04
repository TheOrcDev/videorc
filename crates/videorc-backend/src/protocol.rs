use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::source_registry::SourceRegistrySnapshot;
use crate::streaming::StreamingSettings;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    #[serde(default = "default_layout_preset")]
    pub layout_preset: LayoutPreset,
    #[serde(default = "default_camera_transform_mode")]
    pub camera_transform_mode: CameraTransformMode,
    #[serde(default)]
    pub camera_transform: Option<CameraTransform>,
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
    #[serde(default = "default_side_by_side_split")]
    pub side_by_side_split: SideBySideSplit,
    #[serde(default = "default_side_by_side_camera_side")]
    pub side_by_side_camera_side: SideBySideCameraSide,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutPreset {
    ScreenCamera,
    ScreenOnly,
    CameraOnly,
    SideBySide,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CameraTransformMode {
    Preset,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraTransform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SideBySideSplit {
    #[serde(rename = "50-50")]
    Even,
    #[serde(rename = "60-40")]
    SixtyForty,
    #[serde(rename = "70-30")]
    SeventyThirty,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SideBySideCameraSide {
    Left,
    Right,
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
pub struct SceneSourceVisibilityParams {
    pub source_id: String,
    pub visible: bool,
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

fn default_layout_preset() -> LayoutPreset {
    LayoutPreset::ScreenCamera
}

fn default_camera_transform_mode() -> CameraTransformMode {
    CameraTransformMode::Preset
}

fn default_side_by_side_split() -> SideBySideSplit {
    SideBySideSplit::SeventyThirty
}

fn default_side_by_side_camera_side() -> SideBySideCameraSide {
    SideBySideCameraSide::Right
}

/// The canonical default layout (screen + camera, medium bottom-right camera). Used
/// as a starting point for the active scene model and tests.
#[cfg(test)]
pub(crate) fn default_layout_settings() -> LayoutSettings {
    LayoutSettings {
        layout_preset: default_layout_preset(),
        camera_transform_mode: default_camera_transform_mode(),
        camera_transform: None,
        camera_corner: CameraCorner::BottomRight,
        camera_size: CameraSize::Medium,
        camera_shape: CameraShape::Rectangle,
        camera_margin: 32,
        camera_fit: default_camera_fit(),
        camera_mirror: false,
        camera_zoom: default_camera_zoom(),
        camera_offset_x: 0,
        camera_offset_y: 0,
        side_by_side_split: default_side_by_side_split(),
        side_by_side_camera_side: default_side_by_side_camera_side(),
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<Scene>,
    pub output: OutputSettings,
    #[serde(default)]
    pub audio: AudioSettings,
    #[serde(default)]
    pub streaming: Option<StreamingSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    #[serde(default)]
    pub microphone_gain_db: f32,
    #[serde(default)]
    pub microphone_muted: bool,
    #[serde(default = "default_microphone_sync_offset_ms")]
    pub microphone_sync_offset_ms: i32,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            microphone_gain_db: 0.0,
            microphone_muted: false,
            microphone_sync_offset_ms: default_microphone_sync_offset_ms(),
        }
    }
}

fn default_microphone_sync_offset_ms() -> i32 {
    0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxSessionParams {
    pub session_id: String,
    pub ffmpeg_path: Option<String>,
}

/// Params for the per-recording repair commands (assess / repair). The expectations let
/// a screen-only capture avoid being flagged for "missing audio".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairFileParams {
    pub path: String,
    pub ffmpeg_path: Option<String>,
    pub expect_audio: Option<bool>,
    pub intended_fps: Option<f64>,
}

/// Params for restoring a recording from its hidden backup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairRestoreParams {
    pub path: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    pub transport: PreviewTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_fps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewTransport {
    NativeSurface,
    LatestJpegPolling,
    MjpegStream,
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
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStats {
    pub session_id: Option<String>,
    pub target_fps: Option<f64>,
    pub capture_fps: Option<f64>,
    pub render_fps: Option<f64>,
    pub skipped_frames: u64,
    pub dropped_frames: u64,
    pub encoder_speed: Option<f64>,
    pub preview_target_fps: Option<f64>,
    pub preview_frame_age_ms: Option<u64>,
    pub preview_transport: PreviewTransport,
    #[serde(default)]
    pub preview_source_fps: BTreeMap<String, f64>,
    pub preview_present_fps: Option<f64>,
    pub preview_input_to_present_latency_ms: Option<u64>,
    pub preview_render_frame_time_p50_ms: Option<f64>,
    pub preview_render_frame_time_p95_ms: Option<f64>,
    pub preview_render_frame_time_p99_ms: Option<f64>,
    pub preview_repeated_frames: u64,
    pub preview_surface_resize_count: u64,
    pub preview_latency_ms: Option<u64>,
    pub preview_dropped_frames: u64,
    pub preview_camera_frame_age_ms: Option<u64>,
    pub preview_camera_source_fps: Option<f64>,
    pub preview_camera_dropped_frames: u64,
    pub preview_screen_frame_age_ms: Option<u64>,
    pub preview_screen_source_fps: Option<f64>,
    pub preview_screen_dropped_frames: u64,
    pub preview_source_frame_buffer_count: u64,
    pub preview_source_frame_bytes: u64,
    pub preview_source_frame_dropped_frames: u64,
    pub mic_captured_frames: Option<u64>,
    pub mic_dropped_frames: u64,
    pub device_disconnected: bool,
    pub backend_rss_bytes: Option<u64>,
    pub active_ffmpeg_processes: u64,
    pub active_ffprobe_processes: u64,
    pub ffmpeg_capture_active: bool,
    pub ffmpeg_finalizing_active: bool,
    pub ffmpeg_maintenance_running: bool,
    pub ffmpeg_maintenance_cancel_requested: bool,
    pub ffmpeg_maintenance_deferred_reason: Option<String>,
    #[serde(default)]
    pub duplicate_capture_sources: Vec<String>,
    #[serde(default)]
    pub source_registry: SourceRegistrySnapshot,
    pub bottleneck: DiagnosticBottleneck,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBaselineParams {
    pub transport: PreviewTransport,
    pub target_fps: Option<f64>,
    pub measured_fps: Option<f64>,
    pub present_fps: Option<f64>,
    pub frame_age_ms: Option<u64>,
    pub cadence_p95_ms: Option<f64>,
    pub interval_jitter_p95_ms: Option<f64>,
    pub blank_frames: u64,
    pub long_tasks: u64,
    pub renderer_long_task_p95_ms: Option<f64>,
    pub obs_qualified: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceBounds {
    pub screen_x: f64,
    pub screen_y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceCreateParams {
    pub bounds: PreviewSurfaceBounds,
    #[serde(default = "default_preview_surface_target_fps")]
    pub target_fps: u32,
    #[serde(default)]
    pub source: PreviewSurfaceSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceBoundsParams {
    pub bounds: PreviewSurfaceBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceStatus {
    pub state: PreviewSurfaceState,
    pub source: PreviewSurfaceSource,
    pub transport: PreviewTransport,
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
    pub frames_rendered: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<PreviewSurfaceBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewSurfaceState {
    Unavailable,
    Starting,
    Live,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewSurfaceSource {
    #[default]
    Synthetic,
    Camera,
    Screen,
    Window,
}

fn default_preview_surface_target_fps() -> u32 {
    60
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositorStatus {
    pub state: CompositorState,
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
    pub render_fps: Option<f64>,
    pub frames_rendered: u64,
    pub repeated_frames: u64,
    pub dropped_frames: u64,
    pub frame_age_ms: Option<u64>,
    pub frame_time_p95_ms: Option<f64>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorState {
    Stopped,
    Starting,
    Live,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCameraStartParams {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub video: VideoSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCameraStatus {
    pub state: PreviewCameraState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_unique_id: Option<String>,
    pub target_fps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
    pub frame_age_ms: Option<u64>,
    pub frames_captured: u64,
    pub dropped_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewCameraState {
    Starting,
    Live,
    PermissionNeeded,
    DeviceMissing,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScreenStartParams {
    pub sources: SourceSelection,
    pub video: VideoSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScreenStatus {
    pub state: PreviewScreenState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<PreviewScreenSourceKind>,
    pub target_fps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
    pub frame_age_ms: Option<u64>,
    pub frames_captured: u64,
    pub dropped_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub include_cursor: bool,
    pub exclude_current_process_windows: bool,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewScreenState {
    Starting,
    Live,
    PermissionNeeded,
    SourceMissing,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewScreenSourceKind {
    Screen,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticBottleneck {
    None,
    Capture,
    Render,
    Encoder,
    Preview,
    Audio,
    Device,
    Unknown,
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
    pub session_logs: Vec<SessionLogEntry>,
    pub ai_artifacts: Vec<AiArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamScreenStatus {
    Ready,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamScreen {
    pub id: String,
    pub name: String,
    pub image_path: String,
    pub thumbnail_path: Option<String>,
    pub sort_order: i64,
    pub status: StreamScreenStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScreenImageParams {
    pub path: String,
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenIdParams {
    pub screen_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameScreenParams {
    pub screen_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderScreensParams {
    pub screen_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionPane {
    Privacy,
    ScreenRecording,
    Camera,
    Microphone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthEvent {
    pub id: String,
    pub session_id: Option<String>,
    pub level: HealthLevel,
    pub code: String,
    pub message: String,
    pub permission_pane: Option<PermissionPane>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogEntry {
    pub id: String,
    pub session_id: String,
    pub level: HealthLevel,
    pub code: String,
    pub message: String,
    pub source_id: Option<String>,
    pub permission_pane: Option<PermissionPane>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_preset_serializes_to_kebab_case() {
        assert_eq!(
            serde_json::to_value(LayoutPreset::ScreenCamera).unwrap(),
            serde_json::json!("screen-camera")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::SideBySide).unwrap(),
            serde_json::json!("side-by-side")
        );
    }

    #[test]
    fn layout_settings_defaults_missing_preset_to_screen_camera() {
        // Settings persisted before layoutPreset existed must migrate to screen-camera.
        let legacy = serde_json::json!({
            "cameraCorner": "bottom-right",
            "cameraSize": "medium",
            "cameraShape": "rectangle",
            "cameraMargin": 32,
            "cameraFit": "fill",
            "cameraMirror": false,
            "cameraZoom": 100,
            "cameraOffsetX": 0,
            "cameraOffsetY": 0
        });
        let layout: LayoutSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(layout.layout_preset, LayoutPreset::ScreenCamera);
    }

    #[test]
    fn layout_settings_round_trips_explicit_preset() {
        let layout = LayoutSettings {
            layout_preset: LayoutPreset::SideBySide,
            camera_transform_mode: CameraTransformMode::Custom,
            camera_transform: Some(CameraTransform {
                x: 0.5,
                y: 0.25,
                width: 0.3,
                height: 0.2,
            }),
            camera_corner: CameraCorner::BottomRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Rectangle,
            camera_margin: 32,
            camera_fit: CameraFit::Fill,
            camera_mirror: false,
            camera_zoom: 100,
            camera_offset_x: 0,
            camera_offset_y: 0,
            side_by_side_split: SideBySideSplit::SixtyForty,
            side_by_side_camera_side: SideBySideCameraSide::Left,
        };
        let json = serde_json::to_string(&layout).unwrap();
        assert!(json.contains("\"layoutPreset\":\"side-by-side\""));
        assert!(json.contains("\"cameraTransformMode\":\"custom\""));
        let restored: LayoutSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, layout);
    }

    #[test]
    fn camera_transform_mode_serializes_to_kebab_case() {
        assert_eq!(
            serde_json::to_value(CameraTransformMode::Preset).unwrap(),
            serde_json::json!("preset")
        );
        assert_eq!(
            serde_json::to_value(CameraTransformMode::Custom).unwrap(),
            serde_json::json!("custom")
        );
    }

    #[test]
    fn layout_settings_default_transform_mode_is_preset() {
        // Settings persisted before camera drag existed migrate to preset / no transform.
        let legacy = serde_json::json!({
            "cameraCorner": "bottom-right",
            "cameraSize": "medium",
            "cameraShape": "rectangle",
            "cameraMargin": 32,
            "cameraFit": "fill",
            "cameraMirror": false,
            "cameraZoom": 100,
            "cameraOffsetX": 0,
            "cameraOffsetY": 0
        });
        let layout: LayoutSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(layout.camera_transform_mode, CameraTransformMode::Preset);
        assert!(layout.camera_transform.is_none());
    }

    #[test]
    fn side_by_side_enums_serialize_to_expected_labels() {
        assert_eq!(
            serde_json::to_value(SideBySideSplit::Even).unwrap(),
            serde_json::json!("50-50")
        );
        assert_eq!(
            serde_json::to_value(SideBySideSplit::SixtyForty).unwrap(),
            serde_json::json!("60-40")
        );
        assert_eq!(
            serde_json::to_value(SideBySideSplit::SeventyThirty).unwrap(),
            serde_json::json!("70-30")
        );
        assert_eq!(
            serde_json::to_value(SideBySideCameraSide::Left).unwrap(),
            serde_json::json!("left")
        );
        assert_eq!(
            serde_json::to_value(SideBySideCameraSide::Right).unwrap(),
            serde_json::json!("right")
        );
    }
}
