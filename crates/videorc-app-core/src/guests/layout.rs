//! The talk-show geometry (plan 224 D8; `lib/talk-show-layout.ts`), mirrored
//! from the runner's `talk_show_layout.rs` so the Show stage draws the
//! picture the cloud sends. `protocol-fixtures/talk-show-layout.json` and
//! `talk-show-two-screens-layout.json` are the runner's own fixtures; the
//! tests hold this module to them case by case.
//!
//! Rules: tiles are 16:9 and fitted inside their cell, centred; every rect
//! has even coordinates and sizes; nothing overlaps and nothing leaves the
//! canvas. The gutter and the corner radius scale with the canvas (24 px and
//! 20 px at 1080 lines). A name plate's box runs along its tile's bottom
//! edge.

use super::stage_screens::{STAGE_MAX_SCREENS, screens_by_owner, stage_screens};
use super::wire::{DrawnStageLayout, RoomShown, RoomStatus, StageLayout};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageCanvas {
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StageRect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageTileKind {
    Person,
    Screen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageTile {
    pub identity: String,
    pub kind: StageTileKind,
    pub rect: StageRect,
    /// None on a screen tile and on a full-frame solo tile.
    pub plate: Option<StageRect>,
    /// 0 on a full-frame tile.
    pub corner_radius: i64,
}

/// What the stage asks the program to draw.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StageInput {
    pub layout: StageLayout,
    /// The on-stage identities, in order.
    pub people: Vec<String>,
    /// Everyone on the stage, drawn or not: where each screen's owner stands.
    /// None: `people`.
    pub on_stage: Option<Vec<String>>,
    pub spotlight: Option<String>,
    pub screen: Option<String>,
    pub screens: Vec<String>,
}

/// `Math.floor(value) & ~1` for an integer.
fn even(value: i64) -> i64 {
    value & !1
}

/// `Math.round(numerator / denominator)` for integers, ties up as JS does.
fn js_round(numerator: i64, denominator: i64) -> i64 {
    (2 * numerator + denominator).div_euclid(2 * denominator)
}

fn short_side(canvas: StageCanvas) -> i64 {
    canvas.width.min(canvas.height)
}

/// The gap between tiles and from the canvas edge: 24 px at 1080 lines.
pub fn stage_gutter(canvas: StageCanvas) -> i64 {
    4.max(even(js_round(short_side(canvas) * 24, 1080)))
}

/// Tile corner radius: 20 px at 1080 lines.
pub fn stage_corner_radius(canvas: StageCanvas) -> i64 {
    js_round(short_side(canvas) * 20, 1080)
}

/// A name plate's height: 44 px at 1080 lines.
pub fn stage_plate_height(canvas: StageCanvas) -> i64 {
    12.max(even(js_round(short_side(canvas) * 44, 1080)))
}

fn right(rect: StageRect) -> i64 {
    rect.x + rect.w
}

fn bottom(rect: StageRect) -> i64 {
    rect.y + rect.h
}

/// The largest 16:9 rect that fits `cell`, centred in it, even-sized.
fn fit16x9(cell: StageRect) -> StageRect {
    let (raw_w, raw_h) = if cell.w * 9 <= cell.h * 16 {
        (cell.w, (cell.w * 9).div_euclid(16))
    } else {
        ((cell.h * 16).div_euclid(9), cell.h)
    };
    let w = even(raw_w);
    let h = even(raw_h);
    StageRect {
        x: even(cell.x + (cell.w - w).div_euclid(2)),
        y: even(cell.y + (cell.h - h).div_euclid(2)),
        w,
        h,
    }
}

/// A grid of `count` equal cells in `area`, `cols` wide, rows filled top to
/// bottom, the last row centred when it is short.
fn grid_cells(area: StageRect, count: usize, cols_wanted: usize, gutter: i64) -> Vec<StageRect> {
    let cols = cols_wanted.max(1).min(count.max(1)) as i64;
    let count = count as i64;
    let rows = ((count + cols - 1) / cols).max(1);
    let cell_w = (area.w - gutter * (cols - 1)).max(0).div_euclid(cols);
    let cell_h = (area.h - gutter * (rows - 1)).max(0).div_euclid(rows);
    (0..count)
        .map(|index| {
            let row = index / cols;
            let in_row = if row == rows - 1 {
                count - row * cols
            } else {
                cols
            };
            let col = index % cols;
            let row_w = in_row * cell_w + gutter * (in_row - 1);
            let x0 = area.x + (area.w - row_w).div_euclid(2);
            StageRect {
                x: x0 + col * (cell_w + gutter),
                y: area.y + row * (cell_h + gutter),
                w: cell_w,
                h: cell_h,
            }
        })
        .collect()
}

fn plate_for(canvas: StageCanvas, tile: StageRect) -> Option<StageRect> {
    let inset = stage_gutter(canvas).div_euclid(2);
    let h = stage_plate_height(canvas);
    if tile.h < h + 2 * inset + 8 || tile.w < 4 * inset {
        return None;
    }
    Some(StageRect {
        x: tile.x + inset,
        y: even(bottom(tile) - inset - h),
        w: even(tile.w - 2 * inset),
        h,
    })
}

fn person(canvas: StageCanvas, identity: &str, rect: StageRect) -> StageTile {
    StageTile {
        identity: identity.to_string(),
        kind: StageTileKind::Person,
        rect,
        plate: plate_for(canvas, rect),
        corner_radius: stage_corner_radius(canvas),
    }
}

fn screen_tile(canvas: StageCanvas, identity: &str, rect: StageRect) -> StageTile {
    StageTile {
        identity: identity.to_string(),
        kind: StageTileKind::Screen,
        rect,
        plate: None,
        corner_radius: stage_corner_radius(canvas),
    }
}

fn inset_area(canvas: StageCanvas) -> StageRect {
    let g = stage_gutter(canvas);
    StageRect {
        x: g,
        y: g,
        w: canvas.width - 2 * g,
        h: canvas.height - 2 * g,
    }
}

/// Columns for a side-by-side grid of `n` people.
fn grid_cols(n: usize, portrait: bool) -> usize {
    if n <= 1 {
        return 1;
    }
    if !portrait {
        return match n {
            2 | 3 => n,
            4 => 2,
            _ => 3,
        };
    }
    if n <= 3 { 1 } else { 2 }
}

fn live_people(input: &StageInput) -> Vec<String> {
    input
        .people
        .iter()
        .filter(|identity| !identity.is_empty())
        .cloned()
        .collect()
}

/// The layout the program actually draws for this input (its fallbacks):
/// `screen-people` with two screens is two screens, with one it is itself,
/// and with none it is the grid; Solo with more than one person is the grid.
pub fn effective_stage_layout(input: &StageInput) -> DrawnStageLayout {
    let people = live_people(input);
    if input.layout == StageLayout::ScreenPeople {
        let screens = stage_screens(input.screen.as_deref(), &input.screens).len();
        if screens == 0 {
            return DrawnStageLayout::SideBySide;
        }
        return if screens >= STAGE_MAX_SCREENS {
            DrawnStageLayout::TwoScreens
        } else {
            DrawnStageLayout::ScreenPeople
        };
    }
    if input.layout == StageLayout::Solo && people.len() > 1 {
        return DrawnStageLayout::SideBySide;
    }
    input.layout.into()
}

/// Columns for the people under two screens (plan 251).
fn under_screens_cols(n: usize, portrait: bool) -> usize {
    if !portrait || n <= 2 {
        return n.max(1);
    }
    if n <= 4 { 2 } else { 3 }
}

/// Plan 251: two screens across the top, everyone on stage in a row under
/// them; on a portrait canvas the screens stack, each full width.
fn two_screens_tiles(canvas: StageCanvas, people: &[String], screens: &[String]) -> Vec<StageTile> {
    let gutter = stage_gutter(canvas);
    let area = inset_area(canvas);
    let portrait = canvas.height > canvas.width;
    let cell_w = if portrait {
        area.w
    } else {
        (area.w - gutter).div_euclid(2)
    };
    let cell_h = (cell_w * 9).div_euclid(16);
    let first = fit16x9(StageRect {
        x: area.x,
        y: area.y,
        w: cell_w,
        h: cell_h,
    });
    let second = if portrait {
        fit16x9(StageRect {
            x: area.x,
            y: bottom(first) + gutter,
            w: cell_w,
            h: cell_h,
        })
    } else {
        fit16x9(StageRect {
            x: right(area) - cell_w,
            y: area.y,
            w: cell_w,
            h: cell_h,
        })
    };
    let mut tiles: Vec<StageTile> = [first, second]
        .into_iter()
        .enumerate()
        .map(|(index, rect)| {
            screen_tile(canvas, screens.get(index).map_or("", String::as_str), rect)
        })
        .collect();
    let top = bottom(second) + gutter;
    let below = StageRect {
        x: area.x,
        y: top,
        w: area.w,
        h: (bottom(area) - top).max(0),
    };
    let cells = grid_cells(
        below,
        people.len(),
        under_screens_cols(people.len(), portrait),
        gutter,
    );
    for (identity, cell) in people.iter().zip(cells) {
        tiles.push(person(canvas, identity, fit16x9(cell)));
    }
    tiles
}

/// The screens a program page or a runner reports showing: its `screens`
/// when it sends them, else its one `screen`.
pub fn shown_screens(shown: &RoomShown) -> Vec<String> {
    if !shown.screens.is_empty() {
        let mut unique: Vec<String> = Vec::new();
        for screen in &shown.screens {
            if !unique.contains(screen) {
                unique.push(screen.clone());
            }
        }
        unique.truncate(STAGE_MAX_SCREENS);
        return unique;
    }
    shown.screen.iter().cloned().collect()
}

/// The Show stage's input (review M2): the stage this desktop set, as the
/// program draws it. The runner's `shown` takes out whoever it has on its
/// stage and no longer draws, and names the screen it shows. Without
/// `shown` the stage is drawn as sent.
pub fn show_stage_input(room: Option<&RoomStatus>) -> StageInput {
    let Some(room) = room else {
        return StageInput::default();
    };
    let stage = &room.stage;
    let input = StageInput {
        layout: stage.layout,
        people: stage.on_stage.clone(),
        on_stage: Some(stage.on_stage.clone()),
        spotlight: stage.spotlight.clone(),
        screen: stage.screen.clone(),
        screens: stage.screens.clone(),
    };
    let Some(shown) = &room.shown else {
        return input;
    };
    let runner_stage: Vec<&str> = room
        .participants
        .iter()
        .filter(|participant| participant.on_stage)
        .map(|participant| participant.identity.as_str())
        .collect();
    let screens: Vec<String> = shown_screens(shown)
        .into_iter()
        .filter(|identity| input.people.contains(identity))
        .collect();
    StageInput {
        people: input
            .people
            .iter()
            .filter(|identity| {
                !runner_stage.contains(&identity.as_str()) || shown.on_stage.contains(identity)
            })
            .cloned()
            .collect(),
        screen: screens.first().cloned(),
        screens: if screens.len() == STAGE_MAX_SCREENS {
            screens
        } else {
            Vec::new()
        },
        ..input
    }
}

/// The plan for one canvas. People missing from the room still get a tile.
pub fn plan_stage(canvas: StageCanvas, input: &StageInput) -> Vec<StageTile> {
    let people = live_people(input);
    let screens = stage_screens(input.screen.as_deref(), &input.screens);
    if people.is_empty() && screens.is_empty() {
        return Vec::new();
    }
    let gutter = stage_gutter(canvas);
    let area = inset_area(canvas);
    let portrait = canvas.height > canvas.width;
    let mut tiles: Vec<StageTile> = Vec::new();
    match effective_stage_layout(input) {
        DrawnStageLayout::Solo => tiles.push(StageTile {
            identity: people.first().cloned().unwrap_or_default(),
            kind: StageTileKind::Person,
            rect: StageRect {
                x: 0,
                y: 0,
                w: even(canvas.width),
                h: even(canvas.height),
            },
            plate: None,
            corner_radius: 0,
        }),
        DrawnStageLayout::SideBySide => {
            let cells = grid_cells(
                area,
                people.len(),
                grid_cols(people.len(), portrait),
                gutter,
            );
            for (identity, cell) in people.iter().zip(cells) {
                tiles.push(person(canvas, identity, fit16x9(cell)));
            }
        }
        DrawnStageLayout::TwoScreens => {
            let order = input.on_stage.clone().unwrap_or_else(|| people.clone());
            let paired = screens_by_owner(&screens, &order);
            tiles.extend(two_screens_tiles(canvas, &people, &paired));
        }
        DrawnStageLayout::ScreenPeople => {
            let screen_identity = screens.first().map_or("", String::as_str);
            if portrait {
                let screen = fit16x9(StageRect {
                    x: area.x,
                    y: area.y,
                    w: area.w,
                    h: (area.w * 9).div_euclid(16),
                });
                tiles.push(screen_tile(canvas, screen_identity, screen));
                let below = StageRect {
                    x: area.x,
                    y: bottom(screen) + gutter,
                    w: area.w,
                    h: (bottom(area) - (bottom(screen) + gutter)).max(0),
                };
                let cols = if people.len() <= 2 { 1 } else { 2 };
                let cells = grid_cells(below, people.len(), cols, gutter);
                for (identity, cell) in people.iter().zip(cells) {
                    tiles.push(person(canvas, identity, fit16x9(cell)));
                }
            } else {
                let column_w = even(area.w.div_euclid(4));
                let screen = fit16x9(StageRect {
                    x: area.x,
                    y: area.y,
                    w: area.w - column_w - gutter,
                    h: area.h,
                });
                tiles.push(screen_tile(canvas, screen_identity, screen));
                let n = people.len() as i64;
                let natural_h = even((column_w * 9).div_euclid(16));
                let group_h = n * natural_h + gutter * (n - 1).max(0);
                let column = if group_h <= area.h {
                    StageRect {
                        x: right(area) - column_w,
                        y: area.y + (area.h - group_h).div_euclid(2),
                        w: column_w,
                        h: group_h,
                    }
                } else {
                    StageRect {
                        x: right(area) - column_w,
                        y: area.y,
                        w: column_w,
                        h: area.h,
                    }
                };
                let cells = grid_cells(column, people.len(), 1, gutter);
                for (identity, cell) in people.iter().zip(cells) {
                    tiles.push(person(canvas, identity, fit16x9(cell)));
                }
            }
        }
        DrawnStageLayout::Spotlight => {
            let spotlit = input
                .spotlight
                .clone()
                .filter(|spotlight| people.contains(spotlight))
                .or_else(|| people.first().cloned())
                .unwrap_or_default();
            let rest: Vec<String> = people
                .iter()
                .filter(|identity| **identity != spotlit)
                .cloned()
                .collect();
            if rest.is_empty() {
                tiles.push(person(canvas, &spotlit, fit16x9(area)));
            } else if portrait {
                let big = fit16x9(StageRect {
                    x: area.x,
                    y: area.y,
                    w: area.w,
                    h: (area.w * 9).div_euclid(16),
                });
                tiles.push(person(canvas, &spotlit, big));
                let below = StageRect {
                    x: area.x,
                    y: bottom(big) + gutter,
                    w: area.w,
                    h: (bottom(area) - (bottom(big) + gutter)).max(0),
                };
                let cols = if rest.len() <= 1 { 1 } else { 2 };
                let cells = grid_cells(below, rest.len(), cols, gutter);
                for (identity, cell) in rest.iter().zip(cells) {
                    tiles.push(person(canvas, identity, fit16x9(cell)));
                }
            } else {
                // The strip along the bottom takes 22% of the canvas height
                // (a float, as the runner and the page compute it).
                let strip_h = even((canvas.height as f64 * 0.22).floor() as i64);
                let big = fit16x9(StageRect {
                    x: area.x,
                    y: area.y,
                    w: area.w,
                    h: area.h - strip_h - gutter,
                });
                tiles.push(person(canvas, &spotlit, big));
                let strip = StageRect {
                    x: area.x,
                    y: bottom(area) - strip_h,
                    w: area.w,
                    h: strip_h,
                };
                let cells = grid_cells(strip, rest.len(), rest.len(), gutter);
                for (identity, cell) in rest.iter().zip(cells) {
                    tiles.push(person(canvas, identity, fit16x9(cell)));
                }
            }
        }
    }
    tiles
}

/// A rect as fractions of the canvas, for a stage drawn at any size (the
/// page's `stageRectPercent`, as numbers rather than CSS strings).
pub fn stage_rect_fraction(canvas: StageCanvas, rect: StageRect) -> [f64; 4] {
    let of = |value: i64, total: i64| value as f64 / total as f64;
    [
        of(rect.x, canvas.width),
        of(rect.y, canvas.height),
        of(rect.w, canvas.width),
        of(rect.h, canvas.height),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(name: &str) -> Vec<Value> {
        let path = format!(
            "{}/../../protocol-fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn rect(value: &Value) -> StageRect {
        StageRect {
            x: value["x"].as_i64().unwrap(),
            y: value["y"].as_i64().unwrap(),
            w: value["w"].as_i64().unwrap(),
            h: value["h"].as_i64().unwrap(),
        }
    }

    fn input_of(case: &Value) -> StageInput {
        // The fixtures spell the two-screens layout out; on the wire it is
        // Screen + people with two screens.
        let layout = match case["layout"].as_str().unwrap() {
            "side-by-side" => StageLayout::SideBySide,
            "screen-people" | "two-screens" => StageLayout::ScreenPeople,
            "spotlight" => StageLayout::Spotlight,
            _ => StageLayout::Solo,
        };
        StageInput {
            layout,
            people: strings(&case["people"]),
            on_stage: case.get("onStage").map(strings),
            spotlight: case["spotlight"].as_str().map(str::to_string),
            screen: case["screen"].as_str().map(str::to_string),
            screens: strings(&case["screens"]),
        }
    }

    fn hold_to(name: &str) {
        let cases = fixture(name);
        assert!(!cases.is_empty());
        for case in cases {
            let label = case["name"].as_str().unwrap();
            let canvas = StageCanvas {
                width: case["canvas"]["width"].as_i64().unwrap(),
                height: case["canvas"]["height"].as_i64().unwrap(),
            };
            let tiles = plan_stage(canvas, &input_of(&case));
            let expected = case["plan"]["tiles"].as_array().unwrap();
            assert_eq!(tiles.len(), expected.len(), "{label}: tile count");
            for (tile, want) in tiles.iter().zip(expected) {
                assert_eq!(tile.identity, want["identity"].as_str().unwrap(), "{label}");
                let kind = match want["kind"].as_str().unwrap() {
                    "screen" => StageTileKind::Screen,
                    _ => StageTileKind::Person,
                };
                assert_eq!(tile.kind, kind, "{label}: kind");
                assert_eq!(tile.rect, rect(&want["rect"]), "{label}: rect");
                assert_eq!(tile.plate, want.get("plate").map(rect), "{label}: plate");
                assert_eq!(
                    tile.corner_radius,
                    want["cornerRadius"].as_i64().unwrap(),
                    "{label}: corner"
                );
            }
        }
    }

    #[test]
    fn the_layout_matches_the_runners_fixture_case_by_case() {
        hold_to("talk-show-layout.json");
    }

    #[test]
    fn two_screens_match_the_runners_fixture_case_by_case() {
        hold_to("talk-show-two-screens-layout.json");
    }

    #[test]
    fn the_program_s_fallbacks() {
        let solo_of_two = StageInput {
            layout: StageLayout::Solo,
            people: vec!["h".into(), "g".into()],
            ..StageInput::default()
        };
        assert_eq!(
            effective_stage_layout(&solo_of_two),
            DrawnStageLayout::SideBySide
        );
        let screenless = StageInput {
            layout: StageLayout::ScreenPeople,
            people: vec!["h".into()],
            ..StageInput::default()
        };
        assert_eq!(
            effective_stage_layout(&screenless),
            DrawnStageLayout::SideBySide
        );
        let two = StageInput {
            screen: Some("h".into()),
            screens: vec!["h".into(), "g".into()],
            ..screenless
        };
        assert_eq!(effective_stage_layout(&two), DrawnStageLayout::TwoScreens);
    }

    #[test]
    fn the_runners_shown_stage_drops_who_it_reflowed_out() {
        let room: RoomStatus = serde_json::from_value(serde_json::json!({
            "phase": "open",
            "stage": { "layout": "screen-people", "onStage": ["h", "g", "k"], "screen": "g" },
            "participants": [
                { "identity": "g", "role": "guest", "onStage": true },
                { "identity": "k", "role": "guest", "onStage": true }
            ],
            "shown": { "onStage": ["h", "g"], "screen": "h" }
        }))
        .unwrap();
        let input = show_stage_input(Some(&room));
        // k is on the runner's stage but not drawn; h isn't a runner
        // participant, so it stays as sent.
        assert_eq!(input.people, vec!["h".to_string(), "g".to_string()]);
        assert_eq!(input.screen.as_deref(), Some("h"));
        assert!(input.screens.is_empty());
        assert_eq!(input.on_stage.unwrap().len(), 3);
        assert_eq!(show_stage_input(None), StageInput::default());
    }

    #[test]
    fn js_rounding_and_even_match_the_page() {
        assert_eq!(js_round(5, 2), 3);
        assert_eq!(js_round(-5, 2), -2);
        assert_eq!(even(7), 6);
        assert_eq!(even(-3), -4);
        let canvas = StageCanvas {
            width: 1920,
            height: 1080,
        };
        assert_eq!(stage_gutter(canvas), 24);
        assert_eq!(stage_corner_radius(canvas), 20);
        assert_eq!(stage_plate_height(canvas), 44);
        assert_eq!(
            stage_rect_fraction(
                canvas,
                StageRect {
                    x: 960,
                    y: 540,
                    w: 480,
                    h: 270
                }
            ),
            [0.5, 0.5, 0.25, 0.25]
        );
    }
}
