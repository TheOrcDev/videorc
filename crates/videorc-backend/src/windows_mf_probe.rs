//! Diagnostic-only, process-isolated MF experiments. Never used for encoder selection.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

pub const REPORT_FILE: &str = "windows-mf-probe.json";
const MAX_REPORT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CHILD_BYTES: u64 = 32 * 1024;
const CHILD_DEADLINE: Duration = Duration::from_secs(20);
const REAP_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeCase {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub requested_bitrate_kbps: u32,
    pub bitrate_kbps: u32,
    pub subtype: String,
    pub d3d11_upload: bool,
    pub video_support: bool,
    pub multithread_protected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncoderIdentity {
    pub index: usize,
    pub name: String,
    pub adapter_luid: Option<String>,
    pub adapter_description: Option<String>,
    pub driver_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeAttempt {
    pub case: ProbeCase,
    pub encoder: Option<EncoderIdentity>,
    pub state: String,
    pub stage: String,
    pub hresult: Option<String>,
    pub reason: Option<String>,
    pub elapsed_ms: u64,
    pub idr: bool,
    pub encoded_frames: u64,
    pub actual_subtype: Option<String>,
    pub actual_d3d11_upload: Option<bool>,
    pub actual_video_support: Option<bool>,
    pub actual_multithread_protected: Option<bool>,
    pub child_ready: bool,
    pub child_reaped: bool,
}

impl ProbeAttempt {
    pub fn pending(case: ProbeCase, encoder: Option<EncoderIdentity>) -> Self {
        Self {
            case,
            encoder,
            state: "pending".into(),
            stage: "not-started".into(),
            hresult: None,
            reason: None,
            elapsed_ms: 0,
            idr: false,
            encoded_frames: 0,
            actual_subtype: None,
            actual_d3d11_upload: None,
            actual_video_support: None,
            actual_multithread_protected: None,
            child_ready: false,
            child_reaped: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeReport {
    pub schema_version: u32,
    pub kind: String,
    pub generated_at: String,
    pub platform: String,
    pub backend_version: String,
    pub backend_sha256: String,
    pub source_commit: Option<String>,
    pub measurement_complete: bool,
    pub inventory: Vec<EncoderIdentity>,
    pub cases: Vec<ProbeCase>,
    pub inventory_error: Option<String>,
    pub attempts: Vec<ProbeAttempt>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ChildResult {
    Inventory { encoders: Vec<EncoderIdentity> },
    Attempt { result: Box<ProbeAttempt> },
    Error { reason: String },
}

pub fn matrix(args: &[String]) -> Result<Vec<ProbeCase>> {
    let profiles = if args.is_empty() {
        vec![(1920, 1080, 30, 6000), (1280, 720, 30, 6000)]
    } else {
        ensure!(
            args.len().is_multiple_of(2) && args.len() <= 4,
            "Expected pairs: WxH@fps kbps (at most two profiles)"
        );
        args.chunks_exact(2)
            .map(|pair| {
                let (size, fps) = pair[0].split_once('@').context("Expected WxH@fps")?;
                let (width, height) = size.split_once('x').context("Expected WxH@fps")?;
                Ok((
                    width.parse()?,
                    height.parse()?,
                    fps.parse()?,
                    pair[1].parse()?,
                ))
            })
            .collect::<Result<Vec<(u32, u32, u32, u32)>>>()?
    };
    let mut cases = Vec::new();
    for (width, height, fps, requested) in profiles {
        ensure!(
            (16..=3840).contains(&width)
                && width.is_multiple_of(2)
                && (16..=2160).contains(&height)
                && height.is_multiple_of(2)
                && (1..=60).contains(&fps)
                && (500..=20000).contains(&requested),
            "Probe profile is outside bounded dimensions/fps/bitrate"
        );
        let mut bitrates = vec![requested];
        for alternative in [5500, 5000] {
            if alternative < requested && (requested >= 6000 || alternative == 5000) {
                bitrates.push(alternative);
            }
        }
        for bitrate in bitrates {
            for (subtype, upload, video, protected) in [
                ("NV12", true, false, false),
                ("NV12", true, true, false),
                ("NV12", true, false, true),
                ("NV12", true, true, true),
                ("NV12", false, false, false),
                ("I420", false, false, false),
            ] {
                cases.push(ProbeCase {
                    width,
                    height,
                    fps,
                    requested_bitrate_kbps: requested,
                    bitrate_kbps: bitrate,
                    subtype: subtype.into(),
                    d3d11_upload: upload,
                    video_support: video,
                    multithread_protected: protected,
                });
            }
        }
    }
    Ok(cases)
}

pub fn report_path(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(REPORT_FILE)
}

fn validate_report(report: &ProbeReport) -> Result<()> {
    ensure!(
        report.schema_version == 1
            && report.kind == "videorc.windows-mf-probe"
            && report.platform == "windows",
        "Unsupported MF report identity"
    );
    ensure!(
        report.backend_sha256.len() == 64
            && report.backend_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid backend digest"
    );
    ensure!(
        report
            .source_commit
            .as_ref()
            .is_none_or(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())),
        "Invalid embedded source identity"
    );
    ensure!(
        report.backend_version.len() <= 64
            && report.generated_at.len() <= 64
            && report
                .inventory_error
                .as_ref()
                .is_none_or(|s| s.chars().count() <= 2048),
        "Unbounded MF identity"
    );
    ensure!(
        report.inventory.len() <= 8 && !report.cases.is_empty() && report.cases.len() <= 36,
        "Unbounded MF matrix"
    );
    for (index, encoder) in report.inventory.iter().enumerate() {
        ensure!(
            encoder.index == index
                && !encoder.name.is_empty()
                && encoder.name.chars().count() <= 256
                && encoder
                    .adapter_description
                    .as_ref()
                    .is_none_or(|s| s.chars().count() <= 256)
                && encoder
                    .driver_version
                    .as_ref()
                    .is_none_or(|s| s.len() <= 128)
                && encoder
                    .adapter_luid
                    .as_ref()
                    .is_none_or(|s| s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())),
            "Invalid MF encoder identity"
        );
    }
    for case in &report.cases {
        ensure!(
            matrix(&[
                format!("{}x{}@{}", case.width, case.height, case.fps),
                case.requested_bitrate_kbps.to_string()
            ])?
            .contains(case),
            "Invalid MF case"
        );
    }
    let encoders = report.inventory.len().max(1);
    let expected = report.cases.len() * encoders;
    ensure!(
        report.attempts.len() <= expected
            && (!report.measurement_complete
                || (report.inventory_error.is_none() && report.attempts.len() == expected)),
        "Incomplete MF report claimed complete"
    );
    for (index, attempt) in report.attempts.iter().enumerate() {
        ensure!(
            attempt.case == report.cases[index / encoders]
                && attempt.encoder.as_ref() == report.inventory.get(index % encoders),
            "MF attempt order/identity mismatch"
        );
        ensure!(
            matches!(
                attempt.state.as_str(),
                "rejected" | "encoded-idr" | "no-encoder" | "failed"
            ) && !attempt.stage.is_empty()
                && attempt.stage.len() <= 128
                && attempt
                    .reason
                    .as_ref()
                    .is_none_or(|s| s.chars().count() <= 2048)
                && attempt.hresult.as_ref().is_none_or(|s| s.len() == 10
                    && s.starts_with("0x")
                    && s[2..].bytes().all(|b| b.is_ascii_hexdigit())),
            "Invalid MF attempt outcome"
        );
        if attempt.state == "encoded-idr" {
            ensure!(
                attempt.idr
                    && attempt.encoded_frames > 0
                    && attempt.child_ready
                    && attempt.child_reaped
                    && attempt.actual_subtype.as_ref() == Some(&attempt.case.subtype)
                    && attempt.actual_d3d11_upload == Some(attempt.case.d3d11_upload),
                "MF success lacks exact input/output evidence"
            );
            if attempt.case.d3d11_upload {
                ensure!(
                    attempt.actual_video_support == Some(attempt.case.video_support)
                        && attempt.actual_multithread_protected
                            == Some(attempt.case.multithread_protected),
                    "MF success has different device flags"
                );
            }
        }
        if attempt.state == "no-encoder" {
            ensure!(
                report.inventory.is_empty() && !attempt.idr && attempt.stage == "enumerate",
                "No-encoder verdict conflicts with inventory"
            );
        }
    }
    Ok(())
}

pub fn load_report(database_path: &Path) -> Result<Option<ProbeReport>> {
    let path = report_path(database_path);
    if !path.exists() {
        return Ok(None);
    }
    ensure!(
        std::fs::symlink_metadata(&path)?.file_type().is_file(),
        "MF report must be a regular file"
    );
    ensure!(
        std::fs::metadata(&path)?.len() <= MAX_REPORT_BYTES,
        "MF report exceeds bounded size"
    );
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_REPORT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_REPORT_BYTES,
        "MF report exceeds bounded read"
    );
    let report: ProbeReport = serde_json::from_slice(&bytes)?;
    validate_report(&report)?;
    Ok(Some(report))
}

fn persist(path: &Path, report: &ProbeReport) -> Result<()> {
    validate_report(report)?;
    let bytes = serde_json::to_vec_pretty(report)?;
    ensure!(
        bytes.len() as u64 <= MAX_REPORT_BYTES,
        "MF report exceeds bounded size"
    );
    std::fs::create_dir_all(path.parent().context("Probe report directory missing")?)?;
    use std::io::Write;
    let temporary = path.with_file_name(format!(".mf-probe-{}.tmp", uuid::Uuid::new_v4()));
    let publication = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        crate::atomic_file::replace_file(&temporary, path)?;
        Ok(())
    })();
    if publication.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    publication?;
    Ok(())
}

#[derive(Debug)]
struct ChildOutcome {
    result: std::result::Result<ChildResult, String>,
    ready: bool,
}

async fn child_output(
    mut command: tokio::process::Command,
    deadline: Duration,
) -> Result<ChildOutcome> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Windows children join the backend kill-on-close Job Object, including
    // when the outer CLI wrapper is cancelled or killed.
    let mut child = crate::process_job::spawn_owned_tokio(&mut command)?;
    let stdout = child.stdout.take().context("Missing probe child stdout")?;
    let mut lines = BufReader::new(stdout.take(MAX_CHILD_BYTES + 1)).lines();
    let mut ready = false;
    let mut consumed = 0;
    let received = tokio::time::timeout(deadline, async {
        let mut payload = None;
        while let Some(line) = lines.next_line().await? {
            consumed += line.len() + 1;
            ensure!(
                consumed as u64 <= MAX_CHILD_BYTES,
                "Probe child output exceeded limit"
            );
            if line == "VIDEORC_MF_PROBE_READY" {
                ready = true;
                continue;
            }
            // The owned Rust test child uses libtest's tiny preamble. No
            // arbitrary driver output can stand in for the readiness marker.
            if !ready && (line.is_empty() || line == "running 1 test") {
                continue;
            }
            ensure!(
                ready && payload.is_none(),
                "Probe child violated readiness/result protocol"
            );
            payload = Some(serde_json::from_str::<ChildResult>(&line)?);
        }
        let status = child.wait().await?;
        ensure!(status.success(), "Probe child exited {status}");
        payload.context("Probe child produced no result")
    })
    .await;
    match received {
        Ok(Ok(result)) => Ok(ChildOutcome {
            result: Ok(result),
            ready,
        }),
        failure => {
            let _ = child.start_kill();
            tokio::time::timeout(REAP_DEADLINE, child.wait())
                .await
                .context("Owned MF child cleanup deadline exceeded")??;
            let reason = match failure {
                Ok(Err(error)) => format!("{error:#}"),
                Err(_) => "Probe child deadline exceeded; owned child killed and reaped".into(),
                Ok(Ok(_)) => unreachable!(),
            };
            Ok(ChildOutcome {
                result: Err(reason),
                ready,
            })
        }
    }
}

