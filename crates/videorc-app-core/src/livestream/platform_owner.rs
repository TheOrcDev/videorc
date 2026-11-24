//! S1.6c: who owns a livestream's platform cleanup (`use-studio.tsx`:
//! `platformLifecycleOwnerRef`, `preparedPlatformLifecycleOwnersRef`,
//! `claimPlatformLifecycleOwner`, `retainPlatformLifecycleOwner`,
//! `latchHandOff`, and the X END and YouTube complete result caches).
//!
//! - **The owner** is the session that went live with these destinations.
//!   Its broadcasts are ended and completed exactly once: the stop claims
//!   it, and a cleanup that couldn't finish retains it, so the next Go Live
//!   settles it first or refuses (`LIVESTREAM_STILL_SETTLING`).
//! - **Prepared owners** (`prepared-platform:N`) hold what a Go Live
//!   prepared and never started (a cancelled partial setup, a refused
//!   start). They queue; each settles before the next start.
//! - **A hand-off** (plan 243 D7) drops the owner: the show goes on from
//!   another device, so nothing here ends it.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

/// `PREPARED_PLATFORM_LIFECYCLE_OWNER_PREFIX`.
pub const PREPARED_OWNER_PREFIX: &str = "prepared-platform:";
/// The result caches keep this many broadcasts.
pub const COMPLETED_RESULTS_MAX: usize = 128;

/// `isPreparedPlatformLifecycleOwner`.
pub fn is_prepared_owner(id: &str) -> bool {
    id.starts_with(PREPARED_OWNER_PREFIX)
}

/// `PlatformLifecycleOwner`: a session (or a prepared Go Live) and the
/// streaming settings its broadcasts were prepared with.
#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    pub session_id: String,
    pub streaming: Value,
}

/// The owners: the session's and the prepared ones still to settle.
#[derive(Debug, Default)]
pub struct Owners {
    current: Option<Owner>,
    retained: VecDeque<Owner>,
    sequence: u64,
}

impl Owners {
    /// The session's owner, as the start installs it.
    pub fn install(&mut self, owner: Owner) {
        self.current = Some(owner);
    }

    pub fn current(&self) -> Option<&Owner> {
        self.current.as_ref()
    }

    /// A publish's answer updates the owner it ran for.
    pub fn update_streaming(&mut self, session_id: &str, streaming: &Value) {
        if let Some(owner) = self
            .current
            .as_mut()
            .filter(|owner| owner.session_id == session_id)
        {
            owner.streaming = streaming.clone();
        }
    }

    /// `claimPlatformLifecycleOwner`: the owner leaves the book for whoever
    /// settles it.
    pub fn claim(&mut self, session_id: &str) -> Option<Owner> {
        if session_id.is_empty()
            || self.current.as_ref().map(|owner| owner.session_id.as_str()) != Some(session_id)
        {
            return None;
        }
        self.current.take()
    }

    /// `retainPlatformLifecycleOwner`: a cleanup that didn't finish keeps
    /// its owner. A prepared one replaces its earlier self in the queue; a
    /// session's takes the slot unless another session holds it.
    pub fn retain(&mut self, owner: Owner) {
        if is_prepared_owner(&owner.session_id) {
            match self
                .retained
                .iter_mut()
                .find(|candidate| candidate.session_id == owner.session_id)
            {
                Some(existing) => *existing = owner,
                None => self.retained.push_back(owner),
            }
            return;
        }
        if self
            .current
            .as_ref()
            .is_none_or(|current| current.session_id == owner.session_id)
        {
            self.current = Some(owner);
        }
    }

    /// `createPreparedPlatformLifecycleOwner`.
    pub fn prepared(&mut self, streaming: Value) -> Owner {
        self.sequence += 1;
        Owner {
            session_id: format!("{PREPARED_OWNER_PREFIX}{}", self.sequence),
            streaming,
        }
    }

    /// The oldest prepared owner still to settle.
    pub fn next_retained(&mut self) -> Option<Owner> {
        self.retained.pop_front()
    }

    /// `latchHandOff`: the owner whose session a hand-off stopped is
    /// dropped, never settled here.
    pub fn drop_handed_off(&mut self, handed_off: &[String]) -> Option<Owner> {
        let owned = self
            .current
            .as_ref()
            .is_some_and(|owner| handed_off.contains(&owner.session_id));
        if owned { self.current.take() } else { None }
    }
}

