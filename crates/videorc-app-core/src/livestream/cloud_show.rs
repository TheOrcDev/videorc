//! S1.6c: the cloud show outside the Destinations page
//! (`lib/cloud-show-view.ts`, `lib/cloud-handoff-view.ts` and the strings of
//! `components/studio/cloud-resume-notice.tsx`): the Studio's Resume notice,
//! the Go Live step that goes through the cloud, and the hand-off answer of
//! the End livestream question (plan 243).

use super::cloud_status::{CloudOnAirDevice, CloudStatus};
use super::on_air::format_cloud_countdown;
use crate::studio::session::{StopConfirmation, StopOrigin, end_livestream_body};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeAction {
    /// A show this computer stopped feeding.
    Resume,
    /// The show waits for a device, or another device is on air.
    Continue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeTone {
    Warning,
    Default,
}

/// `CloudResumeNotice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeNotice {
    pub title: String,
    pub detail: Option<String>,
    pub action: NoticeAction,
    pub tone: NoticeTone,
    /// Where a phone picks the show up, while it waits for one.
    pub pointer: Option<&'static str>,
}

/// The End livestream question's hand-off answer, inside the app.
pub const HAND_OFF_LABEL: &str = "Continue on another device";
/// What the hand-off does for viewers, named by the answer that does it.
pub const HAND_OFF_CONSEQUENCE: &str =
    "viewers see Be right back until you continue on your phone or another computer.";
/// The stop was a hand-off, but videorc.com could not be told.
pub const HAND_OFF_UNCONFIRMED: &str = "Videorc Cloud didn't confirm the hand-off. Viewers see Be right back until a device continues.";
/// Where a phone picks the show up (the web's `/live/continue`).
pub const CONTINUE_ON_PHONE: &str = "On your phone, open videorc.com/live/continue.";

// The notice's buttons and its End livestream question.
pub const RESUME_LABEL: &str = "Resume";
pub const RESUMING_LABEL: &str = "Resuming…";
pub const CONTINUE_HERE_LABEL: &str = "Continue here";
pub const CONTINUING_LABEL: &str = "Continuing…";
pub const RECONNECTING_LABEL: &str = "Reconnecting…";
pub const ENDING_LABEL: &str = "Ending…";
pub const END_CLOUD_SHOW_DESCRIPTION: &str = "The stream ends on every platform it's live on.";

/// The notice's first button: Reconnecting… while the Studio rejoins by
/// itself, else Resume or Continue here (with their pending words).
pub fn notice_action_label(notice: &ResumeNotice, pending: bool, rejoining: bool) -> &'static str {
    match (rejoining, notice.action, pending) {
        (true, _, _) => RECONNECTING_LABEL,
        (false, NoticeAction::Continue, true) => CONTINUING_LABEL,
        (false, NoticeAction::Continue, false) => CONTINUE_HERE_LABEL,
        (false, NoticeAction::Resume, true) => RESUMING_LABEL,
        (false, NoticeAction::Resume, false) => RESUME_LABEL,
    }
}

/// `onAirDeviceName`: "iPhone", or the kind when the device sent no name.
pub fn on_air_device_name(on_air: Option<&CloudOnAirDevice>) -> String {
    if let Some(name) = on_air.and_then(|on_air| on_air.name.as_deref()) {
        return name.to_string();
    }
    match on_air.map(|on_air| on_air.kind.as_str()) {
        Some("phone") => "a phone",
        Some("browser") => "a browser",
        Some("computer") => "another computer",
        _ => "another device",
    }
    .into()
}

