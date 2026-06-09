# Native 4K Media Engine Refactor

Status: active media-engine plan.

The active product direction is the native 4K OBS-class media engine refactor described in the Obsidian plan:

```text
/Users/orcdev/Documents/Obsidian Vault/plans/planned/2026-06-08 - Videorc Native 4K OBS Class Media Engine Refactor Plan.md
```

The execution slices live in:

```text
/Users/orcdev/Documents/Obsidian Vault/plans/planned/2026-06-08 - Videorc Native 4K OBS Class Media Engine Refactor Slices.md
```

A priority insertion from 2026-06-09 live usage (stream A/V sync fix, preview glued to the studio slot, left-sidebar studio shell, live layout switching — pulls forward master Phases 7/10/12) lives in:

```text
/Users/orcdev/Documents/Obsidian Vault/plans/planned/2026-06-09 - Videorc Studio Shell And Live Control Plan.md
```

## Locked Product Target

- 4K30 local recording is required.
- Livestreaming is platform-safe 1080p for v1.
- 4K recording plus 1080p streaming must work simultaneously through separate Metal output targets and separate VideoToolbox encoders.
- Preview optimizes for currentness: p95 source-to-present under 50 ms and p99 under 100 ms.
- No user-facing legacy media fallback.
- Custom engine only; do not use libobs or fork OBS.
- macOS is first; Windows is planned but not blocking.
- Final acceptance requires dev build, packaged clean-machine build, automated gates, and user by-eye OBS comparison.

## Feature Freeze

Non-media feature work is frozen while this plan is active. Work should either:

- prove the current media path,
- diagnose a media-path failure,
- move the product toward the native media engine target, or
- explicitly port or cut a committed v1 feature from the new engine surface.

## Legacy Fallback Policy

Raw-YUV, image-polling, FFmpeg-filter, and other legacy media paths may remain only as explicit developer/debug fallbacks while the refactor is underway. Raw-YUV encoder copies must fail 4K acceptance; they cannot be product evidence after the VideoToolbox path is default.

## Media Quality Modes

Diagnostics and acceptance reports use this shared vocabulary for the strongest media path a run actually proves:

| Mode | Meaning |
|---|---|
| `fallback-baseline` | Legacy, copied, blocked, or otherwise fallback media path. Useful for measurement, not a product-accepted mode. |
| `native-preview-only` | Native CAMetalLayer preview evidence exists, but recording still lacks zero-copy output proof. |
| `zero-copy-recording` | Recording used the Metal-to-VideoToolbox zero-copy path without raw-video or copied Metal target frames. |
| `record-stream-split-output` | Recording and streaming are both active through separate output targets/encoders. |
| `4k-accepted` | A 4K30 local recording path passed acceptance with native preview and zero-copy recording evidence. |

For now the mode is computed by `scripts/lib/media-quality-mode.mjs` from summarized run diagnostics and printed by `pnpm baseline:real-source` reports. It is diagnostics/reporting vocabulary only; Studio UI health remains the separate Ready/Live/Degraded/Blocked signal until the native-preview UI slices promote this vocabulary deliberately.

## 4K Measurement Commands

Named Phase 1 commands replace env-var memory for the required 4K baseline:

```sh
pnpm baseline:real-source:4k30 -- --gate
pnpm baseline:evidence:4k30 -- <output-dir>/latest-real-source-evidence.json
pnpm baseline:real-source:4k30:av-sync -- --gate
pnpm baseline:real-source:4k30:endurance -- --gate
pnpm baseline:evidence:4k30:endurance -- <output-dir>/latest-real-source-evidence.json
```

The motion and endurance commands request real sources at `3840x2160`, `30fps`, `30000kbps`, and launch the screen motion stimulus so freeze/repeated-frame gates measure moving content. The A/V-sync command uses the same 4K30 output request with the flash/click stimulus; pass `latest-real-source-evidence.json` directly to `pnpm measure:av-sync`.
Each successful or blocked real-source run writes a sibling `.evidence.json` manifest plus `latest-real-source-evidence.json` in the output directory, with the recording path, baseline report, analyzer reports, startup report, gate verdict, selected sources, and zero-copy/native-preview counters.

The stream-leg A/V sync gate (Studio Shell And Live Control Plan, slice A1) runs two sessions — record-only, then record+stream against a local `ffmpeg -listen` RTMP sink — and measures the flash/click offset on the record-only MKV, the record+stream MKV leg, and the RTMP-received FLV (the platform's view), with drift fitting and H1/H2/H3 hypothesis classification in `stream-av-sync-evidence.json`:

```sh
pnpm baseline:stream:av-sync -- --gate
pnpm baseline:stream:av-sync:endurance -- --gate
```

## Native Preview Placement Contract

The native CAMetalLayer preview is glued to the studio slot (Studio Shell And Live Control Plan, slices B1–B3). The renderer continuously reports the slot rect plus a visible clip rect (slot ∩ clipping ancestors ∩ viewport) and a visibility verdict; the cross-process host window covers exactly the clip rect, ignores all mouse events, is not movable, and hides whenever:

- the slot is fully scrolled out of view,
- the document is hidden/minimized or the app window loses focus, or
- any open Electron overlay (command palette, dialog, select menu, tooltip, toast) intersects the slot — overlays must never render underneath the preview. New overlay primitives must either portal under `document.body` with one of the selectors in `preview-stage.tsx` (`OVERLAY_SELECTORS`) or be added to that list.

UI work must keep sidebars/panels outside the studio slot rect (panels push and resize the slot; they never overlap it).

## Output Profiles

Phase 2 introduces first-class profile IDs for the committed recording/streaming surface:

| Profile | Size | FPS | Bitrate | Intent |
|---|---:|---:|---:|---|
| `record-4k30` | 3840x2160 | 30 | 30000kbps | Required local recording target. |
| `stream-safe-1080p30` | 1920x1080 | 30 | 6000kbps | v1 platform-safe livestream target. |
| `stream-safe-1080p60` | 1920x1080 | 60 | 6000kbps | Optional safe stream target when 60fps is explicitly allowed. |
| `record-4k60-experimental` | 3840x2160 | 60 | 50000kbps | Experimental only, not a v1 acceptance requirement. |

Existing `tutorial-1080p30`, `tutorial-1440p30`, `stream-1080p60`, and `custom` presets remain for compatibility until later policy slices decide which product paths stay visible.

## First Internal Gate

The first internal checkpoint is:

```text
4K30 screen + camera + mic
  -> Metal compositor
  -> native CAMetalLayer preview
  -> VideoToolbox H.264 encode
  -> local MKV recording
  -> optional MP4 remux
```

Passing that checkpoint is not product completion. The product is not fixed until the full committed v1 proof passes.
