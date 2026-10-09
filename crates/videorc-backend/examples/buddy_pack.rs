//! `buddy_pack`: a dev-only tool (plan 172 D1), never shipped. It builds a
//! Buddy pet pack from a folder of versioned sources exactly as
//! `cohost.pet.build` does (the same builder, `build_pack`, on the same
//! inputs), then loads what it wrote with the app's own pack loader
//! (`load_pack_dir`), so a pack this prints `ok` for is a pack the app opens.
//!
//! ```sh
//! cargo run -p videorc-backend --example buddy_pack -- <sources> <out> \
//!   [--name <name>] [--cell-size <px>] [--created-at <rfc3339>] [--json]
//! cargo run -p videorc-backend --example buddy_pack -- --verify <pack> [--json]
//! ```
//!
//! `<sources>` holds the reference and the generated sheets the way a
//! creation's `sources/` folder does (`pnpm buddy:alive` writes it):
//! `reference.png` (or `reference-v<n>.png`), `pilot-v<n>.png` and
//! `<sheet>-v<n>.png` for `gaze-up2`, `gaze-up1`, `gaze-level`,
//! `gaze-down1`, `gaze-down2`, `reactions-a`, `reactions-b` and `extras`.
//! The highest version of each is built unless `accepted.json`
//! (`{ "gaze-up1": 2 }`) pins another. The pack lands in `<out>`:
//! `manifest.json`, `mascot.webp` (lossless), `buddy.json`,
//! `build-report.json` and `provenance.json` (every source's SHA-256).
//! `--verify` only loads an existing pack folder (a re-encoded copy, say).
//!
//! It prints the builder's verdict per cell (`ok` with the scale, the
//! margin and the root drift) or its refusal, which names the sheet and the
//! cell; `--json` prints one JSON object instead. Exit code 1 on a refusal.
//!
//! The backend is a binary crate without a library target, so the builder,
//! the pack contract and `atomic_file` are compiled in from `src/` by path.
//! `buddy_pet.rs` also reaches into two app modules for still packs and
//! state images, which this tool never uses; they get small stand-ins
//! below. When those signatures change, this example stops compiling
//! (`cargo test` builds it): update the stand-ins.

#[allow(dead_code, unused_imports)]
#[path = "../src/atomic_file.rs"]
mod atomic_file;
#[allow(dead_code, unused_imports)]
#[path = "../src/buddy_pet.rs"]
mod buddy_pet;
#[allow(dead_code, unused_imports)]
#[path = "../src/buddy_pet_build/mod.rs"]
mod buddy_pet_build;

/// Stand-in for the parts of `src/cohost.rs` that `buddy_pet.rs` names
/// (still packs and the persona's state images; never used by this tool).
#[allow(dead_code)]
mod cohost {
    pub const COHOST_DEFAULT_PERSONA_NAME: &str = "Buddy";

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
    pub enum CohostAvatarState {
        Idle,
        Talk,
        Laugh,
        Think,
    }

    impl CohostAvatarState {
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Idle => "idle",
                Self::Talk => "talk",
                Self::Laugh => "laugh",
                Self::Think => "think",
            }
        }
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct CohostPersonaImages {
        pub idle: Option<String>,
        pub talk: Option<String>,
        pub laugh: Option<String>,
        pub think: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CohostPersona {
        pub id: String,
        pub name: String,
        pub images: CohostPersonaImages,
    }

    impl Default for CohostPersona {
        fn default() -> Self {
            Self {
                id: "default".to_string(),
                name: COHOST_DEFAULT_PERSONA_NAME.to_string(),
                images: CohostPersonaImages::default(),
            }
        }
    }

    pub(crate) fn truncate_utf16(value: &str, max_units: usize) -> String {
        let mut units = 0;
        for (index, ch) in value.char_indices() {
            units += ch.len_utf16();
            if units > max_units {
                return value[..index].to_string();
            }
        }
        value.to_string()
    }
}

