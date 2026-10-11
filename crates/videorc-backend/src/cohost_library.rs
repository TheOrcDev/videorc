//! The Buddy library (plan 170 D12, D13): one account library shared by
//! videorc.com and the app, plus Videorc's official avatars.
//!
//! The renderer reads it with `cohost.library.get` (the cached state, no
//! network) and follows `cohost.library.changed`, which carries the whole
//! state after every change. `cohost.library.sync`, `use`, `update` and
//! `delete` answer at once (the websocket mutation lane's 10 s rule); the web
//! work runs on a task, one library job at a time, in the order accepted (a
//! `use` sent right after a `sync` runs after it).
//!
//! - **Pictures**: the account's pictures are cached under the buddy write
//!   root as `library/<avatarId>/<state>-<tag>.png` (the tag is the web pose
//!   URL's `v`, so a changed picture gets a new path); main serves them under
//!   `videorc-asset://buddy/`. Each idle is cached on sync, the rest on use.
//! - **Apply** (use, sync, keep): the poses become the persona's still
//!   pictures (`<personaId>/<state>-<tag>.<ext>`, plan 169), the name and
//!   personality follow, a non-empty "About you" becomes the Buddy's notes,
//!   the persona wears Still and links `libraryAvatarId`. Official avatars
//!   apply from the bundled art (the Buddy is the default set), with the
//!   catalog's name and personality and the notes untouched. A failed
//!   download changes nothing.
//! - **Sync** (D12): when the account's choice is newer than the stored
//!   clock and differs from the persona's link, it applies to a linked or
//!   untouched default Buddy; a Buddy made only on this computer is never
//!   overwritten (the choice is offered as `serverActiveAvatarId`); nothing
//!   applies while a recording or stream runs (it waits for the session to
//!   end). Local edits of a linked avatar's name, personality or notes are
//!   pushed with `PATCH` after about 2 s (last write wins).
//! - **Signed out** or the library off: `mine` is null and nothing changes;
//!   official avatars still apply.
//! - **Alive** (plan 172): official Buddies wear their packs, account Buddies
//!   carry theirs between computers, and a Buddy made here can join the
//!   library; see [`alive`].

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};

use crate::buddy_pet::BuddyAvatar;
use crate::cohost::{
    CohostAvatarState, CohostPersona, CohostPersonaImages, CohostPersonaSource, CohostSettings,
};
use crate::cohost_avatar::{ALL_STATES, blocking, store_error};
use crate::protocol::{
    AccountStatus, AiCapabilitiesBuddyLibrary, CohostAvatarErrorDetail, CohostSettingsPatch,
};
use crate::state::AppState;
use crate::storage::Database;
use crate::videorc_api::{
    BuddyLibraryWebAvatar, BuddyLibraryWebPatch, CohostApiError, CohostApiErrorKind,
    VideorcApiClient,
};

/// The event that carries the whole `BuddyLibraryState` after every change.
pub const COHOST_LIBRARY_CHANGED_EVENT: &str = "cohost.library.changed";
/// At most this many avatars per account (D4, owner-confirmed); the web's
/// capabilities and list say what the account's cap is.
pub const BUDDY_LIBRARY_LIMIT: u32 = 30;
/// A persona's `libraryAvatarId` is at most this long (a uuid is 36).
pub const BUDDY_LIBRARY_ID_MAX_CHARS: usize = 64;
pub const BUDDY_OFFICIAL_ID_PREFIX: &str = "official:";
/// The backend-private `app_settings` row holding the sync clock. It never
/// crosses to the renderer.
pub const BUDDY_LIBRARY_SYNC_KEY: &str = "buddyLibrarySync";

/// A library id is neither a user avatar's uuid nor a known official one.
pub const COHOST_LIBRARY_INVALID: &str = "cohost-library-invalid";
/// The account library is off (an older web, or its storage unconfigured).
pub const COHOST_LIBRARY_UNAVAILABLE: &str = "cohost-library-unavailable";
/// No Videorc session on this computer.
pub const COHOST_LIBRARY_SIGNED_OUT: &str = "signed-out";
/// The cache folder under the buddy write root (`buddy-assets.ts` mirrors it).
pub const BUDDY_LIBRARY_CACHE_DIR: &str = "library";

/// A focus sync runs at most once a minute (D12).
const FOCUS_SYNC_INTERVAL: Duration = Duration::from_secs(60);
/// Local edits of a linked avatar are pushed this long after the last one.
const PATCH_DEBOUNCE: Duration = Duration::from_secs(2);
/// How often a choice held back by a live session checks whether it ended.
const LIVE_POLL: Duration = Duration::from_secs(2);
/// Idle pictures downloaded at once during a sync.
const CACHE_CONCURRENCY: usize = 4;

// --- The official catalog ----------------------------------------------------------

/// Videorc's official avatars (D10, D11), in catalog order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyOfficialSlug {
    Golem,
    Orc,
    Goblin,
    Pirate,
    Robot,
}

impl BuddyOfficialSlug {
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
        format!("{BUDDY_OFFICIAL_ID_PREFIX}{}", self.as_str())
    }
}

/// One catalog row. `description` is what the image model was asked for;
/// Buddy the Golem's art is the owner's original, so it has none. `alive`
/// is the character's official pack (plan 172 D4), None until it ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuddyOfficial {
    pub slug: BuddyOfficialSlug,
    pub name: &'static str,
    pub kind: &'static str,
    pub tagline: &'static str,
    pub personality: &'static str,
    #[allow(dead_code)] // read by the catalog test and the official art script's mirror
    pub description: Option<&'static str>,
    pub alive: Option<BuddyOfficialAlive>,
}

/// One file of an official pack, as the catalog pins it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuddyOfficialAliveFile {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// An official character's alive pack (plan 172 D4): `bundled:buddy` ships
/// inside the app; the others (`official:<slug>`) download from
/// `/buddy/official/<slug>/alive/<version>/<name>` the first time they are
/// used, verified file by file against this row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuddyOfficialAlive {
    pub version: u32,
    pub pack_id: &'static str,
    pub bundled: bool,
    #[allow(dead_code)] // the catalog test checks it against the fixture
    pub cell_size: u32,
    #[allow(dead_code)] // the catalog test checks it against the fixture
    pub frames: u32,
    pub files: &'static [BuddyOfficialAliveFile],
}

impl BuddyOfficialAlive {
    pub(crate) fn to_spec(self) -> alive::OfficialAliveSpec {
        alive::OfficialAliveSpec {
            version: self.version,
            pack_id: self.pack_id.to_string(),
            bundled: self.bundled,
            files: self
                .files
                .iter()
                .map(|file| alive::AliveFileSpec {
                    name: file.name.to_string(),
                    bytes: file.bytes,
                    sha256: file.sha256.to_string(),
                })
                .collect(),
        }
    }
}

