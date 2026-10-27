# Plan 208 acceptance: Liquid Chrome colours

S0 done; S1–S7 pending.

Baseline: `origin/main` `dc1309cb` (before any Liquid Chrome product change).

## Before (origin/main dc1309cb)

Captures live under `/tmp/videorc-plan208/before/`. Main-window shots used
`node scripts/ui-theme-screens.mjs` with tab ids `studio`, `sources`,
`layout` (plan name “scene”), `assets`, `streaming` (plan name
“livestream”), `library`, `settings`, and `ai` (plan name “buddy”). Light
main-window tabs used `node scripts/capture-ui-pages.mjs --theme=light`
plus `ui-cmd` for Assets.

### Main window (CDP compositor screenshots)

| Surface | Dark | Light |
| --- | --- | --- |
| Studio | `/tmp/videorc-plan208/before/videorc-ui-studio-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-studio-light.png` |
| Sources | `/tmp/videorc-plan208/before/videorc-ui-sources-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-sources-light.png` |
| Scene (`layout`) | `/tmp/videorc-plan208/before/videorc-ui-layout-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-layout-light.png` |
| Assets | `/tmp/videorc-plan208/before/videorc-ui-assets-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-assets-light.png` |
| Livestream (`streaming`) | `/tmp/videorc-plan208/before/videorc-ui-streaming-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-streaming-light.png` |
| Library | `/tmp/videorc-plan208/before/videorc-ui-library-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-library-light.png` |
| Settings (General tab) | `/tmp/videorc-plan208/before/videorc-ui-settings-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-settings-light.png` |
| Buddy (`ai`) | `/tmp/videorc-plan208/before/videorc-ui-ai-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-ai-light.png` |

Extra light-only settings sub-tabs and Buddy sub-tabs from
`capture-ui-pages.mjs` (same directory, names like
`videorc-ui-settings-general-light.png`, `videorc-ui-buddy-live-light.png`).

### Studio Comments rail (main window)

| Theme | Path |
| --- | --- |
| Dark | not captured — `ui-theme-screens.mjs` exited after tab sweeps: `Three-platform Comments rail did not render` |
| Light | not captured — same script abort before the light pass |

### Stream Manager (detached Chat window)

Representative 1280×720 / activity layouts from `pnpm probe:comments-window`
(probe exited 1 on clipboard copy; PNGs still written).

| Theme | Path |
| --- | --- |
| Dark | `/tmp/videorc-plan208/before/videorc-stream-manager-dark.png` (copy of probe `videorc-comments-sweep-1280-live.png`) |
| Light | `/tmp/videorc-plan208/before/videorc-stream-manager-light.png` (copy of probe `videorc-comments-activity-rows-light.png`) |

Full probe set (not copied): `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-comments-window-probe-1793115777741/`.

### Captions reader (detached window)

| Theme | Path |
| --- | --- |
| Dark | not captured — no maintained smoke/probe writes Captions-window PNGs on this baseline |
| Light | not captured — same |

### Notes window

| Theme | Path |
| --- | --- |
| Dark | not captured — no `notes-window-capture-page` (or equivalent) in existing tooling |
| Light | not captured — same |

### Welcome / first-run screen

| Theme | Path |
| --- | --- |
| Dark | not captured — `ui-theme-screens.mjs` dismisses onboarding before tab sweeps; `smoke:first-run` is not in `package.json` on this baseline |
| Light | not captured — same |

## S0 gate notes

- `pnpm build` and `cargo build -p videorc-backend` (debug) succeeded in the
  plan-208 worktree.
- `ui-theme-screens` failure log: `/tmp/videorc-plan208/ui-theme-screens.log`.
- `probe:comments-window` failure: `links: Copy link puts the link on the
  clipboard` — log `/tmp/videorc-plan208/comments-window-probe.log`.
