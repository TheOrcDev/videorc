//! The animator on a fake clock with a seeded random source (plan 168 S-C2):
//! every row of D11 to D15, D14's fallbacks and the queue limits, a scripted
//! session pinned cell by cell, and the S-C4 rule that a second draw at the
//! same time draws the same thing. Atlases are synthetic: 4 px cells whose
//! pixels never matter here, only their ids, kinds and gaze points.

use std::sync::Arc;

use super::*;
use crate::golem_sprite::{GOLEM_SPRITE_DEFAULT_PIVOT, GolemSpritePackMeta};
use crate::overlay_layout::OverlayRect;

const SEED: u64 = 0x5EED_168C;
/// page-pet's 5 x 5 gaze grid.
const GAZE_STEPS: [f64; 5] = [-1.0, -0.5, 0.0, 0.5, 1.0];
/// page-pet's 12 reactions plus the creator's extras (D18).
const ALL_REACTIONS: [&str; 15] = [
    "laugh",
    "surprised",
    "wink",
    "kiss",
    "blink",
    "sleep",
    "worried",
    "annoyed",
    "proud",
    "confused",
    "excited",
    "calm",
    "talk-a",
    "talk-b",
    "wave",
];
const NEUTRAL: &str = "look-22";
const PRIMARY_CANVAS: (u32, u32) = (1920, 1080);
const AUX_CANVAS: (u32, u32) = (1080, 1920);
/// The pet in the bottom-right corner of the landscape canvas ...
const PRIMARY_BOX: [f32; 4] = [1600.0, 820.0, 240.0, 240.0];
/// ... and the bottom-left corner of the portrait one.
const AUX_BOX: [f32; 4] = [60.0, 1620.0, 240.0, 240.0];
/// A card on the left of the landscape canvas ...
const LEFT_CARD: [f32; 4] = [80.0, 760.0, 560.0, 200.0];
/// ... and top-right of the portrait canvas.
const AUX_CARD: [f32; 4] = [560.0, 1100.0, 440.0, 200.0];

/// `look-{col}{row}`: the gaze cell at `[GAZE_STEPS[col], GAZE_STEPS[row]]`.
fn look(x: f64, y: f64) -> String {
    let index = |value: f64| GAZE_STEPS.iter().position(|step| *step == value).unwrap();
    format!("look-{}{}", index(x), index(y))
}

/// A pack: the 25 gaze cells (or only `[0, 0]` when `grid` is false) and the
/// named reactions; `talk` lists the talk frames the sidecar names.
fn atlas_with(grid: bool, reactions: &[&str], talk: &[&str]) -> GolemSpriteAtlas {
    let mut frames = Vec::new();
    for y in GAZE_STEPS {
        for x in GAZE_STEPS {
            if grid || (x == 0.0 && y == 0.0) {
                frames.push((look(x, y), PetFrameKind::Gaze, Some([x, y])));
            }
        }
    }
    for id in reactions {
        frames.push((id.to_string(), PetFrameKind::Reaction, None));
    }
    let cells = (0..frames.len())
        .map(|_| image::RgbaImage::from_pixel(4, 4, image::Rgba([200, 100, 50, 255])))
        .collect::<Vec<_>>();
    let meta = Arc::new(GolemSpritePackMeta {
        pack_id: "fixture".to_string(),
        neutral: NEUTRAL.to_string(),
        pivot: GOLEM_SPRITE_DEFAULT_PIVOT,
        head_top: 0.2,
        talk: talk.iter().map(|id| id.to_string()).collect(),
        source_cell_px: 4,
        unique_cells: frames.len(),
    });
    let frames = frames
        .into_iter()
        .enumerate()
        .map(|(index, (id, kind, gaze))| (id, kind, gaze, index))
        .collect();
    GolemSpriteAtlas::from_cells(&cells, 4, frames, meta)
}

/// A creator-made pack: every gaze cell, page-pet's reactions, talk frames, wave.
pub(crate) fn alive() -> GolemSpriteAtlas {
    atlas_with(true, &ALL_REACTIONS, &["talk-a", "talk-b"])
}

/// The still pack (S-A4): one gaze cell and the three state images.
fn still() -> GolemSpriteAtlas {
    let mut atlas = atlas_with(false, &["talk", "laugh", "think"], &[]);
    for cell in &mut atlas.cells {
        if cell.id == NEUTRAL {
            cell.id = "idle".to_string();
        }
    }
    let mut meta = (*atlas.meta).clone();
    meta.neutral = "idle".to_string();
    meta.pack_id = "still".to_string();
    atlas.meta = Arc::new(meta);
    atlas
}

fn settings(intensity: f64, sleep_after_seconds: u32, breathing: bool) -> GolemAnimatorSettings {
    GolemAnimatorSettings {
        motion: GolemMotionSettings {
            intensity,
            sleep_after_seconds,
            breathing,
        },
        reactions: BTreeMap::new(),
    }
}

/// The owner defaults: Motion 0.45, sleep after 180 s, breathing on.
fn defaults() -> GolemAnimatorSettings {
    GolemAnimatorSettings::default()
}

/// One leg's context.
fn context<'a>(
    leg: GolemSpriteLeg,
    now: f64,
    atlas: &'a GolemSpriteAtlas,
    avatar_state: CohostAvatarState,
    card: Option<[f32; 4]>,
) -> GolemSpriteLegContext<'a> {
    let (canvas, golem_box) = match leg {
        GolemSpriteLeg::Primary => (PRIMARY_CANVAS, PRIMARY_BOX),
        GolemSpriteLeg::Auxiliary => (AUX_CANVAS, AUX_BOX),
    };
    GolemSpriteLegContext {
        leg,
        now_seconds: now,
        canvas,
        golem_rect: OverlayRect::new(0.8, 0.7, 0.15, 0.25),
        golem_box,
        highlight_rect: card,
        caption_rect: None,
        avatar_state,
        atlas,
    }
}

/// A session on a fake clock: the animator, the atlas, plan 164's state and
/// the cards per leg, stepped frame by frame.
struct Session<'a> {
    animator: GolemAnimator,
    atlas: &'a GolemSpriteAtlas,
    avatar: CohostAvatarState,
    cards: [Option<[f32; 4]>; 2],
    aux: bool,
}

impl<'a> Session<'a> {
    fn new(atlas: &'a GolemSpriteAtlas, settings: GolemAnimatorSettings) -> Self {
        Self {
            animator: GolemAnimator::new(settings, SEED),
            atlas,
            avatar: CohostAvatarState::Idle,
            cards: [None, None],
            aux: false,
        }
    }

    fn with_aux(mut self) -> Self {
        self.aux = true;
        self
    }

    fn handle(&mut self, event: GolemAnimatorEvent, at: f64) {
        self.animator.handle(event, at);
    }

    /// Both legs (primary first, as the compositor draws them) at `now`.
    fn frame(&mut self, now: f64) -> [Option<GolemSpriteDraw>; 2] {
        let primary = self.animator.draw(&context(
            GolemSpriteLeg::Primary,
            now,
            self.atlas,
            self.avatar,
            self.cards[0],
        ));
        let aux = self
            .aux
            .then(|| {
                self.animator.draw(&context(
                    GolemSpriteLeg::Auxiliary,
                    now,
                    self.atlas,
                    self.avatar,
                    self.cards[1],
                ))
            })
            .flatten();
        [primary, aux]
    }

    /// The primary leg's cell id at `now`.
    fn cell(&mut self, now: f64) -> String {
        let draw = self.frame(now)[0].expect("primary draws");
        cell_id(self.atlas, &draw)
    }

