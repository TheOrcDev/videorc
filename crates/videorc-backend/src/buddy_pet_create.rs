//! The Buddy pet creator's orchestration (plan 168 S-F4): one creation from
//! a reference picture to a saved pack.
//!
//! A creation is a web build session (`POST /api/ai/cohost/pet/builds`, D20)
//! plus a local folder under the managed buddy root,
//! `<root>/<personaId>/creations/<buildId>/`:
//!
//! - `build-state.json`: the step, the web build id and its expiry, the
//!   allowance left, the identity notes and every source with its SHA-256,
//!   and which version of each sheet is accepted. Everything a restart needs
//!   to resume lives here; nothing about a running job is persisted.
//! - `sources/<key>-v<n>.png`: the reference and every generated sheet,
//!   versioned, never overwritten (a redo is a new version).
//! - `pack/`: the last successful build ([`crate::buddy_pet_build`]);
//!   `staging/` while a build runs.
//!
//! The web calls (identity up to 60 s, a sheet up to 155 s) and the build
//! never run on the websocket mutation lane (10 s deadline): each RPC checks
//! what it can at once, answers with an acceptance, and the outcome arrives
//! as an event (`cohost.pet.identity.read`, `cohost.pet.sheet.generated`,
//! `cohost.pet.build.progress`), as the Buddy look's RPCs do. One job
//! runs at a time per process. `cohost.pet.save` moves the built pack to
//! `<root>/<personaId>/pets/<packId>/` and switches the persona to Alive;
//! `cohost.pet.creation.cancel` removes the creation folder, and a job still
//! in flight for it discards its result. Nothing is written outside the
//! managed root.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine as _;
use chrono::{DateTime, Datelike, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::buddy_pet::{self, BuddyPetSummary};
use crate::buddy_pet_build::{
    self, BuildError, BuildInput, BuildStage, BuildStep, GazeRow, SheetInput, SheetKind, SourceFile,
};
use crate::cohost::{BuddyAvatar, CohostPersona, CohostSettings};
use crate::protocol::CohostSettingsPatch;
use crate::state::AppState;
use crate::videorc_api::{
    CohostApiError, CohostApiErrorKind, CohostPetIdentityRequest, CohostPetSheetRequest,
    VideorcApiClient,
};

pub const COHOST_PET_IDENTITY_READ_EVENT: &str = "cohost.pet.identity.read";
pub const COHOST_PET_SHEET_GENERATED_EVENT: &str = "cohost.pet.sheet.generated";
pub const COHOST_PET_BUILD_PROGRESS_EVENT: &str = "cohost.pet.build.progress";

/// The request is malformed or breaks a creator rule (the message says which).
pub const COHOST_PET_INVALID: &str = "cohost-pet-invalid";
/// No creation with that build id for the active Buddy.
pub const COHOST_PET_CREATION_NONE: &str = "cohost-pet-creation-none";
/// A creation is already in progress for the active Buddy.
pub const COHOST_PET_CREATION_ACTIVE: &str = "cohost-pet-creation-active";
/// Another creator job is running.
pub const COHOST_PET_BUSY: &str = "cohost-pet-busy";
/// An earlier step is missing (the message names it).
pub const COHOST_PET_NOT_READY: &str = "cohost-pet-not-ready";
/// The reference picture cannot be used (opaque, empty, too large).
pub const COHOST_PET_REFERENCE_INVALID: &str = "cohost-pet-reference-invalid";
/// This process has no buddy root (bare `cargo run`).
pub const COHOST_PET_UNAVAILABLE: &str = "cohost-pet-unavailable";
/// A file in the creation folder could not be read or written.
pub const COHOST_PET_STORE_FAILED: &str = "cohost-pet-store-failed";
/// The creation was cancelled while the job ran; its result was discarded.
pub const COHOST_PET_CANCELLED: &str = "cohost-pet-cancelled";
/// The web build session is past its expiry (24 h) or gone (web 410).
pub const PET_BUILD_EXPIRED: &str = "pet-build-expired";

/// Copy for the web's "model not configured" family, as the avatar tile says.
pub const BUDDY_PET_NOT_AVAILABLE: &str = "Not available yet";
pub const BUDDY_PET_EXPIRED_MESSAGE: &str = "This creation expired; start a new one.";

const CREATIONS_DIR: &str = "creations";
const STATE_FILE: &str = "build-state.json";
const SOURCES_DIR: &str = "sources";
const PACK_DIR: &str = "pack";
const STAGING_DIR: &str = "staging";
const STATE_VERSION: u32 = 1;
const STATE_MAX_BYTES: u64 = 1024 * 1024;
/// The sheet key of the reference picture in `sources/` and `accepted`.
pub const REFERENCE_KEY: &str = "reference";
/// A reference is sent as base64 inside a JSON body, and Vercel refuses
/// request bodies over 4.5 MB before the route runs (plan 172), so the PNG
/// stays at or under 3 MB.
pub const REFERENCE_PNG_MAX_BYTES: usize = 3 * 1024 * 1024;
/// A reference is scaled down to this on its longest side before it is sent
/// (the official references are 1024 px); a picture still over
/// `REFERENCE_PNG_MAX_BYTES` there steps down through `REFERENCE_FALLBACK_SIDES`.
pub const REFERENCE_MAX_SIDE: u32 = 1024;
const REFERENCE_FALLBACK_SIDES: [u32; 2] = [768, 512];
/// An upload is refused above this before it is decoded.
pub const REFERENCE_UPLOAD_MAX_BYTES: usize = 8 * 1024 * 1024;
const REFERENCE_MAX_PIXELS: u64 = 20_000_000;
/// A generated sheet is refused above this before it is written.
const SHEET_PNG_MAX_BYTES: usize = 16 * 1024 * 1024;
/// The web's bounds on the identity notes.
pub const NOTES_LIST_MAX: usize = 8;
pub const NOTES_ITEM_MAX_CHARS: usize = 60;
pub const NOTES_PROPORTIONS_MAX_CHARS: usize = 400;
pub const NOTES_ASYMMETRIC_MAX: usize = 12;
pub const NOTES_FEATURE_MAX_CHARS: usize = 80;
/// A pack name is at most this many UTF-16 units (the pack list's bound).
pub const PACK_NAME_MAX_CHARS: usize = buddy_pet::BUDDY_PET_TEXT_MAX;

// --- Wire types ---------------------------------------------------------------

/// Which side of the character an asymmetric feature is on (anatomical).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuddyPetSide {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetAsymmetry {
    pub feature: String,
    pub side: BuddyPetSide,
}

/// The identity notes (D19): what the vision call read from the reference,
/// shown as editable sentences and sent with every sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetIdentityNotes {
    #[serde(default)]
    pub palette: Vec<String>,
    #[serde(default)]
    pub materials: Vec<String>,
    pub proportions: String,
    #[serde(default)]
    pub asymmetric: Vec<BuddyPetAsymmetry>,
}

/// A sheet kind as the web route names it (`row` rides with `gaze`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyPetSheetKindName {
    Pilot,
    Gaze,
    ReactionsA,
    ReactionsB,
    Extras,
}

impl BuddyPetSheetKindName {
    fn of(kind: SheetKind) -> (Self, Option<GazeRow>) {
        match kind {
            SheetKind::Pilot => (Self::Pilot, None),
            SheetKind::Gaze { row } => (Self::Gaze, Some(row)),
            SheetKind::ReactionsA => (Self::ReactionsA, None),
            SheetKind::ReactionsB => (Self::ReactionsB, None),
            SheetKind::Extras => (Self::Extras, None),
        }
    }
}

/// Where the reference picture comes from: the persona's idle image (the
/// bundled default when it has none) or a picture the user chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BuddyPetReference {
    PersonaIdle,
    Upload {
        /// A PNG or WebP with transparency, as base64.
        #[serde(rename = "imageBase64")]
        image_base64: String,
    },
}

/// `cohost.pet.identity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetIdentityParams {
    pub build_id: String,
    pub reference: BuddyPetReference,
}

/// `cohost.pet.sheet.generate`. `notes` (the corrected identity notes)
/// rides with the pilot only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetSheetGenerateParams {
    pub build_id: String,
    pub kind: BuddyPetSheetKindName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<GazeRow>,
    #[serde(default)]
    pub redo: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<BuddyPetIdentityNotes>,
}

/// `cohost.pet.build` and `cohost.pet.creation.cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetBuildIdParams {
    pub build_id: String,
}

/// `cohost.pet.save`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetSaveParams {
    pub build_id: String,
    pub name: String,
}

/// The answer to an accepted job; the outcome is its event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetCreationAccepted {
    pub build_id: String,
    /// The sheet key a `cohost.pet.sheet.generate` works on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
}

/// What `cohost.pet.save` hands back: the saved pack and the settings with
/// the persona now Alive in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohostPetSaved {
    pub pack: BuddyPetSummary,
    pub settings: CohostSettings,
}

