//! Sidekick → Community: people list, person card, Same person, Mark as bot,
//! Forget — `cohost.community.*` plus `videorc_app_core::buddy::community`.
//! Words and behaviour from Electron's `components/community/*.tsx`.

use std::time::Duration;

use chrono::Utc;
use gpui::{AnyElement, ClipboardItem, Context, Entity, Hsla, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use serde::Deserialize;
use serde_json::{Value, json};
use videorc_app_core::buddy::community::{
    self, BUDDY_REMEMBERS_LOCK_REASON, COMMUNITY_DISCLOSURE_LINE, CommunitySummary,
    REMEMBER_OFFER_DESCRIPTION, REMEMBER_OFFER_TITLE, X_SELF_LINK_REASON, YOUTUBE_RETENTION_LINE,
    account_label, forget_copy, forget_memory_label, has_x, linked_line, memory_forget_copy,
    note_to_save, nothing_remembered_line, people_empty_copy, person_load_failed_line,
    person_row_context, person_stats_line, regular_after_label, remember_offer_shows,
    retention_line, support_line,
};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::client::RpcError;
use videorc_app_core::resources::capability::{IssueOptions, ResourceKind};
use videorc_app_core::resources::issue_capability;
use videorc_app_core::stream_manager::buddy::CohostSettingsView;
use videorc_app_core::user_error::{
    Failure, UserError, UserErrorContext, UserErrorKind, user_error_message,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::Select;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::spinner::Spinner;
use videorc_kit::switch::Switch;
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::toast::{ToastData, ToastKind};
use videorc_kit::tokens::{radius, size, text};
use videorc_kit::tooltip::tooltip;
use videorc_protocol::community::{CommunitySettings, REGULAR_STREAMS_MAX, REGULAR_STREAMS_MIN};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const YOUR_COMMUNITY: &str = "Your community";
const PEOPLE: &str = "People";
const SEARCH_PEOPLE: &str = "Search people";
const SORT_PEOPLE: &str = "Sort people";
const SHOW: &str = "Show";
const LINKS_NEED_YOU: &str = "Links that need you";
const SAME_PERSON: &str = "Same person";
const SAME_PERSON_AS: &str = "Same person as…";
const NOT_THE_SAME: &str = "Not the same";
const MARK_AS_BOT: &str = "Mark as bot";
const NOT_A_BOT: &str = "Not a bot";
const REGULAR: &str = "Regular";
const BOT: &str = "Bot";
const WAVE: &str = "Wave";
const WAVED: &str = "Waved";
const YOUR_NOTE: &str = "Your note";
const NOTE_PLACEHOLDER: &str = "Only you see this. Sidekick never changes it.";
const TRY_AGAIN: &str = "Try again";
const TURN_ON: &str = "Turn on";
const NOT_NOW: &str = "Not now";
const COMMUNITY_SETTINGS: &str = "Community settings";
const COMMUNITY_SETTINGS_DESCRIPTION: &str =
    "Free, and kept on this computer. Viewers can type !forgetme in chat anytime.";
const REMEMBER_COMMUNITY: &str = "Remember my community";
const REMEMBER_COMMUNITY_DESCRIPTION: &str =
    "Count who comes back, so chat shows regulars and Sidekick can welcome them.";
const WELCOME_REGULARS: &str = "Welcome regulars on stream";
const WELCOME_REGULARS_DESCRIPTION: &str =
    "Sidekick waves and says hi to regulars in its bubble. Nothing goes to chat.";
const MILESTONE_CARDS: &str = "Show milestone cards automatically";
const MILESTONE_CARDS_DESCRIPTION: &str =
    "Put a milestone card on stream by itself. Off: you choose on Sidekick's card.";
const REGULAR_AFTER: &str = "Regular after";
const REGULAR_AFTER_DESCRIPTION: &str =
    "Streams in the last 90 days before someone counts as a regular.";
const OFF_REASON: &str = "Turn on Remember my community first.";
const PREMIUM: &str = "Premium";
const SIDEKICK_REMEMBERS: &str = "Sidekick remembers";
const SIDEKICK_REMEMBERS_DESCRIPTION: &str = "After each stream, Sidekick keeps a few short facts people told chat about themselves. Never from YouTube.";
const COMMUNITY_SYNC: &str = "Community sync";
const COMMUNITY_SYNC_REASON: &str = "Community sync is part of Premium.";
const PREMIUM_DESCRIPTION: &str = "Sidekick remembers what regulars say about themselves, and your community follows you to your other computers, encrypted so Videorc can't read it.";
const YOUR_DATA: &str = "Your data";
const YOUR_DATA_DESCRIPTION: &str =
    "Your community's file, and the line that tells viewers what Videorc keeps.";
const DISCLOSURE_LEAD: &str = "For your channel description or a panel:";
const COPY: &str = "Copy";
const COPIED: &str = "Copied";
const FORGET_EVERYONE: &str = "Forget everyone…";
const FORGET_EVERYONE_TITLE: &str = "Forget everyone?";
const CANCEL: &str = "Cancel";

/// `SORT_ITEMS`: the "Sort people" choices, value and words.
const SORTS: [(&str, &str); 3] = [
    ("streams", "Streams"),
    ("recent", "Last chat"),
    ("name", "Name"),
];
/// `FILTERS`: the "Show" choices, as `cohost.community.list` takes them.
const FILTERS: [(&str, &str); 4] = [
    ("regulars", "Regulars"),
    ("everyone", "Everyone"),
    ("linked", "Linked"),
    ("bots", "Bots"),
];

/// `COPIED_FEEDBACK_MS`: how long Copy says "Copied".
const COPIED_FOR: Duration = Duration::from_millis(1_500);
/// How long Wave says "Waved" (person-card-body.tsx).
const WAVED_FOR: Duration = Duration::from_millis(3_000);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub streams: u64,
    #[serde(default)]
    pub regular: bool,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PersonSupport {
    pub bits: u64,
    pub kicks: u64,
    pub gifted_subs: u64,
    pub sub_months: u64,
    pub tips: std::collections::BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PersonAccount {
    pub account_key: String,
    pub platform: String,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub handle: Option<String>,
}

/// `CommunityMemory`: one fact Sidekick remembers (Premium, D10).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonMemory {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSuggestion {
    pub account_a: PersonAccount,
    pub account_b: PersonAccount,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDetail {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub streams: u64,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub in_a_row: u64,
    #[serde(default)]
    pub regular: bool,
    #[serde(default)]
    pub first_seen_at: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub support: Option<community::CommunitySupport>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub accounts: Vec<PersonAccount>,
    #[serde(default)]
    pub memories: Vec<PersonMemory>,
    #[serde(default)]
    pub suggestions: Vec<AccountSuggestion>,
    #[serde(default)]
    pub youtube: bool,
}

pub type LinkSuggestion = AccountSuggestion;

pub struct CommunityState {
    pub summary: Option<CommunitySummary>,
    pub people: Vec<PersonRow>,
    pub suggestions: Vec<LinkSuggestion>,
    pub selected: Option<PersonDetail>,
    pub search: Entity<InputState>,
    pub link_search: Entity<InputState>,
    pub link_hits: Vec<PersonRow>,
    pub linking: bool,
    pub forget: DialogHandle,
    pub forget_everyone: DialogHandle,
    pub forget_id: Option<String>,
    pub forget_name: String,
    pub loaded: bool,
    /// "Show": the `filter` `cohost.community.list` takes.
    pub filter: &'static str,
    /// "Sort people": the `sort` `cohost.community.list` takes.
    pub sort: &'static str,
    /// The person card's dialog, titled with the name.
    pub person: DialogHandle,
    /// The person the card is for (id and name), while it loads too.
    pub opening: Option<(String, String)>,
    pub load_failed: bool,
    /// A card action that failed, as the card says it.
    pub card_error: Option<UserError>,
    pub busy: bool,
    pub waved: bool,
    wave_epoch: u64,
    /// "Your note", and the note last saved.
    pub note: Entity<TextareaState>,
    pub note_saved: String,
    /// Forget one memory: its confirm and the memory it asks about.
    pub memory_forget: DialogHandle,
    pub memory_target: Option<PersonMemory>,
    pub copied: bool,
    copied_epoch: u64,
    /// Export… or Import… while its file is being written or read.
    pub file_busy: Option<CommunityFile>,
}

/// Export… and Import… (D12): a picked folder or file goes to the backend
/// as a single-use capability, never as a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommunityFile {
    Export,
    Import,
}

impl CommunityState {
    pub fn new(window: &mut Window, cx: &mut Context<SidekickScreen>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_PEOPLE));
        let link_search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_PEOPLE));
        let note = cx.new(|cx| TextareaState::new(window, cx).placeholder(NOTE_PLACEHOLDER));
        cx.observe(&search, |screen, _, cx| {
            screen.refresh_community_list(cx);
        })
        .detach();
        cx.observe(&link_search, |screen, _, cx| {
            screen.refresh_community_link_hits(cx);
        })
        .detach();
        // NoteField: saved on Cmd/Ctrl+Enter (a secondary Enter) and on blur.
        cx.subscribe_in(
            &note,
            window,
            |screen, _, event: &InputEvent, window, cx| {
                if matches!(
                    event,
                    InputEvent::PressEnter {
                        secondary: true,
                        ..
                    } | InputEvent::Blur
                ) {
                    screen.save_community_note(window, cx);
                }
            },
        )
        .detach();
        Self {
            summary: None,
            people: Vec::new(),
            suggestions: Vec::new(),
            selected: None,
            search,
            link_search,
            link_hits: Vec::new(),
            linking: false,
            forget: DialogHandle::new(false),
            forget_everyone: DialogHandle::new(false),
            forget_id: None,
            forget_name: String::new(),
            loaded: false,
            filter: "regulars",
            sort: "streams",
            person: DialogHandle::new(false),
            opening: None,
            load_failed: false,
            card_error: None,
            busy: false,
            waved: false,
            wave_epoch: 0,
            note,
            note_saved: String::new(),
            memory_forget: DialogHandle::new(false),
            memory_target: None,
            copied: false,
            copied_epoch: 0,
            file_busy: None,
        }
    }
}

