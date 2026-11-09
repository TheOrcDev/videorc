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
//! Cross-platform by construction: the store is JSON under the per-user
//! app-data dir. The 0600 hardening is `cfg(unix)`. On Windows the keychain
//! rationale never applied (DPAPI in user scope never prompts), so the default
//! store there is `dpapi` (#1078): the same JSON payload, wrapped with
//! `CryptProtectData` under the signed-in Windows account and kept at the same
//! path. A plaintext file an older build wrote is protected in place on first
//! read. A file this account cannot decrypt fails every secret access loudly
//! and is never deleted or overwritten: the fix is to delete it by hand (and
//! sign in again) or to run the build that wrote it. Downgrading to a build
//! without `dpapi` behaves the same way (the old build reports "not valid
//! JSON" on every access and writes nothing), so the protected file survives
//! a round trip through an older version.

use anyhow::{Context, Result, anyhow};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const JSON_FILE_SECRET_STORE_KIND: &str = "json-file";
/// Windows only: the JSON payload wrapped with user-scope DPAPI (#1078).
pub const DPAPI_SECRET_STORE_KIND: &str = "dpapi";
pub const UNSUPPORTED_SECRET_STORE_KIND: &str = "unsupported";
#[cfg(test)]
pub const MEMORY_TEST_SECRET_STORE_KIND: &str = "memory-test";

/// The one-time startup purge of unit-test fixtures (#1078) records that it
/// ran under this ref, in the same commit that removes them, so a store is
/// filtered exactly once. Bookkeeping in the store has precedent: the
/// sign-in intent generation lives here too.
const TEST_FIXTURE_PURGE_MARKER_SECRET_REF: &str = "maintenance:test-fixture-purge";
const TEST_FIXTURE_PURGE_VERSION: &str = "1";

/// Kick account ids `kick_chat.rs` tests use. Before `802acbe1` (2026-11-01)
/// a unit test run wrote their subscription refs into the developer's real
/// store. Real Kick account ids are numeric user ids, never `kick-…`, and the
/// purge matches the whole ref, so no real account's entry can be hit.
const KICK_TEST_FIXTURE_ACCOUNT_IDS: &[&str] = &[
    "kick-cleanup",
    "kick-flap",
    "kick-flow",
    "kick-forbidden",
    "kick-no-videorc-sign-in",
    "kick-rejected",
    "kick-relay-down",
    "kick-signed-out",
];

/// Serializes read-modify-write cycles within this process (the app runs exactly
/// one backend; cross-process locking is not a real concern here).
static STORE_CACHE: Mutex<Option<StoreCache>> = Mutex::new(None);

/// What a `secrets::` unit test sees in place of the process environment's
/// `VIDEORC_SECRET_STORE` and `VIDEORC_SECRETS_PATH`, with a cache of its own.
///
/// The environment and [`STORE_CACHE`] are shared by every test in the binary,
/// and other modules' tests reach the store with no lock of ours (Kick
/// subscription ids, account sign-in, remote-control pairing). A test that set
/// the env and then wrote its fixture file let any of them load and cache the
/// still-empty file under the test's own identity in between, so the test then
/// read the stale cache; and they in turn wrote into, or failed against, the
/// test's damaged store. Scoping both to the test's thread removes the race
/// instead of narrowing it.
#[cfg(test)]
#[derive(Debug, Default)]
struct TestStoreScope {
    store: Option<String>,
    path: Option<PathBuf>,
}

#[cfg(test)]
thread_local! {
    static TEST_STORE_SCOPE: std::cell::RefCell<Option<TestStoreScope>> =
        const { std::cell::RefCell::new(None) };
    static TEST_STORE_CACHE: std::cell::RefCell<Option<StoreCache>> =
        const { std::cell::RefCell::new(None) };
}

/// Runs `f` on the store cache: the process-wide one, or in a scoped unit test
/// that thread's own.
fn with_store_cache<R>(f: impl FnOnce(&mut Option<StoreCache>) -> R) -> R {
    #[cfg(test)]
    if TEST_STORE_SCOPE.with(|scope| scope.borrow().is_some()) {
        return TEST_STORE_CACHE.with(|cache| f(&mut cache.borrow_mut()));
    }
    let mut guard = STORE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

/// `VIDEORC_SECRET_STORE` as the store selection sees it.
fn requested_secret_store_env() -> Option<String> {
    #[cfg(test)]
    if let Some(store) =
        TEST_STORE_SCOPE.with(|scope| scope.borrow().as_ref().map(|scope| scope.store.clone()))
    {
        return store;
    }
    std::env::var("VIDEORC_SECRET_STORE").ok()
}

/// `VIDEORC_SECRETS_PATH` as the store selection sees it.
fn secrets_path_env() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) =
        TEST_STORE_SCOPE.with(|scope| scope.borrow().as_ref().map(|scope| scope.path.clone()))
    {
        return path;
    }
    std::env::var_os("VIDEORC_SECRETS_PATH").map(PathBuf::from)
}