/// Where a creation stands (D18, D21). Derived from the data each time the
/// state is written: no notes yet → `reference`; notes but no accepted pilot
/// → `pilot`; until a build of the accepted sheets succeeds → `build`;
/// then `review`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyPetCreationStep {
    Reference,
    Pilot,
    Build,
    Review,
}

/// One stored source: the reference or a generated sheet version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetCreationSource {
    /// `reference` or a sheet key (`pilot`, `gaze-level`, `reactions-a` ...).
    pub sheet: String,
    pub version: u32,
    /// Relative to the creation folder: `sources/<sheet>-v<version>.png`.
    pub file: String,
    pub sha256: String,
    /// The web said the sheet came back without transparency.
    #[serde(default)]
    pub opaque: bool,
    /// The reference version a sheet was generated from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_version: Option<u32>,
    pub created_at: String,
}

/// Why a build failed, naming the sheet and the cell when the builder did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetBuildFailure {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyPetBuildState {
    Built,
    Failed,
}

/// The last build as the wizard shows it: `fresh` when it was made from the
/// sheets accepted now (a redo makes it stale).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetCreationBuild {
    pub state: BuddyPetBuildState,
    pub fresh: bool,
    pub finished_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BuddyPetBuildFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyPetCreatorJob {
    Start,
    Identity,
    Sheet,
    Build,
    Save,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetCreationRunning {
    pub job: BuddyPetCreatorJob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
}

/// One creation as `cohost.pet.creation.status` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetCreation {
    pub build_id: String,
    pub step: BuddyPetCreationStep,
    pub created_at: String,
    pub expires_at: String,
    /// Past `expiresAt`: generation is over; a build and a save still work.
    pub expired: bool,
    pub sheets_allowed: u32,
    pub redos_allowed: u32,
    pub pilots_allowed: u32,
    pub sheets_remaining: u32,
    pub redos_remaining: u32,
    pub pilots_used: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<BuddyPetCreationSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<BuddyPetIdentityNotes>,
    /// The latest pilot made from the current reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilot: Option<BuddyPetCreationSource>,
    pub pilot_accepted: bool,
    /// The accepted version of each atlas sheet generated so far, in atlas
    /// order (gaze `up2` to `down2`, `reactions-a`, `reactions-b`, `extras`).
    pub sheets: Vec<BuddyPetCreationSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuddyPetCreationBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<BuddyPetCreationRunning>,
}

/// `cohost.pet.creation.status` (and what start and cancel answer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetCreationStatus {
    pub creation: Option<BuddyPetCreation>,
}

/// A refusal, or a failed job in an event: a code and one plain sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuddyPetCreatorError {
    pub code: String,
    pub message: String,
}

impl BuddyPetCreatorError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// `cohost.pet.identity.read`: the notes, or why there are none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetIdentityReadEvent {
    pub build_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<BuddyPetIdentityNotes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BuddyPetCreatorError>,
}

/// `cohost.pet.sheet.generated`: the stored version, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetSheetGeneratedEvent {
    pub build_id: String,
    pub sheet: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default)]
    pub opaque: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets_remaining: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redos_remaining: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BuddyPetCreatorError>,
}

/// A build's stage, then `done` or `failed` once it ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyPetBuildProgressStep {
    Reading,
    Cutting,
    Registering,
    Packing,
    Writing,
    Done,
    Failed,
}

/// `cohost.pet.build.progress`: the builder's `BuildStep`, then the end.
/// A failure carries the builder's code and message, and the sheet and cell
/// it names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyPetBuildProgressEvent {
    pub build_id: String,
    pub step: BuddyPetBuildProgressStep,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
    pub done: u32,
    pub total: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

// --- The persisted state ------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildRecord {
    state: BuddyPetBuildState,
    /// The accepted versions it was built from, the reference included.
    versions: BTreeMap<String, u32>,
    finished_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<BuddyPetBuildFailure>,
}

/// `build-state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildState {
    version: u32,
    build_id: String,
    persona_id: String,
    step: BuddyPetCreationStep,
    created_at: String,
    expires_at: String,
    sheets_allowed: u32,
    redos_allowed: u32,
    pilots_allowed: u32,
    sheets_remaining: u32,
    redos_remaining: u32,
    #[serde(default)]
    pilots_used: u32,
    #[serde(default)]
    identity_reads: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notes: Option<BuddyPetIdentityNotes>,
    /// Every stored version, oldest first.
    #[serde(default)]
    sources: Vec<BuddyPetCreationSource>,
    /// Sheet key to its accepted version: the reference in use, the pilot
    /// once it looked right, and the latest version of each atlas sheet.
    #[serde(default)]
    accepted: BTreeMap<String, u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    build: Option<BuildRecord>,
}

impl BuildState {
    fn source(&self, key: &str, version: u32) -> Option<&BuddyPetCreationSource> {
        self.sources
            .iter()
            .find(|source| source.sheet == key && source.version == version)
    }

    fn accepted_source(&self, key: &str) -> Option<&BuddyPetCreationSource> {
        self.accepted
            .get(key)
            .and_then(|version| self.source(key, *version))
    }

    fn reference(&self) -> Option<&BuddyPetCreationSource> {
        self.accepted_source(REFERENCE_KEY)
    }

    fn latest(&self, key: &str) -> Option<&BuddyPetCreationSource> {
        self.sources
            .iter()
            .filter(|source| source.sheet == key)
            .max_by_key(|source| source.version)
    }

    /// The latest pilot made from the reference in use.
    fn current_pilot(&self) -> Option<&BuddyPetCreationSource> {
        let reference = self.reference()?.version;
        self.sources
            .iter()
            .filter(|source| {
                source.sheet == SheetKind::Pilot.key()
                    && source.reference_version == Some(reference)
            })
            .max_by_key(|source| source.version)
    }

    fn pilot_accepted(&self) -> bool {
        self.accepted.contains_key(SheetKind::Pilot.key())
    }

    fn next_version(&self, key: &str) -> u32 {
        self.latest(key).map_or(1, |source| source.version + 1)
    }

    /// The versions a build reads now: the reference and the atlas sheets.
    fn build_versions(&self) -> BTreeMap<String, u32> {
        std::iter::once(REFERENCE_KEY)
            .chain(SheetKind::ATLAS_ORDER.iter().map(|kind| kind.key()))
            .filter_map(|key| {
                self.accepted
                    .get(key)
                    .map(|version| (key.to_string(), *version))
            })
            .collect()
    }

    fn build_fresh(&self, dir: &Path) -> bool {
        self.build.as_ref().is_some_and(|build| {
            build.state == BuddyPetBuildState::Built
                && build.versions == self.build_versions()
                && dir
                    .join(PACK_DIR)
                    .join(buddy_pet::BUDDY_PET_MANIFEST_FILE)
                    .is_file()
        })
    }

    fn derive_step(&self, dir: &Path) -> BuddyPetCreationStep {
        if self.notes.is_none() {
            BuddyPetCreationStep::Reference
        } else if !self.pilot_accepted() {
            BuddyPetCreationStep::Pilot
        } else if self.build_fresh(dir) {
            BuddyPetCreationStep::Review
        } else {
            BuddyPetCreationStep::Build
        }
    }

    fn expired_at(&self, now: DateTime<Utc>) -> bool {
        DateTime::parse_from_rfc3339(&self.expires_at)
            .map(|expires| now >= expires.with_timezone(&Utc))
            .unwrap_or(true)
    }

    fn wire(
        &self,
        dir: &Path,
        now: DateTime<Utc>,
        running: Option<BuddyPetCreationRunning>,
    ) -> BuddyPetCreation {
        BuddyPetCreation {
            build_id: self.build_id.clone(),
            step: self.derive_step(dir),
            created_at: self.created_at.clone(),
            expires_at: self.expires_at.clone(),
            expired: self.expired_at(now),
            sheets_allowed: self.sheets_allowed,
            redos_allowed: self.redos_allowed,
            pilots_allowed: self.pilots_allowed,
            sheets_remaining: self.sheets_remaining,
            redos_remaining: self.redos_remaining,
            pilots_used: self.pilots_used,
            reference: self.reference().cloned(),
            notes: self.notes.clone(),
            pilot: self.current_pilot().cloned(),
            pilot_accepted: self.pilot_accepted(),
            sheets: SheetKind::ATLAS_ORDER
                .iter()
                .filter_map(|kind| self.accepted_source(kind.key()).cloned())
                .collect(),
            build: self.build.as_ref().map(|build| BuddyPetCreationBuild {
                state: build.state,
                fresh: self.build_fresh(dir),
                finished_at: build.finished_at.clone(),
                error: build.error.clone(),
            }),
            running,
        }
    }
}

// --- Jobs: one at a time per process ------------------------------------------

struct RunningJob {
    id: u64,
    build_id: String,
    job: BuddyPetCreatorJob,
    sheet: Option<String>,
    cancelled: Arc<AtomicBool>,
}

