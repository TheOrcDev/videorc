//! The Alive creator's wire and rules (plan 168 S-F4, S-F5; plan 174
//! S3.15a): Electron's `shared/buddy-pet-creator.ts` (the fields this app
//! reads) and `lib/buddy-pet-creator-view.ts`, word for word. The backend
//! owns the creation; these only read it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use videorc_app_core::buddy::DEFAULT_AVATAR_NAME;

// --- The wire ------------------------------------------------------------------

/// The character's own side for a one-sided feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn value(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }

    pub fn from_value(value: &str) -> Self {
        if value == "right" {
            Self::Right
        } else {
            Self::Left
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asymmetry {
    pub feature: String,
    pub side: Side,
}

/// The identity notes (D19), as the backend reads and takes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notes {
    #[serde(default)]
    pub palette: Vec<String>,
    #[serde(default)]
    pub materials: Vec<String>,
    pub proportions: String,
    #[serde(default)]
    pub asymmetric: Vec<Asymmetry>,
}

/// One stored source: the reference or a sheet version.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Source {
    pub sheet: String,
    pub version: u32,
    /// Relative to the creation folder: `sources/<sheet>-v<n>.png`.
    pub file: String,
    #[serde(default)]
    pub opaque: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuildFailure {
    pub message: String,
    #[serde(default)]
    pub sheet: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    /// `built` or `failed`.
    pub state: String,
    pub fresh: bool,
    pub finished_at: String,
    #[serde(default)]
    pub error: Option<BuildFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Running {
    /// `start`, `identity`, `sheet`, `build` or `save`.
    pub job: String,
    #[serde(default)]
    pub sheet: Option<String>,
}

/// One creation as `cohost.pet.creation.status` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Creation {
    pub build_id: String,
    /// `reference`, `pilot`, `build` or `review`.
    pub step: String,
    #[serde(default)]
    pub expired: bool,
    pub pilots_allowed: u32,
    pub sheets_remaining: u32,
    pub redos_remaining: u32,
    pub pilots_used: u32,
    #[serde(default)]
    pub notes: Option<Notes>,
    #[serde(default)]
    pub pilot: Option<Source>,
    #[serde(default)]
    pub pilot_accepted: bool,
    #[serde(default)]
    pub sheets: Vec<Source>,
    #[serde(default)]
    pub build: Option<Build>,
    #[serde(default)]
    pub running: Option<Running>,
}

/// `cohost.pet.creation.status`, and what start and cancel answer.
#[derive(Debug, Clone, Deserialize)]
pub struct Status {
    #[serde(default)]
    pub creation: Option<Creation>,
}

/// A failed job in an event: a code and one plain sentence.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

/// `cohost.pet.identity.read`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRead {
    pub build_id: String,
    #[serde(default)]
    pub error: Option<JobError>,
}

/// `cohost.pet.sheet.generated`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetGenerated {
    pub build_id: String,
    pub sheet: String,
    #[serde(default)]
    pub error: Option<JobError>,
}

/// `cohost.pet.build.progress`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildProgress {
    pub build_id: String,
    /// `reading`, `cutting`, `registering`, `packing`, `writing`, then
    /// `done` or `failed`.
    pub step: String,
    #[serde(default)]
    pub sheet: Option<String>,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

impl BuildProgress {
    pub fn ended(&self) -> bool {
        self.step == "done" || self.step == "failed"
    }
}

pub const IDENTITY_READ_EVENT: &str = "cohost.pet.identity.read";
pub const SHEET_GENERATED_EVENT: &str = "cohost.pet.sheet.generated";
pub const BUILD_PROGRESS_EVENT: &str = "cohost.pet.build.progress";

/// The pack name's bound (`BUDDY_PET_PACK_NAME_MAX_CHARS`).
pub const PACK_NAME_MAX_CHARS: usize = 64;
const NOTES_LIST_MAX: usize = 8;
const NOTES_ITEM_MAX_CHARS: usize = 60;
const NOTES_PROPORTIONS_MAX_CHARS: usize = 400;
const NOTES_ASYMMETRIC_MAX: usize = 12;
const NOTES_FEATURE_MAX_CHARS: usize = 80;

// --- The steps -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Reference,
    Pilot,
    Build,
    Review,
    Save,
}

