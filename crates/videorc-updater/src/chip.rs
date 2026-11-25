//! The sidebar's update chip (P021): a port of `update-ui.ts` with its
//! tests.
//!
//! The chip shows only while an update is in flight or ready, never for
//! idle, up to date, an error or a build that can't update (Settings → About
//! says those). Clicking installs when the update is downloaded and nothing
//! records or streams; otherwise it opens Settings → About. Its label fits
//! the sidebar (about 20 characters), so the version is only in `detail`,
//! the tooltip and the description.

use crate::status::UpdateStatus;

/// What a click on the chip does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipAction {
    /// Restart and install now.
    Install,
    /// Open Settings → About.
    Settings,
}

/// The chip's dot: green only when a click installs (plan 174 A-25).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipTone {
    Good,
    Neutral,
}

/// The chip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateChip {
    pub label: String,
    /// The full sentence, for the tooltip and the description.
    pub detail: String,
    pub action: ChipAction,
    pub tone: ChipTone,
}

/// `isUpdateInstallable`: downloaded, and nothing records or streams
/// (installing quits and relaunches Videorc).
pub fn is_update_installable(status: &UpdateStatus, capture_active: bool) -> bool {
    matches!(status, UpdateStatus::Downloaded { .. }) && !capture_active
}

fn chip(label: String, detail: String, action: ChipAction, tone: ChipTone) -> UpdateChip {
    UpdateChip {
        label,
        detail,
        action,
        tone,
    }
}

/// `updateChip`: the chip for a status, or none.
pub fn update_chip(status: &UpdateStatus, capture_active: bool) -> Option<UpdateChip> {
    match status {
        UpdateStatus::Available { version } => Some(chip(
            "Update available".to_string(),
            format!("Update {version} available"),
            ChipAction::Settings,
            ChipTone::Neutral,
        )),
        // Linux: a newer release is on videorc.com; Settings → About links
        // to it.
        UpdateStatus::DownloadAvailable { version } => Some(chip(
            "Update available".to_string(),
            format!("Videorc {version} is available on videorc.com"),
            ChipAction::Settings,
            ChipTone::Neutral,
        )),
        UpdateStatus::Downloading { percent, version } => Some(chip(
            format!("Downloading… {percent}%"),
            match version {
                Some(version) => format!("Downloading update {version}… {percent}%"),
                None => format!("Downloading update… {percent}%"),
            },
            ChipAction::Settings,
            ChipTone::Neutral,
        )),
        UpdateStatus::Downloaded { version } if capture_active => Some(chip(
            "Update after stop".to_string(),
            format!(
                "Restart to update to {version} once you stop recording or end the livestream."
            ),
            ChipAction::Settings,
            ChipTone::Neutral,
        )),
        UpdateStatus::Downloaded { version } => Some(chip(
            "Restart to update".to_string(),
            format!("Restart to update to {version}"),
            ChipAction::Install,
            ChipTone::Good,
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::UnsupportedReason;

    fn downloaded() -> UpdateStatus {
        UpdateStatus::Downloaded {
            version: "1.1.0".to_string(),
        }
    }

    #[test]
    fn installs_only_a_downloaded_update_while_nothing_captures() {
        assert!(is_update_installable(&downloaded(), false));
        assert!(!is_update_installable(&downloaded(), true));
        for status in [
            UpdateStatus::Idle,
            UpdateStatus::Checking,
            UpdateStatus::Available {
                version: "1.1.0".to_string(),
            },
            UpdateStatus::Downloading {
                percent: 50,
                version: None,
            },
        ] {
            assert!(!is_update_installable(&status, false));
        }
    }

    #[test]
    fn renders_only_for_in_flight_or_ready_updates() {
        for status in [
            UpdateStatus::Idle,
            UpdateStatus::Checking,
            UpdateStatus::NotAvailable {
                current_version: "1.0.0".to_string(),
            },
            UpdateStatus::Error {
                message: "boom".to_string(),
            },
            UpdateStatus::Unsupported { reason: None },
            UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::LinuxVersionUnknown),
            },
        ] {
            assert_eq!(update_chip(&status, false), None, "{status:?}");
        }
        assert_eq!(
            update_chip(
                &UpdateStatus::Available {
                    version: "1.1.0".to_string()
                },
                false
            ),
            Some(chip(
                "Update available".into(),
                "Update 1.1.0 available".into(),
                ChipAction::Settings,
                ChipTone::Neutral
            ))
        );
        assert_eq!(
            update_chip(
                &UpdateStatus::DownloadAvailable {
                    version: "0.15.0-alpha.1".to_string()
                },
                false
            ),
            Some(chip(
                "Update available".into(),
                "Videorc 0.15.0-alpha.1 is available on videorc.com".into(),
                ChipAction::Settings,
                ChipTone::Neutral
            ))
        );
        assert_eq!(
            update_chip(
                &UpdateStatus::Downloading {
                    percent: 42,
                    version: None
                },
                false
            ),
            Some(chip(
                "Downloading… 42%".into(),
                "Downloading update… 42%".into(),
                ChipAction::Settings,
                ChipTone::Neutral
            ))
        );
        assert_eq!(
            update_chip(
                &UpdateStatus::Downloading {
                    percent: 7,
                    version: Some("1.1.0".to_string())
                },
                false
            )
            .map(|chip| chip.detail),
            Some("Downloading update 1.1.0… 7%".to_string())
        );
    }

    #[test]
    fn keeps_every_label_short_with_the_version_in_the_detail_only() {
        let long = "10.120.300-beta.12".to_string();
        for status in [
            UpdateStatus::Available {
                version: long.clone(),
            },
            UpdateStatus::DownloadAvailable {
                version: long.clone(),
            },
            UpdateStatus::Downloading {
                percent: 100,
                version: Some(long.clone()),
            },
            UpdateStatus::Downloaded {
                version: long.clone(),
            },
        ] {
            for capture in [false, true] {
                let chip = update_chip(&status, capture).unwrap();
                assert!(chip.label.chars().count() <= 20, "{}", chip.label);
                assert!(!chip.label.contains(&long));
                assert!(chip.detail.contains(&long));
            }
        }
    }

    #[test]
    fn offers_install_when_downloaded_but_never_mid_capture() {
        assert_eq!(
            update_chip(&downloaded(), false),
            Some(chip(
                "Restart to update".into(),
                "Restart to update to 1.1.0".into(),
                ChipAction::Install,
                ChipTone::Good
            ))
        );
        assert_eq!(
            update_chip(&downloaded(), true),
            Some(chip(
                "Update after stop".into(),
                "Restart to update to 1.1.0 once you stop recording or end the livestream.".into(),
                ChipAction::Settings,
                ChipTone::Neutral
            ))
        );
    }
}