/// Plan 170 D10, D11: equal to `protocol-fixtures/buddy-official-catalog.json`.
pub const BUDDY_OFFICIAL_CATALOG: [BuddyOfficial; 5] = [
    BuddyOfficial {
        slug: BuddyOfficialSlug::Golem,
        name: "Buddy",
        kind: "Golem",
        tagline: "The original. Steady as stone.",
        personality: "Calm, warm and a little slow to speak. Greets every follower like an old friend and never rushes anyone.",
        description: None,
        alive: Some(BuddyOfficialAlive {
            version: 1,
            pack_id: "bundled:buddy",
            bundled: true,
            cell_size: 640,
            frames: 40,
            files: &[
                BuddyOfficialAliveFile {
                    name: "manifest.json",
                    bytes: 8000,
                    sha256: "fd1e4cb03d537136b792586747a565b44a249e2284bb35cd715ac7da1db8fce4",
                },
                BuddyOfficialAliveFile {
                    name: "mascot.webp",
                    bytes: 1618096,
                    sha256: "a3d5f512ae23381ae2295da817d2e3118145b1986ea906a8fad59647a0eef71c",
                },
                BuddyOfficialAliveFile {
                    name: "buddy.json",
                    bytes: 241,
                    sha256: "a832d39fe8b9ad29ed0c575d242664619e3716f70da98b710c83d3edfad8201f",
                },
            ],
        }),
    },
    BuddyOfficial {
        slug: BuddyOfficialSlug::Orc,
        name: "Golmar",
        kind: "Orc",
        tagline: "Loud, loyal, all horde.",
        personality: "Loud, loyal and proud of the horde. Cheers every follower like a battle won and calls the chat his warband.",
        description: Some(
            "a burly, friendly green orc with small tusks, a braided top-knot, leather shoulder guards and a wide grin",
        ),
        alive: Some(BuddyOfficialAlive {
            version: 1,
            pack_id: "official:orc",
            bundled: false,
            cell_size: 640,
            frames: 40,
            files: &[
                BuddyOfficialAliveFile {
                    name: "manifest.json",
                    bytes: 8001,
                    sha256: "72f0cdb6908516fb09d1b10b9f416e8d59a2b8b2530f4288361edfdc5fc65693",
                },
                BuddyOfficialAliveFile {
                    name: "mascot.webp",
                    bytes: 1400912,
                    sha256: "71966f94042b2f69b4618a9384dd8e1ffa75302f672ab9a4da202e703ed97410",
                },
                BuddyOfficialAliveFile {
                    name: "buddy.json",
                    bytes: 241,
                    sha256: "ddc2fbf5748bce6165b666c6bbc6086cfbf94bc06352a97f8ebeaa634f58f62e",
                },
            ],
        }),
    },
    BuddyOfficial {
        slug: BuddyOfficialSlug::Goblin,
        name: "Nib",
        kind: "Goblin",
        tagline: "Small, sly and in on the joke.",
        personality: "Sly, quick and always after a good deal. Loves a joke at the streamer's expense, but never a mean one.",
        description: Some(
            "a small cheeky yellow-green goblin with huge pointed ears, a patched vest and a coin pouch on his belt",
        ),
        alive: Some(BuddyOfficialAlive {
            version: 1,
            pack_id: "official:goblin",
            bundled: false,
            cell_size: 640,
            frames: 40,
            files: &[
                BuddyOfficialAliveFile {
                    name: "manifest.json",
                    bytes: 7998,
                    sha256: "9c80f9dfc715322763816a0d60539afc4347905de3a5b36663339ab3df926c83",
                },
                BuddyOfficialAliveFile {
                    name: "mascot.webp",
                    bytes: 1494608,
                    sha256: "ab30105f92c04ead861a23cab9c88a8c068ea3a1bb2fee24fc67c301c3f051e1",
                },
                BuddyOfficialAliveFile {
                    name: "buddy.json",
                    bytes: 241,
                    sha256: "a79619ed5e0ba539b1988626450e1b7f8fd2d6c3709c09a1aa189c03dfb40c8f",
                },
            ],
        }),
    },
    BuddyOfficial {
        slug: BuddyOfficialSlug::Pirate,
        name: "Captain Barnacle",
        kind: "Pirate",
        tagline: "Calls your chat his crew.",
        personality: "Booming and theatrical. Calls viewers his crew, new followers new recruits, and every raid a boarding party.",
        description: Some(
            "a jolly round pirate captain with a tricorn hat, an eye patch, a striped shirt and a big bushy beard",
        ),
        alive: Some(BuddyOfficialAlive {
            version: 1,
            pack_id: "official:pirate",
            bundled: false,
            cell_size: 640,
            frames: 40,
            files: &[
                BuddyOfficialAliveFile {
                    name: "manifest.json",
                    bytes: 8011,
                    sha256: "661e205bb7ecb6f378c547c4337418630eb47fd6829540f212e5f70dcbc3eff4",
                },
                BuddyOfficialAliveFile {
                    name: "mascot.webp",
                    bytes: 1357372,
                    sha256: "da53d27ad21ac6e293bef9ef6ff0145a257840fa09dd270dd56e55e4d8618fa7",
                },
                BuddyOfficialAliveFile {
                    name: "buddy.json",
                    bytes: 241,
                    sha256: "116e539792c321a67f582d6625d77a1645075c5d5668c104c64f2a8009c6ba71",
                },
            ],
        }),
    },
    BuddyOfficial {
        slug: BuddyOfficialSlug::Robot,
        name: "Bolt",
        kind: "Robot",
        tagline: "Polite, precise, loves a stat.",
        personality: "Polite, precise and delighted by every stat. Counts followers out loud and celebrates round numbers.",
        description: Some(
            "a rounded retro robot with a screen for a face showing simple glowing eyes, a short antenna and chunky metal hands",
        ),
        alive: Some(BuddyOfficialAlive {
            version: 1,
            pack_id: "official:robot",
            bundled: false,
            cell_size: 640,
            frames: 40,
            files: &[
                BuddyOfficialAliveFile {
                    name: "manifest.json",
                    bytes: 7999,
                    sha256: "f89efc2c8b1a546b25381a53280dab08ee6b7c5d03205ea956709ddbefba7433",
                },
                BuddyOfficialAliveFile {
                    name: "mascot.webp",
                    bytes: 1300458,
                    sha256: "7ecff00c66964cc7811764b00cb1652dbc2687dd2857068b414a88e56b3dfdd8",
                },
                BuddyOfficialAliveFile {
                    name: "buddy.json",
                    bytes: 241,
                    sha256: "11359b1294c35134f3e1dde5d13e98c5d76df032205b7b15f59e97fdeb044e61",
                },
            ],
        }),
    },
];

/// The slug of a known `official:<slug>` id, or None for anything else.
pub fn official_slug_from_id(id: &str) -> Option<BuddyOfficialSlug> {
    id.strip_prefix(BUDDY_OFFICIAL_ID_PREFIX)
        .and_then(BuddyOfficialSlug::parse)
}

/// The version of a downloadable official pack (`official:<slug>`, plan 172
/// D4) as the catalog pins it; None for an unknown slug, a character without
/// a pack, or one that ships bundled.
pub fn official_pack_version(slug: &str) -> Option<u32> {
    let slug = BuddyOfficialSlug::parse(slug)?;
    official_buddy(slug)
        .alive
        .filter(|alive| !alive.bundled)
        .map(|alive| alive.version)
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
        && id.len() <= BUDDY_LIBRARY_ID_MAX_CHARS
        && id
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b':'))
}

// --- Wire types ------------------------------------------------------------------------

/// Where an official character's alive pack is on this computer (plan 172
/// D4, D12): it ships inside the app, it was downloaded and verified, it
/// downloads the first time the Buddy is used, or it has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyOfficialAliveState {
    Bundled,
    Downloaded,
    Available,
    None,
}

/// An official avatar as `BuddyLibraryState.official` lists it; its pictures
/// are bundled with the app, addressed by slug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyOfficialEntry {
    pub id: String,
    pub slug: BuddyOfficialSlug,
    pub name: String,
    pub kind: String,
    pub tagline: String,
    pub personality: String,
    pub alive: BuddyOfficialAliveState,
}

impl BuddyOfficialEntry {
    fn of(official: &BuddyOfficial, alive: BuddyOfficialAliveState) -> Self {
        Self {
            id: official.slug.id(),
            slug: official.slug,
            name: official.name.to_string(),
            kind: official.kind.to_string(),
            tagline: official.tagline.to_string(),
            personality: official.personality.to_string(),
            alive,
        }
    }
}

/// The cached pictures of one account avatar: managed
/// `videorc-asset://buddy/library/<id>/<state>-<tag>.png` URLs. Each state is
/// always present and null until cached (the renderer schema is nullable
/// here, not optional).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryPoses {
    pub idle: Option<String>,
    pub talk: Option<String>,
    pub laugh: Option<String>,
    pub think: Option<String>,
}

/// An account Buddy's alive pack as the renderer sees it (plan 172 D9): the
/// pack it wears once applied, and its cell size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryEntryAlive {
    pub pack_id: String,
    pub cell_size: u32,
}

/// One avatar of the account's own library, as the app caches it. `alive`
/// is always sent (null when it has no pack).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub personality: String,
    pub context: String,
    pub created_at: String,
    pub updated_at: String,
    pub poses: BuddyLibraryPoses,
    pub alive: Option<BuddyLibraryEntryAlive>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyLibraryBusyKind {
    Sync,
    Use,
    Delete,
    Update,
    /// Plan 172 D10: a Buddy's pack goes to the account.
    AliveUpload,
    /// Plan 172 D4, D10: an official or account pack comes to this computer.
    AliveDownload,
    /// Plan 172 D10: a Buddy made here joins the library.
    Import,
}

/// The library job running now; `avatarId` absent (never null) for a sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryBusy {
    pub kind: BuddyLibraryBusyKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_id: Option<String>,
}

/// `cohost.library.get` and `cohost.library.changed`. `mine`,
/// `activeAvatarId`, `serverActiveAvatarId` and `busy` are nullable on the
/// wire (always sent, null when none); `error` is optional (absent, never
/// null).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryState {
    pub signed_in: bool,
    pub official: Vec<BuddyOfficialEntry>,
    /// Newest first; None when signed out or never loaded.
    pub mine: Option<Vec<BuddyLibraryEntry>>,
    /// What the persona is linked to, or `official:golem` for the untouched
    /// default; None for a Buddy made only on this computer.
    pub active_avatar_id: Option<String>,
    /// The account's choice when it differs and sync would not apply it.
    pub server_active_avatar_id: Option<String>,
    pub limit: u32,
    pub busy: Option<BuddyLibraryBusy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CohostAvatarErrorDetail>,
}

/// Why a sync runs (D12, D18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyLibrarySyncReason {
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
    pub reason: BuddyLibrarySyncReason,
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
/// or seen. Backend-private (`app_settings` row `buddyLibrarySync`), with
/// the alive bookkeeping of plan 172 D10.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibrarySync {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_updated_at: Option<String>,
    /// The account pack last applied for the linked Buddy (or none): sync
    /// downloads a pack only when the account's differs, so a Buddy switched
    /// to Still here stays Still.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alive_seen: Option<BuddyLibraryAliveSeen>,
    /// A pack upload or removal the account has not heard of yet; the next
    /// sync tries again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_alive: Option<BuddyLibraryPendingAlive>,
}

/// Which account pack the linked Buddy was last given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryAliveSeen {
    pub avatar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyLibraryPendingAction {
    Upload,
    Delete,
}

/// The latest pack change made here for a linked Buddy, until the account has it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyLibraryPendingAlive {
    pub avatar_id: String,
    pub pack_id: String,
    pub action: BuddyLibraryPendingAction,
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
pub fn load_library_sync(database: &Database) -> BuddyLibrarySync {
    match database.load_setting::<BuddyLibrarySync>(BUDDY_LIBRARY_SYNC_KEY) {
        Ok(Some(sync)) => sync,
        Ok(None) => BuddyLibrarySync::default(),
        Err(error) => {
            tracing::warn!("Could not read the Buddy library sync clock: {error:#}");
            BuddyLibrarySync::default()
        }
    }
}

pub fn save_library_sync(database: &Database, sync: &BuddyLibrarySync) -> anyhow::Result<()> {
    database.save_setting(BUDDY_LIBRARY_SYNC_KEY, sync)
}

