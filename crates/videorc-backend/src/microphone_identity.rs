//! Plan 254 S7: a saved CoreAudio microphone survives a drifted device id.
//!
//! The renderer saves the microphone it picked as `microphone:coreaudio:<id>`,
//! and `<id>` is CoreAudio's `AudioDeviceID`: a number CoreAudio hands out
//! again whenever the device list changes, and after a reboot. One USB
//! microphone was 109, 110, 108 and 109 over two days (2026-11-18/19). A
//! saved id from an earlier list then names no device, and the first open
//! after a backend start failed as "missing or its identity is ambiguous"
//! until the renderer picked from a fresh list.
//!
//! So every list CoreAudio answers is remembered here as id → (UID, name),
//! and kept in the settings so a restarted backend still knows what a saved
//! id meant. An id that no longer names its device is resolved by the UID it
//! had, then by its exact name when exactly one listed device has it. Two
//! listed devices with that name stay ambiguous: nothing here ever picks a
//! different device silently.

use std::sync::{Mutex, OnceLock, PoisonError};

use serde::{Deserialize, Serialize};

/// The setting that keeps what each CoreAudio id last named.
pub(crate) const MICROPHONE_IDENTITIES_KEY: &str = "audio.microphone.identities";
/// Ids remembered at most; the oldest go first.
const REMEMBERED_MAX: usize = 64;

/// One CoreAudio input device as a list named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MicrophoneIdentity {
    pub device_id: u32,
    /// `kAudioDevicePropertyDeviceUID`: the identity that survives a new id.
    #[serde(default)]
    pub uid: Option<String>,
    pub name: String,
}

/// What each id last named, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct MicrophoneBook {
    entries: Vec<MicrophoneIdentity>,
}

impl MicrophoneBook {
    pub(crate) fn remembered(&self, device_id: u32) -> Option<&MicrophoneIdentity> {
        self.entries
            .iter()
            .find(|entry| entry.device_id == device_id)
    }

    /// Records a list. An id that is not listed keeps what it last named:
    /// that is the entry a drifted id is resolved from. Returns whether
    /// anything changed.
    pub(crate) fn observe(&mut self, listed: &[MicrophoneIdentity]) -> bool {
        let mut changed = false;
        for device in listed {
            if self.remembered(device.device_id) == Some(device) {
                continue;
            }
            self.entries
                .retain(|entry| entry.device_id != device.device_id);
            self.entries.push(device.clone());
            changed = true;
        }
        if self.entries.len() > REMEMBERED_MAX {
            let excess = self.entries.len() - REMEMBERED_MAX;
            self.entries.drain(..excess);
        }
        changed
    }
}

/// How a saved id found its device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MatchedBy {
    Id,
    Uid,
    Name,
}

/// Why a saved id found no device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unresolved {
    Missing,
    Ambiguous,
}

/// Pure: the listed device a saved `requested` id means. `remembered` is
/// what that id last named, from before this list.
///
/// - The id is listed and still names what it named: that device.
/// - Otherwise the device with the remembered UID; then the one listed
///   device with the remembered name.
/// - Two listed devices with that UID or name: ambiguous, never a guess.
/// - An id that now names another device while its own is gone: missing,
///   never the other device.
pub(crate) fn resolve(
    requested: u32,
    remembered: Option<&MicrophoneIdentity>,
    listed: &[MicrophoneIdentity],
) -> Result<(u32, MatchedBy), Unresolved> {
    let mut exact = listed.iter().filter(|device| device.device_id == requested);
    if let Some(device) = exact.next() {
        if exact.next().is_some() {
            return Err(Unresolved::Ambiguous);
        }
        let reassigned = remembered.is_some_and(|remembered| {
            match (remembered.uid.as_deref(), device.uid.as_deref()) {
                (Some(saved), Some(now)) => saved != now,
                _ => false,
            }
        });
        if !reassigned {
            return Ok((requested, MatchedBy::Id));
        }
    }
    let Some(remembered) = remembered else {
        return Err(Unresolved::Missing);
    };
    let one = |matches: Vec<&MicrophoneIdentity>, by: MatchedBy| match matches.as_slice() {
        [] => Ok(None),
        [device] => Ok(Some((device.device_id, by))),
        _ => Err(Unresolved::Ambiguous),
    };
    if let Some(uid) = remembered.uid.as_deref()
        && let Some(found) = one(
            listed
                .iter()
                .filter(|device| device.uid.as_deref() == Some(uid))
                .collect(),
            MatchedBy::Uid,
        )?
    {
        return Ok(found);
    }
    one(
        listed
            .iter()
            .filter(|device| device.name == remembered.name)
            .collect(),
        MatchedBy::Name,
    )?
    .ok_or(Unresolved::Missing)
}