fn normalized_source_commit(value: Option<&str>) -> Option<String> {
    value
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned)
}

async fn run_matrix(cases: Vec<ProbeCase>) -> Result<()> {
    ensure!(
        cfg!(target_os = "windows"),
        "Media Foundation measurements require Windows"
    );
    let executable = std::env::current_exe()?;
    let mut report = ProbeReport {
        schema_version: 1,
        kind: "videorc.windows-mf-probe".into(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        platform: std::env::consts::OS.into(),
        backend_version: env!("CARGO_PKG_VERSION").into(),
        backend_sha256: crate::digest_hex::lower_hex(Sha256::digest(std::fs::read(&executable)?)),
        source_commit: normalized_source_commit(
            option_env!("VIDEORC_GIT_SHA")
                .or(option_env!("GIT_SHA"))
                .or(option_env!("VERGEN_GIT_SHA")),
        ),
        measurement_complete: false,
        inventory: vec![],
        cases: cases.clone(),
        inventory_error: None,
        attempts: vec![],
    };
    let path = report_path(&crate::storage::default_database_path());
    persist(&path, &report)?;
    let mut command = tokio::process::Command::new(&executable);
    command.args(["--windows-mf-probe-child", "inventory"]);
    match child_output(command, CHILD_DEADLINE).await {
        Ok(ChildOutcome {
            result: Ok(ChildResult::Inventory { encoders }),
            ..
        }) if encoders.len() <= 8 => report.inventory = encoders,
        other => report.inventory_error = Some(format!("{other:?}").chars().take(2048).collect()),
    }
    persist(&path, &report)?;
    if report.inventory_error.is_some() {
        bail!("MF inventory failed; retained {}", path.display());
    }
    for case in cases {
        if report.inventory.is_empty() {
            let mut result = ProbeAttempt::pending(case, None);
            result.state = "no-encoder".into();
            result.stage = "enumerate".into();
            result.child_ready = true;
            result.child_reaped = true;
            println!("{}", serde_json::to_string(&result)?);
            report.attempts.push(result);
            persist(&path, &report)?;
            continue;
        }
        for encoder in &report.inventory {
            let mut result = ProbeAttempt::pending(case.clone(), Some(encoder.clone()));
            let start = Instant::now();
            let mut command = tokio::process::Command::new(&executable);
            command.args(["--windows-mf-probe-child", &serde_json::to_string(&result)?]);
            let outcome = child_output(command, CHILD_DEADLINE).await;
            let cleanup_failed = outcome.is_err();
            match outcome {
                Ok(ChildOutcome {
                    result:
                        Ok(ChildResult::Attempt {
                            result: child_result,
                        }),
                    ready,
                }) if child_result.case == case
                    && child_result.encoder.as_ref() == Some(encoder) =>
                {
                    result = *child_result;
                    result.child_ready = ready;
                    result.child_reaped = true;
                }
                Ok(outcome) => {
                    result.state = "failed".into();
                    result.stage = "child-supervisor".into();
                    result.child_ready = outcome.ready;
                    result.child_reaped = true;
                    result.reason =
                        Some(format!("{:?}", outcome.result).chars().take(2048).collect());
                }
                Err(error) => {
                    result.state = "failed".into();
                    result.stage = "child-cleanup".into();
                    result.reason = Some(format!("{error:#}").chars().take(2048).collect());
                }
            }
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            println!(
                "{}x{}@{} {}kbps {} upload={} video={} protected={} stage={} HRESULT={} {}ms IDR={} state={}",
                case.width,
                case.height,
                case.fps,
                case.bitrate_kbps,
                case.subtype,
                case.d3d11_upload,
                case.video_support,
                case.multithread_protected,
                result.stage,
                result.hresult.as_deref().unwrap_or("unknown"),
                result.elapsed_ms,
                result.idr,
                result.state
            );
            report.attempts.push(result);
            persist(&path, &report)?;
            ensure!(
                !cleanup_failed,
                "MF probe child could not be reaped; no further probes will start"
            );
        }
    }
    report.measurement_complete = true;
    persist(&path, &report)?;
    println!(
        "MF measurement complete: {} attempts; {} (no-encoder is a measurement, not hardware support)",
        report.attempts.len(),
        path.display()
    );
    Ok(())
}

pub fn run_cli(args: &[String]) -> Result<bool> {
    match args.first().map(String::as_str) {
        Some("--windows-incident-capabilities") => {
            ensure!(args.len() == 1, "Unexpected capability arguments");
            println!(
                "{}",
                serde_json::json!({"schemaVersion": 1, "debugBuild": cfg!(debug_assertions), "workerFailureInjection": cfg!(all(target_os = "windows", debug_assertions)), "ffmpegToneControl": cfg!(debug_assertions), "backendCrateVersion": env!("CARGO_PKG_VERSION")})
            );
            Ok(true)
        }
        Some("--windows-mf-probe-matrix") => {
            let cases = matrix(&args[1..])?;
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(run_matrix(cases))?;
            Ok(true)
        }
        Some("--windows-mf-probe-child") => {
            ensure!(args.len() == 2, "Expected one probe child request");
            println!("VIDEORC_MF_PROBE_READY");
            use std::io::Write;
            std::io::stdout().flush()?;
            let result = run_native_child(&args[1]).unwrap_or_else(|error| ChildResult::Error {
                reason: format!("{error:#}").chars().take(2048).collect(),
            });
            println!("{}", serde_json::to_string(&result)?);
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[cfg(target_os = "windows")]
fn run_native_child(request: &str) -> Result<ChildResult> {
    if request == "inventory" {
        return Ok(ChildResult::Inventory {
            encoders: crate::windows_media_foundation_encoder::diagnostic_inventory()?,
        });
    }
    let attempt: ProbeAttempt = serde_json::from_str(request)?;
    let valid = matrix(&[
        format!(
            "{}x{}@{}",
            attempt.case.width, attempt.case.height, attempt.case.fps
        ),
        attempt.case.requested_bitrate_kbps.to_string(),
    ])?;
    ensure!(
        valid.contains(&attempt.case),
        "Invalid diagnostic probe case"
    );
    Ok(ChildResult::Attempt {
        result: Box::new(crate::windows_media_foundation_encoder::diagnostic_attempt(
            attempt,
        )),
    })
}

#[cfg(not(target_os = "windows"))]
fn run_native_child(_request: &str) -> Result<ChildResult> {
    bail!("Media Foundation requires Windows")
}

#[cfg(test)]
pub(crate) fn test_report() -> ProbeReport {
    let cases = matrix(&[]).unwrap();
    let attempts = cases
        .iter()
        .map(|case| {
            let mut attempt = ProbeAttempt::pending(case.clone(), None);
            attempt.state = "no-encoder".into();
            attempt.stage = "enumerate".into();
            attempt.child_ready = true;
            attempt.child_reaped = true;
            attempt
        })
        .collect();
    ProbeReport {
        schema_version: 1,
        kind: "videorc.windows-mf-probe".into(),
        generated_at: "2026-09-27T00:00:00Z".into(),
        platform: "windows".into(),
        backend_version: "0.9.0".into(),
        backend_sha256: "a".repeat(64),
        source_commit: None,
        measurement_complete: true,
        inventory: vec![],
        cases,
        inventory_error: None,
        attempts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mf_probe_child_fixture() {
        let Ok(mode) = std::env::var("VIDEORC_MF_PROBE_TEST_CHILD") else {
            return;
        };
        use std::io::Write;
        println!("VIDEORC_MF_PROBE_READY");
        std::io::stdout().flush().unwrap();
        match mode.as_str() {
            "hang" => loop {
                std::thread::park();
            },
            "malformed" => println!("not-json"),
            _ => println!(
                "{}",
                serde_json::to_string(&ChildResult::Inventory { encoders: vec![] }).unwrap()
            ),
        }
        std::process::exit(0);
    }

    #[tokio::test]
    async fn mf_probe_owned_child_timeout_and_protocol_failure_are_reaped() {
        for mode in ["ok", "malformed", "hang"] {
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command.args([
                "--exact",
                "windows_mf_probe::tests::mf_probe_child_fixture",
                "--nocapture",
                "--quiet",
            ]);
            command.env("VIDEORC_MF_PROBE_TEST_CHILD", mode);
            let outcome = child_output(command, Duration::from_secs(5)).await.unwrap();
            assert!(
                outcome.ready,
                "child never reached explicit readiness: {mode}"
            );
            assert_eq!(outcome.result.is_ok(), mode == "ok");
            if mode == "hang" {
                assert!(outcome.result.unwrap_err().contains("killed and reaped"));
            }
        }
    }

    #[test]
    fn mf_probe_partial_snapshot_survives_failed_replacement_and_validates_identity() {
        let root = std::env::temp_dir().join(format!("videorc-mf-atomic-{}", uuid::Uuid::new_v4()));
        let path = root.join(REPORT_FILE);
        let mut report = test_report();
        report.measurement_complete = false;
        report.attempts.truncate(1);
        persist(&path, &report).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut invalid = report.clone();
        invalid.source_commit = Some("shortsha".into());
        assert!(persist(&path, &invalid).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        invalid = report.clone();
        invalid.attempts[0].state = "invented".into();
        assert!(persist(&path, &invalid).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(normalized_source_commit(Some("shortsha")).is_none());
        assert_eq!(
            normalized_source_commit(Some(&"a".repeat(40))),
            Some("a".repeat(40))
        );
        let mut huge = report.clone();
        huge.inventory_error = Some("x".repeat(MAX_REPORT_BYTES as usize));
        assert!(persist(&path, &huge).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            load_report(&root.join("db"))
                .unwrap()
                .unwrap()
                .attempts
                .len(),
            1
        );
        report.measurement_complete = true;
        assert!(validate_report(&report).is_err());
        let mut report = test_report();
        report.attempts[0].state = "encoded-idr".into();
        assert!(
            validate_report(&report).is_err(),
            "no encoder cannot claim IDR support"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mf_probe_matrix_is_exact_and_bounded() {
        let cases = matrix(&[]).unwrap();
        assert_eq!(cases.len(), 36);
        assert!(
            matrix(&["1280x720@30".into(), "5200".into()])
                .unwrap()
                .iter()
                .any(|case| case.bitrate_kbps == 5000)
        );
        assert_eq!(
            cases
                .iter()
                .filter(|case| !case.d3d11_upload && case.subtype == "I420")
                .count(),
            6
        );
        assert!(
            cases
                .iter()
                .filter(|case| case.d3d11_upload)
                .all(|case| case.subtype == "NV12")
        );
        assert!(matrix(&["99999x99999@30".into(), "6000".into()]).is_err());
        assert!(matrix(&["1920x1080@30".into()]).is_err());
    }

    #[test]
    fn mf_probe_report_loader_refuses_oversized_or_untyped_evidence() {
        let root = std::env::temp_dir().join(format!("videorc-mf-loader-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("db");
        std::fs::write(report_path(&database), b"{\"kind\":\"fake\"}").unwrap();
        assert!(load_report(&database).is_err());
        let file = std::fs::File::create(report_path(&database)).unwrap();
        file.set_len(MAX_REPORT_BYTES + 1).unwrap();
        assert!(load_report(&database).is_err());
        drop(file);
        std::fs::remove_dir_all(root).unwrap();
    }
}
