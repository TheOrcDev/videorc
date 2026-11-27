//! Typed, window-local Comments fixtures; never changes the backend chat.
use crate::chat::{LiveChat, LiveChatSnapshotWire};
use serde_json::{Map, Value, json};

#[derive(Debug, Clone)]
pub struct SnapshotFixture {
    pub snapshot: LiveChatSnapshotWire,
    pub mode: Value,
    pub unread: usize,
    pub history: bool,
}

impl SnapshotFixture {
    pub fn parse(params: &Map<String, Value>) -> Result<Self, String> {
        let invalid = || "Invalid Comments fixture snapshot.".to_string();
        if params
            .keys()
            .any(|key| !matches!(key.as_str(), "snapshot" | "mode"))
        {
            return Err("GPUI Comments snapshot supports snapshot and mode; send receipts need the command relay.".into());
        }
        let raw = params
            .get("snapshot")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if raw.keys().any(|key| {
            !matches!(
                key.as_str(),
                "sessionId" | "providers" | "messages" | "unreadCount" | "updatedAt"
            )
        }) {
            return Err(
                "GPUI Comments fixture does not accept publisher delivery metadata.".into(),
            );
        }
        let messages = raw
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if messages.len() > 2000
            || !messages.iter().all(Value::is_object)
            || !raw
                .get("providers")
                .and_then(Value::as_array)
                .is_some_and(|v| v.iter().all(Value::is_object))
            || !raw
                .get("updatedAt")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.trim().is_empty())
        {
            return Err(invalid());
        }
        let unread = raw
            .get("unreadCount")
            .and_then(Value::as_u64)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(invalid)?;
        let unread = usize::try_from(unread).map_err(|_| invalid())?;
        if raw.get("sessionId").is_some_and(|id| !id.is_string()) {
            return Err(invalid());
        }
        let mut snapshot: LiveChatSnapshotWire =
            serde_json::from_value(Value::Object(raw.clone())).map_err(|_| invalid())?;
        let mode = params
            .get("mode")
            .cloned()
            .unwrap_or_else(|| json!({"kind":"live"}));
        let object = mode.as_object().ok_or_else(invalid)?;
        let history = match object.get("kind").and_then(Value::as_str) {
            Some("live") if object.len() == 1 => false,
            Some("history") => {
                if object
                    .keys()
                    .any(|k| !matches!(k.as_str(), "kind" | "sessionId" | "title" | "startedAt"))
                {
                    return Err(invalid());
                }
                if !object.get("title").is_some_and(Value::is_string)
                    || !object
                        .get("startedAt")
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.trim().is_empty())
                {
                    return Err(invalid());
                }
                let id = object
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(invalid)?;
                if snapshot
                    .session_id
                    .as_deref()
                    .is_some_and(|existing| existing != id)
                {
                    return Err(invalid());
                }
                snapshot.session_id = Some(id.to_string());
                true
            }
            _ => return Err(invalid()),
        };
        Ok(Self {
            snapshot,
            mode,
            unread,
            history,
        })
    }

    pub fn chat(&self) -> LiveChat {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(self.snapshot.clone(), true);
        chat
    }

    pub fn answer(&self) -> Value {
        let mut snapshot = serde_json::to_value(&self.snapshot).expect("chat snapshot serializes");
        snapshot["unreadCount"] = json!(self.unread);
        json!({ "mode": self.mode, "snapshot": snapshot })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Map<String, Value> {
        json!({"mode":{"kind":"live"}, "snapshot":{
            "sessionId":"isolated", "messages":[{"id":"one", "messageText":"fixture row"}],
            "providers":[], "unreadCount":1, "updatedAt":"2026-11-27T00:00:00Z"
        }})
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn uses_the_real_chat_store_and_preserves_live_or_history_mode() {
        let input = fixture();
        let live = SnapshotFixture::parse(&input).unwrap();
        assert!(!live.history);
        assert_eq!(live.chat().messages[0].message_text, "fixture row");
        assert_eq!(live.chat().session_id.as_deref(), Some("isolated"));
        assert_eq!(live.answer()["snapshot"]["unreadCount"], 1);
        let mut history = input.clone();
        history.insert(
            "mode".into(),
            json!({"kind":"history", "sessionId":"isolated", "title":"Past show", "startedAt":"2026-11-27T00:00:00Z"}),
        );
        assert!(SnapshotFixture::parse(&history).unwrap().history);
        history["mode"]["sessionId"] = json!("another");
        assert!(SnapshotFixture::parse(&history).is_err());
        assert_eq!(input, fixture(), "reads do not mutate a publisher snapshot");
    }

    #[test]
    fn rejects_malformed_or_unimplemented_fixture_fields() {
        for patch in [
            json!({"unreadCount":-1}),
            json!({"messages":{}}),
            json!({"providers":[42]}),
            json!({"updatedAt":""}),
            json!({"delivery":{}}),
        ] {
            let mut input = fixture();
            input["snapshot"]
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(SnapshotFixture::parse(&input).is_err(), "{patch}");
        }
        let mut input = fixture();
        input["snapshot"]["messages"] = json!(vec![json!({"id":"many"}); 2001]);
        assert!(SnapshotFixture::parse(&input).is_err());
    }
}
