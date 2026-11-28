//! First-run setup (plan 260 Phase 3, L4): the full-window welcome from
//! `videorc_app_core::first_run` (#1766), drawn with `videorc-kit`. Words
//! match Electron's `components/first-run/*` and `lib/first-run.ts`.

pub(crate) mod backdrop;
pub(crate) mod pictures;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, ColorSpace, Context, Entity, EventEmitter, FocusHandle, FontWeight, Image,
    ImageFormat, ObjectFit, SharedString, Subscription, Window, WindowControlArea, div, img,
    linear_color_stop, linear_gradient, prelude::*, px, relative,
};
use videorc_app_core::assets;
use videorc_app_core::desktop::permissions::{
    MediaAccessStatus, PermissionPlatform, SystemPermissionPane,
};
use videorc_app_core::desktop::system_access::{
    SystemAccessAction, SystemAccessContext, SystemAccessInput, SystemAccessRowId,
    SystemAccessState, is_media_access_snapshot_ready, row_action, system_access_action_label,
    system_access_rows, system_access_status, system_access_visible_detail,
};
use videorc_app_core::first_run::backdrop::{self as backdrop_rules, StillReason};
use videorc_app_core::first_run::{self as fr, Goal, Leave, SetupMode, Step};
use videorc_app_core::format::device_noun;
use videorc_app_core::livestream::accounts::{
    AccountStatus, oauth_unavailable_reason, platform_label,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::protocol::DeviceKind;
use videorc_app_core::scenes::thumb::{ThumbCorner, ThumbPart, ThumbSize, card_frame, thumb_areas};
use videorc_app_core::scenes::v2::LAYOUT_PRESET_LABELS;
use videorc_app_core::studio::audio_mixer::{
    MICROPHONE_GAIN_RANGE, MeterBallistics, MeterView, format_db,
};
use videorc_app_core::studio::settings::SettingWrite;
use videorc_app_core::studio::source_selection::SourceKind;
use videorc_app_core::{BackendClient, Logger, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::chat_platform::ChatPlatform;
use videorc_kit::chrome::{box_shadow, focus_ring};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::GroupedList;
use videorc_kit::motion::{Glass, floating};
use videorc_kit::platform_glyph::PlatformGlyph;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::Select;
use videorc_kit::skeleton::Skeleton;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::spinner::Spinner;
use videorc_kit::status_badge::StatusBadge;
use videorc_kit::status_dot::StatusTone;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Shadow, Theme, radius, size, text};
use videorc_kit::tooltip::tooltip;

use crate::app::permissions::Permissions;
use crate::screens::studio::audio::meter::segmented_meter;

pub type AppStudio = Studio<BackendClient>;

const SETUP_PLATFORMS: [&str; 4] = ["youtube", "twitch", "kick", "x"];
const METER_TICK: Duration = Duration::from_millis(33);
const ROWS_FALLBACK_MS: u64 = 5_000;

/// Step titles (`FIRST_RUN_STEP_TITLES`).
pub fn step_title(step: Step) -> &'static str {
    match step {
        Step::Permissions => "Welcome to Videorc",
        Step::Goal => "What are you making?",
        Step::Look => "Your look",
        Step::Sound => "Sound check",
        Step::Destinations => "Where you stream",
    }
}

fn permissions_description(platform: &str) -> &'static str {
    match platform {
        "darwin" => {
            "First, let Videorc record your Mac. macOS asks once for each, and you can change them later in Settings → Permissions."
        }
        "win32" => {
            "First, check that Windows lets Videorc use your camera and microphone. You can change this later in Settings → Permissions."
        }
        _ => {
            "Linux keeps no capture permissions for apps, so there is nothing to grant here. Your desktop may ask when Videorc starts capturing the screen."
        }
    }
}

fn goal_description() -> &'static str {
    "Pick what you'll do most. It only changes the next steps."
}

fn look_description() -> &'static str {
    "How you'll look in recordings and livestreams. Change it any time on the Scene page."
}

fn sound_description() -> &'static str {
    "Pick your microphone and talk the way you will when you record."
}

fn destinations_description() -> &'static str {
    "Sign in, and Videorc sets your title and gets the stream key for you. Each one you connect is turned on for Go Live."
}

fn step_description(step: Step, platform: &str) -> &'static str {
    match step {
        Step::Permissions => permissions_description(platform),
        Step::Goal => goal_description(),
        Step::Look => look_description(),
        Step::Sound => sound_description(),
        Step::Destinations => destinations_description(),
    }
}

fn next_label(mode: SetupMode, last: bool) -> &'static str {
    if !last {
        "Continue"
    } else if matches!(mode, SetupMode::Replay { .. }) {
        "Done"
    } else {
        "Open Studio"
    }
}

fn first_run_suppressed() -> bool {
    std::env::var("VIDEORC_SMOKE_SKIP_FIRST_RUN")
        .ok()
        .as_deref()
        == Some("1")
}

fn setting_text(studio: &AppStudio, key: &str) -> Option<String> {
    studio.read_ui_settings(|settings| settings.read_string(key))
}

fn flush_writes(
    studio: Arc<AppStudio>,
    runtime: &tokio::runtime::Handle,
    writes: Vec<(String, String)>,
) {
    if writes.is_empty() {
        return;
    }
    runtime.spawn(async move {
        let batch: Vec<_> = writes
            .into_iter()
            .map(|(key, value)| SettingWrite::text(&key, value))
            .collect();
        let _ = studio.write_settings(batch).await;
    });
}

struct BufStore {
    values: BTreeMap<String, String>,
    dirty: Vec<(String, String)>,
}

impl BufStore {
    fn from_studio(studio: &AppStudio) -> Self {
        let mut values = BTreeMap::new();
        for key in [
            fr::FIRST_RUN_KEY,
            fr::ONBOARDING_KEY,
            fr::WHATS_NEW_LAST_SEEN_KEY,
        ] {
            if let Some(text) = setting_text(studio, key) {
                values.insert(key.to_string(), text);
            }
        }
        Self {
            values,
            dirty: Vec::new(),
        }
    }

    fn take_dirty(self) -> Vec<(String, String)> {
        self.dirty
    }
}

impl fr::FirstRunStore for BufStore {
    fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    fn set(&mut self, key: &str, value: &str) {
        self.values.insert(key.to_string(), value.to_string());
        self.dirty.push((key.to_string(), value.to_string()));
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Shell opens Destinations or another page after setup.
#[derive(Debug, Clone, Copy)]
pub struct OpenPage(pub PageId);

pub struct FirstRunScreen {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    permissions: Arc<Permissions>,
    open: bool,
    mode: SetupMode,
    step: Step,
    goal: Option<Goal>,
    orientation: Orientation,
    camera_shape: CameraShape,
    live_background: Option<&'static str>,
    layout_preset: Option<String>,
    startup: Option<fr::FirstRunStartup>,
    auto_decided: bool,
    opened_at: Option<Instant>,
    pending_permission: Option<SystemPermissionPane>,
    samples: Vec<fr::sound::Sample>,
    mic_meter: MeterBallistics,
    mic_view: MeterView,
    mic_gain: Entity<SliderState>,
    settling: bool,
    /// The Liquid Chrome poster turned around for light, made once off the
    /// main thread the first time setup opens.
    inverted_poster: Option<Arc<Image>>,
    poster_started: bool,
    /// The backdrop: the poster, or Liquid Chrome moving over it
    /// (`backdrop.rs`). The player lives only while setup is open and the
    /// picture moves.
    backdrop_mode: backdrop::Mode,
    #[cfg(target_os = "macos")]
    backdrop_player: Option<backdrop::Player>,
    /// Which player's events still count: one per opening of setup.
    backdrop_run: u64,
    /// Redraws when the window is hidden or shown, so the player holds.
    backdrop_visibility: Option<Subscription>,
    logger: Logger,
    /// Keyboard focus (`first-run-setup.tsx`): the Goal rows, Up and Down
    /// moving between them, and Look's first background card.
    goal_focus: [FocusHandle; 3],
    look_focus: FocusHandle,
    /// The first enabled control in Permissions, Sound and Destinations'
    /// body (a grant button, the microphone, Sign in…), and the primary.
    body_focus: FocusHandle,
    primary_focus: FocusHandle,
    /// The step that already took the keyboard (`shownStep`), so a step
    /// focuses its control once, when it appears.
    focused_step: Option<Step>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Orientation {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CameraShape {
    Rectangle,
    Rounded,
    Circle,
}

impl EventEmitter<OpenPage> for FirstRunScreen {}

impl FirstRunScreen {
    pub fn new(
        studio: Arc<AppStudio>,
        permissions: Arc<Permissions>,
        runtime: tokio::runtime::Handle,
        logger: Logger,
        cx: &mut Context<Self>,
    ) -> Self {
        let studio_watch = studio.clone();
        let levels = studio.mic_levels();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            let mut levels_rx = levels;
            loop {
                tokio::select! {
                    changed = studio_rx.changed() => if changed.is_err() { break },
                    changed = levels_rx.changed() => if changed.is_err() { break },
                }
                let _ = this.update(cx, |screen, cx| {
                    screen.on_tick(cx);
                });
            }
        })
        .detach();

        let gain = studio.snapshot().settings.capture.audio.microphone_gain_db;
        let mic_gain = cx.new(|_| {
            SliderState::new()
                .min(MICROPHONE_GAIN_RANGE.0)
                .max(MICROPHONE_GAIN_RANGE.1)
                .step(1.0)
                .default_value(gain)
        });
        cx.subscribe(&mic_gain, |this, _, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
            };
            let studio = this.studio.clone();
            this.runtime
                .spawn(async move { studio.set_microphone_gain(value).await });
            cx.notify();
        })
        .detach();

        let mut screen = Self {
            studio,
            runtime,
            permissions,
            open: false,
            mode: SetupMode::FirstRun,
            step: Step::Permissions,
            goal: None,
            orientation: Orientation::Horizontal,
            camera_shape: CameraShape::Rectangle,
            live_background: None,
            layout_preset: None,
            startup: None,
            auto_decided: false,
            opened_at: None,
            pending_permission: None,
            samples: Vec::new(),
            mic_meter: MeterBallistics::default(),
            mic_view: MeterView::default(),
            mic_gain,
            settling: false,
            inverted_poster: None,
            poster_started: false,
            backdrop_mode: backdrop::Mode::Starting,
            #[cfg(target_os = "macos")]
            backdrop_player: None,
            backdrop_run: 0,
            backdrop_visibility: None,
            logger,
            goal_focus: std::array::from_fn(|_| cx.focus_handle()),
            look_focus: cx.focus_handle(),
            body_focus: cx.focus_handle(),
            primary_focus: cx.focus_handle(),
            focused_step: None,
        };
        screen.try_auto_show(cx);
        screen
    }

