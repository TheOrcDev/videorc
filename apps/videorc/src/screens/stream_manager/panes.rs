//! Which pane the tabs picked, and what moves them (`stream-manager.tsx`):
//! the tabs, ⌘J, ⌘F and ⌘L (plan 174 S3.16a), a reply's prefill, and a new
//! Sidekick card bringing Sidekick forward (and the old panes back once the
//! cards are gone, unless the streamer moved on).

use std::collections::HashSet;

use super::layout::{Pane, RightPane, Tier, visible};

/// The window's keys. Each needs ⌘ (Ctrl off macOS), without Shift or Alt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneKey {
    /// ⌘J: Sidekick, wherever it sits.
    ShowSidekick,
    /// ⌘F: search chat.
    SearchChat,
    /// ⌘L: write in chat.
    WriteInChat,
}

/// What a key asks of the focused pane once it is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// Sidekick's pane expands (`setCohostExpand`).
    Sidekick,
    ChatSearch,
    Composer,
}

/// When a key runs. ⌘J needs Sidekick shown in the window; ⌘L needs a
/// composer (live, or a marker to write against, and never in history).
pub fn key_runs(key: PaneKey, sidekick_visible: bool, composer_available: bool) -> bool {
    match key {
        PaneKey::ShowSidekick => sidekick_visible,
        PaneKey::SearchChat => true,
        PaneKey::WriteInChat => composer_available,
    }
}

