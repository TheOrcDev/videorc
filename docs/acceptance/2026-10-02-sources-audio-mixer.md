# Sources Audio mixer acceptance (plan 093), 2026-10-02

Scope: `plans/093-sources-audio-mixer-on-audiocn-controls.md`. The first part
is the evidence the slices produced. The second part is the owner checklist,
run on the **packaged** app before the PR merges: the dev app in a worktree
has no Microphone grant, so nothing here saw a live microphone.

## Host

| Item | Value |
| --- | --- |
| Branch | `plan/093-sources-audio-controls` (worktree `../videorc-wt-093`), from `origin/main` `b4bb692e` |
| audiocn | main `f53bfe6` merged with PR #2 (`fix/videorc-adoption`, `d4dfc0a`), built locally as `136c574`; PR #2 is not merged yet |
| Machine | Apple Silicon Mac, macOS, arm64 Node 24.6 |
| Dev app grants | Microphone **no** for this worktree's Electron binary (TCC is per binary) |

## Automated evidence

### Static gates

`pnpm typecheck`, `pnpm lint` (files staged first, for the em-dash gate),
`pnpm format:check`, `pnpm --filter @videorc/desktop test` (250 files, 2,545
tests, 1 skipped), `pnpm build`, `pnpm check:renderer-assets`. All green. The
one lint warning (`use-studio.tsx` exhaustive-deps) is on main too.

audiocn's own gates on the merge it will serve (`136c574`): `pnpm test`
(321), `pnpm typecheck`, `pnpm check`, `pnpm build`, all green.
`pnpm test:install` cannot run on this Mac (pnpm trust policy).

### Renderer bundle

| Build | Eager raw | Eager gzip (Mac) | Sources chunk |
| --- | --- | --- | --- |
| main `b4bb692e` | 1,991,814 | 384,788 | 44,097 raw / 9,765 gzip |
| S1 (vendored, unused) | 1,991,814 (0) | 384,793 | unchanged |
| S3 + spacing fix | 1,991,859 (+45) | 384,833 | 203,924 raw / 45,802 gzip |

The +45 eager bytes are the entry's map of lazy chunk names (two new shared
lazy chunks: `mic-level-meter`, 6.2 KB gzip, shared by the Studio section and
Sources; and a 0.8 KB Base UI helper). The four `modulepreload` links are the
same files as on main. The Sources chunk grows by about 36 KB gzip, mostly
Base UI's Slider and NumberField behind `fader` and `parameter-slider`.

### Dev app, by eye (`pnpm ui:driver`, isolated profile)

Captured on Sources, not committed (generated media):

- dark, idle: the microphone strip (Idle, meter at rest, Gain at 0.0 dB, the
  mute toggle) and the System audio strip (Off, meter at rest with its hint,
  Level at −6.0 dB, the switch), Sync with its ms field, Calibrate folded;
- dark, muted, Calibrate open: the amber pressed mute, the dimmed meter,
  "Muted", the measurement badge with Stimulus (dev build), Import JSON and
  Apply;
- light, the same state;
- narrow (the mixer capped at 440 px in the page): each strip stacks its
  header above the meter and fader, with the value and toggle beside them.

One fix came from this pass: the Mixer grid's gaps around its unused rows and
the groups' outer padding left 24 px of dead space above and below the
strips (`fix(sources): no dead space around the mixer's strips`).

## Performance

`VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance`
ran on the branch and then on main `b4bb692e` (a clean worktree,
`../videorc-wt-093-base`, its own `target/`), one after the other on the same
machine. Both fail the same nine checks the same way, so neither measured
anything:

- `eval-js -> No available Studio microphone could be selected.` (the probe
  found Sources' `[data-videorc-mic-preview]` and the "Microphone" picker on
  both; the isolated profile offered no selectable microphone);
- the Studio microphone visualizer never went live;
- the detached native preview produced no geometry samples, no frames, no
  `native-surface` transport and no `cametal-layer` backing;
- no wall-clock sampling evidence.

A fresh worktree's Electron and backend binaries have neither the Microphone
nor the Screen Recording grant (TCC is per binary), and the result is
identical on main, so this is the host, not the change. The renderer CPU
comparison the plan asks for is owed on a granted build. Reports:
`docs/acceptance/artifacts/performance/detached-native-preview-2026-10-02T12-32-04-520Z.json`
(branch) and the same folder in the base worktree,
`…T12-36-15-503Z.json` (main); both are git-ignored.

## Owner checklist (packaged app)

Run on a packaged build with the Microphone and Screen Recording grants.

1. Sources, dark and light, wide window: the strips read as one list with a
   hairline between them; nothing is boxed; values never shift the row.
2. Narrow the window until the strips stack: no horizontal scroll, nothing
   clipped.
3. Microphone: speak and watch the meter move between sessions (the warm
   microphone's own level); drag Gain and see the level follow; double-click
   the thumb to return to 0 dB; arrows step 1 dB, Shift+arrows 6 dB,
   Home/End jump to the ends.
4. Mute with the toggle and with the global shortcut: the toggle, the strip
   and the Studio sliver agree; the tooltip shows the shortcut when bound.
5. Sync: type 150, scrub the unit, Reset (it hides at 0); start a recording
   and check the "Applies from the next recording or stream." line; check
   the recording's sync matches the value set before it started.
6. Calibrate: folded by default; Import JSON and Apply work as before; no
   Stimulus in the packaged build.
7. System audio: Off and On between sessions (meter at rest, hint on hover);
   in a session the meter moves with what plays; Level drags live; the echo
   guard pauses and Resume shows; without Screen Recording permission the
   strip dims and Open Settings shows.
8. Cmd+Up and Cmd+Down move focus between the two strips.
9. VoiceOver names: "Microphone level", "Microphone gain", "Mute microphone",
   "Sync", "System audio level", "System audio gain", "System audio".

## Owed

- Merge audiocn PR #2 (it deploys audiocn.dev), then confirm the five new
  files match what audiocn.dev serves and record the merge commit in
  `docs/audiocn.md`.
- The owner checklist above.
- A live-microphone perf comparison where the Electron binary has the
  Microphone grant.