    /// Step `from..until` at `fps`, returning the primary cell per frame.
    fn run(&mut self, from: f64, until: f64, fps: f64) -> Vec<(f64, String)> {
        let mut out = Vec::new();
        let mut frame = (from * fps).round() as i64;
        loop {
            let now = frame as f64 / fps;
            if now >= until {
                break;
            }
            out.push((now, self.cell(now)));
            frame += 1;
        }
        out
    }
}

fn cell_id(atlas: &GolemSpriteAtlas, draw: &GolemSpriteDraw) -> String {
    atlas
        .cells
        .iter()
        .find(|cell| cell.rect == draw.cell)
        .map(|cell| cell.id.clone())
        .expect("the draw names an atlas cell")
}

/// Runs of equal cells: `(start, end, id)`.
fn runs(frames: &[(f64, String)]) -> Vec<(f64, f64, String)> {
    let mut out: Vec<(f64, f64, String)> = Vec::new();
    for (now, id) in frames {
        match out.last_mut() {
            Some(run) if run.2 == *id => run.1 = *now,
            _ => out.push((*now, *now, id.clone())),
        }
    }
    out
}

fn gaze_of(atlas: &GolemSpriteAtlas, id: &str) -> Option<[f64; 2]> {
    atlas.cell(id).and_then(|cell| cell.gaze)
}

fn is_identity(draw: &GolemSpriteDraw) -> bool {
    draw.affine == GolemSpriteDraw::IDENTITY_AFFINE && draw.translate == [0.0, 0.0]
}

fn talk(chars: usize, bubble_seconds: f64) -> GolemAnimatorEvent {
    GolemAnimatorEvent::UtteranceStart {
        state: CohostUtteranceState::Talk,
        chars,
        bubble_seconds,
    }
}

fn follow() -> GolemAnimatorEvent {
    GolemAnimatorEvent::Trigger {
        trigger: GolemTrigger::Follow,
        reaction: None,
    }
}

// --- The scripted session (S-C2 done-when) ----------------------------------------------

/// The primary leg of the scripted session, as `(first frame at 30 fps, cell)`
/// runs: the follow's wave, the card on the left (a left gaze cell), the talk
/// cycle, the mid-TTL glance after the bubble, then page-pet's life (blinks,
/// idle glances) until it falls asleep 180 s after the utterance.
const SCRIPTED_PRIMARY: &[(i64, &str)] = &[
    (0, "look-22"),
    (30, "wave"),
    (63, "look-22"),
    (90, "look-02"),
    (135, "look-22"),
    (180, "talk-a"),
    (184, "talk-b"),
    (188, "look-22"),
    (192, "talk-a"),
    (196, "talk-b"),
    (200, "look-22"),
    (204, "talk-a"),
    (207, "talk-b"),
    (211, "look-22"),
    (215, "talk-a"),
    (219, "talk-b"),
    (224, "look-22"),
    (227, "talk-a"),
    (231, "talk-b"),
    (234, "look-22"),
    (255, "look-02"),
    (276, "look-22"),
    (373, "blink"),
    (378, "look-22"),
    (414, "look-13"),
    (441, "look-22"),
    (511, "blink"),
    (516, "look-22"),
    (637, "blink"),
    (642, "look-22"),
    (643, "look-32"),
    (682, "look-22"),
    (749, "blink"),
    (754, "look-22"),
    (860, "look-23"),
    (899, "look-22"),
    (1042, "blink"),
    (1047, "look-22"),
    (1221, "blink"),
    (1226, "look-22"),
    (1265, "look-23"),
    (1293, "look-22"),
    (1362, "blink"),
    (1367, "look-22"),
    (1510, "blink"),
    (1515, "look-22"),
    (1588, "look-11"),
    (1622, "look-22"),
    (1771, "blink"),
    (1776, "look-22"),
    (1915, "blink"),
    (1920, "look-22"),
    (1938, "look-33"),
    (1964, "look-22"),
    (2049, "blink"),
    (2054, "look-22"),
    (2180, "blink"),
    (2185, "look-22"),
    (2260, "look-12"),
    (2294, "look-22"),
    (2310, "blink"),
    (2315, "look-22"),
    (2475, "blink"),
    (2480, "look-22"),
    (2548, "look-32"),
    (2595, "look-22"),
    (2614, "blink"),
    (2619, "look-22"),
    (2785, "blink"),
    (2790, "look-13"),
    (2835, "look-22"),
    (2960, "blink"),
    (2965, "look-22"),
    (3078, "blink"),
    (3083, "look-22"),
    (3115, "look-32"),
    (3155, "look-22"),
    (3212, "blink"),
    (3217, "look-22"),
    (3357, "blink"),
    (3362, "look-22"),
    (3415, "look-11"),
    (3440, "look-22"),
    (3463, "blink"),
    (3468, "look-22"),
    (3614, "blink"),
    (3619, "look-22"),
    (3675, "look-12"),
    (3716, "look-22"),
    (3737, "blink"),
    (3742, "look-22"),
    (3882, "blink"),
    (3887, "look-22"),
    (3987, "look-33"),
    (4025, "look-22"),
    (4055, "blink"),
    (4060, "look-22"),
    (4165, "blink"),
    (4170, "look-22"),
    (4271, "blink"),
    (4276, "look-22"),
    (4280, "look-31"),
    (4321, "look-22"),
    (4441, "blink"),
    (4446, "look-22"),
    (4499, "look-23"),
    (4529, "look-22"),
    (4594, "blink"),
    (4599, "look-22"),
    (4721, "blink"),
    (4726, "look-22"),
    (4874, "blink"),
    (4879, "look-22"),
    (4915, "look-13"),
    (4953, "look-22"),
    (4991, "blink"),
    (4996, "look-22"),
    (5128, "blink"),
    (5133, "look-22"),
    (5180, "look-31"),
    (5227, "look-22"),
    (5257, "blink"),
    (5262, "look-22"),
    (5427, "blink"),
    (5432, "look-22"),
    (5469, "look-21"),
    (5499, "look-22"),
    (5580, "sleep"),
];

