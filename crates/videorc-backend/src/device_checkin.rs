//! Signed-in desktop platform check-in: once a day (and on sign-in) the
//! backend tells videorc.com which OS, CPU arch, app version and channel this
//! install is running, so registered-user platform split does not depend on
//! someone having streamed. Fire-and-forget: it never blocks the UI, never
//! queues offline, and never names a user id. Contract: videorc-web
//! `docs/user-devices.md` (`POST /api/desktop/device-checkin`).
//!
//! Reuses the usage-stats install id. Independent of "Share anonymous usage
//! stats": this only runs while a Videorc session token is present.

use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::protocol::{AccountStatus, ServerEvent};
use crate::state::AppState;
use crate::usage_stats::ensure_install_id;

const CHECKIN_PATH: &str = "/api/desktop/device-checkin";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const LAUNCH_DELAY: Duration = Duration::from_secs(15);
const MIN_INTERVAL: TimeDelta = TimeDelta::days(1);
const LAST_CHECKIN_SETTING_KEY: &str = "deviceCheckin.last";
const MAX_OS_VERSION_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// The JSON body of `POST /api/desktop/device-checkin`. Field names are the
/// web contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceCheckinPayload {
    pub install_id: String,
    pub os: String,
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub app_version: String,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastCheckin {
    sent_at: DateTime<Utc>,
    /// SHA-256 of the signed-in email, so a different account on this install
    /// is not throttled by the previous one. Not the email itself.
    account_fp: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CheckinOutcome {
    Delivered,
    /// 401/403: this launch cannot succeed; wait for a new sign-in.
    Unauthorized,
    /// Any other 4xx: the body was refused.
    Refused,
    /// 408, 429, 5xx or no answer: try again on the next trigger.
    Retry,
}

pub(crate) fn classify_response(status: u16) -> CheckinOutcome {
    match status {
        200..=299 => CheckinOutcome::Delivered,
        401 | 403 => CheckinOutcome::Unauthorized,
        408 | 429 => CheckinOutcome::Retry,
        400..=499 => CheckinOutcome::Refused,
        _ => CheckinOutcome::Retry,
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

pub(crate) fn normalize_os(raw: &str) -> &'static str {
    match raw {
        "macos" | "darwin" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "other",
    }
}

pub(crate) fn normalize_arch(raw: &str) -> &'static str {
    match raw {
        "aarch64" | "arm64" => "arm64",
        "x86_64" | "amd64" | "x64" => "x64",
        "x86" | "i686" | "i386" => "x86",
        "arm" | "armv7" => "arm",
        _ => "other",
    }
}

/// `0.32.1-alpha.1` → `alpha`, `0.9.2-beta.1` → `beta`, `1.0.0` → `stable`.
pub(crate) fn channel_for_version(version: &str) -> &'static str {
    let Some((_, pre)) = version.split_once('-') else {
        return "stable";
    };
    match pre.split(['.', '+']).next().unwrap_or("") {
        "alpha" => "alpha",
        "beta" => "beta",
        "rc" | "stable" => "stable",
        _ => "other",
    }
}

pub(crate) fn linux_os_version_from_release(text: &str) -> Option<String> {
    let mut version_id = None;
    let mut pretty_name = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = os_release_value(line, "VERSION_ID") {
            version_id = Some(value);
        } else if let Some(value) = os_release_value(line, "PRETTY_NAME") {
            pretty_name = Some(value);
        }
    }
    clip_os_version(version_id.or(pretty_name))
}

fn os_release_value(line: &str, key: &str) -> Option<String> {
    let (name, value) = line.split_once('=')?;
    if name != key {
        return None;
    }
    let value = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(any(windows, test))]
pub(crate) fn format_windows_os_version(major: u32, minor: u32, build: u32) -> String {
    format!("{major}.{minor}.{build}")
}

fn clip_os_version(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some(if value.len() > MAX_OS_VERSION_LEN {
        value.chars().take(MAX_OS_VERSION_LEN).collect()
    } else {
        value
    })
}

pub(crate) fn account_fingerprint(email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.trim().to_ascii_lowercase().as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..16].to_string()
}

pub(crate) fn should_send(
    last: Option<&LastCheckin>,
    account_fp: &str,
    now: DateTime<Utc>,
) -> bool {
    match last {
        None => true,
        Some(last) if last.account_fp != account_fp => true,
        Some(last) => now.signed_duration_since(last.sent_at) >= MIN_INTERVAL,
    }
}

pub(crate) fn build_payload(install_id: &str) -> DeviceCheckinPayload {
    let app_version = crate::performance_check::desktop_app_version();
    DeviceCheckinPayload {
        install_id: install_id.to_ascii_lowercase(),
        os: normalize_os(std::env::consts::OS).to_string(),
        arch: normalize_arch(std::env::consts::ARCH).to_string(),
        os_version: os_version(),
        channel: channel_for_version(&app_version).to_string(),
        app_version,
    }
}

fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        return macos_product_version();
    }
    #[cfg(windows)]
    {
        return windows_os_version();
    }
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|text| linux_os_version_from_release(&text));
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_product_version() -> Option<String> {
    let name = std::ffi::CString::new("kern.osproductversion").ok()?;
    let mut size: libc::size_t = 0;
    // SAFETY: `name` is a NUL-terminated C string; the first call only
    // writes `size`.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 || size > 128 {
        return None;
    }
    let mut buf = vec![0u8; size];
    // SAFETY: `buf` is `size` bytes, matching the length the kernel just
    // reported.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&byte| byte == 0).unwrap_or(buf.len());
    clip_os_version(std::str::from_utf8(&buf[..end]).ok().map(str::to_string))
}

#[cfg(windows)]
fn windows_os_version() -> Option<String> {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: a valid, sized OSVERSIONINFOW out pointer.
    let status = unsafe { RtlGetVersion(&mut info) };
    status.is_ok().then(|| {
        format_windows_os_version(info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber)
    })
}

fn signed_in_from_event(event: &ServerEvent) -> bool {
    crate::protocol::AccountChangedEvent::deserialize(&event.payload)
        .is_ok_and(|changed| changed.account.status == AccountStatus::SignedIn)
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// Boot: one background task. Never fails the backend.
pub(crate) fn spawn(state: &AppState) {
    tokio::spawn(run(state.clone(), state.events.subscribe()));
}

async fn run(state: AppState, mut events: broadcast::Receiver<ServerEvent>) {
    let Some(client) = http_client() else {
        return;
    };
    let mut launch_done = false;
    loop {
        tokio::select! {
            received = events.recv() => match received {
                Ok(event) if event.event == "account.changed" && signed_in_from_event(&event) => {
                    try_send(&state, &client).await;
                }
                Err(broadcast::error::RecvError::Closed) => return,
                Err(broadcast::error::RecvError::Lagged(_)) | Ok(_) => {}
            },
            () = tokio::time::sleep(LAUNCH_DELAY), if !launch_done => {
                launch_done = true;
                try_send(&state, &client).await;
            }
        }
    }
}

async fn try_send(state: &AppState, client: &reqwest::Client) {
    let Some(token) = crate::account::stored_session_token() else {
        return;
    };
    let Some(account_fp) = signed_in_fingerprint(state).await else {
        return;
    };
    let Some(install_id) = ensure_install_id(state) else {
        return;
    };
    let now = Utc::now();
    let last = load_last(state);
    if !should_send(last.as_ref(), &account_fp, now) {
        return;
    }
    let payload = build_payload(&install_id);
    let endpoint = format!("{}{CHECKIN_PATH}", crate::videorc_api::api_base_url());
    let outcome = send(client, &endpoint, &token, &payload).await;
    if outcome == CheckinOutcome::Delivered {
        save_last(
            state,
            &LastCheckin {
                sent_at: now,
                account_fp,
            },
        );
    }
}

async fn signed_in_fingerprint(state: &AppState) -> Option<String> {
    let session = state.account_session.lock().await;
    let account = crate::account::current_account(session.as_ref());
    if account.status != AccountStatus::SignedIn {
        return None;
    }
    account
        .email
        .filter(|email| !email.trim().is_empty())
        .map(|email| account_fingerprint(&email))
}

fn load_last(state: &AppState) -> Option<LastCheckin> {
    state
        .database
        .load_setting::<LastCheckin>(LAST_CHECKIN_SETTING_KEY)
        .ok()
        .flatten()
}

fn save_last(state: &AppState, last: &LastCheckin) {
    if let Err(error) = state.database.save_setting(LAST_CHECKIN_SETTING_KEY, last) {
        tracing::debug!("Device check-in: could not save last sent: {error}");
    }
}

async fn send(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    payload: &DeviceCheckinPayload,
) -> CheckinOutcome {
    match client
        .post(endpoint)
        .bearer_auth(token)
        .json(payload)
        .send()
        .await
    {
        Ok(response) => classify_response(response.status().as_u16()),
        Err(_) => CheckinOutcome::Retry,
    }
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(crate::performance_check::desktop_user_agent())
        .build()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-19T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + TimeDelta::seconds(seconds)
    }

    fn last(seconds: i64, account_fp: &str) -> LastCheckin {
        LastCheckin {
            sent_at: at(seconds),
            account_fp: account_fp.to_string(),
        }
    }

    #[test]
    fn a_first_checkin_and_a_day_later_send_the_same_account_does_not() {
        assert!(should_send(None, "aaaa", at(0)));
        assert!(!should_send(
            Some(&last(0, "aaaa")),
            "aaaa",
            at(60 * 60 * 23)
        ));
        assert!(should_send(
            Some(&last(0, "aaaa")),
            "aaaa",
            at(60 * 60 * 24)
        ));
    }

    #[test]
    fn a_different_account_on_the_same_install_sends_at_once() {
        assert!(should_send(Some(&last(0, "aaaa")), "bbbb", at(1)));
    }

    #[test]
    fn os_arch_and_channel_fold_to_the_web_slugs() {
        assert_eq!(normalize_os("macos"), "macos");
        assert_eq!(normalize_os("darwin"), "macos");
        assert_eq!(normalize_os("windows"), "windows");
        assert_eq!(normalize_os("linux"), "linux");
        assert_eq!(normalize_os("freebsd"), "other");

        assert_eq!(normalize_arch("aarch64"), "arm64");
        assert_eq!(normalize_arch("arm64"), "arm64");
        assert_eq!(normalize_arch("x86_64"), "x64");
        assert_eq!(normalize_arch("amd64"), "x64");
        assert_eq!(normalize_arch("i686"), "x86");
        assert_eq!(normalize_arch("riscv64"), "other");

        assert_eq!(channel_for_version("0.32.1-alpha.1"), "alpha");
        assert_eq!(channel_for_version("0.9.2-beta.1"), "beta");
        assert_eq!(channel_for_version("1.0.0"), "stable");
        assert_eq!(channel_for_version("1.0.0+build.7"), "stable");
        assert_eq!(channel_for_version("1.0.0-rc.1"), "stable");
        assert_eq!(channel_for_version("1.0.0-nightly.1"), "other");
    }

    #[test]
    fn linux_os_release_prefers_version_id_and_clips() {
        assert_eq!(
            linux_os_version_from_release(
                "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n"
            )
            .as_deref(),
            Some("24.04")
        );
        assert_eq!(
            linux_os_version_from_release("PRETTY_NAME=Fedora Linux 41\n").as_deref(),
            Some("Fedora Linux 41")
        );
        assert_eq!(linux_os_version_from_release("NAME=Linux\n"), None);
        let long = format!("VERSION_ID=\"{}\"", "9".repeat(80));
        assert_eq!(
            linux_os_version_from_release(&long).map(|value| value.len()),
            Some(MAX_OS_VERSION_LEN)
        );
    }

    #[test]
    fn windows_os_version_is_major_minor_build() {
        assert_eq!(format_windows_os_version(10, 0, 26100), "10.0.26100");
    }

    #[test]
    fn the_payload_matches_the_web_contract() {
        let payload = build_payload("6F1C2A3B-4D5E-4F60-8A71-92B3C4D5E6F7");
        let value = serde_json::to_value(&payload).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert!(keys.contains(&"installId".to_string()));
        assert!(keys.contains(&"os".to_string()));
        assert!(keys.contains(&"arch".to_string()));
        assert!(keys.contains(&"appVersion".to_string()));
        assert!(keys.contains(&"channel".to_string()));
        assert_eq!(payload.install_id, "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7");
        assert_eq!(payload.os, normalize_os(std::env::consts::OS));
        assert_eq!(payload.arch, normalize_arch(std::env::consts::ARCH));
        assert_eq!(payload.channel, channel_for_version(&payload.app_version));
        if payload.os_version.is_none() {
            assert!(value.get("osVersion").is_none());
        }
        assert!(
            serde_json::from_value::<DeviceCheckinPayload>(json!({
                "installId": payload.install_id,
                "os": payload.os,
                "arch": payload.arch,
                "appVersion": payload.app_version,
                "channel": payload.channel,
                "extra": "dropped-by-web-not-by-client"
            }))
            .is_ok()
        );
    }

    #[test]
    fn responses_are_delivered_unauthorized_refused_or_retried() {
        assert_eq!(classify_response(200), CheckinOutcome::Delivered);
        assert_eq!(classify_response(204), CheckinOutcome::Delivered);
        assert_eq!(classify_response(401), CheckinOutcome::Unauthorized);
        assert_eq!(classify_response(403), CheckinOutcome::Unauthorized);
        assert_eq!(classify_response(400), CheckinOutcome::Refused);
        assert_eq!(classify_response(413), CheckinOutcome::Refused);
        assert_eq!(classify_response(408), CheckinOutcome::Retry);
        assert_eq!(classify_response(429), CheckinOutcome::Retry);
        assert_eq!(classify_response(503), CheckinOutcome::Retry);
    }

    #[test]
    fn the_account_fingerprint_is_stable_and_not_the_email() {
        let fp = account_fingerprint("orc@videorc.com");
        assert_eq!(fp, account_fingerprint(" orc@VIDEORC.com "));
        assert_ne!(fp, "orc@videorc.com");
        assert_eq!(fp.len(), 16);
        assert_ne!(fp, account_fingerprint("other@videorc.com"));
    }

    #[test]
    fn a_signed_in_account_event_is_the_only_trigger() {
        let signed_in = ServerEvent {
            event: "account.changed".to_string(),
            payload: json!({
                "account": { "status": "signed-in", "email": "orc@videorc.com" },
                "reason": "signed-in"
            }),
        };
        let signed_out = ServerEvent {
            event: "account.changed".to_string(),
            payload: json!({
                "account": { "status": "signed-out" },
                "reason": "signed-out"
            }),
        };
        assert!(signed_in_from_event(&signed_in));
        assert!(!signed_in_from_event(&signed_out));
        assert!(!signed_in_from_event(&ServerEvent {
            event: "account.changed".to_string(),
            payload: json!({ "nope": true }),
        }));
    }
}
