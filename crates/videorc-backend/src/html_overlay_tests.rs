//! Plan 231: the import, the frame wire, the frame store, the targets and
//! the status of HTML overlays.

use super::*;
use crate::overlay_layout::OverlayRect;
use crate::test_temp_dir::TestTempDir;

const BADGE_PAGE: &str = r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="videorc-overlay-size" content="640x360" />
  </head>
  <body></body>
</html>"#;

fn temp_dir(label: &str) -> TestTempDir {
    TestTempDir::new(&format!("html-overlay-{label}"))
}

fn test_database(dir: &Path) -> Database {
    Database::open_file_for_tests(&dir.join("videorc.sqlite3"))
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// A folder overlay: the page, a stylesheet, an image in a subfolder and a
/// dot file that must be left behind.
fn badge_folder(dir: &Path) -> PathBuf {
    let folder = dir.join("Animated badge");
    write(&folder.join("index.html"), BADGE_PAGE.as_bytes());
    write(&folder.join("style.css"), b"body{margin:0}");
    write(&folder.join("img/logo.png"), &[1, 2, 3, 4]);
    write(&folder.join(".DS_Store"), b"finder");
    folder
}

fn refusal(result: Result<impl std::fmt::Debug>) -> String {
    result.unwrap_err().to_string()
}

fn html_banner(id: &str, horizontal: OverlayRect, vertical: OverlayRect) -> Banner {
    Banner {
        id: id.to_string(),
        name: id.to_string(),
        kind: BannerKind::Html,
        image_file: format!("{id}.png"),
        thumbnail_file: format!("{id}.thumb.png"),
        width: 640,
        height: 360,
        has_alpha: true,
        sort_order: 0,
        shown: true,
        horizontal,
        vertical,
        show_on_stream: true,
        show_in_recording: true,
        opacity: 1.0,
        hide_after_sec: None,
        repeat_every_min: None,
        created_at: "2026-11-12T00:00:00Z".to_string(),
        updated_at: "2026-11-12T00:00:00Z".to_string(),
    }
}

const BADGE_ID: &str = "0f9d1c2e-5b7a-4c3d-9e8f-a1b2c3d4e5f6";

fn badge_header(width: u32, height: u32, sequence: u64) -> FrameHeader {
    FrameHeader {
        id: Uuid::parse_str(BADGE_ID).unwrap(),
        width,
        height,
        sequence,
    }
}

fn badge_target(frame: (u32, u32)) -> HtmlOverlayTarget {
    HtmlOverlayTarget {
        id: BADGE_ID.to_string(),
        page_width: 640,
        page_height: 360,
        frame_width: frame.0,
        frame_height: frame.1,
        fps: 30,
    }
}

// --- The page size -----------------------------------------------------------

#[test]
fn the_size_meta_tag_names_the_page_size() {
    assert_eq!(parse_overlay_size_meta(BADGE_PAGE), Some((640, 360)));
    // Attribute order, quotes, case and the separator do not matter.
    for page in [
        "<META CONTENT='1280x720' NAME='videorc-overlay-size'>",
        "<meta name=videorc-overlay-size content=1280x720>",
        "<meta name=\"videorc-overlay-size\" content=\"1280 × 720\"/>",
        "<meta name=\"videorc-overlay-size\" content=\"1280, 720\">",
        "<meta charset=utf-8><meta name=\"viewport\" content=\"width=10\">\n<meta name=\"videorc-overlay-size\" content=\"1280X720\">",
    ] {
        assert_eq!(parse_overlay_size_meta(page), Some((1280, 720)), "{page}");
    }
}

#[test]
fn a_missing_or_unusable_size_leaves_the_default_page() {
    for page in [
        "<html><body>no meta</body></html>",
        "<meta name=\"viewport\" content=\"640x360\">",
        "<meta name=\"videorc-overlay-size\">",
        "<meta name=\"videorc-overlay-size\" content=\"640\">",
        "<meta name=\"videorc-overlay-size\" content=\"640x360x2\">",
        "<meta name=\"videorc-overlay-size\" content=\"wide\">",
        // Outside 16 to 3840 px a side.
        "<meta name=\"videorc-overlay-size\" content=\"8x360\">",
        "<meta name=\"videorc-overlay-size\" content=\"640x4000\">",
        // `data-content` is not `content`.
        "<meta name=\"videorc-overlay-size\" data-content=\"640x360\">",
    ] {
        assert_eq!(parse_overlay_size_meta(page), None, "{page}");
    }
    let dir = temp_dir("default-page");
    let page = dir.join("plain.html");
    write(&page, b"<html></html>");
    assert_eq!(
        inspect_html_overlay_source(&page).unwrap().page,
        HTML_OVERLAY_DEFAULT_PAGE
    );
}

// --- What can be imported ----------------------------------------------------

#[test]
fn a_single_html_file_is_imported_alone_as_the_entry_page() {
    let dir = temp_dir("single");
    let page = dir.join("Lower third.HTM");
    write(&page, BADGE_PAGE.as_bytes());
    // A neighbour is never copied with a single file.
    write(&dir.join("secret.txt"), b"not part of the overlay");
    let source = inspect_html_overlay_source(&page).unwrap();
    assert_eq!(source.relative_paths(), vec!["index.html"]);
    assert_eq!(source.page, (640, 360));
    assert_eq!(source.name, "Lower third");
}

#[test]
fn a_folder_is_imported_whole_without_its_dot_files() {
    let dir = temp_dir("folder");
    let source = inspect_html_overlay_source(&badge_folder(&dir)).unwrap();
    assert_eq!(
        source.relative_paths(),
        vec!["img/logo.png", "index.html", "style.css"]
    );
    assert_eq!(source.name, "Animated badge");
}

#[test]
fn what_is_not_an_overlay_is_refused_with_its_sentence() {
    let dir = temp_dir("refusals");
    let text = dir.join("notes.txt");
    write(&text, b"hello");
    assert_eq!(
        refusal(inspect_html_overlay_source(&text)),
        REFUSAL_NOT_HTML
    );

    let empty = dir.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&empty)),
        REFUSAL_NO_INDEX
    );
    // `index.html` must be a file, not a folder of that name.
    let folder_named_index = dir.join("odd");
    std::fs::create_dir_all(folder_named_index.join("index.html")).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&folder_named_index)),
        REFUSAL_NO_INDEX
    );
}

