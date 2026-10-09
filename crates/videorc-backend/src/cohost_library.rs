//! The Golem library (plan 170 D12, D13): one account library shared by
//! videorc.com and the app, plus Videorc's official avatars.
//!
//! The renderer sees it through `cohost.library.get` (the cached state, no
//! network) and the `cohost.library.changed` event; `cohost.library.sync`,
//! `use`, `update` and `delete` answer at once and report by that event.
//!
//! This is the contract slice: the wire types, the official catalog (equal to
//! `protocol-fixtures/golem-official-catalog.json`, a test pins it), the
//! persisted sync clock and `cohost.library.get` from what this process
//! already knows. Until the library is wired to videorc-web, `sync`, `use`,
//! `update` and `delete` check their params and refuse with
//! `cohost-library-not-implemented`, so nothing half-works silently.

use serde::{Deserialize, Serialize};

use crate::cohost::{CohostPersona, CohostPersonaSource};
use crate::protocol::{AccountStatus, CohostAvatarErrorDetail};
use crate::state::AppState;
use crate::storage::Database;

/// The event that carries the whole `GolemLibraryState` after every change.
#[allow(dead_code)] // emitted once the library is wired (plan 170 Phase D backend)
pub const COHOST_LIBRARY_CHANGED_EVENT: &str = "cohost.library.changed";
/// At most this many avatars per account (D4, owner-confirmed); the web may
/// say otherwise in its capabilities.
pub const GOLEM_LIBRARY_LIMIT: u32 = 30;
/// A persona's `libraryAvatarId` is at most this long (a uuid is 36).
pub const GOLEM_LIBRARY_ID_MAX_CHARS: usize = 64;
pub const GOLEM_OFFICIAL_ID_PREFIX: &str = "official:";
/// The backend-private `app_settings` row holding the sync clock. It never
/// crosses to the renderer.
#[allow(dead_code)] // read and written by sync (plan 170 Phase D backend)
pub const GOLEM_LIBRARY_SYNC_KEY: &str = "golemLibrarySync";

/// A library id is neither a user avatar's uuid nor a known official one.
pub const COHOST_LIBRARY_INVALID: &str = "cohost-library-invalid";
/// The library RPC is registered but not wired to videorc-web yet.
pub const COHOST_LIBRARY_NOT_IMPLEMENTED: &str = "cohost-library-not-implemented";

// --- The official catalog ----------------------------------------------------------

/// Videorc's official avatars (D10, D11), in catalog order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GolemOfficialSlug {
    Golem,
    Orc,
    Goblin,
    Pirate,
    Robot,
}

impl GolemOfficialSlug {
    pub const ALL: [Self; 5] = [
        Self::Golem,
        Self::Orc,
        Self::Goblin,
        Self::Pirate,
        Self::Robot,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Golem => "golem",
            Self::Orc => "orc",
            Self::Goblin => "goblin",
            Self::Pirate => "pirate",
            Self::Robot => "robot",
        }
    }

    pub fn parse(slug: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|known| known.as_str() == slug)
    }

    /// `official:<slug>`.
    pub fn id(self) -> String {
        format!("{GOLEM_OFFICIAL_ID_PREFIX}{}", self.as_str())
    }
}

/// One catalog row. `description` is what the image model was asked for;
/// the Golem's art is the owner's original, so it has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GolemOfficial {
    pub slug: GolemOfficialSlug,
    pub name: &'static str,
    pub kind: &'static str,
    pub tagline: &'static str,
    pub personality: &'static str,
    #[allow(dead_code)] // read by the catalog test and the official art script's mirror
    pub description: Option<&'static str>,
}

