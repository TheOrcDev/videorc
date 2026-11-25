//! The UI settings store (plan 220 S1.4a): the key-value product state every
//! Videorc window used to keep in `localStorage`, now one `app_settings` row
//! per key under the `ui:` namespace (`storage.rs`), read through
//! `ui.settings.get`, written through `ui.settings.set` (one batch, one
//! transaction) and announced to every window as `ui.settings.changed`, the
//! way `localStorage`'s `storage` event reached the other windows.
//!
//! Limits are explicit refusals, never silent trims: a key is 1 to 256
//! characters without control characters or surrounding whitespace, a value
//! is any JSON but `null` (that is a delete) at most 8 MiB serialized (room
//! for the largest scene library a previous release kept in `localStorage`),
//! a batch names at most 256 keys and 12 MiB in all, and a key cannot be put
//! and deleted in the same batch.
//!
//! A journal replay names each key's write time (`unlessUpdatedAfter`): a key
//! the store changed after it is left out, so a window's stale journal never
//! overwrites what another window wrote since. A delete leaves a tombstone
//! with its time, so a stale journal or a migration copy never resurrects
//! it, and a replayed change is stamped with its write time, so journals
//! replayed in any order leave the newest write.
//!
//! The one-time `localStorage` migration is the renderer's (it is the only
//! side that can read `localStorage`): it sends every key the store lacks as
//! an `ifAbsent` batch marked `localStorageMigrated`, so two windows racing
//! the same launch cannot overwrite each other, and a profile written by the
//! previous release arrives string for string (`protocol-fixtures/
//! ui-settings-previous-release-profile.json`).

use anyhow::Result;

pub use videorc_protocol::ui_settings::{
    UI_SETTINGS_CHANGED_EVENT, UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams,
    UiSettingsSnapshot,
};

use crate::state::AppState;
use crate::storage::Database;

/// Longest key, in characters.
pub const MAX_KEY_CHARS: usize = 256;
/// Largest value, serialized, in bytes.
pub const MAX_VALUE_BYTES: usize = 8 * 1024 * 1024;
/// Most keys one batch (puts plus deletes, or a `get`) may name.
pub const MAX_BATCH_KEYS: usize = 256;
/// Largest batch, every value serialized, in bytes. One largest value fits
/// with room for the request around it under the socket's 16 MiB frame.
pub const MAX_BATCH_BYTES: usize = 12 * 1024 * 1024;
/// Longest writer id, in characters.
pub const MAX_WRITER_CHARS: usize = 128;

/// Why a batch or a read was refused: the renderer shows the message as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UiSettingsInvalid(pub String);