    // Used by macOS preview restoration, the Linux overlay cover probe and
    // the Windows scene follower (no captures while setup shows).
    pub fn is_open(&self) -> bool {
        self.open
    }

    fn on_tick(&mut self, cx: &mut Context<Self>) {
        self.try_auto_show(cx);
        if self.open {
            self.sample_mic(cx);
        }
        cx.notify();
    }

    fn try_auto_show(&mut self, cx: &mut Context<Self>) {
        if self.auto_decided || self.open {
            return;
        }
        if !self.studio.snapshot().settings.hydrated {
            return;
        }
        let mut store = BufStore::from_studio(&self.studio);
        let mut startup = fr::FirstRunStartup::new(&store);
        let runtime = fr::Runtime {
            platform: self.platform().to_string(),
            first_run_suppressed: first_run_suppressed(),
        };
        let show = startup.finalize(&mut store, Some(&runtime)) == Some(true);
        flush_writes(self.studio.clone(), &self.runtime, store.take_dirty());
        self.startup = Some(startup);
        self.auto_decided = true;
        if show {
            let step = self
                .startup
                .as_ref()
                .map(|s| s.step())
                .unwrap_or(Step::Permissions);
            let goal = self.startup.as_ref().and_then(|s| s.goal());
            self.open_first_run(step, goal, cx);
        }
    }

    fn with_store(&mut self, f: impl FnOnce(&mut fr::FirstRunStartup, &mut BufStore)) {
        let Some(startup) = self.startup.as_mut() else {
            return;
        };
        let mut store = BufStore::from_studio(&self.studio);
        f(startup, &mut store);
        flush_writes(self.studio.clone(), &self.runtime, store.take_dirty());
    }

    fn persist_step(&mut self) {
        let step = self.step;
        let mode = self.mode;
        self.with_store(|startup, store| startup.enter_step(store, step, mode));
    }

    fn persist_goal(&mut self, goal: Goal) {
        let mode = self.mode;
        self.with_store(|startup, store| startup.set_goal(store, goal, mode));
    }

    fn persist_complete(&mut self, completion: fr::Completion) {
        let mode = self.mode;
        self.with_store(|startup, store| startup.complete(store, completion, mode));
    }

    pub fn open_replay(&mut self, return_to: PageId, cx: &mut Context<Self>) {
        if self.studio.snapshot().session.phase.is_active() {
            return;
        }
        let platform = Some(self.platform());
        self.mode = SetupMode::Replay { return_to };
        self.goal = setting_text(&self.studio, fr::FIRST_RUN_KEY)
            .as_deref()
            .and_then(|value| fr::parse_record(Some(value)))
            .and_then(|record| record.goal);
        self.step = fr::steps_for(self.goal, platform)[0];
        let was_open = self.open;
        self.open = true;
        self.focused_step = None;
        self.opened_at = Some(Instant::now());
        self.samples.clear();
        self.studio.set_clips_first_run_setup_open(true);
        self.prepare_poster(cx);
        // A setup already open keeps its moving picture.
        if !was_open {
            self.reset_backdrop();
        }
        cx.notify();
    }

    pub fn open_first_run(&mut self, step: Step, goal: Option<Goal>, cx: &mut Context<Self>) {
        let platform = Some(self.platform());
        self.mode = SetupMode::FirstRun;
        self.goal = goal;
        let steps = fr::steps_for(goal, platform);
        self.step = steps
            .into_iter()
            .find(|candidate| *candidate >= step)
            .unwrap_or(Step::Permissions);
        let was_open = self.open;
        self.open = true;
        self.focused_step = None;
        self.opened_at = Some(Instant::now());
        self.samples.clear();
        self.studio.set_clips_first_run_setup_open(true);
        if self.startup.is_none() {
            let store = BufStore::from_studio(&self.studio);
            self.startup = Some(fr::FirstRunStartup::new(&store));
        }
        self.persist_step();
        self.prepare_poster(cx);
        // A setup already open keeps its moving picture.
        if !was_open {
            self.reset_backdrop();
        }
        cx.notify();
    }

    /// The backdrop as a fresh opening of setup finds it, and as a closed
    /// setup leaves it: no player, no thread, nothing on the GPU.
    fn reset_backdrop(&mut self) {
        self.backdrop_mode = backdrop::Mode::Starting;
        self.backdrop_run += 1;
        #[cfg(target_os = "macos")]
        {
            self.backdrop_player = None;
        }
    }

    /// The poster stays, and the log says why (once per reason).
    fn backdrop_still(&mut self, reason: StillReason, detail: Option<String>) {
        if self.backdrop_mode != backdrop::Mode::Still(reason) {
            self.logger
                .info(backdrop::still_line(reason, detail.as_deref()));
        }
        self.backdrop_mode = backdrop::Mode::Still(reason);
        #[cfg(target_os = "macos")]
        {
            self.backdrop_player = None;
        }
    }

