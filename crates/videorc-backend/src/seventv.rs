//! 7TV emotes in the Stream Manager (plan 089).
//!
//! No platform marks a 7TV emote: a viewer types a plain word such as
//! `catJAM`, and the 7TV extension swaps it for an image. Videorc does the same
//! for the streamer's own channel. It asks 7TV's v4 GraphQL which 7TV account
//! is linked to the connected Twitch, Kick and YouTube channels, loads that
//! account's active emote set plus 7TV's global set, and builds a name → emote
//! index.
//!
//! v4 rather than v3 REST, which describes itself as maintenance mode and is
//! about 13x larger for the same set; and polling rather than the EventAPI,
//! which acknowledges no subscription, so a broken one would go unnoticed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::live_chat::{LiveChatEventType, LiveChatMessage, LiveChatMessageFragment};
use crate::state::AppState;
use crate::streaming::{StreamPlatform, stream_platform_label};

/// 7TV's v4 GraphQL endpoint (the same API is served at `api.7tv.app`).
pub(crate) const SEVENTV_GQL_URL: &str = "https://7tv.io/v4/gql";
/// Every emote image URL is this prefix, a validated ULID and
/// [`SEVENTV_IMAGE_FILE`]. A URL is never taken from an API response, so a
/// set can never point the image cache anywhere else.
pub(crate) const SEVENTV_CDN_EMOTE_PREFIX: &str = "https://cdn.7tv.app/emote/";
/// Rows draw emotes 20 CSS px tall, which is 40 device px on Retina: 2x
/// (64 px) stays sharp where 1x (32 px) would be upscaled. WebP is the one
/// format every emote has (animated emotes have no PNG), and Chromium
/// animates it.
const SEVENTV_IMAGE_FILE: &str = "2x.webp";
/// A 1,000-emote set is about 160 KB; anything near this cap is not a set.
const SEVENTV_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const SEVENTV_PAGE_SIZE: u32 = 2500;
/// 10,000 emotes. Sets are capped far lower today; past this the set is
/// reported as truncated rather than fetched forever.
const SEVENTV_MAX_PAGES: u32 = 4;
const SEVENTV_EMOTE_ID_LEN: usize = 26;
const SEVENTV_EMOTE_NAME_MAX_CHARS: usize = 100;
const SEVENTV_ERROR_MAX_CHARS: usize = 160;
const SEVENTV_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const SEVENTV_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Platform limits already bound a message (500 chars on Twitch); this bounds
/// the stored row whatever a platform allows.
const SEVENTV_MAX_EMOTES_PER_MESSAGE: usize = 100;
/// How often a running chat session asks whether the emotes changed. An emote
/// the streamer adds mid-stream renders within this.
const SEVENTV_POLL_INTERVAL: Duration = Duration::from_secs(30);
const SEVENTV_MAX_BACKOFF: Duration = Duration::from_secs(300);

/// The 7TV connection platform for a Videorc platform. 7TV links Twitch, Kick
/// and YouTube (as `GOOGLE`), and nothing else.
fn seventv_platform(platform: StreamPlatform) -> Option<&'static str> {
    match platform {
        StreamPlatform::Twitch => Some("TWITCH"),
        StreamPlatform::Kick => Some("KICK"),
        StreamPlatform::Youtube => Some("GOOGLE"),
        StreamPlatform::X
        | StreamPlatform::Tiktok
        | StreamPlatform::Instagram
        | StreamPlatform::Custom => None,
    }
}

/// One of the streamer's own connected channels, as 7TV knows it: the Twitch
/// user id, the Kick user id or the YouTube `UC…` channel id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvConnection {
    pub platform: StreamPlatform,
    pub account_id: String,
}

impl SevenTvConnection {
    /// `None` for a platform 7TV has no connection for, or an empty id.
    pub(crate) fn new(platform: StreamPlatform, account_id: &str) -> Option<Self> {
        let account_id = account_id.trim();
        (seventv_platform(platform).is_some() && !account_id.is_empty()).then(|| Self {
            platform,
            account_id: account_id.to_string(),
        })
    }
}

/// Why a 7TV request failed. The `Display` text is what the backend log shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SevenTvError {
    Timeout,
    Network,
    /// The HTTP status class, such as `5xx`.
    Http(String),
    /// The first GraphQL error message, trimmed.
    GraphQl(String),
    Decode,
    TooLarge,
}

impl fmt::Display for SevenTvError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => formatter.write_str("timeout"),
            Self::Network => formatter.write_str("network"),
            Self::Http(class) => write!(formatter, "http {class}"),
            Self::GraphQl(message) => write!(formatter, "graphql: {message}"),
            Self::Decode => formatter.write_str("decode"),
            Self::TooLarge => formatter.write_str("too-large"),
        }
    }
}

fn network_error(error: reqwest::Error) -> SevenTvError {
    if error.is_timeout() {
        SevenTvError::Timeout
    } else {
        SevenTvError::Network
    }
}

fn status_class(status: u16) -> String {
    format!("{}xx", status / 100)
}

