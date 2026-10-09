//! Alive packs and the Buddy library (plan 172 D4, D5, D7 to D10).
//!
//! - **Official packs** (D4, D5): Buddy's own pack ships in the bundled root
//!   (`bundled:buddy`); the other official characters download once from the
//!   web's static files (`/buddy/official/<slug>/alive/<version>/<name>`)
//!   into `<root>/official/<slug>/<version>/` (`official:<slug>`). Using one
//!   makes the Buddy Still until its pack lands, then Alive unless the Buddy
//!   changed meanwhile; offline, it stays Still and tries again next use.
//! - **Account packs** (D9, D10): a library Buddy may carry one pack. Apply
//!   (use, sync, keep) downloads it into `<root>/<persona>/pets/<packId>/`
//!   and the Buddy wears it; a sync downloads a pack the linked Buddy gained
//!   elsewhere. `cohost.pet.save` on a linked Buddy uploads its new pack
//!   (presign, PUT each file straight to storage, commit); removing the pack
//!   here removes it from the account. A change the account missed is kept
//!   in the sync row and tried again at the next sync.
//! - **Save to my library** (D10): a Buddy made only on this computer joins
//!   the library through the import routes, is linked, then uploads its own
//!   pack when it wears one.
//!
//! Every download lands in `<root>/.staging/<uuid>/`, each file checked by
//! size and SHA-256 as it arrives, and only a complete, verified folder moves
//! into place: nothing half-written is ever loaded.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::*;
use crate::buddy_pet::{self, PackRef};
use crate::videorc_api::{
    BuddyAliveUploadRequest, BuddyImportRequest, BuddyLibraryWebAlive, BuddyUploadFile,
    BuddyUploadPlan,
};

/// Where downloads are staged under the write root (a dot: never a persona id).
pub(crate) const BUDDY_ALIVE_STAGING_DIR: &str = ".staging";
/// The pack id Buddy's own pack has (`apps/desktop/resources/buddy/buddy/`).
pub(crate) const BUDDY_DEFAULT_ALIVE_PACK_ID: &str = "bundled:buddy";
/// The files of a synced pack and their caps (the web's limits, D8).
pub(crate) const BUDDY_ALIVE_FILES: [(&str, u64); 3] = [
    (buddy_pet::BUDDY_PET_MANIFEST_FILE, 256 * 1024),
    ("mascot.webp", 32 * 1024 * 1024),
    (buddy_pet::BUDDY_PET_SIDECAR_FILE, 64 * 1024),
];
/// The poses an import sends, idle first (the only one required).
const BUDDY_IMPORT_POSE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// A downloaded file did not match what the catalog or the library listed.
pub(crate) const COHOST_ALIVE_MISMATCH: &str = "buddy-alive-mismatch";
/// The pack cannot go to the account (its files are not a synced pack's).
pub(crate) const COHOST_ALIVE_NOT_SYNCABLE: &str = "buddy-alive-not-syncable";

/// One pack file as the catalog or the library lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AliveFileSpec {
    pub(crate) name: String,
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
}

/// An official character's pack, as the catalog pins it (tests pin their own).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OfficialAliveSpec {
    pub(crate) version: u32,
    pub(crate) pack_id: String,
    pub(crate) bundled: bool,
    pub(crate) files: Vec<AliveFileSpec>,
}

// --- Checks ------------------------------------------------------------------------------------

fn sha256_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Exactly `manifest.json`, `mascot.webp` and `buddy.json`, each once, each
/// within its cap and with a SHA-256.
pub(crate) fn alive_files_ok(files: &[AliveFileSpec]) -> bool {
    files.len() == BUDDY_ALIVE_FILES.len() && BUDDY_ALIVE_FILES.iter().all(|(name, cap)| {
        let mut matching = files.iter().filter(|file| file.name == *name);
        matches!(
            (matching.next(), matching.next()),
            (Some(file), None) if file.bytes > 0 && file.bytes <= *cap && sha256_ok(&file.sha256)
        )
    })
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `path` is a regular file of the listed size (and, with `hash`, SHA-256).
fn file_matches(path: &Path, spec: &AliveFileSpec, hash: bool) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() || metadata.len() != spec.bytes {
        return false;
    }
    !hash
        || std::fs::read(path).is_ok_and(|bytes| {
            bytes.len() as u64 == spec.bytes && sha256_hex(&bytes) == spec.sha256
        })
}

/// Every listed file is in `dir` with its size and SHA-256. Blocking.
pub(crate) fn pack_verified(dir: &Path, files: &[AliveFileSpec]) -> bool {
    !files.is_empty()
        && files
            .iter()
            .all(|file| file_matches(&dir.join(&file.name), file, true))
}

/// Every listed file is in `dir` with its size: the cheap check the library
/// state uses (a folder only exists once it verified). Blocking.
fn pack_sized(dir: &Path, files: &[AliveFileSpec]) -> bool {
    !files.is_empty()
        && files
            .iter()
            .all(|file| file_matches(&dir.join(&file.name), file, false))
}

