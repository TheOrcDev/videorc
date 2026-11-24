//! Test your Buddy (plan 220 S3.10d, `lib/buddy-test-view.ts`): which frame
//! each state holds, the reactions it can play, and where the sample bubble
//! sits. The dialog is a sandbox: nothing here reaches the stream, chat or
//! the settings; the backend only draws its sample bubble.

use super::pet_player::{Frame, HOP_REACTION_ID, TALK_IDS, nearest_gaze};

/// One state of the States row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestState {
    Idle,
    Talk,
    Laugh,
    Think,
}

/// The States row, in order: the state, its label and the key that picks it.
pub const STATES: [(TestState, &str, &str); 4] = [
    (TestState::Idle, "Idle", "1"),
    (TestState::Talk, "Talking", "2"),
    (TestState::Laugh, "Laughing", "3"),
    (TestState::Think, "Thinking", "4"),
];

/// `buddyTestStateForKey`.
pub fn state_for_key(key: &str) -> Option<TestState> {
    STATES
        .iter()
        .find(|(_, _, state_key)| *state_key == key)
        .map(|(state, _, _)| *state)
}

/// The state at the States row's `index`.
pub fn state_at(index: usize) -> TestState {
    STATES
        .get(index)
        .map_or(TestState::Idle, |(state, _, _)| *state)
}

/// The States row's index of `state`.
pub fn state_index(state: TestState) -> usize {
    STATES
        .iter()
        .position(|(each, _, _)| *each == state)
        .unwrap_or(0)
}

/// Where a thinking Buddy looks without a think drawing: up-left.
pub const THINK_GAZE: [f64; 2] = [-0.5, -1.0];

/// What the loaded pack offers, as the preview reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct TestPack {
    pub neutral: String,
    pub reactions: Vec<String>,
    pub gazes: Vec<(String, [f64; 2])>,
}

/// One state as the stream shows it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatePlan {
    /// The frame the preview holds; None lets it live.
    pub pose: Option<String>,
    /// Run the on-stream talk cycle (talk frames, else a bob).
    pub talking: bool,
    /// A reaction played once over the hold when the state is picked.
    pub react: Option<String>,
    /// What this pack lacks for the state, in one line.
    pub note: Option<&'static str>,
}

pub const NO_TALK_NOTE: &str =
    "These moves have no talking drawings, so the avatar bobs while it talks.";
pub const NO_LAUGH_NOTE: &str = "These moves have no laugh drawing, so the avatar hops instead.";
pub const NO_THINK_NOTE: &str = "These moves have no thinking drawing.";

/// `buddyTestStatePlan`: Idle lives; Talking cycles the pack's talk frames,
/// else holds its `talk` picture and bobs; Laughing holds `laugh` after its
/// laugh; Thinking holds `think`, else looks up-left.
pub fn state_plan(state: TestState, pack: Option<&TestPack>) -> StatePlan {
    let Some(pack) = pack else {
        return StatePlan::default();
    };
    let has = |id: &str| pack.reactions.iter().any(|each| each == id);
    match state {
        TestState::Idle => StatePlan::default(),
        TestState::Talk => {
            if TALK_IDS.iter().any(|id| has(id)) {
                StatePlan {
                    talking: true,
                    ..StatePlan::default()
                }
            } else if has("talk") {
                StatePlan {
                    pose: Some("talk".into()),
                    talking: true,
                    ..StatePlan::default()
                }
            } else {
                StatePlan {
                    talking: true,
                    note: Some(NO_TALK_NOTE),
                    ..StatePlan::default()
                }
            }
        }
        TestState::Laugh => {
            if has("laugh") {
                StatePlan {
                    pose: Some("laugh".into()),
                    react: Some("laugh".into()),
                    ..StatePlan::default()
                }
            } else {
                StatePlan {
                    react: Some("laugh".into()),
                    note: Some(NO_LAUGH_NOTE),
                    ..StatePlan::default()
                }
            }
        }
        TestState::Think => {
            if has("think") {
                return StatePlan {
                    pose: Some("think".into()),
                    ..StatePlan::default()
                };
            }
            let frames: Vec<Frame> = pack
                .gazes
                .iter()
                .map(|(id, gaze)| Frame {
                    id: id.clone(),
                    reaction: false,
                    gaze: Some(*gaze),
                })
                .collect();
            match nearest_gaze(&frames, THINK_GAZE[0], THINK_GAZE[1]) {
                Some(index) if frames[index].id != pack.neutral => StatePlan {
                    pose: Some(frames[index].id.clone()),
                    ..StatePlan::default()
                },
                _ => StatePlan {
                    note: Some(NO_THINK_NOTE),
                    ..StatePlan::default()
                },
            }
        }
    }
}

/// `buddyTestReactions`: every reaction the pack has, then the hop.
pub fn reactions(reactions: &[String]) -> Vec<String> {
    let mut out = reactions.to_vec();
    if !out.iter().any(|id| id == HOP_REACTION_ID) {
        out.push(HOP_REACTION_ID.into());
    }
    out
}