#[derive(Debug, Clone)]
struct StoreCache {
    identity: SecretStoreBackendIdentity,
    secrets: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SecretStoreBackendIdentity {
    JsonFile(PathBuf),
    #[cfg(windows)]
    Dpapi(PathBuf),
    #[cfg(test)]
    MemoryTest,
}

/// Which backend a `VIDEORC_SECRET_STORE` request resolves to. Kept apart from
/// the backends themselves so the selection rule has unit tests on every OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SecretStoreKind {
    JsonFile,
    Dpapi,
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

/// Windows default (#1078): the JSON payload wrapped with `CryptProtectData`
/// in user scope, at the same path the plain file used. The file starts with
/// [`protected_payload::MAGIC`] so a plaintext file from an older build is
/// told apart from a protected one and migrated in place on first read.
#[cfg(windows)]
#[derive(Debug, Clone)]
struct DpapiFileSecretStore {
    path: PathBuf,
}

#[cfg(windows)]
impl DpapiFileSecretStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

#[cfg(windows)]
impl SecretStoreBackend for DpapiFileSecretStore {
    fn identity(&self) -> SecretStoreBackendIdentity {
        SecretStoreBackendIdentity::Dpapi(self.path.clone())
    }

    fn kind(&self) -> &'static str {
        DPAPI_SECRET_STORE_KIND
    }

    fn path(&self) -> Option<&PathBuf> {
        Some(&self.path)
    }

    fn read_all(&self) -> Result<BTreeMap<String, String>> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Could not read secret store {}", self.path.display())
                });
            }
        };
        match protected_payload::classify(&bytes) {
            protected_payload::StoredPayload::Protected(blob) => {
                // Never "recover" by wiping: a blob this account cannot open
                // is the user's data (copied from another account or machine,
                // or damaged), and every caller fails the same loud way.
                let plain = dpapi::unprotect(blob).with_context(|| {
                    format!(
                        "Secret store {} could not be decrypted by this Windows account; it was left untouched. Quit Videorc and delete the file to sign in again, or open it with the account that wrote it.",
                        self.path.display()
                    )
                })?;
                parse_secrets_json(&plain, &self.path)
            }
            protected_payload::StoredPayload::Legacy(raw) => {
                let secrets = parse_secrets_json(raw, &self.path).with_context(|| {
                    format!(
                        "Secret store {} is neither a DPAPI-protected store nor plain JSON; it was left untouched.",
                        self.path.display()
                    )
                })?;
                // The atomic replace is also what removes the plaintext copy:
                // there is never a moment with both on disk.
                self.write_all(&secrets).with_context(|| {
                    format!(
                        "Could not protect the plaintext secret store {}; it was left in place.",
                        self.path.display()
                    )
                })?;
                tracing::info!(
                    path = %self.path.display(),
                    entries = secrets.len(),
                    "Secret store protected with DPAPI"
                );
                Ok(secrets)
            }
        }
    }

    fn write_all(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        let payload = encode_secrets_json(secrets)?;
        let blob = dpapi::protect(payload.as_bytes())?;
        write_store_file(&self.path, &protected_payload::frame(&blob))
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
    #[cfg(windows)]
    Dpapi(DpapiFileSecretStore),
    #[cfg(test)]
    MemoryTest(MemorySecretStore),
}