/// The creator's process state: the one running job, and the lock every
/// write to (or removal of) a creation folder holds.
#[derive(Default)]
pub(crate) struct CreatorShared {
    job: Mutex<Option<RunningJob>>,
    next_job: AtomicU64,
    commit: Mutex<()>,
}

static PROCESS_CREATOR: LazyLock<Arc<CreatorShared>> =
    LazyLock::new(|| Arc::new(CreatorShared::default()));

/// The running job's slot; dropping it frees the slot (when it still holds
/// this job: a cancel frees it early and a new job may have taken it).
struct JobGuard {
    shared: Arc<CreatorShared>,
    id: u64,
    cancelled: Arc<AtomicBool>,
}

impl JobGuard {
    fn cancelled(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut slot = self.shared.job.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|job| job.id == self.id) {
            *slot = None;
        }
    }
}

impl CreatorShared {
    fn begin(
        self: &Arc<Self>,
        build_id: &str,
        job: BuddyPetCreatorJob,
        sheet: Option<&str>,
    ) -> Result<JobGuard, BuddyPetCreatorError> {
        let mut slot = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(running) = slot.as_ref() {
            return Err(BuddyPetCreatorError::new(
                COHOST_PET_BUSY,
                match running.job {
                    BuddyPetCreatorJob::Build => "The pack is being built. Wait for it to finish.",
                    BuddyPetCreatorJob::Save => "The pack is being saved. Wait for it to finish.",
                    _ => "The creator is already working. Wait for it to finish.",
                },
            ));
        }
        let id = self.next_job.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        *slot = Some(RunningJob {
            id,
            build_id: build_id.to_string(),
            job,
            sheet: sheet.map(str::to_string),
            cancelled: cancelled.clone(),
        });
        Ok(JobGuard {
            shared: self.clone(),
            id,
            cancelled,
        })
    }

    fn running_for(&self, build_id: &str) -> Option<BuddyPetCreationRunning> {
        let slot = self.job.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref()
            .filter(|job| job.build_id == build_id)
            .map(|job| BuddyPetCreationRunning {
                job: job.job,
                sheet: job.sheet.clone(),
            })
    }

    /// Flag the job of `build_id` (if any) as cancelled and free the slot.
    fn cancel_job(&self, build_id: &str) {
        let mut slot = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|job| job.build_id == build_id)
            && let Some(job) = slot.take()
        {
            job.cancelled.store(true, Ordering::Release);
        }
    }
}

// --- The environment ------------------------------------------------------------

/// What a creator call needs from the process: the write root, the web
/// client and the account. Tests build their own with a fake web.
#[derive(Clone)]
pub(crate) struct CreatorEnv {
    root: Option<PathBuf>,
    api: Option<VideorcApiClient>,
    token: Option<String>,
    premium: bool,
    cell_size: u32,
    shared: Arc<CreatorShared>,
    /// Tests hold the builder just before it writes until they pass this.
    #[cfg(test)]
    build_hold: Option<Arc<std::sync::Barrier>>,
}

impl CreatorEnv {
    fn process() -> Self {
        Self {
            root: crate::cohost_avatar::managed_buddy_root(),
            api: VideorcApiClient::new().ok(),
            token: crate::account::stored_session_token(),
            premium: crate::cohost::premium_entitled(),
            cell_size: buddy_pet_build::DEFAULT_CELL_SIZE,
            shared: PROCESS_CREATOR.clone(),
            #[cfg(test)]
            build_hold: None,
        }
    }

    fn root(&self) -> Result<PathBuf, BuddyPetCreatorError> {
        self.root.clone().ok_or_else(|| {
            BuddyPetCreatorError::new(
                COHOST_PET_UNAVAILABLE,
                "Buddy storage is not configured in this process.",
            )
        })
    }

    /// The web client and bearer token, refused before anything is sent
    /// when the account is Basic or signed out.
    fn web(&self) -> Result<(VideorcApiClient, String), BuddyPetCreatorError> {
        if !self.premium {
            return Err(BuddyPetCreatorError::new(
                "premium-required",
                "Creating a Buddy requires Videorc Premium.",
            ));
        }
        let Some(token) = self.token.clone() else {
            return Err(BuddyPetCreatorError::new(
                "signed-out",
                "Sign in to create a Buddy.",
            ));
        };
        let Some(api) = self.api.clone() else {
            return Err(BuddyPetCreatorError::new(
                "network",
                "Could not start the Videorc web client.",
            ));
        };
        Ok((api, token))
    }
}

// --- Folders and files ------------------------------------------------------------

fn persona_id_ok(persona_id: &str) -> bool {
    !persona_id.is_empty()
        && persona_id.len() <= 128
        && persona_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A build id names a folder: a lowercase hyphenated uuid only.
pub(crate) fn build_id_ok(build_id: &str) -> bool {
    uuid::Uuid::parse_str(build_id).is_ok_and(|uuid| uuid.hyphenated().to_string() == build_id)
}

fn creations_dir(root: &Path, persona_id: &str) -> PathBuf {
    root.join(persona_id).join(CREATIONS_DIR)
}

fn creation_dir(root: &Path, persona_id: &str, build_id: &str) -> PathBuf {
    creations_dir(root, persona_id).join(build_id)
}

fn store_error(what: &str, error: impl std::fmt::Display) -> BuddyPetCreatorError {
    BuddyPetCreatorError::new(COHOST_PET_STORE_FAILED, format!("{what}: {error}"))
}

fn now_iso(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Write `bytes` to `dir/name` through a staged file. The folder must exist:
/// a cancelled creation's folder is never recreated by a late write.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), BuddyPetCreatorError> {
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
        store_error(&format!("Could not write {name}"), error)
    })
}

fn read_state(dir: &Path) -> Result<BuildState, BuddyPetCreatorError> {
    use std::io::Read as _;
    let path = dir.join(STATE_FILE);
    let file = std::fs::File::open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BuddyPetCreatorError::new(
                COHOST_PET_CREATION_NONE,
                "That creation is not on this computer. Start a new one.",
            )
        } else {
            store_error("Could not read the creation", error)
        }
    })?;
    let mut bytes = Vec::new();
    file.take(STATE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| store_error("Could not read the creation", error))?;
    if bytes.len() as u64 > STATE_MAX_BYTES {
        return Err(store_error(
            "Could not read the creation",
            "it is too large",
        ));
    }
    let state: BuildState = serde_json::from_slice(&bytes)
        .map_err(|error| store_error("Could not read the creation", error))?;
    let folder = dir.file_name().and_then(|name| name.to_str());
    if state.version != STATE_VERSION
        || folder != Some(state.build_id.as_str())
        || !build_id_ok(&state.build_id)
    {
        return Err(store_error(
            "Could not read the creation",
            "its state does not match its folder",
        ));
    }
    Ok(state)
}

fn write_state(dir: &Path, state: &mut BuildState) -> Result<(), BuddyPetCreatorError> {
    state.step = state.derive_step(dir);
    let mut bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| store_error("Could not write the creation", error))?;
    bytes.push(b'\n');
    write_atomic(dir, STATE_FILE, &bytes)
}

/// The persona's creation: the newest readable one (there is at most one in
/// normal use). An unreadable folder is skipped and named in `skipped`.
fn find_creation(
    root: &Path,
    persona_id: &str,
    skipped: &mut Vec<String>,
) -> Option<(PathBuf, BuildState)> {
    let entries = std::fs::read_dir(creations_dir(root, persona_id)).ok()?;
    let mut found: Vec<(PathBuf, BuildState)> = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !build_id_ok(&name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = entry.path();
        match read_state(&dir) {
            Ok(state) if state.persona_id == persona_id => found.push((dir, state)),
            Ok(_) => skipped.push(format!("Buddy creation {name} belongs to another Buddy.")),
            Err(error) => skipped.push(format!("Buddy creation {name} skipped: {}", error.message)),
        }
    }
    found
        .into_iter()
        .max_by(|a, b| a.1.created_at.cmp(&b.1.created_at))
}

fn open_creation(
    root: &Path,
    persona_id: &str,
    build_id: &str,
) -> Result<(PathBuf, BuildState), BuddyPetCreatorError> {
    if !build_id_ok(build_id) || !persona_id_ok(persona_id) {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_INVALID,
            "The build id is not a creation id.",
        ));
    }
    let dir = creation_dir(root, persona_id, build_id);
    let state = read_state(&dir)?;
    if state.persona_id != persona_id {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_CREATION_NONE,
            "That creation belongs to another Buddy.",
        ));
    }
    Ok((dir, state))
}

/// Read, change and write the state under the commit lock. Refused when the
/// creation was cancelled (or removed) since the job began.
fn commit<T>(
    shared: &CreatorShared,
    dir: &Path,
    cancelled: Option<&AtomicBool>,
    change: impl FnOnce(&Path, &mut BuildState) -> Result<T, BuddyPetCreatorError>,
) -> Result<T, BuddyPetCreatorError> {
    let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(cancelled_error());
    }
    let mut state = read_state(dir).map_err(|error| {
        if error.code == COHOST_PET_CREATION_NONE {
            cancelled_error()
        } else {
            error
        }
    })?;
    let out = change(dir, &mut state)?;
    write_state(dir, &mut state)?;
    Ok(out)
}

