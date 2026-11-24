//! "My Buddies" (plan 170 D16, `lib/buddy-library-view.ts`): the account
//! library as the backend keeps it (`cohost.library.get`, and
//! `cohost.library.changed` after every job), the cards the page draws, and
//! the lines around them. Pure: the store ([`super::store`]) runs the jobs.

use serde::{Deserialize, Serialize};
use videorc_protocol::cohost::{CohostPersona, CohostPersonaSource};

use super::copy;

/// `BUDDY_DEFAULT_OFFICIAL_ID`: what an untouched default persona wears.
pub const DEFAULT_OFFICIAL_ID: &str = "official:golem";
/// `BUDDY_LIBRARY_LIMIT`.
pub const LIBRARY_LIMIT: u32 = 30;
pub const NAME_MAX_CHARS: usize = 24;
pub const DESCRIPTION_MAX_CHARS: usize = 600;
pub const PERSONALITY_MAX_CHARS: usize = 1200;
pub const CONTEXT_MAX_CHARS: usize = 4000;

/// An official character's pack, as the library lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum OfficialAlive {
    Bundled,
    Downloaded,
    #[default]
    Available,
    None,
}

/// `BuddyOfficialEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialEntry {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub alive: OfficialAlive,
}

/// The cached pictures of one account avatar (`videorc-asset://` URLs).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Poses {
    pub idle: Option<String>,
    pub talk: Option<String>,
    pub laugh: Option<String>,
    pub think: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryAlive {
    pub pack_id: String,
    #[serde(default)]
    pub cell_size: u32,
}

/// One of the account's own Buddies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MineEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub poses: Poses,
    #[serde(default)]
    pub alive: Option<EntryAlive>,
}

/// The library job running now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Busy {
    /// `sync`, `use`, `delete`, `update`, `alive-upload`,
    /// `alive-download` or `import`.
    pub kind: String,
    #[serde(default)]
    pub avatar_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// `BuddyLibraryState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    #[serde(default)]
    pub signed_in: bool,
    #[serde(default)]
    pub official: Vec<OfficialEntry>,
    #[serde(default)]
    pub mine: Option<Vec<MineEntry>>,
    #[serde(default)]
    pub active_avatar_id: Option<String>,
    #[serde(default)]
    pub server_active_avatar_id: Option<String>,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub busy: Option<Busy>,
    #[serde(default)]
    pub error: Option<Problem>,
}

/// The official five as the catalog has them (`BUDDY_OFFICIAL_CATALOG`):
/// id, slug, name, tagline, personality, and whether the pack ships.
pub const OFFICIAL_CATALOG: [(&str, &str, &str, &str, &str, bool); 5] = [
    (
        "official:golem",
        "golem",
        super::DEFAULT_AVATAR_NAME,
        "The original. Steady as stone.",
        "Calm, warm and a little slow to speak. Greets every follower like an old friend and never rushes anyone.",
        true,
    ),
    (
        "official:orc",
        "orc",
        "Golmar",
        "Loud, loyal, all horde.",
        "Loud, loyal and proud of the horde. Cheers every follower like a battle won and calls the chat his warband.",
        false,
    ),
    (
        "official:goblin",
        "goblin",
        "Nib",
        "Small, sly and in on the joke.",
        "Sly, quick and always after a good deal. Loves a joke at the streamer's expense, but never a mean one.",
        false,
    ),
    (
        "official:pirate",
        "pirate",
        "Captain Barnacle",
        "Calls your chat his crew.",
        "Booming and theatrical. Calls viewers his crew, new followers new recruits, and every raid a boarding party.",
        false,
    ),
    (
        "official:robot",
        "robot",
        "Bolt",
        "Polite, precise, loves a stat.",
        "Polite, precise and delighted by every stat. Counts followers out loud and celebrates round numbers.",
        false,
    ),
];