fn describe(device: &MicrophoneIdentity) -> String {
    format!(
        "{} \"{}\" (UID {})",
        device.device_id,
        device.name,
        device.uid.as_deref().unwrap_or("unknown")
    )
}

/// The log line for a saved id that found no device: the requested id, what
/// it last named, and every id, name and UID CoreAudio lists now.
pub(crate) fn unresolved_message(
    requested: u32,
    remembered: Option<&MicrophoneIdentity>,
    listed: &[MicrophoneIdentity],
    why: Unresolved,
) -> String {
    let saved = match remembered {
        Some(remembered) => format!("it last named {}", describe(remembered)),
        None => "nothing is remembered for it".to_string(),
    };
    let now = if listed.is_empty() {
        "no input devices".to_string()
    } else {
        listed.iter().map(describe).collect::<Vec<_>>().join(", ")
    };
    format!(
        "Requested microphone:coreaudio:{requested} is {}: {saved}; CoreAudio lists {now}.",
        match why {
            Unresolved::Missing => "missing",
            Unresolved::Ambiguous => "ambiguous",
        }
    )
}

static BOOK: Mutex<MicrophoneBook> = Mutex::new(MicrophoneBook {
    entries: Vec::new(),
});
static STORE: OnceLock<crate::storage::Database> = OnceLock::new();

fn book() -> std::sync::MutexGuard<'static, MicrophoneBook> {
    BOOK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// At startup: reads what an earlier process remembered, and keeps the
/// database for what this one learns. A row this build cannot read is
/// ignored.
pub(crate) fn restore(database: &crate::storage::Database) {
    if let Ok(Some(saved)) = database.load_setting::<MicrophoneBook>(MICROPHONE_IDENTITIES_KEY) {
        let mut book = book();
        // What this process already listed is newer than the saved row.
        let learned = std::mem::replace(&mut *book, saved);
        book.observe(&learned.entries);
    }
    let _ = STORE.set(database.clone());
}

/// Remembers a list CoreAudio just answered, and saves it when it changed.
pub(crate) fn observe(listed: &[MicrophoneIdentity]) {
    let changed = {
        let mut book = book();
        book.observe(listed).then(|| book.clone())
    };
    if let (Some(book), Some(database)) = (changed, STORE.get())
        && let Err(error) = database.save_setting(MICROPHONE_IDENTITIES_KEY, &book)
    {
        tracing::warn!("Could not save the microphone identities: {error:#}");
    }
}