#[test]
fn scripted_session_plays_an_exact_cell_sequence() {
    let atlas = alive();
    let mut session = Session::new(&atlas, defaults()).with_aux();
    let fps = 30.0;
    let mut primary: Vec<(f64, String)> = Vec::new();
    let mut aux: Vec<(f64, String)> = Vec::new();
    let mut snapshots = Vec::new();
    // Follow at 1 s, the card on the left at 3 s (top-right on the portrait
    // leg) for 10 s, a 30 character utterance at 6 s (a 2.5 s bubble), then
    // silence to 210 s.
    for frame in 0..(210 * 30) {
        let now = f64::from(frame) / fps;
        match frame {
            30 => session.handle(follow(), now),
            90 => {
                session.handle(GolemAnimatorEvent::HighlightLive { ttl_seconds: 10.0 }, now);
                session.cards = [Some(LEFT_CARD), Some(AUX_CARD)];
            }
            180 => {
                session.handle(talk(30, 2.5), now);
                session.avatar = CohostAvatarState::Talk;
            }
            255 => {
                session.handle(GolemAnimatorEvent::UtteranceEnd, now);
                session.avatar = CohostAvatarState::Idle;
            }
            390 => {
                session.handle(GolemAnimatorEvent::HighlightIdle, now);
                session.cards = [None, None];
            }
            _ => {}
        }
        let [p, a] = session.frame(now);
        let (p, a) = (p.unwrap(), a.unwrap());
        primary.push((now, cell_id(&atlas, &p)));
        aux.push((now, cell_id(&atlas, &a)));
        if [36, 100, 190, 600, 6200].contains(&frame) {
            snapshots.push((frame, p.affine, p.translate));
        }
    }
    let compact = |frames: &[(f64, String)]| {
        runs(frames)
            .into_iter()
            .map(|(start, _, id)| ((start * fps).round() as i64, id))
            .collect::<Vec<_>>()
    };
    let expected = SCRIPTED_PRIMARY
        .iter()
        .map(|(frame, id)| (*frame, id.to_string()))
        .collect::<Vec<_>>();
    assert_eq!(compact(&primary), expected);
    // The portrait leg lives the same life, but looks at its own card: up
    // and to the right, where the primary looked left.
    let card_frames = |frame: i64| (90..135).contains(&frame) || (255..276).contains(&frame);
    for (index, ((_, p), (_, a))) in primary.iter().zip(&aux).enumerate() {
        if card_frames(index as i64) {
            assert_eq!(p, "look-02", "frame {index}");
            assert_eq!(a, "look-40", "frame {index}");
        } else {
            assert_eq!(p, a, "frame {index}");
        }
    }
    assert!(gaze_of(&atlas, "look-02").unwrap()[0] < 0.0);
    assert!(gaze_of(&atlas, "look-40").unwrap()[0] > 0.0);

    // Transform snapshots: the wave mid-pose (turned and lifted), breathing
    // while the card is looked at, the breath fading under the talk cycle,
    // breathing at rest, and nothing at all asleep.
    let round = |values: &[f32]| {
        values
            .iter()
            .map(|value| (f64::from(*value) * 1e4).round() / 1e4)
            .collect::<Vec<_>>()
    };
    let got = snapshots
        .iter()
        .map(|(frame, affine, translate)| (*frame, round(affine), round(translate)))
        .collect::<Vec<_>>();
    let want: Vec<(i32, Vec<f64>, Vec<f64>)> = vec![
        (36, vec![0.9976, 0.0269, -0.027, 1.0017], vec![0.0, -2.3277]),
        (100, vec![0.9948, 0.0, 0.0, 1.0053], vec![0.0, 0.0]),
        (190, vec![1.0012, 0.0, 0.0, 0.9988], vec![0.0, 0.0]),
        (600, vec![1.0032, 0.0, 0.0, 0.9968], vec![0.0, 0.0]),
        (6200, vec![1.0, 0.0, 0.0, 1.0], vec![0.0, 0.0]),
    ];
    assert_eq!(got, want);
}

// --- D11: gaze ----------------------------------------------------------------------------

#[test]
fn the_pet_looks_at_the_viewer_by_default() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, true));
    // Before the first idle glance (7 s at the earliest) and the first blink.
    for (_, id) in session.run(0.0, 3.4, 30.0) {
        assert_eq!(id, NEUTRAL);
    }
}

#[test]
fn idle_glances_come_every_7_to_14_s_for_0_8_to_1_6_s_within_half_a_cell() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, true));
    let fps = 100.0;
    let frames = session.run(0.0, 600.0, fps);
    let glances = runs(&frames)
        .into_iter()
        .filter(|(_, _, id)| gaze_of(&atlas, id).is_some_and(|gaze| gaze != VIEWER_GAZE))
        .collect::<Vec<_>>();
    assert!(glances.len() >= 600 / 14, "{} glances", glances.len());
    let tick = 1.0 / fps;
    for (start, end, id) in &glances {
        let [x, y] = gaze_of(&atlas, id).unwrap();
        assert!(x.abs() <= 0.5 && y.abs() <= 0.5, "{id}");
        let length = end - start + tick;
        assert!(
            (0.8 - tick..=1.6 + 2.0 * tick).contains(&length),
            "{id} for {length}"
        );
    }
    for pair in glances.windows(2) {
        let gap = pair[1].0 - pair[0].0;
        // A blink in flight can hold a glance back for at most its 160 ms.
        assert!(
            (7.0 - tick..=14.0 + BLINK_SECONDS + 2.0 * tick).contains(&gap),
            "glances {gap} s apart"
        );
    }
}

#[test]
fn no_idle_glance_while_a_bubble_is_up() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, true));
    // A bubble with no text to talk through: the pet just faces the viewer.
    session.handle(talk(0, 60.0), 0.0);
    session.avatar = CohostAvatarState::Talk;
    for (now, id) in session.run(0.0, 60.0, 30.0) {
        assert!(id == NEUTRAL || id == "blink", "{id} at {now}");
    }
}

#[test]
fn the_card_is_looked_at_for_1_5_s_then_the_viewer_then_once_more_at_mid_ttl() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, false)).with_aux();
    session.run(0.0, 1.0, 100.0);
    session.handle(GolemAnimatorEvent::HighlightLive { ttl_seconds: 10.0 }, 1.0);
    session.cards = [Some(LEFT_CARD), Some(AUX_CARD)];
    let frames = session.run(1.0, 11.0, 100.0);
    let at = |time: f64| {
        frames
            .iter()
            .find(|(now, _)| (*now - time).abs() < 1e-6)
            .map(|(_, id)| id.clone())
            .unwrap()
    };
    assert_eq!(at(1.0), "look-02");
    assert_eq!(at(2.49), "look-02");
    assert_eq!(at(2.5), NEUTRAL);
    assert_eq!(at(5.99), NEUTRAL);
    // Mid-TTL: 5 s after the card went up, for 1.2 s.
    assert_eq!(at(6.0), "look-02");
    assert_eq!(at(7.19), "look-02");
    assert_ne!(at(7.2), "look-02");
}

#[test]
fn each_leg_looks_at_its_own_card() {
    let atlas = alive();
    let mut session = Session::new(&atlas, defaults()).with_aux();
    session.frame(0.0);
    session.handle(GolemAnimatorEvent::HighlightLive { ttl_seconds: 10.0 }, 0.5);
    session.cards = [Some(LEFT_CARD), Some(AUX_CARD)];
    let [primary, aux] = session.frame(0.5);
    let primary = gaze_of(&atlas, &cell_id(&atlas, &primary.unwrap())).unwrap();
    let aux = gaze_of(&atlas, &cell_id(&atlas, &aux.unwrap())).unwrap();
    assert!(
        primary[0] < 0.0,
        "the card is left of the landscape pet: {primary:?}"
    );
    assert!(
        aux[0] > 0.0 && aux[1] < 0.0,
        "up-right of the portrait pet: {aux:?}"
    );

    // The card above the pet on the primary leg only: that leg looks up, the
    // other (no card there) keeps facing the viewer.
    let mut session = Session::new(&atlas, defaults()).with_aux();
    session.frame(0.0);
    session.cards = [Some([1500.0, 200.0, 440.0, 200.0]), None];
    let [primary, aux] = session.frame(0.1);
    let primary = gaze_of(&atlas, &cell_id(&atlas, &primary.unwrap())).unwrap();
    assert!(primary[1] < 0.0, "{primary:?}");
    assert_eq!(cell_id(&atlas, &aux.unwrap()), NEUTRAL);
}

#[test]
fn the_card_gaze_is_page_pets_tracking_vector_from_the_head() {
    // Head anchor: box centre x, box top + 0.2 * 240 = 48 px down.
    let golem_box = [1000.0, 500.0, 240.0, 240.0];
    let head = [1120.0_f32, 548.0];
    let radius = 1.3 * 240.0;
    let card_at = |dx: f32, dy: f32| [head[0] + dx - 50.0, head[1] + dy - 20.0, 100.0, 40.0];
    let gaze = card_gaze(golem_box, 0.2, card_at(-156.0, 0.0));
    assert!(
        (gaze[0] - (-156.0 / radius)).abs() < 1e-9 && gaze[1] == 0.0,
        "{gaze:?}"
    );
    assert_eq!(
        card_gaze(golem_box, 0.2, card_at(-2000.0, 2000.0)),
        [-1.0, 1.0]
    );
    // A small pet uses the 120 px floor.
    let small = card_gaze([0.0, 0.0, 40.0, 40.0], 0.0, [80.0, -20.0, 40.0, 40.0]);
    assert_eq!(small, [(100.0 - 20.0) / 120.0, 0.0]);
}

