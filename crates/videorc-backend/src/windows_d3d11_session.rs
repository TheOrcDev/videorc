use std::collections::BTreeSet;

use crate::windows_d3d11_device::{WindowsD3d11MediaRole, WindowsDxgiOutputSelection};

pub(crate) const WINDOWS_D3D11_MEDIA_ENV: &str = "VIDEORC_WINDOWS_D3D11_MEDIA";
pub(crate) const WINDOWS_REQUIRE_D3D11_MEDIA_ENV: &str = "VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA";
// CFR is deadline-paced by the session pump. A blocking AcquireNextFrame
// would consume essentially the entire 60-fps budget on a static desktop.
const WINDOWS_D3D11_CAPTURE_POLL_WAIT_MS: u32 = 0;
// The direct D3D11 capture/compositor/Media Foundation path has production
// coverage through 1080p. Larger canvases must stay on the legacy bridge until
// they have equivalent device-level qualification; admitting them here can let
// a driver-specific hardware encoder failure take down the backend.
const WINDOWS_D3D11_QUALIFIED_MAX_LONG_SIDE: u32 = 1920;
const WINDOWS_D3D11_QUALIFIED_MAX_SHORT_SIDE: u32 = 1080;

#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_terminal_source_error(
    terminal_error: Option<&str>,
    stopped: bool,
) -> Option<String> {
    terminal_error.map(str::to_owned).or_else(|| {
        stopped.then(|| "D3D11 session pump stopped without a terminal result".to_string())
    })
}

/// Normalized destination transform + source crop for a caption/highlight
/// overlay layer. Pure so it is unit-tested on every host; the pixel layout
/// comes from the shared compositor oracle, so D3D11 cannot diverge from the
/// CPU and Metal paths (including the highlight's corner anchors).
#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_overlay_layer_geometry(
    overlay_size: (u32, u32),
    output_size: (u32, u32),
    rect: crate::overlay_layout::OverlayRect,
    safe_inset: usize,
) -> (
    crate::windows_d3d11_compositor::WindowsD3d11NormalizedTransform,
    crate::windows_d3d11_compositor::WindowsD3d11Crop,
) {
    let overlay_width = overlay_size.0.max(1) as usize;
    let overlay_height = overlay_size.1.max(1) as usize;
    let output_width = output_size.0.max(1) as usize;
    let output_height = output_size.1.max(1) as usize;
    let (source_left, destination_left, destination_top, draw_width) =
        crate::overlay_layout::overlay_blit_layout(
            overlay_width,
            overlay_height,
            output_width,
            output_height,
            rect,
            safe_inset,
        );
    let draw_height = overlay_height.min(output_height);
    (
        crate::windows_d3d11_compositor::WindowsD3d11NormalizedTransform {
            x: destination_left as f32 / output_width as f32,
            y: destination_top as f32 / output_height as f32,
            width: draw_width as f32 / output_width as f32,
            height: draw_height as f32 / output_height as f32,
        },
        crate::windows_d3d11_compositor::WindowsD3d11Crop {
            left: source_left as f32 / overlay_width as f32,
            top: 0.0,
            right: (overlay_width - source_left - draw_width) as f32 / overlay_width as f32,
            bottom: (overlay_height - draw_height) as f32 / overlay_height as f32,
        },
    )
}

/// The Buddy's bubble above the pet's head (plan 168 D16) as a normalized
/// transform and crop: the same oracle as the CPU and Metal paths
/// (`buddy_sprite::buddy_bubble_blit_layout`).
#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_bubble_layer_geometry(
    overlay_size: (u32, u32),
    output_size: (u32, u32),
    anchor: crate::buddy_sprite::BuddyBubbleAnchor,
) -> (
    crate::windows_d3d11_compositor::WindowsD3d11NormalizedTransform,
    crate::windows_d3d11_compositor::WindowsD3d11Crop,
) {
    let overlay_width = overlay_size.0.max(1) as usize;
    let overlay_height = overlay_size.1.max(1) as usize;
    let output_width = output_size.0.max(1) as usize;
    let output_height = output_size.1.max(1) as usize;
    let (source_left, destination_left, destination_top, draw_width) =
        crate::buddy_sprite::buddy_bubble_blit_layout(
            overlay_width,
            overlay_height,
            output_width,
            output_height,
            anchor,
        );
    let draw_height = overlay_height.min(output_height);
    (
        crate::windows_d3d11_compositor::WindowsD3d11NormalizedTransform {
            x: destination_left as f32 / output_width as f32,
            y: destination_top as f32 / output_height as f32,
            width: draw_width as f32 / output_width as f32,
            height: draw_height as f32 / output_height as f32,
        },
        crate::windows_d3d11_compositor::WindowsD3d11Crop {
            left: source_left as f32 / overlay_width as f32,
            top: 0.0,
            right: (overlay_width - source_left - draw_width) as f32 / overlay_width as f32,
            bottom: (overlay_height - draw_height) as f32 / overlay_height as f32,
        },
    )
}

/// A banner's draw rect (canvas pixels from `banners::banner_draw_rect`, the
/// oracle the CPU and Metal paths draw at) as the layer's normalized
/// transform (plan 186 S4). The prepared bitmap is the rect's exact size, so
/// the layer needs no crop; a stale bitmap (a re-prepare in flight) is
/// scaled into the rect like Metal does.
#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_banner_layer_transform(
    draw_rect: (usize, usize, usize, usize),
    output_size: (u32, u32),
) -> crate::windows_d3d11_compositor::WindowsD3d11NormalizedTransform {
    let (x, y, width, height) = draw_rect;
    let output_width = output_size.0.max(1) as f32;
    let output_height = output_size.1.max(1) as f32;
    crate::windows_d3d11_compositor::WindowsD3d11NormalizedTransform {
        x: x as f32 / output_width,
        y: y as f32 / output_height,
        width: width as f32 / output_width,
        height: height as f32 / output_height,
    }
}

/// Banner stacking on D3D11 (plan 186 D5): above the scene and the takeover
/// (z 0 and the source order), below captions (z 10). Later banners draw on
/// top; past the fourth they share z 9 and keep their input order (the scene
/// planner sorts by z, then input order).
#[cfg(any(target_os = "windows", test))]
const WINDOWS_D3D11_BANNER_Z_INDEX_BASE: i32 = 6;
#[cfg(any(target_os = "windows", test))]
const WINDOWS_D3D11_BANNER_Z_INDEX_TOP: i32 = 9;

#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_banner_z_index(index: usize) -> i32 {
    let index = i32::try_from(index).unwrap_or(i32::MAX);
    WINDOWS_D3D11_BANNER_Z_INDEX_BASE
        .saturating_add(index)
        .min(WINDOWS_D3D11_BANNER_Z_INDEX_TOP)
}

/// The layers one overlay item (the highlight card, captions, the Buddy, a
/// banner) has this tick, and which outputs each draws on (plan 205 S8).
/// The `PreviewBgra` texture is composed on the primary's canvas from the
/// primary's sources, so an item lands there from its primary-canvas layer
/// whenever one exists, else from its auxiliary one, scaled.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11ItemTargets {
    /// The layer laid out on the primary's canvas: the primary leg's own
    /// (`PRIMARY | PREVIEW`) when that leg burns the item; the Preview's
    /// alone (`PREVIEW`) when no encoded leg burns it but the program carries
    /// it (a Clips ring's stream-only item, D2); `None` otherwise.
    pub(crate) primary_canvas:
        Option<crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets>,
    /// The auxiliary leg's layer when that leg burns the item: `AUXILIARY`,
    /// plus `PREVIEW` when the primary does not burn it (the Preview draws
    /// each item once).
    pub(crate) auxiliary_canvas:
        Option<crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets>,
}

/// The rule (plan 205, "The Preview shows the program"), per item, from
/// which encoded legs burn it (`overlay_leg_plan` with the D13 fallbacks, or
/// `banner_leg_carries`) and whether the program carries it
/// (`program_shows`). Each encoded leg keeps exactly its own layer; only the
/// `PREVIEW` bit moves. Pure; the table is the unit test below.
///
/// | primary burns | auxiliary burns | program carries | primary canvas    | auxiliary canvas    |
/// |---------------|-----------------|-----------------|-------------------|---------------------|
/// | yes           | yes             | (yes)           | PRIMARY + PREVIEW | AUXILIARY           |
/// | yes           | no              | (yes)           | PRIMARY + PREVIEW | none                |
/// | no            | yes             | (yes)           | none              | AUXILIARY + PREVIEW |
/// | no            | no              | yes             | PREVIEW           | none                |
/// | no            | no              | no              | none              | none                |
///
/// An item an output carries is in the program by definition (nothing that
/// goes out is missing from the Preview), so `program_carries` decides only
/// the no-leg row: a buffer-only session's ring keeps the recording plan
/// while its Preview shows the idle program, every item with either switch
/// on (D2). In every other session shape the program is the union of the
/// legs' plans, and that row never happens.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_d3d11_item_targets(
    primary_burns: bool,
    auxiliary_burns: bool,
    program_carries: bool,
) -> WindowsD3d11ItemTargets {
    use crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets as Targets;
    let primary_canvas = if primary_burns {
        Some(Targets::PRIMARY.union(Targets::PREVIEW))
    } else if !auxiliary_burns && program_carries {
        Some(Targets::PREVIEW)
    } else {
        None
    };
    let auxiliary_canvas = auxiliary_burns.then(|| {
        if primary_burns {
            Targets::AUXILIARY
        } else {
            Targets::AUXILIARY.union(Targets::PREVIEW)
        }
    });
    WindowsD3d11ItemTargets {
        primary_canvas,
        auxiliary_canvas,
    }
}

/// The pump's Buddy clock (plan 168 S-C4): `output_sequence / fps`, the
/// pump's own deterministic time, the first animation clock on this path.
/// Both legs of a tick read the same value, so the animator steps once per
/// tick and a repeated tick draws exactly what it drew.
#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_buddy_clock_seconds(output_sequence: u64, render_fps: u32) -> f64 {
    output_sequence as f64 / f64::from(render_fps.max(1))
}

/// When the pump's next render tick is due: the first point after
/// `started_at` on the wall-clock grid `due + k * interval`. Sleeping
/// `interval - elapsed` after each tick added the sleep's overshoot to every
/// period, so a 60fps pump ran near 58 Hz and the CFR encoder writer, which
/// keeps wall time, found no new frame about every half second. A late tick
/// skips the grid points it missed instead of bursting to catch up, like the
/// Windows record compositor's `MissedTickBehavior::Skip`.
#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_next_render_tick_due(
    due: std::time::Instant,
    started_at: std::time::Instant,
    interval: std::time::Duration,
) -> std::time::Instant {
    let missed = started_at.saturating_duration_since(due).as_nanos() / interval.as_nanos().max(1);
    u32::try_from(missed.saturating_add(1))
        .ok()
        .and_then(|steps| interval.checked_mul(steps))
        .and_then(|step| due.checked_add(step))
        .unwrap_or(started_at + interval)
}

/// The Buddy's pet as a D3D11 layer (plan 168 S-B4): the untransformed
/// square (plus the draw's translation) normalized to the leg's output, the
/// atlas cell as the crop, and the 2x2 turn about the pivot for `SceneVs`.
/// The planner keeps the square unclamped so the edge clips, never squashes.
#[cfg(any(target_os = "windows", test))]
fn windows_d3d11_buddy_sprite_layer(
    source_id: u64,
    sprite: &crate::buddy_sprite::BuddySpriteLayer,
    output_size: (u32, u32),
    output_targets: crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets,
    z_index: i32,
) -> Result<crate::windows_d3d11_compositor::WindowsD3d11SceneLayerInput, String> {
    use crate::windows_d3d11_compositor::{
        WindowsD3d11Crop, WindowsD3d11LayerEffects, WindowsD3d11NormalizedTransform,
        WindowsD3d11OutputDimensions, WindowsD3d11SceneFit, WindowsD3d11SceneLayerInput,
        WindowsD3d11SceneMask, WindowsD3d11SceneSourceKind, WindowsD3d11SpriteTransform,
    };
    let draw = &sprite.draw;
    let atlas = &sprite.atlas;
    let [cell_x, cell_y, cell_width, cell_height] = draw.cell;
    if !draw.is_drawable()
        || cell_x + cell_width > atlas.width
        || cell_y + cell_height > atlas.height
    {
        return Err(format!(
            "Buddy sprite revision {} has an undrawable cell",
            atlas.revision
        ));
    }
    let width = output_size.0.max(1) as f32;
    let height = output_size.1.max(1) as f32;
    let left = draw.center[0] - draw.size / 2.0 + draw.translate[0];
    let top = draw.center[1] - draw.size / 2.0 + draw.translate[1];
    let pivot = draw.pivot_point();
    let atlas_width = atlas.width as f32;
    let atlas_height = atlas.height as f32;
    Ok(WindowsD3d11SceneLayerInput {
        source_id,
        source_kind: WindowsD3d11SceneSourceKind::BuddySprite,
        source_dimensions: WindowsD3d11OutputDimensions::new(atlas.width, atlas.height)
            .map_err(|error| error.to_string())?,
        transform: WindowsD3d11NormalizedTransform {
            x: left / width,
            y: top / height,
            width: draw.size / width,
            height: draw.size / height,
        },
        crop: WindowsD3d11Crop {
            left: cell_x as f32 / atlas_width,
            top: cell_y as f32 / atlas_height,
            right: (atlas.width - cell_x - cell_width) as f32 / atlas_width,
            bottom: (atlas.height - cell_y - cell_height) as f32 / atlas_height,
        },
        fit: WindowsD3d11SceneFit::Cover,
        mirror_x: false,
        mask: WindowsD3d11SceneMask::None,
        effects: WindowsD3d11LayerEffects {
            opacity: draw.opacity.clamp(0.0, 1.0),
            sprite: Some(WindowsD3d11SpriteTransform {
                affine: draw.affine,
                pivot: [
                    (pivot[0] + draw.translate[0]) / width,
                    (pivot[1] + draw.translate[1]) / height,
                ],
            }),
            ..Default::default()
        },
        z_index,
        output_targets,
    })
}

/// Presenter liveness follows the sources actually required by the effective
/// scene. A valid intentional empty scene is distinct from a failed input.
#[cfg(any(target_os = "windows", test))]
fn windows_scene_sources_live<'a>(
    mut scenes: impl Iterator<Item = &'a crate::protocol::Scene>,
    camera_pixels: bool,
    capture_pixels: bool,
    takeover: Option<bool>,
) -> bool {
    if let Some(available) = takeover {
        return available;
    }
    scenes.all(|scene| {
        let needs = crate::live_layout::required_scene_sources(scene);
        (!needs.camera || camera_pixels) && (!needs.screen || capture_pixels)
    })
}

/// Capture and primary render pool depth for every session shape. Size it so
/// transient fence lag cannot starve a CFR tick into a silent single-frame
/// skip. Screen-camera composition keeps one more full-frame layer in flight,
/// but screen-only sessions need the same depth too: at 60 fps on an i5-8400
/// with a GTX 1650 Super, three slots showed texture pool pressure and cadence
/// loss, while five showed none (#280). Five stays inside the per-format pool
/// ceiling of 8.
#[cfg(any(target_os = "windows", test))]
const WINDOWS_D3D11_RENDER_POOL_SLOTS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11MediaMode {
    Disabled,
    Automatic,
    Required,
}

impl WindowsD3d11MediaMode {
    pub(crate) fn from_process_env() -> Result<Self, String> {
        Self::from_env_values(
            std::env::var(WINDOWS_D3D11_MEDIA_ENV).ok().as_deref(),
            std::env::var(WINDOWS_REQUIRE_D3D11_MEDIA_ENV)
                .ok()
                .as_deref(),
        )
    }

    pub(crate) fn from_env_values(
        media: Option<&str>,
        require: Option<&str>,
    ) -> Result<Self, String> {
        let media = match media.map(str::trim) {
            None | Some("") | Some("1") | Some("true") | Some("on") | Some("auto")
            | Some("automatic") => Self::Automatic,
            Some("0") | Some("false") | Some("off") | Some("disabled") => Self::Disabled,
            Some("required") | Some("require") => Self::Required,
            Some(value) => {
                return Err(format!(
                    "{WINDOWS_D3D11_MEDIA_ENV} has unsupported value {value:?}; use auto, required, or disabled"
                ));
            }
        };
        let require = match require.map(str::trim) {
            None | Some("") | Some("0") | Some("false") | Some("off") => false,
            Some("1") | Some("true") | Some("on") | Some("required") => true,
            Some(value) => {
                return Err(format!(
                    "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV} has unsupported value {value:?}; use 1 or 0"
                ));
            }
        };
        if require && media == Self::Disabled {
            return Err(format!(
                "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV}=1 conflicts with {WINDOWS_D3D11_MEDIA_ENV}=disabled"
            ));
        }
        Ok(if require { Self::Required } else { media })
    }

    pub(crate) const fn is_required(self) -> bool {
        matches!(self, Self::Required)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11VideoPlan {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) fps: u32,
    pub(crate) bitrate_kbps: u32,
}

fn windows_d3d11_output_fits_qualified_envelope(video: WindowsD3d11VideoPlan) -> bool {
    video.width.max(video.height) <= WINDOWS_D3D11_QUALIFIED_MAX_LONG_SIDE
        && video.width.min(video.height) <= WINDOWS_D3D11_QUALIFIED_MAX_SHORT_SIDE
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11SessionRequest {
    pub(crate) platform_supported: bool,
    pub(crate) screen_id: Option<String>,
    pub(crate) window_selected: bool,
    pub(crate) screen_available: bool,
    pub(crate) source_width: Option<u32>,
    pub(crate) source_height: Option<u32>,
    pub(crate) supported_layout: bool,
    pub(crate) camera_required: bool,
    pub(crate) camera_source_available: bool,
    pub(crate) explicit_scene: bool,
    /// Shipping scene semantics that do not yet have a D3D11 layer/input
    /// mapping. Keeping this explicit makes each future bounded `BgraUpload`
    /// source a selector capability change rather than a silent omission.
    pub(crate) unsupported_scene_features: Vec<String>,
    pub(crate) media_foundation_selected: bool,
    pub(crate) record_enabled: bool,
    pub(crate) stream_enabled: bool,
    pub(crate) primary: WindowsD3d11VideoPlan,
    pub(crate) auxiliary: Option<WindowsD3d11VideoPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11NaturalFallback {
    pub(crate) code: &'static str,
    pub(crate) detail: String,
}

impl std::fmt::Display for WindowsD3d11NaturalFallback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11SessionPlan {
    pub(crate) screen_id: String,
    pub(crate) source_width: u32,
    pub(crate) source_height: u32,
    pub(crate) primary: WindowsD3d11VideoPlan,
    pub(crate) auxiliary: Option<WindowsD3d11VideoPlan>,
    pub(crate) camera_required: bool,
    /// The presenter is generation-bound after the media pump starts, so a
    /// normal session has no preview target at its startup claim gate. Preview
    /// tickets become required only while a trusted presenter generation is
    /// configured.
    pub(crate) preview_required_at_startup: bool,
    pub(crate) primary_role: WindowsD3d11MediaRole,
    pub(crate) roles: BTreeSet<WindowsD3d11MediaRole>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WindowsD3d11SessionSelection {
    Disabled,
    Candidate(WindowsD3d11SessionPlan),
    NaturalFallback(WindowsD3d11NaturalFallback),
}

fn fallback_or_required(
    mode: WindowsD3d11MediaMode,
    code: &'static str,
    detail: impl Into<String>,
) -> Result<WindowsD3d11SessionSelection, String> {
    let fallback = WindowsD3d11NaturalFallback {
        code,
        detail: detail.into(),
    };
    if mode.is_required() {
        Err(format!(
            "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV}=1 rejected session startup: {fallback}"
        ))
    } else {
        Ok(WindowsD3d11SessionSelection::NaturalFallback(fallback))
    }
}

pub(crate) fn select_windows_d3d11_session(
    mode: WindowsD3d11MediaMode,
    request: WindowsD3d11SessionRequest,
) -> Result<WindowsD3d11SessionSelection, String> {
    if mode == WindowsD3d11MediaMode::Disabled {
        return Ok(WindowsD3d11SessionSelection::Disabled);
    }
    if !request.platform_supported {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-platform-unsupported",
            "the unified D3D11 media authority is available only on Windows",
        );
    }
    if !request.media_foundation_selected {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-foundation-not-selected",
            "the effective encoder is not the Media Foundation H.264 bridge",
        );
    }
    if request.window_selected {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-window-capture-unsupported",
            "the first production D3D11 session supports DXGI monitor capture only",
        );
    }
    if !request.supported_layout {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-layout-unsupported",
            "the selected layout needs sources that are not yet mapped into the D3D11 scene plan",
        );
    }
    if request.explicit_scene {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-explicit-scene-unsupported",
            "explicit scene layers are not yet mapped into the D3D11 scene plan",
        );
    }
    if !request.unsupported_scene_features.is_empty() {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-scene-features-unsupported",
            format!(
                "the D3D11 scene input map does not yet support: {}",
                request.unsupported_scene_features.join(", ")
            ),
        );
    }
    if request.camera_required && !request.camera_source_available {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-camera-source-unavailable",
            "the screen-camera layout requires a live camera frame source for its measured GPU upload",
        );
    }
    if !request.record_enabled && !request.stream_enabled {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-no-output",
            "the session has neither a recording nor a livestream output",
        );
    }
    let Some(screen_id) = request.screen_id else {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-missing",
            "no DXGI monitor was selected",
        );
    };
    if let Err(error) = WindowsDxgiOutputSelection::parse(&screen_id) {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-id-invalid",
            error.to_string(),
        );
    }
    if !request.screen_available {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-unavailable",
            format!("selected monitor {screen_id} is not currently available"),
        );
    }
    let (Some(source_width), Some(source_height)) = (request.source_width, request.source_height)
    else {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-dimensions-missing",
            format!("selected monitor {screen_id} did not report native dimensions"),
        );
    };
    if source_width == 0 || source_height == 0 {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-dimensions-invalid",
            format!("selected monitor {screen_id} reported {source_width}x{source_height}"),
        );
    }
    if !windows_d3d11_output_fits_qualified_envelope(request.primary) {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-primary-output-unqualified",
            format!(
                "the production D3D11/Media Foundation path is qualified through 1920x1080; primary output is {}x{}",
                request.primary.width, request.primary.height
            ),
        );
    }
    if let Some(auxiliary) = request.auxiliary
        && !windows_d3d11_output_fits_qualified_envelope(auxiliary)
    {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-auxiliary-output-unqualified",
            format!(
                "the production D3D11/Media Foundation path is qualified through 1920x1080; auxiliary output is {}x{}",
                auxiliary.width, auxiliary.height
            ),
        );
    }
    if !request.primary.width.is_multiple_of(2)
        || !request.primary.height.is_multiple_of(2)
        || request.primary.fps == 0
    {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-primary-profile-invalid",
            "the primary NV12 output requires even, non-zero dimensions and a non-zero frame rate",
        );
    }
    if let Some(auxiliary) = request.auxiliary
        && (!auxiliary.width.is_multiple_of(2)
            || !auxiliary.height.is_multiple_of(2)
            || auxiliary.fps == 0)
    {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-auxiliary-profile-invalid",
            "the auxiliary NV12 output requires even, non-zero dimensions and a non-zero frame rate",
        );
    }

    let primary_role = if request.auxiliary.is_some() || !request.stream_enabled {
        WindowsD3d11MediaRole::Record
    } else {
        WindowsD3d11MediaRole::Stream
    };
    let mut roles = BTreeSet::from([
        WindowsD3d11MediaRole::Compositor,
        WindowsD3d11MediaRole::Preview,
        primary_role,
    ]);
    if request.auxiliary.is_some() {
        roles.insert(WindowsD3d11MediaRole::Stream);
    }
    Ok(WindowsD3d11SessionSelection::Candidate(
        WindowsD3d11SessionPlan {
            screen_id,
            source_width,
            source_height,
            primary: request.primary,
            auxiliary: request.auxiliary,
            camera_required: request.camera_required,
            preview_required_at_startup: false,
            primary_role,
            roles,
        },
    ))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11StartupEvidence {
    pub(crate) capture_started: bool,
    pub(crate) resumed_committed_sources: bool,
    pub(crate) preview_ticket: bool,
    pub(crate) primary_ticket: bool,
    pub(crate) auxiliary_ticket: bool,
    pub(crate) primary_encoder_attached: bool,
    pub(crate) auxiliary_encoder_attached: bool,
}

