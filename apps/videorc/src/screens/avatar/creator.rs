//! The Alive creator (`buddy-pet-creator.tsx`, `use-buddy-pet-creator.ts`,
//! plan 168 S-F4, S-F5; plan 174 S3.15a): while it is open it stands in for
//! the Profile tab. One picture becomes an Alive avatar: Picture (the
//! avatar's idle picture or an upload, then what Videorc read from it as
//! editable sentences), First poses (four poses, drawn again at most three
//! times), All poses (eight sets, one at a time, then the moves put
//! together on this computer), Check (every row marked "Looks right"; a
//! redo clears that row's mark) and Save (named; the avatar wears it).
//!
//! The backend owns the creation (`cohost.pet.creation.*`,
//! `cohost.pet.identity`, `cohost.pet.sheet.generate`, `cohost.pet.build`,
//! `cohost.pet.save`): the long calls answer at once and report by event,
//! so closing the creator or the app picks up where it was. The "Looks
//! right" marks and the sheets this window is making last as long as the
//! window. Every draw and redo spends the streamer's creations: nothing here
//! runs in a test.
//!
//! Check's living preview plays the built moves (`LazyBuddyPetPreview` in
//! Electron), read again per build; it ticks only while Check shows on the
//! page. The neutral cell stands in when the moves can't be played.
//!
//! Not yet in this flavour: keeping the marks across a restart.

use std::collections::{BTreeMap, BTreeSet};

use gpui::{
    AnyElement, Context, Entity, FocusHandle, ImageSource, KeyDownEvent, ObjectFit,
    PathPromptOptions, Role, SharedString, Transformation, Window, div, img, prelude::*, px,
    radians, relative,
};
use serde_json::{Value, json};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::user_error::UserErrorContext;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::Select;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::skeleton::Skeleton;
use videorc_kit::spinner::Spinner;
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, size, text};

use super::creator_view::{
    self as view, ATLAS_SHEETS, BuildProgress, Creation, IdentityRead, Marks, Notes, NotesDraft,
    ReviewRow, SheetGenerated, SheetPhase, Side, Status, Step,
};
use super::files::{self, Atlas, ChooseError, ChosenPicture, PictureKind};
use super::gate::{self, Gate, GateKind};
use super::onboarding::{PRIMARY_KEYS, refusal};
use super::preview::PetPreview;
use super::{AvatarScreen, sync_handle};

/// A refused creator call, as one sentence (`problemOf`).
const UPDATE_THE_LOOK: UserErrorContext = UserErrorContext {
    action: "update",
    object: "your avatar's look",
};

/// Check's cells: a gaze cell, a reaction or extra.
const GAZE_CELL_PX: f32 = 72.;
const OTHER_CELL_PX: f32 = 60.;
/// The living preview beside Check (Electron's `size={160}`), and the
/// neutral cell that stands in for it.
const CHECK_PREVIEW_PX: f32 = 160.;
/// The picture step's frame.
const REFERENCE_PX: f32 = 160.;
/// The pilot sheet, at most.
const PILOT_PX: f32 = 320.;

/// A call this window started and waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Job {
    Start,
    Identity,
    Sheet,
    Build,
    Save,
    Cancel,
}

/// Where the picture comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reference {
    Persona,
    Upload,
}

/// What runs after a status read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Then {
    Nothing,
    /// A sheet came in: the next one, or the build a redo asked for.
    Continue,
}

/// The step's primary action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Run {
    Read,
    Pilot,
    Sheets,
    Build,
    Naming,
    Save,
}

struct Primary {
    id: &'static str,
    label: &'static str,
    disabled: bool,
    run: Run,
}

/// One one-sided feature's field.
struct FeatureField {
    id: u64,
    feature: Entity<InputState>,
    side: Side,
}

/// The notes as editable sentences.
struct NotesFields {
    palette: Entity<InputState>,
    materials: Entity<InputState>,
    proportions: Entity<TextareaState>,
    features: Vec<FeatureField>,
    next_id: u64,
}

pub struct Creator {
    open: bool,
    /// The look's description when Make it Alive opened the creator (D11).
    look_notes: Option<String>,
    loading: bool,
    creation: Option<Creation>,
    pending: Option<Job>,
    /// Keep making the missing sheets one at a time, then build.
    auto_sheets: bool,
    /// A redo builds again once its sheet is made.
    auto_build: bool,
    /// Why the last attempt at a sheet failed, until it is made.
    sheet_errors: BTreeMap<String, String>,
    identity_error: Option<String>,
    /// The last refusal or failure outside a sheet: its code and sentence.
    problem: Option<(String, String)>,
    /// The running build's latest step.
    build: Option<BuildProgress>,
    /// In-flight answers from an earlier creation never land.
    generation: u64,
    /// Creations whose sheets this window is making: a creator opened again
    /// picks the loop up where it was.
    sheets_wanted: BTreeSet<String>,
    /// "Looks right", per creation.
    marks: BTreeMap<String, Marks>,
    naming: bool,
    reference: Reference,
    upload: Option<ChosenPicture>,
    upload_error: Option<&'static str>,
    choosing_picture: bool,
    /// A row redone from Check keeps Check on screen while it is drawn and
    /// the moves are made again.
    redo_key: Option<String>,
    notes: Option<NotesFields>,
    /// The backend's notes the fields were last filled from.
    applied_notes: Option<(String, Notes)>,
    name: Option<Entity<InputState>>,
    name_seeded: bool,
    focus: Option<FocusHandle>,
    focus_root: bool,
    atlas_key: String,
    atlas: Option<Atlas>,
    /// Check's living preview, made the first time Check shows.
    preview: Option<Entity<PetPreview>>,
    preview_active: bool,
    cancel_handle: DialogHandle,
    cancel_want_open: bool,
    cancel_was_open: bool,
}

impl Creator {
    fn new() -> Self {
        Self {
            open: false,
            look_notes: None,
            loading: true,
            creation: None,
            pending: None,
            auto_sheets: false,
            auto_build: false,
            sheet_errors: BTreeMap::new(),
            identity_error: None,
            problem: None,
            build: None,
            generation: 0,
            sheets_wanted: BTreeSet::new(),
            marks: BTreeMap::new(),
            naming: false,
            reference: Reference::Persona,
            upload: None,
            upload_error: None,
            choosing_picture: false,
            redo_key: None,
            notes: None,
            applied_notes: None,
            name: None,
            name_seeded: false,
            focus: None,
            focus_root: false,
            atlas_key: String::new(),
            atlas: None,
            preview: None,
            preview_active: false,
            cancel_handle: DialogHandle::new(false),
            cancel_want_open: false,
            cancel_was_open: false,
        }
    }

    /// A fresh start: what a new controller holds (`INITIAL`).
    fn reset(&mut self) {
        self.loading = false;
        self.creation = None;
        self.pending = None;
        self.auto_sheets = false;
        self.auto_build = false;
        self.sheet_errors.clear();
        self.identity_error = None;
        self.problem = None;
        self.build = None;
    }

    fn build_id(&self) -> Option<String> {
        self.creation
            .as_ref()
            .map(|creation| creation.build_id.clone())
    }

    fn working(&self) -> bool {
        self.pending.is_some()
            || self
                .creation
                .as_ref()
                .is_some_and(|creation| creation.running.is_some())
    }

    fn marks(&self) -> Marks {
        self.creation
            .as_ref()
            .and_then(|creation| self.marks.get(&creation.build_id))
            .cloned()
            .unwrap_or_default()
    }

    /// The fields as the notes draft.
    fn notes_draft(&self, cx: &gpui::App) -> Option<NotesDraft> {
        let fields = self.notes.as_ref()?;
        self.applied_notes.as_ref()?;
        Some(NotesDraft {
            palette: fields.palette.read(cx).value().to_string(),
            materials: fields.materials.read(cx).value().to_string(),
            proportions: fields.proportions.read(cx).value().to_string(),
            asymmetric: fields
                .features
                .iter()
                .map(|field| (field.feature.read(cx).value().to_string(), field.side))
                .collect(),
        })
    }

    /// The step on screen (`buddyPetCreatorStep`, with "Use another
    /// picture" and a row redone from Check).
    fn step(&self) -> Step {
        let creation = self.creation.as_ref();
        let rebuilding = self.redo_key.is_some()
            && creation.is_some_and(|creation| {
                creation.step == "build"
                    && creation
                        .build
                        .as_ref()
                        .is_some_and(|build| build.state == "built")
            });
        if self.choosing_picture && creation.is_some_and(|creation| !creation.pilot_accepted) {
            Step::Reference
        } else if rebuilding {
            Step::Review
        } else {
            view::creator_step(creation, self.naming)
        }
    }
}

