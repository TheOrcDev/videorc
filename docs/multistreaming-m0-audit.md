# Multistreaming — M0 Audit (Phase M0)

Date: 2026-06-02

Scope: audit the current single-target streaming model and map it to the
per-target model before writing M1 code. Companion to
`plans/.../2026-06-02 - Videorc Multi Platform Streaming Plan.md`.

## Current single-target model (what exists today)

Streaming is a single RTMP destination end-to-end:

| Layer | Field(s) | Location |
| --- | --- | --- |
| Renderer config | `streamEnabled`, `rtmpPreset`, `rtmpServerUrl`, `streamKey` | `renderer/src/lib/capture.ts` (`CaptureConfig`) |
| Renderer defaults | `rtmpDefaults` (youtube/twitch server URLs) | `renderer/src/lib/capture.ts` |
| Renderer → backend | `output.streamEnabled`, `output.rtmp = { preset, serverUrl, streamKey }` | `hooks/use-studio.tsx` (`sessionParams`) |
| Backend protocol | `OutputSettings.stream_enabled`, `OutputSettings.rtmp: RtmpSettings { preset, server_url, stream_key }` | `crates/videorc-backend/src/protocol.rs` |
| Backend target | `build_stream_url(&params.output.rtmp) -> StreamTarget { url, redacted_url }` (one URL) | `recording.rs` |
| Backend output | `tee` with `[f=matroska:onfail=abort]<file> \| [f=flv:onfail=ignore:flvflags=no_duration_filesize]<url>` — MKV + **one** RTMP leg; stream-only is a single `flv` | `recording.rs` (`ffmpeg_args`) |
| Session metadata | `stream_preset` (preset name only) | `protocol.rs` (`SessionSummary`) |
| Platform special-case | `x-rtmp-access` health event when preset = X | `recording.rs` |

**The bug:** because there is exactly one `rtmpPreset`/`rtmpServerUrl`/`streamKey`,
switching platforms in the UI mutates the same fields — a YouTube key overwrites
the Twitch key. There is no per-platform storage anywhere in the stack.

## Mapping to the new per-target model

| Old (single) | New (per-target) |
| --- | --- |
| `streamEnabled` | `StreamingSettings.enabled` |
| `rtmpPreset` | identifies which `StreamTargetSettings` the legacy server/key belong to |
| `rtmpServerUrl` | the matching target's `serverUrl` |
| `streamKey` | the matching target's `streamKey` (transitional; → `streamKeySecretRef` in M1b) |
| — | `targets[]`: one built-in target per platform (YouTube, Twitch, X) + one Custom |
| — | per-target `enabled`, `status`, `streamKeyPresent`, `urlMode`, `authMode` |
| — | `enabledTargetIds`, `defaultOutputPreset`, `defaultBitrateKbps` |
| one `tee` RTMP leg | one FLV/RTMP `tee` leg **per enabled target** (M4) |

Migration rule (M1): the legacy key/server move **only** into the target whose
platform matches `rtmpPreset`. The other three targets stay empty, so the
overwrite can no longer happen.

## Multistream-safe output preset

Named preset for v1 three-platform streaming (per plan "Common-Safe Output Presets"):

- **`tutorial-1080p30`** already encodes the spec: H.264, 1920×1080, 30 FPS, **6000 kbps** video. Audio target is **128 kbps** AAC-LC (handled in the audio encode args).
- Justification: it is the strictest-common-denominator that all three platforms
  accept (notably Twitch's ~6000 kbps ceiling). All `tee` legs share one encode in
  v1, so the encode must satisfy the lowest common platform. `stream-1080p60`
  (9000 kbps) is **not** multistream-safe because it exceeds Twitch.
- The M1 model defaults `defaultOutputPreset = 'tutorial-1080p30'`,
  `defaultBitrateKbps = 6000`. A distinct "Multistream Safe" label can be added
  later; the values are already correct.

## FFmpeg tee syntax (from the working command, to extend in M4)

Reference: <https://ffmpeg.org/ffmpeg-formats.html#tee> (re-verify `onfail`,
`use_fifo`, and slave-URL escaping before M4).

- Slave outputs are separated by `|`.
- Per-output options go in `[key=value:key=value]` immediately before the URL/path.
- `onfail=abort` kills the session if that leg fails; `onfail=ignore` keeps the
  session alive. v1: local MKV = `abort`, every remote RTMP leg = `ignore`.
- Special characters in slave URLs (notably `|`, `[`, `]`, `:`, `\`) must be
  backslash-escaped inside the tee output string. Stream keys often contain `?`,
  `&`, `-` (safe) but YouTube/X full URLs can contain reserved chars — M4 must
  escape each leg.

M4 target shape:
`[f=matroska:onfail=abort]<file> | [f=flv:onfail=ignore]<yt> | [f=flv:onfail=ignore]<twitch> | [f=flv:onfail=ignore]<x>`

## Platform reference checkpoints (re-verify before M7)

Documented facts; re-check the live docs before real-platform acceptance (M7),
as platform requirements change.

- **YouTube** — RTMP ingest `rtmp://a.rtmp.youtube.com/live2` + stream key; managed
  broadcast still confirmed with "Go Live" in Studio. First-time channels need
  verification + ~24h activation. <https://developers.google.com/youtube/v3/live/docs/liveBroadcasts>
- **Twitch** — `rtmp://<ingest>/app` + stream key; ~6000 kbps practical ceiling;
  ingest-server list available without auth. <https://dev.twitch.tv/docs/video-broadcast/>
- **X / Twitter** — Media Studio Producer RTMP/RTMPS source with separate URL +
  key. **Account/source-access dependent** — Producer/live-source access is not
  guaranteed. If unavailable, the X card must render as unavailable with setup
  guidance (no silent failure). <https://help.x.com/en/using-x/how-to-use-live-producer>
- **FFmpeg tee** — see above.

## Deferred from M1 (explicitly, for safety/verifiability)

- **Secret storage (Keychain / Electron safeStorage).** Adds a Rust crate +
  cross-process IPC and cannot be verified headlessly; landing it unverified would
  not be a "safe slice." M1 keeps keys inline in the target (same posture as
  today's localStorage) with `streamKeyPresent`, and reserves `streamKeySecretRef`
  for the secret-storage slice (M1b).
- Streaming tab / Recording rename (M2), backend session wiring (M3), tee
  multi-output (M4) — per plan phase order.