/// `cohostSettings.community`, every field defaulted as Rust's wire shape.
pub(super) fn community_settings(settings: Option<&CohostSettingsView>) -> CommunitySettings {
    settings
        .and_then(|settings| settings.raw.get("community"))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

/// What a card action does once the backend said yes.
pub(super) enum CardThen {
    /// The answer is the person: show it.
    Person,
    /// Read the person again.
    Reload,
    /// Wave says "Waved" for a moment.
    Waved,
}

/// One card action: the request, and the verb and object its failure names.
pub(super) struct CardCall {
    pub method: &'static str,
    pub params: Value,
    pub action: &'static str,
    /// What the failure names; the card's person when none.
    pub object: Option<String>,
    pub then: CardThen,
}

/// `toastUserError(error, { action, object })`, said on the card instead.
fn card_failure(action: &'static str, object: &str, error: Option<&RpcError>) -> Option<UserError> {
    let failure = match error {
        Some(error) => Failure::Rpc(error),
        None => Failure::Sentence {
            text: "",
            warning: false,
        },
    };
    let mut copy = user_error_message(failure, Some(UserErrorContext { action, object: "" }));
    if copy.kind == UserErrorKind::Canceled {
        return None;
    }
    copy.title = format!("Couldn't {action} {object}");
    Some(copy)
}

impl SidekickScreen {
    /// A people row: the card's dialog opens on the name and loads the person.
    pub(super) fn open_community_person(
        &mut self,
        person_id: String,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        community.opening = Some((person_id.clone(), name));
        community.selected = None;
        community.load_failed = false;
        community.card_error = None;
        community.busy = false;
        community.waved = false;
        community.linking = false;
        community.link_hits.clear();
        community.memory_target = None;
        community.person.open(window, cx);
        cx.notify();
        self.select_community_person(person_id, window, cx);
    }

    /// A loaded person on the card; the note follows the saved one.
    pub(super) fn show_community_person(
        &mut self,
        person: Option<PersonDetail>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        match person {
            Some(person) => {
                let fresh = community
                    .selected
                    .as_ref()
                    .is_none_or(|current| current.id != person.id);
                if fresh || person.note != community.note_saved {
                    community.note_saved = person.note.clone();
                    let note = person.note.clone();
                    community
                        .note
                        .update(cx, |input, cx| input.set_value(note, window, cx));
                }
                community.opening = Some((person.id.clone(), person.name.clone()));
                community.load_failed = false;
                community.selected = Some(person);
            }
            None => community.load_failed = true,
        }
        cx.notify();
    }

    /// One card action (Wave, a note, Not the same, a memory, a bot flag, a
    /// link): busy while it runs, and its failure on the card.
    pub(super) fn community_card_request(
        &mut self,
        call: CardCall,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        let CardCall {
            method,
            params,
            action,
            object,
            then,
        } = call;
        let object = object.unwrap_or_else(|| {
            community
                .selected
                .as_ref()
                .map(|person| person.name.clone())
                .unwrap_or_default()
        });
        community.busy = true;
        community.card_error = None;
        cx.notify();
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request(method, params).await });
        cx.spawn_in(window, async move |this, cx| {
            let result = job.await;
            let _ = this.update_in(cx, |screen, window, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.busy = false;
                }
                let value = match result {
                    Ok(Ok(value)) => value,
                    Ok(Err(error)) => {
                        eprintln!("[videorc-app] Sidekick Community: {method}: {error}");
                        if let Some(community) = screen.community.as_mut() {
                            community.card_error = card_failure(action, &object, Some(&error));
                        }
                        cx.notify();
                        return;
                    }
                    Err(error) => {
                        eprintln!("[videorc-app] Sidekick Community: {method}: {error}");
                        if let Some(community) = screen.community.as_mut() {
                            community.card_error = card_failure(action, &object, None);
                        }
                        cx.notify();
                        return;
                    }
                };
                match then {
                    CardThen::Person => {
                        if let Some(community) = screen.community.as_mut() {
                            community.linking = false;
                            community.link_hits.clear();
                        }
                        let person = serde_json::from_value::<PersonDetail>(value).ok();
                        if person.is_some() {
                            screen.show_community_person(person, window, cx);
                        }
                    }
                    CardThen::Reload => {
                        let id = screen
                            .community
                            .as_ref()
                            .and_then(|community| community.opening.as_ref())
                            .map(|(id, _)| id.clone());
                        if let Some(id) = id {
                            screen.select_community_person(id, window, cx);
                        }
                    }
                    CardThen::Waved => screen.community_waved(cx),
                }
                screen.refresh_community(cx);
            });
        })
        .detach();
    }

    /// "Wave" (`cohost.community.wave`): Sidekick's bubble only, never chat.
    pub(super) fn community_wave(
        &mut self,
        person_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = self
            .community
            .as_ref()
            .and_then(|community| community.selected.as_ref())
            .map(|person| person.name.clone())
            .unwrap_or_default();
        self.community_card_request(
            CardCall {
                method: "cohost.community.wave",
                params: json!({ "personId": person_id }),
                action: "update",
                object: Some(format!("a wave for {name}")),
                then: CardThen::Waved,
            },
            window,
            cx,
        );
    }

    fn community_waved(&mut self, cx: &mut Context<Self>) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        community.waved = true;
        community.wave_epoch += 1;
        let epoch = community.wave_epoch;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(WAVED_FOR).await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut()
                    && community.wave_epoch == epoch
                {
                    community.waved = false;
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// A linked account's "Not the same" (`cohost.community.unlink`).
    pub(super) fn community_unlink(
        &mut self,
        account_key: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.community_card_request(
            CardCall {
                method: "cohost.community.unlink",
                params: json!({ "accountKey": account_key }),
                action: "update",
                object: None,
                then: CardThen::Reload,
            },
            window,
            cx,
        );
    }

    /// "Your note": saved when it changed (`cohost.community.update`).
    pub(super) fn save_community_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        let Some((person_id, name)) = community
            .selected
            .as_ref()
            .filter(|person| !person.id.is_empty())
            .map(|person| (person.id.clone(), person.name.clone()))
        else {
            return;
        };
        let draft = community.note.read(cx).value().to_string();
        let Some(note) = note_to_save(&draft, &community.note_saved) else {
            return;
        };
        community.note_saved = note.clone();
        self.community_card_request(
            CardCall {
                method: "cohost.community.update",
                params: json!({ "personId": person_id, "note": note }),
                action: "update",
                object: Some(format!("{name}'s note")),
                then: CardThen::Person,
            },
            window,
            cx,
        );
    }

    /// A memory's "Forget …": the confirm takes the card's place.
    pub(super) fn ask_forget_memory(
        &mut self,
        memory: PersonMemory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(community) = self.community.as_mut() {
            community.memory_target = Some(memory);
            community.person.close(window, cx);
            community.memory_forget.open(window, cx);
        }
        cx.notify();
    }

    pub(super) fn cancel_forget_memory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(community) = self.community.as_mut() {
            community.memory_forget.close(window, cx);
            community.memory_target = None;
            community.person.open(window, cx);
        }
        cx.notify();
    }

    /// "Forget memory" (`cohost.community.memory.delete`), back on the card.
    pub(super) fn confirm_forget_memory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        let Some(memory) = community.memory_target.take() else {
            return;
        };
        community.memory_forget.close(window, cx);
        community.person.open(window, cx);
        self.community_card_request(
            CardCall {
                method: "cohost.community.memory.delete",
                params: json!({ "id": memory.id }),
                action: "update",
                object: Some("that memory".to_owned()),
                then: CardThen::Reload,
            },
            window,
            cx,
        );
    }

    /// "Show": Regulars, Everyone, Linked or Bots.
    pub(super) fn set_community_filter(&mut self, value: &str, cx: &mut Context<Self>) {
        if let Some((filter, _)) = FILTERS.iter().find(|(filter, _)| *filter == value)
            && let Some(community) = self.community.as_mut()
        {
            community.filter = filter;
        }
        self.refresh_community(cx);
    }

    /// "Sort people": Streams, Last chat or Name.
    pub(super) fn set_community_sort(&mut self, value: &str, cx: &mut Context<Self>) {
        if let Some((sort, _)) = SORTS.iter().find(|(sort, _)| *sort == value)
            && let Some(community) = self.community.as_mut()
        {
            community.sort = sort;
        }
        self.refresh_community(cx);
    }

    /// Saves the whole `community` settings with one change, as Electron
    /// does (`{ community: { ...settings, ...patch } }`): the backend
    /// replaces the object.
    pub(super) fn save_community_settings(
        &mut self,
        edit: impl FnOnce(&mut CommunitySettings),
        cx: &mut Context<Self>,
    ) {
        let mut next = community_settings(self.settings.as_ref());
        edit(&mut next);
        self.patch_settings(json!({ "community": next }), cx);
    }

    /// "Copy": the disclosure line, and "Copied" for a moment.
    pub(super) fn copy_community_disclosure(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(
            COMMUNITY_DISCLOSURE_LINE.to_string(),
        ));
        let Some(community) = self.community.as_mut() else {
            return;
        };
        community.copied = true;
        community.copied_epoch += 1;
        let epoch = community.copied_epoch;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut()
                    && community.copied_epoch == epoch
                {
                    community.copied = false;
                }
                cx.notify();
            });
        })
        .detach();
    }
}

