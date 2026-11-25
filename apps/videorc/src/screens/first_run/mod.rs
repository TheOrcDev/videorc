//! First-run setup (plan 260 Phase 3, L4): the full-window welcome from
//! `videorc_app_core::first_run` (#1766), drawn with `videorc-kit`. Words
//! match Electron's `components/first-run/*` and `lib/first-run.ts`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{Context, Entity, EventEmitter, SharedString, Window, div, prelude::*, px, relative};
use videorc_app_core::assets;
use videorc_app_core::desktop::permissions::{PermissionPlatform, SystemPermissionPane};
use videorc_app_core::desktop::system_access::{
    SystemAccessAction, SystemAccessContext, SystemAccessInput, SystemAccessRowId,
    SystemAccessState, is_media_access_snapshot_ready, row_action, system_access_rows,
};
use videorc_app_core::first_run::{self as fr, Goal, Leave, SetupMode, Step};
use videorc_app_core::format::device_noun;
use videorc_app_core::livestream::accounts::{AccountStatus, platform_label};
use videorc_app_core::nav::PageId;
use videorc_app_core::scenes::v2::LAYOUT_PRESET_LABELS;
use videorc_app_core::studio::audio_mixer::{MICROPHONE_GAIN_RANGE, MeterBallistics, MeterView};
use videorc_app_core::studio::settings::SettingWrite;
use videorc_app_core::studio::source_selection::SourceKind;
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::empty::Empty;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::Select;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{radius, size, text};

use crate::app::permissions::Permissions;

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

    fn take_dirty(mut self) -> Vec<(String, String)> {
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

fn segmented_meter(meter: MeterView, theme: &videorc_kit::tokens::Theme) -> impl IntoElement {
    let track = hsla(theme.border);
    let ok = hsla(theme.success);
    let warn = hsla(theme.warning);
    let clip = hsla(theme.destructive);
    let hold = hsla(theme.muted_foreground);
    let mut row = div().w_full().h(px(8.)).flex().items_center().gap(px(1.));
    for index in 0u8..24 {
        let lit = index < meter.lit;
        let is_hold = meter.hold > 0 && index + 1 == meter.hold;
        let color = if is_hold && !lit {
            hold
        } else if lit {
            if index >= 20 {
                clip
            } else if index >= 16 {
                warn
            } else {
                ok
            }
        } else {
            track
        };
        row = row.child(div().flex_1().h_full().rounded(px(1.)).bg(color));
    }
    row
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

        let gain = studio.snapshot().settings.capture.audio.microphone_gain_db as f32;
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
        };
        screen.try_auto_show(cx);
        screen
    }

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
        self.open = true;
        self.opened_at = Some(Instant::now());
        self.samples.clear();
        self.studio.set_clips_first_run_setup_open(true);
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
        self.open = true;
        self.opened_at = Some(Instant::now());
        self.samples.clear();
        self.studio.set_clips_first_run_setup_open(true);
        if self.startup.is_none() {
            let store = BufStore::from_studio(&self.studio);
            self.startup = Some(fr::FirstRunStartup::new(&store));
        }
        self.persist_step();
        cx.notify();
    }

    fn platform(&self) -> &'static str {
        crate::app::hotkeys::node_platform()
    }

    fn leave(&mut self, leave: Leave, cx: &mut Context<Self>) {
        self.open = false;
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
        let next = fr::sound::gain_db(current, peak) as f32;
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

impl Render for FirstRunScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().id("first-run-closed");
        }
        let t = theme::current(window, cx).theme();
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

        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(format!("Step {position} of {count}")),
            )
            .child(
                Button::new("first-run-skip")
                    .label("Skip setup")
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.skip(cx))
                    }),
            );

        let title_block = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .type_scale(text::SECTION)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(title),
            )
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(description),
            );

        let body = match self.step {
            Step::Permissions => permissions_body(self, &entity, locked, &t, window, cx),
            Step::Goal => goal_body(noun, &entity, locked),
            Step::Look => look_body(self, &entity, locked, &t),
            Step::Sound => sound_body(
                self, &snapshot, &entity, locked, offline, noun, &t, window, cx,
            ),
            Step::Destinations => destinations_body(self, &entity, locked, offline),
        };

        let mut footer = div().flex().items_center().gap(px(8.));
        if previous.is_some() {
            footer = footer.child(
                Button::new("first-run-back")
                    .label("Back")
                    .variant(ButtonVariant::Ghost)
                    .disabled(locked)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.go_back(cx))
                    }),
            );
        }
        if self.step != Step::Goal {
            let (label, variant) = if self.step == Step::Permissions {
                if grants_ready {
                    ("Continue", ButtonVariant::Default)
                } else {
                    ("Skip for now", ButtonVariant::Outline)
                }
            } else {
                (next_label(self.mode, last), ButtonVariant::Default)
            };
            footer = footer.child(
                div().flex_1().justify_end().child(
                    Button::new("first-run-next")
                        .label(label)
                        .variant(variant)
                        .disabled(locked)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| entity.update(cx, |this, cx| this.go_next(cx))
                        }),
                ),
            );
        }

        let live = format!("Step {position} of {count}, {title}");

        div()
            .id("first-run-setup")
            .size_full()
            .flex()
            .flex_col()
            .font_family(FONT)
            .bg(hsla(t.background))
            .text_color(hsla(t.foreground))
            .child(
                // Soft chrome backdrop (P1456): solid fill until liquid-chrome
                // lands; reduced-motion / no-GPU still get a still plane.
                div()
                    .absolute()
                    .inset_0()
                    .bg(hsla(t.glass_solid))
                    .opacity(0.55),
            )
            .child(
                div()
                    .id("first-run-title-band")
                    .h(px(40.))
                    .w_full()
                    .flex_none(),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(16.))
                    .child(
                        div()
                            .id("first-run-card")
                            .w(relative(1.))
                            .max_w(px(if self.step == Step::Look { 720. } else { 560. }))
                            .max_h(relative(1.))
                            .flex()
                            .flex_col()
                            .gap(px(20.))
                            .rounded(px(radius::PANEL))
                            .border_1()
                            .border_color(hsla(t.border))
                            .bg(hsla(t.glass_solid))
                            .px(px(size::GUTTER))
                            .py(px(20.))
                            .child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(live),
                            )
                            .child(header)
                            .child(title_block)
                            .child(
                                ScrollArea::new("first-run-body")
                                    .child(div().flex().flex_col().gap(px(12.)).child(body)),
                            )
                            .child(footer),
                    ),
            )
    }
}