/// The catalog as entries, before the backend answers (`officialAliveFallback`:
/// a bundled pack ships, the others download on use).
pub fn catalog_entries() -> Vec<OfficialEntry> {
    OFFICIAL_CATALOG
        .iter()
        .map(
            |(id, slug, name, tagline, personality, bundled)| OfficialEntry {
                id: (*id).into(),
                slug: (*slug).into(),
                name: (*name).into(),
                kind: String::new(),
                tagline: (*tagline).into(),
                personality: (*personality).into(),
                alive: if *bundled {
                    OfficialAlive::Bundled
                } else {
                    OfficialAlive::Available
                },
            },
        )
        .collect()
}

/// `officialBuddy(id)?.name`.
pub fn official_name(id: &str) -> Option<&'static str> {
    OFFICIAL_CATALOG
        .iter()
        .find(|entry| entry.0 == id)
        .map(|entry| entry.2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardKind {
    Official,
    Mine,
}

/// `BuddyLibraryCard`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub id: String,
    pub kind: CardKind,
    pub name: String,
    /// The tagline, or what was asked for.
    pub subtitle: String,
    /// The personality (shown when it adds to the subtitle).
    pub hint: String,
    /// Official cards carry their slug (the picture is bundled).
    pub slug: Option<String>,
    /// Mine carry a cached idle URL.
    pub idle_url: Option<String>,
    pub active: bool,
    pub busy: bool,
    pub alive: bool,
    pub can_make_alive: bool,
}

impl Card {
    /// A menu shows for your own and for one you can make Alive.
    pub fn has_menu(&self) -> bool {
        self.kind == CardKind::Mine || self.can_make_alive
    }

    /// The detail line shows only when it adds to the subtitle.
    pub fn detail(&self) -> Option<&str> {
        (!self.hint.is_empty() && self.hint != self.subtitle).then_some(self.hint.as_str())
    }
}

/// `BuddyLibraryView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryView {
    pub signed_in: bool,
    pub official: Vec<Card>,
    /// None when signed out or not loaded (the group shows its line).
    pub mine: Option<Vec<Card>>,
    /// The account's choice, picked on videorc.com, that sync would not apply.
    pub picked_elsewhere: Option<(String, String)>,
    pub syncing: bool,
    pub busy: bool,
    pub error: Option<String>,
}

/// `buddyPersonaLibraryId`: what the persona wears before the library
/// answers: its link, else the untouched default.
pub fn persona_library_id(persona: Option<&CohostPersona>) -> Option<String> {
    let persona = persona?;
    if let Some(id) = &persona.library_avatar_id {
        return Some(id.clone());
    }
    (persona.source == CohostPersonaSource::Default).then(|| DEFAULT_OFFICIAL_ID.to_string())
}

