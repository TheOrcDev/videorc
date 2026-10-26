//! Plan 195 S5: Media Foundation probe rejections remembered across app runs.
//!
//! A record-only Windows start probes the hardware H.264 encoder per canvas
//! rung before anything is sized (`resolve_windows_recordable_video`). On a
//! PC whose Intel MFT rejects every topology, bitrate and canvas (the plan's
//! Iris Xe laptop: `process-output 0x8000FFFF`), each probe costs 1–4 s and
//! the process-lifetime cache forgets them at every launch, so the first
//! start of every run paid seconds for an answer that never changes. This
//! store keeps the rejections in the settings table, keyed by what could
//! change the answer: the GPU driver identity and the app version
//! invalidate the whole set, the encoder preference, profile and topology
//! select an entry, and an entry expires after a week. Successes are never
//! stored; a driver that starts working is found by probing again.
//!
//! Pure: `recording.rs` owns the database handle and the Windows wiring.
use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// `app_settings` key the store lives under (used by the Windows wiring).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const SETTING_KEY: &str = "windows_mf_probe_rejections";
/// A remembered rejection older than this is probed again.
pub(crate) const REJECTION_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Bounded like every stored verdict; the oldest entries make room.
const MAX_ENTRIES: usize = 64;
/// A probe error can quote a whole topology ladder; the store keeps the head.
const MAX_REASON_CHARS: usize = 300;

/// What selects one remembered rejection inside a driver + app version.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RejectionKey {
    /// `auto`, `quick-sync`, `software`: what "no usable GPU encoder" means.
    pub encoder_preference: String,
    /// The output role's capability label (`record`, `stream-horizontal`, …).
    pub topology: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredRejection {
    #[serde(flatten)]
    pub key: RejectionKey,
    pub reason: String,
    /// RFC 3339; an unparsable stamp reads as expired.
    pub rejected_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredRejections {
    pub driver_identity: String,
    pub app_version: String,
    #[serde(default)]
    pub entries: Vec<StoredRejection>,
}

impl StoredRejections {
    pub(crate) fn empty(driver_identity: &str, app_version: &str) -> Self {
        Self {
            driver_identity: driver_identity.to_string(),
            app_version: app_version.to_string(),
            entries: Vec::new(),
        }
    }

    /// The stored set when it was written for this driver and app version,
    /// with expired entries dropped; otherwise a fresh empty set, so a driver
    /// update or an app update probes everything again.
    pub(crate) fn adopt(
        stored: Option<Self>,
        driver_identity: &str,
        app_version: &str,
        now: DateTime<Utc>,
    ) -> Self {
        match stored {
            Some(mut stored)
                if stored.driver_identity == driver_identity
                    && stored.app_version == app_version =>
            {
                stored.prune(now);
                stored
            }
            _ => Self::empty(driver_identity, app_version),
        }
    }

    /// The remembered reason for `key`, when it has not expired.
    pub(crate) fn lookup(&self, key: &RejectionKey, now: DateTime<Utc>) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| &entry.key == key && !expired(&entry.rejected_at, now))
            .map(|entry| entry.reason.as_str())
    }

    /// Remembers a rejection, replacing an earlier one for the same key.
    pub(crate) fn remember(&mut self, key: RejectionKey, reason: &str, now: DateTime<Utc>) {
        self.prune(now);
        self.entries.retain(|entry| entry.key != key);
        self.entries.push(StoredRejection {
            key,
            reason: reason.chars().take(MAX_REASON_CHARS).collect(),
            rejected_at: now.to_rfc3339(),
        });
        while self.entries.len() > MAX_ENTRIES {
            self.entries.remove(0);
        }
    }

    fn prune(&mut self, now: DateTime<Utc>) {
        self.entries
            .retain(|entry| !expired(&entry.rejected_at, now));
        // A duplicate key from an older build keeps its newest entry.
        let mut seen: HashMap<RejectionKey, usize> = HashMap::new();
        let mut keep = vec![true; self.entries.len()];
        for (index, entry) in self.entries.iter().enumerate() {
            if let Some(previous) = seen.insert(entry.key.clone(), index) {
                keep[previous] = false;
            }
        }
        let mut index = 0;
        self.entries.retain(|_| {
            let kept = keep[index];
            index += 1;
            kept
        });
    }
}

/// `MF_E_UNSUPPORTED_D3D_TYPE` from `SetOutputType` is how the NVIDIA H.264
/// MFT says every GPU encoder session is taken (the consumer driver caps
/// concurrent NVENC sessions; another app, or this one's retired encoders,
/// can hold them). It says nothing about the profile, so it is never
/// remembered as a rejection and earns a retry once sessions are freed.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn is_encoder_session_exhaustion(failure: &str) -> bool {
    failure.contains("set-output-type HRESULT=0xC00D6D76")
}

