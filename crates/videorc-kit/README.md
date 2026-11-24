# videorc-kit

**Lane: L3 (Kit).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

Videorc's design system on GPUI, synced from the GPUI flavour of videorc-ui (ui.videorc.com) with `pnpm ui:sync --flavour gpui`. Never edited here, as `apps/desktop/src/renderer/src/components/ui` is synced today. Only this crate and `apps/videorc` touch GPUI.

Empty until plan 260 **S2.2a to S2.2d** fills it. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-kit = { workspace = true }`.
