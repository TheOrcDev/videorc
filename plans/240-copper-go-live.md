# Plan 240: Copper Go Live

The owner's ask (2026-11-15): Studio's sidebar button got the silver
chrome and "looks really good". Go Live wears the same silver, so it should
be different. Of the suggestions (gold, copper, gunmetal with an LED,
cobalt), the owner chose **copper**: "I think it will go nicely with our
theme." Then: plan it properly, add it as a component to the UI library at
ui.videorc.com, create the PRs and send a screenshot before merging.

## Status

- **Status: BUILT 2026-11-15, waiting for the owner's look check.**
- videorc-ui: `TheOrcDev/videorc-ui#3` (branch `feat/copper-go-live`),
  its plan 006. **Merge and deploy it first**: this PR syncs `button`,
  `kbd` and `go-live-button` from that registry, and `pnpm ui:check` only
  matches once ui.videorc.com serves them.
- Desktop: this PR (branch `plan-240-copper-go-live`).

## Why

The sidebar's Studio slab and Go Live were the same `chrome-fill` silver,
the two biggest buttons in the app reading as one. Record already has
metallic red. Copper sits between the silver and the red: it says "this
one matters" without reading as a second Record.

## Decisions

- **D1. A new material, `chrome-copper`.** The fill's five-band shape
  (bright top, darker waist just below the middle, light back at the foot)
  in polished copper, hue 48–62. Defined once in `styles.css` like the
  other materials, with a dark and a light token column.
- **D2. The same copper in both themes.** Silver turns to black chrome in
  light mode because silver vanishes on porcelain; copper holds its own, so
  it stays copper. Light gets a softer, copper-tinted drop.
- **D3. Dark ink.** A deep copper-brown (`oklch(0.2 0.04 45)`), not white:
  dark ink on bright metal is how dark mode's silver reads, and it keeps Go
  Live apart from Record's white on red. No band goes under 0.62
  lightness, so the ink keeps 4.5:1 on every band (`chrome-copper.test.ts`).
- **D4. Still.** No glow and no motion. Red's breathing glow is Record's
  tally light; Go Live doesn't get a second one. `chrome-copper` joins the
  still list in `glass-chips.test.ts`.
- **D5. Copper only ever means Go Live.** Button `variant="go-live"` is for
  the Studio's Go Live (and its End livestream in a talk show) and the Go
  Live dialog's start button ("Go live", "Go live on 3 destinations", "Go
  live on Twitch"). Never panels, rows, badges or text.
- **D6. `GoLiveButton`, the twin of `RecordButton`.** One control for
  `idle | checking | live | stopping`, one width through every state's
  words. **Checking… no longer dims**: it is `aria-disabled` and keeps
  focus, the way Record's Starting does, so the button answers from the
  click in copper. Glyph: the broadcast icon, then Stop once live.
- **D7. The sidebar's Studio slab stays silver.** That's the point.

## Slices

1. **videorc-ui (plan 006 there).** `chrome-copper` in
   `styles/videorc.css`, Button `go-live`, `kbd`'s filled-button chip for
   `go-live`, `GoLiveButton`, docs page and states board, social card,
   registry entry. Gates: check, typecheck, test, build, e2e.
2. **Resync.** `pnpm ui:sync button kbd go-live-button` (from the local
   registry until #3 deploys; `ui:check` against ui.videorc.com after).
   `styles.css` is kept local, so the copper tokens, shadow and utility are
   ported from `styles/videorc.css` as they are.
3. **Studio transport.** `session-panel.tsx`: Go Live becomes
   `GoLiveButton` (`checking` while `goLivePending`, `live` while the talk
   show's livestream runs). Copy stays in `go-live-copy.ts`.
4. **Go Live dialog.** Both start buttons take `variant="go-live"`; their
   shortcut chip takes the copper's ink through `kbd`.
5. **Guards and docs.** `chrome-copper.test.ts` (contrast, still, no
   border), `glass-chips.test.ts` (still list, tokens, hue allowance),
   `session-transport.test.ts` (copper variant, stacked words, Checking…
   held not dimmed). The design skill: rule 4, D8, the materials table and
   "who wears what".

## Verification

Cosmetic change: TS gates, unit tests and the screenshot, no heavy smokes
(owner, 2026-11-14).

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test` for the touched files
- A screenshot of the Studio in the dev app, dark and light, for the owner.

## Not doing

- **The Retro LCD look.** Its outlined keys are a different look.
- **A glow or any motion** on Go Live.
- **Copper on the Studio slab, ⌘K or the sidebar.**
