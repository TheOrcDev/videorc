//! The Buddy's look (plan 169 Phase B, D8, D9; plan 164 S-A6 before it).
//!
//! One click makes the whole set: `cohost.avatar.create` sends a description
//! and/or an inspiration picture to videorc-web's
//! `POST /api/ai/cohost/avatar/set`, which draws the idle character in the
//! house style and talk, laugh and think as edits of it. The desktop never
//! calls a model itself: videorc-web owns the model, the house look and the
//! daily image cap (each delivered image counts; a set needs 4 left).
//!
//! Every RPC answers at once (the websocket mutation lane's 10 s rule); the
//! web call (up to 190 s) runs on its own task and reports by event:
//! `cohost.avatar.progress` per state (`working`, then `done` or `failed`)
//! and `cohost.avatar.draft` with the whole draft. The web answers a set in
//! one response, so a create marks idle `working` and then reports all four
//! states together. One job runs at a time per process
//! (`cohost-avatar-busy`).
//!
//! A new look never overwrites the current one until it is kept (D8). The set
//! lands in `<root>/<personaId>/drafts/<requestId>/<state>.png`, one draft
//! per persona: a create replaces the draft once it succeeded, so a failed
//! one leaves the earlier draft (or nothing) as it was.
//! `cohost.avatar.keep` moves the draft into `<personaId>/<state>-<tag>.png`
//! (the tag is the draft's first 8 hex digits, so a kept look never reuses an
//! earlier look's path and nothing shows a cached picture) and patches the
//! persona; `cohost.avatar.discard` deletes it;
//! `cohost.avatar.redo` remakes talk, laugh or think from the draft's idle;
//! `cohost.avatar.draft.get` offers a draft left on disk again (after a
//! restart). Nothing is written outside the managed buddy root.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::cohost::{
    CohostAvatarState, CohostPersona, CohostPersonaImages, CohostPersonaSource, CohostSettings,
};
use crate::protocol::{CohostAvatarErrorDetail, CohostSettingsPatch};
use crate::state::AppState;
use crate::videorc_api::{
    CohostApiError, CohostApiErrorKind, CohostAvatarSetRequest, CohostAvatarSetResponse,
    BuddyLibraryWebAvatar, BuddyLibraryWebCreateRequest, VideorcApiClient,
};

pub const COHOST_AVATAR_PROGRESS_EVENT: &str = "cohost.avatar.progress";
pub const COHOST_AVATAR_DRAFT_EVENT: &str = "cohost.avatar.draft";
/// The web route's description bound (D4): 1 to 600 UTF-16 units.
pub const COHOST_AVATAR_DESCRIPTION_MAX_CHARS: usize = 600;
/// An inspiration picture or a redo's base rides as base64 and must decode
/// to at most 3 MB: Vercel refuses a request body over 4.5 MB before the
/// route runs, and base64 adds a third (plan 169 Phase A).
pub const COHOST_AVATAR_IMAGE_IN_MAX_BYTES: usize = 3 * 1024 * 1024;
/// A generated PNG is refused above this before it is written (S-A6).
pub const COHOST_AVATAR_PNG_MAX_BYTES: usize = 8 * 1024 * 1024;
const COHOST_AVATAR_MAX_PIXELS: u64 = 20_000_000;

/// The tile hints the plan names (S-A5, S-A6) for the web's error codes.
pub const COHOST_AVATAR_QUOTA_HINT: &str = "Daily avatar limit reached";
pub const COHOST_AVATAR_UNAVAILABLE_HINT: &str = "Not available yet";
/// A state the web did not deliver and that names no reason.
pub const COHOST_AVATAR_NOT_MADE: &str = "This picture was not made. Redo it.";

/// Another look job is running.
pub const COHOST_AVATAR_BUSY: &str = "cohost-avatar-busy";
/// The request breaks a rule (the message says which).
pub const COHOST_AVATAR_INVALID: &str = "cohost-avatar-invalid";
/// A picture to send (the inspiration, or a redo's base) is over 3 MB.
pub const COHOST_AVATAR_PICTURE_TOO_LARGE: &str = "cohost-avatar-picture-too-large";
/// No draft with that request id for the active Buddy.
pub const COHOST_AVATAR_DRAFT_NONE: &str = "cohost-avatar-draft-none";
/// This process has no buddy root (bare `cargo run`).
pub const COHOST_AVATAR_ROOT_UNCONFIGURED: &str = "cohost-avatar-root-unconfigured";
/// A file under the buddy root could not be read or written.
pub const COHOST_AVATAR_STORE_FAILED: &str = "cohost-avatar-store-failed";
/// The draft was discarded while its redo ran; the result was dropped.
pub const COHOST_AVATAR_CANCELLED: &str = "cohost-avatar-cancelled";
/// The web delivered no picture for a state and named no reason.
pub const COHOST_AVATAR_NOT_MADE_CODE: &str = "avatar-not-made";

const DRAFTS_DIR: &str = "drafts";
const STAGING_PREFIX: &str = ".staging-";
const FAILED_FILE: &str = "failed.json";
const FAILED_MAX_BYTES: u64 = 64 * 1024;
/// Plan 170 D13: a draft the library route made names its account avatar
/// (and the name, personality and "About you" Keep applies) here.
const LIBRARY_FILE: &str = "library.json";
const LIBRARY_MAX_BYTES: u64 = 64 * 1024;
/// The bounds the library route takes (plan 170 D1, D5).
const LIBRARY_NAME_MAX_CHARS: usize = 24;
const LIBRARY_PERSONALITY_MAX_CHARS: usize = 1200;
const LIBRARY_CONTEXT_MAX_CHARS: usize = 4000;
const PERSONA_IMAGE_EXTENSIONS: [&str; 3] = ["png", "webp", "jpg"];

// --- Wire types -----------------------------------------------------------------

/// `cohost.avatar.create`: at least one of the two. The picture is a PNG,
/// JPEG or WebP of at most 3 MB (the renderer fits it within 1024 px).
/// Plan 170 D13 adds the library avatar's name (1 to 24; the persona's name
/// when absent), personality (0 to 1200) and "About you" (0 to 4000).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostAvatarCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspiration_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// `cohost.avatar.redo`: one of talk, laugh or think, from the draft's idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostAvatarRedoParams {
    pub request_id: String,
    pub state: CohostAvatarState,
}

/// `cohost.avatar.keep` and `cohost.avatar.discard`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostAvatarRequestIdParams {
    pub request_id: String,
}

/// What `create` and `redo` answer at once: the request id their events
/// carry (a redo carries its draft's id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarAccepted {
    pub request_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAvatarPhase {
    Working,
    Done,
    Failed,
}

