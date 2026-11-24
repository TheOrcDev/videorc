//! The first-frame and presenting contracts, ported from
//! `apps/desktop/src/main/native-preview-first-frame.ts` (Definitive Fix
//! Plan P2, plan 021 F1).
//!
//! From the moment the preview element exists, the app owes the user one of
//! three outcomes within budget: a native frame of the app's committed scene,
//! a self-heal that gets there, or a declared fallback with the exact blocked
//! link. "Waiting for preview" forever is not an outcome.
//!
//! This module is the pure decision core: given a [`Snapshot`] of the chain
//! each tick, it says whether the contract is met, which healing action to
//! fire next, and the truthful reason for the slot's waiting hint. The
//! element owns the timers and executes the actions. Nothing here touches
//! Metal, so it is tested on every platform.

/// One tick's view of the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub elapsed_ms: u64,
    /// `preview.surface.status` says `live`.
    pub surface_live: bool,
    /// The layer is attached and the presenter thread is running.
    pub native_presenting: bool,
    /// The compositor's `framesRendered` advanced since the previous tick.
    pub frames_advancing: bool,
    /// The presenter's presented frame id advanced since the previous tick.
    pub presentation_advancing: bool,
    /// The revision of the scene the app last committed (`None` before the
    /// first commit).
    pub renderer_scene_revision: Option<u64>,
    pub compositor_scene_revision: Option<u64>,
    pub compositor_frame_scene_revision: Option<u64>,
    /// The latest frame carried a frame target: an IOSurface id on the
    /// native route, the mapped ring on the CPU route (plan 220 S4.1d).
    pub metal_target_present: bool,
}

/// The healing ladder, cheapest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HealingAction {
    /// Re-present the freshest frame through the normal path (a stalled
    /// pump, a stale status).
    PresentKick,
    /// Commit the app's scene again; a committed revision displaces a stale
    /// or foreign compositor scene (the 2026-07-01 incident class).
    ResyncScene,
    /// Retire the presenter and the layer and build them again.
    ResetNativePath,
}

impl HealingAction {
    pub const ORDER: [HealingAction; 3] = [
        HealingAction::PresentKick,
        HealingAction::ResyncScene,
        HealingAction::ResetNativePath,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HealingAction::PresentKick => "present-kick",
            HealingAction::ResyncScene => "resync-scene",
            HealingAction::ResetNativePath => "reset-native-path",
        }
    }

    fn index(self) -> usize {
        match self {
            HealingAction::PresentKick => 0,
            HealingAction::ResyncScene => 1,
            HealingAction::ResetNativePath => 2,
        }
    }
}

/// What the ladder has done so far.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Ledger {
    pub last_action_at_ms: u64,
    attempts: [u32; 3],
}

impl Ledger {
    pub fn attempts(&self, action: HealingAction) -> u32 {
        self.attempts[action.index()]
    }
}

/// When each action may fire, how far apart, how often, and when to give up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budgets {
    pub present_kick_after_ms: u64,
    pub resync_scene_after_ms: u64,
    pub reset_native_path_after_ms: u64,
    /// The least time between any two healing actions.
    pub action_spacing_ms: u64,
    /// Attempts allowed per action before the ladder moves on.
    pub attempts_per_action: u32,
    /// After this the contract is declared failed.
    pub declare_fallback_after_ms: u64,
}

impl Budgets {
    /// `DEFAULT_FIRST_FRAME_BUDGETS`.
    pub const FIRST_FRAME: Budgets = Budgets {
        present_kick_after_ms: 1500,
        resync_scene_after_ms: 3000,
        reset_native_path_after_ms: 6000,
        action_spacing_ms: 1200,
        attempts_per_action: 2,
        declare_fallback_after_ms: 15_000,
    };

    fn available_at_ms(&self, action: HealingAction) -> u64 {
        match action {
            HealingAction::PresentKick => self.present_kick_after_ms,
            HealingAction::ResyncScene => self.resync_scene_after_ms,
            HealingAction::ResetNativePath => self.reset_native_path_after_ms,
        }
    }
}

/// `FirstFrameAssessment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assessment {
    Met,
    Pending {
        reason: String,
    },
    Heal {
        action: HealingAction,
        reason: String,
    },
    Fallback {
        reason: String,
    },
}

