//! The Buddy library against a fake videorc-web (plan 170 Phase D): the
//! wire shapes, sync (apply, offer, hold while live, signed out), use,
//! update, delete, the debounced PATCH of local edits, and the capability.
//! `FakeLibrary` is shared with the look's library-route tests.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use base64::Engine as _;
use tokio::sync::broadcast;

use super::*;
use crate::cohost::get_cohost_settings;
use crate::storage::Database;

pub(crate) const BEARER: &str = "bearer-1";
const AVATAR: &str = "7c9e6679-7425-40de-944b-e07fc1ee9a51";
const OTHER: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

pub(crate) fn test_state() -> AppState {
    let (events, _) = broadcast::channel(512);
    AppState::new(
        "test-token".to_string(),
        1234,
        events,
        Database::open_in_memory_for_tests(),
    )
}

pub(crate) fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("videorc-buddy-library-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A 4 x 4 PNG whose one opaque pixel has `shade`, so pictures are told apart.
pub(crate) fn png_bytes(shade: u8) -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 0]));
    image.put_pixel(1, 1, image::Rgba([shade, shade, shade, 255]));
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    png
}

pub(crate) fn shade_of(state: CohostAvatarState) -> u8 {
    match state {
        CohostAvatarState::Idle => 10,
        CohostAvatarState::Talk => 20,
        CohostAvatarState::Laugh => 30,
        CohostAvatarState::Think => 40,
    }
}

// --- The fake web --------------------------------------------------------------------------------

/// An account Buddy's alive pack on the fake web (plan 172): its id and
/// files; the objects live in the fake storage.
#[derive(Clone)]
pub(crate) struct FakeAlive {
    pub(crate) pack_id: String,
    pub(crate) files: Vec<(String, Vec<u8>)>,
}

#[derive(Clone)]
pub(crate) struct FakeAvatar {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) personality: String,
    pub(crate) context: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    /// The pose versions (8 hex), and the shade offset each picture draws.
    pub(crate) poses: BTreeMap<CohostAvatarState, (String, u8)>,
    /// Pictures an import uploaded, served instead of the drawn ones.
    pub(crate) uploaded: BTreeMap<CohostAvatarState, Vec<u8>>,
    pub(crate) alive: Option<FakeAlive>,
}

impl FakeAvatar {
    pub(crate) fn new(id: &str, name: &str, at: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("{name}, described"),
            personality: format!("{name} is cheerful."),
            context: format!("{name} streams on Tuesdays."),
            created_at: at.to_string(),
            updated_at: at.to_string(),
            poses: ALL_STATES
                .iter()
                .map(|state| (*state, (format!("{:08x}", shade_of(*state)), 0)))
                .collect(),
            uploaded: BTreeMap::new(),
            alive: None,
        }
    }

    fn json(&self) -> serde_json::Value {
        let pose = |state: CohostAvatarState| {
            self.poses.get(&state).map(|(version, _)| {
                serde_json::json!({
                    "url": format!("/api/buddy/avatars/{}/{}?v={version}", self.id, state.as_str()),
                    "opaque": false
                })
            })
        };
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "personality": self.personality,
            "context": self.context,
            "lookVersion": 1,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "poses": {
                "idle": pose(CohostAvatarState::Idle),
                "talk": pose(CohostAvatarState::Talk),
                "laugh": pose(CohostAvatarState::Laugh),
                "think": pose(CohostAvatarState::Think)
            },
            "alive": self.alive.as_ref().map(|alive| serde_json::json!({
                "packId": alive.pack_id,
                "version": 1,
                "cellSize": 640,
                "frames": 3,
                "files": alive.files.iter().map(|(name, bytes)| {
                    let sha = alive::sha256_hex(bytes);
                    serde_json::json!({
                        "name": name,
                        "url": format!("/api/buddy/avatars/{}/alive/{name}?v={}", self.id, &sha[..8]),
                        "bytes": bytes.len(),
                        "sha256": sha
                    })
                }).collect::<Vec<_>>()
            }))
        })
    }

    pub(crate) fn picture(&self, state: CohostAvatarState) -> Option<Vec<u8>> {
        if let Some(bytes) = self.uploaded.get(&state) {
            return Some(bytes.clone());
        }
        self.poses
            .get(&state)
            .map(|(_, offset)| png_bytes(shade_of(state) + offset))
    }
}

/// The fake storage behind the presigned URLs (plan 172): objects by key,
/// and what each request carried.
#[derive(Default)]
pub(crate) struct FakeS3State {
    pub(crate) objects: BTreeMap<String, Vec<u8>>,
    /// `(key, content type, carried a credential)` for every PUT.
    pub(crate) puts: Vec<(String, Option<String>, bool)>,
    /// `(key, carried a credential)` for every GET.
    pub(crate) gets: Vec<(String, bool)>,
    /// The next PUT answers this status instead.
    pub(crate) fail_put: Option<StatusCode>,
}

/// What a presign handed out, until its commit.
#[derive(Clone)]
pub(crate) struct FakePlan {
    /// None for an import.
    pub(crate) avatar_id: Option<String>,
    pub(crate) pack_id: Option<String>,
    pub(crate) body: serde_json::Value,
    pub(crate) files: Vec<(String, u64, String)>,
}

fn alive_object_key(avatar_id: &str, pack_id: &str, name: &str) -> String {
    format!("avatars/{avatar_id}/alive/{pack_id}/{name}")
}

#[derive(Default)]
pub(crate) struct FakeLibraryState {
    pub(crate) avatars: Vec<FakeAvatar>,
    pub(crate) active: Option<String>,
    pub(crate) profile_updated_at: Option<String>,
    pub(crate) clock: u32,
    /// `METHOD path` of every call, in order.
    pub(crate) seen: Vec<String>,
    pub(crate) bodies: Vec<(String, serde_json::Value)>,
    /// The next call answers this error instead.
    pub(crate) fail_next: Option<(StatusCode, &'static str)>,
    /// The id the next create gets.
    pub(crate) next_id: Option<String>,
    /// Pose pictures that answer 404 (`<id>/<state>`).
    pub(crate) missing_pictures: Vec<String>,
    /// Plan 172: the fake storage, its base URL, the presigns waiting for a
    /// commit, and the web's static official files by path.
    pub(crate) s3: Arc<StdMutex<FakeS3State>>,
    pub(crate) s3_base: String,
    pub(crate) plans: BTreeMap<String, FakePlan>,
    pub(crate) official: BTreeMap<String, Vec<u8>>,
    /// Official file paths that wait for this barrier before answering.
    pub(crate) hold_official: Option<Arc<tokio::sync::Semaphore>>,
}

impl FakeLibraryState {
    fn tick(&mut self) -> String {
        self.clock += 1;
        format!("2026-10-09T10:{:02}:00.000Z", self.clock.min(59))
    }
}

#[derive(Clone)]
pub(crate) struct FakeLibrary {
    pub(crate) inner: Arc<StdMutex<FakeLibraryState>>,
    pub(crate) client: VideorcApiClient,
}

impl FakeLibrary {
    pub(crate) fn with<R>(&self, edit: impl FnOnce(&mut FakeLibraryState) -> R) -> R {
        edit(&mut self.inner.lock().unwrap())
    }

    pub(crate) fn seen(&self) -> Vec<String> {
        self.with(|state| state.seen.clone())
    }