impl AvatarScreen {
    /// Opens the creator over Profile (Make it Alive, Create under Alive).
    /// From the onboarding, `look_notes` is what was described for the look.
    pub(super) fn show_creator(&mut self, look_notes: Option<String>, cx: &mut Context<Self>) {
        let creator = self.creator.get_or_insert_with(Creator::new);
        if creator.open {
            return;
        }
        creator.open = true;
        creator.look_notes = look_notes.filter(|notes| !notes.trim().is_empty());
        creator.reset();
        creator.loading = true;
        creator.generation += 1;
        creator.naming = false;
        creator.reference = Reference::Persona;
        creator.upload = None;
        creator.upload_error = None;
        creator.choosing_picture = false;
        creator.redo_key = None;
        creator.name_seeded = false;
        creator.focus_root = true;
        // This month's creations are the web's latest.
        self.refresh(cx);
        self.creator_refresh(Then::Nothing, cx);
        cx.notify();
    }

    fn close_creator(&mut self, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut() {
            creator.open = false;
            creator.cancel_want_open = false;
            creator.generation += 1;
        }
        self.sync_creator_preview(cx);
        cx.notify();
    }

    pub(super) fn creator_open(&self) -> bool {
        self.creator.as_ref().is_some_and(|creator| creator.open)
    }

