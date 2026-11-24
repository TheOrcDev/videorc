//! S3.5b: Stream details as data (`MetadataEditor`, `MetadataOverride`,
//! `BroadcastInfoFields`, `lib/broadcast-info.ts`,
//! `lib/stream-metadata-summary.ts`, `lib/stream-languages.ts`).
//!
//! The draft is the backend's (`streamTargets.metadata.get`, `.update`,
//! `.changed`); the Studio keeps the one being edited and the last
//! validation (`streamTargets.metadata.validate`). Unsaved edits are the
//! page's: an edit marks the draft as it was loaded, and a save or a reload
//! brings a new `updatedAt`, which ends it (D-5).

use serde::{Deserialize, Serialize};

use super::copy;
use super::targets::Target;

/// `StreamPrivacy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Privacy {
    Public,
    Unlisted,
    #[default]
    Private,
}

impl Privacy {
    pub const ALL: [Privacy; 3] = [Privacy::Private, Privacy::Unlisted, Privacy::Public];

    pub fn index(self) -> i32 {
        Self::ALL.iter().position(|p| *p == self).unwrap_or(0) as i32
    }

    pub fn label(self) -> &'static str {
        match self {
            Privacy::Public => copy::PUBLIC,
            Privacy::Unlisted => copy::UNLISTED,
            Privacy::Private => copy::PRIVATE,
        }
    }

    /// `broadcastPrivacyHint`.
    pub fn hint(self) -> &'static str {
        match self {
            Privacy::Public => copy::PRIVACY_PUBLIC_HINT,
            Privacy::Unlisted => copy::PRIVACY_UNLISTED_HINT,
            Privacy::Private => copy::PRIVACY_PRIVATE_HINT,
        }
    }
}

/// `StreamTargetMetadataDraft`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetDraft {
    pub platform: String,
    pub customize: bool,
    pub title: String,
    pub description: String,
    pub privacy: Privacy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube_made_for_kids: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_category_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kick_category_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kick_category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_announce: Option<bool>,
    #[serde(default)]
    pub updated_at: String,
}

/// `StreamMetadataDraft`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetadataDraft {
    pub title: String,
    pub description: String,
    pub default_privacy: Privacy,
    pub target_overrides: Vec<TargetDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_asset_id: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// `StreamMetadataValidationIssue`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

/// `StreamMetadataValidation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub valid: bool,
    #[serde(default)]
    pub issues: Vec<Issue>,
}

impl Validation {
    /// `metadataIssue(validation, field, platform)`.
    pub fn issue(&self, field: &str, platform: Option<&str>) -> Option<&Issue> {
        self.issues
            .iter()
            .find(|issue| issue.field == field && issue.platform.as_deref() == platform)
    }
}

pub const TITLE_MAX: usize = 100;
pub const DESCRIPTION_MAX: usize = 5000;

/// `broadcastTextLength`: code points, as `Array.from`.
pub fn text_length(text: &str) -> usize {
    text.chars().count()
}

/// `broadcastInfoIssues`: the title's and the description's problem, if any.
pub fn info_issues(
    title: &str,
    description: &str,
    title_required: bool,
) -> (Option<String>, Option<String>) {
    let angle = |text: &str| text.contains('<') || text.contains('>');
    let title_issue = if title_required && title.trim().is_empty() {
        Some(copy::ADD_A_TITLE.to_string())
    } else if text_length(title) > TITLE_MAX {
        Some(copy::keep_title_to(TITLE_MAX))
    } else if angle(title) {
        Some(copy::TITLE_ANGLES.to_string())
    } else {
        None
    };
    let description_issue = if text_length(description) > DESCRIPTION_MAX {
        Some(copy::keep_description_to("5,000"))
    } else if angle(description) {
        Some(copy::DESCRIPTION_ANGLES.to_string())
    } else {
        None
    };
    (title_issue, description_issue)
}

/// `broadcastTitleCounter`.
pub fn title_counter(title: &str) -> String {
    format!("{}/{TITLE_MAX}", text_length(title))
}

/// `broadcastThumbnailHint`.
pub fn thumbnail_hint(youtube_signed_in: bool) -> &'static str {
    if youtube_signed_in {
        copy::THUMBNAIL_HINT_SIGNED_IN
    } else {
        copy::THUMBNAIL_HINT_KEY
    }
}

