//! The renderer's stage tests, ported one for one where they test maths
//! (`stage-transform.test.ts`, `stage-gesture.test.ts`,
//! `stage-corner.test.ts`, `stage-nudge.test.ts`, `stage-viewport.test.ts`,
//! `stage-undo-control.test.ts`, the pure half of `overlay-stage.test.ts`),
//! plus the two pieces the DOM did: what a press lands on and the draft's
//! wire.

use std::time::{Duration, Instant};

use serde_json::json;
use videorc_protocol::SceneSourceKind;

use super::*;

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 5e-3,
        "{actual} is not close to {expected}"
    );
}

fn close_rect(actual: StageRect, expected: StageRect) {
    close(actual.x, expected.x);
    close(actual.y, expected.y);
    close(actual.width, expected.width);
    close(actual.height, expected.height);
}

fn bx(x: f64, y: f64) -> StageRect {
    StageRect::new(x, y, 0.3, 0.3)
}

fn no_targets() -> SnapTargets {
    SnapTargets::default()
}

fn moved(
    start: StageRect,
    dx: f64,
    dy: f64,
    constrain: bool,
    snap: bool,
    targets: &SnapTargets,
) -> Ghost {
    move_ghost(MoveInput {
        start,
        dx,
        dy,
        constrain_axis: constrain,
        disable_snap: !snap,
        targets,
    })
}

fn resized(start: StageRect, handle: HandleId, dx: f64, dy: f64, lock: bool) -> StageRect {
    resize_ghost(ResizeInput {
        start,
        handle,
        dx,
        dy,
        lock_aspect: lock,
        canvas_width: None,
        canvas_height: None,
        min_fraction: None,
    })
    .rect
}

#[test]
fn the_snap_threshold_pins_the_backends() {
    assert_eq!(STAGE_SNAP_THRESHOLD, 0.015);
}

#[test]
fn a_move_follows_the_pointer_and_keeps_five_percent_covered() {
    let none = no_targets();
    let rect = moved(bx(0.2, 0.2), 0.1, -0.05, false, false, &none).rect;
    close_rect(rect, StageRect::new(0.3, 0.15, 0.3, 0.3));
    let off = moved(bx(0.6, 0.6), 0.9, 0.9, false, false, &none).rect;
    close(off.x, 0.95);
    close(off.y, 0.95);
    let left = moved(bx(0.2, 0.2), -0.9, -0.9, false, false, &none).rect;
    close(left.x, -0.25);
    close(left.y, -0.25);
    let full = moved(
        StageRect::new(0.0, 0.0, 1.0, 1.0),
        4.0,
        -4.0,
        false,
        false,
        &none,
    )
    .rect;
    close(full.x, 0.95);
    close(full.y, -0.95);
    let huge = moved(
        StageRect::new(-1.5, -1.5, 4.0, 4.0),
        -9.0,
        9.0,
        false,
        false,
        &none,
    )
    .rect;
    assert_eq!(huge.x, MIN_SOURCE_POSITION);
    close(huge.y, 0.95);
    let shifted = moved(bx(0.2, 0.2), 0.2, 0.04, true, false, &none).rect;
    close(shifted.x, 0.4);
    close(shifted.y, 0.2);
}

#[test]
fn the_legacy_magnet_snaps_edges_centres_and_siblings() {
    let canvas = stage_snap_targets(&[]);
    let edge = moved(bx(0.2, 0.4), -0.19, 0.0, false, true, &canvas);
    assert_eq!(edge.rect.x, 0.0);
    assert!(edge.guides.contains(&SnapGuide {
        axis: Axis::X,
        position: 0.0
    }));
    let centre = moved(
        StageRect::new(0.2, 0.2, 0.4, 0.4),
        0.11,
        0.0,
        false,
        true,
        &canvas,
    );
    close(centre.rect.x, 0.3);
    assert!(centre.guides.contains(&SnapGuide {
        axis: Axis::X,
        position: 0.5
    }));
    let sibling = stage_snap_targets(&[StageRect::new(0.6, 0.1, 0.3, 0.3)]);
    let beside = moved(bx(0.2, 0.1), 0.09, 0.0, false, true, &sibling);
    close(beside.rect.right(), 0.6);
    let alt = moved(bx(0.2, 0.4), -0.19, 0.0, false, false, &canvas);
    close(alt.rect.x, 0.01);
    assert!(alt.guides.is_empty());
    let far = moved(bx(0.2, 0.4), -0.1, 0.0, false, true, &canvas);
    close(far.rect.x, 0.1);
    assert!(far.guides.is_empty());
}

#[test]
fn a_free_resize_moves_the_named_edges() {
    close_rect(
        resized(bx(0.1, 0.1), HandleId::Se, 0.2, 0.1, false),
        StageRect::new(0.1, 0.1, 0.5, 0.4),
    );
    let nw = resized(bx(0.2, 0.2), HandleId::Nw, 0.1, 0.1, false);
    close_rect(nw, StageRect::new(0.3, 0.3, 0.2, 0.2));
    let east = resized(bx(0.2, 0.2), HandleId::E, 0.15, 0.4, false);
    close(east.width, 0.45);
    close(east.height, 0.3);
    let small = resized(bx(0.2, 0.2), HandleId::Se, -0.5, -0.5, false);
    close(small.width, MIN_SOURCE_FRACTION);
    close(small.height, MIN_SOURCE_FRACTION);
    let past = resized(bx(0.6, 0.6), HandleId::Se, 0.9, 0.9, false);
    close(past.right(), 1.8);
    let huge = resized(bx(0.1, 0.1), HandleId::Se, 9.0, 9.0, false);
    close(huge.width, MAX_SOURCE_FRACTION);
    let far = resized(
        StageRect::new(-1.5, -1.5, 2.0, 2.0),
        HandleId::Nw,
        -9.0,
        -9.0,
        false,
    );
    assert_eq!(far.x, MIN_SOURCE_POSITION);
    close(far.width, 3.5);
    let pulled_in = resized(
        StageRect::new(0.5, 0.2, 1.0, 0.3),
        HandleId::E,
        -9.0,
        0.0,
        false,
    );
    close(pulled_in.x, 0.5);
    close(pulled_in.width, MIN_SOURCE_FRACTION);
    let off = resized(
        StageRect::new(-0.5, 0.2, 1.0, 0.3),
        HandleId::W,
        9.0,
        0.0,
        false,
    );
    close(off.x, 0.45);
    close(off.right(), 0.5);
}

