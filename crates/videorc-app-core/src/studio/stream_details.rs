//! S3.5b: Stream details and Discord as the Studio runs them (use-studio's
//! metadata drafts ~3993–4030, `patchStreamMetadataDraft`,
//! `patchStreamTargetMetadataDraft`, `saveStreamMetadataDraft`,
//! `searchTwitchCategories`, `searchKickCategories`; `useDiscordAnnounce`).
//!
//! Both live apart from the snapshot (`DetailsState` on its own watch): a
//! keystroke in the title redraws the page, never the Studio.

use serde_json::{Value, json};

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::details::{MetadataDraft, TargetDraft, Validation};
use crate::livestream::discord::{self, Preview, Snapshot};
use crate::livestream::ready::Topology;
use crate::livestream::{DetailsState, copy, methods};
use crate::notices::{NoticeAction, NoticeCommand, ToastRequest};
use crate::user_error::UserErrorContext;

/// `streamTargets.metadata.changed`.
pub const METADATA_CHANGED_EVENT: &str = "streamTargets.metadata.changed";

/// The Discord failure's one entry (`publishDiscordFailure`'s key).
pub const DISCORD_FAILURE_ID: &str = "discord-announce";

impl<B: StudioBackend> Studio<B> {
    /// S3.5b: Stream details and Discord, as they change.
    pub fn details(&self) -> tokio::sync::watch::Receiver<DetailsState> {
        self.details_tx.subscribe()
    }

    pub fn details_now(&self) -> DetailsState {
        self.details_tx.borrow().clone()
    }

    fn edit_details(&self, edit: impl FnOnce(&mut DetailsState)) {
        self.details_tx.send_if_modified(|state| {
            let before = state.clone();
            edit(state);
            *state != before
        });
    }

    async fn validate_draft(&self, draft: &MetadataDraft) -> Option<Validation> {
        let value = serde_json::to_value(draft).ok()?;
        let answer = self
            .backend
            .livestream_request(methods::METADATA_VALIDATE, value)
            .await
            .ok()?;
        serde_json::from_value(answer).ok()
    }

    /// The bootstrap's `streamTargets.metadata.get` and its validation, and
    /// the Discord settings.
    pub(super) async fn read_details(&self) {
        // A new connection checks the output path again.
        self.edit_details(|state| state.topology = Topology::NotRequested);
        if let Ok(value) = self
            .backend
            .livestream_request(methods::METADATA_GET, Value::Null)
            .await
            && let Ok(draft) = serde_json::from_value::<MetadataDraft>(value)
        {
            let validation = self.validate_draft(&draft).await;
            self.edit_details(|state| {
                state.draft = Some(draft);
                state.validation = validation;
            });
        }
        self.read_discord().await;
    }

    /// `streamTargets.metadata.changed` (the draft, then its validation) and
    /// `discord.announce.changed`. True when the event was theirs.
    pub(super) async fn handle_details_event(&self, event: &str, payload: &Value) -> bool {
        if event == METADATA_CHANGED_EVENT {
            if let Ok(draft) = serde_json::from_value::<MetadataDraft>(payload.clone()) {
                self.edit_details(|state| state.draft = Some(draft.clone()));
                let validation = self.validate_draft(&draft).await;
                self.edit_details(|state| state.validation = validation);
            }
            return true;
        }
        if event == discord::CHANGED_EVENT {
            if let Ok(snapshot) = serde_json::from_value::<Snapshot>(payload.clone()) {
                self.toast_discord_failure(&snapshot);
                self.edit_details(|state| state.discord = Some(snapshot));
                self.refresh_discord_preview().await;
            }
            return true;
        }
        false
    }

    /// `showDiscordAnnounceFailure`: a go-live post that failed, one notice
    /// per failure wherever the streamer is, with the way to fix it
    /// (`publishDiscordFailure`; a toast until the notification centre lands
    /// with S1.6e).
    fn toast_discord_failure(&self, snapshot: &Snapshot) {
        let last = self.details_now().discord_toasted_at;
        let now = chrono::Utc::now().timestamp_millis();
        let Some(failure) = discord::failure_toast(last.as_deref(), snapshot, now) else {
            return;
        };
        self.edit_details(|state| state.discord_toasted_at = Some(failure.at.clone()));
        let toast = if failure.error {
            ToastRequest::error(failure.title)
        } else {
            ToastRequest::warning(failure.title)
        };
        self.post(vec![NoticeCommand::Show(
            toast
                .id(DISCORD_FAILURE_ID)
                .description(failure.description)
                .action(
                    copy::OPEN_DISCORD_SETTINGS,
                    NoticeAction::OpenPage(crate::nav::PageId::Live),
                )
                .finish(),
        )]);
    }