    // Only the macOS player sends events so far.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn on_backdrop(&mut self, run: u64, event: backdrop::Event, cx: &mut Context<Self>) {
        if run != self.backdrop_run || !self.open {
            return;
        }
        match event {
            backdrop::Event::FirstFrame => {
                if self.backdrop_mode == backdrop::Mode::Starting {
                    self.backdrop_mode = backdrop::Mode::Moving;
                }
            }
            backdrop::Event::Still(reason, detail) => self.backdrop_still(reason, detail),
        }
        cx.notify();
    }

    /// Keeps the backdrop in step with what the screen is about to draw:
    /// starts the player the first time motion is allowed, hands it the
    /// theme, the window's visibility and its size, and takes it down under
    /// reduced motion (`WelcomeBackdrop`'s effects).
    fn sync_backdrop(
        &mut self,
        frame: backdrop::Frame,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.backdrop_visibility.is_none() {
            self.backdrop_visibility =
                Some(cx.observe_window_visibility(window, |_, _, _, cx| cx.notify()));
        }
        if frame.reduced_motion {
            self.backdrop_still(StillReason::ReducedMotion, None);
            return;
        }
        if self.backdrop_mode == backdrop::Mode::Still(StillReason::ReducedMotion) {
            // Motion is allowed again: a new player, from the poster.
            self.backdrop_mode = backdrop::Mode::Starting;
            self.backdrop_run += 1;
        }
        if matches!(self.backdrop_mode, backdrop::Mode::Still(_)) {
            return;
        }
        #[cfg(target_os = "macos")]
        {
            if let Some(player) = self.backdrop_player.as_mut() {
                player.sync(frame);
                return;
            }
            match backdrop::Player::start(frame, window, cx) {
                Ok((player, mut events)) => {
                    self.backdrop_player = Some(player);
                    let run = self.backdrop_run;
                    cx.spawn(async move |this, cx| {
                        while let Some(event) = events.recv().await {
                            let told = this.update(cx, |screen, cx| {
                                screen.on_backdrop(run, event, cx);
                            });
                            if told.is_err() {
                                break;
                            }
                        }
                    })
                    .detach();
                }
                Err((reason, detail)) => self.backdrop_still(reason, detail),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window;
            self.backdrop_still(StillReason::Unsupported, None);
        }
    }

    /// Turns the backdrop's poster around for light, once, off the main
    /// thread (`welcomeBackdropPictureFilter`'s `invert(1)`).
    fn prepare_poster(&mut self, cx: &mut Context<Self>) {
        if self.poster_started {
            return;
        }
        self.poster_started = true;
        cx.spawn(async move |this, cx| {
            let png = cx
                .background_executor()
                .spawn(async move { pictures::inverted_poster_png() })
                .await;
            let _ = this.update(cx, |screen, cx| {
                screen.inverted_poster =
                    png.map(|bytes| Arc::new(Image::from_bytes(ImageFormat::Png, bytes)));
                cx.notify();
            });
        })
        .detach();
    }

    fn platform(&self) -> &'static str {
        crate::app::hotkeys::node_platform()
    }

    /// The moving picture, once it has a frame to show.
    fn backdrop_picture(&self) -> Option<AnyElement> {
        if self.backdrop_mode != backdrop::Mode::Moving {
            return None;
        }
        #[cfg(target_os = "macos")]
        {
            let player = self.backdrop_player.as_ref()?;
            Some(
                div()
                    .absolute()
                    .inset_0()
                    .child(player.element())
                    .into_any_element(),
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    fn leave(&mut self, leave: Leave, cx: &mut Context<Self>) {
        self.open = false;
        // The shader stops with setup.
        self.reset_backdrop();
        self.studio.set_clips_first_run_setup_open(false);
        self.persist_complete(leave.completion);
        if let Some(page) = leave.open_page {
            cx.emit(OpenPage(page));
        } else if let SetupMode::Replay { return_to } = self.mode {
            cx.emit(OpenPage(return_to));
        } else {
            cx.emit(OpenPage(PageId::Studio));
        }
        cx.notify();
    }

    fn skip(&mut self, cx: &mut Context<Self>) {
        self.leave(
            Leave {
                completion: fr::Completion::Skipped,
                open_page: None,
            },
            cx,
        );
    }

    fn go_next(&mut self, cx: &mut Context<Self>) {
        let platform = Some(self.platform());
        match fr::next_step(self.step, self.goal, platform) {
            Some(step) => {
                self.step = step;
                self.persist_step();
                cx.notify();
            }
            None => self.leave(
                Leave {
                    completion: fr::Completion::Done,
                    open_page: None,
                },
                cx,
            ),
        }
    }

    fn go_back(&mut self, cx: &mut Context<Self>) {
        let platform = Some(self.platform());
        if let Some(step) = fr::previous_step(self.step, self.goal, platform) {
            self.step = step;
            self.persist_step();
            cx.notify();
        }
    }

    fn go_to(&mut self, step: Step, cx: &mut Context<Self>) {
        let platform = Some(self.platform());
        if fr::steps_for(self.goal, platform).contains(&step) {
            self.step = step;
            self.persist_step();
            cx.notify();
        }
    }

    fn pick_goal(&mut self, goal: Goal, cx: &mut Context<Self>) {
        self.goal = Some(goal);
        self.persist_goal(goal);
        let platform = Some(self.platform());
        match fr::next_step(Step::Goal, Some(goal), platform) {
            Some(step) => {
                self.step = step;
                self.persist_step();
                cx.notify();
            }
            None => self.go_next(cx),
        }
    }

    fn pick_microphone(&mut self, id: String, cx: &mut Context<Self>) {
        if self.studio.snapshot().session.phase.is_active() {
            return;
        }
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .select_source_device(
                    SourceKind::Microphone,
                    (!id.is_empty()).then_some(id.as_str()),
                )
                .await;
        });
        cx.notify();
    }

    fn set_system_audio(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.studio.snapshot().session.phase.is_active() {
            return;
        }
        let studio = self.studio.clone();
        self.runtime
            .spawn(async move { studio.set_system_audio_enabled(enabled).await });
        cx.notify();
    }

    fn set_layout(&mut self, preset: String, cx: &mut Context<Self>) {
        if self.studio.snapshot().session.phase.is_active() {
            return;
        }
        self.layout_preset = Some(preset.clone());
        let studio = self.studio.clone();
        self.runtime
            .spawn(async move { studio.apply_layout_preset(&preset).await });
        cx.notify();
    }

    fn sample_mic(&mut self, cx: &mut Context<Self>) {
        let levels = self.studio.mic_levels().borrow().clone();
        let now = Instant::now();
        self.mic_view = self.mic_meter.step(levels.microphone_peak_db, now);
        if let Some(peak) = levels.microphone_peak_db {
            let sample = fr::sound::Sample {
                at: now_ms(),
                peak_db: peak,
            };
            self.samples = fr::sound::add_sample(&self.samples, sample);
        }
        if !self.mic_meter.settled() {
            self.ensure_meter_ticks(cx);
        }
    }

    fn ensure_meter_ticks(&mut self, cx: &mut Context<Self>) {
        if self.settling {
            return;
        }
        self.settling = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(METER_TICK).await;
                let cont = this.update(cx, |screen, cx| {
                    if !screen.open {
                        screen.settling = false;
                        return false;
                    }
                    screen.sample_mic(cx);
                    let done = screen.mic_meter.settled();
                    if done {
                        screen.settling = false;
                    }
                    cx.notify();
                    !done
                });
                if !cont.unwrap_or(false) {
                    break;
                }
            }
        })
        .detach();
    }

    fn set_level_for_me(&mut self, cx: &mut Context<Self>) {
        let reading = fr::sound::reading(&self.samples, now_ms());
        let Some(peak) = reading.speech_peak_db else {
            return;
        };
        let current = self
            .studio
            .snapshot()
            .settings
            .capture
            .audio
            .microphone_gain_db;
        let next = fr::sound::gain_db(f64::from(current), peak) as f32;
        let studio = self.studio.clone();
        self.runtime
            .spawn(async move { studio.set_microphone_gain(next).await });
        self.samples.clear();
        cx.notify();
    }

    fn permission_action(
        &mut self,
        pane: SystemPermissionPane,
        action: SystemAccessAction,
        cx: &mut Context<Self>,
    ) {
        if self.pending_permission.is_some() {
            return;
        }
        if action == SystemAccessAction::OpenSettings {
            let _ = self.permissions.open_settings(cx, pane);
            cx.notify();
            return;
        }
        self.pending_permission = Some(pane);
        let task = match action {
            SystemAccessAction::RequestMediaAccess => self.permissions.request(cx, pane),
            SystemAccessAction::Relaunch => self.permissions.relaunch(cx),
            SystemAccessAction::OpenSettings => unreachable!(),
        };
        cx.spawn(async move |entity, cx| {
            let _ = task.await;
            let _ = entity.update(cx, |this, cx| {
                this.pending_permission = None;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn grants_ready(&self) -> bool {
        let snapshot = self.studio.snapshot();
        let media = self.permissions.snapshot();
        let platform = PermissionPlatform::current();
        let rows = system_access_rows(&SystemAccessInput {
            devices: &snapshot.sources.devices.devices,
            audio_meter: None,
            platform,
            os_release: None,
            permission_target_name: "Videorc",
            media_access: Some(&media),
            context: SystemAccessContext {
                pending_pane: self.pending_permission,
                ..Default::default()
            },
        });
        rows.iter().all(|row| {
            !row.required
                || matches!(
                    row.state,
                    SystemAccessState::Granted | SystemAccessState::NotRequired
                )
        })
    }

    fn rows_ready(&self) -> bool {
        let waited = self
            .opened_at
            .is_some_and(|at| at.elapsed() >= Duration::from_millis(ROWS_FALLBACK_MS));
        let snapshot = self.studio.snapshot();
        let media = self.permissions.snapshot();
        let media_ready = is_media_access_snapshot_ready(Some(&media));
        let devices = !snapshot.sources.devices.devices.is_empty() && self.studio.is_connected();
        media_ready && (devices || waited)
    }
}

/// `DIALOG_SIZE_CLASS`: `lg` (576 px) for every step, `xl` (768 px) for the
/// one media step, Your look (plan 207 D6).
fn card_width(step: Step) -> f32 {
    if step == Step::Look { 768. } else { 576. }
}

/// The card's `p-5` (`DIALOG_SURFACE_CLASS`).
const CARD_PADDING: f32 = 20.;

/// Your look's content width (the `xl` card less its padding) and one of its
/// two columns (`grid gap-5 sm:grid-cols-2`).
const LOOK_WIDTH: f32 = 728.;
const LOOK_COLUMN: f32 = 354.;

/// The Skeleton rows Permissions shows until its rows are real.
const SKELETON_ROWS: usize = 4;

/// `WELCOME_BACKDROP.dimDark`, and what Increase Contrast adds to it.
const BACKDROP_DIM_DARK: f32 = 0.3;
const BACKDROP_DIM_MORE_CONTRAST: f32 = 0.2;
/// `moreContrastBrightnessLight`: the inverted picture at 85% under Increase
/// Contrast in light.
const BACKDROP_DIM_LIGHT_MORE_CONTRAST: f32 = 0.15;

/// 14 px body text (`text-sm`) at weight 500: a row's or a choice's name.
fn row_title(words: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(t.foreground))
        .child(words.into())
}

/// 12 px secondary words (`text-meta text-muted-foreground`).
fn meta_line(words: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(words.into())
}

/// `systemAccessStatus`'s tone as `StatusBadge`'s: the colour lives in the
/// dot.
fn status_tone(tone: &str) -> StatusTone {
    match tone {
        "good" => StatusTone::Good,
        "warn" => StatusTone::Warn,
        "bad" | "error" => StatusTone::Error,
        _ => StatusTone::Neutral,
    }
}

/// `grantMissing`: a refusal, or a grant never asked for.
fn grant_missing(status: &MediaAccessStatus) -> bool {
    matches!(
        status,
        MediaAccessStatus::NotDetermined
            | MediaAccessStatus::Denied
            | MediaAccessStatus::Restricted
    )
}

/// `shapeApplies`: only the picture-in-picture layouts draw the camera's
/// shape in Preset mode.
fn shape_applies(preset: &str) -> bool {
    preset == "screen-camera" || preset == "vertical-screen-camera"
}

fn needs_camera(preset: &str) -> bool {
    !preset.ends_with("screen-only")
}

fn needs_screen(preset: &str) -> bool {
    !preset.ends_with("camera-only")
}

/// A disabled control's colours (Electron's `opacity-50`), pre-blended over
/// the card's ground (`faded_over`). GPUI fades each layer on its own, so a
/// faded group would drop its label into its fill; these paint at full
/// opacity instead, as the kit's SegmentedControl, InputGroup and Button do.
fn faded_theme(t: &Theme) -> Theme {
    let fade = |color| faded_over(color, t.glass_solid, 0.5);
    Theme {
        foreground: fade(t.foreground),
        muted_foreground: fade(t.muted_foreground),
        border: fade(t.border),
        muted: fade(t.muted),
        background: fade(t.background),
        accent: fade(t.accent),
        ..*t
    }
}

/// `MediaCard`: the row radius, a 4% fill and a hairline; selected, the
/// chrome plate with a brighter rim, never a colour.
/// A Look card: a real button (`<button>` in Electron), so Tab reaches it,
/// Enter and Space pick it and the focus ring shows. `focus` is the step's
/// autofocus target (the first background card).
fn media_card(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
    disabled: bool,
    focus: Option<&FocusHandle>,
    dim_frame: bool,
    t: &Theme,
) -> gpui_base::Button {
    let faded = faded_theme(t);
    let t = if disabled && dim_frame { &faded } else { t };
    let accent = hsla(t.accent);
    let ring = focus_ring(t);
    let plate = vec![
        box_shadow(&Shadow {
            inset: true,
            x: 0.,
            y: 1.,
            blur: 0.,
            spread: 0.,
            color: t.chrome_plate_hi,
        }),
        box_shadow(&Shadow {
            inset: true,
            x: 0.,
            y: 0.,
            blur: 0.,
            spread: 1.,
            color: t.chrome_plate_rim,
        }),
    ];
    gpui_base::Button::new(id)
        .when_some(focus, |card, focus| card.track_focus(focus))
        .disabled(disabled)
        .accessibility_label(label)
        .relative()
        .min_w(px(0.))
        .rounded(px(radius::ROW))
        .border_1()
        .map(|card| {
            if selected {
                card.border_color(hsla(with_alpha(t.foreground, 0.25)))
                    .bg(linear_gradient(
                        180.,
                        linear_color_stop(hsla(t.chrome_plate_top), 0.),
                        linear_color_stop(hsla(t.chrome_plate_bottom), 1.),
                    )
                    .color_space(ColorSpace::Oklab))
                    .shadow(plate)
            } else {
                card.border_color(hsla(t.border))
                    .bg(hsla(with_alpha(t.foreground, 0.04)))
            }
        })
        .when(!selected && !disabled, |card| {
            card.cursor_pointer().hover(move |style| style.bg(accent))
        })
        .focus_visible(move |style| style.shadow(vec![ring]))
}

/// A diagram corner on the radius tiers, as the scene cards draw it.
fn corner_px(corner: ThumbCorner) -> f32 {
    match corner {
        ThumbCorner::Chip => radius::CHIP,
        ThumbCorner::Area => radius::CHIP / 2.0,
        ThumbCorner::Tight => radius::CHIP / 3.0,
        ThumbCorner::Hair => radius::CHIP / 6.0,
    }
}

/// `LayoutThumb` at card size: the frame and where the layout puts the
/// screen and the camera; a 9:16 one upright in a 4:3 well.
fn layout_thumb(preset: &str, vertical: bool, inner: f32, t: &Theme) -> AnyElement {
    let frame_box = card_frame(vertical, inner);
    let (frame_w, frame_h) = (frame_box.width, frame_box.height);
    let camera = faded_over(t.foreground, t.glass_solid, 0.25);
    let camera_glyph = hsla(faded_over(t.foreground, camera, 0.45));
    let areas = thumb_areas(preset, false, ThumbSize::Card, frame_w - 2., frame_h - 2.);
    let frame = div()
        .relative()
        .flex_none()
        .w(px(frame_w))
        .h(px(frame_h))
        .overflow_hidden()
        .rounded(px(corner_px(frame_box.corner)))
        .border_1()
        .border_color(hsla(t.border))
        .bg(linear_gradient(
            135.,
            linear_color_stop(hsla(with_alpha(t.muted, 0.4)), 0.),
            linear_color_stop(hsla(with_alpha(t.muted, 0.7)), 1.),
        ))
        .children(areas.into_iter().map(|area| {
            let glyph = (area.part == ThumbPart::Camera && area.glyph).then(|| {
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(
                        IconName::VideoCamera,
                        (area.height * 0.6).min(14.),
                        camera_glyph,
                    ))
            });
            div()
                .absolute()
                .left(px(area.left))
                .top(px(area.top))
                .w(px(area.width))
                .h(px(area.height))
                .overflow_hidden()
                .rounded(px(corner_px(area.corner)))
                .bg(match area.part {
                    ThumbPart::Camera => hsla(camera),
                    ThumbPart::Screen => hsla(with_alpha(t.foreground, 0.1)),
                })
                .when(area.rim, |plate| {
                    plate
                        .border_1()
                        .border_color(hsla(with_alpha(t.background, 0.6)))
                })
                .children(glyph)
        }));
    if !vertical {
        return frame.into_any_element();
    }
    div()
        .w(px(inner))
        .h(px(inner * 3. / 4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius::CHIP))
        .bg(hsla(with_alpha(t.foreground, 0.03)))
        .child(frame)
        .into_any_element()
}

/// `PlatformGlyph`: the platform's brand tile in its 30 x 24 slot, the
/// kit's twin of `components/platform-glyph.tsx`.
fn platform_glyph(id: &str) -> PlatformGlyph {
    let platform = match id {
        "youtube" => ChatPlatform::Youtube,
        "x" => ChatPlatform::X,
        "kick" => ChatPlatform::Kick,
        _ => ChatPlatform::Twitch,
    };
    PlatformGlyph::new(platform).id(SharedString::from(format!("first-run-glyph-{id}")))
}

impl Render for FirstRunScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().id("first-run-closed");
        }
        let appearance = theme::current(window, cx);
        let t = appearance.theme();
        let viewport = window.viewport_size();
        self.sync_backdrop(
            backdrop::Frame {
                tone: backdrop_rules::tone(appearance.dark, appearance.increase_contrast),
                reduced_motion: !theme::motion(cx) || backdrop::system_reduces_motion(),
                visible: window.is_visible(),
                width: f64::from(viewport.width),
                height: f64::from(viewport.height),
                scale_factor: f64::from(window.scale_factor()),
            },
            window,
            cx,
        );
        let platform = self.platform();
        let (position, count) = fr::step_position(self.step, self.goal, Some(platform));
        let title = step_title(self.step);
        let description = step_description(self.step, platform);
        let last = fr::next_step(self.step, self.goal, Some(platform)).is_none();
        let previous = fr::previous_step(self.step, self.goal, Some(platform));
        let entity = cx.entity();
        let noun = device_noun(platform);
        let snapshot = self.studio.snapshot();
        let locked = snapshot.session.phase.is_active();
        let offline = !self.studio.is_connected();
        let grants_ready = self.grants_ready();

        // The top line: where setup is, and the way out of it.
        let top = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(meta_line(format!("Step {position} of {count}"), t))
            .child(
                Button::new("first-run-skip")
                    .label("Skip setup")
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.skip(cx))
                    }),
            );

        // The title (`text-base leading-none font-medium`) over the
        // description (`text-sm`), with the app icon as Permissions' lead.
        let lead = (self.step == Step::Permissions).then(|| {
            img(pictures::logo())
                .flex_none()
                .size(px(64.))
                .object_fit(ObjectFit::Contain)
        });
        let heading = div()
            .flex()
            .items_center()
            .gap(px(16.))
            .children(lead)
            .child(
                div()
                    .min_w(px(0.))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(16.))
                            .line_height(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hsla(t.foreground))
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .text_color(hsla(t.muted_foreground))
                            .child(description),
                    ),
            );
        let head = div()
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(top)
            .child(heading);

        // The step's first enabled control takes `body_focus` (once).
        let mut first_control = Some(self.body_focus.clone());
        let body = match self.step {
            Step::Permissions => permissions_body(self, &entity, locked, &mut first_control, t),
            Step::Goal => goal_body(noun, self.goal, &self.goal_focus, &entity, locked, t),
            Step::Look => look_body(self, &snapshot, &entity, locked, t),
            Step::Sound => sound_body(
                self,
                &snapshot,
                &entity,
                locked,
                offline,
                noun,
                &mut first_control,
                t,
            ),
            Step::Destinations => {
                destinations_body(self, &entity, locked, offline, &mut first_control, t)
            }
        };
        let body_has_control = first_control.is_none();

        // A new step takes the keyboard (`first-run-setup.tsx`): its marked
        // control, else its first enabled one, else the primary. Goal marks
        // the chosen row (the first when none is chosen); Look's first card
        // is No background. Permissions waits until its rows are real
        // (`permissions-step.tsx`), never focusing a placeholder.
        let waiting = self.step == Step::Permissions && !self.rows_ready();
        if self.focused_step != Some(self.step) && !waiting {
            self.focused_step = Some(self.step);
            let target = match self.step {
                Step::Goal => {
                    let index = match self.goal {
                        Some(Goal::Stream) => 1,
                        Some(Goal::Both) => 2,
                        _ => 0,
                    };
                    Some(self.goal_focus[index].clone())
                }
                Step::Look if !locked => Some(self.look_focus.clone()),
                Step::Look => None,
                _ if body_has_control => Some(self.body_focus.clone()),
                _ if !locked => Some(self.primary_focus.clone()),
                _ => None,
            };
            if let Some(target) = target {
                cx.on_next_frame(window, move |_, window, cx| window.focus(&target, cx));
            }
        }

        // Back at the left, the step's one primary at the right; Your goal
        // has none (its rows are the action).
        let mut actions = div().flex().items_center().gap(px(8.));
        if previous.is_some() {
            actions = actions.child(
                Button::new("first-run-back")
                    .variant(ButtonVariant::Ghost)
                    .disabled(locked)
                    .child(icon(IconName::ArrowLeft, 16., hsla(t.foreground)))
                    .child("Back")
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.go_back(cx))
                    }),
            );
        }
        let primary = if self.step == Step::Goal {
            None
        } else if self.step == Step::Permissions && !grants_ready {
            Some(
                Button::new("first-run-next")
                    .track_focus(&self.primary_focus)
                    .label("Skip for now")
                    .variant(ButtonVariant::Outline)
                    .disabled(locked)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.go_next(cx))
                    }),
            )
        } else {
            Some(
                Button::new("first-run-next")
                    .track_focus(&self.primary_focus)
                    .variant(ButtonVariant::Default)
                    .disabled(locked)
                    .child(next_label(self.mode, last))
                    .child(icon(IconName::ArrowRight, 16., hsla(t.chrome_fill_ink)))
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.go_next(cx))
                    }),
            )
        };
        actions = actions.child(
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_end()
                .gap(px(8.))
                .children(primary),
        );
        let footnote = (self.step == Step::Permissions).then(|| {
            meta_line(
                format!("Recordings stay on this {noun}. Cloud AI only runs after you opt in."),
                t,
            )
        });
        let foot = div()
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(12.))
            .children(footnote)
            .child(actions);

        // The one card on the dialog tier (plan 203 D1); its step is said
        // once, with where it sits.
        let live = format!("Step {position} of {count}, {title}");
        let glass = Glass {
            fill: t.glass_float_dialog,
            rim: t.glass_float_rim,
            drop: t.glass_float_dialog_drop,
            radius: radius::PANEL,
        };
        let card = floating(
            glass,
            1.0,
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .flex_col()
                .gap(px(20.))
                .child(head)
                .child(ScrollArea::new("first-run-body").child(body))
                .child(foot),
        )
        .id("first-run-card")
        .aria_label(live)
        .w(relative(1.))
        .max_w(px(card_width(self.step)))
        .max_h(relative(1.))
        .flex()
        .flex_col()
        .p(px(CARD_PADDING))
        .text_size(px(14.))
        .text_color(hsla(t.popover_foreground));

        // Liquid Chrome's poster edge to edge (the backdrop's still): dimmed
        // under dark, turned around under light. Decoration only. Once the
        // player's first frame is on its layer the moving picture covers it;
        // the clock starts at the poster's phase, so nothing jumps.
        let picture = if appearance.dark {
            Some(pictures::poster())
        } else {
            self.inverted_poster.clone()
        };
        let dim = match (appearance.dark, appearance.increase_contrast) {
            (true, false) => BACKDROP_DIM_DARK,
            (true, true) => BACKDROP_DIM_DARK + BACKDROP_DIM_MORE_CONTRAST,
            (false, true) => BACKDROP_DIM_LIGHT_MORE_CONTRAST,
            (false, false) => 0.,
        };
        let backdrop = div()
            .absolute()
            .inset_0()
            .overflow_hidden()
            .bg(hsla(t.glass_solid))
            .children(picture.map(|picture| {
                img(picture)
                    .absolute()
                    .inset_0()
                    .size_full()
                    .object_fit(ObjectFit::Cover)
            }))
            .when(dim > 0., |backdrop| {
                backdrop.child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(hsla(with_alpha(videorc_kit::tokens::DARK.glass_solid, dim))),
                )
            })
            .children(self.backdrop_picture());

        div()
            .id("first-run-setup")
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .flex_col()
            .font_family(FONT)
            .text_color(hsla(t.foreground))
            .child(backdrop)
            // The window family's title band: the traffic lights' line and
            // the drag region, with nothing on it.
            .child(
                div()
                    .relative()
                    .flex_none()
                    .w_full()
                    .h(px(size::TOOLBAR))
                    .window_control_area(WindowControlArea::Drag),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(16.))
                    .child(card),
            )
    }
}

