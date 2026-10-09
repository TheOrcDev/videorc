//! The Golem's body motion (plan 168, S-C1): a port of page-pet's
//! `runtime/motion.js` (MIT, Cristian 2026) without GSAP (D6).
//!
//! One transform owner with five channels, `x, y, angle, skew, squash`, in
//! page-pet's 180 px tuning space. Two things move them:
//!
//! - a damped spring (stiffness `300 - weight * 210`, damping
//!   `2 * sqrt(k) * (0.3 + damping * 0.8)`, 120 Hz substeps, `dt` clamped to
//!   50 ms) that carries impulses: the gaze-turn nudge (D11), D12's talk bob;
//! - a reaction envelope: page-pet's three tween segments (a 0.11 s
//!   `power2.out` crouch, a 0.19 s `power2.out` to the pose, the laugh shake
//!   as a 0.11 s `sine.inOut` yoyo) and an `elastic.out(1, 0.55 - bounce *
//!   0.25)` return (`power3.out` when bounce is 0), `(0.45 + bounce * 0.3) /
//!   speed` long, from the per-reaction pose table.
//!
//! D15's breathing (a squash sine, amplitude `0.012 * intensity`, 0.22 Hz)
//! is added while the model is idle; it fades in and out over 0.35 s so a
//! reaction never steps the scale. The output is a [`MotionTransform`] about
//! a normalized pivot (page-pet's `50% 90%`): the clamped channels (x ±20,
//! y ±26, rotation ±10 deg, skew ±7 deg, squash ±0.18, `scaleY = 1 /
//! scaleX`) with the translation scaled by `size / 180` (D10). The persona's
//! Motion intensity (0..1) multiplies every impulse and every pose; 0 is the
//! identity.
//!
//! The model is pure, allocation-free and clock-injected: the caller passes
//! `now` in seconds. The GSAP easing formulas are reimplemented from their
//! definitions (named in [`ease`]); no GSAP code is copied. The pointer drag
//! and inertia of `motion.js` are not ported (unused on stream).
//! `apps/desktop/src/shared/buddy-motion.ts` is the same model in TypeScript;
//! `protocol-fixtures/buddy-motion.json` pins both to the same samples. The
//! animator (`buddy_animator`, S-C2) drives it on stream.

use std::f64::consts::TAU;

/// page-pet's tuning constants (`motionOptions` in `runtime/page-pet.js`).
/// `strength` there is the persona's Motion intensity here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionTuning {
    /// 0..1: how springy the return is (`motion-bounce`).
    pub bounce: f64,
    /// 0..1: lowers the spring stiffness (`motion-weight`).
    pub weight: f64,
    /// 0..1: spring damping (`motion-damping`).
    pub damping: f64,
    /// 0..1: multiplies the reaction poses (`reaction-motion`).
    pub reaction: f64,
    /// 0.5..1.5: reaction playback speed (`reaction-speed`).
    pub speed: f64,
}

/// page-pet's defaults, which the plan's motion numbers were tuned with.
pub const PAGE_PET_TUNING: MotionTuning = MotionTuning {
    bounce: 0.4,
    weight: 0.45,
    damping: 0.55,
    reaction: 0.7,
    speed: 1.0,
};

impl Default for MotionTuning {
    fn default() -> Self {
        PAGE_PET_TUNING
    }
}

/// What the animator (or the app preview) configures per persona and draw.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionConfig {
    /// The persona's Motion setting, 0..1 (D10). 0 removes every transform.
    pub intensity: f64,
    /// The drawn size in pixels; translations scale by `size / 180`.
    pub size: f64,
    /// The persona's Breathing setting (D15).
    pub breathing: bool,
    /// Normalized transform origin inside the cell; page-pet's `50% 90%`.
    pub pivot: [f64; 2],
    pub tuning: MotionTuning,
}

/// page-pet's default Motion (`motion` attribute).
pub const DEFAULT_MOTION_INTENSITY: f64 = 0.45;
/// page-pet's display size the limits were tuned at.
pub const TUNING_SIZE_PX: f64 = 180.0;
/// page-pet's transform origin.
pub const DEFAULT_PIVOT: [f64; 2] = [0.5, 0.9];

impl Default for MotionConfig {
    fn default() -> Self {
        Self {
            intensity: DEFAULT_MOTION_INTENSITY,
            size: TUNING_SIZE_PX,
            breathing: true,
            pivot: DEFAULT_PIVOT,
            tuning: PAGE_PET_TUNING,
        }
    }
}

/// page-pet's `render()` clamps, in 180 px tuning units.
pub const LIMIT_X_PX: f64 = 20.0;
pub const LIMIT_Y_PX: f64 = 26.0;
pub const LIMIT_ROTATION_DEG: f64 = 10.0;
pub const LIMIT_SKEW_DEG: f64 = 7.0;
pub const LIMIT_SQUASH: f64 = 0.18;

/// D15: squash amplitude per unit intensity and the breath rate.
pub const BREATH_AMPLITUDE: f64 = 0.012;
pub const BREATH_HZ: f64 = 0.22;
/// Breathing fades in and out with this time constant (not in page-pet; it
/// keeps a reaction from stepping the scale by the breath's current value).
pub const BREATH_FADE_SECONDS: f64 = 0.35;

/// D11: a gaze change nudges the angle spring by `delta_x * 9` (page-pet's
/// `track()`), times the intensity.
pub const GAZE_TURN_ANGLE_PER_UNIT: f64 = 9.0;
/// D12: a pack without talk frames bobs on the neutral cell; each talk step
/// adds this upward y velocity (180 px units per second) times the
/// intensity. Chosen so a bob peaks near 1 px at Motion 0.45 and 180 px (a
/// 130 ms train stays near that); page-pet has no talk, so this number is ours.
pub const TALK_BOB_VELOCITY: f64 = -64.0;

/// page-pet's `nudge()` velocity clamps.
const NUDGE_LIMIT_Y: f64 = 70.0;
const NUDGE_LIMIT_ANGLE: f64 = 45.0;
/// page-pet's spring settle thresholds (position, velocity) per channel.
const SETTLE_POSITION: f64 = 0.025;
const SETTLE_VELOCITY: f64 = 0.1;
const SETTLE_SQUASH_POSITION: f64 = 0.0003;
const SETTLE_SQUASH_VELOCITY: f64 = 0.003;
/// page-pet's `step()` clamps the frame delta to 50 ms.
const MAX_STEP_SECONDS: f64 = 0.05;
const SUBSTEP_HZ: f64 = 120.0;

