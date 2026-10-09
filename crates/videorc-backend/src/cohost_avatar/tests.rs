//! The Golem look against a fake videorc-web (plan 169 Phase B): a set
//! lands as a draft and Keep moves it; Discard leaves nothing; Redo replaces
//! one state; a second create replaces the draft; a failed idle leaves no
//! draft; a restart finds the draft again; every web error in plain words.

use std::collections::VecDeque;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use tokio::sync::broadcast;

use super::*;
use crate::cohost::{CohostErrorDetail, get_cohost_settings};
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
    let root = std::env::temp_dir().join(format!("videorc-golem-look-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A small transparent PNG with one opaque pixel in `shade`, so each
/// state's picture is told apart by its bytes.
fn png_bytes(shade: u8) -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 0]));
    image.put_pixel(1, 1, image::Rgba([shade, shade, shade, 255]));
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    png
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn shade_of(state: CohostAvatarState) -> u8 {
    match state {
        CohostAvatarState::Idle => 10,
        CohostAvatarState::Talk => 20,
        CohostAvatarState::Laugh => 30,
        CohostAvatarState::Think => 40,
    }
}

/// What the fake answers to one call.
#[derive(Clone)]
enum Canned {
    /// 200 with these states drawn (shade offset by `round`), the rest failed.
    Set {
        round: u8,
        made: Vec<CohostAvatarState>,
    },
    Error {
        status: StatusCode,
        code: &'static str,
        retry_after: Option<&'static str>,
    },
}

#[derive(Default)]
struct FakeWebState {
    seen: Vec<serde_json::Value>,
    queue: VecDeque<Canned>,
    delay: Duration,
}

#[derive(Clone)]
struct FakeWeb {
    inner: Arc<StdMutex<FakeWebState>>,
    client: VideorcApiClient,
}

impl FakeWeb {
    fn answer(&self, canned: Canned) {
        self.inner.lock().unwrap().queue.push_back(canned);
    }

    fn seen(&self) -> Vec<serde_json::Value> {
        self.inner.lock().unwrap().seen.clone()
    }
}

fn set_response(round: u8, made: &[CohostAvatarState], redo: Option<&str>) -> serde_json::Value {
    let mut images = serde_json::Map::new();
    let mut failed = serde_json::Map::new();
    let wanted: Vec<CohostAvatarState> = match redo {
        Some(state) => vec![serde_json::from_value(serde_json::json!(state)).unwrap()],
        None => ALL_STATES.to_vec(),
    };
    for state in wanted {
        if made.contains(&state) {
            images.insert(
                state.as_str().to_string(),
                serde_json::json!({
                    "pngBase64": b64(&png_bytes(shade_of(state) + round)),
                    "opaque": false
                }),
            );
        } else {
            failed.insert(
                state.as_str().to_string(),
                serde_json::json!({
                    "code": "ai-gateway-error",
                    "message": format!("The model could not draw {}.", state.as_str())
                }),
            );
        }
    }
    serde_json::json!({ "images": images, "failed": failed })
}

async fn spawn_fake_web() -> FakeWeb {
    let inner = Arc::new(StdMutex::new(FakeWebState::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let route_state = inner.clone();
    let app = axum::Router::new().route(
        "/api/ai/cohost/avatar/set",
        axum::routing::post(
            move |headers: axum::http::HeaderMap,
                  axum::Json(body): axum::Json<serde_json::Value>| {
                let state = route_state.clone();
                async move {
                    assert_eq!(
                        headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok()),
                        Some("Bearer bearer-1")
                    );
                    let (canned, delay) = {
                        let mut state = state.lock().unwrap();
                        state.seen.push(body.clone());
                        (state.queue.pop_front(), state.delay)
                    };
                    tokio::time::sleep(delay).await;
                    match canned.expect("the test queued an answer") {
                        Canned::Set { round, made } => axum::Json(set_response(
                            round,
                            &made,
                            body.get("redo").and_then(|value| value.as_str()),
                        ))
                        .into_response(),
                        Canned::Error {
                            status,
                            code,
                            retry_after,
                        } => {
                            let mut response = (
                                status,
                                axum::Json(serde_json::json!({
                                    "error": { "code": code, "message": format!("server says {code}") }
                                })),
                            )
                                .into_response();
                            if let Some(after) = retry_after {
                                response.headers_mut().insert(
                                    axum::http::header::RETRY_AFTER,
                                    axum::http::HeaderValue::from_static(after),
                                );
                            }
                            response
                        }
                    }
                }
            },
        ),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    FakeWeb {
        inner,
        client: VideorcApiClient::for_base_url(format!("http://{address}")),
    }
}

fn env_for(root: &Path, web: &FakeWeb, shared: Arc<AvatarShared>) -> AvatarEnv {
    AvatarEnv {
        root: Some(root.to_path_buf()),
        api: Some(web.client.clone()),
        token: Some("bearer-1".to_string()),
        premium: true,
        library: false,
        shared,
    }
}

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

/// Every progress event up to (and including) the run's end: the draft
/// event, or idle `failed` for a create, or the redone state's end.
async fn run_until_end(
    events: &mut broadcast::Receiver<ServerEvent>,
    redo: Option<CohostAvatarState>,
) -> (Vec<CohostAvatarProgressEvent>, Option<CohostAvatarDraft>) {
    let mut progress = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(error) => panic!("event channel closed: {error}"),
            };
            if event.event == COHOST_AVATAR_DRAFT_EVENT {
                return (
                    progress,
                    Some(serde_json::from_value(event.payload).unwrap()),
                );
            }
            if event.event != COHOST_AVATAR_PROGRESS_EVENT {
                continue;
            }
            let step: CohostAvatarProgressEvent = serde_json::from_value(event.payload).unwrap();
            let ended_without_draft = step.phase == CohostAvatarPhase::Failed
                && redo.is_none()
                && step.state == CohostAvatarState::Idle;
            progress.push(step);
            if ended_without_draft {
                return (progress, None);
            }
        }
    })
    .await
    .expect("the run ended")
}