#[test]
fn a_locked_resize_keeps_the_aspect_and_its_anchor() {
    let corner = resized(
        StageRect::new(0.1, 0.1, 0.4, 0.2),
        HandleId::Se,
        0.2,
        0.0,
        true,
    );
    close_rect(corner, StageRect::new(0.1, 0.1, 0.56, 0.28));
    let edge = resized(
        StageRect::new(0.3, 0.4, 0.2, 0.2),
        HandleId::E,
        0.1,
        0.0,
        true,
    );
    close(edge.width, 0.3);
    close(edge.y + edge.height / 2.0, 0.5);
    let start = StageRect::new(0.5, 0.5, 0.4, 0.4);
    close_rect(
        resized(start, HandleId::Se, 0.5, 0.5, true),
        StageRect::new(0.5, 0.5, 0.9, 0.9),
    );
    let ceiling = resized(start, HandleId::Se, 9.0, 9.0, true);
    close(ceiling.width, MAX_SOURCE_FRACTION);
    let wide = resized(
        StageRect::new(0.4, 0.4, 0.2, 0.2),
        HandleId::E,
        9.0,
        0.0,
        true,
    );
    close(wide.width, MAX_SOURCE_FRACTION);
    close(wide.y + wide.height / 2.0, 0.5);
    let shrink = resized(
        StageRect::new(0.2, 0.2, 0.4, 0.2),
        HandleId::Nw,
        0.6,
        0.6,
        true,
    );
    close(shrink.height, MIN_SOURCE_FRACTION);
    close(shrink.width, MIN_SOURCE_FRACTION * 2.0);
    close(shrink.right(), 0.6);
    close(shrink.bottom(), 0.4);
    // Opposing corner deltas project continuously.
    let width = |dy: f64| resized(bx(0.3, 0.3), HandleId::Se, -0.1, dy, true).width;
    assert!((width(0.101) - width(0.099)).abs() < 0.002);
    // Every handle keeps its opposite anchor on a portrait canvas.
    for handle in HandleId::ALL {
        let start = StageRect::new(0.25, 0.25, 0.3, 0.3);
        let rect = resize_ghost(ResizeInput {
            start,
            handle,
            dx: 0.035,
            dy: -0.025,
            lock_aspect: true,
            canvas_width: Some(236.25),
            canvas_height: Some(420.0),
            min_fraction: None,
        })
        .rect;
        close(rect.width / rect.height, 1.0);
        let anchor = |r: StageRect| {
            let name = handle.as_str();
            (
                if name.contains('w') {
                    r.right()
                } else if name.contains('e') {
                    r.x
                } else {
                    r.x + r.width / 2.0
                },
                if name.contains('n') {
                    r.bottom()
                } else if name.contains('s') {
                    r.y
                } else {
                    r.y + r.height / 2.0
                },
            )
        };
        close(anchor(rect).0, anchor(start).0);
        close(anchor(rect).1, anchor(start).1);
    }
}

#[test]
fn the_selection_frame_helpers() {
    let points = stage_handle_points(StageRect::new(0.2, 0.2, 0.4, 0.2));
    assert_eq!(points.map(|(id, _, _)| id), HandleId::ALL);
    let se = points
        .iter()
        .find(|(id, _, _)| *id == HandleId::Se)
        .unwrap();
    assert_eq!((se.1, se.2), (0.6000000000000001, 0.4));
    assert_eq!(HandleId::Nw.cursor(), "nwse-resize");
    assert_eq!(HandleId::Sw.cursor(), "nesw-resize");
    assert_eq!(HandleId::N.cursor(), "ns-resize");
    assert_eq!(HandleId::W.cursor(), "ew-resize");
    assert_eq!(
        round_rect_for_commit(StageRect::new(0.123456, 0.6543219, 0.3333333, 0.1)),
        StageRect::new(0.1235, 0.6543, 0.3333, 0.1)
    );
    // Half up below zero too, as `Math.round` does.
    assert_eq!(
        round_rect_for_commit(StageRect::new(-0.12345, 0.0, 0.1, 0.1)).x,
        -0.1234
    );
    for handle in HandleId::ALL {
        assert_eq!(HandleId::parse(handle.as_str()), Some(handle));
    }
}

#[test]
fn the_mask_geometry_matches_the_compositor() {
    for (width, height) in [(160.0, 90.0), (90.0, 160.0)] {
        let rect = StageRect::new(0.2, 0.3, 0.4, 0.2);
        let SourceShape::Circle { cx, cy, r } =
            stage_source_shape(rect, width, height, "circle", 12.0)
        else {
            panic!("a circle mask is a circle");
        };
        close(cx, (rect.x + rect.width / 2.0) * width);
        close(cy, (rect.y + rect.height / 2.0) * height);
        close(r * 2.0, (rect.width * width).min(rect.height * height));
    }
    assert_eq!(
        stage_source_shape(
            StageRect::new(0.1, 0.2, 0.4, 0.2),
            160.0,
            90.0,
            "rounded",
            100.0
        ),
        SourceShape::Rect {
            x: 16.0,
            y: 18.0,
            width: 64.0,
            height: 18.0,
            rx: 9.0
        }
    );
}

#[test]
fn an_alt_edge_crops_and_what_stays_does_not_move() {
    let none = StageCrop::default();
    let start = StageRect::new(0.25, 0.25, 0.5, 0.5);
    let crop = |crop, handle, dx, dy| {
        crop_ghost(CropInput {
            start,
            crop,
            handle,
            dx,
            dy,
            min_fraction: None,
        })
    };
    let (ghost, next) = crop(none, HandleId::W, 0.1, 0.0);
    close(ghost.rect.x, 0.35);
    close(ghost.rect.width, 0.4);
    assert_eq!(ghost.rect.y, start.y);
    close(next.left, 0.2);
    let (east, east_crop) = crop(none, HandleId::E, -0.1, 0.0);
    assert_eq!(east.rect.x, start.x);
    close(east.rect.width, 0.4);
    close(east_crop.right, 0.2);
    let (_, corner) = crop(none, HandleId::Se, -0.05, -0.1);
    close(corner.right, 0.1);
    close(corner.bottom, 0.2);
    assert_eq!((corner.left, corner.top), (0.0, 0.0));
    let (back, back_crop) = crop_ghost(CropInput {
        start: StageRect::new(0.35, 0.25, 0.4, 0.5),
        crop: StageCrop { left: 0.2, ..none },
        handle: HandleId::W,
        dx: -0.3,
        dy: 0.0,
        min_fraction: None,
    });
    assert_eq!(back_crop.left, 0.0);
    close(back.rect.x, 0.25);
    close(back.rect.width, 0.5);
    let (same, same_crop) = crop(none, HandleId::N, 0.0, -0.2);
    assert_eq!(same.rect, start);
    assert_eq!(same_crop, none);
    let (most, most_crop) = crop(none, HandleId::W, 2.0, 0.0);
    assert!(1.0 - most_crop.left - most_crop.right >= MIN_CROP_KEPT - 1e-9);
    assert!(most.rect.width >= MIN_SOURCE_FRACTION - 1e-9);
    close(most.rect.right(), start.right());
}

