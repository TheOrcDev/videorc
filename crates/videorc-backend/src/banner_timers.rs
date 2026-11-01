//! Banner timing (plan 186 S10): "Hide after" and "Show every".
//!
//! A banner with `hide_after_sec` hides that long after it starts showing,
//! however it was shown (Scene, Stream Manager, `/banner`, a remote, Buddy or
//! this timer). A banner with `repeat_every_min` shows itself on that period
//! while a recording or livestream runs, for sponsor rotation. A manual Show
//! or Hide always wins and restarts the cycle (plan 156 D3: manual always
//! wins); the timer never fights a Hide by showing again before the period.
//!
//! The book is pure: it watches the stored banner list (whatever changed it)
//! and says what is due. `run_banner_timers` owns one book for the process,
//! wakes on every banner change and at the next deadline, and executes the
//! due actions through the same store and compositor install as the RPCs.
//! A fresh process starts a fresh book, so a repeat never resumes before the
//! next session; a banner still showing after a relaunch counts its "Hide
//! after" from the launch.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::protocol::Banner;
use crate::state::AppState;

/// How often the task re-reads whether a session runs while any banner
/// repeats (session start and end have no event of their own here).
const SESSION_POLL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BannerTimerAction {
    Show(String),
    Hide(String),
}

/// How long a timed Hide the store did not apply waits before it is asked
/// again, so a failing Hide never spins.
const HIDE_RETRY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
struct Entry {
    shown_since: Option<Instant>,
    hide_after: Option<Duration>,
    repeat_every: Option<Duration>,
    next_show_at: Option<Instant>,
    /// When the book asked for this banner's Hide ("Hide after" ran out).
    /// Seeing it hidden next is the timer's own doing, so the repeat period
    /// keeps running from the last show; a manual Hide restarts it.
    timed_hide_at: Option<Instant>,
}

impl Entry {
    fn hide_at(&self) -> Option<Instant> {
        let due = self.shown_since? + self.hide_after?;
        Some(match self.timed_hide_at {
            Some(asked) => due.max(asked + HIDE_RETRY),
            None => due,
        })
    }
}

/// The per-process timing state, keyed by banner id. Pure; driven by
/// `observe` (the stored list after any change) and `due`.
#[derive(Debug, Default)]
pub(crate) struct BannerTimerBook {
    entries: HashMap<String, Entry>,
    session_active: bool,
}

fn seconds(value: Option<u32>) -> Option<Duration> {
    value
        .filter(|value| *value > 0)
        .map(|value| Duration::from_secs(u64::from(value)))
}

fn minutes(value: Option<u32>) -> Option<Duration> {
    value
        .filter(|value| *value > 0)
        .map(|value| Duration::from_secs(u64::from(value) * 60))
}

impl BannerTimerBook {
    /// Fold the stored list in. A banner that started showing starts its
    /// "Hide after" now and its repeat period (show to show) while a session
    /// runs; a manual Hide restarts the period, the timer's own Hide keeps
    /// it; a session's start schedules every repeat one period out and its
    /// end stops them; a changed period reschedules.
    pub(crate) fn observe(&mut self, banners: &[Banner], now: Instant, session_active: bool) {
        let session_started = session_active && !self.session_active;
        self.session_active = session_active;
        let present: HashSet<&str> = banners.iter().map(|banner| banner.id.as_str()).collect();
        self.entries.retain(|id, _| present.contains(id.as_str()));
        for banner in banners {
            let entry = self.entries.entry(banner.id.clone()).or_default();
            let hide_after = seconds(banner.hide_after_sec);
            let repeat_every = minutes(banner.repeat_every_min);
            let became_shown = banner.shown && entry.shown_since.is_none();
            let became_hidden = !banner.shown && entry.shown_since.is_some();
            // The book's own Hide keeps the period (show to show); a manual
            // one restarts it.
            let manual_hide = became_hidden && entry.timed_hide_at.is_none();
            entry.shown_since = match (banner.shown, entry.shown_since) {
                (true, Some(since)) => Some(since),
                (true, None) => Some(now),
                (false, _) => None,
            };
            if !banner.shown || became_shown {
                entry.timed_hide_at = None;
            }
            let repeat_changed = repeat_every != entry.repeat_every;
            entry.hide_after = hide_after;
            entry.repeat_every = repeat_every;
            entry.next_show_at = match repeat_every {
                Some(period) if session_active => {
                    if session_started
                        || became_shown
                        || manual_hide
                        || repeat_changed
                        || entry.next_show_at.is_none()
                    {
                        Some(now + period)
                    } else {
                        entry.next_show_at
                    }
                }
                _ => None,
            };
        }
    }

