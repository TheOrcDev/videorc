//! OBS-style local secret store (owner decision 2026-06-11, reaffirmed 2026-06-13).
//!
//! Secrets (stream keys, OAuth tokens) live in a 0600-permission JSON file next
//! to the app database instead of the macOS keychain. The keychain demanded the
//! login password on every dev rebuild — each unsigned binary is a brand-new ACL
//! identity, so "Always Allow" never stuck. OBS avoids the prompt by not using
//! the keychain at all (service configs are plain files); we adopt the same
//! model: a single-user desktop machine where owner-only file permissions are
//! the protection boundary.
//!
//! Cross-platform by construction: the store is plain JSON under the per-user
//! app-data dir, so it works unchanged on Windows. The 0600 hardening is
//! `cfg(unix)`; on Windows the file inherits the per-user `%APPDATA%` ACL,
//! which is the equivalent boundary.

use anyhow::{Context, Result, anyhow};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub const JSON_FILE_SECRET_STORE_KIND: &str = "json-file";
pub const UNSUPPORTED_SECRET_STORE_KIND: &str = "unsupported";
#[cfg(test)]
pub const MEMORY_TEST_SECRET_STORE_KIND: &str = "memory-test";

/// Serializes read-modify-write cycles within this process (the app runs exactly
/// one backend; cross-process locking is not a real concern here).
static STORE_CACHE: Mutex<Option<StoreCache>> = Mutex::new(None);

