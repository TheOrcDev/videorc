//! Prepare (plan 209 S14, Electron's `lib/studio-actions/prepare.ts`):
//! `update_stream_info` and `set_destinations`, through the Studio's own
//! validation, save, and entitlement-gate paths.

use serde_json::{Value, json};

use super::agent::AgentIntentOutcome;
use super::{Studio, StudioBackend};
use crate::account::entitlements::streaming_destination_enable_gate;
use crate::livestream::accounts::{destination_label, metadata_platform_label};
use crate::livestream::details::{MetadataDraft, Privacy, TargetDraft, Validation};
use crate::livestream::lifecycle::start_ready;
use crate::livestream::methods;
use crate::livestream::targets::{TargetPatch, targets as stream_targets};

pub mod copy {
    pub const LOCKED: &str = "Destinations, stream quality and stream details are locked while you're recording or live.";
    pub const UNAVAILABLE: &str = "Stream details aren't available in this Studio.";
    pub const LOADING: &str = "Stream details are still loading. Try again in a moment.";
    pub const INFO_EMPTY: &str =
        "Say what to change: title, description, privacy, category or destinations.";
    pub const CATEGORY_PLATFORMS: &str = "Only Twitch and Kick take a category.";
    pub const DESTINATIONS_EMPTY: &str = "Say which destinations to turn on or off: destinations.";
}

fn parse_privacy(value: Option<&Value>) -> Option<Privacy> {
    match value?.as_str()? {
        "public" => Some(Privacy::Public),
        "unlisted" => Some(Privacy::Unlisted),
        "private" => Some(Privacy::Private),
        _ => None,
    }
}

fn privacy_wire(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Public => "public",
        Privacy::Unlisted => "unlisted",
        Privacy::Private => "private",
    }
}

fn category_of(override_entry: &TargetDraft) -> Option<&str> {
    let name = if override_entry.platform == "kick" {
        override_entry.kick_category_name.as_deref()
    } else {
        override_entry.twitch_category_name.as_deref()
    };
    name.map(str::trim).filter(|s| !s.is_empty())
}

pub fn draft_projection(draft: &MetadataDraft) -> Value {
    let destinations: Vec<Value> = draft
        .target_overrides
        .iter()
        .map(|entry| {
            let mut obj = json!({
                "platform": entry.platform,
                "title": if entry.customize { &entry.title } else { &draft.title },
                "privacy": privacy_wire(if entry.customize { entry.privacy } else { draft.default_privacy }),
                "ownTitle": entry.customize,
            });
            if let Some(category) = category_of(entry) {
                obj["category"] = json!(category);
            }
            obj
        })
        .collect();
    json!({
        "title": draft.title,
        "description": draft.description,
        "privacy": privacy_wire(draft.default_privacy),
        "destinations": destinations,
    })
}

fn with_category(mut entry: TargetDraft, id: &Value, name: String) -> TargetDraft {
    if entry.platform == "kick" {
        entry.kick_category_id = id
            .as_u64()
            .or_else(|| id.as_str().and_then(|s| s.parse::<u64>().ok()));
        entry.kick_category_name = Some(name);
    } else {
        entry.twitch_category_id = Some(
            id.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string()),
        );
        entry.twitch_category_name = Some(name);
    }
    entry
}

