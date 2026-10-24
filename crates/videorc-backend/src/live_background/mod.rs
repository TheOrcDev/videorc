//! Live backgrounds (plan 190): five React Bits shaders behind the screen and
//! camera, on every platform.
//!
//! A live background is a bundled picture with a shader attached. The scene's
//! `EffectiveSceneBackground.asset_id` names the look's poster
//! (`live-<id>-<look>`) and `live` names the shader, so every path that can't
//! animate (the legacy FFmpeg graph, the CPU fallbacks, a refused GPU) draws
//! the poster through the picture code that already exists.
//!
//! This module is the one source of truth all renderers share:
//!
//! - [`looks`]: the catalogue (names, looks, speeds) and the uniform packing.
//!   Every renderer gets the same nine `vec4`s per pass:
//!   - `u[0] = (target_w, target_h, phase, pixel_scale)`: the pass's render
//!     target, the shader clock and one React Bits "CSS pixel" in render
//!     pixels (`min(view) / 1080`).
//!   - `u[1] = (view_w, view_h, dim, 0)`: the background's full internal
//!     size (passes like Silk's field or Plasma's coarse trace render smaller
//!     targets) and the Dim style (0–0.8).
//!   - `u[2..9]`: per-look constants ([`looks::LiveLook::statics`]).
//! - [`sizes`]: internal render sizes (soft backgrounds render at most 1080
//!   on their short side and are drawn up; the guard halves them).
//! - [`clock`]: the phase clock (re-based on every change, never jumps).
//! - [`guard`]: the budget guard (full → half → poster, never climbs back).
//! - [`glsl`]: the GLSL ES 3.00 sources (the source of truth; the Linux
//!   renderer and the Electron previews run them as they are, Metal and D3D11
//!   run hand ports checked against golden frames rendered from them).
//!
//! Nothing here allocates or runs until a live background is applied: the
//! catalogue is built lazily on first use (the zero-cost-when-off contract).

pub mod clock;
pub mod glsl;
pub mod guard;
pub mod looks;
pub mod runtime;
pub mod sizes;

#[cfg(test)]
mod export;

pub use clock::LiveBackgroundClock;
pub use guard::{GuardLevel, LiveBackgroundGuard};
pub use looks::{
    ALL_LIVE_BACKGROUNDS, BASE_COLOR, LiveLook, UNIFORM_VEC4_COUNT, Uniforms, css_id, display_name,
    is_soft, look_or_first, looks, motion_factor, poster_asset_id, uniforms,
};
pub use runtime::{LiveBackgroundBoard, LiveBackgroundFrameInput, LiveBackgroundRuntime};
pub use sizes::{PlasmaSizes, internal_size, plasma_sizes, silk_field_size};

use crate::protocol::{LiveBackgroundSpec, LiveBackgroundStillReason};

/// `VIDEORC_LIVE_BACKGROUND_FORCE_STILL=1` forces the poster (debug builds
/// only), for smokes and A/B checks.
pub fn forced_still() -> bool {
    cfg!(debug_assertions)
        && std::env::var("VIDEORC_LIVE_BACKGROUND_FORCE_STILL")
            .map(|value| value == "1")
            .unwrap_or(false)
}

/// The still reason a renderer must report before it even tries the shader,
/// if any.
pub fn preflight_still_reason() -> Option<LiveBackgroundStillReason> {
    forced_still().then_some(LiveBackgroundStillReason::Forced)
}

/// The spec's look, falling back to the first look for an unknown one. The
/// second value is the requested look when it was unknown (for status).
pub fn resolve(spec: &LiveBackgroundSpec) -> (&'static LiveLook, Option<String>) {
    let (look, known) = look_or_first(spec.id, &spec.look);
    (look, (!known).then(|| spec.look.clone()))
}
