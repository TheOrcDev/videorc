use std::borrow::Cow;
use std::ffi::OsString;
use std::path::Path;

const BUNDLED_FFMPEG_PATH_ENV: &str = "VIDEORC_BUNDLED_FFMPEG_PATH";
const BUNDLED_FFPROBE_PATH_ENV: &str = "VIDEORC_BUNDLED_FFPROBE_PATH";

/// The spelling of an app-owned filesystem path to hand an FFmpeg or FFprobe
/// subprocess, as a `-i` input, an output, or any other path argument.
///
/// Windows file APIs here use the verbatim `\\?\` namespace for long-path
/// safety (publication returns `\\?\C:\…`), but FFmpeg mishandles it: the tee
/// muxer rejects it as a slave filename, and the concat demuxer joins a
/// relative entry to a verbatim list path as `\\0.png` and exits with ENOENT
/// (issue #1061). Keep verbatim paths internally and remove the namespace only
/// at the subprocess boundary. FFmpeg (5.1 and later; Windows ships 8.1) adds
/// the long-path prefix back itself when a plain path is too long.
///
/// The prefix is removed only when the plain spelling names the same file
/// (`dunce::simplified` rules): a rooted drive or UNC path whose components
/// have no reserved device name, trailing dot or space, `/`, or `.`/`..`.
/// Anything else, and every path off Windows, is returned unchanged.
pub(crate) fn ffmpeg_path(path: &Path) -> Cow<'_, Path> {
    #[cfg(target_os = "windows")]
    if let Some(plain) = windows_plain_path(path) {
        return Cow::Owned(plain);
    }
    Cow::Borrowed(path)
}

/// [`ffmpeg_path`] as an `OsString` argument, lossless for any path.
pub(crate) fn ffmpeg_path_arg(path: &Path) -> OsString {
    ffmpeg_path(path).into_owned().into_os_string()
}

/// [`ffmpeg_path`] for the `String` argument vectors most FFmpeg builders use.
pub(crate) fn ffmpeg_file_path(path: &Path) -> String {
    ffmpeg_path(path).display().to_string()
}

/// How much of an FFmpeg child's stderr [`FfmpegStderrTail`] keeps.
pub(crate) const FFMPEG_STDERR_TAIL_BYTES: usize = 4 * 1024;
/// How long each line a failure message carries may be, so the reason stays
/// readable in a health toast.
const FFMPEG_FAILURE_LINE_BYTES: usize = 200;

/// The last [`FFMPEG_STDERR_TAIL_BYTES`] an FFmpeg child wrote to stderr.
///
/// A child spawned with stderr discarded fails with only an exit code: the
/// caption burn reported `exit code: 0xfffffffe` for weeks while FFmpeg was
/// saying `Impossible to open '\\0.png'` (issue #1061). Drain stderr into this
/// instead, so the failure can name FFmpeg's own reason. It is bounded, so a
/// chatty or stuck child can never grow it.
#[derive(Debug, Default)]
pub(crate) struct FfmpegStderrTail {
    bytes: Vec<u8>,
    /// Older output was dropped, so the first kept line may be cut short.
    truncated: bool,
}

impl FfmpegStderrTail {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let total = self.bytes.len() + chunk.len();
        if total > FFMPEG_STDERR_TAIL_BYTES {
            self.truncated = true;
            let chunk = &chunk[chunk.len().saturating_sub(FFMPEG_STDERR_TAIL_BYTES)..];
            let drop = (self.bytes.len() + chunk.len()).saturating_sub(FFMPEG_STDERR_TAIL_BYTES);
            self.bytes.drain(..drop);
            self.bytes.extend_from_slice(chunk);
        } else {
            self.bytes.extend_from_slice(chunk);
        }
    }

    /// The kept stderr lines, trimmed, blank lines and a cut-off first line
    /// skipped. `\r` counts as a line end, as FFmpeg's progress line uses it.
    pub(crate) fn lines(&self) -> Vec<String> {
        let text = String::from_utf8_lossy(&self.bytes);
        let mut lines = text.split(['\n', '\r']);
        if self.truncated {
            lines.next();
        }
        lines
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// The first kept line and the last, `first | last`, for a failure
    /// message, or `None` when FFmpeg printed nothing. Meant for a child run
    /// at `-loglevel error`, where every line is an error: the first is the
    /// cause and the rest is FFmpeg unwinding. The #1061 burn printed
    /// `Impossible to open '\\0.png'`, then three generic `Error opening
    /// input…` lines, so the last lines alone hide the cause.
    pub(crate) fn failure_summary(&self) -> Option<String> {
        let lines = self.lines();
        let first = lines.first()?;
        let last = lines.last()?;
        let first = bounded_line(first, FFMPEG_FAILURE_LINE_BYTES);
        if lines.len() == 1 {
            return Some(first);
        }
        Some(format!(
            "{first} | {}",
            bounded_line(last, FFMPEG_FAILURE_LINE_BYTES)
        ))
    }

    /// Everything kept, for the backend log.
    pub(crate) fn text(&self) -> String {
        self.lines().join("\n")
    }
}

