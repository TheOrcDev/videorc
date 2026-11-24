use super::*;
use crate::test_temp_dir::TestTempDir;
use image::{Rgb, RgbImage, Rgba, RgbaImage};

fn encoded(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), format)
        .unwrap();
    bytes
}

fn solid_png(width: u32, height: u32) -> Vec<u8> {
    encoded(
        DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([20, 120, 220]))),
        ImageFormat::Png,
    )
}

/// Noise does not compress: a PNG this size is well over 2 MB.
fn noise_png(width: u32, height: u32) -> Vec<u8> {
    let mut seed = 0x2545_f491_u32;
    let image = RgbImage::from_fn(width, height, |_, _| {
        let mut channel = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed & 0xff) as u8
        };
        Rgb([channel(), channel(), channel()])
    });
    encoded(DynamicImage::ImageRgb8(image), ImageFormat::Png)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// A PNG header claiming `width` x `height` with no pixel data: enough for
/// the header check, which must refuse before any decode.
fn png_header(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    bytes.extend(chunk(b"IHDR", &ihdr));
    bytes.extend(chunk(b"IDAT", &[]));
    bytes.extend(chunk(b"IEND", &[]));
    bytes
}

fn error_text(result: Result<impl std::fmt::Debug>) -> String {
    format!("{:#}", result.expect_err("the import must refuse"))
}

#[test]
fn stores_a_source_at_or_under_2_mb_byte_identical() {
    let root = TestTempDir::new("thumbnail-small");
    let bytes = solid_png(64, 36);
    let source = root.join("small.png");
    fs::write(&source, &bytes).unwrap();
    let managed = root.join("managed");

    let (saved, path) = import_scheduled_thumbnail(&source, &managed).unwrap();

    let id = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(
        saved,
        ScheduledThumbnail {
            preview_url: format!("videorc-asset://scheduled-thumbnail/{id}"),
            id: id.clone(),
            width: 64,
            height: 36,
        }
    );
    assert_eq!(path, managed.join(format!("{id}.png")));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    // The same picture again is the same managed copy.
    assert_eq!(
        import_scheduled_thumbnail(&source, &managed).unwrap().1,
        path
    );
}

#[test]
fn a_modified_managed_copy_is_refused() {
    let root = TestTempDir::new("thumbnail-tampered");
    let source = root.join("source.png");
    fs::write(&source, solid_png(32, 18)).unwrap();
    let managed = root.join("managed");
    let (_, path) = import_scheduled_thumbnail(&source, &managed).unwrap();
    fs::write(&path, b"tampered").unwrap();

    assert!(error_text(import_scheduled_thumbnail(&source, &managed)).contains("contents changed"));
}

#[test]
fn refuses_spoofed_animated_dense_and_huge_sources() {
    let root = TestTempDir::new("thumbnail-refused");
    let managed = root.join("managed");
    let write = |name: &str, bytes: &[u8]| {
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        path
    };

    let empty = write("empty.png", b"");
    assert!(error_text(import_scheduled_thumbnail(&empty, &managed)).contains("smaller than 2 MB"));
    let svg = write("spoofed.png", b"<svg/>");
    assert!(
        error_text(import_scheduled_thumbnail(&svg, &managed)).contains("Choose a JPEG or PNG")
    );
    let mut animated = solid_png(32, 18);
    animated.extend_from_slice(b"acTL");
    let animated = write("animated.png", &animated);
    assert!(error_text(import_scheduled_thumbnail(&animated, &managed)).contains("Animated"));
    let dense = write("dense.png", &png_header(6000, 4200));
    assert!(error_text(import_scheduled_thumbnail(&dense, &managed)).contains("20 megapixels"));

    let huge = root.join("huge.png");
    fs::File::create(&huge)
        .unwrap()
        .set_len(SOURCE_MAX_BYTES as u64 + 1)
        .unwrap();
    assert!(error_text(import_scheduled_thumbnail(&huge, &managed)).contains("smaller than 50 MB"));
    assert!(!managed.exists(), "nothing is stored for a refused source");
}

