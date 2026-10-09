//! Alive packs and the library against the fake web and its fake storage
//! (plan 172 Phases B and D): official downloads (verify-fail, offline, a
//! Buddy changed while one lands, the bundled pack missing), the default
//! Buddy, account packs on apply and sync (a tampered download included),
//! the upload after a save and its retry, removal, and Save to my library.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;

use super::*;
use crate::buddy_pet::tests::{synthetic_manifest, write_pack};
use crate::cohost::get_cohost_settings;
use crate::cohost_library::tests::{
    BEARER, FakeAlive, FakeAvatar, FakeLibrary, fast_timing, library_state, png_bytes, settle,
    spawn_fake_library, temp_root, test_state,
};

const AVATAR: &str = "7c9e6679-7425-40de-944b-e07fc1ee9a51";
const PACK: &str = "0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a";
const OTHER_PACK: &str = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

// --- Helpers -----------------------------------------------------------------------------------

/// The three files of a synced pack: a synthetic manifest naming
/// `mascot.webp`, its sheet, and a sidecar.
fn pack_files(seed: u8) -> Vec<(String, Vec<u8>)> {
    let dir = temp_root().join("pack");
    write_pack(&dir, &synthetic_manifest("mascot.webp"), "mascot.webp");
    let sidecar = serde_json::json!({
        "version": 1,
        "source": "videorc-creator",
        "headTop": 0.1,
        "talk": ["talk-a"],
        "createdAt": format!("2026-10-09T10:00:{seed:02}Z")
    });
    std::fs::write(
        dir.join("buddy.json"),
        serde_json::to_vec(&sidecar).unwrap(),
    )
    .unwrap();
    ["manifest.json", "mascot.webp", "buddy.json"]
        .into_iter()
        .map(|name| (name.to_string(), std::fs::read(dir.join(name)).unwrap()))
        .collect()
}

fn specs_of(files: &[(String, Vec<u8>)]) -> Vec<AliveFileSpec> {
    files
        .iter()
        .map(|(name, bytes)| AliveFileSpec {
            name: name.clone(),
            bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        })
        .collect()
}

/// Golmar's pack, version 2, listed by the test instead of the catalog.
fn orc_table(files: &[(String, Vec<u8>)]) -> Arc<BTreeMap<BuddyOfficialSlug, OfficialAliveSpec>> {
    Arc::new(BTreeMap::from([
        (
            BuddyOfficialSlug::Golem,
            OfficialAliveSpec {
                version: 1,
                pack_id: BUDDY_DEFAULT_ALIVE_PACK_ID.to_string(),
                bundled: true,
                files: specs_of(files),
            },
        ),
        (
            BuddyOfficialSlug::Orc,
            OfficialAliveSpec {
                version: 2,
                pack_id: "official:orc".to_string(),
                bundled: false,
                files: specs_of(files),
            },
        ),
    ]))
}

/// The web serves Golmar's files at their static paths.
fn serve_official(web: &FakeLibrary, files: &[(String, Vec<u8>)]) {
    web.with(|fake| {
        for (name, bytes) in files {
            fake.official
                .insert(format!("/buddy/official/orc/alive/2/{name}"), bytes.clone());
        }
    });
}

/// A state on the fake web whose official packs are `table`, with a
/// bundled root (empty unless the test fills it), signed in or not.
async fn official_state(
    root: &Path,
    web: &FakeLibrary,
    table: Arc<BTreeMap<BuddyOfficialSlug, OfficialAliveSpec>>,
    api: Option<VideorcApiClient>,
) -> AppState {
    let mut state = test_state();
    state.buddy_library = Arc::new(LibraryShared::for_tests(
        LibraryEnv {
            root: Some(root.join("write")),
            bundled_root: Some(root.join("bundled")),
            api: Some(api.unwrap_or_else(|| web.client.clone())),
            token: None,
            official_alive: Some(table),
        },
        fast_timing(),
    ));
    std::fs::create_dir_all(root.join("write")).unwrap();
    std::fs::create_dir_all(root.join("bundled")).unwrap();
    *state.account_session.lock().await = Some(crate::account::signed_out_account());
    state
}

