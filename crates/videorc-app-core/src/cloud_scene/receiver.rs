//! Latest-revision scene receiver (Electron `SceneReceiver`).

use super::types::{SceneApplied, SceneSnapshot};

/// Latest revision wins; clear (a null scene) outranks everything older.
/// The page calls [`SceneReceiver::rendered`] once the scene's frame is drawn;
/// only then is the revision applied. Owner change, lease expiry and clear
/// drop the scene.
pub struct SceneReceiver<S, N>
where
    S: FnMut(Option<&SceneSnapshot>),
    N: FnMut() -> i64,
{
    owner: Option<String>,
    wanted: i64,
    current: Option<SceneSnapshot>,
    applied: Option<SceneApplied>,
    show: S,
    now: N,
}

impl<S, N> SceneReceiver<S, N>
where
    S: FnMut(Option<&SceneSnapshot>),
    N: FnMut() -> i64,
{
    /// Create a receiver with show/now dependencies.
    pub fn new(show: S, now: N) -> Self {
        Self {
            owner: None,
            wanted: 0,
            current: None,
            applied: None,
            show,
            now,
        }
    }

    /// The revision confirmed drawn.
    pub fn applied(&self) -> Option<&SceneApplied> {
        self.applied.as_ref()
    }

    /// The snapshot waiting to be drawn (or already current).
    pub fn current(&self) -> Option<&SceneSnapshot> {
        self.current.as_ref()
    }

    /// Set the presentation owner; a change drops the scene.
    pub fn owner(&mut self, sid: Option<&str>) {
        let next = sid.map(str::to_string);
        if self.owner == next {
            return;
        }
        self.owner = next;
        self.wanted = 0;
        self.drop_scene();
    }

    fn drop_scene(&mut self) {
        let had = self.current.is_some();
        self.current = None;
        self.applied = None;
        if had {
            (self.show)(None);
        }
    }

    /// Drop an expired lease.
    pub fn step(&mut self) {
        if let Some(current) = &self.current
            && (self.now)() >= current.expires_at
        {
            self.drop_scene();
        }
    }

    /// Accept a newer snapshot from the current owner.
    pub fn accept(&mut self, snapshot: SceneSnapshot) -> bool {
        if Some(snapshot.publisher_sid.as_str()) != self.owner.as_deref()
            || snapshot.revision <= self.wanted
        {
            return false;
        }
        if snapshot.expires_at <= (self.now)() {
            return false;
        }
        self.wanted = snapshot.revision;
        self.applied = None;
        (self.show)(Some(&snapshot));
        self.current = Some(snapshot);
        true
    }

    /// The frame for `revision` is drawn.
    pub fn rendered(&mut self, revision: i64) {
        let Some(current) = &self.current else {
            return;
        };
        if current.revision != revision || (self.now)() >= current.expires_at {
            return;
        }
        self.applied = Some(SceneApplied {
            publisher_sid: current.publisher_sid.clone(),
            revision,
        });
    }
}
