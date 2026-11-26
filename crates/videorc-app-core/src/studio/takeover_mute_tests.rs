use super::*;

fn owned(prior: bool) -> Option<TakeoverMuteOwnership> {
    Some(TakeoverMuteOwnership {
        prior_microphone_muted: prior,
    })
}

/// Electron: 'mutes a newly observed takeover and restores an
/// originally-live microphone'.
#[test]
fn a_takeover_mutes_a_live_microphone_and_gives_it_back() {
    let start = transition(true, false, None);
    assert_eq!(
        start,
        Transition {
            microphone_muted: true,
            ownership: owned(false),
        }
    );
    let end = transition(false, start.microphone_muted, start.ownership);
    assert_eq!(
        end,
        Transition {
            microphone_muted: false,
            ownership: None,
        }
    );
}

/// Electron: 'round-trips ownership across reload without reasserting over a
/// manual unmute'.
#[test]
fn a_takeover_still_on_air_never_takes_a_second_mute() {
    // Reconnected (or relaunched mid-takeover) with the record: the
    // streamer had unmuted by hand; the takeover leaves it.
    let again = transition(true, false, owned(false));
    assert_eq!(
        again,
        Transition {
            microphone_muted: false,
            ownership: owned(false),
        }
    );
    let end = transition(false, false, again.ownership);
    assert!(!end.microphone_muted);
    assert_eq!(end.ownership, None);
}

/// Electron: 'never unmutes a microphone that was already muted before
/// takeover'.
#[test]
fn a_microphone_muted_before_stays_muted() {
    let start = transition(true, true, None);
    assert!(start.microphone_muted);
    assert_eq!(start.ownership, owned(true));
    let end = transition(false, true, start.ownership);
    assert_eq!(
        end,
        Transition {
            microphone_muted: true,
            ownership: None,
        }
    );
}

/// A relaunch: the backend retired the last run's takeover, so the first
/// read says none, and the record the last run left releases its mute.
#[test]
fn a_relaunch_releases_the_mute_the_last_run_left() {
    assert_eq!(
        transition(false, true, owned(false)),
        Transition {
            microphone_muted: false,
            ownership: None,
        }
    );
    // Without a record nothing is touched.
    assert_eq!(
        transition(false, true, None),
        Transition {
            microphone_muted: true,
            ownership: None,
        }
    );
}