fn store_clock(state: &AppState, profile_updated_at: Option<String>) {
    if profile_updated_at.is_none() {
        return;
    }
    update_sync(state, |sync| sync.profile_updated_at = profile_updated_at);
}

/// Change the stored sync row in place (one writer at a time, so the clock
/// and the alive bookkeeping never overwrite each other).
pub(crate) fn update_sync(state: &AppState, edit: impl FnOnce(&mut BuddyLibrarySync)) {
    let _row = state
        .buddy_library
        .sync_row
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut sync = load_library_sync(&state.database);
    edit(&mut sync);
    if let Err(error) = save_library_sync(&state.database, &sync) {
        tracing::warn!("Could not save the Buddy library sync clock: {error:#}");
    }
}

/// Whether the account's clock is newer than the stored one: no stored clock
/// means newer; no account clock never is.
fn is_newer(server: Option<&str>, stored: Option<&str>) -> bool {
    let Some(server) = server else {
        return false;
    };
    let Some(stored) = stored else {
        return true;
    };
    match (
        chrono::DateTime::parse_from_rfc3339(server),
        chrono::DateTime::parse_from_rfc3339(stored),
    ) {
        (Ok(server), Ok(stored)) => server > stored,
        _ => server > stored,
    }
}

// --- Official art ----------------------------------------------------------------------------

/// The catalog row of a slug.
pub fn official_buddy(slug: BuddyOfficialSlug) -> &'static BuddyOfficial {
    BUDDY_OFFICIAL_CATALOG
        .iter()
        .find(|official| official.slug == slug)
        .unwrap_or(&BUDDY_OFFICIAL_CATALOG[0])
}

/// An official avatar's bundled pose: the Buddy is the default set (the
/// stream overlay's `BUNDLED_*`), the others ship in the renderer's
/// `assets/buddy/official/<slug>/<state>.webp`, so official avatars apply
/// offline and signed out.
pub(crate) fn official_webp(slug: BuddyOfficialSlug, state: CohostAvatarState) -> &'static [u8] {
    macro_rules! art {
        ($slug:literal, $state:literal) => {
            include_bytes!(concat!(
                "../../../apps/desktop/src/renderer/src/assets/buddy/official/",
                $slug,
                "/",
                $state,
                ".webp"
            ))
        };
    }
    use BuddyOfficialSlug::{Goblin, Golem, Orc, Pirate, Robot};
    use CohostAvatarState::{Idle, Laugh, Talk, Think};
    match (slug, state) {
        (Golem, state) => crate::buddy_pet::bundled_state_webp(state),
        (Orc, Idle) => art!("orc", "idle"),
        (Orc, Talk) => art!("orc", "talk"),
        (Orc, Laugh) => art!("orc", "laugh"),
        (Orc, Think) => art!("orc", "think"),
        (Goblin, Idle) => art!("goblin", "idle"),
        (Goblin, Talk) => art!("goblin", "talk"),
        (Goblin, Laugh) => art!("goblin", "laugh"),
        (Goblin, Think) => art!("goblin", "think"),
        (Pirate, Idle) => art!("pirate", "idle"),
        (Pirate, Talk) => art!("pirate", "talk"),
        (Pirate, Laugh) => art!("pirate", "laugh"),
        (Pirate, Think) => art!("pirate", "think"),
        (Robot, Idle) => art!("robot", "idle"),
        (Robot, Talk) => art!("robot", "talk"),
        (Robot, Laugh) => art!("robot", "laugh"),
        (Robot, Think) => art!("robot", "think"),
    }
}

// --- Process state ---------------------------------------------------------------------------

/// What a library job needs from the process: the write root, the bundled
/// root, the web client and the bearer. Tests fix their own (temp roots, a
/// fake web, and the official packs they pin).
#[derive(Clone, Default)]
pub(crate) struct LibraryEnv {
    pub(crate) root: Option<PathBuf>,
    pub(crate) bundled_root: Option<PathBuf>,
    pub(crate) api: Option<VideorcApiClient>,
    pub(crate) token: Option<String>,
    /// The official packs by slug; None reads the catalog.
    pub(crate) official_alive: Option<Arc<BTreeMap<BuddyOfficialSlug, alive::OfficialAliveSpec>>>,
}

impl LibraryEnv {
    fn process() -> Self {
        let roots = crate::resource_authority::configured_managed_buddy_roots();
        Self {
            root: roots.first().cloned(),
            bundled_root: roots.get(1).cloned(),
            api: VideorcApiClient::new().ok(),
            token: crate::account::stored_session_token(),
            official_alive: None,
        }
    }

    /// An official character's pack: the pinned one in tests, else the catalog's.
    pub(crate) fn official_alive(
        &self,
        slug: BuddyOfficialSlug,
    ) -> Option<alive::OfficialAliveSpec> {
        match &self.official_alive {
            Some(table) => table.get(&slug).cloned(),
            None => official_buddy(slug).alive.map(BuddyOfficialAlive::to_spec),
        }
    }

    fn web(&self) -> Option<(VideorcApiClient, String)> {
        Some((self.api.clone()?, self.token.clone()?))
    }

    fn root(&self) -> Result<PathBuf, CohostAvatarErrorDetail> {
        self.root.clone().ok_or_else(|| {
            CohostAvatarErrorDetail::new(
                crate::cohost_avatar::COHOST_AVATAR_ROOT_UNCONFIGURED,
                "The Buddy's image folder is not configured.",
            )
        })
    }
}

/// The library's clocks; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LibraryTiming {
    pub(crate) focus_interval: Duration,
    pub(crate) patch_debounce: Duration,
    pub(crate) live_poll: Duration,
}

impl Default for LibraryTiming {
    fn default() -> Self {
        Self {
            focus_interval: FOCUS_SYNC_INTERVAL,
            patch_debounce: PATCH_DEBOUNCE,
            live_poll: LIVE_POLL,
        }
    }
}

/// The account's choice, held back while a recording or stream runs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingApply {
    avatar_id: String,
    profile_updated_at: Option<String>,
}

#[derive(Default)]
struct LibraryCache {
    /// The web's library capability; None until the first read.
    capability: Option<AiCapabilitiesBuddyLibrary>,
    /// The account's avatars as the web last listed them, newest first;
    /// None when signed out or never loaded.
    web: Option<Vec<BuddyLibraryWebAvatar>>,
    /// The cached pictures of each, by avatar id.
    poses: BTreeMap<String, BuddyLibraryPoses>,
    /// The account's choice a local-only Buddy was not overwritten with.
    offer: Option<String>,
    busy: Option<BuddyLibraryBusy>,
    error: Option<CohostAvatarErrorDetail>,
    limit: Option<u32>,
    last_sync: Option<Instant>,
    pending_apply: Option<PendingApply>,
    pending_patch: Option<(String, BuddyLibraryWebPatch)>,
}

/// The library's process state (`AppState::buddy_library`).
pub struct LibraryShared {
    cache: StdMutex<LibraryCache>,
    /// One library job at a time, in the order accepted.
    jobs: tokio::sync::Mutex<()>,
    /// Jobs accepted and not finished (queued or running).
    jobs_pending: AtomicUsize,
    sync_queued: AtomicBool,
    watcher_running: AtomicBool,
    patch_generation: AtomicU64,
    /// One writer of the stored sync row at a time.
    sync_row: StdMutex<()>,
    fixed_env: Option<LibraryEnv>,
    timing: LibraryTiming,
}

impl Default for LibraryShared {
    fn default() -> Self {
        Self::new()
    }
}

