//! The starter sounds (plan 189): the twelve CC0 sounds Videorc ships in
//! `sounds/starter` ([`crate::bundled`]), imported once per profile and
//! again by Restore starter sounds.
//!
//! Electron splits this across main (`sound-files.ts`: the manifest, the
//! folder, the file check) and the renderer (`sound-starters.ts`: the
//! imports, the key rule, the seeded flag). The GPUI app reads the folder
//! itself, so both halves are here; the panel runs the requests.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::copy::{
    SOUND_COUNT_LIMIT_REASON, SOUND_HOTKEYS, SOUND_NAME_MAX_CHARS, SOUND_TOTAL_LIMIT_REASON,
};

/// The manifest beside the starter files (`STARTER_SOUNDS_MANIFEST`).
pub const STARTER_SOUNDS_MANIFEST: &str = "manifest.json";

/// `SOUND_STARTER_SLUG_MAX_CHARS`.
pub const STARTER_SLUG_MAX_CHARS: usize = 32;

/// The restore's toast (`RESTORE_TOAST`).
pub const RESTORE_TOAST_ID: &str = "sound-restore";

/// Restore's failure when an import failed for another reason.
pub const STARTER_IMPORT_FAILED: &str = "A starter sound import failed.";

/// A manifest row the app offers (`StarterSoundRow`), with its file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterRow {
    pub slug: String,
    pub name: String,
    pub hotkey: Option<String>,
    pub file: String,
}

/// `isSoundStarterSlug`: lowercase words joined by single hyphens, up to 32
/// characters.
pub fn is_starter_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= STARTER_SLUG_MAX_CHARS
        && value.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `isStarterSoundFileName`: a bare `.ogg` basename beside the manifest.
pub fn is_starter_file_name(value: &str) -> bool {
    value.len() > 4
        && value.len() <= 255
        && value.ends_with(".ogg")
        && !value.starts_with('.')
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains("..")
        && !value.contains('\0')
}

/// A manifest row's string field.
fn field<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(Value::as_str)
}

/// `starterSoundRows`: the rows to offer, in manifest order, and why the
/// rest were refused (for the log). A slug or a key seen before is refused
/// or dropped, so the board never gets two of either.
pub fn starter_rows(manifest: &Value) -> (Vec<StarterRow>, Vec<String>) {
    let Some(list) = manifest.get("sounds").and_then(Value::as_array) else {
        return (
            Vec::new(),
            vec!["The manifest has no sounds list.".to_string()],
        );
    };
    let mut rows = Vec::new();
    let mut refused = Vec::new();
    let mut slugs = BTreeSet::new();
    let mut hotkeys = BTreeSet::new();
    for (index, entry) in list.iter().enumerate() {
        let at = format!("Row {}", index + 1);
        let Some(slug) = field(entry, "slug").filter(|slug| is_starter_slug(slug)) else {
            refused.push(format!("{at}: not a starter slug."));
            continue;
        };
        if slugs.contains(slug) {
            refused.push(format!("{at}: {slug} is listed twice."));
            continue;
        }
        let name = match field(entry, "name") {
            Some(name)
                if !name.trim().is_empty() && name.chars().count() <= SOUND_NAME_MAX_CHARS =>
            {
                name.trim().to_string()
            }
            _ => {
                refused.push(format!("{at}: {slug} has no usable name."));
                continue;
            }
        };
        let hotkey = match entry.get("hotkey") {
            None => None,
            Some(value) => match value.as_str().filter(|key| SOUND_HOTKEYS.contains(key)) {
                Some(key) => Some(key.to_string()),
                None => {
                    refused.push(format!("{at}: {slug} has a key other than 1 to 9."));
                    continue;
                }
            },
        };
        let Some(file) = field(entry, "file").filter(|file| is_starter_file_name(file)) else {
            refused.push(format!(
                "{at}: {slug} names a file that isn't an .ogg beside it."
            ));
            continue;
        };
        slugs.insert(slug.to_string());
        let hotkey = hotkey.filter(|key| hotkeys.insert(key.clone()));
        rows.push(StarterRow {
            slug: slug.to_string(),
            name,
            hotkey,
            file: file.to_string(),
        });
    }
    (rows, refused)
}

/// The rows in `dir`'s manifest whose file is a regular file there, with
/// its path (`readStarterSoundRows`); none when the manifest is missing or
/// unreadable. The refusals are for the log.
pub fn read_starter_rows(dir: &Path) -> (Vec<(StarterRow, PathBuf)>, Vec<String>) {
    let manifest = match std::fs::read(dir.join(STARTER_SOUNDS_MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(manifest) => manifest,
        None => {
            return (
                Vec::new(),
                vec![format!(
                    "No readable starter manifest in {}.",
                    dir.display()
                )],
            );
        }
    };
    let (rows, mut refused) = starter_rows(&manifest);
    let mut found = Vec::new();
    for row in rows {
        let path = dir.join(&row.file);
        let regular = std::fs::symlink_metadata(&path)
            .map(|meta| meta.file_type().is_file())
            .unwrap_or(false);
        if regular {
            found.push((row, path));
        } else {
            refused.push(format!("{} is missing from the starter folder.", row.file));
        }
    }
    (found, refused)
}

/// `sounds.import`'s params for a starter (`importStarterFiles`): its slug
/// and name, and its key unless another sound has it (`taken`), so a restore
/// never takes a key from the streamer's own sound.
pub fn starter_import_params(
    row: &StarterRow,
    capability_id: &str,
    taken: &BTreeSet<String>,
) -> Value {
    let mut starter = Map::new();
    starter.insert("slug".into(), json!(row.slug));
    starter.insert("name".into(), json!(row.name));
    if let Some(hotkey) = row.hotkey.as_ref().filter(|key| !taken.contains(*key)) {
        starter.insert("hotkey".into(), json!(hotkey));
    }
    json!({ "sourceCapability": capability_id, "starter": Value::Object(starter) })
}

/// `isSoundLimitRefusal(soundRefusal(error))`: the count or total limit,
/// which no later import in the run can get past.
pub fn limit_refusal(message: &str) -> Option<&'static str> {
    [SOUND_COUNT_LIMIT_REASON, SOUND_TOTAL_LIMIT_REASON]
        .into_iter()
        .find(|sentence| message.contains(sentence))
}