/// A bundled pack's folder holds its manifest. Blocking.
pub(crate) fn bundled_pack_present(bundled_root: Option<&Path>, pack_id: &str) -> bool {
    match (bundled_root, buddy_pet::parse_pack_id(pack_id)) {
        (Some(root), Ok(PackRef::Bundled(name))) => crate::cohost_avatar::is_regular_file(
            &root.join(name).join(buddy_pet::BUDDY_PET_MANIFEST_FILE),
        ),
        _ => false,
    }
}

// --- Official packs (D4, D5) -------------------------------------------------------------------

/// The folder a downloadable official pack lives in once verified.
fn official_folder(root: &Path, slug: BuddyOfficialSlug, alive: &OfficialAliveSpec) -> PathBuf {
    buddy_pet::official_pack_folder(root, slug.as_str(), alive.version)
}

/// Each official character's pack state on this computer (D12). Blocking.
pub(crate) fn official_states(
    env: &LibraryEnv,
) -> BTreeMap<BuddyOfficialSlug, BuddyOfficialAliveState> {
    BuddyOfficialSlug::ALL
        .into_iter()
        .map(|slug| {
            let state = match env.official_alive(slug) {
                None => BuddyOfficialAliveState::None,
                Some(alive) if alive.bundled => {
                    if bundled_pack_present(env.bundled_root.as_deref(), &alive.pack_id) {
                        BuddyOfficialAliveState::Bundled
                    } else {
                        BuddyOfficialAliveState::None
                    }
                }
                Some(alive) => match env.root.as_deref() {
                    Some(root)
                        if pack_sized(&official_folder(root, slug, &alive), &alive.files) =>
                    {
                        BuddyOfficialAliveState::Downloaded
                    }
                    _ => BuddyOfficialAliveState::Available,
                },
            };
            (slug, state)
        })
        .collect()
}

/// The pack an official Buddy can wear right now: Buddy's own bundled pack
/// when it is in the bundled root (D5), or a downloaded official pack that
/// verifies file by file (D4). Blocking.
pub(crate) fn official_ready_pack(env: &LibraryEnv, slug: BuddyOfficialSlug) -> Option<String> {
    if slug == BuddyOfficialSlug::Golem {
        let pack_id = env
            .official_alive(slug)
            .filter(|alive| alive.bundled)
            .map(|alive| alive.pack_id)
            .unwrap_or_else(|| BUDDY_DEFAULT_ALIVE_PACK_ID.to_string());
        return bundled_pack_present(env.bundled_root.as_deref(), &pack_id).then_some(pack_id);
    }
    let alive = env.official_alive(slug)?;
    if alive.bundled {
        return bundled_pack_present(env.bundled_root.as_deref(), &alive.pack_id)
            .then_some(alive.pack_id);
    }
    let root = env.root.as_deref()?;
    pack_verified(&official_folder(root, slug, &alive), &alive.files)
        .then(|| official_pack_id(slug))
}

/// `official:<slug>`, the pack id of a downloaded official pack.
pub(crate) fn official_pack_id(slug: BuddyOfficialSlug) -> String {
    format!("{}{}", buddy_pet::BUDDY_OFFICIAL_PACK_PREFIX, slug.as_str())
}

/// The official character has a pack to download here.
pub(crate) fn official_downloadable(env: &LibraryEnv, slug: BuddyOfficialSlug) -> bool {
    env.root.is_some()
        && env.api.is_some()
        && env
            .official_alive(slug)
            .is_some_and(|alive| !alive.bundled && alive_files_ok(&alive.files))
}

/// Download an official pack after its Buddy was applied Still (D4): one
/// library job, so it never races another apply.
pub(crate) fn queue_official_download(
    state: &AppState,
    slug: BuddyOfficialSlug,
    persona_id: String,
) {
    let id = slug.id();
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::AliveDownload, Some(&id)),
        move |state| async move { run_official_download(&state, slug, &persona_id).await },
    );
}

async fn run_official_download(
    state: &AppState,
    slug: BuddyOfficialSlug,
    persona_id: &str,
) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let official = official_buddy(slug);
    let Some(alive) = env
        .official_alive(slug)
        .filter(|alive| !alive.bundled && alive_files_ok(&alive.files))
    else {
        return Ok(());
    };
    let root = env.root()?;
    let api = env
        .api
        .clone()
        .ok_or_else(|| CohostAvatarErrorDetail::new("network", "Could not reach Videorc."))?;
    let dest = official_folder(&root, slug, &alive);
    let sources = alive
        .files
        .iter()
        .map(|file| {
            (
                file.clone(),
                format!(
                    "{}{}/alive/{}/{}",
                    crate::videorc_api::BUDDY_OFFICIAL_ALIVE_PREFIX,
                    slug.as_str(),
                    alive.version,
                    file.name
                ),
            )
        })
        .collect();
    if let Err(error) = install_pack(&api, None, &root, &dest, sources).await {
        return Err(CohostAvatarErrorDetail::new_owned(
            error.code,
            format!(
                "{} stays still for now: its moves could not be downloaded ({}). It tries again the next time you use it.",
                official.name, error.message
            ),
        ));
    }
    // Alive unless the Buddy changed meanwhile (another Buddy, Alive or
    // Still picked by hand, a fresh persona).
    let persona = current_persona(state).await;
    if persona.id != persona_id
        || persona.library_avatar_id.as_deref() != Some(slug.id().as_str())
        || persona.avatar != BuddyAvatar::Still
    {
        return Ok(());
    }
    let mut next = persona;
    next.avatar = BuddyAvatar::Alive {
        pack_id: official_pack_id(slug),
    };
    save_persona(state, next).await?;
    state.emit_log("info", format!("{} is alive.", official.name));
    Ok(())
}

