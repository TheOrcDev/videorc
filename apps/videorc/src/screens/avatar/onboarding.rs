//! The four-step onboarding (`buddy-onboarding.tsx`, plan 170 D14, D15;
//! plan 174 S3.15a): meet the avatar (what it does, the official five),
//! describe it (and an optional picture), give it a personality, then create
//! it. Step 4 is plan 169's look flow on the account library: the four poses
//! fill in (Cancel stops waiting), Redo remakes talk, laugh or think for one
//! image, "Use as my avatar" keeps it and "Make it Alive" keeps it, then
//! opens the Alive creator with it.
//!
//! What was typed lives here, outside the dialog (G-12): closing it or
//! switching tabs loses nothing until an avatar is used. The look is the
//! page's one `buddy::look` state (`look.rs`), shared with My avatars and
//! the Look section as Electron's `BuddyLookClientProvider` shares it. Every
//! create and redo spends the streamer's images: nothing here runs in a
//! test.
//!
//! A chosen picture is fitted within 1024 px and shrunk under 3 MB off the
//! main thread before it is kept (`prepareBuddyLookPicture`); only one that
//! can't get under 3 MB is refused.
//!
//! Not yet in this flavour: the animated stream demo (a still one).

use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, ImageSource, KeyDownEvent, ObjectFit,
    PathPromptOptions, Role, SharedString, Window, div, img, prelude::*, px,
};
use gpui_base::actions::Confirm;
use gpui_base::input::InputEvent;
use serde_json::{Value, json};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::library::{
    CONTEXT_MAX_CHARS, Card, DESCRIPTION_MAX_CHARS, NAME_MAX_CHARS, PERSONALITY_MAX_CHARS,
    library_limit, library_view, text_length,
};
use videorc_app_core::buddy::look::{Draft, Pending as LookPending, STATES};
use videorc_app_core::buddy::persona::chip_fills_at_once;
use videorc_app_core::client::RpcError;
use videorc_app_core::studio::timecode::format_timecode;
use videorc_app_core::user_error::{Failure, UserErrorContext, user_error_message};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::GroupedList;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::skeleton::Skeleton;
use videorc_kit::spinner::Spinner;
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};

use super::files::{self, ChooseError, ChosenPicture, LookPictureError};
use super::gate::{self, Gate};
use super::look::DRAFT_PREVIEW_PX;
use super::onboarding_view::{self as view, Input as Typed};
use super::preview::PetPreview;
use super::{AvatarScreen, Pending, pictures, sync_handle};

/// ⌘↵ on macOS, Ctrl+Enter elsewhere: every step's primary action.
pub(super) const PRIMARY_KEYS: &str = if cfg!(target_os = "macos") {
    "cmd-enter"
} else {
    "ctrl-enter"
};

/// A gallery card's width, as My avatars draws it.
const CARD_WIDTH: f32 = 144.;
/// A pose tile's picture.
const TILE_PX: f32 = 120.;

/// The fields' text, kept while the dialog is closed.
struct Fields {
    description: Entity<TextareaState>,
    name: Entity<InputState>,
    personality: Entity<TextareaState>,
    about: Entity<TextareaState>,
}

/// One confirm over the wizard.
struct Confirmation {
    handle: DialogHandle,
    want_open: bool,
    was_open: bool,
}

impl Confirmation {
    fn new() -> Self {
        Self {
            handle: DialogHandle::new(false),
            want_open: false,
            was_open: false,
        }
    }
}

/// Which field an example chip fills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExampleField {
    Description,
    Personality,
}

impl ExampleField {
    fn what(self) -> &'static str {
        match self {
            Self::Description => "description",
            Self::Personality => "personality",
        }
    }
}

pub struct Onboarding {
    handle: DialogHandle,
    want_open: bool,
    was_open: bool,
    step: u8,
    fields: Option<Fields>,
    picture: Option<ChosenPicture>,
    preparing: bool,
    picture_error: Option<&'static str>,
    skip_details: bool,
    action_error: Option<String>,
    /// "Start a new one" (G-13): the draft left in the library to begin
    /// again, until the next draft replaces it.
    left_behind: Option<String>,
    was_in_progress: bool,
    /// The body takes the focus on open and on each step, so ⌘↵ works at
    /// once and Enter never closes the wizard (G-19, G-21).
    focus: Option<FocusHandle>,
    focus_body: bool,
    /// Kept or begun again: the fields empty on the next frame (they need a
    /// window).
    clear_fields: bool,
    /// The draft pictures' key the living preview last played.
    stills_key: String,
    /// The draft's living preview, this dialog's own.
    preview: Option<Entity<PetPreview>>,
    preview_active: bool,
    delete: Confirmation,
    replace: Confirmation,
    replacing: Option<(ExampleField, String)>,
}

impl Onboarding {
    fn new() -> Self {
        Self {
            handle: DialogHandle::new(false),
            want_open: false,
            was_open: false,
            step: 1,
            fields: None,
            picture: None,
            preparing: false,
            picture_error: None,
            skip_details: false,
            action_error: None,
            left_behind: None,
            was_in_progress: false,
            focus: None,
            focus_body: false,
            clear_fields: false,
            stills_key: String::new(),
            preview: None,
            preview_active: false,
            delete: Confirmation::new(),
            replace: Confirmation::new(),
            replacing: None,
        }
    }

    fn typed(&self, cx: &App) -> Typed {
        let Some(fields) = self.fields.as_ref() else {
            return Typed {
                has_picture: self.picture.is_some(),
                skip_details: self.skip_details,
                ..Typed::default()
            };
        };
        Typed {
            description: fields.description.read(cx).value().to_string(),
            has_picture: self.picture.is_some(),
            name: fields.name.read(cx).value().to_string(),
            personality: fields.personality.read(cx).value().to_string(),
            about: fields.about.read(cx).value().to_string(),
            skip_details: self.skip_details,
        }
    }

    /// Forget everything typed (an avatar was used, or a new one begins).
    fn forget(&mut self) {
        self.picture = None;
        self.picture_error = None;
        self.skip_details = false;
        self.action_error = None;
        self.clear_fields = true;
    }
}

/// The wall clock, as the look's `started_at` counts it.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// A refusal as `(code, one sentence)` (`inlineUserError`).
pub(super) fn refusal(error: &RpcError, context: UserErrorContext) -> (String, String) {
    let copy = user_error_message(Failure::Rpc(error), Some(context));
    (
        error.code.clone(),
        format!("{}. {}", copy.title, copy.description),
    )
}

