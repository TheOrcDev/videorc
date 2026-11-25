//! Whether a downloaded installer is signed by Videorc's publisher (Windows).
//!
//! The feed's SHA-512 says the bytes are the ones that were published. This
//! says who published them. Windows itself does the checking, through
//! PowerShell's `Get-AuthenticodeSignature`; this module writes the command
//! and reads the answer.
//!
//! A port of `updater-signature.ts` with its tests, which replaced
//! `electron-updater`'s own check in the shipping repo. That check gave
//! PowerShell 20 seconds and threw the update away when the time ran out.
//! Hashing a 210 MB installer while Videorc's preview ran took 18 to 21 s
//! on an i5-8365U at 92% CPU (field report, 2026-11-10), so every 0.21.0
//! download was discarded and downloaded again at the next check. The
//! installer itself was valid.
//!
//! The trust rule is the original's: the status is Valid, the file checked
//! is the file downloaded, and the signer is the publisher. PowerShell gets
//! minutes, and is asked only for the three fields the rule needs. Any
//! failure still rejects: an update is never installed on a guess.
//!
//! The command goes through `cmd.exe` exactly as the original's does, so
//! what runs on a streamer's PC is the line that is already proven there.
//! One thing is added: a path that `cmd.exe` would rewrite is refused
//! before anything runs (see [`signature_check_command_line`]).

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

use crate::log::UpdaterLog;

/// How long PowerShell may take: three minutes.
pub const WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS: u64 = 3 * 60 * 1000;

/// What `cmd.exe` runs before the arguments. An unset `PSModulePath` keeps a
/// PowerShell 7 module path from breaking Windows PowerShell
/// (electron-builder issue 7127), and code page 65001 keeps a signer with a
/// letter outside ASCII (Málaga) intact.
pub const SIGNATURE_CHECK_SHELL_PREFIX: &str =
    "set \"PSModulePath=\" & chcp 65001 >NUL & powershell.exe";

/// The PowerShell command, in the double quotes `cmd.exe` passes it in.
pub fn signature_check_command(installer_path: &str) -> String {
    // A single quote is doubled inside a PowerShell single-quoted string.
    let literal_path = installer_path.replace('\'', "''");
    format!(
        "\"Get-AuthenticodeSignature -LiteralPath '{literal_path}' | \
         Select-Object @{{n='Status';e={{[int]$_.Status}}}},Path,\
         @{{n='Subject';e={{$_.SignerCertificate.Subject}}}} | ConvertTo-Json -Compress\""
    )
}

/// PowerShell's arguments, the command last.
pub fn signature_check_arguments(installer_path: &str) -> [String; 6] {
    [
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-InputFormat".to_string(),
        "None".to_string(),
        "-Command".to_string(),
        signature_check_command(installer_path),
    ]
}

/// The whole line `cmd.exe /d /s /c` is given: the prefix and the
/// arguments, joined by spaces, as Node joins them for a shell.
///
/// `None` for a path that would not reach PowerShell as it is. Inside
/// double quotes `cmd.exe` still expands `%NAME%`, so a path with a percent
/// sign could name another file; a double quote would end the quoting; a
/// control character has no place in a path. The original passes such a
/// path on. Refusing it is the same answer, given sooner and for a reason
/// that can be read.
pub fn signature_check_command_line(installer_path: &str) -> Option<String> {
    let unsafe_for_cmd = installer_path.is_empty()
        || installer_path
            .chars()
            .any(|character| character == '%' || character == '"' || character.is_control());
    if unsafe_for_cmd {
        return None;
    }
    Some(format!(
        "{SIGNATURE_CHECK_SHELL_PREFIX} {}",
        signature_check_arguments(installer_path).join(" ")
    ))
}