/// The dialog's title ("Test Grum").
pub fn title(name: &str) -> String {
    format!("Test {name}")
}

/// The Reactions row while the pack loads.
pub fn loading_line(name: &str) -> String {
    format!("Loading {name}…")
}

/// The sample line the bubble shows while Talking.
pub const BUBBLE_LINE: &str = "Welcome to the horde! Grab a seat.";
/// A 1080p stream at twice its size: the bitmap stays crisp at about 1:1.
pub const BUBBLE_CANVAS: (u32, u32) = (3840, 2160);
/// The Buddy on the stage.
pub const PREVIEW_PX: f64 = 320.0;

/// Where the sample bubble goes, in pixels from the preview box's top-left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BubbleBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// `buddyTestBubbleBox`: the bubble keeps its stream proportions to the
/// Buddy and its bottom-centre, the tail's tip, sits on the top of the
/// neutral silhouette (`head_top`, 0 to 1 of the box), centred on the box.
pub fn bubble_box(raster: (u32, u32), rect_w: f64, preview_px: f64, head_top: f64) -> BubbleBox {
    let cell_px = (rect_w * f64::from(BUBBLE_CANVAS.0)).round().max(1.0);
    let scale = preview_px / cell_px;
    let width = f64::from(raster.0) * scale;
    let height = f64::from(raster.1) * scale;
    let head_top = head_top.clamp(0.0, 1.0);
    BubbleBox {
        left: preview_px / 2.0 - width / 2.0,
        top: head_top * preview_px - height,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(reactions: &[&str], gazes: &[(&str, [f64; 2])]) -> TestPack {
        TestPack {
            neutral: "c".into(),
            reactions: reactions.iter().map(|id| (*id).to_string()).collect(),
            gazes: gazes
                .iter()
                .map(|(id, gaze)| ((*id).to_string(), *gaze))
                .collect(),
        }
    }

    #[test]
    fn the_keys_pick_the_states_in_order() {
        assert_eq!(state_for_key("1"), Some(TestState::Idle));
        assert_eq!(state_for_key("4"), Some(TestState::Think));
        assert_eq!(state_for_key("5"), None);
        assert_eq!(state_index(TestState::Laugh), 2);
        assert_eq!(state_at(1), TestState::Talk);
    }

    #[test]
    fn each_state_falls_back_the_way_the_stream_does() {
        let full = pack(
            &["talk-a", "talk-b", "laugh", "think"],
            &[("c", [0.0, 0.0])],
        );
        assert_eq!(
            state_plan(TestState::Idle, Some(&full)),
            StatePlan::default()
        );
        assert!(state_plan(TestState::Talk, Some(&full)).talking);
        assert_eq!(state_plan(TestState::Talk, Some(&full)).pose, None);
        let laugh = state_plan(TestState::Laugh, Some(&full));
        assert_eq!(laugh.pose.as_deref(), Some("laugh"));
        assert_eq!(laugh.react.as_deref(), Some("laugh"));
        assert_eq!(
            state_plan(TestState::Think, Some(&full)).pose.as_deref(),
            Some("think")
        );

        let still = pack(&["talk"], &[("c", [0.0, 0.0])]);
        assert_eq!(
            state_plan(TestState::Talk, Some(&still)).pose.as_deref(),
            Some("talk")
        );

        let bare = pack(&[], &[("c", [0.0, 0.0]), ("ul", [-0.6, -0.9])]);
        assert_eq!(
            state_plan(TestState::Talk, Some(&bare)).note,
            Some(NO_TALK_NOTE)
        );
        let laugh = state_plan(TestState::Laugh, Some(&bare));
        assert_eq!(laugh.note, Some(NO_LAUGH_NOTE));
        assert_eq!(laugh.react.as_deref(), Some("laugh"));
        assert_eq!(
            state_plan(TestState::Think, Some(&bare)).pose.as_deref(),
            Some("ul")
        );

        let one = pack(&[], &[("c", [0.0, 0.0])]);
        assert_eq!(
            state_plan(TestState::Think, Some(&one)).note,
            Some(NO_THINK_NOTE)
        );
        assert_eq!(state_plan(TestState::Laugh, None), StatePlan::default());
    }

    #[test]
    fn the_reactions_end_with_the_hop_once() {
        assert_eq!(reactions(&["wave".into()]), ["wave", "hop"]);
        assert_eq!(reactions(&["hop".into()]), ["hop"]);
    }

    #[test]
    fn the_bubble_sits_on_the_head() {
        // The default rect's width at 3840 px is the Buddy's cell.
        let boxed = bubble_box((640, 320), 0.1, 320.0, 0.25);
        let scale = 320.0 / 384.0;
        assert!((boxed.width - 640.0 * scale).abs() < 1e-9);
        assert!((boxed.top - (80.0 - 320.0 * scale)).abs() < 1e-9);
        assert!((boxed.left - (160.0 - boxed.width / 2.0)).abs() < 1e-9);
        assert_eq!(
            bubble_box((10, 10), 0.1, 320.0, 3.0).top,
            320.0 - 10.0 * scale
        );
    }
}
