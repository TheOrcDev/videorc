//! Typed, short-lived authority for filesystem resources selected by Electron main.
//!
//! Renderer processes never get to turn an arbitrary string into filesystem or
//! process authority. Main owns the native picker, registers the selected path
//! over the admin-authenticated backend channel, and gives the renderer only the
//! opaque capability id. Every use is kind-checked, expires, and is consumed.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::{
    SessionFileObjectIdentity, capture_session_directory_object_identity,
    capture_session_file_object_identity,
};

const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_USES: u32 = 16;
const MAX_ACTIVE_RESOURCE_CAPABILITIES: usize = 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceCapabilityKind {
    InputFile,
    OutputDirectory,
    OpenPath,
    RevealPath,
    TrashPath,
    BackgroundAsset,
}

impl ResourceCapabilityKind {
    fn requires_file(self) -> bool {
        matches!(self, Self::InputFile | Self::BackgroundAsset)
    }

    fn requires_directory(self) -> bool {
        matches!(self, Self::OutputDirectory)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueResourceCapabilityParams {
    pub kind: ResourceCapabilityKind,
    pub path: String,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
    #[serde(default)]
    pub use_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssuedResourceCapability {
    pub capability_id: String,
    pub kind: ResourceCapabilityKind,
    pub expires_in_ms: u64,
    pub use_count: u32,
}

#[derive(Debug, Clone)]
struct ResourceCapability {
    kind: ResourceCapabilityKind,
    canonical_path: PathBuf,
    object_identity: SessionFileObjectIdentity,
    expires_at: Instant,
    remaining_uses: u32,
}

#[derive(Debug, Clone, Default)]
pub struct ResourceAuthority {
    entries: Arc<Mutex<HashMap<String, ResourceCapability>>>,
    managed_backgrounds: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl ResourceAuthority {
    pub fn issue(&self, params: IssueResourceCapabilityParams) -> Result<IssuedResourceCapability> {
        self.issue_at(params, Instant::now())
    }

    fn issue_at(
        &self,
        params: IssueResourceCapabilityParams,
        now: Instant,
    ) -> Result<IssuedResourceCapability> {
        let canonical_path = canonicalize_resource_path(&params.path, params.kind)?;
        let object_identity = capture_resource_object_identity(&canonical_path, params.kind)?;
        let ttl = Duration::from_millis(params.ttl_ms.unwrap_or(DEFAULT_TTL.as_millis() as u64));
        if ttl.is_zero() || ttl > MAX_TTL {
            bail!("Resource capability TTL must be between 1ms and 15 minutes.");
        }
        let use_count = params.use_count.unwrap_or(1);
        if !(1..=MAX_USES).contains(&use_count) {
            bail!("Resource capability use count must be between 1 and {MAX_USES}.");
        }

        let capability_id = format!("resource:{}", Uuid::new_v4());
        let entry = ResourceCapability {
            kind: params.kind,
            canonical_path,
            object_identity,
            expires_at: now + ttl,
            remaining_uses: use_count,
        };
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sweep_expired_capabilities(&mut entries, now);
        if entries.len() >= MAX_ACTIVE_RESOURCE_CAPABILITIES {
            bail!(
                "Resource capability capacity ({MAX_ACTIVE_RESOURCE_CAPABILITIES}) was reached. Consume or revoke an existing selection and try again."
            );
        }
        entries.insert(capability_id.clone(), entry);

        Ok(IssuedResourceCapability {
            capability_id,
            kind: params.kind,
            expires_in_ms: ttl.as_millis() as u64,
            use_count,
        })
    }

    pub fn consume(
        &self,
        capability_id: &str,
        expected_kind: ResourceCapabilityKind,
    ) -> Result<PathBuf> {
        self.consume_at(capability_id, expected_kind, Instant::now())
    }

    fn consume_at(
        &self,
        capability_id: &str,
        expected_kind: ResourceCapabilityKind,
        now: Instant,
    ) -> Result<PathBuf> {
        if !valid_capability_id(capability_id) {
            bail!("Resource capability is invalid.");
        }
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let requested_capability_expired = entries
            .get(capability_id)
            .is_some_and(|entry| now >= entry.expires_at);
        sweep_expired_capabilities(&mut entries, now);
        if requested_capability_expired {
            bail!("Resource capability has expired.");
        }
        let Some(entry) = entries.get(capability_id) else {
            bail!("Resource capability is unknown or has already been consumed.");
        };
        if entry.kind != expected_kind {
            // Wrong-kind attempts must not burn the legitimate operation.
            bail!(
                "Resource capability kind mismatch: expected {:?}, got {:?}.",
                expected_kind,
                entry.kind
            );
        }

        let canonical_path =
            match canonicalize_existing_resource_path(&entry.canonical_path, entry.kind) {
                Ok(path) if path == entry.canonical_path => path,
                Ok(_) => {
                    entries.remove(capability_id);
                    bail!("Resource capability path identity changed. Pick the resource again.");
                }
                Err(error) => {
                    entries.remove(capability_id);
                    return Err(error).context(
                        "Resource capability path is no longer the selected filesystem object",
                    );
                }
            };
        let current_identity = match capture_resource_object_identity(&canonical_path, entry.kind) {
            Ok(identity) => identity,
            Err(error) => {
                entries.remove(capability_id);
                return Err(error).context(
                    "Resource capability path is no longer the selected filesystem object",
                );
            }
        };
        if current_identity != entry.object_identity {
            entries.remove(capability_id);
            bail!("Resource capability filesystem object changed. Pick the resource again.");
        }

        let entry = entries
            .get_mut(capability_id)
            .expect("entry remains present after validation");
        let path = canonical_path;
        entry.remaining_uses -= 1;
        if entry.remaining_uses == 0 {
            entries.remove(capability_id);
        }
        Ok(path)
    }

    pub fn revoke(&self, capability_id: &str) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(capability_id)
            .is_some()
    }

    #[cfg(test)]
    fn active_entry_count_at(&self, now: Instant) -> usize {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sweep_expired_capabilities(&mut entries, now);
        entries.len()
    }

    pub fn register_managed_background(&self, asset_id: &str, raw_path: &str) -> Result<()> {
        validate_asset_id(asset_id)?;
        let canonical =
            canonicalize_resource_path(raw_path, ResourceCapabilityKind::BackgroundAsset)?;
        validate_managed_background_path(&canonical)?;
        self.managed_backgrounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(asset_id.to_string(), canonical);
        Ok(())
    }

    pub fn resolve_managed_background(&self, asset_id: &str) -> Result<PathBuf> {
        validate_asset_id(asset_id)?;
        let path = self
            .managed_backgrounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(asset_id)
            .cloned()
            .with_context(|| format!("Managed background asset {asset_id} is not registered."))?;
        validate_managed_background_path(&path)?;
        Ok(path)
    }
}

pub fn validate_asset_id(asset_id: &str) -> Result<()> {
    if asset_id.is_empty()
        || asset_id.len() > 128
        || !asset_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        bail!("Managed asset id is invalid.");
    }
    Ok(())
}

fn valid_capability_id(value: &str) -> bool {
    value
        .strip_prefix("resource:")
        .and_then(|uuid| Uuid::parse_str(uuid).ok())
        .is_some()
}

pub fn canonicalize_resource_path(raw_path: &str, kind: ResourceCapabilityKind) -> Result<PathBuf> {
    validate_path_syntax(raw_path)?;
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        bail!("Resource path must be absolute.");
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        bail!("Resource path may not contain parent traversal.");
    }

    canonicalize_existing_resource_path(path, kind)
}

fn canonicalize_existing_resource_path(
    path: &Path,
    kind: ResourceCapabilityKind,
) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)
        .with_context(|| "Resource path does not exist or could not be resolved.")?;
    let metadata = std::fs::metadata(&canonical)
        .with_context(|| "Resource path metadata could not be read.")?;
    if kind.requires_file() && !metadata.is_file() {
        bail!("Resource capability requires a regular file.");
    }
    if kind.requires_directory() && !metadata.is_dir() {
        bail!("Resource capability requires a directory.");
    }
    if !metadata.is_file() && !metadata.is_dir() {
        bail!("Resource capability requires a regular file or directory.");
    }
    Ok(canonical)
}