// --- The default Buddy (D5) --------------------------------------------------------------------

/// The backend-private row that remembers the one-time switch of the
/// untouched default Buddy to its bundled pack.
pub(crate) const BUDDY_DEFAULT_ALIVE_KEY: &str = "buddyDefaultAlive";

/// D5: the default Buddy is Alive with `bundled:buddy` when that pack is in
/// the bundled root, else Still. A fresh install starts Alive; an install
/// whose Buddy is still the untouched default (Still, the bundled pictures)
/// switches once. A Buddy changed by hand is never touched, and nothing
/// switches while the pack is missing (a later launch with it does).
pub fn default_buddy_alive(
    database: &Database,
    settings: CohostSettings,
    bundled_root: Option<&Path>,
) -> CohostSettings {
    if !matches!(
        database.load_setting::<bool>(BUDDY_DEFAULT_ALIVE_KEY),
        Ok(None)
    ) {
        return settings;
    }
    if !bundled_pack_present(bundled_root, BUDDY_DEFAULT_ALIVE_PACK_ID) {
        return settings;
    }
    let persona = &settings.persona;
    let untouched = active_avatar_id(persona) == Some(BuddyOfficialSlug::Golem.id())
        && persona.source == CohostPersonaSource::Default
        && persona.avatar == BuddyAvatar::Still
        && persona.images == CohostPersonaImages::default();
    let mut next = settings;
    if untouched {
        next.persona.avatar = BuddyAvatar::Alive {
            pack_id: BUDDY_DEFAULT_ALIVE_PACK_ID.to_string(),
        };
        if let Err(error) = database.save_setting(crate::cohost::COHOST_SETTINGS_KEY, &next) {
            tracing::warn!("Could not make the default Buddy alive: {error:#}");
            next.persona.avatar = BuddyAvatar::Still;
            return next;
        }
    }
    if let Err(error) = database.save_setting(BUDDY_DEFAULT_ALIVE_KEY, &true) {
        tracing::warn!("Could not remember the default Buddy's pack: {error:#}");
    }
    next
}

// --- Downloads ---------------------------------------------------------------------------------

/// Download `sources` (each file and the path it comes from) into a fresh
/// staging folder, checking each file's size and SHA-256 as it arrives, then
/// move the folder to `dest`. A `dest` that already verifies is kept as it is.
async fn install_pack(
    api: &VideorcApiClient,
    bearer: Option<&str>,
    root: &Path,
    dest: &Path,
    sources: Vec<(AliveFileSpec, String)>,
) -> Result<(), CohostAvatarErrorDetail> {
    let specs: Vec<AliveFileSpec> = sources.iter().map(|(spec, _)| spec.clone()).collect();
    {
        let dest = dest.to_path_buf();
        let specs = specs.clone();
        if blocking(move || Ok(pack_verified(&dest, &specs))).await? {
            return Ok(());
        }
    }
    let staging = {
        let root = root.to_path_buf();
        blocking(move || fresh_staging(&root)).await?
    };
    let outcome = download_into(api, bearer, &staging, sources).await;
    let root = root.to_path_buf();
    let dest = dest.to_path_buf();
    blocking(move || {
        let moved = outcome.and_then(|()| {
            if pack_verified(&staging, &specs) {
                move_into_place(&root, &staging, &dest)
            } else {
                Err(mismatch())
            }
        });
        if moved.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        moved
    })
    .await
}

fn mismatch() -> CohostAvatarErrorDetail {
    CohostAvatarErrorDetail::new(
        COHOST_ALIVE_MISMATCH,
        "The downloaded pack did not match what Videorc listed, so it was not used.",
    )
}

/// `<root>/.staging/<uuid>/`, created empty. Library jobs run one at a time,
/// so whatever an earlier run left there is removed first.
fn fresh_staging(root: &Path) -> Result<PathBuf, CohostAvatarErrorDetail> {
    let base = root.join(BUDDY_ALIVE_STAGING_DIR);
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let staging = base.join(uuid::Uuid::new_v4().hyphenated().to_string());
    std::fs::create_dir_all(&staging)
        .map_err(|error| store_error("Could not prepare the download", error))?;
    Ok(staging)
}

async fn download_into(
    api: &VideorcApiClient,
    bearer: Option<&str>,
    staging: &Path,
    sources: Vec<(AliveFileSpec, String)>,
) -> Result<(), CohostAvatarErrorDetail> {
    for (spec, path) in sources {
        let bytes = api
            .get_buddy_alive_file(&path, bearer, spec.bytes)
            .await
            .map_err(|error| match error.kind {
                CohostApiErrorKind::MalformedResponse => mismatch(),
                _ => library_error(&error),
            })?;
        if bytes.len() as u64 != spec.bytes || sha256_hex(&bytes) != spec.sha256 {
            return Err(mismatch());
        }
        let staging = staging.to_path_buf();
        blocking(move || crate::cohost_avatar::write_atomic(&staging, &spec.name, &bytes)).await?;
    }
    Ok(())
}

