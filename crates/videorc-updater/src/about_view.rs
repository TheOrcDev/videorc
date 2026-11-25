//! Settings → About's update row: what it says, and what its one control
//! does, in each state of the updater.
//!
//! A port of `about-update-view.ts` with its tests (plan 174 S3.17, I-20).
//! The window only draws what this returns.
//!
//! One rule matters beyond the words: a failed check or download never
//! shows the updater's own message. It shows one calm line with Try again,
//! and the message goes to the updater's log (`log.rs` in the plan 220
//! port, S5.2). So the sentences of the flow's `failure_message` are for
//! the support bundle, not for this row.
//!
//! Not here yet: a row for a copy of the app that cannot be replaced where
//! it is (`macos_install`'s refusals on macOS, S5.2). Electron has no
//! such state, since Squirrel.Mac fails late and the row then says the
//! connection is at fault. Its row is S5.2c's, in front of the owner.

use crate::status::{UnsupportedReason, UpdateStatus};

/// What install waits for while Videorc records or is on air.
pub const UPDATE_INSTALL_BLOCKED: &str =
    "Finish your recording or stream first. Installing restarts Videorc.";

/// The row's one control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateRowControl {
    /// A button that checks: "Check for updates" or "Check again".
    Check { label: &'static str },
    /// A check is running.
    Checking,
    /// A download's progress bar.
    Progress { percent: u8 },
    /// Restart to install. `disabled_reason` is why it cannot be pressed
    /// now.
    Install {
        label: String,
        disabled_reason: Option<&'static str>,
    },
    /// A link to a videorc.com page, by its name (`download`, `account`).
    Link {
        label: &'static str,
        page: &'static str,
    },
}

/// The row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateRowView {
    Row {
        description: String,
        control: Option<UpdateRowControl>,
    },
    /// A failed check or download: an alert with Try again, never the
    /// updater's own text.
    Error {
        title: &'static str,
        description: &'static str,
    },
}

const DOWNLOADS_PAGE: UpdateRowControl = UpdateRowControl::Link {
    label: "Open downloads page",
    page: "download",
};

fn row(description: impl Into<String>, control: Option<UpdateRowControl>) -> UpdateRowView {
    UpdateRowView::Row {
        description: description.into(),
        control,
    }
}