/// Stand-in for `src/resource_authority.rs` (same body as the original).
#[allow(dead_code)]
/// `buddy_pet.rs` resolves `official:<slug>` pack ids through the library's
/// catalog (plan 172 D4); this example only builds and verifies local packs,
/// so no official version is known here.
mod cohost_library {
    pub fn official_pack_version(_slug: &str) -> Option<u32> {
        None
    }
}

mod resource_authority {
    use std::path::{Path, PathBuf};

    pub fn canonical_path_is_within(path: &Path, roots: &[PathBuf]) -> bool {
        let Ok(canonical_path) = std::fs::canonicalize(path) else {
            return false;
        };
        roots.iter().any(|root| {
            std::fs::canonicalize(root)
                .ok()
                .is_some_and(|canonical_root| canonical_path.starts_with(canonical_root))
        })
    }
}

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use buddy_pet_build::{
    ATLAS_FILE, BuildInput, BuildOutcome, DEFAULT_CELL_SIZE, MANIFEST_FILE, PROVENANCE_FILE,
    REPORT_FILE, SIDECAR_FILE, SheetInput, SheetKind, SourceFile, build_pack, sha256_hex,
};

/// The files a built pack holds, in the order they are listed.
const PACK_FILES: [&str; 5] = [
    MANIFEST_FILE,
    ATLAS_FILE,
    SIDECAR_FILE,
    REPORT_FILE,
    PROVENANCE_FILE,
];
const REFERENCE_KEY: &str = "reference";
const ACCEPTED_FILE: &str = "accepted.json";
/// The pack id the verification load uses (the loader only records it).
const VERIFY_PACK_ID: &str = "bundled:check";

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Build {
        sources: PathBuf,
        out: PathBuf,
        name: String,
        cell_size: u32,
        created_at: Option<String>,
        json: bool,
    },
    Verify {
        pack: PathBuf,
        json: bool,
    },
}

const USAGE: &str = "usage: buddy_pack <sources> <out> [--name <name>] [--cell-size <px>] [--created-at <rfc3339>] [--json]\n       buddy_pack --verify <pack> [--json]";

fn parse_args(args: &[String]) -> Result<Command, String> {
    let mut positional = Vec::new();
    let mut name = "Buddy".to_string();
    let mut cell_size = DEFAULT_CELL_SIZE;
    let mut created_at = None;
    let mut json = false;
    let mut verify = None;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args.get(index + 1);
        match flag {
            "--json" => {
                json = true;
                index += 1;
                continue;
            }
            "--name" | "--cell-size" | "--created-at" | "--verify" => {
                let Some(value) = value else {
                    return Err(format!("{flag} needs a value"));
                };
                match flag {
                    "--name" => name = value.clone(),
                    "--cell-size" => {
                        cell_size = value
                            .parse()
                            .map_err(|_| format!("--cell-size takes pixels, not {value}"))?;
                    }
                    "--created-at" => created_at = Some(value.clone()),
                    _ => verify = Some(PathBuf::from(value)),
                }
                index += 2;
                continue;
            }
            _ if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            _ => positional.push(PathBuf::from(flag)),
        }
        index += 1;
    }
    if let Some(pack) = verify {
        if !positional.is_empty() {
            return Err("--verify takes one pack folder and nothing else".to_string());
        }
        return Ok(Command::Verify { pack, json });
    }
    let [sources, out] = <[PathBuf; 2]>::try_from(positional)
        .map_err(|_| "give the sources folder and the output folder".to_string())?;
    Ok(Command::Build {
        sources,
        out,
        name,
        cell_size,
        created_at,
        json,
    })
}

/// Every sheet key a sources folder may hold, the pilot first.
fn sheet_kinds() -> Vec<SheetKind> {
    std::iter::once(SheetKind::Pilot)
        .chain(SheetKind::ATLAS_ORDER)
        .collect()
}

