//! The Studio's scene where no preview element commits it (Windows until
//! plan 260 S2.3b).
//!
//! On macOS and Linux the preview feed commits the Studio's scene
//! (`scene::follow_studio`); Electron's `reloadSceneFromCaptureConfig`
//! effect does the same on every platform. With no preview element on
//! Windows nothing committed it, so the backend held no scene: the Scene
//! page listed no sources, the Clips ring waited for a camera preview that
//! never started (`replay-sources-not-ready`), and a "Screen + camera"
//! Record was refused for a camera with no frames. [`follow`] commits the
//! scene on the feed's triggers instead, with no picture.

use std::time::{Duration, Instant};

use videorc_protocol::SceneConfigParams;

/// How long after a layout transaction's commit the next scene is taken as
/// that commit's (`scene::ADOPT_WINDOW`).
const ADOPT_WINDOW: Duration = Duration::from_secs(3);

/// Electron's reload waits 250 ms after the change that asks for it, so a
/// burst of settings writes commits once.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const SETTLE: Duration = Duration::from_millis(250);

/// When to commit: the feed's own rule. A request that differs from the
/// last one (none in between counts, so the scene comes back after a
/// session) is committed; the scene a layout transaction just committed is
/// adopted, not committed again.
#[derive(Debug, Default)]
pub(crate) struct SceneFollower {
    sent: Option<SceneConfigParams>,
    seen_commit: u64,
    armed: Option<(Option<SceneConfigParams>, Instant)>,
}

impl SceneFollower {
    pub(crate) fn new(commit_revision: u64) -> Self {
        Self {
            seen_commit: commit_revision,
            ..Self::default()
        }
    }

    /// Whether `request` should be committed now.
    pub(crate) fn next(
        &mut self,
        request: Option<SceneConfigParams>,
        commit_revision: u64,
        now: Instant,
    ) -> bool {
        if commit_revision > self.seen_commit {
            self.seen_commit = commit_revision;
            self.armed = Some((self.sent.clone(), now));
        }
        if let Some((before, at)) = &self.armed {
            if now.duration_since(*at) > ADOPT_WINDOW {
                self.armed = None;
            } else if request.is_some() && request != *before {
                // The transaction's own scene: the backend shows it already.
                self.sent = request;
                self.armed = None;
                return false;
            }
        }
        if request == self.sent {
            return false;
        }
        self.sent = request;
        self.sent.is_some()
    }

    /// The commit didn't land (a switch overtook it, or it failed): the
    /// same request is committed again next time.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub(crate) fn forget(&mut self) {
        self.sent = None;
    }
}

/// Commits the Studio's scene on every change the preview feed would
/// commit, for as long as the Studio runs.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn follow(
    studio: &std::sync::Arc<videorc_app_core::Studio<videorc_app_core::BackendClient>>,
    runtime: &tokio::runtime::Handle,
    logger: videorc_app_core::Logger,
) {
    use videorc_app_core::Level;
    use videorc_app_core::studio::preview_scene::preview_scene_request;
    use videorc_app_core::studio::scene_switch::{
        is_scene_reload_superseded, scene_reload_retry_delay,
    };

    let studio = studio.clone();
    runtime.spawn(async move {
        let mut snapshots = studio.watch();
        let mut follower = SceneFollower::new(studio.layout_commit_revision());
        let mut superseded = 0u32;
        loop {
            let request = preview_scene_request(&snapshots.borrow_and_update(), false);
            if follower.next(request, studio.layout_commit_revision(), Instant::now()) {
                tokio::time::sleep(SETTLE).await;
                if snapshots.has_changed().unwrap_or(false) {
                    // A newer change came in the wait: decide on that one.
                    follower.forget();
                    continue;
                }
                match studio.reload_scene_from_capture_config().await {
                    Ok(()) => superseded = 0,
                    Err(error) if is_scene_reload_superseded(&error) => {
                        // A session took the scene first: nothing failed,
                        // and the scene still follows the settings after.
                        tokio::time::sleep(scene_reload_retry_delay(superseded)).await;
                        superseded = superseded.saturating_add(1);
                        follower.forget();
                        continue;
                    }
                    Err(error) => {
                        logger.log(
                            Level::Warn,
                            &format!("[preview] the scene could not load: {error}"),
                        );
                        follower.forget();
                    }
                }
            }
            if snapshots.changed().await.is_err() {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_app_core::studio::capture_config::CaptureConfig;
    use videorc_protocol::SourceSelection;

    fn scene(screen: &str) -> SceneConfigParams {
        SceneConfigParams {
            sources: SourceSelection {
                screen_id: Some(screen.to_string()),
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            layout: CaptureConfig::default().layout,
            video: None,
            background: None,
            protected_overlay_window_ids: Vec::new(),
            transition_ms: None,
        }
    }

    #[test]
    fn a_new_scene_commits_once_and_again_after_a_session() {
        let now = Instant::now();
        let mut follower = SceneFollower::new(0);
        assert!(
            !follower.next(None, 0, now),
            "nothing to commit before settings load"
        );
        assert!(follower.next(Some(scene("1")), 0, now));
        assert!(
            !follower.next(Some(scene("1")), 0, now),
            "the same scene twice"
        );
        assert!(follower.next(Some(scene("2")), 0, now));
        // A session holds the scene, then lets it go: it is committed again.
        assert!(!follower.next(None, 0, now));
        assert!(follower.next(Some(scene("2")), 0, now));
    }

    #[test]
    fn a_layout_transactions_own_scene_is_adopted_not_committed() {
        let now = Instant::now();
        let mut follower = SceneFollower::new(0);
        assert!(follower.next(Some(scene("1")), 0, now));
        // The transaction committed revision 1; the settle writes its scene.
        assert!(!follower.next(Some(scene("1")), 1, now));
        assert!(!follower.next(Some(scene("2")), 1, now + Duration::from_secs(1)));
        // Later changes commit as usual.
        assert!(follower.next(Some(scene("3")), 1, now + Duration::from_secs(2)));
    }

    #[test]
    fn a_change_after_the_adopt_window_is_committed() {
        let now = Instant::now();
        let mut follower = SceneFollower::new(0);
        assert!(follower.next(Some(scene("1")), 0, now));
        assert!(!follower.next(Some(scene("1")), 1, now));
        assert!(follower.next(Some(scene("2")), 1, now + Duration::from_secs(4)));
    }
}
