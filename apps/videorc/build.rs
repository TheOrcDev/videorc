//! The app's version is the release's: `apps/desktop/package.json`'s
//! `version`, the one a release bumps and the GPUI packagers stamp into the
//! bundle (`package-gpui-macos.mjs`, `package-gpui-linux.mjs`). It is compiled
//! in as `VIDEORC_APP_VERSION` ([`crate::APP_VERSION`]), never the crate's own
//! `0.1.0`: the backend sends it to videorc.com as `Videorc-Desktop/<version>`,
//! and the site refuses managed shows and hand-off below 0.26.0.

use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let package = Path::new(&manifest).join("../desktop/package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let text = std::fs::read_to_string(&package).unwrap_or_else(|error| {
        panic!("the release version source {}: {error}", package.display())
    });
    let json: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", package.display()));
    let version = json["version"]
        .as_str()
        .filter(|version| is_release_version(version))
        .unwrap_or_else(|| panic!("{} has no x.y.z version", package.display()));
    println!("cargo:rustc-env=VIDEORC_APP_VERSION={version}");
}

/// `x.y.z`, each a number (a prerelease suffix is allowed after `z`).
fn is_release_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}