impl AvatarScreen {
    /// One backend call off the UI thread; `then` runs on it with the answer.
    pub(super) fn backend_call(
        &self,
        method: &'static str,
        params: Value,
        then: impl FnOnce(&mut Self, Result<Value, RpcError>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let backend = self.studio.backend().clone();
        let request = self
            .runtime
            .spawn(async move { backend.request(method, params).await });
        cx.spawn(async move |this, cx| {
            let answer = request.await.unwrap_or_else(|_| {
                Err(RpcError::new(
                    method,
                    "failed",
                    "The request stopped before it answered.",
                ))
            });
            let _ = this.update(cx, |screen, cx| {
                then(screen, answer, cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// The draft this dialog offers: not one left for a new one.
    fn onboarding_draft(&self) -> Option<&Draft> {
        let left_behind = self
            .onboarding
            .as_ref()
            .and_then(|onboarding| onboarding.left_behind.as_ref());
        self.look_ui
            .look
            .draft
            .as_ref()
            .filter(|draft| Some(&draft.request_id) != left_behind)
    }

    /// An avatar being made or waiting as a draft: step 4's.
    fn onboarding_in_progress(&self) -> bool {
        self.look_ui.look.creating() || self.onboarding_draft().is_some()
    }

    /// Opens the wizard: step 4 for an avatar being made or waiting as a
    /// draft, else where the typing left off, else `step`.
    pub(super) fn show_onboarding(&mut self, step: u8, cx: &mut Context<Self>) {
        self.onboarding.get_or_insert_with(Onboarding::new);
        let in_progress = self.onboarding_in_progress();
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let typed = onboarding.typed(cx);
        onboarding.step = if in_progress {
            4
        } else if view::dirty(&typed) {
            view::reachable(onboarding.step, &typed)
        } else {
            step
        };
        onboarding.was_in_progress = in_progress;
        onboarding.action_error = None;
        onboarding.want_open = true;
        onboarding.focus_body = true;
        // A draft or a job the backend kept since is picked up.
        self.refresh_look(cx);
        cx.notify();
    }

    /// The fields and the preview, made with the first frame that has a
    /// window; emptied once an avatar was used or begun again.
    fn ensure_onboarding_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        if onboarding.focus.is_none() {
            onboarding.focus = Some(cx.focus_handle());
        }
        if onboarding.preview.is_none() {
            let preview = cx.new(|_| PetPreview::new(DRAFT_PREVIEW_PX, "new look"));
            cx.observe(&preview, |_, _, cx| cx.notify()).detach();
            onboarding.preview = Some(preview);
        }
        if let Some(fields) = onboarding.fields.as_ref() {
            if onboarding.clear_fields {
                onboarding.clear_fields = false;
                fields
                    .description
                    .update(cx, |state, cx| state.set_value("", window, cx));
                fields
                    .name
                    .update(cx, |state, cx| state.set_value("", window, cx));
                fields
                    .personality
                    .update(cx, |state, cx| state.set_value("", window, cx));
                fields
                    .about
                    .update(cx, |state, cx| state.set_value("", window, cx));
            }
            return;
        }
        onboarding.clear_fields = false;
        let description =
            cx.new(|cx| TextareaState::new(window, cx).placeholder(view::DESCRIBE_PLACEHOLDER));
        let name = cx.new(|cx| InputState::new(window, cx).placeholder(words::NAME_PLACEHOLDER));
        let personality =
            cx.new(|cx| TextareaState::new(window, cx).placeholder(words::PERSONALITY_PLACEHOLDER));
        let about =
            cx.new(|cx| TextareaState::new(window, cx).placeholder(words::ABOUT_PLACEHOLDER));
        cx.observe(&description, |_, _, cx| cx.notify()).detach();
        cx.observe(&personality, |_, _, cx| cx.notify()).detach();
        cx.observe(&about, |_, _, cx| cx.notify()).detach();
        cx.subscribe_in(
            &name,
            window,
            |screen, _, event: &InputEvent, _, cx| match event {
                // Enter on the name moves on; ⌘↵ is the body's.
                InputEvent::PressEnter {
                    secondary: false, ..
                } => screen.onboarding_next(cx),
                _ => cx.notify(),
            },
        )
        .detach();
        onboarding.fields = Some(Fields {
            description,
            name,
            personality,
            about,
        });
    }

    fn onboarding_set_step(&mut self, step: u8, cx: &mut Context<Self>) {
        if let Some(onboarding) = self.onboarding.as_mut() {
            onboarding.step = step;
            onboarding.focus_body = true;
        }
        cx.notify();
    }

    fn onboarding_go_to(&mut self, target: u8, cx: &mut Context<Self>) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        onboarding.action_error = None;
        let typed = onboarding.typed(cx);
        self.onboarding_set_step(view::reachable(target, &typed), cx);
    }

    fn onboarding_next(&mut self, cx: &mut Context<Self>) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let step = onboarding.step;
        let typed = onboarding.typed(cx);
        if step < view::STEP_COUNT && view::can_advance(step, &typed) {
            if step == 3 {
                onboarding.skip_details = false;
            }
            self.onboarding_go_to(step + 1, cx);
        }
    }

    fn onboarding_skip(&mut self, cx: &mut Context<Self>) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let typed = onboarding.typed(cx);
        if !view::can_skip(onboarding.step, &typed) {
            return;
        }
        onboarding.skip_details = true;
        self.onboarding_set_step(4, cx);
    }

    fn onboarding_gate(&self) -> Option<Gate> {
        gate::look_create_gate(&self.gate_input(), self.library.as_ref())
    }

    fn onboarding_can_create(&self, cx: &App) -> bool {
        let Some(onboarding) = self.onboarding.as_ref() else {
            return false;
        };
        let typed = onboarding.typed(cx);
        self.onboarding_gate().is_none()
            && !self.look_ui.look.busy()
            && !onboarding.preparing
            && view::has_look(&typed)
            && view::name(&typed).is_some()
    }

    /// "Create my avatar": four images from today's allowance.
    fn onboarding_create(&mut self, cx: &mut Context<Self>) {
        if !self.onboarding_can_create(cx) {
            return;
        }
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let typed = onboarding.typed(cx);
        let params = view::create_params(
            &typed,
            onboarding
                .picture
                .as_ref()
                .map(|picture| picture.base64.as_str()),
        );
        onboarding.action_error = None;
        self.look_create(params, cx);
    }

    /// Keep the draft as the avatar; with `alive`, then open the Alive
    /// creator with its idle as the picture and the description as notes.
    fn onboarding_keep(&mut self, alive: bool, cx: &mut Context<Self>) {
        if self.onboarding_draft().is_none() || self.look_ui.look.busy() {
            return;
        }
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let description = onboarding.typed(cx).description.trim().to_string();
        onboarding.action_error = None;
        self.look_keep(
            move |screen, kept, cx| {
                let problem = screen
                    .look_ui
                    .look
                    .problem
                    .as_ref()
                    .map(|(_, line)| line.clone());
                let Some(onboarding) = screen.onboarding.as_mut() else {
                    return;
                };
                if !kept {
                    onboarding.action_error = problem;
                    return;
                }
                onboarding.forget();
                onboarding.left_behind = None;
                onboarding.step = 1;
                onboarding.want_open = false;
                // My avatars follows the backend's library.
                screen.refresh(cx);
                if alive {
                    screen.show_creator(Some(description), cx);
                }
            },
            cx,
        );
    }

    fn onboarding_discard(&mut self, cx: &mut Context<Self>) {
        if let Some(onboarding) = self.onboarding.as_mut() {
            onboarding.delete.want_open = false;
        }
        self.look_discard(cx);
    }

    fn onboarding_redo(&mut self, state: &'static str, cx: &mut Context<Self>) {
        if gate::look_redo_gate(&self.gate_input()).is_some() {
            return;
        }
        self.look_redo(state, cx);
    }

    /// "Start a new one" (G-13): leave the waiting draft where it is (the
    /// Look section still offers it) and begin again from step 2.
    fn onboarding_start_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(request_id) = self
            .onboarding_draft()
            .map(|draft| draft.request_id.clone())
        else {
            return;
        };
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        onboarding.forget();
        onboarding.left_behind = Some(request_id);
        self.ensure_onboarding_fields(window, cx);
        self.onboarding_set_step(2, cx);
    }

    /// "Use this one": the official avatar becomes the avatar.
    fn onboarding_use_official(&mut self, avatar_id: String, cx: &mut Context<Self>) {
        if let Some(onboarding) = self.onboarding.as_mut() {
            onboarding.action_error = None;
        }
        self.call(
            Pending::Use,
            "cohost.library.use",
            json!({ "avatarId": avatar_id }),
            |screen, accepted, _| {
                let problem = screen.problem.clone();
                let Some(onboarding) = screen.onboarding.as_mut() else {
                    return;
                };
                if accepted {
                    onboarding.want_open = false;
                } else {
                    onboarding.action_error = problem;
                }
            },
            cx,
        );
    }

    fn onboarding_choose_picture(&mut self, cx: &mut Context<Self>) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        if onboarding.preparing {
            return;
        }
        onboarding.picture_error = None;
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(view::PICTURE_CHOOSE.into()),
        });
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if let Some(onboarding) = screen.onboarding.as_mut() {
                    onboarding.preparing = true;
                }
                cx.notify();
            });
            // Decoding, fitting and encoding run on a blocking worker.
            let read = runtime
                .spawn_blocking(move || files::read_look_picture(&path))
                .await
                .unwrap_or(Err(LookPictureError::Choose(ChooseError::Unreadable)));
            let _ = this.update(cx, |screen, cx| {
                let Some(onboarding) = screen.onboarding.as_mut() else {
                    return;
                };
                onboarding.preparing = false;
                match read {
                    Ok(picture) => onboarding.picture = Some(picture),
                    Err(LookPictureError::Choose(ChooseError::Kind)) => {
                        onboarding.picture_error = Some(view::PICTURE_TYPE_ERROR);
                    }
                    Err(LookPictureError::Choose(ChooseError::TooLarge)) => {
                        onboarding.picture_error = Some(view::PICTURE_SIZE_ERROR);
                    }
                    Err(LookPictureError::Choose(ChooseError::Unreadable)) => {
                        onboarding.picture_error = Some(view::PICTURE_UNREADABLE);
                    }
                    Err(LookPictureError::CantShrink) => {
                        onboarding.picture_error = Some(view::PICTURE_TOO_LARGE);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn onboarding_clear_picture(&mut self, cx: &mut Context<Self>) {
        if let Some(onboarding) = self.onboarding.as_mut() {
            onboarding.picture = None;
            onboarding.picture_error = None;
        }
        cx.notify();
    }

    /// An example chip fills an empty field at once and asks over typed
    /// text (G-3).
    fn onboarding_example(
        &mut self,
        field: ExampleField,
        example: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let typed = onboarding.typed(cx);
        let value = match field {
            ExampleField::Description => typed.description,
            ExampleField::Personality => typed.personality,
        };
        if chip_fills_at_once(&value, example) {
            self.onboarding_fill(field, example.to_string(), window, cx);
        } else {
            onboarding.replacing = Some((field, example.to_string()));
            onboarding.replace.want_open = true;
            cx.notify();
        }
    }

    fn onboarding_fill(
        &mut self,
        field: ExampleField,
        example: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(fields) = self
            .onboarding
            .as_ref()
            .and_then(|onboarding| onboarding.fields.as_ref())
        else {
            return;
        };
        match field {
            ExampleField::Description => fields
                .description
                .update(cx, |state, cx| state.set_value(example, window, cx)),
            ExampleField::Personality => fields
                .personality
                .update(cx, |state, cx| state.set_value(example, window, cx)),
        }
        cx.notify();
    }

    fn onboarding_answer_replace(
        &mut self,
        replace: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        onboarding.replace.want_open = false;
        let replacing = onboarding.replacing.take();
        if let (true, Some((field, example))) = (replace, replacing) {
            self.onboarding_fill(field, example, window, cx);
        }
        cx.notify();
    }

    fn onboarding_ask_delete(&mut self, cx: &mut Context<Self>) {
        if let Some(onboarding) = self.onboarding.as_mut() {
            onboarding.delete.want_open = true;
        }
        cx.notify();
    }

    fn onboarding_keep_draft(&mut self, cx: &mut Context<Self>) {
        if let Some(onboarding) = self.onboarding.as_mut() {
            onboarding.delete.want_open = false;
        }
        cx.notify();
    }

    /// ⌘↵: the step's primary action, as its key chip says.
    fn onboarding_primary(&mut self, cx: &mut Context<Self>) {
        let Some(step) = self.onboarding.as_ref().map(|onboarding| onboarding.step) else {
            return;
        };
        let draft_waiting = self.onboarding_draft().is_some() && !self.look_ui.look.creating();
        if step < 4 {
            self.onboarding_next(cx);
        } else if draft_waiting {
            self.onboarding_keep(false, cx);
        } else {
            self.onboarding_create(cx);
        }
    }

    /// The wizard's living preview plays the draft's pictures, as the look
    /// section read them (one read for both); pushed again when a new draft
    /// or a redone pose moves their key.
    fn sync_onboarding_stills(&mut self, cx: &mut Context<Self>) {
        if self.onboarding_draft().is_none() {
            return;
        }
        let (key, stills) = self.draft_stills();
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        if stills.is_empty() || onboarding.stills_key == key {
            return;
        }
        let Some(preview) = onboarding.preview.clone() else {
            return;
        };
        onboarding.stills_key = key.clone();
        preview.update(cx, |preview, cx| preview.show_still(key, stills, cx));
    }

    /// The preview ticks only while the wizard shows step 4 on the page.
    fn sync_onboarding_preview(&mut self, cx: &mut Context<Self>) {
        let active = self.active;
        let Some(onboarding) = self.onboarding.as_mut() else {
            return;
        };
        let wanted = active && onboarding.want_open && onboarding.step == 4;
        if wanted == onboarding.preview_active {
            return;
        }
        onboarding.preview_active = wanted;
        if let Some(preview) = onboarding.preview.clone() {
            preview.update(cx, |preview, cx| preview.set_active(wanted, cx));
        }
    }
}

/// The wizard and its two confirms. Opens and closes them with the window;
/// Escape, the close button or the backdrop closing the wizard keeps what
/// was typed.
pub(super) fn render_onboarding(
    screen: &mut AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    if screen.onboarding.is_none() {
        return div().into_any_element();
    }
    screen.ensure_onboarding_fields(window, cx);
    screen.sync_onboarding_stills(cx);
    let in_progress = screen.onboarding_in_progress();
    if let Some(onboarding) = screen.onboarding.as_mut() {
        sync_handle(
            &onboarding.handle,
            &mut onboarding.want_open,
            &mut onboarding.was_open,
            window,
            cx,
        );
        sync_handle(
            &onboarding.delete.handle,
            &mut onboarding.delete.want_open,
            &mut onboarding.delete.was_open,
            window,
            cx,
        );
        sync_handle(
            &onboarding.replace.handle,
            &mut onboarding.replace.want_open,
            &mut onboarding.replace.was_open,
            window,
            cx,
        );
        if !onboarding.replace.want_open {
            onboarding.replacing = None;
        }
        // An avatar being made or waiting as a draft is step 4's: the
        // wizard goes there when one shows up.
        if in_progress != onboarding.was_in_progress {
            onboarding.was_in_progress = in_progress;
            if in_progress {
                onboarding.step = 4;
                onboarding.focus_body = true;
            }
        }
        if onboarding.focus_body
            && onboarding.want_open
            && let Some(focus) = onboarding.focus.clone()
        {
            onboarding.focus_body = false;
            focus.focus(window, cx);
        }
    }
    screen.sync_onboarding_preview(cx);
    let screen: &AvatarScreen = screen;
    let Some(onboarding) = screen.onboarding.as_ref() else {
        return div().into_any_element();
    };
    let t = theme::resolve(None, window, cx);
    div()
        .child(wizard(screen, onboarding, t, cx))
        .child(delete_confirm(screen, onboarding, cx))
        .child(replace_confirm(onboarding, cx))
        .into_any_element()
}

fn wizard(
    screen: &AvatarScreen,
    onboarding: &Onboarding,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let step = onboarding.step;
    let title = view::STEP_TITLES[usize::from(step.clamp(1, 4) - 1)];
    let typed = onboarding.typed(cx);

    let content = match step {
        1 => meet_step(screen, t, cx),
        2 => describe_step(screen, onboarding, &typed, t, cx),
        3 => personality_step(onboarding, &typed, t, cx),
        _ => create_step(screen, onboarding, &typed, t, cx),
    };

    let primary = cx.entity();
    let mut body = div()
        .id("avatar-onboarding-body")
        .flex()
        .flex_col()
        .gap(px(16.))
        // Enter in a field never closes the wizard; ⌘↵ runs the step's
        // primary action from anywhere inside it.
        .on_action(|_: &Confirm, _, _| {})
        .on_key_down(move |event: &KeyDownEvent, _, cx| {
            let keys = &event.keystroke;
            if keys.key == "enter" && (keys.modifiers.platform || keys.modifiers.control) {
                cx.stop_propagation();
                primary.update(cx, |screen, cx| screen.onboarding_primary(cx));
            }
        })
        .child(progress_row(step, t))
        .child(content);
    if let Some(focus) = onboarding.focus.as_ref() {
        body = body.track_focus(focus);
    }
    if let Some(error) = onboarding.action_error.clone() {
        body = body.child(
            Alert::new("avatar-onboarding-error")
                .variant(AlertVariant::Destructive)
                .title(error),
        );
    }

    Dialog::new("avatar-onboarding", &onboarding.handle, title)
        .size(DialogSize::Xl)
        .child(body)
        .footer(footer(screen, onboarding, &typed, t, cx))
        .into_any_element()
}

/// "Step 2 of 4" and four short bars, monochrome.
fn progress_row(step: u8, t: &Theme) -> impl IntoElement {
    let mut meter = div().flex().items_center().gap(px(4.)).w(px(112.));
    for index in 0..view::STEP_COUNT {
        let ink = with_alpha(t.foreground, if index < step { 0.7 } else { 0.12 });
        meter = meter.child(div().flex_1().h(px(4.)).rounded_full().bg(hsla(ink)));
    }
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(meta(view::progress(step), t))
        .child(meter)
}

fn sub_heading(label: &'static str, note: Option<&'static str>, t: &Theme) -> impl IntoElement {
    div()
        .flex()
        .items_baseline()
        .gap(px(8.))
        .child(
            div()
                .type_scale(text::SECTION)
                .text_color(hsla(t.foreground))
                .child(label),
        )
        .children(note.map(|note| meta(note, t)))
}

fn field_label(label: &'static str, t: &Theme) -> impl IntoElement {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(hsla(t.foreground))
        .child(label)
}

fn meta(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}

fn body_text(line: impl Into<SharedString>, color: gpui::Hsla) -> gpui::Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .text_color(color)
        .child(line.into())
}

/// A field's counter; over the limit, the icon carries the tone (S1.8).
fn counter(count: usize, max: usize, t: &Theme) -> impl IntoElement {
    let over = count > max;
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .type_scale(text::META)
        .text_color(hsla(if over {
            t.foreground
        } else {
            t.muted_foreground
        }))
        .when(over, |row| {
            row.child(icon(IconName::WarningFill, 12., hsla(t.destructive)))
        })
        .child(words::counter(count, max))
}

fn gate_alert(id: &'static str, gate: &Gate, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let (sign_in, consent) = (cx.entity(), cx.entity());
    gate::gate_alert(
        id,
        gate,
        move |_, cx| sign_in.update(cx, |screen, cx| screen.sign_in(cx)),
        move |_, cx| consent.update(cx, |screen, cx| screen.open_consent(cx)),
    )
}

// --- Step 1: Meet your avatar --------------------------------------------------

fn meet_step(screen: &AvatarScreen, t: &Theme, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let entity = cx.entity();
    let official = library_view(screen.library.as_ref(), None).official;
    let busy = screen.working();

    // The stream demo, still: the golem, the alert chip and its lines.
    let demo_picture: Option<ImageSource> = pictures::default_idle().map(Into::into);
    let mut bubbles = div()
        .flex()
        .flex_col()
        .items_start()
        .gap(px(6.))
        .child(Badge::new(view::DEMO_CHIP).variant(BadgeVariant::Outline));
    for line in view::DEMO_BUBBLES {
        bubbles = bubbles.child(
            body_text(line, hsla(t.foreground))
                .px(px(10.))
                .py(px(6.))
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.background)),
        );
    }
    let demo = div()
        .flex()
        .items_end()
        .gap(px(12.))
        .p(px(12.))
        .rounded(px(radius::ROW))
        .bg(hsla(t.inset))
        .child(div().size(px(96.)).flex_none().children(
            demo_picture.map(|picture| img(picture).size_full().object_fit(ObjectFit::Contain)),
        ))
        .child(bubbles);

    let mut what = div().flex().flex_col().gap(px(8.));
    for line in view::WHAT_IT_DOES {
        what = what.child(
            div()
                .flex()
                .items_start()
                .gap(px(8.))
                .child(
                    div()
                        .pt(px(2.))
                        .child(icon(IconName::Check, 16., hsla(t.muted_foreground))),
                )
                .child(body_text(line, hsla(t.foreground))),
        );
    }

    let mut gallery = div().flex().flex_wrap().gap(px(8.));
    for card in &official {
        gallery = gallery.child(official_card(card, busy, entity.clone(), t));
    }

    let mut column = div()
        .flex()
        .flex_col()
        .gap(px(20.))
        .child(body_text(view::STEP1_LEAD, hsla(t.muted_foreground)))
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(20.))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(280.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(sub_heading(view::DEMO_HEADING, None, t))
                        .child(demo),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(240.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(sub_heading(view::WHAT_IT_DOES_HEADING, None, t))
                        .child(what),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(sub_heading(
                    view::GALLERY_HEADING,
                    Some(view::GALLERY_NOTE),
                    t,
                ))
                .child(gallery),
        );
    // Why creating your own is off now (G-5): said before any typing.
    if let Some(gate) = screen.onboarding_gate() {
        column = column.child(gate_alert("avatar-onboarding-gate", &gate, cx));
    }
    column.into_any_element()
}