#[test]
fn a_bubble_faces_the_viewer_and_a_pending_answer_looks_up_left() {
    let atlas = alive();
    let mut session = Session::new(&atlas, defaults());
    session.frame(0.0);
    session.handle(GolemAnimatorEvent::ThinkStart, 0.1);
    session.avatar = CohostAvatarState::Think;
    assert_eq!(session.cell(0.1), look(THINK_GAZE[0], THINK_GAZE[1]));
    // The answer arrives as a bubble: the viewer (between talk steps).
    session.handle(talk(0, 3.0), 0.5);
    session.avatar = CohostAvatarState::Talk;
    assert_eq!(session.cell(0.5), NEUTRAL);
    // A card going up while the bubble shows still gets its first look ...
    session.handle(GolemAnimatorEvent::HighlightLive { ttl_seconds: 10.0 }, 0.6);
    session.cards = [Some(LEFT_CARD), None];
    assert_eq!(session.cell(0.6), "look-02");
    // ... and then the bubble wins again.
    assert_eq!(session.cell(2.2), NEUTRAL);
    // Settled without a bubble: back to the viewer (after the first blink).
    session.handle(GolemAnimatorEvent::UtteranceEnd, 3.7);
    session.avatar = CohostAvatarState::Idle;
    session.cell(3.7);
    assert_eq!(session.cell(3.9), NEUTRAL);
}

#[test]
fn a_gaze_change_turns_the_body_on_the_lead_leg_only() {
    let atlas = alive();
    // Full motion, no breathing: at rest the draw is exactly the identity.
    let mut session = Session::new(&atlas, settings(1.0, 0, false)).with_aux();
    session.frame(0.0);
    assert!(is_identity(&session.frame(0.05)[0].unwrap()));
    // A card only on the auxiliary leg (drawn second): no turn.
    session.cards = [None, Some(AUX_CARD)];
    for frame in 1..30 {
        let [primary, _] = session.frame(0.05 + f64::from(frame) / 60.0);
        assert!(is_identity(&primary.unwrap()), "frame {frame}");
    }
    // The card on the primary leg: the body turns (left: counter-clockwise).
    let mut session = Session::new(&atlas, settings(1.0, 0, false)).with_aux();
    session.frame(0.0);
    session.cards = [Some(LEFT_CARD), None];
    session.frame(0.1);
    let turned = (1..10)
        .map(|frame| session.frame(0.1 + f64::from(frame) / 60.0)[0].unwrap())
        .map(|draw| draw.affine[1])
        .fold(
            0.0_f32,
            |most, sin| if sin.abs() > most.abs() { sin } else { most },
        );
    assert!(turned < -1e-3, "turned {turned}");
}

// --- D12: talk ---------------------------------------------------------------------------

#[test]
fn talk_cycles_the_talk_frames_and_neutral_every_110_to_150_ms() {
    let atlas = alive();
    let mut session = Session::new(&atlas, defaults());
    session.frame(0.0);
    // 20 characters: 1.3 s of talking inside a 2.5 s bubble.
    session.handle(talk(20, 2.5), 1.0);
    session.avatar = CohostAvatarState::Talk;
    let frames = session.run(1.0, 3.5, 1000.0);
    let talking = runs(&frames)
        .into_iter()
        .filter(|(start, _, _)| *start < 2.3)
        .collect::<Vec<_>>();
    let cycle = ["talk-a", "talk-b", NEUTRAL];
    for (index, (start, end, id)) in talking.iter().enumerate() {
        assert_eq!(id, cycle[index % 3], "step {index} at {start}");
        if index + 1 < talking.len() {
            let length = end - start + 0.001;
            assert!((0.109..=0.151).contains(&length), "step {index}: {length}");
        }
    }
    // Then the neutral cell holds to the end of the bubble.
    let (start, end, id) = runs(&frames).last().cloned().unwrap();
    assert_eq!(id, NEUTRAL);
    assert!(start <= 2.3 + 1e-9 && end > 3.49, "{start}..{end}");
    // Talking lasts min(bubble, 65 ms per character).
    let last_talk = frames
        .iter()
        .filter(|(_, id)| id.starts_with("talk"))
        .map(|(now, _)| *now)
        .fold(0.0, f64::max);
    assert!(
        last_talk < 2.3 && last_talk > 2.3 - 0.151 * 3.0,
        "{last_talk}"
    );
}

#[test]
fn talk_stops_with_the_bubble_when_the_text_is_long() {
    let atlas = alive();
    let mut session = Session::new(&atlas, defaults());
    session.frame(0.0);
    // 100 characters would talk for 6.5 s; the bubble lasts 2 s.
    session.handle(talk(100, 2.0), 0.0);
    session.avatar = CohostAvatarState::Talk;
    let frames = session.run(0.0, 4.0, 100.0);
    assert!(
        frames
            .iter()
            .filter(|(now, _)| *now >= 2.0)
            .all(|(_, id)| !id.starts_with("talk"))
    );
    assert!(frames.iter().any(|(_, id)| id == "talk-b"));
}

#[test]
fn a_pack_without_talk_frames_bobs_on_the_neutral_cell() {
    let atlas = atlas_with(true, &["laugh", "blink"], &[]);
    let mut session = Session::new(&atlas, settings(0.45, 0, false));
    session.frame(0.0);
    session.handle(talk(20, 2.5), 0.5);
    session.avatar = CohostAvatarState::Talk;
    let mut lowest = 0.0_f32;
    for frame in 0..80 {
        let now = 0.5 + f64::from(frame) / 60.0;
        let draw = session.frame(now)[0].unwrap();
        assert_eq!(cell_id(&atlas, &draw), NEUTRAL);
        lowest = lowest.min(draw.translate[1]);
    }
    // Upward impulses at the talk cadence: a small lift, about 1 px at
    // Motion 0.45 on a 240 px pet.
    assert!((-3.0..-0.5).contains(&lowest), "{lowest}");
    // Quiet again once the talking and the spring are done.
    session.run(1.85, 4.0, 60.0);
    let rest = session.frame(4.0)[0].unwrap();
    assert!(is_identity(&rest), "{rest:?}");
}

#[test]
fn the_still_pack_shows_plan_164_state_images() {
    let atlas = still();
    let mut session = Session::new(&atlas, defaults());
    assert_eq!(session.cell(0.0), "idle");
    session.handle(talk(40, 3.0), 0.5);
    session.avatar = CohostAvatarState::Talk;
    // Talking and after: the talk image for the whole bubble (and a bob).
    assert_eq!(session.cell(0.5), "talk");
    assert_eq!(session.cell(3.0), "talk");
    session.handle(GolemAnimatorEvent::UtteranceEnd, 3.5);
    session.avatar = CohostAvatarState::Idle;
    assert_eq!(session.cell(3.5), "idle");
    // A laugh: the laugh reaction, then the laugh image while the bubble lasts.
    session.handle(
        GolemAnimatorEvent::UtteranceStart {
            state: CohostUtteranceState::Laugh,
            chars: 10,
            bubble_seconds: 4.0,
        },
        4.0,
    );
    session.avatar = CohostAvatarState::Laugh;
    assert_eq!(session.cell(4.0), "laugh");
    assert_eq!(session.cell(7.5), "laugh");
    session.handle(GolemAnimatorEvent::UtteranceEnd, 8.0);
    session.avatar = CohostAvatarState::Idle;
    // A pending answer: the think image.
    session.handle(GolemAnimatorEvent::ThinkStart, 9.0);
    session.avatar = CohostAvatarState::Think;
    assert_eq!(session.cell(9.0), "think");
    session.handle(GolemAnimatorEvent::ThinkSettle, 10.0);
    session.avatar = CohostAvatarState::Idle;
    assert_eq!(session.cell(10.0), "idle");
    // plan 164's state without its event (a missed event) still shows.
    session.avatar = CohostAvatarState::Talk;
    assert_eq!(session.cell(11.0), "talk");
}

