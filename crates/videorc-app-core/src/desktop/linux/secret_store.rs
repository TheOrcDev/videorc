//! Tokens in the Secret Service (plan 260 S2.6c): what Electron sealed with
//! `safeStorage` (`secure-persistence-codec.ts`) and its Linux keyring
//! check (`linux-password-store.ts`).
//!
//! Plan 260 seals with the OS keychain through the `keyring` crate; on Linux
//! that is the Secret Service (GNOME Keyring, KWallet 6, KeePassXC). This is
//! the Linux policy around it: the round-trip probe that fills
//! [`LinuxKeyringStatus`] for Health and the keyring alert, the store that
//! refuses rather than falls back to plain text (Electron refused
//! `basic_text`), and the sign-in refusal. The keyring calls are behind
//! [`SecretBackend`]; S2.1's implementation is a `keyring::Entry` per account
//! under [`SECRET_SERVICE_NAME`].

use super::setup::{KEYRING_SIGN_IN_REFUSAL, LinuxKeyringStatus};

/// The `service` attribute every Videorc secret carries.
pub const SECRET_SERVICE_NAME: &str = "Videorc";

/// The account the probe writes, reads back and deletes.
pub const PROBE_ACCOUNT: &str = "keyring-probe";

/// `LinuxKeyringStatus.backend` when the Secret Service round trip worked.
pub const SECRET_SERVICE_BACKEND: &str = "secret_service";

/// Electron's `securePersistenceError`, word for word.
pub const STORE_UNAVAILABLE: &str = "Protected desktop persistence is unavailable.";

/// Electron's `MAX_PLAINTEXT_BYTES`.
pub const MAX_SECRET_BYTES: usize = 1024 * 1024;

/// The keyring crate's failures, as far as the policy cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    /// No Secret Service, a locked collection the streamer didn't unlock, or
    /// a refused prompt (`keyring::Error::NoStorageAccess`).
    NoStorageAccess(String),
    /// `keyring::Error::PlatformFailure`, `Ambiguous` and the rest.
    Platform(String),
}

/// One Secret Service item per account under [`SECRET_SERVICE_NAME`].
pub trait SecretBackend {
    fn set(&mut self, account: &str, secret: &[u8]) -> Result<(), SecretError>;
    /// `Ok(None)` when there is no item (`keyring::Error::NoEntry`).
    fn get(&mut self, account: &str) -> Result<Option<Vec<u8>>, SecretError>;
    /// A missing item is not an error.
    fn delete(&mut self, account: &str) -> Result<(), SecretError>;
}

/// Writes, reads back and deletes a probe item: true only when the whole
/// round trip worked, as `safeStorage.isEncryptionAvailable()` did.
pub fn probe_keyring(backend: &mut impl SecretBackend) -> LinuxKeyringStatus {
    const PROBE: &[u8] = b"videorc keyring probe";
    let round_trip = backend
        .set(PROBE_ACCOUNT, PROBE)
        .and_then(|()| backend.get(PROBE_ACCOUNT))
        .map(|read| read.as_deref() == Some(PROBE));
    let available = matches!(round_trip, Ok(true));
    if round_trip.is_ok() {
        let _ = backend.delete(PROBE_ACCOUNT);
    }
    LinuxKeyringStatus {
        backend: if available {
            SECRET_SERVICE_BACKEND
        } else {
            "unknown"
        }
        .to_string(),
        available,
        // The GPUI app has no `--password-store` switch.
        user_password_store: None,
    }
}

/// Sign-in starts only with a keyring Videorc can use.
pub fn sign_in_allowed(status: &LinuxKeyringStatus) -> Result<(), &'static str> {
    if status.available {
        Ok(())
    } else {
        Err(KEYRING_SIGN_IN_REFUSAL)
    }
}

/// Why a seal or unseal failed: always [`STORE_UNAVAILABLE`] to the
/// streamer; the cause is kept for support bundles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub cause: String,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(STORE_UNAVAILABLE)
    }
}

impl std::error::Error for StoreError {}

