//! Backend transport roles and the command admission policy.
//!
//! Electron main receives the admin credential from the private backend
//! bootstrap pipe and must never forward it to preload. Renderers receive a
//! separate least-privilege credential. Method admission happens before JSON
//! parameters are interpreted or side effects begin.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendRole {
    Renderer,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodAdmissionError {
    AdminOnly,
    SmokeDisabled,
}

impl MethodAdmissionError {
    pub fn code(self) -> &'static str {
        match self {
            Self::AdminOnly => "forbidden-method",
            Self::SmokeDisabled => "smoke-method-disabled",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::AdminOnly => "This backend method is restricted to Electron main.",
            Self::SmokeDisabled => "This smoke/test backend method is unavailable in this process.",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendBootstrap {
    pub host: String,
    pub port: u16,
    /// Renderer-scoped credential. This is the only backend secret preload may
    /// receive.
    pub token: String,
    /// Main-process credential. Electron strips this field before logging,
    /// emitting smoke markers, or notifying any renderer.
    pub admin_token: String,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_pid: Option<u32>,
}

pub fn authenticate_backend_token(
    supplied: &str,
    renderer_token: &str,
    admin_token: &str,
) -> Option<BackendRole> {
    if constant_time_equal(supplied.as_bytes(), admin_token.as_bytes()) {
        Some(BackendRole::Admin)
    } else if constant_time_equal(supplied.as_bytes(), renderer_token.as_bytes()) {
        Some(BackendRole::Renderer)
    } else {
        None
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut different = left.len() ^ right.len();
    let width = left.len().max(right.len());
    for index in 0..width {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        different |= usize::from(a ^ b);
    }
    different == 0
}

pub fn authorize_backend_method(
    role: BackendRole,
    method: &str,
    smoke_rpc_enabled: bool,
) -> Result<(), MethodAdmissionError> {
    if smoke_or_test_method(method) {
        if role != BackendRole::Admin {
            return Err(MethodAdmissionError::AdminOnly);
        }
        if !cfg!(debug_assertions) || !smoke_rpc_enabled {
            return Err(MethodAdmissionError::SmokeDisabled);
        }
        return Ok(());
    }

    if admin_only_method(method) && role != BackendRole::Admin {
        return Err(MethodAdmissionError::AdminOnly);
    }
    Ok(())
}

fn smoke_or_test_method(method: &str) -> bool {
    method == "encoder_bridge.synthetic_record"
        || method == "recording.start_test"
        || method.starts_with("test.")
        || method.contains(".test.")
        || method.ends_with(".test")
}

fn admin_only_method(method: &str) -> bool {
    method.starts_with("resource.capability.")
        || method.starts_with("resource.admin.")
        || matches!(
            method,
            "account.auth.begin_intent"
                | "account.sign_out"
                | "compositor.scene.update"
                | "preview.surface.take_native_host_commands"
                | "sessions.delete.resolve"
                | "sessions.delete.complete"
                | "sessions.delete.complete_admin"
        )
}

/// Only debug admin sockets admitted by the explicit smoke runtime switch may
/// use a caller-selected binary. Renderer and release requests always resolve
/// to the trusted bundled/default executable.
pub fn ffmpeg_override_allowed(role: BackendRole, smoke_rpc_enabled: bool) -> bool {
    cfg!(debug_assertions) && role == BackendRole::Admin && smoke_rpc_enabled
}

pub fn resolve_trusted_ffmpeg_path(
    requested: Option<&str>,
    role: BackendRole,
    smoke_rpc_enabled: bool,
) -> String {
    if ffmpeg_override_allowed(role, smoke_rpc_enabled) {
        crate::ffmpeg::resolve_ffmpeg_path_ref(requested)
    } else {
        crate::ffmpeg::default_ffmpeg_path()
    }
}

pub fn scrub_untrusted_ffmpeg_paths(
    value: &mut serde_json::Value,
    role: BackendRole,
    smoke_rpc_enabled: bool,
) {
    if ffmpeg_override_allowed(role, smoke_rpc_enabled) {
        return;
    }
    scrub_ffmpeg_paths_recursive(value);
}

fn scrub_ffmpeg_paths_recursive(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.remove("ffmpegPath");
            for child in object.values_mut() {
                scrub_ffmpeg_paths_recursive(child);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                scrub_ffmpeg_paths_recursive(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_and_admin_credentials_are_distinct_roles() {
        assert_eq!(
            authenticate_backend_token("renderer-secret", "renderer-secret", "admin-secret"),
            Some(BackendRole::Renderer)
        );
        assert_eq!(
            authenticate_backend_token("admin-secret", "renderer-secret", "admin-secret"),
            Some(BackendRole::Admin)
        );
        assert_eq!(
            authenticate_backend_token("forged", "renderer-secret", "admin-secret"),
            None
        );
    }

    #[test]
    fn renderer_is_default_denied_for_admin_and_smoke_namespaces() {
        for method in [
            "resource.capability.issue",
            "resource.capability.revoke",
            "resource.admin.any_future_method",
            "sessions.delete.resolve",
            "preview.surface.take_native_host_commands",
            "compositor.scene.update",
            "account.auth.begin_intent",
            "account.sign_out",
            "encoder_bridge.synthetic_record",
            "recording.start_test",
            "captions.test.inject-audio",
            "audio.test.inject-pcm",
            "test.future.mutation",
        ] {
            assert_eq!(
                authorize_backend_method(BackendRole::Renderer, method, true),
                Err(MethodAdmissionError::AdminOnly),
                "renderer unexpectedly admitted {method}"
            );
        }
    }

    #[test]
    fn smoke_methods_need_debug_build_and_explicit_runtime_switch() {
        assert_eq!(
            authorize_backend_method(BackendRole::Admin, "encoder_bridge.synthetic_record", false),
            Err(MethodAdmissionError::SmokeDisabled)
        );
        let admitted =
            authorize_backend_method(BackendRole::Admin, "encoder_bridge.synthetic_record", true);
        if cfg!(debug_assertions) {
            assert_eq!(admitted, Ok(()));
        } else {
            assert_eq!(admitted, Err(MethodAdmissionError::SmokeDisabled));
        }
    }

    #[test]
    fn renderer_ffmpeg_override_is_removed_recursively() {
        let mut params = serde_json::json!({
            "ffmpegPath": "/tmp/arbitrary-sentinel",
            "output": { "ffmpegPath": "C:\\\\sentinel.exe" },
            "untouched": true
        });
        scrub_untrusted_ffmpeg_paths(&mut params, BackendRole::Renderer, true);
        assert_eq!(
            params,
            serde_json::json!({ "output": {}, "untouched": true })
        );
    }

    #[test]
    fn release_policy_never_allows_arbitrary_ffmpeg_override() {
        if !cfg!(debug_assertions) {
            assert!(!ffmpeg_override_allowed(BackendRole::Admin, true));
        }
        assert!(!ffmpeg_override_allowed(BackendRole::Renderer, true));
    }

    #[test]
    fn arbitrary_executable_sentinel_never_becomes_renderer_process_authority() {
        let sentinel = if cfg!(windows) {
            r"C:\temp\videorc-arbitrary-sentinel.exe"
        } else {
            "/tmp/videorc-arbitrary-sentinel"
        };
        let resolved = resolve_trusted_ffmpeg_path(Some(sentinel), BackendRole::Renderer, true);
        assert_ne!(resolved, sentinel);
        assert_eq!(resolved, crate::ffmpeg::default_ffmpeg_path());
    }

    #[test]
    fn serialized_renderer_connection_never_contains_admin_secret() {
        let public = crate::protocol::BackendConnection {
            host: "127.0.0.1".to_string(),
            port: 7777,
            token: "renderer-only".to_string(),
            pid: 42,
            parent_pid: None,
        };
        let serialized = serde_json::to_string(&public).unwrap();
        assert!(serialized.contains("renderer-only"));
        assert!(!serialized.contains("admin"));
        assert!(!serialized.contains("adminToken"));
    }
}