    pub(crate) fn count(&self, call: &str) -> usize {
        self.seen()
            .iter()
            .filter(|seen| seen.as_str() == call)
            .count()
    }

    pub(crate) fn body_of(&self, call: &str) -> Option<serde_json::Value> {
        self.with(|state| {
            state
                .bodies
                .iter()
                .find(|(seen, _)| seen == call)
                .map(|(_, body)| body.clone())
        })
    }

    /// The account picks `id` now.
    pub(crate) fn choose(&self, id: Option<&str>) {
        self.with(|state| {
            state.active = id.map(str::to_string);
            state.profile_updated_at = Some(state.tick());
        });
    }

    pub(crate) fn add(&self, avatar: FakeAvatar) {
        self.with(|state| state.avatars.insert(0, avatar));
    }

    pub(crate) fn s3(&self) -> Arc<StdMutex<FakeS3State>> {
        self.with(|state| state.s3.clone())
    }

    /// Give an account avatar a pack, its objects in storage.
    pub(crate) fn set_alive(&self, avatar_id: &str, alive: FakeAlive) {
        let s3 = self.s3();
        for (name, bytes) in &alive.files {
            s3.lock().unwrap().objects.insert(
                alive_object_key(avatar_id, &alive.pack_id, name),
                bytes.clone(),
            );
        }
        self.with(|state| {
            let avatar = state
                .avatars
                .iter_mut()
                .find(|avatar| avatar.id == avatar_id)
                .unwrap();
            avatar.alive = Some(alive);
        });
    }

    pub(crate) fn alive_of(&self, avatar_id: &str) -> Option<FakeAlive> {
        self.with(|state| {
            state
                .avatars
                .iter()
                .find(|avatar| avatar.id == avatar_id)
                .and_then(|avatar| avatar.alive.clone())
        })
    }
}

fn content_type_of(name: &str) -> &'static str {
    if name.ends_with(".webp") {
        "image/webp"
    } else if name.ends_with(".png") {
        "image/png"
    } else {
        "application/json"
    }
}