    /// S3.5c: Go Live's draft, saved and validated without a toast
    /// (`runGoLivePreflight`).
    pub(super) async fn save_draft_for_go_live(&self) -> Result<(), RpcError> {
        let Some(draft) = self.details_now().draft else {
            return Ok(());
        };
        let value = serde_json::to_value(&draft).unwrap_or(Value::Null);
        let saved = super::backend::read_json::<MetadataDraft>(
            methods::METADATA_UPDATE,
            self.backend
                .livestream_request(methods::METADATA_UPDATE, value)
                .await?,
        )?;
        let validation = self.validate_draft(&saved).await;
        self.edit_details(|state| {
            state.draft = Some(saved);
            state.validation = validation;
        });
        Ok(())
    }

    /// `patchStreamMetadataDraft`: the edit is local until Save; the last
    /// validation goes.
    pub fn patch_metadata_draft(&self, edit: impl FnOnce(&mut MetadataDraft)) {
        self.edit_details(|state| {
            if let Some(draft) = state.draft.as_mut() {
                edit(draft);
                state.validation = None;
            }
        });
    }

    /// `patchStreamTargetMetadataDraft`.
    pub fn patch_target_metadata_draft(&self, platform: &str, edit: impl FnOnce(&mut TargetDraft)) {
        let platform = platform.to_string();
        self.patch_metadata_draft(|draft| {
            if let Some(target) = draft
                .target_overrides
                .iter_mut()
                .find(|t| t.platform == platform)
            {
                edit(target);
            }
        });
    }