fn expired(rejected_at: &str, now: DateTime<Utc>) -> bool {
    let Ok(at) = DateTime::parse_from_rfc3339(rejected_at) else {
        return true;
    };
    let age = now.signed_duration_since(at.with_timezone(&Utc));
    match age.to_std() {
        Ok(age) => age > REJECTION_TTL,
        // A stamp more than a minute in the future: the clock was set back,
        // so the entry's age is unknown and it is probed again.
        Err(_) => age.num_seconds() < -60,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn key(height: u32) -> RejectionKey {
        RejectionKey {
            encoder_preference: "auto".into(),
            topology: "record".into(),
            width: height * 16 / 9,
            height,
            fps: 30,
            bitrate_kbps: 6_000,
        }
    }

    fn at(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, day, 12, 0, 0).unwrap()
    }

    #[test]
    fn remembers_lookups_and_expires_after_a_week() {
        let mut store = StoredRejections::empty("intel-iris-xe/31.0.101", "0.9.151");
        assert_eq!(store.lookup(&key(1080), at(1)), None);
        store.remember(key(1080), "process-output 0x8000FFFF", at(1));
        assert_eq!(
            store.lookup(&key(1080), at(1)),
            Some("process-output 0x8000FFFF")
        );
        assert_eq!(
            store.lookup(&key(720), at(1)),
            None,
            "another profile is not answered"
        );
        assert_eq!(
            store.lookup(&key(1080), at(7)),
            Some("process-output 0x8000FFFF")
        );
        assert_eq!(
            store.lookup(&key(1080), at(9)),
            None,
            "a week later it is probed again"
        );
        // Remembering again replaces the entry and its stamp.
        store.remember(key(1080), "set-input-type 0xC00D36B4", at(9));
        assert_eq!(store.entries.len(), 1);
        assert_eq!(
            store.lookup(&key(1080), at(10)),
            Some("set-input-type 0xC00D36B4")
        );
    }

    #[test]
    fn adopt_keeps_the_set_for_the_same_driver_and_app_and_drops_it_otherwise() {
        let mut stored = StoredRejections::empty("driver-a", "0.9.151");
        stored.remember(key(1080), "rejected", at(1));
        // An entry written eight days before the load, as an older run left it.
        stored.entries.push(StoredRejection {
            key: key(720),
            reason: "rejected".into(),
            rejected_at: (at(2) - chrono::Duration::days(8)).to_rfc3339(),
        });
        let same = StoredRejections::adopt(Some(stored.clone()), "driver-a", "0.9.151", at(2));
        assert_eq!(
            same.entries.len(),
            1,
            "the expired 720p entry is pruned on load"
        );
        assert_eq!(same.lookup(&key(1080), at(2)), Some("rejected"));
        let new_driver =
            StoredRejections::adopt(Some(stored.clone()), "driver-b", "0.9.151", at(2));
        assert!(new_driver.entries.is_empty());
        assert_eq!(new_driver.driver_identity, "driver-b");
        let new_app = StoredRejections::adopt(Some(stored), "driver-a", "0.9.152", at(2));
        assert!(new_app.entries.is_empty());
        assert_eq!(new_app.app_version, "0.9.152");
        let none = StoredRejections::adopt(None, "driver-a", "0.9.151", at(2));
        assert_eq!(none, StoredRejections::empty("driver-a", "0.9.151"));
    }

    #[test]
    fn encoder_session_exhaustion_is_recognized_at_either_output_type_stage() {
        assert!(is_encoder_session_exhaustion(
            "Media Foundation hardware H.264 probe rejected every activation for 640x360@30 2000kbps: Media Foundation probe stage=set-output-type HRESULT=0xC00D6D76 encoder=\"NVIDIA H.264 Encoder MFT\" input=<unset> profile=640x360@30 2000kbps"
        ));
        assert!(is_encoder_session_exhaustion(
            "Media Foundation probe stage=d3d11-set-output-type HRESULT=0xC00D6D76 (the encoder refused a new session) encoder=\"NVIDIA H.264 Encoder MFT\""
        ));
        assert!(!is_encoder_session_exhaustion(
            "Media Foundation probe stage=set-input-type HRESULT=0xC00D6D76 encoder=\"NVIDIA H.264 Encoder MFT\""
        ));
        assert!(!is_encoder_session_exhaustion(
            "Media Foundation probe stage=process-output HRESULT=0x8000FFFF encoder=\"Intel Quick Sync Video H.264 Encoder MFT\""
        ));
    }

    #[test]
    fn the_store_stays_bounded_and_round_trips_through_json() {
        let mut store = StoredRejections::empty("driver-a", "0.9.151");
        for height in 0..(MAX_ENTRIES as u32 + 10) {
            store.remember(key(height), &"x".repeat(1_000), at(1));
        }
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        assert!(
            store
                .entries
                .iter()
                .all(|entry| entry.reason.len() == MAX_REASON_CHARS)
        );
        assert_eq!(store.lookup(&key(0), at(1)), None, "the oldest made room");
        assert!(store.lookup(&key(MAX_ENTRIES as u32 + 9), at(1)).is_some());
        let json = serde_json::to_string(&store).unwrap();
        let back: StoredRejections = serde_json::from_str(&json).unwrap();
        assert_eq!(back, store);
        assert!(json.contains("\"encoderPreference\":\"auto\""), "{json}");
        assert!(
            json.contains("\"rejectedAt\":\"2026-10-01T12:00:00+00:00\""),
            "{json}"
        );
        // An unparsable stamp reads as expired, never as a panic.
        let mut broken = store.clone();
        broken.entries[0].rejected_at = "yesterday".into();
        let first = broken.entries[0].key.clone();
        assert_eq!(broken.lookup(&first, at(1)), None);
    }
}