/// A presign for `files` (`[{ name, bytes, sha256 }]`).
fn presign(
    fake: &mut FakeLibraryState,
    avatar_id: Option<String>,
    pack_id: Option<String>,
    body: serde_json::Value,
) -> axum::response::Response {
    let Some(files) = body["files"].as_array() else {
        return error_response(StatusCode::BAD_REQUEST, "invalid-request");
    };
    let files: Vec<(String, u64, String)> = files
        .iter()
        .map(|file| {
            (
                file["name"].as_str().unwrap_or_default().to_string(),
                file["bytes"].as_u64().unwrap_or_default(),
                file["sha256"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let upload_id = format!("upload-{}", uuid::Uuid::new_v4().simple());
    let uploads: Vec<serde_json::Value> = files
        .iter()
        .map(|(name, _, _)| {
            serde_json::json!({
                "name": name,
                "url": format!("{}/put/{upload_id}/{name}", fake.s3_base),
                "method": "PUT",
                "headers": { "content-type": content_type_of(name) }
            })
        })
        .collect();
    fake.plans.insert(
        upload_id.clone(),
        FakePlan {
            avatar_id,
            pack_id,
            body,
            files,
        },
    );
    axum::Json(serde_json::json!({
        "uploadId": upload_id,
        "expiresAt": "2026-10-09T11:00:00.000Z",
        "uploads": uploads
    }))
    .into_response()
}

/// The uploaded objects of a plan, checked by size and SHA-256 as the web's
/// commit does; `Err` is the web's answer.
fn committed_files(
    fake: &mut FakeLibraryState,
    upload_id: &str,
) -> Result<(FakePlan, Vec<(String, Vec<u8>)>), axum::response::Response> {
    let Some(plan) = fake.plans.remove(upload_id) else {
        return Err(error_response(StatusCode::GONE, "buddy-upload-expired"));
    };
    let s3 = fake.s3.lock().unwrap();
    let mut files = Vec::new();
    for (name, bytes, sha) in &plan.files {
        let Some(object) = s3.objects.get(&format!("uploads/{upload_id}/{name}")) else {
            return Err(error_response(StatusCode::CONFLICT, "buddy-upload-missing"));
        };
        if object.len() as u64 != *bytes || alive::sha256_hex(object) != *sha {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "buddy-alive-invalid",
            ));
        }
        files.push((name.clone(), object.clone()));
    }
    Ok((plan, files))
}

fn error_response(status: StatusCode, code: &str) -> axum::response::Response {
    (
        status,
        axum::Json(serde_json::json!({
            "error": { "code": code, "message": format!("server says {code}") }
        })),
    )
        .into_response()
}

fn state_named(name: &str) -> Option<CohostAvatarState> {
    serde_json::from_value(serde_json::json!(name)).ok()
}

fn picture_response(png: Vec<u8>) -> axum::response::Response {
    ([(axum::http::header::CONTENT_TYPE, "image/png")], png).into_response()
}

fn handle(
    fake: &mut FakeLibraryState,
    method: &Method,
    path: &str,
    authorized: bool,
    body: serde_json::Value,
) -> axum::response::Response {
    fake.seen.push(format!("{method} {path}"));
    if !body.is_null() {
        fake.bodies.push((format!("{method} {path}"), body.clone()));
    }
    if let Some(blob) = path.strip_prefix("/blob/") {
        let mut parts = blob.split('/');
        let (Some(id), Some(state)) = (parts.next(), parts.next().and_then(state_named)) else {
            return error_response(StatusCode::NOT_FOUND, "missing");
        };
        return match fake
            .avatars
            .iter()
            .find(|avatar| avatar.id == id)
            .and_then(|avatar| avatar.picture(state))
        {
            Some(png) => picture_response(png),
            None => error_response(StatusCode::NOT_FOUND, "missing"),
        };
    }
    if path.starts_with("/buddy/official/") {
        // The web's static official files: public, no bearer needed.
        return match fake.official.get(path) {
            Some(bytes) => (
                [(axum::http::header::CONTENT_TYPE, content_type_of(path))],
                bytes.clone(),
            )
                .into_response(),
            None => (StatusCode::NOT_FOUND, "not found").into_response(),
        };
    }
    if !authorized {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if let Some((status, code)) = fake.fail_next.take() {
        return error_response(status, code);
    }
    if path == "/api/buddy/avatars/import" && *method == Method::POST {
        return presign(fake, None, None, body);
    }
    if path == "/api/buddy/avatars/import/commit" && *method == Method::POST {
        let upload_id = body["uploadId"].as_str().unwrap_or_default().to_string();
        let (plan, files) = match committed_files(fake, &upload_id) {
            Ok(committed) => committed,
            Err(response) => return response,
        };
        let id = fake
            .next_id
            .take()
            .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string());
        let at = fake.tick();
        let mut avatar = FakeAvatar::new(&id, plan.body["name"].as_str().unwrap_or("Buddy"), &at);
        avatar.description = String::new();
        avatar.personality = plan.body["personality"].as_str().unwrap_or("").to_string();
        avatar.context = plan.body["context"].as_str().unwrap_or("").to_string();
        avatar.poses.clear();
        for (name, bytes) in files {
            let Some(state) = name.strip_suffix(".png").and_then(state_named) else {
                continue;
            };
            avatar
                .poses
                .insert(state, (alive::sha256_hex(&bytes)[..8].to_string(), 0));
            avatar.uploaded.insert(state, bytes);
        }
        let response = serde_json::json!({ "avatar": avatar.json() });
        fake.avatars.insert(0, avatar);
        return axum::Json(response).into_response();
    }
    let profile = |fake: &FakeLibraryState| {
        serde_json::json!({
            "activeAvatarId": fake.active,
            "profileUpdatedAt": fake.profile_updated_at
        })
    };
    if path == "/api/buddy/profile" && *method == Method::PUT {
        fake.active = body["activeAvatarId"].as_str().map(str::to_string);
        fake.profile_updated_at = Some(fake.tick());
        return axum::Json(profile(fake)).into_response();
    }
    if path == "/api/buddy/avatars" && *method == Method::GET {
        let mut list = profile(fake);
        list["avatars"] = fake.avatars.iter().map(FakeAvatar::json).collect();
        list["limit"] = serde_json::json!(30);
        return axum::Json(list).into_response();
    }
    if path == "/api/buddy/avatars" && *method == Method::POST {
        let id = fake
            .next_id
            .take()
            .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string());
        let at = fake.tick();
        let mut avatar = FakeAvatar::new(&id, body["name"].as_str().unwrap_or("Buddy"), &at);
        avatar.description = body["description"].as_str().unwrap_or("").to_string();
        avatar.personality = body["personality"].as_str().unwrap_or("").to_string();
        avatar.context = body["context"].as_str().unwrap_or("").to_string();
        let images: serde_json::Map<String, serde_json::Value> = ALL_STATES
            .iter()
            .map(|state| {
                (
                    state.as_str().to_string(),
                    serde_json::json!({
                        "pngBase64": base64::engine::general_purpose::STANDARD
                            .encode(avatar.picture(*state).unwrap()),
                        "opaque": false
                    }),
                )
            })
            .collect();
        let response =
            serde_json::json!({ "avatar": avatar.json(), "images": images, "failed": {} });
        fake.avatars.insert(0, avatar);
        return axum::Json(response).into_response();
    }
    let Some(rest) = path.strip_prefix("/api/buddy/avatars/") else {
        return error_response(StatusCode::NOT_FOUND, "no-route");
    };
    let mut parts = rest.split('/');
    let id = parts.next().unwrap_or_default().to_string();
    let tail = parts.next();
    let after = parts.next();
    let Some(index) = fake.avatars.iter().position(|avatar| avatar.id == id) else {
        return error_response(StatusCode::NOT_FOUND, "buddy-not-found");
    };
    match (method.clone(), tail, after) {
        (Method::POST, Some("alive"), None) => {
            let pack_id = body["packId"].as_str().map(str::to_string);
            return presign(fake, Some(id), pack_id, body);
        }
        (Method::POST, Some("alive"), Some("commit")) => {
            let upload_id = body["uploadId"].as_str().unwrap_or_default().to_string();
            let (plan, files) = match committed_files(fake, &upload_id) {
                Ok(committed) => committed,
                Err(response) => return response,
            };
            if plan.avatar_id.as_deref() != Some(id.as_str()) {
                return error_response(StatusCode::BAD_REQUEST, "buddy-upload-invalid");
            }
            let pack_id = plan.pack_id.unwrap_or_default();
            {
                let mut s3 = fake.s3.lock().unwrap();
                for (name, bytes) in &files {
                    s3.objects
                        .insert(alive_object_key(&id, &pack_id, name), bytes.clone());
                }
            }
            let at = fake.tick();
            let avatar = &mut fake.avatars[index];
            avatar.alive = Some(FakeAlive { pack_id, files });
            avatar.updated_at = at;
            return axum::Json(serde_json::json!({ "avatar": avatar.json() })).into_response();
        }
        (Method::DELETE, Some("alive"), None) => {
            let avatar = &mut fake.avatars[index];
            avatar.alive = None;
            return axum::Json(serde_json::json!({ "avatar": avatar.json() })).into_response();
        }
        (Method::GET, Some("alive"), Some(name)) => {
            let Some(alive) = fake.avatars[index].alive.as_ref() else {
                return error_response(StatusCode::NOT_FOUND, "buddy-alive-missing");
            };
            return (
                StatusCode::FOUND,
                [(
                    axum::http::header::LOCATION,
                    format!(
                        "{}/objects/{}",
                        fake.s3_base,
                        alive_object_key(&id, &alive.pack_id, name)
                    ),
                )],
            )
                .into_response();
        }
        _ => {}
    }
    match (method.clone(), tail) {
        (Method::GET, None) => {
            axum::Json(serde_json::json!({ "avatar": fake.avatars[index].json() })).into_response()
        }
        (Method::PATCH, None) => {
            let at = fake.tick();
            let avatar = &mut fake.avatars[index];
            if let Some(name) = body["name"].as_str() {
                avatar.name = name.to_string();
            }
            if let Some(personality) = body["personality"].as_str() {
                avatar.personality = personality.to_string();
            }
            if let Some(context) = body["context"].as_str() {
                avatar.context = context.to_string();
            }
            avatar.updated_at = at;
            axum::Json(serde_json::json!({ "avatar": avatar.json() })).into_response()
        }
        (Method::DELETE, None) => {
            fake.avatars.remove(index);
            if fake.active.as_deref() == Some(id.as_str()) {
                fake.active = None;
                fake.profile_updated_at = Some(fake.tick());
            }
            let mut answer = profile(fake);
            answer["deleted"] = serde_json::json!(true);
            axum::Json(answer).into_response()
        }
        (Method::POST, Some("redo")) => {
            let Some(state) = body["state"].as_str().and_then(state_named) else {
                return error_response(StatusCode::BAD_REQUEST, "invalid-request");
            };
            let at = fake.tick();
            let avatar = &mut fake.avatars[index];
            let entry = avatar.poses.entry(state).or_insert((String::new(), 0));
            entry.1 += 1;
            entry.0 = format!("{:08x}", 0xabc0_0000_u32 + u32::from(entry.1));
            avatar.updated_at = at;
            let png = avatar.picture(state).unwrap();
            axum::Json(serde_json::json!({
                "avatar": avatar.json(),
                "images": { state.as_str(): {
                    "pngBase64": base64::engine::general_purpose::STANDARD.encode(png),
                    "opaque": false
                } }
            }))
            .into_response()
        }
        (Method::GET, Some(state_name)) => {
            let Some(state) = state_named(state_name) else {
                return error_response(StatusCode::NOT_FOUND, "buddy-pose-missing");
            };
            if fake
                .missing_pictures
                .contains(&format!("{id}/{state_name}"))
                || !fake.avatars[index].poses.contains_key(&state)
            {
                return error_response(StatusCode::NOT_FOUND, "buddy-pose-missing");
            }
            (
                StatusCode::FOUND,
                [(
                    axum::http::header::LOCATION,
                    format!("/blob/{id}/{state_name}"),
                )],
            )
                .into_response()
        }
        _ => error_response(StatusCode::NOT_FOUND, "no-route"),
    }
}

/// The fake storage: `PUT /put/<uploadId>/<name>` keeps the object under
/// `uploads/<uploadId>/<name>`; `GET /objects/<key>` serves one.
async fn spawn_fake_s3(s3: Arc<StdMutex<FakeS3State>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(
        move |method: Method,
              uri: axum::http::Uri,
              headers: axum::http::HeaderMap,
              body: axum::body::Bytes| {
            let s3 = s3.clone();
            async move {
                let credential = headers.contains_key(axum::http::header::AUTHORIZATION)
                    || headers.contains_key(axum::http::header::COOKIE);
                let mut store = s3.lock().unwrap();
                let path = uri.path();
                if method == Method::PUT
                    && let Some(rest) = path.strip_prefix("/put/")
                {
                    let key = format!("uploads/{rest}");
                    let content_type = headers
                        .get(axum::http::header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    store.puts.push((key.clone(), content_type, credential));
                    if let Some(status) = store.fail_put.take() {
                        return status.into_response();
                    }
                    store.objects.insert(key, body.to_vec());
                    return StatusCode::OK.into_response();
                }
                if method == Method::GET
                    && let Some(key) = path.strip_prefix("/objects/")
                {
                    store.gets.push((key.to_string(), credential));
                    return match store.objects.get(key) {
                        Some(bytes) => bytes.clone().into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    };
                }
                StatusCode::NOT_FOUND.into_response()
            }
        },
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://127.0.0.1:{}", address.port())
}

pub(crate) async fn spawn_fake_library() -> FakeLibrary {
    let s3 = Arc::new(StdMutex::new(FakeS3State::default()));
    let s3_base = spawn_fake_s3(s3.clone()).await;
    let inner = Arc::new(StdMutex::new(FakeLibraryState {
        s3,
        s3_base,
        ..FakeLibraryState::default()
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let route_state = inner.clone();
    let app = axum::Router::new().fallback(
        move |method: Method,
              uri: axum::http::Uri,
              headers: axum::http::HeaderMap,
              body: axum::body::Bytes| {
            let state = route_state.clone();
            async move {
                let authorized = headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    == Some(format!("Bearer {BEARER}").as_str());
                let body: serde_json::Value = if body.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)
                };
                // A held official file waits (outside the lock) for its permit.
                let hold = if uri.path().starts_with("/buddy/official/") {
                    state.lock().unwrap().hold_official.clone()
                } else {
                    None
                };
                if let Some(hold) = hold {
                    let _permit = hold.acquire().await;
                }
                let mut fake = state.lock().unwrap();
                handle(&mut fake, &method, uri.path(), authorized, body)
            }
        },
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    FakeLibrary {
        inner,
        client: VideorcApiClient::for_base_url(format!("http://{address}")),
    }
}

pub(crate) fn fast_timing() -> LibraryTiming {
    LibraryTiming {
        focus_interval: Duration::from_secs(60),
        patch_debounce: Duration::from_millis(150),
        live_poll: Duration::from_millis(20),
    }
}

/// Point `state`'s library at `web` and `root`, signed in with the library on.
pub(crate) async fn use_fake_library(state: &mut AppState, root: &Path, web: &FakeLibrary) {
    state.buddy_library = Arc::new(LibraryShared::for_tests(
        LibraryEnv {
            root: Some(root.to_path_buf()),
            api: Some(web.client.clone()),
            token: Some(BEARER.to_string()),
            ..LibraryEnv::default()
        },
        fast_timing(),
    ));
    *state.account_session.lock().await = crate::account::complete_mock_sign_in("orc_dev", true);
    state.buddy_library.cache().capability = Some(AiCapabilitiesBuddyLibrary {
        enabled: true,
        count: 0,
        limit: 30,
        alive: true,
    });
}

pub(crate) async fn library_state(root: &Path, web: &FakeLibrary) -> AppState {
    let mut state = test_state();
    use_fake_library(&mut state, root, web).await;
    state
}

/// Poll the library until `done` holds and no job runs, or fail.
pub(crate) async fn settle(state: &AppState, done: impl Fn(&BuddyLibraryState) -> bool) {
    for _ in 0..500 {
        let library = get(state).await;
        if library.busy.is_none()
            && !state.buddy_library.sync_queued.load(Ordering::Acquire)
            && state.buddy_library.jobs_pending.load(Ordering::Acquire) == 0
            && done(&library)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the library never settled: {:?}", get(state).await);
}

async fn persona(state: &AppState) -> CohostPersona {
    get_cohost_settings(state).await.persona
}

async fn save_persona(state: &AppState, persona: CohostPersona) {
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

async fn save_notes(state: &AppState, notes: &str) {
    crate::cohost::set_cohost_settings(
        state,
        CohostSettingsPatch {
            notes: Some(notes.to_string()),
            ..CohostSettingsPatch::default()
        },
    )
    .await
    .unwrap();
}

fn file_at(root: &Path, relative: &str) -> Vec<u8> {
    std::fs::read(root.join(relative)).unwrap()
}

fn image_of(images: &CohostPersonaImages, state: CohostAvatarState) -> Option<String> {
    match state {
        CohostAvatarState::Idle => images.idle.clone(),
        CohostAvatarState::Talk => images.talk.clone(),
        CohostAvatarState::Laugh => images.laugh.clone(),
        CohostAvatarState::Think => images.think.clone(),
    }
}

fn use_params(id: &str) -> CohostLibraryAvatarParams {
    CohostLibraryAvatarParams {
        avatar_id: id.to_string(),
    }
}

// --- The contract ------------------------------------------------------------------------------------

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

fn round_trips<T: serde::de::DeserializeOwned + Serialize>(pointer: &str) -> T {
    let wire = high_risk_fixture(pointer);
    let value: T =
        serde_json::from_value(wire.clone()).unwrap_or_else(|error| panic!("{pointer}: {error}"));
    assert_eq!(serde_json::to_value(&value).unwrap(), wire, "{pointer}");
    value
}

/// The catalog equals the shared fixture, field for field (D10).
#[test]
fn buddy_official_catalog_matches_the_shared_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol-fixtures/buddy-official-catalog.json"
    ))
    .expect("the official catalog fixture must be valid JSON");
    assert_eq!(fixture["version"], 1);
    let avatars = fixture["avatars"].as_array().unwrap();
    assert_eq!(avatars.len(), BUDDY_OFFICIAL_CATALOG.len());
    for (row, official) in avatars.iter().zip(BUDDY_OFFICIAL_CATALOG.iter()) {
        assert_eq!(row["slug"], official.slug.as_str());
        assert_eq!(row["id"], official.slug.id());
        assert_eq!(row["name"], official.name);
        assert_eq!(row["kind"], official.kind);
        assert_eq!(row["tagline"], official.tagline);
        assert_eq!(row["personality"], official.personality);
        assert_eq!(row["description"].as_str(), official.description);
        // Plan 172 D4: null until the pack ships.
        assert_eq!(
            row.as_object().unwrap().len(),
            8,
            "{}",
            official.slug.as_str()
        );
        match official.alive {
            None => assert!(row["alive"].is_null(), "{}", official.slug.as_str()),
            Some(alive) => {
                assert_eq!(row["alive"], official_alive_json(&alive));
                assert_eq!(alive.bundled, official.slug == BuddyOfficialSlug::Golem);
                if alive.bundled {
                    assert_eq!(alive.pack_id, alive::BUDDY_DEFAULT_ALIVE_PACK_ID);
                } else {
                    assert_eq!(alive.pack_id, alive::official_pack_id(official.slug));
                }
            }
        }
    }
    let slugs: Vec<_> = BUDDY_OFFICIAL_CATALOG.iter().map(|row| row.slug).collect();
    assert_eq!(slugs, BuddyOfficialSlug::ALL);
    // The shapes place `alive` right after `description`, the last key of
    // each row (the web's copy is byte-identical).
    let text = include_str!("../../../../protocol-fixtures/buddy-official-catalog.json");
    let rows: Vec<&str> = text.split("\n    {\n").skip(1).collect();
    assert_eq!(rows.len(), BUDDY_OFFICIAL_CATALOG.len());
    for row in rows {
        let description = row.find("\"description\": ").unwrap();
        let alive = row.find("\"alive\": ").unwrap();
        let between = &row[description..alive];
        assert_eq!(between.matches('\n').count(), 1, "{row}");
        // No key of the row after it (nested keys sit deeper).
        assert!(!row[alive..].contains("\n      \""), "{row}");
    }
}

/// A catalog `alive` block as the fixture writes it (plan 172 shapes).
fn official_alive_json(alive: &BuddyOfficialAlive) -> serde_json::Value {
    serde_json::json!({
        "version": alive.version,
        "packId": alive.pack_id,
        "bundled": alive.bundled,
        "cellSize": alive.cell_size,
        "frames": alive.frames,
        "files": alive.files.iter().map(|file| serde_json::json!({
            "name": file.name,
            "bytes": file.bytes,
            "sha256": file.sha256
        })).collect::<Vec<_>>()
    })
}

/// The filled form of the shapes reads into the Rust row and back, and a
/// pack's three files pass the file rules.
#[test]
fn buddy_official_alive_filled_form_round_trips() {
    const FILES: [BuddyOfficialAliveFile; 3] = [
        BuddyOfficialAliveFile {
            name: "manifest.json",
            bytes: 1234,
            sha256: "0000000000000000000000000000000000000000000000000000000000000001",
        },
        BuddyOfficialAliveFile {
            name: "mascot.webp",
            bytes: 3_456_789,
            sha256: "0000000000000000000000000000000000000000000000000000000000000002",
        },
        BuddyOfficialAliveFile {
            name: "buddy.json",
            bytes: 123,
            sha256: "0000000000000000000000000000000000000000000000000000000000000003",
        },
    ];
    let alive = BuddyOfficialAlive {
        version: 1,
        pack_id: "official:orc",
        bundled: false,
        cell_size: 640,
        frames: 40,
        files: &FILES,
    };
    let json = official_alive_json(&alive);
    assert_eq!(
        json,
        serde_json::json!({
            "version": 1,
            "packId": "official:orc",
            "bundled": false,
            "cellSize": 640,
            "frames": 40,
            "files": [
                { "name": "manifest.json", "bytes": 1234, "sha256": FILES[0].sha256 },
                { "name": "mascot.webp", "bytes": 3_456_789, "sha256": FILES[1].sha256 },
                { "name": "buddy.json", "bytes": 123, "sha256": FILES[2].sha256 }
            ]
        })
    );
    let spec = alive.to_spec();
    assert_eq!(spec.version, 1);
    assert!(!spec.bundled);
    assert!(alive::alive_files_ok(&spec.files));
    let mut wrong = spec.files.clone();
    wrong[1].name = "mascot.png".to_string();
    assert!(!alive::alive_files_ok(&wrong));
    let mut big = spec.files.clone();
    big[1].bytes = 33 * 1024 * 1024;
    assert!(!alive::alive_files_ok(&big));
    let mut upper = spec.files.clone();
    upper[0].sha256 = upper[0].sha256.to_uppercase().replace('0', "A");
    assert!(!alive::alive_files_ok(&upper));
    assert!(!alive::alive_files_ok(&spec.files[..2]));
}

/// Plan 172 Phase B: every bundled pack the catalog lists ships in
/// `apps/desktop/resources/buddy/<name>/` with its listed size and hash.
#[test]
fn buddy_official_bundled_packs_ship_with_their_listed_files() {
    let resources =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/resources/buddy");
    for official in BUDDY_OFFICIAL_CATALOG {
        let Some(alive) = official.alive.filter(|alive| alive.bundled) else {
            continue;
        };
        let name = alive
            .pack_id
            .strip_prefix(crate::buddy_pet::BUDDY_BUNDLED_PACK_PREFIX)
            .expect("a bundled pack id");
        let spec = alive.to_spec();
        assert!(
            alive::pack_verified(&resources.join(name), &spec.files),
            "{} does not match the catalog",
            alive.pack_id
        );
    }
}

/// Every official pose is bundled and decodes as a WebP (D10).
#[test]
fn buddy_official_art_is_bundled_for_every_slug_and_state() {
    for slug in BuddyOfficialSlug::ALL {
        for state in ALL_STATES {
            let bytes = official_webp(slug, state);
            assert!(
                image::load_from_memory_with_format(bytes, image::ImageFormat::WebP).is_ok(),
                "{} {}",
                slug.as_str(),
                state.as_str()
            );
        }
    }
    assert_ne!(
        official_webp(BuddyOfficialSlug::Orc, CohostAvatarState::Idle),
        official_webp(BuddyOfficialSlug::Golem, CohostAvatarState::Idle)
    );
}

#[test]
fn buddy_library_ids_are_user_uuids_or_known_official_slugs() {
    assert_eq!(
        official_slug_from_id("official:pirate"),
        Some(BuddyOfficialSlug::Pirate)
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

#[test]
fn buddy_library_pose_tags_come_from_the_url_version() {
    assert_eq!(
        pose_tag(&format!("/api/buddy/avatars/{AVATAR}/idle?v=0a1b2c3d")),
        "0a1b2c3d"
    );
    // No usable `v`: a stable digest of the URL instead.
    let url = format!("/api/buddy/avatars/{AVATAR}/idle?v=ZZZ");
    let digest = pose_tag(&url);
    assert_eq!(digest.len(), 8);
    assert_eq!(digest, pose_tag(&url));
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

/// Every library RPC and the event round-trip exactly as the TypeScript
/// contract validates them (plan 170 Phase D).
#[test]
fn shared_high_risk_contract_fixture_matches_buddy_library_dtos() {
    for pointer in [
        "/buddyLibrary/signedOut",
        "/buddyLibrary/signedIn",
        "/buddyLibrary/localOnly",
        "/buddyLibrary/importing",
        "/buddyLibrary/aliveUpload",
        "/buddyLibrary/aliveDownload",
    ] {
        round_trips::<BuddyLibraryState>(pointer);
    }
    // Plan 172: official entries carry their pack state, account entries
    // their pack (null when none), and the three new jobs.
    let download: BuddyLibraryState = round_trips("/buddyLibrary/aliveDownload");
    assert_eq!(
        download
            .official
            .iter()
            .map(|entry| entry.alive)
            .collect::<Vec<_>>(),
        [
            BuddyOfficialAliveState::Bundled,
            BuddyOfficialAliveState::Available
        ]
    );
    assert_eq!(
        download.busy.unwrap().kind,
        BuddyLibraryBusyKind::AliveDownload
    );
    let upload: BuddyLibraryState = round_trips("/buddyLibrary/aliveUpload");
    assert_eq!(upload.busy.unwrap().kind, BuddyLibraryBusyKind::AliveUpload);
    let importing: BuddyLibraryState = round_trips("/buddyLibrary/importing");
    assert_eq!(importing.busy.unwrap().kind, BuddyLibraryBusyKind::Import);
    let signed_in: BuddyLibraryState = round_trips("/buddyLibrary/signedIn");
    assert_eq!(
        signed_in.mine.as_ref().unwrap()[1].poses,
        BuddyLibraryPoses::default()
    );
    assert_eq!(
        signed_in.mine.as_ref().unwrap()[0].alive,
        Some(BuddyLibraryEntryAlive {
            pack_id: "0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a".to_string(),
            cell_size: 640
        })
    );
    assert_eq!(signed_in.mine.as_ref().unwrap()[1].alive, None);
    let sync: CohostLibrarySyncParams = round_trips("/buddyLibrary/syncParams");
    assert_eq!(sync.reason, BuddyLibrarySyncReason::DeepLink);
    round_trips::<CohostLibraryAvatarParams>("/buddyLibrary/useParams");
    round_trips::<CohostLibraryAvatarParams>("/buddyLibrary/useOfficialParams");
    round_trips::<CohostLibraryUpdateParams>("/buddyLibrary/updateParams");
    round_trips::<CohostLibraryAvatarParams>("/buddyLibrary/deleteParams");
    let accepted: CohostLibraryAccepted = round_trips("/buddyLibrary/accepted");
    assert!(accepted.accepted);
    assert!(
        serde_json::from_value::<CohostLibrarySyncParams>(serde_json::json!({ "reason": "timer" }))
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
fn buddy_library_active_id_follows_the_persona_link() {
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

#[test]
fn buddy_library_sync_clock_defaults_round_trips_and_compares() {
    let database = Database::open_in_memory_for_tests();
    assert_eq!(load_library_sync(&database), BuddyLibrarySync::default());
    let sync = BuddyLibrarySync {
        profile_updated_at: Some("2026-10-09T10:05:00.000Z".to_string()),
        ..BuddyLibrarySync::default()
    };
    save_library_sync(&database, &sync).unwrap();
    assert_eq!(load_library_sync(&database), sync);
    assert_eq!(
        serde_json::to_value(&sync).unwrap(),
        serde_json::json!({ "profileUpdatedAt": "2026-10-09T10:05:00.000Z" })
    );
    assert!(is_newer(
        Some("2026-10-09T10:06:00.000Z"),
        Some("2026-10-09T10:05:00.000Z")
    ));
    assert!(!is_newer(
        Some("2026-10-09T10:05:00.000Z"),
        Some("2026-10-09T10:05:00.000Z")
    ));
    assert!(is_newer(Some("2026-10-09T10:05:00.000Z"), None));
    assert!(!is_newer(None, None));
}

#[tokio::test]
async fn buddy_library_get_signed_out_is_the_official_catalog_and_the_default() {
    let state = test_state();
    *state.account_session.lock().await = Some(crate::account::signed_out_account());
    assert_eq!(
        serde_json::to_value(get(&state).await).unwrap(),
        high_risk_fixture("/buddyLibrary/signedOut")
    );
}

// --- Sync --------------------------------------------------------------------------------------------

#[tokio::test]
async fn buddy_library_sync_lists_the_account_and_caches_each_idle() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(OTHER, "Pixel", "2026-10-08T09:00:00.000Z"));
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    let state = library_state(&root, &web).await;
    let mut events = state.events.subscribe();
    sync(
        &state,
        CohostLibrarySyncParams {
            reason: BuddyLibrarySyncReason::Tab,
        },
    )
    .await
    .unwrap();
    settle(&state, |library| {
        library
            .mine
            .as_ref()
            .is_some_and(|mine| mine.iter().all(|entry| entry.poses.idle.is_some()))
    })
    .await;
    let library = get(&state).await;
    let mine = library.mine.unwrap();
    assert_eq!(
        mine.iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["Grum", "Pixel"]
    );
    assert_eq!(mine[0].context, "Grum streams on Tuesdays.");
    // Each idle is cached under library/<id>/idle-<v>.png; the rest wait for use.
    assert_eq!(
        mine[0].poses.idle.as_deref(),
        Some(format!("videorc-asset://buddy/library/{AVATAR}/idle-0000000a.png").as_str())
    );
    assert_eq!(mine[0].poses.talk, None);
    assert_eq!(
        file_at(&root, &format!("library/{AVATAR}/idle-0000000a.png")),
        png_bytes(10)
    );
    // No choice on the account: the untouched default stays.
    assert_eq!(library.active_avatar_id.as_deref(), Some("official:golem"));
    assert_eq!(persona(&state).await, CohostPersona::default());
    // The renderer heard about it, and every event reads back as the state.
    let mut changed = 0;
    while let Ok(event) = events.try_recv() {
        if event.event == COHOST_LIBRARY_CHANGED_EVENT {
            serde_json::from_value::<BuddyLibraryState>(event.payload).unwrap();
            changed += 1;
        }
    }
    assert!(changed >= 2);

    // An avatar deleted elsewhere leaves the cache with its pictures.
    web.with(|fake| fake.avatars.retain(|avatar| avatar.id != OTHER));
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |library| {
        library.mine.as_ref().is_some_and(|mine| mine.len() == 1)
    })
    .await;
    assert!(!root.join("library").join(OTHER).exists());
    assert!(root.join("library").join(AVATAR).exists());
}

#[tokio::test]
async fn buddy_library_sync_applies_a_newer_choice_to_the_untouched_default() {
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
    let settings = get_cohost_settings(&state).await;
    let persona = settings.persona;
    assert_eq!(persona.name, "Grum");
    assert_eq!(persona.personality, "Grum is cheerful.");
    assert_eq!(persona.source, CohostPersonaSource::Generated);
    assert_eq!(persona.avatar, BuddyAvatar::Still);
    assert_eq!(persona.library_avatar_id.as_deref(), Some(AVATAR));
    assert_eq!(settings.notes, "Grum streams on Tuesdays.");
    // The four poses are the persona's still pictures.
    for avatar_state in ALL_STATES {
        let path = image_of(&persona.images, avatar_state)
            .unwrap_or_else(|| panic!("{} missing", avatar_state.as_str()));
        assert!(
            path.starts_with("default/") && path.ends_with(".png"),
            "{path}"
        );
        assert_eq!(file_at(&root, &path), png_bytes(shade_of(avatar_state)));
    }
    // The clock is stored: the same choice does not apply again, and sync
    // never writes the account's choice itself.
    assert_eq!(
        load_library_sync(&state.database).profile_updated_at,
        web.with(|fake| fake.profile_updated_at.clone())
    );
    let downloads = web.count(&format!("GET /api/buddy/avatars/{AVATAR}/talk"));
    request_sync(&state, BuddyLibrarySyncReason::Manual);
    settle(&state, |_| true).await;
    assert_eq!(
        web.count(&format!("GET /api/buddy/avatars/{AVATAR}/talk")),
        downloads
    );
    assert_eq!(web.count("GET /api/buddy/avatars"), 2);
    assert_eq!(web.count("PUT /api/buddy/profile"), 0);
}

#[tokio::test]
async fn buddy_library_sync_never_overwrites_a_local_only_buddy() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.choose(Some(AVATAR));
    let state = library_state(&root, &web).await;
    let local = CohostPersona {
        name: "Mossback".to_string(),
        source: CohostPersonaSource::Uploaded,
        ..CohostPersona::default()
    };
    save_persona(&state, local.clone()).await;
    request_sync(&state, BuddyLibrarySyncReason::Launch);
    settle(&state, |library| library.server_active_avatar_id.is_some()).await;
    let library = get(&state).await;
    assert_eq!(library.server_active_avatar_id.as_deref(), Some(AVATAR));
    assert_eq!(library.active_avatar_id, None);
    assert_eq!(persona(&state).await, local);
    // Declined: the clock stays, so the next sync offers it again.
    assert_eq!(
        load_library_sync(&state.database),
        BuddyLibrarySync::default()
    );
    // Use applies it on request and tells the account.
    use_avatar(&state, use_params(AVATAR)).await.unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    assert_eq!(get(&state).await.server_active_avatar_id, None);
    assert_eq!(web.count("PUT /api/buddy/profile"), 1);
}

#[tokio::test]
async fn buddy_library_sync_holds_a_choice_while_live_and_applies_it_after() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.choose(Some(AVATAR));
    let state = library_state(&root, &web).await;
    *state.recording.lock().await = Some(crate::recording::test_active_recording_stub("live-1"));
    request_sync(&state, BuddyLibrarySyncReason::Focus);
    settle(&state, |library| library.mine.is_some()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(persona(&state).await, CohostPersona::default());
    assert!(state.buddy_library.cache().pending_apply.is_some());
    // The session ends: the held choice applies.
    *state.recording.lock().await = None;
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    assert_eq!(persona(&state).await.name, "Grum");
    assert!(
        load_library_sync(&state.database)
            .profile_updated_at
            .is_some()
    );
}

#[tokio::test]
async fn buddy_library_signed_out_changes_nothing_and_official_still_applies() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.choose(Some(AVATAR));
    let mut state = test_state();
    state.buddy_library = Arc::new(LibraryShared::for_tests(
        LibraryEnv {
            root: Some(root.clone()),
            api: Some(web.client.clone()),
            token: None,
            ..LibraryEnv::default()
        },
        fast_timing(),
    ));
    *state.account_session.lock().await = Some(crate::account::signed_out_account());
    save_notes(&state, "My own notes").await;
    request_sync(&state, BuddyLibrarySyncReason::Launch);
    settle(&state, |_| true).await;
    let library = get(&state).await;
    assert!(!library.signed_in);
    assert_eq!(library.mine, None);
    assert!(web.seen().is_empty(), "signed out never calls the web");
    assert_eq!(persona(&state).await, CohostPersona::default());
    // An account avatar needs a session; an official one does not.
    let refused = use_avatar(&state, use_params(AVATAR)).await.unwrap_err();
    assert_eq!(refused.code, COHOST_LIBRARY_SIGNED_OUT);
    use_avatar(&state, use_params("official:orc"))
        .await
        .unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some("official:orc")
    })
    .await;
    let settings = get_cohost_settings(&state).await;
    assert_eq!(settings.persona.name, "Golmar");
    assert_eq!(
        settings.persona.personality,
        official_buddy(BuddyOfficialSlug::Orc).personality
    );
    assert_eq!(
        settings.notes, "My own notes",
        "official avatars keep the notes"
    );
    let idle = settings.persona.images.idle.clone().unwrap();
    assert!(idle.ends_with(".webp"), "{idle}");
    assert_eq!(
        file_at(&root, &idle),
        official_webp(BuddyOfficialSlug::Orc, CohostAvatarState::Idle)
    );
    // Back to the Buddy: the bundled default, its pictures and source.
    use_avatar(&state, use_params("official:golem"))
        .await
        .unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some("official:golem")
    })
    .await;
    let buddy = persona(&state).await;
    assert_eq!(buddy.images, CohostPersonaImages::default());
    assert_eq!(buddy.source, CohostPersonaSource::Default);
    assert_eq!(buddy.library_avatar_id.as_deref(), Some("official:golem"));
    assert!(
        !root.join(&idle).exists(),
        "the orc's pictures went with it"
    );
    // Signed out, nothing touches the account: the only requests are the
    // public official pack files (plan 172 D4).
    let seen = web.seen();
    assert!(
        seen.iter()
            .all(|call| call.starts_with("GET /buddy/official/")),
        "signed out, only public official pack files are fetched: {seen:?}"
    );
}

#[tokio::test]
async fn buddy_library_use_downloads_the_poses_applies_and_tells_the_account() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let mut grum = FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z");
    grum.poses.remove(&CohostAvatarState::Think);
    grum.context = String::new();
    web.add(grum);
    let state = library_state(&root, &web).await;
    save_notes(&state, "Keep these").await;
    use_avatar(&state, use_params(AVATAR)).await.unwrap();
    settle(&state, |library| {
        library.active_avatar_id.as_deref() == Some(AVATAR)
    })
    .await;
    let settings = get_cohost_settings(&state).await;
    // Not listed yet: read on its own, then its pictures.
    assert!(
        web.seen()
            .contains(&format!("GET /api/buddy/avatars/{AVATAR}"))
    );
    assert!(
        settings.persona.images.think.is_none(),
        "think falls back to idle"
    );
    assert_eq!(
        settings.notes, "Keep these",
        "an empty About you keeps the notes"
    );
    assert_eq!(
        web.body_of("PUT /api/buddy/profile"),
        Some(serde_json::json!({ "activeAvatarId": AVATAR }))
    );
    assert_eq!(
        load_library_sync(&state.database).profile_updated_at,
        web.with(|fake| fake.profile_updated_at.clone())
    );
}

