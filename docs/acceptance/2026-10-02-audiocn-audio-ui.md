# audiocn audio UI acceptance (plan 092), 2026-10-02

Scope: `plans/092-audiocn-audio-components.md`. The first part is the evidence
the slices produced. The second part is the owner checklist, which must be run
on the **packaged** app before the PR merges: the dev app in a worktree has no
Microphone grant, so nothing here saw a live microphone.

## Host

| Item | Value |
| --- | --- |
| Branch | `feat/092-audiocn-audio-ui` (worktree `../videorc-wt-092`), from `origin/main` `a8637877` |
| audiocn | `a847315` on `fix/videorc-adoption` (plan 092 U1), installed from a local build of that commit |
| Machine | Apple Silicon Mac, macOS, arm64 Node 24.6 |
| Dev app grants | Screen Recording yes (native preview ran); Microphone **no** for this worktree's Electron binary (TCC is per binary) |

## Automated evidence

### Static gates (every slice)

`pnpm typecheck`, `pnpm lint` (with the em-dash gate, files staged first),
`pnpm format:check`, `pnpm --filter @videorc/desktop test` (248 files, 2,536
tests at S3), `pnpm build`, `pnpm check:renderer-assets`. All green.

### Eager renderer bundle (raw bytes are the CI-comparable number)

| Build | Eager raw | Eager gzip (Mac) | Studio bottom row (lazy) |
| --- | --- | --- | --- |
| main `a8637877` | 1,993,737 | 385,075 | 23.97 kB |
| S1 (vendored, unused) | 1,993,766 (+29) | 385,075 | 23.97 kB |
| S2 (mixer on audiocn) | 1,992,426 (-1,311) | 384,783 | 80.75 kB (19.2 kB gzip) |
| S3 (sliver, preview) | 1,989,776 (-3,961) | 384,086 | 76.40 kB |

The eager bundle shrinks: the peak-label hook and the frame painter left the
eager provider, and audiocn only loads with the lazy Studio and Sources chunks.

### `pnpm smoke:preview-performance` (dev app, native CAMetalLayer preview)

Alternating runs on the same machine, the branch at S3 against main:

| Run | Renderer CPU avg | Renderer CPU p95 | Main CPU avg | Backend CPU avg | Renderer RSS (last median) | Wire rate |
| --- | --- | --- | --- | --- | --- | --- |
| branch 1 | 7.70 % | 16.6 % | 11.00 % | 5.53 % | 379 MB | 82.30 KiB/s |
| main 1 | 17.84 % | 27.7 % | 9.88 % | 4.56 % | 417 MB | 82.48 KiB/s |
| branch 2 | 1.51 % | 5.1 % | 12.60 % | 5.88 % | 433 MB | 82.41 KiB/s |
| main 2 | 12.62 % | 19.9 % | 12.22 % | 5.41 % | 390 MB | 81.94 KiB/s |

No regression; renderer CPU is lower on the branch in both pairs. Every run,
main included, fails one budget: the unfiltered WebSocket wire rate (about
82 KiB/s against 80 KiB/s). That is the preview's own traffic on this machine
and is not touched by this plan.

`VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1` fails here with "Studio live
microphone visualizer did not remain active": `[data-videorc-mic-visualizer]`
mounts (the selector contract holds) but the analyser cannot open a microphone
without the grant, so the label never reads Live. Run it where the grant
exists (owner checklist, item 12).

### Phase C (backend bus levels)

- `cargo test -p videorc-backend`, targeted: the new window maths, a live-bus
  test (microphone read before the sum at -4.44 dBFS for a 0.6 tone, System
  audio at its gained 0.7 peak, the master under the limiter ceiling with
  clipped samples counted), the event builder, the wire shape (missing sources
  omitted, silence floored at -120); plus the session audio, performance
  check, LAN remote and diagnostics suites (150 tests).
- `cargo clippy -p videorc-backend -- -D warnings`, `cargo fmt --check --all`.
- TS: the `audio.levels` schema, the store (liveness notifies only on
  transitions; one timer a second), the level sources, and the mixer's
  priority and Mix strip markup.
- `pnpm test:scripts`: 1,692 tests.

### `pnpm smoke:recording-studio` (dev app, worktrees, shared host)