const X: usize = 0;
const Y: usize = 1;
const ANGLE: usize = 2;
const SKEW: usize = 3;
const SQUASH: usize = 4;
const CHANNEL_COUNT: usize = 5;
const ZERO: [f64; CHANNEL_COUNT] = [0.0; CHANNEL_COUNT];

/// page-pet's pose table: `[y, angle, squash]` per reaction id, in 180 px
/// units before the intensity and `reaction` tuning multiply them.
pub const REACTION_POSES: &[(&str, [f64; 3])] = &[
    ("surprised", [-17.0, -3.0, -0.10]),
    ("laugh", [-9.0, 3.0, 0.065]),
    ("kiss", [-4.0, 5.0, -0.025]),
    ("wink", [-4.0, -5.0, 0.035]),
    ("excited", [-20.0, 4.0, -0.11]),
    ("celebrate", [-20.0, 4.0, -0.11]),
    ("worried", [3.0, -3.0, 0.025]),
    ("confused", [-2.0, -6.0, 0.025]),
    ("annoyed", [2.0, 4.0, 0.045]),
    ("proud", [-5.0, 2.0, -0.04]),
    ("calm", [2.0, 0.0, 0.02]),
    ("sleep", [2.0, -2.0, 0.025]),
    ("wave", [-7.0, 6.0, -0.025]),
    ("dance", [-12.0, 7.0, -0.06]),
    ("shy", [3.0, -4.0, 0.04]),
    // Videorc's motion-only hop (D14's last fallback, and every reaction a
    // pack has no drawing for): not in page-pet. Stronger than its default
    // pose, because no frame change carries it.
    ("hop", [-22.0, 0.0, -0.12]),
];

/// The pose of any id not in the table (page-pet's default).
pub const DEFAULT_REACTION_POSE: [f64; 3] = [-8.0, 3.0, -0.05];

/// A blink is a frame change only; page-pet never animates it.
pub const BLINK_REACTION_ID: &str = "blink";

/// `[y, angle, squash]` for a reaction id.
pub fn reaction_pose(id: &str) -> [f64; 3] {
    REACTION_POSES
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, pose)| *pose)
        .unwrap_or(DEFAULT_REACTION_POSE)
}

/// GSAP 3 easing formulas, reimplemented from their definitions.
pub mod ease {
    use std::f64::consts::{PI, TAU};

    /// GSAP `power2.out` (Cubic.easeOut): `1 - (1 - p)^3`.
    pub fn power2_out(p: f64) -> f64 {
        1.0 - (1.0 - p).powi(3)
    }

    /// GSAP `power3.out` (Quart.easeOut): `1 - (1 - p)^4`.
    pub fn power3_out(p: f64) -> f64 {
        1.0 - (1.0 - p).powi(4)
    }

    /// GSAP `sine.in`: `1 - cos(p * pi / 2)`, exactly 1 at `p == 1`.
    fn sine_in(p: f64) -> f64 {
        if p == 1.0 {
            1.0
        } else {
            -(p * PI / 2.0).cos() + 1.0
        }
    }

    /// GSAP `sine.inOut`, built from `sine.in` the way GSAP's `_insertEase`
    /// builds every inOut: `p < 0.5 ? in(2p) / 2 : 1 - in(2(1 - p)) / 2`.
    pub fn sine_in_out(p: f64) -> f64 {
        if p < 0.5 {
            sine_in(p * 2.0) / 2.0
        } else {
            1.0 - sine_in((1.0 - p) * 2.0) / 2.0
        }
    }

    /// GSAP `elastic.out(amplitude, period)`: with `p1 = max(amplitude, 1)`,
    /// `p2 = period / min(amplitude, 1)` (0.3 when the period is 0),
    /// `p3 = p2 / (2 pi) * asin(1 / p1)`, the curve is
    /// `p1 * 2^(-10 p) * sin((p - p3) * 2 pi / p2) + 1`, exactly 1 at `p == 1`.
    pub fn elastic_out(p: f64, amplitude: f64, period: f64) -> f64 {
        if p == 1.0 {
            return 1.0;
        }
        let p1 = if amplitude >= 1.0 { amplitude } else { 1.0 };
        let period = if period != 0.0 { period } else { 0.3 };
        let p2 = period / if amplitude < 1.0 { amplitude } else { 1.0 };
        let p3 = p2 / TAU * (1.0 / p1).asin();
        p1 * 2f64.powf(-10.0 * p) * ((p - p3) * (TAU / p2)).sin() + 1.0
    }
}

/// The eases page-pet's timeline uses, by curve (GSAP names in [`ease`]).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Ease {
    /// `power2.out`.
    Cubic,
    /// `power3.out`.
    Quartic,
    /// `sine.inOut`.
    Sine,
    /// `elastic.out(1, period)`.
    Elastic { period: f64 },
}

impl Ease {
    fn apply(self, p: f64) -> f64 {
        match self {
            Ease::Cubic => ease::power2_out(p),
            Ease::Quartic => ease::power3_out(p),
            Ease::Sine => ease::sine_in_out(p),
            Ease::Elastic { period } => ease::elastic_out(p, 1.0, period),
        }
    }
}

/// One GSAP tween of the reaction timeline. `yoyo` is `repeat: 1, yoyo:
/// true`: the segment plays forward then backward, twice its duration.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Segment {
    duration: f64,
    ease: Ease,
    from: [f64; CHANNEL_COUNT],
    to: [f64; CHANNEL_COUNT],
    yoyo: bool,
}

impl Segment {
    const REST: Segment = Segment {
        duration: 0.0,
        ease: Ease::Cubic,
        from: ZERO,
        to: ZERO,
        yoyo: false,
    };

    fn span(&self) -> f64 {
        if self.yoyo {
            self.duration * 2.0
        } else {
            self.duration
        }
    }

    /// GSAP's tween ratio at `local` seconds into the segment: a yoyo
    /// iteration flips the time (`time = duration - time`) and eases the
    /// flipped time with the same ease, so the shake returns to its start.
    fn ratio(&self, local: f64) -> f64 {
        let span = self.span();
        if local <= 0.0 {
            return self.ease.apply(0.0);
        }
        if local >= span {
            let p = if self.yoyo { 0.0 } else { 1.0 };
            return self.ease.apply(p);
        }
        let time = if self.yoyo && local > self.duration {
            span - local
        } else {
            local
        };
        self.ease.apply(time / self.duration)
    }