fn permissions_body(
    screen: &FirstRunScreen,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    first_control: &mut Option<FocusHandle>,
    t: &Theme,
) -> AnyElement {
    if screen.platform() == "linux" {
        return Empty::new()
            .title("Nothing to grant here")
            .description(
                "Linux keeps no capture permissions for apps. Your desktop may ask when Videorc starts capturing the screen.",
            )
            .into_any_element();
    }
    if !screen.rows_ready() {
        // Never "Not asked yet" guesses before the rows are real.
        let mut list = GroupedList::new();
        for index in 0..SKELETON_ROWS {
            list = list.item(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .px(px(12.))
                    .py(px(12.))
                    .child(
                        Skeleton::new(("first-run-skeleton-title", index))
                            .w(px(160.))
                            .h(px(16.)),
                    )
                    .child(
                        Skeleton::new(("first-run-skeleton-line", index))
                            .w(px(288.))
                            .max_w(relative(1.))
                            .h(px(12.)),
                    ),
            );
        }
        return list.into_any_element();
    }
    let snapshot = screen.studio.snapshot();
    let media = screen.permissions.snapshot();
    let perm_platform = PermissionPlatform::current();
    let rows = system_access_rows(&SystemAccessInput {
        devices: &snapshot.sources.devices.devices,
        audio_meter: None,
        platform: perm_platform,
        os_release: None,
        permission_target_name: "Videorc",
        media_access: Some(&media),
        context: SystemAccessContext {
            pending_pane: screen.pending_permission,
            ..Default::default()
        },
    });
    let mut list = GroupedList::new();
    for (index, row) in rows.iter().enumerate() {
        let (status, tone) = system_access_status(row.state);
        // The setup variant's tag: what Videorc can't record without.
        let tag = if row.required {
            Some("Needed to record")
        } else if row.id == SystemAccessRowId::Camera {
            Some("Optional")
        } else {
            None
        };
        let checking = row.checking || row.state == SystemAccessState::Waiting;
        let detail = system_access_visible_detail(row).map(str::to_string);
        let proof = row.id == SystemAccessRowId::Microphone
            && row.state == SystemAccessState::Granted
            && !row.checking;
        let action = row_action(row, perm_platform, Some(&media));
        let action_label = system_access_action_label(action, perm_platform);

        let words = div()
            .flex_1()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(row_title(row.label, t))
                    .child(StatusBadge::new(status).tone(status_tone(tone)))
                    .children(checking.then(|| {
                        Spinner::new(("first-run-checking", index))
                            .accessibility_label("Checking permission…")
                    }))
                    .children(tag.map(|tag| Badge::new(tag).variant(BadgeVariant::Outline))),
            )
            .child(meta_line(row.purpose, t))
            .children(detail.map(|detail| meta_line(detail, t)))
            .children(proof.then(|| {
                // The Microphone row's proof (plan 203 D6): the live level.
                div()
                    .pt(px(6.))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(segmented_meter(screen.mic_view, false, t))
                    .child(meta_line(
                        "Say something. The bar moves when Videorc hears you.",
                        t,
                    ))
            }));

        let button = match (action, action_label) {
            (Some(action), Some(label)) if row.id != SystemAccessRowId::SystemAudio => {
                let pane = row.id.pane();
                let busy = screen.pending_permission == Some(pane);
                let disabled = locked || screen.pending_permission.is_some();
                let mut button = Button::new(("first-run-grant", index))
                    .variant(ButtonVariant::Outline)
                    .accessibility_label(format!("{}: {label}", row.label))
                    .disabled(disabled);
                // The first row with something to press takes the keyboard.
                if !disabled && let Some(handle) = first_control.take() {
                    button = button.track_focus(&handle);
                }
                if busy {
                    button = button.child(
                        Spinner::new(("first-run-grant-busy", index))
                            .size(14.)
                            .hidden(true),
                    );
                }
                Some(button.child(SharedString::from(label)).on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| this.permission_action(pane, action, cx))
                    }
                }))
            }
            _ => None,
        };

        list = list.item(
            div()
                .flex()
                .items_start()
                .gap(px(12.))
                .px(px(12.))
                .py(px(10.))
                .child(words)
                .children(button),
        );
    }
    list.into_any_element()
}