fn kind_of(key: &str) -> Option<SheetKind> {
    sheet_kinds().into_iter().find(|kind| kind.key() == key)
}

/// `gaze-up1-v3.png` as `("gaze-up1", 3)`; `None` for any other name.
fn parse_versioned(file_name: &str) -> Option<(String, u32)> {
    let stem = file_name.strip_suffix(".png")?;
    let (key, version) = stem.rsplit_once("-v")?;
    if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let version: u32 = version.parse().ok().filter(|version| *version >= 1)?;
    (key == REFERENCE_KEY || kind_of(key).is_some()).then(|| (key.to_string(), version))
}

/// One source the build reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChosenSource {
    key: String,
    /// `None` for an unversioned `reference.png`.
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    file: String,
    sha256: String,
}

/// The sources a build uses: the reference, the pilot when there is one,
/// and one version of every atlas sheet (the highest, or the one
/// `accepted.json` pins).
fn choose_sources(sources: &Path) -> Result<Vec<(ChosenSource, PathBuf)>, String> {
    let entries = std::fs::read_dir(sources)
        .map_err(|error| format!("cannot read {}: {error}", sources.display()))?;
    let mut versions: BTreeMap<String, BTreeMap<u32, PathBuf>> = BTreeMap::new();
    let mut plain_reference = None;
    for entry in entries {
        let entry = entry.map_err(|error| format!("cannot read {}: {error}", sources.display()))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().is_file() {
            continue;
        }
        if file_name == "reference.png" {
            plain_reference = Some(entry.path());
        } else if let Some((key, version)) = parse_versioned(&file_name) {
            versions
                .entry(key)
                .or_default()
                .insert(version, entry.path());
        }
    }
    let accepted: BTreeMap<String, u32> = match std::fs::read(sources.join(ACCEPTED_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            format!("{ACCEPTED_FILE} is not a map of sheet to version: {error}")
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(format!("cannot read {ACCEPTED_FILE}: {error}")),
    };
    for (key, version) in &accepted {
        if key != REFERENCE_KEY && kind_of(key).is_none() {
            return Err(format!("{ACCEPTED_FILE} names an unknown sheet: {key}"));
        }
        if !versions
            .get(key)
            .is_some_and(|known| known.contains_key(version))
        {
            return Err(format!(
                "{ACCEPTED_FILE} pins {key} to v{version}, but {key}-v{version}.png is not there"
            ));
        }
    }
    let pick = |key: &str| -> Option<(u32, PathBuf)> {
        let known = versions.get(key)?;
        match accepted.get(key) {
            Some(version) => known.get(version).map(|path| (*version, path.clone())),
            None => known
                .last_key_value()
                .map(|(version, path)| (*version, path.clone())),
        }
    };
    let chosen = |key: &str, version: Option<u32>, path: PathBuf| -> Result<_, String> {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        Ok((
            ChosenSource {
                key: key.to_string(),
                version,
                file: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                sha256: sha256_hex(&bytes),
            },
            path,
        ))
    };

    let mut out = Vec::new();
    let reference = match (accepted.contains_key(REFERENCE_KEY), plain_reference) {
        (false, Some(path)) => chosen(REFERENCE_KEY, None, path)?,
        _ => match pick(REFERENCE_KEY) {
            Some((version, path)) => chosen(REFERENCE_KEY, Some(version), path)?,
            None => return Err("no reference.png (or reference-v<n>.png)".to_string()),
        },
    };
    out.push(reference);
    if let Some((version, path)) = pick(SheetKind::Pilot.key()) {
        out.push(chosen(SheetKind::Pilot.key(), Some(version), path)?);
    }
    let mut missing = Vec::new();
    for kind in SheetKind::ATLAS_ORDER {
        match pick(kind.key()) {
            Some((version, path)) => out.push(chosen(kind.key(), Some(version), path)?),
            None => missing.push(format!("{}-v<n>.png", kind.key())),
        }
    }
    if !missing.is_empty() {
        return Err(format!("missing sheets: {}", missing.join(", ")));
    }
    Ok(out)
}

fn build_input(
    chosen: &[(ChosenSource, PathBuf)],
    name: &str,
    cell_size: u32,
    created_at: DateTime<Utc>,
) -> BuildInput {
    let mut reference = None;
    let mut pilot = None;
    let mut sheets = Vec::new();
    for (source, path) in chosen {
        if source.key == REFERENCE_KEY {
            reference = Some(SourceFile {
                path: path.clone(),
                sha256: source.sha256.clone(),
            });
            continue;
        }
        let Some(kind) = kind_of(&source.key) else {
            continue;
        };
        let input = SheetInput {
            kind,
            path: path.clone(),
            sha256: source.sha256.clone(),
        };
        if kind == SheetKind::Pilot {
            pilot = Some(input);
        } else {
            sheets.push(input);
        }
    }
    BuildInput {
        name: name.to_string(),
        reference: reference.expect("choose_sources always picks a reference"),
        pilot,
        sheets,
        cell_size,
        created_at,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackFile {
    name: String,
    bytes: u64,
    sha256: String,
}

fn pack_files(dir: &Path) -> Result<Vec<PackFile>, String> {
    PACK_FILES
        .iter()
        .filter(|name| dir.join(name).is_file())
        .map(|name| {
            let bytes = std::fs::read(dir.join(name))
                .map_err(|error| format!("cannot read {name}: {error}"))?;
            Ok(PackFile {
                name: name.to_string(),
                bytes: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
            })
        })
        .collect()
}

/// What the app's loader says about a pack folder.
fn verify_pack(dir: &Path) -> Value {
    match buddy_pet::load_pack_dir(dir, VERIFY_PACK_ID) {
        Ok(pack) => {
            let cell_size = pack
                .manifest
                .neutral_frame()
                .map(|frame| frame.cell_size())
                .unwrap_or_default();
            json!({
                "ok": true,
                "name": pack.manifest.name,
                "frames": pack.manifest.frames.len(),
                "gazeFrames": pack.manifest.gaze_count(),
                "reactions": pack.manifest.reaction_ids(),
                "cellSize": cell_size,
                "neutral": pack.manifest.neutral,
                "headTop": pack.sidecar.head_top,
                "talk": pack.sidecar.talk,
                "decodedBytes": pack.decoded_bytes(),
                "sidecarOnDisk": pack.sidecar_on_disk,
            })
        }
        Err(error) => json!({
            "ok": false,
            "rule": error.rule.as_str(),
            "message": error.message,
        }),
    }
}

fn build_result(
    sources: &Path,
    out: &Path,
    name: &str,
    cell_size: u32,
    created_at: Option<&str>,
) -> Value {
    let created_at = match created_at {
        Some(text) => match DateTime::parse_from_rfc3339(text) {
            Ok(parsed) => parsed.with_timezone(&Utc),
            Err(error) => {
                return json!({
                    "ok": false,
                    "error": { "code": "usage", "message": format!("--created-at: {error}") },
                });
            }
        },
        None => Utc::now(),
    };
    let chosen = match choose_sources(sources) {
        Ok(chosen) => chosen,
        Err(message) => {
            return json!({ "ok": false, "error": { "code": "sources", "message": message } });
        }
    };
    let listed: Vec<&ChosenSource> = chosen.iter().map(|(source, _)| source).collect();
    let input = build_input(&chosen, name, cell_size, created_at);
    let outcome: BuildOutcome = match build_pack(&input, out, |_| {}) {
        Ok(outcome) => outcome,
        Err(error) => {
            let mut detail = serde_json::to_value(&error).unwrap_or_else(|_| json!({}));
            if let Value::Object(map) = &mut detail {
                map.insert("message".to_string(), json!(error.to_string()));
                map.insert("code".to_string(), json!(error.code()));
            }
            return json!({ "ok": false, "sources": listed, "error": detail });
        }
    };
    let cells: Vec<Value> = outcome
        .report
        .cells
        .iter()
        .map(|cell| {
            json!({
                "id": cell.id,
                "sheet": cell.sheet,
                "cell": cell.cell,
                "isolated": cell.isolated,
                "scale": cell.scale,
                "minimumMargin": cell.minimum_margin,
                "anchorDrift": cell.anchor_drift,
                "outputBounds": cell.output_bounds,
                "rect": cell.rect,
            })
        })
        .collect();
    let files = match pack_files(out) {
        Ok(files) => files,
        Err(message) => {
            return json!({ "ok": false, "sources": listed, "error": { "code": "write", "message": message } });
        }
    };
    let loader = verify_pack(out);
    json!({
        "ok": loader["ok"] == json!(true),
        "sources": listed,
        "name": outcome.manifest.name,
        "cellSize": outcome.report.cell_size,
        "frames": outcome.manifest.frames.len(),
        "atlasSize": [outcome.atlas_width, outcome.atlas_height],
        "neutral": outcome.report.neutral,
        "headTop": outcome.sidecar.head_top,
        "cells": cells,
        "files": files,
        "loader": loader,
    })
}

fn verify_result(pack: &Path) -> Value {
    let loader = verify_pack(pack);
    let files = pack_files(pack).unwrap_or_default();
    json!({ "ok": loader["ok"] == json!(true), "files": files, "loader": loader })
}

fn print_text(result: &Value) {
    if let Some(sources) = result["sources"].as_array() {
        for source in sources {
            println!(
                "source  {:<12} {:<22} {}",
                source["key"].as_str().unwrap_or_default(),
                source["file"].as_str().unwrap_or_default(),
                &source["sha256"].as_str().unwrap_or_default()
                    [..12.min(source["sha256"].as_str().unwrap_or_default().len())]
            );
        }
    }
    if let Some(cells) = result["cells"].as_array() {
        for cell in cells {
            println!(
                "ok      {:<12} {:<10} scale {:.4}  margin {:>6.1} px  drift {:+.1}/{:+.1} px{}",
                cell["sheet"].as_str().unwrap_or_default(),
                cell["id"].as_str().unwrap_or_default(),
                cell["scale"].as_f64().unwrap_or_default(),
                cell["minimumMargin"].as_f64().unwrap_or_default(),
                cell["anchorDrift"][0].as_f64().unwrap_or_default(),
                cell["anchorDrift"][1].as_f64().unwrap_or_default(),
                if cell["isolated"] == json!(true) {
                    "  (isolated)"
                } else {
                    ""
                }
            );
        }
    }
    if let Some(error) = result.get("error") {
        println!(
            "REFUSED [{}] {}",
            error["code"].as_str().unwrap_or_default(),
            error["message"].as_str().unwrap_or_default()
        );
    }
    if let Some(files) = result["files"].as_array() {
        for file in files {
            println!(
                "file    {:<18} {:>10} bytes  {}",
                file["name"].as_str().unwrap_or_default(),
                file["bytes"].as_u64().unwrap_or_default(),
                file["sha256"].as_str().unwrap_or_default()
            );
        }
    }
    let loader = &result["loader"];
    if loader["ok"] == json!(true) {
        println!(
            "loader  ok: {} frames ({} gaze), {} px cells, head top {}, talk {}",
            loader["frames"],
            loader["gazeFrames"],
            loader["cellSize"],
            loader["headTop"],
            loader["talk"]
        );
    } else if loader.is_object() {
        println!(
            "loader  REFUSED [{}] {}",
            loader["rule"].as_str().unwrap_or_default(),
            loader["message"].as_str().unwrap_or_default()
        );
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse_args(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("buddy_pack: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let (result, json) = match &command {
        Command::Build {
            sources,
            out,
            name,
            cell_size,
            created_at,
            json,
        } => (
            build_result(sources, out, name, *cell_size, created_at.as_deref()),
            *json,
        ),
        Command::Verify { pack, json } => (verify_result(pack), *json),
    };
    if json {
        println!("{result}");
    } else {
        print_text(&result);
    }
    if result["ok"] == json!(true) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buddy_pet_build::tests::{CELL_H, Figure, TEST_CELL_SIZE, draw_figure, sheet_image};
    use image::RgbaImage;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SCRATCH: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "videorc-buddy-pack-example-{}-{tag}-{unique}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("sources")).unwrap();
            Scratch(dir)
        }

        fn sources(&self) -> PathBuf {
            self.0.join("sources")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_png(path: &Path, image: &RgbaImage) -> String {
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        std::fs::write(path, &bytes).unwrap();
        sha256_hex(&bytes)
    }

    /// A full synthetic sheet set as a creation writes it, every sheet v1.
    fn write_sheet_set(sources: &Path) -> BTreeMap<String, String> {
        let mut hashes = BTreeMap::new();
        let mut reference = RgbaImage::new(120, 260);
        draw_figure(&mut reference, &Figure::at(60, 240, [90, 90, 90]));
        hashes.insert(
            REFERENCE_KEY.to_string(),
            write_png(&sources.join("reference.png"), &reference),
        );
        for kind in sheet_kinds() {
            let image = sheet_image(kind, CELL_H, |_, _| {});
            let file = sources.join(format!("{}-v1.png", kind.key()));
            hashes.insert(kind.key().to_string(), write_png(&file, &image));
        }
        hashes
    }

    fn build(scratch: &Scratch) -> Value {
        build_result(
            &scratch.sources(),
            &scratch.0.join("pack"),
            "Test Buddy",
            TEST_CELL_SIZE,
            Some("2026-10-09T12:00:00Z"),
        )
    }

    #[test]
    fn a_synthetic_sheet_set_builds_into_a_pack_the_app_loads() {
        let scratch = Scratch::new("happy");
        let hashes = write_sheet_set(&scratch.sources());
        let result = build(&scratch);
        assert_eq!(result["ok"], json!(true), "{result:#}");
        assert_eq!(result["frames"], json!(40));
        assert_eq!(result["cellSize"], json!(TEST_CELL_SIZE));
        assert_eq!(
            result["atlasSize"],
            json!([5 * TEST_CELL_SIZE, 8 * TEST_CELL_SIZE])
        );
        assert_eq!(result["cells"].as_array().unwrap().len(), 40);
        assert_eq!(result["loader"]["ok"], json!(true));
        assert_eq!(result["loader"]["gazeFrames"], json!(25));
        assert_eq!(result["loader"]["talk"], json!(["talk-a", "talk-b"]));
        let names: Vec<&str> = result["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, PACK_FILES);
        // The provenance records the SHA-256 of every source it was built from.
        let provenance: Value = serde_json::from_slice(
            &std::fs::read(scratch.0.join("pack").join(PROVENANCE_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(provenance["referenceSha256"], json!(hashes[REFERENCE_KEY]));
        for kind in sheet_kinds() {
            assert_eq!(
                provenance["sources"][kind.key()],
                json!(hashes[kind.key()]),
                "{}",
                kind.key()
            );
        }
        // --verify reads the same pack the same way.
        let verified = verify_result(&scratch.0.join("pack"));
        assert_eq!(verified["ok"], json!(true));
        assert_eq!(verified["loader"]["frames"], json!(40));
    }

    #[test]
    fn the_highest_version_builds_unless_accepted_pins_another() {
        let scratch = Scratch::new("versions");
        let sources = scratch.sources();
        write_sheet_set(&sources);
        // A newer extras strip (a different colour) is picked up as it is.
        let extras_v2 = sheet_image(SheetKind::Extras, CELL_H, |index, figure| {
            *figure = Figure::at(
                index as i32 * 160 + 80,
                CELL_H as i32 - 60,
                [200, 40, 40 + index as u8],
            );
        });
        let extras_v2_sha = write_png(&sources.join("extras-v2.png"), &extras_v2);
        // A broken redo of a gaze strip (opaque) is skipped by a pin.
        let opaque = RgbaImage::from_pixel(800, CELL_H, image::Rgba([10, 10, 10, 255]));
        write_png(&sources.join("gaze-up1-v2.png"), &opaque);
        let refused = build(&scratch);
        assert_eq!(refused["ok"], json!(false));
        assert_eq!(refused["error"]["code"], json!("sheet-opaque"));
        assert_eq!(refused["error"]["sheet"], json!("gaze-up1"));

        std::fs::write(sources.join(ACCEPTED_FILE), br#"{ "gaze-up1": 1 }"#).unwrap();
        let result = build(&scratch);
        assert_eq!(result["ok"], json!(true), "{result:#}");
        let sources_used: BTreeMap<String, String> = result["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| {
                (
                    source["key"].as_str().unwrap().to_string(),
                    source["file"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(sources_used["gaze-up1"], "gaze-up1-v1.png");
        assert_eq!(sources_used["extras"], "extras-v2.png");
        assert_eq!(sources_used[REFERENCE_KEY], "reference.png");
        let provenance: Value = serde_json::from_slice(
            &std::fs::read(scratch.0.join("pack").join(PROVENANCE_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(provenance["sources"]["extras"], json!(extras_v2_sha));
    }

    #[test]
    fn a_missing_sheet_or_a_bad_pin_is_named() {
        let scratch = Scratch::new("missing");
        let sources = scratch.sources();
        write_sheet_set(&sources);
        std::fs::remove_file(sources.join("reactions-b-v1.png")).unwrap();
        std::fs::remove_file(sources.join("gaze-down2-v1.png")).unwrap();
        let result = build(&scratch);
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"]["code"], json!("sources"));
        assert_eq!(
            result["error"]["message"],
            json!("missing sheets: gaze-down2-v<n>.png, reactions-b-v<n>.png")
        );

        write_sheet_set(&sources);
        std::fs::write(sources.join(ACCEPTED_FILE), br#"{ "extras": 3 }"#).unwrap();
        let result = build(&scratch);
        assert_eq!(
            result["error"]["message"],
            json!("accepted.json pins extras to v3, but extras-v3.png is not there")
        );
    }

    #[test]
    fn file_names_and_arguments_parse() {
        assert_eq!(
            parse_versioned("gaze-up1-v12.png"),
            Some(("gaze-up1".to_string(), 12))
        );
        assert_eq!(
            parse_versioned("reference-v2.png"),
            Some(("reference".to_string(), 2))
        );
        assert_eq!(parse_versioned("gaze-up1-v0.png"), None);
        assert_eq!(parse_versioned("gaze-sideways-v1.png"), None);
        assert_eq!(parse_versioned("extras-v1.webp"), None);
        assert_eq!(parse_versioned("extras-vx.png"), None);
        let args = |text: &str| -> Vec<String> { text.split(' ').map(String::from).collect() };
        assert_eq!(
            parse_args(&args("src out --name Golmar --cell-size 512 --json")),
            Ok(Command::Build {
                sources: PathBuf::from("src"),
                out: PathBuf::from("out"),
                name: "Golmar".to_string(),
                cell_size: 512,
                created_at: None,
                json: true,
            })
        );
        assert_eq!(
            parse_args(&args("--verify pack")),
            Ok(Command::Verify {
                pack: PathBuf::from("pack"),
                json: false,
            })
        );
        assert!(parse_args(&args("only-one")).is_err());
        assert!(parse_args(&args("a b --cell-size big")).is_err());
        assert!(parse_args(&args("a b --shiny")).is_err());
    }
}