    fn at(&self, local: f64) -> [f64; CHANNEL_COUNT] {
        let ratio = self.ratio(local);
        let mut out = ZERO;
        for (k, slot) in out.iter_mut().enumerate() {
            *slot = self.from[k] + (self.to[k] - self.from[k]) * ratio;
        }
        out
    }
}

const MAX_SEGMENTS: usize = 4;

/// page-pet's reaction timeline: up to four sequential segments.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Envelope {
    start: f64,
    segments: [Segment; MAX_SEGMENTS],
    count: usize,
    total: f64,
}

impl Envelope {
    fn ends_at(&self) -> f64 {
        self.start + self.total
    }

    fn finished(&self, now: f64) -> bool {
        now - self.start >= self.total
    }

    /// The gesture channels at `now`; zero once the timeline completed
    /// (page-pet's `onComplete` zeroes the gesture).
    fn at(&self, now: f64) -> [f64; CHANNEL_COUNT] {
        let elapsed = now - self.start;
        if elapsed >= self.total {
            return ZERO;
        }
        let mut offset = 0.0;
        for segment in &self.segments[..self.count] {
            let span = segment.span();
            if elapsed < offset + span {
                return segment.at(elapsed - offset);
            }
            offset += span;
        }
        ZERO
    }
}

/// Builds an [`Envelope`] segment by segment; `cursor` is where the next
/// segment starts (a yoyo segment ends where it began).
struct Timeline {
    envelope: Envelope,
    cursor: [f64; CHANNEL_COUNT],
}

impl Timeline {
    fn new(start: f64, from: [f64; CHANNEL_COUNT]) -> Self {
        Self {
            envelope: Envelope {
                start,
                segments: [Segment::REST; MAX_SEGMENTS],
                count: 0,
                total: 0.0,
            },
            cursor: from,
        }
    }

    fn push(&mut self, duration: f64, ease: Ease, yoyo: bool, to: [f64; CHANNEL_COUNT]) {
        let segment = Segment {
            duration,
            ease,
            from: self.cursor,
            to,
            yoyo,
        };
        self.envelope.segments[self.envelope.count] = segment;
        self.envelope.count += 1;
        self.envelope.total += segment.span();
        if !yoyo {
            self.cursor = to;
        }
    }
}

/// The clamped channel sum (spring + envelope + breath) in 180 px units.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionChannels {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub skew: f64,
    pub squash: f64,
}

/// The transform to draw the sprite with, about `pivot` (normalized cell
/// coordinates). Compose it CSS-style: translate, rotate, skewX, scale,
/// with the pivot as the origin ([`MotionTransform::css_matrix`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionTransform {
    /// Canvas pixels at the drawn size.
    pub translate_x: f64,
    pub translate_y: f64,
    /// Clockwise degrees (CSS `rotate`).
    pub rotation_deg: f64,
    /// CSS `skewX` degrees.
    pub skew_x_deg: f64,
    pub scale_x: f64,
    /// Always `1 / scale_x`: the squash preserves area.
    pub scale_y: f64,
    pub pivot: [f64; 2],
}

impl MotionTransform {
    pub fn identity(pivot: [f64; 2]) -> Self {
        Self {
            translate_x: 0.0,
            translate_y: 0.0,
            rotation_deg: 0.0,
            skew_x_deg: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            pivot,
        }
    }

    /// Exactly no motion (the pivot does not count).
    pub fn is_identity(&self) -> bool {
        self.translate_x == 0.0
            && self.translate_y == 0.0
            && self.rotation_deg == 0.0
            && self.skew_x_deg == 0.0
            && self.scale_x == 1.0
            && self.scale_y == 1.0
    }

    /// The CSS `matrix(a, b, c, d, e, f)` of `translate(tx, ty) rotate(r)
    /// skewX(s) scale(sx, sy)` about the origin. Callers move the pivot to
    /// the origin first (and back after), as `transform-origin` does.
    pub fn css_matrix(&self) -> [f64; 6] {
        let (sin, cos) = self.rotation_deg.to_radians().sin_cos();
        let tan = self.skew_x_deg.to_radians().tan();
        [
            cos * self.scale_x,
            sin * self.scale_x,
            (cos * tan - sin) * self.scale_y,
            (sin * tan + cos) * self.scale_y,
            self.translate_x,
            self.translate_y,
        ]
    }
}

/// The motion model: feed it impulses and reactions, advance it with the
/// frame clock, read the transform.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BuddyMotion {
    config: MotionConfig,
    state: [f64; CHANNEL_COUNT],
    velocity: [f64; CHANNEL_COUNT],
    spring_running: bool,
    envelope: Option<Envelope>,
    idle: bool,
    breath_gain: f64,
    last_now: Option<f64>,
}

impl Default for BuddyMotion {
    fn default() -> Self {
        Self::new(MotionConfig::default())
    }
}

impl BuddyMotion {
    pub fn new(config: MotionConfig) -> Self {
        Self {
            config,
            state: ZERO,
            velocity: ZERO,
            spring_running: false,
            envelope: None,
            idle: true,
            breath_gain: 0.0,
            last_now: None,
        }
    }

    pub fn config(&self) -> &MotionConfig {
        &self.config
    }

    /// Replace the configuration without disturbing motion in flight: a new
    /// intensity applies to the next impulse or reaction and to breathing at
    /// once, a new size rescales the output at once.
    pub fn set_config(&mut self, config: MotionConfig) {
        self.config = config;
    }

    /// page-pet's `stop()`: everything to rest, at once.
    pub fn stop(&mut self) {
        self.state = ZERO;
        self.velocity = ZERO;
        self.spring_running = false;
        self.envelope = None;
        self.breath_gain = 0.0;
    }

    /// Whether the pet rests on a gaze cell (D15: breathing runs only then).
    /// The model already treats a reaction in flight as not idle; the
    /// animator reports the frame hold after it, talking and sleep.
    pub fn set_idle(&mut self, idle: bool) {
        self.idle = idle;
    }

    #[cfg_attr(not(test), allow(dead_code))] // the TS twin's API; tests read it
    pub fn is_idle(&self) -> bool {
        self.idle
    }

    /// page-pet's `nudge(y, angle)`: velocity impulses, times the intensity,
    /// clamped to +-70 (y) and +-45 (angle).
    pub fn nudge(&mut self, y: f64, angle: f64) {
        let amount = self.config.intensity;
        if amount <= 0.0 {
            return;
        }
        self.velocity[Y] = (self.velocity[Y] + y * amount).clamp(-NUDGE_LIMIT_Y, NUDGE_LIMIT_Y);
        self.velocity[ANGLE] =
            (self.velocity[ANGLE] + angle * amount).clamp(-NUDGE_LIMIT_ANGLE, NUDGE_LIMIT_ANGLE);
        self.spring_running = true;
    }