pub fn render_community(
    view: &LiveView,
    entitled: bool,
    state: &CommunityState,
    settings: &CommunitySettings,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let entity = cx.entity();
    let now = Utc::now();
    let off = !settings.enabled;

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if !entitled {
        let action = view
            .unlock
            .as_ref()
            .and_then(|u| u.action)
            .unwrap_or(UnlockAction::ViewPremium);
        let label = match action {
            UnlockAction::SignIn => words::SIGN_IN,
            UnlockAction::ViewPremium => words::VIEW_PREMIUM,
        };
        lead = lead.child(
            Alert::new("sidekick-community-premium")
                .variant(AlertVariant::Warning)
                .title(BUDDY_REMEMBERS_LOCK_REASON)
                .action(
                    Button::new("community-unlock-action")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(label)
                        .on_click(move |_, _, cx| match action {
                            UnlockAction::SignIn => {
                                eprintln!(
                                    "[videorc-app] Sidekick Community: Sign in (account UI next)"
                                )
                            }
                            UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                        }),
                ),
        );
    }

    let header_line = community::community_header_line(state.summary.as_ref());
    let mut summary_block = div().flex().flex_col().gap(px(4.)).child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(header_line),
    );
    if let Some(backfill) = community::backfill_line(state.summary.as_ref()) {
        summary_block = summary_block.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(backfill),
        );
    }
    // D10: offered once, after the first stream regulars came to.
    let regulars_came = state
        .summary
        .as_ref()
        .is_some_and(|summary| summary.regulars > 0);
    if remember_offer_shows(
        regulars_came,
        entitled,
        settings.enabled,
        settings.remember,
        settings.remember_offered,
    ) {
        summary_block = summary_block.child(remember_offer(cx));
    }
    let summary = PanelSection::new("sidekick-your-community")
        .title(YOUR_COMMUNITY)
        .child(summary_block);

    let mut links = PanelSection::new("sidekick-links").title(LINKS_NEED_YOU);
    if state.suggestions.is_empty() {
        links = links.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child("No links waiting."),
        );
    } else {
        let mut list = GroupedList::new().label(LINKS_NEED_YOU);
        for suggestion in &state.suggestions {
            let account_a = suggestion.account_a.account_key.clone();
            let account_b = suggestion.account_b.account_key.clone();
            let title = format!(
                "{} ↔ {}",
                suggestion.account_a.name, suggestion.account_b.name
            );
            let key = format!("{account_a}|{account_b}");
            list = list.row(
                ListRow::new(format!("link-{key}"), title)
                    .context(suggestion.reason.clone())
                    .child(
                        Button::new(format!("accept-{key}"))
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .label(SAME_PERSON)
                            .on_click({
                                let entity = entity.clone();
                                let account_a = account_a.clone();
                                let account_b = account_b.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.community_accept_suggestion(
                                            account_a.clone(),
                                            account_b.clone(),
                                            cx,
                                        );
                                    });
                                }
                            }),
                    )
                    .child(
                        Button::new(format!("dismiss-{key}"))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Xs)
                            .label(NOT_THE_SAME)
                            .on_click({
                                let entity = entity.clone();
                                let account_a = account_a.clone();
                                let account_b = account_b.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.community_dismiss_suggestion(
                                            account_a.clone(),
                                            account_b.clone(),
                                            cx,
                                        );
                                    });
                                }
                            }),
                    ),
            );
        }
        links = links.child(list);
    }

    let people_body = if state.people.is_empty() {
        let query = state.search.read(cx).value().to_string();
        let (title, description) = people_empty_copy(&query, state.filter);
        div()
            .py(px(24.))
            .child(Empty::new().title(title).description(description))
            .into_any_element()
    } else {
        let mut people_list = GroupedList::new().label(PEOPLE);
        for person in &state.people {
            let id = person.id.clone();
            let name = person.name.clone();
            let context = person_row_context(person.streams, person.last_seen_at.as_deref(), now);
            let meta = if person.status == "bot" {
                BOT
            } else if person.regular {
                REGULAR
            } else {
                ""
            };
            people_list = people_list.row(
                ListRow::new(format!("person-{}", person.id), person.name.clone())
                    .compact(true)
                    .context(context)
                    .meta(meta)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |screen, cx| {
                                screen.open_community_person(id.clone(), name.clone(), window, cx);
                            });
                        }
                    }),
            );
        }
        people_list.into_any_element()
    };

    let mut sort = Select::new("community-sort")
        .accessibility_label(SORT_PEOPLE)
        .width(128.)
        .value(Some(state.sort.into()))
        .on_change({
            let entity = entity.clone();
            move |value, _, cx| {
                entity.update(cx, |screen, cx| {
                    screen.set_community_sort(value.as_ref(), cx)
                });
            }
        });
    for (value, label) in SORTS {
        sort = sort.option(value, label);
    }
    let mut show = SegmentedControl::new("community-show")
        .accessibility_label(SHOW)
        .value(Some(state.filter))
        .on_change({
            let entity = entity.clone();
            move |value, _, cx| {
                entity.update(cx, |screen, cx| {
                    screen.set_community_filter(value.as_ref(), cx)
                });
            }
        });
    for (value, label) in FILTERS {
        show = show.option(Segment::new(value, label));
    }

    let people = PanelSection::new("sidekick-people").title(PEOPLE).child(
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div().min_w(px(160.)).flex_1().child(
                            Input::new("community-search", &state.search)
                                .accessibility_label(SEARCH_PEOPLE),
                        ),
                    )
                    .child(sort),
            )
            .child(show)
            .child(people_body),
    );

    let community_settings = render_settings_section(settings, entity.clone());

    let premium = PanelSection::new("sidekick-community-premium")
        .title(PREMIUM)
        .description(PREMIUM_DESCRIPTION)
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("sidekick-remembers", SIDEKICK_REMEMBERS)
                        .description(SIDEKICK_REMEMBERS_DESCRIPTION)
                        .child(
                            Switch::new("sidekick-remembers")
                                .accessibility_label(SIDEKICK_REMEMBERS)
                                .checked(entitled && settings.remember)
                                .disabled(!entitled || off)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.save_community_settings(
                                                |community| community.remember = value,
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                )
                .row(
                    SettingsRow::new("community-sync", COMMUNITY_SYNC)
                        .description(COMMUNITY_SYNC_REASON)
                        .child(
                            Switch::new("community-sync")
                                .accessibility_label(COMMUNITY_SYNC)
                                .checked(false)
                                .disabled(true),
                        ),
                ),
        );

    let data = PanelSection::new("sidekick-your-data")
        .title(YOUR_DATA)
        .description(YOUR_DATA_DESCRIPTION)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(DISCLOSURE_LEAD),
                )
                .child(
                    div()
                        .rounded(px(radius::ROW))
                        .bg(hsla(theme.inset))
                        .px(px(12.))
                        .py(px(8.))
                        .type_scale(text::META)
                        .text_color(hsla(theme.foreground))
                        .child(COMMUNITY_DISCLOSURE_LINE),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new("copy-disclosure")
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::Xs)
                                .label(if state.copied { COPIED } else { COPY })
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.copy_community_disclosure(cx);
                                        });
                                    }
                                }),
                        )
                        .child(file_button(CommunityFile::Export, state.file_busy, cx))
                        .child(file_button(CommunityFile::Import, state.file_busy, cx))
                        .child(
                            Button::new("forget-everyone")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(FORGET_EVERYONE)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |screen, cx| {
                                            if let Some(community) = screen.community.as_mut() {
                                                community.forget_everyone.open(window, cx);
                                            }
                                            cx.notify();
                                        });
                                    }
                                }),
                        ),
                ),
        );

    let person = person_dialog(state, entitled, muted, hsla(theme.subtle), cx);
    let forget = forget_dialog(state, cx);
    let forget_all = forget_everyone_dialog(state, cx);
    let forget_memory = memory_forget_dialog(state, cx);

    div()
        .flex()
        .flex_col()
        .child(lead)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(size::GUTTER))
                .p(px(size::GUTTER))
                .child(summary)
                .child(links)
                .child(people)
                .child(community_settings)
                .child(premium)
                .child(data),
        )
        .child(person)
        .child(forget)
        .child(forget_all)
        .child(forget_memory)
        .into_any_element()
}