fn permissions_body(
    screen: &FirstRunScreen,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    t: &videorc_kit::tokens::Theme,
    _window: &mut Window,
    _cx: &mut Context<FirstRunScreen>,
) -> gpui::AnyElement {
    let platform = screen.platform();
    let noun = device_noun(platform);
    let linux = platform == "linux";
    let mut column = div().flex().flex_col().gap(px(12.));
    if linux {
        column = column.child(
            Empty::new()
                .title("Nothing to grant here")
                .description(
                    "Linux keeps no capture permissions for apps. Your desktop may ask when Videorc starts capturing the screen.",
                ),
        );
    } else if !screen.rows_ready() {
        column = column.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child("Checking system access…"),
        );
    } else {
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
        let mut list = GroupedList::new().label("System access");
        for (index, row) in rows.iter().enumerate() {
            let action = row_action(row, perm_platform, Some(&media));
            let mut trailing = div().flex().items_center().gap(px(8.)).child(
                Badge::new(match row.state {
                    SystemAccessState::Granted => "Granted",
                    SystemAccessState::NotGranted => "Not granted",
                    SystemAccessState::FirstUse => "Not asked yet",
                    SystemAccessState::DeviceIssue => "Device issue",
                    SystemAccessState::Waiting => "Waiting…",
                    SystemAccessState::NeedsRelaunch => "Needs relaunch",
                    SystemAccessState::NotRequired => "Not required",
                    SystemAccessState::Unavailable => "Unavailable",
                })
                .variant(if row.state == SystemAccessState::Granted {
                    BadgeVariant::Success
                } else {
                    BadgeVariant::Outline
                }),
            );
            if let Some(action) = action {
                if row.id != SystemAccessRowId::SystemAudio {
                    let pane = row.id.pane();
                    let label = match action {
                        SystemAccessAction::RequestMediaAccess => "Allow…",
                        SystemAccessAction::OpenSettings => "Open Settings…",
                        SystemAccessAction::Relaunch => "Reopen Videorc",
                    };
                    trailing = trailing.child(
                        Button::new(("first-run-grant", index))
                            .label(label)
                            .variant(ButtonVariant::Outline)
                            .disabled(locked || screen.pending_permission.is_some())
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.permission_action(pane, action, cx)
                                    })
                                }
                            }),
                    );
                }
            }
            list = list.item(ListRow::new(("first-run-row", index), row.label).child(trailing));
        }
        column = column.child(list).child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(segmented_meter(screen.mic_view, t))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child("Say something. The bar moves when Videorc hears you."),
                ),
        );
    }
    column = column.child(div().type_scale(text::META).child(format!(
        "Recordings stay on this {noun}. Cloud AI only runs after you opt in."
    )));
    column.into_any_element()
}

