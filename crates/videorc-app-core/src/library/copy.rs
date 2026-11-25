//! The Library's words, byte for byte with Electron's
//! (`components/tabs/library-tab.tsx`, `session-markers-dialog.tsx`,
//! `lib/library-view.ts`, `lib/session-finalization.ts`,
//! `lib/separate-source-recordings-view.ts`). Checked against today's
//! renderer for plan 260 S1.6f; the tests below hold the drifted ones.

pub const TITLE: &str = "Library";
pub const DESCRIPTION: &str = "Every recording and livestream you make. Files stay on disk.";
/// The Local | Cloud strip's accessible name.
pub const VIEW_LABEL: &str = "Library view";

// The filter bar.
pub const FILTER_LABEL: &str = "Filter";
pub const SORT_LABEL: &str = "Sort";
pub const SEARCH_LABEL: &str = "Search recordings";
pub const SEARCH_PLACEHOLDER: &str = "Search recordings…";
pub const IMPORT: &str = "Import…";
pub const IMPORTING: &str = "Importing…";
pub const OPEN_STUDIO: &str = "Open Studio";

pub const FILTER_ALL: &str = "All recordings";
pub const FILTER_RECORDINGS: &str = "Recorded";
pub const FILTER_STREAMS: &str = "Livestreamed";
pub const SORT_NEWEST: &str = "Newest first";
pub const SORT_OLDEST: &str = "Oldest first";

// The selection bar.
pub const DELETE: &str = "Delete";
pub const CLEAR_SELECTION: &str = "Clear selection";

// The list's states.
pub const LOADING_RECORDINGS: &str = "Loading recordings…";
pub const EMPTY_TITLE: &str = "No recordings yet";
pub const EMPTY_DESCRIPTION: &str = "Record or go live from Studio, and it shows up here.";
pub const NO_MATCH_TITLE: &str = "No recordings match";
pub const CLEAR_SEARCH_AND_FILTER: &str = "Clear search and filter";
pub const CLEAR_FILTER: &str = "Clear filter";
pub const CLEAR_SEARCH: &str = "Clear search";
pub const LOAD_ALL: &str = "Load all";
pub const LOADING: &str = "Loading…";
pub const LOAD_MORE: &str = "Load more";

// The table.
pub const RECORDINGS_LABEL: &str = "Recordings";
pub const SELECT_ALL_LABEL: &str = "Select all recordings in view";
pub const COLUMN_NAME: &str = "Name";
pub const COLUMN_SCENE: &str = "Scene";
pub const COLUMN_DURATION: &str = "Duration";
pub const COLUMN_SIZE: &str = "Size";
pub const COLUMN_FILE: &str = "File";
pub const COLUMN_ACTIONS: &str = "Actions";
pub const UNTITLED_RECORDING: &str = "Untitled recording";
pub const NO_LOCAL_FILE: &str = " · no local file";
pub const NOISE_CLEANED: &str = "Noise cleaned";
pub const MP4_FAILED: &str = "MP4 failed";
pub const PLAY_RECORDING: &str = "Play recording";
pub const PLAY_IN_DEFAULT_PLAYER: &str = "Play in the default player";
pub const SESSION_ACTIONS: &str = "Session actions";
pub const PLAY_WAITS_FOR_END: &str = "Available when the recording ends.";
pub const NO_FILE_TO_PLAY: &str = "No file to play yet.";

// The row's menu.
pub const MENU_PLAY: &str = "Play";
pub const MENU_BUDDY_REPORT: &str = "Sidekick report";
/// S3.10c: Buddy → Clean cut on this recording, and its finished cut.
pub const MENU_CLEAN_CUT: &str = "Make a clean cut…";
pub const MENU_REVIEW_CLEAN_CUT: &str = "Review clean cut";
/// `libraryCleanCutChip`: "Cut queued", "Cutting 40%".
pub const CUT_QUEUED: &str = "Cut queued";
pub fn cutting(percent: u32) -> String {
    format!("Cutting {percent}%")
}
/// The chip's hint: "Clean cut: Transcribing 40%".
pub fn clean_cut_hint(status: &str) -> String {
    format!("Clean cut: {status}")
}
pub const MENU_MARKERS: &str = "Markers";
pub const SHOW_ORIGINAL_MP4_SAVING: &str = "Show original · MP4 is saving";
pub const RETRY_MP4_EXPORT: &str = "Retry MP4 export";
pub const EXPORT_MP4: &str = "Export MP4";
pub const OPEN_IN_STREAM_MANAGER: &str = "Open in Stream Manager";
pub const RENAME_ELLIPSIS: &str = "Rename…";
pub const DUPLICATE: &str = "Duplicate";
pub const DUPLICATING: &str = "Duplicating…";
pub const CHECK_QUALITY: &str = "Check quality";
pub const CHECKING: &str = "Checking…";
pub const REPAIR_AND_FIX: &str = "Repair & fix";
pub const REPAIRING: &str = "Repairing…";
pub const RESTORE_ORIGINAL: &str = "Restore original";