async fn persona(state: &AppState) -> CohostPersona {
    get_cohost_settings(state).await.persona
}

async fn save(state: &AppState, persona: CohostPersona) {
    crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            persona: Some(persona),
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .unwrap();
}

fn use_params(id: &str) -> CohostLibraryAvatarParams {
    CohostLibraryAvatarParams {
        avatar_id: id.to_string(),
    }
}

fn alive(pack_id: &str) -> BuddyAvatar {
    BuddyAvatar::Alive {
        pack_id: pack_id.to_string(),
    }
}

fn staging_is_empty(root: &Path) -> bool {
    std::fs::read_dir(root.join(BUDDY_ALIVE_STAGING_DIR))
        .map(|entries| entries.count() == 0)
        .unwrap_or(true)
}

fn official_state_of(
    library: &BuddyLibraryState,
    slug: BuddyOfficialSlug,
) -> BuddyOfficialAliveState {
    library
        .official
        .iter()
        .find(|entry| entry.slug == slug)
        .unwrap()
        .alive
}

// --- Official packs (D4, D5) -------------------------------------------------------------------

#[tokio::test]
async fn buddy_official_pack_downloads_verified_then_the_buddy_is_alive() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    serve_official(&web, &files);
    let state = official_state(&root, &web, orc_table(&files), None).await;
    assert_eq!(
        official_state_of(&get(&state).await, BuddyOfficialSlug::Orc),
        BuddyOfficialAliveState::Available
    );
    // The Buddy's pack is not in the bundled root: none, not bundled.
    assert_eq!(
        official_state_of(&get(&state).await, BuddyOfficialSlug::Golem),
        BuddyOfficialAliveState::None
    );
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    settle(&state, |library| {
        official_state_of(library, BuddyOfficialSlug::Orc) == BuddyOfficialAliveState::Downloaded
    })
    .await;
    let worn = persona(&state).await;
    assert_eq!(worn.library_avatar_id.as_deref(), Some("official:orc"));
    assert_eq!(worn.avatar, alive("official:orc"));
    assert_eq!(worn.name, "Golmar");
    let folder = root.join("write").join("official").join("orc").join("2");
    for (name, bytes) in &files {
        assert_eq!(&std::fs::read(folder.join(name)).unwrap(), bytes, "{name}");
    }
    assert!(staging_is_empty(&root.join("write")));
    // The static files went out without the bearer, once each.
    for (name, _) in &files {
        assert_eq!(
            web.count(&format!("GET /buddy/official/orc/alive/2/{name}")),
            1
        );
    }
    // Used again: worn at once from the verified folder, nothing downloads.
    use_avatar(&state, use_params("official:goblin"))
        .await
        .unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some("official:goblin")
    })
    .await;
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some("official:orc")
    })
    .await;
    assert_eq!(persona(&state).await.avatar, alive("official:orc"));
    assert_eq!(web.count("GET /buddy/official/orc/alive/2/mascot.webp"), 1);
}

#[tokio::test]
async fn buddy_official_pack_that_fails_its_hash_is_never_used() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    let mut tampered = files.clone();
    tampered[1].1[40] ^= 0xff;
    serve_official(&web, &tampered);
    let state = official_state(&root, &web, orc_table(&files), None).await;
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    settle(&state, |library| library.error.is_some()).await;
    let library = get(&state).await;
    assert_eq!(library.error.unwrap().code, COHOST_ALIVE_MISMATCH);
    assert_eq!(
        official_state_of(&get(&state).await, BuddyOfficialSlug::Orc),
        BuddyOfficialAliveState::Available
    );
    let worn = persona(&state).await;
    assert_eq!(worn.library_avatar_id.as_deref(), Some("official:orc"));
    assert_eq!(
        worn.avatar,
        BuddyAvatar::Still,
        "Still until a pack verifies"
    );
    assert!(!root.join("write").join("official").join("orc").exists());
    assert!(staging_is_empty(&root.join("write")));
}