/// The row for a status. `capture_active` is whether Videorc records or is
/// on air, or cannot tell.
pub fn update_row_view(status: &UpdateStatus, capture_active: bool) -> UpdateRowView {
    match status {
        UpdateStatus::Idle => row(
            "Videorc checks in the background and installs an update the next time you quit.",
            Some(UpdateRowControl::Check {
                label: "Check for updates",
            }),
        ),
        UpdateStatus::Checking => row("Checking for updates…", Some(UpdateRowControl::Checking)),
        UpdateStatus::Available { version } => row(
            format!("Version {version} is available. Starting the download…"),
            None,
        ),
        UpdateStatus::Downloading { percent, version } => row(
            match version {
                Some(version) => format!("Downloading version {version}… {percent}%"),
                None => format!("Downloading the update… {percent}%"),
            },
            Some(UpdateRowControl::Progress { percent: *percent }),
        ),
        UpdateStatus::Downloaded { version } => row(
            if capture_active {
                format!(
                    "Version {version} is ready. Finish your recording or stream first, or it installs the next time you quit Videorc."
                )
            } else {
                format!(
                    "Version {version} is ready. Restart to install it now, or it installs the next time you quit Videorc."
                )
            },
            Some(UpdateRowControl::Install {
                label: format!("Restart & install {version}"),
                disabled_reason: capture_active.then_some(UPDATE_INSTALL_BLOCKED),
            }),
        ),
        UpdateStatus::NotAvailable { current_version } => row(
            format!("You're on the latest version ({current_version})."),
            Some(UpdateRowControl::Check {
                label: "Check again",
            }),
        ),
        // The updater's own message (a URL, an HTTP status) goes to the
        // log, never into this line.
        UpdateStatus::Error { .. } => UpdateRowView::Error {
            title: "Couldn't check for updates",
            description: "Check your internet connection, then try again. If it keeps happening, export a support bundle below.",
        },
        // Linux: the app never downloads it; the downloads page has it.
        UpdateStatus::DownloadAvailable { version } => row(
            format!("Videorc {version} is available. Download it from videorc.com."),
            Some(DOWNLOADS_PAGE),
        ),
        UpdateStatus::Unsupported {
            reason: Some(UnsupportedReason::LinuxVersionUnknown),
        } => row(
            "This build doesn't update itself. Videorc tells you here when a new version is on videorc.com.",
            Some(DOWNLOADS_PAGE),
        ),
        UpdateStatus::Unsupported {
            reason: Some(UnsupportedReason::WindowsFeedUnpublished),
        } => row(
            "No Windows update is published for you yet. Sign in to get Windows Alpha updates on their own, or download the newest build from your account page.",
            Some(UpdateRowControl::Link {
                label: "Open account page",
                page: "account",
            }),
        ),
        UpdateStatus::Unsupported { reason: None } => row(
            "This build doesn't update itself. Download new versions from videorc.com.",
            Some(DOWNLOADS_PAGE),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn description(view: &UpdateRowView) -> &str {
        match view {
            UpdateRowView::Row { description, .. } => description,
            UpdateRowView::Error { description, .. } => description,
        }
    }

    fn control(view: &UpdateRowView) -> Option<&UpdateRowControl> {
        match view {
            UpdateRowView::Row { control, .. } => control.as_ref(),
            UpdateRowView::Error { .. } => None,
        }
    }

    fn downloaded() -> UpdateStatus {
        UpdateStatus::Downloaded {
            version: "1.2.0".to_string(),
        }
    }

    #[test]
    fn says_that_an_update_installs_the_next_time_you_quit() {
        let idle = update_row_view(&UpdateStatus::Idle, false);
        assert_eq!(
            control(&idle),
            Some(&UpdateRowControl::Check {
                label: "Check for updates"
            })
        );
        assert!(description(&idle).contains("next time you quit"));
    }

    #[test]
    fn shows_a_download_as_a_progress_bar_with_its_percentage_in_words() {
        assert_eq!(
            update_row_view(
                &UpdateStatus::Downloading {
                    percent: 42,
                    version: Some("1.2.0".to_string())
                },
                false
            ),
            UpdateRowView::Row {
                description: "Downloading version 1.2.0… 42%".to_string(),
                control: Some(UpdateRowControl::Progress { percent: 42 }),
            }
        );
        // Before the feed's version is known.
        assert_eq!(
            description(&update_row_view(
                &UpdateStatus::Downloading {
                    percent: 0,
                    version: None
                },
                false
            )),
            "Downloading the update… 0%"
        );
    }

    #[test]
    fn says_a_found_update_is_about_to_download() {
        assert_eq!(
            update_row_view(
                &UpdateStatus::Available {
                    version: "1.2.0".to_string()
                },
                false
            ),
            UpdateRowView::Row {
                description: "Version 1.2.0 is available. Starting the download…".to_string(),
                control: None,
            }
        );
        assert_eq!(
            update_row_view(&UpdateStatus::Checking, false),
            UpdateRowView::Row {
                description: "Checking for updates…".to_string(),
                control: Some(UpdateRowControl::Checking),
            }
        );
    }

    #[test]
    fn installs_a_downloaded_update_now_or_on_quit() {
        assert_eq!(
            update_row_view(&downloaded(), false),
            UpdateRowView::Row {
                description: "Version 1.2.0 is ready. Restart to install it now, or it installs the next time you quit Videorc."
                    .to_string(),
                control: Some(UpdateRowControl::Install {
                    label: "Restart & install 1.2.0".to_string(),
                    disabled_reason: None,
                }),
            }
        );
    }

    #[test]
    fn waits_for_a_recording_or_a_livestream_to_finish_and_says_so() {
        let blocked = update_row_view(&downloaded(), true);
        assert_eq!(
            control(&blocked),
            Some(&UpdateRowControl::Install {
                label: "Restart & install 1.2.0".to_string(),
                disabled_reason: Some(UPDATE_INSTALL_BLOCKED),
            })
        );
        assert_eq!(
            UPDATE_INSTALL_BLOCKED,
            "Finish your recording or stream first. Installing restarts Videorc."
        );
        assert!(description(&blocked).contains("recording or stream"));
    }

    #[test]
    fn turns_a_failure_into_copy_with_try_again_never_the_raw_updater_text() {
        let failed = update_row_view(
            &UpdateStatus::Error {
                message: "HttpError: 503 \"method: GET url: https://example.test\"".to_string(),
            },
            false,
        );
        assert_eq!(
            failed,
            UpdateRowView::Error {
                title: "Couldn't check for updates",
                description: "Check your internet connection, then try again. If it keeps happening, export a support bundle below.",
            }
        );
        let drawn = format!("{failed:?}");
        assert!(
            !drawn.contains("HttpError") && !drawn.contains("503"),
            "{drawn}"
        );
    }

    #[test]
    fn links_a_build_that_cannot_update_itself_to_where_new_builds_are() {
        let plain = update_row_view(&UpdateStatus::Unsupported { reason: None }, false);
        assert_eq!(
            control(&plain),
            Some(&UpdateRowControl::Link {
                label: "Open downloads page",
                page: "download"
            })
        );
        let unpublished = update_row_view(
            &UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::WindowsFeedUnpublished),
            },
            false,
        );
        assert_eq!(
            control(&unpublished),
            Some(&UpdateRowControl::Link {
                label: "Open account page",
                page: "account"
            })
        );
    }

    #[test]
    fn sends_a_linux_build_to_the_downloads_page_for_a_newer_release_never_a_download() {
        assert_eq!(
            update_row_view(
                &UpdateStatus::DownloadAvailable {
                    version: "0.15.0-alpha.1".to_string()
                },
                false
            ),
            UpdateRowView::Row {
                description: "Videorc 0.15.0-alpha.1 is available. Download it from videorc.com."
                    .to_string(),
                control: Some(UpdateRowControl::Link {
                    label: "Open downloads page",
                    page: "download"
                }),
            }
        );
        let unknown = update_row_view(
            &UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::LinuxVersionUnknown),
            },
            false,
        );
        assert_eq!(
            control(&unknown),
            Some(&UpdateRowControl::Link {
                label: "Open downloads page",
                page: "download"
            })
        );
        // Not knowing is never "You're on the latest version".
        assert!(!description(&unknown).contains("latest"));
    }

    #[test]
    fn offers_check_again_once_up_to_date() {
        assert_eq!(
            update_row_view(
                &UpdateStatus::NotAvailable {
                    current_version: "1.1.0".to_string()
                },
                false
            ),
            UpdateRowView::Row {
                description: "You're on the latest version (1.1.0).".to_string(),
                control: Some(UpdateRowControl::Check {
                    label: "Check again"
                }),
            }
        );
    }

    #[test]
    fn says_what_the_app_already_says_for_a_build_that_does_not_update_itself() {
        // S3.11c drew this row from the same words (`settings_page::about`).
        assert_eq!(
            description(&update_row_view(
                &UpdateStatus::Unsupported { reason: None },
                true
            )),
            "This build doesn't update itself. Download new versions from videorc.com."
        );
    }
}