/// Plan 170 D10, D11: equal to `protocol-fixtures/golem-official-catalog.json`.
pub const GOLEM_OFFICIAL_CATALOG: [GolemOfficial; 5] = [
    GolemOfficial {
        slug: GolemOfficialSlug::Golem,
        name: "Golem",
        kind: "Golem",
        tagline: "The original. Steady as stone.",
        personality: "Calm, warm and a little slow to speak. Greets every follower like an old friend and never rushes anyone.",
        description: None,
    },
    GolemOfficial {
        slug: GolemOfficialSlug::Orc,
        name: "Golmar",
        kind: "Orc",
        tagline: "Loud, loyal, all horde.",
        personality: "Loud, loyal and proud of the horde. Cheers every follower like a battle won and calls the chat his warband.",
        description: Some(
            "a burly, friendly green orc with small tusks, a braided top-knot, leather shoulder guards and a wide grin",
        ),
    },
    GolemOfficial {
        slug: GolemOfficialSlug::Goblin,
        name: "Nib",
        kind: "Goblin",
        tagline: "Small, sly and in on the joke.",
        personality: "Sly, quick and always after a good deal. Loves a joke at the streamer's expense, but never a mean one.",
        description: Some(
            "a small cheeky yellow-green goblin with huge pointed ears, a patched vest and a coin pouch on his belt",
        ),
    },
    GolemOfficial {
        slug: GolemOfficialSlug::Pirate,
        name: "Captain Barnacle",
        kind: "Pirate",
        tagline: "Calls your chat his crew.",
        personality: "Booming and theatrical. Calls viewers his crew, new followers new recruits, and every raid a boarding party.",
        description: Some(
            "a jolly round pirate captain with a tricorn hat, an eye patch, a striped shirt and a big bushy beard",
        ),
    },
    GolemOfficial {
        slug: GolemOfficialSlug::Robot,
        name: "Bolt",
        kind: "Robot",
        tagline: "Polite, precise, loves a stat.",
        personality: "Polite, precise and delighted by every stat. Counts followers out loud and celebrates round numbers.",
        description: Some(
            "a rounded retro robot with a screen for a face showing simple glowing eyes, a short antenna and chunky metal hands",
        ),
    },
];

/// The slug of a known `official:<slug>` id, or None for anything else.
pub fn official_slug_from_id(id: &str) -> Option<GolemOfficialSlug> {
    id.strip_prefix(GOLEM_OFFICIAL_ID_PREFIX)
        .and_then(GolemOfficialSlug::parse)
}

/// A user avatar id: the web's lowercase hyphenated uuid.
pub fn user_avatar_id_ok(id: &str) -> bool {
    crate::cohost_avatar::request_id_ok(id)
}

/// A library id this build can act on: a user avatar or a known official one.
pub fn library_id_ok(id: &str) -> bool {
    user_avatar_id_ok(id) || official_slug_from_id(id).is_some()
}

/// What `cohostSettings.persona.libraryAvatarId` may hold: 1 to 64 of
/// `[a-z0-9:-]` (a uuid or `official:<slug>`, including a slug a newer build
/// knows). Saved rows are never re-validated on load.
pub fn persona_link_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= GOLEM_LIBRARY_ID_MAX_CHARS
        && id
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b':'))
}

// --- Wire types ------------------------------------------------------------------------

/// An official avatar as `GolemLibraryState.official` lists it; its pictures
/// are bundled with the app, addressed by slug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemOfficialEntry {
    pub id: String,
    pub slug: GolemOfficialSlug,
    pub name: String,
    pub kind: String,
    pub tagline: String,
    pub personality: String,
}

impl From<&GolemOfficial> for GolemOfficialEntry {
    fn from(official: &GolemOfficial) -> Self {
        Self {
            id: official.slug.id(),
            slug: official.slug,
            name: official.name.to_string(),
            kind: official.kind.to_string(),
            tagline: official.tagline.to_string(),
            personality: official.personality.to_string(),
        }
    }
}

/// The cached pictures of one account avatar: managed
/// `videorc-asset://golem/library/<id>/<state>-<tag>.png` URLs. Each state is
/// always present and null until cached (the renderer schema is nullable
/// here, not optional).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemLibraryPoses {
    pub idle: Option<String>,
    pub talk: Option<String>,
    pub laugh: Option<String>,
    pub think: Option<String>,
}

/// One avatar of the account's own library, as the app caches it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemLibraryEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub personality: String,
    pub context: String,
    pub created_at: String,
    pub updated_at: String,
    pub poses: GolemLibraryPoses,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GolemLibraryBusyKind {
    Sync,
    Use,
    Delete,
    Update,
}

/// The library job running now; `avatarId` absent (never null) for a sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemLibraryBusy {
    pub kind: GolemLibraryBusyKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_id: Option<String>,
}

