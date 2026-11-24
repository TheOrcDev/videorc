//! Clean cut's kept drafts (plan 220 S3.10f; Electron's
//! `lib/clean-cut-drafts.ts`): unsaved edits survive every way out of the
//! review. Drafts are kept per job on this device, under the key and in the
//! shape Electron's `localStorage` held them, in the Rust app's own
//! `ui-local.json` (`studio::ui_local`): a tab switch, a page switch,
//! another review or a relaunch never loses one; only Save, Discard, or
//! "Discard changes" in the leave guard drops it. Pure: the app holds the
//! file.

use serde_json::{Value, json};

use super::clean_cut_review::{Draft, DraftManual};

/// `CLEAN_CUT_DRAFTS_STORAGE_KEY`.
pub const STORAGE_KEY: &str = "videorc.cleanCutDrafts";
/// `CLEAN_CUT_DRAFTS_MAX`: jobs whose drafts are kept, newest last.
pub const MAX: usize = 20;

/// `StoredCleanCutDraft`: one job's draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub job_id: String,
    pub draft: Draft,
}

/// `serializeCleanCutDraft`.
fn to_json(stored: &Stored) -> Value {
    json!({
        "jobId": stored.job_id,
        "toggles": stored.draft.toggles.iter().map(|(id, enabled)| json!([id, enabled])).collect::<Vec<_>>(),
        "addManual": stored.draft.add_manual.iter().map(|manual| json!({
            "key": manual.key,
            "startMs": manual.start_ms,
            "endMs": manual.end_ms,
        })).collect::<Vec<_>>(),
        "removeManual": stored.draft.remove_manual,
        "nextKey": stored.draft.next_key,
    })
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// `parseStoredCleanCutDraft`: read loosely; anything malformed is dropped,
/// never an error.
fn parse_one(value: &Value) -> Option<Stored> {
    let fields = value.as_object()?;
    let job_id = fields.get("jobId")?.as_str().filter(|id| !id.is_empty())?;
    let array = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut toggles: Vec<(String, bool)> = Vec::new();
    for entry in array("toggles") {
        if let (Some(id), Some(enabled)) = (
            entry.get(0).and_then(Value::as_str),
            entry.get(1).and_then(Value::as_bool),
        ) {
            // A `Map` built from the list keeps the last value in the first
            // place.
            match toggles.iter_mut().find(|(each, _)| each == id) {
                Some(held) => held.1 = enabled,
                None => toggles.push((id.to_string(), enabled)),
            }
        }
    }
    let add_manual = array("addManual")
        .iter()
        .filter_map(|entry| {
            let key = entry.get("key")?.as_str()?;
            let start = finite(entry.get("startMs"))?;
            let end = finite(entry.get("endMs"))?;
            (end > start).then(|| DraftManual {
                key: key.to_string(),
                start_ms: start.max(0.0).round() as u64,
                end_ms: end.max(0.0).round() as u64,
            })
        })
        .collect();
    let mut remove_manual: Vec<String> = Vec::new();
    for id in array("removeManual") {
        if let Some(id) = id.as_str()
            && !remove_manual.iter().any(|held| held == id)
        {
            remove_manual.push(id.to_string());
        }
    }
    let next_key = finite(fields.get("nextKey"))
        .filter(|key| *key >= 1.0)
        .map_or(1, |key| key.floor().min(f64::from(u32::MAX)) as u32);
    Some(Stored {
        job_id: job_id.to_string(),
        draft: Draft {
            toggles,
            add_manual,
            remove_manual,
            next_key,
        },
    })
}

/// `parseStoredCleanCutDrafts`: the stored list, newest last; anything
/// unreadable reads as empty.
pub fn parse(raw: Option<&str>) -> Vec<Stored> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(entries)) => entries.iter().filter_map(parse_one).collect(),
        _ => Vec::new(),
    }
}

/// The list as stored (`JSON.stringify`).
pub fn serialize(drafts: &[Stored]) -> String {
    Value::Array(drafts.iter().map(to_json).collect()).to_string()
}