#[tokio::test]
async fn buddy_official_pack_offline_stays_still_and_tries_again_on_next_use() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    serve_official(&web, &files);
    // Nothing listens on the discard port: offline.
    let offline = VideorcApiClient::for_base_url("http://127.0.0.1:9");
    let mut state = official_state(&root, &web, orc_table(&files), Some(offline)).await;
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    settle(&state, |library| library.error.is_some()).await;
    assert_eq!(get(&state).await.error.unwrap().code, "network");
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
    assert_eq!(
        persona(&state).await.name,
        "Golmar",
        "the Buddy still changed"
    );
    // Back online: the next use downloads and wears it.
    state.buddy_library = Arc::new(LibraryShared::for_tests(
        LibraryEnv {
            root: Some(root.join("write")),
            bundled_root: Some(root.join("bundled")),
            api: Some(web.client.clone()),
            token: None,
            official_alive: Some(orc_table(&files)),
        },
        fast_timing(),
    ));
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    settle(&state, |library| {
        official_state_of(library, BuddyOfficialSlug::Orc) == BuddyOfficialAliveState::Downloaded
    })
    .await;
    assert_eq!(persona(&state).await.avatar, alive("official:orc"));
    assert!(get(&state).await.error.is_none());
}

#[tokio::test]
async fn buddy_official_pack_landing_after_the_buddy_changed_leaves_it_alone() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    serve_official(&web, &files);
    let hold = Arc::new(tokio::sync::Semaphore::new(0));
    web.with(|fake| fake.hold_official = Some(hold.clone()));
    let state = official_state(&root, &web, orc_table(&files), None).await;
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    // Wait until the download is running (the apply landed, Still).
    for _ in 0..300 {
        if get(&state).await.busy.as_ref().map(|busy| busy.kind)
            == Some(BuddyLibraryBusyKind::AliveDownload)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
    // Meanwhile the streamer makes their own Buddy (only on this computer).
    let mut own = persona(&state).await;
    own.name = "Mossback".to_string();
    own.source = CohostPersonaSource::Uploaded;
    own.library_avatar_id = None;
    save(&state, own.clone()).await;
    hold.add_permits(1000);
    settle(&state, |library| {
        official_state_of(library, BuddyOfficialSlug::Orc) == BuddyOfficialAliveState::Downloaded
    })
    .await;
    // The pack landed and is kept, but the new Buddy is untouched.
    assert_eq!(persona(&state).await, own);
    assert_eq!(get(&state).await.active_avatar_id, None);
}

#[tokio::test]
async fn buddy_default_is_alive_only_when_its_bundled_pack_ships() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    let state = official_state(&root, &web, orc_table(&files), None).await;
    // Bundled pack missing: the Buddy applies Still.
    use_avatar(&state, use_params("official:golem"))
        .await
        .unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some("official:golem")
    })
    .await;
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
    assert!(web.seen().is_empty(), "the Buddy never downloads");
    // It ships: Alive with bundled:buddy, and the library says bundled.
    write_pack(
        &root.join("bundled").join("buddy"),
        &synthetic_manifest("mascot.webp"),
        "mascot.webp",
    );
    assert_eq!(
        official_state_of(&get(&state).await, BuddyOfficialSlug::Golem),
        BuddyOfficialAliveState::Bundled
    );
    use_avatar(&state, use_params("official:golem"))
        .await
        .unwrap();
    settle(&state, |_| true).await;
    assert_eq!(persona(&state).await.avatar, alive("bundled:buddy"));
    assert_eq!(persona(&state).await.source, CohostPersonaSource::Default);
}