impl LibraryShared {
    pub fn new() -> Self {
        Self {
            cache: StdMutex::new(LibraryCache::default()),
            jobs: tokio::sync::Mutex::new(()),
            jobs_pending: AtomicUsize::new(0),
            sync_queued: AtomicBool::new(false),
            watcher_running: AtomicBool::new(false),
            patch_generation: AtomicU64::new(0),
            sync_row: StdMutex::new(()),
            fixed_env: None,
            timing: LibraryTiming::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_tests(env: LibraryEnv, timing: LibraryTiming) -> Self {
        Self {
            fixed_env: Some(env),
            timing,
            ..Self::new()
        }
    }

    pub(crate) fn env(&self) -> LibraryEnv {
        self.fixed_env.clone().unwrap_or_else(LibraryEnv::process)
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, LibraryCache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The web says the account library is on (signed in, storage configured).
    pub(crate) fn enabled(&self) -> bool {
        self.cache()
            .capability
            .as_ref()
            .is_some_and(|capability| capability.enabled)
    }

    /// The web syncs alive packs and imports (plan 172 D8): its storage is S3.
    pub(crate) fn alive_sync(&self) -> bool {
        self.cache()
            .capability
            .as_ref()
            .is_some_and(|capability| capability.enabled && capability.alive)
    }

    /// The capability is known to be off (as opposed to not read yet).
    fn known_disabled(&self) -> bool {
        self.cache()
            .capability
            .as_ref()
            .is_some_and(|capability| !capability.enabled)
    }
}

// --- State -----------------------------------------------------------------------------------

/// The library id the persona wears: its link when this build knows it, the
/// default Buddy for the untouched default, else None (a Buddy made only on
/// this computer, or a link from a newer build).
pub fn active_avatar_id(persona: &CohostPersona) -> Option<String> {
    match persona.library_avatar_id.as_deref() {
        Some(id) if library_id_ok(id) => Some(id.to_string()),
        Some(_) => None,
        None if persona.source == CohostPersonaSource::Default => {
            Some(BuddyOfficialSlug::Golem.id())
        }
        None => None,
    }
}

/// The untouched default: the bundled Buddy, never linked.
fn untouched_default(persona: &CohostPersona) -> bool {
    persona.library_avatar_id.is_none() && persona.source == CohostPersonaSource::Default
}

fn official_entries(
    states: &BTreeMap<BuddyOfficialSlug, BuddyOfficialAliveState>,
) -> Vec<BuddyOfficialEntry> {
    BUDDY_OFFICIAL_CATALOG
        .iter()
        .map(|official| {
            BuddyOfficialEntry::of(
                official,
                states
                    .get(&official.slug)
                    .copied()
                    .unwrap_or(BuddyOfficialAliveState::None),
            )
        })
        .collect()
}

/// The web's avatar as the renderer contract bounds it (the web keeps the
/// same bounds; this only guards the strict schema).
fn entry_of(
    avatar: &BuddyLibraryWebAvatar,
    poses: Option<&BuddyLibraryPoses>,
) -> BuddyLibraryEntry {
    use crate::cohost::truncate_utf16;
    BuddyLibraryEntry {
        id: avatar.id.clone(),
        name: library_name(&avatar.name).unwrap_or_else(|| "Buddy".to_string()),
        description: truncate_utf16(&avatar.description, 600),
        personality: truncate_utf16(&avatar.personality, 1200),
        context: truncate_utf16(&avatar.context, 4000),
        created_at: avatar.created_at.clone(),
        updated_at: avatar.updated_at.clone(),
        poses: poses.cloned().unwrap_or_default(),
        alive: alive::usable_alive(avatar).map(|alive| BuddyLibraryEntryAlive {
            pack_id: alive.pack_id.clone(),
            cell_size: alive.cell_size,
        }),
    }
}

/// A name as the persona takes it: trimmed, at most 24 UTF-16 units, never empty.
fn library_name(name: &str) -> Option<String> {
    let name = crate::cohost::truncate_utf16(name.trim(), 24)
        .trim()
        .to_string();
    (!name.is_empty()).then_some(name)
}

/// An avatar the desktop can show and cache: a lowercase uuid, timestamps,
/// and pose paths on the API host.
fn web_avatar_ok(avatar: &BuddyLibraryWebAvatar) -> bool {
    let timestamp_ok = |value: &str| !value.is_empty() && value.len() <= 128;
    user_avatar_id_ok(&avatar.id)
        && timestamp_ok(&avatar.created_at)
        && timestamp_ok(&avatar.updated_at)
        && ALL_STATES.iter().all(|state| {
            avatar
                .poses
                .get(*state)
                .is_none_or(|pose| crate::videorc_api::buddy_pose_path_ok(&pose.url))
        })
}

async fn signed_in(state: &AppState) -> bool {
    let session = state.account_session.lock().await;
    crate::account::current_account(session.as_ref()).status == AccountStatus::SignedIn
}

async fn current_persona(state: &AppState) -> CohostPersona {
    state.cohost.lock().await.settings().persona.clone()
}

async fn session_live(state: &AppState) -> bool {
    state.recording.lock().await.is_some()
}

/// `cohost.library.get`: the library as this process knows it, without the
/// network.
pub async fn get(state: &AppState) -> BuddyLibraryState {
    let signed_in = signed_in(state).await;
    let persona = current_persona(state).await;
    let active = active_avatar_id(&persona);
    let env = state.buddy_library.env();
    let states = blocking(move || Ok(alive::official_states(&env)))
        .await
        .unwrap_or_default();
    let cache = state.buddy_library.cache();
    let mine = if signed_in {
        cache.web.as_ref().map(|avatars| {
            avatars
                .iter()
                .map(|avatar| entry_of(avatar, cache.poses.get(&avatar.id)))
                .collect()
        })
    } else {
        None
    };
    BuddyLibraryState {
        signed_in,
        official: official_entries(&states),
        mine,
        active_avatar_id: active.clone(),
        server_active_avatar_id: cache
            .offer
            .clone()
            .filter(|offer| library_id_ok(offer) && Some(offer) != active.as_ref()),
        limit: cache
            .limit
            .filter(|limit| *limit > 0)
            .unwrap_or(BUDDY_LIBRARY_LIMIT),
        busy: cache.busy.clone(),
        error: cache.error.clone(),
    }
}

async fn emit_changed(state: &AppState) {
    let snapshot = get(state).await;
    state.emit_event(COHOST_LIBRARY_CHANGED_EVENT, snapshot);
}

/// The one line the library shows for a failed web call.
pub(crate) fn library_error(error: &CohostApiError) -> CohostAvatarErrorDetail {
    let code = error.detail.code.as_str();
    let message = match code {
        "unauthorized" => "Sign in again to use your Buddy library.".to_string(),
        "buddy-storage-unconfigured" | "cohost-disabled" | "ai-gateway-not-configured" => {
            "The Buddy library is not available right now.".to_string()
        }
        "buddy-not-found" => "That Buddy is not in your library any more.".to_string(),
        "network" => "Could not reach Videorc. Check your connection and try again.".to_string(),
        "timeout" => "Videorc took too long to answer. Try again.".to_string(),
        _ if error.kind == CohostApiErrorKind::MalformedResponse => {
            "Videorc answered in a way this app does not read. Update Videorc.".to_string()
        }
        _ => error.detail.message.clone(),
    };
    CohostAvatarErrorDetail::new_owned(error.detail.code.clone(), message)
}

fn signed_out_detail() -> CohostAvatarErrorDetail {
    CohostAvatarErrorDetail::new(
        COHOST_LIBRARY_SIGNED_OUT,
        "Sign in to use your Buddy library.",
    )
}

// --- Jobs ------------------------------------------------------------------------------------

fn accepted() -> CohostLibraryAccepted {
    CohostLibraryAccepted { accepted: true }
}

/// Run `work` as a library job: after every earlier one, with `busy` set
/// and an event at its start and its end. A failure becomes the state's
/// `error` until the next job starts.
fn spawn_job<F, Fut>(state: &AppState, busy: BuddyLibraryBusy, work: F)
where
    F: FnOnce(AppState) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), CohostAvatarErrorDetail>> + Send + 'static,
{
    let state = state.clone();
    state
        .buddy_library
        .jobs_pending
        .fetch_add(1, Ordering::AcqRel);
    tokio::spawn(async move {
        let shared = state.buddy_library.clone();
        let _turn = shared.jobs.lock().await;
        {
            let mut cache = shared.cache();
            cache.busy = Some(busy);
            cache.error = None;
        }
        emit_changed(&state).await;
        let outcome = work(state.clone()).await;
        {
            let mut cache = shared.cache();
            cache.busy = None;
            if let Err(error) = outcome {
                state.emit_log(
                    "warn",
                    format!("Buddy library: {} ({})", error.message, error.code),
                );
                cache.error = Some(error);
            }
        }
        emit_changed(&state).await;
        shared.jobs_pending.fetch_sub(1, Ordering::AcqRel);
    });
}

fn busy(kind: BuddyLibraryBusyKind, avatar_id: Option<&str>) -> BuddyLibraryBusy {
    BuddyLibraryBusy {
        kind,
        avatar_id: avatar_id.map(str::to_string),
    }
}

/// The account library is reachable: a session and, once the web said so,
/// the library on.
fn check_library(state: &AppState) -> Result<(), CohostLibraryRefusal> {
    if state.buddy_library.env().token.is_none() {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_SIGNED_OUT,
            "Sign in to use your Buddy library.",
        ));
    }
    if state.buddy_library.known_disabled() {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_UNAVAILABLE,
            "The Buddy library is not available right now.",
        ));
    }
    Ok(())
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

// --- cohost.library.sync -----------------------------------------------------------------------

/// `cohost.library.sync`.
pub async fn sync(
    state: &AppState,
    params: CohostLibrarySyncParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    request_sync(state, params.reason);
    Ok(accepted())
}

/// Queue a sync: a focus sync at most once a minute, and never two waiting.
pub(crate) fn request_sync(state: &AppState, reason: BuddyLibrarySyncReason) {
    let shared = state.buddy_library.clone();
    if reason == BuddyLibrarySyncReason::Focus
        && shared
            .cache()
            .last_sync
            .is_some_and(|at| at.elapsed() < shared.timing.focus_interval)
    {
        return;
    }
    if shared.sync_queued.swap(true, Ordering::AcqRel) {
        return;
    }
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Sync, None),
        move |state| async move {
            state
                .buddy_library
                .sync_queued
                .store(false, Ordering::Release);
            run_sync(&state).await
        },
    );
}