#[test]
fn an_overlay_over_its_limits_is_refused() {
    let dir = temp_dir("limits");

    let many = dir.join("many");
    write(&many.join("index.html"), BADGE_PAGE.as_bytes());
    for index in 0..HTML_OVERLAY_MAX_FILES {
        write(&many.join(format!("f{index}.txt")), b"x");
    }
    assert_eq!(
        refusal(inspect_html_overlay_source(&many)),
        REFUSAL_TOO_LARGE
    );

    let deep = dir.join("deep");
    write(&deep.join("index.html"), BADGE_PAGE.as_bytes());
    let mut nested = deep.clone();
    for level in 0..=HTML_OVERLAY_MAX_DEPTH {
        nested = nested.join(format!("d{level}"));
    }
    write(&nested.join("leaf.txt"), b"x");
    assert_eq!(
        refusal(inspect_html_overlay_source(&deep)),
        REFUSAL_TOO_LARGE
    );
    // Exactly the allowed depth is fine.
    let allowed = dir.join("allowed");
    write(&allowed.join("index.html"), BADGE_PAGE.as_bytes());
    let mut nested = allowed.clone();
    for level in 0..HTML_OVERLAY_MAX_DEPTH {
        nested = nested.join(format!("d{level}"));
    }
    write(&nested.join("leaf.txt"), b"x");
    assert!(inspect_html_overlay_source(&allowed).is_ok());

    let heavy_page = dir.join("heavy.html");
    let file = std::fs::File::create(&heavy_page).unwrap();
    file.set_len(HTML_OVERLAY_MAX_ENTRY_BYTES + 1).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&heavy_page)),
        REFUSAL_TOO_LARGE
    );

    let heavy = dir.join("heavy");
    write(&heavy.join("index.html"), BADGE_PAGE.as_bytes());
    let file = std::fs::File::create(heavy.join("video.bin")).unwrap();
    file.set_len(HTML_OVERLAY_MAX_BYTES + 1).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&heavy)),
        REFUSAL_TOO_LARGE
    );
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_folder_is_refused() {
    let dir = temp_dir("links");
    let outside = dir.join("outside.txt");
    write(&outside, b"the streamer's own file");

    let linked_file = dir.join("linked-file");
    write(&linked_file.join("index.html"), BADGE_PAGE.as_bytes());
    std::os::unix::fs::symlink(&outside, linked_file.join("data.txt")).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&linked_file)),
        REFUSAL_LINK
    );

    let linked_folder = dir.join("linked-folder");
    write(&linked_folder.join("index.html"), BADGE_PAGE.as_bytes());
    std::os::unix::fs::symlink(&dir, linked_folder.join("up")).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&linked_folder)),
        REFUSAL_LINK
    );

    let linked_entry = dir.join("linked-entry");
    std::fs::create_dir_all(&linked_entry).unwrap();
    let real_page = dir.join("real.html");
    write(&real_page, BADGE_PAGE.as_bytes());
    std::os::unix::fs::symlink(&real_page, linked_entry.join("index.html")).unwrap();
    assert_eq!(
        refusal(inspect_html_overlay_source(&linked_entry)),
        REFUSAL_LINK
    );
}

