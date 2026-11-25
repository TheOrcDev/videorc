//! First-run setup's pictures, shipped in the binary as Electron's renderer
//! ships them: the app icon beside the Welcome title, the Liquid Chrome
//! poster behind the card (`welcome-backdrop.tsx`), and each live
//! background's first-look thumbnail for Your look's tiles
//! (`liveBackgroundThumbnail(id, LIVE_BACKGROUND_DEFAULT_LOOKS[id])`).

use std::io::Cursor;
use std::sync::{Arc, OnceLock};

use gpui::{Image, ImageFormat};
use image::{ExtendedColorType, ImageEncoder, ImageReader};

const LOGO: &[u8] = include_bytes!("../../../../desktop/src/renderer/src/assets/videorc-logo.png");

/// `WELCOME_BACKDROP.look` is `polished`: its poster is the still the
/// backdrop paints first and keeps whenever it can't move.
const POSTER: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-liquid-chrome-polished.webp"
);

const SILK: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-silk-satin.webp"
);
const SIDE_RAYS: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-side-rays-sunbeam.webp"
);
const PLASMA_WAVE: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-plasma-wave-plasma.webp"
);
const LIQUID_CHROME: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-liquid-chrome-polished.webp"
);
const LINE_WAVES: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-line-waves-silk.webp"
);
const BEAMS: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-beams-studio.webp"
);
const COLOR_BENDS: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-color-bends-default.webp"
);
const DITHER: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-dither-classic.webp"
);
const FERROFLUID: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-ferrofluid-studio.webp"
);
const GHOST_FIBERS: &[u8] = include_bytes!(
    "../../../../desktop/src/renderer/src/assets/backgrounds/live-thumbs/live-ghost-fibers-violet.webp"
);

/// The live backgrounds in `LIVE_BACKGROUND_IDS` order, each with its
/// first look's thumbnail.
const THUMBS: [(&str, &[u8]); 10] = [
    ("silk", SILK),
    ("side-rays", SIDE_RAYS),
    ("plasma-wave", PLASMA_WAVE),
    ("liquid-chrome", LIQUID_CHROME),
    ("line-waves", LINE_WAVES),
    ("beams", BEAMS),
    ("color-bends", COLOR_BENDS),
    ("dither", DITHER),
    ("ferrofluid", FERROFLUID),
    ("ghost-fibers", GHOST_FIBERS),
];

/// The app icon (`assets/videorc-logo.png`).
pub fn logo() -> Arc<Image> {
    static IMAGE: OnceLock<Arc<Image>> = OnceLock::new();
    IMAGE
        .get_or_init(|| Arc::new(Image::from_bytes(ImageFormat::Png, LOGO.to_vec())))
        .clone()
}

/// The Liquid Chrome poster as it is, for the dark backdrop.
pub fn poster() -> Arc<Image> {
    static IMAGE: OnceLock<Arc<Image>> = OnceLock::new();
    IMAGE
        .get_or_init(|| Arc::new(Image::from_bytes(ImageFormat::Webp, POSTER.to_vec())))
        .clone()
}

/// The poster turned around (`invert(1)`, plan 208 D3), PNG-encoded: white
/// liquid with black reflections, for the light backdrop. Slow enough to run
/// off the main thread, once.
pub fn inverted_poster_png() -> Option<Vec<u8>> {
    let mut picture = ImageReader::new(Cursor::new(POSTER))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    picture.invert();
    let rgba = picture.to_rgba8();
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(out)
}

/// A live background's thumbnail in its first look, decoded once per id.
pub fn live_thumb(id: &str) -> Option<Arc<Image>> {
    static IMAGES: OnceLock<Vec<(&'static str, Arc<Image>)>> = OnceLock::new();
    let images = IMAGES.get_or_init(|| {
        THUMBS
            .iter()
            .map(|(id, bytes)| {
                (
                    *id,
                    Arc::new(Image::from_bytes(ImageFormat::Webp, bytes.to_vec())),
                )
            })
            .collect()
    });
    images
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, image)| image.clone())
}
