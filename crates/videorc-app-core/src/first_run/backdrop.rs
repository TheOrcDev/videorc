//! First-run setup's backdrop (plan 203 S4, from Electron's
//! `lib/live-background-player.ts`): Liquid Chrome in its Polished look at
//! Normal motion, moving behind the setup card.
//!
//! The rules are Electron's, one for one: thirty frames a second at most, a
//! canvas capped at 1920 on its long side, the shader's Dim under dark and
//! the picture turned around under light, a clock that starts at the
//! poster's phase (the first moving frame is the still it replaces) and is
//! held while the window is hidden, and a budget guard that steps down to
//! half size and then to the poster for the rest of setup.
//!
//! The look's constants are the backend's (`live_background/looks.rs`), as
//! `live-backgrounds.render.generated.json` exports them; a test here reads
//! that file, so a retuned look fails until these follow.

use std::time::Duration;

/// `WELCOME_BACKDROP.dimDark`.
pub const DIM_DARK: f32 = 0.3;
/// `WELCOME_BACKDROP.moreContrastDim`: what Increase Contrast adds under dark.
pub const DIM_MORE_CONTRAST: f32 = 0.2;
/// `WELCOME_BACKDROP.moreContrastBrightnessLight`: the turned-around picture
/// under Increase Contrast in light.
pub const BRIGHTNESS_LIGHT_MORE_CONTRAST: f32 = 0.85;

/// `BACKDROP_FPS`: decoration never needs more.
pub const FPS: u32 = 30;
/// One frame at [`FPS`].
pub const FRAME_INTERVAL: Duration = Duration::from_nanos(1_000_000_000 / FPS as u64);
/// `BACKDROP_MAX_CANVAS_SIDE`: the canvas's long side in device pixels. The
/// chrome is soft; the layer scales it up.
pub const MAX_CANVAS_SIDE: u32 = 1920;
/// `BACKDROP_GUARD_WINDOW_MS`.
pub const GUARD_WINDOW: Duration = Duration::from_millis(3000);
/// `BACKDROP_GUARD_SLOW_INTERVAL_MS`: a window whose median frame interval
/// is over this steps down.
pub const GUARD_SLOW_INTERVAL: Duration = Duration::from_millis(50);

/// `softMaxShortSide`: a soft background renders at most this on its short
/// side (`sizes::internal_size`).
const SOFT_MAX_SHORT_SIDE: f64 = 1080.0;
/// `UNIFORM_VEC4_COUNT`: every pass reads sixteen `vec4`s.
pub const UNIFORM_VEC4_COUNT: usize = 16;

/// Liquid Chrome, Polished (`liquid_chrome_looks`): its phase per second at
/// Normal, the phase its poster was taken at, and its constants (`u[2..16]`).
pub const RATE: f64 = 0.2;
pub const POSTER_PHASE: f64 = 1.2;
pub const STATICS: [[f32; 4]; UNIFORM_VEC4_COUNT - 2] = {
    let mut statics = [[0.0; 4]; UNIFORM_VEC4_COUNT - 2];
    statics[0] = [0.3, 3.0, 3.0, 4.0];
    statics[1] = [5.0 / 3.0, 1.0, 0.17, 1.0];
    statics[2] = [1.0, 1.0, 1.0, 1.0];
    // `BASE_COLOR`, what shows where the chrome is absent.
    statics[4] = [5.0 / 255.0, 5.0 / 255.0, 6.0 / 255.0, 0.0];
    statics
};

/// The backdrop's tone for a theme (`welcomeBackdropDim`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tone {
    /// The picture is turned around (`invert(1)`, plan 208 D3): light.
    pub inverse: bool,
    /// Dim as the shader takes it (`u[1].z`). Dark only: it darkens before
    /// the invert, so under light it would wash the chrome out.
    pub shader_dim: f32,
    /// A brightness after the invert; 1 is none. Light only.
    pub brightness: f32,
}

pub fn tone(dark: bool, more_contrast: bool) -> Tone {
    if !dark {
        return Tone {
            inverse: true,
            shader_dim: 0.0,
            brightness: if more_contrast {
                BRIGHTNESS_LIGHT_MORE_CONTRAST
            } else {
                1.0
            },
        };
    }
    let dim = DIM_DARK
        + if more_contrast {
            DIM_MORE_CONTRAST
        } else {
            0.0
        };
    Tone {
        inverse: false,
        shader_dim: dim.clamp(0.0, 0.8),
        brightness: 1.0,
    }
}

