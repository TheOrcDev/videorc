//! The stream report email's summary (plan 237, Phase A): what one live
//! session looked like, in numbers only, built from the rows the session
//! already saved on this computer.
//!
//! - Watching: the viewer samples (`viewer_stats`, `stream-viewers` logs).
//!   Peak and average follow the Stream Manager's history
//!   (`stream-manager-stats.ts`, `viewersItem`): the largest `total` of one
//!   saved sample and the rounded mean of the totals, so the email and the
//!   app agree to the viewer.
//! - Chatted: `session_chat_authors` (`<platform>:<author id>` keys), plus the
//!   distinct people when plan 225's community store linked accounts.
//! - Followers, support and community counts: the audience snapshot, the
//!   chat totals and Buddy's report (plan 225 D15).
//!
//! Never a viewer's name, a message or a link. While the `streamReport.youtube`
//! service flag is off (plan 237 D3), YouTube's numbers stay out, and so do
//! the blocks that mix platforms (tips, supporters, community).

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::audience::{AudienceCapability, AudienceMetric, AudienceSnapshot};
use crate::protocol::CohostReportCommunity;
use crate::storage::{Database, SessionChatTotals};
use crate::streaming::{StreamPlatform, stream_platform_from_id};
use crate::viewer_stats::ViewerSample;

/// The wire version of `POST /api/desktop/stream-report`.
pub const STREAM_REPORT_VERSION: u32 = 1;
/// The most bars the watching chart carries.
pub const SERIES_BUCKETS: usize = 48;
/// The longest title the email shows, in characters.
pub const TITLE_MAX_CHARS: usize = 140;
/// Plan 237 D5: a live session shorter than this gets no email.
pub const MIN_STREAM_SECONDS: i64 = 5 * 60;
/// How many earlier live sessions "since your last stream" looks through for
/// one with numbers.
const PREVIOUS_SESSIONS_SCAN: usize = 5;

