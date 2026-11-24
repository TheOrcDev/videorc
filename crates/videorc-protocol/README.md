# videorc-protocol

**Lane: L2 (Backend and contracts); its extraction (plan 260 S1.1) by L4.** Only L2 edits it after S1.1 ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

Every wire type of the backend protocol, extracted from `crates/videorc-backend/src/protocol.rs` (S1.1a), with the pure data types those shapes embed from the backend's other modules, in modules of the same name (`cohost`, `captions`, `streaming`...). The backend re-exports everything under its old paths. Generating `backend.ts` from it with `ts-rs` is S1.1b.

Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-protocol = { workspace = true }`.