// --- D13: blink and sleep -------------------------------------------------------------

#[test]
fn blinks_last_160_ms_every_3_5_to_6_s_and_only_on_the_neutral_cell() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, true));
    let fps = 200.0;
    let tick = 1.0 / fps;
    let frames = session.run(0.0, 300.0, fps);
    let all = runs(&frames);
    let blinks = all
        .iter()
        .enumerate()
        .filter(|(_, (_, _, id))| id == "blink")
        .collect::<Vec<_>>();
    assert!(blinks.len() >= 300 / 6 / 2, "{} blinks", blinks.len());
    assert!((blinks[0].1.0 - BLINK_FIRST_SECONDS).abs() < 1e-9);
    for (index, (start, end, _)) in &blinks {
        let length = end - start + tick;
        assert!((length - BLINK_SECONDS).abs() <= tick + 1e-9, "{length}");
        // On the neutral cell before it (never from a glance).
        if *index > 0 {
            assert_eq!(all[index - 1].2, NEUTRAL, "blink at {start}");
        }
    }
    for pair in blinks.windows(2) {
        let gap = pair[1].1.0 - pair[0].1.0;
        assert!(gap >= BLINK_EVERY_SECONDS.0 - tick, "{gap}");
    }
}

#[test]
fn a_pack_without_a_blink_cell_never_blinks() {
    let atlas = atlas_with(true, &["sleep"], &[]);
    let mut session = Session::new(&atlas, settings(0.45, 0, true));
    assert!(
        session
            .run(0.0, 30.0, 30.0)
            .iter()
            .all(|(_, id)| id.starts_with("look"))
    );
}

#[test]
fn the_pet_sleeps_after_the_silence_and_wakes_surprised_for_600_ms() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    let frames = session.run(0.0, 40.0, 100.0);
    let first_sleep = frames.iter().find(|(_, id)| id == "sleep").unwrap().0;
    assert!((first_sleep - 30.0).abs() < 0.011, "{first_sleep}");
    assert!(
        frames
            .iter()
            .filter(|(now, _)| *now >= 30.0)
            .all(|(_, id)| id == "sleep")
    );
    assert!(session.animator.is_asleep());
    // Chat wakes it: surprised for 600 ms, then the viewer.
    session.handle(GolemAnimatorEvent::ChatSeen, 40.0);
    let frames = session.run(40.0, 41.0, 100.0);
    let woke = runs(&frames);
    assert_eq!(woke[0].2, "surprised");
    assert!(
        (woke[0].1 - woke[0].0 + 0.01 - WAKE_SECONDS).abs() < 0.011,
        "{woke:?}"
    );
    assert_eq!(woke[1].2, NEUTRAL);
    // And it sleeps again only after another 30 s of silence.
    let frames = session.run(41.0, 75.0, 100.0);
    let again = frames.iter().find(|(_, id)| id == "sleep").unwrap().0;
    assert!((again - 70.0).abs() < 0.011, "{again}");
}

#[test]
fn every_kind_of_activity_keeps_it_awake() {
    let atlas = alive();
    for event in [
        talk(10, 2.5),
        GolemAnimatorEvent::ThinkStart,
        follow(),
        GolemAnimatorEvent::React {
            reaction: "wink".to_string(),
        },
        GolemAnimatorEvent::HighlightLive { ttl_seconds: 10.0 },
        GolemAnimatorEvent::ChatSeen,
    ] {
        let mut session = Session::new(&atlas, settings(0.45, 30, true));
        session.run(0.0, 20.0, 30.0);
        session.handle(event.clone(), 20.0);
        session.handle(GolemAnimatorEvent::UtteranceEnd, 25.0);
        session.handle(GolemAnimatorEvent::ThinkSettle, 25.0);
        session.handle(GolemAnimatorEvent::HighlightIdle, 25.0);
        let frames = session.run(20.0, 49.0, 30.0);
        assert!(frames.iter().all(|(_, id)| id != "sleep"), "{event:?}");
        assert_eq!(session.cell(50.0), "sleep", "{event:?}");
    }
    // A failed destination is not somebody in chat.
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    session.run(0.0, 20.0, 30.0);
    session.handle(
        GolemAnimatorEvent::Trigger {
            trigger: GolemTrigger::DestinationFailed,
            reaction: None,
        },
        20.0,
    );
    assert_eq!(session.cell(30.0), "sleep");
}

#[test]
fn sleep_never_starts_under_a_bubble_or_the_card() {
    let atlas = alive();
    // A bubble up from 0 to 50 s (plan 164's state, no event).
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    session.avatar = CohostAvatarState::Talk;
    assert!(
        session
            .run(0.0, 50.0, 30.0)
            .iter()
            .all(|(_, id)| id != "sleep")
    );
    session.avatar = CohostAvatarState::Idle;
    assert_eq!(session.cell(50.0), "sleep");
    // The card on the leg from 0 to 50 s.
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    session.cards = [Some(LEFT_CARD), None];
    assert!(
        session
            .run(0.0, 50.0, 30.0)
            .iter()
            .all(|(_, id)| id != "sleep")
    );
    session.cards = [None, None];
    session.cell(50.0);
    assert_eq!(session.cell(50.1), "sleep");
}

#[test]
fn sleep_after_0_never_sleeps_and_a_pack_without_sleep_stays_awake() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, true));
    assert!(
        session
            .run(0.0, 400.0, 10.0)
            .iter()
            .all(|(_, id)| id != "sleep")
    );
    let atlas = atlas_with(true, &["blink"], &[]);
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    assert!(
        session
            .run(0.0, 100.0, 10.0)
            .iter()
            .all(|(_, id)| id != "sleep")
    );
    // Turning sleep off wakes a sleeping pet at once.
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    session.run(0.0, 31.0, 10.0);
    assert!(session.animator.is_asleep());
    session.handle(GolemAnimatorEvent::Settings(settings(0.45, 0, true)), 31.0);
    assert_eq!(session.cell(31.0), NEUTRAL);
}

#[test]
fn a_reaction_while_asleep_wakes_it_first() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 30, true));
    session.run(0.0, 31.0, 100.0);
    session.handle(follow(), 31.0);
    let woke = runs(&session.run(31.0, 33.0, 100.0));
    let ids = woke
        .iter()
        .map(|(_, _, id)| id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(&ids[..3], ["surprised", "wave", NEUTRAL]);
    assert!(
        (woke[1].0 - (31.0 + WAKE_SECONDS)).abs() < 0.011,
        "{woke:?}"
    );
}

// --- D14: reactions -----------------------------------------------------------------------

fn first_reaction(
    atlas: &GolemSpriteAtlas,
    settings: GolemAnimatorSettings,
    event: GolemAnimatorEvent,
) -> String {
    let mut session = Session::new(atlas, settings);
    session.frame(0.0);
    session.handle(event, 0.5);
    session.cell(0.5)
}

#[test]
fn every_trigger_plays_its_default_reaction() {
    let atlas = alive();
    let expected = [
        (GolemTrigger::Follow, "wave"),
        (GolemTrigger::Subscription, "excited"),
        (GolemTrigger::Gift, "excited"),
        (GolemTrigger::Tip, "surprised"),
        (GolemTrigger::Raid, "surprised"),
        (GolemTrigger::WatchStreak, "proud"),
        (GolemTrigger::Redemption, "wink"),
        // Owner default 4: a failed destination plays nothing.
        (GolemTrigger::DestinationFailed, NEUTRAL),
    ];
    for (trigger, cell) in expected {
        let event = GolemAnimatorEvent::Trigger {
            trigger,
            reaction: None,
        };
        assert_eq!(
            first_reaction(&atlas, defaults(), event),
            cell,
            "{trigger:?}"
        );
    }
}