/// `firstFrameContractMet`: the whole chain agrees and advances. A first
/// frame satisfies startup before a second native frame exists; the
/// presenting watch adds the advancement requirement.
pub fn contract_met(snapshot: &Snapshot) -> bool {
    snapshot.surface_live
        && snapshot.native_presenting
        && snapshot.frames_advancing
        && snapshot.metal_target_present
        && snapshot.renderer_scene_revision.is_some()
        && snapshot.compositor_scene_revision == snapshot.renderer_scene_revision
        && snapshot.compositor_frame_scene_revision == snapshot.compositor_scene_revision
}

/// `firstFrameBlockedReason`: the truthful waiting reason, ordered by which
/// link of the chain is blocked first. Shown verbatim in the slot's hint.
pub fn blocked_reason(snapshot: &Snapshot) -> String {
    if !snapshot.surface_live {
        return "Preview surface is starting.".to_string();
    }
    let Some(renderer) = snapshot.renderer_scene_revision else {
        return "Waiting for the app to commit its scene.".to_string();
    };
    if let Some(compositor) = snapshot.compositor_scene_revision
        && compositor != renderer
    {
        return format!(
            "Compositor is on scene revision {compositor}, but the app committed {renderer}."
        );
    }
    if let (Some(frame), Some(compositor)) = (
        snapshot.compositor_frame_scene_revision,
        snapshot.compositor_scene_revision,
    ) && frame != compositor
    {
        return format!("Waiting for the compositor to render scene revision {compositor}.");
    }
    if !snapshot.metal_target_present {
        return "Compositor has not produced a frame target yet.".to_string();
    }
    if !snapshot.frames_advancing {
        return "Compositor frames are not advancing.".to_string();
    }
    if !snapshot.presentation_advancing {
        return "Native presentation is not advancing.".to_string();
    }
    if !snapshot.native_presenting {
        return "Native presenter has not confirmed a frame yet.".to_string();
    }
    "Waiting for the first native frame.".to_string()
}

/// Which action the blocked link calls for: a scene-revision divergence goes
/// straight to resync; a dead presenter under advancing frames goes straight
/// to the path reset; anything else starts with the kick.
fn preferred_action(snapshot: &Snapshot) -> HealingAction {
    if let (Some(renderer), Some(compositor)) = (
        snapshot.renderer_scene_revision,
        snapshot.compositor_scene_revision,
    ) && compositor != renderer
    {
        return HealingAction::ResyncScene;
    }
    if snapshot.surface_live
        && snapshot.metal_target_present
        && snapshot.frames_advancing
        && (!snapshot.native_presenting || !snapshot.presentation_advancing)
    {
        return HealingAction::ResetNativePath;
    }
    HealingAction::PresentKick
}

/// `assessFirstFrame`: one tick of the startup contract.
pub fn assess_first_frame(
    snapshot: &Snapshot,
    ledger: &Ledger,
    budgets: &Budgets,
    require_presentation_advancing: bool,
) -> (Assessment, Ledger) {
    if contract_met(snapshot)
        && (!require_presentation_advancing || snapshot.presentation_advancing)
    {
        return (Assessment::Met, ledger.clone());
    }
    let reason = blocked_reason(snapshot);
    if snapshot.elapsed_ms >= budgets.declare_fallback_after_ms {
        return (Assessment::Fallback { reason }, ledger.clone());
    }
    let since_last = snapshot.elapsed_ms.saturating_sub(ledger.last_action_at_ms);
    if ledger.last_action_at_ms > 0 && since_last < budgets.action_spacing_ms {
        return (Assessment::Pending { reason }, ledger.clone());
    }
    // The diagnosed action first, then the rest of the ladder in order.
    let preferred = preferred_action(snapshot);
    let candidates = std::iter::once(preferred).chain(
        HealingAction::ORDER
            .into_iter()
            .filter(move |action| *action != preferred),
    );
    for action in candidates {
        if snapshot.elapsed_ms < budgets.available_at_ms(action) {
            continue;
        }
        if ledger.attempts(action) >= budgets.attempts_per_action {
            continue;
        }
        let mut next = ledger.clone();
        next.last_action_at_ms = snapshot.elapsed_ms;
        next.attempts[action.index()] += 1;
        return (Assessment::Heal { action, reason }, next);
    }
    (Assessment::Pending { reason }, ledger.clone())
}