    /// What is due at `now`, and the bookkeeping for it: a showing banner
    /// past its "Hide after" hides; a hidden banner past its period shows
    /// (its next period starts now, so a refused Show never fires every
    /// tick); a showing banner at its period just starts the next one.
    pub(crate) fn due(&mut self, now: Instant) -> Vec<BannerTimerAction> {
        let mut actions = Vec::new();
        let mut ids: Vec<&String> = self.entries.keys().collect();
        ids.sort();
        let ids: Vec<String> = ids.into_iter().cloned().collect();
        for id in ids {
            let Some(entry) = self.entries.get_mut(&id) else {
                continue;
            };
            if entry.hide_at().is_some_and(|hide_at| hide_at <= now) {
                entry.timed_hide_at = Some(now);
                actions.push(BannerTimerAction::Hide(id.clone()));
                continue;
            }
            if let (Some(next), Some(period)) = (entry.next_show_at, entry.repeat_every)
                && next <= now
            {
                entry.next_show_at = Some(now + period);
                if entry.shown_since.is_none() {
                    actions.push(BannerTimerAction::Show(id.clone()));
                }
            }
        }
        actions
    }

    /// The earliest deadline the book is waiting for, if any.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.entries
            .values()
            .flat_map(|entry| [entry.hide_at(), entry.next_show_at])
            .flatten()
            .min()
    }

    /// Whether any banner repeats: the task then polls for a session's start
    /// and end.
    pub(crate) fn any_repeat(&self) -> bool {
        self.entries
            .values()
            .any(|entry| entry.repeat_every.is_some())
    }
}

/// The process's banner timer task: started once at backend start.
pub(crate) async fn run_banner_timers(state: AppState) {
    let mut book = BannerTimerBook::default();
    loop {
        let banners = match state.database.list_banners() {
            Ok(banners) => banners,
            Err(error) => {
                tracing::warn!("Banner timers could not read the banners: {error:#}");
                Vec::new()
            }
        };
        let session_active = state.recording.lock().await.is_some();
        let now = Instant::now();
        book.observe(&banners, now, session_active);
        let actions = book.due(now);
        if !actions.is_empty() {
            execute(&state, actions).await;
            // The executed actions changed the list; fold it in before
            // choosing the next wake (the change notification is consumed
            // by this pass, never a second one).
            continue;
        }
        let poll = book.any_repeat().then(|| now + SESSION_POLL);
        let wake = match (book.next_deadline(), poll) {
            (Some(deadline), Some(poll)) => Some(deadline.min(poll)),
            (deadline, poll) => deadline.or(poll),
        };
        match wake {
            Some(wake) => {
                tokio::select! {
                    _ = state.banner_timer_wake.notified() => {}
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(wake)) => {}
                }
            }
            None => state.banner_timer_wake.notified().await,
        }
    }
}