#[test]
fn a_reaction_falls_back_along_its_chain_then_hops() {
    // No wave: the follow's next choice, proud.
    let no_wave = atlas_with(true, &["proud", "laugh"], &[]);
    assert_eq!(first_reaction(&no_wave, defaults(), follow()), "proud");
    // Neither: a motion-only hop on the current cell.
    let neither = atlas_with(true, &["laugh"], &[]);
    let mut session = Session::new(&neither, settings(1.0, 0, false));
    session.frame(0.0);
    session.handle(follow(), 0.5);
    let draws = (0..30)
        .map(|frame| session.frame(0.5 + f64::from(frame) / 60.0)[0].unwrap())
        .collect::<Vec<_>>();
    assert!(draws.iter().all(|draw| cell_id(&neither, draw) == NEUTRAL));
    assert!(draws.iter().any(|draw| draw.translate[1] < -1.0));
    // The still pack hops too (it has no wave), on its idle image.
    let atlas = still();
    assert_eq!(first_reaction(&atlas, defaults(), follow()), "idle");
}

#[test]
fn a_persona_override_and_a_greeting_reaction_win_and_none_plays_nothing() {
    let atlas = alive();
    let mut custom = defaults();
    custom
        .reactions
        .insert(GolemTrigger::Follow, "laugh".to_string());
    custom
        .reactions
        .insert(GolemTrigger::Raid, GOLEM_REACTION_NONE.to_string());
    custom
        .reactions
        .insert(GolemTrigger::Tip, "dance".to_string());
    custom
        .reactions
        .insert(GolemTrigger::DestinationFailed, "worried".to_string());
    assert_eq!(first_reaction(&atlas, custom.clone(), follow()), "laugh");
    let trigger = |trigger| GolemAnimatorEvent::Trigger {
        trigger,
        reaction: None,
    };
    assert_eq!(
        first_reaction(&atlas, custom.clone(), trigger(GolemTrigger::Raid)),
        NEUTRAL
    );
    // An override the pack lacks falls back to the trigger's default.
    assert_eq!(
        first_reaction(&atlas, custom.clone(), trigger(GolemTrigger::Tip)),
        "surprised"
    );
    assert_eq!(
        first_reaction(
            &atlas,
            custom.clone(),
            trigger(GolemTrigger::DestinationFailed)
        ),
        "worried"
    );
    // The greeting's own reaction beats both.
    let greeted = |reaction: &str| GolemAnimatorEvent::Trigger {
        trigger: GolemTrigger::Follow,
        reaction: Some(reaction.to_string()),
    };
    assert_eq!(
        first_reaction(&atlas, custom.clone(), greeted("kiss")),
        "kiss"
    );
    assert_eq!(
        first_reaction(&atlas, custom, greeted(GOLEM_REACTION_NONE)),
        NEUTRAL
    );
    assert_eq!(
        trigger_reaction_chain(GolemTrigger::Follow, Some("wave"), &BTreeMap::new()),
        vec!["wave".to_string(), "proud".to_string()]
    );
}

#[test]
fn a_laughing_utterance_plays_laugh_and_a_manual_reaction_plays_its_cell() {
    let atlas = alive();
    let laugh = GolemAnimatorEvent::UtteranceStart {
        state: CohostUtteranceState::Laugh,
        chars: 12,
        bubble_seconds: 2.5,
    };
    assert_eq!(first_reaction(&atlas, defaults(), laugh), "laugh");
    let manual = GolemAnimatorEvent::React {
        reaction: "calm".to_string(),
    };
    assert_eq!(first_reaction(&atlas, defaults(), manual), "calm");
}

#[test]
fn a_reaction_holds_1_1_s_and_two_more_wait_for_at_most_6_s() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.45, 0, false));
    session.frame(0.0);
    for trigger in [
        GolemTrigger::Follow,
        GolemTrigger::Redemption,
        GolemTrigger::Subscription,
        // A fourth while two wait: dropped.
        GolemTrigger::Raid,
    ] {
        session.handle(
            GolemAnimatorEvent::Trigger {
                trigger,
                reaction: None,
            },
            0.5,
        );
    }
    let played = runs(&session.run(0.5, 5.0, 100.0));
    let ids = played
        .iter()
        .map(|(_, _, id)| id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["wave", "wink", "excited", NEUTRAL]);
    for (start, end, id) in &played[..3] {
        // Never interrupted: each holds its full 1.1 s.
        assert!(
            (end - start + 0.01 - REACTION_HOLD_SECONDS).abs() < 0.011,
            "{id}: {start}..{end}"
        );
    }
    // Reactions older than 6 s when their turn comes are dropped.
    let mut session = Session::new(&atlas, defaults());
    session.frame(0.0);
    session.handle(follow(), 0.0);
    assert_ne!(session.cell(6.5), "wave");
    let mut session = Session::new(&atlas, defaults());
    session.frame(0.0);
    session.handle(follow(), 0.0);
    assert_eq!(session.cell(5.9), "wave");
}

#[test]
fn a_reaction_holds_its_envelope_when_that_is_longer() {
    let atlas = alive();
    let mut slow = defaults();
    slow.motion.intensity = 1.0;
    let mut session = Session::new(&atlas, slow);
    // Half speed: the envelope runs past 1.1 s.
    let mut config = *session.animator.motion.config();
    config.tuning.speed = 0.5;
    session.animator.motion.set_config(config);
    session.handle(follow(), 0.0);
    let played = runs(&session.run(0.0, 3.0, 100.0));
    assert_eq!(played[0].2, "wave");
    let held = played[0].1 - played[0].0 + 0.01;
    // 0.11 / 0.5 + 0.19 / 0.5 + (0.45 + 0.4 * 0.3) / 0.5 = 1.74 s.
    assert!((held - 1.74).abs() < 0.011, "{held}");
}

// --- D15 and Motion -------------------------------------------------------------------

#[test]
fn breathing_runs_only_at_rest_on_a_gaze_cell() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(1.0, 30, true));
    let breathing = (0..600)
        .map(|frame| session.frame(f64::from(frame) / 60.0)[0].unwrap())
        .filter(|draw| draw.affine[0] != 1.0)
        .count();
    assert!(breathing > 500, "{breathing} breathing frames");
    // Asleep (on the sleep cell) the breath fades out to nothing.
    session.run(10.0, 35.0, 60.0);
    let asleep = session.frame(35.0)[0].unwrap();
    assert_eq!(cell_id(&atlas, &asleep), "sleep");
    assert!(is_identity(&asleep), "{asleep:?}");
    // Breathing off: at rest is the identity.
    let mut session = Session::new(&atlas, settings(1.0, 0, false));
    assert!(
        (0..300)
            .map(|frame| session.frame(f64::from(frame) / 60.0)[0].unwrap())
            .all(|draw| is_identity(&draw))
    );
}

#[test]
fn motion_0_keeps_the_frame_changes_and_removes_every_transform() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(0.0, 30, true)).with_aux();
    session.frame(0.0);
    session.handle(follow(), 1.0);
    session.handle(GolemAnimatorEvent::HighlightLive { ttl_seconds: 10.0 }, 3.0);
    let mut seen = std::collections::BTreeSet::new();
    for frame in 1..(40 * 30) {
        let now = f64::from(frame) / 30.0;
        if frame == 90 {
            session.cards = [Some(LEFT_CARD), Some(AUX_CARD)];
        }
        if frame == 390 {
            session.cards = [None, None];
        }
        for draw in session.frame(now).into_iter().flatten() {
            assert!(is_identity(&draw), "{now}: {draw:?}");
            assert_eq!(draw.opacity, 1.0);
            seen.insert(cell_id(&atlas, &draw));
        }
    }
    for id in ["wave", "look-02", "blink", "sleep", NEUTRAL] {
        assert!(seen.contains(id), "{id} never drawn: {seen:?}");
    }
}