#[derive(Debug, thiserror::Error)]
pub enum UiSettingsError {
    #[error(transparent)]
    Invalid(#[from] UiSettingsInvalid),
    #[error(transparent)]
    Storage(#[from] anyhow::Error),
}

fn invalid<T>(message: impl Into<String>) -> Result<T, UiSettingsInvalid> {
    Err(UiSettingsInvalid(message.into()))
}

/// A key is 1 to 256 characters, no control characters, no surrounding
/// whitespace.
pub fn validate_key(key: &str) -> Result<(), UiSettingsInvalid> {
    if key.is_empty() {
        return invalid("A UI setting key cannot be empty.");
    }
    let chars = key.chars().count();
    if chars > MAX_KEY_CHARS {
        return invalid(format!(
            "A UI setting key is at most {MAX_KEY_CHARS} characters; got {chars}."
        ));
    }
    if key.chars().any(char::is_control) {
        return invalid(format!(
            "UI setting key {key:?} contains a control character."
        ));
    }
    if key.trim() != key {
        return invalid(format!(
            "UI setting key {key:?} starts or ends with whitespace."
        ));
    }
    Ok(())
}

fn validate_writer(writer: Option<&str>) -> Result<(), UiSettingsInvalid> {
    match writer {
        Some("") => invalid("A writer id cannot be empty."),
        Some(writer) if writer.chars().count() > MAX_WRITER_CHARS => invalid(format!(
            "A writer id is at most {MAX_WRITER_CHARS} characters."
        )),
        Some(writer) if writer.chars().any(char::is_control) => {
            invalid("A writer id cannot contain control characters.")
        }
        _ => Ok(()),
    }
}

/// Checks a `get`'s keys (any number up to the batch limit).
pub fn validate_get(params: &UiSettingsGetParams) -> Result<(), UiSettingsInvalid> {
    if params.keys.len() > MAX_BATCH_KEYS {
        return invalid(format!(
            "A UI settings read names at most {MAX_BATCH_KEYS} keys; got {}.",
            params.keys.len()
        ));
    }
    for key in &params.keys {
        validate_key(key)?;
    }
    Ok(())
}

/// Checks a batch: every key, every value's size, the batch's size, and no
/// key both put and deleted.
pub fn validate_set(params: &UiSettingsSetParams) -> Result<(), UiSettingsInvalid> {
    validate_writer(params.writer.as_deref())?;
    let named = params.put.len() + params.delete.len();
    if named > MAX_BATCH_KEYS {
        return invalid(format!(
            "A UI settings batch names at most {MAX_BATCH_KEYS} keys; got {named}."
        ));
    }
    let mut total_bytes = 0usize;
    for (key, value) in &params.put {
        validate_key(key)?;
        if value.is_null() {
            return invalid(format!(
                "UI setting {key:?} cannot be set to null; delete it instead."
            ));
        }
        let bytes = serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len());
        if bytes > MAX_VALUE_BYTES {
            return invalid(format!(
                "UI setting {key:?} is {bytes} bytes serialized; the limit is {MAX_VALUE_BYTES}."
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes);
    }
    if total_bytes > MAX_BATCH_BYTES {
        return invalid(format!(
            "A UI settings batch is at most {MAX_BATCH_BYTES} bytes serialized; got {total_bytes}."
        ));
    }
    let mut deleted = std::collections::BTreeSet::new();
    for key in &params.delete {
        validate_key(key)?;
        if params.put.contains_key(key) {
            return invalid(format!(
                "UI setting {key:?} is both put and deleted in one batch."
            ));
        }
        if !deleted.insert(key) {
            return invalid(format!("UI setting {key:?} is deleted twice in one batch."));
        }
    }
    for key in params.unless_updated_after.keys() {
        if !params.put.contains_key(key) && !deleted.contains(key) {
            return invalid(format!(
                "UI setting {key:?} has a write time but is neither put nor deleted."
            ));
        }
    }
    Ok(())
}

/// `ui.settings.get`: the whole store, or the named keys that exist. The
/// entries, the revision and the migration mark are read together, so a
/// batch landing meanwhile is either all in the snapshot or after it.
pub fn get(
    database: &Database,
    params: UiSettingsGetParams,
) -> Result<UiSettingsSnapshot, UiSettingsError> {
    validate_get(&params)?;
    let mut snapshot = database.ui_settings_snapshot()?;
    if !params.keys.is_empty() {
        let wanted: std::collections::BTreeSet<&str> =
            params.keys.iter().map(String::as_str).collect();
        snapshot
            .entries
            .retain(|key, _| wanted.contains(key.as_str()));
    }
    Ok(snapshot)
}

/// `ui.settings.set`: validate, apply the batch in one transaction and, when
/// something landed (or the migration mark was set), tell every window. The
/// write lock keeps the events' revisions in order.
pub fn set(
    state: &AppState,
    params: UiSettingsSetParams,
) -> Result<UiSettingsChange, UiSettingsError> {
    validate_set(&params)?;
    let _ordered = state
        .ui_settings_write
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let applied = state.database.ui_settings_apply(
        &params.put,
        &params.delete,
        params.if_absent,
        params.local_storage_migrated,
        &params.unless_updated_after,
    )?;
    let change = UiSettingsChange {
        revision: applied.revision,
        put: applied.put,
        delete: applied.delete,
        writer: params.writer,
    };
    if !change.put.is_empty() || !change.delete.is_empty() || params.local_storage_migrated {
        state.emit_event(UI_SETTINGS_CHANGED_EVENT, change.clone());
    }
    Ok(change)
}

/// The previous-release profile fixture: every `localStorage` key and its
/// string, as the migration sends them.
#[cfg(test)]
pub(crate) fn previous_release_profile() -> std::collections::BTreeMap<String, serde_json::Value> {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/ui-settings-previous-release-profile.json"
    ))
    .expect("the previous-release profile fixture is JSON");
    fixture["localStorage"]
        .as_object()
        .expect("fixture.localStorage is an object")
        .iter()
        .map(|(key, value)| {
            assert!(
                value.is_string(),
                "{key} holds a string, as localStorage does"
            );
            (key.clone(), value.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Value, json};

    use super::*;

    fn test_state() -> (
        AppState,
        tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) {
        let (events, receiver) = tokio::sync::broadcast::channel(64);
        let state = AppState::new(
            "test-token".to_string(),
            0,
            events,
            Database::open_in_memory_for_tests(),
        );
        (state, receiver)
    }

    fn put(entries: &[(&str, Value)]) -> UiSettingsSetParams {
        UiSettingsSetParams {
            put: entries
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect(),
            ..UiSettingsSetParams::default()
        }
    }

    fn next_change(
        receiver: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> UiSettingsChange {
        let event = receiver.try_recv().expect("a change event");
        assert_eq!(event.event, UI_SETTINGS_CHANGED_EVENT);
        serde_json::from_value(event.payload).expect("a UiSettingsChange payload")
    }

    #[test]
    fn a_fresh_store_is_empty_unmigrated_and_at_revision_zero() {
        let (state, _) = test_state();
        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(snapshot, UiSettingsSnapshot::default());
    }

    #[test]
    fn a_batch_lands_in_one_transaction_bumps_the_revision_and_reaches_every_window() {
        let (state, mut events) = test_state();
        let change = set(
            &state,
            UiSettingsSetParams {
                writer: Some("window-a".to_string()),
                ..put(&[
                    ("videorc.theme", json!("dark")),
                    ("videorc.settings", json!({ "textSize": "m" })),
                ])
            },
        )
        .unwrap();
        assert_eq!(change.revision, 1);
        assert_eq!(change.put.len(), 2);
        assert!(change.delete.is_empty());
        assert_eq!(change.writer.as_deref(), Some("window-a"));
        assert_eq!(next_change(&mut events), change);

        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.entries["videorc.theme"], json!("dark"));
        assert_eq!(
            snapshot.entries["videorc.settings"],
            json!({ "textSize": "m" })
        );
        assert!(!snapshot.local_storage_migrated);

        // A read by keys lists the named keys that exist, nothing else.
        let some = get(
            &state.database,
            UiSettingsGetParams {
                keys: vec!["videorc.theme".to_string(), "videorc.missing".to_string()],
            },
        )
        .unwrap();
        assert_eq!(some.entries.len(), 1);
        assert_eq!(some.entries["videorc.theme"], json!("dark"));

        // A delete lands and is announced; a delete of nothing is not.
        let removed = set(
            &state,
            UiSettingsSetParams {
                delete: vec!["videorc.theme".to_string(), "videorc.missing".to_string()],
                ..UiSettingsSetParams::default()
            },
        )
        .unwrap();
        assert_eq!(removed.revision, 2);
        assert_eq!(removed.delete, vec!["videorc.theme".to_string()]);
        assert_eq!(next_change(&mut events), removed);
        let quiet = set(
            &state,
            UiSettingsSetParams {
                delete: vec!["videorc.missing".to_string()],
                ..UiSettingsSetParams::default()
            },
        )
        .unwrap();
        assert_eq!(quiet.revision, 2, "nothing landed: the revision stays");
        assert!(events.try_recv().is_err(), "nothing landed: no event");
    }

    #[test]
    fn the_store_never_touches_backend_private_rows() {
        let (state, _) = test_state();
        state
            .database
            .save_setting("overlayLayout", &json!({ "x": 1 }))
            .unwrap();
        state
            .database
            .save_setting("usageStats.enabled", &false)
            .unwrap();
        set(&state, put(&[("videorc.theme", json!("light"))])).unwrap();
        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(
            snapshot.entries.keys().collect::<Vec<_>>(),
            vec!["videorc.theme"],
            "backend-private rows and the bookkeeping rows never list"
        );
        assert_eq!(
            state
                .database
                .load_setting::<Value>("overlayLayout")
                .unwrap(),
            Some(json!({ "x": 1 }))
        );
        // The generic helpers refuse the namespace outright.
        assert!(
            state
                .database
                .save_setting("ui:videorc.theme", &json!("x"))
                .is_err()
        );
        assert!(
            state
                .database
                .load_setting::<Value>("ui:videorc.theme")
                .is_err()
        );
    }

    #[test]
    fn the_previous_release_profile_migrates_intact_once_and_never_overwrites() {
        let (state, mut events) = test_state();
        let profile = previous_release_profile();
        assert!(
            profile.len() >= 33,
            "the fixture names every known localStorage key; got {}",
            profile.len()
        );
        // A setting changed in this release before the migration ran (two
        // windows racing the same launch) is never overwritten by the copy.
        set(&state, put(&[("videorc.theme", json!("light"))])).unwrap();
        let _ = next_change(&mut events);

        let migrated = set(
            &state,
            UiSettingsSetParams {
                put: profile.clone(),
                if_absent: true,
                local_storage_migrated: true,
                writer: Some("window-main".to_string()),
                ..UiSettingsSetParams::default()
            },
        )
        .unwrap();
        assert_eq!(migrated.revision, 2);
        assert_eq!(migrated.put.len(), profile.len() - 1);
        assert!(!migrated.put.contains_key("videorc.theme"));
        assert_eq!(next_change(&mut events), migrated);

        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert!(snapshot.local_storage_migrated);
        assert_eq!(snapshot.entries["videorc.theme"], json!("light"));
        for (key, value) in &profile {
            if key == "videorc.theme" {
                continue;
            }
            assert_eq!(&snapshot.entries[key], value, "{key} arrives intact");
        }

        // Running it again (another window, a relaunch) lands nothing and
        // only re-marks; the revision moves once for the mark.
        let again = set(
            &state,
            UiSettingsSetParams {
                put: profile,
                if_absent: true,
                local_storage_migrated: true,
                ..UiSettingsSetParams::default()
            },
        )
        .unwrap();
        assert!(again.put.is_empty());
        assert_eq!(again.revision, 3);
        assert_eq!(next_change(&mut events), again);
        assert!(
            get(&state.database, UiSettingsGetParams::default())
                .unwrap()
                .local_storage_migrated
        );
    }

    #[test]
    fn a_batch_is_refused_whole_with_the_reason() {
        let (state, mut events) = test_state();
        let refusals: Vec<(&str, UiSettingsSetParams)> = vec![
            ("empty", put(&[("", json!(1))])),
            ("control", put(&[("videorc.a\nb", json!(1))])),
            ("whitespace", put(&[(" videorc.a", json!(1))])),
            ("long", put(&[(&"k".repeat(MAX_KEY_CHARS + 1), json!(1))])),
            ("null", put(&[("videorc.a", Value::Null)])),
            (
                "huge value",
                put(&[("videorc.a", json!("x".repeat(MAX_VALUE_BYTES)))]),
            ),
            (
                "put and delete",
                UiSettingsSetParams {
                    delete: vec!["videorc.a".to_string()],
                    ..put(&[("videorc.a", json!(1))])
                },
            ),
            (
                "double delete",
                UiSettingsSetParams {
                    delete: vec!["videorc.a".to_string(), "videorc.a".to_string()],
                    ..UiSettingsSetParams::default()
                },
            ),
            (
                "writer",
                UiSettingsSetParams {
                    writer: Some(String::new()),
                    ..put(&[("videorc.a", json!(1))])
                },
            ),
            (
                "too many keys",
                UiSettingsSetParams {
                    put: (0..=MAX_BATCH_KEYS)
                        .map(|i| (format!("videorc.k{i}"), json!(i)))
                        .collect(),
                    ..UiSettingsSetParams::default()
                },
            ),
        ];
        for (name, params) in refusals {
            match set(&state, params) {
                Err(UiSettingsError::Invalid(UiSettingsInvalid(message))) => {
                    assert!(!message.is_empty(), "{name} names its reason")
                }
                other => panic!("{name} must be refused as invalid, got {other:?}"),
            }
        }
        assert!(
            events.try_recv().is_err(),
            "a refused batch announces nothing"
        );
        assert_eq!(
            get(&state.database, UiSettingsGetParams::default()).unwrap(),
            UiSettingsSnapshot::default(),
            "a refused batch lands nothing"
        );
        // Two largest values are past the batch limit in all.
        let two: BTreeMap<String, Value> = (0..2)
            .map(|i| {
                (
                    format!("videorc.big{i}"),
                    json!("x".repeat(MAX_VALUE_BYTES - 2)),
                )
            })
            .collect();
        const { assert!(MAX_VALUE_BYTES * 2 > MAX_BATCH_BYTES) };
        assert!(matches!(
            set(
                &state,
                UiSettingsSetParams {
                    put: two,
                    ..UiSettingsSetParams::default()
                }
            ),
            Err(UiSettingsError::Invalid(_))
        ));
        // A write time for a key the batch neither puts nor deletes.
        assert!(matches!(
            set(
                &state,
                UiSettingsSetParams {
                    unless_updated_after: BTreeMap::from([("videorc.other".to_string(), 1)]),
                    ..put(&[("videorc.a", json!(1))])
                }
            ),
            Err(UiSettingsError::Invalid(_))
        ));
        // A read of too many keys is refused too.
        assert!(matches!(
            get(
                &state.database,
                UiSettingsGetParams {
                    keys: (0..=MAX_BATCH_KEYS).map(|i| format!("k{i}")).collect()
                }
            ),
            Err(UiSettingsError::Invalid(_))
        ));
    }

    #[test]
    fn a_value_as_large_as_a_previous_release_scene_library_lands() {
        let (state, _) = test_state();
        let library = json!("x".repeat(MAX_VALUE_BYTES - 2));
        let change = set(
            &state,
            UiSettingsSetParams {
                if_absent: true,
                local_storage_migrated: true,
                ..put(&[("videorc.scenes.v2", library.clone())])
            },
        )
        .unwrap();
        assert_eq!(change.put["videorc.scenes.v2"], library);
        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(snapshot.entries["videorc.scenes.v2"], library);
        assert!(snapshot.local_storage_migrated);
    }

    #[test]
    fn a_journal_replay_never_overwrites_or_deletes_a_newer_write() {
        let (state, mut events) = test_state();
        set(
            &state,
            put(&[
                ("videorc.theme", json!("dark")),
                ("videorc.tab", json!("chat")),
            ]),
        )
        .unwrap();
        let _ = next_change(&mut events);
        let before = chrono::Utc::now().timestamp_millis() as u64 - 60_000;
        let after = chrono::Utc::now().timestamp_millis() as u64 + 60_000;

        // Written before the store's values: nothing lands, nothing is announced.
        let stale = set(
            &state,
            UiSettingsSetParams {
                delete: vec!["videorc.tab".to_string()],
                unless_updated_after: BTreeMap::from([
                    ("videorc.theme".to_string(), before),
                    ("videorc.tab".to_string(), before),
                ]),
                ..put(&[("videorc.theme", json!("stale"))])
            },
        )
        .unwrap();
        assert!(stale.put.is_empty() && stale.delete.is_empty());
        assert_eq!(stale.revision, 1);
        assert!(events.try_recv().is_err());

        // A key the store lacks lands whatever the time; a later write lands.
        let replayed = set(
            &state,
            UiSettingsSetParams {
                delete: vec!["videorc.tab".to_string()],
                unless_updated_after: BTreeMap::from([
                    ("videorc.theme".to_string(), after),
                    ("videorc.tab".to_string(), after),
                    ("videorc.notesTab".to_string(), 0),
                ]),
                ..put(&[
                    ("videorc.theme", json!("light")),
                    ("videorc.notesTab", json!("notes")),
                ])
            },
        )
        .unwrap();
        assert_eq!(replayed.revision, 2);
        assert_eq!(replayed.put.len(), 2);
        assert_eq!(replayed.delete, vec!["videorc.tab".to_string()]);
        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(snapshot.entries["videorc.theme"], json!("light"));
        assert_eq!(snapshot.entries["videorc.notesTab"], json!("notes"));
        assert!(!snapshot.entries.contains_key("videorc.tab"));
    }

    /// One journal's replay: `put` (or delete, for `None`) of `key`, written at `at`.
    fn replay(state: &AppState, key: &str, value: Option<Value>, at: u64) -> UiSettingsChange {
        let (put, delete) = match value {
            Some(value) => (BTreeMap::from([(key.to_string(), value)]), Vec::new()),
            None => (BTreeMap::new(), vec![key.to_string()]),
        };
        set(
            state,
            UiSettingsSetParams {
                put,
                delete,
                unless_updated_after: BTreeMap::from([(key.to_string(), at)]),
                ..UiSettingsSetParams::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn a_deleted_key_stays_deleted_under_an_older_journal_and_an_ifabsent_copy() {
        let (state, _) = test_state();
        // Journal times after the live writes below, which are stamped now.
        let t10 = chrono::Utc::now().timestamp_millis() as u64 + 3_600_000;
        set(&state, put(&[("videorc.theme", json!("dark"))])).unwrap();
        // Deleted at t20 by a replayed journal, and live (now) for another key.
        assert_eq!(
            replay(&state, "videorc.theme", None, t10 + 10_000).delete,
            vec!["videorc.theme".to_string()]
        );
        set(&state, put(&[("videorc.tab", json!("chat"))])).unwrap();
        set(
            &state,
            UiSettingsSetParams {
                delete: vec!["videorc.tab".to_string()],
                ..UiSettingsSetParams::default()
            },
        )
        .unwrap();

        // A journal's put from before either delete never brings them back.
        assert!(
            replay(&state, "videorc.theme", Some(json!("stale")), t10)
                .put
                .is_empty()
        );
        let before_now = chrono::Utc::now().timestamp_millis() as u64 - 60_000;
        assert!(
            replay(&state, "videorc.tab", Some(json!("stale")), before_now)
                .put
                .is_empty()
        );
        // Nor does an `ifAbsent` copy (the migration).
        let copy = set(
            &state,
            UiSettingsSetParams {
                if_absent: true,
                ..put(&[
                    ("videorc.theme", json!("old")),
                    ("videorc.tab", json!("old")),
                ])
            },
        )
        .unwrap();
        assert!(copy.put.is_empty());
        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert!(snapshot.entries.is_empty(), "{:?}", snapshot.entries);

        // A write after the delete lands, and clears the tombstone.
        assert_eq!(
            replay(&state, "videorc.theme", Some(json!("light")), t10 + 20_000)
                .put
                .len(),
            1
        );
        let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(snapshot.entries["videorc.theme"], json!("light"));
    }

    #[test]
    fn two_journals_of_one_key_leave_the_newer_write_in_either_order() {
        let t10 = 1_795_000_010_000;
        let t20 = t10 + 10_000;
        for newer_first in [false, true] {
            let (state, _) = test_state();
            let journals = if newer_first {
                [("v2", t20), ("v1", t10)]
            } else {
                [("v1", t10), ("v2", t20)]
            };
            for (value, at) in journals {
                replay(&state, "videorc.theme", Some(json!(value)), at);
            }
            let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
            assert_eq!(
                snapshot.entries["videorc.theme"],
                json!("v2"),
                "newer first: {newer_first}"
            );

            // The same with a delete as the newer write.
            for (value, at) in [(None, t20 + 10_000), (Some(json!("v3")), t20 + 5_000)] {
                replay(&state, "videorc.theme", value, at);
            }
            let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
            assert!(!snapshot.entries.contains_key("videorc.theme"));
        }
    }

    #[test]
    fn a_delete_of_an_absent_key_still_outranks_an_older_put_in_either_order() {
        let (t5, t10, t20) = (1_795_000_005_000, 1_795_000_010_000, 1_795_000_020_000);
        for delete_first in [true, false] {
            // K never existed: delete@t20 and put@t10, from two journals.
            let (state, mut events) = test_state();
            let steps = if delete_first {
                [(None, t20), (Some(json!("old")), t10)]
            } else {
                [(Some(json!("old")), t10), (None, t20)]
            };
            for (value, at) in steps {
                replay(&state, "videorc.theme", value, at);
            }
            let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
            assert!(
                !snapshot.entries.contains_key("videorc.theme"),
                "absent key, delete first: {delete_first}"
            );
            // A delete of an absent key changes nothing a window sees: only
            // the put that landed (when it came first) was announced.
            let announced = std::iter::from_fn(|| events.try_recv().ok()).count();
            assert_eq!(
                announced,
                if delete_first { 0 } else { 2 },
                "delete first: {delete_first}"
            );

            // An existing t5 tombstone advanced by a delete@t20 of the
            // absent key outranks a put@t10, in either order.
            let (state, _) = test_state();
            replay(&state, "videorc.tab", Some(json!("chat")), t5 - 1_000);
            replay(&state, "videorc.tab", None, t5);
            let steps = if delete_first {
                [(None, t20), (Some(json!("old")), t10)]
            } else {
                [(Some(json!("old")), t10), (None, t20)]
            };
            for (value, at) in steps {
                replay(&state, "videorc.tab", value, at);
            }
            let snapshot = get(&state.database, UiSettingsGetParams::default()).unwrap();
            assert!(
                !snapshot.entries.contains_key("videorc.tab"),
                "advanced tombstone, delete first: {delete_first}"
            );
        }
    }

    #[test]
    fn a_snapshot_never_pairs_old_entries_with_a_newer_revision() {
        let (state, _) = test_state();
        let database = &state.database;
        let none = BTreeMap::new();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for index in 0..300 {
                    let put = BTreeMap::from([(format!("videorc.k{index}"), json!(index))]);
                    database
                        .ui_settings_apply(&put, &[], false, index == 299, &none)
                        .unwrap();
                }
            });
            // Every batch adds one key and one revision, so a consistent
            // snapshot always holds as many keys as its revision.
            loop {
                let snapshot = get(database, UiSettingsGetParams::default()).unwrap();
                assert_eq!(snapshot.entries.len() as u64, snapshot.revision);
                if snapshot.local_storage_migrated {
                    assert_eq!(snapshot.revision, 300);
                    break;
                }
            }
        });
    }

    #[test]
    fn the_revision_survives_a_reopen() {
        // Declared first: it drops last, after the databases below.
        let dir = crate::test_temp_dir::TestTempDir::new("ui-settings-revision");
        let path = dir.join("videorc.sqlite3");
        {
            let (events, _) = tokio::sync::broadcast::channel(8);
            let state = AppState::new(
                "t".to_string(),
                0,
                events,
                Database::open_file_for_tests(&path),
            );
            set(&state, put(&[("videorc.theme", json!("dark"))])).unwrap();
            set(&state, put(&[("videorc.theme", json!("light"))])).unwrap();
        }
        let database = Database::open_file_for_tests(&path);
        let snapshot = get(&database, UiSettingsGetParams::default()).unwrap();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.entries["videorc.theme"], json!("light"));
        drop(database);
    }
}