/// "Let Sidekick remember what your regulars tell it?" (remember-offer.tsx):
/// Turn on flips the switch, Not now only keeps the answer.
fn remember_offer(cx: &mut Context<SidekickScreen>) -> AnyElement {
    let entity = cx.entity();
    Alert::new("community-remember-offer")
        .title(REMEMBER_OFFER_TITLE)
        .description(REMEMBER_OFFER_DESCRIPTION)
        .action(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    Button::new("community-remember-on")
                        .size(ButtonSize::Xs)
                        .label(TURN_ON)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.save_community_settings(
                                        |community| {
                                            community.remember = true;
                                            community.remember_offered = true;
                                        },
                                        cx,
                                    );
                                });
                            }
                        }),
                )
                .child(
                    Button::new("community-remember-later")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label(NOT_NOW)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |screen, cx| {
                                screen.save_community_settings(
                                    |community| {
                                        community.remember = false;
                                        community.remember_offered = true;
                                    },
                                    cx,
                                );
                            });
                        }),
                ),
        )
        .into_any_element()
}

/// A control that is off while Remember my community is off, saying why.
fn gated(id: &'static str, off: bool, control: impl IntoElement) -> AnyElement {
    if off {
        div()
            .id(id)
            .tooltip(tooltip(OFF_REASON))
            .child(control)
            .into_any_element()
    } else {
        control.into_any_element()
    }
}