/// `cohost.avatar.progress`: one state's step. `path` (the draft file,
/// relative to the buddy root) on `done`, `error` on `failed`; each is
/// absent, never null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarProgressEvent {
    pub request_id: String,
    pub state: CohostAvatarState,
    pub phase: CohostAvatarPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CohostAvatarErrorDetail>,
}

/// A draft look (the `cohost.avatar.draft` event and `draft.get`): the
/// relative path of each state the draft holds, and why each other state is
/// missing. Idle is always there: without it there is no draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarDraft {
    pub request_id: String,
    pub images: CohostPersonaImages,
    #[serde(default)]
    pub failed: BTreeMap<CohostAvatarState, CohostAvatarErrorDetail>,
    /// Plan 170 D13: the account library avatar this draft already is (a
    /// uuid). Absent for a draft the plan 169 route made (an older web).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_avatar_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAvatarJobKind {
    Create,
    Redo,
}

/// The job running now, so a Buddy tab opened mid-run shows it working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarRunning {
    pub request_id: String,
    pub kind: CohostAvatarJobKind,
    /// The state a redo remakes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<CohostAvatarState>,
}

/// `cohost.avatar.draft.get` and `cohost.avatar.discard`: the active
/// Buddy's draft and the running job, each absent when there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarDraftStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<CohostAvatarDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<CohostAvatarRunning>,
}

/// Why a look RPC was refused before anything was sent or changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohostAvatarRefusal {
    pub code: String,
    pub message: String,
}

impl CohostAvatarRefusal {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

// --- Process state: the one running job -------------------------------------------

struct RunningJob {
    id: u64,
    request_id: String,
    kind: CohostAvatarJobKind,
    state: Option<CohostAvatarState>,
    cancelled: Arc<AtomicBool>,
}

/// The running job's slot, and the lock every write to (or removal of) a
/// draft folder and every keep holds.
#[derive(Default)]
pub(crate) struct AvatarShared {
    job: Mutex<Option<RunningJob>>,
    next_job: AtomicU64,
    commit: Mutex<()>,
}

static PROCESS_AVATAR: LazyLock<Arc<AvatarShared>> =
    LazyLock::new(|| Arc::new(AvatarShared::default()));

/// Holds the slot; dropping it frees the slot (when it still holds this job:
/// a discard frees it early and a new job may have taken it).
struct JobGuard {
    shared: Arc<AvatarShared>,
    id: u64,
    cancelled: Arc<AtomicBool>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut slot = self.shared.job.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|job| job.id == self.id) {
            *slot = None;
        }
    }
}

impl AvatarShared {
    fn begin(
        self: &Arc<Self>,
        request_id: &str,
        kind: CohostAvatarJobKind,
        state: Option<CohostAvatarState>,
    ) -> Result<JobGuard, CohostAvatarRefusal> {
        let mut slot = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err(CohostAvatarRefusal::new(
                COHOST_AVATAR_BUSY,
                "Your Buddy's look is already being made. Wait for it to finish.",
            ));
        }
        let id = self.next_job.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        *slot = Some(RunningJob {
            id,
            request_id: request_id.to_string(),
            kind,
            state,
            cancelled: cancelled.clone(),
        });
        Ok(JobGuard {
            shared: self.clone(),
            id,
            cancelled,
        })
    }

    fn running(&self) -> Option<CohostAvatarRunning> {
        let slot = self.job.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref().map(|job| CohostAvatarRunning {
            request_id: job.request_id.clone(),
            kind: job.kind,
            state: job.state,
        })
    }

    /// Flag the job for `request_id` (if any) as cancelled and free the slot.
    fn cancel(&self, request_id: &str) {
        let mut slot = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|job| job.request_id == request_id)
            && let Some(job) = slot.take()
        {
            job.cancelled.store(true, Ordering::Release);
        }
    }
}

// --- The environment ----------------------------------------------------------------

/// What a look call needs from the process: the write root, the web client
/// and the account. Tests build their own with a fake web.
#[derive(Clone)]
pub(crate) struct AvatarEnv {
    root: Option<PathBuf>,
    api: Option<VideorcApiClient>,
    token: Option<String>,
    premium: bool,
    /// Plan 170 D13: the web's account library is on, so a new look is made
    /// by `POST /api/buddy/avatars` and saved to the library; otherwise the
    /// plan 169 set route stays the path.
    library: bool,
    shared: Arc<AvatarShared>,
}

impl AvatarEnv {
    fn process(state: &AppState) -> Self {
        Self {
            root: managed_buddy_root(),
            api: VideorcApiClient::new().ok(),
            token: crate::account::stored_session_token(),
            premium: crate::cohost::premium_entitled(),
            library: state.buddy_library.enabled(),
            shared: PROCESS_AVATAR.clone(),
        }
    }

    fn root(&self) -> Result<PathBuf, CohostAvatarRefusal> {
        self.root.clone().ok_or_else(|| {
            CohostAvatarRefusal::new(
                COHOST_AVATAR_ROOT_UNCONFIGURED,
                "The Buddy's image folder is not configured.",
            )
        })
    }

    /// The web client and bearer token, refused before anything is sent
    /// when the account is Basic or signed out.
    fn web(&self) -> Result<(VideorcApiClient, String), CohostAvatarRefusal> {
        if !self.premium {
            return Err(CohostAvatarRefusal::new(
                "premium-required",
                "Making your Buddy's look requires Videorc Premium.",
            ));
        }
        let Some(token) = self.token.clone() else {
            return Err(CohostAvatarRefusal::new(
                "signed-out",
                "Sign in to make your Buddy's look.",
            ));
        };
        let Some(api) = self.api.clone() else {
            return Err(CohostAvatarRefusal::new(
                "network",
                "Could not start the Videorc web client.",
            ));
        };
        Ok((api, token))
    }
}

/// The first configured buddy-assets root: where every image is written.
pub(crate) fn managed_buddy_root() -> Option<PathBuf> {
    crate::resource_authority::configured_managed_buddy_roots()
        .into_iter()
        .next()
}

// --- Paths -----------------------------------------------------------------------------

