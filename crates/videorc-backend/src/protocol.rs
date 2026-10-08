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
    NoiseCleanup,
    LiveCohost,
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
    /// TOTAL enabled destinations across both orientation legs (one shared cap).
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
    /// The sources currently summed into this one mixed track (plan 069: one
    /// mixed track everywhere). Empty, and omitted on the wire, for a track
    /// that carries only its `source`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mix_sources: Vec<AudioTrackSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AudioTrackSource {
    Microphone,
    TestTone,
    /// Everything the computer plays, except Videorc itself (plan 069).
    SystemAudio,
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

/// Visibility belongs to visual roles, independently of selected device IDs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceVisibility {
    #[serde(default = "default_true")]
    pub camera: bool,
    #[serde(default = "default_true")]
    pub capture: bool,
}

impl Default for SourceVisibility {
    fn default() -> Self {
        Self {
            camera: true,
            capture: true,
        }
    }
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
    /// Green-screen chroma key for the camera layer. Off by default; when on,
    /// all three render paths (CPU, Metal, FFmpeg) key with the ONE spec from
    /// `scene_geometry::camera_chroma_key` — never re-derive thresholds per path.
    #[serde(default)]
    pub camera_chroma_key_enabled: bool,
    /// Key color as `#RRGGBB`. The UI currently offers green/blue presets; the
    /// protocol takes any hex so a custom picker needs no wire change. An
    /// unparseable value keys against green (with a warning), never fails.
    #[serde(default = "default_camera_chroma_key_color")]
    pub camera_chroma_key_color: String,
    /// CbCr distance below which a pixel is fully transparent, as a percent of
    /// the calibrated range (0-100 → 0-180 distance units).
    #[serde(default = "default_camera_chroma_key_similarity_pct")]
    pub camera_chroma_key_similarity_pct: u32,
    /// Ramp band above the similarity threshold over which alpha rises 0→255
    /// (percent, same scale as similarity; 0 = hard edge).
    #[serde(default = "default_camera_chroma_key_smoothness_pct")]
    pub camera_chroma_key_smoothness_pct: u32,
    /// Spill suppression strength (percent): clamps the key channel toward the
    /// other channels' maximum on kept pixels, killing the green/blue fringe.
    #[serde(default = "default_camera_chroma_key_spill_pct")]
    pub camera_chroma_key_spill_pct: u32,
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
    /// How the SCREEN is framed inside vertical-mode scenes. Non-optional with
    /// a default on purpose (never a bare `Option`: a serialized `null` kills
    /// the renderer contract — serde null trap).
    #[serde(default)]
    pub vertical_screen_framing: VerticalScreenFraming,
    /// Preset (default) composes the fixed `layout_preset` arrangement.
    /// Freeform composes the screen + camera base and applies
    /// `source_transform_overrides` — the "arrange it yourself" mode.
    /// `layout_preset` stays meaningful in Freeform (orientation and the
    /// remembered preset to return to). Non-optional with a default on
    /// purpose (serde null trap).
    #[serde(default)]
    pub arrangement_mode: ArrangementMode,
    /// Per-source transforms for Freeform, keyed by the stable scene source id
    /// ("source:base", "source:camera"). Empty means the base arrangement.
    /// Non-optional with a default on purpose (serde null trap); serializes
    /// as an empty object, never null.
    #[serde(default)]
    pub source_transform_overrides: std::collections::BTreeMap<String, CameraTransform>,
    /// Legacy layouts show both roles. Hidden roles still keep selected IDs.
    #[serde(default)]
    pub source_visibility: SourceVisibility,
}

/// How the scene's source boxes are arranged on the canvas.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArrangementMode {
    #[default]
    Preset,
    Freeform,
}

/// Screen framing for vertical-mode scenes.
///
/// `Fill` is the short-form law (2026-07-13 fill-crop plan): every band is
/// filled and centre-cropped, never letterboxed — right for a recorded Short,
/// wrong for a live screen share, where it throws away 37-68% of the screen.
/// `Fit` shows the WHOLE screen: stacked presets size the screen band to the
/// screen's aspect (so nothing is cropped AND nothing is letterboxed) and the
/// camera covers the rest; full-canvas screen presets contain the screen over
/// the scene background (vertical simulcast screen framing plan, 2026-09-21).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VerticalScreenFraming {
    #[default]
    Fill,
    Fit,
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

fn default_camera_chroma_key_color() -> String {
    "#00FF00".to_string()
}

fn default_camera_chroma_key_similarity_pct() -> u32 {
    40
}

fn default_camera_chroma_key_smoothness_pct() -> u32 {
    8
}

fn default_camera_chroma_key_spill_pct() -> u32 {
    10
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
    VerticalCameraOnly,
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
                | LayoutPreset::VerticalCameraOnly
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
    /// Scene-motion duration in ms for THIS commit (renderer sends it when
    /// "Animate scene changes" is on). Absent/0 = instant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_ms: Option<u32>,
}

/// Backend-owned scene layout transaction. Renderer-generated intent ids are
/// monotonic for the lifetime of a backend connection; callers that predate the
/// transaction API may omit the id and let the backend allocate the next one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneLayoutApplyParams {
    #[serde(default)]
    pub intent_id: Option<u64>,
    /// Target the vertical SIMULCAST leg of a running dual-orientation
    /// session explicitly. Such a request never falls through to a program
    /// commit: one that arrives after the session stopped fails instead of
    /// turning the idle program into the portrait leg scene.
    #[serde(default)]
    pub simulcast_leg: bool,
    #[serde(flatten)]
    pub config: SceneConfigParams,
}

/// How to finish a transform edit after validating its numeric values.
/// Older callers retain edge/center snapping; precision editors send `none`
/// because their displayed geometry already includes the chosen snap policy.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SceneTransformSnap {
    None,
    #[default]
    Legacy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransformUpdateParams {
    pub source_id: String,
    pub transform: SceneTransformPatch,
    #[serde(default)]
    pub snap: SceneTransformSnap,
}

/// Resize handle of the Scene editor's selection frame. Mirrors the
/// renderer's `StageHandleId` (`components/scene/stage-transform.ts`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EditorHandleId {
    N,
    S,
    E,
    W,
    Ne,
    Nw,
    Se,
    Sw,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EditorGuideAxis {
    X,
    Y,
}

/// A snap guide line across the whole canvas; `position` is a canvas
/// fraction (0..1) along the named axis.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorGuide {
    pub axis: EditorGuideAxis,
    pub position: f64,
}

/// Selection chrome the compositor draws over the preview while the Scene
/// editor drags a source (plan 058): selection frame, resize handles and snap
/// guides. Normalised canvas coordinates. `slot_css_width` is the on-screen
/// width of the canvas slot in CSS pixels: the compositor derives the chrome
/// thickness from it and the width of the frame it actually draws into, so a
/// hairline stays a hairline whatever size the preview run composes at.
/// `scale` (preview output pixels per CSS pixel, as the renderer assumed it)
/// is the fallback for callers that do not send the slot width.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorChrome {
    pub selected: CameraTransform,
    pub handles: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_handle: Option<EditorHandleId>,
    #[serde(default)]
    pub guides: Vec<EditorGuide>,
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_css_width: Option<f64>,
}

/// One frame of the Scene editor's live drag: the ghost rect of the dragged
/// source plus the chrome to draw. Applied by the compositor at its snapshot
/// choke point; never committed, never recorded. Without a `transform` the
/// draft is chrome-only: the idle selection's frame and handles over the
/// committed picture (the stage holds one while a source is selected).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneEditorDraftParams {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<CameraTransform>,
    pub chrome: EditorChrome,
}

/// The effective editor draft the compositor is currently applying, reported
/// in `CompositorStatus.editor_draft` and by the draft RPCs so smokes can
/// assert the on-screen geometry without screenshots. `transform` is absent
/// for a chrome-only draft.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneEditorDraftStatus {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<CameraTransform>,
    /// Scene revision of the commit that ends this draft: the compositor
    /// drops the draft once its installed scene revision reaches it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_at_revision: Option<u64>,
}

/// Result of `scene.editor.draft.set` / `scene.editor.draft.clear`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneEditorDraftAck {
    /// Whether a draft is live after this call.
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_draft: Option<SceneEditorDraftStatus>,
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
        camera_chroma_key_enabled: false,
        camera_chroma_key_color: default_camera_chroma_key_color(),
        camera_chroma_key_similarity_pct: default_camera_chroma_key_similarity_pct(),
        camera_chroma_key_smoothness_pct: default_camera_chroma_key_smoothness_pct(),
        camera_chroma_key_spill_pct: default_camera_chroma_key_spill_pct(),
        camera_margin: 32,
        camera_fit: default_camera_fit(),
        camera_mirror: false,
        camera_zoom: default_camera_zoom(),
        camera_offset_x: 0,
        camera_offset_y: 0,
        side_by_side_split: default_side_by_side_split(),
        side_by_side_camera_side: default_side_by_side_camera_side(),
        vertical_screen_framing: crate::protocol::VerticalScreenFraming::Fill,
        arrangement_mode: ArrangementMode::Preset,
        source_transform_overrides: std::collections::BTreeMap::new(),
        source_visibility: Default::default(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub record_enabled: bool,
    pub stream_enabled: bool,
    pub output_directory: Option<String>,
    pub ffmpeg_path: Option<String>,
    /// Keep the capture MKV (lossless PCM audio) next to the exported MP4
    /// instead of removing it after a committed export. Off by default.
    #[serde(default)]
    pub keep_original_mkv: bool,
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
    /// Floor of the performance-check ladder (plan 090 D1): what a PC that
    /// cannot hold 720p30 records and streams at.
    #[serde(rename = "tutorial-540p30")]
    Tutorial540p30,
    #[serde(rename = "tutorial-720p30")]
    Tutorial720p30,
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
    #[serde(rename = "stream-youtube-1080p30")]
    StreamYoutube1080p30,
    #[serde(rename = "stream-youtube-1080p60")]
    StreamYoutube1080p60,
    #[serde(rename = "stream-youtube-4k30")]
    StreamYoutube4k30,
    #[serde(rename = "stream-1080p60")]
    Stream1080p60,
    #[serde(rename = "vertical-1080x1920")]
    Vertical1080x1920,
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
    Kick,
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
    /// Dual-orientation simulcast: a SECOND composed leg with its own scene
    /// geometry (the saved vertical scene) from the same captured sources.
    /// Present only when a vertical-bound destination is armed; vertical
    /// targets consume this leg, horizontal targets the primary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simulcast: Option<SimulcastParams>,
    /// Renderer click timestamp (epoch ms) for latency attribution. Telemetry
    /// only: never load-bearing for the start itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at_ms: Option<u64>,
    /// In-process only: never read from or written to the wire, so a client
    /// cannot start a hidden session.
    #[serde(skip)]
    pub purpose: SessionPurpose,
}

/// Why a session exists. `PerformanceCheck` sessions are benchmark runs owned
/// by `performance_check.rs`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SessionPurpose {
    #[default]
    Capture,
    PerformanceCheck,
}

impl SessionPurpose {
    pub fn is_performance_check(self) -> bool {
        self == Self::PerformanceCheck
    }
}

/// The vertical leg of a dual-orientation session. The layout must be a
/// vertical preset on a portrait canvas — validated per leg at session start,
/// mirroring the primary's orientation rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulcastParams {
    pub layout: LayoutSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<Scene>,
    pub video: VideoSettings,
}

/// Optional `session.stop` params. Older renderers send none.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStopParams {
    /// Renderer Stop click timestamp (epoch ms) for latency attribution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at_ms: Option<u64>,
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
    /// System audio On/Off (plan 069). Off, the default, means not captured at
    /// all. Older clients omit the key and get Off.
    #[serde(default)]
    pub system_audio_enabled: bool,
    /// System audio level in dB, within `SYSTEM_AUDIO_GAIN_DB_MIN..=MAX`.
    #[serde(default = "default_system_audio_gain_db")]
    pub system_audio_gain_db: f32,
    /// Pause System audio when it carries the streamer's own stream back
    /// into itself (plan 076). On by default; older clients omit the key.
    #[serde(default = "default_true")]
    pub system_audio_echo_guard: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            microphone_gain_db: 0.0,
            microphone_muted: false,
            microphone_sync_offset_ms: default_microphone_sync_offset_ms(),
            system_audio_enabled: false,
            system_audio_gain_db: default_system_audio_gain_db(),
            system_audio_echo_guard: true,
        }
    }
}

/// System audio level range and default (plan 069 decision 7). Games and music
/// are mastered near 0 dBFS and voice sits around -18, so -6 keeps the voice on
/// top. Mirrored in `apps/desktop/src/shared/backend.ts`. The range is read by
/// the session audio bus once it mixes a system source (plan 069 S2/S4).
#[cfg_attr(not(test), allow(dead_code))]
pub const SYSTEM_AUDIO_GAIN_DB_MIN: f32 = -24.0;
#[cfg_attr(not(test), allow(dead_code))]
pub const SYSTEM_AUDIO_GAIN_DB_MAX: f32 = 12.0;
pub const SYSTEM_AUDIO_GAIN_DB_DEFAULT: f32 = -6.0;

fn default_system_audio_gain_db() -> f32 {
    SYSTEM_AUDIO_GAIN_DB_DEFAULT
}

/// Clamp a system audio level into the supported range. A non-finite value
/// falls back to the default rather than poisoning the mix.
#[cfg_attr(not(test), allow(dead_code))]
pub fn clamp_system_audio_gain_db(gain_db: f32) -> f32 {
    if gain_db.is_finite() {
        gain_db.clamp(SYSTEM_AUDIO_GAIN_DB_MIN, SYSTEM_AUDIO_GAIN_DB_MAX)
    } else {
        SYSTEM_AUDIO_GAIN_DB_DEFAULT
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessingUpdateParams {
    pub session_id: String,
    pub microphone_gain_db: f32,
    pub microphone_muted: bool,
    /// Live System audio On/Off. Omitted means "unchanged".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_enabled: Option<bool>,
    /// Live System audio level in dB. Omitted means "unchanged".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_gain_db: Option<f32>,
    /// Live echo guard On/Off (plan 076). Omitted means "unchanged".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_echo_guard: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_microphone_gain_db: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_microphone_muted: Option<bool>,
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
    D3d11SharedTexture,
    ElectronProofSurface,
    LatestJpegPolling,
    MjpegStream,
    Unavailable,
}

impl PreviewTransport {
    pub fn is_surface(self) -> bool {
        matches!(
            self,
            PreviewTransport::NativeSurface
                | PreviewTransport::D3d11SharedTexture
                | PreviewTransport::ElectronProofSurface
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
    #[serde(rename = "directcomposition-swapchain")]
    DirectcompositionSwapChain,
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

/// `audio.mic.arm` (instant-record P5): keep the selected CoreAudio
/// microphone open while Studio is visible so `session.start` takes it
/// warm instead of opening the device and waiting for its first callback.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmMicrophoneArmParams {
    pub microphone_id: Option<String>,
    #[serde(default)]
    pub microphone_gain_db: f32,
    #[serde(default)]
    pub microphone_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WarmMicrophoneStatus {
    pub armed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// Why the microphone is not armed (`not-coreaudio`, `session-active`,
    /// `disabled-for-smoke`, `open-failed`, `disarmed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub captured_frames: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armed_for_ms: Option<u64>,
}

/// Plan 092 Phase C: the floor of a level reading. JSON cannot carry
/// -Infinity, so digital silence reads as this many dBFS.
pub const AUDIO_LEVEL_FLOOR_DB: f32 = -120.0;
/// Plan 092 Phase C: the top of a level reading. The processed microphone can
/// pass full scale (up to +24 dB of gain on a hot input); a cap keeps every
/// reading inside the renderer's schema instead of dropping the event.
pub const AUDIO_LEVEL_CEILING_DB: f32 = 48.0;

/// Plan 092 Phase C: one level-meter reading over the last `audio.levels`
/// window, in dBFS, between `AUDIO_LEVEL_FLOOR_DB` and `AUDIO_LEVEL_CEILING_DB`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelReading {
    /// The loudest sample in the window.
    pub peak_db: f32,
    /// The RMS of every sample in the window.
    pub rms_db: f32,
}

impl AudioLevelReading {
    /// A reading from a window's loudest sample and mean square (linear).
    pub fn from_window(peak: f32, mean_square: f64) -> Self {
        let peak_db = if peak > 0.0 {
            20.0 * peak.log10()
        } else {
            AUDIO_LEVEL_FLOOR_DB
        };
        let rms_db = if mean_square > 0.0 {
            (10.0 * mean_square.log10()) as f32
        } else {
            AUDIO_LEVEL_FLOOR_DB
        };
        // The guards above floor zero and NaN windows, so neither value is NaN
        // here; the clamp floors near-silence and caps a hot input.
        Self {
            peak_db: peak_db.clamp(AUDIO_LEVEL_FLOOR_DB, AUDIO_LEVEL_CEILING_DB),
            rms_db: rms_db.clamp(AUDIO_LEVEL_FLOOR_DB, AUDIO_LEVEL_CEILING_DB),
        }
    }
}

/// Plan 092 Phase C: the `audio.levels` event, about 20 times a second while a
/// session's audio bus runs, or while the warm microphone stands by between
/// sessions (microphone only, no session). Readings carry the configured gain
/// (and the session's mute): what the recording and the stream get. A source
/// with no samples in the window is omitted (never null).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelsEvent {
    /// The session whose bus measured the levels; absent for the standby
    /// microphone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<AudioLevelReading>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio: Option<AudioLevelReading>,
    /// The mix written to the recording and the stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master: Option<AudioLevelReading>,
    /// Samples the mix clipped since the previous event.
    #[serde(default)]
    pub master_clipped_samples: u64,
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
    #[serde(default)]
    pub bitrate_kbps: Option<f64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub duplicated_frames: Option<u64>,
    pub created_at: String,
}

/// The encoder a recording session actually requested. Hardware encoders may still fall
/// back internally, so this is the requested backend; the final-file analyzer's
/// codec/encoder tag is the corroborating output-side signal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EncodeBackend {
    /// libx264 (software). LEGACY: no code path selects this; Linux L1.5 uses
    /// OpenH264 for its LGPL software fallback. Kept only so historical
    /// diagnostics payloads still deserialize.
    SoftwareX264,
    /// h264_videotoolbox (hardware, sw fallback allowed).
    HardwareVideotoolbox,
    /// h264_vaapi on a capability-probed Linux DRM render node.
    HardwareVaapi,
    /// h264_mf (MediaFoundation hardware/software hybrid), used by Windows builds.
    HardwareMediaFoundation,
    /// h264_mf's software MFT fallback after the exact hardware profile probe failed.
    SoftwareMediaFoundation,
    /// libopenh264 (software): the Linux LGPL fallback and the Windows fallback
    /// after the hardware probe failed (issue #149).
    SoftwareOpenH264,
    /// h264_qsv: Intel Quick Sync driven by FFmpeg on the Windows raw path,
    /// selected only after the Media Foundation bridge was rejected and its
    /// own probe passed (plan 090 C).
    HardwareQsv,
}

/// Which FFmpeg H.264 encoder the Windows raw path may use once the Media
/// Foundation bridge is unavailable (plan 090 C). `Auto` keeps the OpenH264
/// fallback; Quick Sync is opt-in until it has run real sessions.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsH264EncoderPreference {
    #[default]
    Auto,
    QuickSync,
    Software,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderPreferenceState {
    pub preference: WindowsH264EncoderPreference,
    /// Windows with an Intel graphics adapter: the only place the choice
    /// does anything, and the only place the setting is shown.
    pub quick_sync_available: bool,
    /// The tester environment override decided `preference`; the saved
    /// setting is ignored until it is removed.
    pub env_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderPreferenceSetParams {
    pub preference: WindowsH264EncoderPreference,
}

/// One production encoder role represented by an off-air stream topology probe.
///
/// `shared` means one encoded video output feeds every enabled output. A separate
/// recording/stream pair is explicit so preflight probes the same two encoders
/// that session start will create, even when both use the same video profile.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum StreamOutputTopologyRole {
    Shared,
    Recording,
    Stream,
}

/// Secret-free input for `stream.output.topology.probe`.
///
/// The renderer sends already-normalized effective video profiles, never RTMP
/// URLs, stream keys, OAuth credentials, or a full `StartSessionParams`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamOutputTopologyProbeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
    pub stream_profile: VideoSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_profile: Option<VideoSettings>,
    pub output_roles: Vec<StreamOutputTopologyRole>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum StreamOutputBridge {
    #[serde(rename = "raw-yuv420p")]
    RawYuv420p,
    #[serde(rename = "videotoolbox-h264-annex-b")]
    VideoToolboxH264AnnexB,
    #[serde(rename = "videotoolbox-h264-mpegts")]
    VideoToolboxH264MpegTs,
    #[serde(rename = "windows-media-foundation-h264-mpegts")]
    WindowsMediaFoundationH264MpegTs,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamOutputTopologyProbeState {
    NotRequired,
    Passed,
    Rejected,
    Unsupported,
}

/// Completed output-topology verdict. The capability key is a SHA-256 over the
/// trusted FFmpeg identity, normalized profiles, roles, and requested bridge;
/// it deliberately does not expose a local executable path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamOutputTopologyProbeResult {
    pub capability_key: String,
    pub stream_profile: VideoSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_profile: Option<VideoSettings>,
    pub output_roles: Vec<StreamOutputTopologyRole>,
    pub requested_bridge_output: StreamOutputBridge,
    pub effective_bridge_output: StreamOutputBridge,
    pub effective_encode_backend: EncodeBackend,
    pub probe_state: StreamOutputTopologyProbeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

/// Outcome of the Linux VAAPI render-node policy for one `/dev/dri/renderD*`
/// node (Plan 052). `quarantined` means a previous probe of that node never
/// returned (the host hung); `skipped` means another node was pinned.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LinuxRenderNodeState {
    ProbedOk,
    Rejected,
    Quarantined,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinuxRenderNodeDiagnostic {
    pub node: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    pub state: LinuxRenderNodeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Which VAAPI argument set the Linux probe accepted (Plan 053). `compat`
/// is only ever chosen after `standard` was rejected on the same node.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LinuxVaapiArgProfile {
    #[default]
    Standard,
    Compat,
}

impl std::fmt::Display for LinuxVaapiArgProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Standard => "standard",
            Self::Compat => "compat",
        })
    }
}

