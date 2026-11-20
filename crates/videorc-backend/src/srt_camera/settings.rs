//! The SRT input setting (plan 255 D3, D4, D11): off by default, a port, a
//! generated passphrase and a Connection. The switch, port and Connection
//! live in `app_settings`; the passphrase lives in the secret store.

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

use crate::protocol::{SrtInputConnection, SrtInputSetParams};
use crate::storage::Database;

pub const SRT_INPUT_SETTINGS_KEY: &str = "srtInput";
pub const SRT_INPUT_PASSPHRASE_SECRET_REF: &str = "srt-input:passphrase";
pub const DEFAULT_SRT_PORT: u16 = 9000;
/// Below 1024 needs root on macOS; a sender can reach any port above it.
pub const MIN_SRT_PORT: u16 = 1024;
/// SRT accepts 10 to 79 characters (`SRTO_PASSPHRASE`); D4 picks 32.
pub const PASSPHRASE_LEN: usize = 32;

const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SrtInputSettings {
    pub enabled: bool,
    pub port: u16,
    pub connection: SrtInputConnection,
}

impl Default for SrtInputSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_SRT_PORT,
            connection: SrtInputConnection::default(),
        }
    }
}

impl SrtInputSettings {
    /// The settings after `params`, or why they are refused.
    pub fn with(self, params: &SrtInputSetParams) -> Result<Self> {
        let port = params.port.unwrap_or(self.port);
        if port < MIN_SRT_PORT {
            bail!("Choose a port from {MIN_SRT_PORT} to 65535.");
        }
        Ok(Self {
            enabled: params.enabled.unwrap_or(self.enabled),
            port,
            connection: params.connection.unwrap_or(self.connection),
        })
    }
}

/// D11: the receive latency each Connection asks for, in ms. SRT uses the
/// larger of the two ends' values, so this is a floor for the sender.
pub fn connection_latency_ms(connection: SrtInputConnection) -> u32 {
    match connection {
        SrtInputConnection::CableOrThisComputer => 0,
        SrtInputConnection::Wifi => 120,
        SrtInputConnection::Internet => 500,
    }
}

pub fn camera_name(port: u16) -> String {
    format!("SRT Camera (port {port})")
}

pub fn load_settings(database: &Database) -> Result<SrtInputSettings> {
    Ok(database
        .load_setting::<SrtInputSettings>(SRT_INPUT_SETTINGS_KEY)?
        .unwrap_or_default())
}

pub fn save_settings(database: &Database, settings: &SrtInputSettings) -> Result<()> {
    database.save_setting(SRT_INPUT_SETTINGS_KEY, settings)
}

/// Where the passphrase is kept: the secret store in the app, memory in tests.
pub trait PassphraseVault {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, passphrase: &str) -> Result<()>;
}

pub struct SecretStoreVault;

impl PassphraseVault for SecretStoreVault {
    fn load(&self) -> Result<Option<String>> {
        crate::secrets::try_get_secret(SRT_INPUT_PASSPHRASE_SECRET_REF)
    }

    fn save(&self, passphrase: &str) -> Result<()> {
        crate::secrets::put_secret(SRT_INPUT_PASSPHRASE_SECRET_REF, passphrase)
    }
}

/// The kept passphrase, made and kept on first use (D4). A kept value that
/// SRT would refuse is replaced, never shown.
pub fn passphrase(vault: &impl PassphraseVault) -> Result<String> {
    match vault.load()? {
        Some(kept) if passphrase_is_valid(&kept) => Ok(kept),
        _ => renew_passphrase(vault),
    }
}

/// D4's New passphrase: every sender must be given the new one.
pub fn renew_passphrase(vault: &impl PassphraseVault) -> Result<String> {
    let fresh = generate_passphrase();
    vault.save(&fresh)?;
    Ok(fresh)
}

pub fn passphrase_is_valid(passphrase: &str) -> bool {
    (10..=79).contains(&passphrase.len()) && passphrase.bytes().all(|byte| URL_SAFE.contains(&byte))
}