/// `CN=Uros Miric, O=Uros Miric, S="A, B"` as keys and values. A key that
/// comes twice keeps its last value. Empty for a bare name.
pub fn parse_distinguished_name(name: &str) -> BTreeMap<String, String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in name.chars() {
        if character == '"' {
            quoted = !quoted;
            current.push(character);
        } else if character == ',' && !quoted {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    parts.push(current);

    let mut result = BTreeMap::new();
    for part in parts {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = value.trim();
        if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            value = &value[1..value.len() - 1];
        }
        result.insert(key.to_string(), value.to_string());
    }
    result
}

/// Whether the signer is one of the publishers. A publisher written as a
/// distinguished name must match in every part it names; a bare name must
/// be the signer's common name.
fn signer_matches(publisher_names: &[&str], subject: &str) -> bool {
    let signer = parse_distinguished_name(subject);
    publisher_names.iter().any(|name| {
        let wanted = parse_distinguished_name(name);
        if wanted.is_empty() {
            return signer.get("CN").map(String::as_str) == Some(*name);
        }
        wanted
            .iter()
            .all(|(key, value)| signer.get(key) == Some(value))
    })
}

fn is_separator(character: char) -> bool {
    character == '\\' || character == '/'
}

/// The segments after the root: no empty ones, no `.`, and `..` resolved.
fn normalize_tail(tail: &[char], allow_above_root: bool) -> String {
    let mut kept: Vec<String> = Vec::new();
    for segment in tail.split(|character| is_separator(*character)) {
        let segment: String = segment.iter().collect();
        match segment.as_str() {
            "" | "." => {}
            ".." => {
                if kept.last().is_some_and(|last| last != "..") {
                    kept.pop();
                } else if allow_above_root {
                    kept.push(segment);
                }
            }
            _ => kept.push(segment),
        }
    }
    kept.join("\\")
}

