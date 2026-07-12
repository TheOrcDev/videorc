use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::repair::GateStatus;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountCompleteSignInParams {
    pub code: String,
    pub state: String,
    pub verifier: String,
    pub intent_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthIntent {
    pub intent_generation: u64,
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
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendHealth {
    pub status: String,
    pub version: String,
    pub platform: String,
    pub ffmpeg: ToolStatus,
    pub database_path: String,
    pub secret_store_backend: String,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FeatureId {
    LocalRecording,
    Livestreaming,
    Multistreaming,
    CloudAi,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementState {
    Enabled,
    Disabled,
    DeveloperOverride,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementTier {
    Basic,
    Premium,
    Developer,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementSource {
    LocalDefault,
    EnvOverride,
    Creem,
    Manual,
    SignedCache,
    FutureLicense,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEntitlementLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bitrate_kbps: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamingEntitlementLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
    pub max_bitrate_kbps: u32,
    pub max_destinations: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementLimits {
    pub recording: RecordingEntitlementLimits,
    pub streaming: StreamingEntitlementLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementCapability {
    pub feature_id: FeatureId,
    pub state: EntitlementState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementsSnapshot {
    pub schema_version: u32,
    pub tier: EntitlementTier,
    pub source: EntitlementSource,
    pub capabilities: Vec<EntitlementCapability>,
    pub limits: EntitlementLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AccountStatus {
    SignedOut,
    SignedIn,
}

// The desktop's Videorc PRODUCT account (not a YouTube/Twitch/X platform
// account). Signed-out until real web auth + token storage populate it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideorcAccountSnapshot {
    pub status: AccountStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The account avatar URL (Better Auth `user.image`): the web-uploaded
    /// photo or the Google one. The renderer loads it through main's
    /// allowlisted avatar cache, never hot-linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
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
    /// Corner radius for `CameraShape::Rounded`, as a PERCENT of the camera
    /// box's shorter side (0 = square corners, 50 = pill). Ignored by the
    /// other shapes. All three render paths (CPU, Metal, FFmpeg) derive their
    /// radius from this one number — never re-derive geometry per path.
    #[serde(default = "default_camera_corner_radius_pct")]
    pub camera_corner_radius_pct: u32,
    /// Aspect of the camera box: `source` keeps the per-shape default
    /// (16:9 rectangle, square circle), `square` forces 1:1, `portrait`
    /// forces 3:4 — combined with the default Fill fit this center-crops the
    /// camera like a vertical framing. Circle keeps its square box always.
    #[serde(default = "default_camera_aspect")]
    pub camera_aspect: CameraAspect,
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
    Rounded,
    Circle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CameraAspect {
    Source,
    Square,
    Portrait,
}

fn default_camera_corner_radius_pct() -> u32 {
    12
}

fn default_camera_aspect() -> CameraAspect {
    CameraAspect::Source
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
    /// The alias covers dev-era configs and session rows written while the
    /// preset was plain "vertical" (never shipped in a release).
    #[serde(alias = "vertical")]
    VerticalCameraTop,
    VerticalCameraBottom,
    VerticalSplit,
    VerticalScreenCamera,
    VerticalScreenOnly,
}

impl LayoutPreset {
    /// Orientation class: vertical presets exist only in the Studio's
    /// vertical mode and imply a portrait canvas. The classes may not be
    /// crossed while a session runs — the encoder canvas is fixed at start.
    pub fn is_vertical(&self) -> bool {
        matches!(
            self,
            LayoutPreset::VerticalCameraTop
                | LayoutPreset::VerticalCameraBottom
                | LayoutPreset::VerticalSplit
                | LayoutPreset::VerticalScreenCamera
                | LayoutPreset::VerticalScreenOnly
        )
    }
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundFit {
    Fill,
    Fit,
    Stretch,
}

// Resolved background a scene renders (asset defaults + scene overrides + the
// managed file path). Mirrors the TS EffectiveSceneBackground; A6 reads it in the
// compositor. Absent = no digital background, which is always valid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSceneBackground {
    pub asset_id: String,
    pub managed_asset_path: String,
    pub fit: BackgroundFit,
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur_px: f64,
    pub dim_percent: f64,
    pub saturation_percent: f64,
    pub vignette_percent: f64,
    /// How much of the screen the background ring occupies (0–40): the stage
    /// margin per side is `visibility_percent / 200`. 0 keeps the recording
    /// full-canvas (the asset only fills letterbox gaps); 20 is the classic 80%
    /// stage. Serde-defaulted so older renderers/persisted scenes keep the
    /// classic look.
    #[serde(default = "default_background_visibility_percent")]
    pub visibility_percent: f64,
}

pub const DEFAULT_BACKGROUND_VISIBILITY_PERCENT: f64 = 20.0;

fn default_background_visibility_percent() -> f64 {
    DEFAULT_BACKGROUND_VISIBILITY_PERCENT
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub sources: Vec<SceneSource>,
    pub outputs: Vec<SceneOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<EffectiveSceneBackground>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneConfigParams {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    #[serde(default)]
    pub video: Option<VideoSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<EffectiveSceneBackground>,
    #[serde(default)]
    pub protected_overlay_window_ids: Vec<u32>,
}

/// Backend-owned scene layout transaction. Renderer-generated intent ids are
/// monotonic for the lifetime of a backend connection; callers that predate the
/// transaction API may omit the id and let the backend allocate the next one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneLayoutApplyParams {
    #[serde(default)]
    pub intent_id: Option<u64>,
    #[serde(flatten)]
    pub config: SceneConfigParams,
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
pub(crate) fn default_layout_settings() -> LayoutSettings {
    LayoutSettings {
        layout_preset: default_layout_preset(),
        camera_transform_mode: default_camera_transform_mode(),
        camera_transform: None,
        camera_corner: CameraCorner::BottomRight,
        camera_size: CameraSize::Medium,
        camera_shape: CameraShape::Rectangle,
        camera_corner_radius_pct: default_camera_corner_radius_pct(),
        camera_aspect: default_camera_aspect(),
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
    #[serde(rename = "record-4k30")]
    Record4k30,
    #[serde(rename = "record-4k60-experimental")]
    Record4k60Experimental,
    #[serde(rename = "stream-safe-1080p30")]
    StreamSafe1080p30,
    #[serde(rename = "stream-safe-1080p60")]
    StreamSafe1080p60,
    #[serde(rename = "stream-youtube-4k30")]
    StreamYoutube4k30,
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
    #[serde(default)]
    pub captions: Option<CaptionsSessionParams>,
}

/// Live-caption output intent for this session. Stream selection shapes the
/// live compositor legs; Recording selection gates a non-destructive aligned
/// `(captioned)` copy after finalization. The source recording remains clean.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsSessionParams {
    /// Persisted explicit consent. Audio is only attached while this capture
    /// session is active; enabling while idle leaves captions Ready.
    #[serde(default)]
    pub enabled: bool,
    /// Explicit one-capture suppression selected by "Continue without
    /// captions". Unlike `enabled: false`, this prevents pre-arming a saved
    /// Stream/Both compositor leg for mid-session activation.
    #[serde(default)]
    pub suppressed_for_session: bool,
    /// Which outputs receive captions: live Stream burn-in, an aligned
    /// Recording copy, or both. Replaces `burnInEnabled`.
    #[serde(default)]
    pub burn_target: crate::captions::CaptionBurnTarget,
    /// Legacy pre-R1 flag; `true` maps to Stream when burn_target is absent.
    #[serde(default)]
    pub burn_in_enabled: bool,
    #[serde(default)]
    pub position: crate::captions::CaptionOverlayPosition,
    #[serde(default)]
    pub text_size: crate::captions::CaptionTextSize,
    #[serde(default = "legacy_caption_style_id")]
    pub style_id: crate::captions::CaptionStyleId,
    #[serde(default = "default_caption_language")]
    pub language: String,
    #[serde(default)]
    pub style_revision: u64,
}

impl Default for CaptionsSessionParams {
    fn default() -> Self {
        Self {
            enabled: false,
            suppressed_for_session: false,
            burn_target: crate::captions::CaptionBurnTarget::Off,
            burn_in_enabled: false,
            position: crate::captions::CaptionOverlayPosition::Bottom,
            text_size: crate::captions::CaptionTextSize::M,
            style_id: crate::captions::CaptionStyleId::Classic,
            language: default_caption_language(),
            style_revision: 0,
        }
    }
}

fn default_caption_language() -> String {
    "auto".to_string()
}

fn legacy_caption_style_id() -> crate::captions::CaptionStyleId {
    crate::captions::CaptionStyleId::Glass
}

impl CaptionsSessionParams {
    pub fn effective_burn_target(&self) -> crate::captions::CaptionBurnTarget {
        if self.burn_target == crate::captions::CaptionBurnTarget::Off && self.burn_in_enabled {
            return crate::captions::CaptionBurnTarget::Stream;
        }
        self.burn_target
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessingUpdateParams {
    pub session_id: String,
    pub microphone_gain_db: f32,
    pub microphone_muted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessingUpdateResult {
    pub applied: bool,
    pub session_id: String,
    pub microphone_gain_db: f32,
    pub microphone_muted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

fn default_microphone_sync_offset_ms() -> i32 {
    // Audio/video alignment is structural now: the audio FIFO writer trims to the
    // encoder bridge's first-frame epoch, so no calibrated constant can (or should)
    // paper over pipeline startup latency — the old -750ms default under-corrected at
    // 4K and over-corrected elsewhere. This offset is a pure manual trim for users.
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairSessionParams {
    pub session_id: String,
    pub expect_audio: Option<bool>,
    pub intended_fps: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairRestoreSessionParams {
    pub session_id: String,
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
    pub backing: PreviewSurfaceBacking,
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
pub struct AudioMeterProbeParams {
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
pub struct AudioMeterSampleSnapshot {
    pub microphone_id: Option<String>,
    pub result: AudioMeterResult,
    pub sampled_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterDeviceProbe {
    pub device: Device,
    pub result: AudioMeterResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterDeviceProbeResult {
    pub sampled_at: String,
    pub probes: Vec<AudioMeterDeviceProbe>,
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

/// The encoder a recording session actually requested. Hardware encoders may still fall
/// back internally, so this is the requested backend; the final-file analyzer's
/// codec/encoder tag is the corroborating output-side signal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EncodeBackend {
    /// libx264 (software), used on non-macOS/non-Windows fallback builds.
    SoftwareX264,
    /// h264_videotoolbox (hardware, sw fallback allowed).
    HardwareVideotoolbox,
    /// h264_mf (MediaFoundation hardware/software hybrid), used by Windows builds.
    HardwareMediaFoundation,
    /// h264_mf's software MFT fallback after the exact hardware profile probe failed.
    SoftwareMediaFoundation,
}

/// Which compositor rendered the active shared-compositor frame.
///
/// - `Metal`: the GPU path (macOS OBS-parity target).
/// - `Cpu`: the CPU compositor as the EXPECTED path — platforms without a
///   Metal backend (Windows/Linux) have no GPU compositor to fall back from,
///   so this is normal, not a degradation, and carries no fallback reason.
/// - `CpuFallback`: macOS asked for Metal and could not get it — a real
///   degradation, kept honest with a reason and count.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorBackend {
    Metal,
    Cpu,
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
    /// Requests to the PNG routes without the explicit debug opt-in. These are
    /// rejected before encoding; any nonzero value is a production transport bug.
    #[serde(default)]
    pub production_png: u64,
    /// Uncompressed latest-frame requests used by the Windows proof surface.
    #[serde(default)]
    pub camera_bmp: u64,
    #[serde(default)]
    pub screen_bmp: u64,
    pub live_jpeg: u64,
    pub live_mjpeg: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketQueueDiagnosticStats {
    pub current_depth: u64,
    pub max_depth: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest_age_ms: Option<u64>,
    pub coalesced_count: u64,
    pub evicted_or_dropped_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketTransportDiagnosticStats {
    pub reliable_response_queue: WebSocketQueueDiagnosticStats,
    pub incoming_command_queue: WebSocketQueueDiagnosticStats,
    pub coalesced_telemetry_queue: WebSocketQueueDiagnosticStats,
    pub slow_pressure_disconnect_count: u64,
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
    /// Oldest frame currently waiting for VideoToolbox completion or FIFO output.
    #[serde(default)]
    pub encoder_bridge_output_queue_oldest_frame_age_ms: Option<u64>,
    /// Cumulative enqueue attempts that encountered a full bounded output queue.
    #[serde(default)]
    pub encoder_bridge_output_queue_capacity_pressure_events: u64,
    /// Cumulative frames intentionally discarded by output backpressure policy.
    #[serde(default)]
    pub encoder_bridge_output_queue_dropped_frames: u64,
    pub encoder_bridge_input_fps: Option<f64>,
    pub encoder_bridge_dropped_frames: u64,
    /// Compositor frames re-fed to the encoder on under-run (duplicate frames in the
    /// final file). Honest signal for the recording repeated-frame gate.
    #[serde(default)]
    pub encoder_bridge_repeated_frames: u64,
    /// Distinct bridge under-run bursts. Separates isolated phase misses from clustered
    /// stalls when repeated frames are nonzero.
    #[serde(default)]
    pub encoder_bridge_repeated_frame_bursts: u64,
    /// Longest consecutive duplicate re-feed run observed by the bridge.
    #[serde(default)]
    pub encoder_bridge_max_repeated_frame_run: u64,
    /// Ticks where synthetic filler was fed because no real compositor frame was ready.
    #[serde(default)]
    pub encoder_bridge_synthetic_frames: u64,
    /// Max age (ms) of a compositor frame when it was fed to the encoder.
    #[serde(default)]
    pub encoder_bridge_source_age_ms: Option<u64>,
    /// P95 age (ms) of compositor frames when they were fed to the encoder.
    #[serde(default)]
    pub encoder_bridge_source_age_p95_ms: Option<f64>,
    /// P95 age (ms) of compositor frames that were re-fed as duplicate bridge frames.
    #[serde(default)]
    pub encoder_bridge_repeated_frame_age_p95_ms: Option<f64>,
    /// Max age (ms) of compositor frames that were re-fed as duplicate bridge frames.
    #[serde(default)]
    pub encoder_bridge_repeated_frame_age_max_ms: Option<u64>,
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
    /// Local recording output profile used by split-output sessions.
    #[serde(default)]
    pub recording_output_width: Option<u32>,
    #[serde(default)]
    pub recording_output_height: Option<u32>,
    #[serde(default)]
    pub recording_output_fps: Option<u32>,
    #[serde(default)]
    pub recording_output_bitrate_kbps: Option<u32>,
    /// Livestream output profile used by split-output sessions.
    #[serde(default)]
    pub stream_output_width: Option<u32>,
    #[serde(default)]
    pub stream_output_height: Option<u32>,
    #[serde(default)]
    pub stream_output_fps: Option<u32>,
    #[serde(default)]
    pub stream_output_bitrate_kbps: Option<u32>,
    /// Number of distinct production VideoToolbox output encoders active for the session.
    #[serde(default)]
    pub encoder_bridge_active_video_toolbox_output_encoders: u64,
    /// Frames/bytes produced by the local-recording VideoToolbox output encoder.
    #[serde(default)]
    pub encoder_bridge_recording_video_toolbox_output_frames: u64,
    #[serde(default)]
    pub encoder_bridge_recording_video_toolbox_output_bytes: u64,
    /// Frames/bytes produced by the livestream VideoToolbox output encoder.
    #[serde(default)]
    pub encoder_bridge_stream_video_toolbox_output_frames: u64,
    #[serde(default)]
    pub encoder_bridge_stream_video_toolbox_output_bytes: u64,
    /// True only when diagnostics prove separate record and stream output encoders.
    #[serde(default)]
    pub encoder_bridge_separate_output_encoders_active: bool,
    /// P95 time the bridge writer spent waiting for a fresh compositor frame.
    #[serde(default)]
    pub encoder_bridge_compositor_wait_p95_ms: Option<f64>,
    /// P95 time the bridge writer spent submitting a retained target to VideoToolbox.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_submit_p95_ms: Option<f64>,
    /// P95 time the raw-video FIFO worker spent writing one frame into FFmpeg.
    #[serde(default)]
    pub encoder_bridge_raw_video_fifo_write_p95_ms: Option<f64>,
    /// P95 time the bridge writer spent writing encoded H.264 bytes into FFmpeg.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_fifo_write_p95_ms: Option<f64>,
    /// P95 time spent waiting to enqueue encoded VideoToolbox frames for the FIFO writer.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    /// Max time spent waiting to enqueue encoded VideoToolbox frames for the FIFO writer.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    /// P95 wall time for one bridge writer loop tick, including intentional CFR
    /// deadline sleep.
    #[serde(default)]
    pub encoder_bridge_writer_loop_p95_ms: Option<f64>,
    /// P95 time a bridge writer tick spent sleeping until its scheduled CFR deadline.
    #[serde(default)]
    pub encoder_bridge_writer_sleep_p95_ms: Option<f64>,
    /// P95 active bridge writer work after deadline sleep, including compositor wait,
    /// VideoToolbox submission, and encoded-output drain.
    #[serde(default)]
    pub encoder_bridge_writer_active_p95_ms: Option<f64>,
    /// P95 schedule lag for bridge writer ticks that missed their CFR deadline during
    /// the active session.
    #[serde(default)]
    pub encoder_bridge_deadline_lag_p95_ms: Option<f64>,
    /// Max bridge writer schedule lag observed during the active session.
    #[serde(default)]
    pub encoder_bridge_deadline_lag_max_ms: Option<f64>,
    /// Cumulative bridge writer ticks that started more than the late-deadline threshold
    /// after their scheduled CFR deadline.
    #[serde(default)]
    pub encoder_bridge_late_deadline_ticks: u64,
    /// Wall-clock milliseconds the bridge schedule explicitly skipped during
    /// pathological stalls (app nap, display sleep). Healthy sessions: ~0.
    /// Any nonzero value is honest, bounded loss — never silent compression
    /// (plan 026).
    #[serde(default)]
    pub encoder_bridge_schedule_skipped_ms: u64,
    /// Recording-leg bridge input FPS for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_recording_input_fps: Option<f64>,
    /// Stream-leg bridge input FPS for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_stream_input_fps: Option<f64>,
    /// Recording-leg output queue state for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_recording_queue_depth: u64,
    #[serde(default)]
    pub encoder_bridge_recording_queue_oldest_frame_age_ms: Option<u64>,
    #[serde(default)]
    pub encoder_bridge_recording_queue_capacity_pressure_events: u64,
    #[serde(default)]
    pub encoder_bridge_recording_queue_dropped_frames: u64,
    /// Streaming-leg output queue state for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_stream_queue_depth: u64,
    #[serde(default)]
    pub encoder_bridge_stream_queue_oldest_frame_age_ms: Option<u64>,
    #[serde(default)]
    pub encoder_bridge_stream_queue_capacity_pressure_events: u64,
    #[serde(default)]
    pub encoder_bridge_stream_queue_dropped_frames: u64,
    /// Recording-leg bridge writer p95 for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_recording_writer_loop_p95_ms: Option<f64>,
    /// Stream-leg bridge writer p95 for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_stream_writer_loop_p95_ms: Option<f64>,
    /// Recording-leg active writer work p95 for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_recording_writer_active_p95_ms: Option<f64>,
    /// Stream-leg active writer work p95 for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_stream_writer_active_p95_ms: Option<f64>,
    /// Recording-leg FIFO enqueue wait p95 for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    /// Stream-leg FIFO enqueue wait p95 for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    /// Recording-leg FIFO enqueue max wait for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    /// Stream-leg FIFO enqueue max wait for split-output sessions.
    #[serde(default)]
    pub encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms: Option<f64>,
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
    #[serde(default)]
    pub websocket_transport: WebSocketTransportDiagnosticStats,
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
    /// True while the proof/fallback host has source image polling disabled. This can be
    /// intentional during recording, but it means a fast preview host is not proving
    /// visible source pixels.
    #[serde(default)]
    pub preview_frame_polling_suppressed: bool,
    /// True when the host reports at least one live source layer/pixel source presented.
    /// A native CAMetalLayer activation should eventually make this true without HTTP
    /// image polling.
    #[serde(default)]
    pub preview_source_pixels_present: bool,
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
    /// Cumulative live-source frames imported from IOSurface storage into Metal.
    #[serde(default)]
    pub compositor_source_iosurface_import_frames: u64,
    /// Cumulative live-source frames imported from CVPixelBuffer storage into Metal.
    #[serde(default)]
    pub compositor_source_cvpixelbuffer_import_frames: u64,
    /// Cumulative live-source frames uploaded to Metal from CPU BGRA bytes.
    #[serde(default)]
    pub compositor_source_byte_upload_frames: u64,
    /// Cumulative live-source zero-copy import attempts that fell back to byte upload.
    #[serde(default)]
    pub compositor_source_import_failures: u64,
    /// Cumulative camera frames imported from IOSurface storage into Metal.
    #[serde(default)]
    pub compositor_camera_source_iosurface_import_frames: u64,
    /// Cumulative camera frames imported from CVPixelBuffer storage into Metal.
    #[serde(default)]
    pub compositor_camera_source_cvpixelbuffer_import_frames: u64,
    /// Cumulative camera frames uploaded to Metal from CPU BGRA bytes.
    #[serde(default)]
    pub compositor_camera_source_byte_upload_frames: u64,
    /// Cumulative camera zero-copy import attempts that fell back to byte upload.
    #[serde(default)]
    pub compositor_camera_source_import_failures: u64,
    /// Cumulative screen/window frames imported from IOSurface storage into Metal.
    #[serde(default)]
    pub compositor_screen_source_iosurface_import_frames: u64,
    /// Cumulative screen/window frames imported from CVPixelBuffer storage into Metal.
    #[serde(default)]
    pub compositor_screen_source_cvpixelbuffer_import_frames: u64,
    /// Cumulative screen/window frames uploaded to Metal from CPU BGRA bytes.
    #[serde(default)]
    pub compositor_screen_source_byte_upload_frames: u64,
    /// Cumulative screen/window zero-copy import attempts that fell back to byte upload.
    #[serde(default)]
    pub compositor_screen_source_import_failures: u64,
    /// P95 time spent importing/uploading source textures in the latest diagnostics window.
    #[serde(default)]
    pub compositor_source_import_p95_ms: Option<f64>,
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
    /// P95 wall-clock interval between compositor ticks. High values mean the render
    /// task is waking late even if the measured render work is cheap.
    #[serde(default)]
    pub compositor_tick_gap_p95_ms: Option<f64>,
    /// Max wall-clock interval between compositor ticks in the latest diagnostics
    /// window.
    #[serde(default)]
    pub compositor_tick_gap_max_ms: Option<f64>,
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
    /// Cumulative bounded blocking camera source refreshes after source-store
    /// contention or a visibly stale cached camera frame.
    #[serde(default)]
    pub compositor_camera_source_blocking_refreshes: u64,
    /// Cumulative bounded blocking screen/window source refreshes after
    /// source-store contention or a visibly stale cached screen/window frame.
    #[serde(default)]
    pub compositor_screen_source_blocking_refreshes: u64,
    pub preview_repeated_frames: u64,
    pub preview_surface_resize_count: u64,
    pub preview_latency_ms: Option<u64>,
    pub preview_dropped_frames: u64,
    pub preview_camera_frame_age_ms: Option<u64>,
    pub preview_camera_source_fps: Option<f64>,
    pub preview_camera_dropped_frames: u64,
    /// Latest native camera state reported by the AVFoundation preview source.
    #[serde(default)]
    pub preview_camera_state: Option<PreviewCameraState>,
    /// Native AVFoundation unique ID for the selected camera.
    #[serde(default)]
    pub preview_camera_device_unique_id: Option<String>,
    /// Latest native camera status message, including permission/device-missing reasons.
    #[serde(default)]
    pub preview_camera_status_message: Option<String>,
    /// Camera capture width requested by layout/output policy.
    #[serde(default)]
    pub preview_camera_requested_width: Option<u32>,
    /// Camera capture height requested by layout/output policy.
    #[serde(default)]
    pub preview_camera_requested_height: Option<u32>,
    /// Latest actual camera frame width received from AVFoundation.
    #[serde(default)]
    pub preview_camera_actual_width: Option<u32>,
    /// Latest actual camera frame height received from AVFoundation.
    #[serde(default)]
    pub preview_camera_actual_height: Option<u32>,
    /// Selected native AVFoundation format width.
    #[serde(default)]
    pub preview_camera_selected_format_width: Option<u32>,
    /// Selected native AVFoundation format height.
    #[serde(default)]
    pub preview_camera_selected_format_height: Option<u32>,
    /// Selected native AVFoundation format minimum FPS.
    #[serde(default)]
    pub preview_camera_selected_format_min_fps: Option<f64>,
    /// Selected native AVFoundation format maximum FPS.
    #[serde(default)]
    pub preview_camera_selected_format_max_fps: Option<f64>,
    /// Native AVFoundation camera whose capability matrix was sampled.
    #[serde(default)]
    pub preview_camera_capability_device_id: Option<String>,
    /// Structured AVFoundation camera format matrix: one entry per resolution/fps range.
    #[serde(default)]
    pub preview_camera_capability_formats: Vec<CameraCapabilityFormat>,
    /// Human-readable reason the camera capability matrix could not be sampled.
    #[serde(default)]
    pub preview_camera_capability_error: Option<String>,
    /// P95 interval between AVFoundation camera sample callbacks.
    #[serde(default)]
    pub preview_camera_capture_gap_p95_ms: Option<f64>,
    /// P99 interval between AVFoundation camera sample callbacks.
    #[serde(default)]
    pub preview_camera_capture_gap_p99_ms: Option<f64>,
    /// Max interval between AVFoundation camera sample callbacks.
    #[serde(default)]
    pub preview_camera_capture_gap_max_ms: Option<f64>,
    /// P95 interval between AVFoundation camera sample presentation timestamps.
    #[serde(default)]
    pub preview_camera_sample_pts_gap_p95_ms: Option<f64>,
    /// P99 interval between AVFoundation camera sample presentation timestamps.
    #[serde(default)]
    pub preview_camera_sample_pts_gap_p99_ms: Option<f64>,
    /// Max interval between AVFoundation camera sample presentation timestamps.
    #[serde(default)]
    pub preview_camera_sample_pts_gap_max_ms: Option<f64>,
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
    /// Latest native ScreenCaptureKit status message, including permission/startup errors.
    #[serde(default)]
    pub preview_screen_message: Option<String>,
    /// Native ScreenCaptureKit source width selected for the live screen/window source.
    #[serde(default)]
    pub preview_screen_native_width: Option<u32>,
    /// Native ScreenCaptureKit source height selected for the live screen/window source.
    #[serde(default)]
    pub preview_screen_native_height: Option<u32>,
    /// Width requested from ScreenCaptureKit after production capture policy selection.
    #[serde(default)]
    pub preview_screen_requested_width: Option<u32>,
    /// Height requested from ScreenCaptureKit after production capture policy selection.
    #[serde(default)]
    pub preview_screen_requested_height: Option<u32>,
    /// Actual latest ScreenCaptureKit frame width received from CoreVideo.
    #[serde(default)]
    pub preview_screen_actual_width: Option<u32>,
    /// Actual latest ScreenCaptureKit frame height received from CoreVideo.
    #[serde(default)]
    pub preview_screen_actual_height: Option<u32>,
    /// Whether the latest ScreenCaptureKit frame retained a zero-copy source handle.
    #[serde(default)]
    pub preview_screen_iosurface_available: Option<bool>,
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
    /// Live mic meter level (0-1, dB-scaled) from the frames the active session
    /// already captures - no extra device open. `None` when no session is live
    /// (post-0.9.4 fix batch F7: the Studio mixer shows a moving meter).
    #[serde(default)]
    pub mic_live_level: Option<f64>,
    #[serde(default)]
    pub mic_live_peak_db: Option<f64>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceBounds {
    pub screen_x: f64,
    pub screen_y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<f64>,
    // Visible intersection of the studio slot with its clipping ancestors and the
    // window viewport, in the same screen coordinate space as screen_x/screen_y.
    // Absent means the full rect is visible (legacy callers). The native host crops
    // the surface to this rect so a half-scrolled preview clips instead of floating.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_height: Option<f64>,
    // False when the slot is fully scrolled away or the document/window is hidden —
    // the native host must hide the surface entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    // Detached preview window (cross-process stacking): the global window number
    // of the Electron preview window the native surface must sit directly above,
    // and whether the pair floats above other apps (always-on-top). Absent =
    // legacy embedded overlay behavior (floating level, ordered front).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_above_window_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevated: Option<bool>,
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
    #[serde(default)]
    pub native_preview_main_scene_mismatch_count: Option<u64>,
    #[serde(default)]
    pub native_preview_main_scene_mismatch_age_ms: Option<u64>,
    #[serde(default)]
    pub native_preview_main_last_skipped_scene_revision: Option<u64>,
    #[serde(default)]
    pub native_preview_main_last_skipped_frame_scene_revision: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub frame_polling_suppressed: bool,
    #[serde(default)]
    pub source_pixels_present: bool,
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
    pub native_preview_main_scene_mismatch_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_preview_main_scene_mismatch_age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_preview_main_last_skipped_scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_preview_main_last_skipped_frame_scene_revision: Option<u64>,
    #[serde(default)]
    pub frame_polling_suppressed: bool,
    #[serde(default)]
    pub source_pixels_present: bool,
    /// Native/AppKit host lifecycle commands waiting for the Electron/native host to
    /// apply. Nonzero during an active visible-preview run means the host was requested
    /// but not actually attached.
    #[serde(default)]
    pub pending_host_command_count: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompositorImageCacheStatus {
    pub budget_bytes: u64,
    pub entry_budget: u64,
    pub entries: u64,
    pub decoded_bytes: u64,
    pub preconverted_bgra_bytes: u64,
    pub resident_bytes: u64,
    pub pinned_entries: u64,
    pub pinned_bytes: u64,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompositorFramePipelineStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumer: Option<String>,
    pub gpu_readbacks: u64,
    pub bgra_bytes_copied: u64,
    pub yuv_frames_converted: u64,
    pub immutable_texture_uploads: u64,
    pub immutable_texture_reuses: u64,
}

/// Small latest-wins event used by native preview presentation. Full
/// compositor diagnostics remain on their bounded diagnostic cadence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompositorFrameReady {
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_scene_revision: Option<u64>,
    pub frames_rendered: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metal_target_iosurface_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metal_target_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metal_target_height: Option<u32>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositorStatus {
    pub state: CompositorState,
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    /// Scene revision that produced the latest rendered compositor frame/Metal
    /// handoff. This can lag behind `scene_revision` immediately after a live
    /// scene metadata update, before the next compositor frame is published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_layout: Option<LayoutSettings>,
    /// Persisted `StreamScreen` takeover image layered above the live scene.
    /// Native screen/window capture authority lives in `scene_sources` and
    /// `sources`; this field is not the selected capture device id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_screen_id: Option<String>,
    #[serde(default)]
    pub scene_sources: Vec<CompositorSceneSourceStatus>,
    #[serde(default)]
    pub sources: Vec<CompositorSourceStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_fps: Option<f64>,
    pub frames_rendered: u64,
    pub repeated_frames: u64,
    pub dropped_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_time_p95_ms: Option<f64>,
    /// IOSurface id for the latest retained Metal compositor target. This is a native
    /// preview handoff handle, not an OBS-native claim by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metal_target_iosurface_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metal_target_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metal_target_height: Option<u32>,
    #[serde(default)]
    pub image_cache: CompositorImageCacheStatus,
    #[serde(default)]
    pub frame_pipeline: CompositorFramePipelineStatus,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneCommitStatus {
    pub applied: bool,
    /// "idle" (no active recording/stream), "hot", or "warm".
    pub mode: String,
    pub scene_revision: u64,
    pub scene: Scene,
    pub compositor_status: CompositorStatus,
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
    BackgroundImage,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
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
    pub requested_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_format_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_format_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_format_min_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_format_max_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_age_ms: Option<u64>,
    pub frames_captured: u64,
    pub dropped_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraCapabilityFormat {
    pub width: u32,
    pub height: u32,
    pub min_fps: f64,
    pub max_fps: f64,
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
    #[serde(default)]
    pub protected_overlay_window_ids: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
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
    pub native_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iosurface_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    NoFrames,
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
    /// Size of the visible recording file (mp4 export when present, else the
    /// original container). Statted live at list time while the file exists;
    /// last-known when it has gone missing (Library rewrite L1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<i64>,
    /// Human label for the session's layout preset ("Screen + Camera"); the
    /// stream preset for stream-only sessions. Upgrades to real scene names
    /// when named scenes ship (F2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_status: Option<GateStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_diagnostics: Option<DiagnosticStats>,
    pub layout: LayoutSettings,
    pub sources: SourceSelection,
    pub health_events: Vec<HealthEvent>,
    pub session_logs: Vec<SessionLogEntry>,
    pub ai_artifacts: Vec<AiArtifact>,
    pub comment_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStorageTotals {
    pub count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommentsListParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_session_comments_page_limit")]
    pub limit: usize,
}

pub const DEFAULT_SESSION_COMMENTS_PAGE_LIMIT: usize = 200;

fn default_session_comments_page_limit() -> usize {
    DEFAULT_SESSION_COMMENTS_PAGE_LIMIT
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteParams {
    pub session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteCompleteParams {
    pub operation_id: String,
    pub failed_paths: Vec<String>,
}

/// Renderer-safe handle for a durable Library deletion. Paths remain behind
/// the admin channel and are resolved by Electron main immediately before it
/// invokes the system Trash API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionHandle {
    pub operation_id: String,
    pub session_id: String,
    pub path_count: usize,
    pub blocked_path_count: usize,
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
    /// Per-kind generation: subset of {publish_pack, creator_intelligence,
    /// social_posts}. None = the full atomic bundle (older servers too).
    #[serde(default)]
    pub outputs: Option<Vec<String>>,
    /// Title/description/social register: hooky | informative | casual.
    #[serde(default)]
    pub tone: Option<String>,
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
    /// Every file the export wrote (markdown + per-field paste-ready files).
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSuggestParams {
    pub session_id: String,
}

/// A clip-worthy time range, ranked locally from chat activity + captions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMoment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub reason: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSuggestResult {
    pub session_id: String,
    pub moments: Vec<ClipMoment>,
    pub chat_message_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipExportParams {
    pub session_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipExportResult {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobGetParams {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilities {
    /// Live-caption transport readiness from videorc-web. Optional so desktop
    /// remains compatible while older web deployments roll forward; callers
    /// that opted into captions intentionally fail closed when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captions: Option<AiCapabilitiesCaptions>,
    pub entitlement: AiCapabilitiesEntitlement,
    /// Ed25519-signed entitlement proof (`v1.<payload>.<sig>`) minted by
    /// videorc.com. Optional: older web deploys (or an unconfigured signing
    /// key) omit it and the backend falls back to the unsigned boolean.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entitlement_token: Option<String>,
    pub features: AiCapabilitiesFeatures,
    pub generated_at: String,
    pub limits: AiCapabilitiesLimits,
    pub models: AiCapabilitiesModels,
    pub object_storage: AiCapabilitiesObjectStorage,
    pub readiness: AiCapabilitiesReadiness,
    pub transcription: AiCapabilitiesTranscription,
    pub workflow: AiCapabilitiesWorkflow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesCaptions {
    pub available: bool,
    pub chunked: AiCapabilitiesCaptionsChunked,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_seconds_limit: Option<u64>,
    pub preferred_transport: Option<AiCapabilitiesCaptionsTransport>,
    pub realtime: AiCapabilitiesCaptionsRealtime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
    pub reason_code: AiCapabilitiesCaptionsReasonCode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesCaptionsChunked {
    pub available: bool,
    pub configured: bool,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesCaptionsRealtime {
    pub available: bool,
    pub configured: bool,
    pub disabled: bool,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiCapabilitiesCaptionsTransport {
    Chunked,
    Realtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiCapabilitiesCaptionsReasonCode {
    AiDisabled,
    AiUserDisabled,
    CaptionsDisabled,
    CaptionsInvalidConfig,
    CaptionsMonthlyQuotaExhausted,
    CaptionsNotConfigured,
    CloudAiPremiumRequired,
    ReadyChunkedRealtimeDisabled,
    ReadyChunkedRealtimeUnconfigured,
    ReadyRealtime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesEntitlement {
    pub checked_at: String,
    pub cloud_ai: bool,
    pub expires_at: String,
    pub is_premium: bool,
    pub subscription_status: String,
    pub tier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesFeatures {
    pub cloud_ai_enabled: bool,
    pub gateway_configured: bool,
    pub model_testing_enabled: bool,
    pub multipart_audio_jobs_enabled: bool,
    pub object_backed_jobs_enabled: bool,
    pub transcript_jobs_enabled: bool,
    pub upload_tickets_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesLimits {
    pub daily_jobs: u32,
    pub max_audio_bytes: Option<u64>,
    pub max_audio_megabytes: Option<f64>,
    pub max_output_tokens: Option<u32>,
    pub max_transcript_characters: u32,
    pub monthly_jobs: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesModels {
    pub allowed_text_model_count: u32,
    pub allowed_text_models_configured: bool,
    pub default_text_model: Option<String>,
    #[serde(default)]
    pub fallback_text_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesObjectStorage {
    pub delete_configured: bool,
    pub download_configured: bool,
    pub provider: Option<String>,
    pub provider_error: Option<String>,
    pub proof_configured: bool,
    pub proof_ttl_ms: Option<u64>,
    pub upload_configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesReadiness {
    pub access: AiCapabilitiesAccessReadiness,
    pub gateway: AiCapabilitiesServiceReadiness,
    pub object_storage: AiCapabilitiesObjectStorageReadiness,
    pub transcription: AiCapabilitiesServiceReadiness,
    #[serde(default)]
    pub worker: AiCapabilitiesWorkerReadiness,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesAccessReadiness {
    pub cloud_ai_entitled: bool,
    pub globally_disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesServiceReadiness {
    pub config_error: Option<String>,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesObjectStorageReadiness {
    pub delete_config_error: Option<String>,
    pub download_config_error: Option<String>,
    pub proof_config_error: Option<String>,
    pub provider_error: Option<String>,
    pub upload_config_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesWorkerReadiness {
    pub config_error: Option<String>,
    pub configured: bool,
    pub queued_job_delay_ms: u64,
    pub recently_ran_at: Option<String>,
    pub running_job_timeout_ms: u64,
    pub status: String,
}

impl Default for AiCapabilitiesWorkerReadiness {
    fn default() -> Self {
        Self {
            config_error: None,
            configured: true,
            queued_job_delay_ms: 2 * 60 * 1000,
            recently_ran_at: None,
            running_job_timeout_ms: 15 * 60 * 1000,
            status: "unknown".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesTranscription {
    pub configured: bool,
    pub config_error: Option<String>,
    pub max_audio_bytes: Option<u64>,
    pub max_audio_megabytes: Option<f64>,
    pub request_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesWorkflow {
    #[serde(default)]
    pub input_modes: Vec<AiCapabilitiesInputMode>,
    pub kind: String,
    #[serde(default)]
    pub outputs: Vec<String>,
    // Per-kind generation contract (videorc-web PR #1). All default false so
    // an older server simply behaves like the original atomic bundle.
    #[serde(default)]
    pub supports_outputs_filter: bool,
    #[serde(default)]
    pub supports_tone: bool,
    #[serde(default)]
    pub supports_title_variants: bool,
    #[serde(default)]
    pub supports_chat_context: bool,
    #[serde(default)]
    pub supports_social_posts: bool,
    #[serde(default)]
    pub supports_highlight_timestamps: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesInputMode {
    pub enabled: bool,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuotaStatus {
    pub access: AiQuotaAccess,
    pub entitlement: AiQuotaEntitlement,
    pub generated_at: String,
    pub monthly: AiQuotaWindow,
    pub today: AiQuotaWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuotaAccess {
    pub allowed: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuotaEntitlement {
    pub cancel_at_period_end: bool,
    pub checked_at: String,
    pub cloud_ai: bool,
    pub current_period_end: Option<String>,
    pub expires_at: String,
    pub is_premium: bool,
    pub subscription_status: String,
    pub tier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuotaWindow {
    pub limit: u32,
    pub remaining: u32,
    pub reset_at: String,
    pub used: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<AiJobOwnerArtifacts>,
    pub client_request_id: Option<String>,
    pub completed_at: Option<String>,
    pub cost_estimate_cents: Option<u32>,
    pub created_at: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    #[serde(default)]
    pub fallback_models: Vec<String>,
    pub id: String,
    pub input_tokens: Option<u32>,
    pub model: Option<String>,
    pub output_json: serde_json::Value,
    pub output_tokens: Option<u32>,
    pub provider: String,
    pub run_attempts: u32,
    pub session_client_id: String,
    pub started_at: Option<String>,
    pub status: String,
    pub workflow_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobOwnerArtifacts {
    pub creator_intelligence: serde_json::Value,
    pub publish_pack: serde_json::Value,
    /// Present only when the job requested the social_posts output kind.
    #[serde(default)]
    pub social_posts: serde_json::Value,
    pub transcript: Option<AiJobTranscriptArtifact>,
    pub transcription_metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobTranscriptArtifact {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobEnvelope {
    pub job: AiJobSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobCreateResponse {
    #[serde(default)]
    pub daily_limit: Option<u32>,
    #[serde(default)]
    pub idempotent: bool,
    pub job: AiJobSnapshot,
    #[serde(default)]
    pub monthly_limit: Option<u32>,
    #[serde(default)]
    pub remaining_this_month: Option<u32>,
    #[serde(default)]
    pub remaining_today: Option<u32>,
    #[serde(default)]
    pub transcription: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiObjectUploadTicket {
    pub expires_at: Option<String>,
    pub max_bytes: Option<u64>,
    pub object_key: String,
    #[serde(default)]
    pub upload_headers: BTreeMap<String, String>,
    pub upload_method: String,
    pub upload_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiObjectUploadResponse {
    pub job_request: serde_json::Value,
    pub ticket: AiObjectUploadTicket,
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
    SocialPosts,
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
    fn effective_scene_background_visibility_defaults_when_absent() {
        // Scenes persisted before the visibility slider existed carry no
        // visibilityPercent; they must keep the classic 80%-stage look.
        let json = r#"{"assetId":"a","managedAssetPath":"/tmp/x.webp","fit":"fill","scale":100.0,"offsetX":0.0,"offsetY":0.0,"blurPx":0.0,"dimPercent":0.0,"saturationPercent":100.0,"vignettePercent":0.0}"#;
        let background: EffectiveSceneBackground = serde_json::from_str(json).unwrap();
        assert!(
            (background.visibility_percent - DEFAULT_BACKGROUND_VISIBILITY_PERCENT).abs() < 1e-9
        );
    }

    #[test]
    fn scene_round_trips_background_and_omits_it_when_absent() {
        // No background: the field is omitted on the wire and a legacy scene
        // (saved before this field existed) still deserializes.
        let plain = Scene {
            id: "scene:test".to_string(),
            name: "Test".to_string(),
            sources: Vec::new(),
            outputs: Vec::new(),
            background: None,
        };
        let plain_json = serde_json::to_string(&plain).unwrap();
        assert!(!plain_json.contains("background"));
        let legacy: Scene =
            serde_json::from_str(r#"{"id":"s","name":"n","sources":[],"outputs":[]}"#).unwrap();
        assert_eq!(legacy.background, None);

        // With a background, every field survives a camelCase round trip.
        let scene = Scene {
            background: Some(EffectiveSceneBackground {
                asset_id: "asset-1".to_string(),
                managed_asset_path: "/managed/asset-1.png".to_string(),
                fit: BackgroundFit::Fit,
                scale: 120.0,
                offset_x: -10.0,
                offset_y: 5.0,
                blur_px: 8.0,
                dim_percent: 20.0,
                saturation_percent: 110.0,
                vignette_percent: 30.0,
                visibility_percent: 20.0,
            }),
            ..plain
        };
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"managedAssetPath\":\"/managed/asset-1.png\""));
        assert!(json.contains("\"fit\":\"fit\""));
        let restored: Scene = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, scene);
    }

    #[test]
    fn scene_config_round_trips_background_and_defaults_absent_background() {
        let plain = SceneConfigParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: default_layout_settings(),
            video: None,
            background: None,
            protected_overlay_window_ids: Vec::new(),
        };
        let plain_json = serde_json::to_string(&plain).unwrap();
        assert!(!plain_json.contains("background"));
        let legacy: SceneConfigParams = serde_json::from_str(&plain_json).unwrap();
        assert_eq!(legacy.background, None);

        let params = SceneConfigParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: default_layout_settings(),
            video: None,
            background: Some(EffectiveSceneBackground {
                asset_id: "asset-1".to_string(),
                managed_asset_path: "/managed/asset-1.png".to_string(),
                fit: BackgroundFit::Fill,
                scale: 100.0,
                offset_x: 0.0,
                offset_y: 0.0,
                blur_px: 0.0,
                dim_percent: 0.0,
                saturation_percent: 100.0,
                vignette_percent: 0.0,
                visibility_percent: 20.0,
            }),
            protected_overlay_window_ids: Vec::new(),
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"background\""));
        assert!(json.contains("\"managedAssetPath\":\"/managed/asset-1.png\""));
        let restored: SceneConfigParams = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, params);
    }

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
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalCameraTop).unwrap(),
            serde_json::json!("vertical-camera-top")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalCameraBottom).unwrap(),
            serde_json::json!("vertical-camera-bottom")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalSplit).unwrap(),
            serde_json::json!("vertical-split")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalScreenCamera).unwrap(),
            serde_json::json!("vertical-screen-camera")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalScreenOnly).unwrap(),
            serde_json::json!("vertical-screen-only")
        );
    }

    #[test]
    fn layout_preset_orientation_classes_are_exhaustive() {
        // The class gates live scene switches (the canvas is fixed while a
        // session runs) — a misclassified preset silently breaks that gate.
        assert!(!LayoutPreset::ScreenCamera.is_vertical());
        assert!(!LayoutPreset::ScreenOnly.is_vertical());
        assert!(!LayoutPreset::CameraOnly.is_vertical());
        assert!(!LayoutPreset::SideBySide.is_vertical());
        assert!(LayoutPreset::VerticalCameraTop.is_vertical());
        assert!(LayoutPreset::VerticalCameraBottom.is_vertical());
        assert!(LayoutPreset::VerticalSplit.is_vertical());
        assert!(LayoutPreset::VerticalScreenCamera.is_vertical());
        assert!(LayoutPreset::VerticalScreenOnly.is_vertical());
    }

    #[test]
    fn layout_preset_accepts_the_dev_era_vertical_alias() {
        // "vertical" was the preset's wire name before the orientation-mode
        // split; it never shipped, but dev configs and session rows carry it.
        assert_eq!(
            serde_json::from_value::<LayoutPreset>(serde_json::json!("vertical")).unwrap(),
            LayoutPreset::VerticalCameraTop
        );
    }

    #[test]
    fn media_foundation_backends_match_the_desktop_wire_contract() {
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareMediaFoundation).unwrap(),
            serde_json::json!("hardware-media-foundation")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::SoftwareMediaFoundation).unwrap(),
            serde_json::json!("software-media-foundation")
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
            camera_corner_radius_pct: 12,
            camera_aspect: crate::protocol::CameraAspect::Source,
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
    fn video_presets_serialize_to_product_profile_labels() {
        assert_eq!(
            serde_json::to_value(VideoPreset::Record4k30).unwrap(),
            serde_json::json!("record-4k30")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::Record4k60Experimental).unwrap(),
            serde_json::json!("record-4k60-experimental")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamSafe1080p30).unwrap(),
            serde_json::json!("stream-safe-1080p30")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamSafe1080p60).unwrap(),
            serde_json::json!("stream-safe-1080p60")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamYoutube4k30).unwrap(),
            serde_json::json!("stream-youtube-4k30")
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

    #[test]
    fn legacy_caption_session_settings_migrate_privacy_safe_defaults() {
        let settings: CaptionsSessionParams = serde_json::from_value(serde_json::json!({
            "burnTarget": "stream",
            "position": "bottom",
            "textSize": "m"
        }))
        .unwrap();
        assert!(!settings.enabled);
        assert!(!settings.suppressed_for_session);
        assert_eq!(settings.style_id, crate::captions::CaptionStyleId::Glass);
        assert_eq!(settings.language, "auto");
        assert_eq!(settings.style_revision, 0);
    }

    #[test]
    fn caption_session_style_fields_use_stable_wire_names() {
        let settings = CaptionsSessionParams {
            enabled: true,
            suppressed_for_session: true,
            style_id: crate::captions::CaptionStyleId::HighContrast,
            language: "es".to_string(),
            style_revision: 12,
            ..Default::default()
        };
        let value = serde_json::to_value(settings).unwrap();
        assert_eq!(value["enabled"], true);
        assert_eq!(value["suppressedForSession"], true);
        assert_eq!(value["styleId"], "high-contrast");
        assert_eq!(value["language"], "es");
        assert_eq!(value["styleRevision"], 12);
    }

    fn shared_high_risk_contract_fixture_value(pointer: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("shared high-risk protocol fixture must be valid JSON");
        fixture
            .pointer(pointer)
            .unwrap_or_else(|| panic!("shared protocol fixture is missing {pointer}"))
            .clone()
    }

    #[test]
    fn shared_high_risk_contract_fixture_preserves_preview_bounds_and_stacking() {
        let wire = shared_high_risk_contract_fixture_value("/previewSurfaceBounds/wire");
        let expected = shared_high_risk_contract_fixture_value("/previewSurfaceBounds/normalized");
        let bounds: PreviewSurfaceBounds = serde_json::from_value(wire).unwrap();
        assert_eq!(bounds.order_above_window_id, Some(4242));
        assert_eq!(bounds.elevated, Some(false));
        assert_eq!(serde_json::to_value(bounds).unwrap(), expected);

        let legacy_wire =
            shared_high_risk_contract_fixture_value("/previewSurfaceBounds/legacyWire");
        let legacy_expected =
            shared_high_risk_contract_fixture_value("/previewSurfaceBounds/legacyNormalized");
        let legacy: PreviewSurfaceBounds = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(serde_json::to_value(legacy).unwrap(), legacy_expected);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_layout_and_scene_defaults() {
        let legacy_layout = shared_high_risk_contract_fixture_value("/layout/legacyWire");
        let expected_layout = shared_high_risk_contract_fixture_value("/layout/normalized");
        let layout: LayoutSettings = serde_json::from_value(legacy_layout).unwrap();
        assert_eq!(serde_json::to_value(layout).unwrap(), expected_layout);

        let scene_wire = shared_high_risk_contract_fixture_value("/scene/wire");
        let scene: Scene = serde_json::from_value(scene_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(scene).unwrap(), scene_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_recording_status_defaults() {
        let wire = shared_high_risk_contract_fixture_value("/recordingStatus/wire");
        let status: RecordingStatus = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(status).unwrap(), wire);

        let minimal = shared_high_risk_contract_fixture_value("/recordingStatus/minimalWire");
        let expected =
            shared_high_risk_contract_fixture_value("/recordingStatus/minimalNormalized");
        let status: RecordingStatus = serde_json::from_value(minimal).unwrap();
        assert_eq!(serde_json::to_value(status).unwrap(), expected);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_stopped_compositor_nullability() {
        let wire = shared_high_risk_contract_fixture_value("/compositorStatus/stoppedWire");
        let status: CompositorStatus = serde_json::from_value(wire.clone()).unwrap();
        assert!(status.render_fps.is_none());
        assert!(status.frame_age_ms.is_none());
        assert!(status.frame_time_p95_ms.is_none());
        assert_eq!(serde_json::to_value(status).unwrap(), wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_account_sign_in_params() {
        let wire = shared_high_risk_contract_fixture_value("/account/completeSignInParams");
        let params: AccountCompleteSignInParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_comment_pagination_and_deletion_dtos() {
        let list_wire = shared_high_risk_contract_fixture_value("/comments/listParamsWire");
        let list_expected =
            shared_high_risk_contract_fixture_value("/comments/listParamsNormalized");
        let list: SessionCommentsListParams = serde_json::from_value(list_wire).unwrap();
        assert_eq!(list.limit, DEFAULT_SESSION_COMMENTS_PAGE_LIMIT);
        assert_eq!(serde_json::to_value(list).unwrap(), list_expected);

        let page_expected = shared_high_risk_contract_fixture_value("/comments/page");
        let page = crate::storage::LiveChatMessagesPage {
            messages: Vec::new(),
            next_cursor: page_expected["nextCursor"].as_str().map(str::to_string),
        };
        assert_eq!(serde_json::to_value(page).unwrap(), page_expected);
        assert!(
            page_expected["nextCursor"]
                .as_str()
                .is_some_and(|cursor| cursor.contains('\n'))
        );

        let terminal_page_expected =
            shared_high_risk_contract_fixture_value("/comments/terminalPage");
        let terminal_page = crate::storage::LiveChatMessagesPage {
            messages: Vec::new(),
            next_cursor: None,
        };
        assert_eq!(
            serde_json::to_value(terminal_page).unwrap(),
            terminal_page_expected
        );

        let delete_params_wire = shared_high_risk_contract_fixture_value("/comments/deleteParams");
        let delete_params: SessionDeleteParams =
            serde_json::from_value(delete_params_wire.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(delete_params).unwrap(),
            delete_params_wire
        );

        let operation_wire = shared_high_risk_contract_fixture_value("/comments/deletionOperation");
        let operation: SessionDeletionHandle =
            serde_json::from_value(operation_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(operation).unwrap(), operation_wire);
    }
}