/// Why the backdrop shows its poster instead of moving
/// (`BackdropStillReason`). For the log; never words on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StillReason {
    ReducedMotion,
    /// This platform's window can't host the moving picture yet.
    Unsupported,
    NoGpu,
    ShaderCompileFailed,
    /// The GPU refused a frame (Electron's lost context).
    ContextLost,
    GpuBudget,
}

impl StillReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StillReason::ReducedMotion => "reduced-motion",
            StillReason::Unsupported => "unsupported",
            StillReason::NoGpu => "no-gpu",
            StillReason::ShaderCompileFailed => "shader-compile-failed",
            StillReason::ContextLost => "context-lost",
            StillReason::GpuBudget => "gpu-budget",
        }
    }
}

/// The canvas for a box of points (`backdropCanvasSize`): device pixels,
/// long side capped. `None` for an empty box.
pub fn canvas_size(box_width: f64, box_height: f64, scale_factor: f64) -> Option<(u32, u32)> {
    // NaN is no size either.
    let positive = |side: f64| side > 0.0;
    if !positive(box_width) || !positive(box_height) {
        return None;
    }
    let scale = if scale_factor.is_finite() {
        scale_factor.max(1.0)
    } else {
        1.0
    };
    let mut width = (box_width * scale).round().max(1.0);
    let mut height = (box_height * scale).round().max(1.0);
    let long_side = width.max(height);
    let cap = f64::from(MAX_CANVAS_SIDE);
    if long_side > cap {
        let shrink = cap / long_side;
        width = (width * shrink).round().max(1.0);
        height = (height * shrink).round().max(1.0);
    }
    Some((width as u32, height as u32))
}

/// The guard's level while the backdrop moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Full,
    Half,
}

/// The size the shader renders at for a canvas (`sizes::internal_size` for a
/// soft background): at most 1080 on its short side, halved at
/// [`Level::Half`], never under 16.
pub fn internal_size(canvas: (u32, u32), level: Level) -> (u32, u32) {
    let (width, height) = (f64::from(canvas.0.max(1)), f64::from(canvas.1.max(1)));
    let mut scale = (SOFT_MAX_SHORT_SIDE / width.min(height)).min(1.0);
    if level == Level::Half {
        scale *= 0.5;
    }
    let side = |value: f64| ((value * scale).round() as u32).max(16);
    (side(width), side(height))
}

/// The sixteen `vec4`s of the one pass (`looks::uniforms`, target = view).
pub fn uniforms(view: (u32, u32), phase: f64, dim: f32) -> [[f32; 4]; UNIFORM_VEC4_COUNT] {
    let pixel_scale = view.0.min(view.1).max(1) as f32 / 1080.0;
    let mut out = [[0.0; 4]; UNIFORM_VEC4_COUNT];
    out[0] = [view.0 as f32, view.1 as f32, phase as f32, pixel_scale];
    out[1] = [view.0 as f32, view.1 as f32, dim.clamp(0.0, 0.8), 0.0];
    out[2..].copy_from_slice(&STATICS);
    out
}

/// The phase clock (`live-background-clock.js`): starts at the poster's
/// phase, and the time spent held never shows. Time is a `Duration` since
/// whatever instant the caller counts from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Clock {
    anchor: Duration,
    anchor_phase: f64,
    held_phase: Option<f64>,
}

impl Clock {
    pub fn start(now: Duration) -> Self {
        Self {
            anchor: now,
            anchor_phase: POSTER_PHASE,
            held_phase: None,
        }
    }

    pub fn phase_at(&self, at: Duration) -> f64 {
        if let Some(held) = self.held_phase {
            return held;
        }
        self.anchor_phase + RATE * at.saturating_sub(self.anchor).as_secs_f64()
    }

    /// Freezes the phase (the window is hidden).
    pub fn hold(&mut self, now: Duration) {
        if self.held_phase.is_none() {
            self.held_phase = Some(self.phase_at(now));
        }
    }