/// Move a verified staging folder to `dest`, replacing what was there.
fn move_into_place(
    root: &Path,
    staging: &Path,
    dest: &Path,
) -> Result<(), CohostAvatarErrorDetail> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| store_error("Could not create the pack folder", error))?;
    }
    let old = if dest.exists() {
        let old = root
            .join(BUDDY_ALIVE_STAGING_DIR)
            .join(format!("{}-old", uuid::Uuid::new_v4().hyphenated()));
        std::fs::rename(dest, &old)
            .map_err(|error| store_error("Could not replace the pack", error))?;
        Some(old)
    } else {
        None
    };
    if let Err(error) = std::fs::rename(staging, dest) {
        if let Some(old) = &old {
            let _ = std::fs::rename(old, dest);
        }
        return Err(store_error("Could not move the pack into place", error));
    }
    if let Some(old) = old {
        let _ = std::fs::remove_dir_all(old);
    }
    Ok(())
}

// --- Account packs (D9, D10) -------------------------------------------------------------------

/// The listed pack as this build reads it: a uuid pack id, a version, a cell
/// size the renderer accepts, at most 64 frames, and exactly the three files
/// with their sizes, hashes and paths under the avatar's own alive route.
pub(crate) fn web_alive_ok(avatar_id: &str, alive: &BuddyLibraryWebAlive) -> bool {
    matches!(
        buddy_pet::parse_pack_id(&alive.pack_id),
        Ok(PackRef::User(_))
    ) && alive.version >= 1
        && (buddy_pet::BUDDY_PET_CELL_MIN..=buddy_pet::BUDDY_PET_CELL_MAX)
            .contains(&alive.cell_size)
        && alive.frames as usize <= buddy_pet::BUDDY_PET_FRAMES_MAX
        && alive_files_ok(&web_specs(alive))
        && alive
            .files
            .iter()
            .all(|file| crate::videorc_api::buddy_alive_path_ok(&file.url, avatar_id))
}

/// The avatar's pack, when it has one this build can download.
pub(crate) fn usable_alive(avatar: &BuddyLibraryWebAvatar) -> Option<&BuddyLibraryWebAlive> {
    avatar
        .alive
        .as_ref()
        .filter(|alive| web_alive_ok(&avatar.id, alive))
}

fn web_specs(alive: &BuddyLibraryWebAlive) -> Vec<AliveFileSpec> {
    alive
        .files
        .iter()
        .map(|file| AliveFileSpec {
            name: file.name.clone(),
            bytes: file.bytes,
            sha256: file.sha256.clone(),
        })
        .collect()
}

/// Download an account Buddy's pack into the persona's `pets/` (verified),
/// unless it is already there; the pack id it is worn as.
pub(crate) async fn fetch_account_pack(
    env: &LibraryEnv,
    persona_id: &str,
    avatar_id: &str,
    alive: &BuddyLibraryWebAlive,
) -> Result<String, CohostAvatarErrorDetail> {
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let root = env.root()?;
    if !crate::cohost_avatar::persona_id_ok(persona_id) || !web_alive_ok(avatar_id, alive) {
        return Err(mismatch());
    }
    let dest = root.join(persona_id).join("pets").join(&alive.pack_id);
    let sources = web_specs(alive)
        .into_iter()
        .zip(alive.files.iter().map(|file| file.url.clone()))
        .collect();
    install_pack(&api, Some(&token), &root, &dest, sources).await?;
    Ok(alive.pack_id.clone())
}

/// Remember which account pack the linked Buddy was given.
pub(crate) fn note_alive_seen(state: &AppState, avatar_id: &str, pack_id: Option<String>) {
    update_sync(state, |sync| {
        sync.alive_seen = Some(BuddyLibraryAliveSeen {
            avatar_id: avatar_id.to_string(),
            pack_id,
        });
    });
}

/// A problem the job got past (the Buddy changed, its pack did not): shown
/// as the library's error, the job itself succeeding.
pub(crate) fn warn(state: &AppState, detail: CohostAvatarErrorDetail) {
    state.emit_log(
        "warn",
        format!("Buddy library: {} ({})", detail.message, detail.code),
    );
    state.buddy_library.cache().error = Some(detail);
}