#[tokio::test]
async fn buddy_library_use_with_a_missing_idle_changes_nothing() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    web.with(|fake| fake.missing_pictures.push(format!("{AVATAR}/idle")));
    let state = library_state(&root, &web).await;
    use_avatar(&state, use_params(AVATAR)).await.unwrap();
    settle(&state, |library| library.error.is_some()).await;
    assert_eq!(get(&state).await.error.unwrap().code, "buddy-pose-missing");
    assert_eq!(persona(&state).await, CohostPersona::default());
    assert_eq!(web.count("PUT /api/buddy/profile"), 0);
}

// --- Update, delete, local edits -----------------------------------------------------------------------

async fn linked_state(root: &Path, web: &FakeLibrary) -> AppState {
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

async fn wait_for_call(web: &FakeLibrary, call: &str) {
    for _ in 0..300 {
        if web.count(call) > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no {call}: {:?}", web.seen());
}

#[tokio::test]
async fn buddy_library_local_edits_of_a_linked_avatar_are_pushed_once_after_a_pause() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_state(&root, &web).await;
    let mut edited = persona(&state).await;
    edited.name = "Grumble".to_string();
    save_persona(&state, edited.clone()).await;
    edited.personality = "Grumbles, then helps.".to_string();
    save_persona(&state, edited).await;
    save_notes(&state, "Speedruns on Fridays now.").await;
    let patch_call = format!("PATCH /api/buddy/avatars/{AVATAR}");
    wait_for_call(&web, &patch_call).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    settle(&state, |_| true).await;
    // One PATCH with the latest of each field (last write wins).
    assert_eq!(web.count(&patch_call), 1);
    assert_eq!(
        web.body_of(&patch_call),
        Some(serde_json::json!({
            "name": "Grumble",
            "personality": "Grumbles, then helps.",
            "context": "Speedruns on Fridays now."
        }))
    );
    assert_eq!(get(&state).await.mine.unwrap()[0].name, "Grumble");
    // Saving the same values again pushes nothing.
    save_persona(&state, persona(&state).await).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(web.count(&patch_call), 1);
}

#[tokio::test]
async fn buddy_library_edits_of_a_local_only_buddy_stay_local() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = library_state(&root, &web).await;
    save_persona(
        &state,
        CohostPersona {
            name: "Mossback".to_string(),
            ..CohostPersona::default()
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(web.seen().is_empty());
}

#[tokio::test]
async fn buddy_library_update_edits_the_account_and_the_buddy_follows() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_state(&root, &web).await;
    update(
        &state,
        CohostLibraryUpdateParams {
            avatar_id: AVATAR.to_string(),
            name: Some("Sir Grum".to_string()),
            personality: None,
            context: Some(String::new()),
        },
    )
    .await
    .unwrap();
    settle(&state, |library| {
        library
            .mine
            .as_ref()
            .is_some_and(|mine| mine[0].name == "Sir Grum")
    })
    .await;
    let settings = get_cohost_settings(&state).await;
    assert_eq!(settings.persona.name, "Sir Grum");
    assert_eq!(settings.notes, "");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        web.count(&format!("PATCH /api/buddy/avatars/{AVATAR}")),
        1,
        "the Buddy following its avatar is not pushed back"
    );
}