fn goal_body(
    noun: &str,
    goal: Option<Goal>,
    focus: &[FocusHandle; 3],
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    t: &Theme,
) -> AnyElement {
    let choices = [
        (
            Goal::Record,
            "Recordings",
            format!("Tutorials, demos and videos, saved on this {noun}."),
            IconName::Record,
        ),
        (
            Goal::Stream,
            "Livestreams",
            "Go live on YouTube, Twitch, Kick or X.".to_string(),
            IconName::Broadcast,
        ),
        (
            Goal::Both,
            "Both",
            "Record and go live.".to_string(),
            IconName::VideoCamera,
        ),
    ];
    // Locked rows draw in pre-blended colours, not a faded group.
    let faded = faded_theme(t);
    let t = if locked { &faded } else { t };
    let accent = hsla(t.accent);
    let muted = hsla(t.muted_foreground);
    let mut list = GroupedList::new();
    for (index, (value, title, line, glyph)) in choices.into_iter().enumerate() {
        let chosen = goal == Some(value);
        let ring = focus_ring(t);
        // One click (or Enter) picks the choice and moves on.
        list = list.item(
            gpui_base::Button::new(("first-run-goal", index))
                .track_focus(&focus[index])
                .disabled(locked)
                .w_full()
                .accessibility_label(title)
                .when(chosen, |row| row.bg(accent))
                .when(!locked, |row| row.hover(move |style| style.bg(accent)))
                .focus_visible(move |style| style.shadow(vec![ring]))
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |this, cx| this.pick_goal(value, cx))
                })
                .child(
                    div()
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .px(px(12.))
                        .py(px(10.))
                        .child(icon(glyph, 16., muted))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .child(row_title(title, t))
                                .child(meta_line(line, t)),
                        )
                        .child(icon(
                            if chosen {
                                IconName::Check
                            } else {
                                IconName::CaretRight
                            },
                            16.,
                            muted,
                        )),
                ),
        );
    }
    // `moveFocus`: Up and Down move between the choices, as in a menu,
    // wrapping at either end.
    let rows = focus.clone();
    div()
        .on_key_down(move |event, window, cx| {
            let step: isize = match event.keystroke.key.as_str() {
                "down" => 1,
                "up" => -1,
                _ => return,
            };
            let Some(index) = rows.iter().position(|row| row.is_focused(window)) else {
                return;
            };
            cx.stop_propagation();
            let next = (index as isize + step).rem_euclid(rows.len() as isize) as usize;
            window.focus(&rows[next], cx);
        })
        .child(list)
        .into_any_element()
}