#[allow(clippy::too_many_arguments)]
fn gesture(
    kind: GestureKind,
    start: StageRect,
    point: StagePoint,
    pixels: PixelSize,
    targets: SnapTargets,
    snap: bool,
    locked: bool,
    forced: bool,
    crop: Option<StageCrop>,
) -> StageGesture {
    StageGesture::new(GestureStart {
        source_id: "screen".into(),
        kind,
        start,
        point,
        pixels,
        targets,
        snap,
        locked,
        forced,
        crop,
    })
}

const PLAIN: Modifiers = Modifiers {
    shift: false,
    alt: false,
};

fn pt(x: f64, y: f64) -> StagePoint {
    StagePoint { x, y }
}

#[test]
fn a_move_follows_one_to_one_with_snap_off() {
    let rect = bx(0.3, 0.3);
    for pixels in [
        PixelSize {
            width: 480.0,
            height: 270.0,
        },
        PixelSize {
            width: 236.25,
            height: 420.0,
        },
    ] {
        let mut drag = gesture(
            GestureKind::Move,
            rect,
            pt(0.35, 0.35),
            pixels,
            stage_snap_targets(&[]),
            false,
            true,
            false,
            None,
        );
        let next = drag.sample(
            pt(0.35 + 17.0 / pixels.width, 0.35 + 9.0 / pixels.height),
            PLAIN,
        );
        close((next.rect.x - rect.x) * pixels.width, 17.0);
        close((next.rect.y - rect.y) * pixels.height, 9.0);
        assert!(next.guides.is_empty());
    }
}

#[test]
fn shift_latches_an_axis_in_points() {
    let shift = Modifiers {
        shift: true,
        alt: false,
    };
    let mut drag = gesture(
        GestureKind::Move,
        bx(0.3, 0.3),
        pt(0.0, 0.0),
        PixelSize {
            width: 480.0,
            height: 270.0,
        },
        no_targets(),
        false,
        true,
        false,
        None,
    );
    drag.sample(pt(0.0, 0.0), shift);
    assert_eq!(drag.sample(pt(0.02, 0.03), shift).rect.y, 0.3);
    assert_eq!(drag.sample(pt(0.02, 0.1), shift).rect.y, 0.3);
}

#[test]
fn a_magnet_holds_under_noise_and_lets_go_smoothly() {
    let pixels = PixelSize {
        width: 500.0,
        height: 500.0,
    };
    let targets = SnapTargets {
        x: vec![0.2],
        y: vec![],
    };
    let mut drag = gesture(
        GestureKind::Move,
        StageRect::new(0.1, 0.3, 0.3, 0.3),
        pt(0.0, 0.0),
        pixels,
        targets,
        true,
        true,
        false,
        None,
    );
    let mut sample = |x: f64| drag.sample(pt(x, 0.0), PLAIN).rect.x;
    close(sample(0.092), 0.2);
    for x in [0.101, 0.099, 0.101, 0.099] {
        close(sample(x), 0.2);
    }
    let positions: Vec<f64> = (0..31).map(|i| sample(0.1 + i as f64 * 0.002)).collect();
    assert!(*positions.last().unwrap() > 0.23);
    for pair in positions.windows(2) {
        assert!((pair[1] - pair[0]).abs() * 500.0 <= 1.001);
    }
}

#[test]
fn two_magnets_side_by_side_never_trade_the_box() {
    let pixels = PixelSize {
        width: 500.0,
        height: 500.0,
    };
    let start = StageRect::new(0.2, 0.3, 0.6, 0.3);
    let mut drag = gesture(
        GestureKind::Move,
        start,
        pt(0.0, 0.0),
        pixels,
        SnapTargets {
            x: vec![0.5, 0.798],
            y: vec![],
        },
        true,
        true,
        true,
        None,
    );
    let positions: Vec<f64> = (0..81)
        .map(|i| drag.sample(pt(i as f64 / pixels.width, 0.0), PLAIN).rect.x)
        .collect();
    for pair in positions.windows(2) {
        assert!(pair[1] >= pair[0] - 1e-9);
        assert!((pair[1] - pair[0]) * pixels.width <= 1.001);
    }
    close((positions[80] - start.x) * pixels.width, 70.0);
}

#[test]
fn alt_rebases_when_it_releases_the_magnet() {
    let pixels = PixelSize {
        width: 500.0,
        height: 500.0,
    };
    let alt = Modifiers {
        shift: false,
        alt: true,
    };
    let targets = SnapTargets {
        x: vec![0.2],
        y: vec![],
    };
    let mut drag = gesture(
        GestureKind::Move,
        StageRect::new(0.1, 0.3, 0.3, 0.3),
        pt(0.0, 0.0),
        pixels,
        targets.clone(),
        true,
        true,
        false,
        None,
    );
    let held = drag.sample(pt(0.092, 0.0), PLAIN);
    let bypass = drag.sample(pt(0.092, 0.0), alt);
    assert_eq!(bypass.rect, held.rect);
    assert!(bypass.guides.is_empty());
    close(drag.sample(pt(0.094, 0.0), alt).rect.x, 0.202);
    let mut looped = gesture(
        GestureKind::Move,
        StageRect::new(0.1, 0.3, 0.3, 0.3),
        pt(0.0, 0.0),
        pixels,
        targets,
        true,
        true,
        false,
        None,
    );
    looped.sample(pt(0.092, 0.0), PLAIN);
    looped.sample(pt(0.092, 0.0), alt);
    let end = looped.sample(pt(0.0, 0.0), alt);
    close(end.rect.x, 0.108);
    assert_ne!(end.rect.x, 0.1);
}

#[test]
fn the_aspect_choice_is_shared_and_a_forced_shape_wins() {
    let sample = |locked: bool, forced: bool| {
        gesture(
            GestureKind::Handle(HandleId::Se),
            bx(0.3, 0.3),
            pt(0.0, 0.0),
            PixelSize {
                width: 480.0,
                height: 270.0,
            },
            no_targets(),
            false,
            locked,
            forced,
            None,
        )
        .sample(pt(0.1, 0.0), PLAIN)
        .rect
    };
    close(sample(false, false).width, 0.4);
    close(sample(false, false).height, 0.3);
    close(sample(true, false).width / sample(true, false).height, 1.0);
    close(sample(false, true).width / sample(false, true).height, 1.0);
}