/// 32 characters from the URL-safe alphabet. Two v4 UUIDs (244 random bits
/// from the OS) are hashed so every character gets a uniform 6 bits.
pub fn generate_passphrase() -> String {
    let mut hasher = Sha256::new();
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    hasher
        .finalize()
        .iter()
        .take(PASSPHRASE_LEN)
        .map(|byte| URL_SAFE[usize::from(byte & 0x3f)] as char)
        .collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    pub struct MemoryVault(pub RefCell<Option<String>>);

    impl PassphraseVault for MemoryVault {
        fn load(&self) -> Result<Option<String>> {
            Ok(self.0.borrow().clone())
        }

        fn save(&self, passphrase: &str) -> Result<()> {
            *self.0.borrow_mut() = Some(passphrase.to_string());
            Ok(())
        }
    }

    #[test]
    fn srt_settings_default_off_on_port_9000_over_wifi() {
        let settings = SrtInputSettings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.port, 9000);
        assert_eq!(settings.connection, SrtInputConnection::Wifi);
    }

    #[test]
    fn srt_settings_load_defaults_and_round_trip() {
        let database = Database::open_in_memory_for_tests();
        assert_eq!(
            load_settings(&database).unwrap(),
            SrtInputSettings::default()
        );
        let on = SrtInputSettings {
            enabled: true,
            port: 9100,
            connection: SrtInputConnection::CableOrThisComputer,
        };
        save_settings(&database, &on).unwrap();
        assert_eq!(load_settings(&database).unwrap(), on);
    }

    #[test]
    fn srt_settings_missing_fields_take_defaults() {
        let settings: SrtInputSettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(settings.port, 9000);
        assert_eq!(settings.connection, SrtInputConnection::Wifi);
    }

    #[test]
    fn srt_settings_apply_only_the_given_fields() {
        let next = SrtInputSettings::default()
            .with(&SrtInputSetParams {
                enabled: Some(true),
                port: None,
                connection: Some(SrtInputConnection::Internet),
            })
            .unwrap();
        assert_eq!(
            next,
            SrtInputSettings {
                enabled: true,
                port: 9000,
                connection: SrtInputConnection::Internet
            }
        );
    }

    #[test]
    fn srt_settings_refuse_a_privileged_port() {
        let refused = SrtInputSettings::default().with(&SrtInputSetParams {
            port: Some(80),
            ..Default::default()
        });
        assert_eq!(
            refused.unwrap_err().to_string(),
            "Choose a port from 1024 to 65535."
        );
        assert!(
            SrtInputSettings::default()
                .with(&SrtInputSetParams {
                    port: Some(1024),
                    ..Default::default()
                })
                .is_ok()
        );
    }

    #[test]
    fn srt_connection_maps_to_its_latency() {
        assert_eq!(
            connection_latency_ms(SrtInputConnection::CableOrThisComputer),
            0
        );
        assert_eq!(connection_latency_ms(SrtInputConnection::Wifi), 120);
        assert_eq!(connection_latency_ms(SrtInputConnection::Internet), 500);
    }

    #[test]
    fn srt_camera_name_carries_the_port() {
        assert_eq!(camera_name(9000), "SRT Camera (port 9000)");
    }

    #[test]
    fn srt_passphrase_is_32_url_safe_characters_and_varies() {
        let first = generate_passphrase();
        assert_eq!(first.len(), 32, "D4: 32 characters");
        assert!(passphrase_is_valid(&first));
        assert_ne!(first, generate_passphrase());
    }

    #[test]
    fn srt_passphrase_is_made_once_then_kept() {
        let vault = MemoryVault::default();
        let made = passphrase(&vault).unwrap();
        assert_eq!(vault.0.borrow().as_deref(), Some(made.as_str()));
        assert_eq!(passphrase(&vault).unwrap(), made);
    }

    #[test]
    fn srt_passphrase_renew_replaces_the_kept_one() {
        let vault = MemoryVault::default();
        let made = passphrase(&vault).unwrap();
        let renewed = renew_passphrase(&vault).unwrap();
        assert_ne!(made, renewed);
        assert_eq!(passphrase(&vault).unwrap(), renewed);
    }

    #[test]
    fn srt_passphrase_srt_would_refuse_is_replaced() {
        let vault = MemoryVault(RefCell::new(Some("short".to_string())));
        let made = passphrase(&vault).unwrap();
        assert_ne!(made, "short");
        assert!(passphrase_is_valid(&made));
        assert!(!passphrase_is_valid("has space in it, so no"));
    }
}