// --- The import --------------------------------------------------------------

#[test]
fn an_import_copies_the_folder_and_inserts_an_html_banner() {
    let dir = temp_dir("import");
    let database = test_database(&dir);
    let banner = import_html_overlay_unchecked(&database, &badge_folder(&dir)).unwrap();

    assert_eq!(banner.kind, BannerKind::Html);
    assert_eq!((banner.width, banner.height), (640, 360));
    assert_eq!(banner.name, "Animated badge");
    assert!(!banner.shown, "the import leaves showing to the caller");
    assert!(banner.has_alpha);
    assert_eq!(
        (banner.horizontal, banner.vertical),
        banner_default_places(640, 360)
    );

    let root = database.banner_assets_dir();
    let folder = root.join(html_overlay_dir_name(&banner.id));
    assert_eq!(
        std::fs::read_to_string(folder.join("index.html")).unwrap(),
        BADGE_PAGE
    );
    assert!(folder.join("style.css").is_file());
    assert!(folder.join("img/logo.png").is_file());
    assert!(!folder.join(".DS_Store").exists());
    // Nothing is left half done beside it.
    let leftovers: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("staging"))
        .collect();
    assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");

    // The row round-trips with its kind.
    assert_eq!(database.banner_by_id(&banner.id).unwrap(), banner);
    assert_eq!(database.list_banners().unwrap(), vec![banner]);
}

#[test]
fn a_refused_import_publishes_nothing() {
    let dir = temp_dir("import-refused");
    let database = test_database(&dir);
    let empty = dir.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(
        refusal(import_html_overlay_unchecked(&database, &empty)),
        REFUSAL_NO_INDEX
    );
    assert!(database.list_banners().unwrap().is_empty());
    let root = database.banner_assets_dir();
    assert!(
        !root.exists() || std::fs::read_dir(&root).unwrap().next().is_none(),
        "a refused import left files in the managed folder"
    );
}

#[test]
fn the_platform_refusal_is_one_sentence() {
    let dir = temp_dir("platform");
    let database = test_database(&dir);
    let result = import_html_overlay(&database, &badge_folder(&dir));
    if html_overlays_supported() {
        assert_eq!(result.unwrap().kind, BannerKind::Html);
    } else {
        assert_eq!(refusal(result), REFUSAL_UNSUPPORTED);
        assert!(database.list_banners().unwrap().is_empty());
    }
}