/// D-4: the switches, the threshold and retention.
fn render_settings_section(
    settings: &CommunitySettings,
    entity: Entity<SidekickScreen>,
) -> AnyElement {
    let off = !settings.enabled;
    let mut regular_after = Select::new("community-regular-after")
        .accessibility_label(REGULAR_AFTER)
        .width(128.)
        .disabled(off)
        .value(Some(settings.regular_streams.to_string().into()))
        .on_change({
            let entity = entity.clone();
            move |value, _, cx| {
                let Ok(streams) = value.parse::<u32>() else {
                    return;
                };
                let streams = streams.clamp(REGULAR_STREAMS_MIN, REGULAR_STREAMS_MAX);
                entity.update(cx, |screen, cx| {
                    screen.save_community_settings(
                        |community| community.regular_streams = streams,
                        cx,
                    );
                });
            }
        });
    for streams in REGULAR_STREAMS_MIN..=REGULAR_STREAMS_MAX {
        regular_after = regular_after.option(streams.to_string(), regular_after_label(streams));
    }

    PanelSection::new("sidekick-community-settings")
        .title(COMMUNITY_SETTINGS)
        .description(COMMUNITY_SETTINGS_DESCRIPTION)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    SettingsGroup::new()
                        .row(
                            SettingsRow::new("community-remember", REMEMBER_COMMUNITY)
                                .description(REMEMBER_COMMUNITY_DESCRIPTION)
                                .child(
                                    Switch::new("community-remember")
                                        .accessibility_label(REMEMBER_COMMUNITY)
                                        .checked(settings.enabled)
                                        .on_change({
                                            let entity = entity.clone();
                                            move |value, _, cx| {
                                                entity.update(cx, |screen, cx| {
                                                    screen.save_community_settings(
                                                        |community| community.enabled = value,
                                                        cx,
                                                    );
                                                });
                                            }
                                        }),
                                ),
                        )
                        .row(
                            SettingsRow::new("community-welcome", WELCOME_REGULARS)
                                .description(WELCOME_REGULARS_DESCRIPTION)
                                .child(gated(
                                    "community-welcome-reason",
                                    off,
                                    Switch::new("community-welcome")
                                        .accessibility_label(WELCOME_REGULARS)
                                        .checked(settings.welcome_on_stream)
                                        .disabled(off)
                                        .on_change({
                                            let entity = entity.clone();
                                            move |value, _, cx| {
                                                entity.update(cx, |screen, cx| {
                                                    screen.save_community_settings(
                                                        |community| {
                                                            community.welcome_on_stream = value
                                                        },
                                                        cx,
                                                    );
                                                });
                                            }
                                        }),
                                )),
                        )
                        .row(
                            SettingsRow::new("community-milestones", MILESTONE_CARDS)
                                .description(MILESTONE_CARDS_DESCRIPTION)
                                .child(gated(
                                    "community-milestones-reason",
                                    off,
                                    Switch::new("community-milestones")
                                        .accessibility_label(MILESTONE_CARDS)
                                        .checked(settings.milestone_cards)
                                        .disabled(off)
                                        .on_change(move |value, _, cx| {
                                            entity.update(cx, |screen, cx| {
                                                screen.save_community_settings(
                                                    |community| community.milestone_cards = value,
                                                    cx,
                                                );
                                            });
                                        }),
                                )),
                        )
                        .row(
                            SettingsRow::new("community-regular-after", REGULAR_AFTER)
                                .description(REGULAR_AFTER_DESCRIPTION)
                                .child(gated("community-regular-after-reason", off, regular_after)),
                        ),
                )
                .child(
                    Alert::new("community-retention")
                        .variant(AlertVariant::Quiet)
                        .title(retention_line()),
                ),
        )
        .into_any_element()
}