/// The CoreAudio id to open for a saved `requested` id, against the list
/// CoreAudio answers now. Logs a resolved drift, and logs the requested id
/// beside everything listed when nothing matches.
pub(crate) fn current_device_id(requested: u32) -> Result<u32, Unresolved> {
    let listed = match crate::audio::list_native_microphone_identities() {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(
                "Requested microphone:coreaudio:{requested}, but CoreAudio listed no input devices: {error:#}"
            );
            return Err(Unresolved::Missing);
        }
    };
    // Read before this list is recorded: the entry says what the saved id
    // meant when it was saved.
    let remembered = book().remembered(requested).cloned();
    let resolved = resolve(requested, remembered.as_ref(), &listed);
    match &resolved {
        Ok((_, MatchedBy::Id)) => {}
        Ok((device_id, by)) => {
            tracing::info!(
                "Saved microphone:coreaudio:{requested} is now CoreAudio device {device_id} ({}), matched by its {}.",
                remembered
                    .as_ref()
                    .map_or("unknown", |remembered| remembered.name.as_str()),
                if *by == MatchedBy::Uid { "UID" } else { "name" }
            );
        }
        Err(why) => {
            tracing::warn!(
                "{}",
                unresolved_message(requested, remembered.as_ref(), &listed, *why)
            );
        }
    }
    observe(&listed);
    resolved.map(|(device_id, _)| device_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(device_id: u32, uid: &str, name: &str) -> MicrophoneIdentity {
        MicrophoneIdentity {
            device_id,
            uid: (!uid.is_empty()).then(|| uid.to_string()),
            name: name.to_string(),
        }
    }

    const SHURE_UID: &str = "AppleUSBAudioEngine:Shure Inc:Shure MV7+:1234:1";

    #[test]
    fn a_listed_id_that_still_names_its_device_opens_as_itself() {
        let listed = [
            device(109, SHURE_UID, "Shure MV7+"),
            device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
        ];
        assert_eq!(
            resolve(109, Some(&listed[0]), &listed),
            Ok((109, MatchedBy::Id))
        );
        // Nothing remembered (a first launch): the listed id is trusted.
        assert_eq!(resolve(63, None, &listed), Ok((63, MatchedBy::Id)));
    }

    #[test]
    fn a_drifted_id_still_opens_the_saved_microphone_by_its_uid() {
        // Saved as 109; CoreAudio now calls the same microphone 110.
        let saved = device(109, SHURE_UID, "Shure MV7+");
        let listed = [
            device(110, SHURE_UID, "Shure MV7+"),
            device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
        ];
        assert_eq!(
            resolve(109, Some(&saved), &listed),
            Ok((110, MatchedBy::Uid))
        );
        // The UID wins over a name another device also has.
        let twins = [
            device(110, SHURE_UID, "Shure MV7+"),
            device(
                111,
                "AppleUSBAudioEngine:Shure Inc:Shure MV7+:9999:2",
                "Shure MV7+",
            ),
        ];
        assert_eq!(
            resolve(109, Some(&saved), &twins),
            Ok((110, MatchedBy::Uid))
        );
    }

    #[test]
    fn a_drifted_id_with_no_uid_match_opens_the_one_device_with_its_exact_name() {
        // A UID that moved with the port, or none recorded.
        let listed = [
            device(
                108,
                "AppleUSBAudioEngine:Shure Inc:Shure MV7+:1234:2",
                "Shure MV7+",
            ),
            device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
        ];
        assert_eq!(
            resolve(109, Some(&device(109, SHURE_UID, "Shure MV7+")), &listed),
            Ok((108, MatchedBy::Name))
        );
        assert_eq!(
            resolve(109, Some(&device(109, "", "Shure MV7+")), &listed),
            Ok((108, MatchedBy::Name))
        );
        // Exact: a longer or differently cased name is another device.
        assert_eq!(
            resolve(109, Some(&device(109, "", "shure mv7+")), &listed),
            Err(Unresolved::Missing)
        );
    }

    #[test]
    fn two_devices_with_the_saved_name_stay_ambiguous_and_none_is_picked() {
        let saved = device(109, SHURE_UID, "Shure MV7+");
        let listed = [
            device(
                110,
                "AppleUSBAudioEngine:Shure Inc:Shure MV7+:5555:1",
                "Shure MV7+",
            ),
            device(
                111,
                "AppleUSBAudioEngine:Shure Inc:Shure MV7+:9999:2",
                "Shure MV7+",
            ),
            device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
        ];
        assert_eq!(
            resolve(109, Some(&saved), &listed),
            Err(Unresolved::Ambiguous)
        );
        // Two devices answering the saved UID: no guess either.
        let same_uid = [
            device(110, SHURE_UID, "Shure MV7+"),
            device(111, SHURE_UID, "Shure MV7+ (2)"),
        ];
        assert_eq!(
            resolve(109, Some(&saved), &same_uid),
            Err(Unresolved::Ambiguous)
        );
    }

    #[test]
    fn a_missing_microphone_is_missing_and_another_device_never_stands_in() {
        let saved = device(109, SHURE_UID, "Shure MV7+");
        let builtin = device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone");
        // Unplugged.
        assert_eq!(
            resolve(109, Some(&saved), std::slice::from_ref(&builtin)),
            Err(Unresolved::Missing)
        );
        // Unplugged, and its old id now names another device: still missing.
        let reused = [device(
            109,
            "BuiltInMicrophoneDevice",
            "MacBook Pro Microphone",
        )];
        assert_eq!(
            resolve(109, Some(&saved), &reused),
            Err(Unresolved::Missing)
        );
        // Its old id names another device and it is listed under a new one.
        let moved = [
            device(109, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
            device(110, SHURE_UID, "Shure MV7+"),
        ];
        assert_eq!(
            resolve(109, Some(&saved), &moved),
            Ok((110, MatchedBy::Uid))
        );
        // Never listed and never remembered.
        assert_eq!(resolve(7, None, &[builtin]), Err(Unresolved::Missing));
    }

    #[test]
    fn the_log_names_the_requested_id_and_every_listed_id_uid_and_name() {
        let saved = device(109, SHURE_UID, "Shure MV7+");
        let listed = [
            device(
                110,
                "AppleUSBAudioEngine:Shure Inc:Shure MV7+:5555:1",
                "Shure MV7+",
            ),
            device(63, "", "MacBook Pro Microphone"),
        ];
        assert_eq!(
            unresolved_message(109, Some(&saved), &listed, Unresolved::Missing),
            "Requested microphone:coreaudio:109 is missing: it last named 109 \"Shure MV7+\" \
             (UID AppleUSBAudioEngine:Shure Inc:Shure MV7+:1234:1); CoreAudio lists 110 \
             \"Shure MV7+\" (UID AppleUSBAudioEngine:Shure Inc:Shure MV7+:5555:1), 63 \
             \"MacBook Pro Microphone\" (UID unknown)."
        );
        assert_eq!(
            unresolved_message(7, None, &[], Unresolved::Ambiguous),
            "Requested microphone:coreaudio:7 is ambiguous: nothing is remembered for it; \
             CoreAudio lists no input devices."
        );
    }

    #[test]
    fn the_book_keeps_what_an_unlisted_id_named_across_a_restart() {
        let mut book = MicrophoneBook::default();
        assert!(book.observe(&[
            device(109, SHURE_UID, "Shure MV7+"),
            device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
        ]));
        // The next day's list: the same microphone under a new id.
        let today = [
            device(110, SHURE_UID, "Shure MV7+"),
            device(63, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
        ];
        assert!(book.observe(&today));
        assert!(!book.observe(&today), "an unchanged list changes nothing");
        // A restarted process reads the row back.
        let restored: MicrophoneBook =
            serde_json::from_str(&serde_json::to_string(&book).unwrap()).unwrap();
        assert_eq!(restored, book);
        assert_eq!(
            resolve(109, restored.remembered(109), &today),
            Ok((110, MatchedBy::Uid))
        );
        // An id handed to another device names that device from then on.
        assert!(book.observe(&[device(
            109,
            "BuiltInMicrophoneDevice",
            "MacBook Pro Microphone"
        )]));
        assert_eq!(
            book.remembered(109).map(|entry| entry.name.as_str()),
            Some("MacBook Pro Microphone")
        );
    }

    /// The real CoreAudio read (the UID property is read through FFI): every
    /// listed input has a name, and a UID CoreAudio answers is never blank.
    /// A machine with no input devices lists none.
    #[cfg(target_os = "macos")]
    #[test]
    fn coreaudio_lists_each_input_with_its_name_and_uid() {
        let listed = crate::audio::list_native_microphone_identities().unwrap();
        for device in &listed {
            println!("{}", describe(device));
            assert!(!device.name.is_empty());
            assert!(device.uid.as_deref() != Some(""));
            assert_eq!(
                resolve(device.device_id, Some(device), &listed).map(|(id, _)| id),
                Ok(device.device_id)
            );
        }
    }

    #[test]
    fn the_book_is_bounded_and_drops_its_oldest_ids_first() {
        let mut book = MicrophoneBook::default();
        for device_id in 0..(REMEMBERED_MAX as u32 + 5) {
            book.observe(&[device(device_id, "", "Microphone")]);
        }
        assert_eq!(book.entries.len(), REMEMBERED_MAX);
        assert!(book.remembered(4).is_none());
        assert!(book.remembered(5).is_some());
    }

    #[test]
    fn the_identities_round_trip_through_the_settings_and_an_unreadable_row_is_refused() {
        let database = crate::storage::Database::open_in_memory_for_tests();
        let mut saved = MicrophoneBook::default();
        saved.observe(&[device(109, SHURE_UID, "Shure MV7+")]);
        database
            .save_setting(MICROPHONE_IDENTITIES_KEY, &saved)
            .unwrap();
        assert_eq!(
            database
                .load_setting::<MicrophoneBook>(MICROPHONE_IDENTITIES_KEY)
                .unwrap(),
            Some(saved)
        );
        // An unreadable row is ignored, never trusted.
        database
            .save_setting(MICROPHONE_IDENTITIES_KEY, &serde_json::json!({ "v": 2 }))
            .unwrap();
        assert!(
            database
                .load_setting::<MicrophoneBook>(MICROPHONE_IDENTITIES_KEY)
                .is_err()
        );
    }
}