async fn run_sync(state: &AppState) -> Result<(), CohostAvatarErrorDetail> {
    let shared = state.buddy_library.clone();
    shared.cache().last_sync = Some(Instant::now());
    let env = shared.env();
    // Signed in, but the web's capability was never read in this process
    // (the web was unreachable when the app started): the list is tried
    // anyway, so an unreachable web says so instead of the library looking
    // empty. A library the web says is off stays quiet.
    let unread = !shared.enabled() && !shared.known_disabled();
    let web = env.web().filter(|_| shared.enabled() || unread);
    let off = |shared: &LibraryShared| {
        // Signed out or the library off: nothing changes, nothing is listed.
        let mut cache = shared.cache();
        cache.web = None;
        cache.poses.clear();
        cache.offer = None;
    };
    let Some((api, token)) = web else {
        off(&shared);
        return Ok(());
    };
    let list = match api.get_buddy_library(&token).await {
        Ok(list) => list,
        // Not read, and the web answered but has no library for us (an older
        // web, storage off): as before, the library is off.
        Err(error) if unread && error.kind != CohostApiErrorKind::Network => {
            off(&shared);
            return Ok(());
        }
        Err(error) => return Err(library_error(&error)),
    };
    let avatars: Vec<BuddyLibraryWebAvatar> =
        list.avatars.into_iter().filter(web_avatar_ok).collect();
    let poses = match env.root.clone() {
        Some(root) => {
            let listed = avatars.clone();
            blocking(move || Ok(cached_poses_of(&root, &listed)))
                .await
                .unwrap_or_default()
        }
        None => BTreeMap::new(),
    };
    {
        let mut cache = shared.cache();
        if let Some(limit) = list.limit.filter(|limit| *limit > 0) {
            cache.limit = Some(limit);
        }
        cache.web = Some(avatars.clone());
        cache.poses = poses;
    }
    emit_changed(state).await;
    if let Some(root) = env.root.clone() {
        cache_idles(state, &root, &api, &token, &avatars).await;
        let keep: BTreeSet<String> = avatars.iter().map(|avatar| avatar.id.clone()).collect();
        let _ = blocking(move || {
            prune_cache(&root, &keep);
            Ok(())
        })
        .await;
    }
    decide(
        state,
        &env,
        list.active_avatar_id,
        list.profile_updated_at,
        &avatars,
    )
    .await?;
    // Plan 172 D10: a pack change made here that the account missed, and a
    // pack the linked Buddy gained elsewhere.
    alive::after_sync(state, &avatars).await;
    Ok(())
}

/// D12: apply the account's choice, offer it, or hold it until the session
/// ends.
async fn decide(
    state: &AppState,
    env: &LibraryEnv,
    server_active: Option<String>,
    profile_updated_at: Option<String>,
    avatars: &[BuddyLibraryWebAvatar],
) -> Result<(), CohostAvatarErrorDetail> {
    let shared = state.buddy_library.clone();
    let listed = |id: &str| avatars.iter().any(|avatar| avatar.id == id);
    // A choice this build cannot show (an unknown slug, a missing avatar)
    // reads as none.
    let server_active = server_active
        .filter(|id| official_slug_from_id(id).is_some() || (user_avatar_id_ok(id) && listed(id)));
    let stored = load_library_sync(&state.database).profile_updated_at;
    let newer = is_newer(profile_updated_at.as_deref(), stored.as_deref());
    let mut persona = current_persona(state).await;
    // The linked avatar left the library (deleted elsewhere): the Buddy
    // stays as it is, now only on this computer.
    if let Some(link) = persona.library_avatar_id.clone()
        && user_avatar_id_ok(&link)
        && !listed(&link)
    {
        set_link(state, None).await?;
        persona = current_persona(state).await;
    }
    if server_active.is_some() && server_active == persona.library_avatar_id {
        shared.cache().offer = None;
        if newer {
            store_clock(state, profile_updated_at);
        }
        return Ok(());
    }
    if !newer {
        return Ok(());
    }
    let Some(choice) = server_active else {
        // The account has no choice any more; the Buddy stays.
        shared.cache().offer = None;
        store_clock(state, profile_updated_at);
        return Ok(());
    };
    if persona.library_avatar_id.is_none() && !untouched_default(&persona) {
        // Never overwrite a Buddy made only on this computer: offer it.
        shared.cache().offer = Some(choice);
        return Ok(());
    }
    if session_live(state).await {
        state.emit_log(
            "info",
            "Your Buddy changed on your account; it switches when this session ends.",
        );
        shared.cache().pending_apply = Some(PendingApply {
            avatar_id: choice,
            profile_updated_at,
        });
        ensure_live_watcher(state);
        return Ok(());
    }
    apply_choice(state, env, &choice).await?;
    shared.cache().offer = None;
    store_clock(state, profile_updated_at);
    Ok(())
}

/// Wait for the session to end, then apply the choice it held back.
fn ensure_live_watcher(state: &AppState) {
    let shared = state.buddy_library.clone();
    if shared.watcher_running.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(shared.timing.live_poll).await;
            if shared.cache().pending_apply.is_none() {
                shared.watcher_running.store(false, Ordering::Release);
                return;
            }
            if session_live(&state).await {
                continue;
            }
            shared.watcher_running.store(false, Ordering::Release);
            let pending = shared.cache().pending_apply.take();
            if let Some(pending) = pending {
                spawn_job(
                    &state,
                    busy(BuddyLibraryBusyKind::Sync, None),
                    move |state| async move { apply_pending(&state, pending).await },
                );
            }
            return;
        }
    });
}

async fn apply_pending(
    state: &AppState,
    pending: PendingApply,
) -> Result<(), CohostAvatarErrorDetail> {
    let persona = current_persona(state).await;
    if persona.library_avatar_id.as_deref() == Some(pending.avatar_id.as_str()) {
        store_clock(state, pending.profile_updated_at);
        return Ok(());
    }
    if persona.library_avatar_id.is_none() && !untouched_default(&persona) {
        state.buddy_library.cache().offer = Some(pending.avatar_id);
        return Ok(());
    }
    if session_live(state).await {
        state.buddy_library.cache().pending_apply = Some(pending);
        ensure_live_watcher(state);
        return Ok(());
    }
    let env = state.buddy_library.env();
    apply_choice(state, &env, &pending.avatar_id).await?;
    state.buddy_library.cache().offer = None;
    store_clock(state, pending.profile_updated_at);
    Ok(())
}

// --- cohost.library.use --------------------------------------------------------------------------

/// `cohost.library.use`: make a library or official avatar the Buddy.
/// Official avatars work signed out; the account learns the choice when
/// signed in.
pub async fn use_avatar(
    state: &AppState,
    params: CohostLibraryAvatarParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    let id = params.avatar_id;
    if !library_id_ok(&id) {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "That avatar is not in your library or Videorc's.",
        ));
    }
    if user_avatar_id_ok(&id) {
        check_library(state)?;
    }
    let job_id = id.clone();
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Use, Some(&id)),
        move |state| async move { run_use(&state, &job_id).await },
    );
    Ok(accepted())
}

async fn run_use(state: &AppState, id: &str) -> Result<(), CohostAvatarErrorDetail> {
    let shared = state.buddy_library.clone();
    let env = shared.env();
    apply_choice(state, &env, id).await?;
    {
        // An explicit choice wins over any choice held back or offered.
        let mut cache = shared.cache();
        cache.offer = None;
        cache.pending_apply = None;
    }
    if let Some((api, token)) = env.web().filter(|_| shared.enabled()) {
        select_on_account(state, &api, &token, id).await?;
    }
    Ok(())
}

/// `PUT /api/buddy/profile` and its clock. The Buddy has already changed
/// here; a failure only means the account did not hear of it.
async fn select_on_account(
    state: &AppState,
    api: &VideorcApiClient,
    token: &str,
    id: &str,
) -> Result<(), CohostAvatarErrorDetail> {
    match api.put_buddy_profile(token, Some(id)).await {
        Ok(profile) => {
            store_clock(state, profile.profile_updated_at);
            Ok(())
        }
        Err(error) => {
            let detail = library_error(&error);
            Err(CohostAvatarErrorDetail::new_owned(
                detail.code,
                format!(
                    "Your Buddy changed here, but your Videorc account could not be told: {}",
                    detail.message
                ),
            ))
        }
    }
}

/// Apply an official or account avatar to the persona.
async fn apply_choice(
    state: &AppState,
    env: &LibraryEnv,
    id: &str,
) -> Result<(), CohostAvatarErrorDetail> {
    if let Some(slug) = official_slug_from_id(id) {
        return apply_official(state, env, slug).await;
    }
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let avatar = web_avatar(state, &api, &token, id).await?;
    let pictures = fetch_poses(state, env, &api, &token, &avatar).await?;
    apply_account_avatar(state, env, &avatar, pictures).await
}

/// The account avatar as last listed, or read from the web when it is not.
async fn web_avatar(
    state: &AppState,
    api: &VideorcApiClient,
    token: &str,
    id: &str,
) -> Result<BuddyLibraryWebAvatar, CohostAvatarErrorDetail> {
    let listed = state
        .buddy_library
        .cache()
        .web
        .as_ref()
        .and_then(|avatars| avatars.iter().find(|avatar| avatar.id == id).cloned());
    if let Some(avatar) = listed {
        return Ok(avatar);
    }
    let avatar = api
        .get_buddy_avatar(token, id)
        .await
        .map_err(|error| library_error(&error))?
        .avatar;
    if !web_avatar_ok(&avatar) || avatar.id != id {
        return Err(CohostAvatarErrorDetail::new(
            "malformed-response",
            "Videorc answered in a way this app does not read. Update Videorc.",
        ));
    }
    remember_avatar(state, &avatar);
    Ok(avatar)
}

/// Put `avatar` into the listed library (first when it is new).
fn remember_avatar(state: &AppState, avatar: &BuddyLibraryWebAvatar) {
    let mut cache = state.buddy_library.cache();
    if let Some(avatars) = cache.web.as_mut() {
        match avatars.iter_mut().find(|listed| listed.id == avatar.id) {
            Some(listed) => *listed = avatar.clone(),
            None => avatars.insert(0, avatar.clone()),
        }
    }
}

