//! The plan in the Studio: `entitlements.get` at every connection and
//! `entitlements.updated` after it, kept in the snapshot for the start gates
//! (`inspector::StartGates::of_snapshot`): Record and Go Live read the same
//! entitlements Electron's `startBlockedReasonFor` does. A read that fails or
//! isn't a snapshot keeps the last one, and none gates as Basic.

use serde_json::Value;

use super::{Studio, StudioBackend};
use crate::account::entitlements::read_snapshot;
use crate::captions::methods::ENTITLEMENTS_GET;

impl<B: StudioBackend> Studio<B> {
    /// `entitlements.get`, at this connection's bootstrap.
    pub(super) async fn read_entitlements(&self, generation: u64) {
        let Ok(answer) = self
            .backend
            .captions_request(ENTITLEMENTS_GET, Value::Null)
            .await
        else {
            return;
        };
        if self.lock().bootstrap_generation != generation {
            return;
        }
        self.apply_entitlements(&answer);
    }

    /// An `entitlements.*` answer or event.
    pub(super) fn apply_entitlements(&self, payload: &Value) {
        let Some(snapshot) = read_snapshot(payload) else {
            return;
        };
        {
            let mut inner = self.lock();
            if inner.entitlements.as_ref() == Some(&snapshot) {
                return;
            }
            inner.entitlements = Some(snapshot);
        }
        self.publish();
    }
}
