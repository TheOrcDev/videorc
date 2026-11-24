use super::*;
use gpui::AnyElement;
use videorc_app_core::settings_page::about::{self as a, copy as c};
use videorc_kit::{
    button::{Button, ButtonVariant},
    dialog::Dialog,
    skeleton::Skeleton,
};

pub(super) struct Changelog {
    pub loading: bool,
    dialog: DialogHandle,
    entry: Option<a::ChangelogEntry>,
}
impl Default for Changelog {
    fn default() -> Self {
        Self {
            loading: false,
            dialog: DialogHandle::new(false),
            entry: None,
        }
    }
}
impl SettingsScreen {
    pub(super) fn open_changelog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.changelog.loading {
            return;
        }
        self.changelog.loading = true;
        self.changelog.entry = None;
        self.changelog.dialog.open(window, cx);
        let job = self.runtime.spawn(fetch_latest());
        cx.spawn(async move |entity, cx| {
            let entry = job.await.ok().and_then(Result::ok);
            let _ = entity.update(cx, |this, cx| {
                this.changelog.loading = false;
                this.changelog.entry = entry;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn changelog_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut dialog = Dialog::new(
            "whats-new-dialog",
            &self.changelog.dialog,
            self.changelog
                .entry
                .as_ref()
                .map(|e| c::whats_new_title(&e.version))
                .unwrap_or_else(|| c::WHATS_NEW_BUTTON.into()),
        );
        if self.changelog.loading {
            dialog = dialog.child(Skeleton::new("notes-loading").h(px(80.)));
        } else if let Some(entry) = &self.changelog.entry {
            dialog = dialog.description(entry.summary.clone());
            for line in &entry.highlights {
                dialog = dialog.child(line.clone());
            }
        } else {
            dialog = dialog.description(c::NOTES_UNAVAILABLE);
        }
        let (label, url) = self
            .changelog
            .entry
            .as_ref()
            .map(|entry| {
                (
                    c::FULL_RELEASE_NOTES,
                    a::release_notes_url("https://videorc.com", &entry.version),
                )
            })
            .unwrap_or_else(|| {
                (
                    c::OPEN_CHANGELOG,
                    a::web_link("https://videorc.com", "changelog"),
                )
            });
        // Continue is first in the focus order, as Electron's initialFocus.
        dialog
            .footer(Button::new("notes-continue").label(c::CONTINUE).on_click(
                cx.listener(|this, _, window, cx| this.changelog.dialog.close(window, cx)),
            ))
            .footer(
                Button::new("full-release-notes")
                    .label(label)
                    .variant(ButtonVariant::Ghost)
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            )
            .into_any_element()
    }
}

async fn fetch_latest() -> Result<a::ChangelogEntry, ()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 3
                && attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some("videorc.com" | "www.videorc.com")
                )
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| ())?;
    let mut response = client
        .get("https://videorc.com/api/changelog")
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let platform = a::changelog_platform(crate::app::hotkeys::node_platform()).ok_or(())?;
    // Manual What's new shows only the latest platform release. Older notes
    // are not described as updates included in this development build.
    a::entries_for_platform(a::parse_changelog_entries(&raw), platform)
        .into_iter()
        .next()
        .ok_or(())
}
