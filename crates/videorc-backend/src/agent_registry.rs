//! Agents registry (plan 209 S2): the agents a streamer connected, each with
//! its own token (D6), the Agents switch, and the listener's persisted port.
//!
//! Tokens are shown once, at creation, and stored only as a SHA-256 hash
//! (Security table: "a stolen or old agent token"). The registry lives in the
//! secret store as one JSON record, like Phone remote's devices, so it
//! survives restarts and never lands in the database or a log.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_segmentation::UnicodeSegmentation;

use crate::secrets;
use crate::storage::AgentActivityOutcome;

pub const AGENTS_SECRET: &str = "agents.registry";
pub const MAX_AGENTS: usize = 16;
pub const MAX_AGENT_NAME_CHARS: usize = 40;
/// Every token starts with this so a streamer (or a leak scan) can tell one
/// apart from the renderer, admin and remote tokens.
pub const TOKEN_PREFIX: &str = "vrc_agent_";
/// The bridge pings every 15 s while its agent app runs; an agent heard from
/// inside this window shows as connected in the Session line (D12).
pub const AGENT_PRESENCE_WINDOW: Duration = Duration::from_secs(45);
/// `lastUsedAt` is persisted at most this often per agent: the secret store
/// is one file rewrite, and a busy agent calls many times a minute.
const LAST_USED_PERSIST_INTERVAL: Duration = Duration::from_secs(60);

/// Which app the streamer connected (D6): it picks the config line shown.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentClientKind {
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
    Codex,
    VsCode,
    Other,
}

/// One connected agent as persisted. The token itself never exists here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    pub client: AgentClientKind,
    /// Lowercase hex SHA-256 of the token.
    pub token_hash: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsPersisted {
    #[serde(default)]
    pub enabled: bool,
    /// The port the listener last bound, so client configs stay valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default)]
    pub agents: Vec<AgentRecord>,
}

impl AgentsPersisted {
    pub fn load_from_secrets() -> Self {
        secrets::try_get_secret(AGENTS_SECRET)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn persist(&self) -> Result<()> {
        secrets::put_secret(AGENTS_SECRET, &serde_json::to_string(self)?)
    }
}

/// The last thing an agent did, for the Settings list ("switched scene · 2 s ago").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentLastAction {
    pub tool: String,
    pub at: String,
    pub outcome: AgentActivityOutcome,
}

/// Who called, carried from the `/mcp` guard to the tool executors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Default)]
pub struct AgentRegistry {
    pub persisted: AgentsPersisted,
    /// Last call or heartbeat per agent id (monotonic), for presence.
    last_seen: HashMap<String, Instant>,
    /// When `lastUsedAt` was last written to the store, per agent.
    last_used_persisted: HashMap<String, Instant>,
    last_action: HashMap<String, AgentLastAction>,
    /// Agents whose last action was already looked up in Activity after a
    /// restart (found or not), so a status read queries each at most once.
    last_action_seeded: HashSet<String>,
    /// A presence watch is running (`agent_mcp::watch_presence`): it
    /// publishes `agents.status` when a connected agent's 45 s lapse.
    presence_watch: bool,
}

impl AgentRegistry {
    pub fn load_from_secrets() -> Self {
        Self {
            persisted: AgentsPersisted::load_from_secrets(),
            ..Self::default()
        }
    }

    pub fn persist(&self) -> Result<()> {
        self.persisted.persist()
    }