/// `BUDDY_PET_CREATOR_STEPS`: the ids stay the backend's, the labels the
/// streamer's.
pub const STEPS: [(Step, &str); 5] = [
    (Step::Reference, "Picture"),
    (Step::Pilot, "First poses"),
    (Step::Build, "All poses"),
    (Step::Review, "Check"),
    (Step::Save, "Save"),
];

/// `buddyPetCreatorStep`: the backend's step, with the notes still on the
/// picture step until a pilot exists, and Save once the streamer moved on
/// from a complete review.
pub fn creator_step(creation: Option<&Creation>, naming: bool) -> Step {
    let Some(creation) = creation else {
        return Step::Reference;
    };
    match creation.step.as_str() {
        "pilot" if creation.pilot.is_some() => Step::Pilot,
        "build" => Step::Build,
        "review" if naming => Step::Save,
        "review" => Step::Review,
        _ => Step::Reference,
    }
}

/// `buddyPetNeedsNewCreation`: errors only a new creation fixes.
pub fn needs_new_creation(code: &str) -> bool {
    matches!(
        code,
        "pet-build-expired" | "pet-build-not-found" | "cohost-pet-creation-none"
    )
}

// --- Sheets --------------------------------------------------------------------

/// One atlas sheet: its key, the kind the web route names and its gaze row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtlasSheet {
    pub key: &'static str,
    pub kind: &'static str,
    pub row: Option<&'static str>,
}

/// `BUDDY_PET_ATLAS_SHEETS`: the eight sheets of a pack, in atlas order.
pub static ATLAS_SHEETS: [AtlasSheet; 8] = [
    gaze("gaze-up2", "up2"),
    gaze("gaze-up1", "up1"),
    gaze("gaze-level", "level"),
    gaze("gaze-down1", "down1"),
    gaze("gaze-down2", "down2"),
    AtlasSheet {
        key: "reactions-a",
        kind: "reactions-a",
        row: None,
    },
    AtlasSheet {
        key: "reactions-b",
        kind: "reactions-b",
        row: None,
    },
    AtlasSheet {
        key: "extras",
        kind: "extras",
        row: None,
    },
];

const fn gaze(key: &'static str, row: &'static str) -> AtlasSheet {
    AtlasSheet {
        key,
        kind: "gaze",
        row: Some(row),
    }
}

/// `BUDDY_PET_SHEET_LABELS`.
pub fn sheet_label(key: &str) -> &str {
    match key {
        "pilot" => "First poses",
        "gaze-up2" => "Looking up",
        "gaze-up1" => "Looking a little up",
        "gaze-level" => "Looking ahead",
        "gaze-down1" => "Looking a little down",
        "gaze-down2" => "Looking down",
        "reactions-a" => "Laugh to sleep",
        "reactions-b" => "Worried to calm",
        "extras" => "Talk and wave",
        other => other,
    }
}

/// `BUDDY_PET_PILOT_POSES`: the pilot's four poses, row-major.
pub const PILOT_POSES: [&str; 4] = ["Neutral", "Turned left", "Turned right", "Laughing"];

/// `buddyPetSheetSource`.
pub fn sheet_source<'a>(creation: &'a Creation, key: &str) -> Option<&'a Source> {
    creation.sheets.iter().find(|sheet| sheet.sheet == key)
}

/// `buddyPetNextSheet`: the first atlas sheet not made yet.
pub fn next_sheet(creation: &Creation) -> Option<AtlasSheet> {
    ATLAS_SHEETS
        .into_iter()
        .find(|sheet| sheet_source(creation, sheet.key).is_none())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheetPhase {
    Waiting,
    Making,
    Done,
    Failed,
}

/// One row of the Poses list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetRow {
    pub phase: SheetPhase,
    pub version: Option<u32>,
    pub opaque: bool,
    pub error: Option<String>,
}

/// `buddyPetSheetPhase`.
pub fn sheet_phase(creation: &Creation, key: &str, errors: &BTreeMap<String, String>) -> SheetRow {
    let source = sheet_source(creation, key);
    let version = source.map(|source| source.version);
    let making = creation
        .running
        .as_ref()
        .is_some_and(|running| running.job == "sheet" && running.sheet.as_deref() == Some(key));
    if making {
        return SheetRow {
            phase: SheetPhase::Making,
            version,
            opaque: false,
            error: None,
        };
    }
    if let Some(error) = errors.get(key) {
        return SheetRow {
            phase: SheetPhase::Failed,
            version,
            opaque: false,
            error: Some(error.clone()),
        };
    }
    match source {
        Some(source) => SheetRow {
            phase: SheetPhase::Done,
            version,
            opaque: source.opaque,
            error: None,
        },
        None => SheetRow {
            phase: SheetPhase::Waiting,
            version: None,
            opaque: false,
            error: None,
        },
    }
}

