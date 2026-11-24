use super::*;
use gpui::{AnyElement, SharedString};
use videorc_app_core::{first_run as f, nav::PageId, studio::source_selection::SourceKind};
use videorc_kit::{
    button::{Button, ButtonVariant},
    dialog::{Dialog, DialogSize},
    list_row::{GroupedList, ListRow},
    select::Select,
    switch::Switch,
};

pub(super) struct Replay {
    dialog: DialogHandle,
    step: f::Step,
    goal: Option<f::Goal>,
}
impl Default for Replay {
    fn default() -> Self {
        Self {
            dialog: DialogHandle::new(false),
            step: f::Step::Permissions,
            goal: None,
        }
    }
}
impl SettingsScreen {
    pub(super) fn account_name(&self) -> Option<String> {
        let account = self.account.as_ref()?;
        if account.status != videorc_app_core::protocol::AccountStatus::SignedIn {
            return None;
        }
        let username = account.username.as_ref().filter(|s| !s.is_empty())?;
        Some(
            account
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(username)
                .to_string(),
        )
    }
    pub(super) fn open_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled() || self.studio.snapshot().session.phase.is_active() {
            return;
        }
        self.setup.goal = self
            .studio
            .setting(f::FIRST_RUN_KEY)
            .and_then(|value| f::parse_record(Some(&value.to_string())))
            .and_then(|record| record.goal);
        self.setup.step =
            f::steps_for(self.setup.goal, Some(crate::app::hotkeys::node_platform()))[0];
        // A replay writes no onboarding marker and starts no session or
        // performance capture. All changes below require an explicit click.
        self.setup.dialog.open(window, cx);
        self.refresh(cx);
        cx.notify();
    }
    fn setup_next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match f::next_step(
            self.setup.step,
            self.setup.goal,
            Some(crate::app::hotkeys::node_platform()),
        ) {
            Some(step) => self.setup.step = step,
            None => self.setup.dialog.close(window, cx),
        }
        cx.notify();
    }
    fn setup_pick_microphone(&mut self, id: String, cx: &mut Context<Self>) {
        if self.disabled() || self.studio.snapshot().session.phase.is_active() {
            return;
        }
        self.busy = true;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .select_source_device(
                    SourceKind::Microphone,
                    (!id.is_empty()).then_some(id.as_str()),
                )
                .await
                .is_ok()
        });
        self.finish_save(job, cx);
    }
    pub(super) fn setup_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.setup.dialog.is_open() {
            return div().into_any_element();
        }
        let snapshot = self.studio.snapshot();
        let locked = self.disabled() || snapshot.session.phase.is_active();
        let platform = Some(crate::app::hotkeys::node_platform());
        let (position, count) = f::step_position(self.setup.step, self.setup.goal, platform);
        let title = match self.setup.step {
            f::Step::Permissions => "Welcome to Videorc",
            f::Step::Goal => "What are you making?",
            f::Step::Look => "Your look",
            f::Step::Sound => "Sound check",
            f::Step::Destinations => "Where you stream",
        };
        let body = match self.setup.step {
            f::Step::Permissions => self.permission_page(window, cx),
            f::Step::Goal => {
                let mut choices = GroupedList::new();
                for (goal, label, line) in [(f::Goal::Record, "Recordings", "Tutorials, demos and videos, saved on this Mac."), (f::Goal::Stream, "Livestreams", "Go live on YouTube, Twitch, Kick or X."), (f::Goal::Both, "Both", "Record and go live.")] {
                    choices = choices.item(div().child(ListRow::new(label,label).child(Button::new(label).label(label).variant(ButtonVariant::Outline).disabled(locked).on_click(cx.listener(move |this, _, window, cx| { this.setup.goal = Some(goal); this.setup_next(window,cx); })))).child(line));
                }
                div().child("Pick what you'll do most. It only changes the next steps.").child(choices).into_any_element()
            }
            f::Step::Look => {
                let mut choices = GroupedList::new();
                for scene in &snapshot.scenes.scenes {
                    let id = scene.id.clone();
                    choices = choices.item(ListRow::new(SharedString::from(id.clone()), scene.name.clone()).child(Button::new(SharedString::from(format!("setup-scene-{id}"))).label(scene.name.clone()).variant(ButtonVariant::Outline).disabled(locked || snapshot.scenes.transaction_pending).on_click(cx.listener(move |this, _, _, cx| {
                        if this.disabled() || this.studio.snapshot().session.phase.is_active() { return; }
                        this.busy = true;
                        let studio = this.studio.clone(); let id = id.clone();
                        let job = this.runtime.spawn(async move { studio.apply_saved_scene_by_id(&id).await });
                        this.finish_save(job,cx);
                    }))));
                }
                div().child("How you'll look in recordings and livestreams. Change it any time on the Scene page.").child(choices).into_any_element()
            }
            f::Step::Sound => {
                let mut picker = Select::new("setup-microphone").option("", "Off").disabled(locked || snapshot.source_reasons[2].is_some()).value(snapshot.settings.capture.sources.microphone_id.clone().map(SharedString::from));
                for device in &snapshot.sources.devices.devices {
                    if device.kind == videorc_app_core::protocol::DeviceKind::Microphone { picker = picker.option(device.id.clone(), device.name.clone()); }
                }
                let entity = cx.entity();
                let picker = picker.on_change(move |id, _, cx| entity.update(cx, |this, cx| this.setup_pick_microphone(id.to_string(), cx)));
                let entity = cx.entity();
                let system = Switch::new("setup-system-audio").accessibility_label("System audio").checked(snapshot.settings.capture.audio.system_audio_enabled).disabled(locked).on_change(move |enabled, _, cx| entity.update(cx, |this,cx| {
                    if this.disabled() || this.studio.snapshot().session.phase.is_active() { return; }
                    this.busy = true;
                    let studio = this.studio.clone(); let job = this.runtime.spawn(async move { studio.set_system_audio_enabled(enabled).await; true }); this.finish_save(job,cx);
                }));
                div().child("Pick your microphone and talk the way you will when you record.").child(GroupedList::new().item(ListRow::new("setup-mic", "Microphone").child(picker)).item(ListRow::new("setup-system", "System audio").child(system))).into_any_element()
            }
            f::Step::Destinations => div().child("Sign in, and Videorc sets your title and gets the stream key for you. Each one you connect is turned on for Go Live.").child(Button::new("setup-destinations").label("Open Destinations").disabled(!PageId::Live.ported()).tooltip(view::NOT_IN_THIS_BUILD).on_click(cx.listener(|this, _, window, cx| { this.setup.dialog.close(window,cx); cx.emit(Navigate(PageId::Live)); }))).into_any_element(),
        };
        let previous = f::previous_step(self.setup.step, self.setup.goal, platform);
        let last = f::next_step(self.setup.step, self.setup.goal, platform).is_none();
        Dialog::new("settings-setup-replay", &self.setup.dialog, title)
            .size(DialogSize::Lg)
            .description(format!("Step {position} of {count}, {title}"))
            .children(
                snapshot
                    .session
                    .phase
                    .is_active()
                    .then_some(f::REPLAY_LOCKED_REASON),
            )
            .children(self.error.clone())
            .child(body)
            .footer(
                Button::new("setup-skip")
                    .label("Skip setup")
                    .variant(ButtonVariant::Ghost)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.setup.dialog.close(window, cx)),
                    ),
            )
            .footer(
                Button::new("setup-back")
                    .label("Back")
                    .variant(ButtonVariant::Outline)
                    .disabled(previous.is_none() || locked)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(step) = previous {
                            this.setup.step = step;
                            cx.notify();
                        }
                    })),
            )
            .footer(
                Button::new("setup-next")
                    .label(if last { "Done" } else { "Continue" })
                    .disabled(
                        locked || (self.setup.step == f::Step::Goal && self.setup.goal.is_none()),
                    )
                    .on_click(cx.listener(|this, _, window, cx| this.setup_next(window, cx))),
            )
            .into_any_element()
    }
}