fn look_body(
    screen: &FirstRunScreen,
    snapshot: &videorc_app_core::studio::StudioSnapshot,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    t: &Theme,
) -> AnyElement {
    let vertical = screen.orientation == Orientation::Vertical;
    // The layout the step shows: the one picked here, else the Studio's own.
    let preset: Option<String> = screen.layout_preset.clone().or_else(|| {
        serde_json::to_value(&snapshot.settings.capture.layout.layout_preset)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
    });
    let preset = preset.filter(|preset| preset.starts_with("vertical-") == vertical);

    // What each missing source says (`FIRST_RUN_LOOK_REASONS`).
    let media = screen.permissions.snapshot();
    let sources = &snapshot.settings.capture.sources;
    let devices = &snapshot.sources.devices.devices;
    let chosen = |id: &Option<String>| id.as_deref().is_some_and(|id| !id.is_empty());
    let camera_gap = if chosen(&sources.camera_id) {
        None
    } else if grant_missing(&media.camera) {
        Some("Allow the camera first.")
    } else if devices
        .iter()
        .any(|device| device.kind == DeviceKind::Camera)
    {
        Some("Camera is off.")
    } else {
        Some("No camera found.")
    };
    // `sceneSourceGaps`: a test pattern stands in for no screen, so it is
    // no screen gap.
    let base_chosen = chosen(&sources.screen_id) || chosen(&sources.window_id);
    let screen_gap = if base_chosen || sources.test_pattern {
        None
    } else if grant_missing(&media.screen) {
        Some("Allow Screen Recording first.")
    } else if devices
        .iter()
        .any(|device| matches!(device.kind, DeviceKind::Screen | DeviceKind::Window))
    {
        Some("No screen is chosen.")
    } else {
        Some("No screen found.")
    };
    let reasons: Vec<&str> = camera_gap.into_iter().chain(screen_gap).collect();
    let grant_reason = reasons.iter().any(|reason| reason.starts_with("Allow "));
    // `look-picture.tsx`: the picture places only a camera, screen or
    // window (PICTURE_KINDS). A test pattern isn't one, so with nothing
    // else chosen the picture says what it waits for, as Electron.
    let has_sources = chosen(&sources.camera_id) || base_chosen;

    // The picture: the layout's boxes with the camera in its shape, the
    // chosen live background behind them.
    let (picture_w, picture_h) = if vertical {
        (126., 224.)
    } else {
        (LOOK_COLUMN, LOOK_COLUMN * 9. / 16.)
    };
    let mut picture = div()
        .id("first-run-look-picture")
        .relative()
        .flex_none()
        .w(px(picture_w))
        .h(px(picture_h))
        .overflow_hidden()
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.inset));
    if let Some(image) = screen.live_background.and_then(pictures::live_thumb) {
        picture = picture.child(
            img(image)
                .absolute()
                .inset_0()
                .size_full()
                .object_fit(ObjectFit::Cover),
        );
    }
    if !has_sources {
        picture = picture.child(
            div()
                .absolute()
                .left(px(12.))
                .right(px(12.))
                .bottom(px(8.))
                .text_center()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child("Your camera and screen show here once Videorc can use them."),
        );
    } else if let Some(preset) = preset.as_deref() {
        let stroke = hsla(with_alpha(t.foreground, 0.4));
        for area in thumb_areas(
            preset,
            false,
            ThumbSize::Card,
            picture_w - 2.,
            picture_h - 2.,
        ) {
            let camera = area.part == ThumbPart::Camera;
            let fill = hsla(with_alpha(t.foreground, if camera { 0.15 } else { 0.05 }));
            let shape = if camera && shape_applies(preset) {
                screen.camera_shape
            } else {
                CameraShape::Rectangle
            };
            let side = area.width.min(area.height);
            let source = match shape {
                CameraShape::Circle => div()
                    .absolute()
                    .left(px(area.left + (area.width - side) / 2.))
                    .top(px(area.top + (area.height - side) / 2.))
                    .size(px(side))
                    .rounded_full(),
                CameraShape::Rounded => div()
                    .absolute()
                    .left(px(area.left))
                    .top(px(area.top))
                    .w(px(area.width))
                    .h(px(area.height))
                    .rounded(px(side * 0.15)),
                CameraShape::Rectangle => div()
                    .absolute()
                    .left(px(area.left))
                    .top(px(area.top))
                    .w(px(area.width))
                    .h(px(area.height)),
            };
            picture = picture.child(source.bg(fill).border_1().border_color(stroke));
        }
    }
    let picture = div().flex().justify_center().child(picture);

    let mut orientation = SegmentedControl::new("first-run-orientation")
        .accessibility_label("Orientation")
        // Electron's default w-fit (look-step.tsx, a plain flex column): the
        // track hugs its words instead of filling the column.
        .fit(true)
        .option(Segment::new("horizontal", "Horizontal 16:9"))
        .option(Segment::new("vertical", "Vertical 9:16"))
        .value(Some(SharedString::from(match screen.orientation {
            Orientation::Horizontal => "horizontal",
            Orientation::Vertical => "vertical",
        })))
        .disabled(locked);
    orientation = orientation.on_change({
        let entity = entity.clone();
        move |value, _, cx| {
            entity.update(cx, |this, cx| {
                this.orientation = if value.as_ref() == "vertical" {
                    Orientation::Vertical
                } else {
                    Orientation::Horizontal
                };
                cx.notify();
            })
        }
    });

    let mut shape = SegmentedControl::new("first-run-shape")
        .accessibility_label("Camera shape")
        .fit(true)
        .option(Segment::new("rectangle", "Rectangle"))
        .option(Segment::new("rounded", "Rounded"))
        .option(Segment::new("circle", "Circle"))
        .value(Some(SharedString::from(match screen.camera_shape {
            CameraShape::Rectangle => "rectangle",
            CameraShape::Rounded => "rounded",
            CameraShape::Circle => "circle",
        })))
        .disabled(locked);
    shape = shape.on_change({
        let entity = entity.clone();
        move |value, _, cx| {
            entity.update(cx, |this, cx| {
                this.camera_shape = match value.as_ref() {
                    "rounded" => CameraShape::Rounded,
                    "circle" => CameraShape::Circle,
                    _ => CameraShape::Rectangle,
                };
                cx.notify();
            })
        }
    });

    // The backgrounds: None, then each live background's thumbnail, four
    // to a row on media cards; the name is the tile's tooltip.
    let mut backgrounds = div().grid().grid_cols(4).gap(px(6.));
    let mut tiles: Vec<(Option<&'static str>, &'static str)> = vec![(None, "None")];
    for id in assets::live_backgrounds_offered() {
        tiles.push((Some(*id), assets::live_background_name(id)));
    }
    let faded = faded_theme(t);
    for (index, (id, label)) in tiles.into_iter().enumerate() {
        let selected = screen.live_background == id;
        // Locked: the card's colours pre-blended, the still faded on its own
        // (one layer, so its opacity is the group's).
        let t = if locked { &faded } else { t };
        let well = div()
            .relative()
            .w_full()
            .aspect_ratio(16. / 9.)
            .rounded(px(radius::CHIP));
        let well = match id.and_then(pictures::live_thumb) {
            Some(image) => well.child(
                img(image)
                    .absolute()
                    .inset_0()
                    .size_full()
                    .rounded(px(radius::CHIP))
                    .object_fit(ObjectFit::Cover)
                    .when(locked, |still| still.opacity(0.5)),
            ),
            None => well
                .flex()
                .items_center()
                .justify_center()
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.inset))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(label),
        };
        let focus = (index == 0).then_some(&screen.look_focus);
        let mut tile = media_card(
            ("first-run-bg", index),
            label,
            selected,
            locked,
            focus,
            true,
            t,
        )
        .p(px(4.))
        .tooltip(tooltip(label))
        .child(well);
        if !locked {
            tile = tile.on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |this, cx| {
                        this.live_background = id;
                        cx.notify();
                    })
                }
            });
        }
        backgrounds = backgrounds.child(tile);
    }
    let bg_line = match screen.live_background {
        Some(id) => format!("{}, moving behind you.", assets::live_background_name(id)),
        None => "No background: your screen and camera fill the picture.".into(),
    };

    // The layouts of the orientation as small scene cards, the chosen one
    // ringed and checked.
    let columns: u16 = if vertical { 6 } else { 4 };
    let card_w = (LOOK_WIDTH - 8. * f32::from(columns - 1)) / f32::from(columns);
    let inner = card_w - 18.;
    let mut layouts = div().grid().grid_cols(columns).gap(px(8.));
    for (index, (layout, label)) in LAYOUT_PRESET_LABELS.iter().enumerate() {
        if layout.starts_with("vertical-") != vertical {
            continue;
        }
        let selected = preset.as_deref() == Some(*layout);
        let disabled = locked
            || (needs_camera(layout) && camera_gap.is_some())
            || (needs_screen(layout) && screen_gap.is_some());
        // `SceneCard`: a disabled card dims only its thumb (the well's
        // `opacity-50`, pre-blended here); its frame and name stay whole.
        let thumb_t = if disabled { &faded } else { t };
        let well = div()
            .relative()
            .rounded(px(radius::CHIP))
            .child(layout_thumb(layout, vertical, inner, thumb_t))
            .when(selected, |well| {
                well.child(
                    div()
                        .absolute()
                        .top(px(-4.))
                        .left(px(-4.))
                        .right(px(-4.))
                        .bottom(px(-4.))
                        .rounded(px(radius::CHIP + 4.0))
                        .border_2()
                        .border_color(hsla(t.foreground)),
                )
            });
        // The button centres its content, so the thumb and the name sit in
        // one left-aligned column inside it.
        let mut card = media_card(
            ("first-run-layout", index),
            *label,
            selected,
            disabled,
            None,
            false,
            t,
        )
        .p(px(8.))
        .child(
            div()
                .w_full()
                .min_w(px(0.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(well)
                .child(
                    div()
                        .min_w(px(0.))
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .line_clamp(2)
                        .child(*label),
                ),
        )
        .when(selected, |card| {
            card.child(
                div()
                    .absolute()
                    .top(px(4.))
                    .left(px(4.))
                    .child(Badge::new("").icon(icon(IconName::Check, 12., hsla(t.foreground)))),
            )
        });
        if !disabled {
            card = card.on_click({
                let entity = entity.clone();
                let layout = layout.to_string();
                move |_, _, cx| entity.update(cx, |this, cx| this.set_layout(layout.clone(), cx))
            });
        }
        layouts = layouts.child(card);
    }
    let reason_line = (!reasons.is_empty()).then(|| {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .child(meta_line(reasons.join(" "), t))
            .children(grant_reason.then(|| {
                Button::new("first-run-back-permissions")
                    .label("Back to permissions")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .disabled(locked)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| this.go_to(Step::Permissions, cx))
                        }
                    })
            }))
    });

    let group = |label: &'static str| {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(SectionLabel::new(label))
    };
    let left = div()
        .flex_1()
        .min_w(px(0.))
        .flex()
        .flex_col()
        .gap(px(16.))
        .child(picture)
        .child(
            group("Orientation")
                .child(div().flex().child(orientation))
                .child(meta_line("Vertical is for Shorts, Reels and TikTok.", t)),
        );
    let right = div()
        .flex_1()
        .min_w(px(0.))
        .flex()
        .flex_col()
        .gap(px(16.))
        .children(
            preset
                .as_deref()
                .is_some_and(shape_applies)
                .then(|| group("Camera shape").child(div().flex().child(shape))),
        )
        .child(
            group("Background")
                .child(backgrounds)
                .child(meta_line(bg_line, t)),
        );

    div()
        .flex()
        .flex_col()
        .gap(px(20.))
        .child(div().flex().gap(px(20.)).child(left).child(right))
        .child(group("Layout").child(layouts).children(reason_line))
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn sound_body(
    screen: &FirstRunScreen,
    snapshot: &videorc_app_core::studio::StudioSnapshot,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    offline: bool,
    noun: &str,
    first_control: &mut Option<FocusHandle>,
    t: &Theme,
) -> AnyElement {
    let muted = hsla(t.muted_foreground);
    let mic_id = snapshot
        .settings
        .capture
        .sources
        .microphone_id
        .clone()
        .unwrap_or_default();
    // The picker fills the row: the `lg` card's content less the list's
    // rim and the row's `px-3`.
    let mut picker = Select::new("first-run-microphone")
        .accessibility_label("Microphone")
        .option("", "Off")
        .width(card_width(Step::Sound) - 2. * CARD_PADDING - 2. - 24.)
        .disabled(locked || offline)
        .value(Some(SharedString::from(mic_id)));
    for device in &snapshot.sources.devices.devices {
        if device.kind == DeviceKind::Microphone {
            picker = picker.option(device.id.clone(), device.name.clone());
        }
    }
    // The microphone is the step's first control.
    if !(locked || offline)
        && let Some(handle) = first_control.take()
    {
        picker = picker.track_focus(&handle);
    }
    picker = picker.on_change({
        let entity = entity.clone();
        move |id, _, cx| entity.update(cx, |this, cx| this.pick_microphone(id.to_string(), cx))
    });

    // Only a refusal or a never-asked grant blocks the level; an unknown
    // snapshot keeps the meter.
    let mic_blocked = grant_missing(&screen.permissions.snapshot().microphone);
    let reading = fr::sound::reading(&screen.samples, now_ms());
    let level_ready = reading.speech_peak_db.is_some();
    let gain = snapshot.settings.capture.audio.microphone_gain_db;

    let mut microphone = div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .px(px(12.))
        .py(px(10.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(icon(IconName::Microphone, 16., muted))
                .child(row_title("Microphone", t)),
        )
        .child(picker);
    if mic_blocked {
        microphone = microphone.child(
            Alert::new("first-run-mic-blocked")
                .variant(AlertVariant::Warning)
                .title("Videorc can't hear your microphone yet.")
                .description(
                    div().pt(px(4.)).child(
                        Button::new("first-run-sound-back-permissions")
                            .label("Back to permissions")
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| this.go_to(Step::Permissions, cx))
                                }
                            }),
                    ),
                ),
        );
    } else {
        // `MicrophoneGainFader` in its `SourceControlRow`: Gain, the fader,
        // the value.
        let gain_row = div()
            .min_w(px(0.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex_none()
                    .w(px(36.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child("Gain"),
            )
            .child(
                div().flex_1().min_w(px(0.)).flex().items_center().child(
                    Slider::new(&screen.mic_gain)
                        // A fader from 0 dB, as the Studio's gain.
                        .origin(
                            -MICROPHONE_GAIN_RANGE.0
                                / (MICROPHONE_GAIN_RANGE.1 - MICROPHONE_GAIN_RANGE.0),
                        )
                        .accessibility_label("Microphone gain")
                        .disabled(locked),
                ),
            )
            .child(
                div()
                    .flex_none()
                    .min_w(px(56.))
                    .flex()
                    .justify_end()
                    .font_family(videorc_kit::theme::FONT_MONO)
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(format_db(gain)),
            );
        microphone = microphone
            .child(segmented_meter(screen.mic_view, false, t))
            .child(gain_row)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(reading.verdict.copy()),
                    )
                    .child(
                        Button::new("first-run-set-level")
                            .label("Set level for me")
                            .variant(ButtonVariant::Outline)
                            .disabled(locked || !level_ready)
                            .when(!level_ready, |button| {
                                button.tooltip("Talk for a few seconds first.")
                            })
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| this.set_level_for_me(cx))
                                }
                            }),
                    ),
            );
    }

    let system_checked = snapshot.settings.capture.audio.system_audio_enabled;
    let system = div()
        .flex()
        .items_start()
        .gap(px(12.))
        .px(px(12.))
        .py(px(10.))
        .child(
            div()
                .flex_none()
                .mt(px(2.))
                .child(icon(IconName::Desktop, 16., muted)),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(row_title("System audio", t))
                .child(meta_line(
                    format!(
                        "The sound your {noun} plays: games, music and calls. Its level shows once you record or go live."
                    ),
                    t,
                )),
        )
        .child(
            Switch::new("first-run-system-audio")
                .accessibility_label("System audio")
                .checked(system_checked)
                .disabled(locked)
                .on_change({
                    let entity = entity.clone();
                    move |enabled, _, cx| {
                        entity.update(cx, |this, cx| this.set_system_audio(enabled, cx))
                    }
                }),
        );

    GroupedList::new()
        .item(microphone)
        .item(system)
        .into_any_element()
}