/// One of ours, with "Use this one" unless it is the avatar already.
fn official_card(
    card: &Card,
    busy: bool,
    entity: Entity<AvatarScreen>,
    t: &Theme,
) -> impl IntoElement {
    let key = card.id.replace([':', '/'], "-");
    let picture: Option<ImageSource> = card
        .slug
        .as_deref()
        .and_then(pictures::official_idle)
        .map(Into::into);
    let mut words_block = div()
        .flex()
        .flex_col()
        .min_w(px(0.))
        .gap(px(2.))
        .px(px(2.))
        .child(
            div()
                .truncate()
                .text_size(px(14.))
                .line_height(px(20.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(hsla(t.foreground))
                .child(card.name.clone()),
        );
    if !card.subtitle.is_empty() {
        words_block = words_block.child(meta(card.subtitle.clone(), t).line_clamp(2));
    }
    if let Some(detail) = card.detail() {
        words_block = words_block.child(meta(detail.to_string(), t).line_clamp(3));
    }
    let id = card.id.clone();
    let use_it = (!card.active).then(|| {
        Button::new(SharedString::from(format!("avatar-onboarding-use-{key}")))
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .label(view::CARD_ACTION)
            .disabled(busy)
            .on_click(move |_, _, cx| {
                let id = id.clone();
                entity.update(cx, |screen, cx| screen.onboarding_use_official(id, cx))
            })
    });
    div()
        .id(SharedString::from(format!("avatar-onboarding-card-{key}")))
        .w(px(CARD_WIDTH))
        .flex()
        .flex_col()
        .gap(px(6.))
        .p(px(6.))
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(if card.active { t.ring } else { t.border }))
        .when(card.active, |element| element.bg(hsla(t.accent)))
        .child(
            div()
                .w_full()
                .h(px(CARD_WIDTH - 12.))
                .overflow_hidden()
                .rounded(px(radius::CHIP))
                .bg(hsla(t.inset))
                .children(picture.map(|picture| {
                    img(picture)
                        .size_full()
                        .p(px(6.))
                        .object_fit(ObjectFit::Contain)
                })),
        )
        .child(words_block)
        .children(use_it)
}

fn example_chips(
    field: ExampleField,
    examples: [&'static str; 3],
    disabled: bool,
    cx: &mut Context<AvatarScreen>,
) -> gpui::Div {
    let mut chips = div().flex().flex_wrap().items_center().gap(px(8.));
    for (index, example) in examples.into_iter().enumerate() {
        let entity = cx.entity();
        chips = chips.child(
            Button::new(SharedString::from(format!(
                "avatar-onboarding-{}-example-{index}",
                field.what()
            )))
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .label(example)
            .disabled(disabled)
            .on_click(move |_, window, cx| {
                entity.update(cx, |screen, cx| {
                    screen.onboarding_example(field, example, window, cx)
                })
            }),
        );
    }
    chips
}

// --- Step 2: Describe it -------------------------------------------------------

fn describe_step(
    screen: &AvatarScreen,
    onboarding: &Onboarding,
    typed: &Typed,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let Some(fields) = onboarding.fields.as_ref() else {
        return div().into_any_element();
    };
    let disabled = screen.look_ui.look.creating();
    let description = text_length(typed.description.trim());
    let describe = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(field_label(view::DESCRIBE_LABEL, t))
        .child(
            Textarea::new("avatar-onboarding-description", &fields.description)
                .accessibility_label(view::DESCRIBE_LABEL)
                .disabled(disabled)
                .invalid(description > DESCRIPTION_MAX_CHARS),
        )
        .child(
            example_chips(
                ExampleField::Description,
                view::DESCRIBE_EXAMPLES,
                disabled,
                cx,
            )
            .child(div().flex_1())
            .child(counter(description, DESCRIPTION_MAX_CHARS, t)),
        );

    let entity = cx.entity();
    let thumb = div()
        .size(px(64.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(t.muted));
    let thumb = match (&onboarding.picture, onboarding.preparing) {
        (Some(picture), _) => thumb.child(
            img(picture.path.clone())
                .size_full()
                .object_fit(ObjectFit::Contain),
        ),
        (None, true) => thumb.child(Spinner::new("avatar-onboarding-picture-preparing").size(16.)),
        (None, false) => thumb.child(icon(IconName::ImageSquare, 20., hsla(t.subtle))),
    };
    let action = match &onboarding.picture {
        Some(picture) => div()
            .flex()
            .flex_1()
            .min_w(px(0.))
            .items_center()
            .gap(px(8.))
            .child(
                body_text(picture.name.clone(), hsla(t.foreground))
                    .flex_1()
                    .min_w(px(0.))
                    .truncate(),
            )
            .child(
                Button::new("avatar-onboarding-picture-remove")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label(view::PICTURE_REMOVE)
                    .disabled(disabled)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |screen, cx| screen.onboarding_clear_picture(cx))
                    }),
            ),
        None => div().flex().flex_1().child(
            Button::new("avatar-onboarding-picture-choose")
                .variant(ButtonVariant::Outline)
                .label(view::PICTURE_CHOOSE)
                .disabled(disabled || onboarding.preparing)
                .on_click(move |_, _, cx| {
                    entity.update(cx, |screen, cx| screen.onboarding_choose_picture(cx))
                }),
        ),
    };
    let picture = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(field_label(view::PICTURE_LABEL, t))
        .child(meta(view::PICTURE_HELP, t))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .p(px(8.))
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.inset))
                .child(thumb)
                .child(action),
        )
        .children(onboarding.picture_error.map(|error| {
            div()
                .type_scale(text::META)
                .text_color(hsla(t.destructive))
                .child(error)
        }));

    div()
        .flex()
        .flex_col()
        .gap(px(24.))
        .child(describe)
        .child(picture)
        .into_any_element()
}