    /// D11: the gaze moved by `delta_x` (page-pet gaze units, viewer's left
    /// negative) and the body turns a little with it.
    pub fn gaze_turn(&mut self, delta_x: f64) {
        self.nudge(0.0, delta_x * GAZE_TURN_ANGLE_PER_UNIT);
    }

    /// D12: one talk step for a pack without talk frames.
    pub fn talk_bob(&mut self) {
        self.nudge(TALK_BOB_VELOCITY, 0.0);
    }

    /// page-pet's `reaction(id)` with the on-stream origin (the foot pivot,
    /// no click): starts the envelope at `now` and returns its length in
    /// seconds (0 when nothing will move). A reaction in flight is replaced
    /// from its current values. `blink` never moves (page-pet's rule).
    pub fn react(&mut self, id: &str, now: f64) -> f64 {
        if id == BLINK_REACTION_ID {
            return 0.0;
        }
        let tuning = self.config.tuning;
        let amount = self.config.intensity * tuning.reaction;
        let from = self.gesture_at(now);
        self.envelope = None;
        if amount <= 0.0 {
            return 0.0;
        }
        let [pose_y, pose_angle, pose_squash] = reaction_pose(id);
        let speed = tuning.speed;
        let mut timeline = Timeline::new(now, from);
        // The crouch: page-pet's first tween with `impact = 0` (no click).
        let mut crouch = timeline.cursor;
        crouch[X] = 0.0;
        crouch[Y] = 3.0 * amount;
        crouch[SQUASH] = 0.045 * amount;
        crouch[ANGLE] = -pose_angle * 0.25 * amount;
        timeline.push(0.11 / speed, Ease::Cubic, false, crouch);
        // The pose.
        let mut pose = timeline.cursor;
        pose[X] = 0.0;
        pose[Y] = pose_y * amount;
        pose[ANGLE] = pose_angle * amount;
        pose[SQUASH] = pose_squash * amount;
        timeline.push(0.19 / speed, Ease::Cubic, false, pose);
        // The laugh shake, forward then back (yoyo), on y and squash only.
        if id == "laugh" {
            let mut shake = timeline.cursor;
            shake[Y] = -3.0 * amount;
            shake[SQUASH] = -0.025 * amount;
            timeline.push(0.11 / speed, Ease::Sine, true, shake);
        }
        // The return to rest.
        let ease = if tuning.bounce > 0.0 {
            Ease::Elastic {
                period: 0.55 - tuning.bounce * 0.25,
            }
        } else {
            Ease::Quartic
        };
        timeline.push((0.45 + tuning.bounce * 0.3) / speed, ease, false, ZERO);
        let envelope = timeline.envelope;
        self.envelope = Some(envelope);
        envelope.total
    }

    /// When the reaction envelope in flight completes, if any.
    pub fn reaction_ends_at(&self) -> Option<f64> {
        self.envelope.map(|envelope| envelope.ends_at())
    }

    /// Nothing is moving: the spring settled, no envelope, breath faded.
    #[cfg_attr(not(test), allow(dead_code))] // the TS twin's API; tests read it
    pub fn is_resting(&self) -> bool {
        !self.spring_running && self.envelope.is_none() && self.breath_gain == 0.0
    }

    /// page-pet's `step()`: integrate the spring from the previous call to
    /// `now` (at most 50 ms, 120 Hz substeps), settle it, fade the breath,
    /// retire a finished envelope. Returns the transform at `now`.
    pub fn advance(&mut self, now: f64) -> MotionTransform {
        let dt = match self.last_now {
            Some(last) => (now - last).clamp(0.0, MAX_STEP_SECONDS),
            None => 0.0,
        };
        self.last_now = Some(now);
        if self.spring_running {
            let tuning = self.config.tuning;
            let stiffness = 300.0 - tuning.weight * 210.0;
            let damping = 2.0 * stiffness.sqrt() * (0.3 + tuning.damping * 0.8);
            let steps = (dt * SUBSTEP_HZ).ceil().max(1.0);
            let h = dt / steps;
            for _ in 0..steps as usize {
                for (state, velocity) in self.state.iter_mut().zip(self.velocity.iter_mut()) {
                    *velocity += (-stiffness * *state - damping * *velocity) * h;
                    *state += *velocity * h;
                }
            }
            if self.spring_settled() {
                self.state = ZERO;
                self.velocity = ZERO;
                self.spring_running = false;
            }
        }
        if self.envelope.is_some_and(|envelope| envelope.finished(now)) {
            self.envelope = None;
        }
        let breathing = self.config.breathing && self.idle && self.envelope.is_none();
        let target = if breathing { 1.0 } else { 0.0 };
        self.breath_gain += (target - self.breath_gain) * (1.0 - (-dt / BREATH_FADE_SECONDS).exp());
        if (self.breath_gain - target).abs() < 1e-4 {
            self.breath_gain = target;
        }
        self.transform()
    }

    fn spring_settled(&self) -> bool {
        (0..CHANNEL_COUNT).all(|k| {
            let (position, velocity) = if k == SQUASH {
                (SETTLE_SQUASH_POSITION, SETTLE_SQUASH_VELOCITY)
            } else {
                (SETTLE_POSITION, SETTLE_VELOCITY)
            };
            self.state[k].abs() < position && self.velocity[k].abs() < velocity
        })
    }

    fn gesture_at(&self, now: f64) -> [f64; CHANNEL_COUNT] {
        match self.envelope {
            Some(envelope) => envelope.at(now),
            None => ZERO,
        }
    }

    fn breath(&self) -> f64 {
        match self.last_now {
            Some(now) if self.breath_gain > 0.0 => {
                self.breath_gain
                    * BREATH_AMPLITUDE
                    * self.config.intensity
                    * (TAU * BREATH_HZ * now).sin()
            }
            _ => 0.0,
        }
    }