#[test]
fn fits_a_source_over_2_mb_into_a_jpeg_with_a_1280_px_long_edge() {
    let root = TestTempDir::new("thumbnail-fit");
    let bytes = noise_png(1600, 1200);
    assert!(
        bytes.len() > STORED_MAX_BYTES,
        "the fixture must need fitting"
    );
    let source = root.join("big.png");
    fs::write(&source, &bytes).unwrap();

    let (saved, path) = import_scheduled_thumbnail(&source, &root.join("managed")).unwrap();

    assert_eq!((saved.width, saved.height), (1280, 960));
    assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("jpg"));
    let stored = fs::read(&path).unwrap();
    assert!(stored.len() <= STORED_MAX_BYTES);
    assert_eq!(image::guess_format(&stored).unwrap(), ImageFormat::Jpeg);
    assert_eq!(saved.id, format!("{:x}", Sha256::digest(&stored)));
}

#[test]
fn the_fit_caps_the_long_edge_and_never_enlarges() {
    assert_eq!(fitted_size(3840, 2160, 1280), (1280, 720));
    assert_eq!(fitted_size(1080, 1920, 1280), (720, 1280));
    assert_eq!(fitted_size(640, 360, 1280), (640, 360));
}

#[test]
fn startup_lists_only_stored_thumbnails() {
    let root = TestTempDir::new("thumbnail-stored");
    fs::write(root.join("bbb.jpg"), b"x").unwrap();
    fs::write(root.join("aaa.png"), b"x").unwrap();
    fs::write(root.join("notes.txt"), b"x").unwrap();
    fs::create_dir(root.join("ccc.png")).unwrap();

    let stored = stored_scheduled_thumbnails(&root);

    assert_eq!(
        stored,
        vec![
            ("aaa".to_string(), root.join("aaa.png")),
            ("bbb".to_string(), root.join("bbb.jpg")),
        ]
    );
    assert!(stored_scheduled_thumbnails(&root.join("missing")).is_empty());
}

#[test]
fn background_thumbnails_scale_to_480_px_wide_and_never_enlarge() {
    assert_eq!(background_thumbnail_size(3840, 2160), Some((480, 270)));
    assert_eq!(background_thumbnail_size(320, 180), Some((320, 180)));
    assert_eq!(background_thumbnail_size(0, 0), None);
    assert_eq!(
        background_thumbnail_file_name("abc", "png"),
        "abc.thumb.png"
    );
    assert_eq!(
        background_thumbnail_file_name("abc", "webp"),
        "abc.thumb.jpg"
    );
}

#[test]
fn a_background_import_copies_the_image_and_writes_its_tile() {
    let root = TestTempDir::new("background-import");
    let directory = root.join("background-assets");
    let jpeg = root.join("Sky.JPG");
    fs::write(
        &jpeg,
        encoded(
            DynamicImage::ImageRgb8(RgbImage::from_pixel(1920, 1080, Rgb([200, 30, 30]))),
            ImageFormat::Jpeg,
        ),
    )
    .unwrap();

    let imported = import_background(&jpeg, &directory).unwrap();

    assert_eq!(imported.asset_file_name, format!("{}.jpg", imported.id));
    assert_eq!(
        fs::read(directory.join(&imported.asset_file_name)).unwrap(),
        fs::read(&jpeg).unwrap()
    );
    let tile = imported.thumbnail_file_name.as_deref().unwrap();
    assert_eq!(tile, format!("{}.thumb.jpg", imported.id));
    let tile = image::open(directory.join(tile)).unwrap();
    assert_eq!((tile.width(), tile.height()), (480, 270));

    // A PNG keeps its transparency in a PNG tile.
    let png = root.join("logo.png");
    fs::write(
        &png,
        encoded(
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(960, 540, Rgba([0, 0, 0, 0]))),
            ImageFormat::Png,
        ),
    )
    .unwrap();
    let imported = import_background(&png, &directory).unwrap();
    assert_eq!(
        imported.thumbnail_file_name,
        Some(format!("{}.thumb.png", imported.id))
    );
}

#[test]
fn an_undecodable_background_is_kept_without_a_tile() {
    let root = TestTempDir::new("background-undecodable");
    let directory = root.join("background-assets");
    let broken = root.join("broken.webp");
    fs::write(&broken, b"not an image").unwrap();

    let imported = import_background(&broken, &directory).unwrap();

    assert_eq!(imported.thumbnail_file_name, None);
    assert!(directory.join(&imported.asset_file_name).is_file());

    let gif = root.join("party.gif");
    fs::write(&gif, b"GIF89a").unwrap();
    assert!(error_text(import_background(&gif, &directory)).contains("PNG, JPEG or WebP"));
    assert!(
        error_text(import_background(&root.join("missing.png"), &directory)).contains("missing")
    );
}