    /// `cohost.pet.creation.status`.
    fn creator_refresh(&mut self, then: Then, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_ref() else {
            return;
        };
        if !creator.open || matches!(creator.pending, Some(Job::Cancel | Job::Save)) {
            return;
        }
        let at = creator.generation;
        self.backend_call(
            "cohost.pet.creation.status",
            json!({}),
            move |screen, answer, cx| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                creator.loading = false;
                match answer {
                    Ok(value) => {
                        creator.creation = serde_json::from_value::<Status>(value)
                            .ok()
                            .and_then(|status| status.creation);
                    }
                    Err(error) => {
                        creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                        return;
                    }
                }
                screen.creator_resume_sheets(cx);
                if then == Then::Continue {
                    let Some(creator) = screen.creator.as_mut() else {
                        return;
                    };
                    if creator.auto_sheets {
                        screen.creator_continue_sheets(cx);
                    } else if creator.auto_build {
                        creator.auto_build = false;
                        screen.creator_build(cx);
                    }
                }
            },
            cx,
        );
    }

    /// A creation this window was making sheets for, seen again: carry on
    /// (the sheet in flight, if any, continues it).
    fn creator_resume_sheets(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let Some(creation) = creator.creation.as_ref() else {
            return;
        };
        if creator.auto_sheets || !creator.sheets_wanted.contains(&creation.build_id) {
            return;
        }
        let running = creation.running.is_some();
        creator.auto_sheets = true;
        if !running {
            self.creator_continue_sheets(cx);
        }
    }

    /// The next missing sheet, or the build once every sheet is made.
    fn creator_continue_sheets(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        if !creator.auto_sheets {
            return;
        }
        let Some(creation) = creator.creation.as_ref() else {
            return;
        };
        if let Some(next) = view::next_sheet(creation) {
            self.creator_generate(next.key, false, None, |_, _, _| {}, cx);
            return;
        }
        let fresh = creation.build.as_ref().is_some_and(|build| build.fresh);
        let id = creation.build_id.clone();
        creator.sheets_wanted.remove(&id);
        creator.auto_sheets = false;
        if !fresh {
            self.creator_build(cx);
        }
    }

    /// `cohost.pet.sheet.generate`: the pilot (with the corrected notes) or
    /// one atlas sheet. `then` hears whether the backend took it.
    fn creator_generate(
        &mut self,
        key: &'static str,
        redo: bool,
        notes: Option<Notes>,
        then: impl FnOnce(&mut Self, bool, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let Some(id) = creator.build_id() else {
            return;
        };
        let mut params = json!({ "buildId": id, "redo": redo });
        if key == "pilot" {
            params["kind"] = json!("pilot");
        } else if let Some(sheet) = ATLAS_SHEETS.iter().find(|sheet| sheet.key == key) {
            params["kind"] = json!(sheet.kind);
            if let Some(row) = sheet.row {
                params["row"] = json!(row);
            }
        } else {
            return;
        }
        if let Some(notes) = notes {
            params["notes"] = serde_json::to_value(notes).unwrap_or(Value::Null);
        }
        creator.pending = Some(Job::Sheet);
        creator.problem = None;
        let at = creator.generation;
        self.backend_call(
            "cohost.pet.sheet.generate",
            params,
            move |screen, answer, cx| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                match answer {
                    Ok(_) => {
                        screen.creator_refresh(Then::Nothing, cx);
                        then(screen, true, cx);
                    }
                    Err(error) => {
                        let (code, line) = refusal(&error, UPDATE_THE_LOOK);
                        creator.pending = None;
                        creator.auto_sheets = false;
                        creator.auto_build = false;
                        creator.sheet_errors.insert(key.to_string(), line.clone());
                        creator.problem = Some((code, line));
                        creator.sheets_wanted.remove(&id);
                        then(screen, false, cx);
                    }
                }
            },
            cx,
        );
    }

    /// `cohost.pet.build`: the moves, put together on this computer.
    fn creator_build(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let Some(id) = creator.build_id() else {
            return;
        };
        creator.pending = Some(Job::Build);
        creator.problem = None;
        creator.build = None;
        let at = creator.generation;
        self.backend_call(
            "cohost.pet.build",
            json!({ "buildId": id }),
            move |screen, answer, cx| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                match answer {
                    Ok(_) => screen.creator_refresh(Then::Nothing, cx),
                    Err(error) => {
                        creator.pending = None;
                        creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                    }
                }
            },
            cx,
        );
    }

    /// "Read the picture": open a creation (when none is) and read it.
    fn creator_read_reference(&mut self, reference: Value, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        creator.choosing_picture = false;
        creator.problem = None;
        creator.identity_error = None;
        if creator.creation.is_some() {
            self.creator_identity(reference, cx);
            return;
        }
        creator.pending = Some(Job::Start);
        let at = creator.generation;
        self.backend_call(
            "cohost.pet.creation.start",
            json!({}),
            move |screen, answer, cx| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                match answer {
                    Ok(value) => {
                        creator.creation = serde_json::from_value::<Status>(value)
                            .ok()
                            .and_then(|status| status.creation);
                        screen.creator_identity(reference, cx);
                    }
                    Err(error) => {
                        creator.pending = None;
                        creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                    }
                }
            },
            cx,
        );
    }

    /// `cohost.pet.identity`: the notes come back as an event.
    fn creator_identity(&mut self, reference: Value, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let Some(id) = creator.build_id() else {
            creator.pending = None;
            return;
        };
        creator.pending = Some(Job::Identity);
        let at = creator.generation;
        self.backend_call(
            "cohost.pet.identity",
            json!({ "buildId": id, "reference": reference }),
            move |screen, answer, _| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                if let Err(error) = answer {
                    creator.pending = None;
                    creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                }
            },
            cx,
        );
    }

    /// "Looks like my avatar" and "Draw the poses": the missing sheets one
    /// after another, then the build.
    fn creator_make_sheets(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        if let Some(id) = creator.build_id() {
            creator.sheets_wanted.insert(id);
        }
        creator.auto_sheets = true;
        creator.sheet_errors.clear();
        self.creator_continue_sheets(cx);
    }

    /// Redo one atlas sheet (one of this creation's redos), then build
    /// again.
    fn creator_redo_sheet(&mut self, key: &'static str, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        creator.auto_build = true;
        self.creator_generate(
            key,
            true,
            None,
            |screen, accepted, _| {
                if !accepted && let Some(creator) = screen.creator.as_mut() {
                    creator.auto_build = false;
                }
            },
            cx,
        );
    }

    /// A row redone from Check: its mark goes, and Check stays on screen.
    fn creator_redo_row(&mut self, key: &'static str, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        if let Some(creation) = creator.creation.as_ref() {
            let marks = creator.marks.entry(creation.build_id.clone()).or_default();
            view::mark_row(marks, creation, key, false);
        }
        creator.redo_key = Some(key.to_string());
        self.creator_redo_sheet(key, cx);
    }

    fn creator_mark(&mut self, key: &'static str, marked: bool, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut()
            && let Some(creation) = creator.creation.as_ref()
        {
            let marks = creator.marks.entry(creation.build_id.clone()).or_default();
            view::mark_row(marks, creation, key, marked);
        }
        cx.notify();
    }

    /// "Save and wear it": the avatar wears the new moves.
    fn creator_save(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let name = creator
            .name
            .as_ref()
            .and_then(|name| view::name_to_save(&name.read(cx).value()));
        let (Some(name), Some(id)) = (name, creator.build_id()) else {
            return;
        };
        creator.generation += 1;
        let at = creator.generation;
        creator.pending = Some(Job::Save);
        creator.problem = None;
        self.backend_call(
            "cohost.pet.save",
            json!({ "buildId": id, "name": name }),
            move |screen, answer, cx| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                creator.pending = None;
                match answer {
                    Ok(_) => {
                        creator.marks.remove(&id);
                        creator.creation = None;
                        // The persona is Alive now: the page follows the
                        // backend's settings.
                        screen.refresh(cx);
                        screen.close_creator(cx);
                    }
                    Err(error) => {
                        creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                    }
                }
            },
            cx,
        );
    }

    /// "Cancel creation", once confirmed: true only when the backend says
    /// so.
    fn creator_cancel(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        creator.cancel_want_open = false;
        let Some(id) = creator.build_id() else {
            return;
        };
        creator.generation += 1;
        let at = creator.generation;
        creator.sheets_wanted.remove(&id);
        creator.pending = Some(Job::Cancel);
        creator.problem = None;
        creator.auto_sheets = false;
        creator.auto_build = false;
        self.backend_call(
            "cohost.pet.creation.cancel",
            json!({ "buildId": id }),
            move |screen, answer, _| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                match answer {
                    Ok(value) => {
                        creator.reset();
                        creator.creation = serde_json::from_value::<Status>(value)
                            .ok()
                            .and_then(|status| status.creation);
                        creator.naming = false;
                        creator.redo_key = None;
                        creator.marks.remove(&id);
                    }
                    Err(error) => {
                        creator.pending = None;
                        creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                    }
                }
            },
            cx,
        );
    }

    /// "Start a new one": cancel what is there, then begin with nothing.
    fn creator_start_over(&mut self, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        creator.generation += 1;
        let at = creator.generation;
        let id = creator.build_id();
        if let Some(id) = id.as_ref() {
            creator.sheets_wanted.remove(id);
        }
        creator.auto_build = false;
        creator.auto_sheets = false;
        creator.pending = Some(Job::Cancel);
        creator.problem = None;
        let Some(id) = id else {
            creator.reset();
            cx.notify();
            return;
        };
        self.backend_call(
            "cohost.pet.creation.cancel",
            json!({ "buildId": id }),
            move |screen, answer, _| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                if creator.generation != at {
                    return;
                }
                match answer {
                    Ok(_) => {
                        creator.reset();
                        creator.naming = false;
                        creator.redo_key = None;
                    }
                    Err(error) => {
                        creator.pending = None;
                        creator.problem = Some(refusal(&error, UPDATE_THE_LOOK));
                    }
                }
            },
            cx,
        );
    }

    /// The creator's events, while it is open (Electron's controller lives
    /// only as long as the view).
    pub(super) fn creator_event(&mut self, event: &str, payload: Value, cx: &mut Context<Self>) {
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        if !creator.open || matches!(creator.pending, Some(Job::Cancel | Job::Save)) {
            return;
        }
        let current = creator.build_id();
        match event {
            view::IDENTITY_READ_EVENT => {
                let Ok(read) = serde_json::from_value::<IdentityRead>(payload) else {
                    return;
                };
                if current.as_deref() != Some(read.build_id.as_str()) {
                    return;
                }
                creator.pending = None;
                creator.identity_error = read.error.map(|error| error.message);
                self.creator_refresh(Then::Nothing, cx);
            }
            view::SHEET_GENERATED_EVENT => {
                let Ok(sheet) = serde_json::from_value::<SheetGenerated>(payload) else {
                    return;
                };
                if current.as_deref() != Some(sheet.build_id.as_str()) {
                    return;
                }
                creator.pending = None;
                match sheet.error {
                    Some(error) => {
                        creator
                            .sheet_errors
                            .insert(sheet.sheet.clone(), error.message.clone());
                        creator.auto_build = false;
                        creator.auto_sheets = false;
                        creator.sheets_wanted.remove(&sheet.build_id);
                        creator.problem = Some((error.code, error.message));
                        self.creator_refresh(Then::Nothing, cx);
                    }
                    None => {
                        creator.sheet_errors.remove(&sheet.sheet);
                        self.creator_refresh(Then::Continue, cx);
                    }
                }
            }
            view::BUILD_PROGRESS_EVENT => {
                let Ok(progress) = serde_json::from_value::<BuildProgress>(payload) else {
                    return;
                };
                if current.as_deref() != Some(progress.build_id.as_str()) {
                    return;
                }
                if progress.ended() {
                    creator.pending = None;
                    creator.problem = (progress.step == "failed").then(|| {
                        (
                            progress.code.clone().unwrap_or_else(|| "failed".into()),
                            progress
                                .error
                                .clone()
                                .unwrap_or_else(|| "The build failed.".into()),
                        )
                    });
                    creator.build = Some(progress);
                    self.creator_refresh(Then::Nothing, cx);
                } else {
                    creator.build = Some(progress);
                }
            }
            _ => return,
        }
        cx.notify();
    }

    fn creator_choose_upload(&mut self, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut() {
            creator.upload_error = None;
        }
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(CHOOSE_PICTURE.into()),
        });
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let read = runtime
                .spawn_blocking(move || {
                    files::read_picture(
                        &path,
                        &[PictureKind::Png, PictureKind::Webp],
                        files::REFERENCE_MAX_BYTES,
                    )
                })
                .await
                .unwrap_or(Err(ChooseError::Unreadable));
            let _ = this.update(cx, |screen, cx| {
                let Some(creator) = screen.creator.as_mut() else {
                    return;
                };
                match read {
                    Ok(picture) => creator.upload = Some(picture),
                    Err(ChooseError::TooLarge) => creator.upload_error = Some(UPLOAD_TOO_LARGE),
                    Err(ChooseError::Kind) => creator.upload_error = Some(UPLOAD_KIND),
                    Err(ChooseError::Unreadable) => creator.upload_error = Some(UPLOAD_UNREADABLE),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn creator_set_reference(&mut self, reference: Reference, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut() {
            creator.reference = reference;
        }
        cx.notify();
    }

    fn creator_add_feature(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let feature = cx.new(|cx| InputState::new(window, cx));
        cx.observe(&feature, |_, _, cx| cx.notify()).detach();
        if let Some(fields) = self
            .creator
            .as_mut()
            .and_then(|creator| creator.notes.as_mut())
        {
            let id = fields.next_id;
            fields.next_id += 1;
            fields.features.push(FeatureField {
                id,
                feature,
                side: Side::Left,
            });
        }
        cx.notify();
    }

    fn creator_remove_feature(&mut self, id: u64, cx: &mut Context<Self>) {
        if let Some(fields) = self
            .creator
            .as_mut()
            .and_then(|creator| creator.notes.as_mut())
        {
            fields.features.retain(|field| field.id != id);
        }
        cx.notify();
    }

    fn creator_set_side(&mut self, id: u64, side: Side, cx: &mut Context<Self>) {
        if let Some(field) = self
            .creator
            .as_mut()
            .and_then(|creator| creator.notes.as_mut())
            .and_then(|fields| fields.features.iter_mut().find(|field| field.id == id))
        {
            field.side = side;
        }
        cx.notify();
    }

    fn creator_set_naming(&mut self, naming: bool, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut() {
            creator.naming = naming;
        }
        cx.notify();
    }

    fn creator_new_avatar(&mut self, cx: &mut Context<Self>) {
        // The onboarding lives under My avatars, behind this view (G-4).
        self.close_creator(cx);
        self.show_onboarding(1, cx);
    }

    fn creator_ask_cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut() {
            creator.cancel_want_open = true;
        }
        cx.notify();
    }

    fn creator_keep(&mut self, cx: &mut Context<Self>) {
        if let Some(creator) = self.creator.as_mut() {
            creator.cancel_want_open = false;
        }
        cx.notify();
    }

    /// Why the whole creator is off, and whether a new creation may start
    /// (`buddyPetCreatorGate`): this month's creations stop only a new one.
    fn creator_gate(&self) -> (Option<Gate>, bool) {
        let gate = gate::alive_create_gate(&self.gate_input());
        let can_start = gate.is_none();
        let off = gate.filter(|gate| gate.kind != GateKind::Allowance);
        (off, can_start)
    }

    fn creator_primary(&self, cx: &gpui::App) -> Option<Primary> {
        let creator = self.creator.as_ref()?;
        let (gate, can_start) = self.creator_gate();
        let creation = creator.creation.as_ref();
        let working = creator.working();
        let off = gate.is_some() || working;
        let web = !creation.is_some_and(|creation| creation.expired);
        let step = creator.step();
        let show_notes = step == Step::Reference
            && creation.is_some_and(|creation| creation.notes.is_some())
            && !creator.choosing_picture;
        let notes_ready = creator
            .notes_draft(cx)
            .is_some_and(|draft| view::notes_from_draft(&draft).is_ok());
        let marks = creator.marks();
        let all_marked = creation.is_some_and(|creation| view::can_save(&marks, creation));
        Some(match step {
            Step::Reference if show_notes => Primary {
                id: "avatar-creator-make-pilot",
                label: if creator.pending == Some(Job::Sheet) {
                    "Drawing the first poses…"
                } else {
                    "Draw the first poses"
                },
                disabled: off || !notes_ready || !web,
                run: Run::Pilot,
            },
            Step::Reference => {
                let has_reference =
                    creator.reference == Reference::Persona || creator.upload.is_some();
                Primary {
                    id: "avatar-creator-read",
                    label: if matches!(creator.pending, Some(Job::Start | Job::Identity)) {
                        "Reading the picture…"
                    } else {
                        "Read the picture"
                    },
                    disabled: off || !has_reference || (creation.is_none() && !can_start) || !web,
                    run: Run::Read,
                }
            }
            Step::Pilot => Primary {
                id: "avatar-creator-accept-pilot",
                label: "Looks like my avatar",
                disabled: off || !web,
                run: Run::Sheets,
            },
            Step::Build => {
                let creation = creation?;
                if view::next_sheet(creation).is_some() {
                    Primary {
                        id: "avatar-creator-make-sheets",
                        label: if working {
                            "Drawing the poses…"
                        } else {
                            "Draw the poses"
                        },
                        disabled: off || !web,
                        run: Run::Sheets,
                    }
                } else {
                    Primary {
                        id: "avatar-creator-build",
                        label: if working {
                            "Making the moves…"
                        } else if creation.build.is_some() {
                            "Make the moves again"
                        } else {
                            "Make the moves"
                        },
                        disabled: off,
                        run: Run::Build,
                    }
                }
            }
            Step::Review => Primary {
                id: "avatar-creator-continue",
                label: "Name it",
                disabled: off || !all_marked,
                run: Run::Naming,
            },
            Step::Save => {
                let name_ready = creator
                    .name
                    .as_ref()
                    .is_some_and(|name| view::name_to_save(&name.read(cx).value()).is_some());
                Primary {
                    id: "avatar-creator-save",
                    label: if creator.pending == Some(Job::Save) {
                        "Saving…"
                    } else {
                        "Save and wear it"
                    },
                    disabled: off || !name_ready || !all_marked,
                    run: Run::Save,
                }
            }
        })
    }

    /// The step's primary action (its button, or ⌘↵ from inside the
    /// creator).
    fn creator_run_primary(&mut self, cx: &mut Context<Self>) {
        let Some(primary) = self.creator_primary(cx) else {
            return;
        };
        if primary.disabled {
            return;
        }
        match primary.run {
            Run::Read => {
                let Some(creator) = self.creator.as_ref() else {
                    return;
                };
                let reference = match (creator.reference, creator.upload.as_ref()) {
                    (Reference::Persona, _) => json!({ "kind": "persona-idle" }),
                    (Reference::Upload, Some(upload)) => {
                        json!({ "kind": "upload", "imageBase64": upload.base64 })
                    }
                    (Reference::Upload, None) => return,
                };
                self.creator_read_reference(reference, cx);
            }
            Run::Pilot => {
                let notes = self
                    .creator
                    .as_ref()
                    .and_then(|creator| creator.notes_draft(cx))
                    .and_then(|draft| view::notes_from_draft(&draft).ok());
                if let Some(notes) = notes {
                    self.creator_generate("pilot", false, Some(notes), |_, _, _| {}, cx);
                }
            }
            Run::Sheets => self.creator_make_sheets(cx),
            Run::Build => self.creator_build(cx),
            Run::Naming => self.creator_set_naming(true, cx),
            Run::Save => self.creator_save(cx),
        }
        cx.notify();
    }

    /// "Draw them again": a new pilot with the notes as they read now.
    fn creator_redo_pilot(&mut self, cx: &mut Context<Self>) {
        let notes = self
            .creator
            .as_ref()
            .and_then(|creator| creator.notes_draft(cx))
            .and_then(|draft| view::notes_from_draft(&draft).ok());
        if let Some(notes) = notes {
            self.creator_generate("pilot", false, Some(notes), |_, _, _| {}, cx);
        }
    }

    /// The fields (they need a window): the notes follow the backend's until
    /// the streamer edits, and the name starts as the avatar's.
    fn ensure_creator_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let persona_name = self
            .persona
            .as_ref()
            .map(|persona| persona.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| videorc_app_core::buddy::DEFAULT_AVATAR_NAME.to_string());
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        if creator.focus.is_none() {
            creator.focus = Some(cx.focus_handle());
        }
        if let Some(name) = creator.name.clone() {
            if !creator.name_seeded {
                name.update(cx, |state, cx| state.set_value(persona_name, window, cx));
                creator.name_seeded = true;
            }
        } else {
            let name = cx.new(|cx| InputState::new(window, cx).default_value(persona_name));
            cx.observe(&name, |_, _, cx| cx.notify()).detach();
            creator.name = Some(name);
            creator.name_seeded = true;
        }

        let backend = creator.creation.as_ref().and_then(|creation| {
            creation
                .notes
                .clone()
                .map(|notes| (creation.build_id.clone(), notes))
        });
        if backend == creator.applied_notes {
            return;
        }
        creator.applied_notes = backend.clone();
        let Some((_, notes)) = backend else {
            return;
        };
        let draft = view::notes_draft(&notes);
        if creator.notes.is_none() {
            let palette = cx.new(|cx| InputState::new(window, cx));
            let materials = cx.new(|cx| InputState::new(window, cx));
            let proportions = cx.new(|cx| TextareaState::new(window, cx));
            cx.observe(&palette, |_, _, cx| cx.notify()).detach();
            cx.observe(&materials, |_, _, cx| cx.notify()).detach();
            cx.observe(&proportions, |_, _, cx| cx.notify()).detach();
            creator.notes = Some(NotesFields {
                palette,
                materials,
                proportions,
                features: Vec::new(),
                next_id: 0,
            });
        }
        let Some(fields) = creator.notes.as_mut() else {
            return;
        };
        fields
            .palette
            .update(cx, |state, cx| state.set_value(draft.palette, window, cx));
        fields
            .materials
            .update(cx, |state, cx| state.set_value(draft.materials, window, cx));
        fields.proportions.update(cx, |state, cx| {
            state.set_value(draft.proportions, window, cx)
        });
        fields.features.clear();
        for (feature, side) in draft.asymmetric {
            let input = cx.new(|cx| InputState::new(window, cx).default_value(feature));
            cx.observe(&input, |_, _, cx| cx.notify()).detach();
            let id = fields.next_id;
            fields.next_id += 1;
            fields.features.push(FeatureField {
                id,
                feature: input,
                side,
            });
        }
    }

    /// Check's living preview plays the built moves, read again when the
    /// build's finish time moves (Electron's `reloadKey`). It ticks only
    /// while the page shows the creator on Check, so a closed creator,
    /// another tab or another step keeps no timer.
    pub(super) fn sync_creator_preview(&mut self, cx: &mut Context<Self>) {
        let active = self.active && self.tab == super::Tab::Profile;
        let persona_id = self.persona.as_ref().map(|persona| persona.id.clone());
        let user_data_dir = self.user_data_dir.clone();
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let wanted = active && creator.open && creator.step() == Step::Review;
        if wanted && creator.preview.is_none() {
            let preview = cx.new(|_| PetPreview::new(CHECK_PREVIEW_PX, "check"));
            cx.observe(&preview, |_, _, cx| cx.notify()).detach();
            creator.preview = Some(preview);
        }
        let Some(preview) = creator.preview.clone() else {
            return;
        };
        let changed = wanted != creator.preview_active;
        creator.preview_active = wanted;
        if !(wanted || changed) {
            return;
        }
        let built = creator.creation.as_ref().and_then(|creation| {
            let build = creation.build.as_ref()?;
            (build.state == "built").then(|| (creation.build_id.clone(), build.finished_at.clone()))
        });
        preview.update(cx, |preview, cx| {
            if changed {
                preview.set_active(wanted, cx);
            }
            if wanted && let (Some(persona_id), Some((build_id, stamp))) = (persona_id, built) {
                preview.show_creation(&user_data_dir, &persona_id, &build_id, &stamp, cx);
            }
        });
    }

    /// The built moves for Check, read again per build.
    fn load_creator_atlas(&mut self, cx: &mut Context<Self>) {
        let Some(persona_id) = self.persona.as_ref().map(|persona| persona.id.clone()) else {
            return;
        };
        let user_data_dir = self.user_data_dir.clone();
        let Some(creator) = self.creator.as_mut() else {
            return;
        };
        let Some((build_id, stamp)) = creator.creation.as_ref().and_then(|creation| {
            let build = creation.build.as_ref()?;
            (build.state == "built").then(|| (creation.build_id.clone(), build.finished_at.clone()))
        }) else {
            return;
        };
        let key = format!("{persona_id}/{build_id}/{stamp}");
        if creator.atlas_key == key {
            return;
        }
        creator.atlas_key = key.clone();
        creator.atlas = None;
        let read = cx.background_spawn(async move {
            files::load_atlas(&user_data_dir, &persona_id, &build_id)
        });
        cx.spawn(async move |this, cx| {
            let atlas = read.await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(creator) = screen.creator.as_mut()
                    && creator.atlas_key == key
                {
                    creator.atlas = atlas;
                    cx.notify();
                }
            });
        })
        .detach();
    }
}