#[test]
fn handles_thin_out_on_small_boxes() {
    assert_eq!(visible_stage_handles(15.0, 30.0), &[HandleId::Se]);
    assert_eq!(
        visible_stage_handles(30.0, 30.0),
        &[HandleId::Nw, HandleId::Ne, HandleId::Se, HandleId::Sw]
    );
    assert_eq!(visible_stage_handles(60.0, 60.0).len(), 8);
    for (width, height) in [(160.0, 90.0), (90.0, 160.0)] {
        let (w, h) = (width * 0.05, height * 0.05);
        let offset = stage_handle_offset(w, h);
        assert_eq!(visible_stage_handles(w, h), &[HandleId::Se]);
        for x in [0.0, width - w] {
            for y in [0.0, height - h] {
                let (hx, hy) = (x + w + offset - 12.0, y + h + offset - 12.0);
                assert!(hx >= x + w && hy >= y + h);
                assert!(hx + 24.0 <= width + 28.0 && hy + 24.0 <= height + 28.0);
            }
        }
    }
}

#[test]
fn an_alt_edge_gesture_crops_and_a_move_never_does() {
    let rect = bx(0.3, 0.3);
    let crop = StageCrop {
        left: 0.1,
        ..StageCrop::default()
    };
    let pixels = PixelSize {
        width: 1000.0,
        height: 562.0,
    };
    let mut cropping = gesture(
        GestureKind::Handle(HandleId::W),
        rect,
        pt(0.3, 0.45),
        pixels,
        no_targets(),
        false,
        false,
        false,
        Some(crop),
    );
    close(cropping.sample(pt(0.36, 0.45), PLAIN).rect.x, 0.36);
    close(cropping.crop.unwrap().left, 0.1 + 0.06 * (0.9 / 0.3));
    let mut resizing = gesture(
        GestureKind::Handle(HandleId::W),
        rect,
        pt(0.3, 0.45),
        pixels,
        no_targets(),
        false,
        false,
        false,
        None,
    );
    resizing.sample(pt(0.36, 0.45), PLAIN);
    assert!(resizing.crop.is_none());
    let moving = gesture(
        GestureKind::Move,
        rect,
        pt(0.4, 0.4),
        pixels,
        no_targets(),
        false,
        false,
        false,
        Some(crop),
    );
    assert!(moving.crop.is_none());
}

#[test]
fn a_box_that_is_its_picture_keeps_its_shape_and_crops_exactly() {
    let canvas = PixelSize {
        width: 2560.0,
        height: 1440.0,
    };
    let macbook = PixelSize {
        width: 2228.0,
        height: 1440.0,
    };
    let picture = StageRect::new(
        389.0 / 2560.0,
        134.0 / 1440.0,
        2021.0 / 2560.0,
        1306.0 / 1440.0,
    );
    let pixels = PixelSize {
        width: 800.0,
        height: 450.0,
    };
    let corner = pt(picture.right(), picture.bottom());
    let aspect = |r: StageRect| (r.width * canvas.width) / (r.height * canvas.height);
    let mut pull = gesture(
        GestureKind::Handle(HandleId::Se),
        picture,
        corner,
        pixels,
        no_targets(),
        false,
        false,
        true,
        None,
    );
    let pulled = pull.sample(pt(corner.x + 0.1, corner.y - 0.02), PLAIN).rect;
    assert!((aspect(pulled) - aspect(picture)).abs() < 1e-6);
    let shifted = pull
        .sample(
            pt(corner.x + 0.12, corner.y),
            Modifiers {
                shift: true,
                alt: false,
            },
        )
        .rect;
    assert!((aspect(shifted) - aspect(picture)).abs() < 1e-6);
    assert!((shifted.x - picture.x).abs() < 1e-6);
    let west = pt(picture.x, picture.y + picture.height / 2.0);
    let mut crop = gesture(
        GestureKind::Handle(HandleId::W),
        picture,
        west,
        pixels,
        no_targets(),
        false,
        true,
        true,
        Some(StageCrop::default()),
    );
    let released = crop.sample(
        pt(west.x + 0.1, west.y),
        Modifiers {
            shift: false,
            alt: true,
        },
    );
    let cropped = crop.crop.unwrap();
    assert!((cropped.left - 0.1 / picture.width).abs() < 1e-6);
    let refit = scene_picture_rect(PictureInput {
        frame: released.rect,
        kind: &SceneSourceKind::Screen,
        fit: PictureFit::Contain,
        source: Some(macbook),
        crop: cropped,
        stage_margin: 0.0,
        camera_on_stage: false,
        canvas,
    });
    assert!((refit.x - released.rect.x).abs() * canvas.width <= 1.0);
    assert!((refit.width - released.rect.width).abs() * canvas.width <= 1.0);
    assert!((refit.height - released.rect.height).abs() * canvas.height <= 1.0);
}

fn outcome(rect: StageRect) -> CommitOutcome {
    CommitOutcome {
        applied: true,
        scene_id: "scene".into(),
        sources: vec![("screen".into(), rect)],
    }
}

#[test]
fn a_released_rect_stays_until_the_scene_shows_it() {
    let rect = bx(0.3, 0.3);
    let next = StageRect { x: 0.46, ..rect };
    let mut edits = StageEdits::default();
    edits.observe(Some(outcome(rect)));
    let ticket = edits.submit("screen", next, None);
    assert_eq!(edits.draft.as_ref().unwrap().rect, next);
    assert_eq!(
        edits.settle(&ticket, Some(outcome(next))),
        Settled::Acknowledged
    );
    assert_eq!(edits.draft.as_ref().unwrap().rect.x, next.x);
    assert!(edits.observe(Some(outcome(next))));
    assert!(edits.draft.is_none());
}

#[test]
fn two_quick_releases_settle_in_order_and_the_older_ack_never_clears_the_newer() {
    let rect = bx(0.3, 0.3);
    let (a, b) = (StageRect { x: 0.4, ..rect }, StageRect { x: 0.5, ..rect });
    let mut edits = StageEdits::default();
    edits.observe(Some(outcome(rect)));
    let first = edits.submit("screen", a, None);
    let second = edits.submit("screen", b, None);
    assert_eq!(
        edits.settle(&first, Some(outcome(a))),
        Settled::Acknowledged
    );
    edits.observe(Some(outcome(a)));
    assert_eq!(edits.draft.as_ref().unwrap().rect, b);
    assert!(edits.current(&second));
    assert_eq!(
        edits.settle(&second, Some(outcome(b))),
        Settled::Acknowledged
    );
    edits.observe(Some(outcome(b)));
    assert!(edits.draft.is_none());
}