pub(crate) fn persona_id_ok(persona_id: &str) -> bool {
    !persona_id.is_empty()
        && persona_id.len() <= 128
        && persona_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A request id names a draft folder: a lowercase hyphenated uuid only.
pub(crate) fn request_id_ok(request_id: &str) -> bool {
    uuid::Uuid::parse_str(request_id).is_ok_and(|uuid| uuid.hyphenated().to_string() == request_id)
}

fn drafts_dir(root: &Path, persona_id: &str) -> PathBuf {
    root.join(persona_id).join(DRAFTS_DIR)
}

fn draft_dir(root: &Path, persona_id: &str, request_id: &str) -> PathBuf {
    drafts_dir(root, persona_id).join(request_id)
}

/// `<personaId>/drafts/<requestId>/<state>.png`, relative to the root.
pub(crate) fn draft_relative_path(
    persona_id: &str,
    request_id: &str,
    state: CohostAvatarState,
) -> String {
    format!(
        "{persona_id}/{DRAFTS_DIR}/{request_id}/{}.png",
        state.as_str()
    )
}

/// `<state>-<tag>.png`: a kept picture's file name. The tag is the draft's
/// first 8 hex digits, so each kept look has its own paths.
fn kept_file_name(request_id: &str, state: CohostAvatarState) -> String {
    let tag = request_id.get(..8).unwrap_or(request_id);
    format!("{}-{tag}.png", state.as_str())
}

/// `<personaId>/<state>-<tag>.png`, the value a kept look stores.
pub(crate) fn avatar_relative_path(
    persona_id: &str,
    request_id: &str,
    state: CohostAvatarState,
) -> String {
    format!("{persona_id}/{}", kept_file_name(request_id, state))
}

/// Whether `file` is one of a state's pictures in the persona folder: an
/// upload or an earlier look (`<state>.<ext>`, `<state>-<8 hex>.<ext>`).
pub(crate) fn is_state_picture(file: &str, state: CohostAvatarState) -> bool {
    let Some(rest) = file.strip_prefix(state.as_str()) else {
        return false;
    };
    let Some((stem, extension)) = rest.rsplit_once('.') else {
        return false;
    };
    PERSONA_IMAGE_EXTENSIONS.contains(&extension)
        && (stem.is_empty()
            || stem.strip_prefix('-').is_some_and(|tag| {
                tag.len() == 8
                    && tag
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            }))
}

pub(crate) const ALL_STATES: [CohostAvatarState; 4] = [
    CohostAvatarState::Idle,
    CohostAvatarState::Talk,
    CohostAvatarState::Laugh,
    CohostAvatarState::Think,
];

pub(crate) fn set_image(
    images: &mut CohostPersonaImages,
    state: CohostAvatarState,
    path: Option<String>,
) {
    match state {
        CohostAvatarState::Idle => images.idle = path,
        CohostAvatarState::Talk => images.talk = path,
        CohostAvatarState::Laugh => images.laugh = path,
        CohostAvatarState::Think => images.think = path,
    }
}

fn image_of(images: &CohostPersonaImages, state: CohostAvatarState) -> Option<String> {
    match state {
        CohostAvatarState::Idle => images.idle.clone(),
        CohostAvatarState::Talk => images.talk.clone(),
        CohostAvatarState::Laugh => images.laugh.clone(),
        CohostAvatarState::Think => images.think.clone(),
    }
}

pub(crate) fn store_error(what: &str, error: impl std::fmt::Display) -> CohostAvatarErrorDetail {
    CohostAvatarErrorDetail::new(COHOST_AVATAR_STORE_FAILED, format!("{what}: {error}"))
}

fn not_made() -> CohostAvatarErrorDetail {
    CohostAvatarErrorDetail::new(COHOST_AVATAR_NOT_MADE_CODE, COHOST_AVATAR_NOT_MADE)
}

pub(crate) fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

/// Write `bytes` to `dir/name` through a staged file. The folder must exist:
/// a discarded draft's folder is never recreated by a late write.
pub(crate) fn write_atomic(
    dir: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<(), CohostAvatarErrorDetail> {
    use std::io::Write as _;
    let destination = dir.join(name);
    let staged = dir.join(format!("{name}.partial"));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&staged)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        crate::atomic_file::replace_file(&staged, &destination)
    })();
    result.map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        store_error(&format!("Could not save {name}"), error)
    })
}

fn read_failed(dir: &Path) -> BTreeMap<CohostAvatarState, CohostAvatarErrorDetail> {
    use std::io::Read as _;
    let Ok(file) = std::fs::File::open(dir.join(FAILED_FILE)) else {
        return BTreeMap::new();
    };
    let mut bytes = Vec::new();
    if file
        .take(FAILED_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > FAILED_MAX_BYTES
    {
        return BTreeMap::new();
    }
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// A library draft's account avatar and the text Keep applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftLibrary {
    pub(crate) library_avatar_id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) personality: String,
    #[serde(default)]
    pub(crate) context: String,
}

/// The draft's library meta, or None for a plan 169 draft (or one that
/// cannot be read: it then keeps and discards like a local draft).
fn read_library(dir: &Path) -> Option<DraftLibrary> {
    use std::io::Read as _;
    let file = std::fs::File::open(dir.join(LIBRARY_FILE)).ok()?;
    let mut bytes = Vec::new();
    file.take(LIBRARY_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > LIBRARY_MAX_BYTES {
        return None;
    }
    serde_json::from_slice::<DraftLibrary>(&bytes)
        .ok()
        .filter(|library| crate::cohost_library::user_avatar_id_ok(&library.library_avatar_id))
}

fn write_failed(
    dir: &Path,
    failed: &BTreeMap<CohostAvatarState, CohostAvatarErrorDetail>,
) -> Result<(), CohostAvatarErrorDetail> {
    let bytes = serde_json::to_vec(failed)
        .map_err(|error| store_error("Could not save the draft", error))?;
    write_atomic(dir, FAILED_FILE, &bytes)
}

/// The draft in `dir` as the wire shows it, or None when it has no idle
/// picture (no character, no draft). A state without a picture is failed:
/// with the reason the web gave when it was made, else a generic one.
fn read_draft_dir(dir: &Path, persona_id: &str, request_id: &str) -> Option<CohostAvatarDraft> {
    if !is_regular_file(&dir.join("idle.png")) {
        return None;
    }
    let mut images = CohostPersonaImages::default();
    let mut recorded = read_failed(dir);
    let mut failed = BTreeMap::new();
    for state in ALL_STATES {
        if is_regular_file(&dir.join(format!("{}.png", state.as_str()))) {
            set_image(
                &mut images,
                state,
                Some(draft_relative_path(persona_id, request_id, state)),
            );
        } else {
            failed.insert(state, recorded.remove(&state).unwrap_or_else(not_made));
        }
    }
    Some(CohostAvatarDraft {
        request_id: request_id.to_string(),
        images,
        failed,
        library_avatar_id: read_library(dir).map(|library| library.library_avatar_id),
    })
}

/// The persona's draft: the newest readable one (there is at most one in
/// normal use; staging folders and anything that is not a draft are skipped).
fn find_draft(root: &Path, persona_id: &str) -> Option<CohostAvatarDraft> {
    let entries = std::fs::read_dir(drafts_dir(root, persona_id)).ok()?;
    let mut best: Option<(std::time::SystemTime, CohostAvatarDraft)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !request_id_ok(&name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(draft) = read_draft_dir(&entry.path(), persona_id, &name) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(newest, _)| modified > *newest) {
            best = Some((modified, draft));
        }
    }
    best.map(|(_, draft)| draft)
}

