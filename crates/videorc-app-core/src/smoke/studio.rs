//! The Studio's smoke commands on the GPUI app (plan 260 Phase 3, L6): what
//! Electron's smokes reach through the renderer, here on the core's Studio.
//! Only the smoke command server ever calls them.
//!
//! - `enable-synthetic-source {settleMs?}`: the Sources page's development
//!   switch, the test pattern, on (Electron clicks the same switch).
//! - `studio-state`: the session, the connection and the test pattern.
//! - `studio-record {timeoutMs?}`: Record, answered once the take runs.
//! - `studio-stop {timeoutMs?}`: Stop, answered once the session ended.
//! - `studio-capture-configure {config}`: `config` merged over the capture
//!   config (Electron's smokes seed `videorc.captureConfig` and reload).
//! - `studio-replay-buffer {armed, seconds?}`: the clip buffer armed for
//!   this run with a shorter ring, never saved
//!   (`__videorcSmokeSetReplayBuffer`).
//!
//! The rest of [`STUDIO_COMMANDS`](super::STUDIO_COMMANDS) answer "not
//! supported" by name until they land here.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::{CommandFuture, SmokeCommandHandler};
use crate::studio::{Connection, StudioSnapshot};
use crate::{SessionPhase, StartOutcome, Studio};

/// The commands this handler takes.
pub const STUDIO_SMOKE_COMMANDS: &[&str] = &[
    "enable-synthetic-source",
    "studio-capture-configure",
    "studio-record",
    "studio-replay-buffer",
    "studio-state",
    "studio-stop",
];

/// Electron's `enable-synthetic-source` settle after the switch flips.
const DEFAULT_SETTLE_MS: u64 = 600;
/// How long the switch may take to read back on (Electron's 5 s).
const SWITCH_WAIT: Duration = Duration::from_secs(5);
/// How long a take may take to start or stop by default.
const DEFAULT_SESSION_WAIT_MS: u64 = 30_000;
/// The longest wait a smoke may ask for.
const MAX_WAIT_MS: u64 = 5 * 60_000;

pub struct StudioSmoke {
    studio: Arc<Studio>,
}

impl StudioSmoke {
    pub fn new(studio: Arc<Studio>) -> Self {
        Self { studio }
    }
}

fn millis(params: &Map<String, Value>, key: &str, default: u64) -> u64 {
    params
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .min(MAX_WAIT_MS)
}

fn test_pattern(snapshot: &StudioSnapshot) -> bool {
    snapshot.settings.capture.sources.test_pattern
}

fn session_active(phase: SessionPhase) -> bool {
    !matches!(phase, SessionPhase::Idle | SessionPhase::Failed)
}

/// `studio-state`'s answer.
pub fn state_json(snapshot: &StudioSnapshot) -> Value {
    let session = &snapshot.session;
    json!({
        "connection": match &snapshot.connection {
            Connection::Waiting => json!({ "state": "waiting" }),
            Connection::Connected { pid } => json!({ "state": "connected", "pid": pid }),
            Connection::Disconnected { reason } => {
                json!({ "state": "disconnected", "reason": reason })
            }
        },
        "bootstrapped": snapshot.bootstrapped,
        "phase": format!("{:?}", session.phase).to_lowercase(),
        "status": serde_json::to_value(&session.status).unwrap_or(Value::Null),
        "startPending": session.start_pending,
        "stopPending": session.stop_pending,
        "startFailure": session.start_failure.as_ref().map(|failure| format!("{failure:?}")),
        "testPattern": test_pattern(snapshot),
        "lastError": snapshot.last_error,
    })
}

/// `patch` merged over `target`: objects key by key, anything else replaced.
pub fn merge_json(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                merge_json(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

/// Waits until `done` holds for the Studio's snapshot, or says what it saw.
async fn wait_for(
    mut snapshots: watch::Receiver<StudioSnapshot>,
    wait: Duration,
    what: &str,
    done: impl Fn(&StudioSnapshot) -> bool,
) -> Result<StudioSnapshot, String> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        {
            let snapshot = snapshots.borrow_and_update();
            if done(&snapshot) {
                return Ok(snapshot.clone());
            }
        }
        match tokio::time::timeout_at(deadline, snapshots.changed()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(format!("The Studio stopped before {what}.")),
            Err(_) => {
                let snapshot = snapshots.borrow();
                return Err(format!(
                    "Timed out after {} ms waiting for {what}: {}",
                    wait.as_millis(),
                    state_json(&snapshot)
                ));
            }
        }
    }
}

impl StudioSmoke {
    async fn enable_synthetic_source(&self, params: Map<String, Value>) -> Result<Value, String> {
        let settle = Duration::from_millis(millis(&params, "settleMs", DEFAULT_SETTLE_MS));
        let snapshot = self.studio.snapshot();
        if test_pattern(&snapshot) {
            tokio::time::sleep(settle).await;
            return Ok(json!({ "enabled": true, "alreadyEnabled": true }));
        }
        // The switch is disabled while a session runs (`SyntheticView`).
        if session_active(snapshot.session.phase) {
            return Err("Synthetic source toggle is disabled.".to_string());
        }
        self.studio
            .set_test_pattern(true)
            .await
            .map_err(|error| format!("The test pattern did not turn on: {error}"))?;
        wait_for(
            self.studio.watch(),
            SWITCH_WAIT,
            "the synthetic source",
            test_pattern,
        )
        .await
        .map_err(|_| "Timed out enabling synthetic source.".to_string())?;
        tokio::time::sleep(settle).await;
        Ok(json!({ "enabled": true }))
    }