// Holds (`lib/library-view.ts`).
pub const CAPTURE_HOLD_REASON: &str = "Available when you stop recording or end the livestream.";
pub const CLEAN_CUT_HOLD_REASON: &str = "Cancel or finish Clean cut first.";
pub const NOISE_CLEANUP_HOLD_REASON: &str = "Cancel or finish noise cleanup first.";

// The rename dialog.
pub const RENAME_TITLE: &str = "Rename recording";
pub const RENAME_DESCRIPTION: &str = "The file on disk keeps its name.";
pub const RECORDING_NAME_LABEL: &str = "Recording name";
pub const CANCEL: &str = "Cancel";
pub const RENAME: &str = "Rename";

// The delete question.
pub const DELETING: &str = "Deleting…";

// Quality (`libraryQualityChip`).
pub const QUALITY_ISSUES: &str = "Quality issues";
pub const QUALITY_SAMPLED_DETAIL: &str = "Quick check (long recording): some of the sampled parts aren't 100%. Choose Check quality in its menu for a full check.";
pub const QUALITY_DETAIL: &str =
    "Some of it isn't 100%. Choose Check quality in its menu for the details.";
pub const NOT_CHECKED: &str = "Not checked";
pub const NOT_CHECKED_DETAIL: &str =
    "The last quality check couldn't finish. Choose Check quality to run it again.";

// The check, the repair and the restore's toasts.
pub const NO_PROBLEMS_FOUND: &str = "No problems found";
pub const REPAIRED_INTERPOLATED: &str = "Repaired with interpolated frames";
pub const RECORDING_REPAIRED: &str = "Recording repaired";
pub const COULDNT_FULLY_REPAIR: &str = "Couldn't fully repair the recording";
pub const ORIGINAL_UNCHANGED: &str = "The original is unchanged.";
pub const COULDNT_CHECK: &str = "Couldn't check the recording";
pub const CHECK_AGAIN_ADVICE: &str =
    "Try again. If it keeps happening, export a support bundle from Health.";
pub const RETRY: &str = "Retry";
pub const RESTORED_ORIGINAL: &str = "Restored the original recording from backup";
pub const NO_BACKUP_FOUND: &str = "No backup found for this recording";

// `lib/session-finalization.ts`.
pub const RECOVERED: &str = "Recovered";
pub const RECOVERED_DETAIL: &str = "This recording ended early. Everything up to that moment was saved as MP4; the original MKV is kept.";
pub const DIDNT_START: &str = "Didn't start";
pub const DIDNT_START_DETAIL: &str =
    "This recording stopped before it started, so there is no file.";
pub const SAVING_MP4: &str = "Saving MP4…";

// `lib/separate-source-recordings-view.ts`.
pub const ROLE_COMBINED: &str = "Combined";
pub const ROLE_SCREEN: &str = "Screen";
pub const ROLE_CAMERA: &str = "Camera";
pub const ROLE_NOTE_COMBINED: &str = "combined take";
pub const ROLE_NOTE_SCREEN: &str = "screen, system audio track";
pub const ROLE_NOTE_CAMERA: &str = "camera, microphone track";
pub const STOPPED_EARLY: &str = "Stopped early";
pub const NOT_SAVED: &str = "Not saved";
pub const NOTHING_TO_EXPORT: &str = "Nothing usable was recorded before this file stopped.";
pub const FAILURE_CAMERA_CAPTURE: &str =
    "The camera stopped sending video and couldn't be restarted.";
pub const FAILURE_SCREEN_CAPTURE: &str =
    "The screen stopped sending video and couldn't be restarted.";
pub const FAILURE_ENCODER: &str = "Videorc couldn't keep encoding this file.";
pub const FAILURE_WRITER: &str = "Videorc couldn't keep writing this file.";
pub const FAILURE_AUDIO: &str = "This file's audio stopped.";
pub const FAILURE_SHORT: &str = "This file ended before the take did.";
pub const FAILURE_MISSING: &str = "This file wasn't there when you stopped recording.";
pub const FAILURE_PLACEMENT: &str = "Videorc couldn't place this file beside your recording.";
pub const FAILURE_OWNERSHIP: &str = "Videorc couldn't confirm this file after it restarted.";
pub const FAILURE_INTERRUPTED: &str = "Videorc closed before this file finished.";