/// `isSixteenByNine`: within 1%; an unmeasured image passes.
pub fn is_sixteen_by_nine(width: u32, height: u32) -> bool {
    if width == 0 || height == 0 {
        return true;
    }
    (f64::from(width) / f64::from(height) / (16.0 / 9.0) - 1.0).abs() <= 0.01
}

/// `ThumbnailField`'s own state: the preview that failed to load, the size
/// the loaded preview measured, and an import failure.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThumbnailField {
    pub broken_id: Option<String>,
    pub size: Option<(String, u32, u32)>,
    pub error: String,
}

/// What the field shows for its asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThumbnailView {
    /// Show the preview image.
    pub preview: bool,
    /// [`copy::THUMBNAIL_MISSING`] under it.
    pub missing: bool,
    pub choose_label: &'static str,
    pub remove: bool,
    pub error: Option<String>,
    /// [`copy::NOT_SIXTEEN_NINE`].
    pub not_sixteen_nine: bool,
}

impl ThumbnailField {
    pub fn choose_started(&mut self) {
        self.error.clear();
    }
    /// A picked image: the same bytes keep the same id, so a missing preview
    /// is tried again (#1494).
    pub fn picked(&mut self) {
        self.broken_id = None;
    }
    pub fn import_failed(&mut self, message: &str) {
        self.error = message.to_string();
    }
    pub fn removed(&mut self) {
        self.error.clear();
    }
    pub fn preview_failed(&mut self, asset_id: &str) {
        self.broken_id = Some(asset_id.to_string());
    }
    pub fn preview_loaded(&mut self, asset_id: &str, width: u32, height: u32) {
        self.size = Some((asset_id.to_string(), width, height));
    }

    pub fn view(&self, asset_id: Option<&str>, removable: bool) -> ThumbnailView {
        let asset_id = asset_id.filter(|id| !id.is_empty());
        let broken = asset_id.is_some() && self.broken_id.as_deref() == asset_id;
        let measured = self
            .size
            .as_ref()
            .filter(|(id, ..)| Some(id.as_str()) == asset_id);
        ThumbnailView {
            preview: asset_id.is_some() && !broken,
            missing: broken,
            choose_label: if asset_id.is_some() {
                copy::REPLACE_THUMBNAIL
            } else {
                copy::CHOOSE_THUMBNAIL
            },
            remove: asset_id.is_some() && removable,
            error: (!self.error.is_empty()).then(|| self.error.clone()),
            not_sixteen_nine: measured.is_some_and(|(_, w, h)| !is_sixteen_by_nine(*w, *h)),
        }
    }
}

/// `isMetadataPlatform`.
pub fn is_metadata_platform(platform: &str) -> bool {
    matches!(platform, "youtube" | "twitch" | "kick" | "x")
}

/// `visibleMetadataOverrides`: one row per native destination in use, in
/// Destinations order, labelled by the first matching destination.
pub fn visible_overrides(
    targets: &[Target],
    overrides: &[TargetDraft],
) -> Vec<(TargetDraft, String)> {
    let mut seen: Vec<&str> = Vec::new();
    let mut visible = Vec::new();
    for target in targets {
        let platform = target.platform.as_str();
        if !target.enabled || !is_metadata_platform(platform) || seen.contains(&platform) {
            continue;
        }
        seen.push(platform);
        if let Some(draft) = overrides.iter().find(|o| o.platform == platform) {
            let label = super::accounts::destination_label(target.label.trim());
            let label = if label.is_empty() {
                super::accounts::platform_label(platform).to_string()
            } else {
                label
            };
            visible.push((draft.clone(), label));
        }
    }
    visible
}

