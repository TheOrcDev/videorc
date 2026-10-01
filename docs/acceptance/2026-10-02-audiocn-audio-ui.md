# audiocn audio UI acceptance (plan 092), 2026-10-02

Scope: `plans/092-audiocn-audio-components.md`. The first part is the evidence
the slices produced. The second part is the owner checklist, which must be run
on the **packaged** app before the PR merges: the dev app in a worktree has no
Microphone grant, so nothing here saw a live microphone.

## Host

| Item | Value |
| --- | --- |
| Branch | `feat/092-audiocn-audio-ui` (worktree `../videorc-wt-092`), from `origin/main` `a8637877` |
| audiocn | `221100c` on `fix/videorc-adoption` (plan 092 U1), installed from a local build of that commit |
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
exists (owner checklist, item 9).

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
11. Run `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance`
    on a checkout whose Electron binary has the Microphone grant.

Decisions to confirm while doing it: D1 (segmented meter or the old bars) and
D4 (red from -9 or -6 dBFS).