impl SecretStoreBackend for SelectedSecretStore {
    fn identity(&self) -> SecretStoreBackendIdentity {
        match self {
            Self::JsonFile(store) => store.identity(),
            #[cfg(windows)]
            Self::Dpapi(store) => store.identity(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.identity(),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::JsonFile(store) => store.kind(),
            #[cfg(windows)]
            Self::Dpapi(store) => store.kind(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.kind(),
        }
    }

    fn path(&self) -> Option<&PathBuf> {
        match self {
            Self::JsonFile(store) => store.path(),
            #[cfg(windows)]
            Self::Dpapi(store) => store.path(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.path(),
        }
    }

    fn read_all(&self) -> Result<BTreeMap<String, String>> {
        match self {
            Self::JsonFile(store) => store.read_all(),
            #[cfg(windows)]
            Self::Dpapi(store) => store.read_all(),
            #[cfg(test)]
            Self::MemoryTest(store) => store.read_all(),
        }
    }

    fn write_all(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        match self {
            Self::JsonFile(store) => store.write_all(secrets),
            #[cfg(windows)]
            Self::Dpapi(store) => store.write_all(secrets),
            #[cfg(test)]
            Self::MemoryTest(store) => store.write_all(secrets),
        }
    }
}

/// Runs once at backend start, before any command: loads the store (on
/// Windows this is where a plaintext file becomes DPAPI-protected), removes
/// the staged `.tmp` copy a write that died before its rename left behind, and
/// drops the unit-test fixtures older builds wrote into the real store
/// (#1078). A store that cannot be read is reported and left exactly as it is:
/// every later secret access fails the same loud way, and nothing is deleted.
pub fn init_secret_store() {
    match run_startup_maintenance() {
        Ok(report) => {
            if report.removed_stale_temp_file || !report.purged_test_fixtures.is_empty() {
                tracing::info!(
                    removed_stale_temp_file = report.removed_stale_temp_file,
                    purged_test_fixtures = ?report.purged_test_fixtures,
                    "Secret store startup maintenance"
                );
            }
        }
        Err(error) => {
            let error = format!("{error:#}");
            tracing::warn!(
                error = %error,
                "Secret store startup maintenance failed; the store was left untouched"
            );
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct StartupMaintenanceReport {
    removed_stale_temp_file: bool,
    purged_test_fixtures: Vec<String>,
}

fn run_startup_maintenance() -> Result<StartupMaintenanceReport> {
    with_store_cache(run_startup_maintenance_on)
}

fn run_startup_maintenance_on(cache: &mut Option<StoreCache>) -> Result<StartupMaintenanceReport> {
    let backend = selected_secret_store()?;
    // Only a store that loaded in full may lose its staged copy: after a crash
    // the `.tmp` can be the only readable one.
    let store = load_cache(cache, &backend)?;
    let mut report = StartupMaintenanceReport::default();
    if let Some(path) = backend.path() {
        match remove_stale_temp_file(path) {
            Ok(removed) => report.removed_stale_temp_file = removed,
            Err(error) => {
                let error = format!("{error:#}");
                tracing::warn!(error = %error, "Could not remove the stale secret store copy");
            }
        }
    }
    if let Some((next, removed)) = plan_test_fixture_purge(&store.secrets) {
        backend.write_all(&next)?;
        store.secrets = next;
        report.purged_test_fixtures = removed;
    }
    Ok(report)
}

/// The staged file [`write_store_file`] renames over the store. A backend that
/// dies between the write and the rename leaves it as a full second copy.
fn store_temp_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

/// Removes a `.tmp` left by a crashed write. `Ok(true)` when one was there.
fn remove_stale_temp_file(path: &Path) -> Result<bool> {
    let temp = store_temp_path(path);
    match std::fs::remove_file(&temp) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| {
            format!(
                "Could not remove stale secret store copy {}",
                temp.display()
            )
        }),
    }
}

/// Whether a ref is one a pre-`802acbe1` unit test run wrote into a real
/// store. Whole-ref match against the known fixture account ids only.
fn is_known_test_fixture_secret_ref(secret_ref: &str) -> bool {
    KICK_TEST_FIXTURE_ACCOUNT_IDS
        .iter()
        .any(|account_id| secret_ref == crate::kick_chat::subscription_ids_secret_ref(account_id))
}

/// The store after the one-time fixture purge, with the refs it removes, or
/// `None` when there is nothing to commit: the purge already ran, or the store
/// is empty (a fresh profile never gets a file holding only the marker).
fn plan_test_fixture_purge(
    secrets: &BTreeMap<String, String>,
) -> Option<(BTreeMap<String, String>, Vec<String>)> {
    if secrets.is_empty()
        || secrets
            .get(TEST_FIXTURE_PURGE_MARKER_SECRET_REF)
            .map(String::as_str)
            == Some(TEST_FIXTURE_PURGE_VERSION)
    {
        return None;
    }
    let mut next = secrets.clone();
    let removed = next
        .keys()
        .filter(|secret_ref| is_known_test_fixture_secret_ref(secret_ref))
        .cloned()
        .collect::<Vec<_>>();
    for secret_ref in &removed {
        next.remove(secret_ref);
    }
    next.insert(
        TEST_FIXTURE_PURGE_MARKER_SECRET_REF.to_string(),
        TEST_FIXTURE_PURGE_VERSION.to_string(),
    );
    Some((next, removed))
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
    let requested = requested_secret_store_env();
    let kind = select_secret_store_kind(
        requested.as_deref(),
        platform_default_secret_store_kind(),
        cfg!(windows),
    )?;
    Ok(match kind {
        SecretStoreKind::JsonFile => {
            SelectedSecretStore::JsonFile(JsonFileSecretStore::new(secrets_path()))
        }
        #[cfg(windows)]
        SecretStoreKind::Dpapi => {
            SelectedSecretStore::Dpapi(DpapiFileSecretStore::new(secrets_path()))
        }
        #[cfg(not(windows))]
        SecretStoreKind::Dpapi => {
            return Err(anyhow!(
                "VIDEORC_SECRET_STORE={DPAPI_SECRET_STORE_KIND} is not supported in this build; use json-file."
            ));
        }
        #[cfg(test)]
        SecretStoreKind::MemoryTest => SelectedSecretStore::MemoryTest(MemorySecretStore),
    })
}

/// Windows protects the file with DPAPI; everywhere else the 0600 file is the
/// boundary (see the module doc).
fn platform_default_secret_store_kind() -> SecretStoreKind {
    if cfg!(windows) {
        SecretStoreKind::Dpapi
    } else {
        SecretStoreKind::JsonFile
    }
}

/// Resolves a `VIDEORC_SECRET_STORE` request. `json-file` stays available on
/// Windows as an explicit choice (a smoke that reads the file back, or the
/// documented recovery path); `dpapi` is refused where the build lacks it
/// instead of silently falling back to plaintext.
fn select_secret_store_kind(
    requested: Option<&str>,
    platform_default: SecretStoreKind,
    dpapi_available: bool,
) -> Result<SecretStoreKind> {
    let requested = requested.unwrap_or("").trim().to_ascii_lowercase();
    match requested.as_str() {
        "" => Ok(platform_default),
        "json" | JSON_FILE_SECRET_STORE_KIND => Ok(SecretStoreKind::JsonFile),
        DPAPI_SECRET_STORE_KIND if dpapi_available => Ok(SecretStoreKind::Dpapi),
        DPAPI_SECRET_STORE_KIND | "keychain" | "macos-keychain" => Err(anyhow!(
            "VIDEORC_SECRET_STORE={requested} is not supported in this build; use json-file."
        )),
        #[cfg(test)]
        MEMORY_TEST_SECRET_STORE_KIND => Ok(SecretStoreKind::MemoryTest),
        other => Err(anyhow!(
            "Unsupported VIDEORC_SECRET_STORE value {other}; use json-file."
        )),
    }
}

fn secrets_path() -> PathBuf {
    if let Some(custom) = secrets_path_env() {
        return custom;
    }
    // A unit test that writes a secret without isolating the store must never
    // reach the developer's real one: `cargo test` replaced the real
    // `remote-control.lan` and `agents.registry` with test fixtures.
    #[cfg(test)]
    if std::env::var_os("VIDEORC_DATABASE_PATH").is_none() {
        return unit_test_secrets_path();
    }
    crate::storage::default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("videorc-secrets.json")
}

/// One throwaway store per test process, outside every real profile.
#[cfg(test)]
fn unit_test_secrets_path() -> PathBuf {
    std::env::temp_dir()
        .join(format!("videorc-unit-test-secrets-{}", std::process::id()))
        .join("videorc-secrets.json")
}

fn read_json_file(path: &PathBuf) -> Result<BTreeMap<String, String>> {
    match std::fs::read(path) {
        Ok(raw) => parse_secrets_json(&raw, path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => {
            Err(error).with_context(|| format!("Could not read secret store {}", path.display()))
        }
    }
}

fn parse_secrets_json(raw: &[u8], path: &Path) -> Result<BTreeMap<String, String>> {
    serde_json::from_slice(raw)
        .with_context(|| format!("Secret store {} is not valid JSON", path.display()))
}

fn encode_secrets_json(secrets: &BTreeMap<String, String>) -> Result<String> {
    serde_json::to_string_pretty(secrets).context("Could not encode secrets")
}

/// On-disk framing of the DPAPI store (#1078), kept free of Windows calls so
/// the plaintext-versus-protected decision has tests on every OS (where only
/// those tests use it).
#[cfg_attr(not(windows), allow(dead_code))]
mod protected_payload {
    /// First bytes of a protected store. A plaintext JSON store starts with
    /// `{`, so the two can never be confused.
    pub const MAGIC: &[u8] = b"videorc-secrets:dpapi:1\n";

    #[derive(Debug, PartialEq, Eq)]
    pub enum StoredPayload<'a> {
        /// The DPAPI blob after the magic line.
        Protected(&'a [u8]),
        /// Anything else: a plaintext store from a build before `dpapi`, or
        /// damage. The JSON parse decides which.
        Legacy(&'a [u8]),
    }

    pub fn classify(bytes: &[u8]) -> StoredPayload<'_> {
        match bytes.strip_prefix(MAGIC) {
            Some(blob) => StoredPayload::Protected(blob),
            None => StoredPayload::Legacy(bytes),
        }
    }

    pub fn frame(blob: &[u8]) -> Vec<u8> {
        let mut framed = Vec::with_capacity(MAGIC.len() + blob.len());
        framed.extend_from_slice(MAGIC);
        framed.extend_from_slice(blob);
        framed
    }
}

/// `CryptProtectData` / `CryptUnprotectData` in user scope, UI forbidden: the
/// signed-in Windows account is the boundary. No app entropy: a constant baked
/// into the binary would add nothing a reader of the binary could not undo.
#[cfg(windows)]
mod dpapi {
    use anyhow::{Context, Result, anyhow};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    use windows::core::PCWSTR;

    fn input_blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB> {
        let length = u32::try_from(bytes.len())
            .map_err(|_| anyhow!("Secret store payload of {} bytes is too large", bytes.len()))?;
        Ok(CRYPT_INTEGER_BLOB {
            cbData: length,
            pbData: bytes.as_ptr().cast_mut(),
        })
    }

    /// Copies the DPAPI output into owned memory and releases the `LocalAlloc`
    /// buffer, even when the output is empty.
    fn take_output(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if output.pbData.is_null() {
            return Vec::new();
        }
        // SAFETY: DPAPI returned `cbData` bytes at `pbData` from `LocalAlloc`;
        // they are read once here and freed once below.
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
        let input = input_blob(plain)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` borrows `plain` for the duration of the call;
        // `output` is a valid out-pointer owned by this frame.
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .context("CryptProtectData failed")?;
        Ok(take_output(output))
    }

    pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>> {
        let input = input_blob(blob)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `protect`.
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .context("CryptUnprotectData failed")?;
        Ok(take_output(output))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn protect_round_trips_and_rejects_a_tampered_blob() {
            let plain = br#"{"account:videorc:session":"fixture-token"}"#;

            let blob = protect(plain).unwrap();

            assert_ne!(blob.as_slice(), plain.as_slice());
            assert!(!blob.windows(plain.len()).any(|window| window == plain));
            assert_eq!(unprotect(&blob).unwrap(), plain);

            let mut tampered = blob.clone();
            let last = tampered.len() - 1;
            tampered[last] ^= 0xff;
            assert!(unprotect(&tampered).is_err());
            assert!(unprotect(b"not a dpapi blob").is_err());
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

fn write_json_file(path: &Path, secrets: &BTreeMap<String, String>) -> Result<()> {
    let payload = encode_secrets_json(secrets)?;
    write_store_file(path, payload.as_bytes())
}

/// Stages the bytes in [`store_temp_path`], syncs them, then renames over the
/// store. The rename is the only step that changes what a reader sees.
fn write_store_file(path: &Path, payload: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create secret store dir {}", parent.display()))?;
    }
    let tmp = store_temp_path(path);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .with_context(|| format!("Could not open secret store {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not set permissions on {}", tmp.display()))?;
    }
    file.write_all(payload)
        .with_context(|| format!("Could not write secret store {}", tmp.display()))?;
    file.sync_all()
        .with_context(|| format!("Could not sync secret store {}", tmp.display()))?;
    drop(file);
    if let Err(error) = crate::atomic_file::replace_file(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error)
            .with_context(|| format!("Could not commit secret store {}", path.display()));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .with_context(|| format!("Could not sync secret store dir {}", parent.display()))?;
    }
    Ok(())
}

pub fn put_secret(secret_ref: &str, value: &str) -> Result<()> {
    put_secrets(&[(secret_ref, value)])
}

/// Commit related secret values in one read-modify-write cycle. Account sign-in
/// uses this so its bearer token, cached identity, and replay binding cannot be
/// torn across separate file replacements.
pub fn put_secrets(entries: &[(&str, &str)]) -> Result<()> {
    update_secrets(entries, &[])
}

/// Atomically apply related secret writes and removals in one file replacement.
/// Product-account sign-out uses this to advance its durable intent generation
/// in the same commit that removes the bearer token and cached identity.
pub fn update_secrets(entries: &[(&str, &str)], removals: &[&str]) -> Result<()> {
    with_loaded_store(|backend, store| {
        let mut secrets = store.secrets.clone();
        for secret_ref in removals {
            secrets.remove(*secret_ref);
        }
        for (secret_ref, value) in entries {
            secrets.insert((*secret_ref).to_string(), (*value).to_string());
        }
        if secrets == store.secrets {
            return Ok(());
        }
        backend.write_all(&secrets)?;
        store.secrets = secrets;
        Ok(())
    })
}

pub fn get_secret(secret_ref: &str) -> Result<String> {
    with_loaded_store(|_, store| {
        store
            .secrets
            .get(secret_ref)
            .cloned()
            .ok_or_else(|| anyhow!("Secret ref {secret_ref} is not stored."))
    })
}

/// Like [`get_secret`], but absence is a normal outcome (`Ok(None)`) instead of
/// an error — for callers that need to know whether a secret exists at all.
pub fn try_get_secret(secret_ref: &str) -> Result<Option<String>> {
    with_loaded_store(|_, store| Ok(store.secrets.get(secret_ref).cloned()))
}

/// Selects the store and loads its cache, holding the cache for all of `f`.
fn with_loaded_store<R>(
    f: impl FnOnce(&SelectedSecretStore, &mut StoreCache) -> Result<R>,
) -> Result<R> {
    with_store_cache(|cache| {
        let backend = selected_secret_store()?;
        let store = load_cache(cache, &backend)?;
        f(&backend, store)
    })
}

pub fn delete_secret(secret_ref: &str) -> Result<()> {
    delete_secrets(&[secret_ref])
}

pub fn delete_secrets(secret_refs: &[&str]) -> Result<()> {
    update_secrets(&[], secret_refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Points this test thread's store at `store`/`path` (`None` reads as
    /// unset, whatever the process env holds) with an empty cache of its own.
    /// Nothing another test does can see or change it; see [`TestStoreScope`].
    fn scope_secret_store_for_tests(store: Option<&str>, path: Option<&Path>) {
        TEST_STORE_SCOPE.with(|scope| {
            *scope.borrow_mut() = Some(TestStoreScope {
                store: store.map(str::to_string),
                path: path.map(Path::to_path_buf),
            });
        });
        reset_secret_store_for_tests();
    }

    /// Drops this thread's cache, as a backend restart would.
    fn reset_secret_store_for_tests() {
        TEST_STORE_CACHE.with(|cache| *cache.borrow_mut() = None);
    }

    fn clear_secret_store_env_for_tests() {
        TEST_STORE_SCOPE.with(|scope| *scope.borrow_mut() = None);
        reset_secret_store_for_tests();
    }

    #[test]
    fn file_store_roundtrip_and_permissions() {
        let dir = std::env::temp_dir().join(format!("videorc-secrets-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("videorc-secrets.json");
        scope_secret_store_for_tests(Some(JSON_FILE_SECRET_STORE_KIND), Some(&path));

        assert!(get_secret("stream-target:twitch:manual-stream-key").is_err());
        assert_eq!(
            try_get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            None
        );

        put_secrets(&[
            ("stream-target:twitch:manual-stream-key", "live_abc"),
            ("platform:x:oauth:refresh", "tok"),
        ])
        .unwrap();
        assert_eq!(
            try_get_secret("stream-target:twitch:manual-stream-key").unwrap(),
            Some("live_abc".to_string())
        );
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

        update_secrets(
            &[("account:videorc:sign-in-intent-generation", "7")],
            &["platform:x:oauth:refresh"],
        )
        .unwrap();
        assert_eq!(
            get_secret("account:videorc:sign-in-intent-generation").unwrap(),
            "7"
        );
        assert!(get_secret("platform:x:oauth:refresh").is_err());
        reset_secret_store_for_tests();
        assert_eq!(
            get_secret("account:videorc:sign-in-intent-generation").unwrap(),
            "7",
            "intent tombstone must survive a backend restart"
        );
        assert!(get_secret("platform:x:oauth:refresh").is_err());

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
        assert_eq!(
            get_secret("account:videorc:sign-in-intent-generation").unwrap(),
            "7"
        );

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_file_commit_replaces_an_existing_destination_repeatedly() {
        let dir = std::env::temp_dir().join(format!(
            "videorc-secrets-replace-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("videorc-secrets.json");
        let first = BTreeMap::from([("token".to_string(), "first".to_string())]);
        let second = BTreeMap::from([("token".to_string(), "second".to_string())]);

        write_json_file(&path, &first).unwrap();
        write_json_file(&path, &second).unwrap();

        assert_eq!(read_json_file(&path).unwrap(), second);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn platform_default_backend_is_selected_without_an_override() {
        let dir = std::env::temp_dir().join(format!(
            "videorc-secrets-default-test-{}",
            std::process::id()
        ));
        let path = dir.join("videorc-secrets.json");
        scope_secret_store_for_tests(None, Some(&path));

        let diagnostics = secret_store_diagnostics().unwrap();

        // Windows protects with DPAPI (#1078); everywhere else the 0600 file.
        let expected = if cfg!(windows) {
            DPAPI_SECRET_STORE_KIND
        } else {
            JSON_FILE_SECRET_STORE_KIND
        };
        assert_eq!(diagnostics.kind, expected);
        assert_eq!(diagnostics.path, Some(path));

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_unit_test_without_an_isolated_store_never_reaches_the_real_profile() {
        // The state every other module's test runs in: nothing set.
        scope_secret_store_for_tests(None, None);
        let real_store = crate::storage::default_database_path()
            .parent()
            .map(|dir| dir.join("videorc-secrets.json"))
            .unwrap();

        let path = secret_store_diagnostics().unwrap().path.unwrap();

        assert_ne!(path, real_store);
        assert!(path.starts_with(std::env::temp_dir()), "{}", path.display());
        clear_secret_store_env_for_tests();
    }

    #[test]
    fn unsupported_keychain_override_fails_explicitly() {
        scope_secret_store_for_tests(Some("keychain"), None);

        let error = put_secret("platform:x:oauth:refresh", "fixture-token").unwrap_err();

        assert!(error.to_string().contains("not supported in this build"));
        assert_eq!(secret_store_backend_kind(), UNSUPPORTED_SECRET_STORE_KIND);

        clear_secret_store_env_for_tests();
    }

    #[test]
    fn memory_backend_is_available_for_unit_tests() {
        scope_secret_store_for_tests(Some(MEMORY_TEST_SECRET_STORE_KIND), None);

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

    /// The interleaving behind the intermittent DPAPI test failure, made
    /// deterministic: another
    /// module's test reads the store after this test pointed it at a fixture
    /// path but before the fixture file exists. It must neither see this
    /// test's store nor leave a stale cache this test then reads.
    #[test]
    fn a_scoped_store_is_invisible_to_and_unaffected_by_other_test_threads() {
        let dir =
            std::env::temp_dir().join(format!("videorc-secrets-scope-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("videorc-secrets.json");
        scope_secret_store_for_tests(Some(JSON_FILE_SECRET_STORE_KIND), Some(&path));

        let other_thread_path = std::thread::spawn(|| {
            let _ = try_get_secret("account:videorc:session");
            secret_store_diagnostics().unwrap().path
        })
        .join()
        .unwrap();
        assert_ne!(other_thread_path, Some(path.clone()));

        let fixture =
            BTreeMap::from([("account:videorc:session".to_string(), "token".to_string())]);
        write_json_file(&path, &fixture).unwrap();
        assert_eq!(get_secret("account:videorc:session").unwrap(), "token");

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_kind_selection_follows_the_platform_default_and_refuses_what_the_build_lacks() {
        use SecretStoreKind::{Dpapi, JsonFile};

        assert_eq!(
            select_secret_store_kind(None, JsonFile, false).unwrap(),
            JsonFile
        );
        assert_eq!(select_secret_store_kind(None, Dpapi, true).unwrap(), Dpapi);
        assert_eq!(
            select_secret_store_kind(Some(""), Dpapi, true).unwrap(),
            Dpapi
        );
        // json-file stays an explicit choice on Windows (smokes, recovery).
        for explicit in ["json", "json-file", " JSON-FILE "] {
            assert_eq!(
                select_secret_store_kind(Some(explicit), Dpapi, true).unwrap(),
                JsonFile,
                "{explicit:?}"
            );
        }
        assert_eq!(
            select_secret_store_kind(Some("dpapi"), JsonFile, true).unwrap(),
            Dpapi
        );
        assert_eq!(
            select_secret_store_kind(Some(" DPAPI "), JsonFile, true).unwrap(),
            Dpapi
        );

        // Never a silent fallback to plaintext.
        let error = select_secret_store_kind(Some("dpapi"), JsonFile, false).unwrap_err();
        assert!(
            error.to_string().contains("not supported in this build"),
            "{error}"
        );
        let error = select_secret_store_kind(Some("keychain"), Dpapi, true).unwrap_err();
        assert!(
            error.to_string().contains("not supported in this build"),
            "{error}"
        );
        let error = select_secret_store_kind(Some("vault"), Dpapi, true).unwrap_err();
        assert!(error.to_string().contains("Unsupported"), "{error}");
    }

    #[test]
    fn protected_payload_framing_tells_a_plaintext_store_from_a_protected_one() {
        use protected_payload::{StoredPayload, classify, frame};

        let blob = b"\x01\x00\x00\x00opaque dpapi bytes";
        let framed = frame(blob);

        assert_eq!(classify(&framed), StoredPayload::Protected(blob));
        assert_eq!(
            classify(b"{\n  \"a\": \"b\"\n}"),
            StoredPayload::Legacy(b"{\n  \"a\": \"b\"\n}")
        );
        assert_eq!(classify(b""), StoredPayload::Legacy(b""));
        // A truncated magic line is not a protected store either.
        let truncated = &framed[..protected_payload::MAGIC.len() - 1];
        assert_eq!(classify(truncated), StoredPayload::Legacy(truncated));
    }

    #[test]
    fn test_fixture_purge_matches_whole_refs_only_and_runs_once() {
        let fixture = crate::kick_chat::subscription_ids_secret_ref("kick-flap");
        let real_numeric_account = crate::kick_chat::subscription_ids_secret_ref("4242");
        let near_misses = [
            "platform:kick:kick-flap:oauth:access".to_string(),
            crate::kick_chat::subscription_ids_secret_ref("kick-flapjack"),
            crate::kick_chat::subscription_ids_secret_ref("akick-flap"),
            "platform:twitch:kick-flap:event-subscriptions".to_string(),
        ];
        let mut secrets = BTreeMap::from([
            (fixture.clone(), "[\"a\"]".to_string()),
            (
                crate::kick_chat::subscription_ids_secret_ref("kick-relay-down"),
                "[]".to_string(),
            ),
            (real_numeric_account.clone(), "[\"keep\"]".to_string()),
            ("account:videorc:session".to_string(), "token".to_string()),
        ]);
        for near_miss in &near_misses {
            secrets.insert(near_miss.clone(), "keep".to_string());
        }

        let (next, removed) = plan_test_fixture_purge(&secrets).unwrap();

        assert_eq!(
            removed,
            vec![
                fixture.clone(),
                crate::kick_chat::subscription_ids_secret_ref("kick-relay-down")
            ]
        );
        assert!(!next.contains_key(&fixture));
        assert_eq!(next.get(&real_numeric_account).unwrap(), "[\"keep\"]");
        assert_eq!(next.get("account:videorc:session").unwrap(), "token");
        for near_miss in &near_misses {
            assert_eq!(
                next.get(near_miss).map(String::as_str),
                Some("keep"),
                "{near_miss}"
            );
        }
        assert_eq!(
            next.get(TEST_FIXTURE_PURGE_MARKER_SECRET_REF)
                .map(String::as_str),
            Some(TEST_FIXTURE_PURGE_VERSION)
        );

        // Recorded: a second pass commits nothing, even if a fixture ref came back.
        let mut again = next.clone();
        again.insert(fixture, "[]".to_string());
        assert_eq!(plan_test_fixture_purge(&again), None);
        // A store with nothing in it never gets a file that holds only the marker.
        assert_eq!(plan_test_fixture_purge(&BTreeMap::new()), None);
        // A store with no fixtures still records the pass, once.
        let clean = BTreeMap::from([("account:videorc:session".to_string(), "t".to_string())]);
        let (next, removed) = plan_test_fixture_purge(&clean).unwrap();
        assert!(removed.is_empty());
        assert_eq!(next.len(), 2);
    }

    #[test]
    fn startup_maintenance_removes_the_stale_copy_and_fixtures_only_after_the_store_loads() {
        let dir = std::env::temp_dir().join(format!(
            "videorc-secrets-maintenance-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("videorc-secrets.json");
        let temp = store_temp_path(&path);
        assert_eq!(temp, dir.join("videorc-secrets.json.tmp"));
        scope_secret_store_for_tests(Some(JSON_FILE_SECRET_STORE_KIND), Some(&path));

        // A store that does not load keeps its staged copy: after a crash it
        // may be the only readable one. Nothing is written either.
        std::fs::write(&path, b"not valid json").unwrap();
        std::fs::write(&temp, b"{\"account:videorc:session\":\"survivor\"}").unwrap();
        let error = run_startup_maintenance().unwrap_err();
        assert!(error.to_string().contains("not valid JSON"), "{error}");
        assert!(temp.exists(), "the staged copy must survive a failed load");
        assert_eq!(std::fs::read(&path).unwrap(), b"not valid json");
        reset_secret_store_for_tests();

        // A store that loads loses the staged copy and the fixtures in one go.
        let fixture = crate::kick_chat::subscription_ids_secret_ref("kick-flow");
        let stored = BTreeMap::from([
            (fixture.clone(), "[\"sub-1\"]".to_string()),
            ("account:videorc:session".to_string(), "token".to_string()),
            (
                crate::kick_chat::subscription_ids_secret_ref("4242"),
                "[\"real\"]".to_string(),
            ),
        ]);
        write_json_file(&path, &stored).unwrap();
        std::fs::write(&temp, b"{\"stale\":\"copy\"}").unwrap();

        let report = run_startup_maintenance().unwrap();

        assert_eq!(
            report,
            StartupMaintenanceReport {
                removed_stale_temp_file: true,
                purged_test_fixtures: vec![fixture.clone()],
            }
        );
        assert!(!temp.exists());
        let on_disk = read_json_file(&path).unwrap();
        assert!(!on_disk.contains_key(&fixture));
        assert_eq!(on_disk.get("account:videorc:session").unwrap(), "token");
        assert_eq!(
            on_disk
                .get(&crate::kick_chat::subscription_ids_secret_ref("4242"))
                .unwrap(),
            "[\"real\"]"
        );
        assert_eq!(
            on_disk
                .get(TEST_FIXTURE_PURGE_MARKER_SECRET_REF)
                .map(String::as_str),
            Some(TEST_FIXTURE_PURGE_VERSION)
        );
        // The warmed cache agrees with the file.
        assert_eq!(try_get_secret(&fixture).unwrap(), None);
        assert_eq!(get_secret("account:videorc:session").unwrap(), "token");

        // The next start has nothing to do and rewrites nothing.
        let before = std::fs::read(&path).unwrap();
        reset_secret_store_for_tests();
        assert_eq!(
            run_startup_maintenance().unwrap(),
            StartupMaintenanceReport::default()
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);

        // A fresh profile gets no file at all.
        std::fs::remove_file(&path).unwrap();
        reset_secret_store_for_tests();
        assert_eq!(
            run_startup_maintenance().unwrap(),
            StartupMaintenanceReport::default()
        );
        assert!(!path.exists());

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_store_protects_a_plaintext_file_in_place_and_never_wipes_an_unreadable_one() {
        let dir =
            std::env::temp_dir().join(format!("videorc-secrets-dpapi-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("videorc-secrets.json");
        scope_secret_store_for_tests(Some(DPAPI_SECRET_STORE_KIND), Some(&path));
        assert_eq!(
            secret_store_diagnostics().unwrap().kind,
            DPAPI_SECRET_STORE_KIND
        );

        // An older build's plaintext file is protected in place on first read.
        let legacy = BTreeMap::from([
            ("account:videorc:session".to_string(), "token".to_string()),
            (
                "remote-control:lan:device:abc".to_string(),
                "key".to_string(),
            ),
        ]);
        write_json_file(&path, &legacy).unwrap();
        assert_eq!(get_secret("account:videorc:session").unwrap(), "token");
        let protected = std::fs::read(&path).unwrap();
        assert!(protected.starts_with(protected_payload::MAGIC));
        assert!(!protected.windows(5).any(|window| window == b"token"));
        assert!(!store_temp_path(&path).exists());

        // A protected file reads back after a restart and takes writes.
        reset_secret_store_for_tests();
        assert_eq!(get_secret("remote-control:lan:device:abc").unwrap(), "key");
        put_secret("account:videorc:session", "token-2").unwrap();
        reset_secret_store_for_tests();
        assert_eq!(get_secret("account:videorc:session").unwrap(), "token-2");
        assert!(
            std::fs::read(&path)
                .unwrap()
                .starts_with(protected_payload::MAGIC)
        );

        // A blob this account cannot open fails loudly and stays on disk.
        let mut damaged = std::fs::read(&path).unwrap();
        let last = damaged.len() - 1;
        damaged[last] ^= 0xff;
        std::fs::write(&path, &damaged).unwrap();
        reset_secret_store_for_tests();
        let error = get_secret("account:videorc:session").unwrap_err();
        assert!(
            error.to_string().contains("could not be decrypted"),
            "{error}"
        );
        assert!(put_secret("account:videorc:session", "token-3").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), damaged);
        let error = run_startup_maintenance().unwrap_err();
        assert!(
            error.to_string().contains("could not be decrypted"),
            "{error}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), damaged);

        // Neither protected nor JSON: the same loud, non-destructive failure.
        std::fs::write(&path, b"garbage").unwrap();
        reset_secret_store_for_tests();
        let error = get_secret("account:videorc:session").unwrap_err();
        assert!(error.to_string().contains("neither"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"garbage");

        clear_secret_store_env_for_tests();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
