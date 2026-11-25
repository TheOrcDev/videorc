//! Settings → Remote's Remote control and Phone remote (plan 260 S1.6f, from
//! Electron's `components/settings/remote-settings.tsx`,
//! `lib/phone-remote-view.ts` and the copy of
//! `components/phone-remote-section.tsx`). The tab's other column is
//! [`super::agents`].
//!
//! The backend pushes both statuses (`remote.control.status`); the page
//! shows them and sends actions, and a switch settles when the backend
//! confirms. Regenerating the token, and turning remote control off while
//! phones are paired, both disconnect devices, so both ask first.
//!
//! The wire types mirror `shared/backend.ts` (the backend's remote module);
//! they are not in `videorc-protocol` yet. The pairing QR code is drawn by
//! the GPUI screen (S2), which brings its own encoder.

use std::collections::BTreeMap;

use chrono::DateTime;
use serde::Deserialize;

use crate::format::{NO_VALUE, device_noun, plural};

pub const REMOTE_CONTROL_TITLE: &str = "Remote control";
pub const ENABLE_REMOTE_CONTROL: &str = "Enable remote control";
/// Off: one muted line says what turning it on does (plan 174 V-6).
pub const REMOTE_CONTROL_OFF_HINT: &str = "Turning this on makes a pairing token for your remotes. The Stream Deck plugin pairs on its own.";
pub const PAIRING_TOKEN: &str = "Pairing token";
pub const NEW_TOKEN: &str = "New token";
pub const REGENERATE: &str = "Regenerate";
pub const COPY: &str = "Copy";
pub const COPIED: &str = "Copied";
pub const COPY_FAILED: &str = "Couldn't copy the pairing token.";
pub const REGENERATE_TITLE: &str = "Regenerate the pairing token?";
pub const REGENERATE_CONFIRM: &str = "Regenerate token";
pub const OFF_TITLE: &str = "Turn off remote control?";
pub const OFF_CONFIRM: &str = "Turn off remote control";
pub const PHONE_REMOTE_TITLE: &str = "Phone remote";
pub const PHONE_REMOTE_DESCRIPTION: &str = "Read chat, put a message on stream with a tap and switch scenes from a phone on the same Wi-Fi.";
/// Off: what turning it on does.
pub const PHONE_REMOTE_OFF_HINT: &str =
    "Turning this on also turns on Remote control, and pairs phones with a code you scan.";
pub const NO_NETWORK: &str =
    "No Wi-Fi or Ethernet network found. Connect this computer to the same network as your phone.";

/// Nothing connected this long after a code shows: explain why not.
pub const PAIRING_TROUBLE_HINT_AFTER_MS: i64 = 30_000;
/// The backend keeps at most this many characters of a phone's name
/// (`MAX_DEVICE_NAME_CHARS` in `remote_lan.rs`).
pub const PHONE_NAME_MAX_CHARS: usize = 40;

/// `RemoteControlStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub enabled: bool,
    pub token: Option<String>,
    pub port: u16,
    pub connected_clients: u32,
    pub discovery_path: Option<String>,
}

/// `RemoteLanDevice`: a paired phone (no key material).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanDevice {
    pub id: String,
    pub name: String,
    pub created_at: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    pub connected: bool,
}

/// `RemoteLanStatus`: the phone remote.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanStatus {
    pub enabled: bool,
    /// Absent while off or when the bind failed.
    #[serde(default)]
    pub port: Option<u16>,
    /// Private IPv4 addresses a phone could reach this computer on.
    #[serde(default)]
    pub addresses: Vec<String>,
    #[serde(default)]
    pub devices: Vec<RemoteLanDevice>,
    #[serde(default)]
    pub bind_error: Option<String>,
    #[serde(default)]
    pub pairing_expires_at: Option<String>,
}

/// `RemoteLanPairing`: the one-shot QR ticket from `remote.lan.pairing.begin`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanPairing {
    pub url: String,
    pub address: String,
    pub addresses: Vec<String>,
    pub expires_at: String,
}

// ── Remote control ───────────────────────────────────────────────────────

/// The card's description, naming this computer.
pub fn remote_control_description(platform: &str) -> String {
    format!(
        "Start recordings, switch scenes and mute your microphone from a Stream Deck or another remote on this {}.",
        device_noun(platform)
    )
}

/// New token's description.
pub fn new_token_description(platform: &str) -> String {
    format!(
        "Disconnects every paired client. The Stream Deck plugin pairs again on its own on this {}.",
        device_noun(platform)
    )
}