#[test]
fn buddy_default_switches_to_its_bundled_pack_once() {
    let bundled = temp_root();
    let database = Database::open_in_memory_for_tests();
    // No pack shipped: Still, and nothing remembered (a later launch with it switches).
    let fresh = default_buddy_alive(&database, CohostSettings::default(), Some(&bundled));
    assert_eq!(fresh.persona.avatar, BuddyAvatar::Still);
    assert_eq!(
        database
            .load_setting::<bool>(BUDDY_DEFAULT_ALIVE_KEY)
            .unwrap(),
        None
    );
    let fresh = default_buddy_alive(&database, CohostSettings::default(), None);
    assert_eq!(fresh.persona.avatar, BuddyAvatar::Still);
    // It ships: the untouched default wears it, saved, once.
    write_pack(
        &bundled.join("buddy"),
        &synthetic_manifest("mascot.webp"),
        "mascot.webp",
    );
    let upgraded = default_buddy_alive(&database, CohostSettings::default(), Some(&bundled));
    assert_eq!(upgraded.persona.avatar, alive("bundled:buddy"));
    assert_eq!(crate::cohost::load_cohost_settings(&database), upgraded);
    assert_eq!(
        database
            .load_setting::<bool>(BUDDY_DEFAULT_ALIVE_KEY)
            .unwrap(),
        Some(true)
    );
    // Switched back to Still by hand: it stays Still.
    let mut still = upgraded;
    still.persona.avatar = BuddyAvatar::Still;
    assert_eq!(
        default_buddy_alive(&database, still.clone(), Some(&bundled)),
        still
    );
    // A Buddy of the streamer's own is never touched, and the switch is spent.
    let database = Database::open_in_memory_for_tests();
    let mut own = CohostSettings::default();
    own.persona.source = CohostPersonaSource::Uploaded;
    own.persona.images.idle = Some("default/idle.png".to_string());
    assert_eq!(
        default_buddy_alive(&database, own.clone(), Some(&bundled)),
        own
    );
    assert_eq!(
        database
            .load_setting::<bool>(BUDDY_DEFAULT_ALIVE_KEY)
            .unwrap(),
        Some(true)
    );
}

// --- Account packs (D9, D10) -------------------------------------------------------------------

/// A library with Grum, whose pack is `files`.
async fn grum_with_pack(root: &Path, web: &FakeLibrary, files: &[(String, Vec<u8>)]) -> AppState {
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.set_alive(
        AVATAR,
        FakeAlive {
            pack_id: PACK.to_string(),
            files: files.to_vec(),
        },
    );
    library_state(root, web).await
}

fn pets(root: &Path, pack: &str) -> PathBuf {
    root.join("default").join("pets").join(pack)
}

#[tokio::test]
async fn buddy_library_use_downloads_the_account_pack_verified_and_wears_it() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    let state = grum_with_pack(&root, &web, &files).await;
    request_sync(&state, BuddyLibrarySyncReason::Tab);
    settle(&state, |library| library.mine.is_some()).await;
    let listed = get(&state).await.mine.unwrap();
    assert_eq!(
        listed[0].alive,
        Some(BuddyLibraryEntryAlive {
            pack_id: PACK.to_string(),
            cell_size: 640
        })
    );
    use_avatar(&state, use_params(AVATAR)).await.unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    let worn = persona(&state).await;
    assert_eq!(worn.avatar, alive(PACK));
    for (name, bytes) in &files {
        assert_eq!(&std::fs::read(pets(&root, PACK).join(name)).unwrap(), bytes);
    }
    assert!(staging_is_empty(&root));
    // The signed URLs were fetched from storage without the bearer.
    let gets = web.s3().lock().unwrap().gets.clone();
    assert_eq!(gets.len(), 3);
    assert!(gets.iter().all(|(_, credential)| !credential), "{gets:?}");
    assert_eq!(
        load_library_sync(&state.database).alive_seen,
        Some(BuddyLibraryAliveSeen {
            avatar_id: AVATAR.to_string(),
            pack_id: Some(PACK.to_string())
        })
    );
    // The pack wears like any of the persona's own.
    let loaded = crate::buddy_pet::load_pack(&[root.clone()], "default", PACK).unwrap();
    assert_eq!(loaded.pack_id, PACK);
}