    /// page-pet's `render()` sums and clamps, in 180 px units, as of the
    /// last `advance`.
    pub fn channels(&self) -> MotionChannels {
        let now = self.last_now.unwrap_or(0.0);
        let gesture = self.gesture_at(now);
        let state = self.state;
        MotionChannels {
            x: (state[X] + gesture[X]).clamp(-LIMIT_X_PX, LIMIT_X_PX),
            y: (state[Y] + gesture[Y]).clamp(-LIMIT_Y_PX, LIMIT_Y_PX),
            angle: (state[ANGLE] + gesture[ANGLE]).clamp(-LIMIT_ROTATION_DEG, LIMIT_ROTATION_DEG),
            skew: (state[SKEW] + gesture[SKEW]).clamp(-LIMIT_SKEW_DEG, LIMIT_SKEW_DEG),
            squash: (state[SQUASH] + gesture[SQUASH] + self.breath())
                .clamp(-LIMIT_SQUASH, LIMIT_SQUASH),
        }
    }

    /// The transform as of the last `advance`; the identity at intensity 0.
    pub fn transform(&self) -> MotionTransform {
        let pivot = self.config.pivot;
        if self.config.intensity <= 0.0 {
            return MotionTransform::identity(pivot);
        }
        let channels = self.channels();
        let scale = self.config.size / TUNING_SIZE_PX;
        MotionTransform {
            translate_x: channels.x * scale,
            translate_y: channels.y * scale,
            rotation_deg: channels.angle,
            skew_x_deg: channels.skew,
            scale_x: 1.0 + channels.squash,
            scale_y: 1.0 / (1.0 + channels.squash),
            pivot,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// Relative to `CARGO_MANIFEST_DIR` (the generator writes here).
    const FIXTURE_PATH: &str = "../../protocol-fixtures/buddy-motion.json";
    /// Relative to this source file.
    const FIXTURE: &str = include_str!("../../../protocol-fixtures/buddy-motion.json");
    const FIXTURE_TOLERANCE: f64 = 1e-4;
    const FIXTURE_STEP: f64 = 1.0 / 60.0;
    const FIXTURE_SAMPLES: usize = 121;
    const FIXTURE_DECIMALS: f64 = 1e5;
    const EASING_POINTS: usize = 101;

    fn pose_ids() -> Vec<&'static str> {
        REACTION_POSES.iter().map(|(id, _)| *id).collect()
    }

    /// The scripted cases both languages replay: every pose id, the default
    /// pose, a raw nudge, a gaze turn, a talk bob train, and breathing.
    fn scenarios() -> Vec<(String, bool, Vec<Value>)> {
        let mut out = Vec::new();
        for id in pose_ids().into_iter().chain(["unknown-pose"]) {
            out.push((
                format!("reaction:{id}"),
                false,
                vec![json!({ "at": 0.0, "op": "react", "reaction": id })],
            ));
        }
        out.push((
            "nudge".into(),
            false,
            vec![json!({ "at": 0.0, "op": "nudge", "y": -40.0, "angle": 12.0 })],
        ));
        out.push((
            "gaze-turn".into(),
            false,
            vec![json!({ "at": 0.0, "op": "gazeTurn", "deltaX": 1.0 })],
        ));
        let bobs = (0..9)
            .map(|i| json!({ "at": i as f64 * 0.13, "op": "talkBob" }))
            .collect();
        out.push(("talk".into(), false, bobs));
        out.push(("breathing".into(), true, Vec::new()));
        out
    }

    fn variants() -> [(f64, f64); 4] {
        [(0.45, 180.0), (0.45, 360.0), (1.0, 180.0), (1.0, 360.0)]
    }

    fn apply(model: &mut BuddyMotion, op: &Value) {
        let number = |key: &str| {
            op[key]
                .as_f64()
                .unwrap_or_else(|| panic!("op {op} needs {key}"))
        };
        let now = number("at");
        match op["op"].as_str().expect("op kind") {
            "react" => {
                model.react(op["reaction"].as_str().expect("reaction id"), now);
            }
            "nudge" => model.nudge(number("y"), number("angle")),
            "gazeTurn" => model.gaze_turn(number("deltaX")),
            "talkBob" => model.talk_bob(),
            "idle" => model.set_idle(op["idle"].as_bool().expect("idle flag")),
            other => panic!("unknown fixture op {other}"),
        }
    }

    fn replay(
        intensity: f64,
        size: f64,
        breathing: bool,
        script: &[Value],
        step: f64,
        samples: usize,
    ) -> Vec<[f64; 6]> {
        let mut model = BuddyMotion::new(MotionConfig {
            intensity,
            size,
            breathing,
            ..MotionConfig::default()
        });
        let mut next_op = 0;
        (0..samples)
            .map(|i| {
                let now = i as f64 * step;
                while next_op < script.len() && script[next_op]["at"].as_f64().unwrap() <= now {
                    apply(&mut model, &script[next_op]);
                    next_op += 1;
                }
                let t = model.advance(now);
                [
                    t.translate_x,
                    t.translate_y,
                    t.rotation_deg,
                    t.skew_x_deg,
                    t.scale_x,
                    t.scale_y,
                ]
            })
            .collect()
    }

    fn easing_table() -> Vec<(&'static str, Vec<f64>)> {
        let points = |f: &dyn Fn(f64) -> f64| {
            (0..EASING_POINTS)
                .map(|i| f(i as f64 / (EASING_POINTS - 1) as f64))
                .collect::<Vec<_>>()
        };
        vec![
            ("power2Out", points(&ease::power2_out)),
            ("power3Out", points(&ease::power3_out)),
            ("sineInOut", points(&ease::sine_in_out)),
            (
                "elasticOut(1,0.45)",
                points(&|p| ease::elastic_out(p, 1.0, 0.45)),
            ),
            (
                "elasticOut(1,0.3)",
                points(&|p| ease::elastic_out(p, 1.0, 0.3)),
            ),
            (
                "elasticOut(1,0.55)",
                points(&|p| ease::elastic_out(p, 1.0, 0.55)),
            ),
        ]
    }

    fn round(v: f64) -> f64 {
        (v * FIXTURE_DECIMALS).round() / FIXTURE_DECIMALS
    }

    fn render_fixture() -> String {
        let numbers = |row: &[f64]| {
            row.iter()
                .map(|v| round(*v).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut out = String::new();
        out.push_str("{\n");
        out.push_str("  \"$comment\": \"Generated by `cargo test -p videorc-backend buddy_motion::tests::write_shared_fixture -- --ignored` from crates/videorc-backend/src/buddy_motion.rs. Do not edit by hand. Each case replays its script (ops applied when `at` <= the sample time, before advancing) and records [translateX, translateY, rotationDeg, skewXDeg, scaleX, scaleY] every stepSeconds; Rust and TS must match within tolerance.\",\n");
        out.push_str("  \"version\": 1,\n");
        out.push_str(&format!("  \"stepSeconds\": {FIXTURE_STEP},\n"));
        out.push_str(&format!("  \"samples\": {FIXTURE_SAMPLES},\n"));
        out.push_str(&format!("  \"tolerance\": {FIXTURE_TOLERANCE},\n"));
        out.push_str(&format!(
            "  \"tuning\": {},\n",
            json!({
                "bounce": PAGE_PET_TUNING.bounce,
                "weight": PAGE_PET_TUNING.weight,
                "damping": PAGE_PET_TUNING.damping,
                "reaction": PAGE_PET_TUNING.reaction,
                "speed": PAGE_PET_TUNING.speed,
            })
        ));
        out.push_str(&format!("  \"easingPoints\": {EASING_POINTS},\n"));
        out.push_str("  \"easings\": {\n");
        let easings = easing_table();
        for (i, (name, values)) in easings.iter().enumerate() {
            let comma = if i + 1 < easings.len() { "," } else { "" };
            out.push_str(&format!("    \"{name}\": [{}]{comma}\n", numbers(values)));
        }
        out.push_str("  },\n");
        out.push_str("  \"cases\": [\n");
        let scenarios = scenarios();
        let total = scenarios.len() * variants().len();
        let mut index = 0;
        for (name, breathing, script) in &scenarios {
            for (intensity, size) in variants() {
                index += 1;
                let comma = if index < total { "," } else { "" };
                let samples = replay(
                    intensity,
                    size,
                    *breathing,
                    script,
                    FIXTURE_STEP,
                    FIXTURE_SAMPLES,
                );
                out.push_str("    {\n");
                out.push_str(&format!("      \"name\": \"{name}@{intensity}x{size}\",\n"));
                out.push_str(&format!("      \"intensity\": {intensity},\n"));
                out.push_str(&format!("      \"size\": {size},\n"));
                out.push_str(&format!("      \"breathing\": {breathing},\n"));
                out.push_str(&format!(
                    "      \"script\": {},\n",
                    Value::Array(script.clone())
                ));
                out.push_str("      \"transform\": [\n");
                for (i, row) in samples.iter().enumerate() {
                    let comma = if i + 1 < samples.len() { "," } else { "" };
                    out.push_str(&format!("        [{}]{comma}\n", numbers(row)));
                }
                out.push_str("      ]\n");
                out.push_str(&format!("    }}{comma}\n"));
            }
        }
        out.push_str("  ]\n");
        out.push_str("}\n");
        out
    }

    /// Regenerate `protocol-fixtures/buddy-motion.json` after a deliberate
    /// motion change (then update the TS side's expectations by rerunning
    /// its test): `cargo test -p videorc-backend
    /// buddy_motion::tests::write_shared_fixture -- --ignored`.
    #[test]
    #[ignore]
    fn write_shared_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH);
        std::fs::write(&path, render_fixture()).expect("write the shared motion fixture");
        println!("wrote {}", path.display());
    }

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("protocol-fixtures/buddy-motion.json is valid JSON")
    }

