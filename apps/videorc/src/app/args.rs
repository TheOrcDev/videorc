//! The command line, the workspace and the data directory (plan 260 S2.1,
//! from `videorc-rust`'s `crates/videorc-app/src/main.rs`).

use std::path::PathBuf;

use anyhow::{Result, anyhow, bail};
use videorc_app_core::AppPaths;
use videorc_app_core::desktop::deep_link::links_in_args;

pub const USAGE: &str = "\
Videorc: the GPUI app (plan 260 S2.1: the shell and the backend supervisor)

USAGE:
    Videorc [OPTIONS] [videorc://LINK ...]

OPTIONS:
    --profile DIR        Isolated data directory (sqlite, secrets, recordings, logs all inside it).
                         Default: the real Videorc data directory, or VIDEORC_USER_DATA_DIR /
                         VIDEORC_APP_DATA_DIR when set.
    --backend PATH       Backend executable (default <workspace>/target/<this binary's profile>/videorc-backend)
    --cargo-run          Run the backend through `cargo run -p videorc-backend` instead (the dev chain)
    --workspace PATH     Workspace root (default: derived from the executable, or VIDEORC_WORKSPACE_ROOT)
    --quiet              Do not echo the backend's log lines to stderr (the log file still gets them)
    --quit-after SECS    Quit on its own after SECS (scripts and the build pass)
    --relaunched         Set by Reopen Videorc: wait for the old instance to let go of the
                         data directory instead of handing it the links
    -h, --help           This text

A videorc:// link is handed to the running instance for the same data directory.
";

pub struct Args {
    pub profile: Option<PathBuf>,
    pub backend: Option<PathBuf>,
    pub cargo_run: bool,
    pub workspace: Option<PathBuf>,
    pub quiet: bool,
    pub quit_after: Option<f64>,
    /// Reopen Videorc started this process (`app::permissions`).
    pub relaunched: bool,
    /// `videorc://` links on the command line.
    pub links: Vec<String>,
}

pub fn parse() -> Result<Args> {
    let mut args = Args {
        profile: None,
        backend: None,
        cargo_run: false,
        workspace: None,
        quiet: false,
        quit_after: None,
        relaunched: false,
        links: Vec::new(),
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| -> Result<String> {
            iter.next()
                .ok_or_else(|| anyhow!("{name} needs a value\n\n{USAGE}"))
        };
        match arg.as_str() {
            "--profile" => args.profile = Some(PathBuf::from(value("--profile")?)),
            "--backend" => args.backend = Some(PathBuf::from(value("--backend")?)),
            "--cargo-run" => args.cargo_run = true,
            "--workspace" => args.workspace = Some(PathBuf::from(value("--workspace")?)),
            "--quiet" => args.quiet = true,
            "--quit-after" => args.quit_after = Some(value("--quit-after")?.parse()?),
            "--relaunched" => args.relaunched = true,
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other if !links_in_args([other.to_string()]).is_empty() => {
                args.links.push(other.to_string())
            }
            // A Finder launch on older macOS passes its process serial number.
            other if other.starts_with("-psn_") => {}
            other => bail!("unknown argument {other}\n\n{USAGE}"),
        }
    }
    Ok(args)
}

/// The workspace root: `--workspace`, `VIDEORC_WORKSPACE_ROOT`, the
/// executable's `target/<profile>/..` parent, the manifest's grandparent, or
/// the current directory; the first that holds a `Cargo.toml` and a `crates`
/// directory wins.
pub fn workspace_root(explicit: Option<PathBuf>) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = explicit {
        candidates.push(path);
    }
    if let Some(path) = std::env::var_os("VIDEORC_WORKSPACE_ROOT") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(root) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
    {
        candidates.push(root.to_path_buf());
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".."),
    );
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    for candidate in candidates {
        if candidate.join("Cargo.toml").is_file() && candidate.join("crates").is_dir() {
            return Ok(candidate.canonicalize().unwrap_or(candidate));
        }
    }
    bail!("could not find the workspace root; pass --workspace")
}

/// `debug` or `release`: the backend built the same way as this binary.
pub fn build_profile_dir() -> &'static str {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent().and_then(|p| p.file_name())
        && dir == "release"
    {
        return "release";
    }
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

/// `--profile`, then `VIDEORC_USER_DATA_DIR` / `VIDEORC_APP_DATA_DIR`, then the
/// owner's real data directory (shared with Electron during the crossover).
pub fn app_paths(args: &Args) -> AppPaths {
    if let Some(profile) = &args.profile {
        return AppPaths::profile(profile.clone());
    }
    for name in ["VIDEORC_USER_DATA_DIR", "VIDEORC_APP_DATA_DIR"] {
        if let Some(dir) = std::env::var_os(name)
            && !dir.is_empty()
        {
            return AppPaths::profile(PathBuf::from(dir));
        }
    }
    AppPaths::real()
}