// --- Step 3: Give it a personality ------------------------------------------------

fn personality_step(
    onboarding: &Onboarding,
    typed: &Typed,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let Some(fields) = onboarding.fields.as_ref() else {
        return div().into_any_element();
    };
    let name_long = text_length(typed.name.trim()) > NAME_MAX_CHARS;
    let personality = text_length(&typed.personality);
    let about = text_length(&typed.about);
    div()
        .flex()
        .flex_col()
        .gap(px(24.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(field_label(words::NAME_LABEL, t))
                .child(
                    div().w(px(288.)).max_w_full().child(
                        Input::new("avatar-onboarding-name", &fields.name)
                            .accessibility_label(words::NAME_LABEL)
                            .invalid(name_long),
                    ),
                )
                .child(meta(words::NAME_HELP, t)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(field_label(words::PERSONALITY_LABEL, t))
                .child(
                    Textarea::new("avatar-onboarding-personality", &fields.personality)
                        .accessibility_label(words::PERSONALITY_LABEL)
                        .invalid(personality > PERSONALITY_MAX_CHARS),
                )
                .child(
                    example_chips(
                        ExampleField::Personality,
                        view::PERSONALITY_EXAMPLES,
                        false,
                        cx,
                    )
                    .child(div().flex_1())
                    .child(counter(personality, PERSONALITY_MAX_CHARS, t)),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(field_label(words::ABOUT_LABEL, t))
                .child(
                    Textarea::new("avatar-onboarding-about", &fields.about)
                        .accessibility_label(words::ABOUT_LABEL)
                        .invalid(about > CONTEXT_MAX_CHARS),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(meta(words::ABOUT_HELP, t))
                        .child(div().flex_1())
                        .child(counter(about, CONTEXT_MAX_CHARS, t)),
                ),
        )
        .into_any_element()
}

// --- Step 4: Create your avatar ---------------------------------------------------

fn summary_row(
    id: &'static str,
    label: &'static str,
    value: &str,
    picture: Option<&ChosenPicture>,
    t: &Theme,
) -> impl IntoElement {
    let value = value.trim();
    let empty = value.is_empty() && picture.is_none();
    let thumb = picture.map(|picture| {
        div()
            .size(px(40.))
            .flex_none()
            .overflow_hidden()
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(hsla(t.border))
            .child(
                img(picture.path.clone())
                    .size_full()
                    .object_fit(ObjectFit::Contain),
            )
    });
    let shown = if empty {
        view::NOT_SET.to_string()
    } else {
        value.to_string()
    };
    div()
        .id(id)
        .flex()
        .items_start()
        .gap(px(12.))
        .px(px(12.))
        .py(px(8.))
        .child(meta(label, t).w(px(96.)).flex_none())
        .child(
            div()
                .flex()
                .flex_1()
                .min_w(px(0.))
                .items_start()
                .gap(px(8.))
                .children(thumb)
                .child(
                    body_text(shown, hsla(if empty { t.subtle } else { t.foreground }))
                        .flex_1()
                        .min_w(px(0.))
                        .line_clamp(3),
                ),
        )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Working,
    Draft,
    Empty,
}

fn create_step(
    screen: &AvatarScreen,
    onboarding: &Onboarding,
    typed: &Typed,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let look = &screen.look_ui.look;
    let draft = screen.onboarding_draft();
    let view_kind = if look.creating() {
        View::Working
    } else if draft.is_some() {
        View::Draft
    } else {
        View::Empty
    };
    let capabilities = screen.capabilities.as_ref();
    let mut column = div().flex().flex_col().gap(px(16.));

    // A job picked up after the dialog closed has no inputs here: its
    // summary would only say "Not set".
    let summary = view_kind == View::Empty
        || (view_kind == View::Working && (view::has_look(typed) || !typed.name.trim().is_empty()));
    if summary {
        let skipped = typed.skip_details;
        column = column.child(
            GroupedList::new()
                .item(summary_row(
                    "avatar-onboarding-summary-look",
                    view::SUMMARY_LOOK,
                    &typed.description,
                    onboarding.picture.as_ref(),
                    t,
                ))
                .item(summary_row(
                    "avatar-onboarding-summary-name",
                    view::SUMMARY_NAME,
                    &typed.name,
                    None,
                    t,
                ))
                .item(summary_row(
                    "avatar-onboarding-summary-personality",
                    view::SUMMARY_PERSONALITY,
                    if skipped { "" } else { &typed.personality },
                    None,
                    t,
                ))
                .item(summary_row(
                    "avatar-onboarding-summary-about",
                    view::SUMMARY_ABOUT,
                    if skipped { "" } else { &typed.about },
                    None,
                    t,
                )),
        );
    }

    column = column.child(pose_tiles(screen, onboarding, view_kind, t, cx));

    match view_kind {
        View::Working => {
            let elapsed = look
                .started_at
                .map(|started| format_timecode(now_ms().saturating_sub(started) as i64));
            let cancelling = look.pending == Some(LookPending::Cancel);
            let can_cancel = look
                .running
                .as_ref()
                .is_some_and(|running| running.kind == "create");
            let entity = cx.entity();
            let cancel = can_cancel.then(|| {
                Button::new("avatar-onboarding-cancel")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label(if cancelling {
                        view::CANCELING
                    } else {
                        view::CANCEL
                    })
                    .disabled(cancelling)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |screen, cx| screen.look_cancel(cx))
                    })
            });
            column = column.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(Spinner::new("avatar-onboarding-working").size(16.))
                            .child(body_text(view::WORKING, hsla(t.muted_foreground))),
                    )
                    .children(elapsed.map(|elapsed| meta(elapsed, t)))
                    .children(cancel),
            );
        }
        View::Draft => {
            let saved = draft.is_some_and(|draft| draft.library_avatar_id.is_some());
            // The living preview plays the drafted pictures; one it can't
            // draw keeps the tiles and the line, without an empty box.
            let preview = match onboarding.preview.clone() {
                Some(preview)
                    if screen.has_draft_pictures() && preview.read(cx).error().is_none() =>
                {
                    Some(preview)
                }
                _ => None,
            };
            let has_preview = preview.is_some();
            let mut lines = div().flex().flex_col().min_w(px(0.)).gap(px(4.));
            if saved {
                lines = lines.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(icon(IconName::Check, 16., hsla(t.success)))
                        .child(body_text(view::DONE, hsla(t.foreground))),
                );
            }
            if has_preview {
                lines = lines.child(meta(view::PREVIEW_LINE, t));
            }
            column = column.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.))
                    .children(preview)
                    .child(lines),
            );
        }
        View::Empty => {
            let limit = library_limit(
                capabilities
                    .and_then(|caps| caps.pointer("/cohost/buddyLibrary/limit"))
                    .and_then(Value::as_u64)
                    .and_then(|limit| u32::try_from(limit).ok()),
                screen.library.as_ref(),
            );
            let failure = look
                .problem
                .as_ref()
                .and_then(|(code, _)| view::failure_line(code, limit));
            // The gate is now; a failure was the last attempt.
            if let Some(gate) = screen.onboarding_gate() {
                column = column.child(gate_alert("avatar-onboarding-gate-create", &gate, cx));
            } else if let Some(failure) = failure {
                column = column.child(
                    Alert::new("avatar-onboarding-failed")
                        .variant(AlertVariant::Destructive)
                        .title(failure),
                );
            } else if let Some(allowance) = view::allowance_line(capabilities) {
                column = column.child(meta(allowance, t));
            }
        }
    }
    column.into_any_element()
}