/// The avatar's four pictures: from the cache when the tag matches, else
/// downloaded (and cached). A missing idle fails the whole apply; another
/// missing state falls back to the idle, as on stream.
async fn fetch_poses(
    state: &AppState,
    env: &LibraryEnv,
    api: &VideorcApiClient,
    token: &str,
    avatar: &BuddyLibraryWebAvatar,
) -> Result<BTreeMap<CohostAvatarState, Vec<u8>>, CohostAvatarErrorDetail> {
    let root = env.root()?;
    let mut pictures = BTreeMap::new();
    for avatar_state in ALL_STATES {
        let Some(pose) = avatar.poses.get(avatar_state) else {
            continue;
        };
        match pose_bytes(
            state,
            &root,
            api,
            token,
            &avatar.id,
            avatar_state,
            &pose.url,
        )
        .await
        {
            Ok(bytes) => {
                pictures.insert(avatar_state, bytes);
            }
            Err(error) if avatar_state == CohostAvatarState::Idle => return Err(error),
            Err(error) => tracing::warn!(
                state = avatar_state.as_str(),
                code = %error.code,
                "a Buddy library pose could not be read; the idle stands in"
            ),
        }
    }
    Ok(pictures)
}

/// One pose's PNG: the cached file when it has the pose's tag, else the
/// web's (written to the cache, best effort).
async fn pose_bytes(
    state: &AppState,
    root: &Path,
    api: &VideorcApiClient,
    token: &str,
    avatar_id: &str,
    avatar_state: CohostAvatarState,
    url: &str,
) -> Result<Vec<u8>, CohostAvatarErrorDetail> {
    let tag = pose_tag(url);
    let file = cache_dir(root, avatar_id).join(cache_file_name(avatar_state, &tag));
    let cached = {
        let file = file.clone();
        blocking(move || {
            if !crate::cohost_avatar::is_regular_file(&file) {
                return Ok(None);
            }
            Ok(std::fs::read(&file)
                .ok()
                .and_then(|bytes| crate::cohost_avatar::checked_png(bytes).ok()))
        })
        .await?
    };
    if let Some(bytes) = cached {
        return Ok(bytes);
    }
    let downloaded = api
        .get_buddy_pose(token, url)
        .await
        .map_err(|error| library_error(&error))?;
    let bytes = blocking(move || crate::cohost_avatar::checked_png(downloaded)).await?;
    cache_pose(state, root, avatar_id, avatar_state, &tag, &bytes).await;
    Ok(bytes)
}

/// Write one pose into the cache and note its URL (best effort: a picture
/// that cannot be cached is still used).
async fn cache_pose(
    state: &AppState,
    root: &Path,
    avatar_id: &str,
    avatar_state: CohostAvatarState,
    tag: &str,
    bytes: &[u8],
) {
    let written = {
        let dir = cache_dir(root, avatar_id);
        let name = cache_file_name(avatar_state, tag);
        let bytes = bytes.to_vec();
        blocking(move || write_cached_pose(&dir, avatar_state, &name, &bytes)).await
    };
    match written {
        Ok(()) => {
            let mut cache = state.buddy_library.cache();
            let poses = cache.poses.entry(avatar_id.to_string()).or_default();
            set_pose(
                poses,
                avatar_state,
                Some(pose_url(avatar_id, avatar_state, tag)),
            );
        }
        Err(error) => tracing::warn!(code = %error.code, "a Buddy library picture was not cached"),
    }
}

/// Download each listed avatar's idle that is not cached yet, a few at once.
async fn cache_idles(
    state: &AppState,
    root: &Path,
    api: &VideorcApiClient,
    token: &str,
    avatars: &[BuddyLibraryWebAvatar],
) {
    let missing: Vec<(String, String)> = {
        let cache = state.buddy_library.cache();
        avatars
            .iter()
            .filter(|avatar| {
                cache
                    .poses
                    .get(&avatar.id)
                    .is_none_or(|poses| poses.idle.is_none())
            })
            .map(|avatar| (avatar.id.clone(), avatar.poses.idle.url.clone()))
            .collect()
    };
    if missing.is_empty() {
        return;
    }
    // Owned per download, so the stream holds no borrowed state.
    let downloads = missing.into_iter().map(|(id, url)| {
        let state = state.clone();
        let root = root.to_path_buf();
        let api = api.clone();
        let token = token.to_string();
        async move {
            pose_bytes(
                &state,
                &root,
                &api,
                &token,
                &id,
                CohostAvatarState::Idle,
                &url,
            )
            .await
        }
    });
    futures_util::stream::iter(downloads)
        .buffer_unordered(CACHE_CONCURRENCY)
        .for_each(|outcome| {
            if let Err(error) = outcome {
                tracing::warn!(code = %error.code, "a Buddy library idle was not cached");
            }
            std::future::ready(())
        })
        .await;
    emit_changed(state).await;
}

// --- Apply -----------------------------------------------------------------------------------------

/// A random 8 hex digit tag: each applied look gets its own paths, so no
/// surface shows a cached picture of the one before (plan 169).
fn fresh_tag() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// The pictures written as the persona's look, and the earlier state
/// pictures to remove once the persona points at the new ones.
struct WrittenLook {
    images: CohostPersonaImages,
    written: Vec<PathBuf>,
    stale: Vec<PathBuf>,
}

fn write_look(
    root: &Path,
    persona_id: &str,
    pictures: &[(CohostAvatarState, Vec<u8>, &'static str)],
) -> Result<WrittenLook, CohostAvatarErrorDetail> {
    let folder = root.join(persona_id);
    std::fs::create_dir_all(&folder)
        .map_err(|error| store_error("Could not create the Buddy's folder", error))?;
    let tag = fresh_tag();
    let mut images = CohostPersonaImages::default();
    let mut written = Vec::new();
    let mut names = Vec::new();
    for (avatar_state, bytes, extension) in pictures {
        let name = format!("{}-{tag}.{extension}", avatar_state.as_str());
        if let Err(error) = crate::cohost_avatar::write_atomic(&folder, &name, bytes) {
            for file in &written {
                let _ = std::fs::remove_file(file);
            }
            return Err(error);
        }
        crate::cohost_avatar::set_image(
            &mut images,
            *avatar_state,
            Some(format!("{persona_id}/{name}")),
        );
        written.push(folder.join(&name));
        names.push(name);
    }
    let stale = stale_pictures(&folder, &names);
    Ok(WrittenLook {
        images,
        written,
        stale,
    })
}

/// Every state picture in the persona folder but `keep`.
fn stale_pictures(folder: &Path, keep: &[String]) -> Vec<PathBuf> {
    std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|file| {
                    !keep.contains(file)
                        && ALL_STATES
                            .iter()
                            .any(|state| crate::cohost_avatar::is_state_picture(file, *state))
                })
                .map(|file| folder.join(file))
                .collect()
        })
        .unwrap_or_default()
}

/// Save the persona (and the notes) the apply built; a refused save removes
/// the pictures it wrote, a saved one removes the pictures it replaced.
async fn save_applied(
    state: &AppState,
    persona: CohostPersona,
    notes: Option<String>,
    look: WrittenLook,
) -> Result<CohostSettings, CohostAvatarErrorDetail> {
    let saved = crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            persona: Some(persona),
            notes,
            ..CohostSettingsPatch::default()
        },
    )
    .await;
    let (remove, outcome) = match saved {
        Ok(settings) => (look.stale, Ok(settings)),
        Err(error) => (
            look.written,
            Err(CohostAvatarErrorDetail::new_owned(
                error.code().to_string(),
                format!("Your Buddy could not be saved: {error}"),
            )),
        ),
    };
    let _ = blocking(move || {
        for file in remove {
            if let Err(error) = std::fs::remove_file(&file) {
                tracing::warn!(%error, "an earlier Buddy picture could not be removed");
            }
        }
        Ok(())
    })
    .await;
    if outcome.is_ok() {
        // Plan 168 S-B1: the still pet on stream re-reads the persona's images.
        state.buddy_sprite.invalidate();
    }
    outcome
}

/// An account avatar becomes the Buddy: its poses, name, personality, its
/// "About you" as the notes (when it has one), Still, and the link.
async fn apply_account_avatar(
    state: &AppState,
    env: &LibraryEnv,
    avatar: &BuddyLibraryWebAvatar,
    pictures: BTreeMap<CohostAvatarState, Vec<u8>>,
) -> Result<(), CohostAvatarErrorDetail> {
    let root = env.root()?;
    let persona = current_persona(state).await;
    if !crate::cohost_avatar::persona_id_ok(&persona.id) {
        return Err(CohostAvatarErrorDetail::new(
            crate::cohost_avatar::COHOST_AVATAR_INVALID,
            "The persona id is not a plain token.",
        ));
    }
    let look = {
        let persona_id = persona.id.clone();
        let pictures: Vec<_> = pictures
            .into_iter()
            .map(|(avatar_state, bytes)| (avatar_state, bytes, "png"))
            .collect();
        blocking(move || write_look(&root, &persona_id, &pictures)).await?
    };
    // Plan 172 D10: the Buddy's pack comes with it, verified, or it is Still
    // (and the next sync tries the pack again).
    let (wears, alive_problem) = match alive::usable_alive(avatar) {
        Some(pack) => match alive::fetch_account_pack(env, &persona.id, &avatar.id, pack).await {
            Ok(pack_id) => (BuddyAvatar::Alive { pack_id }, None),
            Err(error) => (BuddyAvatar::Still, Some(error)),
        },
        None => (BuddyAvatar::Still, None),
    };
    let mut next = persona;
    next.images = look.images.clone();
    next.source = CohostPersonaSource::Generated;
    next.avatar = wears.clone();
    if let Some(name) = library_name(&avatar.name) {
        next.name = name;
    }
    next.personality = crate::cohost::truncate_utf16(&avatar.personality, 1200);
    next.library_avatar_id = Some(avatar.id.clone());
    let notes = (!avatar.context.trim().is_empty())
        .then(|| crate::cohost::truncate_utf16(&avatar.context, 4000));
    save_applied(state, next, notes, look).await?;
    state.emit_log("info", format!("Buddy is now {}.", avatar.name.trim()));
    match alive_problem {
        None => alive::note_alive_seen(
            state,
            &avatar.id,
            match &wears {
                BuddyAvatar::Alive { pack_id } => Some(pack_id.clone()),
                BuddyAvatar::Still => None,
            },
        ),
        Some(error) => alive::warn(
            state,
            CohostAvatarErrorDetail::new_owned(
                error.code,
                format!(
                    "{} is still for now: its moves could not be downloaded ({}). It tries again at the next sync.",
                    avatar.name.trim(),
                    error.message
                ),
            ),
        ),
    }
    Ok(())
}

