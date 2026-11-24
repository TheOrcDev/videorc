//! Plan 260 S1.8b: PERF-06's asset references, the renderer's
//! `room-asset-references.ts` in Rust. A program page that advertises
//! `refs: 1` resolves an asset sent as `{ hash, width, height }` (no `png`)
//! from the snapshot it last committed; the publishers send that form only
//! for a hash the page provably holds: its current receipt acknowledges, as
//! applied by this publisher, a revision sent to this very session (lease
//! still running), and the hash is in that snapshot and in every snapshot
//! written to the session after it. Anything else goes whole.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

/// Bounded per peer: a receipt acknowledging anything older gets whole assets.
const HISTORY: usize = 8;

struct SentSnapshot {
    revision: u64,
    expires_at: i64,
    hashes: HashSet<String>,
}

struct Peer {
    sid: String,
    publisher_sid: String,
    sent: VecDeque<SentSnapshot>,
}

#[derive(Default)]
pub(crate) struct SentAssets {
    peers: HashMap<String, Peer>,
}

/// The asset hashes of a snapshot's layers.
fn layer_hashes(snapshot: &Value) -> HashSet<String> {
    snapshot
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layer| layer.get("asset")?.get("hash")?.as_str())
        .map(str::to_string)
        .collect()
}

impl SentAssets {
    /// A snapshot fully written to `identity`'s session `sid`.
    pub(crate) fn record(
        &mut self,
        identity: &str,
        sid: &str,
        publisher_sid: &str,
        snapshot: &Value,
    ) {
        let peer = self
            .peers
            .entry(identity.to_string())
            .or_insert_with(|| Peer {
                sid: sid.to_string(),
                publisher_sid: publisher_sid.to_string(),
                sent: VecDeque::new(),
            });
        if peer.sid != sid || peer.publisher_sid != publisher_sid {
            *peer = Peer {
                sid: sid.to_string(),
                publisher_sid: publisher_sid.to_string(),
                sent: VecDeque::new(),
            };
        }
        peer.sent.push_back(SentSnapshot {
            revision: snapshot
                .get("revision")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            expires_at: snapshot
                .get("expiresAt")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            hashes: layer_hashes(snapshot),
        });
        if peer.sent.len() > HISTORY {
            peer.sent.pop_front();
        }
    }

    /// The hashes `identity` provably holds now, given its receipt; empty
    /// when unsure. `applied` is the receipt's (publisherSid, revision).
    pub(crate) fn held(
        &self,
        identity: &str,
        refs: bool,
        applied: Option<(&str, u64)>,
        sid: &str,
        local_sid: &str,
        now: i64,
    ) -> HashSet<String> {
        let (Some(peer), Some((applied_sid, applied_revision))) =
            (self.peers.get(identity), applied)
        else {
            return HashSet::new();
        };
        if !refs || peer.sid != sid || peer.publisher_sid != local_sid || applied_sid != local_sid {
            return HashSet::new();
        }
        let Some(from) = peer
            .sent
            .iter()
            .position(|s| s.revision == applied_revision)
        else {
            return HashSet::new();
        };
        if peer.sent[from].expires_at <= now {
            return HashSet::new();
        }
        let mut held = peer.sent[from].hashes.clone();
        for later in peer.sent.iter().skip(from + 1) {
            held.retain(|hash| later.hashes.contains(hash));
        }
        held
    }

    pub(crate) fn forget(&mut self, identity: &str) {
        self.peers.remove(identity);
    }
}

/// `withReferences`: each held asset loses its `png`.
pub(crate) fn with_references(snapshot: &Value, held: &HashSet<String>) -> Value {
    let mut wire = snapshot.clone();
    if held.is_empty() {
        return wire;
    }
    if let Some(layers) = wire.get_mut("layers").and_then(Value::as_array_mut) {
        for layer in layers {
            let held_hash = layer
                .get("asset")
                .and_then(|asset| asset.get("hash"))
                .and_then(Value::as_str)
                .is_some_and(|hash| held.contains(hash));
            if held_hash && let Some(asset) = layer.get_mut("asset").and_then(Value::as_object_mut)
            {
                asset.remove("png");
            }
        }
    }
    wire
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(revision: u64, hashes: &[&str]) -> Value {
        json!({
            "revision": revision,
            "expiresAt": 100_000,
            "layers": hashes.iter().map(|hash| json!({
                "id": hash, "asset": { "hash": hash, "png": "AAAA", "width": 2, "height": 2 }
            })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn a_hash_is_held_only_when_acknowledged_and_kept_since() {
        let mut assets = SentAssets::default();
        assets.record("EG_a", "PA_page", "PA_me", &snapshot(1, &["x", "y"]));
        assets.record("EG_a", "PA_page", "PA_me", &snapshot(2, &["x"]));
        // Acknowledged revision 1; revision 2 dropped `y`.
        let held = assets.held("EG_a", true, Some(("PA_me", 1)), "PA_page", "PA_me", 0);
        assert_eq!(held, HashSet::from(["x".to_string()]));
        // No refs, a foreign acknowledgement, another session, an unknown
        // revision or an expired lease: nothing is held.
        assert!(
            assets
                .held("EG_a", false, Some(("PA_me", 1)), "PA_page", "PA_me", 0)
                .is_empty()
        );
        assert!(
            assets
                .held("EG_a", true, Some(("PA_other", 1)), "PA_page", "PA_me", 0)
                .is_empty()
        );
        assert!(
            assets
                .held("EG_a", true, Some(("PA_me", 1)), "PA_new", "PA_me", 0)
                .is_empty()
        );
        assert!(
            assets
                .held("EG_a", true, Some(("PA_me", 9)), "PA_page", "PA_me", 0)
                .is_empty()
        );
        assert!(
            assets
                .held(
                    "EG_a",
                    true,
                    Some(("PA_me", 1)),
                    "PA_page",
                    "PA_me",
                    100_000
                )
                .is_empty()
        );
    }

    #[test]
    fn held_assets_go_as_references_and_the_rest_whole() {
        let wire = with_references(&snapshot(1, &["x", "y"]), &HashSet::from(["x".to_string()]));
        assert_eq!(
            wire["layers"][0]["asset"],
            json!({ "hash": "x", "width": 2, "height": 2 })
        );
        assert_eq!(wire["layers"][1]["asset"]["png"], "AAAA");
        assert_eq!(
            with_references(&snapshot(1, &["x"]), &HashSet::new()),
            snapshot(1, &["x"])
        );
    }
}