#[tokio::test]
async fn buddy_library_delete_removes_it_everywhere_and_unlinks_the_buddy() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = linked_state(&root, &web).await;
    let pictures = persona(&state).await.images;
    delete(&state, use_params(AVATAR)).await.unwrap();
    settle(&state, |library| {
        library.mine.as_ref().is_some_and(|mine| mine.is_empty())
    })
    .await;
    assert!(!root.join("library").join(AVATAR).exists());
    let after = persona(&state).await;
    assert_eq!(
        after.library_avatar_id, None,
        "the Buddy stays, now local only"
    );
    assert_eq!(after.images, pictures);
    assert_eq!(get(&state).await.active_avatar_id, None);
    // The account's choice was cleared with it, and so was its clock.
    assert_eq!(
        load_library_sync(&state.database).profile_updated_at,
        web.with(|fake| fake.profile_updated_at.clone())
    );
}

#[tokio::test]
async fn buddy_library_mutations_refuse_bad_ids_empty_edits_and_no_library() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    let state = library_state(&root, &web).await;
    let unknown = use_avatar(&state, use_params("official:dragon"))
        .await
        .unwrap_err();
    assert_eq!(unknown.code, COHOST_LIBRARY_INVALID);
    let official = delete(&state, use_params("official:golem"))
        .await
        .unwrap_err();
    assert_eq!(official.code, COHOST_LIBRARY_INVALID);
    let edit = |name: Option<&str>| CohostLibraryUpdateParams {
        avatar_id: AVATAR.to_string(),
        name: name.map(str::to_string),
        personality: None,
        context: None,
    };
    assert_eq!(
        update(&state, edit(None)).await.unwrap_err().code,
        COHOST_LIBRARY_INVALID
    );
    assert_eq!(
        update(&state, edit(Some(&"n".repeat(25))))
            .await
            .unwrap_err()
            .code,
        COHOST_LIBRARY_INVALID
    );
    state.buddy_library.cache().capability = Some(AiCapabilitiesBuddyLibrary::default());
    let off = delete(&state, use_params(AVATAR)).await.unwrap_err();
    assert_eq!(off.code, COHOST_LIBRARY_UNAVAILABLE);
    assert!(web.seen().is_empty());
}

