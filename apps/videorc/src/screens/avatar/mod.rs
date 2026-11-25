//! Avatar ⌘8 (plan 260 Phase 3, L3): the character on the stream, from
//! `videorc_app_core::buddy`, drawn with `videorc-kit`. Words and layout
//! match Electron's `tabs/avatar-tab.tsx`: a tab strip with Profile and
//! Greetings; Profile leads with the status row, then My avatars.
//!
//! Still to land, each in its own PR: Name and personality, the look
//! (Still/Alive, Test, the living preview), Reactions and Motion, Greetings,
//! the onboarding dialog and the Alive creator.

mod library;
mod persona;
mod pictures;
mod status;

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{Context, EventEmitter, Window, div, prelude::*, px};
use serde_json::{Value, json};
use videorc_app_core::buddy::chat::display_name;
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::library::{EditForm, EditKind, LibraryState};
use videorc_app_core::nav::PageId;
use videorc_app_core::stream_manager::buddy::CohostSettingsView;
use videorc_app_core::studio::families;
use videorc_app_core::studio::ui_local::UiLocal;
use videorc_app_core::user_error::{Failure, UserErrorContext, user_error_message};
use videorc_app_core::{BackendClient, BackendEvent, Studio};
use videorc_kit::dialog::DialogHandle;
use videorc_kit::input::InputState;
use videorc_kit::page_tabs::PageTabs;
use videorc_kit::textarea::TextareaState;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_protocol::cohost::CohostPersona;

use status::Placement;

pub type AppStudio = Studio<BackendClient>;

/// The events the page follows; `main.rs` adds them to the client's filter.
/// `account.changed` is already there (Settings').
pub const EVENTS: [&str; 3] = [
    LIBRARY_CHANGED_EVENT,
    SETTINGS_CHANGED_EVENT,
    videorc_app_core::chat::overlay::LAYOUT_EVENT,
];
const LIBRARY_CHANGED_EVENT: &str = "cohost.library.changed";
const SETTINGS_CHANGED_EVENT: &str = "cohost.settings.changed";

/// A refused library call, as one sentence (`problemOf`,
/// `use-buddy-library.ts`).
const UPDATE_THE_LIBRARY: UserErrorContext = UserErrorContext {
    action: "update",
    object: "your avatar library",
};

/// Opens another page (Place on Scene).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPage(pub PageId);

impl EventEmitter<OpenPage> for AvatarScreen {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Profile,
    Greetings,
}

impl Tab {
    fn id(self) -> &'static str {
        match self {
            Self::Profile => "profile",
            Self::Greetings => "greetings",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Profile => 0,
            Self::Greetings => 1,
        }
    }

    fn from_index(index: usize) -> Self {
        if index == 1 {
            Self::Greetings
        } else {
            Self::Profile
        }
    }

    fn from_id(id: &str) -> Self {
        if id == "greetings" {
            Self::Greetings
        } else {
            Self::Profile
        }
    }
}

/// The library call in flight: one at a time (`pending`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    Sync,
    Use,
    Update,
    Delete,
    SaveToLibrary,
}

/// The Rename or Edit personality dialog's fields.
struct EditDialog {
    form_kind: EditKind,
    avatar_id: String,
    saved_name: String,
    saved_personality: String,
    saved_context: String,
    name: gpui::Entity<InputState>,
    personality: gpui::Entity<TextareaState>,
    context: gpui::Entity<TextareaState>,
    /// The refusal shows only for a save asked from this form.
    refused: bool,
}

impl EditDialog {
    fn form(&self, cx: &gpui::App) -> EditForm {
        EditForm {
            kind: self.form_kind.clone(),
            avatar_id: self.avatar_id.clone(),
            saved_name: self.saved_name.clone(),
            saved_personality: self.saved_personality.clone(),
            saved_context: self.saved_context.clone(),
            name: self.name.read(cx).value().to_string(),
            personality: self.personality.read(cx).value().to_string(),
            context: self.context.read(cx).value().to_string(),
        }
    }
}

