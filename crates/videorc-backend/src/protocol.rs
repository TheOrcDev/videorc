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
    ElectronProofSurface,
    LatestJpegPolling,
    MjpegStream,
    Unavailable,
}

impl PreviewTransport {
    pub fn is_surface(self) -> bool {
        matches!(
            self,
            PreviewTransport::NativeSurface | PreviewTransport::ElectronProofSurface
        )
    }
}

/// What actually hosts the preview surface. The transport can say "surface", but OBS
/// parity requires that the host be a real CAMetalLayer rather than the Electron proof
/// BrowserWindow used for development smoke tests.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewSurfaceBacking {
    #[serde(rename = "cametal-layer")]
    CaMetalLayer,
    ElectronBrowserWindow,
    #[default]
    None,
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

/// The encoder a recording session actually requested. `-allow_sw 1` means VideoToolbox
/// may still fall back to software internally, so this is the *requested* backend; the
/// final-file analyzer's codec/encoder tag is the corroborating output-side signal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EncodeBackend {
    /// libx264 (software), used by the shared-compositor encoder-bridge path (fps ≤ 30).
    SoftwareX264,
    /// h264_videotoolbox (hardware, sw fallback allowed), used by the legacy path.
    HardwareVideotoolbox,
}

/// Which compositor rendered the active shared-compositor frame. OBS-parity acceptance
/// requires the Metal path; CPU fallback is kept honest with a reason and count.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorBackend {
    Metal,
    CpuFallback,
}