/// `cohost.library.get` and `cohost.library.changed`. `mine`,
/// `activeAvatarId`, `serverActiveAvatarId` and `busy` are nullable on the
/// wire (always sent, null when none); `error` is optional (absent, never
/// null).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemLibraryState {
    pub signed_in: bool,
    pub official: Vec<GolemOfficialEntry>,
    /// Newest first; None when signed out or never loaded.
    pub mine: Option<Vec<GolemLibraryEntry>>,
    /// What the persona is linked to, or `official:golem` for the untouched
    /// default; None for a Golem made only on this computer.
    pub active_avatar_id: Option<String>,
    /// The account's choice when it differs and sync would not apply it.
    pub server_active_avatar_id: Option<String>,
    pub limit: u32,
    pub busy: Option<GolemLibraryBusy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CohostAvatarErrorDetail>,
}

/// Why a sync runs (D12, D18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GolemLibrarySyncReason {
    Launch,
    Tab,
    Focus,
    DeepLink,
    Manual,
}

/// `cohost.library.sync`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostLibrarySyncParams {
    pub reason: GolemLibrarySyncReason,
}

/// `cohost.library.use` (a user avatar or a known official id) and
/// `cohost.library.delete` (a user avatar only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostLibraryAvatarParams {
    pub avatar_id: String,
}

/// `cohost.library.update`: one of the account's own avatars, at least one
/// field (official avatars are read-only on the server).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostLibraryUpdateParams {
    pub avatar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// What the library mutations answer at once: always `{ "accepted": true }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohostLibraryAccepted {
    pub accepted: bool,
}

/// The sync clock (D12): the account profile's `updatedAt` as last applied
/// or seen. Backend-private (`app_settings` row `golemLibrarySync`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemLibrarySync {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_updated_at: Option<String>,
}

/// Why a library RPC was refused before anything changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohostLibraryRefusal {
    pub code: String,
    pub message: String,
}

impl CohostLibraryRefusal {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

// --- The sync clock ----------------------------------------------------------------------

/// The stored sync clock; the default when none is stored or the row is
/// unreadable (the next sync then treats the account's choice as new).
#[allow(dead_code)] // read by sync (plan 170 Phase D backend)
pub fn load_library_sync(database: &Database) -> GolemLibrarySync {
    match database.load_setting::<GolemLibrarySync>(GOLEM_LIBRARY_SYNC_KEY) {
        Ok(Some(sync)) => sync,
        Ok(None) => GolemLibrarySync::default(),
        Err(error) => {
            tracing::warn!("Could not read the Golem library sync clock: {error:#}");
            GolemLibrarySync::default()
        }
    }
}

#[allow(dead_code)] // written by sync, use and delete (plan 170 Phase D backend)
pub fn save_library_sync(database: &Database, sync: &GolemLibrarySync) -> anyhow::Result<()> {
    database.save_setting(GOLEM_LIBRARY_SYNC_KEY, sync)
}

// --- State ---------------------------------------------------------------------------------

/// The library id the persona wears: its link when this build knows it, the
/// default Golem for the untouched default, else None (a Golem made only on
/// this computer, or a link from a newer build).
pub fn active_avatar_id(persona: &CohostPersona) -> Option<String> {
    match persona.library_avatar_id.as_deref() {
        Some(id) if library_id_ok(id) => Some(id.to_string()),
        Some(_) => None,
        None if persona.source == CohostPersonaSource::Default => {
            Some(GolemOfficialSlug::Golem.id())
        }
        None => None,
    }
}

/// The state before anything was loaded from the account: the official
/// catalog, the persona's link, and no account avatars.
pub fn unloaded_state(signed_in: bool, persona: &CohostPersona) -> GolemLibraryState {
    GolemLibraryState {
        signed_in,
        official: GOLEM_OFFICIAL_CATALOG
            .iter()
            .map(GolemOfficialEntry::from)
            .collect(),
        mine: None,
        active_avatar_id: active_avatar_id(persona),
        server_active_avatar_id: None,
        limit: GOLEM_LIBRARY_LIMIT,
        busy: None,
        error: None,
    }
}

/// `cohost.library.get`: the library as this process knows it, without the
/// network. Until sync is wired the account's avatars are never loaded, so
/// `mine` is null signed in or out.
pub async fn get(state: &AppState) -> GolemLibraryState {
    let signed_in = {
        let session = state.account_session.lock().await;
        crate::account::current_account(session.as_ref()).status == AccountStatus::SignedIn
    };
    let persona = state.cohost.lock().await.settings().persona.clone();
    unloaded_state(signed_in, &persona)
}

// --- Mutations (registered; wired by the backend slice) -------------------------------------

fn not_implemented(method: &str) -> CohostLibraryRefusal {
    CohostLibraryRefusal::new(
        COHOST_LIBRARY_NOT_IMPLEMENTED,
        format!("{method} is not available in this build yet (plan 170 Phase D)."),
    )
}

fn check_user_avatar(id: &str) -> Result<(), CohostLibraryRefusal> {
    if user_avatar_id_ok(id) {
        Ok(())
    } else {
        Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "Only your own avatars can be changed or deleted.",
        ))
    }
}

