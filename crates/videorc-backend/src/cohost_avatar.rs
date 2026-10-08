//! The Golem's avatar generation (plan 164 S-A6, D21).
//!
//! `cohost.avatar.generate` accepts one request and answers at once; the
//! web call (up to 95 s) runs on its own task so the websocket mutation lane
//! and its 10 s deadline never wait on a model. The outcome arrives as the
//! `cohost.avatar.generated` event: the stored relative path for the persona
//! to keep, whether the model returned an opaque image, or one error the
//! tile shows. The desktop never calls a model itself: videorc-web owns the
//! model id (`VIDEORC_AI_AVATAR_IMAGE_MODEL`) and the daily cap.
//!
//! Images land in the managed golem-assets root main hands over as
//! `VIDEORC_MANAGED_GOLEM_ROOTS` (S-A3): `<root>/<personaId>/<state>.png`,
//! the folder uploads use, so one persona is one folder. The idle image is
//! generated first and the other states are edits of it (the renderer
//! sequences them); for a non-idle state the persona's current idle image
//! rides along as the base when it is a PNG or WebP under the root.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::cohost::{CohostAvatarState, CohostPersona};
use crate::protocol::{CohostAvatarErrorDetail, CohostAvatarGeneratedEvent};
use crate::state::AppState;
use crate::videorc_api::{CohostApiError, CohostAvatarRequest, VideorcApiClient};

pub const COHOST_AVATAR_GENERATED_EVENT: &str = "cohost.avatar.generated";
/// The web route's prompt bound (S-A5): 1 to 600 UTF-16 units.
pub const COHOST_AVATAR_PROMPT_MAX_CHARS: usize = 600;
/// A base image rides as base64 and must decode under 4 MB (S-A5).
pub const COHOST_AVATAR_BASE_IMAGE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// A generated PNG is refused above this before it is written (S-A6).
pub const COHOST_AVATAR_PNG_MAX_BYTES: usize = 8 * 1024 * 1024;
const COHOST_AVATAR_MAX_PIXELS: u64 = 20_000_000;

/// The tile hints the plan names (S-A5, S-A6) for the web's error codes.
pub const COHOST_AVATAR_QUOTA_HINT: &str = "Daily avatar limit reached";
pub const COHOST_AVATAR_UNAVAILABLE_HINT: &str = "Not available yet";

/// One generation at a time per process: a second request while one runs
/// is refused instead of queued, so a tile never shows two outcomes.
static GENERATION_BUSY: AtomicBool = AtomicBool::new(false);

/// The style presets the web route takes (⚑ plan 164 S-A4).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAvatarStyle {
    Cartoon,
    Pixel,
    Painted,
    Sticker,
}

/// Why `cohost.avatar.generate` was refused before anything was sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohostAvatarRefusal {
    pub code: &'static str,
    pub message: String,
}

impl CohostAvatarRefusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The prompt as the route takes it, or why it cannot be sent.
pub(crate) fn shape_prompt(prompt: &str) -> Result<String, CohostAvatarRefusal> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(CohostAvatarRefusal::new(
            "cohost-avatar-prompt-empty",
            "Describe your Golem first.",
        ));
    }
    let units: usize = prompt.chars().map(char::len_utf16).sum();
    if units > COHOST_AVATAR_PROMPT_MAX_CHARS {
        return Err(CohostAvatarRefusal::new(
            "cohost-avatar-prompt-too-long",
            format!("The description is at most {COHOST_AVATAR_PROMPT_MAX_CHARS} characters."),
        ));
    }
    Ok(prompt.to_string())
}

/// The first configured golem-assets root: where every image is written.
pub(crate) fn managed_golem_root() -> Option<PathBuf> {
    crate::resource_authority::configured_managed_golem_roots()
        .into_iter()
        .next()
}

/// `<personaId>/<state>.png`, the value the persona stores.
pub(crate) fn avatar_relative_path(persona_id: &str, state: CohostAvatarState) -> String {
    format!("{persona_id}/{}.png", state.as_str())
}