/// Reads an FFmpeg child's stderr to its end into an [`FfmpegStderrTail`].
/// Run it as its own task so the pipe never fills and stalls the child; it
/// finishes when the child exits and closes the pipe.
pub(crate) async fn drain_ffmpeg_stderr<R>(mut reader: R) -> FfmpegStderrTail
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt as _;
    let mut tail = FfmpegStderrTail::default();
    let mut chunk = [0_u8; 1024];
    while let Ok(read) = reader.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        tail.push(&chunk[..read]);
    }
    tail
}

fn bounded_line(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let mut end = max_bytes.saturating_sub('…'.len_utf8());
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &line[..end])
}

#[cfg(target_os = "windows")]
fn windows_plain_path(path: &Path) -> Option<std::path::PathBuf> {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return None;
    };
    let mut plain = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut plain = OsString::from(r"\\");
            plain.push(server);
            plain.push(r"\");
            plain.push(share);
            plain
        }
        _ => return None,
    };
    let rest = components.as_path();
    // Inside the namespace `/` is a literal name character, but `components()`
    // still splits on it, so check the raw remainder.
    if rest.as_os_str().to_string_lossy().contains('/') {
        return None;
    }
    let mut rest_components = rest.components();
    // `\\?\C:` alone would become the drive-relative `C:`.
    if rest_components.next() != Some(Component::RootDir) {
        return None;
    }
    if !rest_components.all(|component| match component {
        Component::Normal(name) => windows_plain_component(&name.to_string_lossy()),
        _ => false,
    }) {
        return None;
    }
    plain.push(rest.as_os_str());
    Some(plain.into())
}