/// `buddyLibraryView`: the official five (always), then the account's own,
/// newest first, with the active one marked.
pub fn library_view(
    library: Option<&LibraryState>,
    persona: Option<&CohostPersona>,
) -> LibraryView {
    let active_id = match library {
        Some(library) => library.active_avatar_id.clone(),
        None => persona_library_id(persona),
    };
    let busy_id = library
        .and_then(|library| library.busy.as_ref())
        .and_then(|busy| busy.avatar_id.clone());
    let official_entries = match library {
        Some(library) if !library.official.is_empty() => library.official.clone(),
        _ => catalog_entries(),
    };
    let official = official_entries
        .into_iter()
        .map(|entry| Card {
            active: Some(&entry.id) == active_id.as_ref(),
            busy: Some(&entry.id) == busy_id.as_ref(),
            alive: entry.alive != OfficialAlive::None,
            can_make_alive: entry.alive == OfficialAlive::None,
            kind: CardKind::Official,
            subtitle: entry.tagline,
            hint: entry.personality,
            slug: Some(entry.slug),
            idle_url: None,
            name: entry.name,
            id: entry.id,
        })
        .collect();
    let signed_in = library.is_some_and(|library| library.signed_in);
    let mine = library
        .and_then(|library| library.mine.as_ref())
        .filter(|_| signed_in)
        .map(|mine| {
            mine.iter()
                .map(|entry| Card {
                    id: entry.id.clone(),
                    kind: CardKind::Mine,
                    name: entry.name.clone(),
                    subtitle: entry.description.clone(),
                    hint: entry.description.clone(),
                    slug: None,
                    idle_url: entry.poses.idle.clone(),
                    active: Some(&entry.id) == active_id.as_ref(),
                    busy: Some(&entry.id) == busy_id.as_ref(),
                    alive: entry.alive.is_some(),
                    can_make_alive: entry.alive.is_none(),
                })
                .collect()
        });
    let picked_elsewhere = library.and_then(|library| {
        let server = library.server_active_avatar_id.as_ref()?;
        let name = official_name(server).map(str::to_string).or_else(|| {
            library
                .mine
                .as_ref()?
                .iter()
                .find(|entry| &entry.id == server)
                .map(|entry| entry.name.clone())
        })?;
        (Some(server) != active_id.as_ref()).then(|| (server.clone(), name))
    });
    let busy = library.and_then(|library| library.busy.as_ref());
    LibraryView {
        signed_in,
        official,
        mine,
        picked_elsewhere,
        syncing: busy.is_some_and(|busy| busy.kind == "sync"),
        busy: busy.is_some(),
        error: library
            .and_then(|library| library.error.as_ref())
            .map(|error| error.message.clone()),
    }
}

/// `buddyAliveTagDistinguishes`: only when the group holds both kinds.
pub fn alive_tag_distinguishes(cards: &[Card]) -> bool {
    cards.iter().any(|card| card.alive) && cards.iter().any(|card| !card.alive)
}

/// `buddyLibraryBusyLine`: whose moves download or upload, or which Buddy
/// is being saved; None for the other jobs (their card spinner says enough).
pub fn busy_line(library: Option<&LibraryState>, persona_name: Option<&str>) -> Option<String> {
    let library = library?;
    let busy = library.busy.as_ref()?;
    let name_of = |id: Option<&String>| -> Option<String> {
        let id = id?;
        library
            .official
            .iter()
            .find(|entry| &entry.id == id)
            .map(|entry| entry.name.clone())
            .or_else(|| official_name(id).map(str::to_string))
            .or_else(|| {
                library
                    .mine
                    .as_ref()?
                    .iter()
                    .find(|entry| &entry.id == id)
                    .map(|entry| entry.name.clone())
            })
    };
    let name = name_of(busy.avatar_id.as_ref())
        .or_else(|| persona_name.map(str::to_string))
        .unwrap_or_else(|| super::DEFAULT_AVATAR_NAME.to_string());
    match busy.kind.as_str() {
        "alive-download" => Some(copy::library_alive_downloading(&name)),
        "alive-upload" => Some(copy::library_alive_uploading(&name)),
        "import" => Some(copy::library_importing(persona_name.unwrap_or(&name))),
        _ => None,
    }
}

/// `buddyLibrarySaveOffer`: a Buddy made only here, signed in, the web
/// keeps imports, not being saved already. The Buddy's name for the line.
pub fn save_offer(
    library: Option<&LibraryState>,
    persona: Option<&CohostPersona>,
    library_alive: bool,
) -> Option<String> {
    let (library, persona) = (library?, persona?);
    if !library.signed_in || library.mine.is_none() {
        return None;
    }
    if library
        .busy
        .as_ref()
        .is_some_and(|busy| busy.kind == "import")
    {
        return None;
    }
    if library.active_avatar_id.is_some() || persona.library_avatar_id.is_some() {
        return None;
    }
    persona.images.idle.as_ref()?;
    if !library_alive {
        return None;
    }
    let name = persona.name.trim();
    Some(
        if name.is_empty() {
            super::DEFAULT_AVATAR_NAME
        } else {
            name
        }
        .to_string(),
    )
}