#[test]
fn a_refused_commit_drops_the_draft_and_the_queue_once() {
    let rect = bx(0.3, 0.3);
    let mut edits = StageEdits::default();
    edits.observe(Some(outcome(rect)));
    let first = edits.submit("screen", StageRect { x: 0.4, ..rect }, None);
    let second = edits.submit("screen", StageRect { x: 0.5, ..rect }, None);
    assert_eq!(edits.settle(&first, None), Settled::Failed);
    assert!(edits.draft.is_none());
    assert!(!edits.current(&second), "the queued release is not sent");
    // Another scene answering is a failure too.
    let mut other = StageEdits::default();
    other.observe(Some(outcome(rect)));
    let ticket = other.submit("screen", StageRect { x: 0.4, ..rect }, None);
    let replaced = CommitOutcome {
        scene_id: "replacement".into(),
        ..outcome(rect)
    };
    assert_eq!(other.settle(&ticket, Some(replaced)), Settled::Failed);
}

#[test]
fn a_replaced_scene_discards_a_stale_acknowledgement() {
    let rect = bx(0.3, 0.3);
    let mut edits = StageEdits::default();
    edits.observe(Some(outcome(rect)));
    let ticket = edits.submit("screen", StageRect { x: 0.4, ..rect }, None);
    edits.invalidate();
    edits.observe(Some(CommitOutcome {
        scene_id: "replacement".into(),
        ..outcome(rect)
    }));
    assert_eq!(
        edits.settle(&ticket, Some(outcome(StageRect { x: 0.4, ..rect }))),
        Settled::Stale
    );
    assert!(edits.draft.is_none());
}

#[test]
fn a_commit_carries_its_crop_rounded_like_the_box() {
    let rect = bx(0.3, 0.3);
    let mut edits = StageEdits::default();
    let ticket = edits.submit(
        "screen",
        StageRect {
            x: 0.36123456,
            ..rect
        },
        Some(StageCrop {
            left: 0.28123456,
            ..StageCrop::default()
        }),
    );
    assert_eq!(
        ticket.patch(),
        json!({"x": 0.3612, "y": 0.3, "width": 0.3, "height": 0.3, "cropLeft": 0.2812, "cropTop": 0.0, "cropRight": 0.0, "cropBottom": 0.0})
    );
    let plain = edits.submit("screen", rect, None);
    assert_eq!(
        plain.patch(),
        json!({"x": 0.3, "y": 0.3, "width": 0.3, "height": 0.3})
    );
}

#[test]
fn a_corner_drop_is_the_backends_preset_box() {
    assert_eq!(
        snap_corner_of(StageRect::new(0.02, 0.7, 0.25, 0.25)),
        Some(CameraCorner::BottomLeft)
    );
    assert_eq!(
        snap_corner_of(StageRect::new(0.7, 0.05, 0.26, 0.2)),
        Some(CameraCorner::TopRight)
    );
    assert_eq!(snap_corner_of(StageRect::new(0.3, 0.7, 0.25, 0.25)), None);
    assert_eq!(snap_corner_of(StageRect::new(0.02, 0.3, 0.25, 0.25)), None);
    let layout = |size: &str, shape: &str, aspect: &str, margin: f64| PresetCameraLayout {
        size: size.into(),
        shape: shape.into(),
        aspect: aspect.into(),
        margin,
    };
    let exact = |actual: StageRect, expected: StageRect| {
        assert!(
            (actual.x - expected.x).abs() < 1e-9,
            "{actual:?} {expected:?}"
        );
        assert!(
            (actual.y - expected.y).abs() < 1e-9,
            "{actual:?} {expected:?}"
        );
        assert!(
            (actual.width - expected.width).abs() < 1e-9,
            "{actual:?} {expected:?}"
        );
        assert!(
            (actual.height - expected.height).abs() < 1e-9,
            "{actual:?} {expected:?}"
        );
    };
    exact(
        preset_camera_corner_rect(
            &layout("medium", "rectangle", "source", 32.0),
            CameraCorner::BottomRight,
            1920.0,
            1080.0,
        ),
        StageRect::new(
            1332.0 / 1920.0,
            727.0 / 1080.0,
            540.0 / 1920.0,
            305.0 / 1080.0,
        ),
    );
    exact(
        preset_camera_corner_rect(
            &layout("small", "circle", "source", 32.0),
            CameraCorner::TopLeft,
            1080.0,
            1920.0,
        ),
        StageRect::new(27.0 / 1080.0, 27.0 / 1920.0, 219.0 / 1080.0, 219.0 / 1920.0),
    );
    exact(
        preset_camera_corner_rect(
            &layout("large", "rounded", "portrait", 500.0),
            CameraCorner::TopRight,
            1280.0,
            720.0,
        ),
        StageRect::new(640.0 / 1280.0, 160.0 / 720.0, 480.0 / 1280.0, 640.0 / 720.0),
    );
}

#[test]
fn the_arrows_nudge_and_nothing_else_does() {
    let none = KeyChord::default();
    assert_eq!(
        stage_nudge_for_key("ArrowUp", none),
        Some(StageNudge {
            direction_x: 0,
            direction_y: -1,
            large: false
        })
    );
    assert_eq!(
        stage_nudge_for_key(
            "ArrowRight",
            KeyChord {
                shift: true,
                ..none
            }
        ),
        Some(StageNudge {
            direction_x: 1,
            direction_y: 0,
            large: true
        })
    );
    assert_eq!(
        stage_nudge_for_key("ArrowLeft", none).unwrap().direction_x,
        -1
    );
    assert_eq!(
        stage_nudge_for_key("ArrowDown", none).unwrap().direction_y,
        1
    );
    assert_eq!(stage_nudge_for_key("a", none), None);
    assert_eq!(stage_nudge_for_key("Enter", none), None);
    for chord in [
        KeyChord { alt: true, ..none },
        KeyChord { meta: true, ..none },
        KeyChord { ctrl: true, ..none },
    ] {
        assert_eq!(stage_nudge_for_key("ArrowUp", chord), None);
    }
}

