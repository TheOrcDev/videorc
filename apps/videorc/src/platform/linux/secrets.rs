//! Tokens in the Secret Service (plan 260 S2.6c): the core's `SecretBackend`
//! (`desktop::linux::secret_store`, which probes, bounds and refuses) over
//! `org.freedesktop.secrets` (GNOME Keyring, KWallet 6, KeePassXC).
//!
//! The items carry keyring-rs's attributes (`service`, `username`, `target`)
//! so the `keyring` crate plan 260 names for macOS and Windows reads the same
//! items if Linux moves onto it. The transfer is the spec's `plain` session:
//! the bytes cross the session bus only, as with libsecret's default.
//!
//! No unlock prompt is opened: a locked keyring answers "no access", the
//! probe reads unavailable, and the setup alert says what to do ("Unlock it
//! if your desktop asks").

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use ashpd::zbus;
use ashpd::zvariant::{OwnedObjectPath, OwnedValue, Value};
use videorc_app_core::desktop::linux::secret_store::{
    SECRET_SERVICE_NAME, SecretBackend, SecretError,
};

use super::bus::{Bus, CALL_DEADLINE};

const SERVICE: &str = "org.freedesktop.secrets";
const SERVICE_PATH: &str = "/org/freedesktop/secrets";
/// The default collection, through its alias (a login keyring).
const DEFAULT_COLLECTION: &str = "/org/freedesktop/secrets/aliases/default";
const SERVICE_INTERFACE: &str = "org.freedesktop.Secret.Service";
const COLLECTION_INTERFACE: &str = "org.freedesktop.Secret.Collection";
const ITEM_INTERFACE: &str = "org.freedesktop.Secret.Item";
const SESSION_INTERFACE: &str = "org.freedesktop.Secret.Session";
/// A prompt path of "/" means no prompt was needed.
const NO_PROMPT: &str = "/";

/// keyring-rs's `target` when none is given.
const TARGET: &str = "default";

/// How the service's refusals read to the core.
fn secret_error(error: impl std::fmt::Display) -> SecretError {
    let text = error.to_string();
    let no_access = [
        "IsLocked",
        "NoSession",
        "ServiceUnknown",
        "UnknownObject",
        "NoSuchObject",
        "no session bus",
        "didn't answer",
        "locked",
    ]
    .iter()
    .any(|marker| text.contains(marker));
    if no_access {
        SecretError::NoStorageAccess(text)
    } else {
        SecretError::Platform(text)
    }
}

fn locked() -> SecretError {
    SecretError::NoStorageAccess("the keyring is locked".to_string())
}

/// The item's label in the keyring's own list.
fn label(account: &str) -> String {
    format!("{SECRET_SERVICE_NAME} ({account})")
}

pub struct SecretService {
    bus: Arc<Bus>,
}

impl SecretService {
    pub fn new(bus: Arc<Bus>) -> Self {
        Self { bus }
    }

    fn run<T, F, Fut>(&self, work: F) -> Result<T, SecretError>
    where
        T: Send + 'static,
        F: FnOnce(zbus::Connection) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, SecretError>> + Send + 'static,
    {
        let connection = self.bus.connection();
        self.bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                Ok(work(connection).await)
            })
            .map_err(secret_error)?
    }
}

async fn open_session(connection: &zbus::Connection) -> Result<OwnedObjectPath, SecretError> {
    let reply = connection
        .call_method(
            Some(SERVICE),
            SERVICE_PATH,
            Some(SERVICE_INTERFACE),
            "OpenSession",
            &("plain", Value::from("")),
        )
        .await
        .map_err(secret_error)?;
    let (_, session): (OwnedValue, OwnedObjectPath) =
        reply.body().deserialize().map_err(secret_error)?;
    Ok(session)
}

async fn close_session(connection: &zbus::Connection, session: &OwnedObjectPath) {
    let _ = connection
        .call_method(
            Some(SERVICE),
            session.as_str(),
            Some(SESSION_INTERFACE),
            "Close",
            &(),
        )
        .await;
}

/// The items for `account`: the unlocked ones and the locked ones.
async fn search(
    connection: &zbus::Connection,
    account: &str,
) -> Result<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>), SecretError> {
    let attributes: HashMap<&str, &str> = [
        ("service", SECRET_SERVICE_NAME),
        ("username", account),
        ("target", TARGET),
    ]
    .into_iter()
    .collect();
    let reply = connection
        .call_method(
            Some(SERVICE),
            SERVICE_PATH,
            Some(SERVICE_INTERFACE),
            "SearchItems",
            &(attributes,),
        )
        .await
        .map_err(secret_error)?;
    reply.body().deserialize().map_err(secret_error)
}

