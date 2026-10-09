//! The creator against a fake videorc-web (plan 168 S-F4): a full creation
//! from the reference to a saved pack, a resume after a simulated restart,
//! cancel leaving nothing behind, and every web error in plain words.
//! Sheets are synthetic, drawn in code by the builder's own test helpers.

use std::collections::VecDeque;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use tokio::sync::broadcast;

use super::*;
use crate::buddy_pet_build::tests::{CELL_H, Figure, TEST_CELL_SIZE, draw_figure, sheet_image};
use crate::cohost::get_cohost_settings;
use crate::protocol::ServerEvent;
use crate::storage::Database;

fn test_state() -> AppState {
    let (events, _) = broadcast::channel(512);
    AppState::new(
        "test-token".to_string(),
        1234,
        events,
        Database::open_in_memory_for_tests(),
    )
}

fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("videorc-buddy-create-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn png_bytes(image: &image::RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

fn reference_base64() -> String {
    let mut reference = image::RgbaImage::new(120, 260);
    draw_figure(&mut reference, &Figure::at(60, 240, [90, 90, 90]));
    base64::engine::general_purpose::STANDARD.encode(png_bytes(&reference))
}

fn sample_notes() -> serde_json::Value {
    serde_json::json!({
        "palette": ["stone grey", "moss green"],
        "materials": ["granite"],
        "proportions": "Short legs, a heavy round body and a small head.",
        "asymmetric": [{ "feature": "a crack over the eye", "side": "left" }]
    })
}

/// A canned failure the fake answers once.
#[derive(Clone)]
struct Canned {
    status: StatusCode,
    code: &'static str,
    retry_after: Option<&'static str>,
}

#[derive(Default)]
struct FakeWebState {
    /// Every request: route and body.
    seen: Vec<(String, serde_json::Value)>,
    builds_failure: Option<Canned>,
    identity_failures: VecDeque<Canned>,
    sheet_failures: VecDeque<Canned>,
    sheet_delay: Duration,
    sheets_remaining: u32,
    redos_remaining: u32,
}

#[derive(Clone)]
struct FakeWeb {
    inner: Arc<StdMutex<FakeWebState>>,
    client: VideorcApiClient,
    build_id: String,
}

impl FakeWeb {
    fn seen(&self, route: &str) -> Vec<serde_json::Value> {
        self.inner
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|(seen, _)| seen == route)
            .map(|(_, body)| body.clone())
            .collect()
    }

    fn with<T>(&self, change: impl FnOnce(&mut FakeWebState) -> T) -> T {
        change(&mut self.inner.lock().unwrap())
    }
}

fn failure_response(canned: &Canned) -> axum::response::Response {
    let mut response = (
        canned.status,
        axum::Json(serde_json::json!({
            "error": { "code": canned.code, "message": format!("server says {}", canned.code) }
        })),
    )
        .into_response();
    if let Some(after) = canned.retry_after {
        response.headers_mut().insert(
            axum::http::header::RETRY_AFTER,
            axum::http::HeaderValue::from_static(after),
        );
    }
    response
}

fn sheet_kind_of(body: &serde_json::Value) -> SheetKind {
    let row = body.get("row").cloned();
    match body["kind"].as_str().unwrap() {
        "pilot" => SheetKind::Pilot,
        "gaze" => SheetKind::Gaze {
            row: serde_json::from_value(row.unwrap()).unwrap(),
        },
        "reactions-a" => SheetKind::ReactionsA,
        "reactions-b" => SheetKind::ReactionsB,
        "extras" => SheetKind::Extras,
        other => panic!("unknown kind {other}"),
    }
}

async fn spawn_fake_web() -> FakeWeb {
    let inner = Arc::new(StdMutex::new(FakeWebState {
        sheets_remaining: 9,
        redos_remaining: 6,
        ..FakeWebState::default()
    }));
    let build_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let builds_state = inner.clone();
    let builds_id = build_id.clone();
    let identity_state = inner.clone();
    let sheet_state = inner.clone();
    let app = axum::Router::new()
        .route(
            "/api/ai/cohost/pet/builds",
            axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                let state = builds_state.clone();
                let build_id = builds_id.clone();
                async move {
                    let failure = {
                        let mut state = state.lock().unwrap();
                        state.seen.push(("builds".to_string(), body));
                        state.builds_failure.clone()
                    };
                    if let Some(canned) = failure {
                        return failure_response(&canned);
                    }
                    (
                        StatusCode::CREATED,
                        axum::Json(serde_json::json!({
                            "buildId": build_id,
                            "sheetsAllowed": 9,
                            "redosAllowed": 6,
                            "pilotsAllowed": 3,
                            "expiresAt": now_iso(Utc::now() + chrono::Duration::hours(24))
                        })),
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/api/ai/cohost/pet/identity",
            axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                let state = identity_state.clone();
                async move {
                    let failure = {
                        let mut state = state.lock().unwrap();
                        state.seen.push(("identity".to_string(), body));
                        state.identity_failures.pop_front()
                    };
                    if let Some(canned) = failure {
                        return failure_response(&canned);
                    }
                    axum::Json(serde_json::json!({ "notes": sample_notes() })).into_response()
                }
            }),
        )
        .route(
            "/api/ai/cohost/pet/sheet",
            axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                let state = sheet_state.clone();
                async move {
                    let (failure, delay) = {
                        let mut state = state.lock().unwrap();
                        state.seen.push(("sheet".to_string(), body.clone()));
                        (state.sheet_failures.pop_front(), state.sheet_delay)
                    };
                    tokio::time::sleep(delay).await;
                    if let Some(canned) = failure {
                        return failure_response(&canned);
                    }
                    let kind = sheet_kind_of(&body);
                    let image = sheet_image(kind, CELL_H, |_, _| {});
                    let (sheets, redos) = {
                        let mut state = state.lock().unwrap();
                        if kind != SheetKind::Pilot {
                            if body["redo"] == true {
                                state.redos_remaining -= 1;
                            } else {
                                state.sheets_remaining -= 1;
                            }
                        }
                        (state.sheets_remaining, state.redos_remaining)
                    };
                    axum::Json(serde_json::json!({
                        "pngBase64": base64::engine::general_purpose::STANDARD.encode(png_bytes(&image)),
                        "width": image.width(),
                        "height": image.height(),
                        "opaque": false,
                        "sheetsRemaining": sheets,
                        "redosRemaining": redos
                    }))
                    .into_response()
                }
            }),
        );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    FakeWeb {
        inner,
        client: VideorcApiClient::for_base_url(format!("http://{address}")),
        build_id,
    }
}