fn cancelled_error() -> BuddyPetCreatorError {
    BuddyPetCreatorError::new(
        COHOST_PET_CANCELLED,
        "The creation was cancelled; this result was not kept.",
    )
}

/// Store `png` as the next version of `key` in `sources/`.
fn store_source(
    dir: &Path,
    state: &mut BuildState,
    key: &str,
    png: &[u8],
    opaque: bool,
    reference_version: Option<u32>,
    now: DateTime<Utc>,
) -> Result<BuddyPetCreationSource, BuddyPetCreatorError> {
    let version = state.next_version(key);
    let name = format!("{key}-v{version}.png");
    write_atomic(&dir.join(SOURCES_DIR), &name, png)?;
    let source = BuddyPetCreationSource {
        sheet: key.to_string(),
        version,
        file: format!("{SOURCES_DIR}/{name}"),
        sha256: buddy_pet_build::sha256_hex(png),
        opaque,
        reference_version,
        created_at: now_iso(now),
    };
    state.sources.push(source.clone());
    Ok(source)
}

/// A stored source's bytes, checked against the SHA-256 it was stored with.
fn read_source(
    dir: &Path,
    source: &BuddyPetCreationSource,
) -> Result<Vec<u8>, BuddyPetCreatorError> {
    let bytes = std::fs::read(dir.join(&source.file))
        .map_err(|error| store_error(&format!("Could not read {}", source.file), error))?;
    if buddy_pet_build::sha256_hex(&bytes) != source.sha256 {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_STORE_FAILED,
            format!(
                "{} changed since it was saved. Start a new creation.",
                source.file
            ),
        ));
    }
    Ok(bytes)
}

// --- Validation -------------------------------------------------------------------

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// The notes trimmed and bounded as the web takes them: blank entries are
/// dropped, the proportions sentence is required.
pub(crate) fn shape_notes(
    notes: BuddyPetIdentityNotes,
) -> Result<BuddyPetIdentityNotes, BuddyPetCreatorError> {
    let invalid = |reason: &str| BuddyPetCreatorError::new(COHOST_PET_INVALID, reason);
    let list = |items: Vec<String>, what: &str| -> Result<Vec<String>, BuddyPetCreatorError> {
        let items: Vec<String> = items
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
        if items.len() > NOTES_LIST_MAX {
            return Err(invalid(&format!("List at most {NOTES_LIST_MAX} {what}.")));
        }
        if items
            .iter()
            .any(|item| utf16_len(item) > NOTES_ITEM_MAX_CHARS)
        {
            return Err(invalid(&format!(
                "Each of the {what} is at most {NOTES_ITEM_MAX_CHARS} characters."
            )));
        }
        Ok(items)
    };
    let palette = list(notes.palette, "colours")?;
    let materials = list(notes.materials, "materials")?;
    let proportions = notes.proportions.trim().to_string();
    if proportions.is_empty() || utf16_len(&proportions) > NOTES_PROPORTIONS_MAX_CHARS {
        return Err(invalid(&format!(
            "Describe the body's proportions in 1 to {NOTES_PROPORTIONS_MAX_CHARS} characters."
        )));
    }
    let asymmetric: Vec<BuddyPetAsymmetry> = notes
        .asymmetric
        .into_iter()
        .map(|item| BuddyPetAsymmetry {
            feature: item.feature.trim().to_string(),
            side: item.side,
        })
        .filter(|item| !item.feature.is_empty())
        .collect();
    if asymmetric.len() > NOTES_ASYMMETRIC_MAX
        || asymmetric
            .iter()
            .any(|item| utf16_len(&item.feature) > NOTES_FEATURE_MAX_CHARS)
    {
        return Err(invalid(&format!(
            "List at most {NOTES_ASYMMETRIC_MAX} one-sided features of up to {NOTES_FEATURE_MAX_CHARS} characters."
        )));
    }
    Ok(BuddyPetIdentityNotes {
        palette,
        materials,
        proportions,
        asymmetric,
    })
}

/// The sheet a generate call asks for, or why the request is malformed.
fn sheet_kind(
    kind: BuddyPetSheetKindName,
    row: Option<GazeRow>,
    redo: bool,
) -> Result<SheetKind, BuddyPetCreatorError> {
    let invalid = |reason: &str| BuddyPetCreatorError::new(COHOST_PET_INVALID, reason);
    let sheet = match (kind, row) {
        (BuddyPetSheetKindName::Gaze, Some(row)) => SheetKind::Gaze { row },
        (BuddyPetSheetKindName::Gaze, None) => return Err(invalid("A gaze sheet needs its row.")),
        (_, Some(_)) => return Err(invalid("Only a gaze sheet has a row.")),
        (BuddyPetSheetKindName::Pilot, None) => SheetKind::Pilot,
        (BuddyPetSheetKindName::ReactionsA, None) => SheetKind::ReactionsA,
        (BuddyPetSheetKindName::ReactionsB, None) => SheetKind::ReactionsB,
        (BuddyPetSheetKindName::Extras, None) => SheetKind::Extras,
    };
    if redo && sheet == SheetKind::Pilot {
        return Err(invalid(
            "A pilot is made again, never redone: generate a new pilot.",
        ));
    }
    Ok(sheet)
}

/// The pack name as it is saved: trimmed, 1 to 64 characters.
pub(crate) fn shape_pack_name(name: &str) -> Result<String, BuddyPetCreatorError> {
    let name = name.trim();
    if name.is_empty() || utf16_len(name) > PACK_NAME_MAX_CHARS {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_INVALID,
            format!("Name the pack in 1 to {PACK_NAME_MAX_CHARS} characters."),
        ));
    }
    Ok(name.to_string())
}

// --- The reference ------------------------------------------------------------------

fn reference_error(message: impl Into<String>) -> BuddyPetCreatorError {
    BuddyPetCreatorError::new(COHOST_PET_REFERENCE_INVALID, message)
}

/// An uploaded picture decoded: PNG or WebP by its bytes (a JPEG has no
/// transparency), at most 8 MB and 20 megapixels.
fn decode_upload(image_base64: &str) -> Result<image::RgbaImage, BuddyPetCreatorError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.trim())
        .map_err(|_| reference_error("The picture could not be read."))?;
    if bytes.is_empty() || bytes.len() > REFERENCE_UPLOAD_MAX_BYTES {
        return Err(reference_error("Choose a picture smaller than 8 MB."));
    }
    let format = match image::guess_format(&bytes) {
        Ok(format @ (image::ImageFormat::Png | image::ImageFormat::WebP)) => format,
        Ok(image::ImageFormat::Jpeg) => {
            return Err(reference_error(
                "A JPEG has no transparency. Use a PNG or WebP with a transparent background.",
            ));
        }
        _ => return Err(reference_error("Choose a PNG or WebP picture.")),
    };
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(buddy_pet::BUDDY_PET_DECODED_MAX_BYTES);
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes[..]), format);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| reference_error("The picture could not be read."))?;
    if u64::from(width) * u64::from(height) > REFERENCE_MAX_PIXELS {
        return Err(reference_error("The picture is over 20 megapixels."));
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes[..]), format);
    reader.limits(limits);
    reader
        .decode()
        .map(|decoded| decoded.into_rgba8())
        .map_err(|_| reference_error("The picture could not be decoded."))
}

/// The persona's idle image (the bundled default without one).
fn persona_idle(
    root: &Path,
    persona: &CohostPersona,
) -> Result<image::RgbaImage, BuddyPetCreatorError> {
    match persona.images.idle.as_deref() {
        Some(relative) => buddy_pet::load_state_image(&[root.to_path_buf()], &persona.id, relative)
            .map_err(|reason| reference_error(format!("The idle image {reason}."))),
        None => image::load_from_memory_with_format(
            buddy_pet::BUNDLED_IDLE_WEBP,
            image::ImageFormat::WebP,
        )
        .map(|decoded| decoded.into_rgba8())
        .map_err(|error| reference_error(format!("The default Buddy could not be read: {error}"))),
    }
}

/// The reference as the web takes it: a character on a transparent
/// background (at least 1 % clear pixels, page-pet's alpha cut of 16),
/// scaled to at most 1536 px on its longest side, as a PNG of at most 4 MB.
pub(crate) fn reference_png(image: image::RgbaImage) -> Result<Vec<u8>, BuddyPetCreatorError> {
    let total = u64::from(image.width()) * u64::from(image.height());
    let clear = image.pixels().filter(|pixel| pixel[3] <= 16).count() as u64;
    if total == 0 || clear == total {
        return Err(reference_error("The picture is empty."));
    }
    if clear * 100 < total {
        return Err(reference_error(
            "The picture needs a transparent background. Use a PNG or WebP with alpha.",
        ));
    }
    let longest = image.width().max(image.height());
    for side in std::iter::once(REFERENCE_MAX_SIDE).chain(REFERENCE_FALLBACK_SIDES) {
        let scaled = if longest > side {
            let scale = f64::from(side) / f64::from(longest);
            image::imageops::resize(
                &image,
                ((f64::from(image.width()) * scale).round() as u32).max(1),
                ((f64::from(image.height()) * scale).round() as u32).max(1),
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            image.clone()
        };
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(scaled)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|error| {
                reference_error(format!("The picture could not be prepared: {error}"))
            })?;
        if png.len() <= REFERENCE_PNG_MAX_BYTES {
            return Ok(png);
        }
    }
    Err(reference_error(
        "The picture is too detailed to send, even made smaller. Use a simpler picture.",
    ))
}

