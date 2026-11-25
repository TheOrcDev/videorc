//! When the updater checks by itself, and what each request may do.
//!
//! The decisions `updater.ts` makes in `initAutoUpdater` and at the top of
//! its three commands (Check for updates, Download, Restart to install),
//! with no network, no clock and no window. The checks themselves are
//! [`crate::flow`]'s; what happens after one is [`crate::status`]'s
//! (`settle_status_after_check`, `should_auto_download`,
//! `should_background_recheck`).
//!
//! The rules, as the shipping app has them:
//!
//! - A packaged macOS or Windows build checks at launch, downloads what it
//!   finds, and checks again every thirty minutes from a settled status.
//!   The update installs at the next quit, never during a session.
//! - `VIDEORC_DISABLE_AUTO_UPDATE=1` switches off only the silent checks.
//!   Check for updates still works, on the same feeds.
//! - A build that is not packaged never checks, and says nothing until it
//!   is asked; asked, it says it does not update itself.
//! - An operator's pilot override that was refused at startup blocks every
//!   check, the manual one too. A half-configured bearer must not fall
//!   back to another feed in silence.
//! - Linux never updates itself. It asks the public changelog, when there
//!   is somewhere to ask; Download and Restart to install do nothing.

use crate::status::UnsupportedReason;

/// The system this build runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterHost {
    MacOs,
    Windows,
    Linux,
}

/// What is known when the app starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchFacts {
    pub host: UpdaterHost,
    /// An installed release build. A build run from its build folder is
    /// not one.
    pub packaged: bool,
    /// `VIDEORC_DISABLE_AUTO_UPDATE=1`
    /// ([`crate::windows_pilot::DISABLE_AUTO_UPDATE_ENV`]).
    pub background_disabled: bool,
    /// The operator's pilot override was set and refused
    /// ([`crate::windows_pilot::consume_windows_updater_startup_config`]
    /// returned an error). Never true off Windows, where the override is
    /// itself an error.
    pub pilot_config_refused: bool,
    /// Linux: there is somewhere to ask
    /// ([`crate::linux_notice::linux_update_notice_source`] returned one).
    pub linux_notice_source: bool,
}

/// What the updater does by itself from launch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchPlan {
    /// Nothing, and the status stays as it is.
    Off,
    /// Nothing, and the status says this build does not update itself.
    Unsupported { reason: Option<UnsupportedReason> },
    /// Nothing by itself; it checks when asked.
    OnRequest,
    /// It checks now, downloads what it finds (Linux only says so), and
    /// checks again every
    /// [`crate::status::BACKGROUND_RECHECK_INTERVAL_MS`] from a settled
    /// status.
    Background,
}

/// What the updater does by itself, decided once at launch.
pub fn launch_plan(facts: &LaunchFacts) -> LaunchPlan {
    if facts.host == UpdaterHost::Linux {
        if !facts.linux_notice_source {
            return LaunchPlan::Off;
        }
        if facts.background_disabled {
            // Never "You're on the latest version" on a check that was
            // not made.
            return LaunchPlan::Unsupported {
                reason: Some(UnsupportedReason::LinuxVersionUnknown),
            };
        }
        return LaunchPlan::Background;
    }
    if !facts.packaged {
        return LaunchPlan::Off;
    }
    if facts.pilot_config_refused {
        return LaunchPlan::Unsupported { reason: None };
    }
    if facts.background_disabled {
        return LaunchPlan::OnRequest;
    }
    LaunchPlan::Background
}

/// What the streamer asked for in Settings → About.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateRequest {
    Check,
    Download,
    /// Restart to install.
    Install,
}

/// What a request gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestAnswer {
    /// It runs. An install still passes the rule of [`crate::install`]
    /// first: never while something records or streams.
    Run,
    /// The status becomes "this build does not update itself", and that is
    /// the answer.
    Unsupported,
    /// Nothing happens, and the answer is the status as it is.
    Nothing,
}