/// `cloudResumeNotice`: a show is live on our servers and this computer
/// isn't feeding it. Shown only while no local session runs.
pub fn cloud_resume_notice(
    status: Option<&CloudStatus>,
    session_active: bool,
) -> Option<ResumeNotice> {
    let status = status?;
    let show = status.show.as_ref()?;
    let elsewhere = status.live_elsewhere();
    if !(show.resumable || elsewhere) || session_active {
        return None;
    }
    if matches!(status.phase.as_str(), "off" | "ending" | "failed") {
        return None;
    }
    let talk = show.kind.as_deref() == Some("talk");
    let guests = talk.then_some("Your guests are still on.");
    let on_air = status.on_air.as_ref();
    if elsewhere {
        let brief = (!talk && on_air.is_some_and(|on_air| on_air.source == "feed"))
            .then_some("Viewers see Be right back for a few seconds when you continue here.");
        return Some(ResumeNotice {
            title: format!("Your show is live from {}.", on_air_device_name(on_air)),
            detail: guests.or(brief).map(str::to_string),
            action: NoticeAction::Continue,
            tone: NoticeTone::Default,
            pointer: None,
        });
    }
    let waiting = on_air.is_some_and(|on_air| on_air.waiting);
    let until = if waiting { "continue" } else { "resume" };
    let hold =
        status
            .hold
            .as_ref()
            .filter(|hold| hold.active)
            .map(|hold| match hold.remaining_seconds {
                Some(remaining) if !talk => format!(
                    "Viewers see Be right back. The stream ends in {} unless you {until}.",
                    format_cloud_countdown(remaining as f64)
                ),
                _ => format!("Viewers see Be right back until you {until}."),
            });
    let joined = || {
        let parts: Vec<&str> = guests.into_iter().chain(hold.as_deref()).collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    };
    if waiting {
        return Some(ResumeNotice {
            title: "Your show is waiting for another device.".into(),
            detail: joined(),
            action: NoticeAction::Continue,
            tone: NoticeTone::Warning,
            pointer: Some(CONTINUE_ON_PHONE),
        });
    }
    Some(ResumeNotice {
        title: "You're still live through Videorc Cloud.".into(),
        detail: if talk {
            joined()
        } else {
            Some(
                hold.clone()
                    .unwrap_or_else(|| "Your stream is still on air.".into()),
            )
        },
        action: NoticeAction::Resume,
        tone: NoticeTone::Warning,
        pointer: None,
    })
}

/// `rejoiningResumeNotice`: while the Studio goes back into the room by
/// itself after a backend restart. A show another device has keeps its words.
pub fn rejoining_resume_notice(notice: ResumeNotice) -> ResumeNotice {
    if notice.action != NoticeAction::Resume {
        return notice;
    }
    ResumeNotice {
        title: "Reconnecting to your show…".into(),
        tone: NoticeTone::Default,
        ..notice
    }
}

/// `goesThroughCloud`: the switch is on for an entitled account, or a show
/// is still live on our servers, which Go Live feeds whatever the switch
/// says. Drives `golive::pending_label`'s "Connecting to Videorc Cloud…".
pub fn goes_through_cloud(status: Option<&CloudStatus>) -> bool {
    status.is_some_and(|status| {
        status.show.as_ref().is_some_and(|show| show.resumable)
            || (status.entitled && status.settings.enabled)
    })
}

/// `offersHandOff`: a managed show (`nodeId` "livekit") this computer is on
/// air for, solo or talk. Read when the question shows.
pub fn offers_hand_off(status: Option<&CloudStatus>) -> bool {
    status.is_some_and(|status| {
        status
            .show
            .as_ref()
            .is_some_and(|show| show.node_id == "livekit" && show.kind.as_deref() != Some("test"))
            && status
                .on_air
                .as_ref()
                .is_some_and(|on_air| on_air.this_device && !on_air.waiting)
    })
}

/// `handOffLabel`: the answer says the exit too when the app is leaving.
pub fn hand_off_label(origin: StopOrigin) -> &'static str {
    match origin {
        StopOrigin::Quit => "Quit and keep it live",
        StopOrigin::CloseWindow => "Close and keep it live",
        _ => HAND_OFF_LABEL,
    }
}

