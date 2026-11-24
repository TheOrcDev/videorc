//! First-run setup (plan 260 Phase 3, L4): the full-window welcome from
//! `videorc_app_core::first_run` (#1766), drawn with `videorc-kit`. Words
//! match Electron's `components/first-run/*` and `lib/first-run.ts`.

use std::sync::Arc;

use gpui::{Context, EventEmitter, SharedString, Window, div, prelude::*, px, relative};
use videorc_app_core::assets;
use videorc_app_core::first_run::{self as fr, Goal, Leave, SetupMode, Step};
use videorc_app_core::format::device_noun;
use videorc_app_core::nav::PageId;
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
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{radius, size, text};

pub type AppStudio = Studio<BackendClient>;

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

/// Shell opens Destinations or another page after setup.
#[derive(Debug, Clone, Copy)]
pub struct OpenPage(pub PageId);

pub struct FirstRunScreen {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    open: bool,
    mode: SetupMode,
    step: Step,
    goal: Option<Goal>,
    orientation: Orientation,
    camera_shape: CameraShape,
    live_background: Option<&'static str>,
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
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            loop {
                if studio_rx.changed().await.is_err() {
                    break;
                }
                let _ = this.update(cx, |_, cx| cx.notify());
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            open: false,
            mode: SetupMode::FirstRun,
            step: Step::Permissions,
            goal: None,
            orientation: Orientation::Horizontal,
            camera_shape: CameraShape::Rectangle,
            live_background: None,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn open_replay(&mut self, return_to: PageId, cx: &mut Context<Self>) {
        if self.studio.snapshot().session.phase.is_active() {
            return;
        }
        let platform = Some(crate::app::hotkeys::node_platform());
        self.mode = SetupMode::Replay { return_to };
        self.goal = self
            .studio
            .setting(fr::FIRST_RUN_KEY)
            .and_then(|value| fr::parse_record(Some(&value.to_string())))
            .and_then(|record| record.goal);
        self.step = fr::steps_for(self.goal, platform)[0];
        self.open = true;
        self.studio.set_clips_first_run_setup_open(true);
        cx.notify();
    }

    pub fn open_first_run(&mut self, step: Step, goal: Option<Goal>, cx: &mut Context<Self>) {
        let platform = Some(crate::app::hotkeys::node_platform());
        self.mode = SetupMode::FirstRun;
        self.goal = goal;
        let steps = fr::steps_for(goal, platform);
        self.step = steps
            .into_iter()
            .find(|candidate| *candidate >= step)
            .unwrap_or(Step::Permissions);
        self.open = true;
        self.studio.set_clips_first_run_setup_open(true);
        cx.notify();
    }

    fn platform(&self) -> &'static str {
        crate::app::hotkeys::node_platform()
    }

    fn leave(&mut self, leave: Leave, cx: &mut Context<Self>) {
        self.open = false;
        self.studio.set_clips_first_run_setup_open(false);
        if matches!(self.mode, SetupMode::FirstRun) {
            // Persistence for a true first run lands with the local store
            // slice; replay writes nothing (Electron / app-core).
        }
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
            cx.notify();
        }
    }

    fn go_to(&mut self, step: Step, cx: &mut Context<Self>) {
        let platform = Some(self.platform());
        if fr::steps_for(self.goal, platform).contains(&step) {
            self.step = step;
            cx.notify();
        }
    }

    fn pick_goal(&mut self, goal: Goal, cx: &mut Context<Self>) {
        self.goal = Some(goal);
        let platform = Some(self.platform());
        match fr::next_step(Step::Goal, Some(goal), platform) {
            Some(step) => {
                self.step = step;
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
            Step::Permissions => permissions_body(platform, noun),
            Step::Goal => goal_body(noun, self.goal, &entity, locked),
            Step::Look => look_body(self, &entity, locked, &t),
            Step::Sound => sound_body(self, &snapshot, &entity, locked, offline, noun, &t),
            Step::Destinations => destinations_body(&entity, locked, offline),
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
        // Goal rows are the action; no primary (Electron).
        if self.step != Step::Goal {
            // Permissions: Continue once grants are in, else Skip for now.
            // Without a live grant map yet, Skip for now is the outline primary.
            let label = if self.step == Step::Permissions {
                "Skip for now"
            } else {
                next_label(self.mode, last)
            };
            let variant = if self.step == Step::Permissions {
                ButtonVariant::Outline
            } else {
                ButtonVariant::Default
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
                // Title band (traffic-light line / drag region).
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

fn permissions_body(platform: &str, noun: &str) -> gpui::AnyElement {
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
    } else {
        // Grant rows + mic proof wire with the system-access list; until
        // then keep the privacy footnote Electron shows under the title.
        column = column.child(div().type_scale(text::META).child(format!(
            "Recordings stay on this {noun}. Cloud AI only runs after you opt in."
        )));
    }
    column.into_any_element()
}

fn goal_body(
    noun: &str,
    _selected: Option<Goal>,
    entity: &gpui::Entity<FirstRunScreen>,
    locked: bool,
) -> gpui::AnyElement {
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
    entity: &gpui::Entity<FirstRunScreen>,
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

    div()
        .flex()
        .flex_col()
        .gap(px(16.))
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
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child("Pick a layout on the Scene page after setup."),
                )
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
    entity: &gpui::Entity<FirstRunScreen>,
    locked: bool,
    offline: bool,
    noun: &str,
    t: &videorc_kit::tokens::Theme,
) -> gpui::AnyElement {
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
        column = column
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(fr::sound::Verdict::None.copy()),
            )
            .child(
                Button::new("first-run-set-level")
                    .label("Set level for me")
                    .variant(ButtonVariant::Outline)
                    .disabled(true)
                    .tooltip("Talk for a few seconds first."),
            );
    }

    column = column.child(
        ListRow::new("first-run-system", "System audio")
            .context(format!(
                "The sound your {noun} plays: games, music and calls. Its level shows once you record or go live."
            ))
            .child(system),
    );

    let _ = screen;
    column.into_any_element()
}

fn destinations_body(
    entity: &gpui::Entity<FirstRunScreen>,
    locked: bool,
    offline: bool,
) -> gpui::AnyElement {
    let platforms = ["YouTube", "Twitch", "Kick", "X"];
    let mut list = GroupedList::new().label("Where you stream");
    for name in platforms {
        list = list.item(
            ListRow::new(name, name)
                .child(Badge::new("Not connected").variant(BadgeVariant::Outline))
                .child(
                    Button::new(format!("first-run-signin-{name}"))
                        .label("Sign in…")
                        .variant(ButtonVariant::Outline)
                        .disabled(locked || offline),
                ),
        );
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