/// `performance.check.run` params. The ceiling is the largest output worth
/// testing on this machine (the renderer sends the larger of the selected
/// output and the display's native size); the ladder walks down from there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceCheckRunParams {
    pub ceiling_width: u32,
    pub ceiling_height: u32,
    pub ceiling_fps: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PerformanceCheckRungVerdict {
    Passed,
    Failed,
    /// Not run: a heavier rung failed so far below realtime that this one was
    /// ruled out without spending the user's time on it.
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceCheckRung {
    pub video: VideoSettings,
    pub verdict: PerformanceCheckRungVerdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encode_backend: Option<EncodeBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_backend: Option<CompositorBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_fps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_after_stop_ms: Option<u64>,
    /// Bounded reason codes; empty when the rung passed.
    #[serde(default)]
    pub reasons: Vec<String>,
}

/// A completed check. `capability_key` names the machine the verdict belongs
/// to (OS, arch, real GPU/driver identity, desktop app version, backend
/// crate): when it no longer matches, the stored result is stale and the
/// check runs again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceCheckResult {
    pub capability_key: String,
    pub checked_at: String,
    pub app_version: String,
    pub duration_ms: u64,
    pub recommended: VideoSettings,
    /// True when nothing passed: the recommendation is the floor, unverified.
    pub below_floor: bool,
    pub rungs: Vec<PerformanceCheckRung>,
}

/// `performance.check.progress` event: which rung is being measured.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceCheckProgress {
    pub rung_index: u32,
    pub rung_count: u32,
    pub video: VideoSettings,
}

/// `performance.check.get` result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceCheckState {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<PerformanceCheckResult>,
    /// The stored result was measured on a different adapter/driver/FFmpeg.
    pub stale: bool,
}