async fn execute(state: &AppState, actions: Vec<BannerTimerAction>) {
    for action in actions {
        let result = match &action {
            BannerTimerAction::Show(id) => crate::banners::show_banner(
                &state.database,
                id,
                &crate::compositor::banner_prepare_canvases(state).await,
                crate::recording::active_session_accepts_banners(state).await,
            )
            .map(|_| ()),
            BannerTimerAction::Hide(id) => state.database.hide_banner(id).map(|_| ()),
        };
        match result {
            Ok(()) => {
                if let Err(error) = crate::banners::on_banners_changed(state).await {
                    tracing::warn!("Could not publish the timed banner change: {error:#}");
                }
            }
            // A refusal (four showing, the budget, a session that cannot add
            // one) is the store's answer; the next period tries again.
            Err(error) => tracing::info!("Timed banner {action:?} was refused: {error:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_layout::OverlayRect;

    fn banner(id: &str, shown: bool, hide_after: Option<u32>, repeat: Option<u32>) -> Banner {
        Banner {
            id: id.to_string(),
            name: id.to_string(),
            image_file: format!("{id}.png"),
            thumbnail_file: format!("{id}.thumb.png"),
            width: 2400,
            height: 400,
            has_alpha: true,
            sort_order: 0,
            shown,
            horizontal: OverlayRect::new(0.2, 0.78, 0.6, 0.18),
            vertical: OverlayRect::new(0.07, 0.7, 0.86, 0.08),
            show_on_stream: true,
            show_in_recording: true,
            opacity: 1.0,
            hide_after_sec: hide_after,
            repeat_every_min: repeat,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    const SECOND: Duration = Duration::from_secs(1);
    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn hide_after_counts_from_the_show_and_a_manual_hide_cancels_it() {
        let start = Instant::now();
        let mut book = BannerTimerBook::default();
        book.observe(&[banner("a", false, Some(30), None)], start, false);
        assert!(
            book.due(start + MINUTE).is_empty(),
            "hidden: nothing to hide"
        );
        assert_eq!(book.next_deadline(), None);

        // Shown at +10 s: due at +40 s, not before.
        let shown_at = start + 10 * SECOND;
        book.observe(&[banner("a", true, Some(30), None)], shown_at, false);
        assert_eq!(book.next_deadline(), Some(shown_at + 30 * SECOND));
        assert!(book.due(shown_at + 29 * SECOND).is_empty());
        assert_eq!(
            book.due(shown_at + 30 * SECOND),
            vec![BannerTimerAction::Hide("a".into())]
        );

        // A manual Hide before the deadline: nothing left to do.
        book.observe(
            &[banner("a", false, Some(30), None)],
            shown_at + 5 * SECOND,
            false,
        );
        assert!(book.due(shown_at + MINUTE).is_empty());
        assert_eq!(book.next_deadline(), None);
    }

    #[test]
    fn showing_again_restarts_the_countdown_and_a_new_setting_applies_at_once() {
        let start = Instant::now();
        let mut book = BannerTimerBook::default();
        book.observe(&[banner("a", true, Some(30), None)], start, false);
        book.observe(
            &[banner("a", false, Some(30), None)],
            start + 20 * SECOND,
            false,
        );
        let again = start + 25 * SECOND;
        book.observe(&[banner("a", true, Some(30), None)], again, false);
        assert!(
            book.due(start + 40 * SECOND).is_empty(),
            "counted from the new show"
        );
        assert_eq!(book.next_deadline(), Some(again + 30 * SECOND));
        // Turning "Hide after" down to 10 s while showing: due from the show.
        book.observe(&[banner("a", true, Some(10), None)], again + SECOND, false);
        assert_eq!(
            book.due(again + 10 * SECOND),
            vec![BannerTimerAction::Hide("a".into())]
        );
        // Off (0): never hides.
        let mut book = BannerTimerBook::default();
        book.observe(&[banner("b", true, Some(0), None)], start, false);
        assert!(book.due(start + 60 * MINUTE).is_empty());
    }

    #[test]
    fn repeats_only_run_during_a_session_one_period_after_its_start() {
        let start = Instant::now();
        let mut book = BannerTimerBook::default();
        let idle = [banner("s", false, Some(30), Some(15))];
        book.observe(&idle, start, false);
        assert!(
            book.due(start + 60 * MINUTE).is_empty(),
            "idle: never shows"
        );
        assert!(book.any_repeat());

        let session = start + MINUTE;
        book.observe(&idle, session, true);
        assert!(book.due(session + 14 * MINUTE).is_empty());
        assert_eq!(
            book.due(session + 15 * MINUTE),
            vec![BannerTimerAction::Show("s".into())]
        );
        // The store shows it; 30 s later the timer hides it; the next show
        // is one period after the last show ("every 15 min", show to show).
        let shown_at = session + 15 * MINUTE;
        book.observe(&[banner("s", true, Some(30), Some(15))], shown_at, true);
        assert_eq!(
            book.due(shown_at + 30 * SECOND),
            vec![BannerTimerAction::Hide("s".into())]
        );
        let hidden_at = shown_at + 30 * SECOND;
        book.observe(&[banner("s", false, Some(30), Some(15))], hidden_at, true);
        assert_eq!(book.next_deadline(), Some(shown_at + 15 * MINUTE));
        assert!(book.due(shown_at + 14 * MINUTE).is_empty());
        assert_eq!(
            book.due(shown_at + 15 * MINUTE),
            vec![BannerTimerAction::Show("s".into())]
        );

        // The session ends: no more shows.
        let mut book = BannerTimerBook::default();
        book.observe(&idle, start, true);
        book.observe(&idle, start + MINUTE, false);
        assert!(book.due(start + 60 * MINUTE).is_empty());
        assert_eq!(book.next_deadline(), None);
    }

    #[test]
    fn a_manual_show_or_hide_restarts_the_cycle_and_a_refusal_waits_a_period() {
        let start = Instant::now();
        let mut book = BannerTimerBook::default();
        let hidden = [banner("s", false, None, Some(10))];
        book.observe(&hidden, start, true);
        // A manual Show at +4 min and a Hide at +6 min: the next timed show
        // is a full period after the Hide, not at +10 min.
        book.observe(
            &[banner("s", true, None, Some(10))],
            start + 4 * MINUTE,
            true,
        );
        book.observe(&hidden, start + 6 * MINUTE, true);
        assert!(book.due(start + 10 * MINUTE).is_empty());
        assert_eq!(
            book.due(start + 16 * MINUTE),
            vec![BannerTimerAction::Show("s".into())]
        );
        // The Show was refused (the list still says hidden): the next try is
        // one period later, never on every tick.
        book.observe(&hidden, start + 16 * MINUTE, true);
        assert!(book.due(start + 17 * MINUTE).is_empty());
        assert_eq!(
            book.due(start + 26 * MINUTE),
            vec![BannerTimerAction::Show("s".into())]
        );
        // Already showing at its period: nothing to show, the period rolls.
        let mut book = BannerTimerBook::default();
        book.observe(&[banner("t", true, None, Some(5))], start, true);
        assert!(book.due(start + 5 * MINUTE).is_empty());
        assert_eq!(book.next_deadline(), Some(start + 10 * MINUTE));
    }

    #[test]
    fn a_hide_the_store_did_not_apply_is_asked_again_after_a_pause() {
        let start = Instant::now();
        let mut book = BannerTimerBook::default();
        let showing = [banner("a", true, Some(10), None)];
        book.observe(&showing, start, false);
        let due_at = start + 10 * SECOND;
        assert_eq!(book.due(due_at), vec![BannerTimerAction::Hide("a".into())]);
        // The store refused it: still showing. No spin, one retry later.
        book.observe(&showing, due_at, false);
        assert!(book.due(due_at + SECOND).is_empty());
        assert_eq!(book.next_deadline(), Some(due_at + HIDE_RETRY));
        assert_eq!(
            book.due(due_at + HIDE_RETRY),
            vec![BannerTimerAction::Hide("a".into())]
        );
    }

    #[test]
    fn a_deleted_banner_leaves_the_book() {
        let start = Instant::now();
        let mut book = BannerTimerBook::default();
        book.observe(&[banner("a", true, Some(30), Some(5))], start, true);
        book.observe(&[], start + SECOND, true);
        assert!(book.due(start + 60 * MINUTE).is_empty());
        assert!(!book.any_repeat());
        assert_eq!(book.next_deadline(), None);
    }
}
