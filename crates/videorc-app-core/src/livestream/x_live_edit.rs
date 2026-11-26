//! Live on X (`x-live-edit.ts`, plan 260 L2): the title and category of the
//! broadcast that is on air, changed while it runs (`PUT /2/broadcasts/:id`).
//! The saved Stream details stay as they are; X's answer to the update is
//! what the section shows, because a read right after can still return the
//! old values. Pure, so every rule is a test.

use serde::{Deserialize, Serialize};

use super::details::MetadataDraft;
use super::setup::Runtime;
use super::targets::Target;
use super::x_categories::{X_NO_CATEGORY, XLiveCategory};

pub const X_LIVE_EDIT_TITLE: &str = "Live on X";
pub const X_LIVE_EDIT_DESCRIPTION: &str =
    "Changes go to X now. Your saved stream details stay as they are.";
pub const X_LIVE_TITLE_LABEL: &str = "Title";
pub const X_LIVE_TITLE_REQUIRED: &str = "X needs a title.";
pub const UPDATE_X: &str = "Update X";
pub const UPDATING: &str = "Updating…";
/// `updateXBroadcast` with no connection.
pub const X_UPDATE_OFFLINE: &str = "Videorc is reconnecting. Try again in a moment.";
const GO_LIVE_FALLBACK_TITLE: &str = "Live from Videorc";

/// `xLiveUpdateFailed`.
pub fn x_live_update_failed(message: &str) -> String {
    format!("X didn't take the change: {message}")
}

/// What X shows now, as Videorc last knew it (`XLiveValues`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct XLiveValues {
    pub title: String,
    pub category_id: Option<String>,
}

/// `XBroadcastUpdated`: the broadcast as `PUT /2/broadcasts/:id` answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XBroadcastUpdated {
    pub broadcast_id: String,
    pub state: String,
    pub share_url: String,
    pub title: Option<String>,
    pub live_category_id: Option<String>,
    /// The category's name from this session's list, when it has it.
    pub live_category_name: Option<String>,
}

/// Only what changed, as X takes it (`xLiveChanges`'s result).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct XLiveChanges {
    pub title: Option<String>,
    /// The category's id, or `""` to clear it.
    pub live_category_id: Option<String>,
}

/// `xGoLiveTitle`: the X row's own title when it customizes, else the shared one.
pub fn x_go_live_title(draft: Option<&MetadataDraft>) -> String {
    let x = draft.and_then(|draft| {
        draft
            .target_overrides
            .iter()
            .find(|row| row.platform == "x")
    });
    let own = x
        .filter(|row| row.customize)
        .map(|row| row.title.trim())
        .unwrap_or_default();
    if !own.is_empty() {
        return own.to_string();
    }
    let shared = draft.map(|draft| draft.title.trim()).unwrap_or_default();
    if shared.is_empty() {
        GO_LIVE_FALLBACK_TITLE.to_string()
    } else {
        shared.to_string()
    }
}

/// `liveXTarget`: the X destination on air with its broadcast, when there is
/// one. Live is the target's own status or the session's runtime row for it.
pub fn live_x_target<'a>(targets: &'a [Target], runtimes: &[Runtime]) -> Option<&'a Target> {
    targets.iter().find(|target| {
        let live = target
            .status
            .as_ref()
            .is_some_and(|status| status.state == "live")
            || runtimes
                .iter()
                .any(|runtime| runtime.target_id == target.id && runtime.state == "live");
        target.platform == "x"
            && live
            && target
                .platform_broadcast_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
    })
}

/// `xLiveStart`: what Go Live set, the draft's title and its category when X
/// lists it.
pub fn x_live_start(draft: Option<&MetadataDraft>, categories: &[XLiveCategory]) -> XLiveValues {
    let saved = draft
        .and_then(|draft| {
            draft
                .target_overrides
                .iter()
                .find(|row| row.platform == "x")
        })
        .and_then(|row| row.x_category_id.as_deref())
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let listed = categories.is_empty()
        || saved.is_some_and(|id| categories.iter().any(|category| category.id == id));
    XLiveValues {
        title: x_go_live_title(draft),
        category_id: saved.filter(|_| listed).map(str::to_string),
    }
}

/// `xLiveFromAnswer`: X's answer as the values it now shows.
pub fn x_live_from_answer(answer: &XBroadcastUpdated, before: &XLiveValues) -> XLiveValues {
    let title = answer
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map_or_else(|| before.title.clone(), str::to_string);
    let category_id = answer
        .live_category_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    XLiveValues { title, category_id }
}

/// `xLiveChanges`: only what changed, as X takes it: a trimmed title, and the
/// category's id or `""` to clear it. None when nothing changed or the title
/// is empty.
pub fn x_live_changes(
    shown: &XLiveValues,
    title: &str,
    category_value: &str,
) -> Option<XLiveChanges> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    let category_id = (category_value != X_NO_CATEGORY).then_some(category_value);
    let mut changes = XLiveChanges::default();
    if title != shown.title {
        changes.title = Some(title.to_string());
    }
    if category_id != shown.category_id.as_deref() {
        changes.live_category_id = Some(category_id.unwrap_or_default().to_string());
    }
    (changes != XLiveChanges::default()).then_some(changes)
}