/// Which compositor rendered the active shared-compositor frame.
///
/// - `Metal`: the GPU path (macOS OBS-parity target).
/// - `D3d11`: the Windows GPU path when the complete capture/compositor/encoder
///   capability probe agrees on one adapter and generation.
/// - `Cpu`: the CPU compositor as the expected path on platforms without a
///   supported GPU backend, and as the named Windows legacy path before a
///   D3D11 session starts.
/// - `CpuFallback`: macOS asked for Metal and could not get it — a real
///   degradation, or Windows rejected D3D11 before session start. Both stay
///   honest with a reason and count.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorBackend {
    Metal,
    D3d11,
    Cpu,
    CpuFallback,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsD3d11MediaState {
    #[default]
    Unavailable,
    Probing,
    Live,
    Draining,
    Fallback,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsD3d11CaptureBackend {
    PreviewBgraUpload,
    DesktopDuplication,
    WindowsGraphicsCaptureMonitor,
    LegacyFfmpeg,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsD3d11CursorMode {
    Embedded,
    Separate,
    ExcludedWgc,
    DisabledFallback,
}

/// One truthful, wire-safe snapshot of the Windows GPU media authority. It
/// contains scalar diagnostics only: no COM pointer, shared texture handle, or
/// HWND may cross this boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsD3d11MediaDiagnostics {
    pub state: WindowsD3d11MediaState,
    #[serde(default)]
    pub requested: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_luid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_adapter_luid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_adapter_luid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_encoder_adapter_luid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auxiliary_encoder_adapter_luid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_backend: Option<WindowsD3d11CaptureBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_mode: Option<WindowsD3d11CursorMode>,
    #[serde(default)]
    pub cursor_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_pixels_source: Option<String>,
    #[serde(default)]
    pub cursor_exclusion_guaranteed: bool,
    #[serde(default)]
    pub capture_readback_frames: u64,
    /// Frames where Windows masked protected pixels while the remaining
    /// desktop pixels continued through the D3D11 media path.
    #[serde(default)]
    pub protected_content_masked_frames: u64,
    #[serde(default)]
    pub texture_import_frames: u64,
    #[serde(default)]
    pub camera_upload_frames: u64,
    #[serde(default)]
    pub cursor_shape_uploads: u64,
    #[serde(default)]
    pub cursor_composited_frames: u64,
    #[serde(default)]
    pub compositor_cpu_fallback_frames: u64,
    #[serde(default)]
    pub preview_presents: u64,
    #[serde(default)]
    pub preview_drops: u64,
    #[serde(default)]
    pub preview_bmp_requests: u64,
    #[serde(default)]
    pub preview_bmp_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_pump_lag_p95_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_pump_lag_max_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_command_lag_p95_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_command_lag_max_ms: Option<f64>,
    #[serde(default)]
    pub maximum_consecutive_message_batch: u64,
    #[serde(default)]
    pub maximum_consecutive_media_batch: u64,
    #[serde(default)]
    pub encoder_gpu_samples: u64,
    #[serde(default)]
    pub encoder_system_memory_samples: u64,
    #[serde(default)]
    pub raw_video_copied_frames: u64,
    #[serde(default)]
    pub texture_pool_capacity: u64,
    #[serde(default)]
    pub texture_pool_in_use: u64,
    #[serde(default)]
    pub texture_pool_pressure_events: u64,
    #[serde(default)]
    pub adapter_mismatches: u64,
    #[serde(default)]
    pub device_resets: u64,
    /// Aggregate count of abnormal bounded D3D synchronization waits that
    /// expired. Normal zero-time capture polls with no new desktop frame are
    /// deliberately excluded.
    #[serde(default)]
    pub synchronization_timeouts: u64,
    #[serde(default)]
    pub stale_generation_callbacks: u64,
    /// Render-loop ticks whose work exceeded the frame interval before pacing.
    #[serde(default)]
    pub render_tick_overruns: u64,
    /// Worst overshoot of any render tick beyond its frame interval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_tick_lag_max_ms: Option<f64>,
    /// Worst observed D3D11 compose_scene stage duration on the render thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_compose_stage_max_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
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
pub struct WebSocketCommandLaneDiagnosticStats {
    pub queue: WebSocketQueueDiagnosticStats,
    pub expired_before_dispatch_count: u64,
    pub rejected_before_dispatch_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketTransportDiagnosticStats {
    pub reliable_response_queue: WebSocketQueueDiagnosticStats,
    pub incoming_command_queue: WebSocketQueueDiagnosticStats,
    pub coalesced_telemetry_queue: WebSocketQueueDiagnosticStats,
    #[serde(default)]
    pub command_lanes: std::collections::BTreeMap<String, WebSocketCommandLaneDiagnosticStats>,
    pub slow_pressure_disconnect_count: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCameraDropReasonStats {
    pub frame_was_late: u64,
    pub out_of_buffers: u64,
    pub discontinuity: u64,
    pub unknown: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScreenFrameStatusStats {
    pub complete: u64,
    pub idle: u64,
    pub blank: u64,
    pub suspended: u64,
    pub started: u64,
    pub stopped: u64,
    pub unknown: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSourceSurfaceBackingStats {
    pub live_count: u64,
    pub peak_count: u64,
    pub estimated_bytes: u64,
    pub peak_estimated_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest_age_ms: Option<u64>,
}

/// Authoritative lifecycle for one capture-recovery incident. `Failed` is a
/// latched terminal state: the backend never loops automatic restarts, and a
/// new attempt requires the explicit `capture.recovery.retry` command.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureRecoveryPhase {
    #[default]
    Idle,
    Degraded,
    Restarting,
    Verifying,
    Recovered,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureRecoveryStage {
    CameraDelivery,
    ScreenDelivery,
    CompositorRender,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureRecoverySource {
    Camera,
    Screen,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureRecoveryTrigger {
    Automatic,
    Manual,
}

/// Renderer-safe capture-recovery truth. Optional values are omitted, never
/// serialized as `null`, so a healthy/idle backend remains compatible with
/// strict optional schemas.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecoveryStatus {
    /// Monotonic process-local publication revision. Consumers must ignore a
    /// status whose revision is older than the newest revision they have
    /// already accepted.
    pub revision: u64,
    pub phase: CaptureRecoveryPhase,
    pub retryable: bool,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<CaptureRecoveryStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<CaptureRecoverySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<CaptureRecoveryTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "optional_duration_ms_is_unavailable")]
    pub last_duration_ms: Option<f64>,
}

fn optional_duration_ms_is_unavailable(value: &Option<f64>) -> bool {
    value.is_none_or(|value| !value.is_finite() || value < 0.0)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct EncoderBridgeRoleOutputPressureStats {
    pub output_queue_high_water_frames: u64,
    pub output_queue_oldest_frame_age_high_water_ms: Option<u64>,
    pub output_last_progress_age_ms: Option<u64>,
    pub output_pressure_recovery_events: u64,
    pub output_pre_encode_skipped_frames: u64,
    pub video_toolbox_pending_encode_frames: u64,
    pub video_toolbox_pending_fifo_frames: u64,
    pub encoded_access_unit_dropped_frames: u64,
}

/// Last cumulative/high-water backend sample for one split-output encoder.
/// Kept out of the public diagnostic contract; it exists only so generic
/// counters and timing high-waters can be merged without depending on which
/// role reported last.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct EncoderBridgeRoleDiagnosticStats {
    pub metal_target_frames: u64,
    pub metal_target_copied_frames: u64,
    pub metal_target_handle_frames: u64,
    pub zero_copy_frames: u64,
    pub video_toolbox_probe_frames: u64,
    pub video_toolbox_probe_bytes: u64,
    pub video_toolbox_probe_errors: u64,
    pub video_toolbox_output_encode_ms: Option<u64>,
    pub compositor_wait_p95_ms: Option<f64>,
    pub video_toolbox_submit_p95_ms: Option<f64>,
    pub raw_video_fifo_write_p95_ms: Option<f64>,
    pub video_toolbox_fifo_write_p95_ms: Option<f64>,
    pub video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    pub video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    pub writer_loop_p95_ms: Option<f64>,
    pub writer_sleep_p95_ms: Option<f64>,
    pub writer_active_p95_ms: Option<f64>,
    pub deadline_lag_p95_ms: Option<f64>,
    pub deadline_lag_max_ms: Option<f64>,
    pub late_deadline_ticks: u64,
    pub schedule_skipped_ms: u64,
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
    /// Peak combined pending encoder + FIFO depth observed by an output bridge.
    #[serde(default)]
    pub encoder_bridge_output_queue_high_water_frames: u64,
    /// Oldest frame currently waiting for VideoToolbox completion or FIFO output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_output_queue_oldest_frame_age_ms: Option<u64>,
    /// Peak oldest-frame age retained after a pressured queue recovers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_output_queue_oldest_frame_age_high_water_ms: Option<u64>,
    /// Milliseconds since the most recent encoder completion or complete FIFO AU write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_output_last_progress_age_ms: Option<u64>,
    /// Cumulative enqueue attempts that encountered a full bounded output queue.
    #[serde(default)]
    pub encoder_bridge_output_queue_capacity_pressure_events: u64,
    /// Cumulative pressured intervals that returned to the healthy budget.
    #[serde(default)]
    pub encoder_bridge_output_pressure_recovery_events: u64,
    /// Cumulative frames intentionally discarded by output backpressure policy.
    #[serde(default)]
    pub encoder_bridge_output_queue_dropped_frames: u64,
    /// Recording compositor ticks skipped before encode while queued AUs drain.
    #[serde(default)]
    pub encoder_bridge_output_pre_encode_skipped_frames: u64,
    /// Current VideoToolbox callback/in-flight and FIFO-writer stage depths.
    #[serde(default)]
    pub encoder_bridge_video_toolbox_pending_encode_frames: u64,
    #[serde(default)]
    pub encoder_bridge_video_toolbox_pending_fifo_frames: u64,
    /// Encoded H.264 access units rejected after encode; zero is required.
    #[serde(default)]
    pub encoder_bridge_encoded_access_unit_dropped_frames: u64,
    /// Last role-local pressure samples used to build the aggregate fields above.
    /// These are process-internal because the public diagnostic contract already
    /// exposes the useful aggregate plus the established per-role queue fields.
    /// Keeping the samples here prevents a quiet split-output role from erasing
    /// pressure evidence emitted by the other role.
    #[serde(skip)]
    pub(crate) encoder_bridge_recording_output_pressure: EncoderBridgeRoleOutputPressureStats,
    #[serde(skip)]
    pub(crate) encoder_bridge_stream_output_pressure: EncoderBridgeRoleOutputPressureStats,
    /// Role-local samples used to build generic split-output sums/high-waters.
    /// Starting diagnostics reset both fields, preventing prior-session state
    /// from entering a new recording.
    #[serde(skip)]
    pub(crate) encoder_bridge_recording_role_diagnostics: EncoderBridgeRoleDiagnosticStats,
    #[serde(skip)]
    pub(crate) encoder_bridge_stream_role_diagnostics: EncoderBridgeRoleDiagnosticStats,
    pub encoder_bridge_input_fps: Option<f64>,
    pub encoder_bridge_dropped_frames: u64,
    /// FFmpeg progress-reported drops attributable to the recording bridge.
    #[serde(default)]
    pub encoder_bridge_recording_dropped_frames: u64,
    /// FFmpeg progress-reported drops attributable to the stream bridge.
    #[serde(default)]
    pub encoder_bridge_stream_dropped_frames: u64,
    /// FFmpeg progress-reported encoder speed for the recording bridge.
    #[serde(default)]
    pub encoder_bridge_recording_encoder_speed: Option<f64>,
    /// FFmpeg progress-reported encoder speed for the stream bridge.
    #[serde(default)]
    pub encoder_bridge_stream_encoder_speed: Option<f64>,
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
    /// Raw-video FFmpeg writes attributable to the recording bridge.
    #[serde(default)]
    pub encoder_bridge_recording_raw_video_copied_frames: u64,
    /// Raw-video FFmpeg writes attributable to the stream bridge.
    #[serde(default)]
    pub encoder_bridge_stream_raw_video_copied_frames: u64,
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
    /// Generic encoded-output backend selected for this session.
    #[serde(default)]
    pub encoder_bridge_encoded_output_backend: Option<String>,
    #[serde(default)]
    pub encoder_bridge_requested_video_output: Option<String>,
    #[serde(default)]
    pub encoder_bridge_effective_video_output: Option<String>,
    #[serde(default)]
    pub encoder_bridge_encoded_output_encoder_identity: Option<String>,
    #[serde(default)]
    pub encoder_bridge_encoded_output_input_subtype: Option<String>,
    #[serde(default)]
    pub encoder_bridge_encoded_output_fallback_reason: Option<String>,
    /// Cross-platform aliases populated by both VideoToolbox and Media Foundation.
    #[serde(default)]
    pub encoder_bridge_encoded_output_frames: u64,
    #[serde(default)]
    pub encoder_bridge_encoded_output_bytes: u64,
    #[serde(default)]
    pub encoder_bridge_encoded_output_errors: u64,
    #[serde(default)]
    pub encoder_bridge_encoded_submit_p95_ms: Option<f64>,
    #[serde(default)]
    pub encoder_bridge_encoded_fifo_write_p95_ms: Option<f64>,
    #[serde(default)]
    pub encoder_bridge_active_encoded_output_encoders: u64,
    #[serde(default)]
    pub encoder_bridge_recording_encoded_output_frames: u64,
    #[serde(default)]
    pub encoder_bridge_recording_encoded_output_bytes: u64,
    #[serde(default)]
    pub encoder_bridge_stream_encoded_output_frames: u64,
    #[serde(default)]
    pub encoder_bridge_stream_encoded_output_bytes: u64,
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
    /// Latest measured FFmpeg output bitrate for the active stream.
    #[serde(default)]
    pub stream_measured_bitrate_kbps: Option<f64>,
    /// Lowest non-zero measured output bitrate observed in this stream session.
    #[serde(default)]
    pub stream_measured_bitrate_min_kbps: Option<f64>,
    /// Highest non-zero measured output bitrate observed in this stream session.
    #[serde(default)]
    pub stream_measured_bitrate_max_kbps: Option<f64>,
    /// Cumulative bytes emitted by FFmpeg for this stream process generation.
    #[serde(default)]
    pub stream_output_total_bytes: u64,
    /// Cumulative frames FFmpeg reports duplicating for this stream process generation.
    #[serde(default)]
    pub stream_duplicated_frames: u64,
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
    /// In split-output sessions the generic timing fields below are the worst
    /// role-local session high-water. This keeps them truthful and independent
    /// of report order; established role-specific writer fields remain below.
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
    /// Linux only: every render node the VAAPI policy saw and what it did
    /// with it, so the evidence names the GPU that encoded (Plan 052).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux_render_nodes: Option<Vec<LinuxRenderNodeDiagnostic>>,
    /// Linux VAAPI only: the argument profile the session encodes with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux_vaapi_arg_profile: Option<LinuxVaapiArgProfile>,
    /// Which compositor backend produced the most recent diagnostic window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_backend: Option<CompositorBackend>,
    /// Reason the shared compositor had to use CPU fallback.
    #[serde(default)]
    pub compositor_fallback_reason: Option<String>,
    /// Cumulative frames rendered by the CPU compositor as the platform's
    /// expected path (no GPU compositor exists off macOS). Never a fault.
    #[serde(default)]
    pub compositor_cpu_frames: u64,
    /// Cumulative frames rendered by CPU FALLBACK during the active compositor
    /// run: a GPU compositor was expected and not reached. Nonzero is a fault.
    #[serde(default)]
    pub compositor_cpu_fallback_frames: u64,
    /// Cumulative render ticks of the active record/stream compositor run
    /// (not the preview-only compositor). Frame accounting at stop.
    #[serde(default)]
    pub compositor_ticks: u64,
    /// Cumulative frame intervals the record/stream compositor loop missed
    /// entirely (ticks it was too late to render). Frame accounting at stop.
    #[serde(default)]
    pub compositor_tick_skipped: u64,
    /// Recording-leg bridge writer ticks that fed a fresh compositor frame.
    #[serde(default)]
    pub encoder_bridge_fresh_frames: u64,
    /// Frames the recording-leg bridge submitted to the Media Foundation
    /// encoder (Windows only; zero elsewhere).
    #[serde(default)]
    pub encoder_bridge_mf_submitted_frames: u64,
    /// Writer-thread Media Foundation input-credit waits that hit the
    /// two-frame cap and skipped the frame instead of stalling the schedule.
    #[serde(default)]
    pub encoder_bridge_mf_input_credit_timeouts: u64,
    /// P95 wall time the writer thread spent waiting for a Media Foundation
    /// input credit (Windows only). MUST skip when None: the renderer contract
    /// validates this key with a finite-number schema, and serde would emit
    /// `null` — which blocked every macOS session start in 0.9.68–0.9.70.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_mf_input_credit_wait_p95_ms: Option<f64>,
    /// Scalar-only state for the Windows D3D11 capture/compositor/presenter/MF
    /// authority. This remains present (with `unavailable`) on other platforms
    /// so support-bundle and renderer contracts stay deterministic.
    #[serde(default)]
    pub windows_d3d11_media: WindowsD3d11MediaDiagnostics,
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
    /// Cumulative held capture frames that reused an already imported Metal texture.
    #[serde(default)]
    pub compositor_source_capture_texture_reuses: u64,
    /// Camera subset of held capture texture reuses.
    #[serde(default)]
    pub compositor_camera_source_capture_texture_reuses: u64,
    /// Screen/window subset of held capture texture reuses.
    #[serde(default)]
    pub compositor_screen_source_capture_texture_reuses: u64,
    /// Completed-command boundaries that flushed the CoreVideo Metal texture cache.
    #[serde(default)]
    pub compositor_source_texture_cache_flushes: u64,
    /// Cached capture-source CVMetalTexture/IOSurface imports currently retained.
    /// Absent off macOS, where the Metal ownership path does not exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_metal_cached_capture_source_imports_live_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_metal_cached_capture_source_imports_peak_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_metal_cached_capture_source_imports_ceiling: Option<u64>,
    /// IOSurface-backed Metal compositor target-ring slots retained process-wide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_metal_target_ring_slots_live_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_metal_target_ring_slots_peak_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_metal_target_ring_slots_ceiling: Option<u64>,
    /// Encoder completion guards still retaining an IOSurface target frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_metal_target_refs_in_flight_live_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_metal_target_refs_in_flight_peak_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_bridge_metal_target_refs_in_flight_ceiling: Option<u64>,
    /// Native presenter cache lifetime accounting reported by Electron main.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_live_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_peak_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_ceiling: Option<u64>,
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
    /// Cumulative compositor ticks that served a camera frame the capture
    /// pipeline had replaced since the previous tick (fresh content).
    #[serde(default)]
    pub compositor_camera_source_fresh_serves: u64,
    /// Cumulative compositor ticks that re-served the identical camera frame
    /// handle as the previous tick (held content; the producer delivered
    /// nothing new). Held ≫ fresh during a session is the frozen-recording
    /// signature of the 0.9.71 second-session lag.
    #[serde(default)]
    pub compositor_camera_source_held_serves: u64,
    /// Oldest capture age (ms) of any camera frame the compositor served.
    #[serde(default)]
    pub compositor_camera_source_served_age_max_ms: u64,
    /// Cumulative compositor ticks that served a fresh screen/window frame.
    #[serde(default)]
    pub compositor_screen_source_fresh_serves: u64,
    /// Cumulative compositor ticks that re-served the identical screen/window
    /// frame handle as the previous tick.
    #[serde(default)]
    pub compositor_screen_source_held_serves: u64,
    /// Oldest capture age (ms) of any screen/window frame the compositor served.
    #[serde(default)]
    pub compositor_screen_source_served_age_max_ms: u64,
    /// The pipeline stage the capture-health monitor currently declares
    /// degraded (`camera-delivery` / `compositor-render`), or absent while
    /// healthy. skip_serializing_if is load-bearing: the renderer contract
    /// accepts undefined, and a serialized `null` here is the app-killing
    /// defect class of 0.9.68 and 0.9.79 ([[videorc-serde-null-contract-trap]]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_pipeline_degraded_stage: Option<String>,
    /// Recovery fields are absent while idle. This is intentionally separate
    /// from `capturePipelineDegradedStage`: health detects the fault, while
    /// recovery owns restart/verification authority and its failure latch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_recovery_phase: Option<CaptureRecoveryPhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_recovery_source: Option<CaptureRecoverySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_recovery_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_recovery_last_error: Option<String>,
    #[serde(default, skip_serializing_if = "optional_duration_ms_is_unavailable")]
    pub capture_recovery_last_duration_ms: Option<f64>,
    pub preview_repeated_frames: u64,
    pub preview_surface_resize_count: u64,
    pub preview_latency_ms: Option<u64>,
    pub preview_dropped_frames: u64,
    pub preview_camera_frame_age_ms: Option<u64>,
    pub preview_camera_source_fps: Option<f64>,
    pub preview_camera_dropped_frames: u64,
    /// AVFoundation didOutput callbacks observed before any FrameStore validation/publication.
    #[serde(default)]
    pub preview_camera_capture_callback_count: u64,
    /// AVFoundation didDrop callbacks, independent of locally rejected didOutput samples.
    #[serde(default)]
    pub preview_camera_did_drop_callback_count: u64,
    /// Camera frames successfully published to the shared FrameStore.
    #[serde(default)]
    pub preview_camera_frame_store_publications: u64,
    /// Age of the latest AVFoundation didOutput callback, even if it did not publish a frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_camera_capture_callback_age_ms: Option<u64>,
    /// Latest camera FrameStore sequence visible to consumers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_camera_latest_sequence: Option<u64>,
    /// FourCC delivered by the latest valid AVFoundation sample.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_camera_capture_pixel_format: Option<String>,
    #[serde(default)]
    pub preview_camera_drop_reasons: PreviewCameraDropReasonStats,
    #[serde(default)]
    pub preview_camera_surface_backing: PreviewSourceSurfaceBackingStats,
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
    /// ScreenCaptureKit callbacks observed before status/image validation.
    #[serde(default)]
    pub preview_screen_capture_callback_count: u64,
    /// Screen frames successfully published to the shared FrameStore.
    #[serde(default)]
    pub preview_screen_frame_store_publications: u64,
    /// Age of the latest ScreenCaptureKit callback, including non-complete statuses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_screen_capture_callback_age_ms: Option<u64>,
    /// Latest screen FrameStore sequence visible to consumers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_screen_latest_sequence: Option<u64>,
    #[serde(default)]
    pub preview_screen_frame_statuses: PreviewScreenFrameStatusStats,
    #[serde(default)]
    pub preview_screen_surface_backing: PreviewSourceSurfaceBackingStats,
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
    /// Whether the latest Windows Graphics Capture frame retained its D3D11 source texture.
    #[serde(default)]
    pub preview_screen_d3d11_texture_available: Option<bool>,
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
    /// CPU buffers currently owned by the camera/screen stores and spare pools.
    pub preview_source_frame_buffer_count: u64,
    /// CPU bytes currently owned by the camera/screen stores and spare pools.
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
    /// System audio live meter level (0-1, dB-scaled), plan 069. Omitted,
    /// never null, while no system source is attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_live_level: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_live_peak_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_captured_frames: Option<u64>,
    /// True while a system audio source is attached to the session's audio bus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_active: Option<bool>,
    /// Samples the mix limiter had to pull under its ceiling this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_mix_clipped_samples: Option<u64>,
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
    /// Phase timeline of the most recent `session.start` (instant-record plan).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_start_timeline: Option<RecordingTimelineSnapshot>,
    /// Phase timeline of the most recent stop, including background finalization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_stop_timeline: Option<RecordingTimelineSnapshot>,
    pub updated_at: String,
}

/// One phase boundary of a start/stop timeline, milliseconds since the
/// timeline origin (backend admission of the request).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTimelineMark {
    pub phase: String,
    pub at_ms: u64,
}

/// Typed start/stop latency timeline published in `diagnostics.stats`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTimelineSnapshot {
    /// `start` | `stop`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// True for the first start in this backend process (start timelines only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cold: Option<bool>,
    /// Renderer click time (epoch ms) when the renderer supplied one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at_epoch_ms: Option<u64>,
    /// Renderer click → backend admission, when plausible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub click_to_origin_ms: Option<u64>,
    pub total_ms: u64,
    pub outcome: String,
    #[serde(default)]
    pub marks: Vec<RecordingTimelineMark>,
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
    // Corner radius in POINTS for the native surface (CALayer works in points;
    // contentsScale handles pixels). Docked previews pass the panel radius so
    // the surface clips to the rounded slot instead of poking square corners
    // past it; absent/0 = square (floating window, legacy callers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
}

/// Validated opaque HWND identity used only by Electron main and the backend
/// presenter. The fixed-width string form prevents JavaScript precision loss
/// and is never embedded in renderer-visible status or events.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OpaqueNativeWindowHandle(String);

impl OpaqueNativeWindowHandle {
    pub fn parse(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        let bytes = value.as_bytes();
        if bytes.len() != 18
            || !value.starts_with("0x")
            || !bytes[2..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
            || value == "0x0000000000000000"
        {
            return Err(
                "native window handle must be a nonzero lowercase 0x-prefixed 64-bit value"
                    .to_string(),
            );
        }
        Ok(Self(value))
    }

    #[cfg(any(target_os = "windows", test))]
    pub fn as_u64(&self) -> u64 {
        u64::from_str_radix(&self.0[2..], 16)
            .expect("validated native window handles always contain hexadecimal digits")
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for OpaqueNativeWindowHandle {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for OpaqueNativeWindowHandle {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Privileged request-only bounds. Flattening preserves the established
/// geometry wire shape while keeping the HWND out of `PreviewSurfaceBounds`
/// and therefore out of renderer-visible `PreviewSurfaceStatus`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MainOwnedPreviewSurfaceBounds {
    #[serde(flatten)]
    pub bounds: PreviewSurfaceBounds,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_above_window_handle: Option<OpaqueNativeWindowHandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MainOwnedPreviewSurfaceBoundsParams {
    pub bounds: MainOwnedPreviewSurfaceBounds,
    pub generation: u64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_live_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_peak_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_ceiling: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub frame_polling_suppressed: bool,
    #[serde(default)]
    pub source_pixels_present: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsD3d11PresenterBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Renderer-safe readback from the backend-owned Windows presenter. Raw HWNDs
/// and process IDs intentionally never enter this status object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsD3d11PresenterDiagnostics {
    /// Generation of the backend-owned D3D11 media authority. This remains
    /// scalar and renderer-safe while allowing Electron to reject a delayed
    /// status callback from a retired authority deterministically.
    #[serde(default)]
    pub media_generation: u64,
    pub layered: bool,
    pub transparent: bool,
    pub no_activate: bool,
    pub excluded_from_capture: bool,
    pub window_active: bool,
    pub window_focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_generation: Option<u64>,
    pub generation_matches: bool,
    pub owner_process_matches: bool,
    pub same_adapter: bool,
    pub source_live: bool,
    pub first_present_succeeded: bool,
    pub successful_presents: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_presented_sequence: Option<u64>,
    pub latest_wins_drops: u64,
    pub hidden_drops: u64,
    pub busy_drops: u64,
    pub stale_frame_drops: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_bounds: Option<WindowsD3d11PresenterBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_live_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_peak_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_preview_iosurface_import_ceiling: Option<u64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_d3d11_presenter: Option<WindowsD3d11PresenterDiagnostics>,
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
    /// The Scene editor draft the compositor is applying to this run, if any
    /// (plan 058). Absent while no drag is live; never present during a
    /// session. `skip_serializing_if` keeps `None` off the wire because the
    /// renderer's optional contract fields reject `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_draft: Option<SceneEditorDraftStatus>,
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
    /// Scene-motion duration in ms (clamped to 1000): the previous scene's
    /// transforms glide to this one. Absent/0 = instant switch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_ms: Option<u32>,
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
    pub d3d11_texture_available: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_from_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_kind: Option<String>,
    /// Plan 119 S13: present only on a derived row Clean cut rendered, from a
    /// join on `clean_cut_jobs.output_session_id`. `processing_kind` stays
    /// absent for these rows (decision 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_cut_of_session_id: Option<String>,
    /// `clean` or `condensed`, next to `clean_cut_of_session_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_cut_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalization_state: Option<RecordingFinalizationState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalization_error: Option<String>,
}

/// Bounded, renderer-facing Library row. Histories intentionally live behind
/// their cursor-paginated detail methods so refreshing the Library never
/// serializes every event, log line, or AI payload for every session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListItem {
    pub id: String,
    pub title: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub status: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mp4_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_status: Option<GateStatus>,
    pub health_event_count: u64,
    pub session_log_count: u64,
    pub ai_artifact_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ready_ai_artifact_kinds: Vec<AiArtifactKind>,
    pub comment_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_from_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_kind: Option<String>,
    /// Plan 119 S13: the source session of a Clean cut output row, from a
    /// join on `clean_cut_jobs.output_session_id`. Never set together with a
    /// `processing_kind` (decision 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_cut_of_session_id: Option<String>,
    /// `clean` or `condensed`, next to `clean_cut_of_session_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_cut_mode: Option<String>,
    /// Background MP4 finalization (instant-record P2). Absent for rows that
    /// finished inline (legacy) or never recorded a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalization_state: Option<RecordingFinalizationState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalization_progress_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalization_error: Option<String>,
}

/// Progress of a background recording finalization job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFinalizationEvent {
    pub session_id: String,
    pub state: RecordingFinalizationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListPage {
    pub items: Vec<SessionListItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_session_list_page_limit")]
    pub limit: usize,
}

pub const DEFAULT_SESSION_LIST_PAGE_LIMIT: usize = 50;

fn default_session_list_page_limit() -> usize {
    DEFAULT_SESSION_LIST_PAGE_LIMIT
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDetailListParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_session_detail_page_limit")]
    pub limit: usize,
}

pub const DEFAULT_SESSION_DETAIL_PAGE_LIMIT: usize = 120;

fn default_session_detail_page_limit() -> usize {
    DEFAULT_SESSION_DETAIL_PAGE_LIMIT
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealthEventsPage {
    pub events: Vec<HealthEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogsPage {
    pub entries: Vec<SessionLogEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAiArtifactsPage {
    pub artifacts: Vec<AiArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NoiseCleanupJobStatus {
    Queued,
    Processing,
    Validating,
    Completed,
    Failed,
    Cancelled,
}

impl NoiseCleanupJobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Processing => "processing",
            Self::Validating => "validating",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Processing | Self::Validating)
    }
}

impl std::str::FromStr for NoiseCleanupJobStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "processing" => Ok(Self::Processing),
            "validating" => Ok(Self::Validating),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(format!("Unknown Noise Cleanup job status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoiseCleanupJob {
    pub id: String,
    pub source_session_id: String,
    pub status: NoiseCleanupJobStatus,
    pub progress_percent: u8,
    pub preset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoiseCleanupStartParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoiseCleanupCancelParams {
    pub job_id: String,
}

// ---------------------------------------------------------------------------
// Clean cut (plan 119 S12a/S12b): a durable job per (source session, mode)
// that transcribes a finished recording word for word, finds what to cut and
// builds a frame-exact cut list (the EDL). S13 renders it into a derived
// session. Wire shapes are mirrored in `shared/backend.ts` and validated by
// the closed schemas in `shared/backend-rpc-contract.ts`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum CleanCutMode {
    Clean,
    Condensed,
}

impl CleanCutMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Condensed => "condensed",
        }
    }
}

impl std::str::FromStr for CleanCutMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "clean" => Ok(Self::Clean),
            "condensed" => Ok(Self::Condensed),
            _ => Err(format!("Unknown Clean cut mode: {value}")),
        }
    }
}

/// `queued → transcribing → analyzing → ready` is built here (S12a/S12b);
/// `ready → rendering → validating → completed` is S13's. `failed` and
/// `cancelled` are terminal; a failed job is resumed by starting a new one for
/// the same source and mode, which reuses every chunk already transcribed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CleanCutJobState {
    Queued,
    Transcribing,
    Analyzing,
    Ready,
    Rendering,
    Validating,
    Completed,
    Failed,
    Cancelled,
}

impl CleanCutJobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Transcribing => "transcribing",
            Self::Analyzing => "analyzing",
            Self::Ready => "ready",
            Self::Rendering => "rendering",
            Self::Validating => "validating",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// A worker owns the job: it holds (or waits for) the maintenance slot
    /// and the source recording must not be mutated underneath it. `ready`
    /// is neither active nor final: it waits for review or a render.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::Transcribing
                | Self::Analyzing
                | Self::Rendering
                | Self::Validating
        )
    }
}

