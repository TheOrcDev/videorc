//! The plan in the Studio: `entitlements.get` at every connection and
//! `entitlements.updated` after it, kept in the snapshot for the start gates
//! (`inspector::StartGates::of_snapshot`): Record and Go Live read the same
//! entitlements Electron's `startBlockedReasonFor` does.
//!
//! The gates fail open (`inspector::plan_is_known`), so this never keeps a
//! plan it can't vouch for: a read that fails, or an answer or event that
//! isn't a plan, CLEARS the held one, and a start the app can't prove over
//! the plan's limits is left to the backend, which enforces the plan.

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
            // Not read (the backend answers no plan): none held.
            if self.lock().bootstrap_generation == generation {
                self.set_entitlements(None);
            }
            return;
        };
        if self.lock().bootstrap_generation != generation {
            return;
        }
        self.apply_entitlements(&answer);
    }

    /// An `entitlements.*` answer or event. Not a plan: none held.
    pub(super) fn apply_entitlements(&self, payload: &Value) {
        self.set_entitlements(read_snapshot(payload));
    }

    fn set_entitlements(&self, plan: Option<videorc_protocol::EntitlementsSnapshot>) {
        {
            let mut inner = self.lock();
            if inner.entitlements == plan {
                return;
            }
            inner.entitlements = plan;
        }
        self.publish();
    }
}
