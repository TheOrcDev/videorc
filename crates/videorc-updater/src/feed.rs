//! The update-info file and the check of what it names.
//!
//! The feed is `electron-builder`'s: `latest-mac.yml` for macOS and
//! `latest.yml` for Windows, each a few lines of YAML.
//!
//! ```yaml
//! version: 0.25.2
//! files:
//!   - url: Videorc-0.25.2-mac-arm64.zip
//!     sha512: Z7qET8L7…AJqAg==
//!     size: 192312226
//! path: Videorc-0.25.2-mac-arm64.zip
//! sha512: Z7qET8L7…AJqAg==
//! releaseDate: '2026-11-13T21:54:02.984Z'
//! ```
//!
//! This reads exactly that shape and nothing wider. A feed it cannot read is
//! an error, never a guess: the file decides what the app installs.

use std::fmt;
use std::io::{self, Read};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
/// The version type the feed's files and the flow use, for callers that
/// have no `semver` of their own.
pub use semver::Version;
use sha2::{Digest, Sha512};

/// The feed file for macOS.
pub const MACOS_FEED_FILE: &str = "latest-mac.yml";
/// The feed file for Windows.
pub const WINDOWS_FEED_FILE: &str = "latest.yml";

/// One file a release offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedFile {
    /// The file's name, relative to the feed's base.
    pub url: String,
    /// The SHA-512 of the file, in base64.
    pub sha512: String,
    pub size: u64,
}

/// What a feed file says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: Version,
    pub files: Vec<FeedFile>,
    /// The file an updater takes (`path` in the feed).
    pub path: String,
    pub release_date: Option<String>,
}

/// Why a feed file could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedError {
    /// A line that is not `key: value`, a list item out of place, or a
    /// quoted value that does not close. The number is the line, from 1.
    Syntax(usize),
    MissingVersion,
    /// The version is not `major.minor.patch` with an optional pre-release.
    Version(String),
    NoFiles,
    /// A file with no name, no hash or no size, or with one that is not what
    /// it should be. The number is the file's place in the list, from 1.
    File(usize),
    /// `path` names a file that is not in the list.
    Path(String),
}

impl fmt::Display for FeedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(line) => write!(formatter, "the update feed's line {line} cannot be read"),
            Self::MissingVersion => formatter.write_str("the update feed names no version"),
            Self::Version(version) => {
                write!(
                    formatter,
                    "the update feed's version {version:?} is not a version"
                )
            }
            Self::NoFiles => formatter.write_str("the update feed lists no files"),
            Self::File(index) => write!(formatter, "the update feed's file {index} is incomplete"),
            Self::Path(path) => {
                write!(
                    formatter,
                    "the update feed's path {path:?} is not one of its files"
                )
            }
        }
    }
}

impl std::error::Error for FeedError {}

#[derive(Default)]
struct PartialFile {
    url: Option<String>,
    sha512: Option<String>,
    size: Option<String>,
}

/// Reads a feed file.
pub fn parse_update_info(text: &str) -> Result<UpdateInfo, FeedError> {
    let mut version = None;
    let mut path = None;
    let mut release_date = None;
    let mut files: Vec<PartialFile> = Vec::new();
    // Inside `files:`. Any other key's indented lines (release notes, say)
    // are that key's own and are skipped.
    let mut in_files = false;

    for (index, raw) in text.lines().enumerate() {
        let line_number = index + 1;
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented {
            let (key, value) = key_value(line).ok_or(FeedError::Syntax(line_number))?;
            in_files = key == "files";
            if in_files {
                if !value.is_empty() {
                    return Err(FeedError::Syntax(line_number));
                }
                continue;
            }
            let value = scalar(value).ok_or(FeedError::Syntax(line_number))?;
            match key {
                "version" => version = Some(value),
                "path" => path = Some(value),
                "releaseDate" => release_date = Some(value),
                _ => {}
            }
            continue;
        }
        if !in_files {
            continue;
        }
        let entry = line.trim_start();
        let entry = match entry.strip_prefix("- ") {
            Some(first) => {
                files.push(PartialFile::default());
                first.trim_start()
            }
            None => entry,
        };
        let file = files.last_mut().ok_or(FeedError::Syntax(line_number))?;
        let (key, value) = key_value(entry).ok_or(FeedError::Syntax(line_number))?;
        let value = scalar(value).ok_or(FeedError::Syntax(line_number))?;
        match key {
            "url" => file.url = Some(value),
            "sha512" => file.sha512 = Some(value),
            "size" => file.size = Some(value),
            _ => {}
        }
    }

    let version = version.ok_or(FeedError::MissingVersion)?;
    let version = Version::parse(&version).map_err(|_| FeedError::Version(version))?;
    if files.is_empty() {
        return Err(FeedError::NoFiles);
    }
    let files = files
        .into_iter()
        .enumerate()
        .map(|(index, file)| complete_file(file).ok_or(FeedError::File(index + 1)))
        .collect::<Result<Vec<_>, _>>()?;
    let path = match path {
        Some(path) => {
            if !files.iter().any(|file| file.url == path) {
                return Err(FeedError::Path(path));
            }
            path
        }
        None => files[0].url.clone(),
    };
    Ok(UpdateInfo {
        version,
        files,
        path,
        release_date,
    })
}

