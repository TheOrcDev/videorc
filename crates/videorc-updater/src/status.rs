//! The update status a streamer sees, and when the app checks again.
//!
//! Pure mapping from the updater's lifecycle to the status the Settings row
//! and the sidebar's chip read. It is Electron's `UpdateStatus`, phase for
//! phase.

/// Why updates are not offered on this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsupportedReason {
    /// A Windows build found no update published for it (no public Alpha
    /// feed, and no signed-in pilot access). Rechecked.
    WindowsFeedUnpublished,
    /// The Linux version check could not tell (offline, or videorc.com lists
    /// no Linux release for this line yet). Rechecked.
    LinuxVersionUnknown,
}

/// The auto-update status. `Unsupported` is what a build that cannot update
/// itself says (a dev run, for one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStatus {
    Idle,
    Checking,
    Available {
        version: String,
    },
    Downloading {
        percent: u8,
        version: Option<String>,
    },
    Downloaded {
        version: String,
    },
    NotAvailable {
        current_version: String,
    },
    Error {
        message: String,
    },
    /// Linux only: a newer Linux release is published on videorc.com. Linux
    /// never downloads it; Settings links to the downloads page.
    DownloadAvailable {
        version: String,
    },
    Unsupported {
        reason: Option<UnsupportedReason>,
    },
}

/// What the updater did.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdaterEvent {
    Checking,
    Available { version: String },
    NotAvailable { current_version: String },
    Progress { percent: f64 },
    Downloaded { version: String },
    Error { message: String },
    DownloadAvailable { version: String },
    Unsupported { reason: Option<UnsupportedReason> },
}

/// A download can report a percent slightly outside 0 to 100, or none before
/// the first chunk; normalise it so the progress bar never overflows.
pub fn clamp_percent(percent: f64) -> u8 {
    if !percent.is_finite() {
        return 0;
    }
    percent.round().clamp(0.0, 100.0) as u8
}

pub fn update_status_from_event(event: UpdaterEvent) -> UpdateStatus {
    match event {
        UpdaterEvent::Checking => UpdateStatus::Checking,
        UpdaterEvent::Available { version } => UpdateStatus::Available { version },
        UpdaterEvent::NotAvailable { current_version } => {
            UpdateStatus::NotAvailable { current_version }
        }
        UpdaterEvent::Progress { percent } => UpdateStatus::Downloading {
            percent: clamp_percent(percent),
            version: None,
        },
        UpdaterEvent::Downloaded { version } => UpdateStatus::Downloaded { version },
        UpdaterEvent::Error { message } => UpdateStatus::Error { message },
        UpdaterEvent::DownloadAvailable { version } => UpdateStatus::DownloadAvailable { version },
        UpdaterEvent::Unsupported { reason } => UpdateStatus::Unsupported { reason },
    }
}

/// A check that ended while the status still says "checking" has nothing to
/// move it on, and Settings would say "Checking for updates…" for ever. It
/// settles as unsupported.
pub fn settle_status_after_check(status: UpdateStatus) -> UpdateStatus {
    if status == UpdateStatus::Checking {
        update_status_from_event(UpdaterEvent::Unsupported { reason: None })
    } else {
        status
    }
}

/// After a manual check resolves, start downloading immediately (one-click
/// feel) only when an update is actually available.
pub fn should_auto_download(status: &UpdateStatus) -> bool {
    matches!(status, UpdateStatus::Available { .. })
}

/// The launch-time check alone misses every release shipped while the app
/// stays open, so the background flow checks again on this interval. The
/// feed is one small file.
pub const BACKGROUND_RECHECK_INTERVAL_MS: u64 = 30 * 60 * 1000;

/// Check again only from settled states: never while a check or a download
/// is in flight, never once an update is staged (it applies on the next
/// quit), and never when updates are unsupported. Two exceptions to the
/// last: a Windows build whose feed is not published yet, since signing in
/// or a public Alpha can open one at any time; and Linux, whose notice check
/// keeps watching for the next release. `Available` with no download running
/// means the background download failed, and checking again retries it.
pub fn should_background_recheck(status: &UpdateStatus) -> bool {
    match status {
        UpdateStatus::Idle
        | UpdateStatus::NotAvailable { .. }
        | UpdateStatus::Error { .. }
        | UpdateStatus::Available { .. }
        | UpdateStatus::DownloadAvailable { .. } => true,
        UpdateStatus::Checking
        | UpdateStatus::Downloading { .. }
        | UpdateStatus::Downloaded { .. } => false,
        UpdateStatus::Unsupported { reason } => matches!(
            reason,
            Some(
                UnsupportedReason::WindowsFeedUnpublished | UnsupportedReason::LinuxVersionUnknown
            )
        ),
    }
}

/// The words of the system notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateReadyNotification {
    pub title: String,
    pub body: String,
}

