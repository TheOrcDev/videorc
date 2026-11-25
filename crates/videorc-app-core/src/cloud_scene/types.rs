//! Plan 249 S12/S14 cloud scene wire types (Electron `shared/cloud-scene.ts`).

use serde::{Deserialize, Serialize};

/// `SCENE_TOPIC`.
pub const SCENE_TOPIC: &str = "videorc.presentation.scene.v1";
/// `SCENE_MAX_BYTES`.
pub const SCENE_MAX_BYTES: usize = 16 * 1024;
/// `SCENE_LEASE_MS`.
pub const SCENE_LEASE_MS: i64 = 30_000;
/// `SCENE_MOTION_MS`.
pub const SCENE_MOTION_MS: i64 = 320;
/// `SCENE_MOTION_MAX_MS`.
pub const SCENE_MOTION_MAX_MS: i64 = 2000;
/// `SCENE_ENTER_SCALE`.
pub const SCENE_ENTER_SCALE: f64 = 0.92;
/// `SCENE_MAX_GUEST_SLOTS`.
pub const SCENE_MAX_GUEST_SLOTS: usize = 6;
/// `SCENE_EXTENSION_VERSION`.
pub const SCENE_EXTENSION_VERSION: u32 = 1;
/// `CLOUD_SCENES_PRODUCTION_QUALIFIED`.
pub const CLOUD_SCENES_PRODUCTION_QUALIFIED: bool = false;

/// `BACKGROUND_ASSET_MAX_SIDE`.
pub const BACKGROUND_ASSET_MAX_SIDE: i64 = 2560;
/// `BACKGROUND_DIM_MAX`.
pub const BACKGROUND_DIM_MAX: f64 = 0.8;

/// `LIVE_BACKGROUND_IDS`.
pub const LIVE_BACKGROUND_IDS: [&str; 10] = [
    "silk",
    "side-rays",
    "plasma-wave",
    "liquid-chrome",
    "line-waves",
    "beams",
    "color-bends",
    "dither",
    "ferrofluid",
    "ghost-fibers",
];

/// `BACKGROUND_STILL_REASONS`.
pub const BACKGROUND_STILL_REASONS: [&str; 7] = [
    "no-webgl2",
    "shader-compile-failed",
    "context-lost",
    "gpu-budget",
    "unknown-look",
    "asset-missing",
    "asset-invalid",
];

/// `SceneOutput`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneOutput {
    Stream,
    Recording,
}

/// `SceneOrientation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneOrientation {
    H,
    V,
}

/// Canvas fractions. Boxes may start off the canvas (native freeform).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Fractions of the source picture, before any mirror.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneCrop {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

/// `SceneFit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneFit {
    Contain,
    Cover,
}

/// `SceneMask`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "lowercase")]
pub enum SceneMask {
    Rectangle,
    Rounded { radius: f64 },
    Circle,
}

/// `SceneRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneRole {
    HostCamera,
    Screen,
}

/// `SceneItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneItem {
    pub role: SceneRole,
    pub rect: SceneRect,
    pub crop: SceneCrop,
    pub fit: SceneFit,
    pub mirror: bool,
    pub mask: SceneMask,
    pub z: i64,
}

/// `SceneGuests`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneGuests {
    pub host: SceneRect,
    pub region: SceneRect,
    pub slots: Vec<SceneRect>,
}

/// `BackgroundMime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackgroundMime {
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/png")]
    Png,
}

/// `BackgroundCrop`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BackgroundCrop {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

/// Live background phase clock.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBackgroundClock {
    pub anchor_at: i64,
    pub anchor_phase: f64,
    pub rate: f64,
}

/// `PictureBackground`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PictureBackground {
    pub hash: String,
    pub mime: BackgroundMime,
    pub width: i64,
    pub height: i64,
    pub fit: SceneFit,
    pub crop: BackgroundCrop,
}

/// `LiveBackground`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveBackground {
    pub id: String,
    pub look: String,
    pub dim: f64,
    pub clock: LiveBackgroundClock,
}

/// `SceneBackground`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SceneBackground {
    Picture {
        hash: String,
        mime: BackgroundMime,
        width: i64,
        height: i64,
        fit: SceneFit,
        crop: BackgroundCrop,
    },
    Live {
        id: String,
        look: String,
        dim: f64,
        clock: LiveBackgroundClock,
    },
}

/// `BackgroundRendering`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundRendering {
    Picture,
    Shader,
    Half,
    Still,
    None,
}

/// `BackgroundStillReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundStillReason {
    NoWebgl2,
    ShaderCompileFailed,
    ContextLost,
    GpuBudget,
    UnknownLook,
    AssetMissing,
    AssetInvalid,
}

/// `BackgroundDrawn`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackgroundDrawn {
    pub key: String,
    pub rendering: BackgroundRendering,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<BackgroundStillReason>,
}

/// `BackgroundCapability`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackgroundCapability {
    pub version: u32,
    pub live: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drawn: Option<BackgroundDrawn>,
}

/// `CloudScene`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudScene {
    pub id: String,
    pub items: Vec<SceneItem>,
    pub guests: SceneGuests,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<SceneBackground>,
}

/// `SceneTransition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransition {
    pub kind: SceneTransitionKind,
    pub duration_ms: i64,
    pub apply_at: i64,
}

/// Transition kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneTransitionKind {
    Cut,
    Motion,
}

/// `SceneApplied`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneApplied {
    pub publisher_sid: String,
    pub revision: i64,
}

/// `SceneCapability`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCapability {
    pub version: u32,
    pub output: SceneOutput,
    pub orientation: SceneOrientation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<SceneApplied>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<BackgroundCapability>,
}

/// `SceneSnapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSnapshot {
    pub version: u32,
    pub show: String,
    pub publisher_sid: String,
    pub revision: i64,
    pub output: SceneOutput,
    pub orientation: SceneOrientation,
    pub expires_at: i64,
    pub scene: Option<CloudScene>,
    pub transition: SceneTransition,
}

/// `CloudSceneExtension`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudSceneExtension {
    pub version: u32,
    pub guests: SceneGuests,
}

/// Page context for [`super::parse::parse_scene_snapshot`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePage {
    pub show: String,
    pub publisher_sid: String,
    pub output: SceneOutput,
    pub orientation: SceneOrientation,
    pub now: i64,
}

/// Pixel box on the canvas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScenePixelRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Canvas size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneCanvas {
    pub width: f64,
    pub height: f64,
}

/// `SceneTileMask`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "lowercase")]
pub enum SceneTileMask {
    Rectangle,
    Rounded {
        #[serde(rename = "radiusPx")]
        radius_px: f64,
    },
    Circle,
}

/// `SceneTile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneTile {
    pub identity: String,
    pub kind: SceneTileKind,
    pub role: String,
    pub rect: ScenePixelRect,
    pub crop: SceneCrop,
    pub fit: SceneFit,
    pub mirror: bool,
    pub mask: SceneTileMask,
    pub z: i64,
}

/// Tile kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneTileKind {
    Person,
    Screen,
}

/// `SceneRoster`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneRoster {
    pub host: String,
    pub guests: Vec<String>,
    pub screen: Option<String>,
    pub host_on_stage: bool,
}

/// Crop and frame pair for motion.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneMotionBox {
    pub rect: ScenePixelRect,
    pub crop: SceneCrop,
}

/// Source picture size for [`super::plan::scene_picture`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneSourceSize {
    pub w: f64,
    pub h: f64,
}

/// Picture placement result.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScenePicturePlacement {
    pub clip: ScenePixelRect,
    pub full: ScenePixelRect,
}