/// The four poses (`BuddyPoseTiles`): skeletons while drawn, the draft's
/// pictures with Redo on talk, laugh and think, or four empty slots.
fn pose_tiles(
    screen: &AvatarScreen,
    _onboarding: &Onboarding,
    view_kind: View,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> impl IntoElement {
    let look = &screen.look_ui.look;
    let draft = screen.onboarding_draft();
    let redo_gate = gate::look_redo_gate(&screen.gate_input());
    let busy = look.busy();
    let mut grid = div().flex().gap(px(12.));
    for state in STATES {
        let label = view::pose_label(state);
        let redoing = look.running.as_ref().is_some_and(|running| {
            running.kind == "redo" && running.state.as_deref() == Some(state)
        });
        let working = view_kind == View::Working || (view_kind == View::Draft && redoing);
        let done = view_kind == View::Working
            && look.phases.get(state).map(String::as_str) == Some("done");
        let picture = (view_kind == View::Draft)
            .then(|| screen.draft_picture(state))
            .flatten();
        let failed = view_kind == View::Draft
            && !redoing
            && (look.state_errors.contains_key(state)
                || draft.is_some_and(|draft| {
                    !draft.images.contains_key(state) && draft.failed.contains_key(state)
                }));

        let frame = if working {
            Skeleton::new(SharedString::from(format!(
                "avatar-onboarding-tile-{state}"
            )))
            .w_full()
            .h(px(TILE_PX))
            .rounded(px(radius::CHIP))
            .into_any_element()
        } else {
            let frame = div()
                .id(SharedString::from(format!(
                    "avatar-onboarding-pose-{state}"
                )))
                .w_full()
                .h(px(TILE_PX))
                .flex()
                .items_center()
                .justify_center()
                .overflow_hidden()
                .rounded(px(radius::CHIP))
                .bg(hsla(t.muted));
            match picture {
                Some(picture) => frame
                    .role(Role::Image)
                    .aria_label(format!("{label} picture"))
                    .child(img(picture).size_full().object_fit(ObjectFit::Contain))
                    .into_any_element(),
                None => frame
                    .child(icon(IconName::ImageSquare, 20., hsla(t.subtle)))
                    .into_any_element(),
            }
        };

        let redo = (view_kind == View::Draft && state != "idle").then(|| {
            let entity = cx.entity();
            let reason = redo_gate.as_ref().map(|gate| gate.reason.clone());
            let button = Button::new(SharedString::from(format!(
                "avatar-onboarding-redo-{state}"
            )))
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
            .label(gate::redo_label(view::REDO))
            .disabled(busy || reason.is_some() || redoing)
            .on_click(move |_, _, cx| {
                entity.update(cx, |screen, cx| screen.onboarding_redo(state, cx))
            });
            match reason {
                Some(reason) => button.tooltip(reason),
                None => button,
            }
        });

        let mut tile = div()
            .flex_1()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(8.))
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        meta(label, t)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(hsla(t.foreground)),
                    )
                    .when(done, |row| {
                        row.child(icon(IconName::Check, 14., hsla(t.muted_foreground)))
                    }),
            )
            .child(frame);
        if failed {
            tile = tile.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(view::POSE_FAILED),
            );
        }
        grid = grid.child(tile.children(redo));
    }
    let images_left = (view_kind == View::Draft)
        .then(|| gate::images_left_line(screen.capabilities.as_ref()))
        .flatten();
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(grid)
        .children(images_left.map(|line| meta(line, t)))
}

