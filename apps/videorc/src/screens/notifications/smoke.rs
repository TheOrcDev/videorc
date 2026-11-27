//! Read-only notification evidence for the typed GPUI smoke driver.
use super::*;
use serde_json::{Value, json};

impl Centre {
    pub(crate) fn smoke_snapshot(&self, cx: &gpui::App) -> Value {
        let hub = self.hub.read(cx);
        let toasts: Vec<_> = self
            .smoke_toasts
            .iter()
            .filter(|(id, _)| self.toaster.read(cx).contains(&(*id).clone().into()))
            .map(|(id, text)| json!({ "id": id, "text": text }))
            .collect();
        snapshot(&hub.store, toasts)
    }

    pub(super) fn show_toast(
        &mut self,
        id: String,
        data: ToastData,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Track only when a smoke server was requested. Expired and dismissed
        // ids are removed; a read never marks notifications as read or opens UI.
        if std::env::var("VIDEORC_SMOKE_COMMAND_SERVER").as_deref() == Ok("1") {
            let toaster = self.toaster.read(cx);
            self.smoke_toasts
                .retain(|key, _| toaster.contains(&key.clone().into()));
            let words = match &data.description {
                Some(description) => format!("{}: {description}", data.title),
                None => data.title.to_string(),
            };
            self.smoke_toasts.insert(id.clone(), words);
        }
        self.toaster
            .update(cx, |toaster, cx| toaster.show(id, data, window, cx));
    }
}

fn snapshot(store: &Store, toasts: Vec<Value>) -> Value {
    let count = store.count();
    json!({
        "hook": true,
        "bellCount": count.unread,
        "bellTone": count.tone,
        "count": { "unread": count.unread, "tone": count.tone, "urgent": count.urgent },
        "entries": store.snapshot(),
        "toasts": toasts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_app_core::notices::sources::platforms::{Words, youtube_budget};

    #[test]
    fn reading_notifications_preserves_unread_and_repeat_evidence() {
        let mut store = Store::new(0, 0);
        let mut input = youtube_budget(
            "chat",
            Words {
                title: "YouTube paused",
                description: None,
            },
        );
        input.once = false;
        store.publish(input.clone(), 1_000);
        store.publish(input, 2_000);
        let first = snapshot(
            &store,
            vec![json!({ "id": "connect", "text": "Connecting YouTube" })],
        );
        let next = snapshot(&store, vec![]);
        assert_eq!(first["hook"], true);
        assert_eq!(first["entries"], next["entries"]);
        assert_eq!(first["bellCount"], next["bellCount"]);
        assert_eq!(first["entries"][0]["read"], false);
        assert_eq!(first["entries"][0]["occurrences"], 2);
        assert_eq!(first["toasts"][0]["text"], "Connecting YouTube");
        assert!(next["toasts"].as_array().unwrap().is_empty());
    }
}