fn destinations_body(
    screen: &FirstRunScreen,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    offline: bool,
    first_control: &mut Option<FocusHandle>,
    t: &Theme,
) -> AnyElement {
    let platforms = screen.studio.platforms_now();
    let mut list = GroupedList::new();
    for id in SETUP_PLATFORMS {
        let name = platform_label(id);
        let account = platforms.account(id);
        let connected = account.is_some_and(|a| a.status == AccountStatus::Connected);
        let unavailable = oauth_unavailable_reason(id).is_some()
            || platforms.credentials(id).is_some_and(|c| !c.ready);
        let account_label = account
            .filter(|_| connected)
            .map(|a| a.account_label.clone())
            .filter(|label| !label.is_empty());
        let words = div()
            .flex_1()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(row_title(name, t))
                    .child(
                        StatusBadge::new(if connected {
                            "Connected"
                        } else {
                            "Not connected"
                        })
                        .tone(if connected {
                            StatusTone::Good
                        } else {
                            StatusTone::Neutral
                        }),
                    )
                    .children(account_label.map(|label| meta_line(label, t).truncate())),
            )
            .children(unavailable.then(|| {
                meta_line(
                    format!("Signing in to {name} isn't available in this build."),
                    t,
                )
            }));
        let shows_sign_in = !connected && !unavailable;
        let sign_in_focus = (shows_sign_in && !(locked || offline))
            .then(|| first_control.take())
            .flatten();
        let sign_in = shows_sign_in.then(|| {
            Button::new(format!("first-run-signin-{id}"))
                .label("Sign in…")
                .variant(ButtonVariant::Outline)
                .accessibility_label(format!("{name}: Sign in…"))
                .disabled(locked || offline)
                .tooltip("Finish sign-in in Destinations.")
                .when_some(sign_in_focus, |button, handle| button.track_focus(&handle))
        });
        list = list.item(
            div()
                .flex()
                .items_start()
                .gap(px(12.))
                .px(px(12.))
                .py(px(10.))
                .child(platform_glyph(id))
                .child(words)
                .children(sign_in),
        );
    }
    // Open Destinations takes the keyboard when no Sign in… did.
    let open_disabled = locked || !PageId::Live.ported();
    let open_focus = (!open_disabled).then(|| first_control.take()).flatten();
    div()
        .flex()
        .flex_col()
        .gap(px(16.))
        .children(offline.then(|| {
            Alert::new("first-run-dest-offline")
                .variant(AlertVariant::Locked)
                .title("Videorc is reconnecting. These controls come back in a moment.")
        }))
        .child(list)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(
                    meta_line(
                        "Using a stream key, TikTok or Instagram? Set it up in Destinations.",
                        t,
                    )
                    .flex_1()
                    .min_w(px(0.)),
                )
                .child(
                    Button::new("first-run-open-destinations")
                        .label("Open Destinations")
                        .variant(ButtonVariant::Outline)
                        .disabled(open_disabled)
                        .when_some(open_focus, |button, handle| button.track_focus(&handle))
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, cx| {
                                    this.leave(
                                        Leave {
                                            completion: fr::Completion::Done,
                                            open_page: Some(PageId::Live),
                                        },
                                        cx,
                                    )
                                })
                            }
                        }),
                ),
        )
        .into_any_element()
}