#[test]
fn undo_stays_shown_and_only_its_enabled_state_follows_the_stage() {
    for phase in [StagePhase::Idle, StagePhase::Dragging, StagePhase::Pending] {
        assert!(stage_undo_control(true, phase, false, false).0);
        assert!(!stage_undo_control(false, phase, false, false).0);
    }
    assert_eq!(
        stage_undo_control(true, StagePhase::Idle, false, false),
        (true, true)
    );
    assert_eq!(
        stage_undo_control(true, StagePhase::Dragging, false, false),
        (true, false)
    );
    assert_eq!(
        stage_undo_control(true, StagePhase::Idle, true, false),
        (true, false)
    );
    assert_eq!(
        stage_undo_control(true, StagePhase::Idle, false, true),
        (true, false)
    );
}

#[test]
fn the_canvas_mapping_tracks_points_and_refuses_a_broken_matrix() {
    for mapping in [
        StageMapping {
            a: 3.0,
            b: 0.0,
            c: 0.0,
            d: 3.0,
            e: 20.0,
            f: 40.0,
            width: 160.0,
            height: 90.0,
        },
        StageMapping {
            a: 1.4765625,
            b: 0.0,
            c: 0.0,
            d: 1.4765625,
            e: 142.0,
            f: 40.0,
            width: 160.0,
            height: 284.444444,
        },
    ] {
        let start = stage_point(mapping, 200.0, 160.0).unwrap();
        let next = stage_point(mapping, 231.0, 179.0).unwrap();
        let pixels = stage_pixel_size(mapping);
        close((next.x - start.x) * pixels.width, 31.0);
        close((next.y - start.y) * pixels.height, 19.0);
    }
    let rotated = StageMapping {
        a: 0.0,
        b: 2.0,
        c: -2.0,
        d: 0.0,
        e: 30.0,
        f: 50.0,
        width: 100.0,
        height: 100.0,
    };
    assert_eq!(stage_point(rotated, -70.0, 150.0), Some(pt(0.5, 0.5)));
    for value in [0.0, f64::NAN, f64::INFINITY] {
        let broken = StageMapping {
            a: value,
            ..StageMapping::of_rect(0.0, 0.0, 160.0, 90.0)
        };
        assert_eq!(stage_point(broken, 10.0, 10.0), None);
    }
    let slint = StageMapping::of_rect(100.0, 50.0, 320.0, 180.0);
    assert_eq!(stage_point(slint, 260.0, 140.0), Some(pt(0.5, 0.5)));
}

#[test]
fn the_picture_is_the_frame_on_the_stage_margin_and_fit() {
    let canvas = PixelSize {
        width: 1920.0,
        height: 1080.0,
    };
    let frame = StageRect::new(0.0, 0.0, 1.0, 1.0);
    let margin = background_stage_margin(Some(&json!({ "visibilityPercent": 20 })));
    close(margin, 0.1);
    assert_eq!(
        background_stage_margin(Some(&json!({ "visibilityPercent": 90 }))),
        0.2
    );
    assert_eq!(background_stage_margin(None), 0.0);
    let staged = scene_stage_rect(frame, &SceneSourceKind::Screen, margin, false);
    close_rect(staged, StageRect::new(0.1, 0.1, 0.8, 0.8));
    close_rect(
        scene_frame_rect(staged, &SceneSourceKind::Screen, margin, false),
        frame,
    );
    // A camera sits on the stage margin only when the scene stages it
    // (#1353, plan 235 D9 a).
    assert_eq!(
        scene_stage_rect(frame, &SceneSourceKind::Camera, margin, false),
        frame
    );
    close_rect(
        scene_stage_rect(frame, &SceneSourceKind::Camera, margin, true),
        StageRect::new(0.1, 0.1, 0.8, 0.8),
    );
    // Fit with a known size: the picture is the contained box.
    let picture = scene_picture_rect(PictureInput {
        frame,
        kind: &SceneSourceKind::Screen,
        fit: PictureFit::Contain,
        source: Some(PixelSize {
            width: 1000.0,
            height: 1000.0,
        }),
        crop: StageCrop::default(),
        stage_margin: 0.0,
        camera_on_stage: false,
        canvas,
    });
    close_rect(
        picture,
        StageRect::new(420.0 / 1920.0, 0.0, 1080.0 / 1920.0, 1.0),
    );
    assert!(screen_box_is_picture(
        &SceneSourceKind::Screen,
        PictureFit::Contain,
        Some(PixelSize {
            width: 1.0,
            height: 1.0
        })
    ));
    assert!(!screen_box_is_picture(
        &SceneSourceKind::Camera,
        PictureFit::Contain,
        Some(PixelSize {
            width: 1.0,
            height: 1.0
        })
    ));
    assert!(!screen_box_is_picture(
        &SceneSourceKind::Screen,
        PictureFit::Contain,
        None
    ));
    // The test pattern always fills its frame.
    let pattern = scene_picture_rect(PictureInput {
        frame,
        kind: &SceneSourceKind::TestPattern,
        fit: PictureFit::Contain,
        source: Some(PixelSize {
            width: 1000.0,
            height: 1000.0,
        }),
        crop: StageCrop::default(),
        stage_margin: 0.0,
        camera_on_stage: false,
        canvas,
    });
    assert_eq!(pattern, frame);
}

#[test]
fn the_layer_fit_and_the_mask_follow_the_layout() {
    let camera = SceneSourceKind::Camera;
    let screen = SceneSourceKind::Screen;
    assert_eq!(
        layer_fit(&camera, &json!({"layoutPreset": "vertical-split"})),
        PictureFit::Cover
    );
    assert_eq!(
        layer_fit(&camera, &json!({"cameraFit": "fit", "cameraZoom": 100})),
        PictureFit::Contain
    );
    assert_eq!(
        layer_fit(&camera, &json!({"cameraFit": "fit", "cameraZoom": 150})),
        PictureFit::Cover
    );
    assert_eq!(
        layer_fit(&screen, &json!({"layoutPreset": "screen-camera"})),
        PictureFit::Contain
    );
    assert_eq!(
        layer_fit(&screen, &json!({"layoutPreset": "side-by-side"})),
        PictureFit::Cover
    );
    assert_eq!(
        layer_fit(
            &screen,
            &json!({"layoutPreset": "screen-only", "horizontalScreenFraming": "fill"})
        ),
        PictureFit::Cover
    );
    assert_eq!(
        layer_fit(
            &screen,
            &json!({"layoutPreset": "vertical-screen-only", "verticalScreenFraming": "fit"})
        ),
        PictureFit::Contain
    );
    assert_eq!(
        effective_camera_mask_shape(
            &json!({"layoutPreset": "screen-camera", "cameraShape": "circle"})
        ),
        "circle"
    );
    assert_eq!(
        effective_camera_mask_shape(
            &json!({"layoutPreset": "side-by-side", "cameraShape": "circle"})
        ),
        "rectangle"
    );
    assert_eq!(
        effective_camera_mask_shape(
            &json!({"layoutPreset": "side-by-side", "arrangementMode": "freeform", "cameraShape": "circle"})
        ),
        "circle"
    );
}

