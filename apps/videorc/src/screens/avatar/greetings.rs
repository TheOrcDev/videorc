//! Avatar → Greetings (`buddy-greetings-section.tsx`, plan 164 S-D5, plan
//! 192): what the avatar says when someone chats for the first time (the
//! welcomes) or chat does something (the Activity kinds). Every kind has a
//! built-in line until you write your own, so an empty list never means
//! silence: a kind with no line of yours shows its built-in one as a Default
//! row, and editing it or switching it off makes it yours. A click opens
//! the row's inline editor. Saves on blur and on every switch, through
//! `cohost.settings.set` `{ autoChat }`; no success toasts.

use gpui::{AnyElement, Context, Entity, KeyDownEvent, SharedString, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::buddy::chat::{
    ACTIVITY_KINDS, ANY_PLATFORM, GreetingKind, GreetingRow, TEMPLATE_TEXT_MAX_CHARS,
    TEMPLATES_MAX, activity_rows, add_option_label, auto_chat_patch, builtin, display_name,
    field_entry, fields_for, kind_platforms, new_template, platform_id, platform_label, preview,
    templates_full_line, warnings, welcome_rows, welcomes, with_welcome_text,
};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::field::{Field, FieldGroup};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::popover::Popover;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::{Select, SelectSize};
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::switch::Switch;
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};
use videorc_protocol::cohost::{
    CohostAutoChat, CohostGreetingPlatform, CohostGreetingTemplate, CohostGreetingsSettings,
    CohostTalkMode, CohostUtteranceState, WelcomeLine,
};

use super::AvatarScreen;
use super::reactions::SaveSection;

/// The Avatar state the line is said in (`STATE_OPTIONS`).
const STATES: [(&str, &str, CohostUtteranceState); 3] = [
    ("talk", "Talk", CohostUtteranceState::Talk),
    ("laugh", "Laugh", CohostUtteranceState::Laugh),
    ("think", "Think", CohostUtteranceState::Think),
];
const PLATFORMS: [CohostGreetingPlatform; 4] = [
    CohostGreetingPlatform::Twitch,
    CohostGreetingPlatform::Youtube,
    CohostGreetingPlatform::Kick,
    CohostGreetingPlatform::X,
];
/// Sidekick → Chat, where "Write greetings with AI" lives.
pub const SIDEKICK_CHAT_TAB: usize = 1;
/// An open line's editor adds a variant from the keyboard too (G-23,
/// `ADD_VARIANT_ACCELERATOR`).
const ADD_VARIANT_ACCELERATOR: &str = "CmdOrCtrl+N";

/// The open row's editor: its text box and what it opened with.
pub(super) struct GreetingEditor {
    /// The row's key: a template id, `default:<kind>` or `welcome:<kind>`.
    key: String,
    kind: GreetingKind,
    text: Entity<TextareaState>,
    /// The saved text; empty for a welcome on its built-in line.
    saved: String,
    /// A welcome's built-in line: the placeholder, and what empty posts.
    fallback: Option<String>,
}

/// What an editor's row is.
enum Target {
    Welcome(GreetingKind),
    Default(videorc_protocol::cohost::CohostActivityTemplateKind),
    Template(String),
}

fn target_of(key: &str, kind: GreetingKind) -> Target {
    if key.starts_with("welcome:") && kind.is_welcome() {
        Target::Welcome(kind)
    } else if let (Some(_), GreetingKind::Activity(kind)) = (key.strip_prefix("default:"), kind) {
        Target::Default(kind)
    } else {
        Target::Template(key.to_string())
    }
}

fn state_word(state: CohostUtteranceState) -> &'static str {
    STATES
        .iter()
        .find(|(_, _, known)| *known == state)
        .map_or("talk", |(id, _, _)| *id)
}