/// A generated sheet checked before it is written: base64 of a PNG, at most
/// 16 MB, at most 8192 px on each side.
fn sheet_png(png_base64: &str) -> Result<Vec<u8>, BuddyPetCreatorError> {
    let unreadable = |reason: &str| BuddyPetCreatorError::new("pet-sheet-unreadable", reason);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|_| {
            unreadable("The model sent back a sheet that could not be read. Try again.")
        })?;
    if bytes.is_empty() || bytes.len() > SHEET_PNG_MAX_BYTES {
        return Err(unreadable(
            "The model sent back an empty or oversized sheet. Try again.",
        ));
    }
    if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
        return Err(unreadable(
            "The model sent back a sheet that is not a PNG. Try again.",
        ));
    }
    let (width, height) =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes[..]), image::ImageFormat::Png)
            .into_dimensions()
            .map_err(|_| {
                unreadable("The model sent back a sheet that could not be read. Try again.")
            })?;
    let side = buddy_pet_build::MAX_SHEET_DIMENSION;
    if width == 0 || height == 0 || width > side || height > side {
        return Err(unreadable(
            "The model sent back a sheet of an unusable size. Try again.",
        ));
    }
    Ok(bytes)
}

// --- Web errors ----------------------------------------------------------------------

/// The first day of the next UTC month: when the monthly allowance resets.
fn next_month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// A failed web call in the words the wizard shows. The web's code is kept,
/// so the wizard can offer the one action that fixes it.
pub(crate) fn pet_web_error(error: &CohostApiError, now: DateTime<Utc>) -> BuddyPetCreatorError {
    let code = error.detail.code.as_str();
    let message = match code {
        "pet-allowance-used" => {
            let reset = match error.kind {
                CohostApiErrorKind::QuotaExhausted {
                    retry_after: Some(after),
                } => chrono::Duration::from_std(after)
                    .ok()
                    .and_then(|after| now.checked_add_signed(after))
                    .unwrap_or_else(|| next_month_start(now)),
                _ => next_month_start(now),
            };
            format!(
                "This month's Buddy creations are used up. More on {}.",
                reset.format("%B %-d")
            )
        }
        "pet-pilot-daily-limit" => "Today's pilots are used up. Try again tomorrow.".to_string(),
        "pet-pilots-used" => {
            "This creation's pilots are used up. Keep the last one or start a new creation."
                .to_string()
        }
        "pet-sheets-used" => "This creation's sheets are used up.".to_string(),
        "pet-redos-used" => "This creation's redos are used up.".to_string(),
        "pet-identity-limit" => {
            "This creation has read its reference too many times. Start a new creation.".to_string()
        }
        "pet-image-model-unconfigured"
        | "pet-vision-model-unconfigured"
        | "pet-disabled"
        | "cohost-disabled"
        | "ai-gateway-not-configured" => BUDDY_PET_NOT_AVAILABLE.to_string(),
        PET_BUILD_EXPIRED => BUDDY_PET_EXPIRED_MESSAGE.to_string(),
        "pet-build-not-found" => {
            "Videorc no longer knows this creation; start a new one.".to_string()
        }
        "pet-identity-timeout" | "pet-sheet-timeout" | "timeout" => {
            "The model took too long. Try again.".to_string()
        }
        "pet-identity-invalid-output" => {
            "The model could not read the picture. Try again or use another picture.".to_string()
        }
        "pet-sheet-unreadable" => {
            "The model sent back a sheet that could not be read. Try again.".to_string()
        }
        "ai-gateway-error" => "The image model failed. Try again.".to_string(),
        "unauthorized" => "Sign in again to create a Buddy.".to_string(),
        "premium-required" => "Creating a Buddy requires Videorc Premium.".to_string(),
        "ai-user-disabled" => "Cloud AI is turned off for this account.".to_string(),
        "network" => "Could not reach Videorc. Check your connection and try again.".to_string(),
        _ => error.detail.message.clone(),
    };
    BuddyPetCreatorError {
        code: error.detail.code.clone(),
        message,
    }
}

// --- Shared helpers ---------------------------------------------------------------------

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BuddyPetCreatorError> + Send + 'static,
) -> Result<T, BuddyPetCreatorError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| store_error("The creator stopped", error))?
}

async fn active_persona(state: &AppState) -> CohostPersona {
    state.cohost.lock().await.settings().persona.clone()
}

fn not_ready(message: &str) -> BuddyPetCreatorError {
    BuddyPetCreatorError::new(COHOST_PET_NOT_READY, message)
}

fn expired_error() -> BuddyPetCreatorError {
    BuddyPetCreatorError::new(PET_BUILD_EXPIRED, BUDDY_PET_EXPIRED_MESSAGE)
}

/// Open the persona's creation `build_id` off the async runtime.
async fn open(
    root: &Path,
    persona: &CohostPersona,
    build_id: &str,
) -> Result<(PathBuf, BuildState), BuddyPetCreatorError> {
    let root = root.to_path_buf();
    let persona_id = persona.id.clone();
    let build_id = build_id.to_string();
    blocking(move || open_creation(&root, &persona_id, &build_id)).await
}

// --- cohost.pet.creation.start / status / cancel ------------------------------------------

/// `cohost.pet.creation.start`: open a build session on the web and the
/// creation folder beside it.
pub async fn start(state: &AppState) -> Result<BuddyPetCreationStatus, BuddyPetCreatorError> {
    start_in(state, CreatorEnv::process()).await
}

async fn start_in(
    state: &AppState,
    env: CreatorEnv,
) -> Result<BuddyPetCreationStatus, BuddyPetCreatorError> {
    let root = env.root()?;
    let (api, token) = env.web()?;
    let persona = active_persona(state).await;
    if !persona_id_ok(&persona.id) {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_INVALID,
            "The persona id is not a plain token.",
        ));
    }
    let _guard = env.shared.begin("", BuddyPetCreatorJob::Start, None)?;
    let existing = {
        let root = root.clone();
        let persona_id = persona.id.clone();
        blocking(move || Ok(find_creation(&root, &persona_id, &mut Vec::new()).is_some())).await?
    };
    if existing {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_CREATION_ACTIVE,
            "A creation is already in progress. Continue it or cancel it first.",
        ));
    }
    let now = Utc::now();
    let session = api
        .post_cohost_pet_build(&token)
        .await
        .map_err(|error| pet_web_error(&error, now))?;
    let malformed = |reason: &str| {
        BuddyPetCreatorError::new(
            "malformed-response",
            format!("Videorc sent back a creation it cannot use: {reason}."),
        )
    };
    if !build_id_ok(&session.build_id) {
        return Err(malformed("the build id is not a uuid"));
    }
    if DateTime::parse_from_rfc3339(&session.expires_at).is_err() {
        return Err(malformed("the expiry is not a date"));
    }
    let persona_id = persona.id.clone();
    let shared = env.shared.clone();
    let status = blocking(move || {
        let dir = creation_dir(&root, &persona_id, &session.build_id);
        let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
        std::fs::create_dir_all(dir.join(SOURCES_DIR))
            .map_err(|error| store_error("Could not create the creation folder", error))?;
        let mut build_state = BuildState {
            version: STATE_VERSION,
            build_id: session.build_id.clone(),
            persona_id,
            step: BuddyPetCreationStep::Reference,
            created_at: now_iso(now),
            expires_at: session.expires_at.clone(),
            sheets_allowed: session.sheets_allowed,
            redos_allowed: session.redos_allowed,
            pilots_allowed: session.pilots_allowed,
            sheets_remaining: session.sheets_allowed,
            redos_remaining: session.redos_allowed,
            pilots_used: 0,
            identity_reads: 0,
            notes: None,
            sources: Vec::new(),
            accepted: BTreeMap::new(),
            build: None,
        };
        if let Err(error) = write_state(&dir, &mut build_state) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
        Ok(BuddyPetCreationStatus {
            creation: Some(build_state.wire(&dir, now, None)),
        })
    })
    .await?;
    state.emit_log(
        "info",
        "Buddy creation started (nothing counts until the first sheet after the pilot).",
    );
    Ok(status)
}

/// `cohost.pet.creation.status`: the active Buddy's creation, or none.
pub async fn status(state: &AppState) -> Result<BuddyPetCreationStatus, BuddyPetCreatorError> {
    status_in(state, CreatorEnv::process()).await
}