/// The key a broadcast's END or complete is single-flight on:
/// `JSON.stringify([accountId ?? '', broadcastId])`.
pub fn broadcast_key(account_id: Option<&str>, broadcast_id: &str) -> String {
    serde_json::to_string(&[account_id.unwrap_or_default(), broadcast_id]).unwrap_or_default()
}

/// The answers of broadcasts already ended or completed, oldest dropped
/// past `COMPLETED_RESULTS_MAX`.
#[derive(Debug, Default)]
pub struct CompletedResults {
    results: HashMap<String, Value>,
    order: VecDeque<String>,
}

impl CompletedResults {
    pub fn get(&self, key: &str) -> Option<Value> {
        self.results.get(key).cloned()
    }

    pub fn insert(&mut self, key: String, result: Value) {
        if self.results.insert(key.clone(), result).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > COMPLETED_RESULTS_MAX {
            if let Some(oldest) = self.order.pop_front() {
                self.results.remove(&oldest);
            }
        }
    }

    pub fn remove(&mut self, key: &str) {
        if self.results.remove(key).is_some() {
            self.order.retain(|candidate| candidate != key);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn owner(id: &str, n: u64) -> Owner {
        Owner {
            session_id: id.into(),
            streaming: json!({ "n": n }),
        }
    }

    #[test]
    fn the_stop_claims_the_sessions_owner_once() {
        let mut owners = Owners::default();
        owners.install(owner("s-1", 1));
        assert_eq!(owners.claim("s-2"), None);
        assert_eq!(owners.claim(""), None);
        assert_eq!(owners.claim("s-1"), Some(owner("s-1", 1)));
        assert_eq!(owners.claim("s-1"), None);
    }

    #[test]
    fn an_unfinished_cleanup_is_retained_without_taking_another_sessions_slot() {
        let mut owners = Owners::default();
        owners.retain(owner("s-1", 1));
        assert_eq!(owners.current(), Some(&owner("s-1", 1)));
        owners.retain(owner("s-1", 2));
        assert_eq!(owners.current(), Some(&owner("s-1", 2)));
        owners.retain(owner("s-2", 3));
        assert_eq!(owners.current(), Some(&owner("s-1", 2)));
        owners.update_streaming("s-1", &json!({ "n": 4 }));
        owners.update_streaming("s-9", &json!({ "n": 5 }));
        assert_eq!(owners.current(), Some(&owner("s-1", 4)));
    }

    #[test]
    fn prepared_owners_queue_and_replace_their_earlier_selves() {
        let mut owners = Owners::default();
        let first = owners.prepared(json!({ "n": 1 }));
        let second = owners.prepared(json!({ "n": 2 }));
        assert_eq!(first.session_id, "prepared-platform:1");
        assert!(is_prepared_owner(&second.session_id));
        assert!(!is_prepared_owner("s-1"));
        owners.retain(first.clone());
        owners.retain(second.clone());
        owners.retain(Owner {
            streaming: json!({ "n": 3 }),
            ..first.clone()
        });
        assert_eq!(owners.current(), None);
        assert_eq!(owners.next_retained().unwrap().streaming, json!({ "n": 3 }));
        assert_eq!(owners.next_retained(), Some(second));
        assert_eq!(owners.next_retained(), None);
    }

    #[test]
    fn a_hand_off_drops_the_owner_of_the_session_it_stopped() {
        let mut owners = Owners::default();
        owners.install(owner("s-1", 1));
        assert_eq!(owners.drop_handed_off(&["show-1".into()]), None);
        assert_eq!(
            owners.drop_handed_off(&["show-1".into(), "s-1".into()]),
            Some(owner("s-1", 1))
        );
        assert_eq!(owners.current(), None);
    }

    #[test]
    fn the_result_cache_keys_on_the_account_and_broadcast_and_keeps_the_newest() {
        assert_eq!(broadcast_key(Some("a"), "b"), r#"["a","b"]"#);
        assert_eq!(broadcast_key(None, "b"), r#"["","b"]"#);
        let mut results = CompletedResults::default();
        for n in 0..=COMPLETED_RESULTS_MAX {
            results.insert(format!("k{n}"), json!(n));
        }
        assert_eq!(results.get("k0"), None);
        assert_eq!(results.get("k1"), Some(json!(1)));
        results.remove("k1");
        assert_eq!(results.get("k1"), None);
        results.insert("k1".into(), json!(9));
        assert_eq!(results.get("k1"), Some(json!(9)));
    }
}
