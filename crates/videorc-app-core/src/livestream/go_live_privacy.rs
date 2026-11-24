//! Going live where viewers can't find it (`lib/go-live-privacy.ts`): every
//! YouTube destination in a Go Live that is Unlisted or Private asks the
//! streamer once more, naming it and its privacy. The Go Live dialog confirms
//! on its primary; an agent's `go_live` needs `allowNonPublic`.

use serde_json::{Value, json};

use super::accounts::{destination_label, platform_label};
use super::details::{MetadataDraft, Privacy};
use super::golive::DestinationPreflight;
use super::targets::Target;

/// One YouTube destination this Go Live sends that isn't Public.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonPublicYouTube {
    pub target_id: String,
    /// The destination's name, as its row in the dialog shows it.
    pub label: String,
    /// Never [`Privacy::Public`].
    pub privacy: Privacy,
    /// The privacy is the scheduled event's own, not the dialog's field.
    pub scheduled: bool,
}

/// `effectiveInstantYouTubePrivacy`: YouTube's customised override, else the
/// draft's privacy; Private with no draft (`effective_youtube_metadata`).
pub fn effective_instant_youtube_privacy(draft: Option<&MetadataDraft>) -> Privacy {
    let Some(draft) = draft else {
        return Privacy::Private;
    };
    draft
        .target_overrides
        .iter()
        .find(|target| target.platform == "youtube")
        .filter(|target| target.customize)
        .map_or(draft.default_privacy, |target| target.privacy)
}

/// `instantYouTubePrivacyPatch`: the draft patch that sets the instant
/// YouTube privacy where the backend reads it.
pub fn instant_youtube_privacy_patch(draft: Option<&MetadataDraft>, privacy: Privacy) -> Value {
    let overrides = draft
        .map(|draft| draft.target_overrides.as_slice())
        .unwrap_or_default();
    if !overrides
        .iter()
        .any(|target| target.platform == "youtube" && target.customize)
    {
        return json!({ "defaultPrivacy": privacy });
    }
    let overrides: Vec<_> = overrides
        .iter()
        .map(|target| {
            let mut target = target.clone();
            if target.platform == "youtube" && target.customize {
                target.privacy = privacy;
            }
            target
        })
        .collect();
    json!({ "targetOverrides": overrides })
}

fn as_privacy(value: Option<&str>) -> Option<Privacy> {
    match value?.trim().to_lowercase().as_str() {
        "public" => Some(Privacy::Public),
        "unlisted" => Some(Privacy::Unlisted),
        "private" => Some(Privacy::Private),
        _ => None,
    }
}

/// `nonPublicYouTubeDestinations`, in saved order. A scheduled one takes its
/// event's privacy (the preflight's, else the saved copy) and is left out
/// when Videorc never learned it.
pub fn non_public_youtube(
    sent_targets: &[&Target],
    destinations: &[DestinationPreflight],
    draft: Option<&MetadataDraft>,
) -> Vec<NonPublicYouTube> {
    let instant = effective_instant_youtube_privacy(draft);
    sent_targets
        .iter()
        .filter(|target| target.platform == "youtube")
        .filter_map(|target| {
            let row = destinations
                .iter()
                .find(|destination| destination.target_id == target.id);
            let scheduled = target
                .scheduled_event_id
                .as_deref()
                .is_some_and(|id| !id.is_empty());
            let privacy = if scheduled {
                as_privacy(
                    row.and_then(|row| row.scheduled.as_ref())
                        .and_then(|event| event["privacy"].as_str()),
                )
                .or_else(|| as_privacy(target.scheduled_privacy.as_deref()))?
            } else {
                instant
            };
            (privacy != Privacy::Public).then(|| NonPublicYouTube {
                target_id: target.id.clone(),
                label: destination_label(row.map_or(target.label.as_str(), |row| &row.label)),
                privacy,
                scheduled,
            })
        })
        .collect()
}

fn privacy_word(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Unlisted => "Unlisted",
        Privacy::Private => "Private",
        Privacy::Public => "Public",
    }
}

fn privacy_meaning(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Unlisted => "Only people with the link can watch.",
        Privacy::Private => "Only you can watch.",
        Privacy::Public => "",
    }
}