/// An official avatar becomes the Buddy from the bundled art: the Buddy is
/// the default set itself, the others are written as the persona's look. The
/// notes stay the user's own.
async fn apply_official(
    state: &AppState,
    env: &LibraryEnv,
    slug: BuddyOfficialSlug,
) -> Result<(), CohostAvatarErrorDetail> {
    let official = official_buddy(slug);
    let persona = current_persona(state).await;
    if !crate::cohost_avatar::persona_id_ok(&persona.id) {
        return Err(CohostAvatarErrorDetail::new(
            crate::cohost_avatar::COHOST_AVATAR_INVALID,
            "The persona id is not a plain token.",
        ));
    }
    let look = match (slug, env.root.clone()) {
        (BuddyOfficialSlug::Golem, root) => {
            let stale = match root {
                Some(root) => {
                    let folder = root.join(&persona.id);
                    blocking(move || Ok(stale_pictures(&folder, &[])))
                        .await
                        .unwrap_or_default()
                }
                None => Vec::new(),
            };
            WrittenLook {
                images: CohostPersonaImages::default(),
                written: Vec::new(),
                stale,
            }
        }
        (_, _) => {
            let root = env.root()?;
            let persona_id = persona.id.clone();
            let pictures: Vec<_> = ALL_STATES
                .iter()
                .map(|avatar_state| {
                    (
                        *avatar_state,
                        official_webp(slug, *avatar_state).to_vec(),
                        "webp",
                    )
                })
                .collect();
            blocking(move || write_look(&root, &persona_id, &pictures)).await?
        }
    };
    // Plan 172 D4, D5: the pack it can wear now (bundled, or downloaded and
    // verified); otherwise Still until the download lands.
    let ready = {
        let env = env.clone();
        blocking(move || Ok(alive::official_ready_pack(&env, slug)))
            .await
            .unwrap_or(None)
    };
    let persona_id = persona.id.clone();
    let mut next = persona;
    next.images = look.images.clone();
    next.source = if slug == BuddyOfficialSlug::Golem {
        CohostPersonaSource::Default
    } else {
        CohostPersonaSource::Generated
    };
    next.avatar = match &ready {
        Some(pack_id) => BuddyAvatar::Alive {
            pack_id: pack_id.clone(),
        },
        None => BuddyAvatar::Still,
    };
    next.name = official.name.to_string();
    next.personality = official.personality.to_string();
    next.library_avatar_id = Some(slug.id());
    save_applied(state, next, None, look).await?;
    state.emit_log("info", format!("Buddy is now {}.", official.name));
    if ready.is_none() && alive::official_downloadable(env, slug) {
        alive::queue_official_download(state, slug, persona_id);
    }
    Ok(())
}

/// Link the persona to `id` (None unlinks it), nothing else changing.
async fn set_link(state: &AppState, id: Option<String>) -> Result<(), CohostAvatarErrorDetail> {
    let mut persona = current_persona(state).await;
    if persona.library_avatar_id == id {
        return Ok(());
    }
    persona.library_avatar_id = id;
    crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            persona: Some(persona),
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .map(|_| ())
    .map_err(|error| {
        CohostAvatarErrorDetail::new_owned(
            error.code().to_string(),
            format!("Your Buddy could not be saved: {error}"),
        )
    })
}

// --- cohost.library.update -----------------------------------------------------------------------

/// `cohost.library.update`: rename or edit one of the account's own avatars.
/// When it is the Buddy, the Buddy follows.
pub async fn update(
    state: &AppState,
    params: CohostLibraryUpdateParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    check_user_avatar(&params.avatar_id)?;
    let patch = BuddyLibraryWebPatch {
        name: params.name,
        personality: params.personality,
        context: params.context,
    };
    if patch.is_empty() {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "Change the name, the personality or About you.",
        ));
    }
    check_patch_bounds(&patch)?;
    check_library(state)?;
    let id = params.avatar_id;
    let job_id = id.clone();
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Update, Some(&id)),
        move |state| async move { run_update(&state, &job_id, patch, true).await },
    );
    Ok(accepted())
}

fn check_patch_bounds(patch: &BuddyLibraryWebPatch) -> Result<(), CohostLibraryRefusal> {
    let units = |text: &str| text.chars().map(char::len_utf16).sum::<usize>();
    let refuse = |message: &str| Err(CohostLibraryRefusal::new(COHOST_LIBRARY_INVALID, message));
    if let Some(name) = &patch.name
        && (name.trim().is_empty() || units(name.trim()) > 24)
    {
        return refuse("The name is 1 to 24 characters.");
    }
    if patch
        .personality
        .as_deref()
        .is_some_and(|text| units(text) > 1200)
    {
        return refuse("The personality is at most 1200 characters.");
    }
    if patch
        .context
        .as_deref()
        .is_some_and(|text| units(text) > 4000)
    {
        return refuse("About you is at most 4000 characters.");
    }
    Ok(())
}

async fn run_update(
    state: &AppState,
    id: &str,
    patch: BuddyLibraryWebPatch,
    apply_here: bool,
) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let avatar = api
        .patch_buddy_avatar(&token, id, &patch)
        .await
        .map_err(|error| library_error(&error))?
        .avatar;
    if web_avatar_ok(&avatar) && avatar.id == id {
        remember_avatar(state, &avatar);
    }
    if !apply_here {
        return Ok(());
    }
    let persona = current_persona(state).await;
    if persona.library_avatar_id.as_deref() != Some(id) {
        return Ok(());
    }
    let mut next = persona;
    if let Some(name) = patch.name.as_deref().and_then(library_name) {
        next.name = name;
    }
    if let Some(personality) = &patch.personality {
        next.personality = crate::cohost::truncate_utf16(personality.trim(), 1200);
    }
    crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            persona: Some(next),
            notes: patch.context,
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .map(|_| ())
    .map_err(|error| {
        CohostAvatarErrorDetail::new_owned(
            error.code().to_string(),
            format!("Your Buddy could not be saved: {error}"),
        )
    })
}

/// After `cohost.settings.set` saved: a local edit of a linked account
/// avatar's name, personality or notes is pushed to the library about 2 s
/// after the last one (last write wins). A change of link is an apply, not an
/// edit; values the library already holds are not sent.
pub(crate) fn settings_saved(state: &AppState, previous: &CohostSettings, next: &CohostSettings) {
    let Some(id) = next
        .persona
        .library_avatar_id
        .clone()
        .filter(|id| user_avatar_id_ok(id))
    else {
        return;
    };
    if previous.persona.library_avatar_id != next.persona.library_avatar_id {
        return;
    }
    let shared = state.buddy_library.clone();
    {
        let mut cache = shared.cache();
        if !cache
            .capability
            .as_ref()
            .is_some_and(|capability| capability.enabled)
        {
            return;
        }
        let listed = cache
            .web
            .as_ref()
            .and_then(|avatars| avatars.iter().find(|avatar| avatar.id == id))
            .cloned();
        let differs =
            |previous: &str, next: &str, held: Option<&str>| previous != next && held != Some(next);
        let mut patch = BuddyLibraryWebPatch::default();
        if differs(
            &previous.persona.name,
            &next.persona.name,
            listed.as_ref().map(|avatar| avatar.name.as_str()),
        ) {
            patch.name = Some(next.persona.name.clone());
        }
        if differs(
            &previous.persona.personality,
            &next.persona.personality,
            listed.as_ref().map(|avatar| avatar.personality.as_str()),
        ) {
            patch.personality = Some(next.persona.personality.clone());
        }
        if differs(
            &previous.notes,
            &next.notes,
            listed.as_ref().map(|avatar| avatar.context.as_str()),
        ) {
            patch.context = Some(next.notes.clone());
        }
        if patch.is_empty() {
            return;
        }
        let merged = match cache.pending_patch.take() {
            Some((pending_id, pending)) if pending_id == id => BuddyLibraryWebPatch {
                name: patch.name.or(pending.name),
                personality: patch.personality.or(pending.personality),
                context: patch.context.or(pending.context),
            },
            _ => patch,
        };
        cache.pending_patch = Some((id, merged));
    }
    let generation = shared.patch_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(shared.timing.patch_debounce).await;
        if shared.patch_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let Some((id, patch)) = shared.cache().pending_patch.take() else {
            return;
        };
        let job_id = id.clone();
        spawn_job(
            &state,
            busy(BuddyLibraryBusyKind::Update, Some(&id)),
            move |state| async move { run_update(&state, &job_id, patch, false).await },
        );
    });
}

// --- cohost.library.delete -----------------------------------------------------------------------