/// Remove the drafts folder when nothing is left in it.
fn remove_drafts_dir_if_empty(root: &Path, persona_id: &str) {
    let dir = drafts_dir(root, persona_id);
    if std::fs::read_dir(&dir).is_ok_and(|mut entries| entries.next().is_none()) {
        let _ = std::fs::remove_dir(&dir);
    }
}

// --- Input and output checks ------------------------------------------------------------

/// The description as the route takes it: trimmed, empty as none, at most
/// 600 UTF-16 units.
pub(crate) fn shape_description(
    description: Option<&str>,
) -> Result<Option<String>, CohostAvatarRefusal> {
    let Some(description) = description.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    let units: usize = description.chars().map(char::len_utf16).sum();
    if units > COHOST_AVATAR_DESCRIPTION_MAX_CHARS {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            format!("The description is at most {COHOST_AVATAR_DESCRIPTION_MAX_CHARS} characters."),
        ));
    }
    Ok(Some(description.to_string()))
}

/// The library fields of a create (plan 170 D13) as the route takes them:
/// the name trimmed, 1 to 24 (the persona's own when absent); personality
/// and "About you" trimmed, empty as none, at most 1200 and 4000.
pub(crate) fn shape_library_fields(
    params: &CohostAvatarCreateParams,
    persona_name: &str,
) -> Result<(String, Option<String>, Option<String>), CohostAvatarRefusal> {
    let units = |text: &str| text.chars().map(char::len_utf16).sum::<usize>();
    let name = params
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(persona_name.trim());
    if name.is_empty() || units(name) > LIBRARY_NAME_MAX_CHARS {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            format!("The name is 1 to {LIBRARY_NAME_MAX_CHARS} characters."),
        ));
    }
    let optional = |text: Option<&str>, max: usize, what: &str| match text
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        Some(text) if units(text) > max => Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            format!("{what} is at most {max} characters."),
        )),
        text => Ok(text.map(str::to_string)),
    };
    let personality = optional(
        params.personality.as_deref(),
        LIBRARY_PERSONALITY_MAX_CHARS,
        "The personality",
    )?;
    let context = optional(
        params.context.as_deref(),
        LIBRARY_CONTEXT_MAX_CHARS,
        "About you",
    )?;
    Ok((name.to_string(), personality, context))
}

/// The inspiration picture as the route takes it (base64): a PNG, JPEG or
/// WebP, at most 3 MB decoded, under 20 megapixels by its header.
pub(crate) fn shape_inspiration(
    inspiration: Option<&str>,
) -> Result<Option<String>, CohostAvatarRefusal> {
    let Some(encoded) = inspiration.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    let refuse = |message: &str| CohostAvatarRefusal::new(COHOST_AVATAR_INVALID, message);
    let too_large = || {
        CohostAvatarRefusal::new(
            COHOST_AVATAR_PICTURE_TOO_LARGE,
            "The picture is over 3 MB. Choose a smaller one.",
        )
    };
    if encoded.len() > COHOST_AVATAR_IMAGE_IN_MAX_BYTES.div_ceil(3) * 4 + 4 {
        return Err(too_large());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| refuse("The picture could not be read."))?;
    if bytes.len() > COHOST_AVATAR_IMAGE_IN_MAX_BYTES {
        return Err(too_large());
    }
    if bytes.is_empty() {
        return Err(refuse("The picture could not be read."));
    }
    if !matches!(
        image::guess_format(&bytes).ok(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP)
    ) {
        return Err(refuse("Choose a PNG, JPEG or WebP picture."));
    }
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_dimensions().ok())
        .ok_or_else(|| refuse("The picture could not be read."))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > COHOST_AVATAR_MAX_PIXELS
    {
        return Err(refuse("The picture is empty or over 20 megapixels."));
    }
    Ok(Some(encoded.to_string()))
}

/// A generated PNG, checked before it is written: valid base64, at most
/// 8 MB, a PNG that decodes under 20 megapixels.
pub(crate) fn generated_png(png_base64: &str) -> Result<Vec<u8>, CohostAvatarErrorDetail> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|_| {
            CohostAvatarErrorDetail::new(
                "avatar-image-unreadable",
                "The generated image could not be read.",
            )
        })?;
    checked_png(bytes)
}

/// PNG bytes (generated, or a library pose downloaded): at most 8 MB, a PNG
/// that decodes under 20 megapixels.
pub(crate) fn checked_png(bytes: Vec<u8>) -> Result<Vec<u8>, CohostAvatarErrorDetail> {
    let unreadable =
        |message: &str| CohostAvatarErrorDetail::new("avatar-image-unreadable", message);
    if bytes.is_empty() || bytes.len() > COHOST_AVATAR_PNG_MAX_BYTES {
        return Err(unreadable("The generated image is empty or over 8 MB."));
    }
    if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
        return Err(unreadable("The generated image is not a PNG."));
    }
    let (width, height) = image::load_from_memory(&bytes)
        .map(|decoded| (u64::from(decoded.width()), u64::from(decoded.height())))
        .map_err(|_| unreadable("The generated image could not be decoded."))?;
    if width == 0 || height == 0 || width * height > COHOST_AVATAR_MAX_PIXELS {
        return Err(unreadable("The generated image has an unusable size."));
    }
    Ok(bytes)
}

/// "3 h 20 min", "45 min": how long until the daily cap resets.
fn reset_in(after: std::time::Duration) -> String {
    let minutes = after.as_secs().div_ceil(60).max(1);
    match (minutes / 60, minutes % 60) {
        (0, minutes) => format!("{minutes} min"),
        (hours, 0) => format!("{hours} h"),
        (hours, minutes) => format!("{hours} h {minutes} min"),
    }
}

/// The one line a tile shows for a failed web call (S-A5 codes, S-A6 copy,
/// plan 169's anchor code). The web's code is kept.
pub(crate) fn tile_error(error: &CohostApiError) -> CohostAvatarErrorDetail {
    let code = error.detail.code.as_str();
    let message = match code {
        "quota-exhausted" => match error.kind {
            CohostApiErrorKind::QuotaExhausted {
                retry_after: Some(after),
            } => format!("{COHOST_AVATAR_QUOTA_HINT}. More in {}.", reset_in(after)),
            _ => COHOST_AVATAR_QUOTA_HINT.to_string(),
        },
        "avatar-model-unconfigured"
        | "avatar-disabled"
        | "avatar-style-anchor-missing"
        | "cohost-disabled"
        | "ai-gateway-not-configured"
        | "buddy-storage-unconfigured" => COHOST_AVATAR_UNAVAILABLE_HINT.to_string(),
        "buddy-not-found" => "That Buddy is not in your library any more.".to_string(),
        "unauthorized" => "Sign in again to make your Buddy's look.".to_string(),
        "premium-required" => "Making your Buddy's look requires Videorc Premium.".to_string(),
        "ai-user-disabled" => "Cloud AI is turned off for this account.".to_string(),
        "avatar-timeout" | "timeout" => "The model took too long. Try again.".to_string(),
        "network" => "Could not reach Videorc. Check your connection and try again.".to_string(),
        _ => error.detail.message.clone(),
    };
    CohostAvatarErrorDetail::new_owned(error.detail.code.clone(), message)
}