async fn status_in(
    state: &AppState,
    env: CreatorEnv,
) -> Result<BuddyPetCreationStatus, BuddyPetCreatorError> {
    let root = env.root()?;
    let persona = active_persona(state).await;
    if !persona_id_ok(&persona.id) {
        return Ok(BuddyPetCreationStatus { creation: None });
    }
    let persona_id = persona.id.clone();
    let (found, skipped) = blocking(move || {
        let mut skipped = Vec::new();
        let found = find_creation(&root, &persona_id, &mut skipped);
        Ok((found, skipped))
    })
    .await?;
    for note in skipped {
        state.emit_log("warn", note);
    }
    let now = Utc::now();
    Ok(BuddyPetCreationStatus {
        creation: found.map(|(dir, build_state)| {
            let running = env.shared.running_for(&build_state.build_id);
            build_state.wire(&dir, now, running)
        }),
    })
}

/// `cohost.pet.creation.cancel`: remove the creation folder (sources, any
/// build). A job still running for it discards its result; nothing of the
/// creation stays on disk. Cancelling a creation that is gone is a no-op.
pub async fn cancel(
    state: &AppState,
    params: CohostPetBuildIdParams,
) -> Result<BuddyPetCreationStatus, BuddyPetCreatorError> {
    cancel_in(state, CreatorEnv::process(), params).await
}

async fn cancel_in(
    state: &AppState,
    env: CreatorEnv,
    params: CohostPetBuildIdParams,
) -> Result<BuddyPetCreationStatus, BuddyPetCreatorError> {
    let root = env.root()?;
    let persona = active_persona(state).await;
    if !build_id_ok(&params.build_id) || !persona_id_ok(&persona.id) {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_INVALID,
            "The build id is not a creation id.",
        ));
    }
    env.shared.cancel_job(&params.build_id);
    let dir = creation_dir(&root, &persona.id, &params.build_id);
    let shared = env.shared.clone();
    blocking(move || {
        let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(store_error("Could not remove the creation", error)),
        }
    })
    .await?;
    state.emit_log("info", "Buddy creation cancelled; its files were removed.");
    status_in(state, env).await
}

// --- cohost.pet.identity -------------------------------------------------------------------

/// `cohost.pet.identity`: store the reference and read its identity notes
/// (accepted at once; the outcome is `cohost.pet.identity.read`).
pub async fn identity(
    state: &AppState,
    params: CohostPetIdentityParams,
) -> Result<BuddyPetCreationAccepted, BuddyPetCreatorError> {
    identity_in(state, CreatorEnv::process(), params).await
}