impl std::str::FromStr for CleanCutJobState {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "transcribing" => Ok(Self::Transcribing),
            "analyzing" => Ok(Self::Analyzing),
            "ready" => Ok(Self::Ready),
            "rendering" => Ok(Self::Rendering),
            "validating" => Ok(Self::Validating),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(format!("Unknown Clean cut job state: {value}")),
        }
    }
}

/// Why a span is removed. `false_start` keeps the server's spelling.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CleanCutRemovalKind {
    Head,
    Tail,
    Silence,
    Gap,
    Filler,
    Retake,
    FalseStart,
    Condensed,
    Manual,
}

/// The source frame grid (ffprobe `r_frame_rate` as `num/den`). Every cut
/// boundary is a frame index on it, so audio and video segments have equal
/// lengths when S13 renders.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutFrameRate {
    pub num: u32,
    pub den: u32,
}

/// Path, size and modification time of the source MP4 the cut list was built
/// from. S13 refuses to render when the file no longer matches.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutSourceIdentity {
    pub path: String,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutRemoval {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Frame indices on the source grid; `end_frame` is exclusive. These are
    /// exact where the millisecond values are rounded for display.
    pub start_frame: u64,
    pub end_frame: u64,
    pub kind: CleanCutRemovalKind,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutKindStat {
    pub kind: CleanCutRemovalKind,
    pub count: u32,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutEdlStats {
    /// Enabled removals only, one entry per kind present, in kind order.
    #[serde(default)]
    pub by_kind: Vec<CleanCutKindStat>,
    pub kept_ms: u64,
}

/// The cut list, version 1. Stored as `clean_cut_jobs.edl_json` and returned
/// whole by `cleanCut.get` and `cleanCut.updateEdl`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutEdl {
    pub version: u32,
    pub source_identity: CleanCutSourceIdentity,
    pub frame_rate: CleanCutFrameRate,
    pub duration_ms: u64,
    #[serde(default)]
    pub removals: Vec<CleanCutRemoval>,
    pub stats: CleanCutEdlStats,
}

/// The small part of the cut list that rides on every job snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutEdlSummary {
    pub duration_ms: u64,
    pub kept_ms: u64,
    pub removal_count: u32,
    #[serde(default)]
    pub by_kind: Vec<CleanCutKindStat>,
}

impl CleanCutEdl {
    /// The snapshot-sized view of a cut list.
    pub fn summary(&self) -> CleanCutEdlSummary {
        CleanCutEdlSummary {
            duration_ms: self.duration_ms,
            kept_ms: self.stats.kept_ms,
            removal_count: u32::try_from(self.removals.len()).unwrap_or(u32::MAX),
            by_kind: self.stats.by_kind.clone(),
        }
    }
}

/// Durable Clean cut job state, also the `cleanCut.status` event payload.
/// The renderer never infers completion from anything else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutJob {
    pub id: String,
    pub source_session_id: String,
    pub mode: CleanCutMode,
    pub state: CleanCutJobState,
    /// Free-form, bounded: `extract-audio`, `probe`, `upload`, `stitch`,
    /// `analyze`, `cut-list`. Never a closed enum on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// 0..1 across the whole job.
    pub progress: f64,
    pub edl_revision: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edl_summary: Option<CleanCutEdlSummary>,
    /// `<Artifacts>/<sessionId>/clean-cut/transcript.words.json` once stitched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One kept range of a Condensed selection, mapped from the analysis `keeps`
/// (segment ids) to recording time. S13 adds it to `cleanCut.get` entries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutCondensedKeep {
    pub start_ms: u64,
    pub end_ms: u64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutJobDetail {
    pub job: CleanCutJob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edl: Option<CleanCutEdl>,
    /// Condensed jobs only, and only once the analysis answered; omitted for
    /// clean jobs and when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub condensed_keeps: Vec<CleanCutCondensedKeep>,
}

/// `cleanCut.render`: render the current cut list revision again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutRenderParams {
    pub job_id: String,
}

/// `cleanCut.transcript`: the stitched words and sentence segments of a job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutTranscriptParams {
    pub job_id: String,
}

/// One word of `cleanCut.transcript`. `filler` is written only when true.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutTranscriptWord {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub filler: bool,
}

/// One sentence of `cleanCut.transcript`: the analysis job's segment ids.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutTranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `cleanCut.transcript` result. `language` is `null` when the provider
/// reported none: the S13/S14 interface spells it `string | null`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutTranscript {
    pub job_id: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub words: Vec<CleanCutTranscriptWord>,
    #[serde(default)]
    pub segments: Vec<CleanCutTranscriptSegment>,
}

/// `cleanCut.get`: the latest job per mode for one source session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanCutGetResult {
    pub session_id: String,
    #[serde(default)]
    pub jobs: Vec<CleanCutJobDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutStartParams {
    pub session_id: String,
    pub mode: CleanCutMode,
    /// The Cloud AI consent the renderer holds; `false` is refused.
    pub consent_to_upload_audio: bool,
    /// Condensed only: 120..3600 seconds, default 900.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_duration_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutGetParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutCancelParams {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutRemovalToggle {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutManualRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `cleanCut.updateEdl`: optimistic on `revision`. Toggles flip `enabled` on
/// existing removals; `addManual` adds frame-snapped `manual` removals;
/// `removeManual` deletes manual removals by id. Nothing is re-merged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanCutUpdateEdlParams {
    pub job_id: String,
    pub revision: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removals: Vec<CleanCutRemovalToggle>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_manual: Vec<CleanCutManualRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_manual: Vec<String>,
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

// --- Live Co-host RPC params (mirrored in shared/backend.ts) ---

/// `cohost.start`. Consent is renderer-owned state (the cloud-AI consent
/// toggle), so the renderer passes it explicitly on every start; the backend
/// never assumes it. `streamTitle` is optional context for the model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostStartParams {
    pub session_id: String,
    #[serde(default)]
    pub consent_to_process_chat: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_title: Option<String>,
}

/// `cohost.question.answered` / `cohost.question.dismiss` /
/// `cohost.question.restore`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostQuestionParams {
    pub session_id: String,
    pub question_id: String,
}

/// `cohost.flag.dismiss`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostFlagParams {
    pub session_id: String,
    pub message_id: String,
}

/// `cohost.promise.done` / `cohost.promise.dismiss` (plan 068 D8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPromiseParams {
    pub session_id: String,
    pub promise_id: String,
}

/// `cohost.recap.dismiss` / `cohost.recap.draft` (plan 068 D8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostRecapParams {
    pub session_id: String,
}

/// `cohost.author.greeted` (plan 068 D9): `authorKey` as `sayHi` carries it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAuthorParams {
    pub session_id: String,
    pub author_key: String,
}

/// `cohost.settings.set`: every field optional; absent fields are unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<crate::cohost::CohostTone>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_highlight: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_highlight: Option<bool>,
    /// Replaces the whole list; the engine normalises it (trim, <= 10 x 120).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    /// Orcle hears the microphone while live (plan 068 D2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<bool>,
    /// Voice commands need "Orcle" first (plan 140 S3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_word_required: Option<bool>,
    /// How a voice removal is confirmed (plan 140 S3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_confirm: Option<crate::live_chat_moderation::RemoveConfirmMode>,
}

/// `cohost.command.choose` (plan 140 S3): pick one comment from the chooser
/// the latest voice command opened. `index` is 0 to 2.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandChooseParams {
    pub command_id: String,
    pub index: u8,
}

/// `cohost.command.confirm` / `cohost.command.cancel` (plan 140 S3): answer
/// the card the latest voice command opened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandParams {
    pub command_id: String,
}

// --- Orcle report (plan 119 S1; mirrored in shared/backend.ts) ---

/// The report format this build writes and reads. A stored report with any
/// other version reads as unavailable, never as an error.
pub const COHOST_SESSION_REPORT_VERSION: u32 = 1;
/// Questions logged per report (first seen first).
pub const COHOST_REPORT_QUESTIONS_CAP: usize = 200;
/// Open promises kept at stop.
pub const COHOST_REPORT_OPEN_PROMISES_CAP: usize = 20;
/// Asker names kept per logged question.
pub const COHOST_REPORT_ASKERS_CAP: usize = 5;

/// `cohost.report.get`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportGetParams {
    pub session_id: String,
}

/// `cohost.report.saved`: a report for this session was written (or folded
/// into the one already there).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportSavedEvent {
    pub session_id: String,
}

/// What became of a question Orcle caught. The latest outcome wins; a
/// restore puts it back to `open`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostReportQuestionOutcome {
    Open,
    AnsweredOnAir,
    Replied,
    MarkedAnswered,
    Dismissed,
    /// Still open, but its comment was on stream.
    Shown,
}

/// One question in the report's log. Optional lists are omitted while empty,
/// never null.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportQuestion {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub askers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<crate::streaming::StreamPlatform>,
    pub priority: crate::cohost::CohostPriority,
    pub first_seen_at: String,
    pub outcome: CohostReportQuestionOutcome,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportQuestions {
    /// Distinct question ids Orcle surfaced.
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub marked_answered: u64,
    #[serde(default)]
    pub dismissed: u64,
    #[serde(default)]
    pub replied: u64,
    #[serde(default)]
    pub answered_on_air: u64,
    #[serde(default)]
    pub restored: u64,
    #[serde(default)]
    pub shown_on_stream: u64,
    /// First seen first, at most `COHOST_REPORT_QUESTIONS_CAP`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<CohostReportQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportFlagKindCount {
    pub kind: crate::cohost::CohostFlagKind,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportFlagSeverityCount {
    pub severity: crate::cohost::CohostFlagSeverity,
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportFlags {
    /// Each flagged message id counted once.
    #[serde(default)]
    pub raised: u64,
    #[serde(default)]
    pub dismissed: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_kind: Vec<CohostReportFlagKindCount>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_severity: Vec<CohostReportFlagSeverityCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportOpenPromise {
    pub text: String,
    pub first_seen_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportPromises {
    /// New promise ids heard this session.
    #[serde(default)]
    pub heard: u64,
    /// Marked done, or the transcript showed they were kept.
    #[serde(default)]
    pub kept: u64,
    #[serde(default)]
    pub dismissed: u64,
    #[serde(default)]
    pub reminded: u64,
    /// Still open when the session ended, oldest first, at most
    /// `COHOST_REPORT_OPEN_PROMISES_CAP`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open: Vec<CohostReportOpenPromise>,
}

/// Greeting totals over every chatter of the session (plan 068 D9).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportGreetings {
    /// Viewers whose first message in the channel landed this session.
    #[serde(default)]
    pub first_timers: u64,
    #[serde(default)]
    pub first_timers_greeted: u64,
    #[serde(default)]
    pub by_voice: u64,
    #[serde(default)]
    pub by_chat: u64,
    /// Their comment went on stream.
    #[serde(default)]
    pub on_stream: u64,
    /// The streamer pressed Greeted.
    #[serde(default)]
    pub manual: u64,
}

/// One alert kind viewers raised, with the most distinct viewers who said it
/// at once and whether it was ever corroborated (two viewers within 60 s).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportAlert {
    pub kind: crate::cohost::CohostAlertKind,
    pub peak_viewers: u32,
    pub active: bool,
    pub first_seen_at: String,
}

/// Recaps are never posted by Orcle, so posting leaves no count.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportRecap {
    /// The server offered one (viewers asked what they missed).
    #[serde(default)]
    pub offered: u64,
    #[serde(default)]
    pub drafted: u64,
    #[serde(default)]
    pub dismissed: u64,
}

/// What the streamer's voice commands did in one stream (plan 140 S3).
/// Counts only. A removal counts once, by its outcome; a card a newer
/// command replaced is not counted as cancelled (the streamer moved on).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportCommands {
    #[serde(default)]
    pub highlighted: u64,
    /// Cards taken down by voice ("take it down").
    #[serde(default)]
    pub cleared: u64,
    /// The platform removed the message.
    #[serde(default)]
    pub removed: u64,
    /// The platform could not; Videorc hid it locally.
    #[serde(default)]
    pub hidden_locally: u64,
    #[serde(default)]
    pub cancelled: u64,
    /// Nobody answered the card in time.
    #[serde(default)]
    pub expired: u64,
    /// A removal that failed or ended unknown, or a refused request.
    #[serde(default)]
    pub failed: u64,
    /// No comment matched, or Orcle didn't catch what was said.
    #[serde(default)]
    pub not_found: u64,
}

impl CohostReportCommands {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn merged_with(mut self, later: Self) -> Self {
        self.highlighted = self.highlighted.saturating_add(later.highlighted);
        self.cleared = self.cleared.saturating_add(later.cleared);
        self.removed = self.removed.saturating_add(later.removed);
        self.hidden_locally = self.hidden_locally.saturating_add(later.hidden_locally);
        self.cancelled = self.cancelled.saturating_add(later.cancelled);
        self.expired = self.expired.saturating_add(later.expired);
        self.failed = self.failed.saturating_add(later.failed);
        self.not_found = self.not_found.saturating_add(later.not_found);
        self
    }
}

/// What Orcle caught in one stream, saved on this computer when the session
/// ends and deleted with the recording (plan 119 decision 6). Counts and the
/// question log; never raw chat or drafts. Every optional field is omitted,
/// never null; the blocks always ride and default on read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSessionReport {
    pub version: u32,
    pub session_id: String,
    pub started_at: String,
    pub ended_at: String,
    /// Orcle sessions folded into this report: turning Orcle off and on
    /// mid-stream adds one.
    #[serde(default)]
    pub segments: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_title: Option<String>,
    #[serde(default)]
    pub messages_seen: u64,
    /// Distinct comments that went on stream, automatically or by hand.
    #[serde(default)]
    pub shown_on_stream: u64,
    #[serde(default)]
    pub questions: CohostReportQuestions,
    #[serde(default)]
    pub flags: CohostReportFlags,
    #[serde(default)]
    pub promises: CohostReportPromises,
    #[serde(default)]
    pub greetings: CohostReportGreetings,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<CohostReportAlert>,
    #[serde(default)]
    pub recap: CohostReportRecap,
    /// Voice commands (plan 140 S3). Omitted when no command was counted, so
    /// a report from before voice commands reads and writes unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<CohostReportCommands>,
}

impl CohostSessionReport {
    /// A stored report, or `None` for anything this build cannot read: another
    /// version, or a shape that no longer parses. Never an error.
    pub fn from_stored_json(json: &str) -> Option<Self> {
        let report: Self = serde_json::from_str(json).ok()?;
        (report.version == COHOST_SESSION_REPORT_VERSION).then_some(report)
    }

    /// Fold a later report of the same session into this one (Orcle turned
    /// off and on mid-stream, or a replacing start): counts add up, questions
    /// union by id with the later outcome winning, open promises union by
    /// text, and the span covers both.
    pub fn merged_with(mut self, later: Self) -> Self {
        self.version = COHOST_SESSION_REPORT_VERSION;
        if rfc3339_is_earlier(&later.started_at, &self.started_at) {
            self.started_at = later.started_at;
        }
        if rfc3339_is_earlier(&self.ended_at, &later.ended_at) {
            self.ended_at = later.ended_at;
        }
        self.segments = self.segments.saturating_add(later.segments);
        if later.stream_title.is_some() {
            self.stream_title = later.stream_title;
        }
        self.messages_seen = self.messages_seen.saturating_add(later.messages_seen);
        self.shown_on_stream = self.shown_on_stream.saturating_add(later.shown_on_stream);

        let questions = &mut self.questions;
        questions.total = questions.total.saturating_add(later.questions.total);
        questions.marked_answered = questions
            .marked_answered
            .saturating_add(later.questions.marked_answered);
        questions.dismissed = questions
            .dismissed
            .saturating_add(later.questions.dismissed);
        questions.replied = questions.replied.saturating_add(later.questions.replied);
        questions.answered_on_air = questions
            .answered_on_air
            .saturating_add(later.questions.answered_on_air);
        questions.restored = questions.restored.saturating_add(later.questions.restored);
        questions.shown_on_stream = questions
            .shown_on_stream
            .saturating_add(later.questions.shown_on_stream);
        for item in later.questions.items {
            if let Some(existing) = questions
                .items
                .iter_mut()
                .find(|existing| existing.id == item.id)
            {
                *existing = item;
            } else if questions.items.len() < COHOST_REPORT_QUESTIONS_CAP {
                questions.items.push(item);
            }
        }

        let flags = &mut self.flags;
        flags.raised = flags.raised.saturating_add(later.flags.raised);
        flags.dismissed = flags.dismissed.saturating_add(later.flags.dismissed);
        for count in later.flags.by_kind {
            match flags
                .by_kind
                .iter_mut()
                .find(|existing| existing.kind == count.kind)
            {
                Some(existing) => existing.count = existing.count.saturating_add(count.count),
                None => flags.by_kind.push(count),
            }
        }
        for count in later.flags.by_severity {
            match flags
                .by_severity
                .iter_mut()
                .find(|existing| existing.severity == count.severity)
            {
                Some(existing) => existing.count = existing.count.saturating_add(count.count),
                None => flags.by_severity.push(count),
            }
        }

        let promises = &mut self.promises;
        promises.heard = promises.heard.saturating_add(later.promises.heard);
        promises.kept = promises.kept.saturating_add(later.promises.kept);
        promises.dismissed = promises.dismissed.saturating_add(later.promises.dismissed);
        promises.reminded = promises.reminded.saturating_add(later.promises.reminded);
        for open in later.promises.open {
            if promises.open.len() >= COHOST_REPORT_OPEN_PROMISES_CAP {
                break;
            }
            if !promises
                .open
                .iter()
                .any(|existing| existing.text == open.text)
            {
                promises.open.push(open);
            }
        }

        let greetings = &mut self.greetings;
        greetings.first_timers = greetings
            .first_timers
            .saturating_add(later.greetings.first_timers);
        greetings.first_timers_greeted = greetings
            .first_timers_greeted
            .saturating_add(later.greetings.first_timers_greeted);
        greetings.by_voice = greetings.by_voice.saturating_add(later.greetings.by_voice);
        greetings.by_chat = greetings.by_chat.saturating_add(later.greetings.by_chat);
        greetings.on_stream = greetings
            .on_stream
            .saturating_add(later.greetings.on_stream);
        greetings.manual = greetings.manual.saturating_add(later.greetings.manual);

        for alert in later.alerts {
            match self
                .alerts
                .iter_mut()
                .find(|existing| existing.kind == alert.kind)
            {
                Some(existing) => {
                    existing.peak_viewers = existing.peak_viewers.max(alert.peak_viewers);
                    existing.active |= alert.active;
                    if rfc3339_is_earlier(&alert.first_seen_at, &existing.first_seen_at) {
                        existing.first_seen_at = alert.first_seen_at;
                    }
                }
                None => self.alerts.push(alert),
            }
        }

        self.recap.offered = self.recap.offered.saturating_add(later.recap.offered);
        self.recap.drafted = self.recap.drafted.saturating_add(later.recap.drafted);
        self.recap.dismissed = self.recap.dismissed.saturating_add(later.recap.dismissed);
        self.commands = match (self.commands.take(), later.commands) {
            (Some(base), Some(later)) => Some(base.merged_with(later)),
            (base, later) => base.or(later),
        };
        self
    }
}