/// Why the web left a state out of a set it answered.
fn web_failure(
    response: &CohostAvatarSetResponse,
    state: CohostAvatarState,
) -> CohostAvatarErrorDetail {
    response
        .failed
        .get(&state)
        .map(|failure| {
            CohostAvatarErrorDetail::new_owned(failure.code.clone(), failure.message.clone())
        })
        .unwrap_or_else(not_made)
}

// --- Shared helpers ------------------------------------------------------------------------

pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CohostAvatarErrorDetail> + Send + 'static,
) -> Result<T, CohostAvatarErrorDetail> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| store_error("The look job stopped", error))?
}

async fn active_persona(state: &AppState) -> Result<CohostPersona, CohostAvatarRefusal> {
    let persona = state.cohost.lock().await.settings().persona.clone();
    if !persona_id_ok(&persona.id) {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "The persona id is not a plain token.",
        ));
    }
    Ok(persona)
}

fn refusal_of(detail: CohostAvatarErrorDetail) -> CohostAvatarRefusal {
    CohostAvatarRefusal {
        code: detail.code,
        message: detail.message,
    }
}

fn emit_progress(
    state: &AppState,
    request_id: &str,
    avatar_state: CohostAvatarState,
    phase: CohostAvatarPhase,
    path: Option<String>,
    error: Option<CohostAvatarErrorDetail>,
) {
    state.emit_event(
        COHOST_AVATAR_PROGRESS_EVENT,
        CohostAvatarProgressEvent {
            request_id: request_id.to_string(),
            state: avatar_state,
            phase,
            path,
            error,
        },
    );
}

// --- cohost.avatar.create ---------------------------------------------------------------------

/// `cohost.avatar.create`: accept one set and make it on its own task.
/// Refused before anything is sent when the input is out of bounds, the
/// account is Basic or signed out, no root is configured, or a job runs.
pub async fn create(
    state: &AppState,
    params: CohostAvatarCreateParams,
) -> Result<CohostAvatarAccepted, CohostAvatarRefusal> {
    create_in(state, AvatarEnv::process(state), params).await
}

async fn create_in(
    state: &AppState,
    env: AvatarEnv,
    mut params: CohostAvatarCreateParams,
) -> Result<CohostAvatarAccepted, CohostAvatarRefusal> {
    let description = shape_description(params.description.as_deref())?;
    let inspiration = {
        let raw = params.inspiration_base64.take();
        tokio::task::spawn_blocking(move || shape_inspiration(raw.as_deref()))
            .await
            .map_err(|error| CohostAvatarRefusal::new(COHOST_AVATAR_INVALID, error.to_string()))??
    };
    if description.is_none() && inspiration.is_none() {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "Describe your Buddy or add a picture first.",
        ));
    }
    let root = env.root()?;
    let (api, token) = env.web()?;
    let persona = active_persona(state).await?;
    let (name, personality, context) = shape_library_fields(&params, &persona.name)?;
    let request_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let guard = env
        .shared
        .begin(&request_id, CohostAvatarJobKind::Create, None)?;
    // Plan 170 D13: with the account library on, the look is made by the
    // library route and saved to the account at once.
    let route = if env.library {
        CreateRoute::Library(BuddyLibraryWebCreateRequest {
            name,
            description,
            inspiration,
            personality,
            context,
        })
    } else {
        CreateRoute::Set(CohostAvatarSetRequest {
            description,
            inspiration,
            redo: None,
            base: None,
        })
    };
    let job = SetJob {
        state: state.clone(),
        root,
        persona_id: persona.id,
        request_id: request_id.clone(),
        api,
        token,
        shared: env.shared.clone(),
    };
    tokio::spawn(async move {
        job.run_create(route).await;
        drop(guard);
    });
    Ok(CohostAvatarAccepted { request_id })
}

/// Which web route makes a new look.
enum CreateRoute {
    /// Plan 169: `POST /api/ai/cohost/avatar/set` (stores nothing).
    Set(CohostAvatarSetRequest),
    /// Plan 170 D13: `POST /api/buddy/avatars` (saved to the account).
    Library(BuddyLibraryWebCreateRequest),
}

/// Which web route remakes one state of a draft.
enum RedoRoute {
    Set(CohostAvatarSetRequest),
    Library { avatar_id: String },
}

/// The decoded pictures of a set (already checked when the draft was stored).
fn set_pictures(response: &CohostAvatarSetResponse) -> BTreeMap<CohostAvatarState, Vec<u8>> {
    ALL_STATES
        .iter()
        .filter_map(|state| {
            let image = response.images.get(*state)?;
            generated_png(&image.png_base64)
                .ok()
                .map(|bytes| (*state, bytes))
        })
        .collect()
}

/// What a running create or redo carries onto its task.
struct SetJob {
    state: AppState,
    root: PathBuf,
    persona_id: String,
    request_id: String,
    api: VideorcApiClient,
    token: String,
    shared: Arc<AvatarShared>,
}

impl SetJob {
    fn progress(
        &self,
        avatar_state: CohostAvatarState,
        phase: CohostAvatarPhase,
        path: Option<String>,
        error: Option<CohostAvatarErrorDetail>,
    ) {
        emit_progress(
            &self.state,
            &self.request_id,
            avatar_state,
            phase,
            path,
            error,
        );
    }