/// The person card's dialog, titled with the name (community-tab.tsx).
fn person_dialog(
    state: &CommunityState,
    entitled: bool,
    muted: Hsla,
    subtle: Hsla,
    cx: &mut Context<SidekickScreen>,
) -> Dialog {
    let entity = cx.entity();
    let title = state
        .selected
        .as_ref()
        .map(|person| person.name.clone())
        .or_else(|| state.opening.as_ref().map(|(_, name)| name.clone()))
        .unwrap_or_default();
    let body = match state.selected.as_ref() {
        Some(person) => render_person_card(person, state, entitled, muted, subtle, cx),
        None if state.load_failed => {
            let retry = state.opening.as_ref().map(|(id, _)| id.clone());
            Alert::new("community-person-failed")
                .variant(AlertVariant::Warning)
                .title(person_load_failed_line(&title))
                .action(
                    Button::new("community-person-retry")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(TRY_AGAIN)
                        .on_click(move |_, window, cx| {
                            if let Some(id) = retry.clone() {
                                entity.update(cx, |screen, cx| {
                                    if let Some(community) = screen.community.as_mut() {
                                        community.load_failed = false;
                                    }
                                    screen.select_community_person(id, window, cx);
                                });
                            }
                        }),
                )
                .into_any_element()
        }
        None => div()
            .flex()
            .justify_center()
            .py(px(24.))
            .child(
                Spinner::new("community-person-loading")
                    .accessibility_label(format!("Loading {title}")),
            )
            .into_any_element(),
    };
    Dialog::new("community-person", &state.person, title).child(body)
}

/// The card's section label (`SectionLabel`: 11 px / 600, tertiary).
fn card_label(label: &'static str, subtle: Hsla) -> impl IntoElement {
    div()
        .type_scale(text::LABEL)
        .text_color(subtle)
        .child(label)
}