/// `connectedClientsLine`: under the token.
pub fn connected_clients_line(count: u32) -> String {
    match count {
        0 => "No clients connected.".into(),
        1 => "1 client connected.".into(),
        count => format!("{count} clients connected."),
    }
}

/// `pairedPhonesClause`: "1 paired phone is" / "3 paired phones are".
pub fn paired_phones_clause(count: usize) -> String {
    if count == 1 {
        "1 paired phone is".into()
    } else {
        format!("{count} paired phones are")
    }
}

/// The token as the field shows it: its first 8 and last 4 characters.
pub fn token_preview(token: Option<&str>) -> String {
    match token.filter(|token| !token.is_empty()) {
        Some(token) => {
            let chars: Vec<char> = token.chars().collect();
            let head: String = chars.iter().take(8).collect();
            let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
            format!("{head}…{tail}")
        }
        None => NO_VALUE.into(),
    }
}

/// The regenerate question's body.
pub fn regenerate_body(platform: &str) -> String {
    format!(
        "Every paired client is disconnected and needs the new token to pair again. The Stream Deck plugin pairs again on its own on this {}.",
        device_noun(platform)
    )
}

/// The turn-off question's body.
pub fn off_body(paired_phones: usize) -> String {
    format!(
        "Phone remote turns off with it: {} disconnected, and so is every Stream Deck.",
        paired_phones_clause(paired_phones)
    )
}

/// Phones paired while the phone remote is on (its devices count only then).
pub fn paired_phones(phone: Option<&RemoteLanStatus>) -> usize {
    phone
        .filter(|phone| phone.enabled)
        .map_or(0, |phone| phone.devices.len())
}

/// What flipping the Remote control switch does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteToggle {
    Enable,
    Disable,
    /// Paired phones would disconnect: ask first.
    ConfirmOff,
}

pub fn remote_toggle(checked: bool, paired_phones: usize) -> RemoteToggle {
    if checked {
        RemoteToggle::Enable
    } else if paired_phones > 0 {
        RemoteToggle::ConfirmOff
    } else {
        RemoteToggle::Disable
    }
}

// ── Phone remote (`phone-remote-view.ts`) ────────────────────────────────