/// The system notice that a downloaded update is ready (plan 174 I-20):
/// never while Videorc records or is on air, where a system banner can land
/// on the captured screen. The sidebar chip and Settings → About still say
/// it, and the update installs the next time Videorc quits either way.
pub fn update_ready_notification(
    version: &str,
    capture_active: bool,
) -> Option<UpdateReadyNotification> {
    if capture_active {
        return None;
    }
    Some(UpdateReadyNotification {
        title: format!("Videorc {version} is ready"),
        body: "Restart Videorc to finish updating, or it installs the next time you quit."
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available(version: &str) -> UpdateStatus {
        UpdateStatus::Available {
            version: version.to_string(),
        }
    }

    fn not_available(current_version: &str) -> UpdateStatus {
        UpdateStatus::NotAvailable {
            current_version: current_version.to_string(),
        }
    }

    fn downloaded(version: &str) -> UpdateStatus {
        UpdateStatus::Downloaded {
            version: version.to_string(),
        }
    }

    fn error(message: &str) -> UpdateStatus {
        UpdateStatus::Error {
            message: message.to_string(),
        }
    }

    fn downloading(percent: u8) -> UpdateStatus {
        UpdateStatus::Downloading {
            percent,
            version: None,
        }
    }

    // updater status mapping

    #[test]
    fn maps_each_lifecycle_event_to_its_matching_status() {
        assert_eq!(
            update_status_from_event(UpdaterEvent::Checking),
            UpdateStatus::Checking
        );
        assert_eq!(
            update_status_from_event(UpdaterEvent::Available {
                version: "1.2.3".to_string()
            }),
            available("1.2.3")
        );
        assert_eq!(
            update_status_from_event(UpdaterEvent::NotAvailable {
                current_version: "1.0.0".to_string()
            }),
            not_available("1.0.0")
        );
        assert_eq!(
            update_status_from_event(UpdaterEvent::Downloaded {
                version: "1.2.3".to_string()
            }),
            downloaded("1.2.3")
        );
        assert_eq!(
            update_status_from_event(UpdaterEvent::Error {
                message: "nope".to_string()
            }),
            error("nope")
        );
        assert_eq!(
            update_status_from_event(UpdaterEvent::Unsupported { reason: None }),
            UpdateStatus::Unsupported { reason: None }
        );
        assert_eq!(
            update_status_from_event(UpdaterEvent::Unsupported {
                reason: Some(UnsupportedReason::WindowsFeedUnpublished)
            }),
            UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::WindowsFeedUnpublished)
            }
        );
    }

    #[test]
    fn clamps_and_rounds_download_progress_into_0_to_100() {
        assert_eq!(
            update_status_from_event(UpdaterEvent::Progress { percent: 42.7 }),
            downloading(43)
        );
        assert_eq!(clamp_percent(-5.0), 0);
        assert_eq!(clamp_percent(150.0), 100);
        assert_eq!(clamp_percent(f64::NAN), 0);
    }

    // Regression (0.9.12 era): the launch-time check was the ONLY check, so a
    // release shipped while the app was running never surfaced the sidebar
    // chip. The background flow must re-check periodically while the app
    // stays open.
    #[test]
    fn re_checks_periodically_from_settled_states_never_mid_flight_or_once_staged() {
        assert!(should_background_recheck(&UpdateStatus::Idle));
        assert!(should_background_recheck(&not_available("1.0.0")));
        assert!(should_background_recheck(&error("offline")));
        // `Available` with no download in flight means the background
        // download failed: a re-check retries it.
        assert!(should_background_recheck(&available("1.2.3")));

        assert!(!should_background_recheck(&UpdateStatus::Checking));
        assert!(!should_background_recheck(&downloading(40)));
        assert!(!should_background_recheck(&downloaded("1.2.3")));
        assert!(!should_background_recheck(&UpdateStatus::Unsupported {
            reason: None
        }));
        // A Windows build with no feed yet keeps checking: signing in or a
        // public Alpha can open one while the app stays open.
        assert!(should_background_recheck(&UpdateStatus::Unsupported {
            reason: Some(UnsupportedReason::WindowsFeedUnpublished)
        }));
        // Linux keeps asking videorc.com: after an offline launch, and for
        // the release after the one it already announces.
        assert!(should_background_recheck(&UpdateStatus::Unsupported {
            reason: Some(UnsupportedReason::LinuxVersionUnknown)
        }));
        assert!(should_background_recheck(
            &UpdateStatus::DownloadAvailable {
                version: "1.2.3".to_string()
            }
        ));

        assert_eq!(BACKGROUND_RECHECK_INTERVAL_MS, 30 * 60 * 1000);
    }

    #[test]
    fn maps_a_linux_notice_to_its_own_phase_never_a_download() {
        let notice = UpdateStatus::DownloadAvailable {
            version: "0.15.0-alpha.1".to_string(),
        };
        assert_eq!(
            update_status_from_event(UpdaterEvent::DownloadAvailable {
                version: "0.15.0-alpha.1".to_string()
            }),
            notice
        );
        assert!(!should_auto_download(&notice));
    }

    #[test]
    fn auto_downloads_only_when_an_update_is_available() {
        assert!(should_auto_download(&available("1.2.3")));
        assert!(!should_auto_download(&not_available("1.0.0")));
        assert!(!should_auto_download(&UpdateStatus::Idle));
        assert!(!should_auto_download(&downloaded("1.2.3")));
    }

    // updateReadyNotification (plan 174 I-20)

    #[test]
    fn says_the_update_is_ready_and_that_quitting_installs_it() {
        assert_eq!(
            update_ready_notification("0.9.141", false),
            Some(UpdateReadyNotification {
                title: "Videorc 0.9.141 is ready".to_string(),
                body: "Restart Videorc to finish updating, or it installs the next time you quit."
                    .to_string(),
            })
        );
    }

    #[test]
    fn never_shows_an_os_banner_while_a_recording_or_a_livestream_runs() {
        assert_eq!(update_ready_notification("0.9.141", true), None);
    }

    // settleStatusAfterCheck

    #[test]
    fn settles_a_check_that_resolved_without_an_updater_event_as_unsupported() {
        assert_eq!(
            settle_status_after_check(UpdateStatus::Checking),
            UpdateStatus::Unsupported { reason: None }
        );
    }

    #[test]
    fn keeps_every_status_an_updater_event_already_set() {
        for status in [
            UpdateStatus::Idle,
            available("1.2.3"),
            not_available("1.2.2"),
            downloading(40),
            downloaded("1.2.3"),
            error("offline"),
            UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::WindowsFeedUnpublished),
            },
        ] {
            assert_eq!(settle_status_after_check(status.clone()), status);
        }
    }
}
