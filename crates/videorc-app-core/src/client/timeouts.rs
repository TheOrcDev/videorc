//! Per-method request deadlines, as `backendRequestTimeoutMs` in
//! `apps/desktop/src/renderer/src/backendClient.ts` (`METHOD_REQUEST_TIMEOUT_MS`
//! and the timing contracts it sums). A test reads that file and holds the
//! two tables together while Electron ships.

use std::time::Duration;

/// `DEFAULT_REQUEST_TIMEOUT_MS`.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(30_000);

/// `LIVE_LAYOUT_REQUEST_TIMING_CONTRACT`: the backend's ordered command lane
/// (5 s), the source transition (15 s) and the first fresh frame (15 s), plus
/// 10 s for the answer, so a slow but valid source reports its own outcome.
pub const LIVE_LAYOUT_REQUEST_TIMEOUT: Duration =
    Duration::from_millis(5_000 + 15_000 + 15_000 + 10_000);

/// `SOURCE_SWITCH_REQUEST_TIMING_CONTRACT`: queue admission (5 s), two 30 s
/// video preparation and restoration attempts, the commit acknowledgement
/// (1 s) and 10 s for the answer.
pub const SOURCE_SWITCH_REQUEST_TIMEOUT: Duration =
    Duration::from_millis(5_000 + 30_000 + 30_000 + 1_000 + 10_000);

/// `COMMENTS_SEND_TIMING_CONTRACT.backendRequestMs`
/// (`apps/desktop/src/shared/comments-command-timing.ts`).
pub const LIVE_CHAT_SEND_REQUEST_TIMEOUT: Duration = Duration::from_millis(12_000);