    /// Create an agent and mint its token. The token is returned once and is
    /// never stored; the caller shows it and forgets it.
    pub fn create(
        &mut self,
        name: &str,
        client: AgentClientKind,
        created_at: &str,
    ) -> std::result::Result<(AgentRecord, String), String> {
        let name = sanitize_agent_name(name);
        if name.is_empty() {
            return Err("Name the agent first.".to_string());
        }
        if self.persisted.agents.len() >= MAX_AGENTS {
            return Err(format!(
                "{MAX_AGENTS} agents are connected. Remove one first."
            ));
        }
        let token = generate_token();
        let record = AgentRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            client,
            token_hash: hash_token(&token),
            created_at: created_at.to_string(),
            last_used_at: None,
        };
        self.persisted.agents.push(record.clone());
        Ok((record, token))
    }

    /// Remove an agent: its token stops authenticating at once.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.persisted.agents.len();
        self.persisted.agents.retain(|agent| agent.id != id);
        self.last_seen.remove(id);
        self.last_used_persisted.remove(id);
        self.last_action.remove(id);
        self.last_action_seeded.remove(id);
        self.persisted.agents.len() != before
    }

    /// The agent a Bearer token belongs to, by constant-time hash compare.
    pub fn authenticate(&self, token: &str) -> Option<AgentIdentity> {
        if !token.starts_with(TOKEN_PREFIX) {
            return None;
        }
        let supplied = hash_token(token);
        self.persisted
            .agents
            .iter()
            .find(|agent| constant_time_equal(agent.token_hash.as_bytes(), supplied.as_bytes()))
            .map(|agent| AgentIdentity {
                id: agent.id.clone(),
                name: agent.name.clone(),
            })
    }

    pub fn agent(&self, id: &str) -> Option<&AgentRecord> {
        self.persisted.agents.iter().find(|agent| agent.id == id)
    }

    /// Note a call or heartbeat. Returns true when `lastUsedAt` should be
    /// persisted now (at most once a minute per agent).
    pub fn touch(&mut self, id: &str, now: Instant, wall: &str) -> bool {
        let Some(agent) = self
            .persisted
            .agents
            .iter_mut()
            .find(|agent| agent.id == id)
        else {
            return false;
        };
        agent.last_used_at = Some(wall.to_string());
        self.last_seen.insert(id.to_string(), now);
        let due = self
            .last_used_persisted
            .get(id)
            .is_none_or(|last| now.duration_since(*last) >= LAST_USED_PERSIST_INTERVAL);
        if due {
            self.last_used_persisted.insert(id.to_string(), now);
        }
        due
    }

    pub fn record_action(&mut self, id: &str, action: AgentLastAction) {
        if self.agent(id).is_some() {
            self.last_action.insert(id.to_string(), action);
        }
    }

    pub fn last_action(&self, id: &str) -> Option<&AgentLastAction> {
        self.last_action.get(id)
    }

    /// Agents with no last action in memory that Activity was not asked
    /// about yet: after a restart, their newest row says what they did last.
    pub fn last_actions_to_seed(&self) -> Vec<String> {
        self.persisted
            .agents
            .iter()
            .filter(|agent| {
                !self.last_action.contains_key(&agent.id)
                    && !self.last_action_seeded.contains(&agent.id)
            })
            .map(|agent| agent.id.clone())
            .collect()
    }

    /// The newest Activity row's action, unless the agent acted since the
    /// lookup began (that action is newer) or was removed.
    pub fn seed_last_action(&mut self, id: &str, action: Option<AgentLastAction>) {
        if self.agent(id).is_none() {
            return;
        }
        self.last_action_seeded.insert(id.to_string());
        if let Some(action) = action {
            self.last_action.entry(id.to_string()).or_insert(action);
        }
    }

    pub fn connected(&self, id: &str, now: Instant) -> bool {
        self.last_seen
            .get(id)
            .is_some_and(|seen| now.saturating_duration_since(*seen) < AGENT_PRESENCE_WINDOW)
    }

    pub fn connected_count(&self, now: Instant) -> usize {
        self.persisted
            .agents
            .iter()
            .filter(|agent| self.connected(&agent.id, now))
            .count()
    }

    /// The connected agents' ids, in registry order.
    pub fn connected_ids(&self, now: Instant) -> Vec<String> {
        self.persisted
            .agents
            .iter()
            .filter(|agent| self.connected(&agent.id, now))
            .map(|agent| agent.id.clone())
            .collect()
    }

    /// Stop (D12): every agent reads as disconnected at once.
    pub fn disconnect_all(&mut self) {
        self.last_seen.clear();
    }

    /// True when the caller must start the presence watch: none runs yet.
    pub fn claim_presence_watch(&mut self) -> bool {
        !std::mem::replace(&mut self.presence_watch, true)
    }

    pub fn release_presence_watch(&mut self) {
        self.presence_watch = false;
    }

    /// When the next connected agent's presence lapses. With none
    /// connected the watch ends here, under the same lock a touch takes, so
    /// a touch that lands after it starts a new watch.
    pub fn next_presence_lapse(&mut self, now: Instant) -> Option<Instant> {
        let next = self
            .persisted
            .agents
            .iter()
            .filter_map(|agent| self.last_seen.get(&agent.id))
            .map(|seen| *seen + AGENT_PRESENCE_WINDOW)
            .filter(|lapse| *lapse > now)
            .min();
        if next.is_none() {
            self.presence_watch = false;
        }
        next
    }
}