#[test]
fn the_overlay_items_ids_badges_and_the_buddys_square() {
    for item in OVERLAY_ITEMS {
        assert_eq!(
            overlay_item_from_stage_id(&overlay_stage_id(item)),
            Some(item)
        );
    }
    assert_eq!(overlay_item_from_stage_id("overlay:nope"), None);
    assert_eq!(overlay_stage_id("buddy"), "overlay:buddy");
    assert_eq!(banner_stage_id("abc"), "banner:abc");
    assert_eq!(banner_id_from_stage_id("banner:abc"), Some("abc"));
    assert_eq!(banner_id_from_stage_id("banner:"), None);
    assert_eq!(output_badge(true, false), Some(StageItemBadge::StreamOnly));
    assert_eq!(
        output_badge(false, true),
        Some(StageItemBadge::RecordingOnly)
    );
    assert_eq!(output_badge(true, true), None);
    assert_eq!(StageItemBadge::RecordingOnly.label(), "Recording only");
    let landscape = 16.0 / 9.0;
    close_rect(
        buddy_pet_box(StageRect::new(0.78, 0.6, 0.18, 0.36), landscape),
        StageRect::new(0.78, 0.64, 0.18, 0.32),
    );
    close_rect(
        buddy_pet_box(StageRect::new(0.02, 0.04, 0.18, 0.2), landscape),
        StageRect::new(0.02, 0.04, 0.18, 0.32),
    );
    close_rect(
        buddy_pet_box(StageRect::new(0.95, 0.8, 0.18, 0.2), landscape),
        StageRect::new(0.82, 0.68, 0.18, 0.32),
    );
    close_rect(
        buddy_pet_box(StageRect::new(0.0, 0.5, 1.0, 0.5), 9.0 / 16.0),
        StageRect::new(0.0, 0.4375, 1.0, 0.5625),
    );
    // A square logo in a wider place hugs the place's right edge.
    assert_eq!(
        banner_fit_rect(
            (512.0, 512.0),
            StageRect::new(0.5, 0.04, 0.48, 0.2),
            landscape,
            false
        ),
        StageRect::new(0.8675, 0.04, 0.1125, 0.2)
    );
    assert!(banner_fills_canvas(StageRect::new(0.0, 0.0, 1.0, 0.95)));
    assert!(!banner_fills_canvas(StageRect::new(0.0, 0.0, 0.5, 0.5)));
    assert_eq!(
        clamp_overlay_rect(StageRect::new(0.9, -0.2, 0.3, 0.001)),
        StageRect::new(0.7, 0.0, 0.3, MIN_OVERLAY_SIZE)
    );
}

#[test]
fn a_press_lands_on_the_handles_then_the_items_then_the_sources() {
    let canvas = PixelSize {
        width: 640.0,
        height: 360.0,
    };
    let screen = HitTarget {
        id: "screen".into(),
        rect: StageRect::new(0.0, 0.0, 1.0, 1.0),
        item: false,
        body: true,
        picture: None,
    };
    let camera = HitTarget {
        id: "camera".into(),
        rect: StageRect::new(0.7, 0.6, 0.25, 0.3),
        ..screen.clone()
    };
    let buddy = HitTarget {
        id: "overlay:buddy".into(),
        rect: StageRect::new(0.0, 0.5, 0.25, 0.5),
        item: true,
        body: false,
        picture: None,
    };
    let targets = vec![screen.clone(), camera.clone(), buddy.clone()];
    let at = |x: f64, y: f64| (x * canvas.width, y * canvas.height);
    // The camera sits over the screen.
    assert_eq!(
        stage_hit(at(0.8, 0.7), canvas, None, None, &targets),
        Some(StageHit::Target("camera".into()))
    );
    assert_eq!(
        stage_hit(at(0.3, 0.3), canvas, None, None, &targets),
        Some(StageHit::Target("screen".into()))
    );
    // An unselected overlay item takes the pointer on its chip only.
    assert_eq!(
        stage_hit((4.0, 0.5 * 360.0 + 4.0), canvas, None, None, &targets),
        Some(StageHit::Target("overlay:buddy".into()))
    );
    assert_eq!(
        stage_hit(at(0.1, 0.8), canvas, None, None, &targets),
        Some(StageHit::Target("screen".into()))
    );
    // Selected, its body and its outline grab it.
    assert_eq!(
        stage_hit(at(0.1, 0.8), canvas, None, Some("overlay:buddy"), &targets),
        Some(StageHit::Target("overlay:buddy".into()))
    );
    // The selection's handles come first, even past the canvas's edge.
    let selection = SelectionHit {
        rect: camera.rect,
        handles: visible_stage_handles(160.0, 108.0).to_vec(),
        offset: 0.0,
    };
    assert_eq!(
        stage_hit(
            at(0.95, 0.9),
            canvas,
            Some(&selection),
            Some("camera"),
            &targets
        ),
        Some(StageHit::Handle(HandleId::Se))
    );
    assert_eq!(
        stage_hit(
            (-40.0, -40.0),
            canvas,
            Some(&selection),
            Some("camera"),
            &targets
        ),
        None
    );
}