    /// Runs again from the held phase.
    pub fn release(&mut self, now: Duration) {
        if let Some(held) = self.held_phase.take() {
            self.anchor_phase = held;
            self.anchor = now;
        }
    }
}

/// What the guard says after a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardLevel {
    Moving(Level),
    /// The poster, for the rest of setup.
    Still,
}

/// The budget guard (`recordBackdropFrame`): one window of drawn-frame
/// intervals at a time. Slow at full size drops to half; slow at half shows
/// the poster. It never climbs back.
#[derive(Debug, Clone)]
pub struct Guard {
    level: GuardLevel,
    window_start: Option<Duration>,
    intervals: Vec<Duration>,
}

impl Default for Guard {
    fn default() -> Self {
        Self {
            level: GuardLevel::Moving(Level::Full),
            window_start: None,
            intervals: Vec::new(),
        }
    }
}

impl Guard {
    pub fn level(&self) -> GuardLevel {
        self.level
    }

    /// One drawn frame, `interval` after the one before it.
    pub fn record(&mut self, interval: Duration, now: Duration) -> GuardLevel {
        let GuardLevel::Moving(level) = self.level else {
            return self.level;
        };
        let window_start = *self.window_start.get_or_insert(now);
        self.intervals.push(interval);
        if now.saturating_sub(window_start) < GUARD_WINDOW {
            return self.level;
        }
        if median(&mut self.intervals) > GUARD_SLOW_INTERVAL {
            self.level = match level {
                Level::Full => GuardLevel::Moving(Level::Half),
                Level::Half => GuardLevel::Still,
            };
        }
        self.window_start = Some(now);
        self.intervals.clear();
        self.level
    }

    /// After a pause or a resize, the intervals since are not the GPU's
    /// fault (`resetBackdropGuardWindow`).
    pub fn reset_window(&mut self) {
        self.window_start = None;
        self.intervals.clear();
    }
}

