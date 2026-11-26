//! The X destination's category picker in Stream details
//! (`x-live-categories.ts`, plan 260 L2). X lists its live categories itself
//! (`GET /2/broadcasts/categories`, sorted by viewership) and changes them
//! rarely: the picker keeps X's order, stores the permanent `id` and shows the
//! `name`. The last pick stays for the next stream, as X recommends. A saved
//! category X no longer lists is left out of Go Live quietly (the backend);
//! the picker shows No category and says why.

use serde::{Deserialize, Serialize};

use super::details::TargetDraft;

/// `XLiveCategory`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XLiveCategory {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// `XLiveCategoriesResult` (`streamTargets.x.liveCategories`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XLiveCategoriesResult {
    #[serde(default)]
    pub categories: Vec<XLiveCategory>,
}

/// `XLiveCategoriesStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum XLiveCategoriesStatus {
    /// X Live isn't authorized: nothing to read yet.
    #[default]
    Idle,
    Loading,
    Ready,
    Failed,
}

/// The Select's value for "no category" (`X_NO_CATEGORY`).
pub const X_NO_CATEGORY: &str = "none";
pub const X_NO_CATEGORY_LABEL: &str = "No category";
pub const X_CATEGORY_LABEL: &str = "Category";
pub const X_CATEGORY_ACCESSIBLE_LABEL: &str = "X category";
pub const X_CATEGORY_NEEDS_X_LIVE: &str = "Authorize X Live to pick a category.";
pub const X_CATEGORIES_LOADING: &str = "Loading categories…";
pub const X_CATEGORIES_FAILED: &str = "X's categories didn't load.";
pub const X_CATEGORIES_RETRY: &str = "Try again";
pub const X_ANNOUNCE_LABEL: &str = "Announce on X timeline";
pub const X_ANNOUNCE_DESCRIPTION: &str =
    "X broadcasts are always public. Off skips the announcement post.";

/// `xCategoryGone`.
pub fn x_category_gone(name: &str) -> String {
    format!("X no longer lists “{name}”. Go Live leaves it out.")
}

/// `XCategoryItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XCategoryItem {
    pub value: String,
    pub label: String,
}

/// `XCategoryPick`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XCategoryPick {
    pub items: Vec<XCategoryItem>,
    pub value: String,
    /// One quiet line under the picker, when there is something to say.
    pub note: Option<String>,
    /// The picker can't be used yet (X Live isn't authorized, or it's loading).
    pub unavailable: bool,
}

/// `xCategoryPick`.
pub fn x_category_pick(
    categories: &[XLiveCategory],
    status: XLiveCategoriesStatus,
    saved_id: Option<&str>,
    saved_name: Option<&str>,
) -> XCategoryPick {
    let saved_id = saved_id.map(str::trim).filter(|id| !id.is_empty());
    let saved_name = saved_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .or(saved_id);
    let listed = saved_id.is_some_and(|id| categories.iter().any(|category| category.id == id));
    let mut items = vec![XCategoryItem {
        value: X_NO_CATEGORY.to_string(),
        label: X_NO_CATEGORY_LABEL.to_string(),
    }];
    items.extend(categories.iter().map(|category| XCategoryItem {
        value: category.id.clone(),
        label: category.name.clone(),
    }));
    // Until X's list says otherwise, the saved pick stays on show.
    if let Some(id) = saved_id
        && !listed
        && status != XLiveCategoriesStatus::Ready
    {
        items.push(XCategoryItem {
            value: id.to_string(),
            label: saved_name.unwrap_or(id).to_string(),
        });
    }
    let value = match saved_id {
        Some(id) if items.iter().any(|item| item.value == id) => id.to_string(),
        _ => X_NO_CATEGORY.to_string(),
    };
    let gone = saved_id.is_some() && !listed && status == XLiveCategoriesStatus::Ready;
    let note = match status {
        XLiveCategoriesStatus::Idle => Some(X_CATEGORY_NEEDS_X_LIVE.to_string()),
        XLiveCategoriesStatus::Failed => Some(X_CATEGORIES_FAILED.to_string()),
        _ if gone => Some(x_category_gone(saved_name.or(saved_id).unwrap_or_default())),
        _ => None,
    };
    XCategoryPick {
        items,
        value,
        note,
        unavailable: status == XLiveCategoriesStatus::Idle
            || (status == XLiveCategoriesStatus::Loading && categories.is_empty()),
    }
}

/// `xCategoryPatch`: the id to send and the name to show, on the X override.
pub fn apply_x_category(draft: &mut TargetDraft, value: &str, items: &[XCategoryItem]) {
    let item = (value != X_NO_CATEGORY)
        .then(|| items.iter().find(|entry| entry.value == value))
        .flatten();
    draft.x_category_id = item.map(|item| item.value.clone());
    draft.x_category_name = item.map(|item| item.label.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<XLiveCategory> {
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

    #[test]
    fn idle_asks_for_x_live_and_cannot_be_used() {
        let pick = x_category_pick(&[], XLiveCategoriesStatus::Idle, None, None);
        assert_eq!(pick.value, X_NO_CATEGORY);
        assert_eq!(pick.note.as_deref(), Some(X_CATEGORY_NEEDS_X_LIVE));
        assert!(pick.unavailable);
        assert_eq!(pick.items.len(), 1);
    }

    #[test]
    fn ready_keeps_x_order_after_no_category_and_selects_the_saved_pick() {
        let pick = x_category_pick(&list(), XLiveCategoriesStatus::Ready, Some("music"), None);
        let labels: Vec<_> = pick.items.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(labels, ["No category", "Gaming", "Music"]);
        assert_eq!(pick.value, "music");
        assert_eq!(pick.note, None);
        assert!(!pick.unavailable);
    }

    #[test]
    fn a_saved_pick_stays_on_show_until_the_list_says_otherwise() {
        let loading = x_category_pick(
            &[],
            XLiveCategoriesStatus::Loading,
            Some("chess"),
            Some("Chess"),
        );
        assert_eq!(loading.value, "chess");
        assert_eq!(loading.items.last().unwrap().label, "Chess");
        assert!(loading.unavailable, "loading with no list yet");
        assert_eq!(loading.note, None);

        let failed = x_category_pick(&[], XLiveCategoriesStatus::Failed, Some("chess"), None);
        assert_eq!(failed.value, "chess");
        assert_eq!(failed.note.as_deref(), Some(X_CATEGORIES_FAILED));
        assert!(!failed.unavailable);

        let gone = x_category_pick(
            &list(),
            XLiveCategoriesStatus::Ready,
            Some("chess"),
            Some("Chess"),
        );
        assert_eq!(gone.value, X_NO_CATEGORY);
        assert_eq!(
            gone.note.as_deref(),
            Some("X no longer lists “Chess”. Go Live leaves it out.")
        );
    }

    #[test]
    fn a_pick_stores_id_and_name_and_no_category_clears_both() {
        let pick = x_category_pick(&list(), XLiveCategoriesStatus::Ready, None, None);
        let mut draft = TargetDraft::default();
        apply_x_category(&mut draft, "gaming", &pick.items);
        assert_eq!(draft.x_category_id.as_deref(), Some("gaming"));
        assert_eq!(draft.x_category_name.as_deref(), Some("Gaming"));
        apply_x_category(&mut draft, X_NO_CATEGORY, &pick.items);
        assert_eq!(draft.x_category_id, None);
        assert_eq!(draft.x_category_name, None);
    }
}