#[tokio::test]
async fn buddy_library_unread_capability_says_when_the_web_cannot_be_reached() {
    // QA 2026-10-11: signed in, the app started while videorc.com could not
    // be reached, so the capability was never read: the tab sync stayed
    // quiet and My Buddies said "Buddies you create show up here" as if the
    // library were empty. Now the list is tried and the library says why.
    let root = temp_root();
    let mut state = test_state();
    state.buddy_library = Arc::new(LibraryShared::for_tests(
        LibraryEnv {
            root: Some(root.clone()),
            // Nothing listens on the discard port.
            api: Some(VideorcApiClient::for_base_url("http://127.0.0.1:9")),
            token: Some(BEARER.to_string()),
            ..LibraryEnv::default()
        },
        fast_timing(),
    ));
    *state.account_session.lock().await = crate::account::complete_mock_sign_in("orc_dev", true);
    assert!(state.buddy_library.cache().capability.is_none());
    request_sync(&state, BuddyLibrarySyncReason::Tab);
    settle(&state, |library| library.error.is_some()).await;
    let library = get(&state).await;
    assert_eq!(library.mine, None);
    let error = library.error.unwrap();
    assert_eq!(error.code, "network");
    assert_eq!(
        error.message,
        "Could not reach Videorc. Check your connection and try again."
    );

    // Not read yet but the web answers: the account's Buddies show.
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    let state = library_state(&root, &web).await;
    state.buddy_library.cache().capability = None;
    request_sync(&state, BuddyLibrarySyncReason::Tab);
    settle(&state, |library| library.mine.is_some()).await;
    let library = get(&state).await;
    assert_eq!(library.error, None);
    assert_eq!(library.mine.unwrap()[0].name, "Grum");

    // Known off: quiet, and the web is never asked.
    let quiet = spawn_fake_library().await;
    let state = library_state(&root, &quiet).await;
    state.buddy_library.cache().capability = Some(AiCapabilitiesBuddyLibrary::default());
    request_sync(&state, BuddyLibrarySyncReason::Tab);
    settle(&state, |_| true).await;
    assert_eq!(get(&state).await.error, None);
    assert!(quiet.seen().is_empty());
}