fn env_for(root: &Path, web: &FakeWeb, shared: Arc<CreatorShared>) -> CreatorEnv {
    CreatorEnv {
        root: Some(root.to_path_buf()),
        api: Some(web.client.clone()),
        token: Some("bearer-1".to_string()),
        premium: true,
        cell_size: TEST_CELL_SIZE,
        shared,
        build_hold: None,
    }
}

/// The next event named `name`, within a generous bound.
async fn next_event(
    events: &mut broadcast::Receiver<ServerEvent>,
    name: &str,
) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match events.recv().await {
                Ok(event) if event.event == name => return event.payload,
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(error) => panic!("event channel closed: {error}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {name} event"))
}

async fn current(state: &AppState, env: &CreatorEnv) -> BuddyPetCreation {
    status_in(state, env.clone())
        .await
        .unwrap()
        .creation
        .expect("a creation")
}

async fn read_reference(state: &AppState, env: &CreatorEnv, build_id: &str) {
    let mut events = state.events.subscribe();
    identity_in(
        state,
        env.clone(),
        CohostPetIdentityParams {
            build_id: build_id.to_string(),
            reference: BuddyPetReference::Upload {
                image_base64: reference_base64(),
            },
        },
    )
    .await
    .unwrap();
    let event = next_event(&mut events, COHOST_PET_IDENTITY_READ_EVENT).await;
    assert!(event.get("error").is_none(), "{event}");
}

fn params(build_id: &str, kind: SheetKind, redo: bool) -> CohostPetSheetGenerateParams {
    let (kind, row) = BuddyPetSheetKindName::of(kind);
    CohostPetSheetGenerateParams {
        build_id: build_id.to_string(),
        kind,
        row,
        redo,
        notes: None,
    }
}

async fn generate(
    state: &AppState,
    env: &CreatorEnv,
    build_id: &str,
    kind: SheetKind,
    redo: bool,
) -> serde_json::Value {
    let mut events = state.events.subscribe();
    let accepted = generate_sheet_in(state, env.clone(), params(build_id, kind, redo))
        .await
        .unwrap();
    assert_eq!(accepted.sheet.as_deref(), Some(kind.key()));
    let event = next_event(&mut events, COHOST_PET_SHEET_GENERATED_EVENT).await;
    assert_eq!(event["sheet"], kind.key());
    event
}

/// Run the builder and collect its events up to the end.
async fn run_build(
    state: &AppState,
    env: &CreatorEnv,
    build_id: &str,
) -> Vec<BuddyPetBuildProgressEvent> {
    let mut events = state.events.subscribe();
    build_in(
        state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: build_id.to_string(),
        },
    )
    .await
    .unwrap();
    let mut seen = Vec::new();
    loop {
        let payload = next_event(&mut events, COHOST_PET_BUILD_PROGRESS_EVENT).await;
        let event: BuddyPetBuildProgressEvent = serde_json::from_value(payload).unwrap();
        let end = matches!(
            event.step,
            BuddyPetBuildProgressStep::Done | BuddyPetBuildProgressStep::Failed
        );
        seen.push(event);
        if end {
            return seen;
        }
    }
}

fn creation_folder(root: &Path, build_id: &str) -> PathBuf {
    creation_dir(root, &CohostPersona::default().id, build_id)
}

fn pets_folder(root: &Path) -> PathBuf {
    root.join(CohostPersona::default().id).join("pets")
}