// ---------------------------------------------------------------------------
// Wire shape (videorc-web `docs/stream-report-email.md`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamReport {
    pub version: u32,
    pub report_id: String,
    pub started_at: String,
    pub ended_at: String,
    /// The computer's offset from UTC when the stream started, so the email
    /// shows the streamer's own clock.
    pub utc_offset_minutes: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The platforms the stream went live to, in `StreamPlatform` order.
    pub platforms: Vec<StreamPlatform>,
    /// YouTube's numbers were left out (D3); the email says where they are.
    pub youtube_omitted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewers: Option<ReportViewers>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<ReportChat>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub audience: Vec<ReportAudience>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support: Option<ReportSupport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub community: Option<ReportCommunity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_last: Option<ReportSinceLast>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportViewers {
    /// The largest combined count of one sample.
    pub peak: u64,
    /// Seconds from the start to that sample.
    pub peak_at_seconds: u64,
    pub average: u64,
    /// The platforms whose counts are in the totals.
    pub coverage: Vec<StreamPlatform>,
    pub by_platform: Vec<ReportPlatformViewers>,
    /// At most [`SERIES_BUCKETS`] bars, oldest first: the largest total in
    /// each slice of the stream, `null` where no sample landed.
    pub series: Vec<Option<u64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportPlatformViewers {
    pub platform: StreamPlatform,
    pub peak: u64,
    /// The mean of this platform's counts over the samples that carry it.
    pub average: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportChat {
    pub messages: u64,
    /// Distinct chat accounts that sent a message or a paid message.
    pub chatters: u64,
    /// Distinct people, when plan 225 linked some of those accounts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub people: Option<u64>,
    pub by_platform: Vec<ReportPlatformChat>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportPlatformChat {
    pub platform: StreamPlatform,
    pub messages: u64,
    pub chatters: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportAudience {
    pub platform: StreamPlatform,
    pub metric: AudienceMetric,
    /// Negative when people unfollowed.
    pub delta: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportSupport {
    pub bits: u64,
    pub supporters: u64,
    pub raids: u64,
    pub follows: u64,
    pub tips: Vec<ReportTip>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportTip {
    pub currency: String,
    pub amount_micros: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportCommunity {
    pub regulars_back: u32,
    pub new_regulars: u32,
    pub first_timers: u32,
    pub first_timers_stayed: u32,
    pub comebacks: u32,
    pub milestones: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportSinceLast {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_pct: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_pct: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chatters_delta: Option<i64>,
}

// ---------------------------------------------------------------------------
// The builder (pure)
// ---------------------------------------------------------------------------

/// Everything the builder reads, already loaded.
#[derive(Debug, Clone)]
pub struct ReportInput {
    pub report_id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub utc_offset_minutes: i32,
    pub title: Option<String>,
    /// Where the stream went live (from its destinations); may be empty for
    /// an older session, then the data says.
    pub platforms: Vec<StreamPlatform>,
    pub samples: Vec<ViewerSample>,
    /// `session_chat_authors` rows: the `<platform>:<id>` key and its count.
    pub authors: Vec<(String, u64)>,
    pub people: Option<u64>,
    pub totals: Option<SessionChatTotals>,
    pub audience: Option<AudienceSnapshot>,
    pub community: Option<CohostReportCommunity>,
    pub previous: Option<PreviousStream>,
    /// `streamReport.youtube` (D3).
    pub youtube_allowed: bool,
}

/// The last live session's numbers, for "since your last stream" (D8).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreviousStream {
    pub viewers: Option<ReportViewers>,
    pub chatters: Option<u64>,
}

fn sorted_platforms(mut platforms: Vec<StreamPlatform>) -> Vec<StreamPlatform> {
    platforms.sort_by_key(|platform| *platform as u8);
    platforms.dedup();
    platforms
}

fn kept(platform: StreamPlatform, youtube_allowed: bool) -> bool {
    youtube_allowed || platform != StreamPlatform::Youtube
}

fn rounded_mean(sum: u128, count: u128) -> u64 {
    if count == 0 {
        return 0;
    }
    u64::try_from((sum + count / 2) / count).unwrap_or(u64::MAX)
}

/// Peak, average, per-platform numbers and the chart from the saved samples.
/// `None` when no kept platform reported a count.
pub fn viewer_summary(
    samples: &[ViewerSample],
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    youtube_allowed: bool,
) -> Option<ReportViewers> {
    // (at, total) per sample, with the dropped platforms taken out.
    let mut points: Vec<(DateTime<Utc>, u64)> = Vec::new();
    // platform → (peak, sum, samples)
    let mut by_platform: Vec<(StreamPlatform, u64, u128, u128)> = Vec::new();
    for sample in samples {
        let Ok(at) = DateTime::parse_from_rfc3339(&sample.at) else {
            continue;
        };
        let mut total = 0u64;
        let mut any = false;
        for entry in &sample.platforms {
            if !kept(entry.platform, youtube_allowed) {
                continue;
            }
            any = true;
            total = total.saturating_add(entry.count);
            match by_platform
                .iter_mut()
                .find(|(platform, ..)| *platform == entry.platform)
            {
                Some((_, peak, sum, count)) => {
                    *peak = (*peak).max(entry.count);
                    *sum += u128::from(entry.count);
                    *count += 1;
                }
                None => by_platform.push((entry.platform, entry.count, u128::from(entry.count), 1)),
            }
        }
        if any {
            points.push((at.with_timezone(&Utc), total));
        }
    }
    if points.is_empty() {
        return None;
    }
    points.sort_by_key(|(at, _)| *at);
    // The first sample with the largest total marks the peak.
    let (peak_at, peak) = points
        .iter()
        .copied()
        .fold(None::<(DateTime<Utc>, u64)>, |best, point| match best {
            Some(best) if best.1 >= point.1 => Some(best),
            _ => Some(point),
        })
        .unwrap_or((started_at, 0));
    let span_seconds = (ended_at - started_at).num_seconds().max(0);
    let peak_at_seconds = (peak_at - started_at)
        .num_seconds()
        .clamp(0, span_seconds.max(0));
    let sum: u128 = points.iter().map(|(_, total)| u128::from(*total)).sum();
    let average = rounded_mean(sum, points.len() as u128);
    by_platform.sort_by_key(|(platform, ..)| *platform as u8);
    Some(ReportViewers {
        peak,
        peak_at_seconds: u64::try_from(peak_at_seconds).unwrap_or(0),
        average,
        coverage: by_platform.iter().map(|(platform, ..)| *platform).collect(),
        by_platform: by_platform
            .iter()
            .map(|(platform, peak, sum, count)| ReportPlatformViewers {
                platform: *platform,
                peak: *peak,
                average: rounded_mean(*sum, *count),
            })
            .collect(),
        series: series(&points, started_at, span_seconds),
    })
}

/// One bar per sample when they fit; otherwise [`SERIES_BUCKETS`] equal
/// slices of the stream, each the largest total in it, `None` where no sample
/// landed (the chart never draws a zero nobody measured).
fn series(
    points: &[(DateTime<Utc>, u64)],
    started_at: DateTime<Utc>,
    span_seconds: i64,
) -> Vec<Option<u64>> {
    if points.len() <= SERIES_BUCKETS || span_seconds <= 0 {
        // Few samples, or no usable span: the samples themselves, newest
        // SERIES_BUCKETS at most.
        let skip = points.len().saturating_sub(SERIES_BUCKETS);
        return points
            .iter()
            .skip(skip)
            .map(|(_, total)| Some(*total))
            .collect();
    }
    let mut buckets: Vec<Option<u64>> = vec![None; SERIES_BUCKETS];
    let buckets_i64 = SERIES_BUCKETS as i64;
    for (at, total) in points {
        let offset = (*at - started_at).num_seconds().clamp(0, span_seconds);
        let index = usize::try_from((offset * buckets_i64 / span_seconds).min(buckets_i64 - 1))
            .unwrap_or(0);
        let bucket = &mut buckets[index];
        *bucket = Some(bucket.map_or(*total, |current| current.max(*total)));
    }
    buckets
}

/// Messages and chatters per platform from `session_chat_authors` rows.
pub fn chat_summary(
    authors: &[(String, u64)],
    people: Option<u64>,
    youtube_allowed: bool,
) -> Option<ReportChat> {
    let mut by_platform: Vec<ReportPlatformChat> = Vec::new();
    for (key, messages) in authors {
        if *messages == 0 {
            continue;
        }
        let Some(platform) = key
            .split_once(':')
            .and_then(|(platform, _)| stream_platform_from_id(platform))
        else {
            continue;
        };
        if !kept(platform, youtube_allowed) {
            continue;
        }
        match by_platform
            .iter_mut()
            .find(|entry| entry.platform == platform)
        {
            Some(entry) => {
                entry.messages = entry.messages.saturating_add(*messages);
                entry.chatters += 1;
            }
            None => by_platform.push(ReportPlatformChat {
                platform,
                messages: *messages,
                chatters: 1,
            }),
        }
    }
    if by_platform.is_empty() {
        return None;
    }
    by_platform.sort_by_key(|entry| entry.platform as u8);
    let messages = by_platform
        .iter()
        .fold(0u64, |sum, entry| sum.saturating_add(entry.messages));
    let chatters = by_platform
        .iter()
        .fold(0u64, |sum, entry| sum.saturating_add(entry.chatters));
    Some(ReportChat {
        messages,
        chatters,
        // Only a real merge is worth saying: fewer people than accounts.
        people: people.filter(|people| *people > 0 && *people < chatters),
        by_platform,
    })
}

fn percent_change(current: u64, previous: u64) -> Option<i64> {
    if previous == 0 {
        return None;
    }
    let change = (current as f64 - previous as f64) * 100.0 / previous as f64;
    Some(change.round() as i64)
}

/// Builds the report. Pure: the caller loaded every row.
pub fn build_report(input: ReportInput) -> StreamReport {
    let youtube_allowed = input.youtube_allowed;
    let viewers = viewer_summary(
        &input.samples,
        input.started_at,
        input.ended_at,
        youtube_allowed,
    );
    let chat = chat_summary(&input.authors, input.people, youtube_allowed);

    // Where it went live: the destinations, else whatever the data shows.
    let mut platforms = input.platforms.clone();
    if platforms.is_empty() {
        platforms.extend(
            input
                .samples
                .iter()
                .flat_map(|sample| sample.platforms.iter().map(|entry| entry.platform)),
        );
        platforms.extend(input.authors.iter().filter_map(|(key, _)| {
            key.split_once(':')
                .and_then(|(platform, _)| stream_platform_from_id(platform))
        }));
        if let Some(audience) = &input.audience {
            platforms.extend(audience.platforms.iter().map(|entry| entry.platform));
        }
    }
    let platforms = sorted_platforms(platforms);
    let youtube_omitted = !youtube_allowed && platforms.contains(&StreamPlatform::Youtube);

    let audience = input
        .audience
        .as_ref()
        .map(|snapshot| {
            let mut entries: Vec<ReportAudience> = snapshot
                .platforms
                .iter()
                .filter(|entry| kept(entry.platform, youtube_allowed))
                .filter(|entry| {
                    matches!(
                        entry.capability,
                        AudienceCapability::Available | AudienceCapability::DeltaOnly
                    )
                })
                .filter_map(|entry| {
                    entry.delta.map(|delta| ReportAudience {
                        platform: entry.platform,
                        metric: entry.metric,
                        delta,
                    })
                })
                .collect();
            entries.sort_by_key(|entry| entry.platform as u8);
            entries.dedup_by_key(|entry| entry.platform);
            entries
        })
        .unwrap_or_default();

    let support = match &input.totals {
        Some(SessionChatTotals::Available {
            follows,
            supporters,
            bits,
            tips,
            raids,
            ..
        }) => {
            // Tips and supporters mix every platform's money and members;
            // while YouTube is left out they go too (D3).
            let mixed_allowed = !youtube_omitted;
            let support = ReportSupport {
                bits: *bits,
                supporters: if mixed_allowed { *supporters } else { 0 },
                raids: *raids,
                follows: *follows,
                tips: if mixed_allowed {
                    tips.iter()
                        .filter(|tip| tip.amount_micros > 0)
                        .map(|tip| ReportTip {
                            currency: tip.currency.clone(),
                            amount_micros: tip.amount_micros,
                        })
                        .collect()
                } else {
                    Vec::new()
                },
            };
            let any = support.bits > 0
                || support.supporters > 0
                || support.raids > 0
                || support.follows > 0
                || !support.tips.is_empty();
            any.then_some(support)
        }
        _ => None,
    };

    let community = input
        .community
        .as_ref()
        .filter(|community| !community.is_empty())
        .filter(|_| !youtube_omitted)
        .map(|community| ReportCommunity {
            regulars_back: community.regulars_back,
            new_regulars: community.new_regulars,
            first_timers: community.first_timers,
            first_timers_stayed: community.first_timers_stayed,
            comebacks: community.comebacks,
            milestones: u32::try_from(community.milestones.len()).unwrap_or(u32::MAX),
        })
        .filter(|community| {
            community.regulars_back > 0
                || community.new_regulars > 0
                || community.first_timers > 0
                || community.comebacks > 0
                || community.milestones > 0
        });

    let since_last = input.previous.as_ref().and_then(|previous| {
        let peak_pct = viewers
            .as_ref()
            .zip(previous.viewers.as_ref())
            .and_then(|(now, before)| percent_change(now.peak, before.peak));
        let average_pct = viewers
            .as_ref()
            .zip(previous.viewers.as_ref())
            .and_then(|(now, before)| percent_change(now.average, before.average));
        let chatters_delta = chat
            .as_ref()
            .map(|chat| chat.chatters)
            .zip(previous.chatters)
            .map(|(now, before)| now as i64 - before as i64);
        (peak_pct.is_some() || average_pct.is_some() || chatters_delta.is_some()).then_some(
            ReportSinceLast {
                peak_pct,
                average_pct,
                chatters_delta,
            },
        )
    });

    StreamReport {
        version: STREAM_REPORT_VERSION,
        report_id: input.report_id,
        started_at: input
            .started_at
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        ended_at: input
            .ended_at
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        utc_offset_minutes: input.utc_offset_minutes,
        title: input.title.as_deref().and_then(report_title),
        platforms,
        youtube_omitted,
        viewers,
        chat,
        audience,
        support,
        community,
        since_last,
    }
}

/// The title the email shows: trimmed, at most [`TITLE_MAX_CHARS`]
/// characters (an ellipsis marks a cut), `None` when empty.
pub fn report_title(title: &str) -> Option<String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    if title.chars().count() <= TITLE_MAX_CHARS {
        return Some(title);
    }
    let mut cut: String = title.chars().take(TITLE_MAX_CHARS - 1).collect();
    cut = cut.trim_end().to_string();
    cut.push('…');
    Some(cut)
}

/// The computer's offset from UTC at `at`, in minutes.
pub fn local_utc_offset_minutes(at: DateTime<Utc>) -> i32 {
    chrono::Local
        .from_utc_datetime(&at.naive_utc())
        .offset()
        .local_minus_utc()
        / 60
}

// ---------------------------------------------------------------------------
// Loading (SQLite)
// ---------------------------------------------------------------------------

/// The session columns the report reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFacts {
    pub title: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub mode: String,
    pub duration_ms: Option<i64>,
}

impl SessionFacts {
    /// Went live: the mode names a stream (`stream`, `record+stream`).
    pub fn live(&self) -> bool {
        self.mode.contains("stream")
    }

    /// The end, or the start plus the duration, or the start.
    pub fn end(&self) -> DateTime<Utc> {
        self.ended_at.unwrap_or_else(|| {
            self.started_at + chrono::TimeDelta::milliseconds(self.duration_ms.unwrap_or(0).max(0))
        })
    }
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

pub fn session_facts(
    database: &Database,
    session_id: &str,
) -> anyhow::Result<Option<SessionFacts>> {
    let conn = database.lock()?;
    let row = conn
        .query_row(
            "SELECT title, started_at, ended_at, mode, duration_ms FROM sessions WHERE id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()?;
    Ok(
        row.and_then(|(title, started_at, ended_at, mode, duration_ms)| {
            Some(SessionFacts {
                title,
                started_at: parse_utc(&started_at)?,
                ended_at: ended_at.as_deref().and_then(parse_utc),
                mode,
                duration_ms,
            })
        }),
    )
}

/// `session_chat_authors` rows for one session.
pub fn session_chat_authors(
    database: &Database,
    session_id: &str,
) -> anyhow::Result<Vec<(String, u64)>> {
    let conn = database.lock()?;
    let mut statement = conn.prepare(
        "SELECT author_key, message_count FROM session_chat_authors WHERE session_id = ?1",
    )?;
    let rows = statement.query_map(params![session_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut authors = Vec::new();
    for row in rows {
        let (key, count) = row?;
        authors.push((key, u64::try_from(count).unwrap_or(0)));
    }
    Ok(authors)
}

/// Distinct people who chatted (plan 225's links), `None` when the community
/// store has nothing for this session or cannot be read.
pub fn session_people(database: &Database, session_id: &str, youtube_allowed: bool) -> Option<u64> {
    let conn = database.lock().ok()?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT accounts.person_id)
             FROM community_attendance AS attendance
             JOIN community_accounts AS accounts
               ON accounts.account_key = attendance.account_key
             WHERE attendance.session_id = ?1
               AND (?2 OR accounts.platform != 'youtube')",
            params![session_id, youtube_allowed],
            |row| row.get(0),
        )
        .ok()?;
    u64::try_from(count).ok().filter(|count| *count > 0)
}

/// Earlier live sessions, newest first.
fn previous_streamed_sessions(
    database: &Database,
    before: &str,
    limit: usize,
) -> anyhow::Result<Vec<String>> {
    let conn = database.lock()?;
    let mut statement = conn.prepare(
        "SELECT id FROM sessions
         WHERE library_hidden = 0 AND mode LIKE '%stream%' AND started_at < ?1
         ORDER BY started_at DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(
        params![before, i64::try_from(limit).unwrap_or(i64::MAX)],
        |row| row.get::<_, String>(0),
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The most recent earlier live session that has numbers (D8).
fn previous_stream(
    database: &Database,
    facts: &SessionFacts,
    started_at_raw: &str,
    youtube_allowed: bool,
) -> Option<PreviousStream> {
    let ids = previous_streamed_sessions(database, started_at_raw, PREVIOUS_SESSIONS_SCAN).ok()?;
    for id in ids {
        let Ok(Some(previous)) = session_facts(database, &id) else {
            continue;
        };
        if previous.started_at >= facts.started_at {
            continue;
        }
        let samples =
            crate::viewer_stats::session_viewer_history(database, &id).unwrap_or_default();
        let viewers = viewer_summary(
            &samples,
            previous.started_at,
            previous.end(),
            youtube_allowed,
        );
        let authors = session_chat_authors(database, &id).unwrap_or_default();
        let chatters = chat_summary(&authors, None, youtube_allowed).map(|chat| chat.chatters);
        if viewers.is_some() || chatters.is_some() {
            return Some(PreviousStream { viewers, chatters });
        }
    }
    None
}

fn raw_started_at(database: &Database, session_id: &str) -> Option<String> {
    let conn = database.lock().ok()?;
    conn.query_row(
        "SELECT started_at FROM sessions WHERE id = ?1",
        params![session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Loads every row of a session and builds its report. `None` when the
/// session is gone, never went live, or has not ended.
pub fn load_report(
    database: &Database,
    session_id: &str,
    report_id: String,
    platforms: Vec<StreamPlatform>,
    youtube_allowed: bool,
) -> anyhow::Result<Option<StreamReport>> {
    let Some(facts) = session_facts(database, session_id)? else {
        return Ok(None);
    };
    if !facts.live() {
        return Ok(None);
    }
    let samples = crate::viewer_stats::session_viewer_history(database, session_id)?;
    let authors = session_chat_authors(database, session_id)?;
    let totals = database.session_chat_totals(session_id)?;
    let audience = crate::audience::session_audience(database, session_id)?;
    let community = database
        .get_cohost_report(session_id)?
        .and_then(|report| report.community);
    let people = session_people(database, session_id, youtube_allowed);
    let previous = raw_started_at(database, session_id)
        .and_then(|raw| previous_stream(database, &facts, &raw, youtube_allowed));
    let ended_at = facts.end();
    Ok(Some(build_report(ReportInput {
        report_id,
        started_at: facts.started_at,
        ended_at,
        utc_offset_minutes: local_utc_offset_minutes(facts.started_at),
        title: Some(facts.title.clone()),
        platforms,
        samples,
        authors,
        people,
        totals,
        audience,
        community,
        previous,
        youtube_allowed,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audience::PlatformAudience;
    use crate::storage::SessionChatTipTotal;
    use crate::viewer_stats::ViewerPlatformCount;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-14T18:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::TimeDelta::seconds(seconds)
    }

    fn sample(seconds: i64, counts: &[(StreamPlatform, u64)]) -> ViewerSample {
        ViewerSample {
            session_id: "s".to_string(),
            platforms: counts
                .iter()
                .map(|(platform, count)| ViewerPlatformCount {
                    platform: *platform,
                    count: *count,
                })
                .collect(),
            total: counts.iter().map(|(_, count)| count).sum(),
            at: at(seconds).to_rfc3339(),
        }
    }

    fn input() -> ReportInput {
        ReportInput {
            report_id: "00000000-0000-4000-8000-000000000001".to_string(),
            started_at: at(0),
            ended_at: at(3_600),
            utc_offset_minutes: 60,
            title: Some("Building a Rust TUI".to_string()),
            platforms: vec![StreamPlatform::Twitch, StreamPlatform::Youtube],
            samples: Vec::new(),
            authors: Vec::new(),
            people: None,
            totals: None,
            audience: None,
            community: None,
            previous: None,
            youtube_allowed: true,
        }
    }

    use StreamPlatform::{Kick, Twitch, X, Youtube};

    #[test]
    fn no_samples_means_no_viewers_block() {
        assert_eq!(viewer_summary(&[], at(0), at(600), true), None);
        let report = build_report(input());
        assert_eq!(report.viewers, None);
        assert_eq!(report.chat, None);
        assert_eq!(report.support, None);
        assert_eq!(report.since_last, None);
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("viewers").is_none());
        assert!(json.get("audience").is_none());
        assert_eq!(json["platforms"], serde_json::json!(["youtube", "twitch"]));
        assert_eq!(json["youtubeOmitted"], false);
        assert_eq!(json["utcOffsetMinutes"], 60);
    }

    #[test]
    fn one_platform_peak_and_average_match_the_stream_manager() {
        let samples = vec![
            sample(60, &[(Twitch, 10)]),
            sample(120, &[(Twitch, 25)]),
            sample(180, &[(Twitch, 20)]),
        ];
        let viewers = viewer_summary(&samples, at(0), at(600), true).unwrap();
        assert_eq!(viewers.peak, 25);
        assert_eq!(viewers.peak_at_seconds, 120);
        // (10 + 25 + 20) / 3 = 18.33 → 18, as Math.round in the app.
        assert_eq!(viewers.average, 18);
        assert_eq!(viewers.coverage, vec![Twitch]);
        assert_eq!(viewers.series, vec![Some(10), Some(25), Some(20)]);
    }

    #[test]
    fn platforms_peak_at_different_moments() {
        let samples = vec![
            sample(60, &[(Youtube, 100), (Twitch, 10), (Kick, 5), (X, 1)]),
            sample(120, &[(Youtube, 40), (Twitch, 60), (Kick, 20), (X, 9)]),
            sample(180, &[(Youtube, 80), (Twitch, 30), (Kick, 10), (X, 2)]),
        ];
        let viewers = viewer_summary(&samples, at(0), at(600), true).unwrap();
        assert_eq!(viewers.peak, 129);
        assert_eq!(viewers.peak_at_seconds, 120);
        let peaks: u64 = viewers.by_platform.iter().map(|entry| entry.peak).sum();
        assert_eq!(peaks, 100 + 60 + 20 + 9);
        assert!(peaks > viewers.peak, "platform peaks add up to more");
        assert_eq!(viewers.coverage, vec![Youtube, Twitch, Kick, X]);
        assert_eq!(viewers.by_platform[0].average, 73); // (100+40+80)/3
    }

    #[test]
    fn a_platform_that_drops_out_averages_over_its_own_samples() {
        let samples = vec![
            sample(60, &[(Twitch, 10), (Kick, 4)]),
            sample(120, &[(Twitch, 20)]),
            sample(180, &[(Twitch, 30)]),
        ];
        let viewers = viewer_summary(&samples, at(0), at(600), true).unwrap();
        let kick = viewers
            .by_platform
            .iter()
            .find(|entry| entry.platform == Kick)
            .unwrap();
        assert_eq!((kick.peak, kick.average), (4, 4));
        assert_eq!(viewers.average, 21); // (14 + 20 + 30) / 3 = 21.33
    }

    #[test]
    fn youtube_left_out_recomputes_every_total() {
        let mut report_input = input();
        report_input.youtube_allowed = false;
        report_input.samples = vec![
            sample(60, &[(Youtube, 100), (Twitch, 10)]),
            sample(120, &[(Youtube, 200)]),
            sample(180, &[(Youtube, 50), (Twitch, 30)]),
        ];
        report_input.authors = vec![
            ("youtube:a".to_string(), 5),
            ("twitch:b".to_string(), 2),
            ("twitch:c".to_string(), 1),
        ];
        report_input.totals = Some(SessionChatTotals::Available {
            session_id: "s".to_string(),
            revision: 1,
            message_count: 8,
            chatters: 3,
            platforms: vec![Youtube, Twitch],
            follows: 2,
            supporters: 4,
            bits: 100,
            tips: vec![SessionChatTipTotal {
                currency: "USD".to_string(),
                amount_micros: 5_000_000,
            }],
            raids: 1,
        });
        report_input.community = Some(CohostReportCommunity {
            regulars_back: 3,
            ..Default::default()
        });
        report_input.audience = Some(AudienceSnapshot {
            session_id: "s".to_string(),
            platforms: vec![
                audience_entry(Youtube, AudienceMetric::Subscribers, 7),
                audience_entry(Twitch, AudienceMetric::Followers, 2),
            ],
            updated_at: at(600).to_rfc3339(),
        });
        let report = build_report(report_input);
        assert!(report.youtube_omitted);
        let viewers = report.viewers.unwrap();
        assert_eq!(viewers.coverage, vec![Twitch]);
        assert_eq!(viewers.peak, 30);
        assert_eq!(
            viewers.average, 20,
            "the YouTube-only sample is not counted"
        );
        let chat = report.chat.unwrap();
        assert_eq!((chat.messages, chat.chatters), (3, 2));
        assert_eq!(report.audience.len(), 1);
        assert_eq!(report.audience[0].platform, Twitch);
        let support = report.support.unwrap();
        assert_eq!((support.bits, support.raids, support.follows), (100, 1, 2));
        assert_eq!(support.supporters, 0, "members mix platforms");
        assert!(support.tips.is_empty(), "Super Chats mix platforms");
        assert_eq!(report.community, None, "community counts mix platforms");
        let json = serde_json::to_string(&viewers.coverage).unwrap();
        assert!(!json.contains("youtube"));
    }

    #[test]
    fn youtube_omitted_only_when_the_stream_went_to_youtube() {
        let mut report_input = input();
        report_input.youtube_allowed = false;
        report_input.platforms = vec![Twitch];
        report_input.community = Some(CohostReportCommunity {
            first_timers: 2,
            ..Default::default()
        });
        let report = build_report(report_input);
        assert!(!report.youtube_omitted);
        assert_eq!(report.community.unwrap().first_timers, 2);
    }

    fn audience_entry(
        platform: StreamPlatform,
        metric: AudienceMetric,
        delta: i64,
    ) -> PlatformAudience {
        serde_json::from_value(serde_json::json!({
            "platform": platform,
            "metric": metric,
            "capability": "available",
            "total": 100,
            "baseline": 100 - delta,
            "delta": delta,
        }))
        .unwrap()
    }

    #[test]
    fn a_legacy_chat_session_has_no_support_block() {
        let mut report_input = input();
        report_input.totals = Some(SessionChatTotals::LegacyUnavailable {
            session_id: "s".to_string(),
        });
        assert_eq!(build_report(report_input).support, None);
    }

    #[test]
    fn a_six_hour_stream_still_has_at_most_48_bars() {
        let samples: Vec<ViewerSample> = (0..360)
            .map(|minute| sample(minute * 60, &[(Twitch, minute as u64)]))
            .collect();
        let viewers = viewer_summary(&samples, at(0), at(6 * 3_600), true).unwrap();
        assert_eq!(viewers.series.len(), SERIES_BUCKETS);
        assert!(viewers.series.iter().all(Option::is_some));
        assert_eq!(viewers.series.last().copied().flatten(), Some(359));
        assert_eq!(viewers.peak, 359);
    }

    #[test]
    fn a_gap_in_the_samples_leaves_empty_bars() {
        // 60 samples in the first 10 minutes of a 2-hour stream.
        let samples: Vec<ViewerSample> = (0..60)
            .map(|index| sample(index * 10, &[(Twitch, 5)]))
            .collect();
        let viewers = viewer_summary(&samples, at(0), at(7_200), true).unwrap();
        assert_eq!(viewers.series.len(), SERIES_BUCKETS);
        assert_eq!(viewers.series[0], Some(5));
        assert_eq!(viewers.series[47], None, "nothing measured, nothing drawn");
    }

    #[test]
    fn chat_counts_accounts_per_platform_and_people_only_when_merged() {
        let authors = vec![
            ("twitch:1".to_string(), 3),
            ("twitch:2".to_string(), 1),
            ("kick:9".to_string(), 4),
            ("x:7".to_string(), 0),
            ("bogus".to_string(), 9),
        ];
        let chat = chat_summary(&authors, Some(2), true).unwrap();
        assert_eq!((chat.messages, chat.chatters), (8, 3));
        assert_eq!(chat.people, Some(2));
        assert_eq!(chat.by_platform[0].platform, Twitch);
        assert_eq!(chat.by_platform[1].platform, Kick);
        // As many people as accounts: no merge to mention.
        assert_eq!(chat_summary(&authors, Some(3), true).unwrap().people, None);
        assert_eq!(chat_summary(&[], Some(3), true), None);
    }

    #[test]
    fn since_last_compares_peak_average_and_chatters() {
        let mut report_input = input();
        report_input.samples = vec![sample(60, &[(Twitch, 123)])];
        report_input.authors = vec![("twitch:1".to_string(), 1), ("twitch:2".to_string(), 1)];
        report_input.previous = Some(PreviousStream {
            viewers: viewer_summary(&[sample(60, &[(Twitch, 100)])], at(0), at(600), true),
            chatters: Some(5),
        });
        let since = build_report(report_input.clone()).since_last.unwrap();
        assert_eq!(since.peak_pct, Some(23));
        assert_eq!(since.average_pct, Some(23));
        assert_eq!(since.chatters_delta, Some(-3));
        // No earlier stream, or one without numbers: no comparison.
        report_input.previous = Some(PreviousStream::default());
        assert_eq!(build_report(report_input.clone()).since_last, None);
        report_input.previous = None;
        assert_eq!(build_report(report_input).since_last, None);
    }

    #[test]
    fn titles_are_trimmed_and_cut() {
        assert_eq!(report_title("   "), None);
        assert_eq!(report_title("  Hi \n there "), Some("Hi there".to_string()));
        let long = "a".repeat(200);
        let cut = report_title(&long).unwrap();
        assert_eq!(cut.chars().count(), TITLE_MAX_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn platforms_come_from_the_data_when_no_destination_was_seen() {
        let mut report_input = input();
        report_input.platforms = Vec::new();
        report_input.samples = vec![sample(60, &[(Kick, 3)])];
        report_input.authors = vec![("x:1".to_string(), 1)];
        let report = build_report(report_input);
        assert_eq!(report.platforms, vec![Kick, X]);
    }

    #[test]
    fn the_report_loads_from_a_saved_session() {
        let database = Database::open_in_memory_for_tests();
        crate::stream_report_email::tests_support::seed_live_session(
            &database,
            "live-1",
            "2026-11-14T18:00:00Z",
            "2026-11-14T19:00:00Z",
        );
        database
            .add_session_log(
                "live-1",
                crate::protocol::HealthLevel::Info,
                crate::viewer_stats::VIEWER_SAMPLE_LOG_CODE,
                &serde_json::to_string(&sample(120, &[(Twitch, 42)])).unwrap(),
                None,
            )
            .unwrap();
        let report = load_report(&database, "live-1", "r".to_string(), vec![Twitch], true)
            .unwrap()
            .unwrap();
        assert_eq!(report.viewers.unwrap().peak, 42);
        assert_eq!(report.started_at, "2026-11-14T18:00:00Z");
        assert_eq!(report.ended_at, "2026-11-14T19:00:00Z");
        assert_eq!(report.title.as_deref(), Some("Friday stream"));
        assert_eq!(
            load_report(&database, "missing", "r".to_string(), vec![], true).unwrap(),
            None
        );
    }
}