/// `composerAvailable`: `!inHistory && onSend && (live || markerContext)`.
pub fn composer_available(in_history: bool, can_send: bool, live: bool, marker: bool) -> bool {
    !in_history && can_send && (live || marker)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Picked {
    narrow: Pane,
    right: RightPane,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Panes {
    narrow: Pane,
    right: RightPane,
    /// The panes a Sidekick card moved the streamer from.
    revealed_from: Option<Picked>,
    /// Every Sidekick card already seen, so one card reveals once.
    seen_cards: HashSet<String>,
}

impl Default for Panes {
    fn default() -> Self {
        Self {
            narrow: Pane::Chat,
            right: RightPane::Activity,
            revealed_from: None,
            seen_cards: HashSet::new(),
        }
    }
}

impl Panes {
    pub fn narrow(&self) -> Pane {
        self.narrow
    }

    pub fn right(&self) -> RightPane {
        self.right
    }

    pub fn visible(&self, pane: Pane, tier: Tier) -> bool {
        visible(pane, tier, self.narrow, self.right)
    }

    /// The tabs below Wide.
    pub fn pick(&mut self, pane: Pane) {
        self.narrow = pane;
    }

    /// The right pane's tabs at Wide.
    pub fn pick_right(&mut self, pane: RightPane) {
        self.right = pane;
    }

    /// Runs a key the window allowed ([`key_runs`]). The pane is shown first,
    /// so its focus lands on a visible element.
    pub fn key(&mut self, key: PaneKey) -> Focus {
        match key {
            PaneKey::ShowSidekick => {
                self.narrow = Pane::Sidekick;
                self.right = RightPane::Sidekick;
                Focus::Sidekick
            }
            PaneKey::SearchChat => {
                self.narrow = Pane::Chat;
                Focus::ChatSearch
            }
            PaneKey::WriteInChat => {
                self.narrow = Pane::Chat;
                Focus::Composer
            }
        }
    }

    /// A reply or a Sidekick draft lands in the composer: Chat comes forward.
    pub fn prefill(&mut self) -> Focus {
        self.narrow = Pane::Chat;
        Focus::Composer
    }

    /// Sidekick's cards now (removals, a voice command, proposed posts). A
    /// card never seen before brings Sidekick forward while it sits behind a
    /// tab, without taking focus; the panes it moved from are remembered.
    pub fn cards(&mut self, ids: &[String], tier: Tier, sidekick_present: bool) {
        let mut fresh = false;
        for id in ids {
            fresh |= self.seen_cards.insert(id.clone());
        }
        if !fresh || self.visible(Pane::Sidekick, tier) || !sidekick_present {
            return;
        }
        self.revealed_from.get_or_insert(Picked {
            narrow: self.narrow,
            right: self.right,
        });
        self.narrow = Pane::Sidekick;
        self.right = RightPane::Sidekick;
    }

    /// Sidekick's cards and their result lines are gone: the panes the
    /// streamer was on come back, unless they moved off Sidekick themselves.
    pub fn cards_settled(&mut self, cards_active: bool) {
        if cards_active {
            return;
        }
        let Some(from) = self.revealed_from.take() else {
            return;
        };
        if self.narrow == Pane::Sidekick {
            self.narrow = from.narrow;
        }
        if self.right == RightPane::Sidekick {
            self.right = from.right;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn the_window_opens_on_chat_and_activity() {
        let panes = Panes::default();
        assert_eq!(panes.narrow(), Pane::Chat);
        assert_eq!(panes.right(), RightPane::Activity);
    }

    #[test]
    fn keys_run_only_when_their_pane_can_answer() {
        assert!(key_runs(PaneKey::SearchChat, false, false));
        assert!(!key_runs(PaneKey::ShowSidekick, false, true));
        assert!(key_runs(PaneKey::ShowSidekick, true, false));
        assert!(!key_runs(PaneKey::WriteInChat, true, false));
        assert!(key_runs(PaneKey::WriteInChat, false, true));
    }

    #[test]
    fn the_composer_needs_a_live_session_or_a_marker_and_never_history() {
        assert!(composer_available(false, true, true, false));
        assert!(composer_available(false, true, false, true));
        assert!(!composer_available(false, true, false, false));
        assert!(!composer_available(true, true, true, true));
        assert!(!composer_available(false, false, true, true));
    }

    #[test]
    fn command_j_shows_sidekick_on_both_sides() {
        let mut panes = Panes::default();
        assert_eq!(panes.key(PaneKey::ShowSidekick), Focus::Sidekick);
        assert_eq!(panes.narrow(), Pane::Sidekick);
        assert_eq!(panes.right(), RightPane::Sidekick);
    }

    #[test]
    fn command_f_and_l_bring_chat_forward_and_keep_the_right_pane() {
        let mut panes = Panes::default();
        panes.pick(Pane::Activity);
        panes.pick_right(RightPane::Sidekick);
        assert_eq!(panes.key(PaneKey::SearchChat), Focus::ChatSearch);
        assert_eq!(panes.narrow(), Pane::Chat);
        assert_eq!(panes.right(), RightPane::Sidekick);
        panes.pick(Pane::Sidekick);
        assert_eq!(panes.key(PaneKey::WriteInChat), Focus::Composer);
        assert_eq!(panes.narrow(), Pane::Chat);
    }

    #[test]
    fn a_prefill_brings_chat_forward() {
        let mut panes = Panes::default();
        panes.pick(Pane::Activity);
        assert_eq!(panes.prefill(), Focus::Composer);
        assert_eq!(panes.narrow(), Pane::Chat);
    }

    #[test]
    fn a_new_card_reveals_sidekick_and_the_old_panes_come_back() {
        let mut panes = Panes::default();
        panes.pick(Pane::Activity);
        panes.cards(&ids(&["op-1"]), Tier::Medium, true);
        assert_eq!(panes.narrow(), Pane::Sidekick);
        assert_eq!(panes.right(), RightPane::Sidekick);
        panes.cards_settled(true);
        assert_eq!(panes.narrow(), Pane::Sidekick);
        panes.cards_settled(false);
        assert_eq!(panes.narrow(), Pane::Activity);
        assert_eq!(panes.right(), RightPane::Activity);
    }

    #[test]
    fn a_card_reveals_once() {
        let mut panes = Panes::default();
        panes.cards(&ids(&["op-1"]), Tier::Medium, true);
        panes.cards_settled(false);
        panes.cards(&ids(&["op-1"]), Tier::Medium, true);
        assert_eq!(panes.narrow(), Pane::Chat);
    }

    #[test]
    fn the_streamer_moving_on_keeps_their_pick() {
        let mut panes = Panes::default();
        panes.cards(&ids(&["op-1"]), Tier::Medium, true);
        panes.pick(Pane::Activity);
        panes.cards_settled(false);
        assert_eq!(panes.narrow(), Pane::Activity);
        assert_eq!(panes.right(), RightPane::Activity);
    }

    #[test]
    fn a_second_card_keeps_the_first_reveal_s_origin() {
        let mut panes = Panes::default();
        panes.cards(&ids(&["op-1"]), Tier::Medium, true);
        panes.pick(Pane::Activity);
        panes.cards(&ids(&["op-1", "op-2"]), Tier::Medium, true);
        panes.cards_settled(false);
        assert_eq!(panes.narrow(), Pane::Chat);
    }

    #[test]
    fn no_reveal_when_sidekick_is_shown_or_absent() {
        let mut panes = Panes::default();
        panes.pick_right(RightPane::Sidekick);
        panes.cards(&ids(&["op-1"]), Tier::Wide, true);
        assert_eq!(panes.narrow(), Pane::Chat);
        panes.cards_settled(false);
        assert_eq!(panes.right(), RightPane::Sidekick);

        let mut absent = Panes::default();
        absent.cards(&ids(&["op-2"]), Tier::Medium, false);
        assert_eq!(absent.narrow(), Pane::Chat);
        absent.cards(&ids(&["op-2"]), Tier::Medium, true);
        assert_eq!(
            absent.narrow(),
            Pane::Chat,
            "a card seen while absent stays seen"
        );
    }
}