#[test]
fn the_kind_is_on_the_wire_only_for_an_html_overlay() {
    let overlay = html_banner(
        BADGE_ID,
        OverlayRect::new(0.0, 0.0, 1.0, 1.0),
        OverlayRect::new(0.0, 0.0, 1.0, 0.3),
    );
    let json = serde_json::to_value(&overlay).unwrap();
    assert_eq!(json["kind"], "html");
    let image = Banner {
        kind: BannerKind::Image,
        ..overlay.clone()
    };
    let json = serde_json::to_value(&image).unwrap();
    assert!(
        json.get("kind").is_none(),
        "an image banner must serialise as it always did: {json}"
    );
    // And a payload without `kind` reads as an image (older rows, fixtures).
    assert_eq!(serde_json::from_value::<Banner>(json).unwrap(), image);
    // An unknown stored kind draws nothing rather than run a page.
    assert_eq!(BannerKind::from_column("video"), BannerKind::Image);
}

#[test]
fn deleting_an_html_banner_removes_its_folder() {
    let dir = temp_dir("delete");
    let database = test_database(&dir);
    let banner = import_html_overlay_unchecked(&database, &badge_folder(&dir)).unwrap();
    let root = database.banner_assets_dir();
    let folder = root.join(html_overlay_dir_name(&banner.id));
    assert!(folder.is_dir());
    crate::banners::delete_banner(&database, &banner.id, false).unwrap();
    assert!(!folder.exists());
    assert!(database.list_banners().unwrap().is_empty());
}

#[test]
fn the_folder_guard_refuses_what_is_not_the_managed_folder() {
    let dir = temp_dir("guard");
    let root = dir.join("Banners");
    std::fs::create_dir_all(&root).unwrap();
    // Not a UUID: never joined onto the root.
    assert!(managed_html_overlay_dir(&root, "../outside").is_err());
    // Already gone is fine.
    assert_eq!(managed_html_overlay_dir(&root, BADGE_ID).unwrap(), None);
    // A file where the folder should be is refused.
    write(&root.join(html_overlay_dir_name(BADGE_ID)), b"file");
    assert!(managed_html_overlay_dir(&root, BADGE_ID).is_err());
    #[cfg(unix)]
    {
        let other = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(html_overlay_dir_name(other))).unwrap();
        assert!(managed_html_overlay_dir(&root, other).is_err());
        assert!(outside.is_dir(), "the link's target must never be touched");
    }
}

// --- The frame wire ----------------------------------------------------------

#[test]
fn the_frame_header_matches_the_shared_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/html-overlay-frame.json"
    ))
    .unwrap();
    for case in fixture["headers"].as_array().unwrap() {
        let header = FrameHeader {
            id: Uuid::parse_str(case["id"].as_str().unwrap()).unwrap(),
            width: case["width"].as_u64().unwrap() as u32,
            height: case["height"].as_u64().unwrap() as u32,
            sequence: case["sequence"].as_str().unwrap().parse().unwrap(),
        };
        let hex: String = header
            .encode()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(hex, case["hex"].as_str().unwrap(), "{case}");
        assert_eq!(FrameHeader::parse(&header.encode()).unwrap(), header);
    }
    assert_eq!(
        fixture["headerBytes"].as_u64().unwrap() as usize,
        FRAME_HEADER_BYTES
    );
}

#[test]
fn a_wrong_header_is_an_error() {
    let good = badge_header(4, 2, 7).encode();
    let mut bad_magic = good;
    bad_magic[0] = b'X';
    assert_eq!(FrameHeader::parse(&bad_magic), Err(FrameError::Magic));
    let mut bad_version = good;
    bad_version[4] = 2;
    assert_eq!(FrameHeader::parse(&bad_version), Err(FrameError::Version));
    for (width, height) in [(0, 2), (4, 0), (3841, 2), (4, 3841)] {
        let header = badge_header(width, height, 0).encode();
        assert_eq!(
            FrameHeader::parse(&header),
            Err(FrameError::Size),
            "{width}x{height}"
        );
    }
}