impl AvatarScreen {
    fn greetings_now(&self) -> Option<(CohostAutoChat, CohostGreetingsSettings)> {
        let auto_chat = self.auto_chat.clone()?;
        let greetings = auto_chat.greetings.clone();
        Some((auto_chat, greetings))
    }

    /// Every save spreads the stored block, so the AI switch and the
    /// welcomes ride along with a line's edit.
    fn save_greetings(&mut self, greetings: CohostGreetingsSettings, cx: &mut Context<Self>) {
        let Some(auto_chat) = self.auto_chat.as_mut() else {
            return;
        };
        let patch = auto_chat_patch(auto_chat, greetings.clone());
        // The rows follow at once; the answer confirms.
        auto_chat.greetings = greetings;
        self.patch_settings(patch, SaveSection::Greetings, cx);
    }

    fn set_greetings_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if let Some((_, greetings)) = self.greetings_now() {
            self.save_greetings(
                CohostGreetingsSettings {
                    enabled,
                    ..greetings
                },
                cx,
            );
        }
    }

    fn change_welcome(
        &mut self,
        kind: GreetingKind,
        change: impl FnOnce(WelcomeLine) -> WelcomeLine,
        cx: &mut Context<Self>,
    ) {
        let Some((_, mut greetings)) = self.greetings_now() else {
            return;
        };
        let welcomes = &mut greetings.welcomes;
        let slot = match kind {
            GreetingKind::FirstTime => &mut welcomes.first_time,
            GreetingKind::Returning => &mut welcomes.returning,
            GreetingKind::Regular => &mut welcomes.regular,
            GreetingKind::Comeback => &mut welcomes.comeback,
            GreetingKind::Milestone => &mut welcomes.milestone,
            GreetingKind::Activity(_) => return,
        };
        let next = change(slot.clone());
        *slot = next;
        self.save_greetings(greetings, cx);
    }

    fn change_template(
        &mut self,
        id: &str,
        change: impl FnOnce(&mut CohostGreetingTemplate),
        cx: &mut Context<Self>,
    ) {
        let Some((_, mut greetings)) = self.greetings_now() else {
            return;
        };
        let Some(template) = greetings
            .templates
            .iter_mut()
            .find(|template| template.id == id)
        else {
            return;
        };
        change(template);
        self.save_greetings(greetings, cx);
    }

    /// Adds a line; a full list says so instead.
    fn add_template(&mut self, template: CohostGreetingTemplate, cx: &mut Context<Self>) -> bool {
        let Some((_, mut greetings)) = self.greetings_now() else {
            return false;
        };
        if greetings.templates.len() >= TEMPLATES_MAX {
            self.save_error = Some((SaveSection::Greetings, templates_full_line()));
            cx.notify();
            return false;
        }
        greetings.templates.push(template);
        self.save_greetings(greetings, cx);
        true
    }

    fn remove_template(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some((_, mut greetings)) = self.greetings_now() else {
            return;
        };
        greetings.templates.retain(|template| template.id != id);
        self.greeting_editor = None;
        self.save_greetings(greetings, cx);
    }

    fn new_line(
        kind: videorc_protocol::cohost::CohostActivityTemplateKind,
    ) -> CohostGreetingTemplate {
        new_template(kind, uuid::Uuid::new_v4().to_string())
    }

    /// A click on a row opens its editor, or closes the open one.
    fn toggle_editor(&mut self, row: &GreetingRow, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .greeting_editor
            .as_ref()
            .is_some_and(|editor| editor.key == row.key)
        {
            self.close_editor(cx);
            return;
        }
        self.close_editor(cx);
        let welcome = row.key.starts_with("welcome:");
        // A welcome on its built-in line edits an empty box over it.
        let saved = if welcome && row.default {
            String::new()
        } else {
            row.text.clone()
        };
        let fallback = welcome.then(|| builtin(row.kind).0.to_string());
        let placeholder = fallback
            .clone()
            .unwrap_or_else(|| builtin(row.kind).0.into());
        let initial = saved.clone();
        let text = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(placeholder)
                .default_value(initial)
        });
        cx.subscribe_in(
            &text,
            window,
            |screen, _, event: &InputEvent, _, cx| match event {
                InputEvent::Blur => screen.commit_editor(cx),
                _ => cx.notify(),
            },
        )
        .detach();
        self.greeting_editor = Some(GreetingEditor {
            key: row.key.clone(),
            kind: row.kind,
            text,
            saved,
            fallback,
        });
        cx.notify();
    }

    fn close_editor(&mut self, cx: &mut Context<Self>) {
        self.commit_editor(cx);
        self.greeting_editor = None;
        cx.notify();
    }

    /// The text, saved on blur, Escape and Add variant. A line's text is
    /// never empty (the settings refuse it), so clearing it keeps the line;
    /// an empty welcome goes back to its built-in line.
    fn commit_editor(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.greeting_editor.as_ref() else {
            return;
        };
        let draft = editor.text.read(cx).value().trim().to_string();
        if draft == editor.saved {
            return;
        }
        if draft.is_empty() && editor.fallback.is_none() {
            return;
        }
        let target = target_of(&editor.key, editor.kind);
        if let Some(editor) = self.greeting_editor.as_mut() {
            editor.saved = draft.clone();
        }
        match target {
            Target::Welcome(kind) => {
                self.change_welcome(kind, |welcome| with_welcome_text(welcome, &draft), cx)
            }
            Target::Default(kind) => {
                let template = CohostGreetingTemplate {
                    text: draft,
                    ..Self::new_line(kind)
                };
                let id = template.id.clone();
                if self.add_template(template, cx)
                    && let Some(editor) = self.greeting_editor.as_mut()
                {
                    // The row is yours now: the editor follows it.
                    editor.key = id;
                }
            }
            Target::Template(id) => self.change_template(&id, |template| template.text = draft, cx),
        }
    }

    fn set_line_state(&mut self, state: CohostUtteranceState, cx: &mut Context<Self>) {
        let Some(editor) = self.greeting_editor.as_ref() else {
            return;
        };
        match target_of(&editor.key, editor.kind) {
            Target::Welcome(kind) => {
                self.change_welcome(kind, |welcome| WelcomeLine { state, ..welcome }, cx)
            }
            Target::Default(kind) => {
                let template = CohostGreetingTemplate {
                    state,
                    ..Self::new_line(kind)
                };
                let id = template.id.clone();
                if self.add_template(template, cx)
                    && let Some(editor) = self.greeting_editor.as_mut()
                {
                    editor.key = id;
                }
            }
            Target::Template(id) => {
                self.change_template(&id, |template| template.state = state, cx)
            }
        }
    }

    fn set_line_platform(
        &mut self,
        platform: Option<CohostGreetingPlatform>,
        cx: &mut Context<Self>,
    ) {
        let Some(editor) = self.greeting_editor.as_ref() else {
            return;
        };
        match target_of(&editor.key, editor.kind) {
            Target::Welcome(_) => {}
            Target::Default(kind) => {
                let template = CohostGreetingTemplate {
                    platform,
                    ..Self::new_line(kind)
                };
                let id = template.id.clone();
                if self.add_template(template, cx)
                    && let Some(editor) = self.greeting_editor.as_mut()
                {
                    editor.key = id;
                }
            }
            Target::Template(id) => {
                self.change_template(&id, |template| template.platform = platform, cx)
            }
        }
    }

    /// Add variant: another line of the open one's kind and platform.
    fn add_variant(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_editor(cx);
        let Some(editor) = self.greeting_editor.as_ref() else {
            return;
        };
        let Target::Template(id) = target_of(&editor.key, editor.kind) else {
            return;
        };
        let GreetingKind::Activity(kind) = editor.kind else {
            return;
        };
        let platform = self
            .auto_chat
            .as_ref()
            .and_then(|auto| auto.greetings.templates.iter().find(|t| t.id == id))
            .and_then(|template| template.platform);
        let template = CohostGreetingTemplate {
            platform,
            ..Self::new_line(kind)
        };
        let row = GreetingRow {
            key: template.id.clone(),
            kind: editor.kind,
            title: "",
            text: template.text.clone(),
            default: false,
            enabled: true,
            platform,
            state: template.state,
            warnings: Vec::new(),
        };
        if self.add_template(template, cx) {
            self.greeting_editor = None;
            self.toggle_editor(&row, window, cx);
        }
    }

    fn insert_field(&mut self, field: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.greeting_editor.as_mut() else {
            return;
        };
        let current = editor.text.read(cx).value().to_string();
        let gap = if current.is_empty() || current.ends_with(' ') {
            ""
        } else {
            " "
        };
        let next = format!("{current}{gap}{{{field}}}");
        editor
            .text
            .update(cx, |state, cx| state.set_value(next, window, cx));
        cx.notify();
    }

    /// Escape saves and closes; ⌘/Ctrl+N saves and adds a variant.
    fn editor_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if key == "escape" {
            cx.stop_propagation();
            self.close_editor(cx);
        } else if key == "n" && event.keystroke.modifiers.secondary(cx) {
            cx.stop_propagation();
            self.add_variant(window, cx);
        }
    }
}