/// `buddyInvitationVisible`: only while the persona is the untouched
/// default Buddy and the streamer has not closed it.
pub fn invitation_visible(
    library: Option<&LibraryState>,
    persona: Option<&CohostPersona>,
    dismissed: bool,
) -> bool {
    let (Some(library), Some(persona)) = (library, persona) else {
        return false;
    };
    !dismissed
        && library.active_avatar_id.as_deref() == Some(DEFAULT_OFFICIAL_ID)
        && persona.library_avatar_id.is_none()
        && persona.source == CohostPersonaSource::Default
}

/// `buddyTextLength`: characters as a person counts them.
pub fn text_length(value: &str) -> usize {
    value.chars().count()
}

/// `buddyOnboardingName`: trimmed, 1 to 24 characters.
pub fn name_to_send(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || text_length(trimmed) > NAME_MAX_CHARS {
        return None;
    }
    Some(trimmed.to_string())
}

/// `buddyLibraryLimit`: the web's, else the library's, else 30.
pub fn library_limit(web_limit: Option<u32>, library: Option<&LibraryState>) -> u32 {
    web_limit
        .or_else(|| {
            library
                .map(|library| library.limit)
                .filter(|limit| *limit > 0)
        })
        .unwrap_or(LIBRARY_LIMIT)
}

/// `buddyLibraryIsFull`.
pub fn library_is_full(
    web_limit: Option<u32>,
    web_count: Option<u32>,
    library: Option<&LibraryState>,
) -> bool {
    let limit = library_limit(web_limit, library);
    let count = web_count.unwrap_or_else(|| {
        library
            .and_then(|library| library.mine.as_ref())
            .map_or(0, |mine| mine.len() as u32)
    });
    limit > 0 && count >= limit
}

/// The edit dialog (Rename, Edit personality): what Save sends, when it may.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditKind {
    Rename,
    Personality,
}

/// The edit dialog's form: what was saved and what is typed now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditForm {
    pub kind: EditKind,
    pub avatar_id: String,
    pub saved_name: String,
    pub saved_personality: String,
    pub saved_context: String,
    pub name: String,
    pub personality: String,
    pub context: String,
}