fn persona_id_ok(persona_id: &str) -> bool {
    !persona_id.is_empty()
        && persona_id.len() <= 128
        && persona_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The persona's idle image as the route's `baseImage` (base64), for a
/// non-idle state: only a stored `<personaId>/idle.(png|webp)` under the
/// root, at most 4 MB. A JPEG idle (no alpha) or a missing one means no
/// base: the state is generated from the prompt alone, never refused.
pub(crate) fn base_image_for(
    root: &Path,
    persona: &CohostPersona,
    state: CohostAvatarState,
) -> Option<String> {
    use base64::Engine as _;
    if state == CohostAvatarState::Idle {
        return None;
    }
    let relative = persona.images.idle.as_deref()?;
    let (folder, file) = relative.split_once('/')?;
    if folder != persona.id || !persona_id_ok(folder) {
        return None;
    }
    if !matches!(file, "idle.png" | "idle.webp") {
        return None;
    }
    let path = root.join(folder).join(file);
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > COHOST_AVATAR_BASE_IMAGE_MAX_BYTES {
        return None;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The route's PNG, checked and written as `<root>/<personaId>/<state>.png`:
/// valid base64, at most 8 MB, a PNG that decodes under 20 megapixels. A
/// state keeps one file, so an earlier `.webp` or `.jpg` upload for it goes.
pub(crate) fn store_avatar_png(
    root: &Path,
    persona_id: &str,
    state: CohostAvatarState,
    png_base64: &str,
) -> Result<String, CohostAvatarErrorDetail> {
    use base64::Engine as _;
    if !persona_id_ok(persona_id) {
        return Err(CohostAvatarErrorDetail::new(
            "cohost-avatar-persona-invalid",
            "The persona id is not a plain token.",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|_| {
            CohostAvatarErrorDetail::new(
                "avatar-image-unreadable",
                "The generated image could not be read.",
            )
        })?;
    if bytes.is_empty() || bytes.len() > COHOST_AVATAR_PNG_MAX_BYTES {
        return Err(CohostAvatarErrorDetail::new(
            "avatar-image-unreadable",
            "The generated image is empty or over 8 MB.",
        ));
    }
    if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
        return Err(CohostAvatarErrorDetail::new(
            "avatar-image-unreadable",
            "The generated image is not a PNG.",
        ));
    }
    let (width, height) = image::load_from_memory(&bytes)
        .map(|decoded| (u64::from(decoded.width()), u64::from(decoded.height())))
        .map_err(|_| {
            CohostAvatarErrorDetail::new(
                "avatar-image-unreadable",
                "The generated image could not be decoded.",
            )
        })?;
    if width == 0 || height == 0 || width * height > COHOST_AVATAR_MAX_PIXELS {
        return Err(CohostAvatarErrorDetail::new(
            "avatar-image-unreadable",
            "The generated image has an unusable size.",
        ));
    }
    let folder = root.join(persona_id);
    std::fs::create_dir_all(&folder).map_err(|error| {
        CohostAvatarErrorDetail::new(
            "cohost-avatar-store-failed",
            format!("Could not create the Golem's image folder: {error}"),
        )
    })?;
    let file = folder.join(format!("{}.png", state.as_str()));
    std::fs::write(&file, &bytes).map_err(|error| {
        CohostAvatarErrorDetail::new(
            "cohost-avatar-store-failed",
            format!("Could not save the generated image: {error}"),
        )
    })?;
    for other in ["webp", "jpg"] {
        let _ = std::fs::remove_file(folder.join(format!("{}.{other}", state.as_str())));
    }
    Ok(avatar_relative_path(persona_id, state))
}

/// The one line a tile shows for a failed call (S-A5 codes, S-A6 copy).
pub(crate) fn tile_error(error: &CohostApiError) -> CohostAvatarErrorDetail {
    let code = error.detail.code.as_str();
    let message = match code {
        "quota-exhausted" => COHOST_AVATAR_QUOTA_HINT.to_string(),
        "avatar-model-unconfigured"
        | "avatar-disabled"
        | "cohost-disabled"
        | "ai-gateway-not-configured" => COHOST_AVATAR_UNAVAILABLE_HINT.to_string(),
        "unauthorized" => "Sign in again to generate images.".to_string(),
        "premium-required" => "Generating images requires Videorc Premium.".to_string(),
        "avatar-timeout" | "timeout" => "The model took too long. Try again.".to_string(),
        _ => error.detail.message.clone(),
    };
    CohostAvatarErrorDetail::new_owned(error.detail.code.clone(), message)
}

/// Accept one generation and run it on its own task (see the module doc).
/// Refused before anything is sent when the prompt is out of bounds, the
/// account is Basic or signed out, no managed root is configured, or one is
/// already running.
pub async fn generate(
    state: AppState,
    params: crate::protocol::CohostAvatarGenerateParams,
) -> Result<crate::protocol::CohostAvatarGenerateAccepted, CohostAvatarRefusal> {
    let prompt = shape_prompt(&params.prompt)?;
    if !crate::cohost::premium_entitled() {
        return Err(CohostAvatarRefusal::new(
            "premium-required",
            "Generating images requires Videorc Premium.",
        ));
    }
    let Some(root) = managed_golem_root() else {
        return Err(CohostAvatarRefusal::new(
            "cohost-avatar-root-unconfigured",
            "The Golem's image folder is not configured.",
        ));
    };
    let Some(token) = crate::account::stored_session_token() else {
        return Err(CohostAvatarRefusal::new(
            "signed-out",
            "Sign in to generate images.",
        ));
    };
    let persona = state.cohost.lock().await.settings().persona.clone();
    if !persona_id_ok(&persona.id) {
        return Err(CohostAvatarRefusal::new(
            "cohost-avatar-persona-invalid",
            "The persona id is not a plain token.",
        ));
    }
    if GENERATION_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(CohostAvatarRefusal::new(
            "cohost-avatar-busy",
            "An image is already being generated.",
        ));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let accepted = crate::protocol::CohostAvatarGenerateAccepted {
        request_id: request_id.clone(),
        state: params.state,
    };
    let avatar_state = params.state;
    let style = params.style;
    tokio::spawn(async move {
        let outcome = run_generation(&root, &persona, avatar_state, prompt, style, &token).await;
        GENERATION_BUSY.store(false, Ordering::Release);
        let event = match outcome {
            Ok((path, opaque)) => CohostAvatarGeneratedEvent {
                request_id,
                state: avatar_state,
                path: Some(path),
                opaque,
                error: None,
            },
            Err(error) => {
                state.emit_log(
                    "warn",
                    format!(
                        "Golem avatar generation for {} failed ({}): {}",
                        avatar_state.as_str(),
                        error.code,
                        error.message
                    ),
                );
                CohostAvatarGeneratedEvent {
                    request_id,
                    state: avatar_state,
                    path: None,
                    opaque: false,
                    error: Some(error),
                }
            }
        };
        state.emit_event(COHOST_AVATAR_GENERATED_EVENT, event);
    });
    Ok(accepted)
}

async fn run_generation(
    root: &Path,
    persona: &CohostPersona,
    state: CohostAvatarState,
    prompt: String,
    style: CohostAvatarStyle,
    token: &str,
) -> Result<(String, bool), CohostAvatarErrorDetail> {
    let request = CohostAvatarRequest {
        prompt,
        style,
        state,
        base_image: base_image_for(root, persona, state),
    };
    let client = VideorcApiClient::new().map_err(|error| {
        CohostAvatarErrorDetail::new_owned("network".to_string(), error.to_string())
    })?;
    let response = client
        .post_cohost_avatar(token, &request)
        .await
        .map_err(|error| tile_error(&error))?;
    let path = store_avatar_png(root, &persona.id, state, &response.png_base64)?;
    Ok((path, response.opaque))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohost::CohostErrorDetail;
    use crate::cohost::{CohostPersonaImages, CohostPersonaSource};
    use crate::videorc_api::CohostApiErrorKind;
    use base64::Engine as _;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 0]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("videorc-golem-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn persona(id: &str, idle: Option<&str>) -> CohostPersona {
        CohostPersona {
            id: id.to_string(),
            name: "Grum".to_string(),
            personality: String::new(),
            bubble_style: Default::default(),
            images: CohostPersonaImages {
                idle: idle.map(str::to_string),
                ..CohostPersonaImages::default()
            },
            source: CohostPersonaSource::Generated,
        }
    }

    #[test]
    fn prompt_is_trimmed_and_bounded() {
        assert_eq!(shape_prompt("  a stone golem  ").unwrap(), "a stone golem");
        assert_eq!(
            shape_prompt("   ").unwrap_err().code,
            "cohost-avatar-prompt-empty"
        );
        assert_eq!(
            shape_prompt(&"p".repeat(601)).unwrap_err().code,
            "cohost-avatar-prompt-too-long"
        );
        assert!(shape_prompt(&"p".repeat(600)).is_ok());
    }

    #[test]
    fn stores_a_png_under_the_persona_folder_and_drops_an_older_upload_for_that_state() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("p-1")).unwrap();
        std::fs::write(root.join("p-1").join("laugh.webp"), b"old").unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes(2, 2));
        let path = store_avatar_png(&root, "p-1", CohostAvatarState::Laugh, &encoded).unwrap();
        assert_eq!(path, "p-1/laugh.png");
        assert!(root.join("p-1").join("laugh.png").is_file());
        assert!(!root.join("p-1").join("laugh.webp").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_what_is_not_a_small_png_before_writing() {
        let root = temp_root();
        let not_base64 = store_avatar_png(&root, "p", CohostAvatarState::Idle, "***").unwrap_err();
        assert_eq!(not_base64.code, "avatar-image-unreadable");
        let jpeg = base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff, 0xe0]);
        assert_eq!(
            store_avatar_png(&root, "p", CohostAvatarState::Idle, &jpeg)
                .unwrap_err()
                .message,
            "The generated image is not a PNG."
        );
        let escaped = base64::engine::general_purpose::STANDARD.encode(png_bytes(1, 1));
        assert_eq!(
            store_avatar_png(&root, "../p", CohostAvatarState::Idle, &escaped)
                .unwrap_err()
                .code,
            "cohost-avatar-persona-invalid"
        );
        assert!(!root.join("p").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_idle_image_rides_as_the_base_for_other_states_only() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("p")).unwrap();
        std::fs::write(root.join("p").join("idle.png"), png_bytes(1, 1)).unwrap();
        let with_idle = persona("p", Some("p/idle.png"));
        assert!(base_image_for(&root, &with_idle, CohostAvatarState::Idle).is_none());
        let base = base_image_for(&root, &with_idle, CohostAvatarState::Talk).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(base)
                .unwrap(),
            png_bytes(1, 1)
        );
        // Another persona's folder, a JPEG idle (no alpha) and a missing
        // idle all mean "no base", never a refusal.
        assert!(
            base_image_for(
                &root,
                &persona("p", Some("q/idle.png")),
                CohostAvatarState::Talk
            )
            .is_none()
        );
        assert!(
            base_image_for(
                &root,
                &persona("p", Some("p/idle.jpg")),
                CohostAvatarState::Talk
            )
            .is_none()
        );
        assert!(base_image_for(&root, &persona("p", None), CohostAvatarState::Talk).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn web_error_codes_become_the_tile_hints_the_plan_names() {
        let error = |code: &str, message: &str| CohostApiError {
            kind: CohostApiErrorKind::GatewayError,
            detail: CohostErrorDetail::new(code, message, Some(500)),
        };
        assert_eq!(
            tile_error(&error("quota-exhausted", "x")).message,
            COHOST_AVATAR_QUOTA_HINT
        );
        for code in [
            "avatar-model-unconfigured",
            "avatar-disabled",
            "cohost-disabled",
            "ai-gateway-not-configured",
        ] {
            assert_eq!(
                tile_error(&error(code, "x")).message,
                COHOST_AVATAR_UNAVAILABLE_HINT,
                "{code}"
            );
        }
        let passthrough = tile_error(&error("ai-gateway-error", "The model said no."));
        assert_eq!(passthrough.code, "ai-gateway-error");
        assert_eq!(passthrough.message, "The model said no.");
    }

    #[test]
    fn avatar_request_wire_shape_matches_the_route() {
        let request = CohostAvatarRequest {
            prompt: "a golem".to_string(),
            style: CohostAvatarStyle::Sticker,
            state: CohostAvatarState::Laugh,
            base_image: Some("AAAA".to_string()),
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["prompt"], "a golem");
        assert_eq!(json["style"], "sticker");
        assert_eq!(json["state"], "laugh");
        assert_eq!(json["baseImage"], "AAAA");
        let idle = CohostAvatarRequest {
            base_image: None,
            ..request
        };
        assert!(
            serde_json::to_value(&idle)
                .unwrap()
                .get("baseImage")
                .is_none()
        );
        let response: crate::videorc_api::CohostAvatarResponse =
            serde_json::from_str(r#"{"pngBase64":"AAAA"}"#).unwrap();
        assert!(!response.opaque);
        assert_eq!(response.png_base64, "AAAA");
    }
}