async fn create_and_wait(
    state: &AppState,
    env: &AvatarEnv,
    params: CohostAvatarCreateParams,
) -> (
    String,
    Vec<CohostAvatarProgressEvent>,
    Option<CohostAvatarDraft>,
) {
    let mut events = state.events.subscribe();
    let accepted = create_in(state, env.clone(), params).await.unwrap();
    let (progress, draft) = run_until_end(&mut events, None).await;
    wait_idle(env).await;
    (accepted.request_id, progress, draft)
}

/// The job slot frees once the task finished.
async fn wait_idle(env: &AvatarEnv) {
    for _ in 0..200 {
        if env.shared.running().is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the look job never finished");
}

fn describe(text: &str) -> CohostAvatarCreateParams {
    CohostAvatarCreateParams {
        description: Some(text.to_string()),
        ..CohostAvatarCreateParams::default()
    }
}

fn persona_folder(root: &Path) -> PathBuf {
    root.join(CohostPersona::default().id)
}

fn draft_entries(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(persona_folder(root).join(DRAFTS_DIR))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn golem_look_create_lands_as_a_draft_and_keep_makes_it_the_look() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    // The current look: an uploaded WebP for talk that the kept set replaces.
    std::fs::create_dir_all(persona_folder(&root)).unwrap();
    std::fs::write(persona_folder(&root).join("talk.webp"), b"old").unwrap();
    let before = get_cohost_settings(&state).await.persona;

    web.answer(Canned::Set {
        round: 0,
        made: ALL_STATES.to_vec(),
    });
    let (request_id, progress, draft) = create_and_wait(
        &state,
        &env,
        CohostAvatarCreateParams {
            description: Some("  a grumpy stone golem  ".to_string()),
            inspiration_base64: Some(b64(&png_bytes(99))),
            ..CohostAvatarCreateParams::default()
        },
    )
    .await;
    // The web got one create: trimmed description, the picture, no redo.
    let seen = web.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["description"], "a grumpy stone golem");
    assert_eq!(seen[0]["inspiration"], b64(&png_bytes(99)));
    assert!(seen[0].get("redo").is_none() && seen[0].get("base").is_none());
    // Idle working first, then every state done with its draft path.
    assert_eq!(progress[0].state, CohostAvatarState::Idle);
    assert_eq!(progress[0].phase, CohostAvatarPhase::Working);
    let done: Vec<_> = progress[1..]
        .iter()
        .map(|step| (step.state, step.phase, step.path.clone()))
        .collect();
    assert_eq!(
        done,
        ALL_STATES
            .iter()
            .map(|state| (
                *state,
                CohostAvatarPhase::Done,
                Some(draft_relative_path("default", &request_id, *state))
            ))
            .collect::<Vec<_>>()
    );
    let draft = draft.unwrap();
    assert_eq!(draft.request_id, request_id);
    assert!(draft.failed.is_empty());
    assert_eq!(
        draft.images.laugh.as_deref(),
        Some(format!("default/drafts/{request_id}/laugh.png").as_str())
    );
    // Nothing about the current look changed yet (STOP condition 1).
    assert_eq!(get_cohost_settings(&state).await.persona, before);
    assert_eq!(
        std::fs::read(persona_folder(&root).join("talk.webp")).unwrap(),
        b"old"
    );
    assert!(!persona_folder(&root).join("idle.png").exists());

    let status = draft_status_in(&state, env.clone()).await.unwrap();
    assert_eq!(status.draft.as_ref(), Some(&draft));
    assert!(status.running.is_none());

    let settings = keep_in(
        &state,
        env.clone(),
        CohostAvatarRequestIdParams {
            request_id: request_id.clone(),
        },
    )
    .await
    .unwrap();
    let persona = settings.persona;
    let tag = &request_id[..8];
    assert_eq!(persona.source, CohostPersonaSource::Generated);
    assert_eq!(
        persona.images.idle.as_deref(),
        Some(format!("default/idle-{tag}.png").as_str())
    );
    assert_eq!(
        persona.images.think.as_deref(),
        Some(format!("default/think-{tag}.png").as_str())
    );
    assert_eq!(get_cohost_settings(&state).await.persona, persona);
    for avatar_state in ALL_STATES {
        assert_eq!(
            std::fs::read(
                persona_folder(&root).join(format!("{}-{tag}.png", avatar_state.as_str()))
            )
            .unwrap(),
            png_bytes(shade_of(avatar_state)),
            "{}",
            avatar_state.as_str()
        );
    }
    // The upload it replaced is gone; the folder holds the look and nothing else.
    assert!(!persona_folder(&root).join("talk.webp").exists());
    let mut files: Vec<String> = std::fs::read_dir(persona_folder(&root))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    files.sort();
    assert_eq!(
        files,
        ["idle", "laugh", "talk", "think"]
            .iter()
            .map(|name| format!("{name}-{tag}.png"))
            .collect::<Vec<_>>()
    );
    assert!(!persona_folder(&root).join(DRAFTS_DIR).exists());
    assert!(
        draft_status_in(&state, env.clone())
            .await
            .unwrap()
            .draft
            .is_none()
    );
    // A kept draft is gone: keeping it again says so.
    let again = keep_in(
        &state,
        env.clone(),
        CohostAvatarRequestIdParams { request_id },
    )
    .await
    .unwrap_err();
    assert_eq!(again.code, COHOST_AVATAR_DRAFT_NONE);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_a_second_keep_gets_new_paths_and_drops_the_first_look() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    let mut kept = Vec::new();
    for round in [0, 1] {
        web.answer(Canned::Set {
            round,
            made: ALL_STATES.to_vec(),
        });
        let (request_id, _, _) = create_and_wait(&state, &env, describe("a golem")).await;
        let settings = keep_in(
            &state,
            env.clone(),
            CohostAvatarRequestIdParams { request_id },
        )
        .await
        .unwrap();
        kept.push(settings.persona.images.idle.unwrap());
    }
    // A new path each time, so no surface shows a cached picture of the old one.
    assert_ne!(kept[0], kept[1]);
    assert!(!root.join(&kept[0]).exists());
    assert_eq!(
        std::fs::read(root.join(&kept[1])).unwrap(),
        png_bytes(shade_of(CohostAvatarState::Idle) + 1)
    );
    assert!(is_state_picture("idle.webp", CohostAvatarState::Idle));
    assert!(is_state_picture(
        "talk-0a1b2c3d.png",
        CohostAvatarState::Talk
    ));
    for other in [
        "idle-0A1B2C3D.png",
        "idle-0a1b.png",
        "idler.png",
        "idle.gif",
        "talk.png",
    ] {
        assert!(!is_state_picture(other, CohostAvatarState::Idle), "{other}");
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_discard_leaves_nothing_behind() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    web.answer(Canned::Set {
        round: 0,
        made: ALL_STATES.to_vec(),
    });
    let before = get_cohost_settings(&state).await.persona;
    let (request_id, _, draft) = create_and_wait(&state, &env, describe("a golem")).await;
    assert!(draft.is_some());
    let status = discard_in(
        &state,
        env.clone(),
        CohostAvatarRequestIdParams {
            request_id: request_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(status, CohostAvatarDraftStatus::default());
    assert!(!persona_folder(&root).join(DRAFTS_DIR).exists());
    assert_eq!(get_cohost_settings(&state).await.persona, before);
    // Discarding again is a no-op, and a malformed id is refused.
    discard_in(
        &state,
        env.clone(),
        CohostAvatarRequestIdParams { request_id },
    )
    .await
    .unwrap();
    let bad = discard_in(
        &state,
        env.clone(),
        CohostAvatarRequestIdParams {
            request_id: "../default".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(bad.code, COHOST_AVATAR_INVALID);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_redo_replaces_one_draft_state_from_the_draft_idle() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    // Think failed in the set: the draft says why, and Redo can make it.
    web.answer(Canned::Set {
        round: 0,
        made: vec![
            CohostAvatarState::Idle,
            CohostAvatarState::Talk,
            CohostAvatarState::Laugh,
        ],
    });
    let (request_id, progress, draft) = create_and_wait(&state, &env, describe("a golem")).await;
    let think = progress
        .iter()
        .find(|step| step.state == CohostAvatarState::Think)
        .unwrap();
    assert_eq!(think.phase, CohostAvatarPhase::Failed);
    assert_eq!(
        think.error.as_ref().unwrap().message,
        "The model could not draw think."
    );
    let draft = draft.unwrap();
    assert!(draft.images.think.is_none());
    assert_eq!(
        draft.failed[&CohostAvatarState::Think].code,
        "ai-gateway-error"
    );

    // Idle has no Redo; neither has a draft that is not there.
    let idle = redo_in(
        &state,
        env.clone(),
        CohostAvatarRedoParams {
            request_id: request_id.clone(),
            state: CohostAvatarState::Idle,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(idle.code, COHOST_AVATAR_INVALID);
    let missing = redo_in(
        &state,
        env.clone(),
        CohostAvatarRedoParams {
            request_id: uuid::Uuid::new_v4().hyphenated().to_string(),
            state: CohostAvatarState::Talk,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, COHOST_AVATAR_DRAFT_NONE);
    assert_eq!(web.seen().len(), 1);

    for (round, avatar_state) in [(5, CohostAvatarState::Think), (6, CohostAvatarState::Laugh)] {
        web.answer(Canned::Set {
            round,
            made: vec![avatar_state],
        });
        let mut events = state.events.subscribe();
        let accepted = redo_in(
            &state,
            env.clone(),
            CohostAvatarRedoParams {
                request_id: request_id.clone(),
                state: avatar_state,
            },
        )
        .await
        .unwrap();
        assert_eq!(accepted.request_id, request_id);
        let (steps, redone) = run_until_end(&mut events, Some(avatar_state)).await;
        wait_idle(&env).await;
        assert_eq!(
            steps
                .iter()
                .map(|step| (step.state, step.phase))
                .collect::<Vec<_>>(),
            vec![
                (avatar_state, CohostAvatarPhase::Working),
                (avatar_state, CohostAvatarPhase::Done)
            ]
        );
        let redone = redone.unwrap();
        assert!(redone.failed.is_empty(), "{:?}", redone.failed);
        let file =
            draft_dir(&root, "default", &request_id).join(format!("{}.png", avatar_state.as_str()));
        assert_eq!(
            std::fs::read(file).unwrap(),
            png_bytes(shade_of(avatar_state) + round)
        );
        // The redo sent the draft's idle as its base and nothing else.
        let body = web.seen().last().unwrap().clone();
        assert_eq!(body["redo"], avatar_state.as_str());
        assert_eq!(
            body["base"],
            b64(&png_bytes(shade_of(CohostAvatarState::Idle)))
        );
        assert!(body.get("description").is_none() && body.get("inspiration").is_none());
    }

    // A failed redo keeps the picture the state had.
    web.answer(Canned::Error {
        status: StatusCode::BAD_GATEWAY,
        code: "ai-gateway-error",
        retry_after: None,
    });
    let mut events = state.events.subscribe();
    redo_in(
        &state,
        env.clone(),
        CohostAvatarRedoParams {
            request_id: request_id.clone(),
            state: CohostAvatarState::Talk,
        },
    )
    .await
    .unwrap();
    let (steps, after) = run_until_end(&mut events, Some(CohostAvatarState::Talk)).await;
    wait_idle(&env).await;
    assert_eq!(steps.last().unwrap().phase, CohostAvatarPhase::Failed);
    assert!(after.unwrap().images.talk.is_some());
    assert_eq!(
        std::fs::read(draft_dir(&root, "default", &request_id).join("talk.png")).unwrap(),
        png_bytes(shade_of(CohostAvatarState::Talk))
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_second_create_replaces_the_draft_and_a_failed_one_keeps_it() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    web.answer(Canned::Set {
        round: 0,
        made: ALL_STATES.to_vec(),
    });
    let (first, _, _) = create_and_wait(&state, &env, describe("a golem")).await;
    web.answer(Canned::Set {
        round: 1,
        made: ALL_STATES.to_vec(),
    });
    let (second, _, draft) = create_and_wait(&state, &env, describe("a goblin")).await;
    assert_ne!(first, second);
    assert_eq!(draft.unwrap().request_id, second);
    assert_eq!(draft_entries(&root), vec![second.clone()]);
    assert_eq!(
        std::fs::read(draft_dir(&root, "default", &second).join("idle.png")).unwrap(),
        png_bytes(shade_of(CohostAvatarState::Idle) + 1)
    );
    // The replaced draft cannot be kept.
    let stale = keep_in(
        &state,
        env.clone(),
        CohostAvatarRequestIdParams { request_id: first },
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, COHOST_AVATAR_DRAFT_NONE);

    // A create that fails (here, idle) writes nothing: the draft stays.
    web.answer(Canned::Error {
        status: StatusCode::BAD_GATEWAY,
        code: "ai-gateway-error",
        retry_after: None,
    });
    let (_, progress, none) = create_and_wait(&state, &env, describe("a troll")).await;
    assert!(none.is_none());
    assert_eq!(
        progress
            .iter()
            .map(|step| (step.state, step.phase))
            .collect::<Vec<_>>(),
        vec![
            (CohostAvatarState::Idle, CohostAvatarPhase::Working),
            (CohostAvatarState::Idle, CohostAvatarPhase::Failed)
        ]
    );
    assert_eq!(draft_entries(&root), vec![second.clone()]);
    let status = draft_status_in(&state, env.clone()).await.unwrap();
    assert_eq!(status.draft.unwrap().request_id, second);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_failed_idle_leaves_no_draft() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    // The web failed the call (its idle failed); or it answered without an
    // idle at all. Neither leaves a folder.
    web.answer(Canned::Error {
        status: StatusCode::BAD_GATEWAY,
        code: "ai-gateway-error",
        retry_after: None,
    });
    let (_, progress, draft) = create_and_wait(&state, &env, describe("a golem")).await;
    assert!(draft.is_none());
    assert_eq!(
        progress.last().unwrap().error.as_ref().unwrap().message,
        "server says ai-gateway-error"
    );
    web.answer(Canned::Set {
        round: 0,
        made: vec![CohostAvatarState::Talk],
    });
    let (_, progress, draft) = create_and_wait(&state, &env, describe("a golem")).await;
    assert!(draft.is_none());
    assert_eq!(
        progress.last().unwrap().error.as_ref().unwrap().message,
        "The model could not draw idle."
    );
    assert!(draft_entries(&root).is_empty());
    assert!(
        draft_status_in(&state, env.clone())
            .await
            .unwrap()
            .draft
            .is_none()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_restart_offers_the_draft_on_disk_again() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    web.answer(Canned::Set {
        round: 0,
        made: vec![
            CohostAvatarState::Idle,
            CohostAvatarState::Talk,
            CohostAvatarState::Think,
        ],
    });
    let (request_id, _, draft) = create_and_wait(&state, &env, describe("a golem")).await;
    let draft = draft.unwrap();

    // A new process: fresh job state, a fresh app state, the same disk. A
    // stray staging folder from a crash is ignored.
    std::fs::create_dir_all(
        persona_folder(&root)
            .join(DRAFTS_DIR)
            .join(format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4())),
    )
    .unwrap();
    let restarted = test_state();
    let fresh = env_for(&root, &web, Arc::new(AvatarShared::default()));
    let status = draft_status_in(&restarted, fresh.clone()).await.unwrap();
    assert_eq!(status.draft.as_ref(), Some(&draft));
    assert_eq!(
        status.draft.unwrap().failed[&CohostAvatarState::Laugh].message,
        "The model could not draw laugh."
    );
    // It can still be kept: laugh falls back to the new idle.
    let settings = keep_in(
        &restarted,
        fresh,
        CohostAvatarRequestIdParams { request_id },
    )
    .await
    .unwrap();
    assert!(settings.persona.images.laugh.is_none());
    assert_eq!(
        settings.persona.images.think.as_deref(),
        Some(format!("default/think-{}.png", &draft.request_id[..8]).as_str())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_refuses_before_sending_anything() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    let refused = |params: CohostAvatarCreateParams, env: AvatarEnv| {
        let state = state.clone();
        async move { create_in(&state, env, params).await.unwrap_err() }
    };
    assert_eq!(
        refused(CohostAvatarCreateParams::default(), env.clone())
            .await
            .message,
        "Describe your Golem or add a picture first."
    );
    assert_eq!(
        refused(describe("   "), env.clone()).await.code,
        COHOST_AVATAR_INVALID
    );
    assert_eq!(
        refused(describe(&"p".repeat(601)), env.clone())
            .await
            .message,
        "The description is at most 600 characters."
    );
    let gif = CohostAvatarCreateParams {
        inspiration_base64: Some(b64(b"GIF89a\x01\x00\x01\x00")),
        ..CohostAvatarCreateParams::default()
    };
    assert_eq!(
        refused(gif, env.clone()).await.message,
        "Choose a PNG, JPEG or WebP picture."
    );
    let huge = CohostAvatarCreateParams {
        inspiration_base64: Some(b64(&vec![0u8; COHOST_AVATAR_IMAGE_IN_MAX_BYTES + 1])),
        ..CohostAvatarCreateParams::default()
    };
    let too_large = refused(huge, env.clone()).await;
    assert_eq!(too_large.code, COHOST_AVATAR_PICTURE_TOO_LARGE);
    assert_eq!(
        too_large.message,
        "The picture is over 3 MB. Choose a smaller one."
    );
    let basic = AvatarEnv {
        premium: false,
        ..env.clone()
    };
    assert_eq!(
        refused(describe("a golem"), basic).await.code,
        "premium-required"
    );
    let signed_out = AvatarEnv {
        token: None,
        ..env.clone()
    };
    assert_eq!(
        refused(describe("a golem"), signed_out).await.code,
        "signed-out"
    );
    let rootless = AvatarEnv {
        root: None,
        ..env.clone()
    };
    assert_eq!(
        refused(describe("a golem"), rootless).await.code,
        COHOST_AVATAR_ROOT_UNCONFIGURED
    );
    // One job at a time: a second create while one runs is refused.
    web.inner.lock().unwrap().delay = Duration::from_millis(300);
    web.answer(Canned::Set {
        round: 0,
        made: ALL_STATES.to_vec(),
    });
    let mut events = state.events.subscribe();
    create_in(&state, env.clone(), describe("a golem"))
        .await
        .unwrap();
    let running = draft_status_in(&state, env.clone())
        .await
        .unwrap()
        .running
        .unwrap();
    assert_eq!(running.kind, CohostAvatarJobKind::Create);
    let busy = refused(describe("another"), env.clone()).await;
    assert_eq!(busy.code, COHOST_AVATAR_BUSY);
    next_event(&mut events, COHOST_AVATAR_DRAFT_EVENT).await;
    wait_idle(&env).await;
    assert_eq!(web.seen().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn golem_look_web_errors_become_the_hints_the_plan_names() {
    let state = test_state();
    let root = temp_root();
    let web = spawn_fake_web().await;
    let env = env_for(&root, &web, Arc::new(AvatarShared::default()));
    let cases = [
        (
            StatusCode::TOO_MANY_REQUESTS,
            "quota-exhausted",
            Some("12000"),
            "Daily avatar limit reached. More in 3 h 20 min.",
        ),
        (
            StatusCode::TOO_MANY_REQUESTS,
            "quota-exhausted",
            None,
            COHOST_AVATAR_QUOTA_HINT,
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "avatar-style-anchor-missing",
            None,
            COHOST_AVATAR_UNAVAILABLE_HINT,
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "avatar-model-unconfigured",
            None,
            COHOST_AVATAR_UNAVAILABLE_HINT,
        ),
        (
            StatusCode::FORBIDDEN,
            "avatar-disabled",
            None,
            COHOST_AVATAR_UNAVAILABLE_HINT,
        ),
        (
            StatusCode::FORBIDDEN,
            "premium-required",
            None,
            "Making your Golem's look requires Videorc Premium.",
        ),
    ];
    for (status, code, retry_after, hint) in cases {
        web.answer(Canned::Error {
            status,
            code,
            retry_after,
        });
        let (_, progress, draft) = create_and_wait(&state, &env, describe("a golem")).await;
        assert!(draft.is_none(), "{code}");
        let error = progress.last().unwrap().error.clone().unwrap();
        assert_eq!(error.code, code);
        assert_eq!(error.message, hint, "{code}");
    }
    assert!(draft_entries(&root).is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn tile_error_maps_codes_and_keeps_unknown_messages() {
    let error = |kind: CohostApiErrorKind, code: &str, message: &str| CohostApiError {
        kind,
        detail: CohostErrorDetail::new(code, message, Some(500)),
    };
    for code in [
        "avatar-model-unconfigured",
        "avatar-disabled",
        "avatar-style-anchor-missing",
        "cohost-disabled",
        "ai-gateway-not-configured",
    ] {
        assert_eq!(
            tile_error(&error(CohostApiErrorKind::ServerUnconfigured, code, "x")).message,
            COHOST_AVATAR_UNAVAILABLE_HINT,
            "{code}"
        );
    }
    let quota = |after: u64| {
        tile_error(&error(
            CohostApiErrorKind::QuotaExhausted {
                retry_after: Some(Duration::from_secs(after)),
            },
            "quota-exhausted",
            "x",
        ))
        .message
    };
    assert_eq!(quota(30), "Daily avatar limit reached. More in 1 min.");
    assert_eq!(
        quota(45 * 60),
        "Daily avatar limit reached. More in 45 min."
    );
    assert_eq!(quota(2 * 3600), "Daily avatar limit reached. More in 2 h.");
    let passthrough = tile_error(&error(
        CohostApiErrorKind::GatewayError,
        "ai-gateway-error",
        "The model said no.",
    ));
    assert_eq!(passthrough.code, "ai-gateway-error");
    assert_eq!(passthrough.message, "The model said no.");
}

#[test]
fn generated_pictures_are_checked_before_they_are_written() {
    assert_eq!(
        generated_png("***").unwrap_err().code,
        "avatar-image-unreadable"
    );
    assert_eq!(
        generated_png(&b64(&[0xff, 0xd8, 0xff, 0xe0]))
            .unwrap_err()
            .message,
        "The generated image is not a PNG."
    );
    assert_eq!(generated_png(&b64(&png_bytes(1))).unwrap(), png_bytes(1));
    assert!(request_id_ok("3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8"));
    for bad in [
        "3F2A1C4E-8B7D-4E6F-A1B2-C3D4E5F6A7B8",
        "../default",
        "",
        "3f2a1c4e8b7d4e6fa1b2c3d4e5f6a7b8",
    ] {
        assert!(!request_id_ok(bad), "{bad}");
    }
}

#[test]
fn set_request_wire_shape_matches_the_route() {
    let create = CohostAvatarSetRequest {
        description: Some("a golem".to_string()),
        inspiration: Some("AAAA".to_string()),
        redo: None,
        base: None,
    };
    assert_eq!(
        serde_json::to_value(&create).unwrap(),
        serde_json::json!({ "description": "a golem", "inspiration": "AAAA" })
    );
    let redo = CohostAvatarSetRequest {
        redo: Some(CohostAvatarState::Laugh),
        base: Some("BBBB".to_string()),
        ..CohostAvatarSetRequest::default()
    };
    assert_eq!(
        serde_json::to_value(&redo).unwrap(),
        serde_json::json!({ "redo": "laugh", "base": "BBBB" })
    );
    let response: CohostAvatarSetResponse = serde_json::from_value(serde_json::json!({
        "images": { "idle": { "pngBase64": "AAAA", "opaque": true }, "talk": { "pngBase64": "BBBB" } },
        "failed": { "laugh": { "code": "ai-gateway-error", "message": "no" } }
    }))
    .unwrap();
    assert!(response.images.get(CohostAvatarState::Idle).unwrap().opaque);
    assert!(!response.images.get(CohostAvatarState::Talk).unwrap().opaque);
    assert!(response.images.get(CohostAvatarState::Think).is_none());
    assert_eq!(response.failed[&CohostAvatarState::Laugh].message, "no");
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

/// The look's RPC and event shapes round-trip exactly as the TypeScript
/// contract validates them (plan 169 Phase B).
#[test]
fn shared_high_risk_contract_fixture_matches_golem_look_dtos() {
    round_trips::<CohostAvatarCreateParams>("/golemLook/createParams");
    round_trips::<CohostAvatarCreateParams>("/golemLook/createDescriptionParams");
    round_trips::<CohostAvatarRedoParams>("/golemLook/redoParams");
    round_trips::<CohostAvatarRequestIdParams>("/golemLook/requestIdParams");
    round_trips::<CohostAvatarAccepted>("/golemLook/accepted");
    round_trips::<CohostAvatarProgressEvent>("/golemLook/progressWorking");
    round_trips::<CohostAvatarProgressEvent>("/golemLook/progressDone");
    round_trips::<CohostAvatarProgressEvent>("/golemLook/progressFailed");
    round_trips::<CohostAvatarDraft>("/golemLook/draft");
    round_trips::<CohostAvatarDraftStatus>("/golemLook/status");
    round_trips::<CohostAvatarDraftStatus>("/golemLook/statusNone");
    // Plan 170 D13: the library fields on create and on the draft.
    round_trips::<CohostAvatarCreateParams>("/golemLook/createLibraryParams");
    round_trips::<CohostAvatarDraft>("/golemLook/libraryDraft");
    let create: CohostAvatarCreateParams =
        serde_json::from_value(high_risk_fixture("/golemLook/createLibraryParams")).unwrap();
    assert_eq!(create.name.as_deref(), Some("Grum"));
    let draft: CohostAvatarDraft =
        serde_json::from_value(high_risk_fixture("/golemLook/libraryDraft")).unwrap();
    assert_eq!(
        draft.library_avatar_id.as_deref(),
        Some("7c9e6679-7425-40de-944b-e07fc1ee9a51")
    );
    assert!(
        serde_json::from_value::<CohostAvatarCreateParams>(
            serde_json::json!({ "description": "x", "style": "pixel" })
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<CohostAvatarRequestIdParams>(
            serde_json::json!({ "requestId": "x", "extra": 1 })
        )
        .is_err()
    );
}

// --- The library route (plan 170 D13) -------------------------------------------------------------

mod library_route {
    use super::*;
    use crate::cohost_library::tests::{
        FakeLibrary, settle, shade_of as library_shade, spawn_fake_library, use_fake_library,
    };

    const MADE: &str = "5b1d0c7e-2f3a-4b6c-9d8e-7f6a5b4c3d2e";

    async fn library_env(root: &Path) -> (AppState, AvatarEnv, FakeLibrary) {
        let web = spawn_fake_library().await;
        let mut state = test_state();
        use_fake_library(&mut state, root, &web).await;
        let env = AvatarEnv {
            root: Some(root.to_path_buf()),
            api: Some(web.client.clone()),
            token: Some("bearer-1".to_string()),
            premium: true,
            library: true,
            shared: Arc::new(AvatarShared::default()),
        };
        (state, env, web)
    }

    async fn create_library_draft(
        state: &AppState,
        env: &AvatarEnv,
        web: &FakeLibrary,
    ) -> CohostAvatarDraft {
        web.with(|fake| fake.next_id = Some(MADE.to_string()));
        let (_, _, draft) = create_and_wait(
            state,
            env,
            CohostAvatarCreateParams {
                description: Some("a grumpy stone golem".to_string()),
                name: Some("  Grum ".to_string()),
                personality: Some("Grumbles, then helps.".to_string()),
                context: Some("Speedruns on Tuesdays.".to_string()),
                ..CohostAvatarCreateParams::default()
            },
        )
        .await;
        draft.expect("the library made a draft")
    }

    #[tokio::test]
    async fn golem_look_with_the_library_on_creates_into_the_account() {
        let root = temp_root();
        let (state, env, web) = library_env(&root).await;
        let draft = create_library_draft(&state, &env, &web).await;
        // One library create with the whole sidekick; the set route is not used.
        assert_eq!(
            web.body_of("POST /api/golem/avatars"),
            Some(serde_json::json!({
                "name": "Grum",
                "description": "a grumpy stone golem",
                "personality": "Grumbles, then helps.",
                "context": "Speedruns on Tuesdays."
            }))
        );
        assert_eq!(draft.library_avatar_id.as_deref(), Some(MADE));
        assert!(draft.failed.is_empty());
        // The draft on disk remembers it (a restart offers it again, linked).
        let again = draft_status_in(&state, env.clone()).await.unwrap();
        assert_eq!(
            again.draft.unwrap().library_avatar_id.as_deref(),
            Some(MADE)
        );
        // It is in the library already, its pictures cached from the response.
        settle(&state, |library| {
            library.mine.as_ref().is_some_and(|mine| {
                mine.first().is_some_and(|entry| {
                    entry.id == MADE && entry.poses.idle.is_some() && entry.poses.think.is_some()
                })
            })
        })
        .await;
        assert_eq!(web.count(&format!("GET /api/golem/avatars/{MADE}/idle")), 0);
        // The Golem itself changes only on Keep.
        assert_eq!(
            crate::cohost::get_cohost_settings(&state).await.persona,
            CohostPersona::default()
        );
    }

    #[tokio::test]
    async fn golem_look_keep_on_a_library_draft_applies_it_and_tells_the_account() {
        let root = temp_root();
        let (state, env, web) = library_env(&root).await;
        let draft = create_library_draft(&state, &env, &web).await;
        let settings = keep_in(
            &state,
            env.clone(),
            CohostAvatarRequestIdParams {
                request_id: draft.request_id.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(settings.persona.name, "Grum");
        assert_eq!(settings.persona.personality, "Grumbles, then helps.");
        assert_eq!(settings.persona.library_avatar_id.as_deref(), Some(MADE));
        assert_eq!(settings.notes, "Speedruns on Tuesdays.");
        let idle = settings.persona.images.idle.clone().unwrap();
        assert_eq!(
            std::fs::read(root.join(&idle)).unwrap(),
            png_bytes(library_shade(CohostAvatarState::Idle))
        );
        settle(&state, |library| {
            library.active_avatar_id.as_deref() == Some(MADE)
        })
        .await;
        assert_eq!(
            web.body_of("PUT /api/golem/profile"),
            Some(serde_json::json!({ "activeAvatarId": MADE }))
        );
        assert!(
            crate::cohost_library::load_library_sync(&state.database)
                .profile_updated_at
                .is_some()
        );
    }

    #[tokio::test]
    async fn golem_look_discard_on_a_library_draft_deletes_the_account_avatar() {
        let root = temp_root();
        let (state, env, web) = library_env(&root).await;
        let draft = create_library_draft(&state, &env, &web).await;
        let status = discard_in(
            &state,
            env.clone(),
            CohostAvatarRequestIdParams {
                request_id: draft.request_id.clone(),
            },
        )
        .await
        .unwrap();
        assert!(status.draft.is_none());
        settle(&state, |library| {
            library.mine.as_ref().is_some_and(|mine| mine.is_empty())
        })
        .await;
        assert_eq!(web.count(&format!("DELETE /api/golem/avatars/{MADE}")), 1);
        assert!(!root.join("library").join(MADE).exists());
    }

    #[tokio::test]
    async fn golem_look_redo_on_a_library_draft_uses_the_library_redo() {
        let root = temp_root();
        let (state, env, web) = library_env(&root).await;
        let draft = create_library_draft(&state, &env, &web).await;
        let mut events = state.events.subscribe();
        redo_in(
            &state,
            env.clone(),
            CohostAvatarRedoParams {
                request_id: draft.request_id.clone(),
                state: CohostAvatarState::Laugh,
            },
        )
        .await
        .unwrap();
        let (progress, redone) = run_until_end(&mut events, Some(CohostAvatarState::Laugh)).await;
        wait_idle(&env).await;
        assert!(
            progress
                .iter()
                .any(|step| step.phase == CohostAvatarPhase::Done)
        );
        assert_eq!(
            web.body_of(&format!("POST /api/golem/avatars/{MADE}/redo")),
            Some(serde_json::json!({ "state": "laugh" }))
        );
        // No base upload: the library redoes from its stored idle.
        let redone = redone.unwrap();
        let laugh = redone.images.laugh.unwrap();
        assert_eq!(
            std::fs::read(root.join(&laugh)).unwrap(),
            png_bytes(library_shade(CohostAvatarState::Laugh) + 1)
        );
        settle(&state, |library| {
            library.mine.as_ref().is_some_and(|mine| {
                mine[0]
                    .poses
                    .laugh
                    .as_deref()
                    .is_some_and(|url| url.ends_with("laugh-abc00001.png"))
            })
        })
        .await;
    }

    #[tokio::test]
    async fn golem_look_library_fields_are_bounded_before_anything_is_sent() {
        let root = temp_root();
        let (state, env, web) = library_env(&root).await;
        for params in [
            CohostAvatarCreateParams {
                name: Some("n".repeat(25)),
                ..describe("a golem")
            },
            CohostAvatarCreateParams {
                personality: Some("p".repeat(1201)),
                ..describe("a golem")
            },
            CohostAvatarCreateParams {
                context: Some("c".repeat(4001)),
                ..describe("a golem")
            },
        ] {
            let refused = create_in(&state, env.clone(), params).await.unwrap_err();
            assert_eq!(refused.code, COHOST_AVATAR_INVALID);
        }
        assert!(web.seen().is_empty());
    }
}
