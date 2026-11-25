use super::*;

fn parts(areas: &[ThumbArea]) -> Vec<ThumbPart> {
    areas.iter().map(|area| area.part).collect()
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 0.01
}

#[test]
fn a_card_frame_fills_the_width_or_stands_in_a_four_by_three_well() {
    let wide = card_frame(false, 160.);
    assert_eq!((wide.width, wide.height), (160., 90.));
    assert_eq!(wide.corner, ThumbCorner::Chip);
    assert!(!wide.strong_border);

    let tall = card_frame(true, 160.);
    assert!(close(tall.height, 112.));
    assert!(close(tall.width, 63.));
}

#[test]
fn a_row_frame_fills_its_well_and_a_vertical_one_stands_at_its_height() {
    let wide = row_frame(false, 24.);
    assert!(close(wide.width, 42.67));
    assert_eq!(wide.height, 24.);
    assert_eq!(wide.corner, ThumbCorner::Area);
    assert!(wide.strong_border);

    let tall = row_frame(true, 24.);
    assert_eq!((tall.width, tall.height), (13.5, 24.));
    assert_eq!(tall.corner, ThumbCorner::Chip);
}

#[test]
fn screen_camera_puts_the_camera_in_the_corner_with_its_rim() {
    let areas = thumb_areas("screen-camera", false, ThumbSize::Card, 160., 90.);
    assert_eq!(parts(&areas), [ThumbPart::Screen, ThumbPart::Camera]);
    assert_eq!(
        (areas[0].left, areas[0].top, areas[0].width, areas[0].height),
        (6., 6., 148., 78.)
    );
    let camera = areas[1];
    assert!(close(camera.width, 48.) && close(camera.height, 36.));
    assert!(close(camera.left, 106.) && close(camera.top, 48.));
    assert_eq!(camera.corner, ThumbCorner::Tight);
    assert!(camera.rim && camera.glyph && !camera.strong);
}

#[test]
fn at_icon_size_the_areas_are_stronger_thinner_and_have_no_glyphs() {
    let areas = thumb_areas("screen-camera", false, ThumbSize::Compact, 42., 24.);
    assert_eq!(
        (areas[0].left, areas[0].top, areas[0].width, areas[0].height),
        (2., 2., 38., 20.)
    );
    let camera = areas[1];
    assert!(close(camera.width, 14.28) && close(camera.height, 12.));
    assert!(close(camera.left, 24.72) && close(camera.top, 9.));
    assert!(!camera.rim);
    assert!(areas.iter().all(|area| area.strong && !area.glyph));
    assert!(areas.iter().all(|area| area.corner == ThumbCorner::Hair));
}

#[test]
fn side_by_side_and_camera_only_share_the_frame() {
    let sides = thumb_areas("side-by-side", false, ThumbSize::Card, 160., 90.);
    assert_eq!(parts(&sides), [ThumbPart::Screen, ThumbPart::Camera]);
    assert!(close(sides[0].width, 70.4));
    assert!(close(sides[1].left + sides[1].width, 154.));

    let camera = thumb_areas("camera-only", false, ThumbSize::Card, 160., 90.);
    assert_eq!(parts(&camera), [ThumbPart::Camera]);
    assert_eq!((camera[0].left, camera[0].width), (40., 80.));
}

#[test]
fn fit_keeps_the_screen_small_in_nine_by_sixteen() {
    let fill = thumb_areas("vertical-camera-top", false, ThumbSize::Card, 90., 160.);
    assert_eq!(parts(&fill), [ThumbPart::Camera, ThumbPart::Screen]);
    assert!(close(fill[1].height, 88.));

    let fit = thumb_areas("vertical-camera-top", true, ThumbSize::Card, 90., 160.);
    assert!(close(fit[0].height, 99.2));
    assert!(close(fit[1].height, 48.));
    assert!(close(fit[1].top + fit[1].height, 156.));
}

#[test]
fn a_split_in_fit_draws_as_camera_bottom() {
    let split = thumb_areas("vertical-split", true, ThumbSize::Card, 90., 160.);
    let bottom = thumb_areas("vertical-camera-bottom", true, ThumbSize::Card, 90., 160.);
    assert_eq!(split, bottom);

    let fill = thumb_areas("vertical-split", false, ThumbSize::Card, 90., 160.);
    assert_eq!(parts(&fill), [ThumbPart::Screen, ThumbPart::Camera]);
    assert!(close(fill[0].height, 73.6) && close(fill[1].height, 73.6));
}

#[test]
fn a_vertical_screen_camera_keeps_its_rim_even_at_icon_size() {
    let areas = thumb_areas(
        "vertical-screen-camera",
        true,
        ThumbSize::Compact,
        13.5,
        24.,
    );
    assert_eq!(parts(&areas), [ThumbPart::Screen, ThumbPart::Camera]);
    assert!(close(areas[0].top, 8.4) && close(areas[0].height, 7.2));
    assert!(areas[1].rim);
    assert_eq!(areas[1].corner, ThumbCorner::Hair);
}

#[test]
fn an_unknown_preset_draws_only_the_frame() {
    assert!(thumb_areas("freeform", false, ThumbSize::Card, 160., 90.).is_empty());
    assert!(thumb_areas("vertical-unknown", false, ThumbSize::Card, 90., 160.).is_empty());
}