/// The creator's own words (`buddy-pet-creator.tsx`).
const TITLE: &str = "Create an Alive avatar";
const BACK: &str = "Back";
const CANCEL_CREATION: &str = "Cancel creation";
const CANCEL_TITLE: &str = "Cancel this creation?";
const CANCEL_BODY: &str = "Its pictures and any moves made from them are deleted from this computer. Once a set of poses after the first was drawn, it still counts against this month.";
const KEEP_IT: &str = "Keep it";
const EXPIRED: &str = "This creation expired; start a new one.";
const START_NEW: &str = "Start a new one";
const REFERENCE_TITLE: &str = "Start from one picture";
const REFERENCE_DESCRIPTION: &str = "One picture of the whole body, facing you, on a transparent background. Videorc reads its colors, materials and proportions from it, and every pose is drawn from it.";
const REFERENCE_PERSONA: &str = "My avatar's picture";
const REFERENCE_UPLOAD: &str = "Upload";
const REFERENCE_LABEL: &str = "Picture";
const PERSONA_LINE: &str = "The idle picture from the current look.";
const CHOOSE_PICTURE: &str = "Choose a picture…";
const UPLOAD_TOO_LARGE: &str = "Choose a picture smaller than 8 MB.";
const UPLOAD_KIND: &str = "Choose a PNG or WebP with a transparent background.";
/// `BUDDY_LOOK_PICTURE_UNREADABLE`.
const UPLOAD_UNREADABLE: &str = "That picture could not be read. Try another one.";
const SEES_TITLE: &str = "What Videorc sees";
const SEES_DESCRIPTION: &str = "What Videorc read from your picture. Correct anything it got wrong: these words go with every pose it draws.";
const SEES_PILOT_DESCRIPTION: &str =
    "New first poses use these words. They're fixed once the poses look right.";