/// How long `method` may take before the caller gives up on it.
pub fn backend_request_timeout(method: &str) -> Duration {
    let millis: u64 = match method {
        "preview.surface.present" | "preview.surface.status" => 5_000,
        "compositor.status" | "diagnostics.stats" => 10_000,
        "liveChat.send" => return LIVE_CHAT_SEND_REQUEST_TIMEOUT,
        "devices.list" => 30_000,
        "scene.layout.apply_live" | "scene.layout.apply_preview" | "scene.source.device.switch" => {
            return LIVE_LAYOUT_REQUEST_TIMEOUT;
        }
        "session.source.switch" => return SOURCE_SWITCH_REQUEST_TIMEOUT,
        "session.sources.get" => 10_000,
        // Backend file mutations have a 30 s outcome-unknown boundary; 15 s
        // more for queue admission and the answer.
        "screens.importImage" | "banners.importImage" | "sounds.import" | "sessions.delete" => {
            45_000
        }
        // A cloud show's resume is a session start bound to the live show;
        // its hand-off stops one (plan 184).
        "stream.output.topology.probe"
        | "session.start"
        | "session.stop"
        | "cloud.show.resume"
        | "cloud.show.handOff" => 120_000,
        "session.remux_mp4" | "sessions.import" | "repair.repair_file" => 10 * 60_000,
        _ => return DEFAULT_REQUEST_TIMEOUT,
    };
    Duration::from_millis(millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn known_methods_get_their_own_deadline() {
        assert_eq!(
            backend_request_timeout("session.start"),
            Duration::from_secs(120)
        );
        assert_eq!(
            backend_request_timeout("session.stop"),
            Duration::from_secs(120)
        );
        assert_eq!(
            backend_request_timeout("preview.surface.status"),
            Duration::from_secs(5)
        );
        assert_eq!(
            backend_request_timeout("scene.layout.apply_live"),
            Duration::from_secs(45)
        );
        assert_eq!(
            backend_request_timeout("session.source.switch"),
            Duration::from_secs(76)
        );
        assert_eq!(
            backend_request_timeout("ui.settings.get"),
            DEFAULT_REQUEST_TIMEOUT
        );
        assert_eq!(
            backend_request_timeout("no.such.method"),
            DEFAULT_REQUEST_TIMEOUT
        );
    }

    /// Sums `{ a: 5_000, b: 15_000 }` the way `Object.values(...).reduce` does.
    fn contract_sum(source: &str, name: &str) -> u64 {
        let start = source
            .find(&format!("{name} = Object.freeze({{"))
            .unwrap_or_else(|| panic!("{name} is not in backendClient.ts"));
        let body = &source[start..];
        let body = &body[body.find('{').unwrap() + 1..body.find('}').unwrap()];
        body.split(',')
            .filter_map(|entry| entry.split(':').nth(1))
            .map(|value| millis_literal(value).expect("a numeric contract entry"))
            .sum()
    }

    /// `5_000` or `10 * 60_000`.
    fn millis_literal(text: &str) -> Option<u64> {
        let mut product = 1u64;
        for factor in text.split('*') {
            let digits: String = factor.trim().chars().filter(|c| *c != '_').collect();
            if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            product *= digits.parse::<u64>().ok()?;
        }
        Some(product)
    }

    /// The renderer's table is the reference: every method it names has the
    /// same deadline here. Skipped once Electron (and the file) are gone.
    #[test]
    fn the_table_matches_backend_client_ts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let Ok(source) =
            std::fs::read_to_string(root.join("apps/desktop/src/renderer/src/backendClient.ts"))
        else {
            eprintln!("backendClient.ts is gone; nothing to compare");
            return;
        };
        let comments = std::fs::read_to_string(
            root.join("apps/desktop/src/shared/comments-command-timing.ts"),
        )
        .expect("comments-command-timing.ts sits beside backendClient.ts");
        let live_chat = comments
            .lines()
            .find_map(|line| line.trim().strip_prefix("backendRequestMs:"))
            .and_then(|value| millis_literal(value.trim_end_matches(',')))
            .expect("backendRequestMs is a number");
        let live_layout = contract_sum(&source, "LIVE_LAYOUT_REQUEST_TIMING_CONTRACT");
        let source_switch = contract_sum(&source, "SOURCE_SWITCH_REQUEST_TIMING_CONTRACT");
        assert_eq!(
            Duration::from_millis(live_layout),
            LIVE_LAYOUT_REQUEST_TIMEOUT
        );
        assert_eq!(
            Duration::from_millis(source_switch),
            SOURCE_SWITCH_REQUEST_TIMEOUT
        );
        assert_eq!(
            Duration::from_millis(live_chat),
            LIVE_CHAT_SEND_REQUEST_TIMEOUT
        );
        let default = source
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("const DEFAULT_REQUEST_TIMEOUT_MS =")
            })
            .and_then(millis_literal)
            .expect("DEFAULT_REQUEST_TIMEOUT_MS is a number");
        assert_eq!(Duration::from_millis(default), DEFAULT_REQUEST_TIMEOUT);

        let table_start = source
            .find("const METHOD_REQUEST_TIMEOUT_MS")
            .expect("METHOD_REQUEST_TIMEOUT_MS is in backendClient.ts");
        let table = &source[table_start..];
        let table = &table[..table.find("\n}\n").expect("the table ends")];
        // Entries are `'method': value,` and may wrap over several lines (a
        // `reduce(...)` call); the last one has no comma.
        let mut entries: Vec<(String, String)> = Vec::new();
        for line in table.lines().skip(1) {
            let line = line.trim();
            if line.starts_with("//") || line.is_empty() {
                continue;
            }
            let open = entries
                .last()
                .is_some_and(|(_, value)| value.matches('(').count() > value.matches(')').count());
            if open {
                let (_, value) = entries.last_mut().unwrap();
                value.push(' ');
                value.push_str(line);
            } else if let Some(rest) = line.strip_prefix('\'') {
                let (method, value) = rest.split_once("':").expect("'method': value");
                entries.push((method.to_string(), value.trim().to_string()));
            }
        }
        let mut compared = 0;
        for (method, value) in entries {
            let value = value.trim_end_matches(',').trim();
            let expected = if let Some(millis) = millis_literal(value) {
                Duration::from_millis(millis)
            } else if value.contains("LIVE_LAYOUT_REQUEST_TIMEOUT_MS") {
                LIVE_LAYOUT_REQUEST_TIMEOUT
            } else if value.contains("SOURCE_SWITCH_REQUEST_TIMING_CONTRACT") {
                SOURCE_SWITCH_REQUEST_TIMEOUT
            } else if value.contains("COMMENTS_SEND_TIMING_CONTRACT") {
                LIVE_CHAT_SEND_REQUEST_TIMEOUT
            } else {
                panic!("{method}: a timeout this test cannot read: {value}");
            };
            assert_eq!(
                backend_request_timeout(&method),
                expected,
                "{method} differs from backendClient.ts"
            );
            compared += 1;
        }
        assert!(
            compared >= 20,
            "read only {compared} entries from METHOD_REQUEST_TIMEOUT_MS"
        );
    }
}