    async fn run_create(&self, route: CreateRoute) {
        let idle = CohostAvatarState::Idle;
        self.progress(idle, CohostAvatarPhase::Working, None, None);
        let fail = |error: CohostAvatarErrorDetail| {
            self.state.emit_log(
                "warn",
                format!("Buddy look failed ({}): {}", error.code, error.message),
            );
            self.progress(idle, CohostAvatarPhase::Failed, None, Some(error));
        };
        let (response, library) = match route {
            CreateRoute::Set(request) => {
                match self.api.post_cohost_avatar_set(&self.token, &request).await {
                    Ok(response) => (response, None),
                    Err(error) => return fail(tile_error(&error)),
                }
            }
            CreateRoute::Library(request) => {
                match self.api.post_buddy_avatar(&self.token, &request).await {
                    Ok(created) => {
                        if !crate::cohost_library::user_avatar_id_ok(&created.avatar.id) {
                            return fail(CohostAvatarErrorDetail::new(
                                "malformed-response",
                                "Videorc answered in a way this app does not read. Update Videorc.",
                            ));
                        }
                        let meta = DraftLibrary {
                            library_avatar_id: created.avatar.id.clone(),
                            name: created.avatar.name.clone(),
                            personality: created.avatar.personality.clone(),
                            context: created.avatar.context.clone(),
                        };
                        (created.as_set(), Some((meta, created.avatar)))
                    }
                    Err(error) => return fail(tile_error(&error)),
                }
            }
        };
        let pictures = library.as_ref().map(|_| set_pictures(&response));
        let stored = {
            let root = self.root.clone();
            let persona_id = self.persona_id.clone();
            let request_id = self.request_id.clone();
            let shared = self.shared.clone();
            let meta = library.as_ref().map(|(meta, _)| meta.clone());
            blocking(move || {
                store_set(
                    &root,
                    &persona_id,
                    &request_id,
                    &response,
                    &shared,
                    meta.as_ref(),
                )
            })
            .await
        };
        let draft = match stored {
            Ok(draft) => draft,
            Err(error) => return fail(error),
        };
        for avatar_state in ALL_STATES {
            let path = image_of(&draft.images, avatar_state);
            let phase = if path.is_some() {
                CohostAvatarPhase::Done
            } else {
                CohostAvatarPhase::Failed
            };
            let error = draft.failed.get(&avatar_state).cloned();
            self.progress(avatar_state, phase, path, error);
        }
        self.state.emit_log(
            "info",
            format!(
                "Buddy look drafted: {} of 4 pictures made; nothing changes until it is kept.",
                ALL_STATES.len() - draft.failed.len()
            ),
        );
        self.state.emit_event(COHOST_AVATAR_DRAFT_EVENT, draft);
        // Plan 170 D13: it is in the account library already.
        if let (Some((_, avatar)), Some(pictures)) = (library, pictures) {
            crate::cohost_library::note_created(&self.state, &avatar, &pictures).await;
        }
    }

    async fn run_redo(
        &self,
        avatar_state: CohostAvatarState,
        route: RedoRoute,
        cancelled: Arc<AtomicBool>,
    ) {
        self.progress(avatar_state, CohostAvatarPhase::Working, None, None);
        let dir = draft_dir(&self.root, &self.persona_id, &self.request_id);
        let made = match route {
            RedoRoute::Set(request) => self
                .api
                .post_cohost_avatar_set(&self.token, &request)
                .await
                .map(|response| (response, None)),
            RedoRoute::Library { avatar_id } => self
                .api
                .post_buddy_avatar_redo(&self.token, &avatar_id, avatar_state)
                .await
                .map(|redone| {
                    (
                        CohostAvatarSetResponse {
                            images: redone.images,
                            failed: BTreeMap::new(),
                        },
                        Some(redone.avatar),
                    )
                }),
        };
        let mut redone_avatar: Option<(
            BuddyLibraryWebAvatar,
            BTreeMap<CohostAvatarState, Vec<u8>>,
        )> = None;
        let outcome = match made {
            Err(error) => Err(tile_error(&error)),
            Ok((response, avatar)) => {
                if let Some(avatar) = avatar {
                    redone_avatar = Some((avatar, set_pictures(&response)));
                }
                let dir = dir.clone();
                let shared = self.shared.clone();
                blocking(move || store_redo(&dir, avatar_state, &response, &shared, &cancelled))
                    .await
            }
        };
        if outcome.is_ok()
            && let Some((avatar, pictures)) = redone_avatar
        {
            crate::cohost_library::note_redone(&self.state, &avatar, &pictures).await;
        }
        match outcome {
            Ok(()) => self.progress(
                avatar_state,
                CohostAvatarPhase::Done,
                Some(draft_relative_path(
                    &self.persona_id,
                    &self.request_id,
                    avatar_state,
                )),
                None,
            ),
            Err(error) => {
                self.state.emit_log(
                    "warn",
                    format!(
                        "Buddy look redo of {} failed ({}): {}",
                        avatar_state.as_str(),
                        error.code,
                        error.message
                    ),
                );
                self.progress(avatar_state, CohostAvatarPhase::Failed, None, Some(error));
            }
        }
        let persona_id = self.persona_id.clone();
        let request_id = self.request_id.clone();
        let draft = blocking(move || Ok(read_draft_dir(&dir, &persona_id, &request_id)))
            .await
            .ok()
            .flatten();
        if let Some(draft) = draft {
            self.state.emit_event(COHOST_AVATAR_DRAFT_EVENT, draft);
        }
    }
}

/// Write a set as the persona's one draft: into a staging folder first, then
/// renamed into place under the commit lock, where every earlier draft goes.
/// A set without a usable idle writes nothing.
fn store_set(
    root: &Path,
    persona_id: &str,
    request_id: &str,
    response: &CohostAvatarSetResponse,
    shared: &AvatarShared,
    library: Option<&DraftLibrary>,
) -> Result<CohostAvatarDraft, CohostAvatarErrorDetail> {
    let mut pictures = BTreeMap::new();
    let mut failed = BTreeMap::new();
    for state in ALL_STATES {
        match response.images.get(state) {
            Some(image) => match generated_png(&image.png_base64) {
                Ok(bytes) => {
                    pictures.insert(state, bytes);
                }
                Err(error) => {
                    failed.insert(state, error);
                }
            },
            None => {
                failed.insert(state, web_failure(response, state));
            }
        }
    }
    if !pictures.contains_key(&CohostAvatarState::Idle) {
        return Err(failed
            .remove(&CohostAvatarState::Idle)
            .unwrap_or_else(not_made));
    }
    let drafts = drafts_dir(root, persona_id);
    let staging = drafts.join(format!("{STAGING_PREFIX}{request_id}"));
    let written = (|| {
        std::fs::create_dir_all(&staging)
            .map_err(|error| store_error("Could not create the draft folder", error))?;
        for (state, bytes) in &pictures {
            write_atomic(&staging, &format!("{}.png", state.as_str()), bytes)?;
        }
        if let Some(library) = library {
            let bytes = serde_json::to_vec(library)
                .map_err(|error| store_error("Could not save the draft", error))?;
            write_atomic(&staging, LIBRARY_FILE, &bytes)?;
        }
        write_failed(&staging, &failed)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
    let destination = drafts.join(request_id);
    if let Err(error) = std::fs::rename(&staging, &destination) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(store_error("Could not save the draft", error));
    }
    // One draft per persona: the new one replaces every earlier draft.
    if let Ok(entries) = std::fs::read_dir(&drafts) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy() == request_id {
                continue;
            }
            let path = entry.path();
            let removed = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(error) = removed {
                tracing::warn!(%error, "an earlier Buddy look draft could not be removed");
            }
        }
    }
    read_draft_dir(&destination, persona_id, request_id)
        .ok_or_else(|| store_error("Could not read the draft back", "idle.png is missing"))
}