/// The Delete confirm's target.
struct DeleteTarget {
    avatar_id: String,
    name: String,
    refused: bool,
}

pub struct AvatarScreen {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    user_data_dir: PathBuf,
    tab: Tab,
    active: bool,
    persona: Option<CohostPersona>,
    /// "About you": the avatar's notes (`cohost.settings` `notes`).
    notes: Option<String>,
    persona_fields: Option<persona::PersonaFields>,
    /// A failed save in Name and personality.
    persona_error: Option<String>,
    placement: Option<Placement>,
    library: Option<LibraryState>,
    /// `aiCapabilities.cohost.buddyLibrary.alive`: the web keeps imports.
    library_alive: bool,
    /// The first `cohost.library.get` has not answered.
    loading: bool,
    pending: Option<Pending>,
    /// The last refused call, in words.
    problem: Option<String>,
    /// A refused automatic sync stays quiet.
    quiet_problem: Option<String>,
    invitation_dismissed: bool,
    /// Make it Alive on a card that is not the active one: used first, then
    /// the creator opens once the backend says it is the avatar.
    alive_for: Option<String>,
    edit: Option<EditDialog>,
    edit_handle: DialogHandle,
    edit_want_open: bool,
    edit_was_open: bool,
    delete: Option<DeleteTarget>,
    delete_handle: DialogHandle,
    delete_want_open: bool,
    delete_was_open: bool,
}