fn capture_resource_object_identity(
    path: &Path,
    kind: ResourceCapabilityKind,
) -> Result<SessionFileObjectIdentity> {
    let metadata =
        std::fs::metadata(path).with_context(|| "Resource path metadata could not be read.")?;
    if kind.requires_file() || metadata.is_file() {
        return capture_session_file_object_identity(path)?
            .context("Resource file disappeared while its identity was being captured.");
    }
    if kind.requires_directory() || metadata.is_dir() {
        return capture_session_directory_object_identity(path)?
            .context("Resource directory disappeared while its identity was being captured.");
    }
    bail!("Resource capability requires a regular file or directory.")
}

/// Replace compositor-only managed background paths before a payload crosses
/// back to Electron/renderer. The asset id remains the authority; the URL is a
/// display/read surface handled by Electron's managed protocol, never a local
/// filesystem capability.
pub fn redact_managed_background_paths(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            if object
                .get("assetId")
                .and_then(serde_json::Value::as_str)
                .is_some()
                && let Some(raw_path) = object
                    .get("managedAssetPath")
                    .and_then(serde_json::Value::as_str)
                && !raw_path.starts_with("videorc-asset://")
                && let Some(file_name) = Path::new(raw_path)
                    .file_name()
                    .and_then(|name| name.to_str())
            {
                object.insert(
                    "managedAssetPath".to_string(),
                    serde_json::Value::String(format!("videorc-asset://background/{file_name}")),
                );
            }
            for child in object.values_mut() {
                redact_managed_background_paths(child);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                redact_managed_background_paths(child);
            }
        }
        _ => {}
    }
}