/// `isOffline`: Videorc's connection went away mid-run.
pub fn is_offline_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "reconnecting",
        "isn't connected",
        "connection closed",
        "shut down",
        "couldn't connect",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// What a run of starter imports came to (`StarterImportOutcome`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StarterImportOutcome {
    pub imported: usize,
    /// Imports that failed for another reason (logged).
    pub failed: usize,
    /// A limit refusal that ended the run, verbatim.
    pub refusal: Option<String>,
    /// The connection went away mid-run.
    pub offline: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(slug: &str, hotkey: Option<&str>) -> StarterRow {
        StarterRow {
            slug: slug.into(),
            name: slug.into(),
            hotkey: hotkey.map(Into::into),
            file: format!("{slug}.ogg"),
        }
    }

    #[test]
    fn reads_the_manifest_rows_and_refuses_the_bad_ones() {
        let manifest = json!({ "sounds": [
            { "slug": "airhorn", "name": " Airhorn ", "hotkey": "1", "file": "airhorn.ogg" },
            { "slug": "airhorn", "name": "Again", "file": "again.ogg" },
            { "slug": "Bad Slug", "name": "x", "file": "x.ogg" },
            { "slug": "laugh", "name": "", "file": "laugh.ogg" },
            { "slug": "tada", "name": "Tada", "hotkey": "0", "file": "tada.ogg" },
            { "slug": "ding", "name": "Ding", "file": "../ding.ogg" },
            { "slug": "boom", "name": "Boom", "hotkey": "1", "file": "boom.ogg" }
        ]});
        let (rows, refused) = starter_rows(&manifest);
        assert_eq!(
            rows,
            vec![
                StarterRow {
                    slug: "airhorn".into(),
                    name: "Airhorn".into(),
                    hotkey: Some("1".into()),
                    file: "airhorn.ogg".into(),
                },
                // A key seen before is dropped, the row kept.
                row("boom", None).clone_with_name("Boom"),
            ]
        );
        assert_eq!(refused.len(), 5);
        assert_eq!(starter_rows(&json!({})).0, Vec::new());
    }

    impl StarterRow {
        fn clone_with_name(mut self, name: &str) -> Self {
            self.name = name.into();
            self
        }
    }

    #[test]
    fn slugs_and_files_follow_electrons_rules() {
        assert!(is_starter_slug("sad-trombone"));
        assert!(!is_starter_slug("sad--trombone"));
        assert!(!is_starter_slug("-ding"));
        assert!(!is_starter_slug(&"a".repeat(33)));
        assert!(is_starter_file_name("airhorn.ogg"));
        assert!(!is_starter_file_name(".ogg"));
        assert!(!is_starter_file_name("sub/airhorn.ogg"));
        assert!(!is_starter_file_name("airhorn.mp3"));
    }

    #[test]
    fn the_checkout_ships_twelve_starters_with_their_files() {
        let (rows, refused) = read_starter_rows(&crate::bundled::current().starter_sounds);
        assert_eq!(rows.len(), 12, "{refused:?}");
        assert_eq!(rows[0].0.slug, "airhorn");
        assert!(rows.iter().all(|(_, path)| path.is_file()));
    }

    #[test]
    fn a_taken_key_is_left_off_the_import() {
        let taken = BTreeSet::from(["1".to_string()]);
        let params = starter_import_params(&row("airhorn", Some("1")), "cap-1", &taken);
        assert_eq!(
            params,
            json!({ "sourceCapability": "cap-1", "starter": { "slug": "airhorn", "name": "airhorn" } })
        );
        let params = starter_import_params(&row("tada", Some("2")), "cap-2", &taken);
        assert_eq!(params["starter"]["hotkey"], "2");
    }

    #[test]
    fn limit_and_offline_answers_end_the_run() {
        assert_eq!(
            limit_refusal(&format!("sounds.import: {SOUND_COUNT_LIMIT_REASON}")),
            Some(SOUND_COUNT_LIMIT_REASON)
        );
        assert_eq!(limit_refusal("This file is silent."), None);
        assert!(is_offline_message("Videorc is reconnecting."));
        assert!(is_offline_message("Couldn't connect to the backend"));
        assert!(!is_offline_message("This file is silent."));
    }
}