fn store_error(cause: impl Into<String>) -> StoreError {
    StoreError {
        cause: cause.into(),
    }
}

fn backend_error(error: SecretError) -> StoreError {
    match error {
        SecretError::NoStorageAccess(cause) => store_error(format!("no keyring access: {cause}")),
        SecretError::Platform(cause) => store_error(format!("keyring: {cause}")),
    }
}

/// An account name: what Videorc names its items, nothing a caller could
/// use to reach another app's.
fn valid_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 64
        && account
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

/// Sealed strings in the Secret Service. Refuses every call while the
/// keyring is unavailable rather than keep a token anywhere else.
pub struct SecretStore<B: SecretBackend> {
    backend: B,
    status: LinuxKeyringStatus,
}

impl<B: SecretBackend> SecretStore<B> {
    /// Probes the keyring once; [`Self::reprobe`] after the streamer fixes it.
    pub fn new(mut backend: B) -> Self {
        let status = probe_keyring(&mut backend);
        Self { backend, status }
    }

    pub fn status(&self) -> &LinuxKeyringStatus {
        &self.status
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn reprobe(&mut self) -> &LinuxKeyringStatus {
        self.status = probe_keyring(&mut self.backend);
        &self.status
    }

    fn ready(&self, account: &str) -> Result<(), StoreError> {
        if !self.status.available {
            return Err(store_error("no keyring Videorc can use"));
        }
        if !valid_account(account) {
            return Err(store_error(format!("invalid account {account:?}")));
        }
        Ok(())
    }

    pub fn seal(&mut self, account: &str, plaintext: &str) -> Result<(), StoreError> {
        self.ready(account)?;
        if plaintext.is_empty() || plaintext.len() > MAX_SECRET_BYTES {
            return Err(store_error("empty or oversized secret"));
        }
        self.backend
            .set(account, plaintext.as_bytes())
            .map_err(backend_error)
    }

    /// `Ok(None)` when nothing was sealed under `account`.
    pub fn unseal(&mut self, account: &str) -> Result<Option<String>, StoreError> {
        self.ready(account)?;
        let Some(bytes) = self.backend.get(account).map_err(backend_error)? else {
            return Ok(None);
        };
        if bytes.is_empty() || bytes.len() > MAX_SECRET_BYTES {
            return Err(store_error("empty or oversized secret"));
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| store_error("secret is not UTF-8"))
    }

    pub fn forget(&mut self, account: &str) -> Result<(), StoreError> {
        self.ready(account)?;
        self.backend.delete(account).map_err(backend_error)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::desktop::linux::setup::{BusServiceState, keyring_check};

    #[derive(Default)]
    struct FakeKeyring {
        items: BTreeMap<String, Vec<u8>>,
        locked: bool,
        /// Stores, but hands back something else (a broken bridge).
        garbles: bool,
        calls: Vec<String>,
    }

    impl SecretBackend for FakeKeyring {
        fn set(&mut self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
            self.calls.push(format!("set {account}"));
            if self.locked {
                return Err(SecretError::NoStorageAccess("collection is locked".into()));
            }
            self.items.insert(account.into(), secret.to_vec());
            Ok(())
        }

        fn get(&mut self, account: &str) -> Result<Option<Vec<u8>>, SecretError> {
            self.calls.push(format!("get {account}"));
            if self.locked {
                return Err(SecretError::NoStorageAccess("collection is locked".into()));
            }
            if self.garbles {
                return Ok(Some(b"\xff".to_vec()));
            }
            Ok(self.items.get(account).cloned())
        }

        fn delete(&mut self, account: &str) -> Result<(), SecretError> {
            self.calls.push(format!("delete {account}"));
            self.items.remove(account);
            Ok(())
        }
    }

    #[test]
    fn a_working_keyring_round_trips_the_probe_and_leaves_nothing_behind() {
        let store = SecretStore::new(FakeKeyring::default());
        assert!(store.status().available);
        assert_eq!(store.status().backend, SECRET_SERVICE_BACKEND);
        assert_eq!(store.status().user_password_store, None);
        assert!(store.backend().items.is_empty());
        assert_eq!(
            store.backend().calls,
            [
                "set keyring-probe",
                "get keyring-probe",
                "delete keyring-probe"
            ]
        );
        assert_eq!(
            keyring_check(store.status(), Some(BusServiceState::Running)).value,
            "Secret Service"
        );
    }

    #[test]
    fn a_locked_keyring_is_unavailable_and_health_says_cant_open() {
        let store = SecretStore::new(FakeKeyring {
            locked: true,
            ..FakeKeyring::default()
        });
        assert!(!store.status().available);
        assert_eq!(store.status().backend, "unknown");
        assert_eq!(
            keyring_check(store.status(), Some(BusServiceState::Running)).value,
            "Can't open"
        );
        assert_eq!(
            sign_in_allowed(store.status()),
            Err(KEYRING_SIGN_IN_REFUSAL)
        );
    }

    #[test]
    fn a_keyring_that_hands_back_something_else_is_unavailable() {
        let store = SecretStore::new(FakeKeyring {
            garbles: true,
            ..FakeKeyring::default()
        });
        assert!(!store.status().available);
        // It still cleans up the item it wrote.
        assert!(store.backend().items.is_empty());
    }

    #[test]
    fn seals_unseals_and_forgets_a_token() {
        let mut store = SecretStore::new(FakeKeyring::default());
        assert_eq!(sign_in_allowed(store.status()), Ok(()));
        assert_eq!(store.unseal("account-session"), Ok(None));
        store.seal("account-session", "token-1").unwrap();
        assert_eq!(
            store.unseal("account-session").unwrap().as_deref(),
            Some("token-1")
        );
        store.forget("account-session").unwrap();
        assert_eq!(store.unseal("account-session"), Ok(None));
    }

    #[test]
    fn refuses_rather_than_keep_a_token_anywhere_else() {
        let mut store = SecretStore::new(FakeKeyring {
            locked: true,
            ..FakeKeyring::default()
        });
        let calls = store.backend().calls.len();
        let error = store.seal("account-session", "token-1").unwrap_err();
        assert_eq!(error.to_string(), STORE_UNAVAILABLE);
        assert!(store.unseal("account-session").is_err());
        assert!(store.forget("account-session").is_err());
        assert_eq!(store.backend().calls.len(), calls);
    }

    #[test]
    fn reprobes_after_the_streamer_unlocks_the_keyring() {
        let mut store = SecretStore::new(FakeKeyring {
            locked: true,
            ..FakeKeyring::default()
        });
        assert!(!store.status().available);
        store.backend.locked = false;
        assert!(store.reprobe().available);
        store.seal("account-session", "token-1").unwrap();
    }

    #[test]
    fn rejects_bad_accounts_and_sizes() {
        let mut store = SecretStore::new(FakeKeyring::default());
        assert!(store.seal("", "x").is_err());
        assert!(store.seal("Account", "x").is_err());
        assert!(store.seal("a/b", "x").is_err());
        assert!(store.seal(&"a".repeat(65), "x").is_err());
        assert!(store.seal("account-session", "").is_err());
        assert!(
            store
                .seal("account-session", &"x".repeat(MAX_SECRET_BYTES + 1))
                .is_err()
        );
        assert!(store.seal("recordings.folder_grant-1", "x").is_ok());
    }

    #[test]
    fn an_item_that_is_not_utf8_is_refused_not_mangled() {
        let mut store = SecretStore::new(FakeKeyring::default());
        store.backend.garbles = true;
        let error = store.unseal("account-session").unwrap_err();
        assert_eq!(error.cause, "secret is not UTF-8");
    }

    #[test]
    fn a_keyring_that_locks_later_says_why_without_saying_it_to_the_streamer() {
        let mut store = SecretStore::new(FakeKeyring::default());
        store.backend.locked = true;
        let error = store.seal("account-session", "token-1").unwrap_err();
        assert_eq!(error.cause, "no keyring access: collection is locked");
        assert_eq!(error.to_string(), STORE_UNAVAILABLE);
    }
}