fn median(values: &mut [Duration]) -> Duration {
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        values[middle]
    } else {
        (values[middle - 1] + values[middle]) / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RENDER_JSON: &str =
        include_str!("../../../../apps/desktop/src/shared/live-backgrounds.render.generated.json");

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn the_look_is_the_backends_polished_liquid_chrome() {
        let render: serde_json::Value = serde_json::from_str(RENDER_JSON).expect("the export");
        assert_eq!(render["uniformVec4Count"], UNIFORM_VEC4_COUNT);
        assert_eq!(render["softMaxShortSide"], SOFT_MAX_SHORT_SIDE);
        let background = render["backgrounds"]
            .as_array()
            .expect("backgrounds")
            .iter()
            .find(|entry| entry["id"] == "liquid-chrome")
            .expect("Liquid Chrome");
        assert_eq!(background["soft"], true);
        let passes = background["passes"].as_array().expect("passes");
        assert_eq!(passes.len(), 1, "the backdrop draws one full-screen pass");
        assert_eq!(passes[0]["kind"], "full-screen");
        let look = background["looks"]
            .as_array()
            .expect("looks")
            .iter()
            .find(|look| look["id"] == "polished")
            .expect("Polished");
        assert_eq!(look["rate"].as_f64(), Some(RATE));
        assert_eq!(look["posterPhase"].as_f64(), Some(POSTER_PHASE));
        let statics: Vec<[f32; 4]> = look["statics"]
            .as_array()
            .expect("statics")
            .iter()
            .map(|row| {
                let row = row.as_array().expect("a vec4");
                std::array::from_fn(|at| row[at].as_f64().expect("a number") as f32)
            })
            .collect();
        assert_eq!(statics, STATICS);
    }

    #[test]
    fn dark_dims_in_the_shader_and_light_turns_the_picture_around() {
        assert_eq!(
            tone(true, false),
            Tone {
                inverse: false,
                shader_dim: 0.3,
                brightness: 1.0
            }
        );
        assert_eq!(tone(true, true).shader_dim, 0.5);
        assert_eq!(
            tone(false, false),
            Tone {
                inverse: true,
                shader_dim: 0.0,
                brightness: 1.0
            }
        );
        assert_eq!(tone(false, true).brightness, 0.85);
    }

    #[test]
    fn the_canvas_is_device_pixels_with_its_long_side_capped() {
        assert_eq!(canvas_size(800.0, 600.0, 1.0), Some((800, 600)));
        assert_eq!(canvas_size(800.0, 600.0, 2.0), Some((1600, 1200)));
        assert_eq!(canvas_size(1650.0, 962.0, 2.0), Some((1920, 1119)));
        assert_eq!(canvas_size(600.0, 1400.0, 2.0), Some((823, 1920)));
        assert_eq!(canvas_size(0.0, 600.0, 2.0), None);
        assert_eq!(canvas_size(800.0, f64::NAN, 2.0), None);
        assert_eq!(canvas_size(800.0, 600.0, f64::NAN), Some((800, 600)));
    }

    #[test]
    fn the_shader_renders_at_most_1080_on_its_short_side() {
        assert_eq!(internal_size((1920, 1119), Level::Full), (1853, 1080));
        assert_eq!(internal_size((1920, 1119), Level::Half), (927, 540));
        assert_eq!(internal_size((800, 600), Level::Full), (800, 600));
        assert_eq!(internal_size((20, 20), Level::Half), (16, 16));
    }

    #[test]
    fn the_uniforms_are_packed_as_the_backend_packs_them() {
        let packed = uniforms((1920, 1080), 3.25, 0.9);
        assert_eq!(packed[0], [1920.0, 1080.0, 3.25, 1.0]);
        assert_eq!(packed[1], [1920.0, 1080.0, 0.8, 0.0]);
        assert_eq!(packed[2..], STATICS);
        assert_eq!(uniforms((960, 540), 0.0, 0.3)[0][3], 0.5);
    }

    #[test]
    fn the_clock_starts_at_the_poster_and_a_hold_never_shows() {
        let mut clock = Clock::start(ms(1000));
        assert_eq!(clock.phase_at(ms(1000)), POSTER_PHASE);
        assert_eq!(clock.phase_at(ms(500)), POSTER_PHASE);
        assert!((clock.phase_at(ms(6000)) - (POSTER_PHASE + 1.0)).abs() < 1e-9);
        clock.hold(ms(6000));
        clock.hold(ms(7000));
        assert!((clock.phase_at(ms(60_000)) - (POSTER_PHASE + 1.0)).abs() < 1e-9);
        clock.release(ms(60_000));
        assert!((clock.phase_at(ms(65_000)) - (POSTER_PHASE + 2.0)).abs() < 1e-9);
    }

    fn run(guard: &mut Guard, from: u64, interval: u64, frames: u64) -> u64 {
        let mut now = from;
        for _ in 0..frames {
            now += interval;
            guard.record(ms(interval), ms(now));
        }
        now
    }

    #[test]
    fn a_fast_backdrop_stays_at_full_size() {
        let mut guard = Guard::default();
        run(&mut guard, 0, 33, 600);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Full));
    }

    #[test]
    fn a_slow_window_steps_down_once_and_a_second_one_shows_the_poster() {
        let mut guard = Guard::default();
        // The first frame opens the window; it closes 3 s later.
        let now = run(&mut guard, 0, 60, 50);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Full));
        let now = run(&mut guard, now, 60, 1);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Half));
        let now = run(&mut guard, now, 60, 49);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Half));
        let now = run(&mut guard, now, 60, 1);
        assert_eq!(guard.level(), GuardLevel::Still);
        run(&mut guard, now, 10, 400);
        assert_eq!(guard.level(), GuardLevel::Still, "it never climbs back");
    }

    #[test]
    fn a_few_slow_frames_in_a_fast_window_change_nothing() {
        let mut guard = Guard::default();
        let now = run(&mut guard, 0, 33, 60);
        let now = run(&mut guard, now, 400, 2);
        run(&mut guard, now, 33, 200);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Full));
    }

    #[test]
    fn a_reset_forgets_the_window_but_keeps_the_level() {
        let mut guard = Guard::default();
        let now = run(&mut guard, 0, 60, 51);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Half));
        let now = run(&mut guard, now, 60, 40);
        guard.reset_window();
        // A fresh window: 40 slow frames before the reset no longer count.
        let now = run(&mut guard, now, 60, 50);
        assert_eq!(guard.level(), GuardLevel::Moving(Level::Half));
        run(&mut guard, now, 60, 1);
        assert_eq!(guard.level(), GuardLevel::Still);
    }
}