fn render_person_card(
    person: &PersonDetail,
    state: &CommunityState,
    entitled: bool,
    muted: Hsla,
    subtle: Hsla,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let id = person.id.clone();
    let name = person.name.clone();
    let known = !person.id.is_empty();
    let is_bot = person.status == "bot";
    let linked = person.accounts.len() > 1;
    let busy = state.busy;
    let stats = person_stats_line(
        person.streams,
        person.first_seen_at.as_deref(),
        person.in_a_row,
        person.messages,
    );
    let support = support_line(person.support.as_ref());
    let platforms: Vec<String> = if person.platforms.is_empty() {
        person
            .accounts
            .iter()
            .map(|account| account.platform.clone())
            .collect()
    } else {
        person.platforms.clone()
    };
    let blocks_x = has_x(platforms.iter().map(String::as_str));

    let mut body = div().flex().flex_col().gap(px(12.));
    if let Some(error) = state.card_error.as_ref() {
        body = body.child(
            Alert::new("community-card-error")
                .variant(if error.warning {
                    AlertVariant::Warning
                } else {
                    AlertVariant::Destructive
                })
                .title(error.title.clone())
                .description(error.description.clone()),
        );
    }

    // PersonHeader: the name, Regular / Bot, and a linked person's line.
    let mut name_line = div().flex().items_center().gap(px(6.)).child(
        div()
            .min_w(px(0.))
            .type_scale(text::SECTION)
            .child(name.clone()),
    );
    if person.regular {
        name_line = name_line.child(Badge::new(REGULAR).variant(BadgeVariant::Outline));
    }
    if is_bot {
        name_line = name_line.child(Badge::new(BOT).variant(BadgeVariant::Outline));
    }
    let mut header = div().flex().flex_col().child(name_line);
    if linked {
        header = header.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(linked_line(person.accounts.len())),
        );
    }
    body = body.child(header);

    // AccountsList: a linked account's "Not the same" splits it off.
    if !person.accounts.is_empty() {
        let mut accounts = div().flex().flex_col().gap(px(2.));
        for account in &person.accounts {
            let mut row =
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .min_h(px(24.))
                    .child(div().min_w(px(0.)).flex_1().type_scale(text::META).child(
                        account_label(&account.platform, account.handle.as_deref(), &account.name),
                    ));
            if linked {
                let key = account.account_key.clone();
                row = row.child(
                    Button::new(format!("unlink-{}", account.account_key))
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label(NOT_THE_SAME)
                        .disabled(busy)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.community_unlink(key.clone(), window, cx);
                                });
                            }
                        }),
                );
            }
            accounts = accounts.child(row);
        }
        body = body.child(accounts);
    }

    let mut lines = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(div().type_scale(text::META).text_color(muted).child(stats));
    if let Some(support) = support {
        lines = lines.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(support),
        );
    }
    body = body.child(lines);

    let mine: std::collections::HashSet<&str> = person
        .accounts
        .iter()
        .map(|account| account.account_key.as_str())
        .collect();
    for suggestion in &person.suggestions {
        let other = if mine.contains(suggestion.account_a.account_key.as_str()) {
            &suggestion.account_b
        } else {
            &suggestion.account_a
        };
        let account_a = suggestion.account_a.account_key.clone();
        let account_b = suggestion.account_b.account_key.clone();
        let key = format!("{account_a}|{account_b}");
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .type_scale(text::META)
                        .child(format!("{} — {}", other.name, suggestion.reason)),
                )
                .child(
                    Button::new(format!("card-accept-{key}"))
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(SAME_PERSON)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.community_accept_suggestion(
                                        account_a.clone(),
                                        account_b.clone(),
                                        cx,
                                    );
                                });
                            }
                        }),
                ),
        );
    }

    // "Sidekick remembers": the lock, the memories (each can be forgotten,
    // asking first) or the empty line.
    let mut memories = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(card_label(SIDEKICK_REMEMBERS, subtle));
    if !entitled {
        memories = memories.child(
            Alert::new("community-card-memory-lock")
                .variant(AlertVariant::Locked)
                .title(BUDDY_REMEMBERS_LOCK_REASON),
        );
    } else if person.memories.is_empty() {
        memories = memories.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(nothing_remembered_line(&name)),
        );
    } else {
        for memory in &person.memories {
            let target = memory.clone();
            let label = forget_memory_label(&memory.text);
            memories = memories.child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.))
                    .child(icon(IconName::Sparkle, 12., muted))
                    .child(
                        div()
                            .min_w(px(0.))
                            .flex_1()
                            .type_scale(text::META)
                            .child(memory.text.clone()),
                    )
                    .child(
                        Button::new(format!("forget-memory-{}", memory.id))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::IconXs)
                            .accessibility_label(label.clone())
                            .tooltip(label)
                            .disabled(busy)
                            .child(icon(IconName::Trash, 16., muted))
                            .on_click({
                                let entity = entity.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.ask_forget_memory(target.clone(), window, cx);
                                    });
                                }
                            }),
                    ),
            );
        }
    }
    body = body.child(memories);

    body = body.child(
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(card_label(YOUR_NOTE, subtle))
            .child(
                Textarea::new("community-note", &state.note)
                    .disabled(!known)
                    .accessibility_label(YOUR_NOTE),
            ),
    );

    if person.youtube {
        body = body.child(
            Alert::new("community-card-youtube")
                .variant(AlertVariant::Quiet)
                .title(YOUTUBE_RETENTION_LINE),
        );
    }

    let mut actions = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(4.))
        .child(
            Button::new("community-wave")
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::Xs)
                .label(if state.waved { WAVED } else { WAVE })
                .disabled(!known || busy || state.waved)
                .on_click({
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen, cx| {
                            screen.community_wave(id.clone(), window, cx);
                        });
                    }
                }),
        )
        .child(
            Button::new("mark-bot")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(if is_bot { NOT_A_BOT } else { MARK_AS_BOT })
                .disabled(!known || busy)
                .on_click({
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen, cx| {
                            screen.community_toggle_bot(id.clone(), is_bot, window, cx);
                        });
                    }
                }),
        )
        .child(
            Button::new("forget-person")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(format!("Forget {name}…"))
                .disabled(!known || busy)
                .on_click({
                    let entity = entity.clone();
                    let id = id.clone();
                    let name = name.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen, cx| {
                            screen.ask_forget_person(id.clone(), name.clone(), window, cx);
                        });
                    }
                }),
        );
    if blocks_x {
        actions = actions.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(X_SELF_LINK_REASON),
        );
    } else {
        actions = actions.child(
            Button::new("same-person")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(SAME_PERSON_AS)
                .disabled(!known || busy)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |screen, cx| {
                            if let Some(community) = screen.community.as_mut() {
                                community.linking = !community.linking;
                                if !community.linking {
                                    community.link_hits.clear();
                                }
                            }
                            cx.notify();
                        });
                    }
                }),
        );
    }
    body = body.child(actions);

    if state.linking && !blocks_x {
        let mut link_block = div().flex().flex_col().gap(px(6.)).child(
            Input::new("community-link-search", &state.link_search)
                .accessibility_label(SAME_PERSON_AS),
        );
        for hit in &state.link_hits {
            if hit.id == person.id {
                continue;
            }
            let other_id = hit.id.clone();
            let person_id = person.id.clone();
            link_block = link_block.child(
                ListRow::new(format!("link-hit-{}", hit.id), hit.name.clone())
                    .compact(true)
                    .child(
                        Button::new(format!("link-{}", hit.id))
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .label(SAME_PERSON)
                            .disabled(busy)
                            .on_click({
                                let entity = entity.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.community_link(
                                            person_id.clone(),
                                            other_id.clone(),
                                            window,
                                            cx,
                                        );
                                    });
                                }
                            }),
                    ),
            );
        }
        body = body.child(link_block);
    }

    body.into_any_element()
}

fn forget_dialog(state: &CommunityState, cx: &mut Context<SidekickScreen>) -> Dialog {
    let entity = cx.entity();
    let copy = forget_copy(&state.forget_name);
    Dialog::new("forget-person", &state.forget, copy.title.clone())
        .description(copy.description.clone())
        .footer(
            Button::new("forget-cancel")
                .variant(ButtonVariant::Ghost)
                .label(CANCEL)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen, cx| {
                            if let Some(community) = screen.community.as_mut() {
                                community.forget.close(window, cx);
                                community.forget_id = None;
                                // Back to the card it was asked from.
                                if community.selected.is_some() {
                                    community.person.open(window, cx);
                                }
                            }
                            cx.notify();
                        });
                    }
                }),
        )
        .footer(
            Button::new("forget-confirm")
                .variant(ButtonVariant::Default)
                .label(copy.confirm)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| {
                        screen.confirm_forget_person(window, cx);
                    });
                }),
        )
}

/// "Forget this memory?" (D10), asked in the card's place.
fn memory_forget_dialog(state: &CommunityState, cx: &mut Context<SidekickScreen>) -> Dialog {
    let entity = cx.entity();
    let name = state
        .selected
        .as_ref()
        .map(|person| person.name.as_str())
        .unwrap_or_default();
    let text = state
        .memory_target
        .as_ref()
        .map(|memory| memory.text.as_str())
        .unwrap_or_default();
    let copy = memory_forget_copy(name, text);
    Dialog::new("forget-memory", &state.memory_forget, copy.title)
        .description(copy.description)
        .footer(
            Button::new("forget-memory-cancel")
                .variant(ButtonVariant::Ghost)
                .label(CANCEL)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen, cx| screen.cancel_forget_memory(window, cx));
                    }
                }),
        )
        .footer(
            Button::new("forget-memory-confirm")
                .variant(ButtonVariant::Default)
                .label(copy.confirm)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| screen.confirm_forget_memory(window, cx));
                }),
        )
}