async fn save_persona(
    state: &AppState,
    persona: CohostPersona,
) -> Result<(), CohostAvatarErrorDetail> {
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

/// After a sync listed the account: retry a pack change the account missed,
/// then follow a pack the linked Buddy gained elsewhere. Each runs as its own
/// library job, after this one.
pub(crate) async fn after_sync(state: &AppState, avatars: &[BuddyLibraryWebAvatar]) {
    let listed_pack = |id: &str| {
        avatars
            .iter()
            .find(|avatar| avatar.id == id)
            .map(|avatar| usable_alive(avatar).map(|alive| alive.pack_id.clone()))
    };
    let sync = load_library_sync(&state.database);
    if let Some(pending) = sync.pending_alive.clone() {
        match listed_pack(&pending.avatar_id) {
            // The Buddy left the library: nothing to tell it.
            None => clear_pending(state, &pending),
            Some(web_pack) => {
                let done = match pending.action {
                    BuddyLibraryPendingAction::Upload => {
                        web_pack.as_deref() == Some(pending.pack_id.as_str())
                    }
                    BuddyLibraryPendingAction::Delete => {
                        web_pack.as_deref() != Some(pending.pack_id.as_str())
                    }
                };
                if done {
                    clear_pending(state, &pending);
                    if pending.action == BuddyLibraryPendingAction::Upload {
                        note_alive_seen(state, &pending.avatar_id, Some(pending.pack_id));
                    }
                } else if state.buddy_library.alive_sync() {
                    queue_pending(state, pending);
                }
                // Our own change is on its way: never follow the account
                // for this Buddy until it lands.
                return;
            }
        }
    }
    let persona = current_persona(state).await;
    let Some(link) = persona
        .library_avatar_id
        .clone()
        .filter(|id| user_avatar_id_ok(id))
    else {
        return;
    };
    let Some(web_pack) = listed_pack(&link) else {
        return;
    };
    let seen = BuddyLibraryAliveSeen {
        avatar_id: link.clone(),
        pack_id: web_pack.clone(),
    };
    if sync.alive_seen.as_ref() == Some(&seen) {
        return;
    }
    match web_pack {
        Some(pack_id)
            if persona.avatar
                != (BuddyAvatar::Alive {
                    pack_id: pack_id.clone(),
                }) =>
        {
            // Never swap the Buddy mid-session: the next sync tries again.
            if session_live(state).await {
                return;
            }
            let avatar = link.clone();
            spawn_job(
                state,
                busy(BuddyLibraryBusyKind::AliveDownload, Some(&link)),
                move |state| async move { run_follow(&state, &avatar).await },
            );
        }
        // Worn already, or no pack on the account: nothing to change here
        // (a pack removed elsewhere stays on this computer).
        web_pack => note_alive_seen(state, &link, web_pack),
    }
}

/// Download the linked Buddy's account pack and wear it, unless the Buddy
/// changed meanwhile.
async fn run_follow(state: &AppState, avatar_id: &str) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let avatar = state
        .buddy_library
        .cache()
        .web
        .as_ref()
        .and_then(|avatars| {
            avatars
                .iter()
                .find(|avatar| avatar.id == avatar_id)
                .cloned()
        });
    let Some(avatar) = avatar else {
        return Ok(());
    };
    let Some(alive) = usable_alive(&avatar).cloned() else {
        return Ok(());
    };
    let persona = current_persona(state).await;
    if persona.library_avatar_id.as_deref() != Some(avatar_id) {
        return Ok(());
    }
    let pack_id = fetch_account_pack(&env, &persona.id, avatar_id, &alive)
        .await
        .map_err(|error| {
            CohostAvatarErrorDetail::new_owned(
                error.code,
                format!(
                    "{} is still here for now: its moves could not be downloaded ({}). It tries again at the next sync.",
                    avatar.name.trim(),
                    error.message
                ),
            )
        })?;
    let now = current_persona(state).await;
    if now.id == persona.id && now.library_avatar_id.as_deref() == Some(avatar_id) {
        let mut next = now;
        next.avatar = BuddyAvatar::Alive {
            pack_id: pack_id.clone(),
        };
        save_persona(state, next).await?;
        state.emit_log("info", format!("{} is alive.", avatar.name.trim()));
    }
    note_alive_seen(state, avatar_id, Some(pack_id));
    Ok(())
}

fn clear_pending(state: &AppState, pending: &BuddyLibraryPendingAlive) {
    update_sync(state, |sync| {
        if sync.pending_alive.as_ref() == Some(pending) {
            sync.pending_alive = None;
        }
    });
}

fn set_pending(state: &AppState, pending: BuddyLibraryPendingAlive) {
    update_sync(state, |sync| sync.pending_alive = Some(pending));
}

/// The stored pending change is still this one (a later save or removal
/// replaces it, and the job queued for the earlier one then does nothing).
fn still_pending(state: &AppState, pending: &BuddyLibraryPendingAlive) -> bool {
    load_library_sync(&state.database).pending_alive.as_ref() == Some(pending)
}

fn queue_pending(state: &AppState, pending: BuddyLibraryPendingAlive) {
    let kind = match pending.action {
        BuddyLibraryPendingAction::Upload => BuddyLibraryBusyKind::AliveUpload,
        BuddyLibraryPendingAction::Delete => BuddyLibraryBusyKind::Update,
    };
    let avatar_id = pending.avatar_id.clone();
    spawn_job(
        state,
        busy(kind, Some(&avatar_id)),
        move |state| async move {
            if !still_pending(&state, &pending) {
                return Ok(());
            }
            match pending.action {
                BuddyLibraryPendingAction::Upload => run_upload(&state, pending).await,
                BuddyLibraryPendingAction::Delete => run_remove(&state, pending).await,
            }
        },
    );
}

