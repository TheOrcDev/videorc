//! Name and personality (`buddy-persona-section.tsx`, plan 164 S-A4): name
//! it, give it a personality, tell it about you and pick its bubble. Each
//! field saves on blur (the name also on Enter) through
//! `cohost.settings.set`, with no success toast: the screen is the
//! confirmation. A failed save is the section's (plan 174 G-7).

use std::path::{Component, Path};

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use serde_json::{Value, json};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::library::{CONTEXT_MAX_CHARS, text_length};
use videorc_app_core::buddy::persona::{
    PERSONALITY_MAX_CHARS, about_to_save, bubble_style, chip_fills_at_once, fresh_persona,
    name_to_save,
};
use videorc_app_core::stream_manager::buddy::CohostSettingsView;
use videorc_app_core::user_error::{
    Failure, UserErrorContext, toast_user_error, user_error_message,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_protocol::cohost::CohostPersona;

use super::reactions::SaveSection;
use super::{AvatarScreen, pictures, sync_handle};

const START_OVER: UserErrorContext = UserErrorContext {
    action: "start",
    object: "over",
};

/// The section's fields, made once a window is at hand. Each draft follows
/// the saved value until the streamer types; then the draft is the truth
/// until it is saved.
pub(super) struct PersonaFields {
    name: Entity<InputState>,
    personality: Entity<TextareaState>,
    about: Entity<TextareaState>,
    saved_name: String,
    saved_personality: String,
    saved_about: String,
    name_invalid: bool,
    /// An example chip that asks before it replaces typed text.
    replacing: Option<String>,
    replace_handle: DialogHandle,
    replace_want_open: bool,
    replace_was_open: bool,
    start_over_handle: DialogHandle,
    start_over_want_open: bool,
    start_over_was_open: bool,
}

impl AvatarScreen {
    /// Makes the fields on the first render with a persona, then keeps each
    /// draft on the saved value while it is untouched.
    pub(super) fn ensure_persona_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.clone() else {
            return;
        };
        let notes = self.notes.clone().unwrap_or_default();
        if self.persona_fields.is_none() {
            let name = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(words::NAME_PLACEHOLDER)
                    .default_value(persona.name.clone())
            });
            let personality = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .placeholder(words::PERSONALITY_FIELD_PLACEHOLDER)
                    .default_value(persona.personality.clone())
            });
            let about = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .placeholder(words::ABOUT_PLACEHOLDER)
                    .default_value(notes.clone())
            });
            cx.subscribe_in(
                &name,
                window,
                |screen, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Blur => screen.commit_name(cx),
                    InputEvent::PressEnter { .. } => {
                        screen.commit_name(cx);
                        window.blur(cx);
                    }
                    InputEvent::Change => {
                        let typed = screen
                            .persona_fields
                            .as_ref()
                            .map(|fields| fields.name.read(cx).value().to_string());
                        if let (Some(fields), Some(typed)) = (screen.persona_fields.as_mut(), typed)
                            && fields.name_invalid
                            && name_to_save(&typed).is_some()
                        {
                            fields.name_invalid = false;
                        }
                        cx.notify();
                    }
                    _ => {}
                },
            )
            .detach();
            cx.subscribe_in(
                &personality,
                window,
                |screen, _, event: &InputEvent, _, cx| match event {
                    InputEvent::Blur => screen.commit_personality(None, cx),
                    _ => cx.notify(),
                },
            )
            .detach();
            cx.subscribe_in(
                &about,
                window,
                |screen, _, event: &InputEvent, _, cx| match event {
                    InputEvent::Blur => screen.commit_about(cx),
                    _ => cx.notify(),
                },
            )
            .detach();
            self.persona_fields = Some(PersonaFields {
                name,
                personality,
                about,
                saved_name: persona.name.clone(),
                saved_personality: persona.personality.clone(),
                saved_about: notes,
                name_invalid: false,
                replacing: None,
                replace_handle: DialogHandle::new(false),
                replace_want_open: false,
                replace_was_open: false,
                start_over_handle: DialogHandle::new(false),
                start_over_want_open: false,
                start_over_was_open: false,
            });
            return;
        }
        let Some(fields) = self.persona_fields.as_mut() else {
            return;
        };
        let draft = fields.name.read(cx).value().to_string();
        if follows(&mut fields.saved_name, &persona.name, &draft) {
            let value = persona.name.clone();
            fields
                .name
                .update(cx, |state, cx| state.set_value(value, window, cx));
        }
        let draft = fields.personality.read(cx).value().to_string();
        if follows(&mut fields.saved_personality, &persona.personality, &draft) {
            let value = persona.personality.clone();
            fields
                .personality
                .update(cx, |state, cx| state.set_value(value, window, cx));
        }
        let draft = fields.about.read(cx).value().to_string();
        if follows(&mut fields.saved_about, &notes, &draft) {
            let value = notes.clone();
            fields
                .about
                .update(cx, |state, cx| state.set_value(value, window, cx));
        }
        sync_handle(
            &fields.replace_handle,
            &mut fields.replace_want_open,
            &mut fields.replace_was_open,
            window,
            cx,
        );
        sync_handle(
            &fields.start_over_handle,
            &mut fields.start_over_want_open,
            &mut fields.start_over_was_open,
            window,
            cx,
        );
        if !fields.replace_want_open {
            fields.replacing = None;
        }
    }

    /// The name, saved on blur or Enter; an empty one never saves and says
    /// why.
    fn commit_name(&mut self, cx: &mut Context<Self>) {
        let (Some(fields), Some(persona)) = (self.persona_fields.as_mut(), self.persona.as_ref())
        else {
            return;
        };
        let typed = fields.name.read(cx).value().to_string();
        let Some(name) = name_to_save(&typed) else {
            fields.name_invalid = true;
            cx.notify();
            return;
        };
        fields.name_invalid = false;
        if name == persona.name {
            return;
        }
        fields.saved_name = name.clone();
        let next = CohostPersona {
            name,
            ..persona.clone()
        };
        self.save_persona(next, cx);
    }

    /// The personality saves whatever it holds, an empty one too. A chip
    /// passes its example.
    fn commit_personality(&mut self, example: Option<String>, cx: &mut Context<Self>) {
        let (Some(fields), Some(persona)) = (self.persona_fields.as_mut(), self.persona.as_ref())
        else {
            return;
        };
        let next = example.unwrap_or_else(|| fields.personality.read(cx).value().to_string());
        if next == persona.personality {
            return;
        }
        fields.saved_personality = next.clone();
        let persona = CohostPersona {
            personality: next,
            ..persona.clone()
        };
        self.save_persona(persona, cx);
    }

    /// About you saves within its bound, as the avatar's notes.
    fn commit_about(&mut self, cx: &mut Context<Self>) {
        let Some(fields) = self.persona_fields.as_mut() else {
            return;
        };
        let draft = fields.about.read(cx).value().to_string();
        let saved = self.notes.clone().unwrap_or_default();
        let Some(notes) = about_to_save(&draft, &saved) else {
            return;
        };
        fields.saved_about = notes.clone();
        self.patch_settings(json!({ "notes": notes }), SaveSection::Persona, cx);
    }

    pub(super) fn set_bubble(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let style = bubble_style(index);
        if style == persona.bubble_style {
            return;
        }
        let next = CohostPersona {
            bubble_style: style,
            ..persona.clone()
        };
        self.save_persona(next, cx);
    }

    /// A chip fills an empty field at once and asks over typed text (plan
    /// 174 G-3).
    fn pick_example(&mut self, example: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(fields) = self.persona_fields.as_mut() else {
            return;
        };
        let typed = fields.personality.read(cx).value().to_string();
        if chip_fills_at_once(&typed, example) {
            self.fill_example(example.to_string(), window, cx);
        } else {
            fields.replacing = Some(example.to_string());
            fields.replace_want_open = true;
            cx.notify();
        }
    }

    fn fill_example(&mut self, example: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(fields) = self.persona_fields.as_mut() {
            let replace = example.clone();
            fields
                .personality
                .update(cx, |state, cx| state.set_value(replace, window, cx));
            fields.replace_want_open = false;
        }
        self.commit_personality(Some(example), cx);
    }

    fn answer_replace(&mut self, replace: bool, window: &mut Window, cx: &mut Context<Self>) {
        let example = self.persona_fields.as_mut().and_then(|fields| {
            fields.replace_want_open = false;
            fields.replacing.take()
        });
        if let (true, Some(example)) = (replace, example) {
            self.fill_example(example, window, cx);
        }
        cx.notify();
    }

    fn ask_start_over(&mut self, cx: &mut Context<Self>) {
        if let Some(fields) = self.persona_fields.as_mut() {
            fields.start_over_want_open = true;
        }
        cx.notify();
    }

    fn cancel_start_over(&mut self, cx: &mut Context<Self>) {
        if let Some(fields) = self.persona_fields.as_mut() {
            fields.start_over_want_open = false;
        }
        cx.notify();
    }

    /// Start over: the persona's folder goes from this computer, then a
    /// fresh avatar is saved. A failure toasts (`toastUserError`).
    fn start_over(&mut self, cx: &mut Context<Self>) {
        if let Some(fields) = self.persona_fields.as_mut() {
            fields.start_over_want_open = false;
        }
        let Some(old) = self.persona.as_ref().map(|persona| persona.id.clone()) else {
            return;
        };
        let root = self.user_data_dir.join(pictures::BUDDY_ASSETS_FOLDER);
        let studio = self.studio.clone();
        let fresh = fresh_persona(uuid::Uuid::new_v4().to_string());
        let job = self.runtime.spawn(async move {
            remove_persona_folder(&root, &old).map_err(|error| error.to_string())?;
            studio
                .backend()
                .request("cohost.settings.set", json!({ "persona": fresh }))
                .await
                .map_err(|error| error.message)
        });
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(value)) => screen.settings_answered(&value, cx),
                    Ok(Err(reason)) => {
                        let failure = Failure::Sentence {
                            text: &reason,
                            warning: false,
                        };
                        if let Some(command) =
                            toast_user_error(failure, START_OVER, "buddy-start-over")
                        {
                            studio.post_notices(vec![command]);
                        }
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_persona(&mut self, persona: CohostPersona, cx: &mut Context<Self>) {
        self.save_persona_with(persona, SaveSection::Persona, cx);
    }

    /// Saves the persona; a failure is the given section's.
    pub(super) fn save_persona_with(
        &mut self,
        persona: CohostPersona,
        section: SaveSection,
        cx: &mut Context<Self>,
    ) {
        self.patch_settings(json!({ "persona": persona }), section, cx);
    }

    /// The failed save a section shows, in words.
    pub(super) fn save_error(&self, section: SaveSection) -> Option<String> {
        self.save_error
            .as_ref()
            .filter(|(failed, _)| *failed == section)
            .map(|(_, message)| message.clone())
    }

    /// `patchCohostSettings`: the answer is the new settings.
    pub(super) fn patch_settings(
        &mut self,
        patch: Value,
        section: SaveSection,
        cx: &mut Context<Self>,
    ) {
        self.save_error = None;
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cohost.settings.set", patch).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(value)) => screen.settings_answered(&value, cx),
                    Ok(Err(error)) => {
                        let context = UserErrorContext {
                            action: "save",
                            object: section.object(),
                        };
                        let copy = user_error_message(Failure::Rpc(&error), Some(context));
                        screen.save_error =
                            Some((section, format!("{}. {}", copy.title, copy.description)));
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn settings_answered(&mut self, value: &Value, cx: &mut Context<Self>) {
        if let Some(settings) = CohostSettingsView::from_json(value) {
            if settings.persona.is_some() {
                self.persona = settings.persona;
            }
            self.notes = Some(settings.notes);
            if settings.auto_chat.is_some() {
                self.auto_chat = settings.auto_chat;
            }
        }
        cx.notify();
    }
}

/// A new saved value: true when the draft was untouched (it still equals
/// what was saved before), so it follows. The saved value moves on either way.
fn follows(saved: &mut String, now: &str, draft: &str) -> bool {
    if saved == now {
        return false;
    }
    let untouched = draft == saved.as_str();
    *saved = now.to_string();
    untouched
}

/// Electron's `removeBuddyPersona`: the persona's folder under the buddy
/// root, never anything outside it. A folder that is not there is fine.
fn remove_persona_folder(root: &Path, persona_id: &str) -> std::io::Result<()> {
    let id = Path::new(persona_id);
    let mut parts = id.components();
    let (Some(Component::Normal(_)), None) = (parts.next(), parts.next()) else {
        return Err(std::io::Error::other("not a persona id"));
    };
    match std::fs::remove_dir_all(root.join(id)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

pub(super) fn render_persona(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> Option<AnyElement> {
    let persona = screen.persona.as_ref()?;
    let fields = screen.persona_fields.as_ref()?;
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();

    let name_field = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .w(px(288.))
        .max_w_full()
        .child(
            Input::new("avatar-name", &fields.name)
                .accessibility_label(words::NAME_LABEL)
                .invalid(fields.name_invalid),
        )
        .when(fields.name_invalid, |column| {
            column.child(error_line(words::NAME_REQUIRED, t))
        });
    let start = entity.clone();
    let header = div()
        .flex()
        .flex_wrap()
        .items_start()
        .gap(px(8.))
        .child(name_field)
        .child(
            Button::new("avatar-start-over")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(words::START_OVER)
                .on_click(move |_, _, cx| start.update(cx, |screen, cx| screen.ask_start_over(cx))),
        );

    let personality_draft = fields.personality.read(cx).value().to_string();
    let personality_dirty = personality_draft != persona.personality;
    let mut chips = div().flex().flex_wrap().items_center().gap(px(8.));
    for (index, example) in words::PERSONALITY_EXAMPLES.into_iter().enumerate() {
        let pick = entity.clone();
        chips = chips.child(
            Button::new(SharedString::from(format!(
                "avatar-personality-example-{index}"
            )))
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .label(example)
            .on_click(move |_, window, cx| {
                pick.update(cx, |screen, cx| screen.pick_example(example, window, cx))
            }),
        );
    }
    chips = chips
        .child(div().flex_1())
        .child(meta(
            words::counter(text_length(&personality_draft), PERSONALITY_MAX_CHARS),
            t,
        ))
        .when(personality_dirty, |chips| {
            chips.child(meta(words::UNSAVED, t))
        });
    let personality = field(
        words::PERSONALITY_LABEL,
        Some(words::personality_description(&persona.name)),
        Textarea::new("avatar-personality", &fields.personality)
            .accessibility_label(words::PERSONALITY_LABEL)
            .invalid(text_length(&personality_draft) > PERSONALITY_MAX_CHARS)
            .into_any_element(),
        chips.into_any_element(),
        t,
    );

    let about_draft = fields.about.read(cx).value().to_string();
    let saved_notes = screen.notes.clone().unwrap_or_default();
    let about_dirty = about_draft != saved_notes;
    let about_footer = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(div().flex_1())
        .child(meta(
            words::counter(text_length(&about_draft), CONTEXT_MAX_CHARS),
            t,
        ))
        .when(about_dirty, |footer| footer.child(meta(words::UNSAVED, t)));
    let about = field(
        words::ABOUT_FIELD_LABEL,
        Some(words::ABOUT_HELP.to_string()),
        Textarea::new("avatar-about", &fields.about)
            .accessibility_label(words::ABOUT_FIELD_LABEL)
            .invalid(text_length(&about_draft) > CONTEXT_MAX_CHARS)
            .into_any_element(),
        about_footer.into_any_element(),
        t,
    );

    let picker =
        super::bubble::style_picker("avatar-bubble-style", persona.bubble_style, entity.clone())
            .accessibility_label(words::BUBBLE_STYLE_LABEL);
    // The sample itself opens the zoom too (owner, 2026-10-09); the
    // magnifier stays the keyboard path.
    let (zoom_sample, zoom_button) = (entity.clone(), entity.clone());
    let sample = div()
        .id("avatar-bubble-sample-zoom")
        .cursor_pointer()
        .rounded(px(radius::ROW))
        .child(super::bubble::inline_sample(screen))
        .on_click(move |_, _, cx| zoom_sample.update(cx, |screen, cx| screen.open_bubble_zoom(cx)));
    let controls = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(16.))
        .child(picker)
        .child(
            div().flex().items_end().gap(px(4.)).child(sample).child(
                Button::new("avatar-bubble-zoom")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Icon)
                    .accessibility_label(words::BUBBLE_ZOOM)
                    .tooltip(words::BUBBLE_ZOOM_HINT)
                    .child(icon(
                        IconName::MagnifyingGlass,
                        16.,
                        hsla(t.muted_foreground),
                    ))
                    .on_click(move |_, _, cx| {
                        zoom_button.update(cx, |screen, cx| screen.open_bubble_zoom(cx))
                    }),
            ),
        );
    let bubble = field(
        words::BUBBLE_LABEL,
        Some(words::bubble_description(&persona.name)),
        controls.into_any_element(),
        div().into_any_element(),
        t,
    );

    let mut section = PanelSection::new("avatar-persona")
        .title(words::PERSONA_TITLE)
        .description(words::PERSONA_DESCRIPTION)
        .child(header);
    if let Some(error) = screen.save_error(SaveSection::Persona) {
        section = section.child(
            Alert::new("avatar-persona-error")
                .variant(AlertVariant::Destructive)
                .title(error),
        );
    }
    section = section.child(
        div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .pt(px(4.))
            .child(personality)
            .child(about)
            .child(bubble),
    );
    Some(section.into_any_element())
}

/// The section's two confirms: Replace your personality? and Start over.
pub(super) fn persona_dialogs(screen: &AvatarScreen, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let (Some(fields), Some(persona)) = (screen.persona_fields.as_ref(), screen.persona.as_ref())
    else {
        return div().into_any_element();
    };
    let entity = cx.entity();
    let example = fields.replacing.clone().unwrap_or_default();
    let (keep, replace) = (entity.clone(), entity.clone());
    let replace_dialog = Dialog::new(
        "avatar-example-replace",
        &fields.replace_handle,
        words::replace_title("personality"),
    )
    .description(words::replace_description(&example))
    .close_button(false)
    .footer(
        Button::new("avatar-example-keep")
            .variant(ButtonVariant::Ghost)
            .label(words::REPLACE_KEEP)
            .on_click(move |_, window, cx| {
                keep.update(cx, |screen, cx| screen.answer_replace(false, window, cx))
            }),
    )
    .footer(
        Button::new("avatar-example-replace-confirm")
            .label(words::REPLACE_CONFIRM)
            .on_click(move |_, window, cx| {
                replace.update(cx, |screen, cx| screen.answer_replace(true, window, cx))
            }),
    );

    let (cancel, confirm) = (entity.clone(), entity);
    let start_over_dialog = Dialog::new(
        "avatar-start-over-confirm",
        &fields.start_over_handle,
        words::START_OVER_TITLE,
    )
    .description(words::start_over_description(&persona.name))
    .close_button(false)
    .footer(
        Button::new("avatar-start-over-keep")
            .variant(ButtonVariant::Ghost)
            .label(words::start_over_keep(&persona.name))
            .on_click(move |_, _, cx| cancel.update(cx, |screen, cx| screen.cancel_start_over(cx))),
    )
    .footer(
        Button::new("avatar-start-over-confirm-action")
            .variant(ButtonVariant::Destructive)
            .label(words::START_OVER)
            .on_click(move |_, _, cx| confirm.update(cx, |screen, cx| screen.start_over(cx))),
    );

    div()
        .child(replace_dialog)
        .child(start_over_dialog)
        .into_any_element()
}

/// One field (`Field`): a 14 px label, its 12 px description, the control
/// and a footer row.
fn field(
    label: &'static str,
    description: Option<String>,
    control: AnyElement,
    footer: AnyElement,
    t: &Theme,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(20.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(hsla(t.foreground))
                .child(label),
        )
        .children(description.map(|line| meta(line, t)))
        .child(control)
        .child(footer)
}

fn meta(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}

fn error_line(line: &'static str, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.destructive))
        .child(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_untouched_draft_follows_the_saved_value() {
        let mut saved = "Grum".to_string();
        assert!(follows(&mut saved, "Flint", "Grum"));
        assert_eq!(saved, "Flint");
        // Typed text stays; the saved value still moves on.
        assert!(!follows(&mut saved, "Nib", "Flin"));
        assert_eq!(saved, "Nib");
        assert!(!follows(&mut saved, "Nib", "Nib"));
    }

    #[test]
    fn start_over_removes_only_the_persona_folder() {
        let root = std::env::temp_dir().join(format!("videorc-avatar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("p1")).unwrap();
        std::fs::write(root.join("p1").join("idle.png"), b"x").unwrap();
        std::fs::create_dir_all(root.join("p2")).unwrap();
        remove_persona_folder(&root, "p1").unwrap();
        assert!(!root.join("p1").exists());
        assert!(root.join("p2").exists());
        // Gone already is fine; anything but one plain name is refused.
        remove_persona_folder(&root, "p1").unwrap();
        for id in ["", "..", "../p2", "p2/x", "/tmp"] {
            assert!(remove_persona_folder(&root, id).is_err(), "{id}");
        }
        assert!(root.join("p2").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