fn goal_body(noun: &str, entity: &Entity<FirstRunScreen>, locked: bool) -> gpui::AnyElement {
    let choices = [
        (
            Goal::Record,
            "Recordings",
            format!("Tutorials, demos and videos, saved on this {noun}."),
        ),
        (
            Goal::Stream,
            "Livestreams",
            "Go live on YouTube, Twitch, Kick or X.".into(),
        ),
        (Goal::Both, "Both", "Record and go live.".into()),
    ];
    let mut list = GroupedList::new().label("What are you making?");
    for (goal, title, line) in choices {
        list = list.item(
            ListRow::new(title, title).context(line).child(
                Button::new(format!("first-run-goal-{title}"))
                    .label(title)
                    .variant(ButtonVariant::Ghost)
                    .disabled(locked)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.pick_goal(goal, cx))
                    }),
            ),
        );
    }
    list.into_any_element()
}

fn look_body(
    screen: &FirstRunScreen,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    t: &videorc_kit::tokens::Theme,
) -> gpui::AnyElement {
    let mut orientation = SegmentedControl::new("first-run-orientation")
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

    let mut backgrounds = div().flex().flex_wrap().gap(px(6.));
    let none_selected = screen.live_background.is_none();
    backgrounds = backgrounds.child(
        Button::new("first-run-bg-none")
            .label("None")
            .variant(if none_selected {
                ButtonVariant::Default
            } else {
                ButtonVariant::Outline
            })
            .disabled(locked)
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |this, cx| {
                        this.live_background = None;
                        cx.notify();
                    })
                }
            }),
    );
    for id in assets::live_backgrounds_offered() {
        let selected = screen.live_background == Some(*id);
        backgrounds = backgrounds.child(
            Button::new(format!("first-run-bg-{id}"))
                .label(assets::live_background_name(id))
                .variant(if selected {
                    ButtonVariant::Default
                } else {
                    ButtonVariant::Outline
                })
                .disabled(locked)
                .on_click({
                    let entity = entity.clone();
                    let id = *id;
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.live_background = Some(id);
                            cx.notify();
                        })
                    }
                }),
        );
    }

    let bg_line = match screen.live_background {
        Some(id) => format!("{}, moving behind you.", assets::live_background_name(id)),
        None => "No background: your screen and camera fill the picture.".into(),
    };

    let picture_w = if screen.orientation == Orientation::Vertical {
        120.
    } else {
        220.
    };
    let picture_h = if screen.orientation == Orientation::Vertical {
        214.
    } else {
        124.
    };
    let camera_radius = match screen.camera_shape {
        CameraShape::Rectangle => 0.,
        CameraShape::Rounded => 10.,
        CameraShape::Circle => 999.,
    };

    let vertical = screen.orientation == Orientation::Vertical;
    let mut layouts = div().flex().flex_wrap().gap(px(6.));
    for (preset, label) in LAYOUT_PRESET_LABELS {
        let is_vertical = preset.starts_with("vertical-");
        if is_vertical != vertical {
            continue;
        }
        let selected = screen.layout_preset.as_deref() == Some(preset);
        layouts = layouts.child(
            Button::new(format!("first-run-layout-{preset}"))
                .label(*label)
                .variant(if selected {
                    ButtonVariant::Default
                } else {
                    ButtonVariant::Outline
                })
                .disabled(locked)
                .on_click({
                    let entity = entity.clone();
                    let preset = (*preset).to_string();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| this.set_layout(preset.clone(), cx))
                    }
                }),
        );
    }

    div()
        .flex()
        .flex_col()
        .gap(px(16.))
        .child(
            // Scene picture stand-in (P1470): composition frame until the
            // live preview surface mounts inside setup.
            div()
                .id("first-run-look-picture")
                .flex()
                .justify_center()
                .child(
                    div()
                        .w(px(picture_w))
                        .h(px(picture_h))
                        .rounded(px(radius::MD))
                        .border_1()
                        .border_color(hsla(t.border))
                        .bg(hsla(t.muted))
                        .flex()
                        .items_end()
                        .justify_end()
                        .p(px(8.))
                        .child(
                            div()
                                .w(px(44.))
                                .h(px(44.))
                                .rounded(px(camera_radius))
                                .bg(hsla(t.accent))
                                .border_1()
                                .border_color(hsla(t.border)),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(SectionLabel::new("Orientation"))
                .child(orientation)
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child("Vertical is for Shorts, Reels and TikTok."),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(SectionLabel::new("Camera shape"))
                .child(shape),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(SectionLabel::new("Background"))
                .child(backgrounds)
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(bg_line),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(SectionLabel::new("Layout"))
                .child(layouts)
                .child(
                    Button::new("first-run-back-permissions")
                        .label("Back to permissions")
                        .variant(ButtonVariant::Ghost)
                        .disabled(locked)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, cx| this.go_to(Step::Permissions, cx))
                            }
                        }),
                ),
        )
        .into_any_element()
}