/// `metadataOverrideSummary`.
pub fn override_summary(default_privacy: Privacy, draft: &TargetDraft) -> String {
    let mut parts: Vec<String> = vec![
        if draft.customize {
            copy::OWN_TITLE
        } else {
            copy::SHARED_TITLE
        }
        .to_string(),
    ];
    match draft.platform.as_str() {
        "youtube" => {
            parts.push(
                if draft.customize {
                    draft.privacy
                } else {
                    default_privacy
                }
                .label()
                .to_string(),
            );
            if draft.youtube_made_for_kids == Some(true) {
                parts.push(copy::MADE_FOR_KIDS.to_string());
            }
        }
        "twitch" => {
            if let Some(category) = draft.twitch_category_name.as_deref().map(str::trim)
                && !category.is_empty()
            {
                parts.push(category.to_string());
            }
            if let Some(language) = draft
                .twitch_language
                .as_deref()
                .map(|l| l.trim().to_lowercase())
                && !language.is_empty()
                && language != "en"
            {
                parts.push(language);
            }
        }
        "kick" => {
            if let Some(category) = draft.kick_category_name.as_deref().map(str::trim)
                && !category.is_empty()
            {
                parts.push(category.to_string());
            }
        }
        "x" => parts.push(
            if draft.x_announce == Some(false) {
                copy::NO_ANNOUNCEMENT
            } else {
                copy::ANNOUNCES
            }
            .to_string(),
        ),
        _ => {}
    }
    parts.join(" · ")
}

/// `streamDetailsStatus`: the header's badge (tone, words).
pub fn details_status(
    dirty: bool,
    validation: Option<&Validation>,
) -> Option<(&'static str, String)> {
    if dirty {
        return Some(("neutral", copy::UNSAVED_CHANGES.to_string()));
    }
    let validation = validation?;
    if validation.valid {
        return Some(("good", copy::CHECKED.to_string()));
    }
    let count = validation.issues.len();
    Some((
        "warn",
        match count {
            1 => copy::ONE_DETAIL_NEEDS_ATTENTION.to_string(),
            0 => copy::NEEDS_ATTENTION.to_string(),
            count => copy::details_need_attention(count),
        },
    ))
}