/// `cohost.library.sync`.
pub async fn sync(
    _state: &AppState,
    _params: CohostLibrarySyncParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    Err(not_implemented("cohost.library.sync"))
}

/// `cohost.library.use`.
pub async fn use_avatar(
    _state: &AppState,
    params: CohostLibraryAvatarParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    if !library_id_ok(&params.avatar_id) {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "That avatar is not in your library or Videorc's.",
        ));
    }
    Err(not_implemented("cohost.library.use"))
}

/// `cohost.library.update`.
pub async fn update(
    _state: &AppState,
    params: CohostLibraryUpdateParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    check_user_avatar(&params.avatar_id)?;
    if params.name.is_none() && params.personality.is_none() && params.context.is_none() {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "Change the name, the personality or About you.",
        ));
    }
    Err(not_implemented("cohost.library.update"))
}

/// `cohost.library.delete`.
pub async fn delete(
    _state: &AppState,
    params: CohostLibraryAvatarParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    check_user_avatar(&params.avatar_id)?;
    Err(not_implemented("cohost.library.delete"))
}

#[cfg(test)]
mod tests {
    use tokio::sync::broadcast;

    use super::*;

    const AVATAR: &str = "7c9e6679-7425-40de-944b-e07fc1ee9a51";

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn high_risk_fixture(pointer: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("shared high-risk protocol fixture must be valid JSON");
        fixture
            .pointer(pointer)
            .unwrap_or_else(|| panic!("shared protocol fixture is missing {pointer}"))
            .clone()
    }

    fn round_trips<T: serde::de::DeserializeOwned + Serialize>(pointer: &str) -> T {
        let wire = high_risk_fixture(pointer);
        let value: T = serde_json::from_value(wire.clone())
            .unwrap_or_else(|error| panic!("{pointer}: {error}"));
        assert_eq!(serde_json::to_value(&value).unwrap(), wire, "{pointer}");
        value
    }