#[test]
fn the_draft_wire_is_latest_wins_one_in_flight_with_a_heartbeat() {
    let t0 = Instant::now();
    let mut channel = DraftChannel::default();
    assert_eq!(
        channel.next(t0),
        None,
        "nothing wanted, nothing on the wire"
    );
    let first = draft_params("screen", StageRect::new(0.1, 0.1, 0.3, 0.3), None);
    channel.want(DraftWanted::Gesture(first.clone()));
    let send = channel.next(t0).unwrap();
    assert_eq!(send, DraftSend::Set(first.clone()));
    // A newer frame waits for the wire.
    let second = draft_params("screen", StageRect::new(0.2, 0.1, 0.3, 0.3), None);
    channel.want(DraftWanted::Gesture(second.clone()));
    assert_eq!(channel.next(t0), None);
    channel.finished(&send, Ok(()), t0);
    let send = channel.next(t0).unwrap();
    assert_eq!(send, DraftSend::Set(second.clone()));
    channel.finished(&send, Ok(()), t0);
    // Unchanged: quiet until the heartbeat.
    assert_eq!(channel.next(t0 + Duration::from_millis(100)), None);
    assert_eq!(channel.next_due(), Some(t0 + EDITOR_DRAFT_HEARTBEAT));
    let beat = channel.next(t0 + EDITOR_DRAFT_HEARTBEAT).unwrap();
    assert_eq!(beat, DraftSend::Set(second));
    channel.finished(&beat, Ok(()), t0 + EDITOR_DRAFT_HEARTBEAT);
    // The release goes once and is never repeated.
    let released = draft_params("screen", StageRect::new(0.25, 0.1, 0.3, 0.3), None);
    channel.want(DraftWanted::Released(released.clone()));
    let send = channel.next(t0).unwrap();
    assert_eq!(send, DraftSend::Set(released));
    channel.finished(&send, Ok(()), t0);
    assert_eq!(channel.next(t0 + Duration::from_secs(5)), None);
    assert_eq!(channel.next_due(), None);
    // Nothing wanted clears what is on the wire, once.
    channel.want(DraftWanted::None);
    let clear = channel.next(t0).unwrap();
    assert_eq!(clear, DraftSend::Clear);
    channel.finished(&clear, Ok(()), t0);
    assert_eq!(channel.next(t0), None);
}

#[test]
fn a_refused_draft_stops_its_owner_until_a_new_one() {
    let t0 = Instant::now();
    let mut channel = DraftChannel::default();
    channel.want(DraftWanted::Gesture(draft_params(
        "screen",
        StageRect::new(0.1, 0.1, 0.3, 0.3),
        None,
    )));
    let send = channel.next(t0).unwrap();
    channel.finished(&send, Err(true), t0);
    assert!(channel.refused());
    channel.want(DraftWanted::Gesture(draft_params(
        "screen",
        StageRect::new(0.2, 0.1, 0.3, 0.3),
        None,
    )));
    assert_eq!(channel.next(t0), None, "the same gesture stays refused");
    channel.want(DraftWanted::Hold(hold_params("camera")));
    assert!(
        matches!(channel.next(t0), Some(DraftSend::Set(_))),
        "a new owner tries again"
    );
}

#[test]
fn the_texture_routes_draft_carries_no_chrome_the_compositor_draws() {
    let params = draft_params(
        "screen",
        StageRect::new(0.1, 0.2, 0.3, 0.4),
        Some(StageCrop {
            left: 0.1,
            ..StageCrop::default()
        }),
    );
    assert_eq!(
        params["transform"],
        json!({"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4})
    );
    assert_eq!(params["crop"]["cropLeft"], json!(0.1));
    assert_eq!(params["chrome"]["handles"], json!(false));
    assert_eq!(params["chrome"]["guides"], json!([]));
    assert_eq!(params["chrome"]["selected"]["width"], json!(0.0));
    // The wire's own type takes it.
    let typed: videorc_protocol::SceneEditorDraftParams = serde_json::from_value(params).unwrap();
    assert!(typed.transform.is_some());
    let hold: videorc_protocol::SceneEditorDraftParams =
        serde_json::from_value(hold_params("overlay:buddy")).unwrap();
    assert!(hold.transform.is_none());
}

#[test]
fn only_a_camera_only_unkeyed_preset_scene_stages_its_camera() {
    use SceneSourceKind::{Camera, Screen, TestPattern, Window};
    assert!(scene_camera_uses_background_stage(&[Camera], false, false));
    assert!(scene_camera_uses_background_stage(
        &[Camera, Camera],
        false,
        false
    ));
    // Over or beside a screen (hidden ones count too): it keeps its place.
    assert!(!scene_camera_uses_background_stage(
        &[Camera, Screen],
        false,
        false
    ));
    assert!(!scene_camera_uses_background_stage(
        &[Window, Camera],
        false,
        false
    ));
    // Keyed, Freeform, or no camera at all: never.
    assert!(!scene_camera_uses_background_stage(&[Camera], true, false));
    assert!(!scene_camera_uses_background_stage(&[Camera], false, true));
    assert!(!scene_camera_uses_background_stage(
        &[TestPattern],
        false,
        false
    ));
    assert!(!scene_camera_uses_background_stage(&[], false, false));
    assert!(scene_camera_on_stage(
        &[Camera],
        &json!({"arrangementMode": "preset"})
    ));
    assert!(!scene_camera_on_stage(
        &[Camera],
        &json!({"cameraChromaKeyEnabled": true})
    ));
    assert!(!scene_camera_on_stage(
        &[Camera],
        &json!({"arrangementMode": "freeform"})
    ));
    // The preview surface's layers.
    assert!(preview_surface_layer_uses_background_stage(
        SurfaceLayer::ScreenImage,
        false
    ));
    assert!(!preview_surface_layer_uses_background_stage(
        SurfaceLayer::Background,
        true
    ));
    assert!(!preview_surface_layer_uses_background_stage(
        SurfaceLayer::Banner,
        true
    ));
    assert!(!preview_surface_layer_uses_background_stage(
        SurfaceLayer::Buddy,
        true
    ));
    assert!(preview_surface_layer_uses_background_stage(
        SurfaceLayer::Source(&Camera),
        true
    ));
    assert!(!preview_surface_layer_uses_background_stage(
        SurfaceLayer::Source(&Camera),
        false
    ));
}

#[test]
fn a_canvas_without_the_picture_says_where_it_is() {
    use super::super::stage_copy::{
        LayoutOnlyAction, layout_only_note, live_canvas_supported, stage_layout_only_note,
    };
    let docked = stage_layout_only_note(true, true);
    assert_eq!(
        docked.text,
        "Layout only. The Preview is stuck to the Studio panel."
    );
    assert_eq!(docked.action_label, "Pop out Preview");
    assert_eq!(docked.action, LayoutOnlyAction::PopOut);
    let floating = stage_layout_only_note(true, false);
    assert_eq!(floating.text, "Layout only. The picture is in the Preview.");
    assert_eq!(floating.action_label, "Show Preview");
    assert_eq!(
        stage_layout_only_note(false, true).action_label,
        "Open Preview"
    );
    assert!(live_canvas_supported(true, Some("darwin")));
    assert!(live_canvas_supported(true, Some("linux")));
    assert!(!live_canvas_supported(true, Some("win32")));
    assert!(!live_canvas_supported(false, Some("darwin")));
    assert_eq!(layout_only_note(true, false, true, true), None);
    assert_eq!(layout_only_note(false, true, true, true), None);
    assert!(layout_only_note(false, false, false, false).is_some());
    assert_eq!(
        super::super::stage_copy::overlay_item_label("buddy"),
        "Avatar"
    );
}
