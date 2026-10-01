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

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::streaming::StreamPlatform;

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
}