/// `cohost.pet.save` saved a pack the Buddy now wears: a Buddy linked to the
/// library sends it to the account (D10); a Buddy made only here keeps it
/// here (it can be saved to the library first).
pub(crate) async fn pack_saved(state: &AppState, pack_id: &str) {
    let persona = current_persona(state).await;
    let Some(avatar_id) = persona.library_avatar_id.filter(|id| user_avatar_id_ok(id)) else {
        return;
    };
    if !matches!(buddy_pet::parse_pack_id(pack_id), Ok(PackRef::User(_))) {
        return;
    }
    let pending = BuddyLibraryPendingAlive {
        avatar_id,
        pack_id: pack_id.to_string(),
        action: BuddyLibraryPendingAction::Upload,
    };
    set_pending(state, pending.clone());
    if state.buddy_library.env().token.is_some() && state.buddy_library.alive_sync() {
        queue_pending(state, pending);
    }
}

/// `cohost.pet.remove` removed one of the persona's packs: when the linked
/// Buddy's account pack is that one (or on its way there), it leaves the
/// account too (D10).
pub(crate) async fn pack_removed(state: &AppState, pack_id: &str) {
    let persona = current_persona(state).await;
    let pending = load_library_sync(&state.database).pending_alive;
    let Some(avatar_id) = persona.library_avatar_id.filter(|id| user_avatar_id_ok(id)) else {
        if let Some(pending) = pending.filter(|pending| pending.pack_id == pack_id) {
            clear_pending(state, &pending);
        }
        return;
    };
    let listed = state
        .buddy_library
        .cache()
        .web
        .as_ref()
        .and_then(|avatars| {
            avatars
                .iter()
                .find(|avatar| avatar.id == avatar_id)
                .cloned()
        })
        .and_then(|avatar| usable_alive(&avatar).map(|alive| alive.pack_id.clone()));
    let uploading = pending.as_ref().is_some_and(|pending| {
        pending.avatar_id == avatar_id
            && pending.pack_id == pack_id
            && pending.action == BuddyLibraryPendingAction::Upload
    });
    if listed.as_deref() != Some(pack_id) && !uploading {
        return;
    }
    let removal = BuddyLibraryPendingAlive {
        avatar_id,
        pack_id: pack_id.to_string(),
        action: BuddyLibraryPendingAction::Delete,
    };
    set_pending(state, removal.clone());
    if state.buddy_library.env().token.is_some() && state.buddy_library.alive_sync() {
        queue_pending(state, removal);
    }
}

/// Whether a failed account call is worth another try at the next sync:
/// the network, a timeout, the server's own trouble. A refusal (the pack is
/// invalid, too large, the Buddy gone) is final.
fn retryable(error: &CohostApiError) -> bool {
    match error.kind {
        CohostApiErrorKind::Network
        | CohostApiErrorKind::GatewayError
        | CohostApiErrorKind::QuotaExhausted { .. }
        | CohostApiErrorKind::Unauthorized => true,
        CohostApiErrorKind::ServerUnconfigured => error.detail.code != "buddy-alive-unsupported",
        _ => error.detail.status.is_some_and(|status| status == 410),
    }
}

/// A web failure of an alive job: final ones drop the pending change.
fn alive_failure(
    state: &AppState,
    pending: &BuddyLibraryPendingAlive,
    error: &CohostApiError,
    what: &str,
) -> CohostAvatarErrorDetail {
    let detail = library_error(error);
    if retryable(error) {
        CohostAvatarErrorDetail::new_owned(
            detail.code,
            format!(
                "{what}: {} Videorc tries again at the next sync.",
                detail.message
            ),
        )
    } else {
        clear_pending(state, pending);
        CohostAvatarErrorDetail::new_owned(detail.code, format!("{what}: {}", detail.message))
    }
}

/// The three files of a synced pack, read from its folder: the manifest
/// must name `mascot.webp` as its only sheet, and the sidecar must be there.
/// Blocking.
fn read_pack_files(dir: &Path) -> Result<Vec<(AliveFileSpec, Vec<u8>)>, CohostAvatarErrorDetail> {
    let not_syncable = |message: &str| {
        CohostAvatarErrorDetail::new(
            COHOST_ALIVE_NOT_SYNCABLE,
            format!("This pack stays on this computer: {message}"),
        )
    };
    let mut files = Vec::new();
    for (name, cap) in BUDDY_ALIVE_FILES {
        let path = dir.join(name);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| not_syncable(&format!("it has no {name}.")))?;
        if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > cap {
            return Err(not_syncable(&format!(
                "its {name} is not one the library keeps."
            )));
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| store_error(&format!("Could not read {name}"), error))?;
        if bytes.len() as u64 > cap {
            return Err(not_syncable(&format!("its {name} is too large.")));
        }
        if name == buddy_pet::BUDDY_PET_MANIFEST_FILE {
            let manifest =
                buddy_pet::parse_manifest(&bytes).map_err(|error| not_syncable(&error.message))?;
            if !manifest.sheet_names().iter().eq(["mascot.webp"].iter()) {
                return Err(not_syncable("its pictures are not one mascot.webp sheet."));
            }
        }
        files.push((
            AliveFileSpec {
                name: name.to_string(),
                bytes: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
            },
            bytes,
        ));
    }
    Ok(files)
}