pub fn hash_token(token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(token.as_bytes());
    let bytes = digest.finalize();
    let mut hex = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

pub fn generate_token() -> String {
    // Two UUIDs: 64 hex chars of entropy, like the remote-control token.
    format!(
        "{TOKEN_PREFIX}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// One line, collapsed whitespace, at most `MAX_AGENT_NAME_CHARS` graphemes.
/// A pile of combining marks is one grapheme: the name also stops at twice
/// the grapheme cap in chars, which keeps it inside the strict contract's 160
/// UTF-16 units.
pub fn sanitize_agent_name(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    let mut chars = 0;
    for (index, grapheme) in collapsed.graphemes(true).enumerate() {
        if index >= MAX_AGENT_NAME_CHARS {
            break;
        }
        if grapheme.chars().any(char::is_control) {
            continue;
        }
        chars += grapheme.chars().count();
        if chars > MAX_AGENT_NAME_CHARS * 2 {
            break;
        }
        out.push_str(grapheme);
    }
    out.trim().to_string()
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut different = left.len() ^ right.len();
    let width = left.len().max(right.len());
    for index in 0..width {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        different |= usize::from(a ^ b);
    }
    different == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_mints_a_prefixed_token_and_stores_only_its_hash() {
        let mut registry = AgentRegistry::default();
        let (record, token) = registry
            .create(
                "  Claude   Desktop ",
                AgentClientKind::ClaudeDesktop,
                "2026-10-27T10:00:00Z",
            )
            .unwrap();
        assert!(token.starts_with(TOKEN_PREFIX));
        assert_eq!(token.len(), TOKEN_PREFIX.len() + 64);
        assert_eq!(record.name, "Claude Desktop");
        assert_eq!(record.token_hash, hash_token(&token));
        assert_eq!(record.token_hash.len(), 64);
        let persisted = serde_json::to_string(&registry.persisted).unwrap();
        assert!(!persisted.contains(&token), "the token never rests on disk");
        assert!(persisted.contains("tokenHash"));
        assert!(!persisted.contains("null"), "{persisted}");

        assert_eq!(
            registry.authenticate(&token),
            Some(AgentIdentity {
                id: record.id.clone(),
                name: "Claude Desktop".to_string()
            })
        );
        assert_eq!(registry.authenticate(&format!("{token}x")), None);
        assert_eq!(
            registry.authenticate(&record.token_hash),
            None,
            "a hash is not a token"
        );
        assert_eq!(registry.authenticate(""), None);
        assert_eq!(registry.authenticate("renderer-token"), None);
    }

    #[test]
    fn remove_revokes_and_the_cap_and_name_rules_hold() {
        let mut registry = AgentRegistry::default();
        assert_eq!(
            registry.create("   ", AgentClientKind::Other, "t"),
            Err("Name the agent first.".to_string())
        );
        let mut tokens = Vec::new();
        for index in 0..MAX_AGENTS {
            let (_, token) = registry
                .create(&format!("Agent {index}"), AgentClientKind::Cursor, "t")
                .unwrap();
            tokens.push(token);
        }
        assert!(
            registry
                .create("One more", AgentClientKind::Codex, "t")
                .unwrap_err()
                .contains("Remove one first")
        );
        let first = registry.authenticate(&tokens[0]).unwrap();
        assert!(registry.remove(&first.id));
        assert!(!registry.remove(&first.id));
        assert_eq!(registry.authenticate(&tokens[0]), None);
        assert!(registry.authenticate(&tokens[1]).is_some());
        assert_eq!(
            sanitize_agent_name(&"x".repeat(100)).chars().count(),
            MAX_AGENT_NAME_CHARS
        );
        assert_eq!(sanitize_agent_name("a\u{0}b\tc"), "ab c");
        let zalgo = format!("a{}", "\u{0301}".repeat(500));
        assert!(sanitize_agent_name(&zalgo.repeat(3)).chars().count() <= MAX_AGENT_NAME_CHARS * 2);
    }

    #[test]
    fn presence_follows_the_window_and_stop_clears_it() {
        let mut registry = AgentRegistry::default();
        let (record, _) = registry
            .create("Claude Code", AgentClientKind::ClaudeCode, "t")
            .unwrap();
        let start = Instant::now();
        assert!(!registry.connected(&record.id, start));
        assert!(registry.touch(&record.id, start, "2026-10-27T10:00:00Z"));
        assert!(registry.connected(&record.id, start));
        assert_eq!(registry.connected_count(start + Duration::from_secs(44)), 1);
        assert_eq!(registry.connected_count(start + AGENT_PRESENCE_WINDOW), 0);
        // A second touch inside a minute does not ask for another persist.
        assert!(!registry.touch(&record.id, start + Duration::from_secs(30), "later"));
        assert!(registry.touch(&record.id, start + Duration::from_secs(61), "later"));
        assert_eq!(
            registry.agent(&record.id).unwrap().last_used_at.as_deref(),
            Some("later")
        );
        registry.record_action(
            &record.id,
            AgentLastAction {
                tool: "notify".to_string(),
                at: "later".to_string(),
                outcome: AgentActivityOutcome::Ok,
            },
        );
        assert_eq!(registry.last_action(&record.id).unwrap().tool, "notify");
        registry.disconnect_all();
        assert!(!registry.connected(&record.id, start + Duration::from_secs(61)));
        assert!(!registry.touch("missing", start, "t"));
    }

    #[test]
    fn the_presence_watch_wakes_at_the_next_lapse_and_ends_with_the_last_agent() {
        let mut registry = AgentRegistry::default();
        let (first, _) = registry
            .create("Claude Code", AgentClientKind::ClaudeCode, "t")
            .unwrap();
        let (second, _) = registry
            .create("Cursor", AgentClientKind::Cursor, "t")
            .unwrap();
        let start = Instant::now();
        assert!(registry.claim_presence_watch());
        assert!(!registry.claim_presence_watch(), "one watch at a time");
        registry.touch(&first.id, start, "t");
        registry.touch(&second.id, start + Duration::from_secs(10), "t");
        assert_eq!(
            registry.next_presence_lapse(start),
            Some(start + AGENT_PRESENCE_WINDOW)
        );
        assert_eq!(
            registry.connected_ids(start + Duration::from_secs(10)),
            vec![first.id.clone(), second.id.clone()]
        );
        let after_first = start + AGENT_PRESENCE_WINDOW;
        assert_eq!(registry.connected_ids(after_first), vec![second.id.clone()]);
        assert_eq!(
            registry.next_presence_lapse(after_first),
            Some(start + Duration::from_secs(10) + AGENT_PRESENCE_WINDOW)
        );
        assert!(
            !registry.claim_presence_watch(),
            "still watching the second"
        );
        let after_both = start + Duration::from_secs(10) + AGENT_PRESENCE_WINDOW;
        assert_eq!(registry.next_presence_lapse(after_both), None);
        assert!(registry.claim_presence_watch(), "the watch ended");
    }

    #[test]
    fn a_seeded_last_action_never_replaces_a_newer_one() {
        let mut registry = AgentRegistry::default();
        let (first, _) = registry
            .create("Claude Code", AgentClientKind::ClaudeCode, "t")
            .unwrap();
        let (second, _) = registry
            .create("Cursor", AgentClientKind::Cursor, "t")
            .unwrap();
        let action = |tool: &str| AgentLastAction {
            tool: tool.to_string(),
            at: "2026-10-27T10:00:00+00:00".to_string(),
            outcome: AgentActivityOutcome::Ok,
        };
        assert_eq!(
            registry.last_actions_to_seed(),
            vec![first.id.clone(), second.id.clone()]
        );
        // The first acted while its lookup ran: the live action stays.
        registry.record_action(&first.id, action("switch_scene"));
        registry.seed_last_action(&first.id, Some(action("notify")));
        registry.seed_last_action(&second.id, None);
        assert_eq!(
            registry.last_action(&first.id).unwrap().tool,
            "switch_scene"
        );
        assert!(registry.last_action(&second.id).is_none());
        assert!(
            registry.last_actions_to_seed().is_empty(),
            "each agent is looked up once"
        );
        registry.seed_last_action("removed", Some(action("notify")));
        assert!(registry.last_action("removed").is_none());
    }

    #[test]
    fn persisted_shape_round_trips_and_tolerates_an_empty_store() {
        let persisted = AgentsPersisted {
            enabled: true,
            port: Some(7441),
            agents: vec![AgentRecord {
                id: "a".to_string(),
                name: "Cursor".to_string(),
                client: AgentClientKind::Cursor,
                token_hash: "0".repeat(64),
                created_at: "t".to_string(),
                last_used_at: None,
            }],
        };
        let json = serde_json::to_string(&persisted).unwrap();
        assert!(json.contains("\"client\":\"cursor\""));
        assert_eq!(
            serde_json::from_str::<AgentsPersisted>(&json).unwrap(),
            persisted
        );
        assert_eq!(
            serde_json::from_str::<AgentsPersisted>("{}").unwrap(),
            AgentsPersisted::default()
        );
    }
}