    /// `saveStreamMetadataDraft`: validate, then save; only what still needs
    /// work toasts (the form is the confirmation).
    pub async fn save_metadata_draft(&self) {
        let ctx = UserErrorContext {
            action: "save",
            object: "the stream details",
        };
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return;
        }
        let Some(draft) = self.details_now().draft else {
            self.post(vec![NoticeCommand::Show(
                ToastRequest::warning(crate::user_error::DETAILS_STILL_LOADING)
                    .description(crate::user_error::OFFLINE_NEXT_STEP)
                    .finish(),
            )]);
            return;
        };
        self.edit_details(|state| state.save_pending = true);
        let result: Result<(Validation, MetadataDraft), RpcError> = async {
            let value = serde_json::to_value(&draft).unwrap_or(Value::Null);
            let validation = super::backend::read_json::<Validation>(
                methods::METADATA_VALIDATE,
                self.backend
                    .livestream_request(methods::METADATA_VALIDATE, value.clone())
                    .await?,
            )?;
            self.edit_details(|state| state.validation = Some(validation.clone()));
            let saved = super::backend::read_json::<MetadataDraft>(
                methods::METADATA_UPDATE,
                self.backend
                    .livestream_request(methods::METADATA_UPDATE, value)
                    .await?,
            )?;
            Ok((validation, saved))
        }
        .await;
        self.edit_details(|state| state.save_pending = false);
        match result {
            Ok((validation, saved)) => {
                self.edit_details(|state| state.draft = Some(saved));
                if !validation.valid {
                    let count = validation.issues.len();
                    self.post(vec![NoticeCommand::Show(
                        ToastRequest::warning(crate::user_error::saved_needs_attention(count))
                            .id("stream-details-saved")
                            .finish(),
                    )]);
                }
            }
            Err(error) => self.report_error(&error, ctx),
        }
    }

    /// `searchTwitchCategories` / `searchKickCategories`.
    pub async fn search_categories(&self, platform: &str, query: &str) {
        let trimmed = query.trim().to_string();
        let kick = platform == "kick";
        if trimmed.chars().count() < 2 {
            self.edit_details(|state| {
                state.category_results.clear();
                state.category_searched = None;
            });
            return;
        }
        let account = self
            .platforms_now()
            .account(platform)
            .map(|a| a.account_id.clone());
        self.edit_details(|state| state.category_pending = true);
        let (method, params) = if kick {
            (
                methods::KICK_SEARCH_CATEGORIES,
                json!({ "accountId": account, "query": trimmed, "limit": 10 }),
            )
        } else {
            (
                methods::TWITCH_SEARCH_CATEGORIES,
                json!({ "accountId": account, "query": trimmed, "first": 10 }),
            )
        };
        let answer = self.backend.livestream_request(method, params).await;
        let results: Vec<(String, String)> = answer
            .as_ref()
            .ok()
            .and_then(|v| v.get("categories"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|c| {
                        let id = match c.get("id")? {
                            Value::String(id) => id.clone(),
                            Value::Number(id) => id.to_string(),
                            _ => return None,
                        };
                        Some((id, c.get("name")?.as_str()?.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.edit_details(|state| {
            state.category_results = results;
            state.category_pending = false;
            state.category_searched = Some(trimmed.clone());
        });
        if let Err(error) = answer {
            let object = if kick {
                "Kick categories"
            } else {
                "Twitch categories"
            };
            self.report_error(
                &error,
                UserErrorContext {
                    action: "search",
                    object,
                },
            );
        }
    }

    // --- Discord -------------------------------------------------------

    async fn read_discord(&self) {
        match self
            .backend
            .livestream_request(discord::methods::GET, Value::Null)
            .await
            .and_then(|v| super::backend::read_json::<Snapshot>(discord::methods::GET, v))
        {
            Ok(snapshot) => {
                self.edit_details(|state| {
                    state.discord = Some(snapshot);
                    state.discord_error = None;
                });
                self.refresh_discord_preview().await;
            }
            Err(_) => self.edit_details(|state| {
                state.discord_error = Some(copy::DISCORD_UNREADABLE.to_string());
            }),
        }
    }

    /// `discord.links.preview` for the destinations as they are now.
    pub async fn refresh_discord_preview(&self) {
        let capture = self.snapshot().settings.capture_doc;
        let targets = crate::livestream::targets::targets(&capture);
        let params = json!({ "targets": discord::link_targets(&targets, &capture) });
        if let Ok(value) = self
            .backend
            .livestream_request(discord::methods::LINKS_PREVIEW, params)
            .await
            && let Ok(preview) = serde_json::from_value::<Preview>(value)
        {
            self.edit_details(|state| state.discord_preview = Some(preview));
        }
    }

    /// The refusal's words (`discordRefusal`): the backend's own for a
    /// Discord refusal, else the user-error sentence.
    fn discord_refusal(
        &self,
        error: &RpcError,
        action: &'static str,
        object: &'static str,
    ) -> String {
        if error.code.starts_with("discord-") {
            return error.message.clone();
        }
        let copy = crate::user_error::user_error_message(
            crate::user_error::Failure::Rpc(error),
            Some(UserErrorContext { action, object }),
        );
        format!("{} {}", copy.title, copy.description)
    }

    /// `update(patch)`: `None` when saved, else the refusal (also shown
    /// under the section).
    pub async fn discord_update(&self, patch: Value) -> Option<String> {
        match self
            .backend
            .livestream_request(discord::methods::UPDATE, patch)
            .await
            .and_then(|v| super::backend::read_json::<Snapshot>(discord::methods::UPDATE, v))
        {
            Ok(snapshot) => {
                self.edit_details(|state| {
                    state.discord = Some(snapshot);
                    state.discord_error = None;
                });
                self.refresh_discord_preview().await;
                None
            }
            Err(error) => {
                let message = self.discord_refusal(&error, "save", "the Discord settings");
                self.edit_details(|state| state.discord_error = Some(message.clone()));
                Some(message)
            }
        }
    }

    /// `saveWebhook(url)`: `None` when saved (the URL is never kept).
    pub async fn discord_save_webhook(&self, url: &str) -> Option<String> {
        match self
            .backend
            .livestream_request(discord::methods::WEBHOOK_SAVE, json!({ "url": url }))
            .await
            .and_then(|v| super::backend::read_json::<Snapshot>(discord::methods::WEBHOOK_SAVE, v))
        {
            Ok(snapshot) => {
                self.edit_details(|state| state.discord = Some(snapshot));
                self.refresh_discord_preview().await;
                None
            }
            Err(error) => Some(self.discord_refusal(&error, "connect", "the webhook")),
        }
    }

    pub async fn discord_remove_webhook(&self, webhook_id: &str) {
        match self
            .backend
            .livestream_request(
                discord::methods::WEBHOOK_REMOVE,
                json!({ "webhookId": webhook_id }),
            )
            .await
            .and_then(|v| {
                super::backend::read_json::<Snapshot>(discord::methods::WEBHOOK_REMOVE, v)
            }) {
            Ok(snapshot) => self.edit_details(|state| state.discord = Some(snapshot)),
            Err(error) => {
                let message = self.discord_refusal(&error, "remove", "the webhook");
                self.edit_details(|state| state.discord_error = Some(message));
            }
        }
    }

    /// `sendTest(webhookId)`: `Ok(messageUrl)` or the refusal.
    pub async fn discord_send_test(&self, webhook_id: &str) -> Result<Option<String>, String> {
        let capture = self.snapshot().settings.capture_doc;
        let targets = crate::livestream::targets::targets(&capture);
        let params = json!({
            "targets": discord::link_targets(&targets, &capture),
            "webhookId": webhook_id,
        });
        match self
            .backend
            .livestream_request(discord::methods::WEBHOOK_SEND_TEST, params)
            .await
        {
            Ok(result) => Ok(result
                .get("messageUrl")
                .and_then(Value::as_str)
                .map(str::to_string)),
            Err(error) => Err(self.discord_refusal(&error, "send", "the test message")),
        }
    }

    // --- The output check ---------------------------------------------

    /// Nothing to check (no ready destination, no FFmpeg, no backend): the
    /// check forgets its answer.
    pub fn reset_stream_output_check(&self) {
        self.edit_details(|state| state.topology = Topology::NotRequested);
    }

    /// `probeStreamOutputTopology`: asks the backend once per request (a
    /// settled answer for the same request stands unless `force`, and a
    /// check already running for it is joined); the last request wins.
    /// Answers this request's settled check (`Ready` or `Failed`), or
    /// `None` when it couldn't settle: offline, superseded by another
    /// request, or reset. Go Live reads `None` as a check that didn't pass.
    pub async fn check_stream_output(&self, params: Value, force: bool) -> Option<Topology> {
        let key = crate::livestream::ready::probe_key(&params);
        let current = self.details_now().topology;
        let in_flight = matches!(&current, Topology::Pending { key: pending } if *pending == key);
        if !force && in_flight {
            return self.join_output_check(&key).await;
        }
        if !force && current.key() == Some(key.as_str()) {
            return Some(current);
        }
        if !self.is_connected() {
            return None;
        }
        self.edit_details(|state| {
            state.topology = Topology::Pending { key: key.clone() };
        });
        let mut running = RunningCheck {
            studio: self,
            key: key.clone(),
            settled: false,
        };
        let answer = self
            .backend
            .livestream_request(methods::TOPOLOGY_PROBE, params)
            .await;
        running.settled = true;
        self.edit_details(|state| {
            if state.topology.key() != Some(key.as_str()) {
                return;
            }
            state.topology = match answer {
                Ok(result) => Topology::Ready {
                    key: key.clone(),
                    result,
                },
                Err(error) => Topology::Failed {
                    key: key.clone(),
                    message: error.message,
                },
            };
        });
        settled_check(&self.details_now().topology, &key)
    }

    /// The check running for `key`, waited for.
    async fn join_output_check(&self, key: &str) -> Option<Topology> {
        let mut details = self.details();
        let state = details
            .wait_for(|state| {
                !matches!(&state.topology, Topology::Pending { key: pending } if pending == key)
            })
            .await
            .ok()?
            .clone();
        settled_check(&state.topology, key)
    }
}

/// `topology` when it is `key`'s settled check.
fn settled_check(topology: &Topology, key: &str) -> Option<Topology> {
    match topology {
        Topology::Ready { key: settled, .. } | Topology::Failed { key: settled, .. }
            if settled == key =>
        {
            Some(topology.clone())
        }
        _ => None,
    }
}

/// A check in flight; dropped before its answer (its caller went away), it
/// takes its `Pending` back, so whoever joined it stops waiting.
struct RunningCheck<'a, B: StudioBackend> {
    studio: &'a Studio<B>,
    key: String,
    settled: bool,
}

impl<B: StudioBackend> Drop for RunningCheck<'_, B> {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let key = &self.key;
        self.studio.edit_details(|state| {
            if matches!(&state.topology, Topology::Pending { key: pending } if pending == key) {
                state.topology = Topology::NotRequested;
            }
        });
    }
}