#[tokio::test]
async fn buddy_library_turning_on_syncs_and_turning_off_forgets_the_account() {
    let root = temp_root();
    let web = spawn_fake_library().await;
    web.add(FakeAvatar::new(AVATAR, "Grum", "2026-10-09T09:00:00.000Z"));
    let state = library_state(&root, &web).await;
    state.buddy_library.cache().capability = None;
    // Off: the account's cap is known, nothing is listed or fetched.
    set_capability(
        &state,
        Some(AiCapabilitiesBuddyLibrary {
            enabled: false,
            count: 1,
            limit: 25,
            alive: false,
        }),
    )
    .await;
    assert_eq!(get(&state).await.limit, 25);
    assert!(web.seen().is_empty());
    let on = AiCapabilitiesBuddyLibrary {
        enabled: true,
        count: 1,
        limit: 30,
        alive: true,
    };
    set_capability(&state, Some(on.clone())).await;
    settle(&state, |library| library.mine.is_some()).await;
    assert_eq!(get(&state).await.limit, 30);
    assert_eq!(web.count("GET /api/buddy/avatars"), 1);
    set_capability(&state, None).await;
    assert_eq!(get(&state).await.mine, None);
    // A focus sync right after a sync is skipped (at most once a minute).
    state.buddy_library.cache().capability = Some(on);
    request_sync(&state, BuddyLibrarySyncReason::Focus);
    settle(&state, |_| true).await;
    assert_eq!(web.count("GET /api/buddy/avatars"), 1);
}