/// One line, at most [`SEVENTV_ERROR_MAX_CHARS`] chars.
fn log_safe(message: &str) -> String {
    message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(SEVENTV_ERROR_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The 7TV account linked to one connection, and the set it has active.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvLink {
    pub user_id: String,
    pub active_set_id: Option<String>,
}

/// One entry of an emote set. `alias` is the word viewers type; it can differ
/// from the emote's own default name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvSetEmote {
    pub alias: String,
    pub id: String,
    pub zero_width: bool,
    pub images_pending: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvSet {
    pub id: String,
    pub name: String,
    pub updated_at: Option<String>,
    pub emotes: Vec<SevenTvSetEmote>,
    /// More pages existed than [`SEVENTV_MAX_PAGES`]; the rest were not fetched.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvSets {
    /// The requested sets that exist, in no particular order.
    pub sets: Vec<SevenTvSet>,
    pub global: SevenTvSet,
}

/// What the poll compares: each connection's active set, and when each set
/// last changed. Any difference means the emotes must be reloaded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SevenTvVersions {
    pub active_sets: Vec<Option<String>>,
    pub set_updated_at: BTreeMap<String, Option<String>>,
    pub global_updated_at: Option<String>,
}

#[derive(Deserialize)]
struct GqlEnvelope {
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize)]
struct GqlError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUser {
    id: String,
    style: RawStyle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStyle {
    #[serde(default)]
    active_emote_set_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSet {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    updated_at: Option<String>,
    emotes: RawSetEmotes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetEmotes {
    #[serde(default)]
    page_count: u32,
    /// Raw values, so one malformed entry drops only itself.
    #[serde(default)]
    items: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetEmote {
    alias: String,
    #[serde(default)]
    flags: RawSetEmoteFlags,
    emote: RawEmote,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetEmoteFlags {
    #[serde(default)]
    zero_width: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEmote {
    id: String,
    #[serde(default)]
    images_pending: bool,
    #[serde(default)]
    deleted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetVersion {
    id: String,
    #[serde(default)]
    updated_at: Option<String>,
}

fn set_selection(page: u32) -> String {
    format!(
        "id name updatedAt emotes(page: {page}, perPage: {SEVENTV_PAGE_SIZE}) \
         {{ pageCount items {{ alias flags {{ zeroWidth }} emote {{ id imagesPending deleted }} }} }}"
    )
}

/// The `$cN: String!` declarations, the aliased `userByConnection` fields and
/// their variables. Account ids travel only as variables, never inside the
/// query text; the platform is a fixed enum literal.
fn connection_selection(connections: &[SevenTvConnection]) -> (String, String, Map<String, Value>) {
    let mut declarations = Vec::new();
    let mut fields = Vec::new();
    let mut variables = Map::new();
    for (index, connection) in connections.iter().enumerate() {
        let Some(platform) = seventv_platform(connection.platform) else {
            continue;
        };
        declarations.push(format!("$c{index}: String!"));
        fields.push(format!(
            "c{index}: userByConnection(platform: {platform}, platformId: $c{index}) \
             {{ id style {{ activeEmoteSetId }} }}"
        ));
        variables.insert(
            format!("c{index}"),
            Value::String(connection.account_id.clone()),
        );
    }
    (declarations.join(", "), fields.join(" "), variables)
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, SevenTvError> {
    serde_json::from_value(value).map_err(|_| SevenTvError::Decode)
}

fn links_from_users(
    users: &Value,
    connections: &[SevenTvConnection],
) -> Result<Vec<Option<SevenTvLink>>, SevenTvError> {
    let users = users.as_object().ok_or(SevenTvError::Decode)?;
    connections
        .iter()
        .enumerate()
        .map(|(index, _)| match users.get(&format!("c{index}")) {
            None | Some(Value::Null) => Ok(None),
            Some(user) => {
                let user: RawUser = decode(user.clone())?;
                Ok(Some(SevenTvLink {
                    user_id: user.id,
                    active_set_id: user.style.active_emote_set_id,
                }))
            }
        })
        .collect()
}

fn set_from_raw(raw: RawSet) -> (SevenTvSet, u32) {
    let emotes = raw
        .emotes
        .items
        .into_iter()
        .filter_map(set_emote_from_value)
        .collect();
    (
        SevenTvSet {
            id: raw.id,
            name: raw.name,
            updated_at: raw.updated_at,
            emotes,
            truncated: false,
        },
        raw.emotes.page_count,
    )
}

fn set_emote_from_value(value: Value) -> Option<SevenTvSetEmote> {
    let raw: RawSetEmote = serde_json::from_value(value).ok()?;
    Some(SevenTvSetEmote {
        alias: raw.alias,
        id: raw.emote.id,
        zero_width: raw.flags.zero_width,
        images_pending: raw.emote.images_pending,
        deleted: raw.emote.deleted,
    })
}

/// A 7TV v4 GraphQL client. Unauthenticated: everything it reads is public.
#[derive(Clone)]
pub(crate) struct SevenTvClient {
    http: reqwest::Client,
    endpoint: String,
    max_body_bytes: usize,
}

impl SevenTvClient {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_endpoint(SEVENTV_GQL_URL)
    }

    pub(crate) fn with_endpoint(endpoint: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
                .timeout(SEVENTV_REQUEST_TIMEOUT)
                .connect_timeout(SEVENTV_CONNECT_TIMEOUT)
                .build()
                .expect("static 7TV HTTP client configuration must be valid"),
            endpoint: endpoint.into(),
            max_body_bytes: SEVENTV_MAX_BODY_BYTES,
        }
    }

    #[cfg(test)]
    fn with_body_cap(mut self, max_body_bytes: usize) -> Self {
        self.max_body_bytes = max_body_bytes;
        self
    }

    /// POST one GraphQL document and return its `data`. A GraphQL `errors`
    /// array wins over any HTTP status, because 7TV answers query errors with
    /// 200 and a null `data`.
    async fn post(
        &self,
        query: &str,
        variables: Map<String, Value>,
    ) -> Result<Value, SevenTvError> {
        let mut response = self
            .http
            .post(&self.endpoint)
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|length| length > self.max_body_bytes as u64)
        {
            return Err(SevenTvError::TooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if body.len() + chunk.len() > self.max_body_bytes {
                return Err(SevenTvError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let envelope = serde_json::from_slice::<GqlEnvelope>(&body).ok();
        if let Some(error) = envelope
            .as_ref()
            .and_then(|envelope| envelope.errors.as_ref())
            .and_then(|errors| errors.first())
        {
            return Err(SevenTvError::GraphQl(log_safe(&error.message)));
        }
        if !status.is_success() {
            return Err(SevenTvError::Http(status_class(status.as_u16())));
        }
        envelope
            .and_then(|envelope| envelope.data)
            .filter(|data| !data.is_null())
            .ok_or(SevenTvError::Decode)
    }

    /// The 7TV account linked to each connection, in order; `None` where the
    /// channel has no 7TV account. One request for all of them.
    pub(crate) async fn resolve_connections(
        &self,
        connections: &[SevenTvConnection],
    ) -> Result<Vec<Option<SevenTvLink>>, SevenTvError> {
        if connections.is_empty() {
            return Ok(Vec::new());
        }
        let (declarations, fields, variables) = connection_selection(connections);
        let query = format!("query Resolve({declarations}) {{ users {{ {fields} }} }}");
        let data = self.post(&query, variables).await?;
        links_from_users(&data["users"], connections)
    }

    /// The given sets plus the global set, every page up to the cap.
    pub(crate) async fn fetch_sets(&self, set_ids: &[String]) -> Result<SevenTvSets, SevenTvError> {
        let selection = set_selection(1);
        let query = format!(
            "query Sets($ids: [Id!]!) {{ emoteSets {{ emoteSets(ids: $ids) {{ {selection} }} \
             global {{ {selection} }} }} }}"
        );
        let mut variables = Map::new();
        variables.insert("ids".to_string(), json!(set_ids));
        let data = self.post(&query, variables).await?;
        let raw_sets: Vec<RawSet> = decode(data["emoteSets"]["emoteSets"].clone())?;
        let raw_global: RawSet = decode(data["emoteSets"]["global"].clone())?;
        let mut sets = Vec::with_capacity(raw_sets.len());
        for raw in raw_sets {
            sets.push(self.with_remaining_pages(raw).await?);
        }
        let global = self.with_remaining_pages(raw_global).await?;
        Ok(SevenTvSets { sets, global })
    }

    async fn with_remaining_pages(&self, raw: RawSet) -> Result<SevenTvSet, SevenTvError> {
        let (mut set, page_count) = set_from_raw(raw);
        for page in 2..=page_count.min(SEVENTV_MAX_PAGES) {
            let selection = set_selection(page);
            let query = format!(
                "query Page($id: Id!) {{ emoteSets {{ emoteSet(id: $id) {{ {selection} }} }} }}"
            );
            let mut variables = Map::new();
            variables.insert("id".to_string(), Value::String(set.id.clone()));
            let data = self.post(&query, variables).await?;
            let raw_page: RawSet = decode(data["emoteSets"]["emoteSet"].clone())?;
            set.emotes.extend(set_from_raw(raw_page).0.emotes);
        }
        set.truncated = page_count > SEVENTV_MAX_PAGES;
        Ok(set)
    }

    /// The cheap check behind the 30 s poll: about 500 bytes.
    pub(crate) async fn poll_versions(
        &self,
        connections: &[SevenTvConnection],
        set_ids: &[String],
    ) -> Result<SevenTvVersions, SevenTvError> {
        let (declarations, fields, mut variables) = connection_selection(connections);
        let declarations = if declarations.is_empty() {
            "$ids: [Id!]!".to_string()
        } else {
            format!("{declarations}, $ids: [Id!]!")
        };
        let users = if fields.is_empty() {
            String::new()
        } else {
            format!("users {{ {fields} }} ")
        };
        let query = format!(
            "query Poll({declarations}) {{ {users}emoteSets {{ emoteSets(ids: $ids) \
             {{ id updatedAt }} global {{ id updatedAt }} }} }}"
        );
        variables.insert("ids".to_string(), json!(set_ids));
        let data = self.post(&query, variables).await?;
        let active_sets = if connections.is_empty() {
            Vec::new()
        } else {
            links_from_users(&data["users"], connections)?
                .into_iter()
                .map(|link| link.and_then(|link| link.active_set_id))
                .collect()
        };
        let versions: Vec<RawSetVersion> = decode(data["emoteSets"]["emoteSets"].clone())?;
        let global: RawSetVersion = decode(data["emoteSets"]["global"].clone())?;
        Ok(SevenTvVersions {
            active_sets,
            set_updated_at: versions
                .into_iter()
                .map(|version| (version.id, version.updated_at))
                .collect(),
            global_updated_at: global.updated_at,
        })
    }
}

/// A 7TV emote id: a 26-char ULID in Crockford base32 (no I, L, O or U).
pub(crate) fn valid_emote_id(id: &str) -> bool {
    id.len() == SEVENTV_EMOTE_ID_LEN
        && id.bytes().all(|byte| {
            byte.is_ascii_digit()
                || (byte.is_ascii_uppercase() && !matches!(byte, b'I' | b'L' | b'O' | b'U'))
        })
}

/// A word a viewer can type: 1 to 100 chars with no whitespace or control
/// chars. Punctuation is allowed: real names include `WHAT?`, `!join`, `:d`.
pub(crate) fn valid_emote_name(name: &str) -> bool {
    (1..=SEVENTV_EMOTE_NAME_MAX_CHARS).contains(&name.chars().count())
        && !name
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

/// The image URL for a validated emote id.
pub(crate) fn emote_image_url(id: &str) -> String {
    format!("{SEVENTV_CDN_EMOTE_PREFIX}{id}/{SEVENTV_IMAGE_FILE}")
}

/// One emote the index can draw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvEmote {
    pub id: String,
    /// Drawn on top of the emote before it rather than beside it.
    pub zero_width: bool,
}

/// Word → emote for one platform's chat: the channel set over the global set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SevenTvEmoteIndex {
    by_name: HashMap<String, SevenTvEmote>,
    channel_count: usize,
}

impl SevenTvEmoteIndex {
    pub(crate) fn get(&self, name: &str) -> Option<&SevenTvEmote> {
        self.by_name.get(name)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    /// Usable emotes that came from the channel set.
    pub(crate) fn channel_count(&self) -> usize {
        self.channel_count
    }
}

/// Merge a channel set over the global set. Entries with an invalid id or
/// name, still-processing images, or a deleted emote are skipped. Within one
/// set the first entry with a name wins; a channel entry wins over a global
/// one of the same name.
pub(crate) fn build_index(channel: Option<&SevenTvSet>, global: &SevenTvSet) -> SevenTvEmoteIndex {
    let mut by_name = HashMap::new();
    let mut add = |set: &SevenTvSet| {
        let mut added = 0;
        for emote in &set.emotes {
            if emote.images_pending
                || emote.deleted
                || !valid_emote_id(&emote.id)
                || !valid_emote_name(&emote.alias)
                || by_name.contains_key(&emote.alias)
            {
                continue;
            }
            by_name.insert(
                emote.alias.clone(),
                SevenTvEmote {
                    id: emote.id.clone(),
                    zero_width: emote.zero_width,
                },
            );
            added += 1;
        }
        added
    };
    let channel_count = channel.map_or(0, &mut add);
    add(global);
    SevenTvEmoteIndex {
        by_name,
        channel_count,
    }
}

/// Each platform's index for one chat session.
pub(crate) type SevenTvIndexes = HashMap<StreamPlatform, Arc<SevenTvEmoteIndex>>;

/// The result of loading a session's emotes: the indexes, the versions the
/// poll compares against, and what the log and Settings report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SevenTvLoad {
    pub indexes: SevenTvIndexes,
    pub versions: SevenTvVersions,
    /// The set ids the poll asks about.
    pub set_ids: Vec<String>,
    pub summary: SevenTvSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SevenTvSummary {
    /// No connected channel has a 7TV account with an active set.
    NotLinked,
    Linked {
        set_name: String,
        emote_count: usize,
        global_count: usize,
        platforms: Vec<StreamPlatform>,
        truncated: bool,
    },
}

/// Decide which set each platform uses (plan 089, decision 5) and build the
/// indexes. A platform uses the set of the 7TV account linked to its own
/// channel; a platform with no link borrows the first linked set, in the
/// order the connections are given (Twitch, Kick, YouTube). The global set
/// applies only when at least one channel is linked.
pub(crate) fn assemble_load(
    connections: &[SevenTvConnection],
    links: &[Option<SevenTvLink>],
    sets: &SevenTvSets,
) -> SevenTvLoad {
    let active_sets: Vec<Option<String>> = links
        .iter()
        .map(|link| link.as_ref().and_then(|link| link.active_set_id.clone()))
        .collect();
    let sets_by_id: HashMap<&str, &SevenTvSet> =
        sets.sets.iter().map(|set| (set.id.as_str(), set)).collect();
    let set_for = |index: usize| {
        active_sets
            .get(index)
            .and_then(|set_id| set_id.as_deref())
            .and_then(|set_id| sets_by_id.get(set_id).copied())
    };
    let fallback = (0..connections.len()).find_map(set_for);
    let set_ids: Vec<String> = {
        let mut ids: Vec<String> = active_sets.iter().flatten().cloned().collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let versions = SevenTvVersions {
        active_sets: active_sets.clone(),
        set_updated_at: sets
            .sets
            .iter()
            .map(|set| (set.id.clone(), set.updated_at.clone()))
            .collect(),
        global_updated_at: sets.global.updated_at.clone(),
    };
    let Some(fallback) = fallback else {
        return SevenTvLoad {
            indexes: SevenTvIndexes::new(),
            versions,
            set_ids,
            summary: SevenTvSummary::NotLinked,
        };
    };
    let mut indexes = SevenTvIndexes::new();
    let mut built: HashMap<&str, Arc<SevenTvEmoteIndex>> = HashMap::new();
    let mut platforms = Vec::new();
    for (index, connection) in connections.iter().enumerate() {
        if indexes.contains_key(&connection.platform) {
            continue;
        }
        let set = set_for(index).unwrap_or(fallback);
        let emote_index = built
            .entry(set.id.as_str())
            .or_insert_with(|| Arc::new(build_index(Some(set), &sets.global)))
            .clone();
        indexes.insert(connection.platform, emote_index);
        platforms.push(connection.platform);
    }
    let fallback_index = built
        .get(fallback.id.as_str())
        .cloned()
        .unwrap_or_else(|| Arc::new(build_index(Some(fallback), &sets.global)));
    let global_count = build_index(None, &sets.global).by_name.len();
    SevenTvLoad {
        indexes,
        versions,
        set_ids,
        summary: SevenTvSummary::Linked {
            set_name: fallback.name.clone(),
            emote_count: fallback_index.channel_count(),
            global_count,
            platforms,
            truncated: fallback.truncated || sets.global.truncated,
        },
    }
}

/// Whether a poll result means the emotes must be reloaded: a connection
/// switched sets (or gained or lost a link), or a set in use changed. With
/// nothing linked the global set is not in use, so only links matter.
pub(crate) fn needs_reload(loaded: &SevenTvLoad, polled: &SevenTvVersions) -> bool {
    if polled.active_sets != loaded.versions.active_sets {
        return true;
    }
    match loaded.summary {
        SevenTvSummary::NotLinked => false,
        SevenTvSummary::Linked { .. } => {
            polled.set_updated_at != loaded.versions.set_updated_at
                || polled.global_updated_at != loaded.versions.global_updated_at
        }
    }
}

/// Resolve the connections and load their sets: at most two requests (more
/// only for a set past one page). Nothing linked means no set request.
pub(crate) async fn load(
    client: &SevenTvClient,
    connections: &[SevenTvConnection],
) -> Result<SevenTvLoad, SevenTvError> {
    let links = client.resolve_connections(connections).await?;
    let mut set_ids: Vec<String> = links
        .iter()
        .flatten()
        .filter_map(|link| link.active_set_id.clone())
        .collect();
    set_ids.sort();
    set_ids.dedup();
    if set_ids.is_empty() {
        return Ok(SevenTvLoad {
            indexes: SevenTvIndexes::new(),
            versions: SevenTvVersions {
                active_sets: vec![None; links.len()],
                ..SevenTvVersions::default()
            },
            set_ids,
            summary: SevenTvSummary::NotLinked,
        });
    }
    let sets = client.fetch_sets(&set_ids).await?;
    Ok(assemble_load(connections, &links, &sets))
}

fn is_seventv_fragment(fragment: &LiveChatMessageFragment) -> bool {
    fragment
        .image_url
        .as_deref()
        .is_some_and(|url| url.starts_with(SEVENTV_CDN_EMOTE_PREFIX))
}

fn text_fragment(text: String) -> LiveChatMessageFragment {
    LiveChatMessageFragment {
        fragment_type: "text".to_string(),
        text,
        image_url: None,
        zero_width: false,
    }
}

/// Turn 7TV emote names in viewers' messages into `emote` fragments (plan
/// 089, decision 6). A word matches when it equals an emote name exactly,
/// case included, between whitespace. Only text a viewer wrote is scanned:
/// `text` fragments, or the message text when a platform sent no fragments.
/// Twitch and Kick emotes, mentions and cheermotes pass through untouched, as
/// do deleted, system, membership, follow and moderation rows. The message
/// text never changes, and a message without a match keeps its fragments
/// exactly. Running it twice gives the same result as once, because emote
/// fragments are never scanned again; connectors retry the same message.
pub(crate) fn decorate(messages: &mut [LiveChatMessage], indexes: &SevenTvIndexes) {
    if indexes.is_empty() {
        return;
    }
    for message in messages {
        if message.is_deleted
            || !matches!(
                message.event_type,
                LiveChatEventType::Message | LiveChatEventType::Paid
            )
        {
            continue;
        }
        if let Some(index) = indexes.get(&message.platform) {
            decorate_message(message, index);
        }
    }
}

fn decorate_message(message: &mut LiveChatMessage, index: &SevenTvEmoteIndex) {
    if index.is_empty()
        || !message
            .message_text
            .split_whitespace()
            .any(|word| index.get(word).is_some())
    {
        return;
    }
    let already = message
        .fragments
        .iter()
        .filter(|fragment| is_seventv_fragment(fragment))
        .count();
    let mut budget = SEVENTV_MAX_EMOTES_PER_MESSAGE.saturating_sub(already);
    let plain;
    let source: &[LiveChatMessageFragment] = if message.fragments.is_empty() {
        plain = [text_fragment(message.message_text.clone())];
        &plain
    } else {
        &message.fragments
    };
    let mut decorated = Vec::with_capacity(source.len() + 2);
    let mut changed = false;
    for fragment in source {
        if fragment.fragment_type == "text" && fragment.image_url.is_none() {
            changed |= split_text_run(&fragment.text, index, &mut budget, &mut decorated);
        } else {
            decorated.push(fragment.clone());
        }
    }
    if changed {
        message.fragments = decorated;
    }
}

/// Split one text run into text and emote fragments, keeping every whitespace
/// char where it was. Returns whether any emote matched.
fn split_text_run(
    text: &str,
    index: &SevenTvEmoteIndex,
    budget: &mut usize,
    out: &mut Vec<LiveChatMessageFragment>,
) -> bool {
    let mut changed = false;
    let mut pending = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        let word_start = rest
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(rest.len());
        pending.push_str(&rest[..word_start]);
        rest = &rest[word_start..];
        let word_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..word_end];
        match index.get(word).filter(|_| *budget > 0) {
            Some(emote) => {
                if !pending.is_empty() {
                    out.push(text_fragment(std::mem::take(&mut pending)));
                }
                out.push(LiveChatMessageFragment {
                    fragment_type: "emote".to_string(),
                    text: word.to_string(),
                    image_url: Some(emote_image_url(&emote.id)),
                    zero_width: emote.zero_width,
                });
                *budget -= 1;
                changed = true;
            }
            None => pending.push_str(word),
        }
        rest = &rest[word_end..];
    }
    if !pending.is_empty() {
        out.push(text_fragment(pending));
    }
    changed
}

/// Where the Settings switch is stored (`app_settings`).
const CHAT_EMOTE_SETTINGS_KEY: &str = "chatEmoteSettings";

/// Settings → General → "GIFs in Twitch chat" (plan 155, D6): how a GIF a
/// Tier 2/3 subscriber sent from Twitch's GIF Keyboard draws in the Stream
/// Manager. The renderer applies it; `Off` means it never fetches the image
/// and the row keeps the GIF's title. Mirrors `TwitchGifMode` in
/// `apps/desktop/src/shared/chat-gif.ts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TwitchGifMode {
    #[default]
    Animated,
    Still,
    Off,
}

/// Settings → General → "Show 7TV emotes in chat" and "GIFs in Twitch
/// chat". 7TV is on unless the streamer turned it off; off means Videorc
/// never contacts 7TV. Rows persisted before plan 155 have no `twitchGifs`
/// and read as Animated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatEmoteSettings {
    #[serde(default = "seven_tv_on_by_default")]
    pub seven_tv: bool,
    #[serde(default)]
    pub twitch_gifs: TwitchGifMode,
}

fn seven_tv_on_by_default() -> bool {
    true
}

impl Default for ChatEmoteSettings {
    fn default() -> Self {
        Self {
            seven_tv: true,
            twitch_gifs: TwitchGifMode::Animated,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatEmoteSettingsPatch {
    #[serde(default)]
    pub seven_tv: Option<bool>,
    #[serde(default)]
    pub twitch_gifs: Option<TwitchGifMode>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SevenTvState {
    /// The Settings switch is off.
    Off,
    /// On, and nothing loaded yet in this app run.
    #[default]
    Idle,
    Loading,
    Linked,
    NotLinked,
    Error,
}

/// The line under the Settings switch. Every optional field is skipped when
/// absent: a serialized `null` has broken app load before.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SevenTvStatus {
    pub state: SevenTvState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emote_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<StreamPlatform>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SevenTvStatus {
    fn of(state: SevenTvState) -> Self {
        Self {
            state,
            ..Self::default()
        }
    }

    pub(crate) fn loading() -> Self {
        Self::of(SevenTvState::Loading)
    }

    fn from_summary(summary: &SevenTvSummary) -> Self {
        match summary {
            SevenTvSummary::NotLinked => Self::of(SevenTvState::NotLinked),
            SevenTvSummary::Linked {
                set_name,
                emote_count,
                global_count,
                platforms,
                ..
            } => Self {
                state: SevenTvState::Linked,
                set_name: Some(set_name.clone()),
                emote_count: Some(*emote_count),
                global_count: Some(*global_count),
                platforms: platforms.clone(),
                error: None,
            },
        }
    }

    fn failed(error: &SevenTvError) -> Self {
        Self {
            error: Some(error.to_string()),
            ..Self::of(SevenTvState::Error)
        }
    }
}

/// `liveChat.emotes.get` / `.set`, and the `liveChat.emotes` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatEmotesState {
    pub seven_tv: bool,
    pub seven_tv_status: SevenTvStatus,
    pub twitch_gifs: TwitchGifMode,
}

pub(crate) fn load_settings(state: &AppState) -> ChatEmoteSettings {
    match state
        .database
        .load_setting::<ChatEmoteSettings>(CHAT_EMOTE_SETTINGS_KEY)
    {
        Ok(settings) => settings.unwrap_or_default(),
        Err(error) => {
            state.emit_log(
                "warn",
                format!("The 7TV emote setting could not be read ({error}); treating it as on."),
            );
            ChatEmoteSettings::default()
        }
    }
}

pub(crate) async fn current_state(state: &AppState) -> ChatEmotesState {
    let settings = load_settings(state);
    let seven_tv_status = if settings.seven_tv {
        state.live_chat.lock().await.seventv_status()
    } else {
        SevenTvStatus::of(SevenTvState::Off)
    };
    ChatEmotesState {
        seven_tv: settings.seven_tv,
        seven_tv_status,
        twitch_gifs: settings.twitch_gifs,
    }
}

/// Tell an open Settings window what changed.
pub(crate) async fn publish_state(state: &AppState) {
    let snapshot = current_state(state).await;
    state.emit_event("liveChat.emotes", snapshot);
}

/// Apply the Settings switch. Off stops the loader at once and drops the
/// emotes (rows already decorated keep theirs); on loads them for a stream
/// that is already live, without waiting for the next Go Live.
pub(crate) async fn set_settings(
    state: &AppState,
    patch: ChatEmoteSettingsPatch,
) -> anyhow::Result<ChatEmotesState> {
    let mut settings = load_settings(state);
    let seven_tv_before = settings.seven_tv;
    if let Some(seven_tv) = patch.seven_tv {
        settings.seven_tv = seven_tv;
    }
    if let Some(twitch_gifs) = patch.twitch_gifs {
        settings.twitch_gifs = twitch_gifs;
    }
    state
        .database
        .save_setting(CHAT_EMOTE_SETTINGS_KEY, &settings)?;
    // The GIF mode is renderer-side; only the 7TV switch moves the loader.
    if patch.seven_tv.is_some() || seven_tv_before != settings.seven_tv {
        if settings.seven_tv {
            crate::live_chat::ensure_seventv_for_current_session(state).await;
        } else {
            state.live_chat.lock().await.stop_seventv();
        }
    }
    let snapshot = current_state(state).await;
    state.emit_event("liveChat.emotes", snapshot.clone());
    Ok(snapshot)
}

fn platform_list(platforms: &[StreamPlatform]) -> String {
    platforms
        .iter()
        .map(|platform| stream_platform_label(*platform))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The backend log line for a load. It reaches support bundles.
fn load_log_line(load: &SevenTvLoad, connections: &[SevenTvConnection], reloaded: bool) -> String {
    let prefix = if reloaded {
        "7TV emotes updated"
    } else {
        "7TV emotes"
    };
    match &load.summary {
        SevenTvSummary::NotLinked => {
            let connected: Vec<StreamPlatform> = connections
                .iter()
                .map(|connection| connection.platform)
                .collect();
            format!(
                "{prefix}: no 7TV account is linked to the connected {} channel, so chat shows none.",
                platform_list(&connected)
            )
        }
        SevenTvSummary::Linked {
            set_name,
            emote_count,
            global_count,
            platforms,
            truncated,
        } => {
            let mut line = format!(
                "{prefix}: \"{}\" ({emote_count} emotes + {global_count} global) for {} chat.",
                log_safe(set_name),
                platform_list(platforms)
            );
            if *truncated {
                line.push_str(" The set has more emotes than Videorc loads; the rest stay text.");
            }
            line
        }
    }
}

/// The streamer's own channels that 7TV can link, in the order a platform
/// without a link borrows from (Twitch, Kick, YouTube): one per platform.
pub(crate) fn session_connections<'a>(
    accounts: impl IntoIterator<Item = (StreamPlatform, Option<&'a str>)>,
) -> Vec<SevenTvConnection> {
    let accounts: Vec<(StreamPlatform, Option<&str>)> = accounts.into_iter().collect();
    [
        StreamPlatform::Twitch,
        StreamPlatform::Kick,
        StreamPlatform::Youtube,
    ]
    .into_iter()
    .filter_map(|platform| {
        accounts.iter().find_map(|(candidate, account_id)| {
            (*candidate == platform)
                .then_some(*account_id)
                .flatten()
                .and_then(|account_id| SevenTvConnection::new(platform, account_id))
        })
    })
    .collect()
}

/// Load the session's 7TV emotes beside its chat connectors, then keep them
/// fresh until the session ends; the coordinator aborts this task with the
/// connectors. Chat delivery never waits for it: messages that arrive before
/// the first load stay text.
pub(crate) fn spawn_session_loader(
    state: &AppState,
    session_generation: u64,
    endpoint: String,
    connections: Vec<SevenTvConnection>,
) -> JoinHandle<()> {
    let state = state.clone();
    tokio::spawn(async move {
        run_session(
            state,
            session_generation,
            SevenTvClient::with_endpoint(endpoint),
            connections,
            SEVENTV_POLL_INTERVAL,
        )
        .await;
    })
}

async fn run_session(
    state: AppState,
    session_generation: u64,
    client: SevenTvClient,
    connections: Vec<SevenTvConnection>,
    interval: Duration,
) {
    let mut loaded: Option<SevenTvLoad> = None;
    let mut logged_failures = HashSet::new();
    let mut failures: u32 = 0;
    loop {
        if state.live_chat.lock().await.session_generation() != session_generation {
            return;
        }
        let outcome = match &loaded {
            None => Some(load(&client, &connections).await),
            Some(current) => match client.poll_versions(&connections, &current.set_ids).await {
                Ok(versions) if !needs_reload(current, &versions) => None,
                Ok(_) => Some(load(&client, &connections).await),
                Err(error) => Some(Err(error)),
            },
        };
        match outcome {
            None => failures = 0,
            Some(Ok(next)) => {
                if !state.live_chat.lock().await.install_seventv_load(
                    session_generation,
                    next.indexes.clone(),
                    SevenTvStatus::from_summary(&next.summary),
                ) {
                    return;
                }
                state.emit_log("info", load_log_line(&next, &connections, loaded.is_some()));
                publish_state(&state).await;
                loaded = Some(next);
                failures = 0;
            }
            Some(Err(error)) => {
                if logged_failures.insert(error.to_string()) {
                    state.emit_log(
                        "warn",
                        format!(
                            "7TV emotes unavailable ({error}). Chat works without them; Videorc keeps retrying."
                        ),
                    );
                }
                // Loaded emotes keep working through a failed poll; only a
                // session with nothing loaded reports the error.
                if loaded.is_none()
                    && state
                        .live_chat
                        .lock()
                        .await
                        .set_seventv_status(session_generation, SevenTvStatus::failed(&error))
                {
                    publish_state(&state).await;
                }
                failures = failures.saturating_add(1);
            }
        }
        tokio::time::sleep(backoff(interval, failures)).await;
    }
}

/// The wait before the next 7TV request: the poll interval, doubled per
/// consecutive failure up to five minutes (30, 60, 120, 240, 300 s).
fn backoff(interval: Duration, failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    if failures == 0 {
        return interval;
    }
    interval
        .saturating_mul(1 << doublings)
        .min(SEVENTV_MAX_BACKOFF.max(interval))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use axum::Json;
    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use tokio::sync::oneshot;

    const CHANNEL_SET: &str = "01J9MMS2R800036CR40E1041ED";
    const GLOBAL_SET: &str = "01HKQT8EWR000ESSWF3625XCS4";
    const CAT_JAM: &str = "01F6MZGCNG000255K4X1K0NEX9";
    const RAIN_TIME: &str = "01FCY771D800007PQ2DF3GDTN6";
    const EZ: &str = "01FDTEQJJR000CM9KGHJPMM403";
    const AYAYA: &str = "01F6NACCD80006SZ7ZW5FMWKWK";

    fn entry(alias: &str, id: &str, zero_width: bool) -> Value {
        json!({
            "alias": alias,
            "flags": { "zeroWidth": zero_width },
            "emote": { "id": id, "imagesPending": false, "deleted": false }
        })
    }

    fn set_value(id: &str, name: &str, updated_at: &str, items: Vec<Value>) -> Value {
        json!({
            "id": id,
            "name": name,
            "updatedAt": updated_at,
            "emotes": { "pageCount": 1, "items": items }
        })
    }

    fn global_value() -> Value {
        set_value(
            GLOBAL_SET,
            "Global Emotes",
            "2026-08-01T21:13:37.761+00:00",
            vec![
                entry("RainTime", RAIN_TIME, true),
                entry("EZ", EZ, false),
                // 7TV's global set lists AYAYA under this alias.
                entry("nanaAYAYA", AYAYA, false),
                entry("catJAM", EZ, false),
            ],
        )
    }

    fn channel_value() -> Value {
        set_value(
            CHANNEL_SET,
            "Halloween Emotes 2026",
            "2026-10-01T08:20:30.009+00:00",
            vec![
                entry("catJAM", CAT_JAM, false),
                entry("WHAT?", EZ, false),
                entry("catJAM", RAIN_TIME, false),
                entry("badId", "not-a-ulid", false),
                entry("has space", EZ, false),
                entry("", EZ, false),
                json!({
                    "alias": "pending",
                    "flags": { "zeroWidth": false },
                    "emote": { "id": EZ, "imagesPending": true, "deleted": false }
                }),
                json!({
                    "alias": "gone",
                    "flags": { "zeroWidth": false },
                    "emote": { "id": EZ, "imagesPending": false, "deleted": true }
                }),
                json!({ "alias": null }),
            ],
        )
    }

    fn sets() -> SevenTvSets {
        let (channel, _) = set_from_raw(serde_json::from_value(channel_value()).unwrap());
        let (global, _) = set_from_raw(serde_json::from_value(global_value()).unwrap());
        SevenTvSets {
            sets: vec![channel],
            global,
        }
    }

    fn connections() -> Vec<SevenTvConnection> {
        vec![
            SevenTvConnection::new(StreamPlatform::Twitch, "71092938").unwrap(),
            SevenTvConnection::new(StreamPlatform::Kick, "676").unwrap(),
            SevenTvConnection::new(StreamPlatform::Youtube, "UChXKjLEzAB1K7EZQey7Fm1Q").unwrap(),
        ]
    }

    fn link(set_id: &str) -> Option<SevenTvLink> {
        Some(SevenTvLink {
            user_id: "01FE9DRF000009TR6M9N941CYW".to_string(),
            active_set_id: Some(set_id.to_string()),
        })
    }

    #[test]
    fn only_twitch_kick_and_youtube_are_7tv_connections() {
        assert!(SevenTvConnection::new(StreamPlatform::Twitch, "1").is_some());
        assert!(SevenTvConnection::new(StreamPlatform::Kick, "1").is_some());
        assert!(SevenTvConnection::new(StreamPlatform::Youtube, "UC1").is_some());
        assert!(SevenTvConnection::new(StreamPlatform::X, "1").is_none());
        assert!(SevenTvConnection::new(StreamPlatform::Custom, "1").is_none());
        assert!(SevenTvConnection::new(StreamPlatform::Twitch, "  ").is_none());
        assert_eq!(seventv_platform(StreamPlatform::Youtube), Some("GOOGLE"));
    }

    #[test]
    fn emote_ids_must_be_ulids() {
        assert!(valid_emote_id(CAT_JAM));
        assert!(valid_emote_id("01HKQT8EWR000ESSWF3625XCS4"));
        assert!(!valid_emote_id("01hkqt8ewr000esswf3625xcs4"));
        assert!(!valid_emote_id("01HKQT8EWR000ESSWF3625XCS"));
        assert!(!valid_emote_id("01HKQT8EWR000ESSWF3625XCSI"));
        assert!(!valid_emote_id("60ae958e229664e8667aea38"));
        assert!(!valid_emote_id("01HKQT8EWR000ESS/../../XCS"));
        assert_eq!(
            emote_image_url(CAT_JAM),
            format!("https://cdn.7tv.app/emote/{CAT_JAM}/2x.webp")
        );
    }

    #[test]
    fn emote_names_allow_punctuation_but_not_whitespace() {
        for name in ["catJAM", "WHAT?", "!join", ":d", "???", "nanaAYAYA"] {
            assert!(valid_emote_name(name), "{name}");
        }
        let long = "a".repeat(101);
        for name in ["", "has space", "tab\there", "line\nbreak", long.as_str()] {
            assert!(!valid_emote_name(name), "{name:?}");
        }
        assert!(valid_emote_name(&"a".repeat(100)));
    }

    #[test]
    fn index_merges_channel_over_global_and_skips_unusable_entries() {
        let sets = sets();
        let index = build_index(Some(&sets.sets[0]), &sets.global);
        // Channel wins over global; within the channel set the first wins.
        assert_eq!(index.get("catJAM").unwrap().id, CAT_JAM);
        assert!(!index.get("catJAM").unwrap().zero_width);
        assert_eq!(index.get("WHAT?").unwrap().id, EZ);
        // Global entries fill in, zero-width carried; the alias is the key.
        assert!(index.get("RainTime").unwrap().zero_width);
        assert_eq!(index.get("nanaAYAYA").unwrap().id, AYAYA);
        assert!(index.get("AYAYA").is_none());
        for skipped in ["badId", "has space", "", "pending", "gone"] {
            assert!(index.get(skipped).is_none(), "{skipped}");
        }
        assert!(index.get("catjam").is_none());
        assert_eq!(index.channel_count(), 2);
    }

    #[test]
    fn a_platform_without_a_link_borrows_the_first_linked_set() {
        let load = assemble_load(&connections(), &[None, link(CHANNEL_SET), None], &sets());
        assert_eq!(load.indexes.len(), 3);
        for platform in [
            StreamPlatform::Twitch,
            StreamPlatform::Kick,
            StreamPlatform::Youtube,
        ] {
            assert_eq!(load.indexes[&platform].get("catJAM").unwrap().id, CAT_JAM);
        }
        assert_eq!(
            load.summary,
            SevenTvSummary::Linked {
                set_name: "Halloween Emotes 2026".to_string(),
                emote_count: 2,
                global_count: 4,
                platforms: vec![
                    StreamPlatform::Twitch,
                    StreamPlatform::Kick,
                    StreamPlatform::Youtube
                ],
                truncated: false,
            }
        );
        assert_eq!(load.set_ids, vec![CHANNEL_SET.to_string()]);
        assert_eq!(
            load.versions.active_sets,
            vec![None, Some(CHANNEL_SET.to_string()), None]
        );
    }

    #[test]
    fn nothing_linked_means_no_emotes_not_even_global() {
        let load = assemble_load(&connections(), &[None, None, None], &sets());
        assert!(load.indexes.is_empty());
        assert_eq!(load.summary, SevenTvSummary::NotLinked);
    }

    #[test]
    fn reload_only_when_a_link_or_a_set_in_use_changed() {
        let loaded = assemble_load(&connections(), &[link(CHANNEL_SET), None, None], &sets());
        let same = loaded.versions.clone();
        assert!(!needs_reload(&loaded, &same));

        let mut edited = same.clone();
        edited.set_updated_at.insert(
            CHANNEL_SET.to_string(),
            Some("2026-10-01T09:00:00Z".to_string()),
        );
        assert!(needs_reload(&loaded, &edited));

        let mut global_edited = same.clone();
        global_edited.global_updated_at = Some("later".to_string());
        assert!(needs_reload(&loaded, &global_edited));

        let mut switched = same.clone();
        switched.active_sets[0] = Some(GLOBAL_SET.to_string());
        assert!(needs_reload(&loaded, &switched));

        // Nothing linked: the global set is unused, so its edits do not
        // reload, but a channel gaining a link does.
        let unlinked = SevenTvLoad {
            indexes: SevenTvIndexes::new(),
            versions: SevenTvVersions {
                active_sets: vec![None, None, None],
                ..SevenTvVersions::default()
            },
            set_ids: Vec::new(),
            summary: SevenTvSummary::NotLinked,
        };
        let mut polled = SevenTvVersions {
            active_sets: vec![None, None, None],
            global_updated_at: Some("g1".to_string()),
            ..SevenTvVersions::default()
        };
        assert!(!needs_reload(&unlinked, &polled));
        polled.active_sets[1] = Some(CHANNEL_SET.to_string());
        assert!(needs_reload(&unlinked, &polled));
    }

    #[derive(Clone)]
    struct MockGql {
        bodies: Arc<Mutex<Vec<Value>>>,
        user_agents: Arc<Mutex<Vec<String>>>,
        status: StatusCode,
        response: Arc<dyn Fn(&Value) -> Value + Send + Sync>,
    }

    async fn mock_gql(
        State(state): State<MockGql>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        state.user_agents.lock().unwrap().push(
            headers
                .get("user-agent")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        );
        let response = (state.response)(&body);
        state.bodies.lock().unwrap().push(body);
        (state.status, Json(response))
    }

    struct MockServer {
        url: String,
        state: MockGql,
        _shutdown: oneshot::Sender<()>,
    }

    async fn spawn_mock(
        status: StatusCode,
        response: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> MockServer {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock listener");
        let addr = listener.local_addr().expect("mock address");
        let state = MockGql {
            bodies: Arc::new(Mutex::new(Vec::new())),
            user_agents: Arc::new(Mutex::new(Vec::new())),
            status,
            response: Arc::new(response),
        };
        let app = Router::new()
            .route("/v4/gql", post(mock_gql))
            .with_state(state.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        MockServer {
            url: format!("http://{addr}/v4/gql"),
            state,
            _shutdown: shutdown_tx,
        }
    }

    /// Answers like 7TV: Twitch `71092938` is linked, everything else is not.
    fn seventv_like(body: &Value) -> Value {
        let query = body["query"].as_str().unwrap_or_default();
        if query.starts_with("query Resolve") {
            let mut users = Map::new();
            for (name, value) in body["variables"].as_object().unwrap() {
                users.insert(
                    name.clone(),
                    if value == "71092938" {
                        json!({ "id": "01FE9DRF000009TR6M9N941CYW",
                                "style": { "activeEmoteSetId": CHANNEL_SET } })
                    } else {
                        Value::Null
                    },
                );
            }
            json!({ "data": { "users": users } })
        } else if query.starts_with("query Sets") {
            json!({ "data": { "emoteSets": {
                "emoteSets": [channel_value()],
                "global": global_value()
            } } })
        } else {
            json!({ "data": null, "errors": [{ "message": "unexpected query" }] })
        }
    }

    #[tokio::test]
    async fn load_resolves_every_connection_in_one_request_with_ids_as_variables() {
        let server = spawn_mock(StatusCode::OK, seventv_like).await;
        let client = SevenTvClient::with_endpoint(&server.url);
        let load = load(&client, &connections()).await.expect("load");
        assert_eq!(load.indexes.len(), 3);
        assert_eq!(
            load.indexes[&StreamPlatform::Youtube]
                .get("catJAM")
                .unwrap()
                .id,
            CAT_JAM
        );
        let bodies = server.state.bodies.lock().unwrap().clone();
        assert_eq!(bodies.len(), 2, "one resolve, one sets request");
        let resolve = &bodies[0];
        let query = resolve["query"].as_str().unwrap();
        assert!(query.contains("platform: TWITCH"));
        assert!(query.contains("platform: KICK"));
        assert!(query.contains("platform: GOOGLE"));
        for id in ["71092938", "676", "UChXKjLEzAB1K7EZQey7Fm1Q"] {
            assert!(!query.contains(id), "{id} must travel as a variable");
        }
        assert_eq!(resolve["variables"]["c2"], "UChXKjLEzAB1K7EZQey7Fm1Q");
        assert_eq!(bodies[1]["variables"]["ids"], json!([CHANNEL_SET]));
        assert!(
            server.state.user_agents.lock().unwrap()[0].starts_with("Videorc-Desktop/"),
            "7TV sees who is calling"
        );
    }

    #[tokio::test]
    async fn load_with_nothing_linked_skips_the_set_request() {
        let server = spawn_mock(StatusCode::OK, seventv_like).await;
        let client = SevenTvClient::with_endpoint(&server.url);
        let only_kick = vec![SevenTvConnection::new(StreamPlatform::Kick, "676").unwrap()];
        let load = load(&client, &only_kick).await.expect("load");
        assert_eq!(load.summary, SevenTvSummary::NotLinked);
        assert!(load.indexes.is_empty());
        assert_eq!(server.state.bodies.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn graphql_errors_win_over_the_http_status() {
        let server = spawn_mock(StatusCode::OK, |_| {
            json!({ "data": null, "errors": [{ "message": "Unknown field \"nope\"\non type" }] })
        })
        .await;
        let client = SevenTvClient::with_endpoint(&server.url);
        let error = client
            .resolve_connections(&connections())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            SevenTvError::GraphQl("Unknown field \"nope\" on type".to_string())
        );
        assert_eq!(error.to_string(), "graphql: Unknown field \"nope\" on type");
    }

    #[tokio::test]
    async fn http_failures_and_bad_bodies_are_classified() {
        let server = spawn_mock(StatusCode::SERVICE_UNAVAILABLE, |_| json!({})).await;
        let client = SevenTvClient::with_endpoint(&server.url);
        let error = client.fetch_sets(&[]).await.unwrap_err();
        assert_eq!(error, SevenTvError::Http("5xx".to_string()));
        assert_eq!(error.to_string(), "http 5xx");

        let server = spawn_mock(StatusCode::OK, |_| json!({ "data": { "users": 7 } })).await;
        let client = SevenTvClient::with_endpoint(&server.url);
        assert_eq!(
            client.resolve_connections(&connections()).await,
            Err(SevenTvError::Decode)
        );

        let server = spawn_mock(StatusCode::OK, seventv_like).await;
        let client = SevenTvClient::with_endpoint(&server.url).with_body_cap(64);
        assert_eq!(
            client.fetch_sets(&[CHANNEL_SET.to_string()]).await,
            Err(SevenTvError::TooLarge)
        );

        let client = SevenTvClient::with_endpoint("http://127.0.0.1:9/v4/gql");
        assert_eq!(
            client.resolve_connections(&connections()).await,
            Err(SevenTvError::Network)
        );
    }

    #[tokio::test]
    async fn sets_past_the_first_page_are_followed() {
        let server = spawn_mock(StatusCode::OK, |body| {
            let query = body["query"].as_str().unwrap_or_default();
            if query.starts_with("query Sets") {
                let mut channel = channel_value();
                channel["emotes"]["pageCount"] = json!(2);
                json!({ "data": { "emoteSets": {
                    "emoteSets": [channel],
                    "global": global_value()
                } } })
            } else {
                assert!(query.contains("page: 2"));
                assert_eq!(body["variables"]["id"], CHANNEL_SET);
                json!({ "data": { "emoteSets": { "emoteSet": set_value(
                    CHANNEL_SET, "Halloween Emotes 2026", "x",
                    vec![entry("pageTwo", AYAYA, false)]
                ) } } })
            }
        })
        .await;
        let client = SevenTvClient::with_endpoint(&server.url);
        let sets = client
            .fetch_sets(&[CHANNEL_SET.to_string()])
            .await
            .expect("sets");
        let channel = &sets.sets[0];
        assert!(channel.emotes.iter().any(|emote| emote.alias == "pageTwo"));
        assert!(!channel.truncated);
        assert_eq!(server.state.bodies.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn poll_reads_active_sets_and_update_times_in_one_request() {
        let server = spawn_mock(StatusCode::OK, |body| {
            let query = body["query"].as_str().unwrap_or_default();
            assert!(query.starts_with("query Poll("));
            json!({ "data": {
                "users": {
                    "c0": { "id": "u", "style": { "activeEmoteSetId": CHANNEL_SET } },
                    "c1": null
                },
                "emoteSets": {
                    "emoteSets": [{ "id": CHANNEL_SET, "updatedAt": "t1" }],
                    "global": { "id": GLOBAL_SET, "updatedAt": "g1" }
                }
            } })
        })
        .await;
        let client = SevenTvClient::with_endpoint(&server.url);
        let versions = client
            .poll_versions(&connections()[..2], &[CHANNEL_SET.to_string()])
            .await
            .expect("poll");
        assert_eq!(
            versions,
            SevenTvVersions {
                active_sets: vec![Some(CHANNEL_SET.to_string()), None],
                set_updated_at: BTreeMap::from([(CHANNEL_SET.to_string(), Some("t1".to_string()))]),
                global_updated_at: Some("g1".to_string()),
            }
        );
        assert_eq!(server.state.bodies.lock().unwrap().len(), 1);
    }

    fn chat(
        platform: StreamPlatform,
        text: &str,
        fragments: Vec<LiveChatMessageFragment>,
    ) -> LiveChatMessage {
        LiveChatMessage {
            id: format!("{platform:?}:{text}"),
            provider_message_id: format!("p-{text}"),
            platform,
            target_id: None,
            session_id: "s".to_string(),
            author_id: Some("viewer".to_string()),
            author_name: "Viewer".to_string(),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_affiliation: None,
            author_roles: Vec::new(),
            published_at: "2026-10-01T00:00:00Z".to_string(),
            received_at: "2026-10-01T00:00:00Z".to_string(),
            message_text: text.to_string(),
            fragments,
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: None,
            details: None,
            reply: None,
            first_message: false,
        }
    }

    fn fragment(kind: &str, text: &str, image_url: Option<&str>) -> LiveChatMessageFragment {
        LiveChatMessageFragment {
            fragment_type: kind.to_string(),
            text: text.to_string(),
            image_url: image_url.map(str::to_string),
            zero_width: false,
        }
    }

    fn text(text: &str) -> LiveChatMessageFragment {
        fragment("text", text, None)
    }

    fn seventv(name: &str, id: &str, zero_width: bool) -> LiveChatMessageFragment {
        LiveChatMessageFragment {
            zero_width,
            ..fragment("emote", name, Some(&emote_image_url(id)))
        }
    }

    fn all_indexes() -> SevenTvIndexes {
        let sets = sets();
        let index = Arc::new(build_index(Some(&sets.sets[0]), &sets.global));
        [
            StreamPlatform::Twitch,
            StreamPlatform::Kick,
            StreamPlatform::Youtube,
        ]
        .into_iter()
        .map(|platform| (platform, index.clone()))
        .collect()
    }

    fn decorated(message: LiveChatMessage) -> LiveChatMessage {
        let mut messages = vec![message];
        decorate(&mut messages, &all_indexes());
        messages.remove(0)
    }

    #[test]
    fn twitch_text_runs_split_around_7tv_emotes_with_whitespace_kept() {
        let message = decorated(chat(
            StreamPlatform::Twitch,
            "hi catJAM  there",
            vec![text("hi catJAM  there")],
        ));
        assert_eq!(message.message_text, "hi catJAM  there");
        assert_eq!(
            message.fragments,
            vec![
                text("hi "),
                seventv("catJAM", CAT_JAM, false),
                text("  there")
            ]
        );
    }

    #[test]
    fn platform_emotes_mentions_and_zero_width_are_handled() {
        let twitch_kappa = "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0";
        let message = decorated(chat(
            StreamPlatform::Twitch,
            "@catJAM catJAM RainTime",
            vec![
                fragment("mention", "@catJAM", None),
                text(" "),
                fragment("emote", "catJAM", Some(twitch_kappa)),
                text(" RainTime"),
            ],
        ));
        assert_eq!(
            message.fragments,
            vec![
                fragment("mention", "@catJAM", None),
                text(" "),
                fragment("emote", "catJAM", Some(twitch_kappa)),
                text(" "),
                seventv("RainTime", RAIN_TIME, true),
            ]
        );
    }

    #[test]
    fn youtube_and_kick_messages_get_fragments_built_from_their_text() {
        let youtube = decorated(chat(
            StreamPlatform::Youtube,
            "catJAM\u{3000}EZ",
            Vec::new(),
        ));
        assert_eq!(
            youtube.fragments,
            vec![
                seventv("catJAM", CAT_JAM, false),
                text("\u{3000}"),
                seventv("EZ", EZ, false)
            ]
        );
        let kick_angel = "https://files.kick.com/emotes/1730752/fullsize";
        let kick = decorated(chat(
            StreamPlatform::Kick,
            "hi emojiAngel catJAM",
            vec![
                text("hi "),
                fragment("emote", "emojiAngel", Some(kick_angel)),
                text(" catJAM"),
            ],
        ));
        assert_eq!(
            kick.fragments,
            vec![
                text("hi "),
                fragment("emote", "emojiAngel", Some(kick_angel)),
                text(" "),
                seventv("catJAM", CAT_JAM, false),
            ]
        );
    }

    #[test]
    fn messages_without_a_match_are_left_exactly_as_they_were() {
        for (text_value, fragments) in [
            ("hello there", Vec::new()),
            ("hello there", vec![text("hello there")]),
            ("catjam CATJAM", Vec::new()),
            ("catJAM, EZ! (catJAM)", Vec::new()),
            ("", Vec::new()),
        ] {
            let original = chat(StreamPlatform::Youtube, text_value, fragments);
            assert_eq!(decorated(original.clone()), original, "{text_value:?}");
        }
        let punctuated = decorated(chat(StreamPlatform::Youtube, "WHAT? catJAM?", Vec::new()));
        assert_eq!(
            punctuated.fragments,
            vec![seventv("WHAT?", EZ, false), text(" catJAM?")]
        );
    }

    #[test]
    fn multibyte_text_next_to_emotes_never_splits_a_char() {
        let message = decorated(chat(
            StreamPlatform::Twitch,
            "🎉catJAM 🎉 catJAM🎉 ñ catJAM",
            Vec::new(),
        ));
        assert_eq!(
            message.fragments,
            vec![
                text("🎉catJAM 🎉 catJAM🎉 ñ "),
                seventv("catJAM", CAT_JAM, false)
            ]
        );
    }

    #[test]
    fn only_viewer_chat_and_paid_rows_on_7tv_platforms_are_decorated() {
        let mut paid = chat(StreamPlatform::Twitch, "catJAM", Vec::new());
        paid.event_type = LiveChatEventType::Paid;
        assert_eq!(
            decorated(paid).fragments,
            vec![seventv("catJAM", CAT_JAM, false)]
        );
        for event_type in [
            LiveChatEventType::System,
            LiveChatEventType::Membership,
            LiveChatEventType::Follow,
            LiveChatEventType::Moderation,
            LiveChatEventType::Deleted,
        ] {
            let mut row = chat(StreamPlatform::Twitch, "catJAM", Vec::new());
            row.event_type = event_type;
            assert_eq!(decorated(row.clone()), row, "{event_type:?}");
        }
        let mut deleted = chat(StreamPlatform::Twitch, "catJAM", Vec::new());
        deleted.is_deleted = true;
        assert_eq!(decorated(deleted.clone()), deleted);
        let x = chat(StreamPlatform::X, "catJAM", Vec::new());
        assert_eq!(decorated(x.clone()), x);
    }

    #[test]
    fn at_most_100_emotes_per_message_and_decorating_twice_changes_nothing() {
        let spam = vec!["EZ"; 101].join(" ");
        let once = decorated(chat(StreamPlatform::Youtube, &spam, Vec::new()));
        let emotes = once
            .fragments
            .iter()
            .filter(|fragment| is_seventv_fragment(fragment))
            .count();
        assert_eq!(emotes, 100);
        assert_eq!(once.fragments.last(), Some(&text(" EZ")));
        assert_eq!(decorated(once.clone()), once);

        let simple = decorated(chat(StreamPlatform::Twitch, "hi catJAM", Vec::new()));
        assert_eq!(decorated(simple.clone()), simple);
    }

    #[test]
    fn decorated_fragments_serialize_zero_width_only_when_set() {
        let message = decorated(chat(StreamPlatform::Twitch, "catJAM RainTime", Vec::new()));
        let json = serde_json::to_value(&message.fragments).unwrap();
        assert_eq!(
            json,
            json!([
                { "type": "emote", "text": "catJAM",
                  "imageUrl": format!("https://cdn.7tv.app/emote/{CAT_JAM}/2x.webp") },
                { "type": "text", "text": " " },
                { "type": "emote", "text": "RainTime", "zeroWidth": true,
                  "imageUrl": format!("https://cdn.7tv.app/emote/{RAIN_TIME}/2x.webp") },
            ])
        );
    }

    #[test]
    fn session_connections_take_one_channel_per_platform_in_borrow_order() {
        let connections = session_connections([
            (StreamPlatform::X, Some("x-user")),
            (StreamPlatform::Youtube, Some("UC123")),
            (StreamPlatform::Kick, None),
            (StreamPlatform::Twitch, Some("71092938")),
            (StreamPlatform::Twitch, Some("second-twitch")),
            (StreamPlatform::Kick, Some("676")),
        ]);
        assert_eq!(
            connections,
            vec![
                SevenTvConnection::new(StreamPlatform::Twitch, "71092938").unwrap(),
                SevenTvConnection::new(StreamPlatform::Kick, "676").unwrap(),
                SevenTvConnection::new(StreamPlatform::Youtube, "UC123").unwrap(),
            ]
        );
    }

    #[test]
    fn failures_back_off_to_five_minutes() {
        let interval = Duration::from_secs(30);
        let waits: Vec<u64> = [0, 1, 2, 3, 4, 5, 50]
            .into_iter()
            .map(|failures| backoff(interval, failures).as_secs())
            .collect();
        assert_eq!(waits, vec![30, 30, 60, 120, 240, 300, 300]);
    }

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    fn provider(
        platform: StreamPlatform,
        account_id: &str,
    ) -> crate::live_chat::LiveChatProviderState {
        use crate::live_chat::{
            CommentsReadState, CommentsWriteState, LiveChatProviderConnectionState,
        };
        crate::live_chat::LiveChatProviderState {
            id: format!("{platform:?}"),
            platform,
            target_id: None,
            account_id: Some(account_id.to_string()),
            account_label: None,
            read: CommentsReadState::Ready,
            write: CommentsWriteState::Unavailable,
            moderate: None,
            state: LiveChatProviderConnectionState::Connected,
            message: String::new(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        }
    }

    async fn start_chat_session(
        state: &AppState,
        providers: Vec<crate::live_chat::LiveChatProviderState>,
    ) -> u64 {
        state.database.ensure_fake_live_chat_session("s").unwrap();
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session("s".to_string(), providers);
        coordinator.session_generation()
    }

    async fn wait_until(mut condition: impl AsyncFnMut() -> bool) {
        for _ in 0..500 {
            if condition().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never held");
    }

    fn logs_containing(state: &AppState, needle: &str) -> Vec<String> {
        state
            .recent_logs(200)
            .into_iter()
            .filter(|log| log.message.contains(needle))
            .map(|log| format!("{} {}", log.level, log.message))
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_loaded_session_decorates_buffer_storage_event_and_phone_alike() {
        let server = spawn_mock(StatusCode::OK, seventv_like).await;
        let state = test_state();
        let generation = start_chat_session(
            &state,
            vec![
                provider(StreamPlatform::Twitch, "71092938"),
                provider(StreamPlatform::Youtube, "UC-not-linked"),
                provider(StreamPlatform::X, "x-user"),
            ],
        )
        .await;
        let connections = state.live_chat.lock().await.seventv_connections();
        assert_eq!(connections.len(), 2, "X has no 7TV connection");
        let task = tokio::spawn(run_session(
            state.clone(),
            generation,
            SevenTvClient::with_endpoint(&server.url),
            connections,
            Duration::from_secs(3600),
        ));
        wait_until(async || !state.live_chat.lock().await.seventv_indexes().is_empty()).await;
        assert_eq!(
            logs_containing(&state, "7TV emotes"),
            vec![
                "info 7TV emotes: \"Halloween Emotes 2026\" (2 emotes + 4 global) for Twitch, YouTube chat."
                    .to_string()
            ]
        );

        let mut events = state.events.subscribe();
        let mut youtube = chat(StreamPlatform::Youtube, "hi catJAM RainTime", Vec::new());
        youtube.id = "youtube-1".to_string();
        let mut x = chat(StreamPlatform::X, "catJAM", Vec::new());
        x.id = "x-1".to_string();
        assert!(crate::live_chat::deliver_message(&state, youtube).await);
        assert!(crate::live_chat::deliver_message(&state, x).await);

        let expected = vec![
            text("hi "),
            seventv("catJAM", CAT_JAM, false),
            text(" "),
            seventv("RainTime", RAIN_TIME, true),
        ];
        let stored = state
            .database
            .list_live_chat_messages_recent("s", 10)
            .unwrap();
        let stored_youtube = stored.iter().find(|row| row.id == "youtube-1").unwrap();
        assert_eq!(stored_youtube.fragments, expected);
        assert_eq!(stored_youtube.message_text, "hi catJAM RainTime");
        let stored_x = stored.iter().find(|row| row.id == "x-1").unwrap();
        assert!(stored_x.fragments.is_empty(), "X is never decorated");

        let snapshot = crate::live_chat::current_status(&state).await;
        let buffered = snapshot
            .messages
            .iter()
            .find(|row| row.id == "youtube-1")
            .unwrap();
        assert_eq!(buffered.fragments, expected);

        let mut emitted = None;
        let mut phone = None;
        while let Ok(event) = events.try_recv() {
            if event.event == "liveChat.message" && event.payload["id"] == "youtube-1" {
                emitted = Some(event.payload.clone());
            }
            if event.event == "remote.chat.message" && event.payload["id"] == "youtube-1" {
                phone = Some(event.payload.clone());
            }
        }
        let emitted = emitted.expect("liveChat.message for the YouTube row");
        assert_eq!(emitted["fragments"][3]["zeroWidth"], true);
        assert_eq!(
            emitted["fragments"][1]["imageUrl"],
            format!("https://cdn.7tv.app/emote/{CAT_JAM}/2x.webp")
        );
        if let Some(phone) = phone {
            assert!(
                !phone.to_string().contains("cdn.7tv.app"),
                "the phone projection never carries image URLs"
            );
        }
        task.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn nothing_linked_installs_nothing_and_says_so() {
        let server = spawn_mock(StatusCode::OK, seventv_like).await;
        let state = test_state();
        let generation =
            start_chat_session(&state, vec![provider(StreamPlatform::Kick, "676")]).await;
        let connections = state.live_chat.lock().await.seventv_connections();
        let task = tokio::spawn(run_session(
            state.clone(),
            generation,
            SevenTvClient::with_endpoint(&server.url),
            connections,
            Duration::from_secs(3600),
        ));
        wait_until(async || !logs_containing(&state, "7TV emotes").is_empty()).await;
        assert_eq!(
            logs_containing(&state, "7TV emotes"),
            vec![
                "info 7TV emotes: no 7TV account is linked to the connected Kick channel, so chat shows none."
                    .to_string()
            ]
        );
        assert!(state.live_chat.lock().await.seventv_indexes().is_empty());
        task.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_replaced_session_never_receives_the_old_load() {
        let server = spawn_mock(StatusCode::OK, seventv_like).await;
        let state = test_state();
        let old =
            start_chat_session(&state, vec![provider(StreamPlatform::Twitch, "71092938")]).await;
        let fresh = start_chat_session(&state, Vec::new()).await;
        assert_ne!(old, fresh);
        run_session(
            state.clone(),
            old,
            SevenTvClient::with_endpoint(&server.url),
            connections(),
            Duration::from_millis(10),
        )
        .await;
        assert!(server.state.bodies.lock().unwrap().is_empty());
        let mut coordinator = state.live_chat.lock().await;
        let linked = SevenTvStatus::of(SevenTvState::Linked);
        assert!(!coordinator.install_seventv_load(old, all_indexes(), linked.clone()));
        assert!(!coordinator.set_seventv_status(old, SevenTvStatus::loading()));
        assert!(coordinator.seventv_indexes().is_empty());
        assert_eq!(coordinator.seventv_status().state, SevenTvState::Idle);
        assert!(coordinator.install_seventv_load(fresh, all_indexes(), linked));
        coordinator.stop_session();
        assert!(coordinator.seventv_indexes().is_empty(), "stop drops them");
        assert_eq!(
            coordinator.seventv_status().state,
            SevenTvState::Linked,
            "Settings keeps the last outcome after the stream ends"
        );
    }

    #[test]
    fn statuses_serialize_without_nulls() {
        let sets = sets();
        let load = assemble_load(&connections(), &[link(CHANNEL_SET), None, None], &sets);
        assert_eq!(
            serde_json::to_value(SevenTvStatus::from_summary(&load.summary)).unwrap(),
            json!({
                "state": "linked",
                "setName": "Halloween Emotes 2026",
                "emoteCount": 2,
                "globalCount": 4,
                "platforms": ["twitch", "kick", "youtube"]
            })
        );
        assert_eq!(
            serde_json::to_value(SevenTvStatus::failed(&SevenTvError::Http(
                "5xx".to_string()
            )))
            .unwrap(),
            json!({ "state": "error", "error": "http 5xx" })
        );
        assert_eq!(
            serde_json::to_value(SevenTvStatus::from_summary(&SevenTvSummary::NotLinked)).unwrap(),
            json!({ "state": "notLinked" })
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_changed_set_is_reloaded_once_and_swapped_in() {
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen_polls = polls.clone();
        let server = spawn_mock(StatusCode::OK, move |body| {
            let query = body["query"].as_str().unwrap_or_default();
            let edited = seen_polls.load(std::sync::atomic::Ordering::SeqCst) >= 2;
            if query.starts_with("query Poll") {
                seen_polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let updated = if seen_polls.load(std::sync::atomic::Ordering::SeqCst) >= 2 {
                    "edited"
                } else {
                    "2026-10-01T08:20:30.009+00:00"
                };
                return json!({ "data": {
                    "users": { "c0": { "id": "u", "style": { "activeEmoteSetId": CHANNEL_SET } } },
                    "emoteSets": {
                        "emoteSets": [{ "id": CHANNEL_SET, "updatedAt": updated }],
                        "global": { "id": GLOBAL_SET, "updatedAt": "2026-08-01T21:13:37.761+00:00" }
                    }
                } });
            }
            if query.starts_with("query Sets") && edited {
                let mut channel = channel_value();
                channel["updatedAt"] = json!("edited");
                channel["emotes"]["items"]
                    .as_array_mut()
                    .unwrap()
                    .push(entry("newEmote", AYAYA, false));
                return json!({ "data": { "emoteSets": {
                    "emoteSets": [channel],
                    "global": global_value()
                } } });
            }
            seventv_like(body)
        })
        .await;
        let state = test_state();
        let generation =
            start_chat_session(&state, vec![provider(StreamPlatform::Twitch, "71092938")]).await;
        let task = tokio::spawn(run_session(
            state.clone(),
            generation,
            SevenTvClient::with_endpoint(&server.url),
            vec![SevenTvConnection::new(StreamPlatform::Twitch, "71092938").unwrap()],
            Duration::from_millis(10),
        ));
        wait_until(async || {
            state
                .live_chat
                .lock()
                .await
                .seventv_indexes()
                .get(&StreamPlatform::Twitch)
                .is_some_and(|index| index.get("newEmote").is_some())
        })
        .await;
        // Let a few unchanged polls pass, then check nothing reloaded again.
        wait_until(async || polls.load(std::sync::atomic::Ordering::SeqCst) >= 5).await;
        task.abort();
        let kinds: Vec<String> = server
            .state
            .bodies
            .lock()
            .unwrap()
            .iter()
            .map(|body| {
                body["query"]
                    .as_str()
                    .unwrap_or_default()
                    .split('(')
                    .next()
                    .unwrap_or_default()
                    .trim_start_matches("query ")
                    .to_string()
            })
            .collect();
        let loads = kinds.iter().filter(|kind| *kind == "Sets").count();
        assert_eq!(loads, 2, "initial load plus exactly one reload: {kinds:?}");
        assert_eq!(&kinds[..4], ["Resolve", "Sets", "Poll", "Poll"]);
        assert_eq!(logs_containing(&state, "7TV emotes updated").len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failures_are_logged_once_per_kind_and_chat_is_untouched() {
        let server = spawn_mock(StatusCode::SERVICE_UNAVAILABLE, |_| json!({})).await;
        let state = test_state();
        let generation =
            start_chat_session(&state, vec![provider(StreamPlatform::Twitch, "71092938")]).await;
        let task = tokio::spawn(run_session(
            state.clone(),
            generation,
            SevenTvClient::with_endpoint(&server.url),
            vec![SevenTvConnection::new(StreamPlatform::Twitch, "71092938").unwrap()],
            Duration::from_millis(5),
        ));
        wait_until(async || server.state.bodies.lock().unwrap().len() >= 3).await;
        task.abort();
        assert_eq!(
            logs_containing(&state, "7TV"),
            vec![
                "warn 7TV emotes unavailable (http 5xx). Chat works without them; Videorc keeps retrying."
                    .to_string()
            ]
        );
        assert!(state.live_chat.lock().await.seventv_indexes().is_empty());
    }

    /// Schema-drift alarm against the real 7TV API. Run by hand before a
    /// release: `cargo test -p videorc-backend seventv_live_schema -- --ignored`.
    #[tokio::test]
    #[ignore = "talks to the live 7TV API"]
    async fn seventv_live_schema() {
        let client = SevenTvClient::new();
        let connections = vec![SevenTvConnection::new(StreamPlatform::Twitch, "71092938").unwrap()];
        let load = load(&client, &connections).await.expect("live 7TV load");
        let SevenTvSummary::Linked {
            emote_count,
            global_count,
            ..
        } = load.summary
        else {
            panic!("the reference channel lost its 7TV link");
        };
        assert!(emote_count > 0 && global_count > 0);
        let versions = client
            .poll_versions(&connections, &load.set_ids)
            .await
            .expect("live 7TV poll");
        assert_eq!(versions.active_sets, load.versions.active_sets);
    }

    /// Plan 155, D6: the GIF mode rides the 7TV settings row. A row saved
    /// before the field existed reads as Animated, the wire name is
    /// camelCase, and the patch still refuses keys it does not know.
    #[test]
    fn twitch_gif_mode_defaults_to_animated_and_round_trips() {
        let legacy: ChatEmoteSettings = serde_json::from_str(r#"{"sevenTv":false}"#).unwrap();
        assert_eq!(
            legacy,
            ChatEmoteSettings {
                seven_tv: false,
                twitch_gifs: TwitchGifMode::Animated
            }
        );
        assert_eq!(
            ChatEmoteSettings::default().twitch_gifs,
            TwitchGifMode::Animated
        );

        let saved = serde_json::to_value(ChatEmoteSettings {
            seven_tv: true,
            twitch_gifs: TwitchGifMode::Still,
        })
        .unwrap();
        assert_eq!(saved, json!({ "sevenTv": true, "twitchGifs": "still" }));
        let back: ChatEmoteSettings = serde_json::from_value(saved).unwrap();
        assert_eq!(back.twitch_gifs, TwitchGifMode::Still);

        let patch: ChatEmoteSettingsPatch =
            serde_json::from_value(json!({ "twitchGifs": "off" })).unwrap();
        assert_eq!(patch.seven_tv, None);
        assert_eq!(patch.twitch_gifs, Some(TwitchGifMode::Off));
        assert!(
            serde_json::from_value::<ChatEmoteSettingsPatch>(json!({ "gifs": "off" })).is_err()
        );
        assert!(
            serde_json::from_value::<ChatEmoteSettingsPatch>(json!({ "twitchGifs": "paused" }))
                .is_err()
        );

        let snapshot = serde_json::to_value(ChatEmotesState {
            seven_tv: true,
            seven_tv_status: SevenTvStatus::of(SevenTvState::Idle),
            twitch_gifs: TwitchGifMode::Off,
        })
        .unwrap();
        assert_eq!(snapshot["twitchGifs"], "off");
    }
}