fn complete_file(file: PartialFile) -> Option<FeedFile> {
    let url = file.url?;
    let sha512 = file.sha512?;
    let size: u64 = file.size?.parse().ok()?;
    let plain_name = !url.is_empty()
        && !url.starts_with('.')
        && !url.contains(['/', '\\', ':', '?', '#', '%'])
        && !url.chars().any(char::is_control);
    // A SHA-512 is 64 bytes.
    let digest_bytes = STANDARD.decode(&sha512).ok()?.len();
    (plain_name && size > 0 && digest_bytes == 64).then_some(FeedFile { url, sha512, size })
}

/// `key: value`, or `key:` with an empty value.
fn key_value(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim_end();
    let plain = !key.is_empty()
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_');
    if !plain || !(value.is_empty() || value.starts_with(' ')) {
        return None;
    }
    Some((key, value.trim()))
}

/// A plain value, or one in single or double quotes. Nothing in a feed needs
/// an escape, so a quoted value with a backslash or a quote inside is
/// refused.
fn scalar(value: &str) -> Option<String> {
    for quote in ['\'', '"'] {
        if let Some(rest) = value.strip_prefix(quote) {
            let inner = rest.strip_suffix(quote)?;
            if inner.contains(['\'', '"', '\\']) {
                return None;
            }
            return Some(inner.to_string());
        }
    }
    Some(value.to_string())
}

impl UpdateInfo {
    /// The file an updater takes: the one `path` names.
    pub fn package(&self) -> &FeedFile {
        self.files
            .iter()
            .find(|file| file.url == self.path)
            .unwrap_or(&self.files[0])
    }

    /// Whether this release is newer than the running version. Versions are
    /// ordered as numbers, so 0.25.10 follows 0.25.9, and a pre-release
    /// comes before its release.
    pub fn is_newer_than(&self, current: &Version) -> bool {
        self.version > *current
    }
}

/// Where a feed's file is fetched from: its name under the feed's base.
pub fn file_url(feed_base: &str, file: &FeedFile) -> String {
    if feed_base.ends_with('/') {
        format!("{feed_base}{}", file.url)
    } else {
        format!("{feed_base}/{}", file.url)
    }
}

/// The SHA-512 of `bytes` as a feed writes it (base64), for fixtures and
/// rehearsal feeds.
pub fn sha512_base64(bytes: &[u8]) -> String {
    STANDARD.encode(Sha512::digest(bytes))
}

/// How a downloaded file differs from what the feed says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntegrityFailure {
    Size { expected: u64, actual: u64 },
    Sha512,
}

impl fmt::Display for IntegrityFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Size { expected, actual } => write!(
                formatter,
                "the update is {actual} bytes and the feed says {expected}"
            ),
            Self::Sha512 => formatter.write_str("the update's SHA-512 is not the feed's"),
        }
    }
}

impl std::error::Error for IntegrityFailure {}