/// `TWITCH_LANGUAGE_CODES` with their English names (`streamLanguageName`,
/// `Intl.DisplayNames(['en'])`), `other` last.
const LANGUAGES: [(&str, &str); 35] = [
    ("ar", "Arabic"),
    ("bg", "Bulgarian"),
    ("ca", "Catalan"),
    ("cs", "Czech"),
    ("da", "Danish"),
    ("de", "German"),
    ("el", "Greek"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("hu", "Hungarian"),
    ("id", "Indonesian"),
    ("it", "Italian"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("ms", "Malay"),
    ("nl", "Dutch"),
    ("no", "Norwegian"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("sv", "Swedish"),
    ("th", "Thai"),
    ("tl", "Tagalog"),
    ("tr", "Turkish"),
    ("uk", "Ukrainian"),
    ("vi", "Vietnamese"),
    ("zh", "Chinese"),
    ("zh-hk", "Chinese (Hong Kong)"),
    ("asl", "American Sign Language"),
    ("other", "Other"),
];

/// `streamLanguageOptions(current)`: by name, `other` last; a saved code
/// Twitch's list lacks joins under its own code.
pub fn language_options(current: Option<&str>) -> Vec<(String, String)> {
    let mut options: Vec<(String, String)> = LANGUAGES
        .iter()
        .map(|(code, name)| (code.to_string(), name.to_string()))
        .collect();
    if let Some(saved) = current.map(|c| c.trim().to_lowercase())
        && !saved.is_empty()
        && !options.iter().any(|(code, _)| *code == saved)
    {
        options.push((saved.clone(), saved));
    }
    options.sort_by(|a, b| match (a.0.as_str(), b.0.as_str()) {
        ("other", _) => std::cmp::Ordering::Greater,
        (_, "other") => std::cmp::Ordering::Less,
        _ => a.1.cmp(&b.1),
    });
    options
}

/// `categoryComboboxStatus`.
pub fn category_status(
    query: &str,
    pending: bool,
    results: usize,
    searched: Option<&str>,
) -> Option<String> {
    if query.trim().chars().count() < 2 {
        return Some(copy::TYPE_TO_SEARCH.to_string());
    }
    if pending || searched != Some(query.trim()) {
        return Some(copy::SEARCHING.to_string());
    }
    (results == 0).then(|| copy::NO_CATEGORIES.to_string())
}

/// `customTextHint`.
pub fn custom_text_hint(customize: bool, youtube: bool, label: &str) -> String {
    match (customize, youtube) {
        (true, true) => copy::replaces_title_description_privacy(label),
        (true, false) => copy::replaces_title(label),
        (false, true) => copy::USES_TITLE_DESCRIPTION_PRIVACY.to_string(),
        (false, false) => copy::USES_TITLE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livestream::targets::Target;

    fn draft(platform: &str) -> TargetDraft {
        TargetDraft {
            platform: platform.into(),
            ..TargetDraft::default()
        }
    }

    #[test]
    fn the_fields_say_what_is_wrong_and_each_row_sums_itself_up() {
        assert_eq!(
            info_issues("", "", true).0.as_deref(),
            Some("Add a title before you go live.")
        );
        assert_eq!(info_issues("", "", false).0, None);
        assert_eq!(
            info_issues("a <b>", "", false).0.as_deref(),
            Some("Titles can't contain < or >.")
        );
        assert_eq!(title_counter("Hi"), "2/100");
        let youtube = TargetDraft {
            youtube_made_for_kids: Some(true),
            ..draft("youtube")
        };
        assert_eq!(
            override_summary(Privacy::Unlisted, &youtube),
            "Shared title · Unlisted · Made for kids"
        );
        let twitch = TargetDraft {
            customize: true,
            twitch_category_name: Some("Software and Game Development".into()),
            twitch_language: Some("DE".into()),
            ..draft("twitch")
        };
        assert_eq!(
            override_summary(Privacy::Private, &twitch),
            "Own title · Software and Game Development · de"
        );
        let x = TargetDraft {
            x_announce: Some(false),
            ..draft("x")
        };
        assert_eq!(
            override_summary(Privacy::Public, &x),
            "Shared title · No announcement"
        );
        assert_eq!(
            details_status(true, None),
            Some(("neutral", "Unsaved changes".to_string()))
        );
        assert_eq!(
            category_status("a", false, 0, None).as_deref(),
            Some("Type 2 or more letters to search.")
        );
        assert_eq!(
            category_status("ab", false, 0, Some("ab")).as_deref(),
            Some("No categories match.")
        );
        assert_eq!(category_status("ab", false, 3, Some("ab")), None);
    }

    #[test]
    fn rows_follow_the_destinations_in_use() {
        let target = |id: &str, platform: &str, enabled: bool| Target {
            id: id.into(),
            platform: platform.into(),
            label: id.into(),
            enabled,
            ..Target::default()
        };
        let targets = vec![
            target("Twitch", "twitch", true),
            target("YouTube", "youtube", false),
            target("Kick", "kick", true),
            target("Custom RTMP", "custom", true),
        ];
        let rows = visible_overrides(
            &targets,
            &[draft("youtube"), draft("twitch"), draft("kick"), draft("x")],
        );
        let names: Vec<&str> = rows
            .iter()
            .map(|(o, label)| {
                assert_eq!(o.platform.to_lowercase(), label.to_lowercase());
                label.as_str()
            })
            .collect();
        assert_eq!(names, ["Twitch", "Kick"]);
        let languages = language_options(Some("xx"));
        assert_eq!(languages.last().unwrap().0, "other");
        assert!(languages.iter().any(|(code, _)| code == "xx"));
    }

    #[test]
    fn a_re_picked_thumbnail_tries_a_missing_preview_again() {
        let mut field = ThumbnailField::default();
        field.preview_failed("a1");
        let view = field.view(Some("a1"), true);
        assert!(view.missing && !view.preview);
        assert_eq!(view.choose_label, "Replace thumbnail…");
        field.picked();
        assert!(field.view(Some("a1"), true).preview);

        field.preview_loaded("a1", 1000, 1000);
        assert!(field.view(Some("a1"), true).not_sixteen_nine);
        assert!(!field.view(Some("a2"), true).not_sixteen_nine);
        field.preview_loaded("a1", 1280, 720);
        assert!(!field.view(Some("a1"), true).not_sixteen_nine);
        assert!(is_sixteen_by_nine(0, 720));

        let empty = field.view(None, true);
        assert_eq!(empty.choose_label, "Choose thumbnail…");
        assert!(!empty.remove);
        field.import_failed("Not an image");
        assert_eq!(
            field.view(None, true).error.as_deref(),
            Some("Not an image")
        );
        field.choose_started();
        assert_eq!(field.view(None, true).error, None);
    }
}