Not green end to end on the branch. Every stage passes on its own. In full
runs the branch failed one native-preview timing budget each time; base
passed both of its full runs, but fails the same stage 27 budget run on its
own here (1 of 8, below).

Full runs (33 stages each):

| Run | Head | Result |
| --- | --- | --- |
| branch 1 | `f50c7fe3` | 1-26 PASS; 27 FAIL: floating input-to-present p95 125 ms (budget 100); my audiocn tests were running alongside |
| branch 2 | `7b413208` | 1-26 PASS; 27 FAIL: p95 132 ms |
| branch 3 | `4f6188d5` | 1-29 PASS (27 at p95 98 ms); 30 FAIL: one native preview scene update took 55.1 ms (budget 50; 1.5 ms run alone) |
| base 1 | `a8637877` | 33/33 PASS (27 at p95 19 ms) |
| base 2 | `a8637877` | 33/33 PASS (27 at p95 20 ms) |

Stages 28-33 on `7b413208`, one by one: all PASS (preview lifecycle 100 of
100, window placement and docking, surface reattach at 60 fps and p95 18 ms,
real ScreenCaptureKit recording, Notes window invisible, and system audio
on/off/toggles/self/stream, which drives the Phase C level windows through
real sessions).

Stage 27 alone, eight alternating pairs on the same machine:

| Head | Floating input-to-present p95, ms | Fails |
| --- | --- | --- |
| base `a8637877` | 58, 4, **105**, 5, 3, 4, 4, 4 | 1 of 8 |
| branch | 3, 3, 14, 31, 4, 6, 38, 4 | 0 of 8 |

What the budget measures: the age of the composited source frame plus the
main-process hand-off (`native-preview-present-metrics.ts`). In every
failing run the preview still presented at 60 fps with no skipped
compositor frames and no queue wait; the content (the real camera is in the
scene) was old. Plan 092 changes no main-process, preload, native-preview,
compositor or camera code, and its backend code runs only while a
recording's audio bus runs; this phase records nothing.

Reading: the stage 27 budget fails on main here too (1 of 8 alone), and run
alone the branch is not worse. The branch's 0 of 3 full runs against base's
2 of 2 is not explained; host load was not controlled (the owner's browser
GPU helper and WindowServer were each at about 50-60 % CPU throughout).
Owed: one `pnpm smoke:recording-studio` from the granted checkout before
merge.

## Owner checklist (packaged app, both themes)

Studio, Audio mixer:

1. Mic live: speak. The segmented meter moves smoothly; the peak hold marker
   lingers about a second; the readout updates about four times a second and
   the row never shifts.
2. Gain: drag Sources > Gain from 0 to +12 dB while speaking. The Studio meter
   rises with it (the old bars did not).
3. Hot: shout or tap the mic. Amber from -20 dBFS, red from -9 dBFS; at -1 dBFS
   or above the clip light comes on, holds 1.5 s, and a click resets it.
4. Muted: the strip dims, the readout reads -∞ dB, the label reads Muted.
5. No microphone: "No microphone", no mute button, the readout reads "-- dB".
6. Permission refused, silent, no frames, device issue: each notice reads as
   before, as plain warning text with no tinted panel behind it.
7. System audio off, on, live (meter while a session mixes it), echo (Resume),
   permission required: the same states and words as before.
8. Session sliver: five bars beside the status badge during a session; flat
   and dim while muted; the badge never moves when muting.
9. Sources mic preview: the scrolling waveform follows the voice; with the
   mic muted it reads "Microphone is muted. Unmute to see its level."
10. Idle CPU: Studio open, mic muted, no session. Activity Monitor shows the
    renderer as idle as on 0.9.126.
11. Record (or stream) with System audio on and music playing: the System
    audio meter now moves smoothly (it was one step a second), and a Mix strip
    appears under it showing what is recorded, with a clip count. Push the mic
    and the music hot together: the Mix clip light comes on even when neither
    source clips alone. Stop: the Mix strip goes away within a second.
12. Run `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance`
    on a checkout whose Electron binary has the Microphone grant.
13. Run `pnpm smoke:recording-studio` from the granted checkout on this branch
    (see the full-run table above for what failed here and why it is open).

Decisions to confirm while doing it: D1 (segmented meter or the old bars) and
D4 (red from -9 or -6 dBFS).
