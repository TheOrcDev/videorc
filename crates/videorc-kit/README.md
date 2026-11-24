# videorc-kit

**Lane: L3 (Kit).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

Videorc's design system on GPUI, synced from the GPUI flavour of videorc-ui (ui.videorc.com) with `pnpm ui:sync --flavour gpui`. Never edited here, as `apps/desktop/src/renderer/src/components/ui` is synced today. Only this crate and `apps/videorc` touch GPUI.

Empty until plan 260 **S2.2a to S2.2d** fills it.

- **Sync:** `pnpm ui:sync --flavour gpui <item>` fetches `https://ui.videorc.com/r/gpui/<item>.json` and its dependencies, writes their files under `src/` and `icons/` formatted with `rustfmt`, adds them to `ui-registry.json`, and prints what the crate still needs by hand: the root `Cargo.toml` pins, this crate's `[dependencies]`, the `pub mod` lines and the patched `gpui-pre-apple`. `--local [url-template]` reads videorc-ui's dev server instead (`http://localhost:3000/r/gpui/{name}.json`).
- **Check:** `pnpm ui:check` fails when a synced file differs from the registry, or when the root `Cargo.toml` pins a crate the items use (GPUI first) differently from videorc-ui's kit.
- **Ours:** `src/lib.rs` (the module list and `init`) and anything in `keepLocal`. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-kit = { workspace = true }`.