#[test]
fn premultiplied_pixels_become_straight_alpha() {
    // B, G, R, A.
    let premultiplied = [
        255, 0, 255, 255, // opaque magenta: unchanged
        0, 0, 0, 0, // empty
        128, 128, 0, 128, // half-alpha cyan
        9, 9, 9, 0, // colour without alpha is not a pixel: empty
        200, 200, 200, 100, // over-bright (not valid premultiplied): clamped
        1, 2, 3, 4, // a faint pixel
    ];
    let mut straight = Vec::new();
    append_straight_alpha(&mut straight, &premultiplied);
    assert_eq!(
        straight,
        vec![
            255, 0, 255, 255, //
            0, 0, 0, 0, //
            255, 255, 0, 128, //
            0, 0, 0, 0, //
            255, 255, 255, 100, //
            64, 128, 191, 4,
        ]
    );
}

#[test]
fn the_block_path_and_the_pixel_path_agree() {
    // 100 pixels: an opaque run, an empty run and a mixed run, so the
    // sixteen-pixel fast paths and the remainder are all taken.
    let mut premultiplied = Vec::new();
    for index in 0..100_u32 {
        let alpha = match index {
            0..32 => 255,
            32..64 => 0,
            _ => (index * 37 % 256) as u8,
        };
        let channel = |seed: u32| ((seed * 53 % 256) * u32::from(alpha) / 255) as u8;
        premultiplied.extend_from_slice(&[
            channel(index),
            channel(index + 1),
            channel(index + 2),
            alpha,
        ]);
    }
    let mut blocks = vec![7_u8; 3];
    append_straight_alpha(&mut blocks, &premultiplied);
    assert_eq!(&blocks[..3], &[7, 7, 7], "the existing bytes are kept");
    let mut pixels = vec![0_u8; premultiplied.len()];
    straight_pixels(&mut pixels, &premultiplied);
    assert_eq!(&blocks[3..], pixels.as_slice());
}

/// Two frame records back to back, and the straight pixels each must yield.
fn two_records() -> (Vec<u8>, Vec<(FrameHeader, Vec<u8>)>) {
    let first = badge_header(3, 2, 1);
    let second = badge_header(2, 2, 2);
    let first_pixels: Vec<u8> = (0..first.payload_bytes())
        .map(|index| if index % 4 == 3 { 255 } else { index as u8 })
        .collect();
    let second_pixels: Vec<u8> = [128, 128, 0, 128].repeat(4);
    let mut wire = Vec::new();
    wire.extend_from_slice(&first.encode());
    wire.extend_from_slice(&first_pixels);
    wire.extend_from_slice(&second.encode());
    wire.extend_from_slice(&second_pixels);
    let expected = vec![
        (first, first_pixels),
        (second, [255, 255, 0, 128].repeat(4)),
    ];
    (wire, expected)
}

#[test]
fn records_survive_any_chunking() {
    let (wire, expected) = two_records();
    for chunk_size in [1, 2, 3, 5, 7, 39, 40, 41, 64, wire.len()] {
        let mut assembler = FrameAssembler::default();
        let mut frames = Vec::new();
        for chunk in wire.chunks(chunk_size) {
            assembler
                .push(chunk, &mut |_| true, &mut |header, pixels| {
                    frames.push((header, pixels));
                })
                .unwrap();
        }
        assert_eq!(frames, expected, "chunks of {chunk_size}");
    }
}

#[test]
fn an_unwanted_frame_is_read_and_dropped() {
    let (wire, expected) = two_records();
    let mut assembler = FrameAssembler::default();
    let mut asked = Vec::new();
    let mut frames = Vec::new();
    for chunk in wire.chunks(5) {
        assembler
            .push(
                chunk,
                &mut |header| {
                    asked.push(header.sequence);
                    header.sequence != 1
                },
                &mut |header, pixels| frames.push((header, pixels)),
            )
            .unwrap();
    }
    assert_eq!(asked, vec![1, 2], "each header is asked about once");
    assert_eq!(frames, expected[1..].to_vec(), "the stream stays in step");
}

#[test]
fn a_bad_record_ends_the_upload() {
    let mut assembler = FrameAssembler::default();
    let mut wire = b"HTTP".to_vec();
    wire.extend_from_slice(&[0; 60]);
    assert_eq!(
        assembler.push(&wire, &mut |_| true, &mut |_, _| panic!("no frame")),
        Err(FrameError::Magic)
    );
}

