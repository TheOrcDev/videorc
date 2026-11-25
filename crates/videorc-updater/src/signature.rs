//! Whether a downloaded app is signed as this one is (macOS).
//!
//! The feed's SHA-512 says the bytes are the ones that were published. This
//! says who published them: before anything is replaced, the new bundle must
//! carry a valid Developer ID signature of the same team, for the same
//! bundle id. macOS's own `codesign` does the checking; this module only
//! writes the requirement and reads the answer.

use std::fmt;
use std::path::Path;
use std::process::Command;

/// Who signs Videorc: the team, and the app's bundle id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningIdentity {
    /// The Developer ID team, ten letters and digits.
    pub team_id: String,
    pub bundle_id: String,
}

/// Why a bundle was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureFailure {
    /// The identity cannot be written into a requirement: a team id that is
    /// not ten upper-case letters and digits, or a bundle id with anything
    /// but letters, digits, dots and hyphens.
    Identity,
    /// The signature is missing, broken or someone else's. The text is
    /// `codesign`'s own.
    Refused(String),
    /// `codesign` could not be run.
    Tool(String),
}

impl fmt::Display for SignatureFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity => formatter.write_str("the signing identity is not valid"),
            Self::Refused(detail) => write!(formatter, "the signature was refused: {detail}"),
            Self::Tool(detail) => write!(formatter, "codesign could not run: {detail}"),
        }
    }
}

impl std::error::Error for SignatureFailure {}

/// The requirement a Videorc bundle must meet: Apple's Developer ID chain,
/// this team, this bundle id. `None` when the identity could not be written
/// into one safely.
pub fn developer_id_requirement(identity: &SigningIdentity) -> Option<String> {
    let team = &identity.team_id;
    let bundle = &identity.bundle_id;
    let team_is_plain = team.len() == 10
        && team
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
    let bundle_is_plain = !bundle.is_empty()
        && bundle.len() <= 155
        && bundle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-');
    if !team_is_plain || !bundle_is_plain {
        return None;
    }
    // The second and third clauses are Apple's markers for a Developer ID
    // intermediate and a Developer ID Application leaf.
    Some(format!(
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{team}\" and identifier \"{bundle}\""
    ))
}