impl AvatarScreen {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        user_data_dir: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let tab = Tab::from_id(UiLocal::in_dir(&user_data_dir).avatar_tab());
        let invitation_dismissed = studio.read_ui_settings(families::buddy_invitation_dismissed);
        let screen = Self {
            studio,
            runtime,
            user_data_dir,
            tab,
            active: false,
            persona: None,
            notes: None,
            persona_fields: None,
            persona_error: None,
            placement: None,
            library: None,
            library_alive: false,
            loading: true,
            pending: None,
            problem: None,
            quiet_problem: None,
            invitation_dismissed,
            alive_for: None,
            edit: None,
            edit_handle: DialogHandle::new(false),
            edit_want_open: false,
            edit_was_open: false,
            delete: None,
            delete_handle: DialogHandle::new(false),
            delete_want_open: false,
            delete_was_open: false,
        };
        screen.refresh(cx);
        screen.watch(cx);
        screen
    }

    /// The shell says whether Avatar is the page on screen. Opening the page
    /// syncs the library, as opening Electron's section does.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if active {
            self.sync(cx);
        }
    }

    fn watch(&self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let mut events = studio.backend().subscribe();
            loop {
                match events.recv().await {
                    Ok(BackendEvent::Untyped { event, payload }) => match event.as_str() {
                        LIBRARY_CHANGED_EVENT => {
                            let library = serde_json::from_value::<LibraryState>(payload).ok();
                            let _ = this.update(cx, |screen, cx| {
                                if let Some(library) = library {
                                    screen.library_changed(library, cx);
                                }
                            });
                        }
                        videorc_app_core::chat::overlay::LAYOUT_EVENT => {
                            let placement = Placement::from_layout(&payload);
                            let _ = this.update(cx, |screen, cx| {
                                if placement.is_some() {
                                    screen.placement = placement;
                                    cx.notify();
                                }
                            });
                        }
                        SETTINGS_CHANGED_EVENT | "account.changed" => {
                            let _ = this.update(cx, |screen, cx| screen.refresh(cx));
                        }
                        _ => {}
                    },
                    Ok(BackendEvent::Ready(_)) | Ok(BackendEvent::EventsLagged(_)) => {
                        let _ = this.update(cx, |screen, cx| screen.refresh(cx));
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = this.update(cx, |screen, cx| screen.refresh(cx));
                    }
                    Err(_) => break,
                }
            }
        })
        .detach();
    }

    /// The persona, the cached library (no network) and the overlay's
    /// switches.
    fn refresh(&self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let read = self.runtime.spawn(async move {
            let backend = studio.backend().clone();
            let settings = backend
                .request("cohost.settings.get", json!({}))
                .await
                .ok()
                .and_then(|value| CohostSettingsView::from_json(&value));
            let notes = settings.as_ref().map(|settings| settings.notes.clone());
            let persona = settings.and_then(|settings| settings.persona);
            let library = backend
                .request("cohost.library.get", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<LibraryState>(value).ok());
            let placement = studio
                .overlay_layout()
                .await
                .ok()
                .and_then(|layout| Placement::from_layout(&layout));
            let library_alive = backend
                .request("ai.capabilities.get", json!({}))
                .await
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/cohost/buddyLibrary/alive")
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false);
            (persona, notes, library, placement, library_alive)
        });
        cx.spawn(async move |this, cx| {
            let Ok((persona, notes, library, placement, library_alive)) = read.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                if persona.is_some() {
                    screen.persona = persona;
                }
                if notes.is_some() {
                    screen.notes = notes;
                }
                if let Some(library) = library {
                    screen.library_changed(library, cx);
                }
                screen.library_alive = library_alive;
                screen.loading = false;
                if placement.is_some() {
                    screen.placement = placement;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn library_changed(&mut self, library: LibraryState, cx: &mut Context<Self>) {
        let ready = self.alive_for.as_ref().is_some_and(|id| {
            library.active_avatar_id.as_ref() == Some(id) && library.busy.is_none()
        });
        self.library = Some(library);
        self.loading = false;
        if ready {
            self.alive_for = None;
            self.open_alive_creator(cx);
        }
        cx.notify();
    }

    /// One library call: `true` once the backend accepted it. A refusal
    /// becomes the section's problem; a refused automatic sync stays quiet.
    fn call(
        &mut self,
        pending: Pending,
        method: &'static str,
        params: Value,
        then: impl FnOnce(&mut Self, bool, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.pending.is_some() {
            return;
        }
        self.pending = Some(pending);
        cx.notify();
        let backend = self.studio.backend().clone();
        let request = self
            .runtime
            .spawn(async move { backend.request(method, params).await });
        cx.spawn(async move |this, cx| {
            let answer = request.await;
            let _ = this.update(cx, |screen, cx| {
                screen.pending = None;
                let accepted = match answer {
                    Ok(Ok(value)) => value.get("accepted").and_then(Value::as_bool) != Some(false),
                    Ok(Err(error)) => {
                        let copy =
                            user_error_message(Failure::Rpc(&error), Some(UPDATE_THE_LIBRARY));
                        let message = format!("{}. {}", copy.title, copy.description);
                        if pending == Pending::Sync {
                            screen.quiet_problem = Some(message.clone());
                        }
                        screen.problem = Some(message);
                        false
                    }
                    Err(_) => false,
                };
                if accepted {
                    screen.problem = None;
                }
                then(screen, accepted, cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        self.call(
            Pending::Sync,
            "cohost.library.sync",
            json!({ "reason": "tab" }),
            |_, _, _| {},
            cx,
        );
    }

    pub(crate) fn use_avatar(&mut self, avatar_id: String, cx: &mut Context<Self>) {
        self.call(
            Pending::Use,
            "cohost.library.use",
            json!({ "avatarId": avatar_id }),
            |_, _, _| {},
            cx,
        );
    }

    pub(crate) fn save_to_library(&mut self, cx: &mut Context<Self>) {
        self.call(
            Pending::SaveToLibrary,
            "cohost.library.saveToLibrary",
            json!({}),
            |_, _, _| {},
            cx,
        );
    }

    pub(crate) fn dismiss_invitation(&mut self, cx: &mut Context<Self>) {
        self.invitation_dismissed = true;
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .write_settings(vec![families::write_buddy_invitation_dismissed()])
                .await;
        });
        cx.notify();
    }

    /// Make it Alive: the active card opens the creator at once; another is
    /// used first.
    pub(crate) fn make_alive(&mut self, avatar_id: String, active: bool, cx: &mut Context<Self>) {
        if active {
            self.open_alive_creator(cx);
            return;
        }
        let id = avatar_id.clone();
        self.call(
            Pending::Use,
            "cohost.library.use",
            json!({ "avatarId": avatar_id }),
            move |screen, accepted, _| {
                if accepted {
                    screen.alive_for = Some(id);
                }
            },
            cx,
        );
    }

    /// The Alive creator lands in its own PR (P1133 to P1149).
    fn open_alive_creator(&mut self, _cx: &mut Context<Self>) {
        eprintln!("[videorc-app] Avatar: Make it Alive (the Alive creator lands next)");
    }

    /// The four-step onboarding lands in its own PR (P1077 to P1093).
    pub(crate) fn open_onboarding(&mut self, _cx: &mut Context<Self>) {
        eprintln!("[videorc-app] Avatar: New avatar (the onboarding lands next)");
    }

    pub(crate) fn sign_in(&mut self, _cx: &mut Context<Self>) {
        eprintln!("[videorc-app] Avatar: Sign in (account UI next)");
    }

    pub(crate) fn open_page(&mut self, page: PageId, _window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(OpenPage(page));
    }

    pub(crate) fn open_edit(
        &mut self,
        kind: EditKind,
        avatar_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entry = self
            .library
            .as_ref()
            .and_then(|library| library.mine.as_ref())
            .and_then(|mine| mine.iter().find(|entry| entry.id == avatar_id))
            .cloned();
        let Some(entry) = entry else {
            return;
        };
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(words::NAME_PLACEHOLDER)
                .default_value(entry.name.clone())
        });
        let personality = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(words::PERSONALITY_PLACEHOLDER)
                .default_value(entry.personality.clone())
        });
        let context = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(words::ABOUT_PLACEHOLDER)
                .default_value(entry.context.clone())
        });
        cx.observe(&name, |_, _, cx| cx.notify()).detach();
        cx.observe(&personality, |_, _, cx| cx.notify()).detach();
        cx.observe(&context, |_, _, cx| cx.notify()).detach();
        self.edit = Some(EditDialog {
            form_kind: kind,
            avatar_id: entry.id,
            saved_name: entry.name,
            saved_personality: entry.personality,
            saved_context: entry.context,
            name,
            personality,
            context,
            refused: false,
        });
        self.edit_want_open = true;
        cx.notify();
    }

    pub(crate) fn close_edit(&mut self, cx: &mut Context<Self>) {
        self.edit_want_open = false;
        cx.notify();
    }

    /// Save: the dialog closes only once the backend accepted (plan 174
    /// G-24); a refusal shows inside it, the fields still filled.
    pub(crate) fn save_edit(&mut self, cx: &mut Context<Self>) {
        let Some(params) = self
            .edit
            .as_ref()
            .and_then(|edit| edit.form(cx).update_params())
        else {
            return;
        };
        if let Some(edit) = self.edit.as_mut() {
            edit.refused = false;
        }
        self.call(
            Pending::Update,
            "cohost.library.update",
            params,
            |screen, accepted, _| {
                if accepted {
                    screen.edit_want_open = false;
                } else if let Some(edit) = screen.edit.as_mut() {
                    edit.refused = true;
                }
            },
            cx,
        );
    }

    pub(crate) fn ask_delete(&mut self, avatar_id: String, name: String, cx: &mut Context<Self>) {
        self.delete = Some(DeleteTarget {
            avatar_id,
            name,
            refused: false,
        });
        self.delete_want_open = true;
        cx.notify();
    }

    pub(crate) fn cancel_delete(&mut self, cx: &mut Context<Self>) {
        if self.pending == Some(Pending::Delete) {
            return;
        }
        self.delete_want_open = false;
        cx.notify();
    }

    pub(crate) fn confirm_delete(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.delete.as_mut() else {
            return;
        };
        target.refused = false;
        let avatar_id = target.avatar_id.clone();
        self.call(
            Pending::Delete,
            "cohost.library.delete",
            json!({ "avatarId": avatar_id }),
            |screen, accepted, _| {
                if accepted {
                    screen.delete_want_open = false;
                } else if let Some(target) = screen.delete.as_mut() {
                    target.refused = true;
                }
            },
            cx,
        );
    }

    /// Opens and closes the two dialogs with the window; Escape or the
    /// backdrop closing one is a cancel.
    fn sync_dialogs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        sync_handle(
            &self.edit_handle,
            &mut self.edit_want_open,
            &mut self.edit_was_open,
            window,
            cx,
        );
        sync_handle(
            &self.delete_handle,
            &mut self.delete_want_open,
            &mut self.delete_was_open,
            window,
            cx,
        );
    }

    fn display_name(&self) -> String {
        display_name(self.persona.as_ref().map(|persona| persona.name.as_str()))
    }

    /// The avatar's own idle picture (`buddyPictureUrl`); None keeps the golem.
    fn persona_picture(&self) -> Option<PathBuf> {
        let idle = self.persona.as_ref()?.images.idle.as_deref()?;
        pictures::managed_path(&self.user_data_dir, idle)
    }

    fn working(&self) -> bool {
        self.pending.is_some()
            || self
                .library
                .as_ref()
                .is_some_and(|library| library.busy.is_some())
    }

    /// The problem the section shows: never a refused automatic sync.
    fn shown_problem(&self) -> Option<String> {
        let problem = self.problem.as_ref()?;
        (Some(problem) != self.quiet_problem.as_ref()).then(|| problem.clone())
    }

    pub(crate) fn select_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        let tab = Tab::from_index(index);
        if self.tab == tab {
            return;
        }
        self.tab = tab;
        let _ = UiLocal::in_dir(&self.user_data_dir).set_avatar_tab(tab.id());
        cx.notify();
    }
}

