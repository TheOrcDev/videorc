use std::collections::{BTreeMap, BTreeSet};

use crate::source_status::SourceLifecycleStatus;

// Plan 260 S1.1: these wire types live in `videorc-protocol` now.
pub use videorc_protocol::source_registry::{
    SourceConsumerReason, SourceIdentityConfidence, SourceKey, SourceKind,
    SourceRegistryEntrySnapshot, SourceRegistrySnapshot,
};

#[derive(Debug, Clone)]
struct SourceRegistryEntry {
    key: SourceKey,
    status: SourceLifecycleStatus,
    consumers: BTreeSet<SourceConsumerReason>,
    identity_confidence: SourceIdentityConfidence,
}

#[allow(dead_code)]
impl SourceRegistryEntry {
    fn new(key: SourceKey) -> Self {
        Self {
            key,
            status: SourceLifecycleStatus::Stopped,
            consumers: BTreeSet::new(),
            identity_confidence: SourceIdentityConfidence::Exact,
        }
    }

    fn snapshot(&self) -> SourceRegistryEntrySnapshot {
        SourceRegistryEntrySnapshot {
            key: self.key.clone(),
            status: self.status.clone(),
            consumers: self.consumers.iter().cloned().collect(),
            identity_confidence: self.identity_confidence.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SourceRegistry {
    entries: BTreeMap<SourceKey, SourceRegistryEntry>,
}

#[allow(dead_code)]
impl SourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(
        &mut self,
        key: SourceKey,
        consumer: SourceConsumerReason,
    ) -> SourceRegistrySnapshot {
        let entry = self
            .entries
            .entry(key.clone())
            .or_insert_with(|| SourceRegistryEntry::new(key));
        entry.consumers.insert(consumer);
        self.snapshot()
    }

    pub fn release(
        &mut self,
        key: &SourceKey,
        consumer: &SourceConsumerReason,
    ) -> SourceRegistrySnapshot {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.consumers.remove(consumer);
            if entry.consumers.is_empty() {
                entry.status = SourceLifecycleStatus::Stopped;
            }
        }
        self.snapshot()
    }

    pub fn set_status(
        &mut self,
        key: SourceKey,
        status: SourceLifecycleStatus,
    ) -> SourceRegistrySnapshot {
        let entry = self
            .entries
            .entry(key.clone())
            .or_insert_with(|| SourceRegistryEntry::new(key));
        entry.status = status;
        self.snapshot()
    }

    pub fn set_identity_confidence(
        &mut self,
        key: SourceKey,
        confidence: SourceIdentityConfidence,
    ) -> SourceRegistrySnapshot {
        let entry = self
            .entries
            .entry(key.clone())
            .or_insert_with(|| SourceRegistryEntry::new(key));
        entry.identity_confidence = confidence;
        self.snapshot()
    }

    pub fn snapshot(&self) -> SourceRegistrySnapshot {
        SourceRegistrySnapshot {
            entries: self
                .entries
                .values()
                .map(SourceRegistryEntry::snapshot)
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_source_key_can_have_multiple_consumers_without_duplicates() {
        let mut registry = SourceRegistry::new();
        let key = SourceKey::camera("camera:avfoundation:0");

        registry.acquire(key.clone(), SourceConsumerReason::Preview);
        registry.acquire(key.clone(), SourceConsumerReason::Recording);
        let snapshot = registry.acquire(key.clone(), SourceConsumerReason::Preview);

        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(
            snapshot.entries[0].consumers,
            vec![
                SourceConsumerReason::Preview,
                SourceConsumerReason::Recording
            ]
        );
    }

    #[test]
    fn release_only_removes_the_named_consumer() {
        let mut registry = SourceRegistry::new();
        let key = SourceKey::screen("screen:avfoundation:3");

        registry.acquire(key.clone(), SourceConsumerReason::Preview);
        registry.acquire(key.clone(), SourceConsumerReason::Recording);
        registry.set_status(key.clone(), SourceLifecycleStatus::Live);
        let snapshot = registry.release(&key, &SourceConsumerReason::Preview);

        assert_eq!(
            snapshot.entries[0].consumers,
            vec![SourceConsumerReason::Recording]
        );
        assert_eq!(snapshot.entries[0].status, SourceLifecycleStatus::Live);

        let snapshot = registry.release(&key, &SourceConsumerReason::Recording);
        assert!(snapshot.entries[0].consumers.is_empty());
        assert_eq!(snapshot.entries[0].status, SourceLifecycleStatus::Stopped);
    }

    #[test]
    fn source_status_is_reported_in_snapshot() {
        let mut registry = SourceRegistry::new();
        let key = SourceKey::synthetic("synthetic:preview");

        let snapshot = registry.set_status(key, SourceLifecycleStatus::Live);

        assert_eq!(snapshot.entries[0].status, SourceLifecycleStatus::Live);
    }

    #[test]
    fn source_identity_confidence_defaults_to_exact_and_can_be_updated() {
        let mut registry = SourceRegistry::new();
        let key = SourceKey::screen("screen:screencapturekit:1");

        let snapshot = registry.acquire(key.clone(), SourceConsumerReason::Preview);

        assert_eq!(
            snapshot.entries[0].identity_confidence,
            SourceIdentityConfidence::Exact
        );

        let snapshot = registry.set_identity_confidence(key, SourceIdentityConfidence::Fallback);

        assert_eq!(
            snapshot.entries[0].identity_confidence,
            SourceIdentityConfidence::Fallback
        );
    }

    #[test]
    fn different_source_keys_remain_distinct() {
        let mut registry = SourceRegistry::new();

        registry.acquire(SourceKey::camera("camera:1"), SourceConsumerReason::Preview);
        registry.acquire(SourceKey::screen("screen:1"), SourceConsumerReason::Preview);
        registry.acquire(SourceKey::window("window:1"), SourceConsumerReason::Preview);
        registry.acquire(SourceKey::image("image:1"), SourceConsumerReason::Preview);

        let snapshot = registry.snapshot();
        assert_eq!(snapshot.entries.len(), 4);
        assert_eq!(snapshot.entries[0].key, SourceKey::camera("camera:1"));
        assert_eq!(snapshot.entries[1].key, SourceKey::screen("screen:1"));
        assert_eq!(snapshot.entries[2].key, SourceKey::window("window:1"));
        assert_eq!(snapshot.entries[3].key, SourceKey::image("image:1"));
    }
}