#[tokio::test]
async fn buddy_library_a_tampered_account_pack_stays_still_until_it_verifies() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(1);
    let state = grum_with_pack(&root, &web, &files).await;
    let key = format!("avatars/{AVATAR}/alive/{PACK}/mascot.webp");
    web.s3().lock().unwrap().objects.get_mut(&key).unwrap()[50] ^= 0xff;
    use_avatar(&state, use_params(AVATAR)).await.unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR) && library.error.is_some()
    })
    .await;
    assert_eq!(get(&state).await.error.unwrap().code, COHOST_ALIVE_MISMATCH);
    let worn = persona(&state).await;
    assert_eq!(worn.avatar, BuddyAvatar::Still, "the poses applied, Still");
    assert_eq!(worn.name, "Grum");
    assert!(!pets(&root, PACK).exists());
    assert!(staging_is_empty(&root));
    assert_eq!(
        web.count("PUT /api/buddy/profile"),
        1,
        "the account still heard"
    );
    // Storage is fixed: the next sync downloads it and the Buddy is Alive.
    web.s3()
        .lock()
        .unwrap()
        .objects
        .insert(key, files[1].1.clone());
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |_| true).await;
    settle(&state, |_| true).await;
    assert_eq!(persona(&state).await.avatar, alive(PACK));
}

#[tokio::test]
async fn buddy_library_sync_follows_a_pack_the_linked_buddy_gained_elsewhere() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.choose(Some(AVATAR));
    let state = library_state(&root, &web).await;
    request_sync(&state, BuddyLibrarySyncReason::Launch);
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
    // Made alive on another computer.
    let files = pack_files(2);
    web.set_alive(
        AVATAR,
        FakeAlive {
            pack_id: PACK.to_string(),
            files: files.clone(),
        },
    );
    request_sync(&state, BuddyLibrarySyncReason::Focus);
    // A focus sync right after the launch one is skipped; a manual one runs.
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |_| true).await;
    for _ in 0..200 {
        if persona(&state).await.avatar == alive(PACK) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    settle(&state, |_| true).await;
    assert_eq!(persona(&state).await.avatar, alive(PACK));
    // Switched to Still here: later syncs leave it Still.
    let mut still = persona(&state).await;
    still.avatar = BuddyAvatar::Still;
    save(&state, still).await;
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |_| true).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    settle(&state, |_| true).await;
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
}

/// Write a pack of the persona's own, as `cohost.pet.save` leaves it.
fn own_pack(root: &Path, pack: &str, seed: u8) -> Vec<(String, Vec<u8>)> {
    let files = pack_files(seed);
    let dir = pets(root, pack);
    std::fs::create_dir_all(dir.join("sources")).unwrap();
    for (name, bytes) in &files {
        std::fs::write(dir.join(name), bytes).unwrap();
    }
    std::fs::write(dir.join("build-report.json"), b"{}").unwrap();
    std::fs::write(dir.join("sources").join("reference-v1.png"), png_bytes(9)).unwrap();
    files
}

async fn linked_grum(root: &Path, web: &FakeLibrary) -> AppState {
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.choose(Some(AVATAR));
    let state = library_state(root, web).await;
    request_sync(&state, BuddyLibrarySyncReason::Launch);
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    state
}

async fn wear(state: &AppState, pack: &str) {
    let mut worn = persona(state).await;
    worn.avatar = alive(pack);
    save(state, worn).await;
}

#[tokio::test]
async fn buddy_library_a_saved_pack_of_a_linked_buddy_goes_to_the_account() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_grum(&root, &web).await;
    let files = own_pack(&root, PACK, 3);
    wear(&state, PACK).await;
    pack_saved(&state, PACK).await;
    settle(&state, |_| true).await;
    let uploaded = web.alive_of(AVATAR).expect("the account has the pack");
    assert_eq!(uploaded.pack_id, PACK);
    assert_eq!(uploaded.files, files, "the three files, nothing else");
    // Straight to storage: the signed content type, never a credential.
    let puts = web.s3().lock().unwrap().puts.clone();
    assert_eq!(puts.len(), 3);
    for (key, content_type, credential) in &puts {
        assert!(!credential, "{key}");
        let expected = if key.ends_with(".webp") {
            "image/webp"
        } else {
            "application/json"
        };
        assert_eq!(content_type.as_deref(), Some(expected), "{key}");
    }
    let body = web
        .body_of(&format!("POST /api/buddy/avatars/{AVATAR}/alive"))
        .unwrap();
    assert_eq!(body["packId"], PACK);
    assert_eq!(body["files"].as_array().unwrap().len(), 3);
    assert_eq!(
        web.count(&format!("POST /api/buddy/avatars/{AVATAR}/alive/commit")),
        1
    );
    let sync = load_library_sync(&state.database);
    assert_eq!(sync.pending_alive, None);
    assert_eq!(
        sync.alive_seen.unwrap().pack_id.as_deref(),
        Some(PACK),
        "the next sync does not download it back"
    );
    assert_eq!(
        get(&state).await.mine.unwrap()[0]
            .alive
            .as_ref()
            .unwrap()
            .pack_id,
        PACK
    );
}