/// `handOffQuestionBody`: what End does, what the hand-off does, and the
/// recording, which stops and is saved either way.
pub fn hand_off_question_body(confirmation: &StopConfirmation) -> String {
    let end = end_livestream_body(&StopConfirmation {
        also_records: false,
        ..confirmation.clone()
    });
    let mut body = format!(
        "{end} With {}, {HAND_OFF_CONSEQUENCE}",
        hand_off_label(confirmation.origin)
    );
    if confirmation.also_records {
        body.push_str(" Your recording stops either way and is saved to the Library.");
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livestream::cloud_status::{CloudHold, CloudSettings, CloudShow};

    fn held(kind: &str) -> CloudStatus {
        CloudStatus {
            phase: "hold".into(),
            show: Some(CloudShow {
                id: "s".into(),
                node_id: "livekit".into(),
                resumable: true,
                kind: Some(kind.into()),
                ..CloudShow::default()
            }),
            hold: Some(CloudHold {
                active: true,
                remaining_seconds: Some(1620),
                ..CloudHold::default()
            }),
            ..CloudStatus::default()
        }
    }

    fn device(this_device: bool, waiting: bool) -> CloudOnAirDevice {
        CloudOnAirDevice {
            kind: "phone".into(),
            source: "feed".into(),
            this_device,
            waiting,
            ..CloudOnAirDevice::default()
        }
    }

    #[test]
    fn a_held_solo_show_offers_resume_with_the_countdown() {
        let notice = cloud_resume_notice(Some(&held("solo")), false).unwrap();
        assert_eq!(notice.title, "You're still live through Videorc Cloud.");
        assert_eq!(
            notice.detail.as_deref(),
            Some("Viewers see Be right back. The stream ends in 27 min unless you resume.")
        );
        assert_eq!(notice.action, NoticeAction::Resume);
        assert_eq!(notice.tone, NoticeTone::Warning);
        assert_eq!(notice_action_label(&notice, false, false), "Resume");
        assert_eq!(notice_action_label(&notice, true, false), "Resuming…");
        assert_eq!(notice_action_label(&notice, false, true), "Reconnecting…");
        assert_eq!(cloud_resume_notice(Some(&held("solo")), true), None);
        let mut ending = held("solo");
        ending.phase = "ending".into();
        assert_eq!(cloud_resume_notice(Some(&ending), false), None);
        let mut on_air = held("solo");
        on_air.hold = None;
        assert_eq!(
            cloud_resume_notice(Some(&on_air), false)
                .unwrap()
                .detail
                .as_deref(),
            Some("Your stream is still on air.")
        );
        let rejoining = rejoining_resume_notice(notice);
        assert_eq!(rejoining.title, "Reconnecting to your show…");
        assert_eq!(rejoining.tone, NoticeTone::Default);
    }

    #[test]
    fn a_talk_show_keeps_its_guests_and_never_counts_down() {
        let notice = cloud_resume_notice(Some(&held("talk")), false).unwrap();
        assert_eq!(
            notice.detail.as_deref(),
            Some("Your guests are still on. Viewers see Be right back until you resume.")
        );
    }

    #[test]
    fn a_show_waiting_or_elsewhere_offers_continue_here() {
        let mut waiting = held("solo");
        waiting.on_air = Some(device(false, true));
        let notice = cloud_resume_notice(Some(&waiting), false).unwrap();
        assert_eq!(notice.title, "Your show is waiting for another device.");
        assert_eq!(
            notice.detail.as_deref(),
            Some("Viewers see Be right back. The stream ends in 27 min unless you continue.")
        );
        assert_eq!(notice.pointer, Some(CONTINUE_ON_PHONE));
        assert_eq!(notice_action_label(&notice, false, false), "Continue here");

        let mut elsewhere = held("solo");
        elsewhere.show.as_mut().unwrap().resumable = false;
        elsewhere.on_air = Some(CloudOnAirDevice {
            name: Some("iPhone".into()),
            ..device(false, false)
        });
        let notice = cloud_resume_notice(Some(&elsewhere), false).unwrap();
        assert_eq!(notice.title, "Your show is live from iPhone.");
        assert_eq!(
            notice.detail.as_deref(),
            Some("Viewers see Be right back for a few seconds when you continue here.")
        );
        assert_eq!(notice.tone, NoticeTone::Default);
        assert_eq!(on_air_device_name(None), "another device");
        assert_eq!(on_air_device_name(Some(&device(false, false))), "a phone");
    }

    #[test]
    fn go_live_goes_through_the_cloud_when_on_or_held() {
        assert!(!goes_through_cloud(None));
        let mut status = CloudStatus {
            entitled: true,
            settings: CloudSettings {
                enabled: true,
                ..CloudSettings::default()
            },
            ..CloudStatus::default()
        };
        assert!(goes_through_cloud(Some(&status)));
        status.entitled = false;
        assert!(!goes_through_cloud(Some(&status)));
        assert!(goes_through_cloud(Some(&held("solo"))));
    }

    #[test]
    fn the_hand_off_is_offered_on_a_managed_show_this_computer_airs() {
        let mut status = held("solo");
        assert!(!offers_hand_off(Some(&status)));
        status.on_air = Some(device(true, false));
        assert!(offers_hand_off(Some(&status)));
        status.show.as_mut().unwrap().kind = Some("test".into());
        assert!(!offers_hand_off(Some(&status)));

        let confirmation = StopConfirmation {
            origin: StopOrigin::Quit,
            session_id: None,
            platforms: vec!["Twitch".into(), "YouTube".into()],
            also_records: true,
        };
        assert_eq!(hand_off_label(StopOrigin::Button), HAND_OFF_LABEL);
        assert_eq!(
            hand_off_question_body(&confirmation),
            "Viewers on Twitch and YouTube are disconnected. With Quit and keep it live, viewers see Be right back until you continue on your phone or another computer. Your recording stops either way and is saved to the Library."
        );
    }
}