pub(super) fn render_greetings(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> Option<AnyElement> {
    let auto_chat = screen.auto_chat.as_ref()?;
    let greetings = &auto_chat.greetings;
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let name = display_name(screen.persona.as_ref().map(|persona| persona.name.as_str()));
    // A chat's length cap means nothing while the avatar talks in its bubble.
    let chat_caps = auto_chat.talk.unwrap_or_default() != CohostTalkMode::Bubble;

    let enabled = entity.clone();
    // A settings row sits in a grouped card like every Settings row (plan
    // 168 S-02). Electron's Greetings row is its own `items-center` line
    // (label over description at `gap-0.5`), so the switch centres on both.
    let switch_row = div()
        .id("avatar-greetings-enabled-row")
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w(px(0.))
                .gap(px(2.))
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .child("Greetings"),
                )
                .child(meta(
                    "New chatters, follows, subs, raids and the rest, each with its own line.",
                    t,
                )),
        )
        .child(
            Switch::new("avatar-greetings-enabled")
                .accessibility_label("Greetings")
                .checked(greetings.enabled)
                .on_change(move |on, _, cx| {
                    enabled.update(cx, |screen, cx| screen.set_greetings_enabled(on, cx))
                }),
        );
    let ai_line = if greetings.ai {
        format!(
            "On: Sidekick writes each greeting in {name}'s voice, with your line as the example."
        )
    } else {
        format!("Off: {name} says your lines as they are.")
    };
    let open_chat = entity.clone();
    // Plan 239: writing them with AI is Sidekick's (Premium and cloud AI),
    // so its switch lives with Answers and Banter.
    // A horizontal Field: the pointer sits on the label's line.
    let ai_row = SettingsRow::new("avatar-greetings-ai-row", "Write greetings with AI")
        .flush(true)
        .description(ai_line)
        .child(
            Button::new("avatar-greetings-ai-pointer")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label("Sidekick → Chat")
                .child(icon(IconName::CaretRight, 12., hsla(t.foreground)))
                .on_click(move |_, _, cx| {
                    open_chat.update(cx, |_, cx| {
                        cx.emit(super::OpenSidekickTab(SIDEKICK_CHAT_TAB))
                    })
                }),
        );

    let mut welcomes_list = GroupedList::new().label("Welcomes");
    let welcome_lines = welcomes(greetings);
    for row in welcome_rows(greetings, chat_caps) {
        let line = welcome_lines
            .iter()
            .find(|(kind, _)| *kind == row.kind)
            .map(|(_, line)| line.clone());
        welcomes_list = welcomes_list.item(greeting_row(screen, &row, line, t, cx));
    }

    let mut activity_list = GroupedList::new().label("Activity");
    for row in activity_rows(greetings, chat_caps) {
        activity_list = activity_list.item(greeting_row(screen, &row, None, t, cx));
    }

    let full = greetings.templates.len() >= TEMPLATES_MAX;
    let add = entity.clone();
    let mut picker = Select::new("avatar-greeting-add")
        .size(SelectSize::Xs)
        .width(176.)
        .accessibility_label("Add a greeting")
        .placeholder(if full {
            "Remove one to add another"
        } else {
            "Add a greeting…"
        })
        .disabled(full)
        .value(None)
        .on_change(move |value, _, cx| {
            let kind = ACTIVITY_KINDS
                .into_iter()
                .find(|kind| GreetingKind::Activity(*kind).id() == value.as_ref());
            if let Some(kind) = kind {
                add.update(cx, |screen, cx| {
                    let _ = screen.add_template(AvatarScreen::new_line(kind), cx);
                })
            }
        });
    for kind in ACTIVITY_KINDS {
        picker = picker.option(GreetingKind::Activity(kind).id(), add_option_label(kind));
    }
    let footer = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(8.))
        .child(picker)
        .child(meta(
            format!("{}/{TEMPLATES_MAX}", greetings.templates.len()),
            t,
        ));

    let mut section = PanelSection::new("avatar-greetings")
        .title("Greetings")
        .description(format!(
            "What {name} says when someone chats for the first time, follows, subs or raids. Free: every kind has a line until you write your own. In Bubble, {name} says it on stream; in Suggest, you post it."
        ))
        .last(true)
        .child(FieldGroup::new().grouped().child(switch_row).child(ai_row))
        .child(welcomes_list)
        .child(activity_list)
        .child(footer);
    if let Some(error) = screen.save_error(SaveSection::Greetings) {
        section = section.child(Field::new("avatar-greetings-error").error(error));
    }
    Some(section.into_any_element())
}