/// `withStoredCleanCutDraft`: the list with this job's draft put last, or
/// taken out when it is empty, and at most `max` jobs kept.
pub fn with_draft(drafts: &[Stored], job_id: &str, draft: &Draft, max: usize) -> Vec<Stored> {
    let mut next: Vec<Stored> = drafts
        .iter()
        .filter(|entry| entry.job_id != job_id)
        .cloned()
        .collect();
    if draft.change_count() == 0 {
        return next;
    }
    next.push(Stored {
        job_id: job_id.to_string(),
        draft: draft.clone(),
    });
    if next.len() > max {
        let excess = next.len() - max;
        next.drain(..excess);
    }
    next
}

/// `readCleanCutDraft`: the job's kept draft, or the empty one.
pub fn read(drafts: &[Stored], job_id: &str) -> Draft {
    drafts
        .iter()
        .find(|entry| entry.job_id == job_id)
        .map(|entry| entry.draft.clone())
        .unwrap_or_default()
}

/// `writeCleanCutDraft`'s rule: the new list, or None when nothing changes
/// (an empty draft for a job with nothing kept).
pub fn write(drafts: &[Stored], job_id: &str, draft: &Draft) -> Option<Vec<Stored>> {
    let known = drafts.iter().any(|entry| entry.job_id == job_id);
    if !known && draft.change_count() == 0 {
        return None;
    }
    Some(with_draft(drafts, job_id, draft, MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(toggles: &[(&str, bool)]) -> Draft {
        Draft {
            toggles: toggles
                .iter()
                .map(|(id, enabled)| ((*id).to_string(), *enabled))
                .collect(),
            add_manual: vec![DraftManual {
                key: "draft:1".into(),
                start_ms: 100,
                end_ms: 900,
            }],
            remove_manual: vec!["m1".into()],
            next_key: 2,
        }
    }

    #[test]
    fn a_draft_survives_the_round_trip_in_electrons_shape() {
        let kept = with_draft(&[], "job-1", &draft(&[("r1", false)]), MAX);
        let text = serialize(&kept);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value,
            json!([{
                "jobId": "job-1",
                "toggles": [["r1", false]],
                "addManual": [{ "key": "draft:1", "startMs": 100, "endMs": 900 }],
                "removeManual": ["m1"],
                "nextKey": 2
            }])
        );
        assert_eq!(parse(Some(&text)), kept);
        assert_eq!(read(&kept, "job-1"), draft(&[("r1", false)]));
        assert_eq!(read(&kept, "other"), Draft::default());
    }

    #[test]
    fn anything_malformed_is_dropped_never_thrown() {
        assert!(parse(None).is_empty());
        assert!(parse(Some("not json")).is_empty());
        assert!(parse(Some("{}")).is_empty());
        let parsed = parse(Some(
            r#"[{"jobId":""},{"jobId":"j","toggles":[["a",true],[1,true],["b"]],
               "addManual":[{"key":"k","startMs":5,"endMs":2},{"key":"ok","startMs":1.4,"endMs":9.6}],
               "removeManual":["m",3,"m"],"nextKey":-4}]"#,
        ));
        assert_eq!(parsed.len(), 1);
        let only = &parsed[0].draft;
        assert_eq!(only.toggles, vec![("a".to_string(), true)]);
        assert_eq!(only.add_manual.len(), 1);
        assert_eq!(
            (only.add_manual[0].start_ms, only.add_manual[0].end_ms),
            (1, 10)
        );
        assert_eq!(only.remove_manual, vec!["m".to_string()]);
        assert_eq!(only.next_key, 1);
    }

    #[test]
    fn an_empty_draft_is_forgotten_and_the_newest_twenty_are_kept() {
        let one = with_draft(&[], "a", &draft(&[]), MAX);
        assert!(with_draft(&one, "a", &Draft::default(), MAX).is_empty());
        assert_eq!(write(&[], "a", &Draft::default()), None);
        assert_eq!(write(&one, "a", &Draft::default()), Some(Vec::new()));
        let mut many = Vec::new();
        for index in 0..25 {
            many = with_draft(&many, &format!("job-{index}"), &draft(&[]), MAX);
        }
        assert_eq!(many.len(), MAX);
        assert_eq!(many[0].job_id, "job-5");
        assert_eq!(many[MAX - 1].job_id, "job-24");
        // A job written again moves last.
        let moved = with_draft(&many, "job-5", &draft(&[("r", true)]), MAX);
        assert_eq!(
            moved.last().map(|entry| entry.job_id.as_str()),
            Some("job-5")
        );
    }
}