// --- The frame store ---------------------------------------------------------

#[test]
fn the_store_keeps_frames_only_for_targets_within_the_cap() {
    let service = HtmlOverlayService::default();
    let header = badge_header(640, 360, 1);
    assert!(!service.accepts(&header), "no targets: nothing is kept");
    assert!(service.set_targets(vec![badge_target((640, 360))]));
    assert!(
        !service.set_targets(vec![badge_target((640, 360))]),
        "unchanged"
    );
    assert!(service.accepts(&header));
    // Another overlay's id is not a target.
    assert!(!service.accepts(&FrameHeader {
        id: Uuid::parse_str("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d").unwrap(),
        ..header
    }));
    // D7: a frame over a 1080p frame's pixels is refused whatever its shape.
    assert!(service.accepts(&badge_header(1920, 1080, 2)));
    assert!(!service.accepts(&badge_header(1922, 1080, 3)));
    assert!(!service.accepts(&badge_header(3840, 2160, 4)));
}

#[test]
fn the_latest_frame_wins_and_each_has_its_own_revision() {
    let service = HtmlOverlayService::default();
    let now = Instant::now();
    assert!(service.latest_frame(BADGE_ID).is_none());
    service.store(badge_header(2, 1, 1), vec![1; 8], now);
    let one = service.latest_frame(BADGE_ID).unwrap();
    assert_eq!(
        (one.width, one.height, one.bgra.as_slice()),
        (2, 1, &[1_u8; 8][..])
    );
    service.store(badge_header(1, 1, 2), vec![2; 4], now);
    let two = service.latest_frame(BADGE_ID).unwrap();
    assert_eq!(
        (two.width, two.height, two.bgra.as_slice()),
        (1, 1, &[2_u8; 4][..])
    );
    assert_ne!(one.revision, two.revision, "a new frame is new content");
    let stats = service.stats();
    assert_eq!((stats.frames_received, stats.bytes_received), (2, 12));

    // A frame goes when its overlay leaves the set.
    service.retain(&HashSet::from([BADGE_ID]));
    assert!(service.latest_frame(BADGE_ID).is_some());
    service.retain(&HashSet::new());
    assert!(service.latest_frame(BADGE_ID).is_none());
}

#[test]
fn the_picture_is_due_once_a_second_after_the_first_frame_when_something_is_drawn() {
    let service = HtmlOverlayService::default();
    let start = Instant::now();
    let drawn = vec![10, 20, 30, 255];
    let empty = vec![0, 0, 0, 0];
    assert!(
        service
            .store(badge_header(1, 1, 1), drawn.clone(), start)
            .picture_due
            .is_none(),
        "the first frame is too early"
    );
    // A second later the page has drawn nothing: not yet, and not again
    // until another second has passed.
    let later = start + PICTURE_AFTER;
    assert!(
        service
            .store(badge_header(1, 1, 2), empty, later)
            .picture_due
            .is_none()
    );
    assert!(
        service
            .store(
                badge_header(1, 1, 3),
                drawn.clone(),
                later + Duration::from_millis(500)
            )
            .picture_due
            .is_none()
    );
    let due = service.store(badge_header(1, 1, 4), drawn.clone(), later + PICTURE_AFTER);
    assert_eq!(due.picture_due.unwrap().bgra.as_slice(), drawn.as_slice());
    // Once.
    assert!(
        service
            .store(badge_header(1, 1, 5), drawn, later + PICTURE_AFTER * 3)
            .picture_due
            .is_none()
    );
}

// --- Targets and status ------------------------------------------------------

fn badge_view(canvases: &[(u32, u32)], fps: u32) -> HtmlOverlayView {
    HtmlOverlayView {
        layers: vec![(
            html_banner(
                BADGE_ID,
                // 16:9 page in a 16:9 rect, a quarter of the width.
                OverlayRect::new(0.7, 0.05, 0.25, 0.25),
                // And in a rect of its own shape on a 9:16 canvas: 80 % wide.
                OverlayRect::new(0.1, 0.1, 0.8, 0.253125),
            ),
            false,
        )],
        canvases: canvases.to_vec(),
        fps,
    }
}