/// The row's meta word: "Drawing…", "Done", "Redone 2×", "Failed",
/// "Waiting".
pub fn sheet_meta(row: &SheetRow) -> String {
    match row.phase {
        SheetPhase::Making => "Drawing…".into(),
        SheetPhase::Done => match row.version {
            Some(version) if version > 1 => format!("Redone {}×", version - 1),
            _ => "Done".into(),
        },
        SheetPhase::Failed => "Failed".into(),
        SheetPhase::Waiting => "Waiting".into(),
    }
}

/// `buddyPetPilotsLeft`.
pub fn pilots_left(creation: &Creation) -> u32 {
    creation.pilots_allowed.saturating_sub(creation.pilots_used)
}

/// `plural`: "1 set", "3 redos".
pub fn plural(count: u32, word: &str) -> String {
    if count == 1 {
        format!("{count} {word}")
    } else {
        format!("{count} {word}s")
    }
}

/// The Poses section's description.
pub fn poses_description(creation: &Creation) -> String {
    format!(
        "Eight sets of poses, one at a time; each takes up to two minutes. {} and {} left in this creation.",
        plural(creation.sheets_remaining, "set"),
        plural(creation.redos_remaining, "redo")
    )
}

/// `buildStepCopy`.
pub fn build_step_copy(step: &str) -> &'static str {
    match step {
        "reading" => "Reading",
        "cutting" => "Cutting",
        "registering" => "Lining up",
        "packing" => "Packing",
        _ => "Writing",
    }
}

/// The Moves progress line: "Cutting Looking up · 3 of 40".
pub fn build_progress_line(progress: &BuildProgress) -> String {
    let sheet = progress
        .sheet
        .as_deref()
        .map(|sheet| format!(" {}", sheet_label(sheet)))
        .unwrap_or_default();
    format!(
        "{}{sheet} · {} of {}",
        build_step_copy(&progress.step),
        progress.done,
        progress.total
    )
}

// --- Check ---------------------------------------------------------------------

/// One row the streamer marks (D21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRow {
    pub key: &'static str,
    /// Frame ids, left to right.
    pub cells: Vec<String>,
    /// Captions under reactions and extras (gaze cells carry arrows).
    pub captions: Option<Vec<String>>,
    /// The gaze grid's row, 0 (up) to 4 (down).
    pub gaze_row: Option<usize>,
}

const REACTIONS_A: [&str; 6] = ["laugh", "surprised", "wink", "kiss", "blink", "sleep"];
const REACTIONS_B: [&str; 6] = ["worried", "annoyed", "proud", "confused", "excited", "calm"];
const EXTRAS: [&str; 3] = ["talk-a", "talk-b", "wave"];

fn caption(id: &str) -> String {
    match id {
        "talk-a" => "Talk".into(),
        "talk-b" => "Talk, half".into(),
        _ => {
            let mut chars = id.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        }
    }
}

/// `BUDDY_PET_REVIEW_ROWS`: five gaze rows, the two reaction sheets and the
/// extras.
pub fn review_rows() -> Vec<ReviewRow> {
    let mut rows: Vec<ReviewRow> = ATLAS_SHEETS[..5]
        .iter()
        .enumerate()
        .map(|(row, sheet)| ReviewRow {
            key: sheet.key,
            cells: (0..5).map(|col| format!("gaze-{col}-{row}")).collect(),
            captions: None,
            gaze_row: Some(row),
        })
        .collect();
    for (key, cells) in [
        ("reactions-a", &REACTIONS_A[..]),
        ("reactions-b", &REACTIONS_B[..]),
        ("extras", &EXTRAS[..]),
    ] {
        rows.push(ReviewRow {
            key,
            cells: cells.iter().map(|cell| cell.to_string()).collect(),
            captions: Some(cells.iter().map(|cell| caption(cell)).collect()),
            gaze_row: None,
        });
    }
    rows
}

/// Which version of each row "Looks right" was given to. A redo makes a new
/// version, so its row reads as unmarked until it is marked again.
pub type Marks = BTreeMap<String, u32>;