#[tokio::test]
async fn buddy_library_a_failed_upload_is_tried_again_at_the_next_sync() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_grum(&root, &web).await;
    own_pack(&root, PACK, 4);
    wear(&state, PACK).await;
    web.s3().lock().unwrap().fail_put = Some(StatusCode::SERVICE_UNAVAILABLE);
    pack_saved(&state, PACK).await;
    settle(&state, |library| library.error.is_some()).await;
    assert!(web.alive_of(AVATAR).is_none());
    assert_eq!(
        load_library_sync(&state.database).pending_alive,
        Some(BuddyLibraryPendingAlive {
            avatar_id: AVATAR.to_string(),
            pack_id: PACK.to_string(),
            action: BuddyLibraryPendingAction::Upload
        })
    );
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |_| true).await;
    for _ in 0..200 {
        if web.alive_of(AVATAR).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    settle(&state, |_| true).await;
    assert_eq!(web.alive_of(AVATAR).unwrap().pack_id, PACK);
    assert_eq!(load_library_sync(&state.database).pending_alive, None);
    assert!(get(&state).await.error.is_none());
}

#[tokio::test]
async fn buddy_library_an_upload_replaced_by_a_removal_never_runs() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_grum(&root, &web).await;
    own_pack(&root, PACK, 9);
    let upload = BuddyLibraryPendingAlive {
        avatar_id: AVATAR.to_string(),
        pack_id: PACK.to_string(),
        action: BuddyLibraryPendingAction::Upload,
    };
    // The pack was removed after its upload was queued: the removal is the
    // stored change, so the queued upload does nothing.
    set_pending(
        &state,
        BuddyLibraryPendingAlive {
            action: BuddyLibraryPendingAction::Delete,
            ..upload.clone()
        },
    );
    queue_pending(&state, upload);
    settle(&state, |_| true).await;
    assert_eq!(
        web.count(&format!("POST /api/buddy/avatars/{AVATAR}/alive")),
        0
    );
    assert!(get(&state).await.error.is_none());
}

#[tokio::test]
async fn buddy_library_a_pack_of_a_local_only_buddy_stays_local() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = library_state(&root, &web).await;
    own_pack(&root, PACK, 5);
    wear(&state, PACK).await;
    pack_saved(&state, PACK).await;
    settle(&state, |_| true).await;
    assert!(web.seen().is_empty());
    assert_eq!(load_library_sync(&state.database).pending_alive, None);
}

#[tokio::test]
async fn buddy_library_a_pack_that_is_not_a_synced_pack_is_kept_here() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_grum(&root, &web).await;
    // A page-pet import: its sheet is a PNG.
    let dir = pets(&root, PACK);
    write_pack(&dir, &synthetic_manifest("mascot.png"), "mascot.png");
    std::fs::write(dir.join("buddy.json"), b"{}").unwrap();
    wear(&state, PACK).await;
    pack_saved(&state, PACK).await;
    settle(&state, |library| library.error.is_some()).await;
    assert_eq!(
        get(&state).await.error.unwrap().code,
        COHOST_ALIVE_NOT_SYNCABLE
    );
    assert_eq!(
        load_library_sync(&state.database).pending_alive,
        None,
        "final"
    );
    assert_eq!(
        web.count(&format!("POST /api/buddy/avatars/{AVATAR}/alive")),
        0
    );
}