/// Whether a request runs. The opt-out of the silent checks is not asked
/// here: a request is the streamer's own.
pub fn request_answer(facts: &LaunchFacts, request: UpdateRequest) -> RequestAnswer {
    if facts.host == UpdaterHost::Linux {
        return match request {
            UpdateRequest::Check if facts.linux_notice_source => RequestAnswer::Run,
            UpdateRequest::Check => RequestAnswer::Unsupported,
            // There is nothing to download or install in the app.
            UpdateRequest::Download | UpdateRequest::Install => RequestAnswer::Nothing,
        };
    }
    let can_update = facts.packaged && !facts.pilot_config_refused;
    match (request, can_update) {
        (_, true) => RequestAnswer::Run,
        (UpdateRequest::Check | UpdateRequest::Download, false) => RequestAnswer::Unsupported,
        (UpdateRequest::Install, false) => RequestAnswer::Nothing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUESTS: [UpdateRequest; 3] = [
        UpdateRequest::Check,
        UpdateRequest::Download,
        UpdateRequest::Install,
    ];

    fn desktop(host: UpdaterHost) -> LaunchFacts {
        LaunchFacts {
            host,
            packaged: true,
            background_disabled: false,
            pilot_config_refused: false,
            linux_notice_source: false,
        }
    }

    fn linux() -> LaunchFacts {
        LaunchFacts {
            linux_notice_source: true,
            ..desktop(UpdaterHost::Linux)
        }
    }

    fn answers(facts: &LaunchFacts) -> [RequestAnswer; 3] {
        REQUESTS.map(|request| request_answer(facts, request))
    }

    #[test]
    fn a_packaged_build_checks_by_itself_and_on_request() {
        for host in [UpdaterHost::MacOs, UpdaterHost::Windows] {
            let facts = desktop(host);
            assert_eq!(launch_plan(&facts), LaunchPlan::Background, "{host:?}");
            assert_eq!(answers(&facts), [RequestAnswer::Run; 3], "{host:?}");
        }
    }

    #[test]
    fn the_opt_out_switches_off_only_the_silent_checks() {
        for host in [UpdaterHost::MacOs, UpdaterHost::Windows] {
            let facts = LaunchFacts {
                background_disabled: true,
                ..desktop(host)
            };
            assert_eq!(launch_plan(&facts), LaunchPlan::OnRequest, "{host:?}");
            assert_eq!(answers(&facts), [RequestAnswer::Run; 3], "{host:?}");
        }
    }

    #[test]
    fn a_build_that_is_not_packaged_never_checks_and_says_so_only_when_asked() {
        for host in [UpdaterHost::MacOs, UpdaterHost::Windows] {
            for background_disabled in [false, true] {
                let facts = LaunchFacts {
                    packaged: false,
                    background_disabled,
                    ..desktop(host)
                };
                assert_eq!(launch_plan(&facts), LaunchPlan::Off, "{host:?}");
                assert_eq!(
                    answers(&facts),
                    [
                        RequestAnswer::Unsupported,
                        RequestAnswer::Unsupported,
                        RequestAnswer::Nothing
                    ],
                    "{host:?}"
                );
            }
        }
    }

    #[test]
    fn a_refused_pilot_override_blocks_every_check_the_manual_one_too() {
        for background_disabled in [false, true] {
            let facts = LaunchFacts {
                pilot_config_refused: true,
                background_disabled,
                ..desktop(UpdaterHost::Windows)
            };
            assert_eq!(
                launch_plan(&facts),
                LaunchPlan::Unsupported { reason: None }
            );
            assert_eq!(
                answers(&facts),
                [
                    RequestAnswer::Unsupported,
                    RequestAnswer::Unsupported,
                    RequestAnswer::Nothing
                ]
            );
        }
        // A build that is not packaged stays silent, refused override or not.
        let dev = LaunchFacts {
            packaged: false,
            pilot_config_refused: true,
            ..desktop(UpdaterHost::Windows)
        };
        assert_eq!(launch_plan(&dev), LaunchPlan::Off);
    }

    #[test]
    fn linux_asks_the_changelog_and_never_downloads_or_installs() {
        let facts = linux();
        assert_eq!(launch_plan(&facts), LaunchPlan::Background);
        assert_eq!(
            answers(&facts),
            [
                RequestAnswer::Run,
                RequestAnswer::Nothing,
                RequestAnswer::Nothing
            ]
        );
        // Packaged or not does not matter there: the source already says
        // whether a dev build may ask.
        let dev = LaunchFacts {
            packaged: false,
            ..facts
        };
        assert_eq!(launch_plan(&dev), LaunchPlan::Background);
        assert_eq!(answers(&dev), answers(&facts));
    }

    #[test]
    fn linux_with_the_opt_out_says_it_does_not_know_and_still_checks_when_asked() {
        let facts = LaunchFacts {
            background_disabled: true,
            ..linux()
        };
        assert_eq!(
            launch_plan(&facts),
            LaunchPlan::Unsupported {
                reason: Some(UnsupportedReason::LinuxVersionUnknown)
            }
        );
        assert_eq!(
            request_answer(&facts, UpdateRequest::Check),
            RequestAnswer::Run
        );
    }

    #[test]
    fn linux_with_nowhere_to_ask_stays_silent_and_says_so_only_when_asked() {
        for background_disabled in [false, true] {
            let facts = LaunchFacts {
                linux_notice_source: false,
                background_disabled,
                ..linux()
            };
            assert_eq!(launch_plan(&facts), LaunchPlan::Off);
            assert_eq!(
                answers(&facts),
                [
                    RequestAnswer::Unsupported,
                    RequestAnswer::Nothing,
                    RequestAnswer::Nothing
                ]
            );
        }
    }

    #[test]
    fn every_plan_that_checks_by_itself_also_checks_on_request() {
        // A table over every combination: nothing may check in silence
        // that refuses the streamer's own request.
        for host in [UpdaterHost::MacOs, UpdaterHost::Windows, UpdaterHost::Linux] {
            for bits in 0..16_u8 {
                let facts = LaunchFacts {
                    host,
                    packaged: bits & 1 != 0,
                    background_disabled: bits & 2 != 0,
                    pilot_config_refused: bits & 4 != 0,
                    linux_notice_source: bits & 8 != 0,
                };
                if launch_plan(&facts) == LaunchPlan::Background {
                    assert_eq!(
                        request_answer(&facts, UpdateRequest::Check),
                        RequestAnswer::Run,
                        "{facts:?}"
                    );
                    assert!(!facts.background_disabled, "{facts:?}");
                }
                // An install never runs where a check would not.
                if request_answer(&facts, UpdateRequest::Install) == RequestAnswer::Run {
                    assert_eq!(
                        request_answer(&facts, UpdateRequest::Check),
                        RequestAnswer::Run,
                        "{facts:?}"
                    );
                }
            }
        }
    }
}