#[test]
fn the_draw_is_the_motion_transform_about_the_pack_pivot() {
    let atlas = alive();
    let mut session = Session::new(&atlas, settings(1.0, 0, false));
    session.handle(follow(), 0.0);
    session.frame(0.0);
    let draw = session.frame(0.2)[0].unwrap();
    assert_eq!(draw.cell, atlas.cell("wave").unwrap().rect);
    assert_eq!(draw.center, [1720.0, 940.0]);
    assert_eq!(draw.size, 240.0);
    assert_eq!(draw.pivot, [0.5, 0.9]);
    assert!(!is_identity(&draw));
    // Translation is in canvas pixels at the drawn size: the same moment on
    // a pet half the size moves half as far.
    let mut config = *session.animator.motion.config();
    config.size = 120.0;
    session.animator.motion.set_config(config);
    let half = session.animator.motion.transform().translate_y;
    config.size = 240.0;
    session.animator.motion.set_config(config);
    let full = session.animator.motion.transform().translate_y;
    assert!(
        (full - 2.0 * half).abs() < 1e-9 && full < 0.0,
        "{full} {half}"
    );
    assert!((f64::from(draw.translate[1]) - full).abs() < 1e-4);
}

// --- S-C4: one state per frame -------------------------------------------------------------

#[test]
fn two_draws_at_the_same_time_are_identical() {
    let atlas = alive();
    let mut session = Session::new(&atlas, defaults()).with_aux();
    session.handle(follow(), 0.5);
    session.handle(talk(30, 2.5), 2.0);
    for frame in 0..(20 * 60) {
        let now = f64::from(frame) / 60.0;
        session.avatar = if (2.0..4.5).contains(&now) {
            CohostAvatarState::Talk
        } else {
            CohostAvatarState::Idle
        };
        session.cards = if (6.0..16.0).contains(&now) {
            [Some(LEFT_CARD), Some(AUX_CARD)]
        } else {
            [None, None]
        };
        let first = session.frame(now);
        let again = session.frame(now);
        assert_eq!(first, again, "frame {frame}");
    }
}

#[test]
fn the_same_seed_replays_the_same_session() {
    let atlas = alive();
    let play = |seed: u64| {
        let mut session = Session::new(&atlas, defaults());
        session.animator = GolemAnimator::new(defaults(), seed);
        session.handle(follow(), 1.0);
        session
            .run(0.0, 120.0, 30.0)
            .into_iter()
            .map(|(_, id)| id)
            .collect::<Vec<_>>()
    };
    assert_eq!(play(SEED), play(SEED));
    assert_ne!(play(SEED), play(SEED + 1));
}

// --- The slot's source ------------------------------------------------------------------------

#[test]
fn the_source_applies_events_at_the_next_frame_and_keeps_its_own_clock() {
    let atlas = alive();
    let mut source = GolemAnimatorSource::new(defaults(), SEED);
    let draw = |source: &mut GolemAnimatorSource, now: f64| {
        let draw = source
            .draw(&context(
                GolemSpriteLeg::Primary,
                now,
                &atlas,
                CohostAvatarState::Idle,
                None,
            ))
            .unwrap();
        cell_id(&atlas, &draw)
    };
    assert_eq!(draw(&mut source, 100.0), NEUTRAL);
    source.notify(
        Instant::now(),
        GolemAnimatorEvent::React {
            reaction: "wave".to_string(),
        },
    );
    // Not before the next frame: the second leg of a frame sees what the
    // first saw.
    assert_eq!(draw(&mut source, 100.0), NEUTRAL);
    assert_eq!(draw(&mut source, 100.02), "wave");
    // A new session's clock starts over at 0: the animator's time carries on
    // (one frame later), so the reaction is still playing ...
    assert_eq!(draw(&mut source, 0.0), "wave");
    // ... and ends 1.1 s after it began, on the new clock.
    assert_eq!(draw(&mut source, 1.0), "wave");
    assert_eq!(draw(&mut source, 1.2), NEUTRAL);
    // Settings apply at once.
    source.notify(
        Instant::now(),
        GolemAnimatorEvent::Settings(settings(0.0, 0, false)),
    );
    assert_eq!(source.animator.settings.motion.intensity, 0.0);
}

#[test]
fn the_source_drops_reactions_that_waited_too_long_for_a_frame() {
    let atlas = alive();
    let mut source = GolemAnimatorSource::new(defaults(), SEED);
    let ctx = |now: f64| {
        context(
            GolemSpriteLeg::Primary,
            now,
            &atlas,
            CohostAvatarState::Idle,
            None,
        )
    };
    source.draw(&ctx(10.0));
    let long_ago = Instant::now() - std::time::Duration::from_secs(8);
    source.notify(long_ago, follow());
    let draw = source.draw(&ctx(10.02)).unwrap();
    assert_eq!(cell_id(&atlas, &draw), NEUTRAL);
    // The pile of events waiting for a frame stays bounded.
    for _ in 0..(PENDING_MAX * 3) {
        source.notify(Instant::now(), GolemAnimatorEvent::ChatSeen);
    }
    assert_eq!(source.pending.len(), PENDING_MAX);
}

// --- S-C3: chat rows as animator events -------------------------------------------------------

fn twitch_activity() -> Vec<LiveChatMessage> {
    crate::live_chat::fake_events_for_tests(
        "golem-session",
        crate::streaming::StreamPlatform::Twitch,
        None,
    )
}