const OTHER_PICTURE: &str = "Use another picture";
const PALETTE_LABEL: &str = "Its colors are";
const MATERIALS_LABEL: &str = "It's made of";
const PROPORTIONS_LABEL: &str = "Its proportions";
const ONE_SIDE_LABEL: &str = "On one side only";
const ONE_SIDE_DESCRIPTION: &str = "Its own side, as it faces you: its left is on your right.";
const ITS_LEFT: &str = "Its left";
const ITS_RIGHT: &str = "Its right";
const ADD_FEATURE: &str = "Add a feature";
const PILOT_TITLE: &str = "First poses";
const PILOT_DESCRIPTION: &str = "Four poses before the rest: neutral, turned left, turned right and laughing. If these look right, every other pose follows them.";
const PILOT_OPAQUE: &str = "These poses came back without transparency. Draw them again.";
const POSES_TITLE: &str = "Poses";
const NO_TRANSPARENCY: &str = "No transparency; redo it";
const REDO: &str = "Redo";
const TRY_AGAIN: &str = "Try again";
const MOVES_TITLE: &str = "Moves";
const MOVES_DESCRIPTION: &str = "Put together on this computer from the poses: each one is cut out, stood on its feet and packed into the moves.";
const MOVES_STARTING: &str = "Starting…";
const MOVES_WAITING: &str = "The moves are made once every pose is drawn.";
const MOVES_READY: &str = "Every pose is drawn. Make the moves to check them.";
const CHECK_TITLE: &str = "Check";
const CHECK_DESCRIPTION: &str = "Check every row: each pose looks where its arrow points, and every pose looks like the same avatar. Redo a row that's wrong; it counts against this creation's redos.";
const LOOKS_RIGHT: &str = "Looks right";
const REDO_ROW: &str = "Redo row";
const REDOING: &str = "Redoing…";
const NAME_TITLE: &str = "Name it";
const BACK_TO_CHECK: &str = "Back to Check";
const NAME_LABEL: &str = "Name of the moves";
const NAME_NEEDED: &str = "The moves need a name.";

/// The creator, in place of Profile's sections.
pub(super) fn render_creator(
    screen: &mut AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    screen.ensure_creator_fields(window, cx);
    screen.load_creator_atlas(cx);
    screen.sync_creator_preview(cx);
    if let Some(creator) = screen.creator.as_mut() {
        sync_handle(
            &creator.cancel_handle,
            &mut creator.cancel_want_open,
            &mut creator.cancel_was_open,
            window,
            cx,
        );
        if creator.focus_root
            && let Some(focus) = creator.focus.clone()
        {
            creator.focus_root = false;
            focus.focus(window, cx);
        }
    }
    let screen: &AvatarScreen = screen;
    let Some(creator) = screen.creator.as_ref() else {
        return div().into_any_element();
    };
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let step = creator.step();
    let creation = creator.creation.as_ref();
    let (gate, can_start) = screen.creator_gate();
    let locked = gate.is_some();
    let working = creator.working();
    let disabled = locked || working;

    // --- The header: Back, the title, this month's creations, the steps.
    let back = entity.clone();
    let mut title_row = div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            Button::new("avatar-creator-back")
                .variant(ButtonVariant::Ghost)
                .label(BACK)
                .on_click(move |_, _, cx| back.update(cx, |screen, cx| screen.close_creator(cx))),
        )
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(20.))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(hsla(t.foreground))
                .child(TITLE),
        );
    if let Some(allowance) = gate::pet_allowance_line(screen.capabilities.as_ref()) {
        title_row = title_row.child(div().flex_1()).child(meta(allowance, t));
    }
    let header = div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .px(px(size::GUTTER))
        .py(px(12.))
        .border_b_1()
        .border_color(hsla(t.border))
        .child(title_row)
        .child(step_header(step, t));

    // --- The body.
    let mut body = div().flex().flex_col();
    // The month's allowance stops only a new creation; the lock everything.
    let shown_gate = gate.clone().or_else(|| {
        (creation.is_none() && !creator.loading && !can_start)
            .then(|| gate::alive_create_gate(&screen.gate_input()))
            .flatten()
    });
    if let Some(gate) = shown_gate {
        let (sign_in, consent) = (entity.clone(), entity.clone());
        body = body.child(
            div()
                .px(px(size::GUTTER))
                .pt(px(size::GUTTER))
                .child(gate::gate_alert(
                    "avatar-creator-gate",
                    &gate,
                    move |_, cx| sign_in.update(cx, |screen, cx| screen.sign_in(cx)),
                    move |_, cx| consent.update(cx, |screen, cx| screen.open_consent(cx)),
                )),
        );
    }
    // An expired creation still makes the moves and saves; only drawing is
    // over.
    let expired = creation.is_some_and(|creation| {
        creation.expired
            && (matches!(step, Step::Reference | Step::Pilot)
                || (step == Step::Build && view::next_sheet(creation).is_some()))
    });
    let fatal = creator
        .problem
        .as_ref()
        .filter(|(code, _)| view::needs_new_creation(code));
    if expired || fatal.is_some() {
        let start = entity.clone();
        body = body.child(
            div().px(px(size::GUTTER)).pt(px(size::GUTTER)).child(
                Alert::new("avatar-creator-expired")
                    .variant(AlertVariant::Warning)
                    .title(
                        fatal
                            .map(|(_, line)| line.clone())
                            .unwrap_or_else(|| EXPIRED.to_string()),
                    )
                    .action(
                        Button::new("avatar-creator-start-new")
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .label(START_NEW)
                            .disabled(disabled || !can_start)
                            .on_click(move |_, _, cx| {
                                start.update(cx, |screen, cx| screen.creator_start_over(cx))
                            }),
                    ),
            ),
        );
    } else if let Some((_, problem)) = creator.problem.as_ref()
        && step != Step::Build
    {
        body = body.child(
            div().px(px(size::GUTTER)).pt(px(size::GUTTER)).child(
                Alert::new("avatar-creator-problem")
                    .variant(AlertVariant::Destructive)
                    .title(problem.clone()),
            ),
        );
    }

    let show_notes = step == Step::Reference
        && creation.is_some_and(|creation| creation.notes.is_some())
        && !creator.choosing_picture;
    let content = if creator.loading {
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(size::GUTTER))
            .child(
                Skeleton::new("avatar-creator-loading-title")
                    .w(px(192.))
                    .h(px(24.)),
            )
            .child(
                Skeleton::new("avatar-creator-loading-body")
                    .w_full()
                    .max_w(px(448.))
                    .h(px(160.)),
            )
            .into_any_element()
    } else {
        match (step, creation) {
            (Step::Reference, _) if !show_notes => reference_step(screen, creator, disabled, t, cx),
            (Step::Reference, _) => notes_section(
                creator,
                SEES_DESCRIPTION,
                Some(other_picture_button(disabled, cx)),
                disabled,
                t,
                cx,
            ),
            (Step::Pilot, Some(creation)) => pilot_step(screen, creator, creation, disabled, t, cx),
            (Step::Build, Some(creation)) => build_step(creator, creation, locked, t, cx),
            (Step::Review, Some(creation)) => review_step(creator, creation, disabled, t, cx),
            (Step::Save, Some(_)) => save_step(screen, creator, disabled, t, cx),
            _ => div().into_any_element(),
        }
    };
    body = body.child(content);

    // --- The footer: Cancel creation, and the step's primary action.
    let mut footer = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(size::GUTTER))
        .py(px(12.))
        .border_t_1()
        .border_color(hsla(t.border));
    if creation.is_some() {
        let cancel = entity.clone();
        footer = footer.child(
            Button::new("avatar-creator-cancel")
                .variant(ButtonVariant::Ghost)
                .label(CANCEL_CREATION)
                .disabled(matches!(creator.pending, Some(Job::Cancel | Job::Save)))
                .on_click(move |_, _, cx| {
                    cancel.update(cx, |screen, cx| screen.creator_ask_cancel(cx))
                }),
        );
    }
    footer = footer.child(div().flex_1());
    if let Some(primary) = screen.creator_primary(cx) {
        let run = entity.clone();
        footer = footer.child(
            Button::new(primary.id)
                .label(primary.label)
                .disabled(primary.disabled)
                .child(ShortcutKeys::keystrokes(PRIMARY_KEYS))
                .on_click(move |_, _, cx| {
                    run.update(cx, |screen, cx| screen.creator_run_primary(cx))
                }),
        );
    }

    // ⌘↵ continues from anywhere inside the creator itself (G-19): a
    // confirm or a menu over it keeps its own keys.
    let keys = entity.clone();
    let mut root = div()
        .id("avatar-creator")
        .flex()
        .flex_col()
        .on_key_down(move |event: &KeyDownEvent, _, cx| {
            let stroke = &event.keystroke;
            if stroke.key == "enter" && (stroke.modifiers.platform || stroke.modifiers.control) {
                cx.stop_propagation();
                keys.update(cx, |screen, cx| screen.creator_run_primary(cx));
            }
        })
        .child(header)
        .child(body)
        .child(footer)
        .child(cancel_dialog(creator, cx));
    if let Some(focus) = creator.focus.as_ref() {
        root = root.track_focus(focus);
    }
    root.into_any_element()
}