// --- cohost.avatar.redo -------------------------------------------------------------------------

/// `cohost.avatar.redo`: remake talk, laugh or think of the draft from its
/// idle (one image off the daily cap). Accepted at once; the outcome is a
/// `cohost.avatar.progress` for that state and the updated draft.
pub async fn redo(
    state: &AppState,
    params: CohostAvatarRedoParams,
) -> Result<CohostAvatarAccepted, CohostAvatarRefusal> {
    redo_in(state, AvatarEnv::process(state), params).await
}

async fn redo_in(
    state: &AppState,
    env: AvatarEnv,
    params: CohostAvatarRedoParams,
) -> Result<CohostAvatarAccepted, CohostAvatarRefusal> {
    if params.state == CohostAvatarState::Idle {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "Idle has no Redo: Try again makes a new character.",
        ));
    }
    if !request_id_ok(&params.request_id) {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "The request id is not a draft id.",
        ));
    }
    let root = env.root()?;
    let (api, token) = env.web()?;
    let persona = active_persona(state).await?;
    // Plan 170 D13: a library draft is remade by the library (from the
    // stored idle), so the account avatar gets the new pose too.
    let library = {
        let dir = draft_dir(&root, &persona.id, &params.request_id);
        blocking(move || Ok(read_library(&dir)))
            .await
            .map_err(refusal_of)?
    };
    let base = if library.is_some() {
        String::new()
    } else {
        let idle = draft_dir(&root, &persona.id, &params.request_id).join("idle.png");
        blocking(move || {
            if !is_regular_file(&idle) {
                return Err(CohostAvatarErrorDetail::new(
                    COHOST_AVATAR_DRAFT_NONE,
                    "That draft is not on this computer any more.",
                ));
            }
            let bytes = std::fs::read(&idle)
                .map_err(|error| store_error("Could not read the draft", error))?;
            if bytes.is_empty() || bytes.len() > COHOST_AVATAR_IMAGE_IN_MAX_BYTES {
                return Err(CohostAvatarErrorDetail::new(
                    COHOST_AVATAR_PICTURE_TOO_LARGE,
                    "The draft's idle picture is over 3 MB, too large to redo from. Try again instead.",
                ));
            }
            Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        })
        .await
        .map_err(refusal_of)?
    };
    let guard = env.shared.begin(
        &params.request_id,
        CohostAvatarJobKind::Redo,
        Some(params.state),
    )?;
    let route = match library {
        Some(library) => RedoRoute::Library {
            avatar_id: library.library_avatar_id,
        },
        None => RedoRoute::Set(CohostAvatarSetRequest {
            description: None,
            inspiration: None,
            redo: Some(params.state),
            base: Some(base),
        }),
    };
    let job = SetJob {
        state: state.clone(),
        root,
        persona_id: persona.id,
        request_id: params.request_id.clone(),
        api,
        token,
        shared: env.shared.clone(),
    };
    let avatar_state = params.state;
    tokio::spawn(async move {
        let cancelled = guard.cancelled.clone();
        job.run_redo(avatar_state, route, cancelled).await;
        drop(guard);
    });
    Ok(CohostAvatarAccepted {
        request_id: params.request_id,
    })
}

/// A redo's picture into the draft, under the commit lock: dropped when the
/// draft was discarded or replaced while the web worked. A state the web
/// could not remake keeps its earlier picture; one that had none records
/// why.
fn store_redo(
    dir: &Path,
    state: CohostAvatarState,
    response: &CohostAvatarSetResponse,
    shared: &AvatarShared,
    cancelled: &AtomicBool,
) -> Result<(), CohostAvatarErrorDetail> {
    let picture = match response.images.get(state) {
        Some(image) => generated_png(&image.png_base64),
        None => Err(web_failure(response, state)),
    };
    let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
    if cancelled.load(Ordering::Acquire) || !dir.is_dir() {
        return Err(CohostAvatarErrorDetail::new(
            COHOST_AVATAR_CANCELLED,
            "The draft was discarded, so its redo was dropped.",
        ));
    }
    let file = format!("{}.png", state.as_str());
    let mut failed = read_failed(dir);
    match picture {
        Ok(bytes) => {
            write_atomic(dir, &file, &bytes)?;
            failed.remove(&state);
            write_failed(dir, &failed)
        }
        Err(error) => {
            if !is_regular_file(&dir.join(&file)) {
                failed.insert(state, error.clone());
                write_failed(dir, &failed)?;
            }
            Err(error)
        }
    }
}

// --- cohost.avatar.keep / discard / draft.get ------------------------------------------------------

/// `cohost.avatar.keep`: the draft becomes the Buddy's look. Its pictures
/// move to `<personaId>/<state>-<tag>.png`; a state the draft does not have
/// loses its old picture too (it was a different character), so it falls
/// back to the new idle. The persona's images and `source: generated` are
/// saved and the settings returned; the earlier pictures go only once the
/// persona points at the new ones.
pub async fn keep(
    state: &AppState,
    params: CohostAvatarRequestIdParams,
) -> Result<CohostSettings, CohostAvatarRefusal> {
    keep_in(state, AvatarEnv::process(state), params).await
}