#[tokio::test]
async fn buddy_library_removing_the_pack_here_removes_it_from_the_account() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let files = pack_files(6);
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.set_alive(
        AVATAR,
        FakeAlive {
            pack_id: PACK.to_string(),
            files,
        },
    );
    web.choose(Some(AVATAR));
    let state = library_state(&root, &web).await;
    request_sync(&state, BuddyLibrarySyncReason::Launch);
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    assert_eq!(persona(&state).await.avatar, alive(PACK));
    // Another pack is removed: the account keeps Grum's.
    pack_removed(&state, OTHER_PACK).await;
    settle(&state, |_| true).await;
    assert!(web.alive_of(AVATAR).is_some());
    // Grum's own: Still here, gone from the account.
    let mut still = persona(&state).await;
    still.avatar = BuddyAvatar::Still;
    save(&state, still).await;
    std::fs::remove_dir_all(pets(&root, PACK)).unwrap();
    pack_removed(&state, PACK).await;
    settle(&state, |_| true).await;
    assert!(web.alive_of(AVATAR).is_none());
    assert_eq!(
        web.count(&format!("DELETE /api/buddy/avatars/{AVATAR}/alive")),
        1
    );
    assert_eq!(get(&state).await.mine.unwrap()[0].alive, None);
    // The next sync neither downloads it again nor removes anything more.
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |_| true).await;
    assert!(!pets(&root, PACK).exists());
    assert_eq!(persona(&state).await.avatar, BuddyAvatar::Still);
}

// --- Save to my library (D10) ------------------------------------------------------------------