    /// The catalog equals the shared fixture, field for field (D10).
    #[test]
    fn golem_official_catalog_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/golem-official-catalog.json"
        ))
        .expect("the official catalog fixture must be valid JSON");
        assert_eq!(fixture["version"], 1);
        let avatars = fixture["avatars"].as_array().unwrap();
        assert_eq!(avatars.len(), GOLEM_OFFICIAL_CATALOG.len());
        for (row, official) in avatars.iter().zip(GOLEM_OFFICIAL_CATALOG.iter()) {
            assert_eq!(row["slug"], official.slug.as_str());
            assert_eq!(row["id"], official.slug.id());
            assert_eq!(row["name"], official.name);
            assert_eq!(row["kind"], official.kind);
            assert_eq!(row["tagline"], official.tagline);
            assert_eq!(row["personality"], official.personality);
            assert_eq!(row["description"].as_str(), official.description);
        }
        let slugs: Vec<_> = GOLEM_OFFICIAL_CATALOG.iter().map(|row| row.slug).collect();
        assert_eq!(slugs, GolemOfficialSlug::ALL);
    }

    #[test]
    fn golem_library_ids_are_user_uuids_or_known_official_slugs() {
        assert_eq!(
            official_slug_from_id("official:pirate"),
            Some(GolemOfficialSlug::Pirate)
        );
        for bad in ["official:dragon", "official:", "golem", AVATAR] {
            assert_eq!(official_slug_from_id(bad), None, "{bad}");
        }
        assert!(library_id_ok(AVATAR));
        assert!(library_id_ok("official:robot"));
        for bad in [
            "official:dragon",
            "",
            "../official:golem",
            "7C9E6679-7425-40DE-944B-E07FC1EE9A51",
        ] {
            assert!(!library_id_ok(bad), "{bad}");
        }
        // A persona link may name a slug a newer build knows.
        assert!(persona_link_ok("official:dragon"));
        assert!(!persona_link_ok("official:Dragon"));
    }

    /// Every library RPC and the event round-trip exactly as the TypeScript
    /// contract validates them (plan 170 Phase D).
    #[test]
    fn shared_high_risk_contract_fixture_matches_golem_library_dtos() {
        for pointer in [
            "/golemLibrary/signedOut",
            "/golemLibrary/signedIn",
            "/golemLibrary/localOnly",
        ] {
            round_trips::<GolemLibraryState>(pointer);
        }
        let signed_in: GolemLibraryState = round_trips("/golemLibrary/signedIn");
        assert_eq!(
            signed_in.mine.as_ref().unwrap()[1].poses,
            GolemLibraryPoses::default()
        );
        let sync: CohostLibrarySyncParams = round_trips("/golemLibrary/syncParams");
        assert_eq!(sync.reason, GolemLibrarySyncReason::DeepLink);
        round_trips::<CohostLibraryAvatarParams>("/golemLibrary/useParams");
        round_trips::<CohostLibraryAvatarParams>("/golemLibrary/useOfficialParams");
        round_trips::<CohostLibraryUpdateParams>("/golemLibrary/updateParams");
        round_trips::<CohostLibraryAvatarParams>("/golemLibrary/deleteParams");
        let accepted: CohostLibraryAccepted = round_trips("/golemLibrary/accepted");
        assert!(accepted.accepted);
        assert!(
            serde_json::from_value::<CohostLibrarySyncParams>(
                serde_json::json!({ "reason": "timer" })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<CohostLibraryAvatarParams>(
                serde_json::json!({ "avatarId": AVATAR, "extra": 1 })
            )
            .is_err()
        );
    }

    #[test]
    fn golem_library_active_id_follows_the_persona_link() {
        let mut persona = CohostPersona::default();
        assert_eq!(
            active_avatar_id(&persona).as_deref(),
            Some("official:golem")
        );
        persona.source = CohostPersonaSource::Uploaded;
        assert_eq!(active_avatar_id(&persona), None);
        persona.library_avatar_id = Some(AVATAR.to_string());
        assert_eq!(active_avatar_id(&persona).as_deref(), Some(AVATAR));
        persona.library_avatar_id = Some("official:dragon".to_string());
        assert_eq!(active_avatar_id(&persona), None);
    }

    #[tokio::test]
    async fn golem_library_get_signed_out_is_the_official_catalog_and_the_default() {
        let state = test_state();
        *state.account_session.lock().await = Some(crate::account::signed_out_account());
        let library = get(&state).await;
        assert_eq!(
            serde_json::to_value(&library).unwrap(),
            high_risk_fixture("/golemLibrary/signedOut")
        );
    }

    #[tokio::test]
    async fn golem_library_mutations_check_their_ids_then_say_not_implemented() {
        let state = test_state();
        let refused = sync(
            &state,
            CohostLibrarySyncParams {
                reason: GolemLibrarySyncReason::Manual,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, COHOST_LIBRARY_NOT_IMPLEMENTED);
        let unknown = use_avatar(
            &state,
            CohostLibraryAvatarParams {
                avatar_id: "official:dragon".to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.code, COHOST_LIBRARY_INVALID);
        let official = delete(
            &state,
            CohostLibraryAvatarParams {
                avatar_id: "official:golem".to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(official.code, COHOST_LIBRARY_INVALID);
        let empty = update(
            &state,
            CohostLibraryUpdateParams {
                avatar_id: AVATAR.to_string(),
                name: None,
                personality: None,
                context: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(empty.code, COHOST_LIBRARY_INVALID);
        let pending = update(
            &state,
            CohostLibraryUpdateParams {
                avatar_id: AVATAR.to_string(),
                name: Some("Grum".to_string()),
                personality: None,
                context: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(pending.code, COHOST_LIBRARY_NOT_IMPLEMENTED);
    }

    #[test]
    fn golem_library_sync_clock_defaults_and_round_trips() {
        let database = Database::open_in_memory_for_tests();
        assert_eq!(load_library_sync(&database), GolemLibrarySync::default());
        let sync = GolemLibrarySync {
            profile_updated_at: Some("2026-10-09T10:05:00.000Z".to_string()),
        };
        save_library_sync(&database, &sync).unwrap();
        assert_eq!(load_library_sync(&database), sync);
        assert_eq!(
            serde_json::to_value(&sync).unwrap(),
            serde_json::json!({ "profileUpdatedAt": "2026-10-09T10:05:00.000Z" })
        );
        assert_eq!(
            serde_json::to_value(GolemLibrarySync::default()).unwrap(),
            serde_json::json!({})
        );
    }
}