impl<B: StudioBackend> Studio<B> {
    async fn resolve_category(
        &self,
        platform: &str,
        query: &str,
    ) -> Result<(Value, String), String> {
        let wanted = query.trim();
        let method = if platform == "kick" {
            methods::KICK_SEARCH_CATEGORIES
        } else {
            methods::TWITCH_SEARCH_CATEGORIES
        };
        let answer = self
            .backend
            .livestream_request(method, json!({ "query": wanted }))
            .await
            .map_err(|error| error.message)?;
        let list = answer
            .get("categories")
            .and_then(Value::as_array)
            .or_else(|| answer.as_array())
            .cloned()
            .unwrap_or_default();
        let wanted_lower = wanted.to_lowercase();
        let exact = list.iter().find(|entry| {
            entry
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.to_lowercase() == wanted_lower)
        });
        let chosen = exact.or_else(|| list.first());
        let Some(chosen) = chosen else {
            return Err(format!(
                "{} has no category called \"{wanted}\".",
                metadata_platform_label(platform)
            ));
        };
        let id = chosen.get("id").cloned().unwrap_or(Value::Null);
        let name = chosen
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(wanted)
            .to_string();
        Ok((id, name))
    }

    pub(super) async fn agent_update_stream_info(&self, args: &Value) -> AgentIntentOutcome {
        if !self.is_connected() {
            return AgentIntentOutcome::refused(copy::UNAVAILABLE);
        }
        if self.session_owns_transport() || self.go_live_now().pending {
            return AgentIntentOutcome::refused(copy::LOCKED);
        }
        let Some(draft) = self.details_now().draft else {
            return AgentIntentOutcome::refused(copy::LOADING);
        };

        let title = args.get("title").and_then(Value::as_str);
        let description = args.get("description").and_then(Value::as_str);
        let privacy = parse_privacy(args.get("privacy"));
        let category = args
            .get("category")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let destinations = args
            .get("destinations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if title.is_none()
            && description.is_none()
            && privacy.is_none()
            && category.is_none()
            && destinations.is_empty()
        {
            return AgentIntentOutcome::refused(copy::INFO_EMPTY);
        }

        let mut next = draft;
        if let Some(title) = title {
            next.title = title.to_string();
        }
        if let Some(description) = description {
            next.description = description.to_string();
        }
        if let Some(privacy) = privacy {
            next.default_privacy = privacy;
        }

        if let Some(category) = category {
            let platforms: Vec<String> = next
                .target_overrides
                .iter()
                .filter(|o| o.platform == "twitch" || o.platform == "kick")
                .map(|o| o.platform.clone())
                .collect();
            if platforms.is_empty() {
                return AgentIntentOutcome::refused(copy::CATEGORY_PLATFORMS);
            }
            for platform in platforms {
                let (id, name) = match self.resolve_category(&platform, category).await {
                    Ok(found) => found,
                    Err(message) => return AgentIntentOutcome::refused(message),
                };
                if let Some(entry) = next
                    .target_overrides
                    .iter_mut()
                    .find(|o| o.platform == platform)
                {
                    *entry = with_category(entry.clone(), &id, name);
                }
            }
        }

        for raw in destinations {
            let Some(obj) = raw.as_object() else {
                return AgentIntentOutcome::refused("Each destination needs its platform.");
            };
            let Some(platform) = obj.get("platform").and_then(Value::as_str) else {
                return AgentIntentOutcome::refused("Each destination needs its platform.");
            };
            let label = metadata_platform_label(platform);
            let Some(index) = next
                .target_overrides
                .iter()
                .position(|o| o.platform == platform)
            else {
                return AgentIntentOutcome::refused(format!(
                    "{label} has no stream details in Videorc."
                ));
            };
            let mut entry = next.target_overrides[index].clone();
            let entry_title = obj.get("title").and_then(Value::as_str);
            let entry_desc = obj.get("description").and_then(Value::as_str);
            let entry_privacy = parse_privacy(obj.get("privacy"));
            let entry_category = obj
                .get("category")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());

            if entry_title.is_some() || entry_desc.is_some() || entry_privacy.is_some() {
                if !entry.customize {
                    entry.customize = true;
                    entry.title = next.title.clone();
                    entry.description = next.description.clone();
                    entry.privacy = next.default_privacy;
                }
                if let Some(t) = entry_title {
                    entry.title = t.to_string();
                }
                if let Some(d) = entry_desc {
                    entry.description = d.to_string();
                }
                if let Some(p) = entry_privacy {
                    entry.privacy = p;
                }
            }
            if let Some(cat) = entry_category {
                if platform != "twitch" && platform != "kick" {
                    return AgentIntentOutcome::refused(format!(
                        "{label} has no category in Videorc. {}",
                        copy::CATEGORY_PLATFORMS
                    ));
                }
                let (id, name) = match self.resolve_category(platform, cat).await {
                    Ok(found) => found,
                    Err(message) => return AgentIntentOutcome::refused(message),
                };
                entry = with_category(entry, &id, name);
            }
            next.target_overrides[index] = entry;
        }

        let payload = serde_json::to_value(&next).unwrap_or(Value::Null);
        let validation_raw = match self
            .backend
            .livestream_request(methods::METADATA_VALIDATE, payload.clone())
            .await
        {
            Ok(v) => v,
            Err(error) => return AgentIntentOutcome::refused(error.message),
        };
        let validation: Validation = match serde_json::from_value(validation_raw) {
            Ok(v) => v,
            Err(_) => {
                return AgentIntentOutcome::refused("Couldn't validate the stream details.");
            }
        };
        if !validation.valid {
            let message = validation
                .issues
                .iter()
                .map(|issue| match &issue.platform {
                    Some(platform) => {
                        format!("{}: {}", metadata_platform_label(platform), issue.message)
                    }
                    None => issue.message.clone(),
                })
                .collect::<Vec<_>>()
                .join(" ");
            return AgentIntentOutcome::refused(message);
        }

        let saved_raw = match self
            .backend
            .livestream_request(methods::METADATA_UPDATE, payload)
            .await
        {
            Ok(v) => v,
            Err(error) => return AgentIntentOutcome::refused(error.message),
        };
        let saved: MetadataDraft = serde_json::from_value(saved_raw).unwrap_or(next);
        self.apply_saved_metadata_draft(saved.clone(), Some(validation));
        AgentIntentOutcome::ok("Stream details saved.", draft_projection(&saved))
    }

    pub(super) async fn agent_set_destinations(&self, args: &Value) -> AgentIntentOutcome {
        if !self.is_connected() {
            return AgentIntentOutcome::refused(copy::UNAVAILABLE);
        }
        let asked = args
            .get("destinations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if asked.is_empty() {
            return AgentIntentOutcome::refused(copy::DESTINATIONS_EMPTY);
        }
        if self.session_owns_transport() || self.go_live_now().pending {
            return AgentIntentOutcome::refused(copy::LOCKED);
        }

        let snapshot = self.snapshot();
        let entitlements = snapshot.entitlements.as_ref();
        let mut targets = stream_targets(&snapshot.settings.capture_doc);
        let mut enabled_ids: Vec<String> = targets
            .iter()
            .filter(|t| t.enabled)
            .map(|t| t.id.clone())
            .collect();

        let mut changes: Vec<(String, bool)> = Vec::new();
        for entry in asked {
            let id = entry.get("id").and_then(Value::as_str);
            let on = entry.get("on").and_then(Value::as_bool);
            let (Some(id), Some(on)) = (id, on) else {
                return AgentIntentOutcome::refused("Each destination needs its id and on.");
            };
            let Some(pos) = targets.iter().position(|t| t.id == id) else {
                return AgentIntentOutcome::refused(format!(
                    "No destination has the id \"{id}\". list_destinations gives the ids."
                ));
            };
            if on && !targets[pos].enabled {
                let gate = streaming_destination_enable_gate(entitlements, &enabled_ids, id);
                if !gate.allowed() {
                    return AgentIntentOutcome::refused(
                        gate.reason()
                            .unwrap_or("Multistreaming requires Videorc Premium.")
                            .to_string(),
                    );
                }
            }
            targets[pos].enabled = on;
            if on {
                if !enabled_ids.iter().any(|existing| existing == id) {
                    enabled_ids.push(id.to_string());
                }
            } else {
                enabled_ids.retain(|existing| existing != id);
            }
            changes.push((id.to_string(), on));
        }

        for (id, on) in changes {
            self.patch_stream_target(&id, TargetPatch::default().set("enabled", json!(on)))
                .await;
        }

        let destinations: Vec<Value> = targets
            .iter()
            .map(|target| {
                json!({
                    "id": target.id,
                    "platform": target.platform,
                    "label": destination_label(&target.label),
                    "on": target.enabled,
                    "ready": start_ready(target),
                })
            })
            .collect();
        let on_labels: Vec<String> = targets
            .iter()
            .filter(|t| t.enabled)
            .map(|t| destination_label(&t.label))
            .collect();
        let message = if on_labels.is_empty() {
            "No destination is on for the next stream.".to_string()
        } else {
            format!("On for the next stream: {}.", on_labels.join(", "))
        };
        AgentIntentOutcome::ok(message, json!({ "destinations": destinations }))
    }
}