fn meta(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}

fn error_line(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.destructive))
        .child(line.into())
}

fn field_label(label: &'static str, t: &Theme) -> gpui::Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(hsla(t.foreground))
        .child(label)
}

/// The five steps, the current one named, the done ones checked.
fn step_header(current: Step, t: &Theme) -> impl IntoElement {
    let index = view::STEPS
        .iter()
        .position(|(step, _)| *step == current)
        .unwrap_or(0);
    let mut list = div()
        .id("avatar-creator-steps")
        .aria_label("Steps")
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(12.));
    for (position, (_, label)) in view::STEPS.iter().enumerate() {
        let ink = if position == index {
            t.foreground
        } else if position < index {
            t.muted_foreground
        } else {
            t.subtle
        };
        let mark = if position < index {
            icon(IconName::Check, 12., hsla(ink)).into_any_element()
        } else {
            div().child((position + 1).to_string()).into_any_element()
        };
        list = list.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .type_scale(text::META)
                .text_color(hsla(ink))
                .when(position == index, |step| {
                    step.font_weight(gpui::FontWeight::MEDIUM)
                })
                .child(mark)
                .child(*label),
        );
    }
    list
}

fn other_picture_button(disabled: bool, cx: &mut Context<AvatarScreen>) -> Button {
    let entity = cx.entity();
    Button::new("avatar-creator-other-picture")
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::Xs)
        .label(OTHER_PICTURE)
        .disabled(disabled)
        .on_click(move |_, _, cx| {
            entity.update(cx, |screen, cx| {
                if let Some(creator) = screen.creator.as_mut() {
                    creator.choosing_picture = true;
                }
                cx.notify();
            })
        })
}

// --- Picture -------------------------------------------------------------------

fn reference_step(
    screen: &AvatarScreen,
    creator: &Creator,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let preview: Option<ImageSource> = match creator.reference {
        Reference::Upload => creator
            .upload
            .as_ref()
            .map(|upload| upload.path.clone().into()),
        Reference::Persona => match screen.persona_picture() {
            Some(path) => Some(path.into()),
            None => super::pictures::default_idle().map(Into::into),
        },
    };
    let frame = div()
        .size(px(REFERENCE_PX))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.muted));
    let frame = match preview {
        Some(picture) => frame.child(
            div()
                .id("avatar-creator-reference-preview")
                .role(Role::Image)
                .aria_label("Reference")
                .size_full()
                .child(img(picture).size_full().object_fit(ObjectFit::Contain)),
        ),
        None => frame.child(icon(IconName::ImageSquare, 24., hsla(t.subtle))),
    };

    let pick = entity.clone();
    let source = SegmentedControl::new("avatar-creator-reference")
        .small(true)
        .accessibility_label(REFERENCE_LABEL)
        .disabled(disabled)
        .value(Some(match creator.reference {
            Reference::Persona => "persona",
            Reference::Upload => "upload",
        }))
        .option(Segment::new("persona", REFERENCE_PERSONA))
        .option(Segment::new("upload", REFERENCE_UPLOAD))
        .on_change(move |value: SharedString, _, cx| {
            let reference = if value.as_ref() == "upload" {
                Reference::Upload
            } else {
                Reference::Persona
            };
            pick.update(cx, |screen, cx| screen.creator_set_reference(reference, cx));
        });

    let mut column = div()
        .flex()
        .flex_1()
        .min_w(px(240.))
        .flex_col()
        .gap(px(12.))
        .child(div().flex().child(source));
    match creator.reference {
        Reference::Persona => {
            let new_avatar = entity.clone();
            column = column.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(12.))
                            .child(meta(PERSONA_LINE, t))
                            .child(
                                Button::new("avatar-creator-new-avatar")
                                    .variant(ButtonVariant::Ghost)
                                    .size(ButtonSize::Xs)
                                    .label(words::LIBRARY_NEW_BUDDY)
                                    .on_click(move |_, _, cx| {
                                        new_avatar
                                            .update(cx, |screen, cx| screen.creator_new_avatar(cx))
                                    }),
                            ),
                    )
                    .children(
                        creator
                            .look_notes
                            .as_ref()
                            .map(|notes| meta(format!("Your look: “{notes}”"), t)),
                    ),
            );
        }
        Reference::Upload => {
            let choose = entity.clone();
            column = column.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        Button::new("avatar-creator-choose-picture")
                            .variant(ButtonVariant::Outline)
                            .label(CHOOSE_PICTURE)
                            .disabled(disabled)
                            .on_click(move |_, _, cx| {
                                choose.update(cx, |screen, cx| screen.creator_choose_upload(cx))
                            }),
                    )
                    .children(
                        creator
                            .upload
                            .as_ref()
                            .map(|upload| meta(upload.name.clone(), t).truncate()),
                    ),
            );
        }
    }
    let error = creator
        .upload_error
        .map(str::to_string)
        .or_else(|| creator.identity_error.clone());
    column = column.children(error.map(|error| error_line(error, t)));

    PanelSection::new("avatar-creator-reference-section")
        .title(REFERENCE_TITLE)
        .description(REFERENCE_DESCRIPTION)
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_start()
                .gap(px(16.))
                .child(frame)
                .child(column),
        )
        .into_any_element()
}

/// "What Videorc sees": the notes as sentences, the one-sided features with
/// their side, and the one thing to fix.
fn notes_editor(
    creator: &Creator,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let Some(fields) = creator.notes.as_ref() else {
        return div().into_any_element();
    };
    let error = creator
        .notes_draft(cx)
        .and_then(|draft| view::notes_from_draft(&draft).err());
    let field = |label: &'static str, control: AnyElement| {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(field_label(label, t))
            .child(control)
    };

    let mut features = div().flex().flex_col().gap(px(8.));
    for (index, feature) in fields.features.iter().enumerate() {
        let number = index + 1;
        let (side, remove) = (cx.entity(), cx.entity());
        let id = feature.id;
        features = features.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div().flex_1().min_w(px(0.)).child(
                        Input::new(
                            SharedString::from(format!("avatar-creator-feature-{id}")),
                            &feature.feature,
                        )
                        .accessibility_label(format!("Feature {number}"))
                        .disabled(disabled),
                    ),
                )
                .child(
                    Select::new(SharedString::from(format!(
                        "avatar-creator-feature-side-{id}"
                    )))
                    .option(Side::Left.value(), ITS_LEFT)
                    .option(Side::Right.value(), ITS_RIGHT)
                    .value(Some(feature.side.value().into()))
                    .width(112.)
                    .accessibility_label(format!("Side of feature {number}"))
                    .disabled(disabled)
                    .on_change(move |value, _, cx| {
                        side.update(cx, |screen, cx| {
                            screen.creator_set_side(id, Side::from_value(&value), cx)
                        })
                    }),
                )
                .child(
                    Button::new(SharedString::from(format!(
                        "avatar-creator-feature-remove-{id}"
                    )))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Icon)
                    .accessibility_label(format!("Remove feature {number}"))
                    .disabled(disabled)
                    .child(icon(IconName::X, 16., hsla(t.muted_foreground)))
                    .on_click(move |_, _, cx| {
                        remove.update(cx, |screen, cx| screen.creator_remove_feature(id, cx))
                    }),
                ),
        );
    }
    let add = cx.entity();
    features = features.child(
        div().flex().child(
            Button::new("avatar-creator-add-feature")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(ADD_FEATURE)
                .disabled(disabled)
                .on_click(move |_, window, cx| {
                    add.update(cx, |screen, cx| screen.creator_add_feature(window, cx))
                }),
        ),
    );

    GroupedList::new()
        .item(
            div().p(px(12.)).child(field(
                PALETTE_LABEL,
                Input::new("avatar-creator-palette", &fields.palette)
                    .accessibility_label(PALETTE_LABEL)
                    .disabled(disabled)
                    .into_any_element(),
            )),
        )
        .item(
            div().p(px(12.)).child(field(
                MATERIALS_LABEL,
                Input::new("avatar-creator-materials", &fields.materials)
                    .accessibility_label(MATERIALS_LABEL)
                    .disabled(disabled)
                    .into_any_element(),
            )),
        )
        .item(
            div().p(px(12.)).child(field(
                PROPORTIONS_LABEL,
                Textarea::new("avatar-creator-proportions", &fields.proportions)
                    .accessibility_label(PROPORTIONS_LABEL)
                    .disabled(disabled)
                    .into_any_element(),
            )),
        )
        .item(
            div()
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(field_label(ONE_SIDE_LABEL, t))
                .child(meta(ONE_SIDE_DESCRIPTION, t))
                .child(features)
                .children(error.map(|error| error_line(error, t))),
        )
        .into_any_element()
}