// The markers dialog (`session-markers-dialog.tsx`).
pub const MARKERS_DESCRIPTION: &str =
    "Points on the recording's timeline. Choose one to jump to it.";
pub const STILL_RECORDING: &str = "Still recording. Playback opens when the recording ends.";
pub const NO_VIDEO_FILE: &str =
    "This recording has no video file. Its marker times are still saved.";
pub const SAVED_MARKERS: &str = "Saved markers";
pub const MARKER_TITLE_LABEL: &str = "Marker title";
pub const SAVE: &str = "Save";
pub const UNTITLED_MARKER: &str = "Untitled marker";
pub const LOADING_MARKERS: &str = "Loading markers…";
pub const NO_MARKERS_TITLE: &str = "No markers yet";
pub const NO_MARKERS_DESCRIPTION: &str = "While you record, type /marker and a title in Stream Manager, or say “Sidekick, make a marker here for” and the title.";
pub const LOAD_MORE_MARKERS: &str = "Load more markers";
pub const COULDNT_LOAD_MARKERS: &str = "Couldn't load the markers";
pub const COULDNT_RENAME_MARKER: &str = "Couldn't rename the marker";
pub const COULDNT_DELETE_MARKER: &str = "Couldn't delete the marker";
pub const NO_ANSWER: &str = "Videorc didn't answer. Try again in a moment.";
pub const MARKER_FAILURE_FALLBACK: &str =
    "Try again. If it keeps happening, export a support bundle from Health.";
pub const UNDO: &str = "Undo";
pub const MARKER_SOURCE_VOICE: &str = "Voice";
pub const MARKER_SOURCE_TYPED: &str = "Typed";
pub const MARKER_FALLBACK_NAME: &str = "marker";

/// `trashName()`: the Recycle Bin on Windows, the Trash elsewhere.
pub fn trash_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "Recycle Bin"
    } else {
        "Trash"
    }
}

/// The delete question's title (`library-tab.tsx`'s ConfirmDialog).
pub fn delete_title(count: usize) -> String {
    if count == 1 {
        format!("Move this recording to the {}?", trash_name())
    } else {
        format!("Move {count} recordings to the {}?", trash_name())
    }
}

/// The delete question's line: only the video file can come back.
pub fn delete_description(count: usize) -> String {
    if count == 1 {
        format!(
            "The video file goes to the {}. Its Library entry, markers, Sidekick report and chat history are deleted and can't be restored.",
            trash_name()
        )
    } else {
        format!(
            "The video files go to the {}. Their Library entries, markers, Sidekick reports and chat history are deleted and can't be restored.",
            trash_name()
        )
    }
}

/// The delete question's button.
pub fn delete_confirm_label(pending: bool) -> String {
    if pending {
        DELETING.to_string()
    } else {
        format!("Move to {}", trash_name())
    }
}

/// "Recording moved to the Trash", or the count.
pub fn deleted_toast(count: usize) -> String {
    if count == 1 {
        format!("Recording moved to the {}", trash_name())
    } else {
        format!("{count} recordings moved to the {}", trash_name())
    }
}

/// The bulk delete's "and 3 more".
pub fn and_more(count: usize) -> String {
    format!("and {count} more")
}

/// "2 selected".
pub fn selected_count(count: usize) -> String {
    format!("{count} selected")
}

/// The failed delete's title (`toastUserError`'s `move … to the Trash`).
pub fn move_to_trash_object(count: usize) -> String {
    format!(
        "{} to the {}",
        if count == 1 {
            "the recording"
        } else {
            "the recordings"
        },
        trash_name()
    )
}

/// `deleteSessions`' refusal when a file could not move.
pub fn files_kept(failed: usize) -> String {
    format!(
        "{} be moved to the {}, so {} kept.",
        crate::format::plural(failed as i64, "file couldn't", Some("files couldn't")),
        trash_name(),
        if failed == 1 {
            "its recording was"
        } else {
            "their recordings were"
        }
    )
}

/// The markers dialog's title.
pub fn markers_title(title: &str) -> String {
    format!("Markers · {title}")
}

/// The marker delete's toast.
pub fn marker_deleted(name: &str) -> String {
    format!("Marker deleted · {name}")
}