/// Cumulative request counts (since backend start) for the HTTP image-polling preview
/// transports. A native preview never fetches these, so a session in which they climb is
/// not actually native — the honest signal behind the transport-honesty gate.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImagePollCounts {
    pub camera_png: u64,
    pub screen_png: u64,
    pub live_jpeg: u64,
    pub live_mjpeg: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStats {
    pub session_id: Option<String>,
    pub active_output_mode: Option<String>,
    pub active_scene_revision: Option<u64>,
    pub target_fps: Option<f64>,
    pub capture_fps: Option<f64>,
    pub render_fps: Option<f64>,
    pub skipped_frames: u64,
    pub dropped_frames: u64,
    pub encoder_speed: Option<f64>,
    pub encoder_bridge_queue_depth: u64,
    pub encoder_bridge_input_fps: Option<f64>,
    pub encoder_bridge_dropped_frames: u64,
    /// Compositor frames re-fed to the encoder on under-run (duplicate frames in the
    /// final file). Honest signal for the recording repeated-frame gate.
    #[serde(default)]
    pub encoder_bridge_repeated_frames: u64,
    /// Ticks where synthetic filler was fed because no real compositor frame was ready.
    #[serde(default)]
    pub encoder_bridge_synthetic_frames: u64,
    /// Max age (ms) of a compositor frame when it was fed to the encoder.
    #[serde(default)]
    pub encoder_bridge_source_age_ms: Option<u64>,
    /// FIFO ticks where the copied compositor frame also exposed an IOSurface-backed
    /// Metal target. This is a candidate signal for the future zero-copy encoder path.
    #[serde(default)]
    pub encoder_bridge_metal_target_frames: u64,
    /// FIFO frames written through the raw-video FFmpeg bridge. These are copied bytes,
    /// not zero-copy VideoToolbox submissions.
    #[serde(default)]
    pub encoder_bridge_raw_video_copied_frames: u64,
    /// Raw-video FFmpeg writes where the source frame also had an IOSurface-backed Metal
    /// target. This proves the current Metal-target path is still copied.
    #[serde(default)]
    pub encoder_bridge_metal_target_copied_frames: u64,
    /// Raw-video FFmpeg writes where the encoder bridge also received the retained
    /// CoreVideo handle for the IOSurface-backed Metal target.
    #[serde(default)]
    pub encoder_bridge_metal_target_handle_frames: u64,
    /// Frames submitted to the encoder without a CPU raw-video copy.
    #[serde(default)]
    pub encoder_bridge_zero_copy_frames: u64,
    /// Retained Metal target frames encoded by the opt-in production-thread
    /// VideoToolbox probe. This is not counted as zero-copy output until the raw FIFO
    /// path is removed.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_probe_frames: u64,
    /// Encoded byte count copied from the opt-in VideoToolbox probe.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_probe_bytes: u64,
    /// Failed attempts by the opt-in VideoToolbox probe.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_probe_errors: u64,
    /// Retained Metal target frames written to the production VideoToolbox H.264 output.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_output_frames: u64,
    /// Encoded byte count written to the production VideoToolbox H.264 output.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_output_bytes: u64,
    /// Max inline VideoToolbox encode latency observed by the bridge writer.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_output_encode_ms: Option<u64>,
    /// P95 time the bridge writer spent waiting for a fresh compositor frame.
    #[serde(default)]
    pub encoder_bridge_compositor_wait_p95_ms: Option<f64>,
    /// P95 time the bridge writer spent submitting a retained target to VideoToolbox.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_submit_p95_ms: Option<f64>,
    /// P95 time the bridge writer spent writing encoded H.264 bytes into FFmpeg.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_fifo_write_p95_ms: Option<f64>,
    /// P95 wall time for one bridge writer loop tick.
    #[serde(default)]
    pub encoder_bridge_writer_loop_p95_ms: Option<f64>,
    pub encoder_bridge_error: Option<String>,
    /// Which encoder the active session actually requested — proves hardware vs software
    /// encode (previously unrecorded).
    #[serde(default)]
    pub encode_backend: Option<EncodeBackend>,
    /// Which compositor backend produced the most recent diagnostic window.
    #[serde(default)]
    pub compositor_backend: Option<CompositorBackend>,
    /// Reason the shared compositor had to use CPU fallback.
    #[serde(default)]
    pub compositor_fallback_reason: Option<String>,
    /// Cumulative frames rendered by CPU fallback during the active compositor run.
    #[serde(default)]
    pub compositor_cpu_fallback_frames: u64,
    /// Cumulative HTTP image-poll request counts. The transport-honesty gate fails when
    /// these climb during a session the UI claims is rendering a native preview.
    #[serde(default)]
    pub preview_image_poll_counts: PreviewImagePollCounts,
    pub preview_target_fps: Option<f64>,
    pub preview_frame_age_ms: Option<u64>,
    pub preview_transport: PreviewTransport,
    #[serde(default)]
    pub preview_source_fps: BTreeMap<String, f64>,
    #[serde(default)]
    pub preview_surface_backing: PreviewSurfaceBacking,
    pub preview_present_fps: Option<f64>,
    pub preview_input_to_present_latency_ms: Option<u64>,
    pub preview_input_to_present_latency_p50_ms: Option<u64>,
    pub preview_input_to_present_latency_p95_ms: Option<u64>,
    pub preview_input_to_present_latency_p99_ms: Option<u64>,
    /// Difference between the newest compositor frame observed by the preview host and
    /// the compositor frame most recently presented. OBS-style preview may skip frames,
    /// but should not trail the compositor by more than a couple frames.
    #[serde(default)]
    pub preview_compositor_frame_lag: Option<u64>,
    pub preview_render_frame_time_p50_ms: Option<f64>,
    pub preview_render_frame_time_p95_ms: Option<f64>,
    pub preview_render_frame_time_p99_ms: Option<f64>,
    /// P95 time spent fetching the latest live source frame handles for one compositor
    /// tick. High values point to capture/frame-store contention before Metal work
    /// begins.
    #[serde(default)]
    pub compositor_source_fetch_p95_ms: Option<f64>,
    /// P95 time spent snapshotting the compositor scene/frame-store handles before
    /// source frame fetch begins.
    #[serde(default)]
    pub compositor_scene_snapshot_p95_ms: Option<f64>,
    /// P95 wall time spent fetching the latest camera frame handle.
    #[serde(default)]
    pub compositor_camera_frame_fetch_p95_ms: Option<f64>,
    /// P95 wall time spent fetching the latest screen/window frame handle.
    #[serde(default)]
    pub compositor_screen_frame_fetch_p95_ms: Option<f64>,
    /// P95 time spent preparing visible scene sources for the Metal compositor before
    /// issuing draw work.
    #[serde(default)]
    pub compositor_gpu_prepare_p95_ms: Option<f64>,
    /// P95 time spent allocating/updating per-source Metal textures from live BGRA
    /// frames. This is the live-source upload pressure signal.
    #[serde(default)]
    pub compositor_gpu_source_texture_p95_ms: Option<f64>,
    /// P95 time spent waiting for the Metal command buffer to complete.
    #[serde(default)]
    pub compositor_gpu_command_wait_p95_ms: Option<f64>,
    /// P95 total time spent inside the Metal compose call.
    #[serde(default)]
    pub compositor_gpu_total_p95_ms: Option<f64>,
    /// P95 time spent publishing the finished compositor frame into the shared frame
    /// store.
    #[serde(default)]
    pub compositor_frame_store_publish_p95_ms: Option<f64>,
    /// P95 wall time spent refreshing cached live source handles outside the measured
    /// render block.
    #[serde(default)]
    pub compositor_live_source_refresh_p95_ms: Option<f64>,
    /// P95 wall time spent updating preview-surface frame progress outside the measured
    /// render block.
    #[serde(default)]
    pub compositor_preview_surface_progress_p95_ms: Option<f64>,
    /// P95 wall time spent updating/emitting compositor frame progress outside the
    /// measured render block.
    #[serde(default)]
    pub compositor_status_progress_p95_ms: Option<f64>,
    /// Cumulative compositor ticks that skipped preview-surface progress because the
    /// UI status lock was busy.
    #[serde(default)]
    pub compositor_preview_surface_lock_contentions: u64,
    /// Cumulative compositor ticks that skipped compositor progress because the status
    /// lock was busy.
    #[serde(default)]
    pub compositor_status_lock_contentions: u64,
    /// Cumulative compositor ticks where the non-blocking camera source frame lock was
    /// busy, so the compositor reused the cached camera frame for that tick.
    #[serde(default)]
    pub compositor_camera_source_try_lock_misses: u64,
    /// Cumulative compositor ticks where the non-blocking screen/window source frame
    /// lock was busy, so the compositor reused the cached screen/window frame for that
    /// tick.
    #[serde(default)]
    pub compositor_screen_source_try_lock_misses: u64,
    /// Cumulative bounded blocking camera source refreshes after repeated try-lock
    /// misses or a visibly stale cached camera frame.
    #[serde(default)]
    pub compositor_camera_source_blocking_refreshes: u64,
    /// Cumulative bounded blocking screen/window source refreshes after repeated
    /// try-lock misses or a visibly stale cached screen/window frame.
    #[serde(default)]
    pub compositor_screen_source_blocking_refreshes: u64,
    pub preview_repeated_frames: u64,
    pub preview_surface_resize_count: u64,
    pub preview_latency_ms: Option<u64>,
    pub preview_dropped_frames: u64,
    pub preview_camera_frame_age_ms: Option<u64>,
    pub preview_camera_source_fps: Option<f64>,
    pub preview_camera_dropped_frames: u64,
    /// P95 interval between AVFoundation camera sample callbacks.
    #[serde(default)]
    pub preview_camera_capture_gap_p95_ms: Option<f64>,
    /// Max interval between AVFoundation camera sample callbacks.
    #[serde(default)]
    pub preview_camera_capture_gap_max_ms: Option<f64>,
    /// P95 time spent locking the AVFoundation camera CVPixelBuffer base address.
    #[serde(default)]
    pub preview_camera_pixel_buffer_lock_p95_ms: Option<f64>,
    /// P95 time spent copying BGRA rows out of the AVFoundation camera sample.
    #[serde(default)]
    pub preview_camera_row_copy_p95_ms: Option<f64>,
    /// P95 wall time spent publishing the copied camera frame to the source frame store.
    #[serde(default)]
    pub preview_camera_publish_p95_ms: Option<f64>,
    /// Bytes copied for the latest native camera capture frame.
    #[serde(default)]
    pub preview_camera_frame_bytes: u64,
    pub preview_screen_frame_age_ms: Option<u64>,
    pub preview_screen_source_fps: Option<f64>,
    pub preview_screen_dropped_frames: u64,
    /// P95 interval between ScreenCaptureKit screen sample callbacks.
    #[serde(default)]
    pub preview_screen_capture_gap_p95_ms: Option<f64>,
    /// Max interval between ScreenCaptureKit screen sample callbacks.
    #[serde(default)]
    pub preview_screen_capture_gap_max_ms: Option<f64>,
    /// P95 time spent locking the ScreenCaptureKit CVPixelBuffer base address.
    #[serde(default)]
    pub preview_screen_pixel_buffer_lock_p95_ms: Option<f64>,
    /// P95 time spent copying BGRA rows out of the ScreenCaptureKit sample.
    #[serde(default)]
    pub preview_screen_row_copy_p95_ms: Option<f64>,
    /// P95 wall time spent publishing the copied screen frame to the source frame store.
    #[serde(default)]
    pub preview_screen_publish_p95_ms: Option<f64>,
    /// Bytes copied for the latest native screen capture frame.
    #[serde(default)]
    pub preview_screen_frame_bytes: u64,
    /// ScreenCaptureKit stream queue depth requested for the live screen source.
    #[serde(default)]
    pub preview_screen_capture_queue_depth: u32,
    pub preview_source_frame_buffer_count: u64,
    pub preview_source_frame_bytes: u64,
    pub preview_source_frame_dropped_frames: u64,
    pub mic_captured_frames: Option<u64>,
    pub mic_dropped_frames: u64,
    /// Fraction of expected audio sample-frames actually captured during the run (live).
    /// Below ~0.95 signals a mic capture gap. `None` until past the coverage warmup.
    #[serde(default)]
    pub mic_capture_coverage: Option<f64>,
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
    /// True when an active recording is being compromised by a measured problem (encoder
    /// behind real-time, duplicate/synthetic frames re-fed, mic drops/gaps, duplicate
    /// capture). Drives the "Recording at risk" badge so a bad output is never silently
    /// presented as ready.
    #[serde(default)]
    pub recording_at_risk: bool,
    /// Human-readable reasons backing `recording_at_risk`.
    #[serde(default)]
    pub recording_risk_reasons: Vec<String>,
    /// True when the active recording consumes the shared compositor output through the
    /// protected encoder-bridge path (paced by the output clock), rather than a separate
    /// FFmpeg capture. Drives the "Recording protected" badge.
    #[serde(default)]
    pub recording_protected: bool,
    /// Startup barrier state for protected recordings. The encoder bridge must not start
    /// until the compositor has produced fresh target-resolution real-source frames.
    #[serde(default)]
    pub recording_startup_barrier_state: Option<String>,
    #[serde(default)]
    pub recording_startup_barrier_wait_ms: Option<u64>,
    #[serde(default)]
    pub recording_startup_barrier_timeout_reason: Option<String>,
    #[serde(default)]
    pub first_source_frame_ms: Option<u64>,
    #[serde(default)]
    pub first_full_resolution_compositor_frame_ms: Option<u64>,
    #[serde(default)]
    pub first_encoded_frame_ms: Option<u64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderBridgeSyntheticParams {
    pub ffmpeg_path: Option<String>,
    pub output_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub duration_ms: Option<u64>,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderBridgeSyntheticResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_ms: u64,
    pub frames_written: u64,
    pub queue_depth_max: u64,
    pub input_fps: Option<f64>,
    pub dropped_frames: u64,
    pub encoder_speed: Option<f64>,
    pub file_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBaselineParams {
    pub transport: PreviewTransport,
    #[serde(default)]
    pub surface_backing: PreviewSurfaceBacking,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<f64>,
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
pub struct PreviewSurfacePresentParams {
    #[serde(default)]
    pub transport: Option<PreviewTransport>,
    #[serde(default)]
    pub backing: Option<PreviewSurfaceBacking>,
    pub presented_frame_id: Option<u64>,
    pub compositor_frame_lag: Option<u64>,
    #[serde(default)]
    pub dropped_frames: u64,
    pub input_to_present_latency_ms: Option<u64>,
    pub input_to_present_latency_p50_ms: Option<u64>,
    pub input_to_present_latency_p95_ms: Option<u64>,
    pub input_to_present_latency_p99_ms: Option<u64>,
    pub present_fps: Option<f64>,
    pub interval_p95_ms: Option<f64>,
    pub interval_p99_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceStatus {
    pub state: PreviewSurfaceState,
    pub source: PreviewSurfaceSource,
    pub transport: PreviewTransport,
    #[serde(default)]
    pub backing: PreviewSurfaceBacking,
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
    pub frames_rendered: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presented_frame_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compositor_frame_lag: Option<u64>,
    #[serde(default)]
    pub dropped_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_to_present_latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_to_present_latency_p50_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_to_present_latency_p95_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_to_present_latency_p99_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub present_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_p95_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_p99_ms: Option<f64>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_layout: Option<LayoutSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_screen_id: Option<String>,
    #[serde(default)]
    pub scene_sources: Vec<CompositorSceneSourceStatus>,
    #[serde(default)]
    pub sources: Vec<CompositorSourceStatus>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositorSourceStatus {
    pub kind: CompositorSourceKind,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorSourceKind {
    Camera,
    Screen,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositorSceneUpdateParams {
    pub revision: u64,
    pub scene: Option<Scene>,
    pub layout: LayoutSettings,
    #[serde(default)]
    pub active_screen: Option<StreamScreen>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositorSceneSourceStatus {
    pub id: String,
    pub name: String,
    pub kind: CompositorSceneSourceKind,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub visible: bool,
    pub transform: SceneTransform,
    pub fit: CompositorSceneSourceFit,
    pub mirror: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<CameraShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorSceneSourceKind {
    Screen,
    Window,
    Camera,
    TestPattern,
    ScreenImage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorSceneSourceFit {
    Contain,
    Cover,
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