fn notes_section(
    creator: &Creator,
    description: &'static str,
    action: Option<Button>,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let mut section = PanelSection::new(SharedString::from(format!(
        "avatar-creator-notes-{}",
        if action.is_some() { "read" } else { "pilot" }
    )))
    .title(SEES_TITLE)
    .description(description);
    if let Some(action) = action {
        section = section.action(action);
    }
    section
        .child(notes_editor(creator, disabled, t, cx))
        .into_any_element()
}

// --- First poses -----------------------------------------------------------------

fn pilot_step(
    screen: &AvatarScreen,
    creator: &Creator,
    creation: &Creation,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let left = view::pilots_left(creation);
    let making = creation
        .running
        .as_ref()
        .is_some_and(|running| running.job == "sheet" && running.sheet.as_deref() == Some("pilot"));
    let notes_ok = creator
        .notes_draft(cx)
        .is_some_and(|draft| view::notes_from_draft(&draft).is_ok());
    let pilot = creation.pilot.as_ref();
    let file = pilot.and_then(|pilot| {
        let persona = screen.persona.as_ref()?;
        files::creation_file(
            &screen.user_data_dir,
            &persona.id,
            &creation.build_id,
            &pilot.file,
        )
    });
    let sheet = match (making, file) {
        (false, Some(file)) => div()
            .id("avatar-creator-pilot")
            .role(Role::Image)
            .aria_label(format!("First poses: {}", view::PILOT_POSES.join(", ")))
            .size(px(PILOT_PX))
            .max_w_full()
            .overflow_hidden()
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(t.muted))
            .child(img(file).size_full().object_fit(ObjectFit::Contain))
            .into_any_element(),
        _ => Skeleton::new("avatar-creator-pilot-loading")
            .size(px(PILOT_PX))
            .max_w_full()
            .rounded(px(radius::ROW))
            .into_any_element(),
    };
    let entity = cx.entity();
    let redo = Button::new("avatar-creator-redo-pilot")
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::Xs)
        .label(format!("Draw them again ({left} left)"))
        .disabled(disabled || left == 0 || !notes_ok || creation.expired)
        .on_click(move |_, _, cx| entity.update(cx, |screen, cx| screen.creator_redo_pilot(cx)));
    let opaque = pilot.is_some_and(|pilot| pilot.opaque);
    div()
        .flex()
        .flex_col()
        .child(
            PanelSection::new("avatar-creator-pilot-section")
                .title(PILOT_TITLE)
                .description(PILOT_DESCRIPTION)
                .action(redo)
                .child(sheet)
                .when(opaque, |section| section.child(meta(PILOT_OPAQUE, t))),
        )
        .child(notes_section(
            creator,
            SEES_PILOT_DESCRIPTION,
            None,
            disabled,
            t,
            cx,
        ))
        .into_any_element()
}

// --- All poses ----------------------------------------------------------------------

fn build_step(
    creator: &Creator,
    creation: &Creation,
    locked: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let building = creation
        .running
        .as_ref()
        .is_some_and(|running| running.job == "build")
        || creator.pending == Some(Job::Build);
    let progress = creator.build.as_ref().filter(|progress| !progress.ended());
    let failure = creation
        .build
        .as_ref()
        .filter(|build| build.state == "failed" && !building)
        .and_then(|build| build.error.as_ref());
    let failed_sheet = failure
        .and_then(|failure| failure.sheet.as_deref())
        .and_then(|sheet| ATLAS_SHEETS.iter().find(|candidate| candidate.key == sheet));
    let working = creator.working();

    let mut rows = GroupedList::new();
    for sheet in ATLAS_SHEETS {
        let row = view::sheet_phase(creation, sheet.key, &creator.sheet_errors);
        let mark = match row.phase {
            SheetPhase::Making => Spinner::new(SharedString::from(format!(
                "avatar-creator-sheet-making-{}",
                sheet.key
            )))
            .size(14.)
            .into_any_element(),
            SheetPhase::Done => {
                icon(IconName::Check, 14., hsla(t.muted_foreground)).into_any_element()
            }
            SheetPhase::Failed => {
                icon(IconName::WarningCircle, 14., hsla(t.destructive)).into_any_element()
            }
            SheetPhase::Waiting => div()
                .size(px(6.))
                .rounded_full()
                .bg(hsla(t.subtle))
                .into_any_element(),
        };
        let mut list_row = ListRow::new(
            SharedString::from(format!("avatar-creator-sheet-{}", sheet.key)),
            view::sheet_label(sheet.key).to_string(),
        )
        .icon(mark)
        .meta(view::sheet_meta(&row));
        if let Some(error) = row.error.clone() {
            list_row = list_row.context(error);
        } else if row.opaque {
            list_row = list_row.context(NO_TRANSPARENCY);
        }
        if row.phase == SheetPhase::Failed || (row.phase == SheetPhase::Done && row.opaque) {
            let entity = cx.entity();
            let key = sheet.key;
            let redo = row.version.is_some();
            list_row = list_row.child(
                Button::new(SharedString::from(format!(
                    "avatar-creator-sheet-redo-{}",
                    sheet.key
                )))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(if redo { REDO } else { TRY_AGAIN })
                .disabled(locked || working || creation.expired)
                .on_click(move |_, _, cx| {
                    entity.update(cx, |screen, cx| {
                        if redo {
                            screen.creator_redo_sheet(key, cx)
                        } else {
                            screen.creator_make_sheets(cx)
                        }
                    })
                }),
            );
        }
        rows = rows.row(list_row);
    }

    let moves: AnyElement = if building {
        let (done, total) =
            progress.map_or((0, 1), |progress| (progress.done, progress.total.max(1)));
        let fraction = (done as f32 / total as f32).clamp(0., 1.);
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .id("avatar-creator-build-progress")
                    .role(Role::ProgressIndicator)
                    .aria_label("Making the moves")
                    .w_full()
                    .max_w(px(448.))
                    .h(px(6.))
                    .overflow_hidden()
                    .rounded_full()
                    .bg(hsla(with_alpha(t.primary, 0.2)))
                    .child(div().h_full().w(relative(fraction)).bg(hsla(t.primary))),
            )
            .child(meta(
                progress.map_or_else(|| MOVES_STARTING.to_string(), view::build_progress_line),
                t,
            ))
            .into_any_element()
    } else if let Some(failure) = failure {
        let mut alert = Alert::new("avatar-creator-build-failure")
            .variant(AlertVariant::Destructive)
            .title(failure.message.clone());
        if let Some(sheet) = failed_sheet {
            let entity = cx.entity();
            let key = sheet.key;
            alert = alert.action(
                Button::new("avatar-creator-build-failure-redo")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(format!("Redo {}", view::sheet_label(sheet.key)))
                    .disabled(
                        locked || working || creation.expired || creation.redos_remaining == 0,
                    )
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |screen, cx| screen.creator_redo_sheet(key, cx))
                    }),
            );
        }
        alert.into_any_element()
    } else {
        meta(
            if view::next_sheet(creation).is_some() {
                MOVES_WAITING
            } else {
                MOVES_READY
            },
            t,
        )
        .into_any_element()
    };
    let problem = creator
        .problem
        .as_ref()
        .filter(|(_, line)| {
            failure.is_none() && !creator.sheet_errors.values().any(|error| error == line)
        })
        .map(|(_, line)| {
            Alert::new("avatar-creator-build-problem")
                .variant(AlertVariant::Destructive)
                .title(line.clone())
        });

    div()
        .flex()
        .flex_col()
        .child(
            PanelSection::new("avatar-creator-poses")
                .title(POSES_TITLE)
                .description(SharedString::from(view::poses_description(creation)))
                .child(rows),
        )
        .child(
            PanelSection::new("avatar-creator-moves")
                .title(MOVES_TITLE)
                .description(MOVES_DESCRIPTION)
                .child(moves)
                .children(problem),
        )
        .into_any_element()
}

