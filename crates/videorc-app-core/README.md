# videorc-app-core

**Lanes: L4 (Shell and OS) for the shell modules (`src/log.rs`, `src/crash_log.rs`, `src/restart.rs`, `src/process.rs`, `src/paths.rs`, `src/ledger.rs`, `src/supervisor.rs`, `src/client/`, `src/desktop/`); L7 (Core) for everything else.** Only those lanes edit this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The Videorc app without a UI: the typed backend client, the supervisor, the Studio state machine and every page's view-model, the smoke command server, settings. It never depends on GPUI (a test enforces it).

The shell modules land first (plan 260 S1.6s, L4), lifted from `videorc-rust`'s app-core with their tests; the product areas follow in **S1.6a to S1.6f** (L7). Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-app-core = { workspace = true }`.