#[test]
fn a_frame_is_even_and_never_over_the_cap() {
    assert_eq!(frame_size_for_draw(480, 270), (480, 270));
    assert_eq!(frame_size_for_draw(481, 271), (482, 272));
    assert_eq!(frame_size_for_draw(1, 1), (2, 2));
    assert_eq!(frame_size_for_draw(0, 0), (2, 2));
    // A 4K full frame is rasterised at 1080p and scaled by the compositor.
    assert_eq!(frame_size_for_draw(3840, 2160), (1920, 1080));
    assert_eq!(frame_size_for_draw(1920, 1080), (1920, 1080));
    for (width, height) in [(3840, 400), (400, 3840), (2561, 1441), (1921, 1081)] {
        let (frame_width, frame_height) = frame_size_for_draw(width, height);
        assert!(
            u64::from(frame_width) * u64::from(frame_height) <= HTML_OVERLAY_MAX_FRAME_PIXELS,
            "{width}x{height} gave {frame_width}x{frame_height}"
        );
        assert_eq!((frame_width % 2, frame_height % 2), (0, 0));
        let aspect = f64::from(width) / f64::from(height);
        let frame_aspect = f64::from(frame_width) / f64::from(frame_height);
        assert!(
            (aspect / frame_aspect - 1.0).abs() < 0.02,
            "{width}x{height} gave {frame_width}x{frame_height}"
        );
    }
}

#[test]
fn a_target_is_the_draw_size_on_the_largest_canvas_at_no_more_than_30_fps() {
    // No run: nothing to draw on, so nothing to render.
    assert!(html_overlay_targets(&badge_view(&[], 30), None).is_empty());

    let one = html_overlay_targets(&badge_view(&[(1920, 1080)], 60), None);
    assert_eq!(
        one,
        vec![HtmlOverlayTarget {
            id: BADGE_ID.to_string(),
            page_width: 640,
            page_height: 360,
            frame_width: 480,
            frame_height: 270,
            fps: 30,
        }]
    );
    // A slower session renders the page no faster than it composes.
    assert_eq!(
        html_overlay_targets(&badge_view(&[(1920, 1080)], 24), None)[0].fps,
        24
    );

    // With a vertical stream leg the larger draw decides: 80 % of 1080 wide.
    let two = html_overlay_targets(&badge_view(&[(1920, 1080), (1080, 1920)], 30), None);
    assert_eq!((two[0].frame_width, two[0].frame_height), (864, 486));
    // The page is contained in its rect: a rect wider than the page's shape
    // is limited by its height (384 px high on that canvas, so 684 wide).
    let mut wide = badge_view(&[(1080, 1920)], 30);
    wide.layers[0].0.vertical = OverlayRect::new(0.1, 0.1, 0.8, 0.2);
    let contained = html_overlay_targets(&wide, None);
    assert_eq!(
        (contained[0].frame_width, contained[0].frame_height),
        (684, 384)
    );

    // A 4K recording: the quarter-width badge is 960 x 540.
    let four_k = html_overlay_targets(&badge_view(&[(3840, 2160)], 30), None);
    assert_eq!((four_k[0].frame_width, four_k[0].frame_height), (960, 540));
}

#[test]
fn an_overlay_that_is_leaving_off_or_undrawable_is_not_a_target() {
    let mut leaving = badge_view(&[(1920, 1080)], 30);
    leaving.layers[0].1 = true;
    assert!(html_overlay_targets(&leaving, None).is_empty());

    let mut off = badge_view(&[(1920, 1080)], 30);
    off.layers[0].0.show_on_stream = false;
    off.layers[0].0.show_in_recording = false;
    assert!(html_overlay_targets(&off, None).is_empty());

    let mut image = badge_view(&[(1920, 1080)], 30);
    image.layers[0].0.kind = BannerKind::Image;
    assert!(html_overlay_targets(&image, None).is_empty());

    // D9: a session the compositor does not compose cannot draw one.
    let view = badge_view(&[(1920, 1080)], 30);
    assert!(html_overlay_targets(&view, Some(false)).is_empty());
    assert_eq!(html_overlay_targets(&view, Some(true)).len(), 1);
}