/// One row (`GreetingRow`, `DefaultGreetingRow`, `WelcomeRow`): its title,
/// its line, Default when it is the built-in one, a warning mark, and its
/// switch; a click opens the editor under it.
fn greeting_row(
    screen: &AvatarScreen,
    row: &GreetingRow,
    welcome: Option<WelcomeLine>,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let key = row.key.replace([':', '/'], "-");
    let is_welcome = welcome.is_some();
    let switch_label = if is_welcome {
        format!("{} welcome on", row.title)
    } else {
        format!("{} greeting on", row.title)
    };
    let toggle = entity.clone();
    let switch_row = row.clone();
    let switch = Switch::new(SharedString::from(format!("avatar-greeting-on-{key}")))
        .small(true)
        .accessibility_label(switch_label)
        .checked(row.enabled)
        .on_change(move |on, _, cx| {
            let row = switch_row.clone();
            let welcome = welcome.clone();
            toggle.update(cx, |screen, cx| match (welcome, row.kind) {
                (Some(_), kind) => screen.change_welcome(
                    kind,
                    |line| WelcomeLine {
                        enabled: on,
                        ..line
                    },
                    cx,
                ),
                (None, GreetingKind::Activity(kind)) if row.default => {
                    // Switching a Default row off makes it yours, off.
                    if !on {
                        let template = CohostGreetingTemplate {
                            enabled: false,
                            ..AvatarScreen::new_line(kind)
                        };
                        let _ = screen.add_template(template, cx);
                    }
                }
                (None, _) => screen.change_template(&row.key, |template| template.enabled = on, cx),
            })
        });

    let open = entity.clone();
    let open_row = row.clone();
    let mut line = ListRow::new(
        SharedString::from(format!("avatar-greeting-{key}")),
        row.title,
    )
    .context(if row.text.is_empty() {
        "Empty".to_string()
    } else {
        row.text.clone()
    })
    .interactive(true)
    .on_click(move |_, window, cx| {
        let row = open_row.clone();
        open.update(cx, |screen, cx| screen.toggle_editor(&row, window, cx))
    });
    if row.default {
        line = line.alias(Badge::new("Default").variant(BadgeVariant::Outline));
    }
    // Electron's order: the warning mark (a status icon), then the switch
    // in the meta slot, last.
    if !row.warnings.is_empty() {
        line = line.status_icon(icon(IconName::WarningFill, 14., hsla(t.warning)));
    }
    // Flush in its grouped list: no rounding of its own.
    let line = line.meta_element(switch).grouped();
    let editing = screen
        .greeting_editor
        .as_ref()
        .filter(|editor| editor.key == row.key);
    div()
        .flex()
        .flex_col()
        .child(line)
        .children(editing.map(|editor| line_editor(screen, editor, row, t, cx)))
        .into_any_element()
}