async fn keep_in(
    state: &AppState,
    env: AvatarEnv,
    params: CohostAvatarRequestIdParams,
) -> Result<CohostSettings, CohostAvatarRefusal> {
    if !request_id_ok(&params.request_id) {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "The request id is not a draft id.",
        ));
    }
    if env
        .shared
        .running()
        .is_some_and(|job| job.request_id == params.request_id)
    {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_BUSY,
            "A picture of this draft is being remade. Wait for it to finish.",
        ));
    }
    let root = env.root()?;
    let persona = active_persona(state).await?;
    // Plan 170 D13: a library draft names its account avatar; keeping it
    // applies the avatar's name, personality and "About you" and tells the
    // account. Read before the draft folder goes.
    let library = {
        let dir = draft_dir(&root, &persona.id, &params.request_id);
        blocking(move || Ok(read_library(&dir)))
            .await
            .map_err(refusal_of)?
    };
    let (kept, stale) = {
        let root = root.clone();
        let persona_id = persona.id.clone();
        let request_id = params.request_id.clone();
        let shared = env.shared.clone();
        blocking(move || move_draft_into_place(&root, &persona_id, &request_id, &shared))
            .await
            .map_err(refusal_of)?
    };
    // The latest persona is read again: only its images and source change.
    let mut next = active_persona(state).await?;
    if next.id != persona.id {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "Your Buddy changed while its look was kept.",
        ));
    }
    let mut images = CohostPersonaImages::default();
    for avatar_state in kept {
        set_image(
            &mut images,
            avatar_state,
            Some(avatar_relative_path(
                &persona.id,
                &params.request_id,
                avatar_state,
            )),
        );
    }
    next.images = images;
    next.source = CohostPersonaSource::Generated;
    let mut notes = None;
    if let Some(library) = &library {
        let name = crate::cohost::truncate_utf16(library.name.trim(), LIBRARY_NAME_MAX_CHARS);
        if !name.trim().is_empty() {
            next.name = name.trim().to_string();
        }
        next.personality =
            crate::cohost::truncate_utf16(&library.personality, LIBRARY_PERSONALITY_MAX_CHARS);
        next.avatar = crate::buddy_pet::BuddyAvatar::Still;
        next.library_avatar_id = Some(library.library_avatar_id.clone());
        notes = (!library.context.trim().is_empty())
            .then(|| crate::cohost::truncate_utf16(&library.context, LIBRARY_CONTEXT_MAX_CHARS));
    }
    let settings = crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            persona: Some(next),
            notes,
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .map_err(|error| {
        CohostAvatarRefusal::new(
            error.code(),
            format!("The pictures were kept, but your Buddy could not be saved: {error}"),
        )
    })?;
    // The persona wears the new pictures: the earlier ones (an older look,
    // uploads from before plan 169) go now.
    let _ = blocking(move || {
        for file in stale {
            if let Err(error) = std::fs::remove_file(&file) {
                tracing::warn!(%error, "an earlier Buddy picture could not be removed");
            }
        }
        Ok(())
    })
    .await;
    // Plan 168 S-B1: the still pet on stream re-reads the persona's images.
    state.buddy_sprite.invalidate();
    state.emit_log("info", "Buddy look kept.");
    if let Some(library) = library {
        crate::cohost_library::select_after_keep(state, &library.library_avatar_id);
    }
    Ok(settings)
}

/// The keep's file work, under the commit lock: the draft's pictures move
/// into the persona folder under their kept names. Returns the states kept
/// and the earlier pictures to remove once the persona points at the new.
fn move_draft_into_place(
    root: &Path,
    persona_id: &str,
    request_id: &str,
    shared: &AvatarShared,
) -> Result<(Vec<CohostAvatarState>, Vec<PathBuf>), CohostAvatarErrorDetail> {
    let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
    let dir = draft_dir(root, persona_id, request_id);
    if !is_regular_file(&dir.join("idle.png")) {
        return Err(CohostAvatarErrorDetail::new(
            COHOST_AVATAR_DRAFT_NONE,
            "That draft is not on this computer any more.",
        ));
    }
    let folder = root.join(persona_id);
    let mut kept = Vec::new();
    let mut kept_names = Vec::new();
    for state in ALL_STATES {
        let source = dir.join(format!("{}.png", state.as_str()));
        if is_regular_file(&source) {
            let name = kept_file_name(request_id, state);
            crate::atomic_file::replace_file(&source, &folder.join(&name))
                .map_err(|error| store_error("Could not keep the new look", error))?;
            kept.push(state);
            kept_names.push(name);
        }
    }
    let stale = std::fs::read_dir(&folder)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|file| {
                    !kept_names.contains(file)
                        && ALL_STATES
                            .iter()
                            .any(|state| is_state_picture(file, *state))
                })
                .map(|file| folder.join(file))
                .collect()
        })
        .unwrap_or_default();
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        tracing::warn!(%error, "the kept Buddy look draft folder could not be removed");
    }
    remove_drafts_dir_if_empty(root, persona_id);
    Ok((kept, stale))
}

/// `cohost.avatar.discard`: delete the draft (a redo still running for it
/// drops its result). Discarding a draft that is gone is a no-op.
pub async fn discard(
    state: &AppState,
    params: CohostAvatarRequestIdParams,
) -> Result<CohostAvatarDraftStatus, CohostAvatarRefusal> {
    discard_in(state, AvatarEnv::process(state), params).await
}

async fn discard_in(
    state: &AppState,
    env: AvatarEnv,
    params: CohostAvatarRequestIdParams,
) -> Result<CohostAvatarDraftStatus, CohostAvatarRefusal> {
    if !request_id_ok(&params.request_id) {
        return Err(CohostAvatarRefusal::new(
            COHOST_AVATAR_INVALID,
            "The request id is not a draft id.",
        ));
    }
    let root = env.root()?;
    let persona = active_persona(state).await?;
    env.shared.cancel(&params.request_id);
    let library = {
        let persona_id = persona.id.clone();
        let request_id = params.request_id.clone();
        let shared = env.shared.clone();
        blocking(move || {
            let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
            let library = read_library(&draft_dir(&root, &persona_id, &request_id));
            match std::fs::remove_dir_all(draft_dir(&root, &persona_id, &request_id)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(store_error("Could not delete the draft", error)),
            }
            remove_drafts_dir_if_empty(&root, &persona_id);
            Ok(library)
        })
        .await
        .map_err(refusal_of)?
    };
    // Plan 170 D13: a library draft leaves the account library too.
    if let Some(library) = library {
        crate::cohost_library::delete_after_discard(state, &library.library_avatar_id);
    }
    state.emit_log("info", "Buddy look draft discarded.");
    draft_status_in(state, env).await
}

/// `cohost.avatar.draft.get`: the active Buddy's draft (a draft left on disk
/// by an earlier run is offered again) and the job running now.
pub async fn draft_status(
    state: &AppState,
) -> Result<CohostAvatarDraftStatus, CohostAvatarRefusal> {
    draft_status_in(state, AvatarEnv::process(state)).await
}

async fn draft_status_in(
    state: &AppState,
    env: AvatarEnv,
) -> Result<CohostAvatarDraftStatus, CohostAvatarRefusal> {
    let running = env.shared.running();
    let Some(root) = env.root else {
        return Ok(CohostAvatarDraftStatus {
            draft: None,
            running,
        });
    };
    let persona = state.cohost.lock().await.settings().persona.clone();
    if !persona_id_ok(&persona.id) {
        return Ok(CohostAvatarDraftStatus {
            draft: None,
            running,
        });
    }
    let draft = blocking(move || Ok(find_draft(&root, &persona.id)))
        .await
        .map_err(refusal_of)?;
    Ok(CohostAvatarDraftStatus { draft, running })
}

#[cfg(test)]
mod tests;