/// `nonPublicPrivacyLine`: "Unlisted. Only people with the link can watch."
pub fn non_public_privacy_line(privacy: Privacy) -> String {
    format!("{}. {}", privacy_word(privacy), privacy_meaning(privacy))
}

/// "YouTube Vertical" as named, or "Main channel (YouTube)".
fn youtube_name(label: &str) -> String {
    let youtube = platform_label("youtube");
    if label.to_lowercase().contains(&youtube.to_lowercase()) {
        label.to_string()
    } else {
        format!("{label} ({youtube})")
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// `GoLivePrivacyConfirmCopy`: the Go Live dialog's privacy step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmCopy {
    /// "Go live unlisted?"
    pub title: String,
    /// "YouTube is Unlisted. Only people with the link can watch."
    pub description: String,
    /// "Go live unlisted", or "Go live anyway" for a mix.
    pub confirm_label: String,
    /// "Change privacy" when the dialog's Privacy field can change it.
    pub cancel_label: &'static str,
}

/// `goLivePrivacyConfirmCopy`: one sentence per privacy naming who has it.
pub fn confirm_copy(non_public: &[NonPublicYouTube]) -> ConfirmCopy {
    let privacies: Vec<Privacy> = [Privacy::Unlisted, Privacy::Private]
        .into_iter()
        .filter(|privacy| non_public.iter().any(|d| d.privacy == *privacy))
        .collect();
    let description = privacies
        .iter()
        .map(|privacy| {
            let mut names: Vec<String> = Vec::new();
            for destination in non_public.iter().filter(|d| d.privacy == *privacy) {
                let name = if destination.scheduled {
                    format!(
                        "the scheduled event on {}",
                        youtube_name(&destination.label)
                    )
                } else {
                    youtube_name(&destination.label)
                };
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            let verb = if names.len() > 1 { "are" } else { "is" };
            format!(
                "{} {verb} {}. {}",
                capitalize(&join_names(&names)),
                privacy_word(*privacy),
                privacy_meaning(*privacy)
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let word = match privacies.as_slice() {
        [single] => Some(privacy_word(*single).to_lowercase()),
        _ => None,
    };
    ConfirmCopy {
        title: word.as_ref().map_or_else(
            || "Go live unlisted and private?".to_string(),
            |word| format!("Go live {word}?"),
        ),
        description,
        confirm_label: word.as_ref().map_or_else(
            || "Go live anyway".to_string(),
            |word| format!("Go live {word}"),
        ),
        cancel_label: if non_public.iter().any(|d| !d.scheduled) {
            "Change privacy"
        } else {
            "Go back"
        },
    }
}

/// `ALLOW_NON_PUBLIC_HINT`.
pub const ALLOW_NON_PUBLIC_HINT: &str =
    "Pass allowNonPublic: true to go live anyway, or change Privacy in Destinations → Setup.";

/// `headlessNonPublicRefusal`: the dialog's sentence, then how to go ahead.
pub fn headless_refusal(non_public: &[NonPublicYouTube]) -> String {
    format!(
        "{} {ALLOW_NON_PUBLIC_HINT}",
        confirm_copy(non_public).description
    )
}

#[cfg(test)]
mod tests {
    use super::super::details::TargetDraft;
    use super::*;

    fn youtube(id: &str, label: &str, scheduled: Option<&str>) -> Target {
        Target {
            id: id.into(),
            platform: "youtube".into(),
            label: label.into(),
            enabled: true,
            scheduled_event_id: scheduled.map(|_| "event".to_string()),
            scheduled_privacy: scheduled.map(str::to_string),
            ..Target::default()
        }
    }

    fn draft(default: Privacy, youtube_override: Option<(bool, Privacy)>) -> MetadataDraft {
        MetadataDraft {
            default_privacy: default,
            target_overrides: youtube_override
                .map(|(customize, privacy)| TargetDraft {
                    platform: "youtube".into(),
                    customize,
                    privacy,
                    ..TargetDraft::default()
                })
                .into_iter()
                .collect(),
            ..MetadataDraft::default()
        }
    }

    #[test]
    fn the_instant_privacy_is_youtubes_customised_override_else_the_drafts() {
        assert_eq!(effective_instant_youtube_privacy(None), Privacy::Private);
        let plain = draft(Privacy::Public, Some((false, Privacy::Unlisted)));
        assert_eq!(
            effective_instant_youtube_privacy(Some(&plain)),
            Privacy::Public
        );
        assert_eq!(
            instant_youtube_privacy_patch(Some(&plain), Privacy::Unlisted),
            json!({ "defaultPrivacy": "unlisted" })
        );
        let custom = draft(Privacy::Public, Some((true, Privacy::Unlisted)));
        assert_eq!(
            effective_instant_youtube_privacy(Some(&custom)),
            Privacy::Unlisted
        );
        let patch = instant_youtube_privacy_patch(Some(&custom), Privacy::Public);
        assert_eq!(patch["targetOverrides"][0]["privacy"], json!("public"));
        assert!(patch.get("defaultPrivacy").is_none());
    }

    #[test]
    fn only_youtube_destinations_that_arent_public_are_named() {
        let main = youtube("yt", "YouTube", None);
        let vertical = youtube("yt-v", "Main channel", Some("private"));
        let unknown = Target {
            scheduled_privacy: None,
            ..youtube("yt-u", "YouTube 3", Some("private"))
        };
        let twitch = Target {
            platform: "twitch".into(),
            ..youtube("tw", "Twitch", None)
        };
        let sent = [&main, &vertical, &unknown, &twitch];
        let public = draft(Privacy::Public, None);
        let found = non_public_youtube(&sent, &[], Some(&public));
        assert_eq!(found.len(), 1);
        assert_eq!(
            (
                found[0].target_id.as_str(),
                found[0].privacy,
                found[0].scheduled
            ),
            ("yt-v", Privacy::Private, true)
        );

        // The preflight's scheduled event wins over the saved copy.
        let row = DestinationPreflight {
            target_id: "yt-v".into(),
            label: "Main channel".into(),
            scheduled: Some(json!({ "privacy": "public" })),
            ..DestinationPreflight::default()
        };
        assert!(non_public_youtube(&sent, &[row], Some(&public)).is_empty());

        let unlisted = draft(Privacy::Unlisted, None);
        let found = non_public_youtube(&[&main], &[], Some(&unlisted));
        assert_eq!(found[0].privacy, Privacy::Unlisted);
        assert!(!found[0].scheduled);
    }

    #[test]
    fn the_privacy_step_names_each_destination_and_what_it_means() {
        let one = [NonPublicYouTube {
            target_id: "yt".into(),
            label: "YouTube".into(),
            privacy: Privacy::Unlisted,
            scheduled: false,
        }];
        assert_eq!(
            confirm_copy(&one),
            ConfirmCopy {
                title: "Go live unlisted?".into(),
                description: "YouTube is Unlisted. Only people with the link can watch.".into(),
                confirm_label: "Go live unlisted".into(),
                cancel_label: "Change privacy",
            }
        );
        let mixed = [
            one[0].clone(),
            NonPublicYouTube {
                target_id: "yt-v".into(),
                label: "Main channel".into(),
                privacy: Privacy::Private,
                scheduled: true,
            },
            NonPublicYouTube {
                target_id: "yt-w".into(),
                label: "YouTube Vertical".into(),
                privacy: Privacy::Unlisted,
                scheduled: false,
            },
        ];
        let copy = confirm_copy(&mixed);
        assert_eq!(copy.title, "Go live unlisted and private?");
        assert_eq!(copy.confirm_label, "Go live anyway");
        assert_eq!(
            copy.description,
            "YouTube and YouTube Vertical are Unlisted. Only people with the link can watch. The scheduled event on Main channel (YouTube) is Private. Only you can watch."
        );
        assert_eq!(confirm_copy(&mixed[1..2]).cancel_label, "Go back");
        assert_eq!(
            headless_refusal(&one),
            "YouTube is Unlisted. Only people with the link can watch. Pass allowNonPublic: true to go live anyway, or change Privacy in Destinations → Setup."
        );
        assert_eq!(
            non_public_privacy_line(Privacy::Private),
            "Private. Only you can watch."
        );
    }
}