// --- Check -----------------------------------------------------------------------

/// One atlas cell, cut out of the built moves (no decode per cell).
fn atlas_cell(
    atlas: Option<&Atlas>,
    frame: &str,
    px_size: f32,
    label: String,
    t: &Theme,
) -> AnyElement {
    let id = SharedString::from(format!("avatar-creator-cell-{frame}"));
    let Some((atlas, rect)) = atlas.and_then(|atlas| Some((atlas, atlas.frame(frame)?))) else {
        return Skeleton::new(id)
            .size(px(px_size))
            .rounded(px(radius::CHIP))
            .into_any_element();
    };
    let (scale_x, scale_y) = (px_size / rect.w, px_size / rect.h);
    div()
        .id(id)
        .role(Role::Image)
        .aria_label(label)
        .relative()
        .size(px(px_size))
        .flex_none()
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(t.muted))
        .child(
            img(atlas.image.clone())
                .absolute()
                .left(px(-rect.x * scale_x))
                .top(px(-rect.y * scale_y))
                .w(px(atlas.width * scale_x))
                .h(px(atlas.height * scale_y))
                .object_fit(ObjectFit::Fill),
        )
        .into_any_element()
}

fn review_row(
    creator: &Creator,
    creation: &Creation,
    row: &ReviewRow,
    redoing: Option<&str>,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> impl IntoElement {
    let marks = creator.marks();
    let marked = view::row_marked(&marks, creation, row.key);
    let this_redoing = redoing == Some(row.key);
    let cell_px = if row.gaze_row.is_some() {
        GAZE_CELL_PX
    } else {
        OTHER_CELL_PX
    };
    let mut cells = div().flex().gap(px(4.));
    for (col, frame) in row.cells.iter().enumerate() {
        let arrow = row.gaze_row.map(|gaze_row| view::gaze_arrow(col, gaze_row));
        let caption = row
            .captions
            .as_ref()
            .and_then(|captions| captions.get(col))
            .cloned();
        let label = arrow
            .as_ref()
            .map(|arrow| arrow.label.clone())
            .or_else(|| caption.clone())
            .unwrap_or_else(|| frame.clone());
        let atlas = (!this_redoing).then_some(creator.atlas.as_ref()).flatten();
        let mut cell = div()
            .relative()
            .child(atlas_cell(atlas, frame, cell_px, label, t));
        if let Some(arrow) = arrow {
            // The centre looks at you; every other cell points where it
            // looks (Electron's arrow points right at 0°, this one left).
            let glyph = if arrow.center {
                icon(IconName::Crosshair, 12., hsla(t.muted_foreground))
            } else {
                icon(IconName::ArrowLeft, 12., hsla(t.muted_foreground)).with_transformation(
                    Transformation::rotate(radians((arrow.degrees + 180.).to_radians())),
                )
            };
            cell = cell.child(
                div()
                    .absolute()
                    .top(px(4.))
                    .right(px(4.))
                    .size(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(hsla(with_alpha(t.background, 0.7)))
                    .child(glyph),
            );
        }
        cells = cells.child(
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .child(cell)
                .children(caption.map(|caption| {
                    div()
                        .text_size(px(11.))
                        .line_height(px(16.))
                        .text_color(hsla(t.subtle))
                        .child(caption)
                })),
        );
    }
    let key = row.key;
    let (mark, redo) = (cx.entity(), cx.entity());
    let redo_label = if this_redoing { REDOING } else { REDO_ROW };
    let redo_button = Button::new(SharedString::from(format!("avatar-creator-redo-{key}")))
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::Xs)
        .disabled(disabled || this_redoing || creation.redos_remaining == 0 || creation.expired)
        .on_click(move |_, _, cx| redo.update(cx, |screen, cx| screen.creator_redo_row(key, cx)));
    let redo_button = if this_redoing {
        redo_button
            .child(
                Spinner::new(SharedString::from(format!("avatar-creator-redoing-{key}"))).size(12.),
            )
            .child(redo_label)
    } else {
        redo_button.label(redo_label)
    };
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(12.))
        .child(cells)
        .child(
            div()
                .flex()
                .flex_col()
                .min_w(px(144.))
                .gap(px(4.))
                .child(
                    meta(view::sheet_label(key).to_string(), t)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground)),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            Button::new(SharedString::from(format!("avatar-creator-mark-{key}")))
                                .variant(if marked {
                                    ButtonVariant::Secondary
                                } else {
                                    ButtonVariant::Outline
                                })
                                .size(ButtonSize::Xs)
                                .disabled(disabled || this_redoing || creator.atlas.is_none())
                                .child(icon(IconName::Check, 12., hsla(t.foreground)))
                                .child(LOOKS_RIGHT)
                                .on_click(move |_, _, cx| {
                                    mark.update(cx, |screen, cx| {
                                        screen.creator_mark(key, !marked, cx)
                                    })
                                }),
                        )
                        .child(redo_button),
                ),
        )
}

fn review_step(
    creator: &Creator,
    creation: &Creation,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let working = creator.working();
    let rebuilding = creator.redo_key.is_some() && creation.step == "build";
    let redoing = creator
        .redo_key
        .clone()
        .filter(|_| working || rebuilding)
        .or_else(|| {
            creation
                .running
                .as_ref()
                .filter(|running| running.job == "sheet")
                .and_then(|running| running.sheet.clone())
        });
    let marks = creator.marks();
    let mut rows = div().flex().flex_1().min_w(px(0.)).flex_col().gap(px(16.));
    for row in view::review_rows() {
        rows = rows.child(review_row(
            creator,
            creation,
            &row,
            redoing.as_deref(),
            disabled || redoing.is_some(),
            t,
            cx,
        ));
    }
    // The living preview plays the built moves (click it for the next
    // reaction, as on stream); one it can't load leaves the neutral cell.
    let preview = creator
        .preview
        .clone()
        .filter(|preview| preview.read(cx).error().is_none());
    let still = match preview {
        Some(preview) => Some(preview.into_any_element()),
        None => creator.atlas.as_ref().map(|atlas| {
            atlas_cell(
                Some(atlas),
                &atlas.neutral,
                CHECK_PREVIEW_PX,
                TITLE.to_string(),
                t,
            )
        }),
    };
    let aside = div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.))
        .children(still)
        .child(meta(
            view::marked_line(view::marked_count(&marks, creation)),
            t,
        ));
    PanelSection::new("avatar-creator-check")
        .title(CHECK_TITLE)
        .description(CHECK_DESCRIPTION)
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_start()
                .gap(px(24.))
                .child(rows)
                .child(aside),
        )
        .into_any_element()
}

// --- Save --------------------------------------------------------------------------

fn save_step(
    screen: &AvatarScreen,
    creator: &Creator,
    disabled: bool,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let Some(name) = creator.name.as_ref() else {
        return div().into_any_element();
    };
    let invalid = view::name_to_save(&name.read(cx).value()).is_none();
    let persona = screen.persona.as_ref();
    let description = view::save_description(
        persona.map_or("", |persona| persona.name.as_str()),
        persona.and_then(|persona| persona.library_avatar_id.as_deref()),
        screen.library_alive(),
    );
    let back = cx.entity();
    PanelSection::new("avatar-creator-save")
        .title(NAME_TITLE)
        .description(SharedString::from(description))
        .action(
            Button::new("avatar-creator-back-to-check")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(BACK_TO_CHECK)
                .disabled(disabled)
                .on_click(move |_, _, cx| {
                    back.update(cx, |screen, cx| screen.creator_set_naming(false, cx))
                }),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div().w(px(288.)).max_w_full().child(
                        Input::new("avatar-creator-name", name)
                            .accessibility_label(NAME_LABEL)
                            .invalid(invalid)
                            .disabled(disabled),
                    ),
                )
                .when(invalid, |column| column.child(error_line(NAME_NEEDED, t))),
        )
        .into_any_element()
}

/// "Cancel this creation?", with "Keep it".
fn cancel_dialog(creator: &Creator, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let (keep, cancel) = (cx.entity(), cx.entity());
    Dialog::new(
        "avatar-creator-cancel-confirm",
        &creator.cancel_handle,
        CANCEL_TITLE,
    )
    .description(CANCEL_BODY)
    .close_button(false)
    .footer(
        Button::new("avatar-creator-cancel-keep")
            .variant(ButtonVariant::Ghost)
            .label(KEEP_IT)
            .on_click(move |_, _, cx| keep.update(cx, |screen, cx| screen.creator_keep(cx))),
    )
    .footer(
        Button::new("avatar-creator-cancel-confirm-action")
            .variant(ButtonVariant::Destructive)
            .label(CANCEL_CREATION)
            .on_click(move |_, _, cx| cancel.update(cx, |screen, cx| screen.creator_cancel(cx))),
    )
    .into_any_element()
}