/// A Windows path in one spelling: backslashes, no doubled separators, no
/// `.` or `..` segments. It follows Node's `path.win32.normalize`, which
/// the original compares with, for drive, UNC and rooted paths.
pub fn normalize_windows_path(path: &str) -> String {
    let characters: Vec<char> = path.chars().collect();
    let length = characters.len();
    if length == 0 {
        return ".".to_string();
    }
    if length == 1 {
        return if is_separator(characters[0]) {
            "\\".to_string()
        } else {
            path.to_string()
        };
    }

    let mut root_end = 0;
    let mut device: Option<String> = None;
    let mut absolute = false;
    if is_separator(characters[0]) {
        absolute = true;
        if is_separator(characters[1]) {
            // Perhaps a UNC root: \\server\share.
            let server_start = 2;
            let mut index = server_start;
            while index < length && !is_separator(characters[index]) {
                index += 1;
            }
            if index < length && index != server_start {
                let server: String = characters[server_start..index].iter().collect();
                let separators_start = index;
                while index < length && is_separator(characters[index]) {
                    index += 1;
                }
                if index < length && index != separators_start {
                    let share_start = index;
                    while index < length && !is_separator(characters[index]) {
                        index += 1;
                    }
                    let share: String = characters[share_start..index].iter().collect();
                    if index == length {
                        // Only the root: nothing is left to tidy.
                        return format!("\\\\{server}\\{share}\\");
                    }
                    if index != share_start {
                        device = Some(format!("\\\\{server}\\{share}"));
                        root_end = index;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if characters[0].is_ascii_alphabetic() && characters[1] == ':' {
        device = Some(characters[..2].iter().collect());
        root_end = 2;
        if length > 2 && is_separator(characters[2]) {
            absolute = true;
            root_end = 3;
        }
    }

    let mut tail = if root_end < length {
        normalize_tail(&characters[root_end..], !absolute)
    } else {
        String::new()
    };
    if tail.is_empty() && !absolute {
        tail.push('.');
    }
    if !tail.is_empty() && is_separator(characters[length - 1]) {
        tail.push('\\');
    }
    match (device, absolute) {
        (None, true) => format!("\\{tail}"),
        (None, false) => tail,
        (Some(device), true) => format!("{device}\\{tail}"),
        (Some(device), false) => format!("{device}{tail}"),
    }
}

/// Trims as JavaScript's `trim` does: white space, and the byte order mark
/// PowerShell may print first under code page 65001.
fn trim_answer(text: &str) -> &str {
    text.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

/// The status as the reason names it, for an answer that is not Valid.
fn status_text(status: Option<&Value>) -> String {
    match status {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `None` when the installer is trusted, otherwise why it is not.
/// `output` is what PowerShell printed, as JSON.
pub fn signature_verdict(
    publisher_names: &[&str],
    installer_path: &str,
    output: &Value,
) -> Option<String> {
    let status = output.get("Status");
    // 0 is SignatureStatus.Valid; the name covers PowerShell builds that
    // print the enum by name.
    let valid = match status {
        Some(Value::Number(number)) => number.as_f64() == Some(0.0),
        Some(Value::String(name)) => name == "Valid",
        _ => false,
    };
    if !valid {
        return Some(format!(
            "signature status {} is not Valid",
            status_text(status)
        ));
    }
    if let Some(checked_path) = output.get("Path").and_then(Value::as_str) {
        let checked = normalize_windows_path(checked_path).to_lowercase();
        let downloaded = normalize_windows_path(installer_path).to_lowercase();
        if checked != downloaded {
            return Some(format!(
                "PowerShell checked {checked_path}, not the downloaded installer"
            ));
        }
    }
    let subject = output
        .get("Subject")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if subject.is_empty() || !signer_matches(publisher_names, subject) {
        return Some(format!(
            "publisherNames: {}, signer: {}",
            publisher_names.join(" | "),
            if subject.is_empty() { "none" } else { subject }
        ));
    }
    None
}

/// How the PowerShell run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureRunOutcome {
    /// It ran past the time it was given and was stopped.
    TimedOut,
    /// It could not be started.
    NotStarted(String),
    /// It ran to its end. `success` is a zero exit code.
    Finished {
        success: bool,
        stdout: String,
        stderr: String,
    },
}

/// Runs the check's command line. The app's Windows half does it for real
/// ([`PowerShellRunner`]); a test answers from a script.
pub trait SignatureRunner {
    fn run(&mut self, command_line: &str, timeout_ms: u64) -> SignatureRunOutcome;
}

/// Why the check itself could not be made. The update is rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureCheckError {
    /// The installer's path would not reach PowerShell as it is.
    Path,
    /// PowerShell ran out of time.
    TimedOut { timeout_ms: u64 },
    /// PowerShell failed, or said something on its error stream.
    Tool(String),
    /// PowerShell's answer is not the JSON that was asked for.
    Unreadable(String),
}

impl fmt::Display for SignatureCheckError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Path => formatter.write_str(
                "Couldn't check the update's signature: the folder it was saved in has a name the check can't use.",
            ),
            Self::TimedOut { timeout_ms } => write!(
                formatter,
                "Checking the update's signature took longer than {} seconds, so the download was discarded.",
                (timeout_ms + 500) / 1000
            ),
            Self::Tool(detail) => {
                write!(formatter, "Couldn't check the update's signature: {detail}")
            }
            Self::Unreadable(answer) => {
                write!(formatter, "Couldn't read the update's signature: {answer}")
            }
        }
    }
}

impl std::error::Error for SignatureCheckError {}

/// Checks the installer at `installer_path`. `Ok(None)` means it is signed
/// by one of `publisher_names`; `Ok(Some(reason))` means it is not; an
/// error means the check could not be made. Only `Ok(None)` may install.
///
/// `now_ms` is a clock in milliseconds, read before and after the run for
/// the log's line.
pub fn verify_installer_signature(
    runner: &mut dyn SignatureRunner,
    publisher_names: &[&str],
    installer_path: &str,
    timeout_ms: u64,
    now_ms: &mut dyn FnMut() -> u64,
    log: &mut UpdaterLog,
) -> Result<Option<String>, SignatureCheckError> {
    let command_line =
        signature_check_command_line(installer_path).ok_or(SignatureCheckError::Path)?;
    let started_at = now_ms();
    log.info(&format!("Verifying signature of {installer_path}"));
    let outcome = runner.run(&command_line, timeout_ms);
    let seconds = now_ms().saturating_sub(started_at) as f64 / 1000.0;

    let (success, stdout, stderr) = match outcome {
        SignatureRunOutcome::TimedOut => return Err(SignatureCheckError::TimedOut { timeout_ms }),
        SignatureRunOutcome::NotStarted(detail) => return Err(SignatureCheckError::Tool(detail)),
        SignatureRunOutcome::Finished {
            success,
            stdout,
            stderr,
        } => (success, stdout, stderr),
    };
    let said = trim_answer(&stderr);
    if !success || !said.is_empty() {
        let detail = if said.is_empty() {
            "PowerShell reported an error"
        } else {
            said
        };
        return Err(SignatureCheckError::Tool(detail.to_string()));
    }
    let answer = trim_answer(&stdout);
    let output: Value = serde_json::from_str(answer)
        .map_err(|_| SignatureCheckError::Unreadable(answer.chars().take(200).collect()))?;

    let verdict = signature_verdict(publisher_names, installer_path, &output);
    match &verdict {
        Some(reason) => log.warn(&format!(
            "Signature check failed after {seconds:.1} s: {reason}"
        )),
        None => log.info(&format!("Signature check passed in {seconds:.1} s")),
    }
    Ok(verdict)
}

/// Runs the check through `cmd.exe`, hidden, and stops it at the timeout.
#[cfg(windows)]
pub struct PowerShellRunner;

#[cfg(windows)]
impl SignatureRunner for PowerShellRunner {
    fn run(&mut self, command_line: &str, timeout_ms: u64) -> SignatureRunOutcome {
        use std::io::Read;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        /// No console window flashes over the stream.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // The system's own cmd.exe, never one found beside the app or on
        // the search path.
        let system_root = std::env::var_os("SystemRoot")
            .filter(|root| !root.is_empty())
            .unwrap_or_else(|| "C:\\Windows".into());
        let shell = std::path::Path::new(&system_root)
            .join("System32")
            .join("cmd.exe");

        let spawned = Command::new(shell)
            // Node's `shell: true` runs `cmd.exe /d /s /c "<line>"`, with
            // the line passed through untouched.
            .raw_arg("/d /s /c")
            .raw_arg(format!("\"{command_line}\""))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => return SignatureRunOutcome::NotStarted(error.to_string()),
        };

        // Both pipes are read on their own threads, so a full pipe never
        // stalls PowerShell.
        fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                if let Some(mut pipe) = pipe {
                    let _ = pipe.read_to_end(&mut bytes);
                }
                String::from_utf8_lossy(&bytes).into_owned()
            })
        }
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return SignatureRunOutcome::TimedOut;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return SignatureRunOutcome::NotStarted(error.to_string());
                }
            }
        };
        SignatureRunOutcome::Finished {
            success: status.success(),
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::log::{UpdaterLogEntry, UpdaterLogLevel};

    const INSTALLER: &str = "C:\\Users\\tester\\AppData\\Local\\@videorcdesktop-updater\\pending\\temp-Videorc-0.21.0-win-x64.exe";
    const SUBJECT: &str = "CN=Uros Miric, O=Uros Miric, L=Malaga, S=Málaga, C=ES";
    const PUBLISHER: &[&str] = &["Uros Miric"];

    fn valid() -> Value {
        json!({ "Status": 0, "Path": INSTALLER, "Subject": SUBJECT })
    }

    fn with(field: &str, value: Value) -> Value {
        let mut output = valid();
        output[field] = value;
        output
    }

    /// Answers every run with one outcome, and keeps what it was asked.
    struct FakeRunner {
        outcome: SignatureRunOutcome,
        calls: Vec<(String, u64)>,
    }

    impl FakeRunner {
        fn new(outcome: SignatureRunOutcome) -> Self {
            Self {
                outcome,
                calls: Vec::new(),
            }
        }

        fn printing(stdout: &str) -> Self {
            Self::finished(true, stdout, "")
        }

        fn finished(success: bool, stdout: &str, stderr: &str) -> Self {
            Self::new(SignatureRunOutcome::Finished {
                success,
                stdout: stdout.to_string(),
                stderr: stderr.to_string(),
            })
        }
    }

    impl SignatureRunner for FakeRunner {
        fn run(&mut self, command_line: &str, timeout_ms: u64) -> SignatureRunOutcome {
            self.calls.push((command_line.to_string(), timeout_ms));
            self.outcome.clone()
        }
    }

    fn verify(
        runner: &mut FakeRunner,
        publisher_names: &[&str],
        path: &str,
    ) -> (
        Result<Option<String>, SignatureCheckError>,
        Vec<UpdaterLogEntry>,
    ) {
        let mut log = UpdaterLog::with(40, Box::new(|| 0), Box::new(|_, _| Ok(())));
        // The run takes 18.4 s on this clock.
        let mut ticks = [1_000_u64, 19_400].into_iter();
        let mut now = move || ticks.next().unwrap_or(19_400);
        let result = verify_installer_signature(
            runner,
            publisher_names,
            path,
            WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS,
            &mut now,
            &mut log,
        );
        (result, log.snapshot())
    }

    // Windows update signature check

    #[test]
    fn allows_minutes_not_twenty_seconds_for_a_large_installer_on_a_busy_machine() {
        // Field report 2026-11-10: the check took 18 to 21 s at 92% CPU.
        const { assert!(WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS >= 120_000) };
    }

    #[test]
    fn passes_the_timeout_and_the_same_powershell_prefix_as_electron_updater() {
        let mut runner = FakeRunner::printing(&valid().to_string());
        let (result, _) = verify(&mut runner, PUBLISHER, INSTALLER);
        assert_eq!(result, Ok(None));
        let (command_line, timeout_ms) = &runner.calls[0];
        assert_eq!(*timeout_ms, WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS);
        assert_eq!(
            *command_line,
            format!(
                "set \"PSModulePath=\" & chcp 65001 >NUL & powershell.exe -NoProfile -NonInteractive -InputFormat None -Command {}",
                signature_check_command(INSTALLER)
            )
        );
        assert_eq!(runner.calls.len(), 1);
    }

    #[test]
    fn asks_powershell_only_for_status_path_and_signer() {
        let command = signature_check_command(INSTALLER);
        assert!(command.contains(&format!("-LiteralPath '{INSTALLER}'")));
        assert!(command.contains("[int]$_.Status"));
        assert!(command.contains("$_.SignerCertificate.Subject"));
        assert!(command.starts_with('"') && command.ends_with('"'));
        // The whole command, as the original builds it.
        assert_eq!(
            signature_check_command("C:\\x.exe"),
            "\"Get-AuthenticodeSignature -LiteralPath 'C:\\x.exe' | Select-Object @{n='Status';e={[int]$_.Status}},Path,@{n='Subject';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress\""
        );
    }

    #[test]
    fn escapes_single_quotes_in_the_path() {
        assert!(
            signature_check_command("C:\\a'b\\x.exe").contains("-LiteralPath 'C:\\a''b\\x.exe'")
        );
        assert!(
            signature_check_arguments("C:\\a'b\\x.exe").contains(&"-NonInteractive".to_string())
        );
    }

    #[test]
    fn rejects_with_plain_words_when_the_check_times_out() {
        let mut runner = FakeRunner::new(SignatureRunOutcome::TimedOut);
        let (result, _) = verify(&mut runner, PUBLISHER, INSTALLER);
        let error = result.unwrap_err();
        assert_eq!(
            error,
            SignatureCheckError::TimedOut {
                timeout_ms: 180_000
            }
        );
        assert_eq!(
            error.to_string(),
            "Checking the update's signature took longer than 180 seconds, so the download was discarded."
        );
    }

    #[test]
    fn fails_closed_on_a_powershell_error_or_any_stderr() {
        let mut missing = FakeRunner::new(SignatureRunOutcome::NotStarted(
            "spawn powershell.exe ENOENT".into(),
        ));
        let error = verify(&mut missing, PUBLISHER, INSTALLER).0.unwrap_err();
        assert!(error.to_string().contains("ENOENT"), "{error}");

        // A valid answer does not outweigh a word on the error stream.
        let mut noisy = FakeRunner::finished(true, &valid().to_string(), "boom");
        let error = verify(&mut noisy, PUBLISHER, INSTALLER).0.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Couldn't check the update's signature: boom"
        );

        // Nor a failed exit that said nothing.
        let mut failed = FakeRunner::finished(false, &valid().to_string(), "  ");
        let error = verify(&mut failed, PUBLISHER, INSTALLER).0.unwrap_err();
        assert!(matches!(error, SignatureCheckError::Tool(_)), "{error}");

        let mut garbled = FakeRunner::printing("not json");
        let error = verify(&mut garbled, PUBLISHER, INSTALLER).0.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Couldn't read the update's signature: not json"
        );

        // An unreadable answer is quoted up to 200 characters.
        let mut long = FakeRunner::printing(&"z".repeat(900));
        let error = verify(&mut long, PUBLISHER, INSTALLER).0.unwrap_err();
        assert_eq!(error, SignatureCheckError::Unreadable("z".repeat(200)));
    }

    #[test]
    fn returns_a_reason_not_trust_for_a_wrong_signer() {
        let other = with("Subject", json!("CN=Someone Else, O=Someone Else, C=US"));
        let mut runner = FakeRunner::printing(&other.to_string());
        let (result, log) = verify(&mut runner, PUBLISHER, INSTALLER);
        let reason = result.unwrap().expect("a reason");
        assert!(reason.contains("Someone Else"), "{reason}");
        // The log says how long it took and why it failed.
        assert_eq!(
            log[0].message,
            format!("Verifying signature of {INSTALLER}")
        );
        assert_eq!(log[1].level, UpdaterLogLevel::Warn);
        assert_eq!(
            log[1].message,
            format!("Signature check failed after 18.4 s: {reason}")
        );
    }

    #[test]
    fn logs_a_passed_check_with_its_time() {
        let mut runner = FakeRunner::printing(&format!("\r\n{}\r\n", valid()));
        let (result, log) = verify(&mut runner, PUBLISHER, INSTALLER);
        assert_eq!(result, Ok(None));
        assert_eq!(log[1].level, UpdaterLogLevel::Info);
        assert_eq!(log[1].message, "Signature check passed in 18.4 s");
    }

    #[test]
    fn reads_an_answer_that_starts_with_a_byte_order_mark() {
        let mut runner =
            FakeRunner::finished(true, &format!("\u{feff}{}\r\n", valid()), "\u{feff}");
        assert_eq!(verify(&mut runner, PUBLISHER, INSTALLER).0, Ok(None));
    }

    #[test]
    fn reads_an_answer_that_is_not_an_object_as_no_signature() {
        for answer in ["null", "[]", "7", "\"Valid\""] {
            let mut runner = FakeRunner::printing(answer);
            let reason = verify(&mut runner, PUBLISHER, INSTALLER)
                .0
                .unwrap()
                .expect("a reason");
            assert_eq!(
                reason, "signature status undefined is not Valid",
                "{answer}"
            );
        }
    }

    #[test]
    fn refuses_a_path_cmd_would_rewrite_before_anything_runs() {
        for path in [
            "",
            "C:\\Users\\%USERNAME%\\x.exe",
            "C:\\Users\\50%\\x.exe",
            "C:\\a\"b\\x.exe",
            "C:\\a\nb\\x.exe",
        ] {
            assert_eq!(signature_check_command_line(path), None, "{path:?}");
            let mut runner = FakeRunner::printing(&valid().to_string());
            let (result, log) = verify(&mut runner, PUBLISHER, path);
            assert_eq!(result, Err(SignatureCheckError::Path), "{path:?}");
            assert!(runner.calls.is_empty());
            assert!(log.is_empty());
        }
        // What stays legal in a quoted argument is passed on.
        for path in [
            "C:\\R&D\\x.exe",
            "C:\\a^b\\x.exe",
            "C:\\José (1)\\x.exe",
            "C:\\a!b\\x.exe",
        ] {
            assert!(signature_check_command_line(path).is_some(), "{path}");
        }
    }

    // signatureVerdict

    #[test]
    fn trusts_a_valid_installer_signed_by_the_publisher_cn_or_full_dn() {
        assert_eq!(signature_verdict(PUBLISHER, INSTALLER, &valid()), None);
        assert_eq!(
            signature_verdict(&["CN=Uros Miric, C=ES"], INSTALLER, &valid()),
            None
        );
        assert_eq!(
            signature_verdict(&["Someone", "Uros Miric"], INSTALLER, &valid()),
            None
        );
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &with("Status", json!("Valid"))),
            None
        );
        // A number is a number, however PowerShell prints it.
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &with("Status", json!(0.0))),
            None
        );
    }

    #[test]
    fn treats_the_path_case_insensitively_like_windows() {
        let upper = with("Path", json!(INSTALLER.to_uppercase()));
        assert_eq!(signature_verdict(PUBLISHER, INSTALLER, &upper), None);
        // And in whatever spelling PowerShell gives it back.
        let forward = with("Path", json!(INSTALLER.replace('\\', "/")));
        assert_eq!(signature_verdict(PUBLISHER, INSTALLER, &forward), None);
        let dotted = with(
            "Path",
            json!(
                "C:\\Users\\tester\\.\\AppData\\Local\\Temp\\..\\@videorcdesktop-updater\\pending\\temp-Videorc-0.21.0-win-x64.exe"
            ),
        );
        assert_eq!(signature_verdict(PUBLISHER, INSTALLER, &dotted), None);
    }

    #[test]
    fn refuses_anything_not_valid() {
        // 1 UnknownError, 2 NotSigned, 3 HashMismatch, 4 NotTrusted.
        for status in [
            json!(1),
            json!(2),
            json!(3),
            json!(4),
            json!("HashMismatch"),
            json!(null),
        ] {
            let reason = signature_verdict(PUBLISHER, INSTALLER, &with("Status", status.clone()));
            assert!(
                reason.is_some_and(|reason| reason.contains("not Valid")),
                "{status}"
            );
        }
        let mut missing = valid();
        missing.as_object_mut().unwrap().remove("Status");
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &missing).as_deref(),
            Some("signature status undefined is not Valid")
        );
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &with("Status", json!(3))).as_deref(),
            Some("signature status 3 is not Valid")
        );
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &with("Status", json!("HashMismatch")))
                .as_deref(),
            Some("signature status HashMismatch is not Valid")
        );
        // A status that only looks like zero is not Valid.
        for status in [json!("0"), json!(false), json!([0])] {
            assert!(signature_verdict(PUBLISHER, INSTALLER, &with("Status", status)).is_some());
        }
    }

    #[test]
    fn refuses_a_different_file_a_different_signer_or_no_signer() {
        let other_file = with("Path", json!("C:\\other.exe"));
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &other_file).as_deref(),
            Some("PowerShell checked C:\\other.exe, not the downloaded installer")
        );
        let wrong_country = signature_verdict(&["CN=Uros Miric, C=US"], INSTALLER, &valid());
        assert!(wrong_country.is_some_and(|reason| reason.starts_with("publisherNames")));
        let part_of_a_name = signature_verdict(&["Uros"], INSTALLER, &valid());
        assert!(part_of_a_name.is_some_and(|reason| reason.starts_with("publisherNames")));
        let unsigned = json!({ "Status": 0, "Path": INSTALLER });
        assert_eq!(
            signature_verdict(PUBLISHER, INSTALLER, &unsigned).as_deref(),
            Some("publisherNames: Uros Miric, signer: none")
        );
        // Beyond the original's cases: no publisher is no trust, and the
        // reason lists every name that was asked for.
        assert!(signature_verdict(&[], INSTALLER, &valid()).is_some());
        assert_eq!(
            signature_verdict(&["A", "B"], INSTALLER, &with("Subject", json!("CN=C"))).as_deref(),
            Some("publisherNames: A | B, signer: CN=C")
        );
    }

    // parseDistinguishedName

    #[test]
    fn splits_on_commas_outside_quotes_and_keeps_non_ascii_values() {
        let name = parse_distinguished_name("CN=\"Miric, Uros\", O=Uros Miric, S=Málaga");
        assert_eq!(name.get("CN").map(String::as_str), Some("Miric, Uros"));
        assert_eq!(name.get("O").map(String::as_str), Some("Uros Miric"));
        assert_eq!(name.get("S").map(String::as_str), Some("Málaga"));
        // A signer with a comma in its name is matched whole.
        let quoted = with("Subject", json!("CN=\"Miric, Uros\", C=ES"));
        assert_eq!(
            signature_verdict(&["Miric, Uros"], INSTALLER, &quoted),
            None
        );
    }

    #[test]
    fn is_empty_for_a_bare_name() {
        assert!(parse_distinguished_name("Uros Miric").is_empty());
        assert!(parse_distinguished_name("").is_empty());
        assert!(parse_distinguished_name("=value, ,").is_empty());
        // A key that comes twice keeps its last value, and a value may hold
        // an equals sign.
        let twice = parse_distinguished_name("OU=first, OU=second, X=a=b");
        assert_eq!(twice.get("OU").map(String::as_str), Some("second"));
        assert_eq!(twice.get("X").map(String::as_str), Some("a=b"));
    }

    // The path's one spelling, against Node's `path.win32.normalize`.

    #[test]
    fn normalizes_a_windows_path_as_node_does() {
        for (path, normal) in [
            ("C:\\a\\..\\b\\.\\c.exe", "C:\\b\\c.exe"),
            ("C:/Users/x//y.exe", "C:\\Users\\x\\y.exe"),
            ("C:\\Users\\x\\", "C:\\Users\\x\\"),
            (
                "\\\\server\\share\\a\\..\\b.exe",
                "\\\\server\\share\\b.exe",
            ),
            ("C:a\\..\\..\\b", "C:..\\b"),
            ("\\\\?\\C:\\x\\..\\y.exe", "\\\\?\\C:\\y.exe"),
            ("C:\\", "C:\\"),
            ("C:", "C:."),
            ("..\\a\\.\\b", "..\\a\\b"),
            ("\\a\\..\\..\\b", "\\b"),
            ("C:\\a\\b\\..\\..\\..\\c", "C:\\c"),
            ("//server/share/x", "\\\\server\\share\\x"),
            ("\\\\server\\share", "\\\\server\\share\\"),
            ("\\\\server", "\\server"),
            ("", "."),
            (".", "."),
            ("a\\\\b\\", "a\\b\\"),
            ("C:\\x\\.", "C:\\x"),
            ("\\\\.\\pipe\\x", "\\\\.\\pipe\\x"),
            ("/", "\\"),
            (INSTALLER, INSTALLER),
        ] {
            assert_eq!(normalize_windows_path(path), normal, "{path:?}");
        }
    }
}