// --- The footer ----------------------------------------------------------------

/// The step's primary action, with its ⌘↵ chip; a spinner leads while a
/// look is drawn.
fn primary_button(
    id: &'static str,
    label: &'static str,
    disabled: bool,
    spinner: bool,
    entity: Entity<AvatarScreen>,
) -> Button {
    let button = Button::new(id).disabled(disabled);
    let button = if spinner {
        button
            .child(Spinner::new("avatar-onboarding-primary-spinner").size(14.))
            .child(label)
    } else {
        button.label(label)
    };
    button
        .child(ShortcutKeys::keystrokes(PRIMARY_KEYS))
        .on_click(move |_, _, cx| entity.update(cx, |screen, cx| screen.onboarding_primary(cx)))
}

fn footer(
    screen: &AvatarScreen,
    onboarding: &Onboarding,
    typed: &Typed,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> impl IntoElement {
    let step = onboarding.step;
    let look = &screen.look_ui.look;
    let creating = look.creating();
    let busy = look.busy();
    let draft_waiting = step == 4 && screen.onboarding_draft().is_some() && !creating;
    let entity = cx.entity();

    let mut left = div().flex().min_w(px(0.)).items_center().gap(px(12.));
    // Back keeps its slot while a draft waits (G-13); only a creation in
    // flight hides it.
    if step > 1 && !creating {
        let back = entity.clone();
        left = left.child(
            Button::new("avatar-onboarding-back")
                .variant(ButtonVariant::Ghost)
                .label(view::BACK)
                .on_click(move |_, _, cx| {
                    back.update(cx, |screen, cx| screen.onboarding_go_to(step - 1, cx))
                }),
        );
    }
    if draft_waiting {
        let (delete, start) = (entity.clone(), entity.clone());
        left = left
            .child(
                Button::new("avatar-onboarding-delete")
                    .variant(ButtonVariant::Ghost)
                    .label(view::DELETE)
                    .disabled(busy)
                    .on_click(move |_, _, cx| {
                        delete.update(cx, |screen, cx| screen.onboarding_ask_delete(cx))
                    }),
            )
            .child(
                Button::new("avatar-onboarding-start-new")
                    .variant(ButtonVariant::Ghost)
                    .label(view::START_NEW)
                    .disabled(busy)
                    .on_click(move |_, window, cx| {
                        start.update(cx, |screen, cx| screen.onboarding_start_new(window, cx))
                    }),
            );
    }
    if step == 2 && !view::can_advance(2, typed) {
        left = left.child(meta(view::NEXT_HINT, t));
    }

    let mut right = div().flex().flex_none().items_center().gap(px(8.));
    if step == 1 {
        right = right.child(primary_button(
            "avatar-onboarding-create-own",
            view::CREATE_OWN,
            false,
            false,
            entity,
        ));
    } else if step < 4 {
        if view::can_skip(step, typed) {
            let skip = entity.clone();
            right = right.child(
                Button::new("avatar-onboarding-skip")
                    .variant(ButtonVariant::Ghost)
                    .label(view::SKIP)
                    .on_click(move |_, _, cx| {
                        skip.update(cx, |screen, cx| screen.onboarding_skip(cx))
                    }),
            );
        }
        right = right.child(primary_button(
            "avatar-onboarding-next",
            view::NEXT,
            !view::can_advance(step, typed),
            false,
            entity,
        ));
    } else if draft_waiting {
        // The primary action sits rightmost.
        let alive = entity.clone();
        right = right
            .child(
                Button::new("avatar-onboarding-make-alive")
                    .variant(ButtonVariant::Outline)
                    .label(view::MAKE_ALIVE)
                    .disabled(busy)
                    .on_click(move |_, _, cx| {
                        alive.update(cx, |screen, cx| screen.onboarding_keep(true, cx))
                    }),
            )
            .child(primary_button(
                "avatar-onboarding-use",
                view::USE,
                busy,
                false,
                entity,
            ));
    } else {
        right = right.child(primary_button(
            "avatar-onboarding-create",
            view::CREATE,
            !screen.onboarding_can_create(cx),
            creating,
            entity,
        ));
    }

    div()
        .flex_1()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.))
        .child(left)
        .child(right)
}

