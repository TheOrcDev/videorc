# videorc-protocol

**Lane: L2 (Backend and contracts).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

Every wire type of the backend protocol, serde only, extracted from `crates/videorc-backend/src/protocol.rs`; `ts-rs` generates `backend.ts` from it while Electron ships.

Empty until plan 260 **S1.1** fills it. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-protocol = { workspace = true }`.
