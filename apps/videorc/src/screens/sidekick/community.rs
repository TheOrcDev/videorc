//! Sidekick → Community: people list, person card, Same person, Mark as bot,
//! Forget — `cohost.community.*` plus `videorc_app_core::buddy::community`.
//! Words and behaviour from Electron's `components/community/*.tsx`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::Utc;
use gpui::{
    AnyElement, ClipboardItem, Context, Entity, FontWeight, Hsla, SharedString, Window, div,
    prelude::*, px,
};
use gpui_base::input::InputEvent;
use serde::Deserialize;
use serde_json::{Value, json};
use videorc_app_core::buddy::community::{
    self, BUDDY_REMEMBERS_LOCK_REASON, COMMUNITY_DISCLOSURE_LINE, CommunitySummary,
    REMEMBER_OFFER_DESCRIPTION, REMEMBER_OFFER_TITLE, X_SELF_LINK_REASON, YOUTUBE_RETENTION_LINE,
    account_label, avatar_retry_delay, avatar_url, avatar_urls_to_load, forget_copy,
    forget_memory_label, has_x, linked_line, memory_forget_copy, note_to_save,
    nothing_remembered_line, people_empty_copy, person_load_failed_line, person_row_context,
    person_stats_line, regular_after_label, remember_offer_shows, retention_line, support_line,
};
use videorc_app_core::chat::highlight_driver as driver;
use videorc_app_core::chat::images;
use videorc_app_core::chat::overlay::monogram_initials;
use videorc_app_core::client::RpcError;
use videorc_app_core::resources::capability::{IssueOptions, ResourceKind};
use videorc_app_core::resources::issue_capability;
use videorc_app_core::stream_manager::buddy::CohostSettingsView;
use videorc_app_core::user_error::{
    Failure, UserError, UserErrorContext, UserErrorKind, user_error_message,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::avatar::Avatar;
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::input_group::{InputGroup, InputGroupAddon};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::page::PageStack;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::platform_glyph::PlatformMark;
use videorc_kit::progress::Progress;
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

use super::live::{Unlock, UnlockAction};
use super::voice::chat_platform;
use super::{SidekickScreen, config_grid_pair, unlock_alert};
use crate::screens::chat_media::{self, Picture};

const YOUR_COMMUNITY: &str = "Your community";
const PEOPLE: &str = "People";
const SEARCH_PEOPLE: &str = "Search people";
const SORT_PEOPLE: &str = "Sort people";
const SHOW: &str = "Show";
const LINKS_NEED_YOU: &str = "Links that need you";
const LINKS_DESCRIPTION: &str =
    "Accounts that might be one person. Videorc never links them on its own.";
const AND: &str = "and";
const LINK_CANCELLED: &str = "!link cancelled";
const PEOPLE_DESCRIPTION: &str =
    "Everyone who chatted, as one person per human. Open someone to see their card.";
const READING_PAST_STREAMS: &str = "Reading your past streams";
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
const COMMUNITY_SYNC_LATER: &str = "Community sync arrives in a later update.";
const COMMUNITY_SYNC_DESCRIPTION: &str =
    "The same community on your other computers. YouTube viewers are not synced (YouTube's rules).";
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
/// Pictures kept for the People rows and the card; past it, only the ones
/// on screen stay (the list asks for 100 people at most).
const AVATAR_CACHE: usize = 256;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRow {
    pub id: String,
    pub name: String,
    /// The viewer's picture (`CommunityPersonRow.avatarUrl`).
    #[serde(default)]
    pub avatar_url: Option<String>,
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
    /// The viewer's picture (`CommunityPerson.avatarUrl`).
    #[serde(default)]
    pub avatar_url: Option<String>,
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
    /// P1201: Play a welcome / Play a milestone (local preview only).
    pub(super) preview: Option<super::community_preview::CommunityPreview>,
    /// `useCachedAvatar`: the People rows' and the card's pictures by
    /// `avatarUrl`, through the backend's chat image cache.
    pub(super) avatars: HashMap<String, Picture>,
    /// How many times each picture has failed, for its next wait.
    pub(super) avatar_failures: HashMap<String, usize>,
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
            preview: None,
            avatars: HashMap::new(),
            avatar_failures: HashMap::new(),
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
        self.load_community_avatars(cx);
        cx.notify();
    }

    /// `useCachedAvatar` for the People rows and the card: the backend
    /// caches the picture, its route serves the bytes, and the monogram
    /// stays while it loads or when either refuses.
    pub(super) fn load_community_avatars(&mut self, cx: &mut Context<Self>) {
        let Some(community) = self.community.as_mut() else {
            return;
        };
        let shown: Vec<String> = community
            .people
            .iter()
            .map(|person| person.avatar_url.as_deref())
            .chain(
                community
                    .selected
                    .iter()
                    .map(|person| person.avatar_url.as_deref()),
            )
            .filter_map(avatar_url)
            .map(str::to_owned)
            .collect();
        let wanted = avatar_urls_to_load(shown.iter().map(|url| Some(url.as_str())), |url| {
            community.avatars.contains_key(url)
        });
        if community.avatars.len() + wanted.len() > AVATAR_CACHE {
            let keep: HashSet<&str> = shown.iter().map(String::as_str).collect();
            community
                .avatars
                .retain(|url, _| keep.contains(url.as_str()));
            community
                .avatar_failures
                .retain(|url, _| keep.contains(url.as_str()));
        }
        for url in wanted {
            self.fetch_community_avatar(url, cx);
        }
    }

    /// One picture through the backend's cache. One the cache could not
    /// fetch is asked for again after 5, 20 and 60 s, then left as the
    /// monogram (`useCachedAvatar`'s `CHAT_IMAGE_NULL_RETRY_DELAYS_MS`).
    fn fetch_community_avatar(&mut self, url: String, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let Some(community) = self.community.as_mut() else {
            return;
        };
        community.avatars.insert(url.clone(), Picture::Loading);
        let remote = url.clone();
        let job = self.runtime.spawn(async move {
            let kind = chat_media::cache_kind_for_url(&remote, false);
            let local = driver::cache_image_as(&*backend, &remote, kind).await?;
            let bytes = images::read_route(&local).await.ok()?;
            Some(chat_media::picture_from_bytes(bytes))
        });
        cx.spawn(async move |this, cx| {
            let picture = job.await.ok().flatten();
            let retry = this
                .update(cx, |screen, cx| {
                    let community = screen.community.as_mut()?;
                    let retry = match picture {
                        Some(picture) => {
                            community.avatar_failures.remove(&url);
                            community.avatars.insert(url.clone(), picture);
                            None
                        }
                        None => {
                            let failed = community.avatar_failures.entry(url.clone()).or_insert(0);
                            let delay = avatar_retry_delay(*failed);
                            *failed += 1;
                            community.avatars.insert(url.clone(), Picture::Failed);
                            delay
                        }
                    };
                    cx.notify();
                    retry
                })
                .ok()
                .flatten();
            let Some(delay) = retry else {
                return;
            };
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |screen, cx| {
                // Still on the page and still failed: ask again.
                let again = screen.community.as_ref().is_some_and(|community| {
                    matches!(community.avatars.get(&url), Some(Picture::Failed))
                });
                if again {
                    screen.fetch_community_avatar(url, cx);
                }
            });
        })
        .detach();
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

    /// A memory's "Forget …": the confirm stacks over the card
    /// (`Dialog::layer(1)`).
    pub(super) fn ask_forget_memory(
        &mut self,
        memory: PersonMemory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(community) = self.community.as_mut() {
            community.memory_target = Some(memory);
            community.memory_forget.open(window, cx);
        }
        cx.notify();
    }

    pub(super) fn cancel_forget_memory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(community) = self.community.as_mut() {
            community.memory_forget.close(window, cx);
            community.memory_target = None;
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
    entitled: bool,
    state: &CommunityState,
    settings: &CommunitySettings,
    preview: AnyElement,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let foreground = hsla(theme.foreground);
    let border = hsla(theme.border);
    let entity = cx.entity();
    let now = Utc::now();
    let off = !settings.enabled;

    // `CommunityOverview`: the header line as the description, then the
    // past streams being read (with their progress) and the remember offer.
    let mut summary = PanelSection::new("sidekick-your-community")
        .title(YOUR_COMMUNITY)
        .description(community::community_header_line(state.summary.as_ref()));
    if let (Some(backfill), Some(counts)) = (
        community::backfill_line(state.summary.as_ref()),
        state.summary.as_ref(),
    ) {
        summary = summary.child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(backfill),
                )
                .child(
                    Progress::new(counts.backfill.done as f32)
                        .max(counts.backfill.total.max(1) as f32)
                        .accessibility_label(READING_PAST_STREAMS),
                ),
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
        summary = summary.child(remember_offer(cx));
    }

    // D-2: links that need you, only when there are any. Each row names
    // both accounts with their platform marks, then its two answers.
    let links = (!state.suggestions.is_empty()).then(|| {
        let mut list = GroupedList::new();
        for suggestion in &state.suggestions {
            let account_a = suggestion.account_a.account_key.clone();
            let account_b = suggestion.account_b.account_key.clone();
            let key = format!("{account_a}|{account_b}");
            // `ChatPlatformIcon className="mr-0"`: the 20 px mark (YouTube's
            // official one) with no clear space of its own.
            let account = |person: &PersonAccount, side: &str| {
                [
                    PlatformMark::new(chat_platform(&person.platform))
                        .size(20.)
                        .id(SharedString::from(format!("link-mark-{key}-{side}")))
                        .into_any_element(),
                    div()
                        .min_w_0()
                        .truncate()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(foreground)
                        .child(person.name.clone())
                        .into_any_element(),
                ]
            };
            let names = div()
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(6.))
                .children(account(&suggestion.account_a, "a"))
                .child(div().flex_none().text_color(muted).child(AND))
                .children(account(&suggestion.account_b, "b"))
                .when(suggestion.reason == "link-cancelled", |names| {
                    names.child(Badge::new(LINK_CANCELLED).variant(BadgeVariant::Outline))
                });
            let answers = div()
                .flex()
                .flex_none()
                .gap(px(4.))
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
                );
            list = list.item(
                div()
                    .id(SharedString::from(format!("link-{key}")))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .min_h(px(size::ROW))
                    .gap_x(px(10.))
                    .gap_y(px(4.))
                    .px(px(12.))
                    .py(px(4.))
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .child(names)
                    .child(answers),
            );
        }
        PanelSection::new("sidekick-links")
            .title(LINKS_NEED_YOU)
            .description(LINKS_DESCRIPTION)
            .child(list)
    });

    // D-3: search, sort and filter over the list, which scrolls inside its
    // own 384 px well.
    let people_body = if state.people.is_empty() {
        let query = state.search.read(cx).value().to_string();
        let (title, description) = people_empty_copy(&query, state.filter);
        // `Empty className="py-6"`: Empty's own 24 px padding, no more.
        Empty::new()
            .title(title)
            .description(description)
            .into_any_element()
    } else {
        let count = state.people.len();
        let mut rows = div().flex().flex_col();
        for (index, person) in state.people.iter().enumerate() {
            let id = person.id.clone();
            let name = person.name.clone();
            let context = person_row_context(person.streams, person.last_seen_at.as_deref(), now);
            let tag = if person.status == "bot" {
                Some(BOT)
            } else if person.regular {
                Some(REGULAR)
            } else {
                None
            };
            let marks = div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.))
                .children(
                    person
                        .platforms
                        .iter()
                        .map(|platform| PlatformMark::new(chat_platform(platform)).size(20.)),
                )
                .children(tag.map(|tag| Badge::new(tag).variant(BadgeVariant::Outline)));
            rows = rows.child(
                div()
                    .when(index + 1 < count, |row| {
                        row.border_b_1().border_color(border)
                    })
                    .child(
                        ListRow::new(format!("person-{}", person.id), person.name.clone())
                            .leading(
                                person_avatar(
                                    &person.name,
                                    person.avatar_url.as_deref(),
                                    &state.avatars,
                                )
                                .sm(),
                            )
                            .alias(marks)
                            .meta(context)
                            .grouped()
                            .on_click({
                                let entity = entity.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.open_community_person(
                                            id.clone(),
                                            name.clone(),
                                            window,
                                            cx,
                                        );
                                    });
                                }
                            }),
                    ),
            );
        }
        div()
            .overflow_hidden()
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(border)
            .bg(hsla(theme.inset))
            .child(
                div()
                    .id("community-people-list")
                    .h(px(384.))
                    .overflow_y_scroll()
                    .child(rows),
            )
            .into_any_element()
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
    // A plain `SegmentedControl` (not in a Field): `w-fit`, hugging its
    // options at the left.
    let mut show = SegmentedControl::new("community-show")
        .fit(true)
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

    let people = PanelSection::new("sidekick-people")
        .title(PEOPLE)
        .description(PEOPLE_DESCRIPTION)
        .last(true)
        .child(
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
                                InputGroup::new("community-search", &state.search)
                                    .accessibility_label(SEARCH_PEOPLE)
                                    .start(InputGroupAddon::start().child(icon(
                                        IconName::MagnifyingGlass,
                                        16.,
                                        muted,
                                    ))),
                            ),
                        )
                        .child(sort),
                )
                .child(show)
                .child(people_body),
        );

    let community_settings = render_settings_section(settings, entity.clone());

    // Premium: the lock leads, and both rows stay on screen behind it. Its
    // action is the gate's upgrade (`unlockActionForGate`): View Premium,
    // signed in or not.
    let lock = (!entitled).then(|| {
        unlock_alert(
            "sidekick-community-premium-lock",
            "community-unlock-action",
            &Unlock {
                action: Some(UnlockAction::ViewPremium),
                reason: BUDDY_REMEMBERS_LOCK_REASON.to_string(),
            },
            BUDDY_REMEMBERS_LOCK_REASON,
        )
    });
    let remember_reason = if !entitled {
        Some(BUDDY_REMEMBERS_LOCK_REASON)
    } else if off {
        Some(OFF_REASON)
    } else {
        None
    };
    let premium = PanelSection::new("sidekick-community-premium")
        .title(PREMIUM)
        .description(PREMIUM_DESCRIPTION)
        .children(lock)
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("sidekick-remembers", SIDEKICK_REMEMBERS)
                        .description(SIDEKICK_REMEMBERS_DESCRIPTION)
                        .child(with_reason(
                            "sidekick-remembers-reason",
                            remember_reason,
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
                        )),
                )
                .row(
                    SettingsRow::new("community-sync", COMMUNITY_SYNC)
                        .description(COMMUNITY_SYNC_DESCRIPTION)
                        .child(with_reason(
                            "community-sync-reason",
                            Some(if entitled {
                                COMMUNITY_SYNC_LATER
                            } else {
                                COMMUNITY_SYNC_REASON
                            }),
                            Switch::new("community-sync")
                                .accessibility_label(COMMUNITY_SYNC)
                                .checked(false)
                                .disabled(true),
                        )),
                ),
        );

    // Your data: the disclosure line and its Copy, then Export… and
    // Import… with Forget everyone… at the far end.
    let data = PanelSection::new("sidekick-your-data")
        .title(YOUR_DATA)
        .description(YOUR_DATA_DESCRIPTION)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
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
                                .text_color(foreground)
                                .child(COMMUNITY_DISCLOSURE_LINE),
                        )
                        .child(
                            div().flex().child(
                                Button::new("copy-disclosure")
                                    .variant(ButtonVariant::Secondary)
                                    .size(ButtonSize::Xs)
                                    .icon(IconName::Copy)
                                    .label(if state.copied { COPIED } else { COPY })
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |screen, cx| {
                                                screen.copy_community_disclosure(cx);
                                            });
                                        }
                                    }),
                            ),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(6.))
                        .child(file_button(CommunityFile::Export, state.file_busy, cx))
                        .child(file_button(CommunityFile::Import, state.file_busy, cx))
                        .child(div().flex_1())
                        .child(
                            Button::new("forget-everyone")
                                .variant(ButtonVariant::Destructive)
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

    // One column for the people (the header, links that need you, the
    // list), one for the settings, Premium, your data and the preview.
    let lead = PageStack::new()
        .child(summary)
        .children(links)
        .child(people);
    let trail = PageStack::new()
        .child(community_settings)
        .child(premium)
        .child(data)
        .child(preview);

    div()
        .flex()
        .flex_col()
        .flex_1()
        .child(config_grid_pair(
            "sidekick-community-grid",
            lead,
            trail,
            border,
        ))
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
    with_reason(id, off.then_some(OFF_REASON), control)
}