pub(crate) fn validate_windows_d3d11_startup_evidence(
    mode: WindowsD3d11MediaMode,
    plan: &WindowsD3d11SessionPlan,
    evidence: WindowsD3d11StartupEvidence,
) -> Result<Option<WindowsD3d11NaturalFallback>, String> {
    let missing = if !evidence.capture_started && !evidence.resumed_committed_sources {
        Some((
            "windows-d3d11-media-capture-not-started",
            "capture did not start on the D3D11 media authority",
        ))
    } else if plan.preview_required_at_startup && !evidence.preview_ticket {
        Some((
            "windows-d3d11-media-preview-ticket-missing",
            "the compositor did not publish a role-bound BGRA preview ticket",
        ))
    } else if !evidence.primary_ticket {
        Some((
            "windows-d3d11-media-primary-ticket-missing",
            "the compositor did not publish a role-bound primary NV12 ticket",
        ))
    } else if plan.auxiliary.is_some() && !evidence.auxiliary_ticket {
        Some((
            "windows-d3d11-media-auxiliary-ticket-missing",
            "the compositor did not publish a role-bound auxiliary NV12 ticket",
        ))
    } else if !evidence.primary_encoder_attached {
        Some((
            "windows-d3d11-media-primary-encoder-unattached",
            "the primary NV12 ticket was not attached to its Media Foundation surface encoder",
        ))
    } else if plan.auxiliary.is_some() && !evidence.auxiliary_encoder_attached {
        Some((
            "windows-d3d11-media-auxiliary-encoder-unattached",
            "the auxiliary NV12 ticket was not attached to its Media Foundation surface encoder",
        ))
    } else {
        None
    };
    let Some((code, detail)) = missing else {
        return Ok(None);
    };
    let fallback = WindowsD3d11NaturalFallback {
        code,
        detail: detail.to_string(),
    };
    if mode.is_required() {
        Err(format!(
            "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV}=1 rejected session startup: {fallback}"
        ))
    } else {
        Ok(Some(fallback))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsD3d11CfrTick {
    output_sequence: u64,
    source_sequence: u64,
    repeated_source: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct WindowsD3d11CfrSequencer {
    output_sequence: u64,
    source_sequence: Option<u64>,
}

impl WindowsD3d11CfrSequencer {
    fn replace_source(&mut self) {
        // Capture sequences restart per binding; encoder time never does.
        self.source_sequence = None;
    }
    fn advance_blank(&mut self) -> Result<Option<WindowsD3d11CfrTick>, String> {
        if self.output_sequence == 0 {
            return Ok(None);
        }
        self.output_sequence = self
            .output_sequence
            .checked_add(1)
            .ok_or_else(|| "D3D11 CFR output sequence was exhausted".to_string())?;
        Ok(Some(WindowsD3d11CfrTick {
            output_sequence: self.output_sequence,
            source_sequence: 0,
            repeated_source: true,
        }))
    }
    fn advance(
        &mut self,
        new_source_sequence: Option<u64>,
    ) -> Result<Option<WindowsD3d11CfrTick>, String> {
        let repeated_source = new_source_sequence.is_none();
        if let Some(sequence) = new_source_sequence {
            if sequence == 0
                || self
                    .source_sequence
                    .is_some_and(|previous| sequence <= previous)
            {
                return Err(format!(
                    "D3D11 capture sequence {sequence} did not advance beyond {:?}",
                    self.source_sequence
                ));
            }
            self.source_sequence = Some(sequence);
        }
        let Some(source_sequence) = self.source_sequence else {
            return Ok(None);
        };
        self.output_sequence = self
            .output_sequence
            .checked_add(1)
            .ok_or_else(|| "D3D11 CFR output sequence was exhausted".to_string())?;
        Ok(Some(WindowsD3d11CfrTick {
            output_sequence: self.output_sequence,
            source_sequence,
            repeated_source,
        }))
    }
}

#[cfg(target_os = "windows")]
mod runtime {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Condvar, Mutex as StdMutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use crate::captions::{
        CaptionOverlay, CaptionOverlaySlot, CaptionOverlaySlots, current_caption_overlay,
        current_caption_overlays,
    };
    use crate::compositor::{
        CompositorFrameExportHandle, CompositorFrameStore, CompositorPixelFormat,
        caption_overlay_safe_inset,
    };
    use crate::frame_store::{FrameHandle, FrameStore};
    use crate::preview_camera::{PreviewCameraFrameSource, PreviewCameraPixelFormat};
    use crate::protocol::{LayoutSettings, SceneSourceKind};
    use crate::scene_geometry::{
        CHROMA_KEY_SATURATION_FLOOR, SceneFit, SceneMask, camera_chroma_key, camera_mask,
        resolved_camera_transform, scene_crop_from_transform, scene_source_fit,
    };
    use crate::state::{
        WindowsD3d11MediaCoordinatorSlot, WindowsD3d11MediaRoleHandle, acquire_windows_d3d11_media,
    };
    use crate::windows_d3d11_capture::{
        WindowsD3d11CapturePlan, WindowsD3d11WgcCursorExclusionProbe,
    };
    use crate::windows_d3d11_compositor::{
        WindowsD3d11CanvasOrientation, WindowsD3d11ChromaKey, WindowsD3d11Crop,
        WindowsD3d11EncodedOutputPlan, WindowsD3d11EncodedOutputRole, WindowsD3d11LayerEffects,
        WindowsD3d11NormalizedTransform, WindowsD3d11OutputDimensions, WindowsD3d11SceneFit,
        WindowsD3d11SceneLayerInput, WindowsD3d11SceneMask, WindowsD3d11SceneOutputTargets,
        WindowsD3d11ScenePlanRequest, WindowsD3d11SceneSourceKind, WindowsD3d11UploadPixelOrder,
        build_windows_d3d11_scene_plan,
    };
    use crate::windows_d3d11_device::{
        WindowsD3d11BgraTextureDescriptor, WindowsD3d11ComposedTextureKind,
        WindowsD3d11CompositionConsumers, WindowsD3d11CompositionSource, WindowsD3d11Error,
        WindowsD3d11ErrorCode, WindowsD3d11MediaClient, WindowsD3d11MediaRole,
        WindowsD3d11Nv12TextureDescriptor, WindowsD3d11TextureFormat,
        WindowsD3d11TextureLeaseTicket, WindowsD3d11TexturePoolConfig, WindowsD3d11TicketedTexture,
        WindowsD3d11UploadPixels, WindowsDxgiOutputSelection,
    };
    use crate::windows_d3d11_preview::{WindowsD3d11PresenterStatus, WindowsD3d11PreviewPlacement};
    use crate::windows_media_foundation_encoder::MediaFoundationEncoderConfig;

    use super::{
        WindowsD3d11CfrSequencer, WindowsD3d11CfrTick, WindowsD3d11SessionPlan,
        WindowsD3d11StartupEvidence, windows_d3d11_terminal_source_error,
    };

    const STARTUP_TIMEOUT: Duration = Duration::from_secs(4);
    const CAPTURE_SOURCE_ID: u64 = 1;
    const CAMERA_SOURCE_ID: u64 = 2;
    const CAPTION_PRIMARY_SOURCE_ID: u64 = 10;
    const CAPTION_AUXILIARY_SOURCE_ID: u64 = 11;
    const HIGHLIGHT_PRIMARY_SOURCE_ID: u64 = 12;
    const HIGHLIGHT_AUXILIARY_SOURCE_ID: u64 = 13;
    /// The Buddy's bubble per target (plan 168 D16).
    const BUDDY_PRIMARY_SOURCE_ID: u64 = 14;
    const BUDDY_AUXILIARY_SOURCE_ID: u64 = 15;
    /// The Buddy's pet atlas per leg (plan 168 S-B4).
    const BUDDY_SPRITE_PRIMARY_SOURCE_ID: u64 = 16;
    const BUDDY_SPRITE_AUXILIARY_SOURCE_ID: u64 = 17;
    /// Overlay stacking (plan 164 owner answer 7, plan 168 D9): captions,
    /// then the Buddy (pet, then bubble), then the highlight card on top.
    /// `build_windows_d3d11_scene_plan` sorts layers by z, so the numbers are
    /// the order.
    const CAPTION_Z_INDEX: i32 = 10;
    const BUDDY_SPRITE_Z_INDEX: i32 = 11;
    const BUDDY_Z_INDEX: i32 = 12;
    const HIGHLIGHT_Z_INDEX: i32 = 13;
    /// Banners per leg (plan 186 S4): `banners::BANNER_MAX_SHOWN` plus room
    /// for the ones still fading out. Ids 40.. are the primary leg's, 48.. the
    /// auxiliary's; z 6 to 9 sits under the captions.
    const BANNER_LAYERS_PER_LEG: usize = 8;
    const BANNER_PRIMARY_SOURCE_ID_BASE: u64 = 40;
    const BANNER_AUXILIARY_SOURCE_ID_BASE: u64 = 48;
    /// Plan 205 S8: the banners only the Preview draws (a buffer-only
    /// session's ring keeps the recording plan while the Preview shows the
    /// idle program, D2), ids 56.., laid out on the primary's canvas.
    const BANNER_PREVIEW_SOURCE_ID_BASE: u64 = 56;
    const _: () = assert!(super::WINDOWS_D3D11_BANNER_Z_INDEX_TOP < CAPTION_Z_INDEX);
    const _: () = assert!(
        BANNER_PRIMARY_SOURCE_ID_BASE + BANNER_LAYERS_PER_LEG as u64
            <= BANNER_AUXILIARY_SOURCE_ID_BASE
    );
    const _: () = assert!(
        BANNER_AUXILIARY_SOURCE_ID_BASE + BANNER_LAYERS_PER_LEG as u64
            <= BANNER_PREVIEW_SOURCE_ID_BASE
    );

    /// Shared committed authority only; no recording/pump back-reference.
    pub(crate) struct WindowsLiveSources {
        session_id: String,
        compositor: crate::compositor::CompositorSlot,
        camera: crate::preview_camera::PreviewCameraSlot,
        capture: crate::preview_screen::PreviewScreenSlot,
        coordinator: Arc<StdMutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        generation: u64,
        authority: Option<crate::compositor::NativeSourceOutputLease>,
        bootstrap: Option<WindowsLiveSnapshot>,
        events: tokio::sync::broadcast::Sender<crate::protocol::ServerEvent>,
        /// For the live background's budget notice (plan 190 S4).
        state: crate::state::AppState,
    }
    struct WindowsLiveSnapshot {
        edit: crate::compositor::CompositorSourceEdit,
        render_edit: crate::compositor::CompositorSourceEdit,
        camera: Option<PreviewCameraFrameSource>,
        capture: Option<crate::preview_screen::PreviewScreenFrameSource>,
        confirmed: crate::protocol::SourceSelection,
        source_revision: u64,
        takeover: Option<crate::compositor::WindowsSceneImage>,
        takeover_active: bool,
        backgrounds: Vec<Option<crate::compositor::WindowsSceneImage>>,
        /// The banner set (plan 186 S4), swapped as one `Arc` by the
        /// compositor; each leg's draws are derived per tick.
        banners: Arc<crate::banners::BannerSet>,
        /// Plan 190 S4: the live background this tick, when one shows (the
        /// pump stamps the tick; `primary_live_background` checks the leg).
        live_background: Option<crate::live_background::LiveBackgroundFrameInput>,
        /// The guard just fell back to the poster: the pump says so once.
        live_background_budget_notice: bool,
    }
    impl WindowsLiveSources {
        pub(crate) fn new(state: &crate::state::AppState, session_id: &str) -> Self {
            Self {
                session_id: session_id.into(),
                compositor: state.compositor.clone(),
                camera: state.preview_camera.clone(),
                capture: state.preview_screen.clone(),
                coordinator: state.live_source_switch.clone(),
                generation: 0,
                authority: None,
                bootstrap: None,
                events: state.events.clone(),
                state: state.clone(),
            }
        }
        pub(crate) async fn for_recovery(
            state: &crate::state::AppState,
            session_id: &str,
        ) -> Result<Self, String> {
            let mut sources = Self::new(state, session_id);
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                if let Some(snapshot) = sources.snapshot() {
                    sources.bootstrap = Some(snapshot);
                    return Ok(sources);
                }
                if sources
                    .coordinator
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .running_snapshot(session_id)
                    .is_err()
                {
                    return Err("Source authority stopped during GPU recovery".into());
                }
                if Instant::now() >= deadline {
                    return Err("Current committed sources were busy during GPU recovery; no previous source was reopened".into());
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        fn snapshot(&self) -> Option<WindowsLiveSnapshot> {
            // Match the publication lock order and never wait on an async lock
            // from the CFR thread. A busy transaction leaves the last route live.
            let camera = self.camera.try_lock().ok()?;
            let capture = self.capture.try_lock().ok()?;
            let mut compositor = self.compositor.try_lock().ok()?;
            let coordinator = self.coordinator.try_lock().ok()?;
            let confirmed = coordinator.running_snapshot(&self.session_id).ok()?;
            // Same-ID retry candidates can be installed before commit. Their
            // generation is not authorized merely because the ID still matches.
            if confirmed.pending.as_ref().is_some_and(|operation| {
                operation.kind != crate::live_source_switch::SourceKind::Microphone
            }) {
                return None;
            }
            let camera =
                crate::preview_camera::available_frame_source_locked(&camera).filter(|source| {
                    source
                        .source_key()
                        .is_some_and(|key| Some(&key.id) == confirmed.confirmed.camera_id.as_ref())
                });
            let capture =
                crate::preview_screen::available_frame_source_locked(&capture).filter(|source| {
                    source.source_key().is_some_and(|key| {
                        Some(&key.id)
                            == confirmed
                                .confirmed
                                .window_id
                                .as_ref()
                                .or(confirmed.confirmed.screen_id.as_ref())
                    })
                });
            let edit = compositor.source_edit_snapshot()?;
            let (takeover, backgrounds) = compositor.windows_scene_images(&edit);
            let (live_background, live_background_budget_notice) =
                compositor.windows_live_background(Instant::now());
            Some(WindowsLiveSnapshot {
                render_edit: compositor.source_render_edit(Instant::now())?,
                edit,
                takeover,
                takeover_active: compositor.windows_takeover_active(),
                backgrounds,
                banners: compositor.windows_banner_set(),
                live_background,
                live_background_budget_notice,
                camera,
                capture,
                confirmed: confirmed.confirmed,
                source_revision: confirmed.source_revision,
            })
        }
        /// Plan 190 S4: the guard fell back to the poster (once per fall).
        fn notify_live_background_budget(&self) {
            let _ = crate::recording::emit_health_event(
                &self.state,
                Some(&self.session_id),
                crate::protocol::HealthLevel::Info,
                "live-background-gpu-budget",
                crate::live_background::runtime::GPU_BUDGET_NOTICE,
            );
        }
        fn observe(
            &self,
            snapshot: &WindowsLiveSnapshot,
            camera_pixels: bool,
            capture_pixels: bool,
            all_legs: bool,
        ) {
            let Ok(mut compositor) = self.compositor.try_lock() else {
                return;
            };
            let Ok(mut coordinator) = self.coordinator.try_lock() else {
                return;
            };
            let observed =
                compositor.observe_windows_source_publication(
                    &mut coordinator,
                    &snapshot.edit,
                    &self.session_id,
                    self.generation,
                    snapshot.camera.as_ref().and_then(|source| {
                        source.source_key().map(|key| (key, source.generation()))
                    }),
                    snapshot.capture.as_ref().and_then(|source| {
                        source.source_key().map(|key| (key, source.generation()))
                    }),
                    camera_pixels,
                    capture_pixels,
                    all_legs,
                );
            let changed = observed
                .then(|| coordinator.snapshot(&self.session_id).ok())
                .flatten();
            drop(coordinator);
            drop(compositor);
            if let Some(changed) = changed {
                let _ = self.events.send(crate::protocol::ServerEvent::new(
                    "session.sources.changed",
                    changed,
                ));
            }
        }
    }

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11CameraInput {
        pub(crate) source: PreviewCameraFrameSource,
        pub(crate) layout: LayoutSettings,
    }

    #[derive(Clone)]
    pub(crate) struct WindowsD3d11OverlayInput {
        pub(crate) captions: CaptionOverlaySlots,
        pub(crate) highlight: CaptionOverlaySlot,
        /// The Buddy's bubble, one raster per target like captions (plan 164;
        /// the bubble only since plan 168).
        pub(crate) buddy: CaptionOverlaySlots,
        /// The Buddy's pet atlases and draws (plan 168 S-B4).
        pub(crate) buddy_sprite: crate::buddy_sprite::BuddySpriteSlot,
        pub(crate) caption_on_primary: bool,
        pub(crate) caption_on_auxiliary: bool,
        pub(crate) highlight_on_primary: bool,
        pub(crate) highlight_on_auxiliary: bool,
        pub(crate) buddy_on_primary: bool,
        pub(crate) buddy_on_auxiliary: bool,
        /// Plan 205 S8: the program carries the highlight card / the Buddy
        /// (`program_shows` over the layout at session start, like the leg
        /// flags above; mid-session switches apply at the next start, as the
        /// log says). It differs from "some leg burns it" only for a
        /// buffer-only session, whose ring keeps the recording plan (D2)
        /// while its Preview shows the idle program.
        pub(crate) highlight_in_program: bool,
        pub(crate) buddy_in_program: bool,
        /// The banners' leg plan shape (plan 186 S4): each banner's switches
        /// pick its legs through `banners::banner_leg_carries`, live, so a
        /// switch change mid-session moves it on the next tick.
        pub(crate) banner_shape: crate::overlay_layout::OverlaySessionShape,
        /// Plan 205 S8: the shape the Preview's program is read from, for the
        /// banners (live, from the committed set). `Some(banner_shape)` for a
        /// session that is an output; `None` for a buffer-only (Clips)
        /// session, whose program is the idle one: every shown banner with
        /// either switch on, while the ring keeps `banner_shape`'s plan.
        pub(crate) program_shape: Option<crate::overlay_layout::OverlaySessionShape>,
        /// The shared prepare service: the bitmaps are prepared once per
        /// (banner, canvas, rect, opacity) off this thread and shared here.
        pub(crate) banner_prepare: crate::banner_prepare::BannerPrepareService,
    }

    /// One banner on one leg for one tick (plan 186 S4).
    #[derive(Clone)]
    struct WindowsD3d11BannerFrame {
        source_id: u64,
        draw: crate::compositor::BannerDraw,
        output_targets: WindowsD3d11SceneOutputTargets,
        output_dimensions: WindowsD3d11OutputDimensions,
        z_index: i32,
    }

    #[derive(Clone)]
    struct WindowsD3d11OverlayFrame {
        source_id: u64,
        source_kind: WindowsD3d11SceneSourceKind,
        overlay: CaptionOverlay,
        output_targets: WindowsD3d11SceneOutputTargets,
        output_dimensions: WindowsD3d11OutputDimensions,
        safe_inset: usize,
        z_index: i32,
        /// The Buddy's bubble: anchored above the pet's head on its leg
        /// (plan 168 D16) instead of inside its rect.
        bubble_anchor: Option<crate::buddy_sprite::BuddyBubbleAnchor>,
    }

    /// The Buddy's pet on one leg for one tick (plan 168 S-B4).
    #[derive(Clone)]
    struct WindowsD3d11SpriteFrame {
        source_id: u64,
        layer: crate::buddy_sprite::BuddySpriteLayer,
        output_targets: WindowsD3d11SceneOutputTargets,
        output_dimensions: WindowsD3d11OutputDimensions,
        z_index: i32,
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11SessionPumpSnapshot {
        pub(crate) generation: u64,
        pub(crate) authority_adapter_luid: u64,
        pub(crate) capture_adapter_luid: u64,
        pub(crate) compositor_adapter_luid: u64,
        pub(crate) primary_encoder_adapter_luid: u64,
        pub(crate) auxiliary_encoder_adapter_luid: Option<u64>,
        pub(crate) adapter_mismatches: u64,
        pub(crate) captured_frames: u64,
        pub(crate) capture_upload_frames: u64,
        pub(crate) capture_route_bgra: bool,
        pub(crate) source_revision: u64,
        pub(crate) capture_cleanup_pending: bool,
        pub(crate) capture_source_error: Option<String>,
        pub(crate) composed_frames: u64,
        pub(crate) camera_upload_frames: u64,
        pub(crate) latest_capture_sequence: Option<u64>,
        pub(crate) repeated_capture_frames: u64,
        pub(crate) pressure_skips: u64,
        pub(crate) render_ticks: u64,
        pub(crate) render_tick_overruns: u64,
        pub(crate) render_tick_lag_max_us: u64,
        pub(crate) render_compose_stage_max_us: u64,
        pub(crate) render_publish_stage_max_us: u64,
        pub(crate) preview_offered_sequence: Option<u64>,
        pub(crate) preview_offer_failures: u64,
        pub(crate) preview_sequence: Option<u64>,
        pub(crate) primary_sequence: Option<u64>,
        pub(crate) auxiliary_sequence: Option<u64>,
        pub(crate) device_lost: bool,
        pub(crate) terminal_error: Option<String>,
        pub(crate) stopped: bool,
    }

    pub(crate) struct WindowsD3d11SessionPump {
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
        client: WindowsD3d11MediaClient,
        preview_store: CompositorFrameStore,
        primary_store: CompositorFrameStore,
        auxiliary_store: Option<CompositorFrameStore>,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        preview_generation: Arc<AtomicU64>,
        roles: Vec<WindowsD3d11MediaRoleHandle>,
        primary_role: WindowsD3d11MediaRole,
        startup_evidence: WindowsD3d11StartupEvidence,
    }

    #[derive(Debug, Clone)]
    struct WindowsD3d11EncoderTicketSourceState {
        client: WindowsD3d11MediaClient,
        frame_store: CompositorFrameStore,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        recovery_count: u8,
    }

    #[derive(Debug)]
    struct WindowsD3d11EncoderTicketSourceSlot {
        current: StdMutex<WindowsD3d11EncoderTicketSourceState>,
        changed: Condvar,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11EncoderTicketSource {
        pub(crate) role: WindowsD3d11MediaRole,
        slot: Arc<WindowsD3d11EncoderTicketSourceSlot>,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11EncoderTicketSourceSnapshot {
        pub(crate) client: WindowsD3d11MediaClient,
        pub(crate) frame_store: CompositorFrameStore,
        pub(crate) role: WindowsD3d11MediaRole,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        recovery_count: u8,
    }

    #[derive(Clone)]
    pub(crate) struct WindowsD3d11SessionMonitor {
        client: WindowsD3d11MediaClient,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        preview_generation: Arc<AtomicU64>,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11SessionDiagnosticsSnapshot {
        pub(crate) pump: WindowsD3d11SessionPumpSnapshot,
        pub(crate) device: crate::windows_d3d11_device::WindowsD3d11DeviceStatus,
        pub(crate) presenter: Option<WindowsD3d11PresenterStatus>,
    }

    impl WindowsD3d11SessionMonitor {
        pub(crate) fn configure_preview(
            &self,
            placement: WindowsD3d11PreviewPlacement,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            let preview_generation = placement.preview_generation;
            let status = self
                .client
                .configure_preview(placement)
                .inspect_err(|error| {
                    attribute_adapter_mismatch(&self.snapshot, error);
                })?;
            self.preview_generation
                .store(preview_generation, Ordering::Release);
            Ok(status)
        }

        pub(crate) fn preview_status(
            &self,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            self.client.preview_status()
        }

        pub(crate) fn destroy_preview(&self) -> Result<bool, WindowsD3d11Error> {
            let destroyed = self.client.destroy_preview()?;
            self.preview_generation.store(0, Ordering::Release);
            Ok(destroyed)
        }

        pub(crate) fn diagnostics_snapshot(
            &self,
        ) -> Result<WindowsD3d11SessionDiagnosticsSnapshot, WindowsD3d11Error> {
            let device = self.client.status()?;
            let presenter = self.client.preview_status().ok();
            Ok(WindowsD3d11SessionDiagnosticsSnapshot {
                pump: self
                    .snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                device,
                presenter,
            })
        }
    }

    impl WindowsD3d11EncoderTicketSource {
        fn new(
            client: WindowsD3d11MediaClient,
            frame_store: CompositorFrameStore,
            role: WindowsD3d11MediaRole,
            snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        ) -> Self {
            Self {
                role,
                slot: Arc::new(WindowsD3d11EncoderTicketSourceSlot {
                    current: StdMutex::new(WindowsD3d11EncoderTicketSourceState {
                        client,
                        frame_store,
                        snapshot,
                        recovery_count: 0,
                    }),
                    changed: Condvar::new(),
                }),
            }
        }

        pub(crate) fn current(&self) -> WindowsD3d11EncoderTicketSourceSnapshot {
            let current = self
                .slot
                .current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            WindowsD3d11EncoderTicketSourceSnapshot {
                client: current.client.clone(),
                frame_store: Arc::clone(&current.frame_store),
                role: self.role,
                snapshot: Arc::clone(&current.snapshot),
                recovery_count: current.recovery_count,
            }
        }

        pub(crate) fn generation(&self) -> u64 {
            self.current().generation()
        }

        /// Atomically rebinds every clone of this role's source handle. The
        /// failed generation may be replaced only by its immediate successor;
        /// delayed callbacks cannot overwrite a newer recovery.
        pub(crate) fn replace_generation(
            &self,
            expected_generation: u64,
            replacement: &Self,
        ) -> Result<bool, String> {
            if !self.can_replace_generation(expected_generation, replacement)? {
                return Ok(false);
            }
            let replacement = replacement.current();
            let mut current = self
                .slot
                .current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current_generation = current
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .generation;
            if current_generation != expected_generation {
                return Ok(false);
            }
            let recovery_count = current.recovery_count.saturating_add(1);
            *current = WindowsD3d11EncoderTicketSourceState {
                client: replacement.client,
                frame_store: replacement.frame_store,
                snapshot: replacement.snapshot,
                recovery_count,
            };
            drop(current);
            self.slot.changed.notify_all();
            Ok(true)
        }

        pub(crate) fn can_replace_generation(
            &self,
            expected_generation: u64,
            replacement: &Self,
        ) -> Result<bool, String> {
            if self.role != replacement.role {
                return Err(format!(
                    "cannot replace {:?} D3D11 ticket source with {:?}",
                    self.role, replacement.role
                ));
            }
            let replacement = replacement.current();
            let replacement_generation = replacement.generation();
            if replacement_generation != expected_generation.saturating_add(1) {
                return Err(format!(
                    "D3D11 ticket source recovery expected generation {}, received {replacement_generation}",
                    expected_generation.saturating_add(1)
                ));
            }
            let current = self
                .slot
                .current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current_generation = current
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .generation;
            if current_generation != expected_generation {
                return Ok(false);
            }
            if current.recovery_count != 0 {
                return Err(format!(
                    "{:?} D3D11 ticket source already consumed its one recovery",
                    self.role
                ));
            }
            Ok(true)
        }

        pub(crate) fn wait_for_generation_change(
            &self,
            observed_generation: u64,
            timeout: Duration,
        ) -> Option<WindowsD3d11EncoderTicketSourceSnapshot> {
            let current = self
                .slot
                .current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (current, _) = self
                .slot
                .changed
                .wait_timeout_while(current, timeout, |current| {
                    current
                        .snapshot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .generation
                        == observed_generation
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let generation = current
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .generation;
            (generation != observed_generation).then(|| WindowsD3d11EncoderTicketSourceSnapshot {
                client: current.client.clone(),
                frame_store: Arc::clone(&current.frame_store),
                role: self.role,
                snapshot: Arc::clone(&current.snapshot),
                recovery_count: current.recovery_count,
            })
        }

        pub(crate) fn latest_ticket(
            &self,
        ) -> Option<(u64, Instant, WindowsD3d11TextureLeaseTicket)> {
            self.current().latest_ticket()
        }

        pub(crate) fn terminal_error(&self) -> Option<String> {
            self.current().terminal_error()
        }
    }

    impl WindowsD3d11EncoderTicketSourceSnapshot {
        pub(crate) fn generation(&self) -> u64 {
            self.snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .generation
        }

        pub(crate) const fn recovery_count(&self) -> u8 {
            self.recovery_count
        }

        /// Newest primary-output sequence the pump has published to the frame
        /// store, or `None` before the first composition. The encoder drain
        /// uses this to wake as soon as a fresh frame exists instead of
        /// discovering it one clock period late.
        pub(crate) fn latest_published_sequence(&self) -> Option<u64> {
            self.snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .primary_sequence
        }

        pub(crate) fn latest_ticket(
            &self,
        ) -> Option<(u64, Instant, WindowsD3d11TextureLeaseTicket)> {
            let frame = self
                .frame_store
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .latest()?;
            if !matches!(frame.pixel_format, CompositorPixelFormat::D3d11Nv12 { .. }) {
                return None;
            }
            let ticket = frame.metadata.d3d11_texture_for_role(self.role)?;
            Some((frame.sequence, frame.captured_at, ticket))
        }

        /// The compositor pump is the producer authority for every ticket in
        /// this store. Once it fails no future sequence can arrive, so bridge
        /// writers must close their FIFO instead of polling the last frame
        /// forever and leaving FFmpeg blocked on an open input.
        pub(crate) fn terminal_error(&self) -> Option<String> {
            let snapshot = self
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            windows_d3d11_terminal_source_error(
                snapshot.terminal_error.as_deref(),
                snapshot.stopped,
            )
        }
    }

    impl std::fmt::Debug for WindowsD3d11SessionPump {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("WindowsD3d11SessionPump")
                .field("snapshot", &self.snapshot())
                .field("roles", &self.roles.len())
                .finish_non_exhaustive()
        }
    }

    impl WindowsD3d11SessionPump {
        pub(crate) fn start(
            coordinator: &WindowsD3d11MediaCoordinatorSlot,
            mut plan: WindowsD3d11SessionPlan,
            mut camera: Option<WindowsD3d11CameraInput>,
            overlays: WindowsD3d11OverlayInput,
            mut live_sources: WindowsLiveSources,
        ) -> Result<Self, String> {
            let resuming = live_sources.bootstrap.is_some();
            if let Some(current) = live_sources.bootstrap.as_ref() {
                plan.camera_required = current
                    .edit
                    .scenes()
                    .any(|scene| crate::live_layout::required_scene_sources(scene).camera);
                camera = current
                    .camera
                    .clone()
                    .map(|source| WindowsD3d11CameraInput {
                        source,
                        layout: current
                            .edit
                            .legs()
                            .next()
                            .expect("primary recovery scene")
                            .1
                            .clone(),
                    });
            }
            if !resuming && plan.camera_required != camera.is_some() {
                return Err(format!(
                    "D3D11 screen-camera plan/source mismatch: plan requires camera={}, source supplied={}",
                    plan.camera_required,
                    camera.is_some()
                ));
            }
            if plan.auxiliary.is_none()
                && (overlays.caption_on_auxiliary
                    || overlays.highlight_on_auxiliary
                    || overlays.buddy_on_auxiliary)
            {
                return Err(
                    "D3D11 overlay plan targets an auxiliary leg that this session did not create"
                        .to_string(),
                );
            }
            let pool = WindowsD3d11TexturePoolConfig::dimension_keyed(
                WindowsD3d11BgraTextureDescriptor::new(plan.source_width, plan.source_height)
                    .map_err(|error| error.to_string())?,
                super::WINDOWS_D3D11_RENDER_POOL_SLOTS,
                WindowsD3d11BgraTextureDescriptor::new(plan.primary.width, plan.primary.height)
                    .map_err(|error| error.to_string())?,
                3,
                WindowsD3d11Nv12TextureDescriptor::new(plan.primary.width, plan.primary.height)
                    .map_err(|error| error.to_string())?,
                super::WINDOWS_D3D11_RENDER_POOL_SLOTS,
                plan.auxiliary
                    .map(|auxiliary| {
                        Ok((
                            WindowsD3d11Nv12TextureDescriptor::new(
                                auxiliary.width,
                                auxiliary.height,
                            )?,
                            3,
                        ))
                    })
                    .transpose()
                    .map_err(|error: WindowsD3d11Error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let mut roles = Vec::with_capacity(plan.roles.len());
            for role in &plan.roles {
                roles.push(
                    acquire_windows_d3d11_media(coordinator, &plan.screen_id, *role, pool)
                        .map_err(|error| {
                            format!("could not acquire D3D11 {role:?} authority: {error}")
                        })?,
                );
            }
            let client = roles
                .first()
                .ok_or_else(|| "D3D11 session plan acquired no roles".to_string())?
                .client();
            let status = client.status().map_err(|error| error.to_string())?;
            let selection = WindowsDxgiOutputSelection::parse(&plan.screen_id)
                .map_err(|error| error.to_string())?;
            if status.generation == 0
                || status.adapter_luid != selection.adapter_luid
                || status.output_index != selection.output_index
                || !status.compositor_ready
            {
                return Err(format!(
                    "D3D11 media authority status did not confirm compositor/output ownership for {}",
                    plan.screen_id
                ));
            }
            live_sources.generation = status.generation;
            live_sources.authority = Some({
                let compositor = live_sources
                    .compositor
                    .try_lock()
                    .map_err(|_| "source output authority is busy")?;
                if resuming {
                    live_sources
                        .coordinator
                        .try_lock()
                        .map_err(|_| "source authority is busy")?
                        .running_snapshot(&live_sources.session_id)
                        .map_err(|error| error.message())?;
                }
                compositor.claim_native_source_output(&live_sources.session_id, status.generation)
            });
            let capture_plan = WindowsD3d11CapturePlan::resolve(
                &plan.screen_id,
                true,
                status.adapter_luid,
                status.generation,
                WindowsD3d11WgcCursorExclusionProbe::default(),
            )
            .map_err(|error| error.to_string())?;
            let authority_adapter_luid = status.adapter_luid.as_u64();
            let capture_adapter_luid = if resuming {
                // Recovery retains GPU/encoder affinity but never reopens the
                // startup display. Current committed BGRA/None supplies frames.
                authority_adapter_luid
            } else {
                client
                    .start_capture(capture_plan)
                    .map_err(|error| format!("could not start D3D11 capture: {error}"))?
                    .diagnostics
                    .adapter_luid
            };
            if capture_adapter_luid != authority_adapter_luid {
                let _ = client.stop_capture();
                return Err(format!(
                    "D3D11 capture adapter {capture_adapter_luid:016x} does not match authority adapter {authority_adapter_luid:016x}"
                ));
            }
            let primary_encoder = client
                .create_encoder(plan.primary_role, encoder_config(plan.primary), 2)
                .map_err(|error| {
                    format!(
                        "could not attach the {:?} Media Foundation surface encoder: {error}",
                        plan.primary_role
                    )
                })?;
            if primary_encoder.role != plan.primary_role
                || !primary_encoder.diagnostics.d3d11_aware
                || !primary_encoder.diagnostics.dxgi_manager_bound
                || primary_encoder.diagnostics.adapter_luid != authority_adapter_luid
            {
                let _ = client.shutdown_encoder(plan.primary_role, 2_000);
                let _ = client.stop_capture();
                return Err(format!(
                    "Media Foundation {:?} encoder did not confirm the D3D11/DXGI authority",
                    plan.primary_role
                ));
            }
            let primary_encoder_adapter_luid = primary_encoder.diagnostics.adapter_luid;
            let mut auxiliary_encoder_adapter_luid = None;
            if let Some(auxiliary) = plan.auxiliary {
                match client.create_encoder(
                    WindowsD3d11MediaRole::Stream,
                    encoder_config(auxiliary),
                    2,
                ) {
                    Ok(status)
                        if status.role == WindowsD3d11MediaRole::Stream
                            && status.diagnostics.d3d11_aware
                            && status.diagnostics.dxgi_manager_bound
                            && status.diagnostics.adapter_luid == authority_adapter_luid =>
                    {
                        auxiliary_encoder_adapter_luid = Some(status.diagnostics.adapter_luid);
                    }
                    Ok(_) => {
                        let _ = client.shutdown_encoder(WindowsD3d11MediaRole::Stream, 2_000);
                        let _ = client.shutdown_encoder(plan.primary_role, 2_000);
                        let _ = client.stop_capture();
                        return Err(
                            "Media Foundation stream encoder did not confirm the D3D11/DXGI authority"
                                .to_string(),
                        );
                    }
                    Err(error) => {
                        let _ = client.shutdown_encoder(plan.primary_role, 2_000);
                        let _ = client.stop_capture();
                        return Err(format!(
                            "could not attach the Stream Media Foundation surface encoder: {error}"
                        ));
                    }
                }
            }

            let stop = Arc::new(AtomicBool::new(false));
            let preview_store = new_frame_store();
            let primary_store = new_frame_store();
            let auxiliary_store = plan.auxiliary.map(|_| new_frame_store());
            let snapshot = Arc::new(StdMutex::new(WindowsD3d11SessionPumpSnapshot {
                generation: status.generation,
                authority_adapter_luid,
                capture_adapter_luid,
                compositor_adapter_luid: selection.adapter_luid.as_u64(),
                primary_encoder_adapter_luid,
                auxiliary_encoder_adapter_luid,
                capture_route_bgra: resuming,
                ..Default::default()
            }));
            let preview_generation = Arc::new(AtomicU64::new(0));
            let (startup_tx, startup_rx) = mpsc::sync_channel(1);
            let worker = {
                let stop = Arc::clone(&stop);
                let preview_store = Arc::clone(&preview_store);
                let primary_store = Arc::clone(&primary_store);
                let auxiliary_store = auxiliary_store.clone();
                let worker_snapshot = Arc::clone(&snapshot);
                let panic_snapshot = Arc::clone(&snapshot);
                let panic_client = client.clone();
                let preview_generation = Arc::clone(&preview_generation);
                let worker_plan = plan.clone();
                thread::Builder::new()
                    .name("videorc-windows-d3d11-session".to_string())
                    .spawn(move || {
                        let result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                                run_pump(
                                    client,
                                    worker_plan,
                                    stop,
                                    preview_store,
                                    primary_store,
                                    auxiliary_store,
                                    worker_snapshot,
                                    startup_tx,
                                    camera,
                                    overlays,
                                    preview_generation,
                                    live_sources,
                                );
                            }));
                        if result.is_err() {
                            update_snapshot(&panic_snapshot, |current| {
                                current.terminal_error.get_or_insert_with(|| {
                                    "D3D11 session pump panicked".to_string()
                                });
                                current.stopped = true;
                            });
                            let _ = panic_client.stop_capture();
                        }
                    })
                    .map_err(|error| {
                        format!("could not start D3D11 session pump thread: {error}")
                    })?
            };
            match startup_rx.recv_timeout(STARTUP_TIMEOUT) {
                Ok(Ok(evidence)) => Ok(Self {
                    stop,
                    worker: Some(worker),
                    client: roles
                        .first()
                        .expect("D3D11 roles were validated before worker startup")
                        .client(),
                    preview_store,
                    primary_store,
                    auxiliary_store,
                    snapshot,
                    preview_generation,
                    roles,
                    primary_role: plan.primary_role,
                    startup_evidence: evidence,
                }),
                Ok(Err(error)) => {
                    stop.store(true, Ordering::Relaxed);
                    let _ = worker.join();
                    Err(error)
                }
                Err(_) => {
                    stop.store(true, Ordering::Relaxed);
                    let _ = worker.join();
                    Err(format!(
                        "D3D11 session did not publish its first preview/encoder surfaces within {}ms",
                        STARTUP_TIMEOUT.as_millis()
                    ))
                }
            }
        }

        pub(crate) fn preview_store(&self) -> CompositorFrameStore {
            Arc::clone(&self.preview_store)
        }

        pub(crate) fn primary_store(&self) -> CompositorFrameStore {
            Arc::clone(&self.primary_store)
        }

        pub(crate) fn auxiliary_store(&self) -> Option<CompositorFrameStore> {
            self.auxiliary_store.clone()
        }

        pub(crate) fn primary_encoder_source(&self) -> WindowsD3d11EncoderTicketSource {
            WindowsD3d11EncoderTicketSource::new(
                self.client.clone(),
                self.primary_store(),
                self.primary_role,
                Arc::clone(&self.snapshot),
            )
        }

        pub(crate) fn auxiliary_encoder_source(&self) -> Option<WindowsD3d11EncoderTicketSource> {
            Some(WindowsD3d11EncoderTicketSource::new(
                self.client.clone(),
                self.auxiliary_store()?,
                WindowsD3d11MediaRole::Stream,
                Arc::clone(&self.snapshot),
            ))
        }

        pub(crate) const fn startup_evidence(&self) -> WindowsD3d11StartupEvidence {
            self.startup_evidence
        }

        pub(crate) fn destroy_preview(&self) -> Result<bool, WindowsD3d11Error> {
            let destroyed = self.client.destroy_preview()?;
            self.preview_generation.store(0, Ordering::Release);
            Ok(destroyed)
        }

        pub(crate) fn monitor(&self) -> WindowsD3d11SessionMonitor {
            WindowsD3d11SessionMonitor {
                client: self.client.clone(),
                snapshot: Arc::clone(&self.snapshot),
                preview_generation: Arc::clone(&self.preview_generation),
            }
        }

        pub(crate) fn snapshot(&self) -> WindowsD3d11SessionPumpSnapshot {
            self.snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        pub(crate) fn stop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            let _ = self.destroy_preview();
            let roles = self
                .roles
                .iter()
                .map(WindowsD3d11MediaRoleHandle::role)
                .collect::<BTreeSet<_>>();
            if roles.contains(&WindowsD3d11MediaRole::Stream) {
                let _ = self
                    .client
                    .shutdown_encoder(WindowsD3d11MediaRole::Stream, 2_000);
            }
            if roles.contains(&WindowsD3d11MediaRole::Record) {
                let _ = self
                    .client
                    .shutdown_encoder(WindowsD3d11MediaRole::Record, 2_000);
            }
        }
    }

    impl Drop for WindowsD3d11SessionPump {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn new_frame_store() -> CompositorFrameStore {
        Arc::new(StdMutex::new(FrameStore::new(0)))
    }

    fn encoder_config(plan: super::WindowsD3d11VideoPlan) -> MediaFoundationEncoderConfig {
        MediaFoundationEncoderConfig {
            width: plan.width,
            height: plan.height,
            fps: plan.fps,
            bitrate_kbps: plan.bitrate_kbps,
            low_latency: true,
            input_topology:
                crate::windows_d3d11_encoder_contract::MediaFoundationInputTopology::Auto,
        }
    }

    fn latest_camera_frame(
        camera: Option<&WindowsD3d11CameraInput>,
        last_frame: &mut Option<FrameHandle<PreviewCameraPixelFormat>>,
    ) -> Option<FrameHandle<PreviewCameraPixelFormat>> {
        let camera = camera?;
        if let Ok(Some((frame, _))) = camera.source.try_latest_frame_result() {
            *last_frame = Some(frame);
        }
        last_frame.clone().filter(|frame| {
            frame.captured_at.elapsed() <= Duration::from_millis(1500)
                && frame.bytes.len() == frame.width as usize * frame.height as usize * 4
        })
    }

    /// A published capture or camera frame, shared as the bytes of its BGRA
    /// upload (plan 191). The pump used to clone each new frame into a fresh
    /// `Vec` (8.3 MB at 1080p, 3.7 MB for a 720p camera) on the thread that
    /// must hit its frame interval. `FrameHandle` bytes are immutable, and the
    /// frame store returns a buffer to its pool only after the last handle
    /// drops, so the upload reads the same pixels without the copy.
    struct FrameUploadBytes<P>(FrameHandle<P>);

    impl<P> AsRef<[u8]> for FrameUploadBytes<P> {
        fn as_ref(&self) -> &[u8] {
            &self.0.bytes
        }
    }

    fn frame_upload_pixels<P: 'static>(frame: &FrameHandle<P>) -> WindowsD3d11UploadPixels
    where
        FrameHandle<P>: Send + Sync,
    {
        WindowsD3d11UploadPixels::shared(FrameUploadBytes(frame.clone()))
    }

    /// Plan 205 S8: the captions' layers this tick. Their program is "burned
    /// on any running leg" (plan 090, one shared encode), so the Preview
    /// draws them from whichever leg burns them; a buffer-only session has
    /// no captions.
    fn caption_targets(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
    ) -> super::WindowsD3d11ItemTargets {
        let on_auxiliary = plan.auxiliary.is_some() && input.caption_on_auxiliary;
        super::windows_d3d11_item_targets(
            input.caption_on_primary,
            on_auxiliary,
            input.caption_on_primary || on_auxiliary,
        )
    }

    /// Plan 205 S8: the highlight card's layers this tick.
    fn highlight_targets(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
    ) -> super::WindowsD3d11ItemTargets {
        super::windows_d3d11_item_targets(
            input.highlight_on_primary,
            plan.auxiliary.is_some() && input.highlight_on_auxiliary,
            input.highlight_in_program,
        )
    }

    /// Plan 205 S8: the Buddy's layers (pet and bubble) this tick.
    fn buddy_targets(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
    ) -> super::WindowsD3d11ItemTargets {
        super::windows_d3d11_item_targets(
            input.buddy_on_primary,
            plan.auxiliary.is_some() && input.buddy_on_auxiliary,
            input.buddy_in_program,
        )
    }

    /// The Buddy on each leg for this tick (plan 168 S-B4): the pet's draw
    /// and the bubble's anchor, from the sprite slot, with the gaze targets
    /// Phase C reads (the card's and the caption bar's blits on the leg).
    /// `now_seconds` is the pump's deterministic clock. The primary leg's
    /// frame is also the Preview's when only the program carries the Buddy
    /// (plan 205 S8): the Preview is composed on the primary's canvas.
    fn current_buddy_legs(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
        now_seconds: f64,
    ) -> [Option<crate::buddy_sprite::BuddyLegFrame>; 2] {
        use crate::buddy_sprite::{BuddyLegRequest, BuddySpriteLeg};
        let targets = buddy_targets(plan, input);
        if targets.primary_canvas.is_none() && targets.auxiliary_canvas.is_none() {
            return [None, None];
        }
        let caption_on = caption_targets(plan, input);
        let highlight_on = highlight_targets(plan, input);
        let captions = current_caption_overlays(&input.captions);
        let highlight = current_caption_overlay(&input.highlight);
        let blit = |overlay: &CaptionOverlay, (width, height): (u32, u32), inset: usize| {
            let (_, left, top, draw_width) = crate::overlay_layout::overlay_blit_layout(
                overlay.width as usize,
                overlay.height as usize,
                width.max(1) as usize,
                height.max(1) as usize,
                overlay.blit_rect(width, height),
                inset,
            );
            [
                left as f32,
                top as f32,
                draw_width as f32,
                overlay.height.min(height.max(1)) as f32,
            ]
        };
        let leg = |leg: BuddySpriteLeg,
                   canvas: (u32, u32),
                   caption: Option<&CaptionOverlay>,
                   card: Option<&CaptionOverlay>| {
            input.buddy_sprite.leg_frame(BuddyLegRequest {
                leg,
                canvas,
                now_seconds,
                highlight_rect: card.map(|card| blit(card, canvas, 0)),
                caption_rect: caption.map(|caption| {
                    blit(
                        caption,
                        canvas,
                        caption_overlay_safe_inset(Some(caption), card, canvas.0, canvas.1),
                    )
                }),
            })
        };
        let primary = targets.primary_canvas.map(|_| {
            leg(
                BuddySpriteLeg::Primary,
                (plan.primary.width, plan.primary.height),
                captions
                    .primary
                    .as_ref()
                    .filter(|_| caption_on.primary_canvas.is_some()),
                highlight
                    .as_ref()
                    .filter(|_| highlight_on.primary_canvas.is_some()),
            )
        });
        let auxiliary = plan
            .auxiliary
            .filter(|_| targets.auxiliary_canvas.is_some())
            .map(|video| {
                leg(
                    BuddySpriteLeg::Auxiliary,
                    (video.width, video.height),
                    captions
                        .auxiliary
                        .as_ref()
                        .filter(|_| caption_on.auxiliary_canvas.is_some()),
                    highlight
                        .as_ref()
                        .filter(|_| highlight_on.auxiliary_canvas.is_some()),
                )
            });
        [primary, auxiliary]
    }

    /// The pet's layer per leg that has an atlas this tick, on the targets
    /// `buddy_targets` gives each leg (plan 205 S8).
    fn buddy_sprite_frames(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
        buddy_legs: &[Option<crate::buddy_sprite::BuddyLegFrame>; 2],
    ) -> Result<Vec<WindowsD3d11SpriteFrame>, String> {
        let targets = buddy_targets(plan, input);
        let primary_dimensions =
            WindowsD3d11OutputDimensions::new(plan.primary.width, plan.primary.height)
                .map_err(|error| error.to_string())?;
        let mut frames = Vec::with_capacity(2);
        if let (Some(sprite), Some(output_targets)) = (
            buddy_legs[0].as_ref().and_then(|leg| leg.sprite.clone()),
            targets.primary_canvas,
        ) {
            frames.push(WindowsD3d11SpriteFrame {
                source_id: BUDDY_SPRITE_PRIMARY_SOURCE_ID,
                layer: sprite,
                output_targets,
                output_dimensions: primary_dimensions,
                z_index: BUDDY_SPRITE_Z_INDEX,
            });
        }
        if let (Some(sprite), Some(video), Some(output_targets)) = (
            buddy_legs[1].as_ref().and_then(|leg| leg.sprite.clone()),
            plan.auxiliary,
            targets.auxiliary_canvas,
        ) {
            frames.push(WindowsD3d11SpriteFrame {
                source_id: BUDDY_SPRITE_AUXILIARY_SOURCE_ID,
                layer: sprite,
                output_targets,
                output_dimensions: WindowsD3d11OutputDimensions::new(video.width, video.height)
                    .map_err(|error| error.to_string())?,
                z_index: BUDDY_SPRITE_Z_INDEX,
            });
        }
        Ok(frames)
    }

    /// The banners each leg carries this tick (plan 186 S4), bottom to top:
    /// the same `banner_draws_for_leg` the Metal and CPU paths draw (leg
    /// plan, fade, prepared bitmap). Each encoded leg's list is its own plan;
    /// the Preview draws the program's banners once each (plan 205 S8,
    /// `windows_d3d11_item_targets`), plus, for a buffer-only session, the
    /// banners the ring skips, from the idle plan on the primary's canvas.
    /// No draft: drafts only exist while idle.
    fn current_banner_frames(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
        set: &crate::banners::BannerSet,
        now: Instant,
    ) -> Result<Vec<WindowsD3d11BannerFrame>, String> {
        use crate::banners::BannerLeg;
        use crate::compositor::banner_draws_for_leg;
        if set.layers.is_empty() {
            return Ok(Vec::new());
        }
        let primary_canvas = (plan.primary.width, plan.primary.height);
        let primary_dimensions =
            WindowsD3d11OutputDimensions::new(primary_canvas.0, primary_canvas.1)
                .map_err(|error| error.to_string())?;
        let shape = Some(input.banner_shape);
        let primary_draws = banner_draws_for_leg(
            set,
            shape,
            BannerLeg::Primary,
            primary_canvas,
            now,
            None,
            &input.banner_prepare,
        );
        let auxiliary_draws = match plan.auxiliary {
            Some(video) => {
                let canvas = (video.width, video.height);
                Some((
                    WindowsD3d11OutputDimensions::new(canvas.0, canvas.1)
                        .map_err(|error| error.to_string())?,
                    banner_draws_for_leg(
                        set,
                        shape,
                        BannerLeg::Auxiliary,
                        canvas,
                        now,
                        None,
                        &input.banner_prepare,
                    ),
                ))
            }
            None => None,
        };
        let primary_slots: Vec<u64> = primary_draws.iter().map(|draw| draw.slot).collect();
        let auxiliary_slots: Vec<u64> = auxiliary_draws
            .iter()
            .flat_map(|(_, draws)| draws.iter().map(|draw| draw.slot))
            .collect();
        // Plan 205 S8 (D2): a buffer-only session's ring keeps `banner_shape`'s
        // plan (the recording's) while its Preview shows the idle program,
        // every shown banner with either switch on, in Scene order. The ring's
        // list is a sub-sequence of that program (same bitmaps, same fades);
        // the banners it skips become Preview-only layers, and every layer at
        // this canvas takes its z from its place in the program, so the
        // Preview stacks the program's way while the ring's own order is
        // unchanged. In every other shape the program at this canvas is the
        // primary leg's own list, and nothing here changes.
        let program_only_draws = match input.program_shape {
            Some(_) => Vec::new(),
            None => banner_draws_for_leg(
                set,
                None,
                BannerLeg::Primary,
                primary_canvas,
                now,
                None,
                &input.banner_prepare,
            ),
        };
        let program_index_of = |slot: u64, ring_index: usize| {
            if program_only_draws.is_empty() {
                ring_index
            } else {
                program_only_draws
                    .iter()
                    .position(|draw| draw.slot == slot)
                    .unwrap_or(ring_index)
            }
        };
        let mut frames = Vec::new();
        for (index, draw) in primary_draws
            .into_iter()
            .take(BANNER_LAYERS_PER_LEG)
            .enumerate()
        {
            let output_targets =
                super::windows_d3d11_item_targets(true, auxiliary_slots.contains(&draw.slot), true)
                    .primary_canvas
                    .ok_or_else(|| "the primary leg's own banner lost its layer".to_string())?;
            let z_index = super::windows_d3d11_banner_z_index(program_index_of(draw.slot, index));
            frames.push(WindowsD3d11BannerFrame {
                source_id: BANNER_PRIMARY_SOURCE_ID_BASE + index as u64,
                draw,
                output_targets,
                output_dimensions: primary_dimensions,
                z_index,
            });
        }
        let preview_only = program_only_draws
            .into_iter()
            .enumerate()
            .filter(|(_, draw)| !primary_slots.contains(&draw.slot))
            .take(BANNER_LAYERS_PER_LEG)
            .enumerate();
        for (index, (program_index, draw)) in preview_only {
            let output_targets = super::windows_d3d11_item_targets(false, false, true)
                .primary_canvas
                .ok_or_else(|| "a program-only banner lost its Preview layer".to_string())?;
            frames.push(WindowsD3d11BannerFrame {
                source_id: BANNER_PREVIEW_SOURCE_ID_BASE + index as u64,
                draw,
                output_targets,
                output_dimensions: primary_dimensions,
                z_index: super::windows_d3d11_banner_z_index(program_index),
            });
        }
        if let Some((output_dimensions, draws)) = auxiliary_draws {
            for (index, draw) in draws.into_iter().take(BANNER_LAYERS_PER_LEG).enumerate() {
                let output_targets = super::windows_d3d11_item_targets(
                    primary_slots.contains(&draw.slot),
                    true,
                    true,
                )
                .auxiliary_canvas
                .ok_or_else(|| "the auxiliary leg's own banner lost its layer".to_string())?;
                frames.push(WindowsD3d11BannerFrame {
                    source_id: BANNER_AUXILIARY_SOURCE_ID_BASE + index as u64,
                    draw,
                    output_targets,
                    output_dimensions,
                    z_index: super::windows_d3d11_banner_z_index(index),
                });
            }
        }
        Ok(frames)
    }

    /// The captions, the Buddy's bubble and the highlight card per leg this
    /// tick, each on the targets `windows_d3d11_item_targets` gives it (plan
    /// 205 S8): the encoded legs keep their own plans, the Preview draws the
    /// program's items once each, the primary-canvas layer first.
    fn current_overlay_frames(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
        buddy_legs: &[Option<crate::buddy_sprite::BuddyLegFrame>; 2],
    ) -> Result<Vec<WindowsD3d11OverlayFrame>, String> {
        let captions = current_caption_overlays(&input.captions);
        let highlight = current_caption_overlay(&input.highlight);
        let buddy = current_caption_overlays(&input.buddy);
        let caption_on = caption_targets(plan, input);
        let highlight_on = highlight_targets(plan, input);
        let buddy_on = buddy_targets(plan, input);
        let primary_dimensions =
            WindowsD3d11OutputDimensions::new(plan.primary.width, plan.primary.height)
                .map_err(|error| error.to_string())?;
        let auxiliary_dimensions = plan
            .auxiliary
            .map(|video| WindowsD3d11OutputDimensions::new(video.width, video.height))
            .transpose()
            .map_err(|error| error.to_string())?;
        let mut frames = Vec::with_capacity(6);

        if let (Some(output_targets), Some(caption)) = (caption_on.primary_canvas, captions.primary)
        {
            let safe_inset = caption_overlay_safe_inset(
                Some(&caption),
                highlight_on.primary_canvas.and(highlight.as_ref()),
                primary_dimensions.width,
                primary_dimensions.height,
            );
            frames.push(WindowsD3d11OverlayFrame {
                source_id: CAPTION_PRIMARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CaptionOverlay,
                overlay: caption,
                output_targets,
                output_dimensions: primary_dimensions,
                safe_inset,
                z_index: CAPTION_Z_INDEX,
                bubble_anchor: None,
            });
        }
        if let (Some(output_targets), Some(caption), Some(output_dimensions)) = (
            caption_on.auxiliary_canvas,
            captions.auxiliary,
            auxiliary_dimensions,
        ) {
            let safe_inset = caption_overlay_safe_inset(
                Some(&caption),
                highlight_on.auxiliary_canvas.and(highlight.as_ref()),
                output_dimensions.width,
                output_dimensions.height,
            );
            frames.push(WindowsD3d11OverlayFrame {
                source_id: CAPTION_AUXILIARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CaptionOverlay,
                overlay: caption,
                output_targets,
                output_dimensions,
                safe_inset,
                z_index: CAPTION_Z_INDEX,
                bubble_anchor: None,
            });
        }
        if let (Some(output_targets), Some(overlay)) = (buddy_on.primary_canvas, buddy.primary) {
            frames.push(WindowsD3d11OverlayFrame {
                source_id: BUDDY_PRIMARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::BuddyOverlay,
                overlay,
                output_targets,
                output_dimensions: primary_dimensions,
                safe_inset: 0,
                z_index: BUDDY_Z_INDEX,
                bubble_anchor: buddy_legs[0].as_ref().map(|leg| leg.bubble_anchor),
            });
        }
        if let (Some(output_targets), Some(overlay), Some(output_dimensions)) = (
            buddy_on.auxiliary_canvas,
            buddy.auxiliary,
            auxiliary_dimensions,
        ) {
            frames.push(WindowsD3d11OverlayFrame {
                source_id: BUDDY_AUXILIARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::BuddyOverlay,
                overlay,
                output_targets,
                output_dimensions,
                safe_inset: 0,
                z_index: BUDDY_Z_INDEX,
                bubble_anchor: buddy_legs[1].as_ref().map(|leg| leg.bubble_anchor),
            });
        }
        if let (Some(output_targets), Some(overlay)) =
            (highlight_on.primary_canvas, highlight.clone())
        {
            frames.push(WindowsD3d11OverlayFrame {
                source_id: HIGHLIGHT_PRIMARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CommentHighlight,
                overlay,
                output_targets,
                output_dimensions: primary_dimensions,
                safe_inset: 0,
                z_index: HIGHLIGHT_Z_INDEX,
                bubble_anchor: None,
            });
        }
        if let (Some(output_targets), Some(overlay), Some(output_dimensions)) = (
            highlight_on.auxiliary_canvas,
            highlight,
            auxiliary_dimensions,
        ) {
            frames.push(WindowsD3d11OverlayFrame {
                source_id: HIGHLIGHT_AUXILIARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CommentHighlight,
                overlay,
                output_targets,
                output_dimensions,
                safe_inset: 0,
                z_index: HIGHLIGHT_Z_INDEX,
                bubble_anchor: None,
            });
        }
        Ok(frames)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_pump(
        client: WindowsD3d11MediaClient,
        plan: WindowsD3d11SessionPlan,
        stop: Arc<AtomicBool>,
        preview_store: CompositorFrameStore,
        primary_store: CompositorFrameStore,
        auxiliary_store: Option<CompositorFrameStore>,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        startup_tx: mpsc::SyncSender<Result<WindowsD3d11StartupEvidence, String>>,
        camera: Option<WindowsD3d11CameraInput>,
        overlays: WindowsD3d11OverlayInput,
        preview_generation: Arc<AtomicU64>,
        mut live_sources: WindowsLiveSources,
    ) {
        let mut startup_tx = Some(startup_tx);
        let render_fps = plan
            .auxiliary
            .map(|auxiliary| auxiliary.fps)
            .unwrap_or_default()
            .max(plan.primary.fps)
            .max(1);
        let frame_interval = Duration::from_secs_f64(1.0 / f64::from(render_fps));
        let mut last_camera_frame: Option<FrameHandle<PreviewCameraPixelFormat>> = None;
        let mut last_camera_upload: Option<(u64, WindowsD3d11UploadPixels)> = None;
        let mut retained_capture_ticket: Option<WindowsD3d11TextureLeaseTicket> = None;
        let mut cfr = WindowsD3d11CfrSequencer::default();
        let mut pending_capture: Option<crate::windows_d3d11_device::WindowsD3d11CapturePoll> =
            None;
        let resuming = live_sources.bootstrap.is_some();
        let mut committed = live_sources.bootstrap.take();
        let mut camera = camera;
        let mut camera_identity = camera.as_ref().and_then(|input| {
            input
                .source
                .source_key()
                .cloned()
                .map(|key| (key, input.source.generation()))
        });
        let mut capture_identity = None;
        let mut native_binding = None;
        let mut native_capture = !resuming;
        let mut native_retire_required = false;
        let mut native_retirement = None;
        let mut capture_frame: Option<
            FrameHandle<crate::preview_screen::PreviewScreenPixelFormat>,
        > = None;
        // Plan 210 S7 (Hide screen): the native texture route only runs while
        // the screen is visible. Hidden, this loop composes from the gated
        // BGRA store, the one `screen.hide` covers synchronously; the capture
        // owner keeps running, nothing is retired, and the next native frame
        // after a show takes over again.
        let screen_privacy = Arc::clone(&live_sources.state.screen_privacy);
        let mut privacy_hidden = false;
        let mut privacy_resume_pending = false;
        let mut upload_revision = 0u64;
        let mut last_capture_upload: Option<(u64, WindowsD3d11UploadPixels, u64)> = None;
        let mut camera_upload_revision = 0u64;
        let mut previous_tick_started: Option<Instant> = None;
        // Due time of the coming tick; every pace below sleeps to the next one.
        let mut next_tick_due = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            let frame_started_at = Instant::now();
            next_tick_due = super::windows_d3d11_next_render_tick_due(
                next_tick_due,
                frame_started_at,
                frame_interval,
            );
            // Plan 190 S4: the live background's guard reads late ticks (a
            // gap of more than one and a half intervals).
            let live_missed_deadline =
                previous_tick_started
                    .replace(frame_started_at)
                    .is_some_and(|previous| {
                        frame_started_at.duration_since(previous) > frame_interval * 3 / 2
                    });
            let privacy_hidden_now = screen_privacy.view().hidden;
            if privacy_hidden_now != privacy_hidden {
                privacy_hidden = privacy_hidden_now;
                privacy_resume_pending = !privacy_hidden_now;
                retained_capture_ticket = None;
                pending_capture = None;
                if privacy_hidden_now {
                    // The BGRA frame in hand and its upload are live pixels
                    // from before the edge: drop them with the texture lease.
                    // The still replaces them below; until it is read, no
                    // screen is drawn at all.
                    capture_frame = None;
                    last_capture_upload = None;
                }
                cfr.replace_source();
            }
            let fresh_committed = live_sources.snapshot();
            if fresh_committed
                .as_ref()
                .is_some_and(|next| next.live_background_budget_notice)
            {
                live_sources.notify_live_background_budget();
            }
            if resuming && startup_tx.is_some() && fresh_committed.is_none() {
                // A recovery bootstrap is a source of dimensions/readiness, not
                // permission to publish an older binding through contention.
                record_render_tick_overrun(&snapshot, frame_started_at, frame_interval);
                pace_render_tick(next_tick_due);
                continue;
            }
            if let Some(next) = fresh_committed {
                let next_camera = next.camera.as_ref().and_then(|source| {
                    source
                        .source_key()
                        .cloned()
                        .map(|key| (key, source.generation()))
                });
                if next_camera != camera_identity {
                    camera_identity = next_camera;
                    last_camera_frame = None;
                    last_camera_upload = None;
                }
                camera = next.camera.clone().map(|source| WindowsD3d11CameraInput {
                    source,
                    layout: next.edit.legs().next().expect("primary scene").1.clone(),
                });
                let next_capture = next.capture.as_ref().and_then(|source| {
                    source
                        .source_key()
                        .cloned()
                        .map(|key| (key, source.generation()))
                });
                let requested_capture = next
                    .confirmed
                    .window_id
                    .as_ref()
                    .or(next.confirmed.screen_id.as_ref());
                if native_capture
                    && (requested_capture.map(String::as_str) != Some(plan.screen_id.as_str())
                        || next_capture
                            .as_ref()
                            .zip(native_binding.as_ref())
                            .is_some_and(|(next, previous)| next != previous))
                {
                    native_capture = false;
                    update_snapshot(&snapshot, |current| current.capture_route_bgra = true);
                    native_retire_required = true;
                    pending_capture = None;
                    retained_capture_ticket = None;
                    cfr.replace_source();
                }
                if native_capture && native_binding.is_none() {
                    native_binding = next_capture.clone();
                }
                if !native_capture && next_capture != capture_identity {
                    capture_frame = None;
                    last_capture_upload = None;
                    cfr.replace_source();
                }
                capture_identity = next_capture;
                update_snapshot(&snapshot, |current| {
                    current.source_revision = next.source_revision
                });
                committed = Some(next);
            }
            if native_retire_required && native_retirement.is_none() {
                match client.begin_stop_capture() {
                    Ok(receipt) => {
                        native_retirement = Some(receipt);
                        native_retire_required = false;
                        update_snapshot(&snapshot, |current| {
                            current.capture_cleanup_pending = true
                        });
                    }
                    Err(error) if is_transient_pressure(&error) => {}
                    Err(error) => {
                        finish_with_error(&snapshot, &mut startup_tx, error.to_string());
                        break;
                    }
                }
            }
            if let Some(receipt) = native_retirement.as_ref() {
                match receipt.try_recv() {
                    Ok(Ok(_)) => {
                        native_retirement = None;
                        update_snapshot(&snapshot, |current| {
                            current.capture_cleanup_pending = false
                        });
                    }
                    Ok(Err(error)) => {
                        native_retirement = None;
                        update_snapshot(&snapshot, |current| {
                            current.capture_source_error =
                                Some(format!("Previous capture cleanup: {error}"))
                        });
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(mpsc::TryRecvError::Disconnected) => {
                        finish_with_error(
                            &snapshot,
                            &mut startup_tx,
                            "Capture owner retirement lost its completion receipt".into(),
                        );
                        break;
                    }
                }
            }
            let mut new_capture_sequence = None;
            if native_capture && !privacy_hidden && pending_capture.is_none() {
                match client.begin_capture_poll(
                    super::WINDOWS_D3D11_CAPTURE_POLL_WAIT_MS,
                    vec![WindowsD3d11MediaRole::Compositor],
                ) {
                    Ok(pending) => pending_capture = Some(pending),
                    Err(error) if is_transient_pressure(&error) => {
                        update_snapshot(&snapshot, |current| {
                            current.pressure_skips = current.pressure_skips.saturating_add(1)
                        });
                    }
                    Err(error) => {
                        finish_with_error(&snapshot, &mut startup_tx, error.to_string());
                        break;
                    }
                }
            }
            let acquired = pending_capture.as_mut().and_then(|pending| pending.poll());
            if acquired.is_some() {
                pending_capture = None;
            }
            match acquired.unwrap_or(Ok(None)) {
                Ok(Some(capture)) if privacy_hidden => {
                    // Hidden between the poll and its answer: the lease is
                    // released unadopted. The still comes from the BGRA store.
                    drop(capture);
                }
                Ok(Some(capture)) => {
                    let sequence = capture.metadata.sequence;
                    let source_ticket = match ticket_for_role(
                        capture.texture,
                        WindowsD3d11MediaRole::Compositor,
                        WindowsD3d11ComposedTextureKind::CapturedBgra,
                        WindowsD3d11TextureFormat::Bgra8Unorm,
                    ) {
                        Ok(ticket) => ticket,
                        Err(error) => {
                            finish_with_error(&snapshot, &mut startup_tx, error);
                            break;
                        }
                    };
                    retained_capture_ticket = Some(source_ticket);
                    new_capture_sequence = Some(sequence);
                    if privacy_resume_pending {
                        // The first native frame after a show: the BGRA
                        // stand-in is done.
                        privacy_resume_pending = false;
                        capture_frame = None;
                        last_capture_upload = None;
                    }
                    update_snapshot(&snapshot, |current| {
                        current.captured_frames = current.captured_frames.saturating_add(1);
                        current.latest_capture_sequence = Some(sequence);
                    });
                }
                Ok(None) => {}
                Err(error) if is_transient_pressure(&error) => {
                    update_snapshot(&snapshot, |current| {
                        current.pressure_skips = current.pressure_skips.saturating_add(1);
                    });
                }
                Err(error)
                    if error.code == WindowsD3d11ErrorCode::CaptureUnavailable
                        && startup_tx.is_none() =>
                {
                    native_capture = false;
                    update_snapshot(&snapshot, |current| current.capture_route_bgra = true);
                    native_retire_required = true;
                    retained_capture_ticket = None;
                    cfr.replace_source();
                    update_snapshot(&snapshot, |current| {
                        current.capture_source_error = Some(error.to_string())
                    });
                }
                Err(error) => {
                    attribute_adapter_mismatch(&snapshot, &error);
                    attribute_device_loss(&snapshot, &error);
                    finish_with_error(
                        &snapshot,
                        &mut startup_tx,
                        format!("D3D11 capture stopped: {error}"),
                    );
                    break;
                }
            }
            if !native_capture || privacy_hidden || privacy_resume_pending {
                if let Some(source) = committed
                    .as_ref()
                    .and_then(|current| current.capture.as_ref())
                {
                    // Hidden, only the gate's still is taken from the store:
                    // the gate closes before `screen.hide` covers the store,
                    // so its newest frame can still be live for a tick.
                    let latest = if privacy_hidden {
                        source.try_latest_still_frame_result()
                    } else {
                        source.try_latest_frame_result()
                    };
                    if let Ok(Some(frame)) = latest
                        && frame.bytes.len() == frame.width as usize * frame.height as usize * 4
                        && capture_frame
                            .as_ref()
                            .is_none_or(|previous| previous.sequence != frame.sequence)
                    {
                        new_capture_sequence = Some(frame.sequence);
                        capture_frame = Some(frame);
                    }
                } else {
                    capture_frame = None;
                    last_capture_upload = None;
                }
            }
            if !resuming
                && startup_tx.is_some()
                && retained_capture_ticket.is_none()
                && capture_frame.is_none()
            {
                record_render_tick_overrun(&snapshot, frame_started_at, frame_interval);
                pace_render_tick(next_tick_due);
                continue;
            }
            let tick_result = if new_capture_sequence.is_none()
                && retained_capture_ticket.is_none()
                && capture_frame.is_none()
            {
                if resuming && cfr.output_sequence == 0 {
                    cfr.output_sequence = 1;
                    Ok(Some(WindowsD3d11CfrTick {
                        output_sequence: 1,
                        source_sequence: 0,
                        repeated_source: true,
                    }))
                } else {
                    cfr.advance_blank()
                }
            } else {
                cfr.advance(new_capture_sequence)
            };
            let tick = match tick_result {
                Ok(Some(tick)) => tick,
                Ok(None) => {
                    record_render_tick_overrun(&snapshot, frame_started_at, frame_interval);
                    pace_render_tick(next_tick_due);
                    continue;
                }
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            let camera_frame = latest_camera_frame(camera.as_ref(), &mut last_camera_frame);
            if !resuming && startup_tx.is_some() && plan.camera_required && camera_frame.is_none() {
                record_render_tick_overrun(&snapshot, frame_started_at, frame_interval);
                pace_render_tick(next_tick_due);
                continue;
            }
            // Plan 168 S-B4 / S-C4: the Buddy's pet per leg on the pump's
            // own deterministic clock; the animator steps once per tick.
            let buddy_legs = current_buddy_legs(
                &plan,
                &overlays,
                super::windows_d3d11_buddy_clock_seconds(tick.output_sequence, render_fps),
            );
            let overlay_frames = match current_overlay_frames(&plan, &overlays, &buddy_legs) {
                Ok(frames) => frames,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            let sprite_frames = match buddy_sprite_frames(&plan, &overlays, &buddy_legs) {
                Ok(frames) => frames,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            // Plan 186 S4: the banners each leg carries, from the committed
            // snapshot's set; fades read the wall clock like the compositor's.
            let banner_frames = match committed.as_ref() {
                Some(committed) => {
                    match current_banner_frames(
                        &plan,
                        &overlays,
                        &committed.banners,
                        Instant::now(),
                    ) {
                        Ok(frames) => frames,
                        Err(error) => {
                            finish_with_error(&snapshot, &mut startup_tx, error);
                            break;
                        }
                    }
                }
                None => Vec::new(),
            };
            let scene = match build_scene_plan(
                &plan,
                tick.output_sequence,
                live_sources.generation,
                camera_frame
                    .as_ref()
                    .map(|frame| (frame.width, frame.height)),
                camera.as_ref().map(|input| &input.layout),
                &overlay_frames,
                &sprite_frames,
                &banner_frames,
                committed.as_ref(),
                if retained_capture_ticket.is_some() {
                    Some((plan.source_width, plan.source_height))
                } else {
                    capture_frame
                        .as_ref()
                        .map(|frame| (frame.width, frame.height))
                },
            ) {
                Ok(scene) => scene,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            let mut sources = Vec::new();
            if let Some(ticket) = retained_capture_ticket.as_ref() {
                sources.push(WindowsD3d11CompositionSource::TextureLease {
                    source_id: CAPTURE_SOURCE_ID,
                    ticket: ticket.clone(),
                });
            }
            if let Some(frame) = capture_frame.as_ref() {
                let (pixels, revision) = match last_capture_upload.as_ref() {
                    Some((sequence, pixels, revision)) if *sequence == frame.sequence => {
                        (pixels.clone(), *revision)
                    }
                    _ => {
                        upload_revision += 1;
                        let pixels = frame_upload_pixels(frame);
                        last_capture_upload =
                            Some((frame.sequence, pixels.clone(), upload_revision));
                        update_snapshot(&snapshot, |current| current.capture_upload_frames += 1);
                        (pixels, upload_revision)
                    }
                };
                sources.push(WindowsD3d11CompositionSource::BgraUpload {
                    source_id: CAPTURE_SOURCE_ID,
                    pixels,
                    dimensions: WindowsD3d11OutputDimensions::new(frame.width, frame.height)
                        .expect("validated preview dimensions"),
                    row_pitch: frame.width * 4,
                    pixel_order: WindowsD3d11UploadPixelOrder::Bgra,
                    content_revision: revision,
                    immutable: true,
                });
            }
            if let Some(frame) = camera_frame.as_ref() {
                let pixels = match last_camera_upload.as_ref() {
                    Some((revision, pixels)) if *revision == frame.sequence => pixels.clone(),
                    _ => {
                        camera_upload_revision += 1;
                        let pixels = frame_upload_pixels(frame);
                        last_camera_upload = Some((frame.sequence, pixels.clone()));
                        pixels
                    }
                };
                let Some(row_pitch) = frame.width.checked_mul(4) else {
                    finish_with_error(
                        &snapshot,
                        &mut startup_tx,
                        format!(
                            "D3D11 camera frame {} has an overflowing row pitch",
                            frame.sequence
                        ),
                    );
                    break;
                };
                sources.push(WindowsD3d11CompositionSource::BgraUpload {
                    source_id: CAMERA_SOURCE_ID,
                    pixels,
                    dimensions: match WindowsD3d11OutputDimensions::new(frame.width, frame.height) {
                        Ok(dimensions) => dimensions,
                        Err(error) => {
                            finish_with_error(&snapshot, &mut startup_tx, error.to_string());
                            break;
                        }
                    },
                    row_pitch,
                    pixel_order: WindowsD3d11UploadPixelOrder::Bgra,
                    content_revision: camera_upload_revision,
                    // FrameHandle bytes are immutable. Repeated CFR ticks at a
                    // higher render cadence reuse the generation-scoped upload
                    // until the camera sequence advances.
                    immutable: true,
                });
            }
            if let Some(committed) = committed.as_ref() {
                for (source_id, image) in std::iter::once((20, committed.takeover.as_ref())).chain(
                    committed
                        .backgrounds
                        .iter()
                        .enumerate()
                        .map(|(index, image)| (30 + index as u64, image.as_ref())),
                ) {
                    // Plan 190 S4: the primary leg's live background renders
                    // on the media thread; its poster rides along for a still.
                    if source_id == 30
                        && let Some(input) = primary_live_background(committed)
                    {
                        let mut input = input.clone();
                        input.tick = crate::live_background::LiveBackgroundTick::new(
                            frame_started_at,
                            frame_interval,
                            live_missed_deadline,
                        );
                        sources.push(WindowsD3d11CompositionSource::LiveBackground {
                            source_id,
                            input: Box::new(input),
                            output: (plan.primary.width, plan.primary.height),
                            poster: image.cloned(),
                        });
                        continue;
                    }
                    if let Some(image) = image {
                        sources.push(WindowsD3d11CompositionSource::BgraUpload {
                            source_id,
                            pixels: image.pixels.clone().into(),
                            dimensions: WindowsD3d11OutputDimensions::new(
                                image.width,
                                image.height,
                            )
                            .expect("prepared image dimensions"),
                            row_pitch: image.width * 4,
                            pixel_order: WindowsD3d11UploadPixelOrder::Bgra,
                            content_revision: image.revision,
                            immutable: true,
                        });
                    }
                }
            }
            // The pet's atlas uploads once per revision (immutable, keyed
            // by source id and revision); then the bubbles and cards.
            let overlay_sources = banner_frames
                .iter()
                .map(banner_upload_source)
                .chain(sprite_frames.iter().map(sprite_upload_source))
                .chain(overlay_frames.iter().map(overlay_upload_source))
                .collect::<Result<Vec<_>, _>>();
            match overlay_sources {
                Ok(overlay_sources) => sources.extend(overlay_sources),
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            }
            let configured_preview_generation = preview_generation.load(Ordering::Acquire);
            let consumers = WindowsD3d11CompositionConsumers {
                preview: (configured_preview_generation != 0)
                    .then_some(WindowsD3d11MediaRole::Preview)
                    .into_iter()
                    .collect(),
                primary: vec![plan.primary_role],
                auxiliary: plan
                    .auxiliary
                    .map(|_| vec![WindowsD3d11MediaRole::Stream])
                    .unwrap_or_default(),
            };
            let compose_started_at = Instant::now();
            let composition = match client.compose_scene(scene, sources, consumers) {
                Ok(composition) => composition,
                Err(error) if is_transient_pressure(&error) => {
                    update_snapshot(&snapshot, |current| {
                        current.pressure_skips = current.pressure_skips.saturating_add(1);
                        current.render_compose_stage_max_us =
                            current.render_compose_stage_max_us.max(
                                u64::try_from(compose_started_at.elapsed().as_micros())
                                    .unwrap_or(u64::MAX),
                            );
                    });
                    record_render_tick_overrun(&snapshot, frame_started_at, frame_interval);
                    pace_render_tick(next_tick_due);
                    continue;
                }
                Err(error) => {
                    attribute_adapter_mismatch(&snapshot, &error);
                    attribute_device_loss(&snapshot, &error);
                    finish_with_error(
                        &snapshot,
                        &mut startup_tx,
                        format!("D3D11 composition stopped: {error}"),
                    );
                    break;
                }
            };
            let compose_stage_us =
                u64::try_from(compose_started_at.elapsed().as_micros()).unwrap_or(u64::MAX);
            if composition.diagnostics.production_readback_frames != 0 {
                finish_with_error(
                    &snapshot,
                    &mut startup_tx,
                    "D3D11 compositor reported a forbidden production GPU readback".to_string(),
                );
                break;
            }
            if !resuming
                && startup_tx.is_some()
                && plan.camera_required
                && composition.diagnostics.camera_upload_frames == 0
            {
                finish_with_error(
                    &snapshot,
                    &mut startup_tx,
                    "D3D11 screen-camera composition did not report its measured camera upload"
                        .to_string(),
                );
                break;
            }
            let camera_upload_frames = composition.diagnostics.camera_upload_frames;
            if configured_preview_generation != 0
                && let Some(ticket) = clone_ticket_for_role(
                    &composition.textures,
                    WindowsD3d11MediaRole::Preview,
                    WindowsD3d11ComposedTextureKind::PreviewBgra,
                    WindowsD3d11TextureFormat::Bgra8Unorm,
                )
            {
                let source_live = committed.as_ref().map_or_else(
                    || {
                        retained_capture_ticket.is_some()
                            && (!plan.camera_required || camera_frame.is_some())
                    },
                    |current| {
                        super::windows_scene_sources_live(
                            current.render_edit.scenes(),
                            camera_frame.is_some(),
                            retained_capture_ticket.is_some() || capture_frame.is_some(),
                            current
                                .takeover_active
                                .then_some(current.takeover.is_some()),
                        )
                    },
                );
                match client.offer_preview(ticket, configured_preview_generation, source_live) {
                    Ok(offer) => {
                        update_snapshot(&snapshot, |current| {
                            current.preview_offered_sequence = Some(offer.sequence);
                        });
                    }
                    Err(_) => {
                        update_snapshot(&snapshot, |current| {
                            current.preview_offer_failures =
                                current.preview_offer_failures.saturating_add(1);
                        });
                    }
                }
            }
            let publish_started_at = Instant::now();
            let published = publish_composition(
                composition.textures,
                plan.primary_role,
                &preview_store,
                &primary_store,
                auxiliary_store.as_ref(),
            );
            let publish_stage_us =
                u64::try_from(publish_started_at.elapsed().as_micros()).unwrap_or(u64::MAX);
            let (preview_sequence, primary_sequence, auxiliary_sequence) = match published {
                Ok(published) => published,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            if let Some(committed) = committed.as_ref() {
                live_sources.observe(
                    committed,
                    camera_frame.is_some(),
                    retained_capture_ticket.is_some() || capture_frame.is_some(),
                    plan.auxiliary.is_none() || auxiliary_sequence.is_some(),
                );
            }
            update_snapshot(&snapshot, |current| {
                current.composed_frames = current.composed_frames.saturating_add(1);
                if tick.repeated_source {
                    current.repeated_capture_frames =
                        current.repeated_capture_frames.saturating_add(1);
                }
                current.camera_upload_frames = camera_upload_frames;
                current.preview_sequence = preview_sequence;
                current.primary_sequence = Some(primary_sequence);
                current.auxiliary_sequence = auxiliary_sequence;
                current.render_ticks = current.render_ticks.saturating_add(1);
                current.render_compose_stage_max_us =
                    current.render_compose_stage_max_us.max(compose_stage_us);
                current.render_publish_stage_max_us =
                    current.render_publish_stage_max_us.max(publish_stage_us);
            });
            if let Some(sender) = startup_tx.take() {
                let _ = sender.send(Ok(WindowsD3d11StartupEvidence {
                    capture_started: !resuming,
                    resumed_committed_sources: resuming,
                    preview_ticket: preview_sequence.is_some(),
                    primary_ticket: true,
                    auxiliary_ticket: plan.auxiliary.is_none() || auxiliary_sequence.is_some(),
                    // The media-thread encoder attachment command augments
                    // these before the production claim gate is evaluated.
                    primary_encoder_attached: true,
                    auxiliary_encoder_attached: true,
                }));
            }
            record_render_tick_overrun(&snapshot, frame_started_at, frame_interval);
            pace_render_tick(next_tick_due);
        }
        let _ = client.stop_capture();
        update_snapshot(&snapshot, |current| current.stopped = true);
        if let Some(sender) = startup_tx {
            let _ = sender.send(Err(
                "D3D11 session pump stopped before first-frame readiness".to_string(),
            ));
        }
    }

    fn overlay_upload_source(
        frame: &WindowsD3d11OverlayFrame,
    ) -> Result<WindowsD3d11CompositionSource, String> {
        let row_pitch = frame.overlay.width.checked_mul(4).ok_or_else(|| {
            format!(
                "D3D11 overlay revision {} has an overflowing row pitch",
                frame.overlay.revision
            )
        })?;
        let dimensions =
            WindowsD3d11OutputDimensions::new(frame.overlay.width, frame.overlay.height)
                .map_err(|error| error.to_string())?;
        Ok(WindowsD3d11CompositionSource::BgraUpload {
            source_id: frame.source_id,
            pixels: Arc::clone(&frame.overlay.bgra).into(),
            dimensions,
            row_pitch,
            pixel_order: WindowsD3d11UploadPixelOrder::Bgra,
            content_revision: frame.overlay.revision,
            immutable: true,
        })
    }

    fn sprite_upload_source(
        frame: &WindowsD3d11SpriteFrame,
    ) -> Result<WindowsD3d11CompositionSource, String> {
        let atlas = &frame.layer.atlas;
        let row_pitch = atlas.width.checked_mul(4).ok_or_else(|| {
            format!(
                "D3D11 Buddy sprite revision {} has an overflowing row pitch",
                atlas.revision
            )
        })?;
        Ok(WindowsD3d11CompositionSource::BgraUpload {
            source_id: frame.source_id,
            pixels: Arc::clone(&atlas.bgra).into(),
            dimensions: WindowsD3d11OutputDimensions::new(atlas.width, atlas.height)
                .map_err(|error| error.to_string())?,
            row_pitch,
            pixel_order: WindowsD3d11UploadPixelOrder::Bgra,
            content_revision: atlas.revision,
            immutable: true,
        })
    }

    /// A banner's prepared bitmap (plan 186 S4): immutable, keyed by the
    /// prepare's revision, so it uploads once per prepare and never per tick.
    fn banner_upload_source(
        frame: &WindowsD3d11BannerFrame,
    ) -> Result<WindowsD3d11CompositionSource, String> {
        let bitmap = &frame.draw.bitmap;
        let row_pitch = bitmap.width.checked_mul(4).ok_or_else(|| {
            format!(
                "D3D11 banner revision {} has an overflowing row pitch",
                bitmap.revision
            )
        })?;
        Ok(WindowsD3d11CompositionSource::BgraUpload {
            source_id: frame.source_id,
            pixels: Arc::clone(&bitmap.bgra).into(),
            dimensions: WindowsD3d11OutputDimensions::new(bitmap.width, bitmap.height)
                .map_err(|error| error.to_string())?,
            row_pitch,
            pixel_order: WindowsD3d11UploadPixelOrder::Bgra,
            content_revision: bitmap.revision,
            immutable: true,
        })
    }

    fn pace_render_tick(due: Instant) {
        let remaining = due.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            thread::sleep(remaining);
        }
    }

    /// Overshoot of one render tick beyond its frame interval, in micros.
    pub(crate) fn tick_overrun_micros(total: Duration, interval: Duration) -> Option<u64> {
        total
            .checked_sub(interval)
            .filter(|overrun| !overrun.is_zero())
            .map(|overrun| u64::try_from(overrun.as_micros()).unwrap_or(u64::MAX))
    }

    fn record_render_tick_overrun(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        started_at: Instant,
        frame_interval: Duration,
    ) {
        let Some(overrun_us) = tick_overrun_micros(started_at.elapsed(), frame_interval) else {
            return;
        };
        update_snapshot(snapshot, |current| {
            current.render_tick_overruns = current.render_tick_overruns.saturating_add(1);
            current.render_tick_lag_max_us = current.render_tick_lag_max_us.max(overrun_us);
        });
    }

    fn is_transient_pressure(error: &WindowsD3d11Error) -> bool {
        matches!(
            error.code,
            WindowsD3d11ErrorCode::TexturePoolExhausted | WindowsD3d11ErrorCode::CommandQueueFull
        )
    }

    fn attribute_adapter_mismatch(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        error: &WindowsD3d11Error,
    ) {
        if error.code == WindowsD3d11ErrorCode::AdapterMismatch {
            update_snapshot(snapshot, |current| {
                current.adapter_mismatches = current.adapter_mismatches.saturating_add(1);
            });
        }
    }

    fn attribute_device_loss(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        error: &WindowsD3d11Error,
    ) {
        if error.code == WindowsD3d11ErrorCode::DeviceLost {
            update_snapshot(snapshot, |current| current.device_lost = true);
        }
    }

    fn finish_with_error(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        startup_tx: &mut Option<mpsc::SyncSender<Result<WindowsD3d11StartupEvidence, String>>>,
        error: String,
    ) {
        update_snapshot(snapshot, |current| {
            current.terminal_error.get_or_insert_with(|| error.clone());
        });
        if let Some(sender) = startup_tx.take() {
            let _ = sender.send(Err(error));
        }
    }

    fn update_snapshot(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        update: impl FnOnce(&mut WindowsD3d11SessionPumpSnapshot),
    ) {
        update(
            &mut snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
    }

    /// Plan 190 S4: the live background the primary leg draws this tick,
    /// when its scene shows one.
    fn primary_live_background(
        committed: &WindowsLiveSnapshot,
    ) -> Option<&crate::live_background::LiveBackgroundFrameInput> {
        let input = committed.live_background.as_ref()?;
        let (scene, _) = committed.render_edit.legs().next()?;
        scene.background.as_ref()?.live.as_ref()?;
        Some(input)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_scene_plan(
        plan: &WindowsD3d11SessionPlan,
        sequence: u64,
        generation: u64,
        camera_dimensions: Option<(u32, u32)>,
        camera_layout: Option<&LayoutSettings>,
        overlays: &[WindowsD3d11OverlayFrame],
        sprites: &[WindowsD3d11SpriteFrame],
        banners: &[WindowsD3d11BannerFrame],
        committed: Option<&WindowsLiveSnapshot>,
        capture_dimensions: Option<(u32, u32)>,
    ) -> Result<crate::windows_d3d11_compositor::WindowsD3d11ScenePlan, String> {
        let selection = WindowsDxgiOutputSelection::parse(&plan.screen_id)
            .map_err(|error| error.to_string())?;
        let dimensions = WindowsD3d11OutputDimensions::new(plan.primary.width, plan.primary.height)
            .map_err(|error| error.to_string())?;
        let mut encoded_outputs = vec![WindowsD3d11EncodedOutputPlan {
            role: WindowsD3d11EncodedOutputRole::Primary,
            dimensions,
        }];
        if let Some(auxiliary) = plan.auxiliary {
            encoded_outputs.push(WindowsD3d11EncodedOutputPlan {
                role: WindowsD3d11EncodedOutputRole::Auxiliary,
                dimensions: WindowsD3d11OutputDimensions::nv12(auxiliary.width, auxiliary.height)
                    .map_err(|error| error.to_string())?,
            });
        }
        let display_fit = camera_layout
            .map(|layout| scene_source_fit(&SceneSourceKind::Screen, layout))
            .map(windows_scene_fit)
            .unwrap_or(WindowsD3d11SceneFit::Cover);
        let mut layers = vec![WindowsD3d11SceneLayerInput {
            source_id: CAPTURE_SOURCE_ID,
            source_kind: WindowsD3d11SceneSourceKind::Display,
            source_dimensions: WindowsD3d11OutputDimensions::new(
                plan.source_width,
                plan.source_height,
            )
            .map_err(|error| error.to_string())?,
            transform: WindowsD3d11NormalizedTransform::full_canvas(),
            crop: WindowsD3d11Crop::none(),
            fit: display_fit,
            mirror_x: false,
            mask: WindowsD3d11SceneMask::None,
            effects: WindowsD3d11LayerEffects::default(),
            z_index: 0,
            output_targets: WindowsD3d11SceneOutputTargets::ALL,
        }];
        if let (Some((camera_width, camera_height)), Some(layout)) =
            (camera_dimensions, camera_layout)
        {
            let transform = resolved_camera_transform(layout, dimensions.width, dimensions.height);
            let crop = scene_crop_from_transform(&transform);
            let chroma_key = camera_chroma_key(layout).map(|key| WindowsD3d11ChromaKey {
                key_rgb: key.key_rgb,
                angle_threshold_degrees: key.max_angle_deg as f32,
                softness_degrees: key.band_deg as f32,
                spill_suppression: key.spill as f32,
                saturation_floor: (CHROMA_KEY_SATURATION_FLOOR / 255.0) as f32,
            });
            layers.push(WindowsD3d11SceneLayerInput {
                source_id: CAMERA_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CameraUpload,
                source_dimensions: WindowsD3d11OutputDimensions::new(camera_width, camera_height)
                    .map_err(|error| error.to_string())?,
                transform: WindowsD3d11NormalizedTransform {
                    x: transform.x as f32,
                    y: transform.y as f32,
                    width: transform.width as f32,
                    height: transform.height as f32,
                },
                crop: WindowsD3d11Crop {
                    left: crop.left as f32,
                    top: crop.top as f32,
                    right: crop.right as f32,
                    bottom: crop.bottom as f32,
                },
                fit: windows_scene_fit(scene_source_fit(&SceneSourceKind::Camera, layout)),
                mirror_x: layout.camera_mirror,
                mask: windows_scene_mask(camera_mask(layout)),
                effects: WindowsD3d11LayerEffects {
                    chroma_key,
                    ..Default::default()
                },
                z_index: 1,
                output_targets: WindowsD3d11SceneOutputTargets::ALL,
            });
        }
        if let Some(committed) = committed {
            layers.clear();
            let legs = committed.render_edit.legs().collect::<Vec<_>>();
            for (index, (scene, layout)) in legs.iter().enumerate() {
                let targets = if legs.len() == 1 {
                    WindowsD3d11SceneOutputTargets::ALL
                } else if index == 0 {
                    WindowsD3d11SceneOutputTargets::PRIMARY
                        .union(WindowsD3d11SceneOutputTargets::PREVIEW)
                } else {
                    WindowsD3d11SceneOutputTargets::AUXILIARY
                };
                // Plan 190 S4: the primary leg's live background is a frame
                // at its Full internal size; every other background is its
                // prepared picture.
                let live_size = (index == 0)
                    .then(|| primary_live_background(committed))
                    .flatten()
                    .map(|input| {
                        crate::live_background::internal_size(
                            input.spec.id,
                            (dimensions.width, dimensions.height),
                            crate::live_background::GuardLevel::Full,
                        )
                    });
                let background_size = live_size.or_else(|| {
                    committed
                        .backgrounds
                        .get(index)
                        .and_then(Option::as_ref)
                        .map(|image| (image.width, image.height))
                });
                if let (Some((width, height)), Some(background)) =
                    (background_size, scene.background.as_ref())
                {
                    let crop = crate::scene_geometry::background_zoom_crop(Some(background));
                    layers.push(WindowsD3d11SceneLayerInput {
                        source_id: 30 + index as u64,
                        source_kind: WindowsD3d11SceneSourceKind::BackgroundImage,
                        source_dimensions: WindowsD3d11OutputDimensions::new(width, height)
                            .map_err(|error| error.to_string())?,
                        transform: WindowsD3d11NormalizedTransform::full_canvas(),
                        crop: WindowsD3d11Crop {
                            left: crop.left as f32,
                            top: crop.top as f32,
                            right: crop.right as f32,
                            bottom: crop.bottom as f32,
                        },
                        fit: if matches!(background.fit, crate::protocol::BackgroundFit::Fit) {
                            WindowsD3d11SceneFit::Contain
                        } else {
                            WindowsD3d11SceneFit::Cover
                        },
                        mirror_x: false,
                        mask: WindowsD3d11SceneMask::None,
                        effects: WindowsD3d11LayerEffects::default(),
                        z_index: -1,
                        output_targets: targets,
                    });
                }
                let stage_margin = if background_size.is_some() {
                    crate::scene_geometry::background_stage_margin(scene.background.as_ref())
                } else {
                    0.0
                };
                if committed.takeover_active {
                    if let Some(image) = committed.takeover.as_ref() {
                        layers.push(WindowsD3d11SceneLayerInput {
                            source_id: 20,
                            source_kind: WindowsD3d11SceneSourceKind::Image,
                            source_dimensions: WindowsD3d11OutputDimensions::new(
                                image.width,
                                image.height,
                            )
                            .map_err(|error| error.to_string())?,
                            transform: WindowsD3d11NormalizedTransform {
                                x: stage_margin as f32,
                                y: stage_margin as f32,
                                width: (1.0 - 2.0 * stage_margin) as f32,
                                height: (1.0 - 2.0 * stage_margin) as f32,
                            },
                            crop: WindowsD3d11Crop::none(),
                            fit: windows_scene_fit(scene_source_fit(
                                &SceneSourceKind::Screen,
                                layout,
                            )),
                            mirror_x: false,
                            mask: WindowsD3d11SceneMask::None,
                            effects: WindowsD3d11LayerEffects::default(),
                            z_index: 0,
                            output_targets: targets,
                        });
                    }
                    continue;
                }
                for (order, source) in scene
                    .sources
                    .iter()
                    .enumerate()
                    .filter(|(_, source)| source.visible && source.device_id.is_some())
                {
                    let (id, kind, size) = match source.kind {
                        SceneSourceKind::Camera => (
                            CAMERA_SOURCE_ID,
                            WindowsD3d11SceneSourceKind::CameraUpload,
                            camera_dimensions,
                        ),
                        SceneSourceKind::Screen | SceneSourceKind::Window => (
                            CAPTURE_SOURCE_ID,
                            WindowsD3d11SceneSourceKind::Display,
                            capture_dimensions,
                        ),
                        SceneSourceKind::TestPattern => continue,
                    };
                    let Some((width, height)) = size else {
                        continue;
                    };
                    let transform = crate::scene_geometry::scene_source_render_transform(
                        &source.transform,
                        &source.kind,
                        stage_margin,
                    );
                    let crop = scene_crop_from_transform(&transform);
                    let is_camera = source.kind == SceneSourceKind::Camera;
                    layers.push(WindowsD3d11SceneLayerInput {
                        source_id: id,
                        source_kind: kind,
                        source_dimensions: WindowsD3d11OutputDimensions::new(width, height)
                            .map_err(|error| error.to_string())?,
                        transform: WindowsD3d11NormalizedTransform {
                            x: transform.x as f32,
                            y: transform.y as f32,
                            width: transform.width as f32,
                            height: transform.height as f32,
                        },
                        crop: WindowsD3d11Crop {
                            left: crop.left as f32,
                            top: crop.top as f32,
                            right: crop.right as f32,
                            bottom: crop.bottom as f32,
                        },
                        fit: windows_scene_fit(scene_source_fit(&source.kind, layout)),
                        mirror_x: is_camera && layout.camera_mirror,
                        mask: if is_camera {
                            windows_scene_mask(camera_mask(layout))
                        } else {
                            WindowsD3d11SceneMask::None
                        },
                        effects: WindowsD3d11LayerEffects {
                            chroma_key: is_camera.then(|| camera_chroma_key(layout)).flatten().map(
                                |key| WindowsD3d11ChromaKey {
                                    key_rgb: key.key_rgb,
                                    angle_threshold_degrees: key.max_angle_deg as f32,
                                    softness_degrees: key.band_deg as f32,
                                    spill_suppression: key.spill as f32,
                                    saturation_floor: (CHROMA_KEY_SATURATION_FLOOR / 255.0) as f32,
                                },
                            ),
                            ..Default::default()
                        },
                        z_index: order as i32,
                        output_targets: targets,
                    });
                }
            }
        } else if capture_dimensions.is_none() {
            layers.retain(|layer| layer.source_id != CAPTURE_SOURCE_ID);
        }
        for sprite in sprites {
            layers.push(super::windows_d3d11_buddy_sprite_layer(
                sprite.source_id,
                &sprite.layer,
                (
                    sprite.output_dimensions.width,
                    sprite.output_dimensions.height,
                ),
                sprite.output_targets,
                sprite.z_index,
            )?);
        }
        // Plan 186 S4: each banner at the shared oracle's pixels, opacity
        // baked into its bitmap and the fade as the layer's opacity.
        for banner in banners {
            let output = (
                banner.output_dimensions.width,
                banner.output_dimensions.height,
            );
            let bitmap = &banner.draw.bitmap;
            layers.push(WindowsD3d11SceneLayerInput {
                source_id: banner.source_id,
                source_kind: WindowsD3d11SceneSourceKind::Image,
                source_dimensions: WindowsD3d11OutputDimensions::new(bitmap.width, bitmap.height)
                    .map_err(|error| error.to_string())?,
                transform: super::windows_d3d11_banner_layer_transform(
                    banner.draw.draw_rect(output.0, output.1),
                    output,
                ),
                crop: WindowsD3d11Crop::none(),
                fit: WindowsD3d11SceneFit::Contain,
                mirror_x: false,
                mask: WindowsD3d11SceneMask::None,
                effects: WindowsD3d11LayerEffects {
                    opacity: banner.draw.opacity.clamp(0.0, 1.0),
                    ..Default::default()
                },
                z_index: banner.z_index,
                output_targets: banner.output_targets,
            });
        }
        for overlay in overlays {
            let (transform, crop) = match overlay.bubble_anchor {
                Some(anchor) => super::windows_d3d11_bubble_layer_geometry(
                    (overlay.overlay.width, overlay.overlay.height),
                    (
                        overlay.output_dimensions.width,
                        overlay.output_dimensions.height,
                    ),
                    anchor,
                ),
                None => super::windows_d3d11_overlay_layer_geometry(
                    (overlay.overlay.width, overlay.overlay.height),
                    (
                        overlay.output_dimensions.width,
                        overlay.output_dimensions.height,
                    ),
                    overlay.overlay.blit_rect(
                        overlay.output_dimensions.width,
                        overlay.output_dimensions.height,
                    ),
                    overlay.safe_inset,
                ),
            };
            layers.push(WindowsD3d11SceneLayerInput {
                source_id: overlay.source_id,
                source_kind: overlay.source_kind,
                source_dimensions: WindowsD3d11OutputDimensions::new(
                    overlay.overlay.width,
                    overlay.overlay.height,
                )
                .map_err(|error| error.to_string())?,
                transform,
                crop,
                fit: WindowsD3d11SceneFit::Contain,
                mirror_x: false,
                mask: WindowsD3d11SceneMask::None,
                effects: WindowsD3d11LayerEffects::default(),
                z_index: overlay.z_index,
                output_targets: overlay.output_targets,
            });
        }
        build_windows_d3d11_scene_plan(WindowsD3d11ScenePlanRequest {
            adapter_luid: selection.adapter_luid,
            generation,
            sequence,
            orientation: if dimensions.width >= dimensions.height {
                WindowsD3d11CanvasOrientation::Horizontal
            } else {
                WindowsD3d11CanvasOrientation::Vertical
            },
            canvas_dimensions: dimensions,
            layers,
            encoded_outputs,
        })
        .map_err(|error| error.to_string())
    }

    const fn windows_scene_fit(fit: SceneFit) -> WindowsD3d11SceneFit {
        match fit {
            SceneFit::Contain => WindowsD3d11SceneFit::Contain,
            SceneFit::Cover => WindowsD3d11SceneFit::Cover,
        }
    }

    const fn windows_scene_mask(mask: SceneMask) -> WindowsD3d11SceneMask {
        match mask {
            SceneMask::None => WindowsD3d11SceneMask::None,
            SceneMask::Circle => WindowsD3d11SceneMask::Circle,
            SceneMask::Rounded { radius_pct } => WindowsD3d11SceneMask::Rounded { radius_pct },
        }
    }

    #[cfg(test)]
    #[test]
    fn windows_live_scene_mapping_keeps_slots_auxiliary_geometry_and_takeover() {
        use crate::protocol::{SceneSource, SceneTransform, SourceSelection};
        let transform = SceneTransform {
            x: 0.2,
            y: 0.1,
            width: 0.4,
            height: 0.6,
            crop_left: 0.1,
            crop_top: 0.05,
            crop_right: 0.15,
            crop_bottom: 0.1,
        };
        let mut scene = crate::scene::default_scene();
        scene.sources.push(SceneSource {
            id: "camera-slot".into(),
            name: "Camera".into(),
            kind: SceneSourceKind::Camera,
            device_id: None,
            transform: transform.clone(),
            default_transform: transform,
            visible: true,
            locked: true,
        });
        let mut layout = crate::protocol::default_layout_settings();
        layout.camera_fit = crate::protocol::CameraFit::Fill;
        let confirmed = SourceSelection {
            screen_id: None,
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        let edit = crate::compositor::CompositorSourceEdit::test_from_scenes(
            scene.clone(),
            Some(scene),
            layout.clone(),
            confirmed.clone(),
        );
        let mut current = WindowsLiveSnapshot {
            render_edit: edit.clone(),
            edit,
            camera: None,
            capture: None,
            confirmed,
            source_revision: 1,
            takeover: None,
            takeover_active: false,
            backgrounds: vec![None, None],
            banners: Arc::new(crate::banners::BannerSet::default()),
            live_background: None,
            live_background_budget_notice: false,
        };
        let primary = super::WindowsD3d11VideoPlan {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4500,
        };
        let plan = WindowsD3d11SessionPlan {
            screen_id: "screen:dxgi:00000000000003f1:2".into(),
            source_width: 1920,
            source_height: 1080,
            primary,
            auxiliary: Some(primary),
            camera_required: false,
            preview_required_at_startup: false,
            primary_role: WindowsD3d11MediaRole::Record,
            roles: [WindowsD3d11MediaRole::Record, WindowsD3d11MediaRole::Stream]
                .into_iter()
                .collect(),
        };
        let map = |current: &WindowsLiveSnapshot, camera| {
            build_scene_plan(
                &plan,
                9,
                4,
                camera,
                Some(&layout),
                &[],
                &[],
                &[],
                Some(current),
                None,
            )
            .unwrap()
        };
        assert!(
            map(&current, None).layers.is_empty(),
            "None is black even with a retained slot"
        );
        let original = current.render_edit.clone();
        current.confirmed.camera_id = Some("camera:B".into());
        current.render_edit.patch(
            crate::live_source_switch::SourceKind::Camera,
            Some("camera:B"),
            &current.confirmed,
        );
        let applied = map(&current, Some((640, 480)));
        assert_eq!(applied.layers.len(), 2);
        assert_eq!((applied.generation, applied.sequence), (4, 9));
        assert_eq!(applied.encoded_outputs.len(), 2);
        assert_eq!(
            applied.layers[0].destination_normalized,
            [0.2, 0.1, 0.4, 0.6]
        );
        assert_ne!(
            applied.layers[0].source_uv,
            [0.0, 0.0, 1.0, 1.0],
            "slot crop remains in the actual GPU plan"
        );
        assert!(applied.layers[0].applies_to(
            crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTarget::Encoded(
                WindowsD3d11EncodedOutputRole::Primary
            )
        ));
        assert!(!applied.layers[0].applies_to(
            crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTarget::Encoded(
                WindowsD3d11EncodedOutputRole::Auxiliary
            )
        ));
        assert!(applied.layers[1].applies_to(
            crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTarget::Encoded(
                WindowsD3d11EncodedOutputRole::Auxiliary
            )
        ));
        current.confirmed.camera_id = None;
        current.render_edit.patch(
            crate::live_source_switch::SourceKind::Camera,
            None,
            &current.confirmed,
        );
        assert!(current.render_edit == original);
        assert!(
            map(&current, Some((640, 480))).layers.is_empty(),
            "stale available camera bytes cannot fill None"
        );
        current.takeover_active = true;
        current.takeover = Some(crate::compositor::WindowsSceneImage {
            pixels: Arc::new(vec![255; 16]),
            width: 2,
            height: 2,
            revision: 1,
        });
        assert!(
            map(&current, Some((640, 480)))
                .layers
                .iter()
                .all(|layer| layer.source_id == 20)
        );
    }

    /// Plan 193 S3: a record-and-stream session composing one scene puts
    /// the primary leg's live background on every target, the AUXILIARY
    /// (stream) one included, at its Full internal size; with a vertical
    /// simulcast leg it stays off the auxiliary target (plan 190 D9).
    #[cfg(test)]
    #[test]
    fn windows_live_plan_draws_the_live_background_on_the_stream_target() {
        use crate::protocol::{
            EffectiveSceneBackground, LiveBackgroundId, LiveBackgroundMotion, LiveBackgroundSpec,
            SceneSource, SceneTransform, SourceSelection,
        };
        use crate::windows_d3d11_compositor::{
            WindowsD3d11SceneOutputTarget, WindowsD3d11SceneOutputTargets,
            WindowsD3d11SceneSourceKind,
        };
        let spec = LiveBackgroundSpec {
            id: LiveBackgroundId::Silk,
            look: "satin".to_string(),
            motion: LiveBackgroundMotion::Calm,
        };
        let background = EffectiveSceneBackground {
            asset_id: crate::live_background::poster_asset_id(spec.id, &spec.look),
            managed_asset_path: String::new(),
            fit: crate::protocol::BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
            live: Some(spec.clone()),
        };
        let mut scene = crate::scene::default_scene();
        scene.background = Some(background.clone());
        let transform = SceneTransform {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };
        scene.sources.push(SceneSource {
            id: "screen-slot".into(),
            name: "Screen".into(),
            kind: SceneSourceKind::Screen,
            device_id: Some("screen:dxgi:00000000000003f1:2".into()),
            transform: transform.clone(),
            default_transform: transform,
            visible: true,
            locked: true,
        });
        let layout = crate::protocol::default_layout_settings();
        let confirmed = SourceSelection {
            screen_id: Some("screen:dxgi:00000000000003f1:2".into()),
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        let now = std::time::Instant::now();
        let mut runtime = None;
        crate::live_background::runtime::sync(&mut runtime, Some(&spec), now);
        let live_background = runtime.unwrap().frame_input(
            &background,
            &Arc::default(),
            crate::live_background::LiveBackgroundTick::unmeasured(now),
        );
        let snapshot = |auxiliary: Option<crate::protocol::Scene>| {
            let edit = crate::compositor::CompositorSourceEdit::test_from_scenes(
                scene.clone(),
                auxiliary,
                layout.clone(),
                confirmed.clone(),
            );
            WindowsLiveSnapshot {
                render_edit: edit.clone(),
                edit,
                camera: None,
                capture: None,
                confirmed: confirmed.clone(),
                source_revision: 1,
                takeover: None,
                takeover_active: false,
                backgrounds: vec![None, None],
                banners: Arc::new(crate::banners::BannerSet::default()),
                live_background: Some(live_background.clone()),
                live_background_budget_notice: false,
            }
        };
        let primary = super::WindowsD3d11VideoPlan {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4500,
        };
        let plan = WindowsD3d11SessionPlan {
            screen_id: "screen:dxgi:00000000000003f1:2".into(),
            source_width: 1920,
            source_height: 1080,
            primary,
            auxiliary: Some(primary),
            camera_required: false,
            preview_required_at_startup: false,
            primary_role: WindowsD3d11MediaRole::Record,
            roles: [WindowsD3d11MediaRole::Record, WindowsD3d11MediaRole::Stream]
                .into_iter()
                .collect(),
        };
        let map = |current: &WindowsLiveSnapshot| {
            build_scene_plan(
                &plan,
                9,
                4,
                None,
                Some(&layout),
                &[],
                &[],
                &[],
                Some(current),
                Some((1920, 1080)),
            )
            .unwrap()
        };
        let auxiliary =
            WindowsD3d11SceneOutputTarget::Encoded(WindowsD3d11EncodedOutputRole::Auxiliary);
        let primary_target =
            WindowsD3d11SceneOutputTarget::Encoded(WindowsD3d11EncodedOutputRole::Primary);

        // One scene, two outputs: the live layer and the screen are on ALL.
        let one_leg = map(&snapshot(None));
        assert_eq!(one_leg.encoded_outputs.len(), 2);
        let live = one_leg
            .layers
            .iter()
            .find(|layer| layer.source_id == 30)
            .expect("the live background layer");
        assert_eq!(
            live.source_kind,
            WindowsD3d11SceneSourceKind::BackgroundImage
        );
        assert_eq!(
            (live.source_dimensions.width, live.source_dimensions.height),
            crate::live_background::internal_size(
                spec.id,
                (1280, 720),
                crate::live_background::GuardLevel::Full
            ),
            "the frame at its Full internal size"
        );
        assert_eq!(live.output_targets, WindowsD3d11SceneOutputTargets::ALL);
        assert!(live.applies_to(auxiliary) && live.applies_to(primary_target));
        assert!(live.applies_to(WindowsD3d11SceneOutputTarget::Preview));
        let screen = one_leg
            .layers
            .iter()
            .find(|layer| layer.source_kind == WindowsD3d11SceneSourceKind::Display)
            .expect("the screen layer");
        assert!(screen.applies_to(auxiliary) && screen.applies_to(primary_target));

        // A vertical simulcast leg composes its own scene: the primary's live
        // layer stays off the auxiliary target, and the vertical leg has no
        // live layer of its own (its poster rides in `backgrounds[1]`).
        let two_legs = map(&snapshot(Some(scene.clone())));
        let live = two_legs
            .layers
            .iter()
            .find(|layer| layer.source_id == 30)
            .expect("the primary leg's live background layer");
        assert!(live.applies_to(primary_target) && !live.applies_to(auxiliary));
        assert!(two_legs.layers.iter().all(|layer| layer.source_id != 31));
    }

    /// Plan 164 S-C3: the Buddy rides its own per-target slot between the
    /// caption bar and the highlight card on both legs, and a session with no
    /// auxiliary leg refuses an auxiliary Buddy like it refuses auxiliary
    /// captions. Mirrored from the CPU/Metal order by reading; this is the
    /// Windows CI gate for it.
    #[cfg(test)]
    #[test]
    fn windows_buddy_legs_of_one_tick_share_the_animator_step() {
        // Plan 168 S-C4: the pump asks both legs at one clock; asking again
        // at that clock draws the same, the next tick moves on.
        let video = super::WindowsD3d11VideoPlan {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4500,
        };
        let plan = WindowsD3d11SessionPlan {
            screen_id: "screen:dxgi:00000000000003f1:2".into(),
            source_width: 1920,
            source_height: 1080,
            primary: video,
            auxiliary: Some(video),
            camera_required: false,
            preview_required_at_startup: false,
            primary_role: WindowsD3d11MediaRole::Record,
            roles: [WindowsD3d11MediaRole::Record, WindowsD3d11MediaRole::Stream]
                .into_iter()
                .collect(),
        };
        let input = WindowsD3d11OverlayInput {
            captions: crate::captions::new_caption_overlay_slots(),
            highlight: crate::captions::new_caption_overlay_slot(),
            buddy: crate::captions::new_caption_overlay_slots(),
            buddy_sprite: crate::buddy_sprite::BuddySpriteSlot::new(
                &crate::cohost::CohostPersona::default(),
                crate::overlay_layout::OverlayLayout::default().buddy,
                None,
            ),
            caption_on_primary: false,
            caption_on_auxiliary: false,
            highlight_on_primary: false,
            highlight_on_auxiliary: false,
            buddy_on_primary: true,
            buddy_on_auxiliary: true,
            highlight_in_program: false,
            buddy_in_program: true,
            banner_shape: crate::overlay_layout::OverlaySessionShape {
                record_enabled: true,
                stream_enabled: true,
                aux_leg: crate::overlay_layout::OverlayAuxLeg::Stream,
            },
            program_shape: Some(crate::overlay_layout::OverlaySessionShape {
                record_enabled: true,
                stream_enabled: true,
                aux_leg: crate::overlay_layout::OverlayAuxLeg::Stream,
            }),
            banner_prepare: crate::banner_prepare::BannerPrepareService::new(),
        };
        input
            .buddy_sprite
            .set_source(Box::new(crate::buddy_animator::BuddyAnimatorSource::new(
                crate::buddy_animator::BuddyAnimatorSettings::default(),
                7,
            )));
        for leg in crate::buddy_sprite::BuddySpriteLeg::ALL {
            input.buddy_sprite.install_atlas_for_test(
                leg,
                (1280, 720),
                crate::buddy_animator::tests::alive(),
            );
        }
        let draws = |clock: f64| {
            current_buddy_legs(&plan, &input, clock)
                .map(|leg| leg.and_then(|leg| leg.sprite).map(|sprite| sprite.draw))
        };
        let mut previous = None;
        for sequence in 1..=90_u64 {
            if sequence == 10 {
                input
                    .buddy_sprite
                    .notify(crate::buddy_animator::BuddyAnimatorEvent::React {
                        reaction: "surprised".to_string(),
                    });
            }
            let clock = super::windows_d3d11_buddy_clock_seconds(sequence, 30);
            let first = draws(clock);
            assert!(first.iter().all(Option::is_some), "tick {sequence}");
            assert_eq!(draws(clock), first, "tick {sequence} asked twice");
            if (11..20).contains(&sequence) {
                assert_ne!(
                    Some(first),
                    previous,
                    "tick {sequence} moves with the reaction"
                );
            }
            previous = Some(first);
        }
    }

    #[cfg(test)]
    #[test]
    fn windows_overlay_frames_stack_the_buddy_between_captions_and_the_card() {
        use crate::captions::CaptionOverlayPosition;
        use crate::overlay_layout::OverlayRect;
        let video = super::WindowsD3d11VideoPlan {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4500,
        };
        let mut plan = WindowsD3d11SessionPlan {
            screen_id: "screen:dxgi:00000000000003f1:2".into(),
            source_width: 1920,
            source_height: 1080,
            primary: video,
            auxiliary: Some(video),
            camera_required: false,
            preview_required_at_startup: false,
            primary_role: WindowsD3d11MediaRole::Record,
            roles: [WindowsD3d11MediaRole::Record, WindowsD3d11MediaRole::Stream]
                .into_iter()
                .collect(),
        };
        let png = {
            use base64::Engine as _;
            let mut bytes = Vec::new();
            image::RgbaImage::from_pixel(200, 100, image::Rgba([0, 255, 0, 255]))
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };
        let input = WindowsD3d11OverlayInput {
            captions: crate::captions::new_caption_overlay_slots(),
            highlight: crate::captions::new_caption_overlay_slot(),
            buddy: crate::captions::new_caption_overlay_slots(),
            buddy_sprite: crate::buddy_sprite::BuddySpriteSlot::new(
                &crate::cohost::CohostPersona::default(),
                crate::overlay_layout::OverlayLayout::default().buddy,
                None,
            ),
            caption_on_primary: true,
            caption_on_auxiliary: true,
            highlight_on_primary: true,
            highlight_on_auxiliary: true,
            buddy_on_primary: true,
            buddy_on_auxiliary: true,
            highlight_in_program: true,
            buddy_in_program: true,
            banner_shape: crate::overlay_layout::OverlaySessionShape {
                record_enabled: true,
                stream_enabled: true,
                aux_leg: crate::overlay_layout::OverlayAuxLeg::Stream,
            },
            program_shape: Some(crate::overlay_layout::OverlaySessionShape {
                record_enabled: true,
                stream_enabled: true,
                aux_leg: crate::overlay_layout::OverlayAuxLeg::Stream,
            }),
            banner_prepare: crate::banner_prepare::BannerPrepareService::new(),
        };
        crate::captions::install_caption_overlays(
            &input.captions,
            crate::captions::SetCaptionOverlayParams {
                png_base64: png.clone(),
                position: CaptionOverlayPosition::Bottom,
                rect: None,
                target: None,
                style_revision: None,
            },
        )
        .unwrap();
        crate::captions::install_caption_overlay(
            &input.highlight,
            &png,
            CaptionOverlayPosition::Top,
        )
        .unwrap();
        let buddy_rect = OverlayRect::new(0.15, 0.25, 0.25, 0.2);
        crate::buddy_overlay::install_buddy_overlay(
            &input.buddy,
            crate::buddy_overlay::SetBuddyOverlayParams {
                png_base64: png,
                target: None,
                rect: Some(buddy_rect),
            },
        )
        .unwrap();
        let frames = current_overlay_frames(&plan, &input, &[None, None]).unwrap();
        let stack = |frames: &[WindowsD3d11OverlayFrame]| {
            frames
                .iter()
                .map(|frame| (frame.source_id, frame.z_index, frame.source_kind))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            stack(&frames),
            vec![
                (
                    CAPTION_PRIMARY_SOURCE_ID,
                    CAPTION_Z_INDEX,
                    WindowsD3d11SceneSourceKind::CaptionOverlay
                ),
                (
                    CAPTION_AUXILIARY_SOURCE_ID,
                    CAPTION_Z_INDEX,
                    WindowsD3d11SceneSourceKind::CaptionOverlay
                ),
                (
                    BUDDY_PRIMARY_SOURCE_ID,
                    BUDDY_Z_INDEX,
                    WindowsD3d11SceneSourceKind::BuddyOverlay
                ),
                (
                    BUDDY_AUXILIARY_SOURCE_ID,
                    BUDDY_Z_INDEX,
                    WindowsD3d11SceneSourceKind::BuddyOverlay
                ),
                (
                    HIGHLIGHT_PRIMARY_SOURCE_ID,
                    HIGHLIGHT_Z_INDEX,
                    WindowsD3d11SceneSourceKind::CommentHighlight
                ),
                (
                    HIGHLIGHT_AUXILIARY_SOURCE_ID,
                    HIGHLIGHT_Z_INDEX,
                    WindowsD3d11SceneSourceKind::CommentHighlight
                ),
            ]
        );
        const {
            assert!(
                CAPTION_Z_INDEX < BUDDY_SPRITE_Z_INDEX
                    && BUDDY_SPRITE_Z_INDEX < BUDDY_Z_INDEX
                    && BUDDY_Z_INDEX < HIGHLIGHT_Z_INDEX
            )
        };
        // Plan 205 S8: both legs burn the Buddy, so the Preview draws it once,
        // from the primary's layer (the Preview's canvas and sources are the
        // primary's); the stream leg's layer is the stream's alone.
        let buddy_primary = &frames[2];
        assert_eq!(
            buddy_primary.output_targets,
            WindowsD3d11SceneOutputTargets::PRIMARY.union(WindowsD3d11SceneOutputTargets::PREVIEW)
        );
        assert_eq!(
            frames[3].output_targets,
            WindowsD3d11SceneOutputTargets::AUXILIARY
        );
        assert_eq!(buddy_primary.overlay.blit_rect(1280, 720), buddy_rect);
        assert_eq!(buddy_primary.safe_inset, 0);
        // The same geometry oracle as the CPU and Metal paths: the parity
        // fixture's Buddy lands at (192, 180).
        let (transform, _) = super::windows_d3d11_overlay_layer_geometry(
            (200, 100),
            (1280, 720),
            buddy_primary.overlay.blit_rect(1280, 720),
            0,
        );
        assert_eq!(transform.x, 192.0 / 1280.0);
        assert_eq!(transform.y, 180.0 / 720.0);
        // The scene plan keeps the stack: z sorts captions, Buddy, card.
        let scene = build_scene_plan(
            &plan,
            1,
            1,
            None,
            None,
            &frames,
            &[],
            &[],
            None,
            Some((1920, 1080)),
        )
        .unwrap();
        let overlay_layers = scene
            .layers
            .iter()
            .filter(|layer| layer.source_id >= CAPTION_PRIMARY_SOURCE_ID)
            .map(|layer| layer.source_id)
            .collect::<Vec<_>>();
        assert_eq!(
            overlay_layers,
            vec![
                CAPTION_PRIMARY_SOURCE_ID,
                CAPTION_AUXILIARY_SOURCE_ID,
                BUDDY_PRIMARY_SOURCE_ID,
                BUDDY_AUXILIARY_SOURCE_ID,
                HIGHLIGHT_PRIMARY_SOURCE_ID,
                HIGHLIGHT_AUXILIARY_SOURCE_ID,
            ]
        );
        // No auxiliary leg: only the primary frames remain, in the same stack
        // (the pump's start refuses an auxiliary flag without a leg).
        plan.auxiliary = None;
        assert_eq!(
            stack(&current_overlay_frames(&plan, &input, &[None, None]).unwrap()),
            vec![
                (
                    CAPTION_PRIMARY_SOURCE_ID,
                    CAPTION_Z_INDEX,
                    WindowsD3d11SceneSourceKind::CaptionOverlay
                ),
                (
                    BUDDY_PRIMARY_SOURCE_ID,
                    BUDDY_Z_INDEX,
                    WindowsD3d11SceneSourceKind::BuddyOverlay
                ),
                (
                    HIGHLIGHT_PRIMARY_SOURCE_ID,
                    HIGHLIGHT_Z_INDEX,
                    WindowsD3d11SceneSourceKind::CommentHighlight
                ),
            ]
        );
    }

    /// Plan 205 S8: the `PreviewBgra` composition draws the program (every
    /// item at least one running output carries; the idle program for a
    /// Clips ring) while each encoded leg keeps exactly its own plan.
    #[cfg(test)]
    #[test]
    fn windows_preview_composition_draws_the_program_while_each_leg_keeps_its_plan() {
        use crate::banner_prepare::{BannerBitmapKey, BannerFileRevision, prepare_banner_bitmap};
        use crate::banners::{
            BannerFade, BannerLayer, BannerSet, banner_draw_rect, banner_rect_for,
        };
        use crate::overlay_layout::{OverlayAuxLeg, OverlayOrientation, OverlaySessionShape};
        use crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTarget;

        let canvas = (1280_u32, 720_u32);
        let video = super::WindowsD3d11VideoPlan {
            width: canvas.0,
            height: canvas.1,
            fps: 30,
            bitrate_kbps: 4500,
        };
        let split_plan = WindowsD3d11SessionPlan {
            screen_id: "screen:dxgi:00000000000003f1:2".into(),
            source_width: 1920,
            source_height: 1080,
            primary: video,
            auxiliary: Some(video),
            camera_required: false,
            preview_required_at_startup: false,
            primary_role: WindowsD3d11MediaRole::Record,
            roles: [WindowsD3d11MediaRole::Record, WindowsD3d11MediaRole::Stream]
                .into_iter()
                .collect(),
        };
        let split_shape = OverlaySessionShape {
            record_enabled: true,
            stream_enabled: true,
            aux_leg: OverlayAuxLeg::Stream,
        };
        let record_shape = OverlaySessionShape {
            record_enabled: true,
            stream_enabled: false,
            aux_leg: OverlayAuxLeg::None,
        };
        let now = Instant::now();
        let file_revision = BannerFileRevision {
            size: 1,
            modified_nanos: 1,
        };
        let prepare = crate::banner_prepare::BannerPrepareService::with_decoder(
            Arc::new(|_: &std::path::Path| Err("no decode in this test".to_string())),
            crate::banner_prepare::BANNER_BITMAP_BUDGET_BYTES,
        );
        // Two banners with their exact bitmaps seeded for the canvas: one the
        // recording alone carries, one the stream alone carries.
        let mut recording_only = crate::banners::tests::sample_banner("recording-only", 0);
        recording_only.show_on_stream = false;
        let mut stream_only = crate::banners::tests::sample_banner("stream-only", 1);
        stream_only.show_in_recording = false;
        for banner in [&recording_only, &stream_only] {
            let rect = banner_rect_for(
                banner,
                OverlayOrientation::for_canvas(canvas.0, canvas.1),
                None,
            );
            let (_, _, width, height) = banner_draw_rect(
                banner.width,
                banner.height,
                canvas.0 as usize,
                canvas.1 as usize,
                rect,
            );
            let image = image::RgbaImage::from_pixel(
                banner.width,
                banner.height,
                image::Rgba([255, 0, 255, 255]),
            );
            prepare.insert_for_test(
                BannerBitmapKey::new(&banner.id, file_revision, canvas, rect, banner.opacity),
                prepare_banner_bitmap(&image, width as u32, height as u32, banner.opacity),
            );
        }
        let layer = |banner: &crate::protocol::Banner| BannerLayer {
            image_path: Arc::from(std::path::Path::new("/nonexistent").join(&banner.image_file)),
            banner: banner.clone(),
            file_revision: Some(file_revision),
            fade: BannerFade {
                from: 1.0,
                to: 1.0,
                started_at: now,
            },
        };
        let set = BannerSet {
            layers: vec![layer(&recording_only), layer(&stream_only)],
        };
        let png = {
            use base64::Engine as _;
            let mut bytes = Vec::new();
            image::RgbaImage::from_pixel(200, 100, image::Rgba([0, 255, 0, 255]))
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };
        // A stream-only Buddy: its bubble on both targets, its pet's atlas on
        // both legs, as a real session has them.
        let input = |shape: OverlaySessionShape, program_shape: Option<OverlaySessionShape>| {
            let input = WindowsD3d11OverlayInput {
                captions: crate::captions::new_caption_overlay_slots(),
                highlight: crate::captions::new_caption_overlay_slot(),
                buddy: crate::captions::new_caption_overlay_slots(),
                buddy_sprite: crate::buddy_sprite::BuddySpriteSlot::new(
                    &crate::cohost::CohostPersona::default(),
                    crate::overlay_layout::OverlayLayout::default().buddy,
                    None,
                ),
                caption_on_primary: false,
                caption_on_auxiliary: false,
                highlight_on_primary: false,
                highlight_on_auxiliary: false,
                buddy_on_primary: false,
                buddy_on_auxiliary: shape.stream_enabled && shape.aux_leg == OverlayAuxLeg::Stream,
                highlight_in_program: false,
                buddy_in_program: crate::overlay_layout::program_shows(program_shape, true, false),
                banner_shape: shape,
                program_shape,
                banner_prepare: prepare.clone(),
            };
            crate::buddy_overlay::install_buddy_overlay(
                &input.buddy,
                crate::buddy_overlay::SetBuddyOverlayParams {
                    png_base64: png.clone(),
                    target: None,
                    rect: None,
                },
            )
            .unwrap();
            input.buddy_sprite.set_source(Box::new(
                crate::buddy_animator::BuddyAnimatorSource::new(
                    crate::buddy_animator::BuddyAnimatorSettings::default(),
                    7,
                ),
            ));
            for leg in crate::buddy_sprite::BuddySpriteLeg::ALL {
                input.buddy_sprite.install_atlas_for_test(
                    leg,
                    canvas,
                    crate::buddy_animator::tests::alive(),
                );
            }
            input
        };
        let compose = |plan: &WindowsD3d11SessionPlan, input: &WindowsD3d11OverlayInput| {
            let buddy_legs =
                current_buddy_legs(plan, input, super::windows_d3d11_buddy_clock_seconds(1, 30));
            let overlays = current_overlay_frames(plan, input, &buddy_legs).unwrap();
            let sprites = buddy_sprite_frames(plan, input, &buddy_legs).unwrap();
            let banners = current_banner_frames(plan, input, &set, now).unwrap();
            build_scene_plan(
                plan,
                1,
                1,
                None,
                None,
                &overlays,
                &sprites,
                &banners,
                None,
                Some((1920, 1080)),
            )
            .unwrap()
        };
        let ids_on = |scene: &crate::windows_d3d11_compositor::WindowsD3d11ScenePlan,
                      target: WindowsD3d11SceneOutputTarget| {
            let mut ids = scene
                .layers
                .iter()
                .filter(|layer| layer.source_id >= CAPTION_PRIMARY_SOURCE_ID)
                .filter(|layer| layer.applies_to(target))
                .map(|layer| layer.source_id)
                .collect::<Vec<_>>();
            ids.sort_unstable();
            ids
        };
        let preview = WindowsD3d11SceneOutputTarget::Preview;
        let recording =
            WindowsD3d11SceneOutputTarget::Encoded(WindowsD3d11EncodedOutputRole::Primary);
        let stream =
            WindowsD3d11SceneOutputTarget::Encoded(WindowsD3d11EncodedOutputRole::Auxiliary);

        // Record + stream on a split leg: the Preview has the stream-only
        // Buddy and banner (from the stream leg's layers) and the
        // recording-only banner (from the recording's); the recording has
        // its banner alone, the stream the Buddy and its banner alone.
        let scene = compose(&split_plan, &input(split_shape, Some(split_shape)));
        assert_eq!(
            ids_on(&scene, preview),
            vec![
                BUDDY_AUXILIARY_SOURCE_ID,
                BUDDY_SPRITE_AUXILIARY_SOURCE_ID,
                BANNER_PRIMARY_SOURCE_ID_BASE,
                BANNER_AUXILIARY_SOURCE_ID_BASE,
            ]
        );
        assert_eq!(
            ids_on(&scene, recording),
            vec![BANNER_PRIMARY_SOURCE_ID_BASE]
        );
        assert_eq!(
            ids_on(&scene, stream),
            vec![
                BUDDY_AUXILIARY_SOURCE_ID,
                BUDDY_SPRITE_AUXILIARY_SOURCE_ID,
                BANNER_AUXILIARY_SOURCE_ID_BASE,
            ]
        );

        // Record only: the stream-only Buddy and banner go nowhere, so the
        // Preview drops them with the recording.
        let record_plan = WindowsD3d11SessionPlan {
            auxiliary: None,
            roles: [WindowsD3d11MediaRole::Record].into_iter().collect(),
            ..split_plan.clone()
        };
        let scene = compose(&record_plan, &input(record_shape, Some(record_shape)));
        assert_eq!(ids_on(&scene, preview), vec![BANNER_PRIMARY_SOURCE_ID_BASE]);
        assert_eq!(
            ids_on(&scene, recording),
            vec![BANNER_PRIMARY_SOURCE_ID_BASE]
        );

        // Buffer only (D2): the ring keeps the recording plan, so it has the
        // recording-only banner alone; the Preview shows the idle program,
        // the stream-only Buddy and banner too, from Preview-only layers.
        let scene = compose(&record_plan, &input(record_shape, None));
        assert_eq!(
            ids_on(&scene, preview),
            vec![
                BUDDY_PRIMARY_SOURCE_ID,
                BUDDY_SPRITE_PRIMARY_SOURCE_ID,
                BANNER_PRIMARY_SOURCE_ID_BASE,
                BANNER_PREVIEW_SOURCE_ID_BASE,
            ]
        );
        assert_eq!(
            ids_on(&scene, recording),
            vec![BANNER_PRIMARY_SOURCE_ID_BASE]
        );
        let preview_only = scene
            .layers
            .iter()
            .find(|layer| layer.source_id == BANNER_PREVIEW_SOURCE_ID_BASE)
            .expect("the stream-only banner's Preview layer");
        assert_eq!(
            preview_only.output_targets,
            WindowsD3d11SceneOutputTargets::PREVIEW
        );
        // The Preview stacks the program's way: the stream-only banner is
        // second in the Scene order, so it draws above the ring's banner.
        let ring_banner = scene
            .layers
            .iter()
            .find(|layer| layer.source_id == BANNER_PRIMARY_SOURCE_ID_BASE)
            .expect("the recording-only banner's layer");
        assert_eq!(ring_banner.z_index, super::windows_d3d11_banner_z_index(0));
        assert_eq!(preview_only.z_index, super::windows_d3d11_banner_z_index(1));
        // Every overlay layer has its own source id, so the upload table
        // (one entry per id) stays valid.
        let mut overlay_ids = scene
            .layers
            .iter()
            .filter(|layer| layer.source_id >= CAPTION_PRIMARY_SOURCE_ID)
            .map(|layer| layer.source_id)
            .collect::<Vec<_>>();
        overlay_ids.sort_unstable();
        overlay_ids.dedup();
        assert_eq!(overlay_ids.len(), 4);
    }

    #[cfg(test)]
    #[tokio::test]
    async fn windows_live_snapshot_fences_precommit_same_id_generations_and_recovery_bootstrap() {
        use crate::live_source_switch::{SourceKind, SourceSwitchParams};
        use std::future::Future;
        let (events, _) = tokio::sync::broadcast::channel(16);
        let state = crate::state::AppState::new(
            "fixture".into(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Tutorial720p30,
            width: 64,
            height: 36,
            fps: 30,
            bitrate_kbps: 1000,
        };
        crate::compositor::update_compositor_scene(
            &state,
            crate::protocol::CompositorSceneUpdateParams {
                revision: 1,
                scene: Some(crate::scene::default_scene()),
                layout: layout.clone(),
                active_screen: None,
                transition_ms: None,
            },
        )
        .await;
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:A", &layout, &video,
        )
        .await;
        let confirmed = crate::protocol::SourceSelection {
            camera_id: Some("camera:A".into()),
            screen_id: None,
            window_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        {
            let mut coordinator = state.live_source_switch.lock().unwrap();
            coordinator.start("session".into(), confirmed);
            coordinator.enable_video();
        }
        let sources = WindowsLiveSources::new(&state, "session");
        let first = sources.snapshot().unwrap().camera.unwrap().generation();
        let request = SourceSwitchParams {
            session_id: "session".into(),
            request_id: "retry-A".into(),
            expected_source_revision: 0,
            kind: SourceKind::Camera,
            device_id: Some("camera:A".into()),
            protected_overlay_window_ids: vec![],
        };
        state
            .live_source_switch
            .lock()
            .unwrap()
            .admit(&request)
            .unwrap();
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:A", &layout, &video,
        )
        .await;
        assert!(
            sources.snapshot().is_none(),
            "prepared same-ID pixels are not committed bindings"
        );
        state
            .live_source_switch
            .lock()
            .unwrap()
            .commit_video(&request)
            .unwrap();
        let next = sources.snapshot().unwrap().camera.unwrap().generation();
        assert_ne!(next, first);
        let remove = SourceSwitchParams {
            request_id: "none".into(),
            expected_source_revision: 1,
            device_id: None,
            ..request.clone()
        };
        state
            .live_source_switch
            .lock()
            .unwrap()
            .admit(&remove)
            .unwrap();
        state
            .live_source_switch
            .lock()
            .unwrap()
            .commit_video(&remove)
            .unwrap();
        let compositor_guard = state.compositor.lock().await;
        let mut recovery = std::pin::pin!(WindowsLiveSources::for_recovery(&state, "session"));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(
            recovery.as_mut().poll(&mut context).is_pending(),
            "busy current authority cannot fall back to startup A"
        );
        drop(compositor_guard);
        let recovered = recovery.await.unwrap();
        assert!(recovered.bootstrap.as_ref().unwrap().camera.is_none());
        assert!(
            recovered
                .bootstrap
                .as_ref()
                .unwrap()
                .confirmed
                .camera_id
                .is_none()
        );
        let stopped = SourceSwitchParams {
            request_id: "stop-race".into(),
            expected_source_revision: 2,
            device_id: Some("camera:A".into()),
            ..request
        };
        state
            .live_source_switch
            .lock()
            .unwrap()
            .admit(&stopped)
            .unwrap();
        assert!(sources.snapshot().is_none());
        state.live_source_switch.lock().unwrap().stop("session");
        assert!(
            sources.snapshot().is_none(),
            "late candidate cannot survive Stop authority"
        );
        assert!(
            WindowsLiveSources::for_recovery(&state, "session")
                .await
                .is_err()
        );
        crate::preview_camera::stop_preview_camera(&state).await;
    }

    fn publish_composition(
        textures: Vec<WindowsD3d11TicketedTexture>,
        primary_role: WindowsD3d11MediaRole,
        preview_store: &CompositorFrameStore,
        primary_store: &CompositorFrameStore,
        auxiliary_store: Option<&CompositorFrameStore>,
    ) -> Result<(Option<u64>, u64, Option<u64>), String> {
        let mut preview = None;
        let mut primary = None;
        let mut auxiliary = None;
        for texture in textures {
            match texture.kind {
                WindowsD3d11ComposedTextureKind::PreviewBgra => {
                    preview = Some(publish_texture(
                        texture,
                        WindowsD3d11MediaRole::Preview,
                        WindowsD3d11TextureFormat::Bgra8Unorm,
                        preview_store,
                    )?);
                }
                WindowsD3d11ComposedTextureKind::PrimaryNv12 => {
                    primary = Some(publish_texture(
                        texture,
                        primary_role,
                        WindowsD3d11TextureFormat::Nv12,
                        primary_store,
                    )?);
                }
                WindowsD3d11ComposedTextureKind::AuxiliaryNv12 => {
                    let store = auxiliary_store.ok_or_else(|| {
                        "D3D11 compositor returned an unrequested auxiliary output".to_string()
                    })?;
                    auxiliary = Some(publish_texture(
                        texture,
                        WindowsD3d11MediaRole::Stream,
                        WindowsD3d11TextureFormat::Nv12,
                        store,
                    )?);
                }
                WindowsD3d11ComposedTextureKind::CapturedBgra => {
                    return Err(
                        "D3D11 compositor returned a captured texture as an output".to_string()
                    );
                }
            }
        }
        Ok((
            preview,
            primary.ok_or_else(|| "D3D11 primary output was missing".to_string())?,
            auxiliary,
        ))
    }

    fn publish_texture(
        texture: WindowsD3d11TicketedTexture,
        role: WindowsD3d11MediaRole,
        expected_format: WindowsD3d11TextureFormat,
        store: &CompositorFrameStore,
    ) -> Result<u64, String> {
        let sequence = texture.sequence;
        let width = texture.width;
        let height = texture.height;
        let ticket = ticket_for_role(
            texture,
            role,
            expected_kind(expected_format),
            expected_format,
        )?;
        let pixel_format = match expected_format {
            WindowsD3d11TextureFormat::Bgra8Unorm => {
                CompositorPixelFormat::d3d11_bgra8(width, height)
            }
            WindowsD3d11TextureFormat::Nv12 => CompositorPixelFormat::d3d11_nv12(width, height),
        };
        store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .publish_with_metadata(
                sequence,
                width,
                height,
                pixel_format,
                CompositorFrameExportHandle::d3d11_texture(ticket),
                Instant::now(),
                Vec::new(),
            );
        Ok(sequence)
    }

    fn expected_kind(format: WindowsD3d11TextureFormat) -> WindowsD3d11ComposedTextureKind {
        match format {
            WindowsD3d11TextureFormat::Bgra8Unorm => WindowsD3d11ComposedTextureKind::PreviewBgra,
            WindowsD3d11TextureFormat::Nv12 => WindowsD3d11ComposedTextureKind::PrimaryNv12,
        }
    }

    fn clone_ticket_for_role(
        textures: &[WindowsD3d11TicketedTexture],
        role: WindowsD3d11MediaRole,
        expected_kind: WindowsD3d11ComposedTextureKind,
        expected_format: WindowsD3d11TextureFormat,
    ) -> Option<WindowsD3d11TextureLeaseTicket> {
        let texture = textures.iter().find(|texture| {
            texture.kind == expected_kind && texture.lease.format == expected_format
        })?;
        texture
            .tickets
            .iter()
            .find(|ticket| ticket.metadata().role == role)
            .cloned()
    }

    fn ticket_for_role(
        mut texture: WindowsD3d11TicketedTexture,
        role: WindowsD3d11MediaRole,
        expected_kind: WindowsD3d11ComposedTextureKind,
        expected_format: WindowsD3d11TextureFormat,
    ) -> Result<WindowsD3d11TextureLeaseTicket, String> {
        if texture.kind != expected_kind
            && !(expected_format == WindowsD3d11TextureFormat::Nv12
                && texture.kind == WindowsD3d11ComposedTextureKind::AuxiliaryNv12)
        {
            return Err(format!(
                "D3D11 ticket kind {:?} did not match expected {:?}",
                texture.kind, expected_kind
            ));
        }
        if texture.lease.format != expected_format {
            return Err(format!(
                "D3D11 ticket format {:?} did not match expected {:?}",
                texture.lease.format, expected_format
            ));
        }
        let ticket_index = texture
            .tickets
            .iter()
            .position(|ticket| ticket.metadata().role == role)
            .ok_or_else(|| format!("D3D11 output did not grant the {role:?} role"))?;
        Ok(texture.tickets.swap_remove(ticket_index))
    }
}

#[cfg(target_os = "windows")]
pub(crate) use runtime::{
    WindowsD3d11CameraInput, WindowsD3d11EncoderTicketSource,
    WindowsD3d11EncoderTicketSourceSnapshot, WindowsD3d11OverlayInput,
    WindowsD3d11SessionDiagnosticsSnapshot, WindowsD3d11SessionMonitor, WindowsD3d11SessionPump,
    WindowsLiveSources,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Plan 186 S4: a banner layer on D3D11 lands on the same pixels the CPU
    /// and Metal paths draw (the shared `banner_draw_rect` oracle, pinned by
    /// `protocol-fixtures/banner-geometry.json`), and banners stack above the
    /// scene and the takeover and below captions.
    #[test]
    fn windows_banner_layers_sit_between_scene_and_captions() {
        // The fixture's "wide default 1080p" case: a 2400 x 400 banner in the
        // default wide place lands at (384, 845) as 1152 x 192.
        let rect = crate::overlay_layout::OverlayRect::new(0.2, 0.782222, 0.6, 0.177778);
        let draw_rect = crate::banners::banner_draw_rect(2400, 400, 1920, 1080, rect);
        assert_eq!(draw_rect, (384, 845, 1152, 192));
        let transform = windows_d3d11_banner_layer_transform(draw_rect, (1920, 1080));
        assert_eq!(transform.x, 384.0 / 1920.0);
        assert_eq!(transform.y, 845.0 / 1080.0);
        assert_eq!(transform.width, 1152.0 / 1920.0);
        assert_eq!(transform.height, 192.0 / 1080.0);
        // Back to pixels the transform is exactly the draw rect.
        assert_eq!((transform.x * 1920.0).round(), 384.0);
        assert_eq!((transform.height * 1080.0).round(), 192.0);

        // Stacking: z 6 to 9 in Assets order, above the takeover and the
        // scene sources (z 0 and their order) and below captions (z 10).
        let zs: Vec<i32> = (0..6).map(windows_d3d11_banner_z_index).collect();
        assert_eq!(zs, vec![6, 7, 8, 9, 9, 9]);
        assert!(zs.windows(2).all(|pair| pair[0] <= pair[1]));
        const {
            assert!(WINDOWS_D3D11_BANNER_Z_INDEX_BASE > 0);
            assert!(
                WINDOWS_D3D11_BANNER_Z_INDEX_TOP < 10,
                "captions draw at z 10"
            );
        }
    }

    fn draws_on(
        targets: Option<crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets>,
        output: crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets,
    ) -> bool {
        targets.is_some_and(|targets| targets.union(output) == targets)
    }

    /// Plan 205 S8, the three cases the slice names: record + stream with a
    /// stream-only Buddy and a recording-only banner (the Preview has both,
    /// the recording only the banner, the stream only the Buddy); record
    /// only (the Preview drops a stream-only item); buffer only (the Preview
    /// has a stream-only item, the ring does not).
    #[test]
    fn the_preview_draws_the_program_and_each_encoded_leg_keeps_its_plan() {
        use crate::overlay_layout::{OverlayAuxLeg, OverlaySessionShape, program_shows};
        use crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets as Targets;

        let split = OverlaySessionShape {
            record_enabled: true,
            stream_enabled: true,
            aux_leg: OverlayAuxLeg::Stream,
        };
        let record = OverlaySessionShape {
            record_enabled: true,
            stream_enabled: false,
            aux_leg: OverlayAuxLeg::None,
        };
        let stream_only = |shape: OverlaySessionShape, program: Option<OverlaySessionShape>| {
            item_targets_for(shape, program, true, false)
        };
        let recording_only = |shape: OverlaySessionShape, program: Option<OverlaySessionShape>| {
            item_targets_for(shape, program, false, true)
        };

        // Record + stream, split leg.
        let buddy = stream_only(split, Some(split));
        assert_eq!(
            buddy,
            WindowsD3d11ItemTargets {
                primary_canvas: None,
                auxiliary_canvas: Some(Targets::AUXILIARY.union(Targets::PREVIEW)),
            }
        );
        let banner = recording_only(split, Some(split));
        assert_eq!(
            banner,
            WindowsD3d11ItemTargets {
                primary_canvas: Some(Targets::PRIMARY.union(Targets::PREVIEW)),
                auxiliary_canvas: None,
            }
        );
        // An item both legs burn is in the Preview once, from the primary's
        // layer; the stream leg's layer is the stream's alone.
        assert_eq!(
            item_targets_for(split, Some(split), true, true),
            WindowsD3d11ItemTargets {
                primary_canvas: Some(Targets::PRIMARY.union(Targets::PREVIEW)),
                auxiliary_canvas: Some(Targets::AUXILIARY),
            }
        );

        // Record only: a stream-only item goes nowhere, and the Preview says so.
        assert_eq!(
            stream_only(record, Some(record)),
            WindowsD3d11ItemTargets {
                primary_canvas: None,
                auxiliary_canvas: None,
            }
        );
        assert!(!program_shows(Some(record), true, false));

        // Buffer only (D2): the ring keeps the recording plan, the Preview
        // shows the idle program.
        assert_eq!(
            stream_only(record, None),
            WindowsD3d11ItemTargets {
                primary_canvas: Some(Targets::PREVIEW),
                auxiliary_canvas: None,
            }
        );
        assert_eq!(
            recording_only(record, None),
            WindowsD3d11ItemTargets {
                primary_canvas: Some(Targets::PRIMARY.union(Targets::PREVIEW)),
                auxiliary_canvas: None,
            }
        );
    }

    /// The item's targets for a session shape and a pair of switches, the
    /// way the pump's inputs are built: the leg plan with the D13 fallback
    /// (`overlay_session_plans`, `banner_leg_carries`) and `program_shows`.
    fn item_targets_for(
        shape: crate::overlay_layout::OverlaySessionShape,
        program_shape: Option<crate::overlay_layout::OverlaySessionShape>,
        show_on_stream: bool,
        show_in_recording: bool,
    ) -> WindowsD3d11ItemTargets {
        let plan = crate::overlay_layout::overlay_leg_plan(
            shape.record_enabled,
            shape.stream_enabled,
            shape.aux_leg,
            show_on_stream,
            show_in_recording,
        );
        let plan = if plan.needs_split {
            plan.shared_leg_fallback()
        } else {
            plan
        };
        windows_d3d11_item_targets(
            plan.primary,
            plan.aux,
            crate::overlay_layout::program_shows(program_shape, show_on_stream, show_in_recording),
        )
    }

    /// Plan 205 S8, the whole table: over every session shape the D3D11 path
    /// runs (record, stream, record + stream on one leg or a split leg, and
    /// a buffer-only ring) and every switch pair, the Preview draws an item
    /// exactly once when the program carries it and never otherwise, and
    /// each encoded leg's layer exists exactly when its plan burns the item.
    #[test]
    fn the_preview_bit_follows_program_shows_over_every_d3d11_session_shape() {
        use crate::overlay_layout::{OverlayAuxLeg, OverlaySessionShape, program_shows};
        use crate::windows_d3d11_compositor::WindowsD3d11SceneOutputTargets as Targets;

        let shape = |record_enabled: bool, stream_enabled: bool, aux_leg: OverlayAuxLeg| {
            OverlaySessionShape {
                record_enabled,
                stream_enabled,
                aux_leg,
            }
        };
        let sessions = [
            ("record only", shape(true, false, OverlayAuxLeg::None), true),
            ("stream only", shape(false, true, OverlayAuxLeg::None), true),
            (
                "record + stream, one leg",
                shape(true, true, OverlayAuxLeg::None),
                true,
            ),
            (
                "record + stream, split",
                shape(true, true, OverlayAuxLeg::Stream),
                true,
            ),
            (
                "buffer only",
                shape(true, false, OverlayAuxLeg::None),
                false,
            ),
        ];
        for (name, session, is_output) in sessions {
            let program_shape = is_output.then_some(session);
            for (show_on_stream, show_in_recording) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                let plan = crate::overlay_layout::overlay_leg_plan(
                    session.record_enabled,
                    session.stream_enabled,
                    session.aux_leg,
                    show_on_stream,
                    show_in_recording,
                );
                let plan = if plan.needs_split {
                    plan.shared_leg_fallback()
                } else {
                    plan
                };
                let targets =
                    item_targets_for(session, program_shape, show_on_stream, show_in_recording);
                let case =
                    format!("{name}, on_stream={show_on_stream}, in_rec={show_in_recording}");
                let in_preview = usize::from(draws_on(targets.primary_canvas, Targets::PREVIEW))
                    + usize::from(draws_on(targets.auxiliary_canvas, Targets::PREVIEW));
                assert_eq!(
                    in_preview,
                    usize::from(program_shows(
                        program_shape,
                        show_on_stream,
                        show_in_recording
                    )),
                    "{case}: the Preview draws the item once when the program carries it"
                );
                assert_eq!(
                    draws_on(targets.primary_canvas, Targets::PRIMARY),
                    plan.primary,
                    "{case}: the primary leg keeps its own plan"
                );
                assert_eq!(
                    targets.auxiliary_canvas.is_some(),
                    plan.aux,
                    "{case}: the auxiliary leg keeps its own plan"
                );
                assert!(
                    targets
                        .auxiliary_canvas
                        .is_none_or(|aux| aux.union(Targets::AUXILIARY) == aux),
                    "{case}: the auxiliary canvas layer is the auxiliary leg's"
                );
                assert!(
                    !draws_on(targets.primary_canvas, Targets::AUXILIARY)
                        && !draws_on(targets.auxiliary_canvas, Targets::PRIMARY),
                    "{case}: no layer crosses legs"
                );
            }
        }
    }

    /// Every sleep wakes a little late. Pacing each tick relative to its own
    /// start added that overshoot to every period (the GTX 1650 run measured
    /// 57.9 fps for a 60 fps pump, and the CFR writer recorded the shortfall
    /// as skipped frames); the grid absorbs it.
    #[test]
    fn render_ticks_stay_on_the_wall_clock_grid_despite_sleep_overshoot() {
        use std::time::{Duration, Instant};

        let interval = Duration::from_secs_f64(1.0 / 60.0);
        let overshoot = Duration::from_micros(600);
        let origin = Instant::now();
        let ten_seconds = origin + Duration::from_secs(10);
        let ticks_within_ten_seconds = |next_start: &mut dyn FnMut(Instant) -> Instant| {
            let mut started_at = origin;
            let mut ticks = 0;
            while started_at < ten_seconds {
                ticks += 1;
                started_at = next_start(started_at);
            }
            ticks
        };

        let relative =
            ticks_within_ten_seconds(&mut |started_at| started_at + interval + overshoot);
        assert_eq!(relative, 580, "the old pacing loses ~3% of a 60 fps pump");

        let mut due = origin;
        let grid = ticks_within_ten_seconds(&mut |started_at| {
            due = windows_d3d11_next_render_tick_due(due, started_at, interval);
            due + overshoot
        });
        assert_eq!(grid, 600);

        // A slightly late tick keeps the grid; a stalled one skips the points
        // it missed instead of bursting through them.
        assert_eq!(
            windows_d3d11_next_render_tick_due(origin, origin + overshoot, interval),
            origin + interval
        );
        assert_eq!(
            windows_d3d11_next_render_tick_due(origin, origin + interval * 5 / 2, interval),
            origin + interval * 3
        );
        assert_eq!(
            windows_d3d11_next_render_tick_due(origin + interval, origin, interval),
            origin + interval * 2,
            "an early start never moves the grid backwards"
        );
    }

    #[test]
    fn the_buddy_clock_is_the_output_sequence_over_the_fps() {
        assert_eq!(windows_d3d11_buddy_clock_seconds(0, 30), 0.0);
        assert_eq!(windows_d3d11_buddy_clock_seconds(30, 30), 1.0);
        assert_eq!(windows_d3d11_buddy_clock_seconds(90, 60), 1.5);
        // The same tick is the same time, to the bit.
        assert_eq!(
            windows_d3d11_buddy_clock_seconds(1234, 30).to_bits(),
            windows_d3d11_buddy_clock_seconds(1234, 30).to_bits()
        );
        // A tick later is one frame later.
        let step = windows_d3d11_buddy_clock_seconds(1235, 30)
            - windows_d3d11_buddy_clock_seconds(1234, 30);
        assert!((step - 1.0 / 30.0).abs() < 1e-12, "{step}");
    }

    fn request() -> WindowsD3d11SessionRequest {
        WindowsD3d11SessionRequest {
            platform_supported: true,
            screen_id: Some("screen:dxgi:00000000000003f1:2".to_string()),
            window_selected: false,
            screen_available: true,
            source_width: Some(1920),
            source_height: Some(1080),
            supported_layout: true,
            camera_required: false,
            camera_source_available: false,
            explicit_scene: false,
            unsupported_scene_features: Vec::new(),
            media_foundation_selected: true,
            record_enabled: true,
            stream_enabled: true,
            primary: WindowsD3d11VideoPlan {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 8_000,
            },
            auxiliary: None,
        }
    }

    #[test]
    fn windows_d3d11_overlay_layer_geometry_follows_the_shared_rect_oracle() {
        use crate::captions::{CaptionOverlayPosition, OverlayPlacement};
        use crate::comment_highlight::CommentHighlightAnchor;
        use crate::overlay_layout::OverlayRect;

        let legacy = |placement: OverlayPlacement, width: u32, height: u32| {
            placement.rect_for_canvas(width, height)
        };
        // 1920x1080: margin = round(1080 * 0.04) = 43 px on BOTH axes.
        let (right, crop) = windows_d3d11_overlay_layer_geometry(
            (600, 200),
            (1920, 1080),
            legacy(CommentHighlightAnchor::BottomRight.into(), 1920, 1080),
            0,
        );
        assert_eq!(right.x, (1920 - 600 - 43) as f32 / 1920.0);
        assert_eq!(right.y, (1080 - 200 - 43) as f32 / 1080.0);
        assert_eq!(right.width, 600.0 / 1920.0);
        assert_eq!(right.height, 200.0 / 1080.0);
        assert_eq!(
            (crop.left, crop.top, crop.right, crop.bottom),
            (0.0, 0.0, 0.0, 0.0)
        );

        let (left, _) = windows_d3d11_overlay_layer_geometry(
            (600, 200),
            (1920, 1080),
            legacy(CommentHighlightAnchor::TopLeft.into(), 1920, 1080),
            0,
        );
        assert_eq!(left.x, 43.0 / 1920.0);
        assert_eq!(left.y, 43.0 / 1080.0);

        // Vertical 1080x1920: side margin round(1920 * 0.04) = 77 px; the top
        // edge keeps the portrait platform safe area, round(1920 * 0.08) = 154
        // px (plan 077).
        let (vertical, _) = windows_d3d11_overlay_layer_geometry(
            (600, 200),
            (1080, 1920),
            legacy(CommentHighlightAnchor::TopRight.into(), 1080, 1920),
            0,
        );
        assert_eq!(vertical.x, (1080 - 600 - 77) as f32 / 1080.0);
        assert_eq!(vertical.y, 154.0 / 1920.0);

        // Captions stay centred and honour the collision inset.
        let (caption, _) = windows_d3d11_overlay_layer_geometry(
            (1000, 100),
            (1920, 1080),
            legacy(
                OverlayPlacement::from(CaptionOverlayPosition::Top),
                1920,
                1080,
            ),
            222,
        );
        assert_eq!(caption.x, 460.0 / 1920.0);
        assert_eq!(caption.y, (43 + 222) as f32 / 1080.0);

        // A placed rect (plan 164): the bitmap sits at the rect's top-left.
        let (placed, placed_crop) = windows_d3d11_overlay_layer_geometry(
            (200, 100),
            (1280, 720),
            OverlayRect::new(0.1, 0.2, 0.25, 0.2),
            0,
        );
        assert_eq!(placed.x, 128.0 / 1280.0);
        assert_eq!(placed.y, 144.0 / 720.0);
        assert_eq!(placed.width, 200.0 / 1280.0);
        assert_eq!(placed.height, 100.0 / 720.0);
        assert_eq!((placed_crop.left, placed_crop.right), (0.0, 0.0));

        // Over-wide overlays centre-crop to the full-canvas rect.
        let (wide, wide_crop) = windows_d3d11_overlay_layer_geometry(
            (2400, 100),
            (1920, 1080),
            OverlayRect::new(0.0, 0.0, 1.0, 1.0),
            0,
        );
        assert_eq!((wide.x, wide.width), (0.0, 1.0));
        assert_eq!((wide_crop.left, wide_crop.right), (0.1, 0.1));
    }

    #[test]
    fn windows_d3d11_ticket_source_treats_every_stopped_pump_as_terminal() {
        assert_eq!(
            windows_d3d11_terminal_source_error(Some("device removed"), true).as_deref(),
            Some("device removed")
        );
        assert_eq!(
            windows_d3d11_terminal_source_error(None, true).as_deref(),
            Some("D3D11 session pump stopped without a terminal result")
        );
        assert_eq!(windows_d3d11_terminal_source_error(None, false), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_d3d11_render_tick_overrun_accounting_is_interval_relative() {
        use std::time::Duration;

        let interval = Duration::from_millis(33);
        assert_eq!(
            runtime::tick_overrun_micros(Duration::from_millis(20), interval),
            None
        );
        assert_eq!(runtime::tick_overrun_micros(interval, interval), None);
        assert_eq!(
            runtime::tick_overrun_micros(Duration::from_millis(34), interval),
            Some(1_000)
        );
        assert_eq!(
            runtime::tick_overrun_micros(Duration::from_secs(3600), Duration::from_micros(1)),
            Some(3_599_999_999)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_d3d11_pump_snapshot_defaults_render_telemetry_to_zero() {
        let snapshot = runtime::WindowsD3d11SessionPumpSnapshot::default();
        assert_eq!(snapshot.render_ticks, 0);
        assert_eq!(snapshot.render_tick_overruns, 0);
        assert_eq!(snapshot.render_tick_lag_max_us, 0);
        assert_eq!(snapshot.render_compose_stage_max_us, 0);
        assert_eq!(snapshot.render_publish_stage_max_us, 0);
    }

    #[test]
    fn windows_d3d11_sessions_size_deep_render_pools() {
        // Screen-only sessions get the same depth as screen-camera ones (#280).
        assert_eq!(WINDOWS_D3D11_RENDER_POOL_SLOTS, 5);
    }

    #[test]
    fn windows_d3d11_media_env_selects_auto_required_and_disabled() {
        assert_eq!(
            WindowsD3d11MediaMode::from_env_values(None, None).unwrap(),
            WindowsD3d11MediaMode::Automatic
        );
        assert_eq!(
            WindowsD3d11MediaMode::from_env_values(Some("disabled"), None).unwrap(),
            WindowsD3d11MediaMode::Disabled
        );
        assert_eq!(
            WindowsD3d11MediaMode::from_env_values(Some("auto"), Some("1")).unwrap(),
            WindowsD3d11MediaMode::Required
        );
        assert!(WindowsD3d11MediaMode::from_env_values(Some("off"), Some("true")).is_err());
        assert!(WindowsD3d11MediaMode::from_env_values(Some("surprise"), None).is_err());
    }

    #[test]
    fn windows_source_presenter_liveness_distinguishes_unavailable_inputs_none_and_takeover() {
        let mut scene = crate::scene::default_scene();
        assert!(windows_scene_sources_live(
            [&scene].into_iter(),
            false,
            false,
            None
        ));
        let transform = crate::protocol::SceneTransform {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };
        scene.sources.push(crate::protocol::SceneSource {
            id: "capture".into(),
            name: "Screen".into(),
            kind: crate::protocol::SceneSourceKind::Screen,
            device_id: Some("screen:A".into()),
            transform: transform.clone(),
            default_transform: transform,
            visible: true,
            locked: false,
        });
        assert!(!windows_scene_sources_live(
            [&scene].into_iter(),
            true,
            false,
            None
        ));
        assert!(
            windows_scene_sources_live([&scene].into_iter(), false, true, None),
            "static healthy capture remains live"
        );
        scene.sources[0].kind = crate::protocol::SceneSourceKind::Camera;
        assert!(!windows_scene_sources_live(
            [&scene].into_iter(),
            false,
            true,
            None
        ));
        assert!(windows_scene_sources_live(
            [&scene].into_iter(),
            true,
            false,
            None
        ));
        assert!(windows_scene_sources_live(
            [&scene].into_iter(),
            false,
            false,
            Some(true)
        ));
        assert!(!windows_scene_sources_live(
            [&scene].into_iter(),
            true,
            true,
            Some(false)
        ));
        scene.sources[0].device_id = None;
        assert!(
            windows_scene_sources_live([&scene].into_iter(), false, false, None),
            "intentional camera None is a valid black scene"
        );
    }

    #[test]
    fn windows_d3d11_cfr_repeats_retained_static_source_at_render_cadence() {
        assert_eq!(
            WINDOWS_D3D11_CAPTURE_POLL_WAIT_MS, 0,
            "static-source CFR must not spend its 60-fps deadline blocking on capture"
        );
        let mut sequencer = WindowsD3d11CfrSequencer::default();
        let first = sequencer.advance(Some(41)).unwrap().unwrap();
        let repeats = [
            sequencer.advance(None).unwrap().unwrap(),
            sequencer.advance(None).unwrap().unwrap(),
            sequencer.advance(None).unwrap().unwrap(),
        ];

        assert_eq!(first.output_sequence, 1);
        assert_eq!(first.source_sequence, 41);
        assert!(!first.repeated_source);
        assert_eq!(
            repeats.map(|tick| (tick.output_sequence, tick.source_sequence)),
            [(2, 41), (3, 41), (4, 41)]
        );
        assert!(repeats.iter().all(|tick| tick.repeated_source));
    }

    #[test]
    fn windows_d3d11_cfr_replacement_resets_only_the_source_fence() {
        let mut sequencer = WindowsD3d11CfrSequencer::default();
        assert_eq!(
            sequencer
                .advance(Some(500))
                .unwrap()
                .unwrap()
                .output_sequence,
            1
        );
        assert_eq!(sequencer.advance(None).unwrap().unwrap().output_sequence, 2);
        sequencer.replace_source();
        assert!(sequencer.advance(None).unwrap().is_none());
        let first_b = sequencer.advance(Some(1)).unwrap().unwrap();
        assert_eq!((first_b.output_sequence, first_b.source_sequence), (3, 1));
        assert!(sequencer.advance(Some(1)).is_err());
    }

    #[test]
    fn windows_d3d11_cfr_blank_preserves_clock_after_start_but_never_supplies_startup() {
        let mut sequencer = WindowsD3d11CfrSequencer::default();
        assert!(
            sequencer.advance_blank().unwrap().is_none(),
            "delayed first acquire cannot fake startup"
        );
        assert_eq!(
            sequencer
                .advance(Some(100))
                .unwrap()
                .unwrap()
                .output_sequence,
            1
        );
        sequencer.replace_source();
        assert_eq!(
            sequencer.advance_blank().unwrap().unwrap().output_sequence,
            2
        );
        assert_eq!(
            sequencer.advance_blank().unwrap().unwrap().output_sequence,
            3
        );
        assert_eq!(
            sequencer.advance(Some(1)).unwrap().unwrap().output_sequence,
            4
        );
    }

    #[test]
    fn windows_d3d11_cfr_rejects_nonadvancing_capture_sequence() {
        let mut sequencer = WindowsD3d11CfrSequencer::default();
        assert!(sequencer.advance(None).unwrap().is_none());
        assert!(sequencer.advance(Some(7)).unwrap().is_some());
        assert!(
            sequencer
                .advance(Some(7))
                .unwrap_err()
                .contains("did not advance")
        );
    }

    #[test]
    fn windows_d3d11_supported_auto_session_gets_generation_roles() {
        let selection =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, request()).unwrap();
        let WindowsD3d11SessionSelection::Candidate(plan) = selection else {
            panic!("supported request should select D3D11");
        };
        assert_eq!(plan.primary_role, WindowsD3d11MediaRole::Stream);
        assert_eq!(
            plan.roles,
            BTreeSet::from([
                WindowsD3d11MediaRole::Compositor,
                WindowsD3d11MediaRole::Preview,
                WindowsD3d11MediaRole::Stream,
            ])
        );
    }

    #[test]
    fn windows_d3d11_split_session_assigns_record_and_stream_roles() {
        let mut request = request();
        request.auxiliary = Some(request.primary);
        let selection =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, request).unwrap();
        let WindowsD3d11SessionSelection::Candidate(plan) = selection else {
            panic!("supported split request should select D3D11");
        };
        assert_eq!(plan.primary_role, WindowsD3d11MediaRole::Record);
        assert!(plan.roles.contains(&WindowsD3d11MediaRole::Record));
        assert!(plan.roles.contains(&WindowsD3d11MediaRole::Stream));
    }

    #[test]
    fn windows_d3d11_auto_names_layout_and_window_fallbacks() {
        let mut window = request();
        window.window_selected = true;
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, window).unwrap()
        else {
            panic!("window capture should use a named fallback");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-window-capture-unsupported"
        );

        let mut scene = request();
        scene.explicit_scene = true;
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, scene).unwrap()
        else {
            panic!("explicit scene should use a named fallback");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-explicit-scene-unsupported"
        );

        let mut overlay = request();
        overlay.unsupported_scene_features = vec![
            "caption-overlay".to_string(),
            "comment-highlight-overlay".to_string(),
        ];
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, overlay).unwrap()
        else {
            panic!("unmapped shipping overlays must use one whole-session fallback");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-scene-features-unsupported"
        );
        assert!(fallback.detail.contains("caption-overlay"));
        assert!(fallback.detail.contains("comment-highlight-overlay"));
    }

    #[test]
    fn windows_d3d11_required_fails_closed_for_unsupported_session() {
        let mut unsupported = request();
        unsupported.primary.width = 1279;
        let error =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Required, unsupported).unwrap_err();
        assert!(error.contains(WINDOWS_REQUIRE_D3D11_MEDIA_ENV));
        assert!(error.contains("primary-profile-invalid"));
    }

    #[test]
    fn windows_d3d11_auto_falls_back_for_unqualified_2k_output() {
        let mut output_2k = request();
        output_2k.primary.width = 2560;
        output_2k.primary.height = 1440;
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, output_2k).unwrap()
        else {
            panic!("2K output must use the legacy bridge until D3D11 is qualified for it");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-primary-output-unqualified"
        );
        assert!(fallback.detail.contains("2560x1440"));

        let mut required_output_2k = request();
        required_output_2k.primary.width = 2560;
        required_output_2k.primary.height = 1440;
        let error =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Required, required_output_2k)
                .unwrap_err();
        assert!(error.contains("primary-output-unqualified"));
    }

    #[test]
    fn windows_d3d11_accepts_scaled_split_outputs_and_screen_camera_upload() {
        let mut scaled = request();
        scaled.source_width = Some(2560);
        scaled.source_height = Some(1440);
        scaled.primary.width = 1920;
        scaled.primary.height = 1080;
        scaled.auxiliary = Some(WindowsD3d11VideoPlan {
            width: 1280,
            height: 720,
            fps: 60,
            bitrate_kbps: 4_500,
        });
        scaled.camera_required = true;
        scaled.camera_source_available = true;
        let WindowsD3d11SessionSelection::Candidate(plan) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, scaled).unwrap()
        else {
            panic!("dimension-keyed screen-camera session should remain on D3D11");
        };
        assert_eq!((plan.source_width, plan.source_height), (2560, 1440));
        assert_eq!(
            plan.auxiliary.map(|video| (video.width, video.height)),
            Some((1280, 720))
        );
        assert!(plan.camera_required);
    }

    #[test]
    fn windows_d3d11_claim_gate_requires_every_ticket_and_encoder() {
        let WindowsD3d11SessionSelection::Candidate(plan) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, request()).unwrap()
        else {
            panic!("supported request should select D3D11");
        };
        let fallback = validate_windows_d3d11_startup_evidence(
            WindowsD3d11MediaMode::Automatic,
            &plan,
            WindowsD3d11StartupEvidence {
                capture_started: true,
                preview_ticket: true,
                primary_ticket: true,
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-primary-encoder-unattached"
        );
        assert!(
            validate_windows_d3d11_startup_evidence(
                WindowsD3d11MediaMode::Required,
                &plan,
                WindowsD3d11StartupEvidence {
                    capture_started: true,
                    preview_ticket: true,
                    primary_ticket: true,
                    ..Default::default()
                },
            )
            .is_err()
        );
    }
    /// The S-B5 draw (the CPU and Metal parity fixture's): cell 4 of the 3 x
    /// 2 atlas, 150 px from 120 px cells, turned 30 degrees, scaled 1.1 x 0.9
    /// about page-pet's pivot and nudged by (12, -7).
    fn buddy_parity_sprite() -> crate::buddy_sprite::BuddySpriteLayer {
        let atlas = std::sync::Arc::new(crate::buddy_sprite::tests::parity_atlas(120));
        let (sin, cos) = 30.0_f32.to_radians().sin_cos();
        let draw = crate::buddy_sprite::BuddySpriteDraw {
            affine: [cos * 1.1, sin * 1.1, -sin * 0.9, cos * 0.9],
            translate: [12.0, -7.0],
            ..crate::buddy_sprite::BuddySpriteDraw::at_rest(
                atlas.cell("cell-4").unwrap().rect,
                [565.0, 285.0, 150.0, 150.0],
                crate::buddy_sprite::BUDDY_SPRITE_DEFAULT_PIVOT,
            )
        };
        crate::buddy_sprite::BuddySpriteLayer { atlas, draw }
    }

    fn plan_one_layer(
        layer: crate::windows_d3d11_compositor::WindowsD3d11SceneLayerInput,
        canvas: (u32, u32),
    ) -> crate::windows_d3d11_compositor::WindowsD3d11PlannedLayer {
        use crate::windows_d3d11_compositor::{
            WindowsD3d11CanvasOrientation, WindowsD3d11OutputDimensions,
            WindowsD3d11ScenePlanRequest, build_windows_d3d11_scene_plan,
        };
        build_windows_d3d11_scene_plan(WindowsD3d11ScenePlanRequest {
            adapter_luid: crate::windows_d3d11_device::DxgiAdapterLuid::from_u64(1),
            generation: 1,
            sequence: 1,
            orientation: if canvas.0 >= canvas.1 {
                WindowsD3d11CanvasOrientation::Horizontal
            } else {
                WindowsD3d11CanvasOrientation::Vertical
            },
            canvas_dimensions: WindowsD3d11OutputDimensions::new(canvas.0, canvas.1).unwrap(),
            layers: vec![layer],
            encoded_outputs: vec![],
        })
        .unwrap()
        .layers[0]
    }

    /// Plan 168 S-B4/S-B5, the D3D11 twin on every host: the planned sprite
    /// layer and `SceneVs`'s turn (its Rust twin) put the quad's corners
    /// where the CPU and Metal paths put them, on the leg's own output and on
    /// a larger target of the same aspect; the source rect is the atlas cell.
    #[test]
    fn windows_d3d11_buddy_sprite_vertices_match_the_cpu_and_metal_quad() {
        use crate::windows_d3d11_compositor::{
            WindowsD3d11SceneOutputTargets, WindowsD3d11SceneSourceKind, windows_d3d11_scene_vertex,
        };
        let sprite = buddy_parity_sprite();
        let layer = windows_d3d11_buddy_sprite_layer(
            16,
            &sprite,
            (1280, 720),
            WindowsD3d11SceneOutputTargets::PRIMARY,
            11,
        )
        .unwrap();
        let planned = plan_one_layer(layer, (1280, 720));
        assert_eq!(
            planned.source_kind,
            WindowsD3d11SceneSourceKind::BuddySprite
        );
        assert_eq!(planned.effects.opacity, 1.0);
        let expected = sprite.draw.corners();
        for (width, height) in [(1280.0_f32, 720.0_f32), (1920.0, 1080.0)] {
            let scale = width / 1280.0;
            for (unit, want) in [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]
                .into_iter()
                .zip(expected)
            {
                let [x, y] = windows_d3d11_scene_vertex(
                    planned.destination_normalized,
                    planned.effects.sprite,
                    [1.0 / width, 1.0 / height],
                    unit,
                );
                assert!(
                    (x * width - want[0] * scale).abs() < 0.05
                        && (y * height - want[1] * scale).abs() < 0.05,
                    "corner {unit:?} at {width}x{height}: ({}, {}) vs {want:?}",
                    x * width,
                    y * height
                );
            }
        }
        let [cell_x, cell_y, cell_w, cell_h] = sprite.draw.cell;
        let (atlas_w, atlas_h) = (sprite.atlas.width as f32, sprite.atlas.height as f32);
        for (got, want) in planned.source_uv.into_iter().zip([
            cell_x as f32 / atlas_w,
            cell_y as f32 / atlas_h,
            cell_w as f32 / atlas_w,
            cell_h as f32 / atlas_h,
        ]) {
            assert!((got - want).abs() < 1e-6, "source uv {got} vs {want}");
        }
        // Every other layer keeps its exact axis-aligned vertices.
        assert_eq!(
            windows_d3d11_scene_vertex([0.25, 0.5, 0.5, 0.25], None, [1.0, 1.0], [1.0, 1.0]),
            [0.75, 0.75]
        );
    }

    /// D7: the pet hanging off the canvas edge is clipped by the rasterizer
    /// (its square stays whole), where an ordinary layer is squashed into
    /// the canvas by the planner.
    #[test]
    fn windows_d3d11_buddy_sprite_clips_at_the_canvas_edge_instead_of_squashing() {
        use crate::windows_d3d11_compositor::{
            WindowsD3d11SceneOutputTargets, WindowsD3d11SceneSourceKind,
        };
        let mut sprite = buddy_parity_sprite();
        sprite.draw = crate::buddy_sprite::BuddySpriteDraw::at_rest(
            sprite.draw.cell,
            [1200.0, 300.0, 120.0, 120.0],
            crate::buddy_sprite::BUDDY_SPRITE_DEFAULT_PIVOT,
        );
        let layer = windows_d3d11_buddy_sprite_layer(
            16,
            &sprite,
            (1280, 720),
            WindowsD3d11SceneOutputTargets::PRIMARY,
            11,
        )
        .unwrap();
        let planned = plan_one_layer(layer, (1280, 720));
        let [x, _, w, _] = planned.destination_normalized;
        assert!((x - 1200.0 / 1280.0).abs() < 1e-6);
        assert!(
            (w - 120.0 / 1280.0).abs() < 1e-6,
            "the square is not squashed"
        );
        assert!(
            x + w > 1.0,
            "it hangs off the right edge; the rasterizer clips it"
        );
        let mut squashed = layer;
        squashed.source_kind = WindowsD3d11SceneSourceKind::BuddyOverlay;
        squashed.effects.sprite = None;
        let ordinary = plan_one_layer(squashed, (1280, 720));
        assert!(
            ordinary.destination_normalized[0] + ordinary.destination_normalized[2] <= 1.0 + 1e-6
        );
        // A sprite transform on any other kind is refused.
        let mut stray = layer;
        stray.source_kind = WindowsD3d11SceneSourceKind::BuddyOverlay;
        assert!(
            crate::windows_d3d11_compositor::build_windows_d3d11_scene_plan(
                crate::windows_d3d11_compositor::WindowsD3d11ScenePlanRequest {
                    adapter_luid: crate::windows_d3d11_device::DxgiAdapterLuid::from_u64(1),
                    generation: 1,
                    sequence: 1,
                    orientation:
                        crate::windows_d3d11_compositor::WindowsD3d11CanvasOrientation::Horizontal,
                    canvas_dimensions:
                        crate::windows_d3d11_compositor::WindowsD3d11OutputDimensions::new(
                            1280, 720
                        )
                        .unwrap(),
                    layers: vec![stray],
                    encoded_outputs: vec![],
                }
            )
            .is_err()
        );
    }

    /// D16 on D3D11: the bubble sits above the pet's head through the same
    /// oracle as the CPU and Metal paths.
    #[test]
    fn windows_d3d11_buddy_bubble_sits_above_the_head_like_cpu_and_metal() {
        let anchor = crate::buddy_sprite::BuddyBubbleAnchor { x: 650.0, y: 320.0 };
        let (transform, crop) = windows_d3d11_bubble_layer_geometry((60, 40), (1280, 720), anchor);
        assert_eq!(
            crate::buddy_sprite::buddy_bubble_blit_layout(60, 40, 1280, 720, anchor),
            (0, 620, 280, 60)
        );
        assert_eq!(transform.x, 620.0 / 1280.0);
        assert_eq!(transform.y, 280.0 / 720.0);
        assert_eq!(transform.width, 60.0 / 1280.0);
        assert_eq!(transform.height, 40.0 / 720.0);
        assert_eq!(
            (crop.left, crop.top, crop.right, crop.bottom),
            (0.0, 0.0, 0.0, 0.0)
        );
    }
}
