//! The UI settings store's wire shapes, as `videorc-rust`'s plan 220 S1.4a
//! defined them (plan 260 S1.6a, L7).
//!
//! **Held here until L2's S1.4 lands.** Today's backend has no `ui.settings.*`
//! (Electron keeps these keys in the renderer's `localStorage`); plan 260
//! S1.4 moves them into the backend's `app_settings` and adds these shapes to
//! `videorc-protocol`, which L2 owns. Until then the Studio's settings model
//! is pure and tested against fakes, and this file is the one place that
//! names the wire. When S1.4's protocol module lands, this file is deleted
//! and its users import `videorc_protocol::ui_settings` instead.
//!
//! The key-value store:
//! every Videorc window reads its product state from (what `localStorage`
//! held while Electron owned the UI). The store, its limits, the one-time
//! `localStorage` migration bookkeeping and the change event stay in
//! `videorc-backend` (`ui_settings.rs`).
//!
//! Keys are the renderer's `localStorage` names (`videorc.settings`,
//! `videorc.scene-presets.v1`, ...), values any JSON value but `null` (a
//! `null` is a delete). `ui.settings.get` returns a snapshot, `ui.settings.set`
//! applies one batch and answers with what landed, and every window hears the
//! same batch as `ui.settings.changed`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `ui.settings.get` params. No `keys` (or an empty list) reads the whole
/// store; otherwise only the named keys that exist come back.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsGetParams {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
}

/// `ui.settings.get` result: the entries, the store's revision (bumped by
/// every batch that lands something) and whether the one-time `localStorage`
/// migration has run on this profile.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsSnapshot {
    pub entries: BTreeMap<String, Value>,
    pub revision: u64,
    pub local_storage_migrated: bool,
}

/// `ui.settings.set` params: one batch of puts and deletes, applied in one
/// transaction.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsSetParams {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub put: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delete: Vec<String>,
    /// Puts land only on keys the store does not hold yet (the `localStorage`
    /// migration copies, never overwrites).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub if_absent: bool,
    /// Marks the one-time `localStorage` migration done on this profile.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local_storage_migrated: bool,
    /// The writing window's id, echoed on `ui.settings.changed` so that
    /// window can skip its own change (what the `storage` event did).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer: Option<String>,
}

/// `ui.settings.set` result and the `ui.settings.changed` event: what landed
/// (an `ifAbsent` put on a held key is left out), the revision after it, and
/// the writer's id.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsChange {
    pub revision: u64,
    pub put: BTreeMap<String, Value>,
    pub delete: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer: Option<String>,
}

/// The change event's name.
pub const UI_SETTINGS_CHANGED_EVENT: &str = "ui.settings.changed";