async fn store(
    connection: zbus::Connection,
    account: String,
    secret: Vec<u8>,
) -> Result<(), SecretError> {
    let session = open_session(&connection).await?;
    let attributes: HashMap<&str, &str> = [
        ("service", SECRET_SERVICE_NAME),
        ("username", account.as_str()),
        ("target", TARGET),
    ]
    .into_iter()
    .collect();
    let label = label(&account);
    let mut properties: HashMap<&str, Value<'_>> = HashMap::new();
    properties.insert(
        "org.freedesktop.Secret.Item.Label",
        Value::from(label.as_str()),
    );
    properties.insert(
        "org.freedesktop.Secret.Item.Attributes",
        Value::from(attributes),
    );
    let reply = connection
        .call_method(
            Some(SERVICE),
            DEFAULT_COLLECTION,
            Some(COLLECTION_INTERFACE),
            "CreateItem",
            &(
                properties,
                (session.clone(), Vec::<u8>::new(), secret, "text/plain"),
                true,
            ),
        )
        .await
        .map_err(secret_error);
    close_session(&connection, &session).await;
    let (_, prompt): (OwnedObjectPath, OwnedObjectPath) =
        reply?.body().deserialize().map_err(secret_error)?;
    if prompt.as_str() != NO_PROMPT {
        return Err(locked());
    }
    Ok(())
}

async fn read(
    connection: zbus::Connection,
    account: String,
) -> Result<Option<Vec<u8>>, SecretError> {
    let (unlocked, locked_items) = search(&connection, &account).await?;
    let Some(item) = unlocked.first() else {
        return if locked_items.is_empty() {
            Ok(None)
        } else {
            Err(locked())
        };
    };
    let session = open_session(&connection).await?;
    let reply = connection
        .call_method(
            Some(SERVICE),
            item.as_str(),
            Some(ITEM_INTERFACE),
            "GetSecret",
            &(session.clone(),),
        )
        .await
        .map_err(secret_error);
    close_session(&connection, &session).await;
    let (_, _, value, _): (OwnedObjectPath, Vec<u8>, Vec<u8>, String) =
        reply?.body().deserialize().map_err(secret_error)?;
    Ok(Some(value))
}

async fn remove(connection: zbus::Connection, account: String) -> Result<(), SecretError> {
    let (unlocked, locked_items) = search(&connection, &account).await?;
    if unlocked.is_empty() && !locked_items.is_empty() {
        return Err(locked());
    }
    for item in unlocked {
        let reply = connection
            .call_method(
                Some(SERVICE),
                item.as_str(),
                Some(ITEM_INTERFACE),
                "Delete",
                &(),
            )
            .await
            .map_err(secret_error)?;
        let prompt: OwnedObjectPath = reply.body().deserialize().map_err(secret_error)?;
        if prompt.as_str() != NO_PROMPT {
            return Err(locked());
        }
    }
    Ok(())
}

impl SecretBackend for SecretService {
    fn set(&mut self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
        let (account, secret) = (account.to_string(), secret.to_vec());
        self.run(move |connection| store(connection, account, secret))
    }

    fn get(&mut self, account: &str) -> Result<Option<Vec<u8>>, SecretError> {
        let account = account.to_string();
        self.run(move |connection| read(connection, account))
    }

    fn delete(&mut self, account: &str) -> Result<(), SecretError> {
        let account = account.to_string();
        self.run(move |connection| remove(connection, account))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_locked_or_missing_keyring_is_no_access_and_the_rest_is_a_failure() {
        assert!(matches!(
            secret_error(
                "org.freedesktop.Secret.Error.IsLocked: Cannot create an item in a locked collection"
            ),
            SecretError::NoStorageAccess(_)
        ));
        assert!(matches!(
            secret_error("org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable"),
            SecretError::NoStorageAccess(_)
        ));
        assert!(matches!(
            secret_error("org.freedesktop.DBus.Error.InvalidArgs: bad attributes"),
            SecretError::Platform(_)
        ));
        assert_eq!(label("account-session"), "Videorc (account-session)");
    }
}