#[test]
fn the_status_says_where_an_overlay_stands() {
    let view = badge_view(&[(1920, 1080)], 30);
    let no_frame = |_: &str| None;
    let frame = |_: &str| Some((480, 270));
    let no_host = |_: &str| None;
    let status = |session,
                  frame_of: &dyn Fn(&str) -> Option<(u32, u32)>,
                  host_of: &dyn Fn(&str) -> Option<HostReport>| {
        html_overlay_statuses(&view, session, frame_of, host_of)
            .pop()
            .unwrap()
    };

    let loading = status(None, &no_frame, &no_host);
    assert_eq!(
        (loading.state, loading.detail.clone()),
        (HtmlOverlayState::Loading, None)
    );

    let live = status(None, &frame, &no_host);
    assert_eq!(live.state, HtmlOverlayState::Live);
    assert_eq!(
        (live.frame_width, live.frame_height),
        (Some(480), Some(270))
    );
    assert_eq!(live.blocked_requests, None);

    // The page went away: said even though an old frame is still held.
    let failed_host = |_: &str| {
        Some(HostReport {
            state: HtmlOverlayHostState::Failed,
            detail: Some("the page crashed".to_string()),
            blocked_requests: 3,
        })
    };
    let failed = status(None, &frame, &failed_host);
    assert_eq!(failed.state, HtmlOverlayState::Failed);
    assert_eq!(
        failed.detail.as_deref(),
        Some("This banner stopped: the page crashed")
    );
    assert_eq!(failed.frame_width, None);
    assert_eq!(failed.blocked_requests, Some(3));

    let unavailable = status(Some(false), &frame, &no_host);
    assert_eq!(unavailable.state, HtmlOverlayState::Unavailable);
    assert_eq!(
        unavailable.detail.as_deref(),
        Some(REFUSAL_SESSION_CANNOT_DRAW)
    );

    // A hidden overlay has no status.
    let mut leaving = view.clone();
    leaving.layers[0].1 = true;
    assert!(html_overlay_statuses(&leaving, None, &frame, &no_host).is_empty());

    // Never `null` on the wire (the serde null trap).
    let json = serde_json::to_string(&loading).unwrap();
    assert!(!json.contains("null"), "{json}");
}

// --- The wire, shared with TypeScript ----------------------------------------

#[test]
fn the_wire_shapes_match_the_shared_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol-fixtures/high-risk-contracts.json"
    ))
    .unwrap();
    let fixture = &fixture["htmlOverlay"];

    // Each value must survive Rust unchanged: read into the type, written
    // back, equal to the fixture (so no field is dropped, renamed or `null`).
    fn round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(value: &serde_json::Value) {
        let typed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(&serde_json::to_value(&typed).unwrap(), value);
    }
    round_trip::<Banner>(&fixture["banner"]);
    round_trip::<HtmlOverlayTargets>(&fixture["targets"]);
    round_trip::<HtmlOverlayStatuses>(&fixture["statuses"]);
    round_trip::<HtmlOverlayStats>(&fixture["stats"]);

    let banner: Banner = serde_json::from_value(fixture["banner"].clone()).unwrap();
    assert_eq!(banner.kind, BannerKind::Html);
    // The refusal the fixture quotes is the one the backend says.
    assert_eq!(
        fixture["statuses"]["overlays"][1]["detail"],
        REFUSAL_SESSION_CANNOT_DRAW
    );

    let report: crate::protocol::HtmlOverlayHostReportParams =
        serde_json::from_value(fixture["hostReport"].clone()).unwrap();
    assert_eq!(report.state, HtmlOverlayHostState::Failed);
    assert_eq!(report.blocked_requests, Some(3));
    // A report with a field main never sends is refused, not ignored.
    let mut extra = fixture["hostReport"].clone();
    extra["path"] = serde_json::json!("/Users/me");
    assert!(serde_json::from_value::<crate::protocol::HtmlOverlayHostReportParams>(extra).is_err());
}