/// Checks that the bundle at `bundle` is validly signed, every nested part
/// included, and that its signature meets `requirement`.
pub fn verify_code_signature(bundle: &Path, requirement: &str) -> Result<(), SignatureFailure> {
    let output = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--deep")
        .arg("--strict")
        .arg("-R")
        .arg(format!("={requirement}"))
        .arg(bundle)
        .output()
        .map_err(|error| SignatureFailure::Tool(error.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&output.stderr);
    let detail = said
        .lines()
        .last()
        .unwrap_or("no reason given")
        .trim()
        .to_string();
    Err(SignatureFailure::Refused(detail))
}

/// Checks that the bundle at `bundle` is Videorc's: validly signed by
/// `identity`'s team for its bundle id.
pub fn verify_videorc_bundle(
    bundle: &Path,
    identity: &SigningIdentity,
) -> Result<(), SignatureFailure> {
    let requirement = developer_id_requirement(identity).ok_or(SignatureFailure::Identity)?;
    verify_code_signature(bundle, &requirement)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    /// An app Apple signs, on every Mac.
    const APPLE_APP: &str = "/System/Applications/Calculator.app";
    /// The shipped Videorc, when this Mac has it.
    const INSTALLED_VIDEORC: &str = "/Applications/Videorc.app";

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn videorc() -> SigningIdentity {
        SigningIdentity {
            team_id: "C2PA37RB58".to_string(),
            bundle_id: "dev.theorcdev.videorc".to_string(),
        }
    }

    /// A folder of this test's own, removed when it goes out of scope.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "videorc-updater-signature-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // the requirement

    #[test]
    fn asks_for_apples_developer_id_chain_this_team_and_this_bundle_id() {
        assert_eq!(
            developer_id_requirement(&videorc()).as_deref(),
            Some(
                "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"C2PA37RB58\" and identifier \"dev.theorcdev.videorc\""
            )
        );
    }

    #[test]
    fn refuses_an_identity_that_could_change_the_requirement() {
        for (team_id, bundle_id) in [
            ("", "dev.theorcdev.videorc"),
            ("C2PA37RB5", "dev.theorcdev.videorc"),
            ("c2pa37rb58", "dev.theorcdev.videorc"),
            ("C2PA37RB58\"", "dev.theorcdev.videorc"),
            ("C2PA37RB58", ""),
            ("C2PA37RB58", "dev.theorcdev.videorc\" or anchor apple"),
            ("C2PA37RB58", "dev theorcdev videorc"),
        ] {
            let identity = SigningIdentity {
                team_id: team_id.to_string(),
                bundle_id: bundle_id.to_string(),
            };
            assert_eq!(
                developer_id_requirement(&identity),
                None,
                "{team_id} {bundle_id}"
            );
            assert_eq!(
                verify_videorc_bundle(Path::new(APPLE_APP), &identity),
                Err(SignatureFailure::Identity)
            );
        }
    }

    // what codesign answers

    #[test]
    fn accepts_a_valid_signature_that_meets_the_requirement() {
        if !Path::new(APPLE_APP).exists() {
            eprintln!("SKIP: {APPLE_APP} is not on this Mac");
            return;
        }
        assert_eq!(
            verify_code_signature(Path::new(APPLE_APP), "anchor apple"),
            Ok(())
        );
    }

    #[test]
    fn refuses_an_app_someone_else_signed() {
        if !Path::new(APPLE_APP).exists() {
            eprintln!("SKIP: {APPLE_APP} is not on this Mac");
            return;
        }
        let refused = verify_videorc_bundle(Path::new(APPLE_APP), &videorc());
        assert!(
            matches!(refused, Err(SignatureFailure::Refused(_))),
            "{refused:?}"
        );
    }

    #[test]
    fn refuses_a_bundle_with_no_signature() {
        let scratch = Scratch::new();
        let bundle = scratch.0.join("Videorc.app");
        fs::create_dir_all(bundle.join("Contents").join("MacOS")).unwrap();
        fs::write(
            bundle.join("Contents").join("MacOS").join("Videorc"),
            "not a program",
        )
        .unwrap();
        let refused = verify_videorc_bundle(&bundle, &videorc());
        assert!(
            matches!(refused, Err(SignatureFailure::Refused(_))),
            "{refused:?}"
        );
        // Not even the loosest requirement lets an unsigned bundle through.
        let refused = verify_code_signature(&bundle, "anchor apple generic");
        assert!(
            matches!(refused, Err(SignatureFailure::Refused(_))),
            "{refused:?}"
        );
    }

    /// A small bundle of this test's own, signed ad hoc as `dev.videorc.test`.
    /// `None` when this Mac could not sign it.
    fn signed_test_bundle(scratch: &Scratch) -> Option<PathBuf> {
        let bundle = scratch.0.join("Test.app");
        let contents = bundle.join("Contents");
        fs::create_dir_all(contents.join("MacOS")).unwrap();
        fs::create_dir_all(contents.join("Resources")).unwrap();
        fs::copy("/usr/bin/true", contents.join("MacOS").join("Test")).ok()?;
        fs::write(
            contents.join("Info.plist"),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>CFBundleIdentifier</key><string>dev.videorc.test</string>\n<key>CFBundleExecutable</key><string>Test</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n</dict></plist>\n",
        )
        .unwrap();
        fs::write(contents.join("Resources").join("note.txt"), "hello").unwrap();
        let signed = Command::new("/usr/bin/codesign")
            .args(["--force", "-s", "-", "--identifier", "dev.videorc.test"])
            .arg(&bundle)
            .output();
        signed
            .is_ok_and(|output| output.status.success())
            .then_some(bundle)
    }

    const TEST_REQUIREMENT: &str = "identifier \"dev.videorc.test\"";

    #[test]
    fn refuses_a_signed_bundle_that_was_changed_afterwards() {
        let scratch = Scratch::new();
        let Some(bundle) = signed_test_bundle(&scratch) else {
            eprintln!("SKIP: this Mac could not sign a test bundle");
            return;
        };
        assert_eq!(verify_code_signature(&bundle, TEST_REQUIREMENT), Ok(()));
        // One file added inside it, and it is no longer what was signed.
        let added = bundle.join("Contents").join("Resources").join("added.txt");
        fs::write(&added, "x").unwrap();
        let refused = verify_code_signature(&bundle, TEST_REQUIREMENT);
        assert!(
            matches!(refused, Err(SignatureFailure::Refused(_))),
            "{refused:?}"
        );
        // The same for a file that was there and now says something else.
        fs::remove_file(&added).unwrap();
        assert_eq!(verify_code_signature(&bundle, TEST_REQUIREMENT), Ok(()));
        fs::write(
            bundle.join("Contents").join("Resources").join("note.txt"),
            "changed",
        )
        .unwrap();
        let refused = verify_code_signature(&bundle, TEST_REQUIREMENT);
        assert!(
            matches!(refused, Err(SignatureFailure::Refused(_))),
            "{refused:?}"
        );
    }

    #[test]
    fn refuses_a_valid_signature_that_is_not_a_developer_id() {
        let scratch = Scratch::new();
        let Some(bundle) = signed_test_bundle(&scratch) else {
            eprintln!("SKIP: this Mac could not sign a test bundle");
            return;
        };
        // Signed, intact, with the right bundle id, and still not Videorc's:
        // an ad hoc signature has no Developer ID behind it.
        let identity = SigningIdentity {
            bundle_id: "dev.videorc.test".to_string(),
            ..videorc()
        };
        let refused = verify_videorc_bundle(&bundle, &identity);
        assert!(
            matches!(refused, Err(SignatureFailure::Refused(_))),
            "{refused:?}"
        );
    }

    #[test]
    fn accepts_the_videorc_this_mac_has_installed() {
        if !Path::new(INSTALLED_VIDEORC).exists() {
            eprintln!("SKIP: {INSTALLED_VIDEORC} is not on this Mac");
            return;
        }
        assert_eq!(
            verify_videorc_bundle(Path::new(INSTALLED_VIDEORC), &videorc()),
            Ok(())
        );
        // The same app under another team's name, or another bundle id, is
        // not Videorc.
        let other_team = SigningIdentity {
            team_id: "ABCDE12345".to_string(),
            ..videorc()
        };
        assert!(matches!(
            verify_videorc_bundle(Path::new(INSTALLED_VIDEORC), &other_team),
            Err(SignatureFailure::Refused(_))
        ));
        let other_bundle = SigningIdentity {
            bundle_id: "dev.theorcdev.other".to_string(),
            ..videorc()
        };
        assert!(matches!(
            verify_videorc_bundle(Path::new(INSTALLED_VIDEORC), &other_bundle),
            Err(SignatureFailure::Refused(_))
        ));
    }
}