fn sync_handle(
    handle: &DialogHandle,
    want_open: &mut bool,
    was_open: &mut bool,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) {
    if *want_open {
        if !handle.is_open() {
            if *was_open {
                // Closed by Escape or the backdrop.
                *want_open = false;
                *was_open = false;
            } else {
                handle.open(window, cx);
                *was_open = true;
            }
        }
    } else {
        if handle.is_open() {
            handle.close(window, cx);
        }
        *was_open = false;
    }
}

impl Render for AvatarScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_dialogs(window, cx);
        self.ensure_persona_fields(window, cx);
        let body = match self.tab {
            Tab::Profile => div()
                .flex()
                .flex_col()
                .child(status::render_status(self, window, cx))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(size::GUTTER))
                        .p(px(size::GUTTER))
                        .child(library::render_library(self, window, cx))
                        .children(persona::render_persona(self, window, cx)),
                )
                .into_any_element(),
            Tab::Greetings => {
                let t = theme::resolve(None, window, cx);
                div()
                    .p(px(size::GUTTER))
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child("Greetings come in their own Phase 3 PR.")
                    .into_any_element()
            }
        };

        let entity = cx.entity();
        let mut tabs = PageTabs::new("avatar-page", words::AVATAR_TABS_LABEL);
        for (_, label) in words::AVATAR_TABS {
            tabs = tabs.tab(label);
        }
        let tabs = tabs
            .selected(self.tab.index())
            .on_select(move |index, _, cx| {
                entity.update(cx, |screen, cx| screen.select_tab(index, cx));
            });

        div()
            .id("avatar-screen")
            .size_full()
            .flex()
            .flex_col()
            .font_family(FONT)
            .child(tabs.child(body))
            .child(library::edit_dialog(self, window, cx))
            .child(library::delete_dialog(self, window, cx))
            .child(persona::persona_dialogs(self, cx))
    }
}