impl EditForm {
    /// `cohost.library.update`'s params from the form, or None while Save
    /// is off (nothing changed, or a field is out of bounds).
    pub fn update_params(&self) -> Option<serde_json::Value> {
        let mut params = serde_json::Map::new();
        params.insert("avatarId".into(), self.avatar_id.clone().into());
        match self.kind {
            EditKind::Rename => {
                let name = name_to_send(&self.name)?;
                if name == self.saved_name {
                    return None;
                }
                params.insert("name".into(), name.into());
            }
            EditKind::Personality => {
                if text_length(&self.personality) > PERSONALITY_MAX_CHARS
                    || text_length(&self.context) > CONTEXT_MAX_CHARS
                {
                    return None;
                }
                if self.personality == self.saved_personality && self.context == self.saved_context
                {
                    return None;
                }
                if self.personality != self.saved_personality {
                    params.insert("personality".into(), self.personality.trim().into());
                }
                if self.context != self.saved_context {
                    params.insert("context".into(), self.context.trim().into());
                }
            }
        }
        Some(serde_json::Value::Object(params))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog is the backend's and the web's (`buddy-official-catalog.json`).
    #[test]
    fn the_official_catalog_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol-fixtures/buddy-official-catalog.json"
        ))
        .unwrap();
        let avatars = fixture["avatars"].as_array().unwrap();
        assert_eq!(avatars.len(), OFFICIAL_CATALOG.len());
        for ((id, slug, name, tagline, personality, ships), avatar) in
            OFFICIAL_CATALOG.iter().zip(avatars)
        {
            assert_eq!(avatar["id"], *id);
            assert_eq!(avatar["slug"], *slug);
            assert_eq!(avatar["name"], *name, "{id}");
            assert_eq!(avatar["tagline"], *tagline, "{id}");
            assert_eq!(avatar["personality"], *personality, "{id}");
            assert_eq!(
                avatar["alive"]["bundled"].as_bool().unwrap_or(false),
                *ships,
                "{id}"
            );
        }
    }

    fn state(json: serde_json::Value) -> LibraryState {
        serde_json::from_value(json).unwrap()
    }

    fn default_persona() -> CohostPersona {
        CohostPersona::default()
    }

    #[test]
    fn before_the_backend_answers_the_catalog_and_the_default_stand_in() {
        let view = library_view(None, Some(&default_persona()));
        assert_eq!(view.official.len(), 5);
        assert_eq!(view.official[0].name, "Flint");
        assert!(view.official[0].active);
        assert!(
            view.official
                .iter()
                .all(|card| card.alive && !card.has_menu())
        );
        assert_eq!(view.mine, None);
        assert!(!alive_tag_distinguishes(&view.official));
        assert_eq!(view.official[3].subtitle, "Calls your chat his crew.");
    }

    #[test]
    fn signed_in_lists_mine_newest_first_and_marks_the_active_one() {
        let library = state(serde_json::json!({
            "signedIn": true,
            "official": [],
            "mine": [
                { "id": "a", "name": "Grum", "description": "a grumpy rock",
                  "personality": "", "context": "", "createdAt": "", "updatedAt": "",
                  "poses": { "idle": "videorc-asset://buddy/library/a/idle-1.png",
                             "talk": null, "laugh": null, "think": null },
                  "alive": null }
            ],
            "activeAvatarId": "a",
            "serverActiveAvatarId": "official:orc",
            "limit": 30,
            "busy": { "kind": "alive-download", "avatarId": "official:orc" }
        }));
        let view = library_view(Some(&library), None);
        let mine = view.mine.unwrap();
        assert!(mine[0].active && mine[0].can_make_alive && mine[0].has_menu());
        assert_eq!(mine[0].detail(), None);
        assert_eq!(
            view.picked_elsewhere,
            Some(("official:orc".into(), "Golmar".into()))
        );
        assert!(view.busy && !view.syncing);
        assert!(view.official[1].busy);
        assert_eq!(
            busy_line(Some(&library), Some("Grum")).as_deref(),
            Some("Downloading Golmar's moves.")
        );
    }

    #[test]
    fn the_invitation_shows_only_for_the_untouched_default() {
        let library = state(serde_json::json!({
            "signedIn": false, "official": [], "mine": null,
            "activeAvatarId": "official:golem", "serverActiveAvatarId": null,
            "limit": 30, "busy": null
        }));
        assert!(invitation_visible(
            Some(&library),
            Some(&default_persona()),
            false
        ));
        assert!(!invitation_visible(
            Some(&library),
            Some(&default_persona()),
            true
        ));
        let linked = CohostPersona {
            library_avatar_id: Some("official:orc".into()),
            ..default_persona()
        };
        assert!(!invitation_visible(Some(&library), Some(&linked), false));
        assert!(!invitation_visible(None, Some(&default_persona()), false));
    }

    #[test]
    fn names_and_edits_follow_the_limits() {
        assert_eq!(name_to_send("  Grum "), Some("Grum".into()));
        assert_eq!(name_to_send("   "), None);
        assert_eq!(name_to_send(&"x".repeat(25)), None);
        let form = |kind: EditKind, name: &str, personality: &str| EditForm {
            kind,
            avatar_id: "a".into(),
            saved_name: "Grum".into(),
            saved_personality: "x".into(),
            saved_context: "y".into(),
            name: name.into(),
            personality: personality.into(),
            context: "y".into(),
        };
        assert_eq!(form(EditKind::Rename, "Grum", "x").update_params(), None);
        assert_eq!(
            form(EditKind::Rename, "Mossback", "x").update_params(),
            Some(serde_json::json!({ "avatarId": "a", "name": "Mossback" }))
        );
        assert_eq!(
            form(EditKind::Personality, "Grum", " kind ").update_params(),
            Some(serde_json::json!({ "avatarId": "a", "personality": "kind" }))
        );
        assert!(!library_is_full(None, None, None));
    }
}