/// `buddyPetRowMarked`.
pub fn row_marked(marks: &Marks, creation: &Creation, key: &str) -> bool {
    sheet_source(creation, key).is_some_and(|source| marks.get(key) == Some(&source.version))
}

/// `buddyPetMarkRow`.
pub fn mark_row(marks: &mut Marks, creation: &Creation, key: &str, marked: bool) {
    match sheet_source(creation, key) {
        Some(source) if marked => {
            marks.insert(key.to_string(), source.version);
        }
        _ => {
            marks.remove(key);
        }
    }
}

/// `buddyPetMarkedCount`.
pub fn marked_count(marks: &Marks, creation: &Creation) -> usize {
    ATLAS_SHEETS
        .iter()
        .filter(|sheet| row_marked(marks, creation, sheet.key))
        .count()
}

/// `buddyPetCanSave`: a fresh build and every row marked "Looks right".
pub fn can_save(marks: &Marks, creation: &Creation) -> bool {
    creation.step == "review"
        && creation
            .build
            .as_ref()
            .is_some_and(|build| build.state == "built" && build.fresh)
        && marked_count(marks, creation) == ATLAS_SHEETS.len()
}

/// "5 of 8 rows look right".
pub fn marked_line(count: usize) -> String {
    format!("{count} of {} rows look right", ATLAS_SHEETS.len())
}

/// Where a gaze cell should look (`buddyPetGazeArrow`): column 0 is the
/// viewer's left, row 0 is up; the centre looks at you.
#[derive(Debug, Clone, PartialEq)]
pub struct GazeArrow {
    pub center: bool,
    pub degrees: f32,
    pub label: String,
}

pub fn gaze_arrow(col: usize, row: usize) -> GazeArrow {
    // In half steps: -2 (far left or up) to 2 (far right or down).
    let x = col as i32 - 2;
    let y = row as i32 - 2;
    if x == 0 && y == 0 {
        return GazeArrow {
            center: true,
            degrees: 0.,
            label: "Looking at you".into(),
        };
    }
    let vertical = match y.signum() {
        -1 => "up",
        1 => "down",
        _ => "",
    };
    let horizontal = match x.signum() {
        -1 => "left",
        1 => "right",
        _ => "",
    };
    let strength = if x.abs().max(y.abs()) == 2 {
        ""
    } else {
        "a little "
    };
    let direction = [vertical, horizontal]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" and ");
    GazeArrow {
        center: false,
        degrees: (y as f32).atan2(x as f32).to_degrees().round(),
        label: format!("Looking {strength}{direction}"),
    }
}

// --- The notes as editable sentences ------------------------------------------

/// The notes as the fields hold them: comma-separated lists, the
/// proportions, and the one-sided features.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesDraft {
    pub palette: String,
    pub materials: String,
    pub proportions: String,
    pub asymmetric: Vec<(String, Side)>,
}

/// `buddyPetNotesDraft`.
pub fn notes_draft(notes: &Notes) -> NotesDraft {
    NotesDraft {
        palette: notes.palette.join(", "),
        materials: notes.materials.join(", "),
        proportions: notes.proportions.clone(),
        asymmetric: notes
            .asymmetric
            .iter()
            .map(|item| (item.feature.clone(), item.side))
            .collect(),
    }
}