fn sound_body(
    screen: &FirstRunScreen,
    snapshot: &videorc_app_core::studio::StudioSnapshot,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    offline: bool,
    noun: &str,
    t: &videorc_kit::tokens::Theme,
    window: &mut Window,
    cx: &mut Context<FirstRunScreen>,
) -> gpui::AnyElement {
    let _ = (window, cx);
    let mic_id = snapshot.settings.capture.sources.microphone_id.clone();
    let mut picker = Select::new("first-run-microphone")
        .option("", "Off")
        .disabled(locked || offline)
        .value(mic_id.clone().map(SharedString::from));
    for device in &snapshot.sources.devices.devices {
        if device.kind == videorc_app_core::protocol::DeviceKind::Microphone {
            picker = picker.option(device.id.clone(), device.name.clone());
        }
    }
    picker = picker.on_change({
        let entity = entity.clone();
        move |id, _, cx| entity.update(cx, |this, cx| this.pick_microphone(id.to_string(), cx))
    });

    let system_checked = snapshot.settings.capture.audio.system_audio_enabled;
    let system = Switch::new("first-run-system-audio")
        .accessibility_label("System audio")
        .checked(system_checked)
        .disabled(locked)
        .on_change({
            let entity = entity.clone();
            move |enabled, _, cx| entity.update(cx, |this, cx| this.set_system_audio(enabled, cx))
        });

    let mic_blocked = !offline
        && snapshot
            .settings
            .capture
            .sources
            .microphone_id
            .as_ref()
            .is_none_or(|id| id.is_empty());

    let reading = fr::sound::reading(&screen.samples, now_ms());
    let level_ready = reading.speech_peak_db.is_some();

    let mut column = div().flex().flex_col().gap(px(12.)).child(
        GroupedList::new()
            .label("Sound check")
            .item(ListRow::new("first-run-mic", "Microphone").child(picker)),
    );

    if mic_blocked {
        column = column.child(
            Alert::new("first-run-mic-blocked")
                .variant(AlertVariant::Warning)
                .title("Videorc can't hear your microphone yet.")
                .action(
                    Button::new("first-run-sound-back-permissions")
                        .label("Back to permissions")
                        .variant(ButtonVariant::Ghost)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, cx| this.go_to(Step::Permissions, cx))
                            }
                        }),
                ),
        );
    } else {
        column = column.child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(segmented_meter(screen.mic_view, t))
                .child(SectionLabel::new("Microphone gain"))
                .child(Slider::new(&screen.mic_gain).disabled(locked))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex_1()
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(reading.verdict.copy()),
                        )
                        .child(
                            Button::new("first-run-set-level")
                                .label("Set level for me")
                                .variant(ButtonVariant::Outline)
                                .disabled(locked || !level_ready)
                                .tooltip(if level_ready {
                                    "Set level for me"
                                } else {
                                    "Talk for a few seconds first."
                                })
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |this, cx| this.set_level_for_me(cx))
                                    }
                                }),
                        ),
                ),
        );
    }

    column = column.child(
        ListRow::new("first-run-system", "System audio")
            .context(format!(
                "The sound your {noun} plays: games, music and calls. Its level shows once you record or go live."
            ))
            .child(system),
    );

    column.into_any_element()
}

fn destinations_body(
    screen: &FirstRunScreen,
    entity: &Entity<FirstRunScreen>,
    locked: bool,
    offline: bool,
) -> gpui::AnyElement {
    let platforms = screen.studio.platforms_now();
    let mut list = GroupedList::new().label("Where you stream");
    for id in SETUP_PLATFORMS {
        let name = platform_label(id);
        let account = platforms
            .accounts
            .iter()
            .find(|account| account.platform == id);
        let connected = account.is_some_and(|a| a.status == AccountStatus::Connected);
        let mut row = ListRow::new(name, name).child(
            Badge::new(if connected {
                "Connected"
            } else {
                "Not connected"
            })
            .variant(if connected {
                BadgeVariant::Success
            } else {
                BadgeVariant::Outline
            }),
        );
        if !connected {
            row = row.child(
                Button::new(format!("first-run-signin-{name}"))
                    .label("Sign in…")
                    .variant(ButtonVariant::Outline)
                    .disabled(locked || offline)
                    .tooltip("Finish sign-in in Destinations."),
            );
        }
        list = list.item(row);
    }
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
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
                    div().flex_1().type_scale(text::META).child(
                        "Using a stream key, TikTok or Instagram? Set it up in Destinations.",
                    ),
                )
                .child(
                    Button::new("first-run-open-destinations")
                        .label("Open Destinations")
                        .variant(ButtonVariant::Outline)
                        .disabled(locked || !PageId::Live.ported())
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