/// `a` is strictly before `b`. Both are RFC 3339; when one does not parse the
/// comparison falls back to the text, which orders same-format UTC stamps.
fn rfc3339_is_earlier(a: &str, b: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(a),
        chrono::DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(a), Ok(b)) => a < b,
        _ => a < b,
    }
}

/// Chat rows of one platform in a session (plan 119 S1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportChatPlatformCount {
    pub platform: crate::streaming::StreamPlatform,
    pub messages: u64,
}

/// Every chat row the session kept, by platform (busiest first).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportChat {
    pub messages: u64,
    #[serde(default)]
    pub by_platform: Vec<CohostReportChatPlatformCount>,
}

/// `cohost.report.get` / `cohost.report.latest`: the saved report (null when
/// Orcle left none), the session's moments (computed on read, never stored)
/// and its chat totals.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostReportPayload {
    pub session_id: String,
    pub report: Option<CohostSessionReport>,
    #[serde(default)]
    pub moments: Vec<ClipMoment>,
    #[serde(default)]
    pub chat: CohostReportChat,
}

/// A moment worth a clip: a clip mark or a chat peak, snapped to the
/// captions. Computed on read for the Orcle report, never stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMoment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub reason: String,
    pub excerpt: String,
    /// Where the moment came from (plan 068 D6). Omitted, never null, so an
    /// older renderer keeps loading the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ClipMomentSource>,
}

/// What produced a moment: a spoken "clip that", a manual mark, or a chat
/// spike.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClipMomentSource {
    Voice,
    Manual,
    Chat,
}

/// Who placed a clip mark (plan 068 D6).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClipMarkSource {
    Voice,
    Manual,
}

/// One persisted clip mark: a recording-file time the streamer wants clipped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipMark {
    pub id: String,
    pub session_id: String,
    /// Recording-file time in seconds (capture-relative).
    pub at_seconds: f64,
    pub source: ClipMarkSource,
    /// The spoken phrase for a voice mark ("clip that"). Omitted, never null.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phrase: Option<String>,
    pub created_at: String,
}

/// `clip.marked` event and the `clip.mark` reply: where the mark landed and
/// whether it was stored. `saved: false` carries a `reason` code
/// (`recording-off`) so the toast can say why nothing was kept.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipMarkedEvent {
    pub session_id: String,
    pub at_seconds: f64,
    pub source: ClipMarkSource,
    pub saved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMarksListParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilities {
    /// Live-caption transport readiness from videorc-web. Optional so desktop
    /// remains compatible while older web deployments roll forward; callers
    /// that opted into captions intentionally fail closed when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captions: Option<AiCapabilitiesCaptions>,
    /// Clean cut readiness (plan 119, contract part B). A server that omits
    /// the block does not offer Clean cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_cut: Option<AiCapabilitiesCleanCut>,
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
    /// Clean cut kill switch off and its provider configured (plan 119).
    /// Older servers omit it.
    #[serde(default)]
    pub clean_cut_enabled: bool,
    pub cloud_ai_enabled: bool,
    /// The Orcle command route is on and its model configured (plan 140 S8,
    /// contract part E). Older servers omit it: the parser stays off.
    #[serde(default)]
    pub cohost_command_enabled: bool,
    pub gateway_configured: bool,
    pub model_testing_enabled: bool,
    pub multipart_audio_jobs_enabled: bool,
    pub object_backed_jobs_enabled: bool,
    pub transcript_jobs_enabled: bool,
    pub upload_tickets_enabled: bool,
}