#[derive(Debug, Clone)]
struct StoreCache {
    identity: SecretStoreBackendIdentity,
    secrets: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SecretStoreBackendIdentity {
    JsonFile(PathBuf),
    #[cfg(test)]
    MemoryTest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretStoreDiagnostics {
    pub kind: &'static str,
    pub path: Option<PathBuf>,
}

trait SecretStoreBackend {
    fn identity(&self) -> SecretStoreBackendIdentity;
    fn kind(&self) -> &'static str;
    fn path(&self) -> Option<&PathBuf>;
    fn read_all(&self) -> Result<BTreeMap<String, String>>;
    fn write_all(&self, secrets: &BTreeMap<String, String>) -> Result<()>;
}

#[derive(Debug, Clone)]
struct JsonFileSecretStore {
    path: PathBuf,
}

impl JsonFileSecretStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SecretStoreBackend for JsonFileSecretStore {
    fn identity(&self) -> SecretStoreBackendIdentity {
        SecretStoreBackendIdentity::JsonFile(self.path.clone())
    }

    fn kind(&self) -> &'static str {
        JSON_FILE_SECRET_STORE_KIND
    }

    fn path(&self) -> Option<&PathBuf> {
        Some(&self.path)
    }

    fn read_all(&self) -> Result<BTreeMap<String, String>> {
        read_json_file(&self.path)
    }

    fn write_all(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        write_json_file(&self.path, secrets)
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct MemorySecretStore;

#[cfg(test)]
impl SecretStoreBackend for MemorySecretStore {
    fn identity(&self) -> SecretStoreBackendIdentity {
        SecretStoreBackendIdentity::MemoryTest
    }

    fn kind(&self) -> &'static str {
        MEMORY_TEST_SECRET_STORE_KIND
    }

    fn path(&self) -> Option<&PathBuf> {
        None
    }

    fn read_all(&self) -> Result<BTreeMap<String, String>> {
        Ok(BTreeMap::new())
    }

    fn write_all(&self, _secrets: &BTreeMap<String, String>) -> Result<()> {
        Ok(())
    }
}

enum SelectedSecretStore {
    JsonFile(JsonFileSecretStore),
    #[cfg(test)]
    MemoryTest(MemorySecretStore),
}

impl SecretStoreBackend for SelectedSecretStore {
    fn identity(&self) -> SecretStoreBackendIdentity {
        match self {
            Self::JsonFile(store) => store.identity(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.identity(),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::JsonFile(store) => store.kind(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.kind(),
        }
    }

    fn path(&self) -> Option<&PathBuf> {
        match self {
            Self::JsonFile(store) => store.path(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.path(),
        }
    }

    fn read_all(&self) -> Result<BTreeMap<String, String>> {
        match self {
            Self::JsonFile(store) => store.read_all(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.read_all(),
        }
    }

    fn write_all(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        match self {
            Self::JsonFile(store) => store.write_all(secrets),
            #[cfg(test)]
            Self::MemoryTest(store) => store.write_all(secrets),
        }
    }
}

pub fn init_native_secret_store() {
    // Nothing to initialize: the store is a file created on first write. The
    // hook stays so main's startup sequence reads unchanged.
}

pub fn secret_store_diagnostics() -> Result<SecretStoreDiagnostics> {
    let backend = selected_secret_store()?;
    Ok(SecretStoreDiagnostics {
        kind: backend.kind(),
        path: backend.path().cloned(),
    })
}

pub fn secret_store_backend_kind() -> &'static str {
    secret_store_diagnostics()
        .map(|diagnostics| diagnostics.kind)
        .unwrap_or(UNSUPPORTED_SECRET_STORE_KIND)
}

fn selected_secret_store() -> Result<SelectedSecretStore> {
    let requested = std::env::var("VIDEORC_SECRET_STORE")
        .unwrap_or_else(|_| JSON_FILE_SECRET_STORE_KIND.to_string())
        .trim()
        .to_ascii_lowercase();
    match requested.as_str() {
        "" | "json" | JSON_FILE_SECRET_STORE_KIND => Ok(SelectedSecretStore::JsonFile(
            JsonFileSecretStore::new(secrets_path()),
        )),
        "keychain" | "macos-keychain" => Err(anyhow!(
            "VIDEORC_SECRET_STORE={requested} is not supported in this build; use json-file."
        )),
        #[cfg(test)]
        MEMORY_TEST_SECRET_STORE_KIND => Ok(SelectedSecretStore::MemoryTest(MemorySecretStore)),
        other => Err(anyhow!(
            "Unsupported VIDEORC_SECRET_STORE value {other}; use json-file."
        )),
    }
}

fn secrets_path() -> PathBuf {
    if let Some(custom) = std::env::var_os("VIDEORC_SECRETS_PATH") {
        return PathBuf::from(custom);
    }
    crate::storage::default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("videorc-secrets.json")
}

fn read_json_file(path: &PathBuf) -> Result<BTreeMap<String, String>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .with_context(|| format!("Secret store {} is not valid JSON", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => {
            Err(error).with_context(|| format!("Could not read secret store {}", path.display()))
        }
    }
}

fn load_cache<'a>(
    cache: &'a mut Option<StoreCache>,
    backend: &SelectedSecretStore,
) -> Result<&'a mut StoreCache> {
    let identity = backend.identity();
    let should_load = cache
        .as_ref()
        .map(|store| store.identity != identity)
        .unwrap_or(true);
    if should_load {
        *cache = Some(StoreCache {
            identity,
            secrets: backend.read_all()?,
        });
    }
    Ok(cache.as_mut().expect("secret cache was just loaded"))
}

fn write_json_file(path: &PathBuf, secrets: &BTreeMap<String, String>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create secret store dir {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(secrets).context("Could not encode secrets")?;
    std::fs::write(&tmp, payload)
        .with_context(|| format!("Could not write secret store {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not set permissions on {}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("Could not commit secret store {}", path.display()))
}

pub fn put_secret(secret_ref: &str, value: &str) -> Result<()> {
    let mut guard = STORE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let backend = selected_secret_store()?;
    let store = load_cache(&mut guard, &backend)?;
    let mut secrets = store.secrets.clone();
    secrets.insert(secret_ref.to_string(), value.to_string());
    backend.write_all(&secrets)?;
    store.secrets = secrets;
    Ok(())
}

pub fn get_secret(secret_ref: &str) -> Result<String> {
    let mut guard = STORE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let backend = selected_secret_store()?;
    let store = load_cache(&mut guard, &backend)?;
    store
        .secrets
        .get(secret_ref)
        .cloned()
        .ok_or_else(|| anyhow!("Secret ref {secret_ref} is not stored."))
}

/// Like [`get_secret`], but absence is a normal outcome (`Ok(None)`) instead of
/// an error — for callers that need to know whether a secret exists at all.
pub fn try_get_secret(secret_ref: &str) -> Result<Option<String>> {
    let mut guard = STORE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let backend = selected_secret_store()?;
    let store = load_cache(&mut guard, &backend)?;
    Ok(store.secrets.get(secret_ref).cloned())
}

pub fn delete_secret(secret_ref: &str) -> Result<()> {
    let mut guard = STORE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let backend = selected_secret_store()?;
    let store = load_cache(&mut guard, &backend)?;
    let mut secrets = store.secrets.clone();
    if secrets.remove(secret_ref).is_some() {
        backend.write_all(&secrets)?;
        store.secrets = secrets;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn reset_secret_store_for_tests() {
        let mut guard = STORE_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
    }

    fn clear_secret_store_env_for_tests() {
        unsafe {
            std::env::remove_var("VIDEORC_SECRET_STORE");
            std::env::remove_var("VIDEORC_SECRETS_PATH");
        }
        reset_secret_store_for_tests();
    }

    #[test]
    fn file_store_roundtrip_and_permissions() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("videorc-secrets-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("videorc-secrets.json");
        // SAFETY: tests in this module run in one test fn; no parallel env races.
        unsafe {
            std::env::set_var("VIDEORC_SECRET_STORE", JSON_FILE_SECRET_STORE_KIND);
            std::env::set_var("VIDEORC_SECRETS_PATH", &path);
        }
        reset_secret_store_for_tests();

        assert!(get_secret("stream-target:twitch:manual-stream-key").is_err());
        assert_eq!(
            try_get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            None
        );

        put_secret("stream-target:twitch:manual-stream-key", "live_abc").unwrap();
        assert_eq!(
            try_get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            Some("live_abc".to_string())
        );
        put_secret("platform:x:oauth:refresh", "tok").unwrap();
        assert_eq!(
            get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            "live_abc"
        );

        // Once warmed, reads come from the in-process cache instead of
        // re-reading and re-parsing the whole JSON file per secret lookup.
        std::fs::write(&path, b"not valid json").unwrap();
        assert_eq!(
            get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            "live_abc"
        );

        // Overwrite keeps the latest value.
        put_secret("stream-target:twitch:manual-stream-key", "live_def").unwrap();
        assert_eq!(
            get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            "live_def"
        );

        // Owner-only permissions: the file is the protection boundary.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "secret store must be 0600");
        }

        // Deleting is idempotent and removes only the named entry.
        delete_secret("stream-target:twitch:manual-stream-key").unwrap();
        delete_secret("stream-target:twitch:manual-stream-key").unwrap();
        assert!(get_secret("stream-target:twitch:manual-stream-key").is_err());
        assert_eq!(get_secret("platform:x:oauth:refresh").unwrap(), "tok");

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_file_backend_is_the_explicit_default() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "videorc-secrets-default-test-{}",
            std::process::id()
        ));
        let path = dir.join("videorc-secrets.json");
        unsafe {
            std::env::remove_var("VIDEORC_SECRET_STORE");
            std::env::set_var("VIDEORC_SECRETS_PATH", &path);
        }
        reset_secret_store_for_tests();

        let diagnostics = secret_store_diagnostics().unwrap();

        assert_eq!(diagnostics.kind, JSON_FILE_SECRET_STORE_KIND);
        assert_eq!(diagnostics.path, Some(path));

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_keychain_override_fails_explicitly() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        unsafe {
            std::env::set_var("VIDEORC_SECRET_STORE", "keychain");
            std::env::remove_var("VIDEORC_SECRETS_PATH");
        }
        reset_secret_store_for_tests();

        let error = put_secret("platform:x:oauth:refresh", "fixture-token").unwrap_err();

        assert!(error.to_string().contains("not supported in this build"));
        assert_eq!(secret_store_backend_kind(), UNSUPPORTED_SECRET_STORE_KIND);

        clear_secret_store_env_for_tests();
    }

    #[test]
    fn memory_backend_is_available_for_unit_tests() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        unsafe {
            std::env::set_var("VIDEORC_SECRET_STORE", MEMORY_TEST_SECRET_STORE_KIND);
            std::env::remove_var("VIDEORC_SECRETS_PATH");
        }
        reset_secret_store_for_tests();

        assert_eq!(
            secret_store_diagnostics().unwrap(),
            SecretStoreDiagnostics {
                kind: MEMORY_TEST_SECRET_STORE_KIND,
                path: None,
            }
        );
        put_secret("stream-target:youtube:manual-stream-key", "fixture-key").unwrap();
        assert_eq!(
            get_secret("stream-target:youtube:manual-stream-key").unwrap(),
            "fixture-key"
        );
        delete_secret("stream-target:youtube:manual-stream-key").unwrap();
        assert_eq!(
            try_get_secret("stream-target:youtube:manual-stream-key").unwrap(),
            None
        );

        clear_secret_store_env_for_tests();
    }
}