/// Whether a verbatim path component keeps its meaning outside `\\?\`, where
/// Win32 trims trailing dots and spaces and maps device names to devices.
#[cfg(target_os = "windows")]
fn windows_plain_component(name: &str) -> bool {
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    if name.is_empty() || name.ends_with(['.', ' ']) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let numbered = |base: &str| {
        let bytes = stem.as_bytes();
        bytes.len() > 3
            && bytes[..3].eq_ignore_ascii_case(base.as_bytes())
            && matches!(
                &stem[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
    };
    !(RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
        || numbered("COM")
        || numbered("LPT"))
}

pub fn default_ffmpeg_path() -> String {
    std::env::var(BUNDLED_FFMPEG_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "ffmpeg".to_string())
}

/// Resolves the FFprobe binary that pairs with an already-resolved FFmpeg path: an
/// explicit `VIDEORC_BUNDLED_FFPROBE_PATH` wins, otherwise a sibling `ffprobe` next to a
/// bundled `ffmpeg` (or `ffprobe.exe` beside `ffmpeg.exe`) is derived, otherwise
/// it falls back to `ffprobe` on `PATH`.
pub fn ffprobe_path_for(ffmpeg_path: &str) -> String {
    paired_ffprobe_path(
        ffmpeg_path,
        std::env::var(BUNDLED_FFPROBE_PATH_ENV).ok().as_deref(),
    )
}

fn paired_ffprobe_path(ffmpeg_path: &str, explicit: Option<&str>) -> String {
    if let Some(explicit) = explicit.map(str::trim).filter(|path| !path.is_empty()) {
        return explicit.to_string();
    }
    let ffmpeg_path = ffmpeg_path.trim();
    if let Some(prefix) = ffmpeg_path.strip_suffix("ffmpeg.exe") {
        return format!("{prefix}ffprobe.exe");
    }
    if let Some(prefix) = ffmpeg_path.strip_suffix("ffmpeg") {
        return format!("{prefix}ffprobe");
    }
    "ffprobe".to_string()
}

pub fn resolve_ffmpeg_path(path: Option<String>) -> String {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_ffmpeg_path)
}

pub fn resolve_ffmpeg_path_ref(path: Option<&str>) -> String {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_ffmpeg_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_sibling_ffprobe_next_to_bundled_ffmpeg() {
        // Only meaningful when the explicit override env is unset (the common case).
        if std::env::var("VIDEORC_BUNDLED_FFPROBE_PATH").is_ok() {
            return;
        }
        assert_eq!(ffprobe_path_for("/opt/ff/ffmpeg"), "/opt/ff/ffprobe");
        assert_eq!(ffprobe_path_for("ffmpeg"), "ffprobe");
    }

    #[test]
    fn derives_windows_sibling_ffprobe_without_host_path_semantics() {
        assert_eq!(
            paired_ffprobe_path(r"D:\Videorc tools\bin\ffmpeg.exe", None),
            r"D:\Videorc tools\bin\ffprobe.exe"
        );
        assert_eq!(paired_ffprobe_path("ffmpeg.exe", None), "ffprobe.exe");
        assert_eq!(
            paired_ffprobe_path(r"D:\bin\ffmpeg.exe", Some(r" E:\tools\probe.exe ")),
            r"E:\tools\probe.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ffmpeg_path_unwraps_verbatim_drive_and_unc_paths() {
        assert_eq!(
            ffmpeg_file_path(Path::new(r"\\?\C:\recordings\capture.mkv")),
            r"C:\recordings\capture.mkv"
        );
        assert_eq!(
            ffmpeg_file_path(Path::new(r"\\?\UNC\server\share\capture.mkv")),
            r"\\server\share\capture.mkv"
        );
        assert_eq!(
            ffmpeg_path_arg(Path::new(
                r"\\?\C:\Users\me\Videos\.videorc-session-1.mp4.cues-2.caption-frames\track.ffconcat"
            )),
            OsString::from(
                r"C:\Users\me\Videos\.videorc-session-1.mp4.cues-2.caption-frames\track.ffconcat"
            )
        );
        // Plain paths pass through untouched.
        assert_eq!(
            ffmpeg_file_path(Path::new(r"C:\recordings\capture.mkv")),
            r"C:\recordings\capture.mkv"
        );
        assert_eq!(
            ffmpeg_file_path(Path::new(r"\\server\share\capture.mkv")),
            r"\\server\share\capture.mkv"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ffmpeg_path_keeps_verbatim_paths_whose_plain_spelling_names_another_file() {
        for path in [
            // Win32 maps device names to devices and trims trailing dots/spaces.
            r"\\?\C:\recordings\NUL",
            r"\\?\C:\recordings\con.mp4",
            r"\\?\C:\recordings\COM1\capture.mkv",
            r"\\?\C:\recordings\lpt9.txt",
            r"\\?\C:\recordings\COM².mkv",
            r"\\?\C:\recordings\take.\capture.mkv",
            r"\\?\C:\recordings\take \capture.mkv",
            // `/` is a literal name character only inside the namespace.
            r"\\?\C:\recordings/capture.mkv",
            r"\\?\C:\recordings\..\capture.mkv",
            // Drive-relative once unwrapped.
            r"\\?\C:",
            // Not a drive or share.
            r"\\?\Volume{0b1e7c8a-0000-0000-0000-100000000000}\capture.mkv",
            r"\\?\GLOBALROOT\Device\HarddiskVolume3\capture.mkv",
            r"\\.\PhysicalDrive0",
        ] {
            assert_eq!(ffmpeg_file_path(Path::new(path)), path, "{path}");
        }
        // Names that only resemble reserved ones are fine.
        assert_eq!(
            ffmpeg_file_path(Path::new(r"\\?\C:\console\COM0\lpt10\nul-take\a€\é.mkv")),
            r"C:\console\COM0\lpt10\nul-take\a€\é.mkv"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ffmpeg_path_is_unchanged_off_windows() {
        for path in ["/tmp/capture.mkv", r"\\?\C:\recordings\capture.mkv"] {
            assert_eq!(ffmpeg_file_path(Path::new(path)), path);
            assert_eq!(ffmpeg_path_arg(Path::new(path)), OsString::from(path));
        }
    }

    #[test]
    fn stderr_tail_names_ffmpegs_reason_for_a_failed_burn() {
        // The shipped Windows FFmpeg 8.1's stderr at `-loglevel error` for a
        // concat list opened through `\\?\` (#1061), split across two reads.
        let mut tail = FfmpegStderrTail::default();
        tail.push(b"[in#0 @ 000001e73e994900] Impossible to open '\\\\0.png'\r\n[in#0 @ 0000");
        tail.push(
            b"01e73e9b7e80] Error opening input: No such file or directory\r\n\
              Error opening input file \\\\?\\C:\\Users\\me\\track.ffconcat.\r\n\
              Error opening input files: No such file or directory\r\n",
        );
        assert_eq!(
            tail.failure_summary().as_deref(),
            Some(
                "[in#0 @ 000001e73e994900] Impossible to open '\\\\0.png' | \
                 Error opening input files: No such file or directory"
            ),
            "the cause is the first line, not one of the last"
        );
        let text = tail.text();
        assert_eq!(text.lines().count(), 4, "{text}");
        assert!(text.contains("[in#0 @ 000001e73e9b7e80] Error opening input: No such file"));

        let mut single = FfmpegStderrTail::default();
        single.push(b"Conversion failed!\n");
        assert_eq!(
            single.failure_summary().as_deref(),
            Some("Conversion failed!")
        );
        assert_eq!(FfmpegStderrTail::default().failure_summary(), None);
        let mut blank = FfmpegStderrTail::default();
        blank.push(b"\r\n  \n");
        assert_eq!(blank.failure_summary(), None);
    }

    #[test]
    fn stderr_tail_is_bounded_and_drops_the_cut_line() {
        let mut tail = FfmpegStderrTail::default();
        for index in 0..2_000 {
            tail.push(format!("frame={index} fps=30 q=28.0 size=1kB\r").as_bytes());
        }
        tail.push(b"Conversion failed!\n");
        assert!(tail.bytes.len() <= FFMPEG_STDERR_TAIL_BYTES);
        let lines = tail.lines();
        assert_eq!(lines.last().map(String::as_str), Some("Conversion failed!"));
        assert!(
            lines
                .iter()
                .all(|line| line.starts_with("frame=") || line == "Conversion failed!"),
            "the partial first line is dropped: {:?}",
            lines.first()
        );

        // One read larger than the whole tail keeps only its end.
        let mut huge = FfmpegStderrTail::default();
        huge.push(&[b'x'; FFMPEG_STDERR_TAIL_BYTES * 3]);
        huge.push(b"\nlast\n");
        assert_eq!(huge.bytes.len(), FFMPEG_STDERR_TAIL_BYTES);
        assert_eq!(huge.lines(), vec!["last".to_string()]);

        // Long and multi-byte lines are cut on a char boundary.
        let mut wide = FfmpegStderrTail::default();
        wide.push("é".repeat(400).as_bytes());
        let summary = wide.failure_summary().unwrap();
        assert!(
            summary.len() <= FFMPEG_FAILURE_LINE_BYTES,
            "{}",
            summary.len()
        );
        assert!(summary.ends_with('…'));
    }

    #[tokio::test]
    async fn drain_ffmpeg_stderr_reads_to_the_end() {
        let tail = drain_ffmpeg_stderr(&b"one\ntwo\n"[..]).await;
        assert_eq!(tail.lines(), vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn falls_back_to_ffprobe_for_unrecognized_ffmpeg_path() {
        if std::env::var("VIDEORC_BUNDLED_FFPROBE_PATH").is_ok() {
            return;
        }
        assert_eq!(ffprobe_path_for("/opt/custom/ffmpeg-static"), "ffprobe");
    }
}