/// Screen paths are compositor authority owned by the backend. Renderer
/// responses need only the managed protocol URL used for thumbnails; keeping
/// an absolute path in screens.list/events needlessly exposes app-data layout.
pub fn redact_managed_screen_paths(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            let stream_screen = object.contains_key("sortOrder")
                && object.contains_key("status")
                && object.contains_key("imagePath");
            let compositor_screen_source =
                object.get("kind").and_then(serde_json::Value::as_str) == Some("screen-image");
            if stream_screen || compositor_screen_source {
                for field in ["imagePath", "thumbnailPath"] {
                    if let Some(raw_path) = object.get(field).and_then(serde_json::Value::as_str)
                        && !raw_path.is_empty()
                        && !raw_path.starts_with("videorc-asset://")
                        && let Some(file_name) = Path::new(raw_path)
                            .file_name()
                            .and_then(|name| name.to_str())
                    {
                        object.insert(
                            field.to_string(),
                            serde_json::Value::String(format!(
                                "videorc-asset://screen/{file_name}"
                            )),
                        );
                    }
                }
            }
            for child in object.values_mut() {
                redact_managed_screen_paths(child);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                redact_managed_screen_paths(child);
            }
        }
        _ => {}
    }
}

/// Cross-platform lexical rejection. These Windows namespaces are dangerous
/// even when a forged value is tested on Unix, so the policy is deterministic
/// across build hosts and cross-compilation.
pub fn validate_path_syntax(raw_path: &str) -> Result<()> {
    if raw_path.is_empty() || raw_path.trim() != raw_path || raw_path.contains('\0') {
        bail!("Resource path is empty, padded, or contains NUL.");
    }
    if raw_path
        .split(['/', '\\'])
        .any(|component| component == "..")
    {
        bail!("Resource path may not contain parent traversal.");
    }
    let normalized = raw_path.replace('/', "\\");
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("\\\\?\\")
        || lower.starts_with("\\\\.\\")
        || lower.starts_with("\\??\\")
        || lower.starts_with("\\device\\")
        || lower.starts_with("\\\\")
    {
        bail!("Windows device and UNC paths are not accepted as renderer resources.");
    }
    let bytes = raw_path.as_bytes();
    if bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes
            .get(2)
            .is_none_or(|separator| !matches!(separator, b'/' | b'\\'))
    {
        bail!("Drive-relative paths are not accepted.");
    }
    Ok(())
}

pub fn canonical_path_is_within(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(canonical_path) = std::fs::canonicalize(path) else {
        return false;
    };
    roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .ok()
            .is_some_and(|canonical_root| canonical_path.starts_with(canonical_root))
    })
}

fn sweep_expired_capabilities(entries: &mut HashMap<String, ResourceCapability>, now: Instant) {
    entries.retain(|_, entry| now < entry.expires_at);
}