/// A row's checkbox name.
pub fn select_row(title: &str) -> String {
    format!("Select {title}")
}

/// A marker's Rename and Delete names.
pub fn rename_marker(label: Option<&str>) -> String {
    format!("Rename {}", label.unwrap_or(MARKER_FALLBACK_NAME))
}
pub fn delete_marker(label: Option<&str>) -> String {
    format!("Delete {}", label.unwrap_or(MARKER_FALLBACK_NAME))
}

/// The quality check's warning ("2 quality issues found").
pub fn quality_issues_found(count: usize) -> String {
    format!(
        "{} found",
        crate::format::plural(count as i64, "quality issue", None)
    )
}

/// The row's meta line notes.
pub fn cleaned_from(title: &str) -> String {
    format!(" · cleaned from {title}")
}
pub fn cut_from(title: &str) -> String {
    format!(" · cut from {title}")
}

/// The quality check's line when a repair can run: the first reason, then
/// where the repair is.
pub fn repair_available(first: Option<&str>) -> String {
    let first = first.map(|first| format!("{first} ")).unwrap_or_default();
    format!("{first}Repair is available from this menu.")
}

/// `separateFileFailedToast`'s names and sentences.
pub const CAMERA_FILE: &str = "Camera file";
pub const SCREEN_FILE: &str = "Screen file";
pub const SEPARATE_FILE: &str = "Separate file";
pub const FILE_NOT_FINISHED: &str = "Videorc couldn't finish this file.";
pub const COMBINED_KEEPS_GOING: &str = "Your Combined recording keeps going.";

#[cfg(test)]
pub(crate) mod tests {
    /// The renderer files these words come from. Listed in
    /// `scripts/lib/ci-change-scope.mjs`, so a change to one runs this test.
    const SOURCES: [&str; 7] = [
        include_str!("../../../../apps/desktop/src/renderer/src/components/tabs/library-tab.tsx"),
        include_str!("../../../../apps/desktop/src/renderer/src/components/tabs/library-table.tsx"),
        include_str!(
            "../../../../apps/desktop/src/renderer/src/components/session-markers-dialog.tsx"
        ),
        include_str!("../../../../apps/desktop/src/renderer/src/lib/library-view.ts"),
        include_str!("../../../../apps/desktop/src/renderer/src/lib/session-finalization.ts"),
        include_str!("../../../../apps/desktop/src/renderer/src/lib/session-player-view.ts"),
        include_str!(
            "../../../../apps/desktop/src/renderer/src/lib/separate-source-recordings-view.ts"
        ),
    ];

    /// The code without its comments: a word a comment still mentions is not
    /// one the renderer shows.
    fn code(text: &str) -> String {
        text.lines()
            .filter(|line| {
                let line = line.trim_start();
                !(line.starts_with("//") || line.starts_with("/*") || line.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// JSX wraps lines and writes `&apos;`; TS escapes quotes. Compare the
    /// words, not the layout.
    fn words(text: &str) -> String {
        text.replace("&apos;", "'")
            .replace("\\'", "'")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The `pub const …: &str` values of `source` (a module's text before
    /// its tests), one-line or wrapped by rustfmt, and the names whose words
    /// none of `renderer` has any more: (checked, missing).
    pub(crate) fn unseen_constants(source: &str, renderer: &[&str]) -> (usize, Vec<String>) {
        let renderer = words(&code(&renderer.join("\n")));
        let source = source.replace("&str =\n", "&str = ");
        let mut checked = 0;
        let mut missing = Vec::new();
        for line in source.lines() {
            let Some(rest) = line.trim().strip_prefix("pub const ") else {
                continue;
            };
            let Some((name, value)) = rest.split_once(": &str = ") else {
                continue;
            };
            let Some(value) = value
                .trim()
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix("\";"))
            else {
                continue;
            };
            checked += 1;
            if !renderer.contains(&words(&value.replace("\\\"", "\""))) {
                missing.push(name.to_string());
            }
        }
        (checked, missing)
    }

    /// Every `pub const …: &str` in this file is still the renderer's.
    #[test]
    fn every_constant_is_still_in_the_renderer() {
        let this = include_str!("copy.rs");
        let this = &this[..this.find("#[cfg(test)]").unwrap()];
        let (checked, missing) = unseen_constants(this, &SOURCES);
        assert!(
            checked > 40,
            "found {checked} constants; the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "not in the renderer any more: {missing:?}"
        );
    }
}