/// Reads `download` to its end and checks its size and its SHA-512 against
/// the feed's. The outer error is the read's; the inner one says the bytes
/// are not the release's. Nothing is installed unless this is `Ok(Ok(()))`.
pub fn verify_download(
    mut download: impl Read,
    expected: &FeedFile,
) -> io::Result<Result<(), IntegrityFailure>> {
    let mut hasher = Sha512::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut actual: u64 = 0;
    loop {
        let read = download.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        actual += read as u64;
        hasher.update(&buffer[..read]);
    }
    if actual != expected.size {
        return Ok(Err(IntegrityFailure::Size {
            expected: expected.size,
            actual,
        }));
    }
    let digest = STANDARD.encode(hasher.finalize());
    if digest != expected.sha512 {
        return Ok(Err(IntegrityFailure::Sha512));
    }
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `https://www.videorc.com/api/updates/latest-mac.yml` on 2026-11-14.
    const MACOS_FEED: &str = "version: 0.25.2
files:
  - url: Videorc-0.25.2-mac-arm64.zip
    sha512: Z7qET8L7HZ4QTszW+y4iflPEKw9ykO6CV9ZJZ59IWG+LSFCf+ww5iMFOFWYZnZKCS3g73rxt5anHVxCbvwJqAg==
    size: 192312226
  - url: Videorc-0.25.2-mac-arm64.dmg
    sha512: rUOqDDGMsJP1ubU/Iz+OIO3dSiPY/DF94sVMmeo3wy8gXqCSoAXXJtgaKjHfPsPuhXZUQ/3L7uJ3Xo8RLf4iPQ==
    size: 214151632
path: Videorc-0.25.2-mac-arm64.zip
sha512: Z7qET8L7HZ4QTszW+y4iflPEKw9ykO6CV9ZJZ59IWG+LSFCf+ww5iMFOFWYZnZKCS3g73rxt5anHVxCbvwJqAg==
releaseDate: '2026-11-13T21:54:02.984Z'
";

    /// `https://www.videorc.com/api/updates/latest.yml` on 2026-11-14.
    const WINDOWS_FEED: &str = "version: 0.25.2
files:
  - url: Videorc-0.25.2-win-x64.exe
    sha512: ByOqhU5/sdUmSG7CssgNGemrOVvliE8QYg3e+yxpwkfdSYFmVzdgFnrRXCiaB2kSJyW/5wjkOQFKGyl7U+CmNw==
    size: 214520880
path: Videorc-0.25.2-win-x64.exe
sha512: ByOqhU5/sdUmSG7CssgNGemrOVvliE8QYg3e+yxpwkfdSYFmVzdgFnrRXCiaB2kSJyW/5wjkOQFKGyl7U+CmNw==
releaseDate: '2026-11-13T22:09:54.560Z'
";

    /// SHA-512 of the three bytes `abc`, in base64.
    const ABC_SHA512: &str =
        "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    // the feed as it is published

    #[test]
    fn reads_the_macos_feed_and_takes_the_zip() {
        let info = parse_update_info(MACOS_FEED).unwrap();
        assert_eq!(info.version, version("0.25.2"));
        assert_eq!(info.files.len(), 2);
        assert_eq!(info.path, "Videorc-0.25.2-mac-arm64.zip");
        assert_eq!(
            info.release_date.as_deref(),
            Some("2026-11-13T21:54:02.984Z")
        );
        let package = info.package();
        assert_eq!(package.url, "Videorc-0.25.2-mac-arm64.zip");
        assert_eq!(package.size, 192_312_226);
        assert!(package.sha512.starts_with("Z7qET8L7"));
        assert_eq!(info.files[1].url, "Videorc-0.25.2-mac-arm64.dmg");
        assert_eq!(info.files[1].size, 214_151_632);
    }

    #[test]
    fn reads_the_windows_feed() {
        let info = parse_update_info(WINDOWS_FEED).unwrap();
        assert_eq!(info.version, version("0.25.2"));
        assert_eq!(info.files.len(), 1);
        assert_eq!(info.package().url, "Videorc-0.25.2-win-x64.exe");
        assert_eq!(info.package().size, 214_520_880);
    }

    #[test]
    fn reads_windows_line_endings_comments_and_keys_it_does_not_know() {
        let feed = MACOS_FEED.replace('\n', "\r\n");
        assert_eq!(
            parse_update_info(&feed).unwrap(),
            parse_update_info(MACOS_FEED).unwrap()
        );

        let noted = format!(
            "# a comment\nreleaseName: Videorc\nreleaseNotes: |\n  First line: with a colon\n  - and a dash\nstagingPercentage: 50\n{MACOS_FEED}"
        );
        assert_eq!(
            parse_update_info(&noted).unwrap(),
            parse_update_info(MACOS_FEED).unwrap()
        );
    }

    #[test]
    fn takes_the_first_file_when_the_feed_names_no_path() {
        let feed = MACOS_FEED.replace("path: Videorc-0.25.2-mac-arm64.zip\n", "");
        let info = parse_update_info(&feed).unwrap();
        assert_eq!(info.path, "Videorc-0.25.2-mac-arm64.zip");
    }

    // a feed that cannot be trusted is refused

    #[test]
    fn refuses_a_feed_with_no_version_or_one_that_is_not_a_version() {
        let feed = MACOS_FEED.replace("version: 0.25.2\n", "");
        assert_eq!(parse_update_info(&feed), Err(FeedError::MissingVersion));
        let feed = MACOS_FEED.replace("version: 0.25.2", "version: latest");
        assert_eq!(
            parse_update_info(&feed),
            Err(FeedError::Version("latest".to_string()))
        );
        let feed = MACOS_FEED.replace("version: 0.25.2", "version: 0.25");
        assert_eq!(
            parse_update_info(&feed),
            Err(FeedError::Version("0.25".to_string()))
        );
    }

    #[test]
    fn refuses_a_feed_with_no_files_or_an_incomplete_one() {
        assert_eq!(
            parse_update_info("version: 0.25.2\n"),
            Err(FeedError::NoFiles)
        );
        assert_eq!(
            parse_update_info("version: 0.25.2\nfiles:\n"),
            Err(FeedError::NoFiles)
        );
        let no_size = MACOS_FEED.replace("    size: 214151632\n", "");
        assert_eq!(parse_update_info(&no_size), Err(FeedError::File(2)));
        let zero = MACOS_FEED.replace("size: 192312226", "size: 0");
        assert_eq!(parse_update_info(&zero), Err(FeedError::File(1)));
        let words = MACOS_FEED.replace("size: 192312226", "size: large");
        assert_eq!(parse_update_info(&words), Err(FeedError::File(1)));
        let short_hash = MACOS_FEED.replace("    sha512: rUOqDDGMsJP1ubU/Iz+OIO3dSiPY/DF94sVMmeo3wy8gXqCSoAXXJtgaKjHfPsPuhXZUQ/3L7uJ3Xo8RLf4iPQ==", "    sha512: AAAA");
        assert_eq!(parse_update_info(&short_hash), Err(FeedError::File(2)));
    }

    #[test]
    fn refuses_a_file_name_that_is_not_a_plain_name() {
        for name in [
            "../Videorc.zip",
            "/Videorc.zip",
            "https://example.com/Videorc.zip",
            "sub/Videorc.zip",
            "sub\\Videorc.zip",
            ".hidden.zip",
            "Videorc.zip?x=1",
            "Videorc%2ezip",
        ] {
            let feed = MACOS_FEED
                .replace(
                    "  - url: Videorc-0.25.2-mac-arm64.zip",
                    &format!("  - url: {name}"),
                )
                .replace("path: Videorc-0.25.2-mac-arm64.zip\n", "");
            assert_eq!(parse_update_info(&feed), Err(FeedError::File(1)), "{name}");
        }
    }

    #[test]
    fn refuses_a_path_that_is_not_one_of_the_files() {
        let feed = MACOS_FEED.replace(
            "path: Videorc-0.25.2-mac-arm64.zip",
            "path: Videorc-0.25.2-mac-x64.zip",
        );
        assert_eq!(
            parse_update_info(&feed),
            Err(FeedError::Path("Videorc-0.25.2-mac-x64.zip".to_string()))
        );
    }

    #[test]
    fn refuses_lines_it_cannot_read_and_says_which() {
        assert_eq!(
            parse_update_info("version 0.25.2\n"),
            Err(FeedError::Syntax(1))
        );
        assert_eq!(
            parse_update_info("version: 0.25.2\nfiles: [a, b]\n"),
            Err(FeedError::Syntax(2))
        );
        // A file's key before any list item.
        assert_eq!(
            parse_update_info("version: 0.25.2\nfiles:\n    url: a.zip\n"),
            Err(FeedError::Syntax(3))
        );
        // A quote that does not close, and one with an escape inside.
        assert_eq!(
            parse_update_info("version: '0.25.2\n"),
            Err(FeedError::Syntax(1))
        );
        assert_eq!(
            parse_update_info("version: \"0.25\\\".2\"\n"),
            Err(FeedError::Syntax(1))
        );
        assert_eq!(parse_update_info(""), Err(FeedError::MissingVersion));
    }

    // which version is newer

    #[test]
    fn orders_versions_as_numbers_and_a_pre_release_before_its_release() {
        let info = parse_update_info(MACOS_FEED).unwrap();
        assert!(info.is_newer_than(&version("0.25.1")));
        assert!(info.is_newer_than(&version("0.9.141")));
        assert!(info.is_newer_than(&version("0.25.2-alpha.1")));
        assert!(!info.is_newer_than(&version("0.25.2")));
        assert!(!info.is_newer_than(&version("0.25.10")));
        assert!(!info.is_newer_than(&version("0.26.0-alpha.1")));

        let alpha =
            parse_update_info(&WINDOWS_FEED.replace("version: 0.25.2", "version: 0.26.0-alpha.10"))
                .unwrap();
        assert!(alpha.is_newer_than(&version("0.26.0-alpha.9")));
        assert!(alpha.is_newer_than(&version("0.25.2")));
        assert!(!alpha.is_newer_than(&version("0.26.0")));
    }

    // where a file is fetched from

    #[test]
    fn fetches_a_file_from_under_the_feeds_base() {
        let info = parse_update_info(MACOS_FEED).unwrap();
        assert_eq!(
            file_url("https://www.videorc.com/api/updates/", info.package()),
            "https://www.videorc.com/api/updates/Videorc-0.25.2-mac-arm64.zip"
        );
        assert_eq!(
            file_url("https://www.videorc.com/api/updates/mirror", info.package()),
            "https://www.videorc.com/api/updates/mirror/Videorc-0.25.2-mac-arm64.zip"
        );
    }

    // the bytes are the release's, or nothing installs

    fn file(sha512: &str, size: u64) -> FeedFile {
        FeedFile {
            url: "Videorc.zip".to_string(),
            sha512: sha512.to_string(),
            size,
        }
    }

    #[test]
    fn accepts_a_download_whose_size_and_sha512_are_the_feeds() {
        assert_eq!(
            verify_download(&b"abc"[..], &file(ABC_SHA512, 3)).unwrap(),
            Ok(())
        );
    }

    #[test]
    fn refuses_a_download_of_another_size() {
        assert_eq!(
            verify_download(&b"abcd"[..], &file(ABC_SHA512, 3)).unwrap(),
            Err(IntegrityFailure::Size {
                expected: 3,
                actual: 4
            })
        );
        assert_eq!(
            verify_download(&b""[..], &file(ABC_SHA512, 3)).unwrap(),
            Err(IntegrityFailure::Size {
                expected: 3,
                actual: 0
            })
        );
    }

    #[test]
    fn refuses_a_download_whose_bytes_changed() {
        assert_eq!(
            verify_download(&b"abd"[..], &file(ABC_SHA512, 3)).unwrap(),
            Err(IntegrityFailure::Sha512)
        );
    }

    #[test]
    fn checks_a_download_larger_than_one_read() {
        let bytes = vec![7u8; 200_000];
        let digest = STANDARD.encode(Sha512::digest(&bytes));
        assert_eq!(
            verify_download(&bytes[..], &file(&digest, 200_000)).unwrap(),
            Ok(())
        );
        let mut changed = bytes.clone();
        changed[150_000] = 8;
        assert_eq!(
            verify_download(&changed[..], &file(&digest, 200_000)).unwrap(),
            Err(IntegrityFailure::Sha512)
        );
    }

    #[test]
    fn passes_on_a_read_that_fails() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("the disk went away"))
            }
        }
        assert!(verify_download(Broken, &file(ABC_SHA512, 3)).is_err());
    }
}