// --- The confirms ------------------------------------------------------------------

/// "Delete Grum?" (G-1): a draft is saved to the library already, so
/// throwing it away is a delete, and it asks.
fn delete_confirm(
    screen: &AvatarScreen,
    onboarding: &Onboarding,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let typed = onboarding.typed(cx);
    let name = view::name(&typed).or_else(|| {
        let id = screen.onboarding_draft()?.library_avatar_id.as_ref()?;
        screen
            .library
            .as_ref()?
            .mine
            .as_ref()?
            .iter()
            .find(|entry| &entry.id == id)
            .map(|entry| entry.name.clone())
    });
    let (keep, delete) = (cx.entity(), cx.entity());
    Dialog::new(
        "avatar-onboarding-delete",
        &onboarding.delete.handle,
        view::delete_title(name.as_deref()),
    )
    .description(words::LIBRARY_DELETE_BODY)
    .close_button(false)
    .footer(
        Button::new("avatar-onboarding-delete-keep")
            .variant(ButtonVariant::Ghost)
            .label(view::KEEP_IT)
            .on_click(move |_, _, cx| {
                keep.update(cx, |screen, cx| screen.onboarding_keep_draft(cx))
            }),
    )
    .footer(
        Button::new("avatar-onboarding-delete-confirm")
            .variant(ButtonVariant::Destructive)
            .label(view::delete_label(name.as_deref()))
            .on_click(move |_, _, cx| {
                delete.update(cx, |screen, cx| screen.onboarding_discard(cx))
            }),
    )
    .into_any_element()
}

/// "Replace your description?" over typed text (G-3).
fn replace_confirm(onboarding: &Onboarding, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let (field, example) = onboarding
        .replacing
        .clone()
        .unwrap_or((ExampleField::Description, String::new()));
    let (keep, replace) = (cx.entity(), cx.entity());
    Dialog::new(
        "avatar-onboarding-replace",
        &onboarding.replace.handle,
        words::replace_title(field.what()),
    )
    .description(words::replace_description(&example))
    .close_button(false)
    .footer(
        Button::new("avatar-onboarding-replace-keep")
            .variant(ButtonVariant::Ghost)
            .label(words::REPLACE_KEEP)
            .on_click(move |_, window, cx| {
                keep.update(cx, |screen, cx| {
                    screen.onboarding_answer_replace(false, window, cx)
                })
            }),
    )
    .footer(
        Button::new("avatar-onboarding-replace-confirm")
            .label(words::REPLACE_CONFIRM)
            .on_click(move |_, window, cx| {
                replace.update(cx, |screen, cx| {
                    screen.onboarding_answer_replace(true, window, cx)
                })
            }),
    )
    .into_any_element()
}