pub fn configured_managed_background_roots() -> Vec<PathBuf> {
    std::env::var_os("VIDEORC_MANAGED_BACKGROUND_ROOTS")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

pub fn validate_managed_background_path(path: &Path) -> Result<()> {
    let roots = configured_managed_background_roots();
    if roots.is_empty() {
        if cfg!(debug_assertions) {
            // Unit tests and bare `cargo run` do not have Electron's app-data
            // roots. Packaged/release processes fail closed below.
            return Ok(());
        }
        bail!("Managed background roots are not configured.");
    }
    if !canonical_path_is_within(path, &roots) {
        bail!("Scene background is outside Videorc-managed asset roots.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> PathBuf {
        let root = std::env::temp_dir().join(format!("videorc-resource-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("picked.mp4");
        std::fs::write(&file, b"fixture").unwrap();
        file
    }

    fn issue_params(path: &Path, kind: ResourceCapabilityKind) -> IssueResourceCapabilityParams {
        IssueResourceCapabilityParams {
            kind,
            path: path.display().to_string(),
            ttl_ms: None,
            use_count: None,
        }
    }

    #[test]
    fn capability_is_typed_one_shot_and_unforgeable() {
        let authority = ResourceAuthority::default();
        let file = temp_file();
        let issued = authority
            .issue(issue_params(&file, ResourceCapabilityKind::InputFile))
            .unwrap();

        assert!(
            authority
                .consume(
                    "resource:00000000-0000-4000-8000-000000000000",
                    ResourceCapabilityKind::InputFile
                )
                .is_err()
        );
        assert!(
            authority
                .consume(&issued.capability_id, ResourceCapabilityKind::TrashPath)
                .is_err()
        );
        assert_eq!(
            authority
                .consume(&issued.capability_id, ResourceCapabilityKind::InputFile)
                .unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        assert!(
            authority
                .consume(&issued.capability_id, ResourceCapabilityKind::InputFile)
                .is_err(),
            "replay must fail"
        );
    }

    #[test]
    fn managed_backgrounds_resolve_by_asset_id_not_renderer_path() {
        let authority = ResourceAuthority::default();
        let file = temp_file();
        authority
            .register_managed_background("background_01", &file.display().to_string())
            .unwrap();
        assert_eq!(
            authority
                .resolve_managed_background("background_01")
                .unwrap(),
            std::fs::canonicalize(file).unwrap()
        );
        assert!(
            authority
                .resolve_managed_background("../../forged")
                .is_err()
        );
    }

    #[test]
    fn expired_capability_is_rejected_and_retired() {
        let authority = ResourceAuthority::default();
        let file = temp_file();
        let now = Instant::now();
        let issued = authority
            .issue_at(
                IssueResourceCapabilityParams {
                    ttl_ms: Some(1),
                    ..issue_params(&file, ResourceCapabilityKind::InputFile)
                },
                now,
            )
            .unwrap();
        assert!(
            authority
                .consume_at(
                    &issued.capability_id,
                    ResourceCapabilityKind::InputFile,
                    now + Duration::from_millis(2),
                )
                .unwrap_err()
                .to_string()
                .contains("expired")
        );
        assert!(
            authority
                .consume(&issued.capability_id, ResourceCapabilityKind::InputFile)
                .is_err()
        );
    }

    #[test]
    fn issuing_a_capability_sweeps_other_abandoned_expired_entries() {
        let authority = ResourceAuthority::default();
        let file = temp_file();
        let now = Instant::now();
        let abandoned = authority
            .issue_at(
                IssueResourceCapabilityParams {
                    ttl_ms: Some(1),
                    ..issue_params(&file, ResourceCapabilityKind::InputFile)
                },
                now,
            )
            .unwrap();

        let replacement = authority
            .issue_at(
                issue_params(&file, ResourceCapabilityKind::InputFile),
                now + Duration::from_millis(2),
            )
            .unwrap();

        assert_eq!(
            authority.active_entry_count_at(now + Duration::from_millis(2)),
            1
        );
        assert!(
            authority
                .consume_at(
                    &abandoned.capability_id,
                    ResourceCapabilityKind::InputFile,
                    now + Duration::from_millis(2),
                )
                .is_err()
        );
        assert!(
            authority
                .consume_at(
                    &replacement.capability_id,
                    ResourceCapabilityKind::InputFile,
                    now + Duration::from_millis(2),
                )
                .is_ok()
        );
    }

    #[test]
    fn active_capability_capacity_is_bounded_and_recovers_after_revoke() {
        let authority = ResourceAuthority::default();
        let file = temp_file();
        let now = Instant::now();
        let mut issued_ids = Vec::with_capacity(MAX_ACTIVE_RESOURCE_CAPABILITIES);

        for _ in 0..MAX_ACTIVE_RESOURCE_CAPABILITIES {
            issued_ids.push(
                authority
                    .issue_at(issue_params(&file, ResourceCapabilityKind::InputFile), now)
                    .unwrap()
                    .capability_id,
            );
        }

        let error = authority
            .issue_at(issue_params(&file, ResourceCapabilityKind::InputFile), now)
            .unwrap_err();
        assert!(error.to_string().contains("capacity"));

        assert!(authority.revoke(&issued_ids[0]));
        assert!(
            authority
                .issue_at(issue_params(&file, ResourceCapabilityKind::InputFile), now,)
                .is_ok()
        );
        assert_eq!(
            authority.active_entry_count_at(now),
            MAX_ACTIVE_RESOURCE_CAPABILITIES
        );
    }

    #[test]
    fn capability_rejects_a_different_file_installed_at_the_same_path() {
        let authority = ResourceAuthority::default();
        let file = temp_file();
        let original = file.with_file_name("picked-original.mp4");
        let issued = authority
            .issue(issue_params(&file, ResourceCapabilityKind::InputFile))
            .unwrap();

        std::fs::rename(&file, &original).unwrap();
        std::fs::write(&file, b"replacement").unwrap();

        let error = authority
            .consume(&issued.capability_id, ResourceCapabilityKind::InputFile)
            .unwrap_err();
        assert!(error.to_string().contains("filesystem object changed"));
        assert!(
            authority
                .consume(&issued.capability_id, ResourceCapabilityKind::InputFile)
                .is_err(),
            "an identity mismatch must retire the capability"
        );
    }

    #[test]
    fn capability_rejects_a_different_directory_installed_at_the_same_path() {
        let authority = ResourceAuthority::default();
        let root = std::env::temp_dir().join(format!("videorc-resource-{}", Uuid::new_v4()));
        let directory = root.join("output");
        let original = root.join("output-original");
        std::fs::create_dir_all(&directory).unwrap();
        let issued = authority
            .issue(issue_params(
                &directory,
                ResourceCapabilityKind::OutputDirectory,
            ))
            .unwrap();

        std::fs::rename(&directory, &original).unwrap();
        std::fs::create_dir(&directory).unwrap();

        let error = authority
            .consume(
                &issued.capability_id,
                ResourceCapabilityKind::OutputDirectory,
            )
            .unwrap_err();
        assert!(error.to_string().contains("filesystem object changed"));
    }

    #[test]
    fn rejects_traversal_unc_device_and_drive_relative_forms() {
        for forged in [
            "/tmp/../etc/passwd",
            r"\\server\share\file.mp4",
            r"\\?\C:\Windows\System32\cmd.exe",
            r"\\.\PhysicalDrive0",
            r"\??\C:\Windows\System32",
            r"\Device\HarddiskVolume1\file",
            r"C:relative\file.mp4",
        ] {
            assert!(validate_path_syntax(forged).is_err(), "accepted {forged}");
        }
    }

    #[test]
    fn renderer_background_payloads_keep_only_managed_urls() {
        let mut payload = serde_json::json!({
            "scene": {
                "background": {
                    "assetId": "asset-1",
                    "managedAssetPath": "/private/user/background-assets/asset-1.webp"
                }
            }
        });
        redact_managed_background_paths(&mut payload);
        assert_eq!(
            payload["scene"]["background"]["managedAssetPath"],
            "videorc-asset://background/asset-1.webp"
        );
        assert!(!payload.to_string().contains("/private/user"));
    }

    #[test]
    fn renderer_screen_payloads_keep_only_managed_urls() {
        let mut payload = serde_json::json!({
            "screens": [{
                "id": "8bc7491d-d5df-4aae-8a18-6cf39ccbaad7",
                "status": "ready",
                "sortOrder": 0,
                "imagePath": "/private/user/Screens/8bc7491d-d5df-4aae-8a18-6cf39ccbaad7.png",
                "thumbnailPath": null
            }],
            "sceneSources": [{
                "id": "screen-image:8bc7491d-d5df-4aae-8a18-6cf39ccbaad7",
                "kind": "screen-image",
                "imagePath": "/private/user/Screens/8bc7491d-d5df-4aae-8a18-6cf39ccbaad7.png"
            }]
        });
        redact_managed_screen_paths(&mut payload);
        assert_eq!(
            payload["screens"][0]["imagePath"],
            "videorc-asset://screen/8bc7491d-d5df-4aae-8a18-6cf39ccbaad7.png"
        );
        assert_eq!(
            payload["sceneSources"][0]["imagePath"],
            "videorc-asset://screen/8bc7491d-d5df-4aae-8a18-6cf39ccbaad7.png"
        );
        assert!(!payload.to_string().contains("/private/user"));
    }

    #[cfg(unix)]
    #[test]
    fn containment_uses_canonical_paths_and_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("videorc-root-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("videorc-outside-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("secret.json");
        std::fs::write(&outside_file, b"secret").unwrap();
        let link = root.join("escape.json");
        symlink(&outside_file, &link).unwrap();

        assert!(!canonical_path_is_within(
            &link,
            std::slice::from_ref(&root)
        ));
    }
}