/// `xLiveShownLine`: the line under the fields, what X shows now.
pub fn x_live_shown_line(
    shown: &XLiveValues,
    categories: &[XLiveCategory],
    answer_name: Option<&str>,
) -> String {
    let name = match &shown.category_id {
        Some(id) => categories
            .iter()
            .find(|category| &category.id == id)
            .map(|category| category.name.as_str())
            .or(answer_name)
            .unwrap_or(id.as_str())
            .to_string(),
        None => super::x_categories::X_NO_CATEGORY_LABEL.to_string(),
    };
    format!("X shows “{}” · {name}", shown.title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livestream::details::TargetDraft;
    use crate::livestream::targets::TargetStatus;

    fn categories() -> Vec<XLiveCategory> {
        vec![
            XLiveCategory {
                id: "gaming".into(),
                name: "Gaming".into(),
            },
            XLiveCategory {
                id: "music".into(),
                name: "Music".into(),
            },
        ]
    }

    fn draft(shared: &str, x: TargetDraft) -> MetadataDraft {
        MetadataDraft {
            title: shared.into(),
            target_overrides: vec![TargetDraft {
                platform: "x".into(),
                ..x
            }],
            ..MetadataDraft::default()
        }
    }

    #[test]
    fn the_go_live_title_is_the_rows_own_then_the_shared_then_the_fallback() {
        let own = draft(
            "Shared",
            TargetDraft {
                customize: true,
                title: " Own ".into(),
                ..TargetDraft::default()
            },
        );
        assert_eq!(x_go_live_title(Some(&own)), "Own");
        let not_customized = draft(
            "Shared",
            TargetDraft {
                title: "Own".into(),
                ..TargetDraft::default()
            },
        );
        assert_eq!(x_go_live_title(Some(&not_customized)), "Shared");
        assert_eq!(x_go_live_title(None), "Live from Videorc");
    }

    #[test]
    fn only_a_live_x_target_with_its_broadcast_counts() {
        let target = |state: &str, broadcast: Option<&str>| Target {
            id: "x-1".into(),
            platform: "x".into(),
            status: Some(TargetStatus {
                state: state.into(),
                ..TargetStatus::default()
            }),
            platform_broadcast_id: broadcast.map(str::to_string),
            ..Target::default()
        };
        assert!(live_x_target(&[target("live", Some("b1"))], &[]).is_some());
        assert!(live_x_target(&[target("live", None)], &[]).is_none());
        assert!(live_x_target(&[target("idle", Some("b1"))], &[]).is_none());
        let runtime = Runtime {
            target_id: "x-1".into(),
            label: "X".into(),
            state: "live".into(),
            message: None,
            uplink_overflows: 0,
        };
        assert!(live_x_target(&[target("idle", Some("b1"))], &[runtime]).is_some());
    }

    #[test]
    fn start_keeps_the_saved_category_only_when_x_lists_it() {
        let saved = draft(
            "Show",
            TargetDraft {
                x_category_id: Some("music".into()),
                ..TargetDraft::default()
            },
        );
        assert_eq!(
            x_live_start(Some(&saved), &categories())
                .category_id
                .as_deref(),
            Some("music")
        );
        assert_eq!(
            x_live_start(Some(&saved), &[]).category_id.as_deref(),
            Some("music"),
            "no list yet: keep it"
        );
        let gone = draft(
            "Show",
            TargetDraft {
                x_category_id: Some("chess".into()),
                ..TargetDraft::default()
            },
        );
        assert_eq!(x_live_start(Some(&gone), &categories()).category_id, None);
    }

    #[test]
    fn changes_are_only_what_differs_and_need_a_title() {
        let shown = XLiveValues {
            title: "Show".into(),
            category_id: Some("gaming".into()),
        };
        assert_eq!(x_live_changes(&shown, "Show", "gaming"), None);
        assert_eq!(x_live_changes(&shown, "  ", "music"), None);
        assert_eq!(
            x_live_changes(&shown, " New ", "gaming"),
            Some(XLiveChanges {
                title: Some("New".into()),
                live_category_id: None,
            })
        );
        assert_eq!(
            x_live_changes(&shown, "Show", X_NO_CATEGORY),
            Some(XLiveChanges {
                title: None,
                live_category_id: Some(String::new()),
            })
        );
    }

    #[test]
    fn the_answer_is_what_x_shows_and_the_line_names_it() {
        let before = XLiveValues {
            title: "Show".into(),
            category_id: Some("gaming".into()),
        };
        let answer = XBroadcastUpdated {
            title: Some(" ".into()),
            live_category_id: Some("chess".into()),
            live_category_name: Some("Chess".into()),
            ..XBroadcastUpdated::default()
        };
        let next = x_live_from_answer(&answer, &before);
        assert_eq!(next.title, "Show");
        assert_eq!(next.category_id.as_deref(), Some("chess"));
        assert_eq!(
            x_live_shown_line(&next, &categories(), Some("Chess")),
            "X shows “Show” · Chess"
        );
        assert_eq!(
            x_live_shown_line(&before, &categories(), None),
            "X shows “Show” · Gaming"
        );
        let none = XLiveValues {
            title: "Show".into(),
            category_id: None,
        };
        assert_eq!(
            x_live_shown_line(&none, &[], None),
            "X shows “Show” · No category"
        );
        assert_eq!(
            x_live_update_failed("Rate limited"),
            "X didn't take the change: Rate limited"
        );
    }
}