fn pet_entries(root: &Path) -> Vec<String> {
    std::fs::read_dir(pets_folder(root))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn buddy_pet_creation_runs_from_pilot_to_a_saved_pack() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(CreatorShared::default()));

    let started = start_in(&state, env.clone())
        .await
        .unwrap()
        .creation
        .unwrap();
    let build_id = started.build_id.clone();
    assert_eq!(build_id, web.build_id);
    assert_eq!(started.step, BuddyPetCreationStep::Reference);
    assert_eq!(
        (
            started.sheets_allowed,
            started.redos_allowed,
            started.pilots_allowed
        ),
        (9, 6, 3)
    );
    assert!(!started.expired);
    assert!(creation_folder(&root, &build_id).join(STATE_FILE).is_file());
    // A second start while one is open is refused, and nothing is sent.
    let again = start_in(&state, env.clone()).await.unwrap_err();
    assert_eq!(again.code, COHOST_PET_CREATION_ACTIVE);
    assert_eq!(web.seen("builds").len(), 1);

    // Reference → identity notes.
    read_reference(&state, &env, &build_id).await;
    let creation = current(&state, &env).await;
    assert_eq!(creation.step, BuddyPetCreationStep::Pilot);
    let reference = creation.reference.clone().unwrap();
    assert_eq!(reference.file, "sources/reference-v1.png");
    assert_eq!(
        creation.notes.as_ref().unwrap().asymmetric[0].side,
        BuddyPetSide::Left
    );
    let identity = web.seen("identity");
    assert_eq!(identity[0]["buildId"], build_id.as_str());
    let sent = base64::engine::general_purpose::STANDARD
        .decode(identity[0]["reference"].as_str().unwrap())
        .unwrap();
    assert_eq!(buddy_pet_build::sha256_hex(&sent), reference.sha256);

    // An atlas sheet before any pilot is refused.
    let early = generate_sheet_in(
        &state,
        env.clone(),
        params(&build_id, SheetKind::ReactionsA, false),
    )
    .await
    .unwrap_err();
    assert_eq!(early.code, COHOST_PET_NOT_READY);

    // Pilot (with corrected notes), then a second pilot.
    let mut events = state.events.subscribe();
    let mut corrected: BuddyPetIdentityNotes = serde_json::from_value(sample_notes()).unwrap();
    corrected.palette.push("  ember orange ".to_string());
    generate_sheet_in(
        &state,
        env.clone(),
        CohostPetSheetGenerateParams {
            notes: Some(corrected),
            ..params(&build_id, SheetKind::Pilot, false)
        },
    )
    .await
    .unwrap();
    let pilot = next_event(&mut events, COHOST_PET_SHEET_GENERATED_EVENT).await;
    assert_eq!(pilot["version"], 1);
    let pilot = generate(&state, &env, &build_id, SheetKind::Pilot, false).await;
    assert_eq!(pilot["version"], 2);
    let creation = current(&state, &env).await;
    assert_eq!(creation.step, BuddyPetCreationStep::Pilot);
    assert_eq!(creation.pilots_used, 2);
    assert_eq!(creation.pilot.as_ref().unwrap().version, 2);
    assert!(!creation.pilot_accepted);
    assert_eq!(
        creation.notes.as_ref().unwrap().palette,
        vec!["stone grey", "moss green", "ember orange"]
    );
    let sheets_sent = web.seen("sheet");
    assert_eq!(sheets_sent[0]["kind"], "pilot");
    assert!(sheets_sent[0].get("row").is_none());
    assert_eq!(sheets_sent[0]["redo"], false);
    assert_eq!(sheets_sent[0]["notes"]["palette"][2], "ember orange");

    // The eight atlas sheets; the first accepts the pilot.
    for kind in SheetKind::ATLAS_ORDER {
        let event = generate(&state, &env, &build_id, kind, false).await;
        assert_eq!(event["version"], 1, "{}", kind.key());
        assert!(event.get("error").is_none());
    }
    let creation = current(&state, &env).await;
    assert!(creation.pilot_accepted);
    assert_eq!(creation.step, BuddyPetCreationStep::Build);
    assert_eq!(creation.sheets.len(), 8);
    assert_eq!(creation.sheets[2].file, "sources/gaze-level-v1.png");
    assert_eq!(creation.sheets_remaining, 1);
    let sheets_sent = web.seen("sheet");
    let level = sheets_sent
        .iter()
        .find(|body| body["row"] == "level")
        .unwrap();
    assert_eq!(level["kind"], "gaze");
    assert_eq!(level["notes"]["proportions"], sample_notes()["proportions"]);
    // A pilot after acceptance, a second base sheet, a redo of nothing: refused.
    for (kind, redo, code) in [
        (SheetKind::Pilot, false, COHOST_PET_INVALID),
        (SheetKind::Extras, false, COHOST_PET_INVALID),
    ] {
        let refused = generate_sheet_in(&state, env.clone(), params(&build_id, kind, redo))
            .await
            .unwrap_err();
        assert_eq!(refused.code, code, "{}", kind.key());
    }

    // Build: the builder's steps, then done; the step is review.
    let progress = run_build(&state, &env, &build_id).await;
    let last = progress.last().unwrap();
    assert_eq!(last.step, BuddyPetBuildProgressStep::Done, "{progress:?}");
    assert!(
        progress
            .iter()
            .any(|event| event.step == BuddyPetBuildProgressStep::Cutting
                && event.sheet.as_deref() == Some("gaze-up2"))
    );
    assert!(progress.iter().all(|event| event.total > 0));
    let creation = current(&state, &env).await;
    assert_eq!(creation.step, BuddyPetCreationStep::Review);
    assert!(creation.build.as_ref().unwrap().fresh);
    let built = creation_folder(&root, &build_id).join(PACK_DIR);
    assert!(built.join("mascot.webp").is_file());
    assert!(!creation_folder(&root, &build_id).join(STAGING_DIR).exists());

    // Redo one row: a new version, the build is stale until it runs again.
    let redo = generate(&state, &env, &build_id, SheetKind::ReactionsA, true).await;
    assert_eq!(redo["version"], 2);
    assert_eq!(redo["redosRemaining"], 5);
    let creation = current(&state, &env).await;
    assert_eq!(creation.step, BuddyPetCreationStep::Build);
    assert!(!creation.build.as_ref().unwrap().fresh);
    assert_eq!(creation.sheets[5].file, "sources/reactions-a-v2.png");
    let stale = save_in(
        &state,
        env.clone(),
        CohostPetSaveParams {
            build_id: build_id.clone(),
            name: "Pebble".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, COHOST_PET_NOT_READY);
    assert_eq!(
        run_build(&state, &env, &build_id)
            .await
            .last()
            .unwrap()
            .step,
        BuddyPetBuildProgressStep::Done
    );

    // Save: named, moved into pets/, worn, the creation gone.
    let refused = save_in(
        &state,
        env.clone(),
        CohostPetSaveParams {
            build_id: build_id.clone(),
            name: "   ".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, COHOST_PET_INVALID);
    let saved = save_in(
        &state,
        env.clone(),
        CohostPetSaveParams {
            build_id: build_id.clone(),
            name: "  Pebble  ".to_string(),
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.pack.name, "Pebble");
    assert_eq!(saved.pack.gaze_count, 25);
    assert_eq!(saved.pack.reactions.len(), 15);
    assert!(saved.pack.has_talk);
    assert_eq!(saved.pack.source, buddy_pet::PetSource::VideorcCreator);
    let pack_id = saved.pack.pack_id.clone();
    assert_eq!(
        saved.settings.persona.avatar,
        BuddyAvatar::Alive {
            pack_id: pack_id.clone()
        }
    );
    assert_eq!(
        get_cohost_settings(&state).await.persona.avatar,
        saved.settings.persona.avatar
    );
    let pack = pets_folder(&root).join(&pack_id);
    for file in [
        "manifest.json",
        "mascot.webp",
        "buddy.json",
        "build-report.json",
        "provenance.json",
        "sources/reference-v1.png",
        "sources/pilot-v2.png",
        "sources/reactions-a-v2.png",
        "sources/gaze-down2-v1.png",
    ] {
        assert!(pack.join(file).is_file(), "{file}");
    }
    assert!(!pack.join("sources/reactions-a-v1.png").exists());
    assert!(!pack.join("sources/pilot-v1.png").exists());
    let loaded = buddy_pet::load_pack(
        &[root.clone(), root.join("bundled")],
        &CohostPersona::default().id,
        &pack_id,
    )
    .unwrap();
    assert_eq!(loaded.manifest.name, "Pebble");
    assert!(!creation_folder(&root, &build_id).exists());
    assert!(
        status_in(&state, env.clone())
            .await
            .unwrap()
            .creation
            .is_none()
    );
    // Every pack file passes the store's allow-list (main can read it back).
    for entry in walk(&pack) {
        // Compare with `/` on every platform: Windows paths stringify with `\`.
        let relative = entry
            .strip_prefix(&pack)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert!(
            relative == "sources"
                || relative.ends_with(".json")
                || relative.ends_with(".webp")
                || (relative.starts_with("sources/") && relative.ends_with(".png")),
            "{relative}"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        out.push(path.clone());
        if path.is_dir() {
            out.extend(walk(&path));
        }
    }
    out
}

#[tokio::test]
async fn buddy_pet_creation_resumes_after_a_restart() {
    let root = temp_root();
    let web = spawn_fake_web().await;
    let build_id = {
        // The first process: pilot accepted, three sheets made, then a crash
        // in the middle of a build (a staging folder left behind).
        let state = test_state();
        let env = env_for(&root, &web, Arc::new(CreatorShared::default()));
        let build_id = start_in(&state, env.clone())
            .await
            .unwrap()
            .creation
            .unwrap()
            .build_id;
        read_reference(&state, &env, &build_id).await;
        generate(&state, &env, &build_id, SheetKind::Pilot, false).await;
        for kind in &SheetKind::ATLAS_ORDER[..3] {
            generate(&state, &env, &build_id, *kind, false).await;
        }
        std::fs::create_dir_all(creation_folder(&root, &build_id).join(STAGING_DIR)).unwrap();
        build_id
    };

    // The second process: fresh state, fresh job slot, the same folder.
    let state = test_state();
    let env = env_for(&root, &web, Arc::new(CreatorShared::default()));
    let creation = current(&state, &env).await;
    assert_eq!(creation.build_id, build_id);
    assert_eq!(creation.step, BuddyPetCreationStep::Build);
    assert!(creation.pilot_accepted);
    assert!(creation.running.is_none());
    assert_eq!(creation.notes.as_ref().unwrap().materials, vec!["granite"]);
    assert_eq!(
        creation
            .sheets
            .iter()
            .map(|sheet| sheet.sheet.as_str())
            .collect::<Vec<_>>(),
        vec!["gaze-up2", "gaze-up1", "gaze-level"]
    );
    assert_eq!(creation.sheets_remaining, 6);
    let on_disk: serde_json::Value = serde_json::from_slice(
        &std::fs::read(creation_folder(&root, &build_id).join(STATE_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(on_disk["step"], "build");
    assert_eq!(on_disk["buildId"], build_id.as_str());
    assert!(on_disk["expiresAt"].is_string());
    assert_eq!(on_disk["accepted"]["pilot"], 1);
    assert_eq!(on_disk["accepted"]["gaze-level"], 1);

    // It carries on from there: the rest of the sheets, a build that clears
    // the stale staging folder, and a save.
    for kind in &SheetKind::ATLAS_ORDER[3..] {
        generate(&state, &env, &build_id, *kind, false).await;
    }
    assert_eq!(
        run_build(&state, &env, &build_id)
            .await
            .last()
            .unwrap()
            .step,
        BuddyPetBuildProgressStep::Done
    );
    let saved = save_in(
        &state,
        env.clone(),
        CohostPetSaveParams {
            build_id: build_id.clone(),
            name: "Resumed".to_string(),
        },
    )
    .await
    .unwrap();
    assert_eq!(pet_entries(&root), vec![saved.pack.pack_id]);
    let _ = std::fs::remove_dir_all(&root);
}

async fn full_sheets(state: &AppState, env: &CreatorEnv) -> String {
    let build_id = start_in(state, env.clone())
        .await
        .unwrap()
        .creation
        .unwrap()
        .build_id;
    read_reference(state, env, &build_id).await;
    generate(state, env, &build_id, SheetKind::Pilot, false).await;
    for kind in SheetKind::ATLAS_ORDER {
        generate(state, env, &build_id, kind, false).await;
    }
    build_id
}

#[tokio::test]
async fn buddy_pet_creation_cancel_leaves_no_partial_pack() {
    // Cancelled while a sheet is being generated: the late sheet is dropped
    // and nothing is recreated.
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(CreatorShared::default()));
    let build_id = start_in(&state, env.clone())
        .await
        .unwrap()
        .creation
        .unwrap()
        .build_id;
    read_reference(&state, &env, &build_id).await;
    web.with(|web| web.sheet_delay = Duration::from_millis(400));
    let mut events = state.events.subscribe();
    generate_sheet_in(
        &state,
        env.clone(),
        params(&build_id, SheetKind::Pilot, false),
    )
    .await
    .unwrap();
    assert_eq!(
        current(&state, &env).await.running,
        Some(BuddyPetCreationRunning {
            job: BuddyPetCreatorJob::Sheet,
            sheet: Some("pilot".to_string())
        })
    );
    // One job at a time.
    let busy = generate_sheet_in(
        &state,
        env.clone(),
        params(&build_id, SheetKind::Pilot, false),
    )
    .await
    .unwrap_err();
    assert_eq!(busy.code, COHOST_PET_BUSY);
    let cancelled = cancel_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: build_id.clone(),
        },
    )
    .await
    .unwrap();
    assert!(cancelled.creation.is_none());
    let late = next_event(&mut events, COHOST_PET_SHEET_GENERATED_EVENT).await;
    assert_eq!(late["error"]["code"], COHOST_PET_CANCELLED);
    assert!(!creation_folder(&root, &build_id).exists());
    assert!(pet_entries(&root).is_empty());
    let _ = std::fs::remove_dir_all(&root);

    // Cancelled while the pack is being built (held just before it writes):
    // the builder then writes its files, and they are removed with the
    // creation.
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let hold = Arc::new(std::sync::Barrier::new(2));
    let env = CreatorEnv {
        build_hold: Some(hold.clone()),
        ..env_for(&root, &web, Arc::new(CreatorShared::default()))
    };
    let build_id = full_sheets(&state, &env).await;
    let mut events = state.events.subscribe();
    build_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: build_id.clone(),
        },
    )
    .await
    .unwrap();
    loop {
        let event = next_event(&mut events, COHOST_PET_BUILD_PROGRESS_EVENT).await;
        if event["step"] == "writing" {
            break;
        }
    }
    cancel_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: build_id.clone(),
        },
    )
    .await
    .unwrap();
    assert!(!creation_folder(&root, &build_id).exists());
    tokio::task::spawn_blocking(move || {
        hold.wait();
    })
    .await
    .unwrap();
    loop {
        let event = next_event(&mut events, COHOST_PET_BUILD_PROGRESS_EVENT).await;
        if event["step"] == "done" || event["step"] == "failed" {
            assert_eq!(event["step"], "failed");
            assert_eq!(event["code"], COHOST_PET_CANCELLED);
            break;
        }
    }
    assert!(!creation_folder(&root, &build_id).exists());
    assert!(pet_entries(&root).is_empty());
    let _ = std::fs::remove_dir_all(&root);

    // Cancelled after the build, before the save: nothing reaches pets/,
    // and the save that follows finds no creation.
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(CreatorShared::default()));
    let build_id = full_sheets(&state, &env).await;
    run_build(&state, &env, &build_id).await;
    assert!(creation_folder(&root, &build_id).join(PACK_DIR).is_dir());
    cancel_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: build_id.clone(),
        },
    )
    .await
    .unwrap();
    let gone = save_in(
        &state,
        env.clone(),
        CohostPetSaveParams {
            build_id: build_id.clone(),
            name: "Ghost".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(gone.code, COHOST_PET_CREATION_NONE);
    assert!(!creation_folder(&root, &build_id).exists());
    assert!(pet_entries(&root).is_empty());
    assert!(
        std::fs::read_dir(creations_dir(&root, &CohostPersona::default().id))
            .unwrap()
            .next()
            .is_none()
    );
    let _ = std::fs::remove_dir_all(&root);
}

fn api_error(status: u16, code: &str, retry_after: Option<&str>) -> CohostApiError {
    crate::videorc_api::classify_cohost_failure(
        status,
        code,
        format!("server says {code}"),
        retry_after,
    )
}

#[test]
fn buddy_pet_web_errors_read_as_plain_sentences() {
    let now = Utc.with_ymd_and_hms(2026, 10, 9, 12, 0, 0).unwrap();
    // The allowance names the reset date: Retry-After first, else the 1st.
    let until_november = (Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap() - now)
        .num_seconds()
        .to_string();
    let used = pet_web_error(
        &api_error(429, "pet-allowance-used", Some(&until_november)),
        now,
    );
    assert_eq!(used.code, "pet-allowance-used");
    assert_eq!(
        used.message,
        "This month's Buddy creations are used up. More on November 1."
    );
    let december = Utc.with_ymd_and_hms(2026, 12, 20, 9, 0, 0).unwrap();
    assert_eq!(
        pet_web_error(&api_error(429, "pet-allowance-used", None), december).message,
        "This month's Buddy creations are used up. More on January 1."
    );
    let cases = [
        (503, "pet-image-model-unconfigured", BUDDY_PET_NOT_AVAILABLE),
        (
            503,
            "pet-vision-model-unconfigured",
            BUDDY_PET_NOT_AVAILABLE,
        ),
        (503, "pet-disabled", BUDDY_PET_NOT_AVAILABLE),
        (503, "cohost-disabled", BUDDY_PET_NOT_AVAILABLE),
        (503, "ai-gateway-not-configured", BUDDY_PET_NOT_AVAILABLE),
        (410, "pet-build-expired", BUDDY_PET_EXPIRED_MESSAGE),
        (
            404,
            "pet-build-not-found",
            "Videorc no longer knows this creation; start a new one.",
        ),
        (
            429,
            "pet-pilot-daily-limit",
            "Today's pilots are used up. Try again tomorrow.",
        ),
        (
            429,
            "pet-pilots-used",
            "This creation's pilots are used up. Keep the last one or start a new creation.",
        ),
        (
            429,
            "pet-sheets-used",
            "This creation's sheets are used up.",
        ),
        (429, "pet-redos-used", "This creation's redos are used up."),
        (
            429,
            "pet-identity-limit",
            "This creation has read its reference too many times. Start a new creation.",
        ),
        (
            504,
            "pet-sheet-timeout",
            "The model took too long. Try again.",
        ),
        (
            504,
            "pet-identity-timeout",
            "The model took too long. Try again.",
        ),
        (
            502,
            "pet-identity-invalid-output",
            "The model could not read the picture. Try again or use another picture.",
        ),
        (
            502,
            "pet-sheet-unreadable",
            "The model sent back a sheet that could not be read. Try again.",
        ),
        (
            502,
            "ai-gateway-error",
            "The image model failed. Try again.",
        ),
        (401, "unauthorized", "Sign in again to create a Buddy."),
        (
            403,
            "premium-required",
            "Creating a Buddy requires Videorc Premium.",
        ),
        (
            403,
            "ai-user-disabled",
            "Cloud AI is turned off for this account.",
        ),
    ];
    for (status, code, message) in cases {
        let mapped = pet_web_error(&api_error(status, code, None), now);
        assert_eq!(mapped.code, code);
        assert_eq!(mapped.message, message, "{code}");
    }
    // A code the desktop does not know keeps the server's own words.
    assert_eq!(
        pet_web_error(&api_error(400, "invalid-request", None), now).message,
        "server says invalid-request"
    );
    assert_eq!(
        pet_web_error(&CohostApiError::network("refused"), now).message,
        "Could not reach Videorc. Check your connection and try again."
    );
}

#[tokio::test]
async fn buddy_pet_web_errors_reach_the_caller_and_the_events() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(CreatorShared::default()));

    // The allowance is used: start answers with the reset date, no folder.
    web.with(|web| {
        web.builds_failure = Some(Canned {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "pet-allowance-used",
            retry_after: Some("86400"),
        })
    });
    let used = start_in(&state, env.clone()).await.unwrap_err();
    assert_eq!(used.code, "pet-allowance-used");
    assert!(
        used.message
            .starts_with("This month's Buddy creations are used up. More on ")
    );
    assert!(
        std::fs::read_dir(creations_dir(&root, &CohostPersona::default().id)).is_err(),
        "no creation folder"
    );
    web.with(|web| web.builds_failure = None);

    let build_id = start_in(&state, env.clone())
        .await
        .unwrap()
        .creation
        .unwrap()
        .build_id;
    // The vision model is not configured: the event says "Not available yet".
    web.with(|web| {
        web.identity_failures.push_back(Canned {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "pet-vision-model-unconfigured",
            retry_after: None,
        })
    });
    let mut events = state.events.subscribe();
    identity_in(
        &state,
        env.clone(),
        CohostPetIdentityParams {
            build_id: build_id.clone(),
            reference: BuddyPetReference::Upload {
                image_base64: reference_base64(),
            },
        },
    )
    .await
    .unwrap();
    let event = next_event(&mut events, COHOST_PET_IDENTITY_READ_EVENT).await;
    assert_eq!(event["error"]["message"], BUDDY_PET_NOT_AVAILABLE);
    let creation = current(&state, &env).await;
    assert_eq!(creation.step, BuddyPetCreationStep::Reference);
    assert!(
        creation.reference.is_some(),
        "the picture is kept for a retry"
    );

    read_reference(&state, &env, &build_id).await;
    // The pilot limit for today: the event names it; nothing is stored.
    web.with(|web| {
        web.sheet_failures.push_back(Canned {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "pet-pilot-daily-limit",
            retry_after: Some("3600"),
        })
    });
    let event = generate(&state, &env, &build_id, SheetKind::Pilot, false).await;
    assert_eq!(event["error"]["code"], "pet-pilot-daily-limit");
    assert_eq!(
        event["error"]["message"],
        "Today's pilots are used up. Try again tomorrow."
    );
    assert!(current(&state, &env).await.pilot.is_none());

    // The web says the session expired: the expired copy.
    web.with(|web| {
        web.sheet_failures.push_back(Canned {
            status: StatusCode::GONE,
            code: "pet-build-expired",
            retry_after: None,
        })
    });
    let event = generate(&state, &env, &build_id, SheetKind::Pilot, false).await;
    assert_eq!(event["error"]["message"], BUDDY_PET_EXPIRED_MESSAGE);

    // Past its expiry locally: generation is refused before anything is
    // sent, and the status says so.
    let dir = creation_folder(&root, &build_id);
    let mut on_disk = read_state(&dir).unwrap();
    on_disk.expires_at = now_iso(Utc::now() - chrono::Duration::minutes(1));
    write_state(&dir, &mut on_disk).unwrap();
    assert!(current(&state, &env).await.expired);
    let before = web.seen("sheet").len();
    let expired = generate_sheet_in(
        &state,
        env.clone(),
        params(&build_id, SheetKind::Pilot, false),
    )
    .await
    .unwrap_err();
    assert_eq!(expired.code, PET_BUILD_EXPIRED);
    assert_eq!(expired.message, BUDDY_PET_EXPIRED_MESSAGE);
    assert_eq!(web.seen("sheet").len(), before);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn buddy_pet_creator_refuses_what_it_cannot_do_before_sending() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(CreatorShared::default()));

    // Basic and signed-out accounts never reach the web.
    for (premium, token, code) in [
        (false, Some("t".to_string()), "premium-required"),
        (true, None, "signed-out"),
    ] {
        let refused = start_in(
            &state,
            CreatorEnv {
                premium,
                token,
                ..env.clone()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, code);
    }
    assert!(web.seen("builds").is_empty());
    let no_root = status_in(
        &state,
        CreatorEnv {
            root: None,
            ..env.clone()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(no_root.code, COHOST_PET_UNAVAILABLE);
    assert!(
        status_in(&state, env.clone())
            .await
            .unwrap()
            .creation
            .is_none()
    );

    let build_id = start_in(&state, env.clone())
        .await
        .unwrap()
        .creation
        .unwrap()
        .build_id;
    // Malformed sheet requests.
    for (kind, row, redo) in [
        (BuddyPetSheetKindName::Gaze, None, false),
        (BuddyPetSheetKindName::Extras, Some(GazeRow::Up1), false),
        (BuddyPetSheetKindName::Pilot, None, true),
    ] {
        let refused = generate_sheet_in(
            &state,
            env.clone(),
            CohostPetSheetGenerateParams {
                build_id: build_id.clone(),
                kind,
                row,
                redo,
                notes: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, COHOST_PET_INVALID);
    }
    // Before the reference is read nothing generates.
    let early = generate_sheet_in(
        &state,
        env.clone(),
        params(&build_id, SheetKind::Pilot, false),
    )
    .await
    .unwrap_err();
    assert_eq!(early.code, COHOST_PET_NOT_READY);
    // An opaque or JPEG reference is refused in the event.
    let mut events = state.events.subscribe();
    let opaque = image::RgbaImage::from_pixel(64, 64, image::Rgba([10, 10, 10, 255]));
    identity_in(
        &state,
        env.clone(),
        CohostPetIdentityParams {
            build_id: build_id.clone(),
            reference: BuddyPetReference::Upload {
                image_base64: base64::engine::general_purpose::STANDARD.encode(png_bytes(&opaque)),
            },
        },
    )
    .await
    .unwrap();
    let event = next_event(&mut events, COHOST_PET_IDENTITY_READ_EVENT).await;
    assert_eq!(event["error"]["code"], COHOST_PET_REFERENCE_INVALID);
    assert!(web.seen("identity").is_empty(), "nothing was sent");
    // Notes ride with the pilot only; a build or save before the sheets
    // exist is refused; an unknown build id is not a creation.
    read_reference(&state, &env, &build_id).await;
    let refused = generate_sheet_in(
        &state,
        env.clone(),
        CohostPetSheetGenerateParams {
            notes: Some(serde_json::from_value(sample_notes()).unwrap()),
            ..params(&build_id, SheetKind::Extras, false)
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, COHOST_PET_INVALID);
    let refused = build_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: build_id.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, COHOST_PET_NOT_READY);
    let refused = save_in(
        &state,
        env.clone(),
        CohostPetSaveParams {
            build_id: build_id.clone(),
            name: "Early".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, COHOST_PET_NOT_READY);
    let unknown = build_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: uuid::Uuid::new_v4().hyphenated().to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(unknown.code, COHOST_PET_CREATION_NONE);
    let traversal = build_in(
        &state,
        env.clone(),
        CohostPetBuildIdParams {
            build_id: "../pets".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(traversal.code, COHOST_PET_INVALID);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn buddy_pet_notes_are_trimmed_and_bounded() {
    let notes: BuddyPetIdentityNotes = serde_json::from_value(serde_json::json!({
        "palette": [" grey ", "", "green"],
        "materials": [],
        "proportions": "  stout  ",
        "asymmetric": [{ "feature": " ", "side": "right" }, { "feature": "horn", "side": "right" }]
    }))
    .unwrap();
    let shaped = shape_notes(notes.clone()).unwrap();
    assert_eq!(shaped.palette, vec!["grey", "green"]);
    assert_eq!(shaped.proportions, "stout");
    assert_eq!(shaped.asymmetric.len(), 1);
    let mut long = notes.clone();
    long.palette = vec!["x".repeat(61)];
    assert_eq!(shape_notes(long).unwrap_err().code, COHOST_PET_INVALID);
    let mut many = notes.clone();
    many.materials = (0..9).map(|n| format!("m{n}")).collect();
    assert!(shape_notes(many).is_err());
    let mut blank = notes;
    blank.proportions = "  ".to_string();
    assert!(shape_notes(blank).is_err());
    assert_eq!(shape_pack_name(" Pip ").unwrap(), "Pip");
    assert!(shape_pack_name(&"p".repeat(65)).is_err());
}

#[test]
fn buddy_pet_reference_needs_transparency_and_is_scaled_to_the_web_bounds() {
    let mut large = image::RgbaImage::new(3000, 2000);
    for y in 500..1500 {
        for x in 1000..2000 {
            large.put_pixel(x, y, image::Rgba([200, 100, 50, 255]));
        }
    }
    let png = reference_png(large).unwrap();
    let decoded = image::load_from_memory(&png).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (1536, 1024));
    assert!(png.len() <= REFERENCE_PNG_MAX_BYTES);
    let opaque = image::RgbaImage::from_pixel(10, 10, image::Rgba([1, 2, 3, 255]));
    assert_eq!(
        reference_png(opaque).unwrap_err().code,
        COHOST_PET_REFERENCE_INVALID
    );
    assert!(
        reference_png(image::RgbaImage::new(10, 10)).is_err(),
        "empty"
    );
    // The bundled default idle works as a reference as is.
    let persona = CohostPersona::default();
    let idle = persona_idle(Path::new("/nonexistent"), &persona).unwrap();
    assert!(reference_png(idle).is_ok());
    let jpeg = base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    assert!(
        decode_upload(&jpeg)
            .unwrap_err()
            .message
            .starts_with("A JPEG has no transparency")
    );
}

fn high_risk_fixture(pointer: &str) -> serde_json::Value {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol-fixtures/high-risk-contracts.json"
    ))
    .expect("shared high-risk protocol fixture must be valid JSON");
    fixture
        .pointer(pointer)
        .unwrap_or_else(|| panic!("shared protocol fixture is missing {pointer}"))
        .clone()
}

fn round_trips<T: serde::de::DeserializeOwned + Serialize>(pointer: &str) {
    let wire = high_risk_fixture(pointer);
    let value: T =
        serde_json::from_value(wire.clone()).unwrap_or_else(|error| panic!("{pointer}: {error}"));
    assert_eq!(serde_json::to_value(value).unwrap(), wire, "{pointer}");
}

/// The creator's RPC and event shapes round-trip exactly as the TypeScript
/// contract validates them (plan 168, Phase F).
#[test]
fn shared_high_risk_contract_fixture_matches_buddy_pet_creator_dtos() {
    round_trips::<BuddyPetCreationStatus>("/buddyPetCreator/status");
    round_trips::<BuddyPetCreationStatus>("/buddyPetCreator/statusNone");
    round_trips::<CohostPetIdentityParams>("/buddyPetCreator/identityParams");
    round_trips::<CohostPetIdentityParams>("/buddyPetCreator/identityUploadParams");
    round_trips::<CohostPetSheetGenerateParams>("/buddyPetCreator/sheetParams");
    round_trips::<CohostPetSheetGenerateParams>("/buddyPetCreator/pilotParams");
    round_trips::<CohostPetBuildIdParams>("/buddyPetCreator/buildParams");
    round_trips::<CohostPetSaveParams>("/buddyPetCreator/saveParams");
    round_trips::<BuddyPetCreationAccepted>("/buddyPetCreator/accepted");
    round_trips::<BuddyPetIdentityReadEvent>("/buddyPetCreator/identityRead");
    round_trips::<BuddyPetSheetGeneratedEvent>("/buddyPetCreator/sheetGenerated");
    round_trips::<BuddyPetSheetGeneratedEvent>("/buddyPetCreator/sheetFailed");
    round_trips::<BuddyPetBuildProgressEvent>("/buddyPetCreator/buildProgress");
    round_trips::<BuddyPetBuildProgressEvent>("/buddyPetCreator/buildFailed");
    round_trips::<BuddyPetSummary>("/buddyPetCreator/savedPack");
    assert!(
        serde_json::from_value::<CohostPetBuildIdParams>(
            serde_json::json!({ "buildId": "x", "extra": 1 })
        )
        .is_err()
    );
}