async fn identity_in(
    state: &AppState,
    env: CreatorEnv,
    params: CohostPetIdentityParams,
) -> Result<BuddyPetCreationAccepted, BuddyPetCreatorError> {
    let root = env.root()?;
    let (api, token) = env.web()?;
    let persona = active_persona(state).await;
    let (dir, build_state) = open(&root, &persona, &params.build_id).await?;
    if build_state.expired_at(Utc::now()) {
        return Err(expired_error());
    }
    if build_state.pilot_accepted() {
        return Err(BuddyPetCreatorError::new(
            COHOST_PET_INVALID,
            "The reference is set once the pilot looks right. Start a new creation to change it.",
        ));
    }
    let guard = env
        .shared
        .begin(&params.build_id, BuddyPetCreatorJob::Identity, None)?;
    let build_id = params.build_id.clone();
    let task_state = state.clone();
    tokio::spawn(async move {
        let outcome = run_identity(
            &env,
            &root,
            &persona,
            &dir,
            &api,
            &token,
            params,
            guard.cancelled(),
        )
        .await;
        drop(guard);
        let event = match outcome {
            Ok(notes) => BuddyPetIdentityReadEvent {
                build_id,
                notes: Some(notes),
                error: None,
            },
            Err(error) => {
                task_state.emit_log(
                    "warn",
                    format!(
                        "Buddy creation: reading the reference failed ({}): {}",
                        error.code, error.message
                    ),
                );
                BuddyPetIdentityReadEvent {
                    build_id,
                    notes: None,
                    error: Some(error),
                }
            }
        };
        task_state.emit_event(COHOST_PET_IDENTITY_READ_EVENT, event);
    });
    Ok(BuddyPetCreationAccepted {
        build_id: build_state.build_id,
        sheet: None,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_identity(
    env: &CreatorEnv,
    root: &Path,
    persona: &CohostPersona,
    dir: &Path,
    api: &VideorcApiClient,
    token: &str,
    params: CohostPetIdentityParams,
    cancelled: Arc<AtomicBool>,
) -> Result<BuddyPetIdentityNotes, BuddyPetCreatorError> {
    // The picture, prepared off the runtime.
    let png = {
        let root = root.to_path_buf();
        let persona = persona.clone();
        let reference = params.reference;
        blocking(move || {
            let image = match reference {
                BuddyPetReference::PersonaIdle => persona_idle(&root, &persona)?,
                BuddyPetReference::Upload { image_base64 } => decode_upload(&image_base64)?,
            };
            reference_png(image)
        })
        .await?
    };
    // Keep it as the reference (a new version when it changed; the notes and
    // the pilot of an older reference no longer apply).
    let png = Arc::new(png);
    {
        let shared = env.shared.clone();
        let dir = dir.to_path_buf();
        let png = png.clone();
        let cancelled = cancelled.clone();
        blocking(move || {
            commit(&shared, &dir, Some(&cancelled), |dir, build_state| {
                let sha256 = buddy_pet_build::sha256_hex(&png);
                if build_state
                    .reference()
                    .is_some_and(|current| current.sha256 == sha256)
                {
                    return Ok(());
                }
                let source = store_source(
                    dir,
                    build_state,
                    REFERENCE_KEY,
                    &png,
                    false,
                    None,
                    Utc::now(),
                )?;
                build_state
                    .accepted
                    .insert(REFERENCE_KEY.to_string(), source.version);
                build_state.notes = None;
                build_state.build = None;
                Ok(())
            })
        })
        .await?;
    }
    let request = CohostPetIdentityRequest {
        build_id: params.build_id,
        reference: base64::engine::general_purpose::STANDARD.encode(png.as_slice()),
    };
    let response = api
        .post_cohost_pet_identity(token, &request)
        .await
        .map_err(|error| pet_web_error(&error, Utc::now()))?;
    let notes = shape_notes(response.notes).map_err(|error| {
        BuddyPetCreatorError::new(
            "pet-identity-invalid-output",
            format!("The model's notes could not be used: {}", error.message),
        )
    })?;
    let shared = env.shared.clone();
    let dir = dir.to_path_buf();
    let stored = notes.clone();
    blocking(move || {
        commit(&shared, &dir, Some(&cancelled), |_, build_state| {
            build_state.notes = Some(stored);
            build_state.identity_reads += 1;
            Ok(())
        })
    })
    .await?;
    Ok(notes)
}

// --- cohost.pet.sheet.generate ----------------------------------------------------------------

/// `cohost.pet.sheet.generate`: one sheet as an edit of the reference with
/// the notes (accepted at once; the outcome is `cohost.pet.sheet.generated`).
/// The first atlas sheet accepts the pilot ("Looks like my Buddy").
pub async fn generate_sheet(
    state: &AppState,
    params: CohostPetSheetGenerateParams,
) -> Result<BuddyPetCreationAccepted, BuddyPetCreatorError> {
    generate_sheet_in(state, CreatorEnv::process(), params).await
}

async fn generate_sheet_in(
    state: &AppState,
    env: CreatorEnv,
    params: CohostPetSheetGenerateParams,
) -> Result<BuddyPetCreationAccepted, BuddyPetCreatorError> {
    let kind = sheet_kind(params.kind, params.row, params.redo)?;
    let key = kind.key();
    let notes_update = match params.notes {
        Some(_) if kind != SheetKind::Pilot => {
            return Err(BuddyPetCreatorError::new(
                COHOST_PET_INVALID,
                "Corrected notes ride with the pilot only.",
            ));
        }
        Some(notes) => Some(shape_notes(notes)?),
        None => None,
    };
    let root = env.root()?;
    let (api, token) = env.web()?;
    let persona = active_persona(state).await;
    let (dir, build_state) = open(&root, &persona, &params.build_id).await?;
    if build_state.expired_at(Utc::now()) {
        return Err(expired_error());
    }
    if build_state.reference().is_none() || build_state.notes.is_none() {
        return Err(not_ready("Read the reference first."));
    }
    if kind == SheetKind::Pilot {
        if build_state.pilot_accepted() {
            return Err(BuddyPetCreatorError::new(
                COHOST_PET_INVALID,
                "The pilot already looks right; redo a row instead.",
            ));
        }
    } else {
        if build_state.current_pilot().is_none() {
            return Err(not_ready("Make a pilot first."));
        }
        let exists = build_state.accepted.contains_key(key);
        if exists && !params.redo {
            return Err(BuddyPetCreatorError::new(
                COHOST_PET_INVALID,
                "That sheet is already made; redo it instead.",
            ));
        }
        if !exists && params.redo {
            return Err(BuddyPetCreatorError::new(
                COHOST_PET_INVALID,
                "Make that sheet before redoing it.",
            ));
        }
    }
    let guard = env
        .shared
        .begin(&params.build_id, BuddyPetCreatorJob::Sheet, Some(key))?;
    // "Looks like my Buddy" is the first atlas sheet: the pilot is accepted
    // before the call, so a restart resumes past it. Corrected notes for a
    // pilot are kept before the call too.
    {
        let shared = env.shared.clone();
        let dir = dir.clone();
        let cancelled = guard.cancelled();
        blocking(move || {
            commit(&shared, &dir, Some(&cancelled), |_, build_state| {
                if let Some(notes) = notes_update {
                    build_state.notes = Some(notes);
                }
                if kind != SheetKind::Pilot && !build_state.pilot_accepted() {
                    let pilot = build_state
                        .current_pilot()
                        .map(|pilot| pilot.version)
                        .ok_or_else(|| not_ready("Make a pilot first."))?;
                    build_state
                        .accepted
                        .insert(SheetKind::Pilot.key().to_string(), pilot);
                }
                Ok(())
            })
        })
        .await?;
    }
    let build_id = params.build_id.clone();
    let redo = params.redo;
    let task_state = state.clone();
    tokio::spawn(async move {
        let outcome = run_sheet(
            &env,
            &dir,
            &api,
            &token,
            &build_id,
            kind,
            redo,
            guard.cancelled(),
        )
        .await;
        drop(guard);
        let event = match outcome {
            Ok((source, remaining)) => BuddyPetSheetGeneratedEvent {
                build_id,
                sheet: key.to_string(),
                version: Some(source.version),
                opaque: source.opaque,
                sheets_remaining: Some(remaining.0),
                redos_remaining: Some(remaining.1),
                error: None,
            },
            Err(error) => {
                task_state.emit_log(
                    "warn",
                    format!(
                        "Buddy creation: the {key} sheet failed ({}): {}",
                        error.code, error.message
                    ),
                );
                BuddyPetSheetGeneratedEvent {
                    build_id,
                    sheet: key.to_string(),
                    version: None,
                    opaque: false,
                    sheets_remaining: None,
                    redos_remaining: None,
                    error: Some(error),
                }
            }
        };
        task_state.emit_event(COHOST_PET_SHEET_GENERATED_EVENT, event);
    });
    Ok(BuddyPetCreationAccepted {
        build_id: build_state.build_id,
        sheet: Some(key.to_string()),
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_sheet(
    env: &CreatorEnv,
    dir: &Path,
    api: &VideorcApiClient,
    token: &str,
    build_id: &str,
    kind: SheetKind,
    redo: bool,
    cancelled: Arc<AtomicBool>,
) -> Result<(BuddyPetCreationSource, (u32, u32)), BuddyPetCreatorError> {
    let (reference, reference_version, notes) = {
        let dir = dir.to_path_buf();
        blocking(move || {
            let build_state = read_state(&dir)?;
            let source = build_state
                .reference()
                .cloned()
                .ok_or_else(|| not_ready("Read the reference first."))?;
            let notes = build_state
                .notes
                .clone()
                .ok_or_else(|| not_ready("Read the reference first."))?;
            Ok((read_source(&dir, &source)?, source.version, notes))
        })
        .await?
    };
    let (name, row) = BuddyPetSheetKindName::of(kind);
    let request = CohostPetSheetRequest {
        build_id: build_id.to_string(),
        kind: name,
        row,
        reference: base64::engine::general_purpose::STANDARD.encode(&reference),
        notes,
        redo,
    };
    let response = api
        .post_cohost_pet_sheet(token, &request)
        .await
        .map_err(|error| pet_web_error(&error, Utc::now()))?;
    let remaining = (response.sheets_remaining, response.redos_remaining);
    let shared = env.shared.clone();
    let dir = dir.to_path_buf();
    blocking(move || {
        let png = sheet_png(&response.png_base64)?;
        commit(&shared, &dir, Some(&cancelled), |dir, build_state| {
            let key = kind.key();
            let source = store_source(
                dir,
                build_state,
                key,
                &png,
                response.opaque,
                Some(reference_version),
                Utc::now(),
            )?;
            if kind == SheetKind::Pilot {
                build_state.pilots_used += 1;
            } else {
                build_state.accepted.insert(key.to_string(), source.version);
            }
            build_state.sheets_remaining = response.sheets_remaining;
            build_state.redos_remaining = response.redos_remaining;
            Ok((source, remaining))
        })
    })
    .await
}

// --- cohost.pet.build -----------------------------------------------------------------------

/// `cohost.pet.build`: run the builder on the accepted sheets (accepted at
/// once; progress and the end are `cohost.pet.build.progress`). Works
/// offline and after the web session expired.
pub async fn build(
    state: &AppState,
    params: CohostPetBuildIdParams,
) -> Result<BuddyPetCreationAccepted, BuddyPetCreatorError> {
    build_in(state, CreatorEnv::process(), params).await
}

fn progress_step(stage: BuildStage) -> BuddyPetBuildProgressStep {
    match stage {
        BuildStage::Reading => BuddyPetBuildProgressStep::Reading,
        BuildStage::Cutting => BuddyPetBuildProgressStep::Cutting,
        BuildStage::Registering => BuddyPetBuildProgressStep::Registering,
        BuildStage::Packing => BuddyPetBuildProgressStep::Packing,
        BuildStage::Writing => BuddyPetBuildProgressStep::Writing,
    }
}

/// The builder's error with the sheet and cell it names (its serde fields).
fn build_failure(error: &BuildError) -> BuddyPetBuildFailure {
    let fields = serde_json::to_value(error).unwrap_or_default();
    let text = |field: &str| {
        fields
            .get(field)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    BuddyPetBuildFailure {
        code: error.code().to_string(),
        message: error.to_string(),
        sheet: text("sheet"),
        cell: text("cell"),
    }
}

async fn build_in(
    state: &AppState,
    env: CreatorEnv,
    params: CohostPetBuildIdParams,
) -> Result<BuddyPetCreationAccepted, BuddyPetCreatorError> {
    let root = env.root()?;
    let persona = active_persona(state).await;
    let (dir, build_state) = open(&root, &persona, &params.build_id).await?;
    let reference = build_state
        .reference()
        .cloned()
        .ok_or_else(|| not_ready("Read the reference first."))?;
    let pilot = build_state
        .accepted_source(SheetKind::Pilot.key())
        .cloned()
        .ok_or_else(|| not_ready("Accept a pilot first."))?;
    let mut sheets = Vec::with_capacity(SheetKind::ATLAS_ORDER.len());
    for kind in SheetKind::ATLAS_ORDER {
        let source = build_state
            .accepted_source(kind.key())
            .ok_or_else(|| not_ready("Make every sheet first."))?;
        sheets.push(SheetInput {
            kind,
            path: dir.join(&source.file),
            sha256: source.sha256.clone(),
        });
    }
    let versions = build_state.build_versions();
    let guard = env
        .shared
        .begin(&params.build_id, BuddyPetCreatorJob::Build, None)?;
    let name = {
        let name = persona.name.trim();
        if name.is_empty() { "Buddy" } else { name }.to_string()
    };
    let input = BuildInput {
        name,
        reference: SourceFile {
            path: dir.join(&reference.file),
            sha256: reference.sha256,
        },
        pilot: Some(SheetInput {
            kind: SheetKind::Pilot,
            path: dir.join(&pilot.file),
            sha256: pilot.sha256,
        }),
        sheets,
        cell_size: env.cell_size,
        created_at: Utc::now(),
    };
    let build_id = params.build_id.clone();
    let task_state = state.clone();
    tokio::spawn(async move {
        let cancelled = guard.cancelled();
        let progress_state = task_state.clone();
        let progress_build = build_id.clone();
        let staging = dir.join(STAGING_DIR);
        #[cfg(test)]
        let mut hold = env.build_hold.clone();
        let built = tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&staging);
            buddy_pet_build::build_pack(&input, &staging, |step: BuildStep| {
                progress_state.emit_event(
                    COHOST_PET_BUILD_PROGRESS_EVENT,
                    BuddyPetBuildProgressEvent {
                        build_id: progress_build.clone(),
                        step: progress_step(step.stage),
                        sheet: step.sheet.map(str::to_string),
                        cell: None,
                        done: step.done,
                        total: step.total,
                        error: None,
                        code: None,
                    },
                );
                #[cfg(test)]
                if step.stage == BuildStage::Writing
                    && step.done < step.total
                    && let Some(hold) = hold.take()
                {
                    hold.wait();
                }
            })
        })
        .await;
        let built = match built {
            Ok(result) => result.map_err(|error| build_failure(&error)),
            Err(error) => Err(BuddyPetBuildFailure {
                code: "internal".to_string(),
                message: format!("The builder stopped: {error}"),
                sheet: None,
                cell: None,
            }),
        };
        let total = built
            .as_ref()
            .map(|outcome| outcome.report.cells.len() as u32)
            .unwrap_or(0);
        let shared = env.shared.clone();
        let finish_dir = dir.clone();
        let failure = built.as_ref().err().cloned();
        let finished =
            blocking(move || finish_build(&shared, &finish_dir, &cancelled, versions, failure))
                .await;
        drop(guard);
        let event = match (built, finished) {
            (_, Err(error)) => {
                task_state.emit_log(
                    "warn",
                    format!(
                        "Buddy creation: the build was not kept ({}): {}",
                        error.code, error.message
                    ),
                );
                BuddyPetBuildProgressEvent {
                    build_id,
                    step: BuddyPetBuildProgressStep::Failed,
                    sheet: None,
                    cell: None,
                    done: 0,
                    total: 0,
                    error: Some(error.message),
                    code: Some(error.code),
                }
            }
            (Ok(_), Ok(())) => {
                task_state.emit_log("info", format!("Buddy pack built: {total} poses."));
                BuddyPetBuildProgressEvent {
                    build_id,
                    step: BuddyPetBuildProgressStep::Done,
                    sheet: None,
                    cell: None,
                    done: 1,
                    total: 1,
                    error: None,
                    code: None,
                }
            }
            (Err(failure), Ok(())) => {
                task_state.emit_log(
                    "warn",
                    format!(
                        "Buddy pack build failed ({}): {}",
                        failure.code, failure.message
                    ),
                );
                BuddyPetBuildProgressEvent {
                    build_id,
                    step: BuddyPetBuildProgressStep::Failed,
                    sheet: failure.sheet,
                    cell: failure.cell,
                    done: 0,
                    total: 0,
                    error: Some(failure.message),
                    code: Some(failure.code),
                }
            }
        };
        task_state.emit_event(COHOST_PET_BUILD_PROGRESS_EVENT, event);
    });
    Ok(BuddyPetCreationAccepted {
        build_id: build_state.build_id,
        sheet: None,
    })
}

/// Keep (or drop) a finished build under the commit lock: success swaps
/// `staging/` in as `pack/`; a failure records the reason. A creation
/// cancelled meanwhile is removed whole, so a late `staging/` never stays.
fn finish_build(
    shared: &CreatorShared,
    dir: &Path,
    cancelled: &AtomicBool,
    versions: BTreeMap<String, u32>,
    failure: Option<BuddyPetBuildFailure>,
) -> Result<(), BuddyPetCreatorError> {
    let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
    let staging = dir.join(STAGING_DIR);
    let gone = cancelled.load(Ordering::Acquire) || !dir.join(STATE_FILE).is_file();
    if gone {
        let _ = std::fs::remove_dir_all(dir);
        return Err(cancelled_error());
    }
    let mut build_state = read_state(dir)?;
    let finished_at = now_iso(Utc::now());
    match failure {
        None => {
            let pack = dir.join(PACK_DIR);
            match std::fs::remove_dir_all(&pack) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(store_error("Could not replace the last build", error));
                }
            }
            std::fs::rename(&staging, &pack)
                .map_err(|error| store_error("Could not keep the build", error))?;
            build_state.build = Some(BuildRecord {
                state: BuddyPetBuildState::Built,
                versions,
                finished_at,
                error: None,
            });
        }
        Some(failure) => {
            let _ = std::fs::remove_dir_all(&staging);
            build_state.build = Some(BuildRecord {
                state: BuddyPetBuildState::Failed,
                versions,
                finished_at,
                error: Some(failure),
            });
        }
    }
    write_state(dir, &mut build_state)
}

// --- cohost.pet.save --------------------------------------------------------------------------

/// `cohost.pet.save`: name the built pack, move it under
/// `<root>/<personaId>/pets/<packId>/` with its accepted sources, remove the
/// creation, and make the persona Alive with it.
pub async fn save(
    state: &AppState,
    params: CohostPetSaveParams,
) -> Result<CohostPetSaved, BuddyPetCreatorError> {
    save_in(state, CreatorEnv::process(), params).await
}

async fn save_in(
    state: &AppState,
    env: CreatorEnv,
    params: CohostPetSaveParams,
) -> Result<CohostPetSaved, BuddyPetCreatorError> {
    let name = shape_pack_name(&params.name)?;
    let root = env.root()?;
    let persona = active_persona(state).await;
    let (dir, build_state) = open(&root, &persona, &params.build_id).await?;
    if !build_state.build_fresh(&dir) {
        return Err(not_ready(if build_state.build.is_some() {
            "The pack is older than the sheets; build it again."
        } else {
            "Build the pack first."
        }));
    }
    let guard = env
        .shared
        .begin(&params.build_id, BuddyPetCreatorJob::Save, None)?;
    let pack_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let summary = {
        let shared = env.shared.clone();
        let cancelled = guard.cancelled();
        let root = root.clone();
        let persona_id = persona.id.clone();
        let pack_id = pack_id.clone();
        blocking(move || {
            let _lock = shared.commit.lock().unwrap_or_else(|e| e.into_inner());
            if cancelled.load(Ordering::Acquire) {
                return Err(cancelled_error());
            }
            let build_state = read_state(&dir)?;
            move_pack_into_place(&root, &persona_id, &dir, &build_state, &pack_id, &name)
        })
        .await?
    };
    drop(guard);
    // The persona wears it. The latest persona is read again: only its
    // avatar changes.
    let mut alive = active_persona(state).await;
    alive.avatar = BuddyAvatar::Alive {
        pack_id: pack_id.clone(),
    };
    let settings = crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            persona: Some(alive),
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .map_err(|error| {
        BuddyPetCreatorError::new(
            error.code(),
            format!("The pack was saved, but the Buddy could not wear it: {error}"),
        )
    })?;
    state.emit_log(
        "info",
        format!(
            "Buddy pack saved: {} ({} poses).",
            summary.name,
            summary.gaze_count as usize + summary.reactions.len()
        ),
    );
    // Plan 172 D10: a Buddy linked to the library sends its new pack to the
    // account (a library job, tried again at the next sync when it fails).
    crate::cohost_library::alive::pack_saved(state, &pack_id).await;
    Ok(CohostPetSaved {
        pack: summary,
        settings,
    })
}

/// The save's file work, under the commit lock: the manifest gets its name,
/// the accepted sources join the pack, the pack loads as any pack must
/// (S-A1 rules, decoded), then it moves into `pets/` and the creation goes.
fn move_pack_into_place(
    root: &Path,
    persona_id: &str,
    dir: &Path,
    build_state: &BuildState,
    pack_id: &str,
    name: &str,
) -> Result<BuddyPetSummary, BuddyPetCreatorError> {
    let pack = dir.join(PACK_DIR);
    let manifest_bytes = std::fs::read(pack.join(buddy_pet::BUDDY_PET_MANIFEST_FILE))
        .map_err(|error| store_error("Could not read the built manifest", error))?;
    let mut manifest = buddy_pet::parse_manifest(&manifest_bytes)
        .map_err(|error| BuddyPetCreatorError::new(COHOST_PET_INVALID, error.message))?;
    manifest.name = name.to_string();
    let mut bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| store_error("Could not write the manifest", error))?;
    bytes.push(b'\n');
    write_atomic(&pack, buddy_pet::BUDDY_PET_MANIFEST_FILE, &bytes)?;

    let sources = pack.join(SOURCES_DIR);
    std::fs::create_dir_all(&sources)
        .map_err(|error| store_error("Could not keep the sources", error))?;
    let keys = std::iter::once(REFERENCE_KEY)
        .chain(std::iter::once(SheetKind::Pilot.key()))
        .chain(SheetKind::ATLAS_ORDER.iter().map(|kind| kind.key()));
    for key in keys {
        let source = build_state
            .accepted_source(key)
            .ok_or_else(|| not_ready("Make every sheet first."))?;
        let bytes = read_source(dir, source)?;
        let file_name = source
            .file
            .strip_prefix(&format!("{SOURCES_DIR}/"))
            .unwrap_or(&source.file);
        write_atomic(&sources, file_name, &bytes)?;
    }

    let loaded = buddy_pet::load_pack_dir(&pack, pack_id).map_err(|error| {
        BuddyPetCreatorError::new(
            COHOST_PET_INVALID,
            format!("The built pack did not pass its checks: {}", error.message),
        )
    })?;
    let summary = loaded.summary();
    drop(loaded);

    let pets = root.join(persona_id).join("pets");
    std::fs::create_dir_all(&pets)
        .map_err(|error| store_error("Could not create the pets folder", error))?;
    let destination = pets.join(pack_id);
    std::fs::rename(&pack, &destination)
        .map_err(|error| store_error("Could not move the pack into place", error))?;
    if let Err(error) = std::fs::remove_dir_all(dir) {
        tracing::warn!(%error, "the finished Buddy creation folder could not be removed");
    }
    Ok(summary)
}

#[cfg(test)]
mod tests;