fn split_list(text: &str) -> Vec<String> {
    text.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn length(text: &str) -> usize {
    text.chars().count()
}

/// `buddyPetNotesFromDraft`: the notes the backend takes, or the one thing
/// to fix.
pub fn notes_from_draft(draft: &NotesDraft) -> Result<Notes, String> {
    let palette = split_list(&draft.palette);
    let materials = split_list(&draft.materials);
    for (items, what) in [(&palette, "colors"), (&materials, "materials")] {
        if items.len() > NOTES_LIST_MAX {
            return Err(format!("List at most {NOTES_LIST_MAX} {what}."));
        }
        if items.iter().any(|item| length(item) > NOTES_ITEM_MAX_CHARS) {
            return Err(format!(
                "Keep each of the {what} under {} characters.",
                NOTES_ITEM_MAX_CHARS + 1
            ));
        }
    }
    let proportions = draft.proportions.trim();
    if proportions.is_empty() {
        return Err("Describe its proportions.".into());
    }
    if length(proportions) > NOTES_PROPORTIONS_MAX_CHARS {
        return Err(format!(
            "Keep the proportions under {} characters.",
            NOTES_PROPORTIONS_MAX_CHARS + 1
        ));
    }
    let asymmetric: Vec<Asymmetry> = draft
        .asymmetric
        .iter()
        .map(|(feature, side)| Asymmetry {
            feature: feature.trim().to_string(),
            side: *side,
        })
        .filter(|item| !item.feature.is_empty())
        .collect();
    if asymmetric.len() > NOTES_ASYMMETRIC_MAX {
        return Err(format!(
            "List at most {NOTES_ASYMMETRIC_MAX} one-sided features."
        ));
    }
    if asymmetric
        .iter()
        .any(|item| length(&item.feature) > NOTES_FEATURE_MAX_CHARS)
    {
        return Err(format!(
            "Keep each feature under {} characters.",
            NOTES_FEATURE_MAX_CHARS + 1
        ));
    }
    Ok(Notes {
        palette,
        materials,
        proportions: proportions.to_string(),
        asymmetric,
    })
}

/// `buddyPetNameToSave`: the pack name as saved, or None.
pub fn name_to_save(draft: &str) -> Option<String> {
    let name = draft.trim();
    (!name.is_empty() && length(name) <= PACK_NAME_MAX_CHARS).then(|| name.to_string())
}

/// A user avatar id: the web's lowercase hyphenated uuid
/// (`isBuddyUserAvatarId`).
fn user_avatar_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, len)| {
            part.len() == len
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

/// `buddyPetSaveDescription`: where the new moves are kept.
pub fn save_description(
    name: &str,
    library_avatar_id: Option<&str>,
    web_keeps_moves: bool,
) -> String {
    let name = match name.trim() {
        "" => DEFAULT_AVATAR_NAME,
        name => name,
    };
    let wears = format!("{name} wears them right away; switch back to Still any time.");
    if web_keeps_moves && library_avatar_id.is_some_and(user_avatar_id) {
        format!(
            "Saved on this computer and in your Videorc account, so {name} moves on any computer. {wears}"
        )
    } else {
        format!("Saved on this computer. {wears}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn creation(value: serde_json::Value) -> Creation {
        let mut base = json!({
            "buildId": "b1",
            "step": "build",
            "expired": false,
            "pilotsAllowed": 3,
            "sheetsRemaining": 8,
            "redosRemaining": 4,
            "pilotsUsed": 1,
            "pilotAccepted": true,
            "sheets": []
        });
        for (key, field) in value.as_object().unwrap() {
            base[key] = field.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn source(sheet: &str, version: u32) -> serde_json::Value {
        json!({ "sheet": sheet, "version": version, "file": format!("sources/{sheet}-v{version}.png"), "sha256": "x", "opaque": false, "createdAt": "t" })
    }

    #[test]
    fn the_step_follows_the_backend() {
        assert_eq!(creator_step(None, false), Step::Reference);
        let pilot_less = creation(json!({ "step": "pilot" }));
        assert_eq!(creator_step(Some(&pilot_less), false), Step::Reference);
        let pilot = creation(json!({ "step": "pilot", "pilot": source("pilot", 1) }));
        assert_eq!(creator_step(Some(&pilot), false), Step::Pilot);
        let review = creation(json!({ "step": "review" }));
        assert_eq!(creator_step(Some(&review), false), Step::Review);
        assert_eq!(creator_step(Some(&review), true), Step::Save);
        assert_eq!(
            STEPS.map(|(_, label)| label),
            ["Picture", "First poses", "All poses", "Check", "Save"]
        );
        assert!(needs_new_creation("pet-build-expired"));
        assert!(!needs_new_creation("failed"));
    }

    #[test]
    fn sheets_come_in_atlas_order_with_their_phase() {
        let made = creation(json!({
            "sheets": [source("gaze-up2", 1), source("gaze-up1", 3)],
            "running": { "job": "sheet", "sheet": "gaze-level" }
        }));
        assert_eq!(next_sheet(&made).map(|sheet| sheet.key), Some("gaze-level"));
        let errors = BTreeMap::from([("gaze-down1".to_string(), "No.".to_string())]);
        assert_eq!(
            sheet_phase(&made, "gaze-level", &errors).phase,
            SheetPhase::Making
        );
        assert_eq!(
            sheet_phase(&made, "gaze-down1", &errors).phase,
            SheetPhase::Failed
        );
        assert_eq!(
            sheet_phase(&made, "extras", &errors).phase,
            SheetPhase::Waiting
        );
        let redone = sheet_phase(&made, "gaze-up1", &errors);
        assert_eq!(sheet_meta(&redone), "Redone 2×");
        assert_eq!(sheet_meta(&sheet_phase(&made, "gaze-up2", &errors)), "Done");
        assert_eq!(
            poses_description(&made),
            "Eight sets of poses, one at a time; each takes up to two minutes. 8 sets and 4 redos left in this creation."
        );
        assert_eq!(pilots_left(&made), 2);
        assert_eq!(ATLAS_SHEETS[2].row, Some("level"));
    }

    #[test]
    fn a_redo_unmarks_its_row_until_it_is_marked_again() {
        let mut made = creation(json!({
            "step": "review",
            "build": { "state": "built", "fresh": true, "finishedAt": "t" },
            "sheets": ATLAS_SHEETS.iter().map(|sheet| source(sheet.key, 1)).collect::<Vec<_>>()
        }));
        let mut marks = Marks::new();
        for sheet in ATLAS_SHEETS {
            mark_row(&mut marks, &made, sheet.key, true);
        }
        assert!(can_save(&marks, &made));
        assert_eq!(
            marked_line(marked_count(&marks, &made)),
            "8 of 8 rows look right"
        );
        made.sheets[0].version = 2;
        assert!(!row_marked(&marks, &made, "gaze-up2"));
        assert!(!can_save(&marks, &made));
        mark_row(&mut marks, &made, "gaze-up1", false);
        assert_eq!(marked_count(&marks, &made), 6);
    }

    #[test]
    fn the_review_rows_and_their_arrows() {
        let rows = review_rows();
        assert_eq!(rows.len(), 8);
        assert_eq!(rows[0].cells[0], "gaze-0-0");
        assert_eq!(rows[4].cells[4], "gaze-4-4");
        assert_eq!(
            rows[7].captions.clone().unwrap(),
            vec!["Talk", "Talk, half", "Wave"]
        );
        assert_eq!(rows[5].captions.clone().unwrap()[1], "Surprised");
        assert!(gaze_arrow(2, 2).center);
        assert_eq!(gaze_arrow(0, 0).label, "Looking up and left");
        assert_eq!(gaze_arrow(3, 2).label, "Looking a little right");
        assert_eq!(gaze_arrow(4, 2).degrees, 0.);
        assert_eq!(gaze_arrow(2, 4).degrees, 90.);
    }

    #[test]
    fn the_notes_round_trip_and_say_what_to_fix() {
        let notes = Notes {
            palette: vec!["grey".into(), "moss green".into()],
            materials: vec!["stone".into()],
            proportions: "Squat, big hands".into(),
            asymmetric: vec![Asymmetry {
                feature: "Lantern".into(),
                side: Side::Left,
            }],
        };
        let mut draft = notes_draft(&notes);
        assert_eq!(draft.palette, "grey, moss green");
        assert_eq!(notes_from_draft(&draft), Ok(notes));
        draft.asymmetric.push(("  ".into(), Side::Right));
        assert_eq!(notes_from_draft(&draft).unwrap().asymmetric.len(), 1);
        draft.proportions = " ".into();
        assert_eq!(
            notes_from_draft(&draft),
            Err("Describe its proportions.".into())
        );
        draft.proportions = "ok".into();
        draft.palette = (0..9).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        assert_eq!(
            notes_from_draft(&draft),
            Err("List at most 8 colors.".into())
        );
        assert_eq!(serde_json::to_value(Side::Right).unwrap(), json!("right"));
    }

    #[test]
    fn the_save_line_says_where_the_moves_live() {
        assert_eq!(
            save_description("Grum", Some("official:orc"), true),
            "Saved on this computer. Grum wears them right away; switch back to Still any time."
        );
        assert_eq!(
            save_description(" ", Some("0c2a1f3e-1b2c-4d5e-8f90-123456789abc"), true),
            "Saved on this computer and in your Videorc account, so Flint moves on any computer. Flint wears them right away; switch back to Still any time."
        );
        assert_eq!(name_to_save("  Moves "), Some("Moves".into()));
        assert_eq!(name_to_save(&"x".repeat(65)), None);
        assert_eq!(build_step_copy("registering"), "Lining up");
    }
}