/// The open line's editor: the text (saved on blur), its state, the
/// platform for a line of yours, the fields, a preview with the warnings,
/// and Add variant and Remove for a line of yours.
fn line_editor(
    screen: &AvatarScreen,
    editor: &GreetingEditor,
    row: &GreetingRow,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let target = target_of(&editor.key, editor.kind);
    let draft = editor.text.read(cx).value().to_string();
    let effective = match draft.trim() {
        "" => editor.fallback.clone().unwrap_or_default(),
        typed => typed.to_string(),
    };
    let (sample, _) = preview(&effective, editor.kind);
    let chat_caps = screen
        .auto_chat
        .as_ref()
        .is_some_and(|auto| auto.talk.unwrap_or_default() != CohostTalkMode::Bubble);
    let platform = row.platform;
    let notes = warnings(editor.kind, platform, &effective, chat_caps);

    let state = entity.clone();
    let mut state_picker = SegmentedControl::new("avatar-greeting-state")
        .small(true)
        .accessibility_label("Avatar state")
        .value(Some(state_word(row.state)))
        .on_change(move |value, _, cx| {
            if let Some((_, _, chosen)) = STATES.iter().find(|(id, _, _)| *id == value.as_ref()) {
                let chosen = *chosen;
                state.update(cx, |screen, cx| screen.set_line_state(chosen, cx));
            }
        });
    for (id, label, _) in STATES {
        state_picker = state_picker.option(Segment::new(id, label));
    }

    let mut controls = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(8.))
        .child(meta(
            format!("{}/{TEMPLATE_TEXT_MAX_CHARS}", draft.chars().count()),
            t,
        ))
        .child(state_picker);
    if !matches!(target, Target::Welcome(_)) {
        let pick = entity.clone();
        let mut platforms = Select::new("avatar-greeting-platform")
            .size(SelectSize::Xs)
            .width(112.)
            .accessibility_label("Platform")
            .value(Some(SharedString::from(
                platform.map_or("any", platform_id),
            )))
            .option("any", ANY_PLATFORM)
            .on_change(move |value, _, cx| {
                let chosen = PLATFORMS
                    .into_iter()
                    .find(|platform| platform_id(*platform) == value.as_ref());
                pick.update(cx, |screen, cx| screen.set_line_platform(chosen, cx));
            });
        for platform in kind_platforms(editor.kind) {
            platforms = platforms.option(platform_id(*platform), platform_label(*platform));
        }
        controls = controls.child(platforms);
    }
    // The braces this line may use, in a popover (`w-64 p-1`).
    let field_list = fields_for(editor.kind);
    let insert = entity.clone();
    controls = controls.child(
        Popover::new("avatar-greeting-fields")
            .width(256.)
            .flush()
            .trigger(
                Button::new("avatar-greeting-fields-trigger")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label("Fields"),
            )
            .content(move |window, cx| {
                let t = theme::resolve(None, window, cx);
                let mut list = div().flex().flex_col().items_start().p(px(4.));
                for (field, hint) in field_list.iter().copied() {
                    let insert = insert.clone();
                    list = list.child(
                        Button::new(SharedString::from(format!("avatar-greeting-field-{field}")))
                            .variant(ButtonVariant::Ghost)
                            .accessibility_label(field_entry(field, hint))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .child(format!("{{{field}}}")),
                            )
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .truncate()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(hsla(t.muted_foreground))
                                    .child(hint),
                            )
                            .on_click(move |_, window, cx| {
                                insert
                                    .update(cx, |screen, cx| screen.insert_field(field, window, cx))
                            }),
                    );
                }
                list
            }),
    );
    if let Target::Template(id) = &target {
        let variant = entity.clone();
        let remove = entity.clone();
        let id = id.clone();
        controls = controls
            .child(div().flex_1())
            .child(
                Button::new("avatar-greeting-add-variant")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label("Add variant")
                    .child(ShortcutKeys::accelerator(ADD_VARIANT_ACCELERATOR))
                    .on_click(move |_, window, cx| {
                        variant.update(cx, |screen, cx| screen.add_variant(window, cx))
                    }),
            )
            .child(
                Button::new("avatar-greeting-remove")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::IconXs)
                    .accessibility_label("Remove greeting")
                    .tooltip("Remove greeting")
                    .child(icon(IconName::X, 12., hsla(t.muted_foreground)))
                    .on_click(move |_, _, cx| {
                        let id = id.clone();
                        remove.update(cx, |screen, cx| screen.remove_template(&id, cx))
                    }),
            );
    }

    let mut column = div()
        .id(SharedString::from(format!(
            "avatar-greeting-editor-{}",
            editor.key.replace([':', '/'], "-")
        )))
        .flex()
        .flex_col()
        .gap(px(8.))
        .px(px(12.))
        .py(px(8.))
        .border_t_1()
        .border_color(hsla(t.border))
        .on_key_down(cx.listener(|screen, event: &KeyDownEvent, window, cx| {
            screen.editor_key(event, window, cx)
        }))
        .child(
            Textarea::new("avatar-greeting-text", &editor.text).accessibility_label(
                if editor.kind.is_welcome() {
                    format!("{} welcome text", row.title)
                } else {
                    format!("{} greeting text", row.title)
                },
            ),
        )
        .child(controls)
        // "Preview:" in the faintest tier, then the line with the sample.
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(4.))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(
                    div()
                        .flex_none()
                        .text_color(hsla(t.subtle))
                        .child("Preview:"),
                )
                .child(div().min_w(px(0.)).child(if sample.is_empty() {
                    "…".to_string()
                } else {
                    sample
                })),
        );
    // Each warning is a plain note under the preview.
    for note in notes {
        column = column.child(meta(note, t));
    }
    column.into_any_element()
}

fn meta(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_protocol::cohost::CohostActivityTemplateKind;

    #[test]
    fn a_row_key_names_what_it_edits() {
        assert!(matches!(
            target_of("welcome:first-time", GreetingKind::FirstTime),
            Target::Welcome(GreetingKind::FirstTime)
        ));
        let follow = ACTIVITY_KINDS[0];
        let key = format!("default:{}", GreetingKind::Activity(follow).id());
        assert!(matches!(
            target_of(&key, GreetingKind::Activity(follow)),
            Target::Default(kind) if kind == follow
        ));
        assert!(matches!(
            target_of("3f2c", GreetingKind::Activity(follow)),
            Target::Template(id) if id == "3f2c"
        ));
        let _: CohostActivityTemplateKind = follow;
    }

    #[test]
    fn states_read_back_their_words() {
        assert_eq!(state_word(CohostUtteranceState::Laugh), "laugh");
        assert_eq!(state_word(CohostUtteranceState::Talk), "talk");
    }
}
