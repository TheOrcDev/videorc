//! A temp folder a test owns (#1086): created fresh under the system temp
//! dir and removed when the guard drops, a panicking test included, so test
//! runs stop piling `videorc-*` folders into `$TMPDIR`.

use std::ops::Deref;
use std::path::{Path, PathBuf};

/// `<temp>/videorc-<label>-<uuid>`, removed on drop. Keep the guard itself
/// alive for the whole test (`let root = TestTempDir::new(..)`), never only
/// a path taken from it. Declare it before anything that holds a file open
/// inside it (a SQLite database): locals drop in reverse order, and Windows
/// cannot remove a folder with an open file. Removal is best effort and never
/// panics.
pub(crate) struct TestTempDir(PathBuf);

impl TestTempDir {
    pub(crate) fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("videorc-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Deref for TestTempDir {
    type Target = PathBuf;

    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

impl AsRef<Path> for TestTempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

mod tests {
    use super::*;

    #[test]
    fn the_folder_lives_with_the_guard_and_goes_with_it() {
        let guard = TestTempDir::new("temp-dir-guard");
        let path = guard.to_path_buf();
        std::fs::write(path.join("file"), b"x").unwrap();
        assert!(path.is_dir());
        drop(guard);
        assert!(!path.exists());
    }
}