// --- The presenting watch (plan 021 F1) -----------------------------------
// The first-frame contract used to end at `Met`: nothing watched for a stall
// afterwards, so a dead pump or a lost surface showed the placeholder
// forever. The watch keeps assessing the same chain after the first frame:
// consecutive broken ticks re-enter the healing ladder, exhaustion declares a
// truthful stall, and a recovery re-arms a fresh ladder.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresentingWatchBudgets {
    /// Consecutive broken ticks before the ladder arms.
    pub stall_ticks_before_healing: u32,
    /// The ladder, with elapsed time measured from the start of the stall.
    pub healing: Budgets,
}

impl PresentingWatchBudgets {
    /// `DEFAULT_PRESENTING_WATCH_BUDGETS`: the tick threshold absorbed the
    /// transient window, so the cheap kick fires as soon as a stall is
    /// confirmed.
    pub const DEFAULT: PresentingWatchBudgets = PresentingWatchBudgets {
        stall_ticks_before_healing: 3,
        healing: Budgets {
            present_kick_after_ms: 0,
            resync_scene_after_ms: 2500,
            reset_native_path_after_ms: 5000,
            action_spacing_ms: 1500,
            attempts_per_action: 2,
            declare_fallback_after_ms: 20_000,
        },
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PresentingWatch {
    pub broken_ticks: u32,
    pub stall_elapsed_ms: u64,
    pub ledger: Ledger,
    pub exhausted: bool,
}

/// `PresentingAssessment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presenting {
    Presenting,
    /// A broken tick below the threshold: silent, never a hint.
    Observing {
        reason: String,
    },
    Heal {
        action: HealingAction,
        reason: String,
    },
    /// The ladder is exhausted; the watch keeps going so a revival re-arms it.
    Stalled {
        reason: String,
    },
}

/// Everything healthy except frame advancement: a legitimately static scene
/// looks like this (the compositor renders on source frames), so the
/// disruptive path reset never fires for it.
fn is_soft_stall(snapshot: &Snapshot) -> bool {
    snapshot.surface_live
        && snapshot.native_presenting
        && snapshot.metal_target_present
        && snapshot.renderer_scene_revision.is_some()
        && snapshot.compositor_scene_revision == snapshot.renderer_scene_revision
        && snapshot.compositor_frame_scene_revision == snapshot.compositor_scene_revision
        && !snapshot.frames_advancing
}

/// `assessPresenting`: one tick of the mid-session watch.
pub fn assess_presenting(
    snapshot: &Snapshot,
    watch: &PresentingWatch,
    tick_ms: u64,
    budgets: &PresentingWatchBudgets,
) -> (Presenting, PresentingWatch) {
    if contract_met(snapshot) && snapshot.presentation_advancing {
        // Recovery resets everything, so the next stall gets a fresh ladder.
        return (Presenting::Presenting, PresentingWatch::default());
    }
    let mut next = watch.clone();
    next.broken_ticks += 1;
    next.stall_elapsed_ms += tick_ms;
    let reason = blocked_reason(snapshot);
    if next.broken_ticks < budgets.stall_ticks_before_healing {
        return (Presenting::Observing { reason }, next);
    }
    if next.exhausted {
        return (Presenting::Stalled { reason }, next);
    }
    let stall = Snapshot {
        elapsed_ms: next.stall_elapsed_ms,
        ..snapshot.clone()
    };
    let (assessment, ledger) = assess_first_frame(&stall, &next.ledger, &budgets.healing, true);
    next.ledger = ledger;
    let presenting = match assessment {
        // Unreachable (the contract was checked above); keep the mapping total.
        Assessment::Met => return (Presenting::Presenting, PresentingWatch::default()),
        Assessment::Pending { reason } => Presenting::Observing { reason },
        Assessment::Heal { action, reason } => {
            if action == HealingAction::ResetNativePath && is_soft_stall(snapshot) {
                // The attempt stays charged so the ladder still exhausts
                // toward a declared stall; the reset just never fires.
                Presenting::Observing { reason }
            } else {
                Presenting::Heal { action, reason }
            }
        }
        Assessment::Fallback { reason } => {
            next.exhausted = true;
            Presenting::Stalled { reason }
        }
    };
    (presenting, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Snapshot {
        Snapshot {
            elapsed_ms: 0,
            surface_live: true,
            native_presenting: true,
            frames_advancing: true,
            presentation_advancing: true,
            renderer_scene_revision: Some(42),
            compositor_scene_revision: Some(42),
            compositor_frame_scene_revision: Some(42),
            metal_target_present: true,
        }
    }

    fn first(snapshot: &Snapshot, ledger: &Ledger) -> (Assessment, Ledger) {
        assess_first_frame(snapshot, ledger, &Budgets::FIRST_FRAME, false)
    }

    fn heal_action(assessment: &Assessment) -> Option<HealingAction> {
        match assessment {
            Assessment::Heal { action, .. } => Some(*action),
            _ => None,
        }
    }

    #[test]
    fn the_contract_is_met_only_when_the_whole_chain_agrees_and_advances() {
        assert!(contract_met(&snapshot()));
        assert!(!contract_met(&Snapshot {
            surface_live: false,
            ..snapshot()
        }));
        assert!(!contract_met(&Snapshot {
            native_presenting: false,
            ..snapshot()
        }));
        assert!(!contract_met(&Snapshot {
            frames_advancing: false,
            ..snapshot()
        }));
        // A first frame satisfies startup before a second native frame exists.
        assert!(contract_met(&Snapshot {
            presentation_advancing: false,
            ..snapshot()
        }));
        assert!(!contract_met(&Snapshot {
            metal_target_present: false,
            ..snapshot()
        }));
        assert!(!contract_met(&Snapshot {
            renderer_scene_revision: None,
            ..snapshot()
        }));
        assert!(!contract_met(&Snapshot {
            compositor_scene_revision: Some(41),
            ..snapshot()
        }));
        assert!(!contract_met(&Snapshot {
            compositor_frame_scene_revision: Some(41),
            ..snapshot()
        }));
    }

    #[test]
    fn the_blocked_reason_names_the_first_blocked_link_in_chain_order() {
        assert!(
            blocked_reason(&Snapshot {
                surface_live: false,
                ..snapshot()
            })
            .contains("surface is starting")
        );
        assert!(
            blocked_reason(&Snapshot {
                renderer_scene_revision: None,
                ..snapshot()
            })
            .contains("commit its scene")
        );
        assert_eq!(
            blocked_reason(&Snapshot {
                compositor_scene_revision: Some(7),
                ..snapshot()
            }),
            "Compositor is on scene revision 7, but the app committed 42."
        );
        assert_eq!(
            blocked_reason(&Snapshot {
                compositor_frame_scene_revision: Some(41),
                ..snapshot()
            }),
            "Waiting for the compositor to render scene revision 42."
        );
        assert!(
            blocked_reason(&Snapshot {
                metal_target_present: false,
                ..snapshot()
            })
            .contains("frame target")
        );
        assert!(
            blocked_reason(&Snapshot {
                frames_advancing: false,
                ..snapshot()
            })
            .contains("frames are not advancing")
        );
        assert!(
            blocked_reason(&Snapshot {
                presentation_advancing: false,
                ..snapshot()
            })
            .contains("presentation is not advancing")
        );
        assert!(
            blocked_reason(&Snapshot {
                native_presenting: false,
                ..snapshot()
            })
            .contains("Native presenter")
        );
    }

    #[test]
    fn met_leaves_the_ledger_untouched() {
        let ledger = Ledger::default();
        let (assessment, after) = first(
            &Snapshot {
                elapsed_ms: 500,
                ..snapshot()
            },
            &ledger,
        );
        assert_eq!(assessment, Assessment::Met);
        assert_eq!(after, ledger);
    }

    #[test]
    fn pending_before_the_first_action_budget() {
        let (assessment, _) = first(
            &Snapshot {
                elapsed_ms: 800,
                native_presenting: false,
                ..snapshot()
            },
            &Ledger::default(),
        );
        assert!(matches!(assessment, Assessment::Pending { .. }));
    }

    #[test]
    fn the_kick_fires_first_for_a_generic_stall() {
        let (assessment, ledger) = first(
            &Snapshot {
                elapsed_ms: 1600,
                frames_advancing: false,
                native_presenting: false,
                ..snapshot()
            },
            &Ledger::default(),
        );
        assert_eq!(heal_action(&assessment), Some(HealingAction::PresentKick));
        assert_eq!(ledger.attempts(HealingAction::PresentKick), 1);
        assert_eq!(ledger.last_action_at_ms, 1600);
    }

    #[test]
    fn a_foreign_compositor_scene_goes_straight_to_resync() {
        let (assessment, _) = first(
            &Snapshot {
                elapsed_ms: 3200,
                compositor_scene_revision: Some(999_999),
                compositor_frame_scene_revision: Some(999_999),
                native_presenting: false,
                ..snapshot()
            },
            &Ledger::default(),
        );
        assert_eq!(heal_action(&assessment), Some(HealingAction::ResyncScene));
    }

    #[test]
    fn frames_without_a_presenter_go_straight_to_the_path_reset() {
        let (assessment, _) = first(
            &Snapshot {
                elapsed_ms: 6500,
                native_presenting: false,
                ..snapshot()
            },
            &Ledger::default(),
        );
        assert_eq!(
            heal_action(&assessment),
            Some(HealingAction::ResetNativePath)
        );
    }

    #[test]
    fn actions_are_spaced_and_capped_per_action() {
        let stall = |elapsed_ms: u64| Snapshot {
            elapsed_ms,
            frames_advancing: false,
            native_presenting: false,
            ..snapshot()
        };
        let (assessment, ledger) = first(&stall(1600), &Ledger::default());
        assert_eq!(heal_action(&assessment), Some(HealingAction::PresentKick));
        // Too soon after the last action: pending, not another heal.
        let (assessment, ledger) = first(&stall(2200), &ledger);
        assert!(matches!(assessment, Assessment::Pending { .. }));
        let (assessment, ledger) = first(&stall(2900), &ledger);
        assert_eq!(heal_action(&assessment), Some(HealingAction::PresentKick));
        // The kick is exhausted (2 attempts): the ladder moves on.
        let (assessment, _) = first(&stall(4200), &ledger);
        assert_eq!(heal_action(&assessment), Some(HealingAction::ResyncScene));
    }

    #[test]
    fn fallback_carries_the_truthful_reason_after_the_budget() {
        let (assessment, _) = first(
            &Snapshot {
                elapsed_ms: 15_001,
                metal_target_present: false,
                native_presenting: false,
                ..snapshot()
            },
            &Ledger::default(),
        );
        match assessment {
            Assessment::Fallback { reason } => assert!(reason.contains("frame target")),
            other => panic!("expected fallback, got {other:?}"),
        }
    }

    #[test]
    fn the_default_budgets_are_ordered_cheapest_first() {
        let budgets = Budgets::FIRST_FRAME;
        assert!(budgets.present_kick_after_ms < budgets.resync_scene_after_ms);
        assert!(budgets.resync_scene_after_ms < budgets.reset_native_path_after_ms);
        assert!(budgets.reset_native_path_after_ms < budgets.declare_fallback_after_ms);
    }

    const TICK_MS: u64 = 750;

    fn broken() -> Snapshot {
        Snapshot {
            surface_live: false,
            native_presenting: false,
            ..snapshot()
        }
    }

    fn kind(presenting: &Presenting) -> &'static str {
        match presenting {
            Presenting::Presenting => "presenting",
            Presenting::Observing { .. } => "observing",
            Presenting::Heal { .. } => "heal",
            Presenting::Stalled { .. } => "stalled",
        }
    }

    fn run(
        snapshots: &[Snapshot],
        mut watch: PresentingWatch,
    ) -> (Vec<&'static str>, PresentingWatch, Presenting) {
        let mut kinds = Vec::new();
        let mut last = Presenting::Presenting;
        for snapshot in snapshots {
            let (assessment, next) =
                assess_presenting(snapshot, &watch, TICK_MS, &PresentingWatchBudgets::DEFAULT);
            watch = next;
            kinds.push(kind(&assessment));
            last = assessment;
        }
        (kinds, watch, last)
    }

    #[test]
    fn presenting_stays_quiet_while_the_chain_is_healthy() {
        let (kinds, _, _) = run(
            &[snapshot(), snapshot(), snapshot()],
            PresentingWatch::default(),
        );
        assert_eq!(kinds, ["presenting", "presenting", "presenting"]);
    }

    #[test]
    fn a_transient_stall_is_observed_without_healing_before_the_threshold() {
        let (kinds, _, _) = run(&[broken(), broken()], PresentingWatch::default());
        assert_eq!(kinds, ["observing", "observing"]);
    }

    #[test]
    fn a_frozen_presentation_under_advancing_frames_is_a_stall() {
        let frozen = Snapshot {
            presentation_advancing: false,
            ..snapshot()
        };
        let (kinds, _, last) = run(
            &[frozen.clone(), frozen.clone(), frozen],
            PresentingWatch::default(),
        );
        assert_eq!(kinds, ["observing", "observing", "heal"]);
        assert_eq!(
            last,
            Presenting::Heal {
                action: HealingAction::PresentKick,
                reason: "Native presentation is not advancing.".to_string(),
            }
        );
    }

    #[test]
    fn a_healthy_tick_resets_the_stall_counter() {
        let (kinds, _, _) = run(
            &[broken(), broken(), snapshot(), broken(), broken()],
            PresentingWatch::default(),
        );
        assert_eq!(
            kinds,
            [
                "observing",
                "observing",
                "presenting",
                "observing",
                "observing"
            ]
        );
    }

    #[test]
    fn a_lone_broken_tick_never_surfaces_a_reason() {
        let (kinds, _, last) = run(
            &[snapshot(), broken(), snapshot(), snapshot()],
            PresentingWatch::default(),
        );
        assert_eq!(
            kinds,
            ["presenting", "observing", "presenting", "presenting"]
        );
        assert!(!kinds.iter().any(|k| *k == "heal" || *k == "stalled"));
        assert_eq!(last, Presenting::Presenting);
    }

    #[test]
    fn the_ladder_arms_after_the_threshold_with_the_cheapest_action_at_once() {
        let (_, _, last) = run(&[broken(), broken(), broken()], PresentingWatch::default());
        match last {
            Presenting::Heal { action, reason } => {
                assert_eq!(action, HealingAction::PresentKick);
                assert!(reason.contains("surface is starting"));
            }
            other => panic!("expected heal, got {other:?}"),
        }
    }

    #[test]
    fn the_ladder_exhausts_to_a_stall_and_rearms_after_a_recovery() {
        let budgets = PresentingWatchBudgets::DEFAULT;
        let ticks = budgets.healing.declare_fallback_after_ms.div_ceil(TICK_MS) as usize;
        let (kinds, watch, _) = run(&vec![broken(); ticks + 4], PresentingWatch::default());
        assert!(kinds.contains(&"heal"));
        assert_eq!(kinds.last(), Some(&"stalled"));
        // Still stalled on further broken ticks: no healing spam.
        let (kinds, watch, _) = run(&[broken()], watch);
        assert_eq!(kinds, ["stalled"]);
        // A recovery resets everything…
        let (kinds, watch, _) = run(&[snapshot()], watch);
        assert_eq!(kinds, ["presenting"]);
        // …so the next stall re-arms a fresh ladder.
        let (_, _, last) = run(&[broken(), broken(), broken()], watch);
        assert_eq!(
            match last {
                Presenting::Heal { action, .. } => Some(action),
                _ => None,
            },
            Some(HealingAction::PresentKick)
        );
    }

    #[test]
    fn a_soft_stall_never_fires_the_path_reset() {
        let soft = Snapshot {
            frames_advancing: false,
            ..snapshot()
        };
        let budgets = PresentingWatchBudgets::DEFAULT;
        let ticks = (budgets.healing.declare_fallback_after_ms + 5000).div_ceil(TICK_MS) as usize;
        let mut watch = PresentingWatch::default();
        let mut heals = 0;
        for _ in 0..ticks {
            let (assessment, next) = assess_presenting(&soft, &watch, TICK_MS, &budgets);
            watch = next;
            if let Presenting::Heal { action, .. } = assessment {
                heals += 1;
                assert_ne!(action, HealingAction::ResetNativePath);
            }
        }
        assert!(heals > 0);
    }
}