    #[test]
    fn shared_fixture_matches_the_rust_model() {
        let fixture = fixture();
        let step = fixture["stepSeconds"].as_f64().unwrap();
        let samples = fixture["samples"].as_u64().unwrap() as usize;
        let tolerance = fixture["tolerance"].as_f64().unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), scenarios().len() * variants().len());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let script = case["script"].as_array().unwrap();
            let got = replay(
                case["intensity"].as_f64().unwrap(),
                case["size"].as_f64().unwrap(),
                case["breathing"].as_bool().unwrap(),
                script,
                step,
                samples,
            );
            let expected = case["transform"].as_array().unwrap();
            assert_eq!(expected.len(), samples, "{name}");
            for (i, (row, want)) in got.iter().zip(expected).enumerate() {
                let want = want.as_array().unwrap();
                for (k, value) in row.iter().enumerate() {
                    let target = want[k].as_f64().unwrap();
                    assert!(
                        (value - target).abs() <= tolerance,
                        "{name} sample {i} channel {k}: rust {value} fixture {target}"
                    );
                }
            }
        }
    }

    #[test]
    fn shared_fixture_pins_the_easings_at_101_points() {
        let fixture = fixture();
        assert_eq!(
            fixture["easingPoints"].as_u64().unwrap() as usize,
            EASING_POINTS
        );
        for (name, values) in easing_table() {
            let expected = fixture["easings"][name]
                .as_array()
                .unwrap_or_else(|| panic!("fixture lacks easing {name}"));
            assert_eq!(expected.len(), EASING_POINTS, "{name}");
            for (i, (value, want)) in values.iter().zip(expected).enumerate() {
                assert!(
                    (value - want.as_f64().unwrap()).abs() <= FIXTURE_TOLERANCE,
                    "{name} point {i}: rust {value} fixture {want}"
                );
            }
        }
    }

    #[test]
    fn fixture_is_current_with_the_model() {
        // A change to the motion numbers must regenerate the fixture: the
        // scripts, variants and sample count have to match what the
        // generator would write today (the samples are compared above).
        let fixture = fixture();
        let cases = fixture["cases"].as_array().unwrap();
        let mut index = 0;
        for (name, breathing, script) in scenarios() {
            for (intensity, size) in variants() {
                let case = &cases[index];
                index += 1;
                assert_eq!(case["name"], format!("{name}@{intensity}x{size}"));
                assert_eq!(case["breathing"], Value::Bool(breathing));
                assert_eq!(case["script"], Value::Array(script.clone()), "{name}");
            }
        }
    }

    #[test]
    fn easings_hit_their_endpoints_like_gsap() {
        for f in [ease::power2_out, ease::power3_out, ease::sine_in_out] {
            assert_eq!(f(0.0), 0.0);
            assert_eq!(f(1.0), 1.0);
        }
        assert_eq!(ease::elastic_out(1.0, 1.0, 0.45), 1.0);
        assert!((ease::elastic_out(0.0, 1.0, 0.45)).abs() < 1e-12);
        // Cubic and quartic ease-outs, not quadratic (GSAP's power1 is quad).
        assert!((ease::power2_out(0.5) - 0.875).abs() < 1e-12);
        assert!((ease::power3_out(0.5) - 0.9375).abs() < 1e-12);
        assert!((ease::sine_in_out(0.5) - 0.5).abs() < 1e-12);
        // elastic.out overshoots past 1 before settling.
        let overshoot = (1..100)
            .map(|i| ease::elastic_out(i as f64 / 100.0, 1.0, 0.45))
            .fold(f64::MIN, f64::max);
        assert!(overshoot > 1.05, "elastic.out(1,0.45) peak {overshoot}");
    }

    #[test]
    fn intensity_zero_is_the_identity_for_every_reaction() {
        for id in pose_ids().into_iter().chain(["unknown-pose", "blink"]) {
            let mut model = BuddyMotion::new(MotionConfig {
                intensity: 0.0,
                ..MotionConfig::default()
            });
            assert_eq!(model.react(id, 0.0), 0.0, "{id}");
            model.gaze_turn(1.0);
            model.talk_bob();
            for i in 0..=120 {
                let t = model.advance(i as f64 / 60.0);
                assert!(t.is_identity(), "{id} at sample {i}: {t:?}");
            }
        }
    }

    #[test]
    fn intensity_zero_mid_flight_removes_the_transform_at_once() {
        let mut model = BuddyMotion::default();
        model.react("surprised", 0.0);
        assert!(!model.advance(0.2).is_identity());
        let mut config = *model.config();
        config.intensity = 0.0;
        model.set_config(config);
        assert!(model.advance(0.21).is_identity());
    }

    #[test]
    fn every_pose_id_and_the_hop_are_in_the_table_and_unknown_ids_use_the_default() {
        // page-pet's 15 poses plus Videorc's motion-only hop.
        assert_eq!(REACTION_POSES.len(), 16);
        assert_eq!(reaction_pose("hop"), [-22.0, 0.0, -0.12]);
        assert_eq!(reaction_pose("surprised"), [-17.0, -3.0, -0.10]);
        assert_eq!(reaction_pose("laugh"), [-9.0, 3.0, 0.065]);
        assert_eq!(reaction_pose("excited"), [-20.0, 4.0, -0.11]);
        assert_eq!(reaction_pose("think"), DEFAULT_REACTION_POSE);
        assert_eq!(reaction_pose(""), DEFAULT_REACTION_POSE);
    }

    #[test]
    fn envelope_lengths_follow_page_pet() {
        let mut model = BuddyMotion::default();
        // 0.11 + 0.19 + (0.45 + 0.4 * 0.3) at speed 1.
        assert!((model.react("surprised", 1.0) - 0.87).abs() < 1e-12);
        let ends_at = model.reaction_ends_at().expect("envelope in flight");
        assert!((ends_at - 1.87).abs() < 1e-12, "{ends_at}");
        // The laugh shake adds 2 x 0.11 (repeat 1, yoyo).
        assert!((model.react("laugh", 1.0) - 1.09).abs() < 1e-12);
        let mut fast = BuddyMotion::new(MotionConfig {
            tuning: MotionTuning {
                speed: 1.5,
                bounce: 0.0,
                ..PAGE_PET_TUNING
            },
            ..MotionConfig::default()
        });
        assert!((fast.react("wink", 0.0) - 0.75 / 1.5).abs() < 1e-12);
        assert_eq!(model.react("blink", 0.0), 0.0);
    }

    #[test]
    fn a_reaction_crouches_then_reaches_its_pose_then_returns_to_rest() {
        let mut model = BuddyMotion::new(MotionConfig {
            intensity: 1.0,
            breathing: false,
            ..MotionConfig::default()
        });
        model.react("surprised", 0.0);
        let amount = PAGE_PET_TUNING.reaction;
        // End of the crouch: y = 3 * amount, squash = 0.045 * amount.
        let crouch = model.advance(0.11);
        assert!(
            (crouch.translate_y - 3.0 * amount).abs() < 1e-9,
            "{crouch:?}"
        );
        assert!((crouch.scale_x - (1.0 + 0.045 * amount)).abs() < 1e-9);
        // End of the pose: y = -17 * amount, angle = -3 * amount.
        let pose = model.advance(0.30);
        assert!((pose.translate_y + 17.0 * amount).abs() < 1e-9, "{pose:?}");
        assert!((pose.rotation_deg + 3.0 * amount).abs() < 1e-9);
        assert!((pose.scale_x - (1.0 - 0.10 * amount)).abs() < 1e-9);
        assert!((pose.scale_x * pose.scale_y - 1.0).abs() < 1e-12);
        // The elastic return overshoots past rest before 0.87 s.
        let mut crossed = false;
        let mut t = 0.30;
        while t < 0.87 {
            t += 1.0 / 240.0;
            if model.advance(t).translate_y > 0.1 {
                crossed = true;
            }
        }
        assert!(crossed, "elastic.out must overshoot the rest position");
        let rest = model.advance(0.9);
        assert!(rest.is_identity(), "{rest:?}");
        assert!(model.reaction_ends_at().is_none());
    }

    #[test]
    fn the_laugh_shake_returns_to_the_pose_before_the_return() {
        let mut model = BuddyMotion::new(MotionConfig {
            intensity: 1.0,
            breathing: false,
            ..MotionConfig::default()
        });
        model.react("laugh", 0.0);
        let amount = PAGE_PET_TUNING.reaction;
        let pose = model.advance(0.30);
        let shaken = model.advance(0.41);
        let back = model.advance(0.52);
        assert!((pose.translate_y + 9.0 * amount).abs() < 1e-9);
        assert!(
            (shaken.translate_y + 3.0 * amount).abs() < 1e-9,
            "{shaken:?}"
        );
        assert!(
            (back.translate_y - pose.translate_y).abs() < 1e-9,
            "{back:?}"
        );
        assert!((back.rotation_deg - pose.rotation_deg).abs() < 1e-9);
    }

    #[test]
    fn a_new_reaction_starts_from_the_values_in_flight() {
        let mut model = BuddyMotion::new(MotionConfig {
            intensity: 1.0,
            breathing: false,
            ..MotionConfig::default()
        });
        model.react("excited", 0.0);
        let before = model.advance(0.25);
        model.react("calm", 0.25);
        let after = model.advance(0.25);
        assert!((before.translate_y - after.translate_y).abs() < 1e-9);
        assert!((before.rotation_deg - after.rotation_deg).abs() < 1e-9);
    }

    #[test]
    fn clamps_hold_and_the_squash_preserves_area() {
        let mut model = BuddyMotion::new(MotionConfig {
            intensity: 1.0,
            size: 360.0,
            breathing: false,
            ..MotionConfig::default()
        });
        for _ in 0..40 {
            model.nudge(-500.0, 500.0);
        }
        model.react("excited", 0.0);
        let mut t = 0.0;
        while t < 2.0 {
            t += 1.0 / 60.0;
            let out = model.advance(t);
            let c = model.channels();
            assert!(c.x.abs() <= LIMIT_X_PX && c.y.abs() <= LIMIT_Y_PX);
            assert!(c.angle.abs() <= LIMIT_ROTATION_DEG && c.skew.abs() <= LIMIT_SKEW_DEG);
            assert!(c.squash.abs() <= LIMIT_SQUASH);
            assert!(out.translate_y.abs() <= LIMIT_Y_PX * 2.0 + 1e-9);
            assert!((out.scale_x * out.scale_y - 1.0).abs() < 1e-12);
            assert!(
                (out.translate_y - c.y * 2.0).abs() < 1e-9,
                "size scales translation"
            );
        }
    }

    #[test]
    fn a_nudge_is_clamped_and_multiplied_by_the_intensity() {
        let mut model = BuddyMotion::default();
        model.nudge(-1000.0, 1000.0);
        assert_eq!(model.velocity[Y], -NUDGE_LIMIT_Y);
        assert_eq!(model.velocity[ANGLE], NUDGE_LIMIT_ANGLE);
        let mut half = BuddyMotion::new(MotionConfig {
            intensity: 0.5,
            ..MotionConfig::default()
        });
        half.nudge(-20.0, 4.0);
        assert_eq!(half.velocity[Y], -10.0);
        assert_eq!(half.velocity[ANGLE], 2.0);
        half.gaze_turn(-0.5);
        assert_eq!(half.velocity[ANGLE], 2.0 - 2.25);
    }

    #[test]
    fn the_spring_settles_to_exact_zero_and_rests() {
        let mut model = BuddyMotion::new(MotionConfig {
            breathing: false,
            ..MotionConfig::default()
        });
        model.talk_bob();
        let mut peak: f64 = 0.0;
        let mut t = 0.0;
        while t < 3.0 {
            t += 1.0 / 60.0;
            peak = peak.max(-model.advance(t).translate_y);
        }
        assert!(peak > 0.5 && peak < 2.5, "one talk bob peaks at {peak} px");
        assert!(model.is_resting());
        assert!(model.transform().is_identity());
    }

    #[test]
    fn a_large_frame_gap_integrates_at_most_50_ms() {
        let mut a = BuddyMotion::new(MotionConfig {
            breathing: false,
            ..MotionConfig::default()
        });
        let mut b = a;
        a.nudge(-60.0, 0.0);
        b.nudge(-60.0, 0.0);
        a.advance(0.0);
        b.advance(0.0);
        let gap = a.advance(5.0);
        let clamped = b.advance(0.05);
        assert!((gap.translate_y - clamped.translate_y).abs() < 1e-12);
    }

    #[test]
    fn breathing_fades_in_only_while_idle_and_never_during_a_reaction() {
        let mut model = BuddyMotion::default();
        model.advance(0.0);
        assert!(model.transform().is_identity());
        let mut t = 0.0;
        let mut seen = 0.0f64;
        while t < 2.0 {
            t += 1.0 / 60.0;
            let out = model.advance(t);
            seen = seen.max((out.scale_x - 1.0).abs());
            assert_eq!(out.translate_x, 0.0);
            assert_eq!(out.rotation_deg, 0.0);
        }
        let amplitude = BREATH_AMPLITUDE * DEFAULT_MOTION_INTENSITY;
        assert!(
            seen > amplitude * 0.9 && seen <= amplitude + 1e-12,
            "breath {seen}"
        );
        // A reaction fades the breath out under the pose instead of
        // stepping it; by the end of the envelope it is nearly gone.
        let before = model.breath_gain;
        model.react("calm", t);
        let end = t + 0.85;
        while t < end {
            t += 1.0 / 60.0;
            model.advance(t);
        }
        let during = model.breath_gain;
        assert!(before > 0.9 && during < 0.15, "{before} -> {during}");
        // Once the envelope ends the pet is idle again and the breath comes back.
        while t < end + 1.0 {
            t += 1.0 / 60.0;
            model.advance(t);
        }
        assert!(model.breath_gain > 0.5, "{during} -> {}", model.breath_gain);
        // Not idle (a frame hold, talking, sleep): the breath fades to zero.
        let mut awake = BuddyMotion::default();
        for i in 0..=240 {
            awake.advance(i as f64 / 60.0);
        }
        assert_eq!(awake.breath_gain, 1.0);
        awake.set_idle(false);
        for i in 1..=240 {
            awake.advance(4.0 + i as f64 / 60.0);
        }
        assert_eq!(awake.breath_gain, 0.0);
        assert!(awake.transform().is_identity());
        // Breathing off in the persona never breathes.
        let mut still = BuddyMotion::new(MotionConfig {
            breathing: false,
            ..MotionConfig::default()
        });
        for i in 0..=180 {
            assert!(still.advance(i as f64 / 60.0).is_identity());
        }
    }

    #[test]
    fn css_matrix_composes_rotate_skew_scale() {
        let identity = MotionTransform::identity(DEFAULT_PIVOT).css_matrix();
        assert_eq!(identity, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let turned = MotionTransform {
            rotation_deg: 90.0,
            translate_x: 3.0,
            translate_y: -4.0,
            ..MotionTransform::identity(DEFAULT_PIVOT)
        }
        .css_matrix();
        assert!((turned[0]).abs() < 1e-12 && (turned[1] - 1.0).abs() < 1e-12);
        assert!((turned[2] + 1.0).abs() < 1e-12 && (turned[3]).abs() < 1e-12);
        assert_eq!(&turned[4..], &[3.0, -4.0]);
        let scaled = MotionTransform {
            scale_x: 1.1,
            scale_y: 1.0 / 1.1,
            skew_x_deg: 45.0,
            ..MotionTransform::identity(DEFAULT_PIVOT)
        }
        .css_matrix();
        assert!((scaled[0] - 1.1).abs() < 1e-12);
        assert!(
            (scaled[2] - 1.0 / 1.1).abs() < 1e-12,
            "skewX(45) puts tan = 1 in c"
        );
        assert!((scaled[3] - 1.0 / 1.1).abs() < 1e-12);
    }

    #[test]
    fn stop_returns_to_rest_at_once() {
        let mut model = BuddyMotion::default();
        model.react("dance", 0.0);
        model.nudge(-50.0, 20.0);
        model.advance(0.2);
        assert!(!model.transform().is_identity());
        model.stop();
        assert!(model.is_resting());
        assert!(model.transform().is_identity());
    }
}