/// `cohost.library.delete`: one of the account's own avatars. When it is
/// the Buddy, the Buddy stays as it is, now only on this computer.
pub async fn delete(
    state: &AppState,
    params: CohostLibraryAvatarParams,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    check_user_avatar(&params.avatar_id)?;
    check_library(state)?;
    let id = params.avatar_id;
    let job_id = id.clone();
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Delete, Some(&id)),
        move |state| async move { run_delete(&state, &job_id).await },
    );
    Ok(accepted())
}

async fn run_delete(state: &AppState, id: &str) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let deleted = match api.delete_buddy_avatar(&token, id).await {
        Ok(deleted) => Some(deleted),
        // Already gone: clean up here all the same.
        Err(error) if error.detail.code == "buddy-not-found" => None,
        Err(error) => return Err(library_error(&error)),
    };
    forget_avatar(state, &env, id).await;
    if let Some(deleted) = deleted {
        store_clock(state, deleted.profile_updated_at);
    }
    if current_persona(state).await.library_avatar_id.as_deref() == Some(id) {
        set_link(state, None).await?;
    }
    Ok(())
}

/// Drop an avatar from the cache, its pictures and anything waiting for it.
async fn forget_avatar(state: &AppState, env: &LibraryEnv, id: &str) {
    {
        let mut cache = state.buddy_library.cache();
        if let Some(avatars) = cache.web.as_mut() {
            avatars.retain(|avatar| avatar.id != id);
        }
        cache.poses.remove(id);
        if cache.offer.as_deref() == Some(id) {
            cache.offer = None;
        }
        if cache
            .pending_apply
            .as_ref()
            .is_some_and(|pending| pending.avatar_id == id)
        {
            cache.pending_apply = None;
        }
        if cache
            .pending_patch
            .as_ref()
            .is_some_and(|(pending_id, _)| pending_id == id)
        {
            cache.pending_patch = None;
        }
    }
    if let Some(root) = env.root.clone()
        && user_avatar_id_ok(id)
    {
        let dir = cache_dir(&root, id);
        let _ = blocking(move || {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(%error, "a Buddy library cache folder could not be removed")
                }
            }
            Ok(())
        })
        .await;
    }
}

// --- The capability, and the look's library path (plan 169 re-pointed, D13) -------------------------

/// The web's capability as the account entitlement refresh read it (None:
/// signed out, or an older web without the block). The library turning on
/// (launch, sign-in) syncs; turning off forgets the account's avatars.
pub(crate) async fn set_capability(
    state: &AppState,
    capability: Option<AiCapabilitiesBuddyLibrary>,
) {
    let (was, now) = {
        let mut cache = state.buddy_library.cache();
        let was = cache
            .capability
            .as_ref()
            .is_some_and(|capability| capability.enabled);
        let now = capability
            .as_ref()
            .is_some_and(|capability| capability.enabled);
        if let Some(limit) = capability
            .as_ref()
            .map(|capability| capability.limit)
            .filter(|limit| *limit > 0)
        {
            cache.limit = Some(limit);
        }
        cache.capability = Some(capability.unwrap_or_default());
        if !now {
            cache.web = None;
            cache.poses.clear();
            cache.offer = None;
            cache.pending_patch = None;
        }
        (was, now)
    };
    if was != now {
        emit_changed(state).await;
    }
    if now && !was {
        request_sync(state, BuddyLibrarySyncReason::Launch);
    }
}

/// A look the library route made (`cohost.avatar.create`): it is in the
/// account library already. Its pictures are cached from the response.
pub(crate) async fn note_created(
    state: &AppState,
    avatar: &BuddyLibraryWebAvatar,
    pictures: &BTreeMap<CohostAvatarState, Vec<u8>>,
) {
    if !web_avatar_ok(avatar) {
        return;
    }
    {
        let mut cache = state.buddy_library.cache();
        match cache.web.as_mut() {
            Some(avatars) => {
                avatars.retain(|listed| listed.id != avatar.id);
                avatars.insert(0, avatar.clone());
            }
            None => cache.web = Some(vec![avatar.clone()]),
        }
    }
    cache_response_poses(state, avatar, pictures).await;
    emit_changed(state).await;
}

/// A pose the library redo made: the avatar's new URL and its picture.
pub(crate) async fn note_redone(
    state: &AppState,
    avatar: &BuddyLibraryWebAvatar,
    pictures: &BTreeMap<CohostAvatarState, Vec<u8>>,
) {
    if !web_avatar_ok(avatar) {
        return;
    }
    remember_avatar(state, avatar);
    cache_response_poses(state, avatar, pictures).await;
    emit_changed(state).await;
}

async fn cache_response_poses(
    state: &AppState,
    avatar: &BuddyLibraryWebAvatar,
    pictures: &BTreeMap<CohostAvatarState, Vec<u8>>,
) {
    let Some(root) = state.buddy_library.env().root else {
        return;
    };
    for (avatar_state, bytes) in pictures {
        if let Some(pose) = avatar.poses.get(*avatar_state) {
            let tag = pose_tag(&pose.url);
            cache_pose(state, &root, &avatar.id, *avatar_state, &tag, bytes).await;
        }
    }
}

/// Keep this look on a library draft: the account learns the choice.
pub(crate) fn select_after_keep(state: &AppState, id: &str) {
    let job_id = id.to_string();
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Use, Some(id)),
        move |state| async move {
            {
                let mut cache = state.buddy_library.cache();
                cache.offer = None;
                cache.pending_apply = None;
            }
            let env = state.buddy_library.env();
            match env.web() {
                Some((api, token)) => select_on_account(&state, &api, &token, &job_id).await,
                None => Ok(()),
            }
        },
    );
}

/// Discard on a library draft: the avatar leaves the account library too.
pub(crate) fn delete_after_discard(state: &AppState, id: &str) {
    let job_id = id.to_string();
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Delete, Some(id)),
        move |state| async move { run_delete(&state, &job_id).await },
    );
}

// --- The picture cache -------------------------------------------------------------------------------

fn cache_dir(root: &Path, avatar_id: &str) -> PathBuf {
    root.join(BUDDY_LIBRARY_CACHE_DIR).join(avatar_id)
}

fn cache_file_name(avatar_state: CohostAvatarState, tag: &str) -> String {
    format!("{}-{tag}.png", avatar_state.as_str())
}

/// The managed URL of a cached picture (`parseBuddyLibraryPoseUrl`).
fn pose_url(avatar_id: &str, avatar_state: CohostAvatarState, tag: &str) -> String {
    format!(
        "videorc-asset://buddy/{BUDDY_LIBRARY_CACHE_DIR}/{avatar_id}/{}",
        cache_file_name(avatar_state, tag)
    )
}

/// A pose URL's `v` (8 lowercase hex digits), or the first 8 hex digits of
/// the URL's SHA-256 when it has none: the cache file's tag.
pub(crate) fn pose_tag(url: &str) -> String {
    let from_query = url
        .split_once('?')
        .and_then(|(_, query)| query.split('&').find_map(|pair| pair.strip_prefix("v=")))
        .filter(|tag| {
            tag.len() == 8
                && tag
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        });
    match from_query {
        Some(tag) => tag.to_string(),
        None => {
            use sha2::Digest as _;
            let digest = sha2::Sha256::digest(url.as_bytes());
            digest
                .iter()
                .take(4)
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }
    }
}

fn set_pose(poses: &mut BuddyLibraryPoses, avatar_state: CohostAvatarState, url: Option<String>) {
    match avatar_state {
        CohostAvatarState::Idle => poses.idle = url,
        CohostAvatarState::Talk => poses.talk = url,
        CohostAvatarState::Laugh => poses.laugh = url,
        CohostAvatarState::Think => poses.think = url,
    }
}

/// The pictures already cached for each listed avatar, by their pose tags.
fn cached_poses_of(
    root: &Path,
    avatars: &[BuddyLibraryWebAvatar],
) -> BTreeMap<String, BuddyLibraryPoses> {
    avatars
        .iter()
        .map(|avatar| {
            let mut poses = BuddyLibraryPoses::default();
            for avatar_state in ALL_STATES {
                if let Some(pose) = avatar.poses.get(avatar_state) {
                    let tag = pose_tag(&pose.url);
                    let file =
                        cache_dir(root, &avatar.id).join(cache_file_name(avatar_state, &tag));
                    if crate::cohost_avatar::is_regular_file(&file) {
                        set_pose(
                            &mut poses,
                            avatar_state,
                            Some(pose_url(&avatar.id, avatar_state, &tag)),
                        );
                    }
                }
            }
            (avatar.id.clone(), poses)
        })
        .collect()
}

/// Write one cached picture and drop the state's earlier ones.
fn write_cached_pose(
    dir: &Path,
    avatar_state: CohostAvatarState,
    name: &str,
    bytes: &[u8],
) -> Result<(), CohostAvatarErrorDetail> {
    std::fs::create_dir_all(dir)
        .map_err(|error| store_error("Could not create the library cache folder", error))?;
    crate::cohost_avatar::write_atomic(dir, name, bytes)?;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if file != name
                && file.starts_with(&format!("{}-", avatar_state.as_str()))
                && file.ends_with(".png")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// Remove the cache of every avatar no longer in the library (uuid folders
/// only; nothing else under the root is touched).
fn prune_cache(root: &Path, keep: &BTreeSet<String>) {
    let Ok(entries) = std::fs::read_dir(root.join(BUDDY_LIBRARY_CACHE_DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if user_avatar_id_ok(&name)
            && !keep.contains(&name)
            && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && let Err(error) = std::fs::remove_dir_all(entry.path())
        {
            tracing::warn!(%error, "a Buddy library cache folder could not be removed");
        }
    }
}

pub(crate) mod alive;
pub use alive::save_to_library;

#[cfg(test)]
pub(crate) mod tests;