#[test]
fn activity_rows_become_their_triggers_and_chat_becomes_activity() {
    use CohostActivityTemplateKind as Kind;
    for (kind, trigger) in [
        (Kind::Follow, GolemTrigger::Follow),
        (Kind::Sub, GolemTrigger::Subscription),
        (Kind::Resub, GolemTrigger::Subscription),
        (Kind::Membership, GolemTrigger::Subscription),
        (Kind::SubGift, GolemTrigger::Gift),
        (Kind::CommunitySubGift, GolemTrigger::Gift),
        (Kind::Cheer, GolemTrigger::Tip),
        (Kind::Kicks, GolemTrigger::Tip),
        (Kind::SuperChat, GolemTrigger::Tip),
        (Kind::SuperSticker, GolemTrigger::Tip),
        (Kind::PowerUp, GolemTrigger::Tip),
        (Kind::Raid, GolemTrigger::Raid),
        (Kind::WatchStreak, GolemTrigger::WatchStreak),
        (Kind::Redemption, GolemTrigger::Redemption),
    ] {
        assert_eq!(trigger_for_activity(kind), trigger, "{kind:?}");
    }
    let rows = twitch_activity();
    let events = live_chat_events(&rows, &CohostAutoChat::default(), chrono::Utc::now());
    let triggers = events
        .iter()
        .filter_map(|event| match event {
            GolemAnimatorEvent::Trigger { trigger, reaction } => {
                assert_eq!(*reaction, None);
                Some(*trigger)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(triggers.contains(&GolemTrigger::Follow), "{triggers:?}");
    assert!(triggers.contains(&GolemTrigger::Raid), "{triggers:?}");
    assert!(triggers.contains(&GolemTrigger::Redemption), "{triggers:?}");
    // Plain chat: one ChatSeen per batch; tombstones, moderation rows and
    // stale rows count for nothing.
    let mut chat = rows[0].clone();
    chat.details = None;
    chat.event_type = LiveChatEventType::Message;
    let mut deleted = chat.clone();
    deleted.is_deleted = true;
    let mut moderation = chat.clone();
    moderation.event_type = LiveChatEventType::Moderation;
    let mut stale = rows[0].clone();
    stale.published_at = (chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
    let events = live_chat_events(
        &[chat.clone(), chat, deleted, moderation, stale],
        &CohostAutoChat::default(),
        chrono::Utc::now(),
    );
    assert_eq!(events, vec![GolemAnimatorEvent::ChatSeen]);
}

#[test]
fn a_greeting_that_answers_the_row_brings_its_own_reaction() {
    use crate::cohost::{CohostGreetingPlatform, CohostGreetingTemplate, CohostGreetingsSettings};
    let follow = twitch_activity()
        .into_iter()
        .find(|row| row.event_type == LiveChatEventType::Follow)
        .unwrap();
    let template = |id: &str, platform, reaction: Option<&str>, enabled| CohostGreetingTemplate {
        id: id.to_string(),
        kind: CohostActivityTemplateKind::Follow,
        platform,
        text: "Welcome {name}!".to_string(),
        state: CohostUtteranceState::Talk,
        enabled,
        reaction: reaction.map(str::to_string),
    };
    let mut auto_chat = CohostAutoChat {
        mode: CohostAutoChatMode::Auto,
        greetings: CohostGreetingsSettings {
            enabled: true,
            templates: vec![
                template("off", None, Some("laugh"), false),
                template(
                    "kick-only",
                    Some(CohostGreetingPlatform::Kick),
                    Some("calm"),
                    true,
                ),
                template("plain", None, None, true),
                template(
                    "proud",
                    Some(CohostGreetingPlatform::Twitch),
                    Some("proud"),
                    true,
                ),
            ],
        },
        ..CohostAutoChat::default()
    };
    let reaction = |auto_chat: &CohostAutoChat| match live_chat_events(
        std::slice::from_ref(&follow),
        auto_chat,
        chrono::Utc::now(),
    )
    .as_slice()
    {
        [GolemAnimatorEvent::Trigger { reaction, .. }] => reaction.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(reaction(&auto_chat), Some("proud".to_string()));
    // Greetings off (or the mode off): the trigger's own reaction.
    auto_chat.greetings.enabled = false;
    assert_eq!(reaction(&auto_chat), None);
    auto_chat.greetings.enabled = true;
    auto_chat.mode = CohostAutoChatMode::Off;
    assert_eq!(reaction(&auto_chat), None);
}

// --- S-C3: the events reach the pet on stream -------------------------------------------------

mod wiring {
    use super::*;
    use crate::golem_sprite::GolemLegRequest;
    use crate::state::AppState;
    use crate::storage::Database;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(256);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    /// The pet on the primary 1080p leg at `now`, with the card at `card`.
    fn on_stream(state: &AppState, now: f64, card: Option<[f32; 4]>) -> (String, [f32; 4]) {
        let frame = state.golem_sprite.leg_frame(GolemLegRequest {
            leg: GolemSpriteLeg::Primary,
            canvas: PRIMARY_CANVAS,
            now_seconds: now,
            highlight_rect: card,
            caption_rect: None,
        });
        let sprite = frame.sprite.expect("the pet draws");
        (cell_id(&sprite.atlas, &sprite.draw), frame.golem_box)
    }

    fn wear_alive(state: &AppState) {
        state
            .golem_sprite
            .install_atlas_for_test(GolemSpriteLeg::Primary, PRIMARY_CANVAS, alive());
    }

    #[tokio::test]
    async fn a_fake_follow_plays_the_follow_reaction_on_stream() {
        let state = test_state();
        wear_alive(&state);
        assert_eq!(on_stream(&state, 10.0, None).0, NEUTRAL);
        // The Twitch fake activity's follow, through the chat delivery hook.
        let follow = crate::live_chat::fake_events_for_tests(
            "golem-session",
            crate::streaming::StreamPlatform::Twitch,
            Some("twitch-target"),
        )
        .into_iter()
        .find(|message| message.event_type == LiveChatEventType::Follow)
        .expect("the fake activity has a follow");
        let delivery = state.live_chat_persistence.begin_delivery().await;
        crate::cohost::note_messages_under_lifecycle_fence(&state, &delivery, &[follow]).await;
        drop(delivery);
        assert_eq!(
            on_stream(&state, 10.0, None).0,
            NEUTRAL,
            "not before the next frame"
        );
        assert_eq!(on_stream(&state, 10.033, None).0, "wave");
        assert_eq!(on_stream(&state, 11.0, None).0, "wave");
        assert_eq!(on_stream(&state, 11.2, None).0, NEUTRAL);
    }

    #[tokio::test]
    async fn plain_chat_wakes_the_pet_and_a_tombstone_does_not() {
        let state = test_state();
        wear_alive(&state);
        let mut sleepy = GolemAnimatorSettings::default();
        sleepy.motion.sleep_after_seconds = 30;
        state
            .golem_sprite
            .notify(GolemAnimatorEvent::Settings(sleepy));
        for frame in 0..=320 {
            on_stream(&state, f64::from(frame) / 10.0, None);
        }
        assert_eq!(on_stream(&state, 32.1, None).0, "sleep");
        let mut chat = crate::live_chat::fake_events_for_tests(
            "golem-session",
            crate::streaming::StreamPlatform::Twitch,
            None,
        )
        .remove(0);
        chat.details = None;
        chat.event_type = LiveChatEventType::Message;
        let mut tombstone = chat.clone();
        tombstone.is_deleted = true;
        let delivery = state.live_chat_persistence.begin_delivery().await;
        crate::cohost::note_messages_under_lifecycle_fence(&state, &delivery, &[tombstone]).await;
        drop(delivery);
        assert_eq!(on_stream(&state, 32.2, None).0, "sleep");
        let delivery = state.live_chat_persistence.begin_delivery().await;
        crate::cohost::note_messages_under_lifecycle_fence(&state, &delivery, &[chat]).await;
        drop(delivery);
        assert_eq!(on_stream(&state, 32.3, None).0, "surprised");
    }

    #[tokio::test]
    async fn the_say_box_talks_and_a_manual_reaction_plays() {
        let state = test_state();
        wear_alive(&state);
        on_stream(&state, 5.0, None);
        crate::golem_overlay::show_bubble(
            &state,
            "Thanks for hanging out tonight, everyone!",
            CohostUtteranceState::Talk,
        )
        .await
        .unwrap();
        let talked = (1..40)
            .map(|frame| on_stream(&state, 5.0 + f64::from(frame) / 30.0, None).0)
            .collect::<Vec<_>>();
        assert_eq!(talked[0], "talk-a");
        assert!(talked.iter().any(|id| id == "talk-b"), "{talked:?}");
        // A Stream Manager chip (`cohost.pet.react`): the still persona's
        // `laugh` passes the pack check and plays.
        crate::golem_pet_store::request_reaction(&state, "laugh")
            .await
            .unwrap();
        assert_eq!(on_stream(&state, 6.5, None).0, "laugh");
    }

    #[tokio::test]
    async fn a_live_highlight_turns_the_gaze_toward_the_card() {
        let state = test_state();
        wear_alive(&state);
        let (_, golem_box) = on_stream(&state, 1.0, None);
        // The card left of the pet, as the compositor passes its blit.
        let card = [
            (golem_box[0] - 700.0).max(0.0),
            golem_box[1],
            500.0,
            golem_box[3],
        ];
        crate::comment_highlight::tests::install_live_highlight_for_test(&state).await;
        let (looked, _) = on_stream(&state, 1.05, Some(card));
        let gaze = gaze_of(&alive(), &looked).expect("a gaze cell");
        assert!(gaze[0] < 0.0, "{looked} {gaze:?}");
        // 1.5 s later: back to the viewer; the card leaving changes nothing.
        assert_eq!(on_stream(&state, 2.6, Some(card)).0, NEUTRAL);
        crate::comment_highlight::clear_comment_highlight(&state).await;
        assert_eq!(on_stream(&state, 2.7, None).0, NEUTRAL);
    }
}