fn declared(files: &[(AliveFileSpec, Vec<u8>)]) -> Vec<BuddyUploadFile> {
    files
        .iter()
        .map(|(spec, _)| BuddyUploadFile {
            name: spec.name.clone(),
            bytes: spec.bytes,
            sha256: spec.sha256.clone(),
        })
        .collect()
}

/// PUT every file to the URL the web signed for it.
async fn upload_files(
    api: &VideorcApiClient,
    plan: &BuddyUploadPlan,
    files: Vec<(AliveFileSpec, Vec<u8>)>,
) -> Result<(), CohostApiError> {
    for (spec, bytes) in files {
        let target = plan
            .uploads
            .iter()
            .find(|target| target.name == spec.name)
            .ok_or_else(|| {
                CohostApiError::malformed_response(
                    200,
                    format!("The library sent no upload address for {}.", spec.name),
                )
            })?;
        api.put_presigned(target, bytes).await?;
    }
    Ok(())
}

/// Send the persona's pack to its library Buddy (D8, D10).
async fn run_upload(
    state: &AppState,
    pending: BuddyLibraryPendingAlive,
) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let root = env.root()?;
    let persona = current_persona(state).await;
    let what = format!(
        "{}'s moves were not saved to your library",
        persona.name.trim()
    );
    let dir = root.join(&persona.id).join("pets").join(&pending.pack_id);
    let files = match blocking(move || read_pack_files(&dir)).await {
        Ok(files) => files,
        Err(error) => {
            // A pack the library cannot keep (or one that is gone) is final.
            clear_pending(state, &pending);
            return Err(error);
        }
    };
    let request = BuddyAliveUploadRequest {
        pack_id: pending.pack_id.clone(),
        files: declared(&files),
    };
    let plan = api
        .post_buddy_alive(&token, &pending.avatar_id, &request)
        .await
        .map_err(|error| alive_failure(state, &pending, &error, &what))?;
    upload_files(&api, &plan, files)
        .await
        .map_err(|error| alive_failure(state, &pending, &error, &what))?;
    let avatar = api
        .post_buddy_alive_commit(&token, &pending.avatar_id, &plan.upload_id)
        .await
        .map_err(|error| alive_failure(state, &pending, &error, &what))?
        .avatar;
    if web_avatar_ok(&avatar) && avatar.id == pending.avatar_id {
        remember_avatar(state, &avatar);
    }
    clear_pending(state, &pending);
    note_alive_seen(state, &pending.avatar_id, Some(pending.pack_id.clone()));
    state.emit_log(
        "info",
        format!("{}'s moves are saved to your library.", persona.name.trim()),
    );
    Ok(())
}

/// Remove the Buddy's pack from the account, when it is still the one
/// removed here (another computer may have sent a newer one).
async fn run_remove(
    state: &AppState,
    pending: BuddyLibraryPendingAlive,
) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let what = "The pack was removed here but not from your library";
    let current = match api.get_buddy_avatar(&token, &pending.avatar_id).await {
        Ok(response) => response.avatar,
        Err(error) => return Err(alive_failure(state, &pending, &error, what)),
    };
    if usable_alive(&current).map(|alive| alive.pack_id.as_str()) != Some(pending.pack_id.as_str())
    {
        clear_pending(state, &pending);
        return Ok(());
    }
    let avatar = api
        .delete_buddy_alive(&token, &pending.avatar_id)
        .await
        .map_err(|error| alive_failure(state, &pending, &error, what))?
        .avatar;
    if web_avatar_ok(&avatar) && avatar.id == pending.avatar_id {
        remember_avatar(state, &avatar);
    }
    clear_pending(state, &pending);
    note_alive_seen(state, &pending.avatar_id, None);
    Ok(())
}

// --- Save to my library (D10) ------------------------------------------------------------------

/// `cohost.library.saveToLibrary`: a Buddy made only on this computer joins
/// the account library (its poses, name, personality and notes as About
/// you), is linked, then sends its own pack when it wears one.
pub async fn save_to_library(
    state: &AppState,
) -> Result<CohostLibraryAccepted, CohostLibraryRefusal> {
    check_library(state)?;
    let persona = current_persona(state).await;
    if active_avatar_id(&persona).is_some() || persona.library_avatar_id.is_some() {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "This Buddy is already in a library.",
        ));
    }
    if persona.images.idle.is_none() {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_INVALID,
            "Your Buddy needs its idle picture to be saved to your library.",
        ));
    }
    if state
        .buddy_library
        .cache()
        .capability
        .as_ref()
        .is_some_and(|capability| capability.enabled && !capability.alive)
    {
        return Err(CohostLibraryRefusal::new(
            COHOST_LIBRARY_UNAVAILABLE,
            "Saving to your library is not available right now.",
        ));
    }
    spawn_job(
        state,
        busy(BuddyLibraryBusyKind::Import, None),
        move |state| async move { run_import(&state).await },
    );
    Ok(accepted())
}