/// `cleanCut` from `GET /api/ai/capabilities` (docs/clean-cut-contract.md,
/// part B). Every field defaults so a partial block never breaks the load;
/// `reason_code` is an open string (`disabled`, `blocked`, `premium-required`,
/// `provider-unconfigured`, `quota-exhausted`, or newer codes).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilitiesCleanCut {
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chunk_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chunk_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_seconds_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_kind: Option<String>,
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
    #[test]
    fn audio_level_readings_floor_silence_and_omit_missing_sources() {
        use super::{
            AUDIO_LEVEL_CEILING_DB, AUDIO_LEVEL_FLOOR_DB, AudioLevelReading, AudioLevelsEvent,
        };
        // Digital silence never reaches the wire as -Infinity.
        assert_eq!(
            AudioLevelReading::from_window(0.0, 0.0),
            AudioLevelReading {
                peak_db: AUDIO_LEVEL_FLOOR_DB,
                rms_db: AUDIO_LEVEL_FLOOR_DB
            }
        );
        // A hot input past full scale is capped, and a NaN window reads as silence.
        assert_eq!(
            AudioLevelReading::from_window(1000.0, 1.0e6).peak_db,
            AUDIO_LEVEL_CEILING_DB
        );
        assert_eq!(
            AudioLevelReading::from_window(0.5, f64::NAN).rms_db,
            AUDIO_LEVEL_FLOOR_DB
        );
        // A full-scale sine: peak 0 dBFS, RMS 3.01 dB below.
        let sine = AudioLevelReading::from_window(1.0, 0.5);
        assert!(sine.peak_db.abs() < 1.0e-6, "{sine:?}");
        assert!((sine.rms_db + 3.0103).abs() < 1.0e-3, "{sine:?}");
        // Sources without samples are omitted, never null (the serde-null trap).
        let event = AudioLevelsEvent {
            session_id: Some("session-1".into()),
            microphone: Some(sine),
            system_audio: None,
            master: None,
            master_clipped_samples: 0,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "sessionId": "session-1",
                "microphone": { "peakDb": sine.peak_db, "rmsDb": sine.rms_db },
                "masterClippedSamples": 0
            })
        );
        // The standby microphone has no session: the key is omitted, not null.
        let standby = AudioLevelsEvent {
            session_id: None,
            ..event
        };
        assert_eq!(
            serde_json::to_value(&standby).unwrap(),
            serde_json::json!({
                "microphone": { "peakDb": sine.peak_db, "rmsDb": sine.rms_db },
                "masterClippedSamples": 0
            })
        );
    }

    #[test]
    fn scene_editor_draft_params_round_trip_with_renderer_handle_ids() {
        let wire = serde_json::json!({
            "sourceId": "source:camera",
            "transform": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
            "chrome": {
                "selected": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "handles": true,
                "activeHandle": "se",
                "guides": [{ "axis": "x", "position": 0.5 }],
                "scale": 1.5
            }
        });
        let params: super::SceneEditorDraftParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(params.chrome.active_handle, Some(super::EditorHandleId::Se));
        assert_eq!(params.chrome.guides[0].axis, super::EditorGuideAxis::X);
        assert_eq!(serde_json::to_value(&params).unwrap(), wire);

        // The renderer omits activeHandle and guides when nothing is active.
        let minimal: super::SceneEditorDraftParams = serde_json::from_value(serde_json::json!({
            "sourceId": "source:camera",
            "transform": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
            "chrome": {
                "selected": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "handles": false,
                "scale": 1
            }
        }))
        .unwrap();
        assert_eq!(minimal.chrome.active_handle, None);
        assert!(minimal.chrome.guides.is_empty());
        let serialized = serde_json::to_value(&minimal).unwrap();
        assert!(serialized["chrome"].get("activeHandle").is_none());
        for bad_handle in ["north", "", "NE"] {
            let mut wire = wire.clone();
            wire["chrome"]["activeHandle"] = serde_json::json!(bad_handle);
            assert!(serde_json::from_value::<super::SceneEditorDraftParams>(wire).is_err());
        }
    }

    #[test]
    fn scene_editor_draft_without_a_transform_is_chrome_only_on_the_wire() {
        // The idle selection: chrome, no rect. Absent, not null, both ways.
        let wire = serde_json::json!({
            "sourceId": "source:camera",
            "chrome": {
                "selected": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "handles": true,
                "scale": 2
            }
        });
        let params: super::SceneEditorDraftParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(params.transform, None);
        assert!(params.chrome.handles);
        let serialized = serde_json::to_value(&params).unwrap();
        assert!(serialized.get("transform").is_none());
        assert_eq!(serialized["sourceId"], "source:camera");

        let status = super::SceneEditorDraftStatus {
            source_id: "source:camera".into(),
            transform: None,
            release_at_revision: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({ "sourceId": "source:camera" })
        );
        let parsed: super::SceneEditorDraftStatus =
            serde_json::from_value(serde_json::json!({ "sourceId": "source:camera" })).unwrap();
        assert_eq!(parsed, status);

        // A partial rect is still a malformed draft, never a chrome-only one.
        let mut partial = wire.clone();
        partial["transform"] = serde_json::json!({ "x": 0.1, "y": 0.2 });
        assert!(serde_json::from_value::<super::SceneEditorDraftParams>(partial).is_err());
    }

    #[test]
    fn scene_editor_draft_status_never_serializes_null_release_revision() {
        let status = super::SceneEditorDraftStatus {
            source_id: "source:camera".into(),
            transform: Some(super::CameraTransform {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            }),
            release_at_revision: None,
        };
        let wire = serde_json::to_value(&status).unwrap();
        assert!(wire.get("releaseAtRevision").is_none());
        assert!(wire.get("transform").is_some());
        let ack = super::SceneEditorDraftAck {
            active: false,
            editor_draft: None,
        };
        assert_eq!(
            serde_json::to_value(&ack).unwrap(),
            serde_json::json!({ "active": false })
        );
    }

    #[test]
    fn scene_transform_snap_defaults_to_legacy_for_older_requests() {
        for snap in [None, Some("legacy"), Some("none")] {
            let mut wire = serde_json::json!({
                "sourceId": "source:camera",
                "transform": { "x": 0.012 }
            });
            if let Some(value) = snap {
                wire["snap"] = serde_json::json!(value);
            }
            let params: super::SceneTransformUpdateParams = serde_json::from_value(wire).unwrap();
            assert_eq!(
                params.snap,
                if snap == Some("none") {
                    super::SceneTransformSnap::None
                } else {
                    super::SceneTransformSnap::Legacy
                }
            );
            let serialized = serde_json::to_value(params).unwrap();
            assert_eq!(serialized["snap"], snap.unwrap_or("legacy"));
        }
    }

    #[test]
    fn scene_transform_snap_rejects_invalid_policy() {
        for snap in [
            serde_json::json!("auto"),
            serde_json::json!(false),
            serde_json::Value::Null,
        ] {
            let wire = serde_json::json!({
                "sourceId": "source:camera",
                "transform": { "x": 0.012 },
                "snap": snap
            });
            assert!(serde_json::from_value::<super::SceneTransformUpdateParams>(wire).is_err());
        }
    }

    #[test]
    fn capture_recovery_status_omits_unavailable_and_non_finite_fields() {
        let status = super::CaptureRecoveryStatus {
            revision: 7,
            phase: super::CaptureRecoveryPhase::Idle,
            retryable: false,
            attempts: 0,
            stage: None,
            source: None,
            trigger: None,
            source_generation: None,
            detected_at: None,
            updated_at: None,
            message: None,
            last_error: None,
            last_duration_ms: Some(f64::NAN),
        };
        let wire = serde_json::to_value(status).expect("recovery status serializes");
        assert_eq!(wire["revision"], 7);
        assert_eq!(wire["phase"], "idle");
        assert_eq!(wire["retryable"], false);
        assert_eq!(wire["attempts"], 0);
        for field in [
            "stage",
            "source",
            "trigger",
            "sourceGeneration",
            "detectedAt",
            "updatedAt",
            "message",
            "lastError",
            "lastDurationMs",
        ] {
            assert!(
                wire.get(field).is_none(),
                "unavailable recovery field {field} must be omitted"
            );
        }

        let missing_revision = serde_json::json!({
            "phase": "idle",
            "retryable": false,
            "attempts": 0
        });
        assert!(
            serde_json::from_value::<super::CaptureRecoveryStatus>(missing_revision).is_err(),
            "strict recovery consumers need an explicit ordering revision"
        );
    }

    #[test]
    fn screen_capture_recovery_scope_has_stable_wire_labels() {
        let status = super::CaptureRecoveryStatus {
            revision: 8,
            phase: super::CaptureRecoveryPhase::Verifying,
            retryable: false,
            attempts: 1,
            stage: Some(super::CaptureRecoveryStage::ScreenDelivery),
            source: Some(super::CaptureRecoverySource::Screen),
            trigger: Some(super::CaptureRecoveryTrigger::Automatic),
            source_generation: Some(12),
            detected_at: None,
            updated_at: None,
            message: Some("Verifying replacement screen generation.".to_string()),
            last_error: None,
            last_duration_ms: None,
        };
        let wire = serde_json::to_value(status).expect("screen recovery status serializes");
        assert_eq!(wire["stage"], "screen-delivery");
        assert_eq!(wire["source"], "screen");
        assert_eq!(wire["sourceGeneration"], 12);
    }

    #[test]
    fn mf_input_credit_wait_p95_is_absent_when_none() {
        // 0.9.68 regression: serde emitted `"encoderBridgeMfInputCreditWaitP95Ms": null`
        // and the renderer contract (optional finite number) rejected every
        // diagnostics.stats payload on macOS, blocking session start.
        let stats = crate::diagnostics::idle_diagnostics();
        let json = serde_json::to_value(&stats).expect("stats serialize");
        assert!(
            json.get("encoderBridgeMfInputCreditWaitP95Ms").is_none(),
            "None must serialize as an absent key, not null"
        );
    }

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
            transition_ms: None,
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
            transition_ms: None,
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
        // Explicit wire pin: smokes ride preset custom, so this test is the
        // only CI coverage that the TS list and the Rust enum agree (the
        // 0.9.32 lesson — a preset name missing on one side broke the wire).
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalCameraOnly).unwrap(),
            serde_json::json!("vertical-camera-only")
        );
        assert_eq!(
            serde_json::from_value::<LayoutPreset>(serde_json::json!("vertical-camera-only"))
                .unwrap(),
            LayoutPreset::VerticalCameraOnly
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
        assert!(LayoutPreset::VerticalCameraOnly.is_vertical());
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
    fn h264_backends_match_the_desktop_wire_contract() {
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareVaapi).unwrap(),
            serde_json::json!("hardware-vaapi")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareMediaFoundation).unwrap(),
            serde_json::json!("hardware-media-foundation")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::SoftwareMediaFoundation).unwrap(),
            serde_json::json!("software-media-foundation")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::SoftwareOpenH264).unwrap(),
            serde_json::json!("software-open-h264")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareQsv).unwrap(),
            serde_json::json!("hardware-qsv")
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
            vertical_screen_framing: crate::protocol::VerticalScreenFraming::Fill,
            arrangement_mode: crate::protocol::ArrangementMode::Preset,
            source_transform_overrides: std::collections::BTreeMap::new(),
            source_visibility: Default::default(),
            camera_chroma_key_enabled: false,
            camera_chroma_key_color: "#00FF00".to_string(),
            camera_chroma_key_similarity_pct: 40,
            camera_chroma_key_smoothness_pct: 8,
            camera_chroma_key_spill_pct: 10,
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
            serde_json::to_value(VideoPreset::StreamYoutube1080p30).unwrap(),
            serde_json::json!("stream-youtube-1080p30")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamYoutube1080p60).unwrap(),
            serde_json::json!("stream-youtube-1080p60")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamYoutube4k30).unwrap(),
            serde_json::json!("stream-youtube-4k30")
        );
        // The 0.9.31 wire bug: the renderer's 'vertical-1080x1920' had no Rust
        // variant, so entering vertical mode failed to deserialize. Pin BOTH
        // directions so a renderer-only preset can never ship again.
        assert_eq!(
            serde_json::to_value(VideoPreset::Vertical1080x1920).unwrap(),
            serde_json::json!("vertical-1080x1920")
        );
        assert_eq!(
            serde_json::from_value::<VideoPreset>(serde_json::json!("vertical-1080x1920")).unwrap(),
            VideoPreset::Vertical1080x1920
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
    fn windows_d3d11_main_owned_preview_bounds_preserve_opaque_hwnd_and_generation() {
        let wire = serde_json::json!({
            "bounds": {
                "screenX": 12.0,
                "screenY": 34.0,
                "width": 1280.0,
                "height": 720.0,
                "scaleFactor": 1.25,
                "visible": true,
                "orderAboveWindowId": 42,
                "orderAboveWindowHandle": "0x000000001234abcd",
                "elevated": false
            },
            "generation": 9
        });
        let request: MainOwnedPreviewSurfaceBoundsParams =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(request.generation, 9);
        assert_eq!(
            request
                .bounds
                .order_above_window_handle
                .as_ref()
                .map(OpaqueNativeWindowHandle::as_u64),
            Some(0x1234_abcd)
        );
        assert_eq!(request.bounds.bounds.order_above_window_id, Some(42));
        assert_eq!(request.bounds.bounds.elevated, Some(false));
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
    }

    #[test]
    fn windows_d3d11_opaque_hwnd_rejects_unsafe_wire_values() {
        for value in [
            serde_json::json!("0x0000000000000000"),
            serde_json::json!("0x1234"),
            serde_json::json!("0X0000000000000001"),
            serde_json::json!("0x00000000000000AF"),
            serde_json::json!(1234),
        ] {
            assert!(
                serde_json::from_value::<OpaqueNativeWindowHandle>(value).is_err(),
                "unsafe HWND wire value was accepted"
            );
        }
    }

    #[test]
    fn windows_d3d11_renderer_preview_bounds_never_serialize_an_hwnd() {
        let ordinary: PreviewSurfaceBounds = serde_json::from_value(serde_json::json!({
            "screenX": 0.0,
            "screenY": 0.0,
            "width": 640.0,
            "height": 360.0,
            "scaleFactor": 1.0,
            "orderAboveWindowHandle": "0x000000001234abcd"
        }))
        .unwrap();
        let serialized = serde_json::to_value(ordinary).unwrap();
        assert!(serialized.get("orderAboveWindowHandle").is_none());
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_layout_and_scene_defaults() {
        let legacy_layout = shared_high_risk_contract_fixture_value("/layout/legacyWire");
        assert!(legacy_layout.get("sourceVisibility").is_none());
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

        // Plan 069: the one mixed track reports its sources; an unmixed track
        // (the `wire` fixture above) keeps omitting `mixSources`.
        let mixed = shared_high_risk_contract_fixture_value("/recordingStatus/mixedAudioWire");
        let status: RecordingStatus = serde_json::from_value(mixed.clone()).unwrap();
        assert_eq!(
            status.audio_tracks[0].mix_sources,
            vec![AudioTrackSource::Microphone, AudioTrackSource::SystemAudio]
        );
        assert_eq!(serde_json::to_value(status).unwrap(), mixed);
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

    #[test]
    fn shared_high_risk_contract_fixture_matches_chat_event_details() {
        use crate::live_chat::{LiveChatEventDetails, LiveChatEventType, LiveChatMessage};

        let wire = shared_high_risk_contract_fixture_value("/comments/eventMessages");
        let messages: Vec<LiveChatMessage> = serde_json::from_value(wire.clone()).unwrap();
        // Round-trips exactly: a plain row gains no `details: null`, and every
        // variant keeps its kebab-case tag with camelCase fields.
        assert_eq!(serde_json::to_value(&messages).unwrap(), wire);
        assert!(messages[0].details.is_none() && messages[0].reply.is_none());
        assert!(!messages[0].first_message);
        assert!(messages[1].first_message);
        assert_eq!(
            messages[1].details,
            Some(LiveChatEventDetails::Cheer { bits: 1500 })
        );
        assert_eq!(messages[5].event_type, LiveChatEventType::Follow);
        assert!(matches!(
            messages[5].details,
            Some(LiveChatEventDetails::Follow { .. })
        ));
        assert_eq!(messages[6].event_type, LiveChatEventType::Paid);
        assert_eq!(
            messages[6].details,
            Some(LiveChatEventDetails::Kicks {
                amount: 500,
                gift_name: Some("Rage Quit".to_string()),
            })
        );
        assert_eq!(messages[8].event_type, LiveChatEventType::System);
        assert_eq!(
            messages[8].details,
            Some(LiveChatEventDetails::WatchStreak {
                streak_count: 20,
                channel_points_awarded: Some(450),
            })
        );
        // Plan 155: a Twitch GIF Keyboard row is a plain message whose one
        // `gif` fragment carries Twitch's URL; no new field, no `zeroWidth`.
        assert_eq!(messages[9].event_type, LiveChatEventType::Message);
        assert_eq!(messages[9].fragments[0].fragment_type, "gif");
        assert_eq!(
            messages[9].fragments[0].image_url.as_deref(),
            Some("https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif")
        );
        // Plan 162: Activity-only Twitch Power-up and channel point rows.
        assert_eq!(messages[10].event_type, LiveChatEventType::PowerUp);
        assert_eq!(
            messages[10].details,
            Some(LiveChatEventDetails::PowerUp {
                bits: 50,
                power_up: crate::live_chat::PowerUpKind::GigantifyAnEmote,
                emote_name: Some("orcdevBONK".to_string()),
                title: None,
            })
        );
        assert_eq!(messages[11].event_type, LiveChatEventType::Redemption);
        assert_eq!(
            messages[11].details,
            Some(LiveChatEventDetails::Redemption {
                reward: crate::live_chat::RedemptionKind::Custom,
                channel_points: 500,
                title: Some("Hydrate".to_string()),
                emote_name: None,
                points_name: Some("Orc Gold".to_string()),
            })
        );
        assert!(messages[0].author_affiliation.is_none());
        assert_eq!(
            messages[7]
                .author_affiliation
                .as_ref()
                .and_then(|badge| badge.description.as_deref()),
            Some("Neon")
        );
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_clip_mark_dtos() {
        let saved_wire = shared_high_risk_contract_fixture_value("/clip/markedSaved");
        let saved: ClipMarkedEvent = serde_json::from_value(saved_wire.clone()).unwrap();
        assert!(saved.saved);
        assert_eq!(saved.source, ClipMarkSource::Manual);
        assert_eq!(saved.reason, None);
        // Omitted, never null: the serde-null trap.
        assert_eq!(serde_json::to_value(saved).unwrap(), saved_wire);

        let unsaved_wire = shared_high_risk_contract_fixture_value("/clip/markedUnsaved");
        let unsaved: ClipMarkedEvent = serde_json::from_value(unsaved_wire.clone()).unwrap();
        assert!(!unsaved.saved);
        assert_eq!(unsaved.reason.as_deref(), Some("recording-off"));
        assert_eq!(serde_json::to_value(unsaved).unwrap(), unsaved_wire);

        let params_wire = shared_high_risk_contract_fixture_value("/clip/listParams");
        let params: ClipMarksListParams = serde_json::from_value(params_wire).unwrap();
        assert_eq!(params.session_id, "session-fixture");

        let marks_wire = shared_high_risk_contract_fixture_value("/clip/marks");
        let marks: Vec<ClipMark> = serde_json::from_value(marks_wire.clone()).unwrap();
        assert_eq!(marks[0].source, ClipMarkSource::Voice);
        assert_eq!(marks[0].phrase.as_deref(), Some("clip that"));
        assert_eq!(marks[1].phrase, None);
        assert_eq!(serde_json::to_value(marks).unwrap(), marks_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_clean_cut_dtos() {
        let start_wire = shared_high_risk_contract_fixture_value("/cleanCut/startParams");
        let start: CleanCutStartParams = serde_json::from_value(start_wire.clone()).unwrap();
        assert_eq!(start.mode, CleanCutMode::Clean);
        assert!(start.consent_to_upload_audio);
        assert_eq!(start.target_duration_seconds, None);
        // Omitted, never null: the serde-null trap.
        assert_eq!(serde_json::to_value(start).unwrap(), start_wire);
        let condensed_wire =
            shared_high_risk_contract_fixture_value("/cleanCut/condensedStartParams");
        let condensed: CleanCutStartParams =
            serde_json::from_value(condensed_wire.clone()).unwrap();
        assert_eq!(condensed.mode, CleanCutMode::Condensed);
        assert_eq!(condensed.target_duration_seconds, Some(900));
        assert_eq!(serde_json::to_value(condensed).unwrap(), condensed_wire);
        let get_wire = shared_high_risk_contract_fixture_value("/cleanCut/getParams");
        let get: CleanCutGetParams = serde_json::from_value(get_wire).unwrap();
        assert_eq!(get.session_id, "session-fixture");

        for pointer in [
            "/cleanCut/queuedJob",
            "/cleanCut/readyJob",
            "/cleanCut/failedJob",
        ] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let job: CleanCutJob = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(job).unwrap(), wire, "{pointer}");
        }
        let ready: CleanCutJob = serde_json::from_value(shared_high_risk_contract_fixture_value(
            "/cleanCut/readyJob",
        ))
        .unwrap();
        assert_eq!(ready.state, CleanCutJobState::Ready);
        assert!(!ready.state.is_active());
        let ready_summary = ready.edl_summary.clone().unwrap();
        assert_eq!(ready_summary.removal_count, 3);
        let failed: CleanCutJob = serde_json::from_value(shared_high_risk_contract_fixture_value(
            "/cleanCut/failedJob",
        ))
        .unwrap();
        assert_eq!(
            failed.error_code.as_deref(),
            Some("clean-cut-monthly-quota-exhausted")
        );
        assert_eq!(failed.step.as_deref(), Some("upload"));

        let edl_wire = shared_high_risk_contract_fixture_value("/cleanCut/edl");
        let edl: CleanCutEdl = serde_json::from_value(edl_wire.clone()).unwrap();
        assert_eq!(
            edl.frame_rate,
            CleanCutFrameRate {
                num: 30_000,
                den: 1_001
            }
        );
        assert_eq!(edl.removals[1].kind, CleanCutRemovalKind::Retake);
        assert_eq!(edl.removals[2].kind, CleanCutRemovalKind::FalseStart);
        assert!(!edl.removals[2].enabled);
        assert_eq!(edl.removals[0].confidence, None);
        assert_eq!(edl.summary(), ready_summary);
        assert_eq!(serde_json::to_value(edl).unwrap(), edl_wire);

        let result_wire = shared_high_risk_contract_fixture_value("/cleanCut/getResult");
        let result: CleanCutGetResult = serde_json::from_value(result_wire.clone()).unwrap();
        assert_eq!(result.jobs.len(), 1);
        assert!(result.jobs[0].edl.is_some());
        assert_eq!(serde_json::to_value(result).unwrap(), result_wire);

        let update_wire = shared_high_risk_contract_fixture_value("/cleanCut/updateEdlParams");
        let update: CleanCutUpdateEdlParams = serde_json::from_value(update_wire.clone()).unwrap();
        assert_eq!(update.revision, 0);
        assert!(update.remove_manual.is_empty());
        assert_eq!(update.add_manual[0].end_ms, 601_000);
        assert_eq!(update.removals[0].id, "r3");
        assert_eq!(serde_json::to_value(update).unwrap(), update_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_clean_cut_render_dtos() {
        // Plan 119 S13: `cleanCut.render`, `cleanCut.transcript` and the
        // Condensed keeps on `cleanCut.get`.
        let render_wire = shared_high_risk_contract_fixture_value("/cleanCut/renderParams");
        let render: CleanCutRenderParams = serde_json::from_value(render_wire.clone()).unwrap();
        assert_eq!(render.job_id, "clean-cut-fixture-1");
        assert_eq!(serde_json::to_value(render).unwrap(), render_wire);
        let transcript_params: CleanCutTranscriptParams = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/transcriptParams"),
        )
        .unwrap();
        assert_eq!(transcript_params.job_id, "clean-cut-fixture-1");

        for pointer in ["/cleanCut/renderingJob", "/cleanCut/completedJob"] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let job: CleanCutJob = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(job).unwrap(), wire, "{pointer}");
        }
        let rendering: CleanCutJob = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/renderingJob"),
        )
        .unwrap();
        assert_eq!(rendering.state, CleanCutJobState::Rendering);
        assert!(rendering.state.is_active());
        assert_eq!(rendering.step.as_deref(), Some("render"));
        assert_eq!(rendering.output_session_id, None);
        let completed: CleanCutJob = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/completedJob"),
        )
        .unwrap();
        assert_eq!(completed.state, CleanCutJobState::Completed);
        assert!(!completed.state.is_active());
        assert_eq!(
            completed.output_session_id.as_deref(),
            Some("session-fixture-clean-cut")
        );

        let transcript_wire = shared_high_risk_contract_fixture_value("/cleanCut/transcript");
        let transcript: CleanCutTranscript =
            serde_json::from_value(transcript_wire.clone()).unwrap();
        assert_eq!(transcript.language.as_deref(), Some("en"));
        assert!(!transcript.words[0].filler && transcript.words[1].filler);
        assert_eq!(transcript.segments[0].id, "s1");
        assert_eq!(
            serde_json::to_value(transcript).unwrap(),
            transcript_wire,
            "filler is written only when true"
        );
        let without_wire =
            shared_high_risk_contract_fixture_value("/cleanCut/transcriptWithoutLanguage");
        let without: CleanCutTranscript = serde_json::from_value(without_wire.clone()).unwrap();
        assert_eq!(without.language, None);
        assert!(without.words.is_empty() && without.segments.is_empty());
        assert_eq!(
            serde_json::to_value(without).unwrap(),
            without_wire,
            "language is null, never absent"
        );

        let condensed_wire =
            shared_high_risk_contract_fixture_value("/cleanCut/condensedGetResult");
        let condensed: CleanCutGetResult = serde_json::from_value(condensed_wire.clone()).unwrap();
        assert_eq!(condensed.jobs[0].job.mode, CleanCutMode::Condensed);
        assert_eq!(condensed.jobs[0].condensed_keeps.len(), 2);
        assert_eq!(
            condensed.jobs[0].condensed_keeps[1].title,
            "Deploying to Vercel"
        );
        assert_eq!(serde_json::to_value(condensed).unwrap(), condensed_wire);
        let clean: CleanCutGetResult = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/getResult"),
        )
        .unwrap();
        assert!(clean.jobs[0].condensed_keeps.is_empty());
        assert!(
            serde_json::to_value(&clean.jobs[0])
                .unwrap()
                .get("condensedKeeps")
                .is_none(),
            "omitted when empty"
        );
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_cohost_dtos() {
        let start_wire = shared_high_risk_contract_fixture_value("/cohost/startParams");
        let start: CohostStartParams = serde_json::from_value(start_wire.clone()).unwrap();
        assert!(start.consent_to_process_chat);
        assert_eq!(serde_json::to_value(start).unwrap(), start_wire);

        let minimal_start: CohostStartParams =
            serde_json::from_value(serde_json::json!({ "sessionId": "session-fixture" })).unwrap();
        assert!(!minimal_start.consent_to_process_chat);
        assert_eq!(minimal_start.stream_title, None);

        let question_wire = shared_high_risk_contract_fixture_value("/cohost/questionParams");
        let question: CohostQuestionParams = serde_json::from_value(question_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(question).unwrap(), question_wire);

        let flag_wire = shared_high_risk_contract_fixture_value("/cohost/flagParams");
        let flag: CohostFlagParams = serde_json::from_value(flag_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(flag).unwrap(), flag_wire);

        let patch_wire = shared_high_risk_contract_fixture_value("/cohost/settingsPatch");
        let patch: CohostSettingsPatch = serde_json::from_value(patch_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&patch).unwrap(), patch_wire);
        let empty_patch: CohostSettingsPatch =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty_patch, CohostSettingsPatch::default());

        let settings_wire = shared_high_risk_contract_fixture_value("/cohost/settings");
        let settings: crate::cohost::CohostSettings =
            serde_json::from_value(settings_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(settings).unwrap(), settings_wire);

        let state_wire = shared_high_risk_contract_fixture_value("/cohost/state");
        let state: crate::cohost::CohostState = serde_json::from_value(state_wire.clone()).unwrap();
        // Presence fields (W1): pending delta, scheduled next pass, in-flight
        // flag, and the session lifetime counters ride every state payload.
        assert!(!state.tick_in_flight);
        assert_eq!(state.pending_messages, 4);
        assert_eq!(state.next_tick_at.as_deref(), Some("2026-08-22T10:00:28Z"));
        assert_eq!(state.messages_seen, 84);
        assert_eq!(state.questions_total, 5);
        assert_eq!(serde_json::to_value(state).unwrap(), state_wire);

        let off_wire = shared_high_risk_contract_fixture_value("/cohost/offState");
        let off: crate::cohost::CohostState = serde_json::from_value(off_wire.clone()).unwrap();
        assert_eq!(off, crate::cohost::CohostState::off());
        assert_eq!(serde_json::to_value(off).unwrap(), off_wire);

        // `detail` rides a failed tick: server envelope code + message + HTTP
        // status, or a desktop-assigned code with no status.
        let error_wire = shared_high_risk_contract_fixture_value("/cohost/errorState");
        let errored: crate::cohost::CohostState =
            serde_json::from_value(error_wire.clone()).unwrap();
        assert_eq!(
            errored.detail,
            Some(crate::cohost::CohostErrorDetail {
                code: "ai-gateway-error".to_string(),
                message: "The Orcle tick failed on every configured model.".to_string(),
                status: Some(502),
            })
        );
        assert_eq!(serde_json::to_value(errored).unwrap(), error_wire);
        let timeout_wire = shared_high_risk_contract_fixture_value("/cohost/timeoutState");
        let timed_out: crate::cohost::CohostState =
            serde_json::from_value(timeout_wire.clone()).unwrap();
        assert_eq!(
            timed_out.detail.as_ref().map(|detail| detail.code.as_str()),
            Some("timeout")
        );
        assert_eq!(
            timed_out.detail.as_ref().and_then(|detail| detail.status),
            None
        );
        assert_eq!(serde_json::to_value(timed_out).unwrap(), timeout_wire);

        // Wire v2: flag extras, suggested highlights, alerts and mood scores
        // round-trip; absent optionals stay absent (never null), and an
        // unknown flag kind rides as "unknown".
        let v2_wire = shared_high_risk_contract_fixture_value("/cohost/stateV2");
        let v2: crate::cohost::CohostState = serde_json::from_value(v2_wire.clone()).unwrap();
        assert_eq!(v2.flags[1].rule.as_deref(), Some("No spoilers"));
        assert_eq!(v2.flags[2].kind, crate::cohost::CohostFlagKind::Unknown);
        assert_eq!(v2.flags[2].confidence, None);
        assert!(v2.alerts[0].active);
        // Plan 060 S1: the engine's automatic on-stream command rides the
        // state with a kebab-case source; absent (never null) until it exists.
        assert_eq!(
            v2.auto_highlight,
            Some(crate::cohost::CohostAutoHighlight {
                generation: 4,
                message_id: "session-fixture:twitch:default:message-highlight".to_string(),
                source: crate::cohost::CohostAutoHighlightSource::Pick,
                refresh: false,
            })
        );
        // Plan 060 S3: the spotlight (the comment the streamer is talking
        // about) and the voice-resolved questions ride the state; both are
        // absent (never null / never `[]`) until they exist.
        assert_eq!(
            v2.spotlight,
            Some(crate::cohost::CohostSpotlight {
                message_id: "session-fixture:twitch:default:message-highlight".to_string(),
                question_id: Some("q_fixture".to_string()),
                score: 0.91,
                at: "2026-08-22T10:00:20Z".to_string(),
                expires_at: "2026-08-22T10:00:35Z".to_string(),
            })
        );
        assert_eq!(v2.recently_resolved.len(), 1);
        assert_eq!(
            v2.recently_resolved[0].reason,
            crate::cohost::CohostResolveReason::Voice
        );
        assert_eq!(v2.recently_resolved[0].question.id, "q_fixture");
        assert_eq!(v2.recently_resolved[0].resolved_at, "2026-08-22T10:00:20Z");
        assert_eq!(serde_json::to_value(&v2).unwrap(), v2_wire);
        // `voiceHighlight` (plan 060) defaults off on a settings row or patch
        // from before the field.
        assert!(settings_wire.get("voiceHighlight").is_some());
        let legacy_settings: crate::cohost::CohostSettings = serde_json::from_value(
            serde_json::json!({ "enabled": true, "tone": "short", "notes": "", "autoHighlight": true }),
        )
        .unwrap();
        assert!(legacy_settings.auto_highlight);
        assert!(!legacy_settings.voice_highlight);
        assert_eq!(patch.voice_highlight, Some(true));
        // `listen` (plan 068) defaults off on a settings row from before the
        // field; the patch carries it explicitly.
        assert!(!legacy_settings.listen);
        assert_eq!(patch.listen, Some(true));
        assert_eq!(
            v2.listening,
            Some(crate::cohost::CohostListening {
                state: crate::cohost::CohostListeningState::Blocked,
                reason_code: Some("listen-monthly-quota-exhausted".to_string()),
                message: Some("Orcle's listening allowance for this month is used up.".to_string()),
                remaining_seconds: Some(0),
            })
        );

        // A payload from before `detail` and the presence fields existed still
        // parses (serde defaults).
        let legacy_wire = shared_high_risk_contract_fixture_value("/cohost/legacyState");
        assert!(legacy_wire.get("detail").is_none());
        assert!(legacy_wire.get("tickInFlight").is_none());
        assert!(legacy_wire.get("pendingMessages").is_none());
        assert!(legacy_wire.get("nextTickAt").is_none());
        assert!(legacy_wire.get("messagesSeen").is_none());
        assert!(legacy_wire.get("questionsTotal").is_none());
        assert!(legacy_wire.get("autoHighlight").is_none());
        assert!(legacy_wire.get("spotlight").is_none());
        assert!(legacy_wire.get("recentlyResolved").is_none());
        let legacy: crate::cohost::CohostState = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(legacy, crate::cohost::CohostState::off());
        assert_eq!(legacy.auto_highlight, None);
        assert_eq!(legacy.spotlight, None);
        assert!(legacy.recently_resolved.is_empty());
        // The restore RPC reuses the question params verbatim.
        let restore: CohostQuestionParams = serde_json::from_value(question_wire).unwrap();
        assert_eq!(restore.question_id, "q_fixture");
        // Plan 068 S5 (tick v3): promise and recap params, and the topic,
        // promises, reminder, recap and on-topic flag on the state; every one
        // of them absent (never null) on the legacy payload.
        let promise_wire = shared_high_risk_contract_fixture_value("/cohost/promiseParams");
        let promise: CohostPromiseParams = serde_json::from_value(promise_wire.clone()).unwrap();
        assert_eq!(promise.promise_id, "p_fixture");
        assert_eq!(serde_json::to_value(promise).unwrap(), promise_wire);
        let recap_wire = shared_high_risk_contract_fixture_value("/cohost/recapParams");
        let recap: CohostRecapParams = serde_json::from_value(recap_wire.clone()).unwrap();
        assert_eq!(recap.session_id, "session-fixture");
        assert_eq!(serde_json::to_value(recap).unwrap(), recap_wire);
        assert_eq!(v2.topic.as_deref(), Some("Mechanical keyboards"));
        assert_eq!(v2.promises.len(), 2);
        assert_eq!(
            v2.promises[0].trigger,
            crate::cohost::CohostPromiseTrigger {
                kind: crate::cohost::CohostPromiseTriggerKind::Viewers,
                value: Some(100),
            }
        );
        assert_eq!(
            v2.promises[1].trigger.kind,
            crate::cohost::CohostPromiseTriggerKind::None
        );
        assert_eq!(v2.promises[1].trigger.value, None);
        assert_eq!(
            v2.promise_reminder.as_ref().map(|r| r.promise_id.as_str()),
            Some("p_fixture")
        );
        assert_eq!(
            v2.recap.as_ref().map(|r| r.expires_at.as_str()),
            Some("2026-08-22T10:05:20Z")
        );
        assert!(v2.questions[0].on_topic);
        assert_eq!(legacy.topic, None);
        assert!(legacy.promises.is_empty());
        assert_eq!(legacy.promise_reminder, None);
        assert_eq!(legacy.recap, None);
        // Plan 068 S6: the Greeted params, "Say hi" and the dead-air nudge;
        // both absent (never null) on the legacy payload.
        let author_wire = shared_high_risk_contract_fixture_value("/cohost/authorParams");
        let author: CohostAuthorParams = serde_json::from_value(author_wire.clone()).unwrap();
        assert_eq!(author.author_key, "\"twitch\":viewer-fixture");
        assert_eq!(serde_json::to_value(author).unwrap(), author_wire);
        assert_eq!(v2.say_hi.len(), 1);
        assert_eq!(v2.say_hi[0].name, "x_Dark_Knight_x");
        assert_eq!(
            v2.say_hi[0].platform,
            crate::streaming::StreamPlatform::Twitch
        );
        assert_eq!(
            v2.dead_air_nudge.as_ref().map(|nudge| nudge.key.as_str()),
            Some("dead-air-1-1")
        );
        assert!(legacy.say_hi.is_empty());
        assert_eq!(legacy.dead_air_nudge, None);

        // Plan 140 S3: the voice-command settings, the command RPC params, and
        // the latest command with the kill switches. All of them absent (never
        // null) from the older payloads; old settings load with the defaults.
        assert!(!settings_wire["wakeWordRequired"].as_bool().unwrap());
        assert_eq!(settings_wire["removeConfirm"], "confirm");
        assert!(!legacy_settings.wake_word_required);
        assert_eq!(
            legacy_settings.remove_confirm,
            crate::live_chat_moderation::RemoveConfirmMode::Confirm
        );
        assert_eq!(patch.wake_word_required, Some(true));
        assert_eq!(
            patch.remove_confirm,
            Some(crate::live_chat_moderation::RemoveConfirmMode::Countdown)
        );
        let choose_wire = shared_high_risk_contract_fixture_value("/cohost/commandChooseParams");
        let choose: CohostCommandChooseParams =
            serde_json::from_value(choose_wire.clone()).unwrap();
        assert_eq!(choose.index, 1);
        assert_eq!(serde_json::to_value(choose).unwrap(), choose_wire);
        let answer_wire = shared_high_risk_contract_fixture_value("/cohost/commandParams");
        let answer: CohostCommandParams = serde_json::from_value(answer_wire.clone()).unwrap();
        assert!(answer.command_id.starts_with("cmd-"));
        assert_eq!(serde_json::to_value(answer).unwrap(), answer_wire);
        let command_wire = shared_high_risk_contract_fixture_value("/cohost/commandState");
        let with_command: crate::cohost::CohostState =
            serde_json::from_value(command_wire.clone()).unwrap();
        let command = with_command.command.as_ref().unwrap();
        assert_eq!(command.kind, crate::cohost::CohostCommandKind::Remove);
        assert_eq!(command.status, crate::cohost::CohostCommandStatus::Confirm);
        assert!(command.operation_id.is_some() && command.candidates.is_empty());
        assert_eq!(
            with_command.command_availability,
            Some(crate::cohost::CohostCommandAvailability {
                voice_commands: crate::cohost::CohostSwitchState::On,
                remove: crate::cohost::CohostSwitchState::Paused,
            })
        );
        assert_eq!(serde_json::to_value(&with_command).unwrap(), command_wire);
        let chooser_wire = shared_high_risk_contract_fixture_value("/cohost/chooserState");
        let chooser: crate::cohost::CohostState =
            serde_json::from_value(chooser_wire.clone()).unwrap();
        let command = chooser.command.as_ref().unwrap();
        assert_eq!(
            command.status,
            crate::cohost::CohostCommandStatus::Ambiguous
        );
        assert_eq!(command.candidates.len(), 2);
        assert!(command.target.is_none() && command.operation_id.is_none());
        assert_eq!(chooser.command_availability, None);
        assert_eq!(serde_json::to_value(&chooser).unwrap(), chooser_wire);
        for wire in [&state_wire, &v2_wire, &off_wire] {
            assert!(wire.get("command").is_none());
            assert!(wire.get("commandAvailability").is_none());
        }
        assert_eq!(legacy.command, None);
        assert_eq!(legacy.command_availability, None);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_cohost_report_dtos() {
        let params_wire = shared_high_risk_contract_fixture_value("/cohost/reportGetParams");
        let params: CohostReportGetParams = serde_json::from_value(params_wire.clone()).unwrap();
        assert_eq!(params.session_id, "session-fixture");
        assert_eq!(serde_json::to_value(params).unwrap(), params_wire);

        let saved_wire = shared_high_risk_contract_fixture_value("/cohost/reportSaved");
        let saved: CohostReportSavedEvent = serde_json::from_value(saved_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(saved).unwrap(), saved_wire);

        let report_wire = shared_high_risk_contract_fixture_value("/cohost/report");
        let report: CohostSessionReport = serde_json::from_value(report_wire.clone()).unwrap();
        assert_eq!(report.version, COHOST_SESSION_REPORT_VERSION);
        assert_eq!(report.questions.items.len(), 2);
        assert_eq!(
            report.questions.items[0].outcome,
            CohostReportQuestionOutcome::Replied
        );
        assert!(report.questions.items[1].askers.is_empty());
        assert_eq!(report.alerts[0].kind, crate::cohost::CohostAlertKind::Audio);
        assert_eq!(
            report.flags.by_kind[0].kind,
            crate::cohost::CohostFlagKind::SelfPromo
        );
        // Optional lists ride only when they have entries: no null anywhere.
        assert_eq!(serde_json::to_value(&report).unwrap(), report_wire);
        assert_eq!(
            CohostSessionReport::from_stored_json(&report_wire.to_string()),
            Some(report.clone())
        );

        let payload_wire = shared_high_risk_contract_fixture_value("/cohost/reportPayload");
        let payload: CohostReportPayload = serde_json::from_value(payload_wire.clone()).unwrap();
        let minimal = payload
            .report
            .as_ref()
            .expect("the payload carries the minimal report");
        assert_eq!(minimal.segments, 2);
        assert_eq!(minimal.stream_title, None);
        assert!(minimal.alerts.is_empty() && minimal.questions.items.is_empty());
        assert_eq!(payload.moments.len(), 3);
        assert_eq!(payload.moments[0].source, Some(ClipMomentSource::Voice));
        assert_eq!(payload.chat.messages, 84);
        assert_eq!(serde_json::to_value(&payload).unwrap(), payload_wire);

        let empty_wire =
            shared_high_risk_contract_fixture_value("/cohost/reportPayloadWithoutReport");
        let empty: CohostReportPayload = serde_json::from_value(empty_wire.clone()).unwrap();
        assert_eq!(empty.report, None);
        assert!(empty.moments.is_empty() && empty.chat.by_platform.is_empty());
        // `report` is the one explicit null: the renderer keys on it.
        assert_eq!(serde_json::to_value(&empty).unwrap(), empty_wire);

        // Plan 140 S3: the voice-command counts ride the full report and are
        // absent (never null) from a report without commands.
        let commands = report
            .commands
            .as_ref()
            .expect("the full report counts commands");
        assert_eq!(commands.highlighted, 3);
        assert_eq!(commands.hidden_locally, 1);
        assert_eq!(commands.not_found, 2);
        assert_eq!(minimal.commands, None);
        assert!(
            payload_wire["report"].get("commands").is_none(),
            "omitted, never null"
        );
    }

    #[test]
    fn cohost_report_commands_merge_by_sum_and_stay_absent_without_commands() {
        let base: CohostSessionReport =
            serde_json::from_value(shared_high_risk_contract_fixture_value("/cohost/report"))
                .unwrap();
        let counted = base.commands.clone().unwrap();
        let mut without = base.clone();
        without.commands = None;

        // Orcle off and on mid-stream: the counts add up.
        let merged = base.clone().merged_with(base.clone());
        let doubled = merged.commands.unwrap();
        assert_eq!(doubled.highlighted, counted.highlighted * 2);
        assert_eq!(doubled.cleared, counted.cleared * 2);
        assert_eq!(doubled.removed, counted.removed * 2);
        assert_eq!(doubled.hidden_locally, counted.hidden_locally * 2);
        assert_eq!(doubled.cancelled, counted.cancelled * 2);
        assert_eq!(doubled.not_found, counted.not_found * 2);
        // Either side alone keeps its counts.
        assert_eq!(
            without.clone().merged_with(base.clone()).commands,
            Some(counted.clone())
        );
        assert_eq!(
            base.clone().merged_with(without.clone()).commands,
            Some(counted)
        );
        // Neither side: still absent, and the key never appears.
        let neither = without.clone().merged_with(without);
        assert_eq!(neither.commands, None);
        assert!(
            serde_json::to_value(&neither)
                .unwrap()
                .get("commands")
                .is_none()
        );
        // A stored report from before plan 140 reads with no commands.
        let legacy = serde_json::json!({
            "version": 1,
            "sessionId": "s-1",
            "startedAt": "2026-10-04T10:00:00Z",
            "endedAt": "2026-10-04T11:00:00Z"
        });
        let legacy = CohostSessionReport::from_stored_json(&legacy.to_string()).unwrap();
        assert_eq!(legacy.commands, None);
        assert!(CohostReportCommands::default().is_empty());
        // Partial counts default the rest.
        let partial: CohostReportCommands =
            serde_json::from_value(serde_json::json!({ "removed": 2 })).unwrap();
        assert_eq!(partial.removed, 2);
        assert_eq!(partial.highlighted, 0);
    }

    #[test]
    fn cohost_session_report_defaults_missing_blocks_and_reads_other_versions_as_unavailable() {
        let minimal: CohostSessionReport = serde_json::from_value(serde_json::json!({
            "version": 1,
            "sessionId": "s-1",
            "startedAt": "2026-10-04T10:00:00Z",
            "endedAt": "2026-10-04T11:00:00Z"
        }))
        .unwrap();
        assert_eq!(minimal.segments, 0);
        assert_eq!(minimal.questions, CohostReportQuestions::default());
        assert_eq!(minimal.greetings, CohostReportGreetings::default());
        let wire = serde_json::to_value(&minimal).unwrap();
        for key in ["streamTitle", "alerts"] {
            assert!(wire.get(key).is_none(), "{key} is omitted, never null");
        }
        assert!(wire["questions"].get("items").is_none());
        assert!(wire["flags"].get("byKind").is_none());
        assert!(wire["promises"].get("open").is_none());
        assert_eq!(
            CohostSessionReport::from_stored_json(&wire.to_string()),
            Some(minimal)
        );
        assert_eq!(
            CohostSessionReport::from_stored_json(
                r#"{"version":2,"sessionId":"s-1","startedAt":"t","endedAt":"t"}"#
            ),
            None,
            "a newer format reads as unavailable, never as an error"
        );
        assert_eq!(CohostSessionReport::from_stored_json("not json"), None);
        assert_eq!(
            CohostSessionReport::from_stored_json(
                r#"{"version":1,"sessionId":"s","startedAt":"t","endedAt":"t","questions":{"items":[{"id":"q","text":"?","priority":"high","firstSeenAt":"t","outcome":"teleported"}]}}"#
            ),
            None,
            "an outcome this build does not know"
        );
    }

    #[test]
    fn cohost_session_report_merge_sums_counts_and_keeps_the_later_outcome() {
        let base: CohostSessionReport =
            serde_json::from_value(shared_high_risk_contract_fixture_value("/cohost/report"))
                .unwrap();
        let mut later = base.clone();
        later.started_at = "2026-08-22T11:31:00Z".to_string();
        later.ended_at = "2026-08-22T12:00:00Z".to_string();
        later.stream_title = None;
        later.questions.items.truncate(1);
        later.questions.items[0].outcome = CohostReportQuestionOutcome::MarkedAnswered;
        later.questions.items.push(CohostReportQuestion {
            id: "q_new".to_string(),
            text: "Is this live?".to_string(),
            askers: Vec::new(),
            platforms: Vec::new(),
            priority: crate::cohost::CohostPriority::Low,
            first_seen_at: "2026-08-22T11:45:00Z".to_string(),
            outcome: CohostReportQuestionOutcome::Open,
        });
        later.promises.open.push(CohostReportOpenPromise {
            text: "Raid someone after".to_string(),
            first_seen_at: "2026-08-22T11:50:00Z".to_string(),
        });
        later.flags.by_kind = vec![CohostReportFlagKindCount {
            kind: crate::cohost::CohostFlagKind::Spam,
            count: 3,
        }];
        later.alerts[0].peak_viewers = 5;
        later.alerts[0].first_seen_at = "2026-08-22T11:40:00Z".to_string();
        later.alerts.push(CohostReportAlert {
            kind: crate::cohost::CohostAlertKind::Video,
            peak_viewers: 1,
            active: false,
            first_seen_at: "2026-08-22T11:55:00Z".to_string(),
        });

        let merged = base.clone().merged_with(later);
        assert_eq!(merged.version, COHOST_SESSION_REPORT_VERSION);
        assert_eq!(merged.started_at, "2026-08-22T10:00:00Z");
        assert_eq!(merged.ended_at, "2026-08-22T12:00:00Z");
        assert_eq!(merged.segments, 2);
        assert_eq!(
            merged.stream_title.as_deref(),
            Some("Rust night"),
            "a later report without a title keeps the earlier one"
        );
        assert_eq!(merged.messages_seen, 168);
        assert_eq!(merged.shown_on_stream, 4);
        assert_eq!(merged.questions.total, 10);
        assert_eq!(merged.questions.replied, 2);
        assert_eq!(merged.questions.items.len(), 3);
        assert_eq!(
            merged.questions.items[0].outcome,
            CohostReportQuestionOutcome::MarkedAnswered,
            "the later outcome wins"
        );
        assert_eq!(merged.questions.items[1].id, "q_fixture_2");
        assert_eq!(merged.questions.items[2].id, "q_new");
        assert_eq!(merged.promises.heard, 4);
        assert_eq!(
            merged
                .promises
                .open
                .iter()
                .map(|open| open.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Giveaway at 100 viewers", "Raid someone after"],
            "open promises union by text"
        );
        assert_eq!(merged.flags.raised, 4);
        assert_eq!(merged.flags.by_kind.len(), 2);
        assert_eq!(
            merged.flags.by_kind[1].kind,
            crate::cohost::CohostFlagKind::Spam
        );
        assert_eq!(merged.flags.by_kind[1].count, 4);
        assert_eq!(merged.flags.by_severity[0].count, 4);
        assert_eq!(merged.alerts.len(), 2);
        assert_eq!(merged.alerts[0].peak_viewers, 5);
        assert!(merged.alerts[0].active);
        assert_eq!(merged.alerts[0].first_seen_at, "2026-08-22T10:40:00Z");
        assert_eq!(merged.alerts[1].kind, crate::cohost::CohostAlertKind::Video);
        assert_eq!(merged.greetings.first_timers, 6);
        assert_eq!(merged.recap.offered, 2);

        // A later report that started earlier moves the start back, and a
        // shorter one never shortens the span.
        let mut earlier = base.clone();
        earlier.started_at = "2026-08-22T09:00:00Z".to_string();
        earlier.ended_at = "2026-08-22T09:30:00Z".to_string();
        let merged = base.merged_with(earlier);
        assert_eq!(merged.started_at, "2026-08-22T09:00:00Z");
        assert_eq!(merged.ended_at, "2026-08-22T11:30:00Z");
    }

    #[test]
    fn performance_check_contract_has_no_nulls_and_rejects_unknown_params() {
        let video = VideoSettings {
            preset: VideoPreset::Tutorial720p30,
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4000,
        };
        let result = PerformanceCheckResult {
            capability_key: "performance-check-v1:abc".to_string(),
            checked_at: "2026-09-20T00:00:00Z".to_string(),
            app_version: "0.9.0".to_string(),
            duration_ms: 6_000,
            recommended: video.clone(),
            below_floor: false,
            rungs: vec![PerformanceCheckRung {
                video,
                verdict: PerformanceCheckRungVerdict::Passed,
                encode_backend: None,
                compositor_backend: None,
                encoder_speed: Some(1.0),
                delivered_fps: None,
                drain_after_stop_ms: None,
                reasons: Vec::new(),
            }],
        };
        let state = PerformanceCheckState {
            running: false,
            result: Some(result.clone()),
            stale: false,
        };
        let text = serde_json::to_string(&state).unwrap();
        // serde null → contract trap: an Option without skip_serializing_if
        // has taken the app down three times.
        assert!(!text.contains("null"), "{text}");
        assert!(text.contains("\"preset\":\"tutorial-720p30\""));
        assert!(text.contains("\"verdict\":\"passed\""));
        let decoded: PerformanceCheckState = serde_json::from_str(&text).unwrap();
        assert_eq!(decoded.result, Some(result));
        let idle = serde_json::to_string(&PerformanceCheckState {
            running: true,
            result: None,
            stale: false,
        })
        .unwrap();
        assert_eq!(idle, "{\"running\":true,\"stale\":false}");

        assert!(
            serde_json::from_value::<PerformanceCheckRunParams>(serde_json::json!({
                "ceilingWidth": 1920, "ceilingHeight": 1080, "ceilingFps": 30,
                "ffmpegPath": "/tmp/evil"
            }))
            .is_err(),
            "unknown fields are rejected: the check never takes a client FFmpeg path"
        );
    }

    #[test]
    fn stream_output_topology_probe_contract_is_secret_free_and_stable() {
        let params: StreamOutputTopologyProbeParams = serde_json::from_value(serde_json::json!({
            "streamProfile": {
                "preset": "stream-safe-1080p60",
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 6000
            },
            "recordingProfile": {
                "preset": "tutorial-1080p30",
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "bitrateKbps": 6000
            },
            "outputRoles": ["recording", "stream"]
        }))
        .unwrap();
        assert_eq!(
            params.output_roles,
            vec![
                StreamOutputTopologyRole::Recording,
                StreamOutputTopologyRole::Stream
            ]
        );

        let result = StreamOutputTopologyProbeResult {
            capability_key: format!("stream-output-topology-v1:{}", "a".repeat(64)),
            stream_profile: params.stream_profile,
            recording_profile: params.recording_profile,
            output_roles: params.output_roles,
            requested_bridge_output: StreamOutputBridge::WindowsMediaFoundationH264MpegTs,
            effective_bridge_output: StreamOutputBridge::RawYuv420p,
            effective_encode_backend: EncodeBackend::SoftwareOpenH264,
            probe_state: StreamOutputTopologyProbeState::Rejected,
            fallback_reason: Some("hardware profile rejected".to_string()),
        };
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(
            wire["requestedBridgeOutput"],
            "windows-media-foundation-h264-mpegts"
        );
        assert_eq!(wire["effectiveBridgeOutput"], "raw-yuv420p");
        assert_eq!(wire["effectiveEncodeBackend"], "software-open-h264");
        assert_eq!(wire["probeState"], "rejected");
        let serialized = wire.to_string().to_ascii_lowercase();
        for forbidden in [
            "serverurl",
            "streamkey",
            "accesstoken",
            "refreshtoken",
            "oauth",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "topology result exposed forbidden field {forbidden}"
            );
        }

        let rejected =
            serde_json::from_value::<StreamOutputTopologyProbeParams>(serde_json::json!({
                "streamProfile": {
                    "preset": "custom",
                    "width": 1920,
                    "height": 1080,
                    "fps": 30,
                    "bitrateKbps": 6000
                },
                "outputRoles": ["shared"],
                "streamKey": "must-not-enter-the-contract"
            }));
        assert!(
            rejected.is_err(),
            "unknown secret-bearing fields must be rejected"
        );
    }

    #[test]
    fn windows_d3d11_synchronization_timeout_counter_is_stable_on_the_wire() {
        let diagnostics = WindowsD3d11MediaDiagnostics {
            synchronization_timeouts: 3,
            ..Default::default()
        };
        let wire = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(wire["synchronizationTimeouts"], 3);
        for field in [
            "messagePumpLagP95Ms",
            "messagePumpLagMaxMs",
            "mediaCommandLagP95Ms",
            "mediaCommandLagMaxMs",
        ] {
            assert!(
                wire.get(field).is_none(),
                "unset optional timing field {field} must be omitted rather than serialized as null"
            );
        }

        let legacy: WindowsD3d11MediaDiagnostics = serde_json::from_value(serde_json::json!({
            "state": "unavailable"
        }))
        .unwrap();
        assert_eq!(legacy.synchronization_timeouts, 0);
    }

    #[test]
    fn diagnostic_stats_omit_an_unavailable_compositor_backend_on_the_wire() {
        let diagnostics = crate::diagnostics::idle_diagnostics();
        let wire = serde_json::to_value(diagnostics).unwrap();

        assert!(
            wire.get("compositorBackend").is_none(),
            "optional compositor backend must be omitted rather than serialized as null"
        );
    }

    #[test]
    fn diagnostic_capture_pressure_idle_fixture_omits_unavailable_fields_without_nulls() {
        let wire = serde_json::to_value(crate::diagnostics::idle_diagnostics())
            .expect("idle diagnostics serialize");

        for field in [
            "previewCameraCaptureCallbackAgeMs",
            "previewCameraLatestSequence",
            "previewCameraCapturePixelFormat",
            "previewScreenCaptureCallbackAgeMs",
            "previewScreenLatestSequence",
            "compositorMetalCachedCaptureSourceImportsLiveCount",
            "compositorMetalCachedCaptureSourceImportsPeakCount",
            "compositorMetalCachedCaptureSourceImportsCeiling",
            "compositorMetalTargetRingSlotsLiveCount",
            "compositorMetalTargetRingSlotsPeakCount",
            "compositorMetalTargetRingSlotsCeiling",
            "encoderBridgeMetalTargetRefsInFlightLiveCount",
            "encoderBridgeMetalTargetRefsInFlightPeakCount",
            "encoderBridgeMetalTargetRefsInFlightCeiling",
            "nativePreviewIosurfaceImportLiveCount",
            "nativePreviewIosurfaceImportPeakCount",
            "nativePreviewIosurfaceImportCeiling",
        ] {
            assert!(
                wire.get(field).is_none(),
                "unset optional capture field {field} must be omitted rather than null"
            );
        }
        for field in ["previewCameraSurfaceBacking", "previewScreenSurfaceBacking"] {
            let surface = wire
                .get(field)
                .and_then(serde_json::Value::as_object)
                .unwrap_or_else(|| panic!("required surface diagnostics object {field}"));
            assert!(
                !surface.contains_key("oldestAgeMs"),
                "unset optional {field}.oldestAgeMs must be omitted rather than null"
            );
            assert!(
                surface.values().all(|value| !value.is_null()),
                "required {field} counters must never serialize as null"
            );
        }
    }

    #[test]
    fn capture_pipeline_degraded_stage_is_omitted_when_healthy_and_a_string_when_set() {
        // The serde-null → contract trap (0.9.68, 0.9.79): an Option without
        // skip_serializing_if serializes null, and the renderer contract's
        // optionalSchema rejects null. Healthy pipelines must OMIT the field.
        let wire = serde_json::to_value(crate::diagnostics::idle_diagnostics())
            .expect("idle diagnostics serialize");
        assert!(
            wire.get("capturePipelineDegradedStage").is_none(),
            "healthy capturePipelineDegradedStage must be omitted rather than null"
        );

        let mut degraded = crate::diagnostics::idle_diagnostics();
        degraded.capture_pipeline_degraded_stage = Some("camera-delivery".to_string());
        let wire = serde_json::to_value(degraded).expect("degraded diagnostics serialize");
        assert_eq!(
            wire.get("capturePipelineDegradedStage")
                .and_then(serde_json::Value::as_str),
            Some("camera-delivery")
        );
    }

    #[test]
    fn diagnostic_capture_pressure_maximal_fixture_round_trips_without_nulls() {
        let mut diagnostics = crate::diagnostics::idle_diagnostics();
        diagnostics.compositor_source_capture_texture_reuses = 120;
        diagnostics.compositor_camera_source_capture_texture_reuses = 70;
        diagnostics.compositor_screen_source_capture_texture_reuses = 50;
        diagnostics.compositor_source_texture_cache_flushes = 6;
        diagnostics.preview_camera_capture_callback_count = 1_001;
        diagnostics.preview_camera_did_drop_callback_count = 17;
        diagnostics.preview_camera_frame_store_publications = 984;
        diagnostics.preview_camera_capture_callback_age_ms = Some(12);
        diagnostics.preview_camera_latest_sequence = Some(984);
        diagnostics.preview_camera_capture_pixel_format = Some("BGRA".to_string());
        diagnostics.preview_camera_drop_reasons = PreviewCameraDropReasonStats {
            frame_was_late: 3,
            out_of_buffers: 5,
            discontinuity: 7,
            unknown: 2,
        };
        diagnostics.preview_camera_surface_backing = PreviewSourceSurfaceBackingStats {
            live_count: 2,
            peak_count: 4,
            estimated_bytes: 66_355_200,
            peak_estimated_bytes: 132_710_400,
            oldest_age_ms: Some(42),
        };
        diagnostics.preview_screen_capture_callback_count = 1_010;
        diagnostics.preview_screen_frame_store_publications = 990;
        diagnostics.preview_screen_capture_callback_age_ms = Some(9);
        diagnostics.preview_screen_latest_sequence = Some(990);
        diagnostics.preview_screen_frame_statuses = PreviewScreenFrameStatusStats {
            complete: 990,
            idle: 4,
            blank: 3,
            suspended: 2,
            started: 1,
            stopped: 1,
            unknown: 9,
        };
        diagnostics.preview_screen_surface_backing = PreviewSourceSurfaceBackingStats {
            live_count: 3,
            peak_count: 6,
            estimated_bytes: 99_532_800,
            peak_estimated_bytes: 199_065_600,
            oldest_age_ms: Some(31),
        };

        let wire = serde_json::to_value(&diagnostics).expect("maximal diagnostics serialize");
        for field in [
            "previewCameraCaptureCallbackAgeMs",
            "previewCameraLatestSequence",
            "previewCameraCapturePixelFormat",
            "previewScreenCaptureCallbackAgeMs",
            "previewScreenLatestSequence",
        ] {
            assert_ne!(wire.get(field), Some(&serde_json::Value::Null), "{field}");
        }
        assert_eq!(wire["previewCameraDropReasons"]["outOfBuffers"], 5);
        assert_eq!(wire["previewCameraSurfaceBacking"]["oldestAgeMs"], 42);
        assert_eq!(wire["previewScreenFrameStatuses"]["suspended"], 2);
        assert_eq!(wire["previewScreenSurfaceBacking"]["peakCount"], 6);
        assert_eq!(wire["compositorSourceCaptureTextureReuses"], 120);
        assert_eq!(wire["compositorCameraSourceCaptureTextureReuses"], 70);
        assert_eq!(wire["compositorScreenSourceCaptureTextureReuses"], 50);
        assert_eq!(wire["compositorSourceTextureCacheFlushes"], 6);

        let restored: DiagnosticStats =
            serde_json::from_value(wire).expect("maximal diagnostics deserialize");
        assert_eq!(restored, diagnostics);
    }

    #[test]
    fn windows_d3d11_presenter_media_generation_is_stable_on_the_wire() {
        let diagnostics = WindowsD3d11PresenterDiagnostics {
            media_generation: 41,
            ..Default::default()
        };
        let wire = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(wire["mediaGeneration"], 41);

        let mut legacy_wire =
            serde_json::to_value(WindowsD3d11PresenterDiagnostics::default()).unwrap();
        legacy_wire
            .as_object_mut()
            .expect("presenter diagnostics serialize as an object")
            .remove("mediaGeneration");
        let legacy: WindowsD3d11PresenterDiagnostics = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(legacy.media_generation, 0);
    }

    mod system_audio_protocol {
        use super::super::{
            AudioProcessingUpdateParams, AudioSettings, AudioTrack, AudioTrackSource,
            SYSTEM_AUDIO_GAIN_DB_DEFAULT, SYSTEM_AUDIO_GAIN_DB_MAX, SYSTEM_AUDIO_GAIN_DB_MIN,
            clamp_system_audio_gain_db,
        };
        use serde_json::json;

        #[test]
        fn audio_settings_without_system_audio_keys_load_as_off_at_minus_six_db() {
            let legacy: AudioSettings = serde_json::from_value(json!({
                "microphoneGainDb": 3.0,
                "microphoneMuted": false,
                "microphoneSyncOffsetMs": 0
            }))
            .unwrap();
            assert!(!legacy.system_audio_enabled);
            assert_eq!(legacy.system_audio_gain_db, -6.0);
            assert_eq!(legacy.system_audio_gain_db, SYSTEM_AUDIO_GAIN_DB_DEFAULT);
            assert_eq!(legacy.microphone_gain_db, 3.0);

            let empty: AudioSettings = serde_json::from_value(json!({})).unwrap();
            assert_eq!(empty, AudioSettings::default());
            assert!(!empty.system_audio_enabled);
            assert_eq!(empty.system_audio_gain_db, -6.0);
        }

        #[test]
        fn audio_settings_round_trip_explicit_system_audio_values_in_camel_case() {
            let off: AudioSettings = serde_json::from_value(json!({
                "systemAudioEnabled": false,
                "systemAudioGainDb": 4.5
            }))
            .unwrap();
            assert!(!off.system_audio_enabled);
            assert_eq!(off.system_audio_gain_db, 4.5);

            let on = AudioSettings {
                system_audio_enabled: true,
                system_audio_gain_db: -12.0,
                ..AudioSettings::default()
            };
            let wire = serde_json::to_value(&on).unwrap();
            assert_eq!(wire["systemAudioEnabled"], true);
            assert_eq!(wire["systemAudioGainDb"], -12.0);
            let back: AudioSettings = serde_json::from_value(wire).unwrap();
            assert_eq!(back, on);

            // Off is sent explicitly, never dropped.
            let wire_off = serde_json::to_value(AudioSettings::default()).unwrap();
            assert_eq!(wire_off["systemAudioEnabled"], false);
            assert_eq!(wire_off["systemAudioGainDb"], -6.0);
        }

        #[test]
        fn system_audio_gain_clamps_to_the_shared_range() {
            assert_eq!(SYSTEM_AUDIO_GAIN_DB_MIN, -24.0);
            assert_eq!(SYSTEM_AUDIO_GAIN_DB_MAX, 12.0);
            assert_eq!(clamp_system_audio_gain_db(-40.0), -24.0);
            assert_eq!(clamp_system_audio_gain_db(40.0), 12.0);
            assert_eq!(clamp_system_audio_gain_db(-3.5), -3.5);
            assert_eq!(clamp_system_audio_gain_db(f32::NAN), -6.0);
            assert_eq!(clamp_system_audio_gain_db(f32::INFINITY), -6.0);
        }

        #[test]
        fn audio_processing_update_omits_untouched_system_audio_fields() {
            let mic_only: AudioProcessingUpdateParams = serde_json::from_value(json!({
                "sessionId": "session-1",
                "microphoneGainDb": 2.0,
                "microphoneMuted": true
            }))
            .unwrap();
            assert_eq!(mic_only.system_audio_enabled, None);
            assert_eq!(mic_only.system_audio_gain_db, None);
            let wire = serde_json::to_value(&mic_only).unwrap();
            let object = wire.as_object().unwrap();
            assert!(!object.contains_key("systemAudioEnabled"), "{wire}");
            assert!(!object.contains_key("systemAudioGainDb"), "{wire}");

            let toggle: AudioProcessingUpdateParams = serde_json::from_value(json!({
                "sessionId": "session-1",
                "microphoneGainDb": 2.0,
                "microphoneMuted": true,
                "systemAudioEnabled": false,
                "systemAudioGainDb": -9.0
            }))
            .unwrap();
            assert_eq!(toggle.system_audio_enabled, Some(false));
            assert_eq!(toggle.system_audio_gain_db, Some(-9.0));
            let wire = serde_json::to_value(&toggle).unwrap();
            assert_eq!(wire["systemAudioEnabled"], false);
            assert_eq!(wire["systemAudioGainDb"], -9.0);
        }

        #[test]
        fn audio_track_source_system_audio_is_kebab_case_on_the_wire() {
            assert_eq!(
                serde_json::to_value(AudioTrackSource::SystemAudio).unwrap(),
                json!("system-audio")
            );
            assert_eq!(
                serde_json::to_value(AudioTrackSource::TestTone).unwrap(),
                json!("test-tone")
            );
            let parsed: AudioTrackSource = serde_json::from_value(json!("system-audio")).unwrap();
            assert_eq!(parsed, AudioTrackSource::SystemAudio);
        }

        #[test]
        fn audio_track_omits_empty_mix_sources_and_round_trips_a_mixed_track() {
            let mic_only = AudioTrack {
                id: "microphone".to_string(),
                label: "Microphone".to_string(),
                source: AudioTrackSource::Microphone,
                mix_sources: Vec::new(),
            };
            let wire = serde_json::to_value(&mic_only).unwrap();
            assert!(
                !wire.as_object().unwrap().contains_key("mixSources"),
                "an unmixed track keeps the legacy wire shape: {wire}"
            );
            let legacy: AudioTrack = serde_json::from_value(json!({
                "id": "microphone",
                "label": "Microphone",
                "source": "microphone"
            }))
            .unwrap();
            assert_eq!(legacy, mic_only);

            let mixed = AudioTrack {
                mix_sources: vec![AudioTrackSource::Microphone, AudioTrackSource::SystemAudio],
                ..mic_only
            };
            let wire = serde_json::to_value(&mixed).unwrap();
            assert_eq!(wire["id"], "microphone");
            assert_eq!(wire["mixSources"], json!(["microphone", "system-audio"]));
            let back: AudioTrack = serde_json::from_value(wire).unwrap();
            assert_eq!(back, mixed);
        }

        #[test]
        fn diagnostic_stats_omit_absent_system_audio_fields_instead_of_null() {
            let idle = crate::diagnostics::idle_diagnostics();
            let wire = serde_json::to_value(&idle).unwrap();
            let object = wire.as_object().unwrap();
            for key in [
                "systemAudioLiveLevel",
                "systemAudioLivePeakDb",
                "systemAudioCapturedFrames",
                "systemAudioActive",
                "audioMixClippedSamples",
            ] {
                assert!(
                    !object.contains_key(key),
                    "{key} must be omitted, never null (the serde-null trap)"
                );
            }

            let mut live = idle;
            live.system_audio_live_level = Some(0.5);
            live.system_audio_live_peak_db = Some(-12.0);
            live.system_audio_captured_frames = Some(48_000);
            live.system_audio_active = Some(true);
            live.audio_mix_clipped_samples = Some(3);
            let wire = serde_json::to_value(&live).unwrap();
            assert_eq!(wire["systemAudioLiveLevel"], 0.5);
            assert_eq!(wire["systemAudioLivePeakDb"], -12.0);
            assert_eq!(wire["systemAudioCapturedFrames"], 48_000);
            assert_eq!(wire["systemAudioActive"], true);
            assert_eq!(wire["audioMixClippedSamples"], 3);
        }
    }
}