    async fn record(&self, params: Map<String, Value>) -> Result<Value, String> {
        let wait = Duration::from_millis(millis(&params, "timeoutMs", DEFAULT_SESSION_WAIT_MS));
        match self.studio.start_recording().await {
            StartOutcome::Started => {}
            StartOutcome::Refused { message } => {
                return Err(format!("Record was refused: {message}"));
            }
            StartOutcome::Busy => {
                return Err("Record: a session is active or a start is in flight.".to_string());
            }
        }
        let snapshot = wait_for(self.studio.watch(), wait, "the take to run", |snapshot| {
            snapshot.session.phase == SessionPhase::Recording
        })
        .await?;
        Ok(json!({ "started": true, "state": state_json(&snapshot) }))
    }

    async fn stop(&self, params: Map<String, Value>) -> Result<Value, String> {
        let wait = Duration::from_millis(millis(&params, "timeoutMs", DEFAULT_SESSION_WAIT_MS));
        if !self.studio.stop().await {
            return Err(format!(
                "Stop failed: {}",
                state_json(&self.studio.snapshot())
            ));
        }
        let snapshot = wait_for(
            self.studio.watch(),
            wait,
            "the session to end",
            |snapshot| !session_active(snapshot.session.phase),
        )
        .await?;
        Ok(json!({ "stopped": true, "state": state_json(&snapshot) }))
    }
}

impl StudioSmoke {
    async fn capture_configure(&self, params: Map<String, Value>) -> Result<Value, String> {
        let patch = params
            .get("config")
            .filter(|config| config.is_object())
            .cloned()
            .ok_or_else(|| "studio-capture-configure needs a config object.".to_string())?;
        self.studio
            .update_capture_config(|config| merge_json(config, &patch))
            .await
            .map_err(|error| format!("The capture config was not saved: {error}"))?;
        Ok(json!({ "configured": true, "state": state_json(&self.studio.snapshot()) }))
    }

    fn replay_buffer(&self, params: Map<String, Value>) -> Result<Value, String> {
        let armed = params
            .get("armed")
            .or_else(|| params.get("enabled"))
            .and_then(Value::as_bool)
            .ok_or_else(|| "studio-replay-buffer needs armed: true or false.".to_string())?;
        let seconds = params
            .get("seconds")
            .and_then(Value::as_u64)
            .map(|seconds| seconds.clamp(1, 3600) as u32);
        self.studio.set_clips_for_run(armed, seconds);
        Ok(json!({ "armed": armed, "seconds": seconds }))
    }
}

impl SmokeCommandHandler for StudioSmoke {
    fn handles(&self, command: &str) -> bool {
        STUDIO_SMOKE_COMMANDS.contains(&command)
    }

    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(async move {
            match command {
                "enable-synthetic-source" => self.enable_synthetic_source(params).await,
                "studio-state" => Ok(state_json(&self.studio.snapshot())),
                "studio-record" => self.record(params).await,
                "studio-stop" => self.stop(params).await,
                "studio-capture-configure" => self.capture_configure(params).await,
                "studio-replay-buffer" => self.replay_buffer(params),
                other => Err(format!("The Studio smoke handler does not take {other}.")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_takes_only_studio_commands() {
        for command in STUDIO_SMOKE_COMMANDS {
            assert!(super::super::STUDIO_COMMANDS.contains(command), "{command}");
        }
    }

    #[test]
    fn a_patch_merges_objects_and_replaces_the_rest() {
        let mut config = json!({"video": {"fps": 30, "width": 1920}, "recordEnabled": false});
        merge_json(
            &mut config,
            &json!({"video": {"fps": 60}, "recordEnabled": true, "layout": {"layoutPreset": "screen-only"}}),
        );
        assert_eq!(
            config,
            json!({
                "video": {"fps": 60, "width": 1920},
                "recordEnabled": true,
                "layout": {"layoutPreset": "screen-only"}
            })
        );
    }

    #[test]
    fn waits_are_capped() {
        let mut params = Map::new();
        params.insert("timeoutMs".into(), json!(u64::MAX));
        assert_eq!(millis(&params, "timeoutMs", 1), MAX_WAIT_MS);
        assert_eq!(millis(&Map::new(), "settleMs", 600), 600);
    }

    #[test]
    fn only_idle_and_failed_are_not_a_running_session() {
        assert!(!session_active(SessionPhase::Idle));
        assert!(!session_active(SessionPhase::Failed));
        assert!(session_active(SessionPhase::Starting));
        assert!(session_active(SessionPhase::Recording));
        assert!(session_active(SessionPhase::Stopping));
    }
}