/// The persona's poses as the import sends them: PNG (an upload in WebP or
/// JPEG is re-encoded), at most 8 MB each, idle required. Blocking.
fn persona_pose_files(
    root: &Path,
    images: &CohostPersonaImages,
) -> Result<Vec<(AliveFileSpec, Vec<u8>)>, CohostAvatarErrorDetail> {
    let mut files = Vec::new();
    for (avatar_state, path) in [
        (CohostAvatarState::Idle, &images.idle),
        (CohostAvatarState::Talk, &images.talk),
        (CohostAvatarState::Laugh, &images.laugh),
        (CohostAvatarState::Think, &images.think),
    ] {
        let png = path
            .as_deref()
            .and_then(|relative| pose_png(&root.join(relative)));
        match png {
            Some(bytes) => files.push((
                AliveFileSpec {
                    name: format!("{}.png", avatar_state.as_str()),
                    bytes: bytes.len() as u64,
                    sha256: sha256_hex(&bytes),
                },
                bytes,
            )),
            None if avatar_state == CohostAvatarState::Idle => {
                return Err(CohostAvatarErrorDetail::new(
                    COHOST_LIBRARY_INVALID,
                    "Your Buddy's idle picture could not be read, so it was not saved to your library.",
                ));
            }
            None => {}
        }
    }
    Ok(files)
}

fn pose_png(path: &Path) -> Option<Vec<u8>> {
    if !crate::cohost_avatar::is_regular_file(path) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > BUDDY_IMPORT_POSE_MAX_BYTES * 4 {
        return None;
    }
    let png = if image::guess_format(&bytes).ok() == Some(image::ImageFormat::Png) {
        bytes
    } else {
        let decoded = image::load_from_memory(&bytes).ok()?;
        let mut png = Vec::new();
        decoded
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        png
    };
    (png.len() as u64 <= BUDDY_IMPORT_POSE_MAX_BYTES).then_some(png)
}

async fn run_import(state: &AppState) -> Result<(), CohostAvatarErrorDetail> {
    let env = state.buddy_library.env();
    let (api, token) = env.web().ok_or_else(signed_out_detail)?;
    let root = env.root()?;
    let settings = crate::cohost::get_cohost_settings(state).await;
    let persona = settings.persona.clone();
    if persona.library_avatar_id.is_some() {
        return Ok(());
    }
    let poses = {
        let root = root.clone();
        let images = persona.images.clone();
        blocking(move || persona_pose_files(&root, &images)).await?
    };
    let pictures: BTreeMap<CohostAvatarState, Vec<u8>> = poses
        .iter()
        .filter_map(|(spec, bytes)| {
            let name = spec.name.strip_suffix(".png")?;
            let avatar_state: CohostAvatarState =
                serde_json::from_value(serde_json::json!(name)).ok()?;
            Some((avatar_state, bytes.clone()))
        })
        .collect();
    let optional = |text: &str, max: usize| {
        let text = crate::cohost::truncate_utf16(text.trim(), max);
        (!text.is_empty()).then_some(text)
    };
    let request = BuddyImportRequest {
        name: library_name(&persona.name).unwrap_or_else(|| "Buddy".to_string()),
        personality: optional(&persona.personality, 1200),
        context: optional(&settings.notes, 4000),
        files: declared(&poses),
    };
    let failed = |error: CohostApiError| {
        let detail = library_error(&error);
        CohostAvatarErrorDetail::new_owned(
            detail.code,
            format!(
                "{} was not saved to your library: {}",
                persona.name.trim(),
                detail.message
            ),
        )
    };
    let plan = api
        .post_buddy_import(&token, &request)
        .await
        .map_err(failed)?;
    upload_files(&api, &plan, poses).await.map_err(failed)?;
    let avatar = api
        .post_buddy_import_commit(&token, &plan.upload_id)
        .await
        .map_err(failed)?
        .avatar;
    if !web_avatar_ok(&avatar) {
        return Err(CohostAvatarErrorDetail::new(
            "malformed-response",
            "Videorc answered in a way this app does not read. Update Videorc.",
        ));
    }
    note_created(state, &avatar, &pictures).await;
    // Linked only when the Buddy is still the one that was sent.
    let now = current_persona(state).await;
    if now.id != persona.id || now.library_avatar_id.is_some() {
        return Ok(());
    }
    set_link(state, Some(avatar.id.clone())).await?;
    note_alive_seen(state, &avatar.id, None);
    state.emit_log(
        "info",
        format!("{} is saved to your library.", persona.name.trim()),
    );
    // The account's Buddy is this one now, so a sync never swaps it back.
    if let Err(error) = select_on_account(state, &api, &token, &avatar.id).await {
        warn(state, error);
    }
    // Its own pack follows (D10).
    if let BuddyAvatar::Alive { pack_id } = &now.avatar
        && matches!(buddy_pet::parse_pack_id(pack_id), Ok(PackRef::User(_)))
    {
        let pending = BuddyLibraryPendingAlive {
            avatar_id: avatar.id.clone(),
            pack_id: pack_id.clone(),
            action: BuddyLibraryPendingAction::Upload,
        };
        set_pending(state, pending.clone());
        if state.buddy_library.alive_sync() {
            queue_pending(state, pending);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