#[tokio::test]
async fn buddy_library_save_to_library_imports_links_and_sends_its_pack() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.with(|fake| fake.next_id = Some(AVATAR.to_string()));
    let state = library_state(&root, &web).await;
    // A Buddy made only here: an idle PNG, a talk WebP, its own pack.
    std::fs::create_dir_all(root.join("default")).unwrap();
    std::fs::write(root.join("default/idle-0a0a0a0a.png"), png_bytes(10)).unwrap();
    let mut webp = Vec::new();
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        4,
        4,
        image::Rgba([20, 20, 20, 255]),
    ))
    .write_to(
        &mut std::io::Cursor::new(&mut webp),
        image::ImageFormat::WebP,
    )
    .unwrap();
    std::fs::write(root.join("default/talk-0b0b0b0b.webp"), &webp).unwrap();
    let files = own_pack(&root, PACK, 7);
    let mut mine = CohostPersona {
        name: "Mossback".to_string(),
        personality: "Slow and kind.".to_string(),
        source: CohostPersonaSource::Uploaded,
        ..CohostPersona::default()
    };
    mine.images.idle = Some("default/idle-0a0a0a0a.png".to_string());
    mine.images.talk = Some("default/talk-0b0b0b0b.webp".to_string());
    mine.avatar = alive(PACK);
    save(&state, mine).await;
    crate::cohost::set_cohost_settings(
        &state,
        CohostSettingsPatch {
            notes: Some("I stream on Fridays.".to_string()),
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(get(&state).await.active_avatar_id, None);

    save_to_library(&state).await.unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    settle(&state, |_| true).await;
    let body = web.body_of("POST /api/buddy/avatars/import").unwrap();
    assert_eq!(body["name"], "Mossback");
    assert_eq!(body["personality"], "Slow and kind.");
    assert_eq!(body["context"], "I stream on Fridays.");
    let names: Vec<&str> = body["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["idle.png", "talk.png"]);
    // The talk pose went up as a PNG.
    let talk = web.with(|fake| {
        fake.avatars[0]
            .uploaded
            .get(&CohostAvatarState::Talk)
            .cloned()
            .unwrap()
    });
    assert_eq!(image::guess_format(&talk).unwrap(), image::ImageFormat::Png);
    // Linked, chosen on the account, listed with its idle cached, and its
    // pack sent after it.
    let linked = persona(&state).await;
    assert_eq!(linked.library_avatar_id.as_deref(), Some(AVATAR));
    assert_eq!(linked.name, "Mossback");
    assert_eq!(
        web.body_of("PUT /api/buddy/profile"),
        Some(serde_json::json!({ "activeAvatarId": AVATAR }))
    );
    let library = get(&state).await;
    let entry = &library.mine.unwrap()[0];
    assert_eq!(entry.id, AVATAR);
    assert!(entry.poses.idle.is_some());
    assert_eq!(web.alive_of(AVATAR).unwrap().files, files);
    assert_eq!(load_library_sync(&state.database).pending_alive, None);
    let puts = web.s3().lock().unwrap().puts.clone();
    assert_eq!(puts.len(), 5);
    assert!(puts.iter().all(|(_, _, credential)| !credential));
}

#[tokio::test]
async fn buddy_library_save_to_library_refuses_a_buddy_already_in_one() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = library_state(&root, &web).await;
    // The untouched default is Videorc's own Buddy.
    let refused = save_to_library(&state).await.unwrap_err();
    assert_eq!(refused.code, COHOST_LIBRARY_INVALID);
    let mut linked = persona(&state).await;
    linked.library_avatar_id = Some(AVATAR.to_string());
    save(&state, linked).await;
    assert_eq!(
        save_to_library(&state).await.unwrap_err().code,
        COHOST_LIBRARY_INVALID
    );
    // A web without alive storage cannot take it.
    let mut own = persona(&state).await;
    own.library_avatar_id = None;
    own.source = CohostPersonaSource::Uploaded;
    own.images.idle = Some("default/idle.png".to_string());
    save(&state, own).await;
    state.buddy_library.cache().capability = Some(AiCapabilitiesBuddyLibrary {
        enabled: true,
        count: 0,
        limit: 30,
        alive: false,
    });
    assert_eq!(
        save_to_library(&state).await.unwrap_err().code,
        COHOST_LIBRARY_UNAVAILABLE
    );
    assert!(web.seen().is_empty());
    let _ = BEARER;
}

#[test]
fn buddy_library_web_packs_are_read_only_in_their_own_shape() {
    let files = pack_files(8);
    let pack = |pack_id: &str, url_avatar: &str| BuddyLibraryWebAlive {
        pack_id: pack_id.to_string(),
        version: 1,
        cell_size: 640,
        frames: 40,
        files: files
            .iter()
            .map(
                |(name, bytes)| crate::videorc_api::BuddyLibraryWebAliveFile {
                    name: name.clone(),
                    url: format!("/api/buddy/avatars/{url_avatar}/alive/{name}?v=0a1b2c3d"),
                    bytes: bytes.len() as u64,
                    sha256: sha256_hex(bytes),
                },
            )
            .collect(),
    };
    assert!(web_alive_ok(AVATAR, &pack(PACK, AVATAR)));
    // Another avatar's paths, a pack id that is no uuid, a bundled one.
    assert!(!web_alive_ok(AVATAR, &pack(PACK, OTHER_PACK)));
    assert!(!web_alive_ok(AVATAR, &pack("bundled:buddy", AVATAR)));
    assert!(!web_alive_ok(AVATAR, &pack(&PACK.to_uppercase(), AVATAR)));
    let mut absolute = pack(PACK, AVATAR);
    absolute.files[0].url = "https://elsewhere.example/manifest.json".to_string();
    assert!(!web_alive_ok(AVATAR, &absolute));
    let mut extra = pack(PACK, AVATAR);
    extra.files.push(extra.files[0].clone());
    assert!(!web_alive_ok(AVATAR, &extra));
    let mut tiny = pack(PACK, AVATAR);
    tiny.cell_size = 64;
    assert!(!web_alive_ok(AVATAR, &tiny));
    // An avatar whose pack this build cannot read is still listed, without it.
    let avatar: crate::videorc_api::BuddyLibraryWebAvatar =
        serde_json::from_value(serde_json::json!({
            "id": AVATAR,
            "name": "Grum",
            "createdAt": "2026-10-09T09:00:00.000Z",
            "updatedAt": "2026-10-09T09:00:00.000Z",
            "poses": { "idle": { "url": format!("/api/buddy/avatars/{AVATAR}/idle?v=0000000a") } },
            "alive": { "packId": PACK, "files": "nope" }
        }))
        .unwrap();
    assert_eq!(avatar.alive, None);
}