fn parse_ms(stamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(stamp)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// `pairingSecondsLeft`: whole seconds, rounded up, never below zero.
pub fn pairing_seconds_left(expires_at: Option<&str>, now_ms: i64) -> i64 {
    expires_at
        .and_then(parse_ms)
        .map_or(0, |expires| ((expires - now_ms).max(0) + 999) / 1000)
}

/// `formatCountdown`: "4:07".
pub fn format_countdown(seconds: i64) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// `deviceActivityLabel`.
pub fn device_activity_label(device: &RemoteLanDevice, now_ms: i64) -> String {
    if device.connected {
        return "Connected".into();
    }
    let Some(seen) = device.last_seen_at.as_deref().and_then(parse_ms) else {
        return "Never connected".into();
    };
    let minutes = (now_ms - seen).max(0) / 60_000;
    if minutes < 1 {
        return "Seen just now".into();
    }
    if minutes < 60 {
        return format!("Seen {minutes} min ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("Seen {hours} h ago");
    }
    format!("Seen {} d ago", hours / 24)
}

/// The line's tone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryTone {
    Ok,
    Warning,
}

/// `phoneRemoteSummary`: the one line under the toggle, what is wrong or
/// where phones connect.
pub fn phone_remote_summary(status: &RemoteLanStatus) -> (SummaryTone, String) {
    if let Some(error) = status.bind_error.as_deref().filter(|e| !e.is_empty()) {
        return (SummaryTone::Warning, error.to_string());
    }
    let Some(address) = status.addresses.first() else {
        return (SummaryTone::Warning, NO_NETWORK.into());
    };
    let connected = status.devices.iter().filter(|d| d.connected).count();
    let place = match status.port.filter(|port| *port != 0) {
        Some(port) => format!("{address}:{port}"),
        None => address.clone(),
    };
    let text = if connected > 0 {
        format!(
            "{} connected · {place}",
            plural(connected as i64, "phone", None)
        )
    } else {
        format!("Listening on {place} · same Wi-Fi only")
    };
    (SummaryTone::Ok, text)
}

/// `renamedPhoneName`: what Rename… saves, or `None` when there is nothing
/// to save (empty or unchanged), so Save stays off.
pub fn renamed_phone_name(current: &str, typed: &str) -> Option<String> {
    // `slice(0, 40)` counts UTF-16 units; this counts chars.
    let next: String = typed.trim().chars().take(PHONE_NAME_MAX_CHARS).collect();
    (!next.is_empty() && next != current).then_some(next)
}

/// `phoneDisplayNames`: phones pair as "iPhone · Safari", so repeats are
/// numbered in list order ("iPhone · Safari 2") until renamed.
pub fn phone_display_names(devices: &[RemoteLanDevice]) -> BTreeMap<String, String> {
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    devices
        .iter()
        .map(|device| {
            let index = seen.entry(&device.name).or_insert(0);
            *index += 1;
            let name = if *index > 1 {
                format!("{} {index}", device.name)
            } else {
                device.name.clone()
            };
            (device.id.clone(), name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-11-24T12:00:00Z";

    fn now() -> i64 {
        parse_ms(NOW).unwrap()
    }

    fn device(id: &str, name: &str, connected: bool, seen: Option<&str>) -> RemoteLanDevice {
        RemoteLanDevice {
            id: id.into(),
            name: name.into(),
            created_at: NOW.into(),
            last_seen_at: seen.map(str::to_string),
            connected,
        }
    }

    /// `remote-settings.test.ts`.
    #[test]
    fn the_remote_control_card() {
        assert_eq!(connected_clients_line(0), "No clients connected.");
        assert_eq!(connected_clients_line(1), "1 client connected.");
        assert_eq!(connected_clients_line(3), "3 clients connected.");
        assert_eq!(paired_phones_clause(1), "1 paired phone is");
        assert_eq!(paired_phones_clause(3), "3 paired phones are");
        assert_eq!(
            off_body(2),
            "Phone remote turns off with it: 2 paired phones are disconnected, and so is every Stream Deck."
        );
        assert!(regenerate_body("win32").ends_with("on this PC."));
        assert!(remote_control_description("darwin").ends_with("on this Mac."));
        assert!(new_token_description("linux").ends_with("on this computer."));
        assert_eq!(
            token_preview(Some("abcdefghijklmnopqrstuvwxyz")),
            "abcdefgh…wxyz"
        );
        assert_eq!(token_preview(None), "–");
        assert_eq!(token_preview(Some("")), "–");
    }

    #[test]
    fn turning_off_with_paired_phones_asks_first() {
        let on = RemoteLanStatus {
            enabled: true,
            devices: vec![device("a", "iPhone", false, None)],
            ..RemoteLanStatus::default()
        };
        let off = RemoteLanStatus {
            enabled: false,
            ..on.clone()
        };
        assert_eq!(paired_phones(Some(&on)), 1);
        assert_eq!(paired_phones(Some(&off)), 0);
        assert_eq!(paired_phones(None), 0);
        assert_eq!(remote_toggle(true, 1), RemoteToggle::Enable);
        assert_eq!(remote_toggle(false, 1), RemoteToggle::ConfirmOff);
        assert_eq!(remote_toggle(false, 0), RemoteToggle::Disable);
    }

    /// `phone-remote-view.test.ts`.
    #[test]
    fn the_pairing_countdown() {
        assert_eq!(pairing_seconds_left(None, now()), 0);
        assert_eq!(pairing_seconds_left(Some("nope"), now()), 0);
        assert_eq!(
            pairing_seconds_left(Some("2026-11-24T12:04:07.500Z"), now()),
            248
        );
        assert_eq!(pairing_seconds_left(Some("2026-11-24T11:00:00Z"), now()), 0);
        assert_eq!(format_countdown(247), "4:07");
        assert_eq!(format_countdown(5), "0:05");
    }

    #[test]
    fn when_a_phone_was_last_seen() {
        let at = |seconds_ago: i64| {
            DateTime::from_timestamp_millis(now() - seconds_ago * 1000)
                .unwrap()
                .to_rfc3339()
        };
        let label = |connected, seen: Option<String>| {
            device_activity_label(&device("a", "x", connected, seen.as_deref()), now())
        };
        assert_eq!(label(true, None), "Connected");
        assert_eq!(label(false, None), "Never connected");
        assert_eq!(label(false, Some(at(30))), "Seen just now");
        assert_eq!(label(false, Some(at(5 * 60))), "Seen 5 min ago");
        assert_eq!(label(false, Some(at(3 * 3600))), "Seen 3 h ago");
        assert_eq!(label(false, Some(at(2 * 86_400))), "Seen 2 d ago");
    }

    #[test]
    fn the_summary_says_what_is_wrong_or_where_phones_connect() {
        let mut status = RemoteLanStatus {
            enabled: true,
            port: Some(47_890),
            addresses: vec!["192.168.1.20".into(), "10.0.0.4".into()],
            ..RemoteLanStatus::default()
        };
        assert_eq!(
            phone_remote_summary(&status),
            (
                SummaryTone::Ok,
                "Listening on 192.168.1.20:47890 · same Wi-Fi only".into()
            )
        );
        status.devices = vec![
            device("a", "iPhone", true, None),
            device("b", "Pixel", false, None),
        ];
        assert_eq!(
            phone_remote_summary(&status).1,
            "1 phone connected · 192.168.1.20:47890"
        );
        status.port = None;
        assert_eq!(
            phone_remote_summary(&status).1,
            "1 phone connected · 192.168.1.20"
        );
        status.addresses.clear();
        assert_eq!(
            phone_remote_summary(&status),
            (SummaryTone::Warning, NO_NETWORK.into())
        );
        status.bind_error = Some("Port 47890 is in use.".into());
        assert_eq!(
            phone_remote_summary(&status),
            (SummaryTone::Warning, "Port 47890 is in use.".into())
        );
    }

    #[test]
    fn rename_and_repeated_names() {
        assert_eq!(renamed_phone_name("iPhone", "  "), None);
        assert_eq!(renamed_phone_name("iPhone", " iPhone "), None);
        assert_eq!(
            renamed_phone_name("iPhone", " Desk phone "),
            Some("Desk phone".into())
        );
        assert_eq!(renamed_phone_name("x", &"a".repeat(50)).unwrap().len(), 40);
        let names = phone_display_names(&[
            device("1", "iPhone · Safari", false, None),
            device("2", "iPhone · Safari", false, None),
            device("3", "Pixel", false, None),
            device("4", "iPhone · Safari", false, None),
        ]);
        assert_eq!(names["1"], "iPhone · Safari");
        assert_eq!(names["2"], "iPhone · Safari 2");
        assert_eq!(names["3"], "Pixel");
        assert_eq!(names["4"], "iPhone · Safari 3");
    }

    #[test]
    fn the_wire_reads_as_the_backend_writes_it() {
        let control: RemoteControlStatus = serde_json::from_value(json!({
            "enabled": true, "token": "t", "port": 47870, "connectedClients": 2,
            "discoveryPath": null
        }))
        .unwrap();
        assert_eq!(control.connected_clients, 2);
        let phone: RemoteLanStatus = serde_json::from_value(json!({
            "enabled": true, "addresses": [], "devices": [{
                "id": "d", "name": "n", "createdAt": NOW, "connected": false
            }]
        }))
        .unwrap();
        assert_eq!(phone.devices[0].last_seen_at, None);
    }

    /// The words are still Electron's.
    #[test]
    fn every_constant_is_still_in_the_renderer() {
        let sources = [
            include_str!(
                "../../../../apps/desktop/src/renderer/src/components/settings/remote-settings.tsx"
            ),
            include_str!(
                "../../../../apps/desktop/src/renderer/src/components/phone-remote-section.tsx"
            ),
            include_str!("../../../../apps/desktop/src/renderer/src/lib/phone-remote-view.ts"),
        ];
        let this = include_str!("remote.rs");
        let this = &this[..this.find("#[cfg(test)]").unwrap()];
        let (checked, missing) = crate::library::copy::tests::unseen_constants(this, &sources);
        assert!(
            checked >= 17,
            "found {checked} constants; the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "not in the renderer any more: {missing:?}"
        );
        // The formatted lines.
        let settings = sources[0];
        for fragment in [
            "Start recordings, switch scenes and mute your microphone from a Stream Deck or another remote on this ${deviceNoun}.",
            "Disconnects every paired client. The Stream Deck plugin pairs again on its own on this ${deviceNoun}.",
            "Phone remote turns off with it: ${pairedPhonesClause(pairedPhones)} disconnected, and so is every Stream Deck.",
            "`Every paired client is disconnected and needs the new token to pair again. The Stream Deck plugin pairs again on its own on this ${deviceNoun}.`",
        ] {
            assert!(settings.contains(fragment), "{fragment}");
        }
    }
}