fn forget_everyone_dialog(state: &CommunityState, cx: &mut Context<SidekickScreen>) -> Dialog {
    let entity = cx.entity();
    Dialog::new(
        "forget-everyone",
        &state.forget_everyone,
        FORGET_EVERYONE_TITLE,
    )
    .description("Videorc deletes what it remembers about everyone on this computer.")
    .footer(
        Button::new("forget-everyone-cancel")
            .variant(ButtonVariant::Ghost)
            .label(CANCEL)
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| {
                    entity.update(cx, |screen, cx| {
                        if let Some(community) = screen.community.as_mut() {
                            community.forget_everyone.close(window, cx);
                        }
                        cx.notify();
                    });
                }
            }),
    )
    .footer(
        Button::new("forget-everyone-confirm")
            .variant(ButtonVariant::Default)
            .label("Forget everyone")
            .on_click(move |_, window, cx| {
                entity.update(cx, |screen, cx| {
                    screen.community_forget_all(window, cx);
                });
            }),
    )
}

fn file_button(
    which: CommunityFile,
    busy: Option<CommunityFile>,
    cx: &mut Context<SidekickScreen>,
) -> Button {
    let (id, label, working) = match which {
        CommunityFile::Export => ("community-export", "Export…", "Exporting…"),
        CommunityFile::Import => ("community-import", "Import…", "Importing…"),
    };
    let entity = cx.entity();
    Button::new(id)
        .variant(ButtonVariant::Outline)
        .size(ButtonSize::Xs)
        .label(if busy == Some(which) { working } else { label })
        .disabled(busy.is_some())
        .on_click(move |_, _, cx| {
            entity.update(cx, |screen, cx| screen.pick_community_file(which, cx));
        })
}

/// `plural(n, one, many)`: "1 person", "3 people".
fn plural(count: u64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn file_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Why a community file failed: the capability Videorc couldn't issue, or
/// the backend's answer.
enum FileFailure {
    Issue(String),
    Rpc(RpcError),
}

impl SidekickScreen {
    /// Export… picks a folder, Import… a file; a cancelled picker does
    /// nothing.
    pub(super) fn pick_community_file(&mut self, which: CommunityFile, cx: &mut Context<Self>) {
        if self
            .community
            .as_ref()
            .is_none_or(|community| community.file_busy.is_some())
        {
            return;
        }
        let export = which == CommunityFile::Export;
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: !export,
            directories: export,
            multiple: false,
            prompt: Some((if export { "Export" } else { "Import" }).into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let _ = this.update(cx, |screen, cx| screen.run_community_file(which, path, cx));
        })
        .detach();
    }

    fn run_community_file(
        &mut self,
        which: CommunityFile,
        path: std::path::PathBuf,
        cx: &mut Context<Self>,
    ) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        community.file_busy = Some(which);
        cx.notify();
        let bootstrap = self.backend_state.borrow().bootstrap().cloned();
        let backend = self.studio.backend().clone();
        let target = path.clone();
        let job = self.runtime.spawn(async move {
            let bootstrap = bootstrap.ok_or_else(|| {
                FileFailure::Issue("Videorc is reconnecting. Try again in a moment.".into())
            })?;
            let (kind, field, method) = match which {
                CommunityFile::Export => (
                    ResourceKind::OutputDirectory,
                    "outputDirectoryCapability",
                    "cohost.community.export",
                ),
                CommunityFile::Import => (
                    ResourceKind::InputFile,
                    "sourceCapability",
                    "cohost.community.import",
                ),
            };
            let (_, issued) = issue_capability(&bootstrap, &target, kind, IssueOptions::default())
                .await
                .map_err(FileFailure::Issue)?;
            backend
                .request(method, json!({ field: issued.capability_id }))
                .await
                .map_err(FileFailure::Rpc)
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Some(community) = screen.community.as_mut() {
                    community.file_busy = None;
                }
                match answer {
                    Ok(Ok(value)) => {
                        screen.community_file_done(which, &path, &value, cx);
                        if which == CommunityFile::Import {
                            screen.refresh_community(cx);
                        }
                    }
                    Ok(Err(failure)) => screen.community_file_failed(which, &path, failure, cx),
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// A finished file is news out of view: one toast (id `community-file`).
    fn community_file_done(
        &mut self,
        which: CommunityFile,
        path: &std::path::Path,
        value: &Value,
        cx: &mut Context<Self>,
    ) {
        let count = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
        let people = plural(count("people"), "person", "people");
        let toast = match which {
            CommunityFile::Export => {
                let written = value
                    .get("fileName")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                ToastData::new(
                    ToastKind::Success,
                    format!("Exported {people} to {written}"),
                )
                .description(format!(
                    "In {}. The file is yours: Import… reads it on another computer.",
                    file_name(path)
                ))
            }
            CommunityFile::Import => {
                let toast = ToastData::new(
                    ToastKind::Success,
                    format!("Imported {people} from {}", file_name(path)),
                );
                let merged = count("merged");
                if merged > 0 {
                    toast.description(format!(
                        "{} already here; their streams now count once.",
                        plural(merged, "person was", "people were")
                    ))
                } else {
                    toast
                }
            }
        };
        press_community_toast(toast, cx);
    }

    /// "Couldn't export your community" / "Couldn't import {file}".
    fn community_file_failed(
        &mut self,
        which: CommunityFile,
        path: &std::path::Path,
        failure: FileFailure,
        cx: &mut Context<Self>,
    ) {
        let context = UserErrorContext {
            action: match which {
                CommunityFile::Export => "export",
                CommunityFile::Import => "import",
            },
            object: "your community",
        };
        let copy = match &failure {
            FileFailure::Rpc(error) => user_error_message(Failure::Rpc(error), Some(context)),
            FileFailure::Issue(text) => user_error_message(
                Failure::Sentence {
                    text,
                    warning: false,
                },
                Some(context),
            ),
        };
        if copy.kind == UserErrorKind::Canceled {
            return;
        }
        let title = match which {
            CommunityFile::Export => copy.title,
            CommunityFile::Import => format!("Couldn't import {}", file_name(path)),
        };
        let kind = if copy.warning {
            ToastKind::Warning
        } else {
            ToastKind::Error
        };
        press_community_toast(
            ToastData::new(kind, title).description(copy.description),
            cx,
        );
    }
}

fn press_community_toast(toast: ToastData, cx: &mut Context<SidekickScreen>) {
    let hub = cx
        .global::<crate::screens::notifications::Shared>()
        .0
        .clone();
    hub.update(cx, |hub, cx| {
        hub.press_toast("community-file".to_string(), toast, cx)
    });
}