/// `DisabledReason`: a disabled control's reason on hover, while it has one.
fn with_reason(
    id: &'static str,
    reason: Option<&'static str>,
    control: impl IntoElement,
) -> AnyElement {
    match reason {
        Some(reason) => div()
            .id(id)
            .tooltip(tooltip(reason))
            .child(control)
            .into_any_element(),
        None => control.into_any_element(),
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

/// `Avatar` with `AvatarImage` over the `AvatarFallback` monogram: the
/// person's picture once the cache has it, the initials until then.
fn person_avatar(name: &str, url: Option<&str>, avatars: &HashMap<String, Picture>) -> Avatar {
    let avatar = Avatar::new(monogram_initials(name));
    match avatar_url(url)
        .and_then(|url| avatars.get(url))
        .and_then(Picture::ready)
    {
        Some(image) => avatar.image(image),
        None => avatar,
    }
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
    let mut header = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w(px(0.))
        .child(name_line);
    if linked {
        header = header.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(linked_line(person.accounts.len())),
        );
    }
    // `Avatar size="lg"` beside the name, 10 px apart (`gap-2.5`).
    body = body.child(
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .min_w(px(0.))
            .child(person_avatar(&name, person.avatar_url.as_deref(), &state.avatars).lg())
            .child(header),
    );

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
        .layer(1)
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
                                // The card it was asked from stays open below.
                                community.forget.close(window, cx);
                                community.forget_id = None;
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

/// "Forget this memory?" (D10), stacked over the card.
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
        .layer(1)
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

#[cfg(test)]
mod tests {
    use super::{PersonDetail, PersonRow};
    use serde_json::json;

    /// `cohost.community.list` rows and `cohost.community.person` carry the
    /// viewer's picture as `avatarUrl`; an older answer without it still reads.
    #[test]
    fn people_and_the_card_read_the_avatar_url() {
        let row: PersonRow = serde_json::from_value(json!({
            "id": "p1",
            "name": "Ada",
            "avatarUrl": "https://yt3.ggpht.com/ada.jpg",
            "platforms": ["youtube"],
            "streams": 3,
            "regular": true,
            "status": "normal",
        }))
        .expect("row");
        assert_eq!(
            row.avatar_url.as_deref(),
            Some("https://yt3.ggpht.com/ada.jpg")
        );
        let bare: PersonRow =
            serde_json::from_value(json!({ "id": "p2", "name": "Bo" })).expect("bare row");
        assert_eq!(bare.avatar_url, None);

        let person: PersonDetail = serde_json::from_value(json!({
            "id": "p1",
            "name": "Ada",
            "avatarUrl": "https://static-cdn.jtvnw.net/ada.png",
            "accounts": [],
            "streams": 3,
            "messages": 40,
            "inARow": 2,
            "bestInARow": 2,
            "regular": true,
            "support": {},
            "note": "",
            "status": "normal",
        }))
        .expect("person");
        assert_eq!(
            person.avatar_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/ada.png")
        );
    }
}
