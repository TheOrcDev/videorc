//! Offline half of `pnpm probe:live-background-cost -- --mode grounds`.
use std::{
    io::{Cursor, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
};

use anyhow::{Context, Result, ensure};
use image::RgbImage;
use serde::{Deserialize, Serialize};

const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;
const SIGMA: f32 = 24.0;
const GREY: &str =
    "Rec.709 luma of gamma-encoded sRGB: (0.2126 R + 0.7152 G + 0.0722 B) / 255; no linearization";

#[derive(Debug, Serialize, Deserialize)]
struct GreyStats {
    min: f64,
    max: f64,
    mean: f64,
}

#[derive(Serialize, Deserialize)]
struct GroundStats {
    generator_version: u32,
    background_id: String,
    look: String,
    phase: f64,
    width: u32,
    height: u32,
    sigma: f32,
    grey: String,
    encoding: String,
    dark: GreyStats,
    light: GreyStats,
}

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/backgrounds")
}

fn measure(pixels: &RgbImage) -> GreyStats {
    let mut stats = GreyStats {
        min: 1.0,
        max: 0.0,
        mean: 0.0,
    };
    for pixel in pixels.pixels() {
        let [r, g, b] = pixel.0.map(f64::from);
        let grey = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
        stats.min = stats.min.min(grey);
        stats.max = stats.max.max(grey);
        stats.mean += grey;
    }
    stats.mean /= f64::from(pixels.width()) * f64::from(pixels.height());
    stats
}

fn main() -> Result<()> {
    let phase: f64 = std::env::args()
        .nth(1)
        .context("poster phase argument required")?
        .parse()?;
    let mut png = Vec::new();
    std::io::stdin().read_to_end(&mut png)?;
    let pixels = image::load_from_memory_with_format(&png, image::ImageFormat::Png)?.to_rgb8();
    ensure!(
        pixels.dimensions() == (WIDTH, HEIGHT),
        "expected 1280×720 poster"
    );
    std::fs::create_dir_all(directory())?;
    let mut measurements = Vec::new();
    for theme in ["dark", "light"] {
        let mut source = pixels.clone();
        if theme == "light" {
            for channel in source.as_mut() {
                *channel = 255 - *channel;
            }
        }
        let blurred = image::imageops::blur(&source, SIGMA);
        let path = directory().join(format!("chrome-ground-{theme}.webp"));
        let mut png = Cursor::new(Vec::new());
        blurred.write_to(&mut png, image::ImageFormat::Png)?;
        let mut encoder = Command::new("cwebp")
            .args(["-quiet", "-q", "90", "-o", "-", "--", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .context("install libwebp's cwebp and put it on PATH")?;
        encoder.stdin.take().unwrap().write_all(png.get_ref())?;
        let encoded = encoder.wait_with_output()?;
        ensure!(encoded.status.success(), "cwebp failed: {}", encoded.status);
        std::fs::write(&path, encoded.stdout)?;
        let size = std::fs::metadata(&path)?.len();
        ensure!(size <= 40_000, "{} exceeds 40 KB: {size}", path.display());
        // Measure decoded shipping pixels, including any encoder effects.
        let decoded = image::open(&path)?.to_rgb8();
        measurements.push(measure(&decoded));
        println!("{}: {size} bytes", path.display());
    }
    let light = measurements.pop().unwrap();
    let dark = measurements.pop().unwrap();
    let stats = GroundStats {
        generator_version: 1,
        background_id: "liquid-chrome".into(),
        look: "polished".into(),
        phase,
        width: WIDTH,
        height: HEIGHT,
        sigma: SIGMA,
        grey: GREY.into(),
        encoding: "cwebp lossy quality 90".into(),
        dark,
        light,
    };
    std::fs::write(
        directory().join("chrome-ground.stats.json"),
        format!("{}\n", serde_json::to_string_pretty(&stats)?),
    )?;
    Ok(())
}

#[test]
fn chrome_ground_stats_match_committed_webps() -> Result<()> {
    let stats: GroundStats = serde_json::from_slice(&std::fs::read(
        directory().join("chrome-ground.stats.json"),
    )?)?;
    assert_eq!(stats.generator_version, 1);
    assert_eq!(stats.background_id, "liquid-chrome");
    assert_eq!(stats.look, "polished");
    let catalogue: serde_json::Value = serde_json::from_str(include_str!(
        "../../../apps/desktop/src/shared/live-backgrounds.render.generated.json"
    ))?;
    let background = catalogue["backgrounds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == stats.background_id)
        .unwrap();
    let look = background["looks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == stats.look)
        .unwrap();
    assert_eq!(Some(stats.phase), look["posterPhase"].as_f64());
    assert_eq!(stats.encoding, "cwebp lossy quality 90");
    assert_eq!((stats.width, stats.height), (WIDTH, HEIGHT));
    assert_eq!(stats.sigma, SIGMA);
    assert_eq!(stats.grey, GREY);
    for (theme, expected) in [("dark", stats.dark), ("light", stats.light)] {
        let path = directory().join(format!("chrome-ground-{theme}.webp"));
        assert!(std::fs::metadata(&path)?.len() <= 40_000);
        let decoded = image::open(path)?.to_rgba8();
        assert_eq!(decoded.dimensions(), (WIDTH, HEIGHT));
        assert!(decoded.pixels().all(|pixel| pixel[3] == 255));
        let actual = measure(&image::DynamicImage::ImageRgba8(decoded).to_rgb8());
        for (name, actual, expected) in [
            ("min", actual.min, expected.min),
            ("max", actual.max, expected.max),
            ("mean", actual.mean, expected.mean),
        ] {
            assert!(
                (actual - expected).abs() < 1e-6,
                "{theme} {name}: decoded {actual}, stats {expected}; rerun the generator"
            );
        }
    }
    Ok(())
}
