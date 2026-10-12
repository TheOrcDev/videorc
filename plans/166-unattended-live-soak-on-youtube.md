# Plan 166: Videorc tests itself live on YouTube, unattended, and reports what breaks

> **Executor instructions**: Follow this plan slice by slice. Run every
> verification command and confirm the expected result before moving to the
> next slice. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update this plan's entry in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 2efe2baf..HEAD -- apps/desktop/src/renderer/src/lib/go-live-flow.ts apps/desktop/src/renderer/src/lib/remote-surface.ts crates/videorc-backend/src/remote_control.rs crates/videorc-backend/src/backend_authority.rs crates/videorc-backend/src/diagnostics.rs apps/desktop/src/main/backend-log-file.ts apps/desktop/src/main/updater.ts scripts/lib/process-census.mjs scripts/lib/app-launcher.mjs`
> If `decideGoLiveStart`, the remote `streamStart` ack, the remote role
> allowlist, or `RuntimeResourceSampler` changed, compare the "Current state"
> excerpts below against the live code first. A mismatch is a STOP condition.

## Status

- **Priority**: P1. This is how we find leaks, stalls and the "app says On
  air, YouTube has nothing" class (plan 161) before users do.
- **Effort**: L, 10 slices in 3 phases. Phase A (S1-S6) gets a daily
  unattended stream on air. Phase B (S7-S8) adds checks on what YouTube
  received and automatic verdicts. Phase C (S9-S10) adds fault injection and
  turns calibrated thresholds into gates.
- **Risk**: MEDIUM. S2 changes Go Live behaviour that users can reach, behind
  an opt-in setting that is off by default. S1 and S3 are additive. The
  harness runs on its own machine and never touches user installs.
- **Depends on**: owner decisions D1-D7 below (D1 and D2 block Phase A). The
  YouTube channel exists (@VideorcApp, live streaming requested 2026-10-08,
  may take up to 24 h).
- **Category**: test infrastructure + small product additions
- **Planned at**: commit `2efe2baf` (origin/main), 2026-10-08
- **Executed**: not yet
- **Route**: Orchestrator, fit 10, model lane `fable-5` for planning and S2/S8
  (multi-system, judgement-heavy). Per-slice lanes are in "Model lane note".

## Goal

A dedicated machine runs the **public Videorc release** with nobody at it. On
a schedule it goes live on the Videorc YouTube channel, works through scripted
scenarios, and writes down what happened:

- memory growth per process (leaks), file-handle and thread growth
- CPU, host load, encoder speed, dropped and duplicated frames, bitrate
- stream disconnects, reconnects, and failed destinations
- crashes, backend restarts, renderer deaths, preview downgrades
- **what YouTube actually received**: stream health, freezes, audio gaps and
  A/V offset in the public output

Everything is public: viewers watch the live telemetry on stream, every run
gets a public report, and every new failure becomes a GitHub issue.

## What exists today (verified at `2efe2baf`)

Most of the building blocks already exist. The gaps are listed after the
table.

| Building block                                                                                        | Where                                                                                                                   | Use in the soak                                                                  |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Remote control (loopback WS, persisted on/off, discovery file)                                        | `crates/videorc-backend/src/remote_control.rs:26-27,160-171,228-262`; `docs/remote-control.md`                          | How the harness drives the app: scene switches, record toggles, mic, stream stop |
| Remote client helpers                                                                                 | `scripts/lib/remote-control-client.mjs` (`connectRemote`, `remoteRequest`, `waitForRemoteEvent`, `enableRemoteControl`) | Reused as is                                                                     |
| Packaged-app launch via LaunchServices (keeps TCC identity), isolated profile dirs                    | `scripts/lib/app-launcher.mjs:34-44,137-161,495-520`                                                                    | Launching `/Applications/Videorc.app`                                            |
| Owned-process ledger + census by role (backend, ffmpeg, electron-main/renderer/gpu, preview helper)   | `scripts/lib/process-census.mjs:10-21,454,495-540`; `scripts/lib/process-endurance.mjs`                                 | RSS/CPU sampler; the only PIDs the harness may reap                              |
| Memory gate with slope + plateau logic (seconds-long today)                                           | `scripts/smoke-process-memory.mjs:39-76`; `scripts/lib/process-memory-gate.mjs:41,123`                                  | The leak verdict logic, run over hours                                           |
| Stream health over WS (`stream.health` every 500 ms, `diagnostics.stats` 300+ fields, `health.event`) | `crates/videorc-backend/src/protocol.rs:1600,2214`; `recording.rs:935,17108,22953`                                      | Source for the metrics journal (S1)                                              |
| Dead-leg monitor + YouTube-side watch (plan 161)                                                      | `recording.rs:22230` (`StreamLegMonitor`); `platform_stream_watch.rs`                                                   | Reconnect/failed events are soak incidents                                       |
| Host overload events (plan 087)                                                                       | `crates/videorc-backend/src/host_pressure.rs:18-23`                                                                     | Incident signal                                                                  |
| Recording analyzer (freezedetect, repeated frames, audio gaps, A/V skew)                              | `scripts/lib/recording-analyzer.mjs:36-60`                                                                              | Run on clips pulled from YouTube (S7)                                            |
| Flash/click A/V sync + drift fit                                                                      | `scripts/measure-av-sync.mjs`; `scripts/lib/stream-av-sync.mjs:23-26`                                                   | Run on clips pulled from YouTube with the dashboard stimulus                     |
| Self-hosted real-hardware runner (weekly perf)                                                        | `.github/workflows/performance-macos.yml:133-145`                                                                       | Shows the logged-in, TCC-granted machine setup works                             |
| Manual-RTMP destinations make **zero** YouTube Data API calls                                         | `use-studio.tsx:13040-13041` (prepare only for `authMode==='oauth'`)                                                    | Daily soak costs no shared quota                                                 |

**Gaps this plan closes:**

1. **Remote `streamStart` cannot go live unattended.** With streaming on,
   `decideGoLiveStart` always returns `'open-confirmation'`
   (`apps/desktop/src/renderer/src/lib/go-live-flow.ts:20-21`), and the remote
   ack says "The stream did not start. Complete any required confirmation in
   Studio." (`remote-surface.ts:272`). → S2.
2. **No time series on disk.** `diagnostics_json` stores only the final
   snapshot (`storage.rs:1732`). Live stats reach an outside process only
   through the renderer-role socket, and that needs the smoke launch path. → S1.
3. **Logs overwrite themselves.** `backend.log` keeps 2 files × 2 MB
   (`apps/desktop/src/main/backend-log-file.ts:18-19`), so an 8 h soak loses
   nearly all of it. FFmpeg stderr is parsed but never saved raw. → S3.
4. **No crash dumps.** There is no `crashReporter`, Crashpad or Sentry. Only
   `backend-crashes.json` (last 5 exits) and the Rust panic line. → S3, plus
   macOS `DiagnosticReports` collection in S5.
5. **Nothing checks what the platform received**, and no soak streams to a
   real platform at all. → S7.
6. **Leak gates run for seconds, idle only, never while streaming.** → S8.

## Design

### The rig

```
 ┌──────────────── Soak Mac (dedicated, no personal data) ────────────────┐
 │                                                                        │
 │  launchd ──► soak harness (Node, scripts/soak/*, git clone of main)    │
 │                 │  installs/updates /Applications/Videorc.app          │
 │                 │  launches it via LaunchServices, isolated profile     │
 │                 │  drives it via Remote Control (loopback WS)           │
 │                 │  samples: process census 10 s, footprint/lsof 10 min  │
 │                 │  tails: metrics journal (S1), health events, logs     │
 │                 ▼                                                      │
 │  Videorc.app ── captures the screen + system audio ─────────► RTMPS ───┼──► YouTube @VideorcApp
 │                 the screen shows the soak dashboard (S6):              │        │
 │                 live telemetry, moving timecode, flash+click stimulus  │        │
 │                                                                        │        │
 │  receiver watch (S7) ◄── liveStreams.list healthStatus (own GCP proj) ─┼────────┤
 │                     ◄── yt-dlp pulls 2-min clips of the public stream ─┼────────┘
 │                                                                        │
 │  verdict engine (S8) ──► run report + verdict.json ──► public reports repo
 │                     └──► GitHub issue per new incident signature       │
 │                     └──► Discord ping for P0                           │
 └────────────────────────────────────────────────────────────────────────┘
```

### Decisions taken in this plan (with reasons)

- **macOS, not Linux or Windows.** macOS Beta is the most-used and most stable
  track. Linux screen capture needs a human whenever the portal restore token
  is refused (`docs/linux-dev-loop.md:134-150`), and Wayland is marked
  unsupported (`docs/linux-port-plan.md:10-20`). Windows Alpha has never run
  on a physical machine. Linux and Windows rigs can follow once Phase C is
  stable.
- **Test the public release first, release candidates second.** Phase A soaks
  what users actually run. Once stable, the same rig soaks the signed
  candidate before promotion (follow-up, see "Out of scope").
- **Manual RTMP with a persistent YouTube stream key.** It makes no Data API
  calls (zero shared quota), needs no OAuth refresh, and with Auto-start each
  connection goes live by itself. Each run becomes its own VOD. The OAuth
  Go Live path is tested once a day as a separate scenario in Phase C, so its
  quota cost stays small (~250 of 10,000 units, shared by all installs).
- **Drive the real UI path, not `session.start` directly.** Calling the
  backend directly (as `smoke:multistream-endurance` does) skips the
  renderer's Go Live flow: preflight, settings, destinations, confirmation.
  Users go through that flow, so the soak does too, via remote control +
  S2.
- **The app writes its own time series (S1).** Then the harness needs no
  privileged token. The journal is also useful in support bundles for real
  users.
- **Screen + system audio only in Phase A, no camera, no mic.** An unattended
  room camera or mic on a public stream is a privacy risk. The dashboard
  supplies motion and a sync stimulus. A camera aimed at a clock is optional
  in Phase C (D5).
- **Thresholds start report-only.** For the first 14 days every threshold
  only reports. S10 sets real limits from that data, the same calibrate-then-
  gate approach as `perf:calibrate`.

### Scenarios

Each scenario is a scripted timeline in `scripts/soak/scenarios/*.mjs`. All
waits are on events (`remote.state`, journal lines, health events), never
fixed sleeps (AGENTS.md:67).

| Scenario                 | What it does                                                                                                                                               | Finds                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `marathon`               | 8 h live at 1080p30 / 6000 kbps. Scene switch every 10 min (`sceneApply`). Local recording on for 20 min every 2 h (`recordStart/Stop`). Mic mute toggles. | Leaks under load, drift, slow decay, encoder speed loss. 8 h stays under YouTube's 12 h archive limit, so each run keeps a VOD. |
| `churn`                  | 40 cycles: go live, 90 s, stop, 20 s idle.                                                                                                                 | Leaks per session, teardown leftovers (orphan ffmpeg, open fds), start latency creeping up.                                     |
| `idle`                   | App open, preview on, not live, 2 h.                                                                                                                       | Idle leaks, idle CPU and timers.                                                                                                |
| `update`                 | Lets the in-app updater find and download a new release, quits while idle, relaunches, checks the version.                                                 | Updater regressions (the real path users get).                                                                                  |
| `faults` (Phase C)       | Network impairment for 30 s via `dnctl`/`pfctl`. SIGSTOP of an **owned** ffmpeg PID for 0.5 s and 6 s.                                                     | Reconnect (plan 161), stall survival (plan 087), honest "On air" status.                                                        |
| `oauth-golive` (Phase C) | One short OAuth Go Live a day through the app's own YouTube connection.                                                                                    | The OAuth/broadcast path and its quota accounting.                                                                              |

**Daily schedule (proposed, Europe/Madrid, owner can change, D4):**
`04:00` update check → `04:30` churn (≈75 min) → `06:00` marathon (8 h) →
`14:15` idle (2 h) → `16:30` report + publish. Machine reboots weekly on
Sunday 03:30. Off-hours slots keep the CPU free for the owner's own streams
on other machines and spread viewer exposure across time zones.

### Incident signals and first thresholds (report-only until S10)

| Signal                                  | Source                                                                                    | Incident when                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSS growth per role                     | census every 10 s                                                                         | after 30 min warm-up, linear slope over the last 2 h and over the second half both above: backend 20 MB/h, electron-main 10 MB/h, renderer 30 MB/h, gpu 30 MB/h, each ffmpeg 10 MB/h, preview helper 20 MB/h. Plateaus do not count (`process-memory-gate.mjs` logic). |
| Absolute memory                         | census                                                                                    | owned RSS above 3 GB, or the macOS `footprint` of any role doubles from warm-up                                                                                                                                                                                        |
| Handles / threads                       | `lsof -p` and `ps -M` every 10 min on owned PIDs                                          | slope above 50 fds/h or 20 threads/h                                                                                                                                                                                                                                   |
| Orphans                                 | ledger + census after each stop                                                           | any owned PID still alive 10 s after `session.stop` acknowledged                                                                                                                                                                                                       |
| Dropped frames                          | journal                                                                                   | above 0.5% over any 5-min window                                                                                                                                                                                                                                       |
| Encoder speed                           | journal                                                                                   | below 0.97 for 60 s or longer                                                                                                                                                                                                                                          |
| Bitrate                                 | journal                                                                                   | below 70% of target for 60 s or longer                                                                                                                                                                                                                                 |
| Destination                             | health events                                                                             | any `stream-target-reconnecting`, `-failed`, `stream-output-stalled`                                                                                                                                                                                                   |
| **App says live, YouTube says no data** | journal + receiver watch                                                                  | **P0.** Two consecutive `noData` polls while the app reports On air (the plan 161 incident class)                                                                                                                                                                      |
| YouTube health                          | `liveStreams.list` every 5 min                                                            | status `bad`, or `ok` for 3 polls in a row, or any new configuration issue                                                                                                                                                                                             |
| Public output                           | yt-dlp clip every 30 min                                                                  | freeze above 1 s, audio gap above 100 ms, A/V offset above 150 ms, drift above 20 ms per 30 min                                                                                                                                                                        |
| Crashes                                 | `DiagnosticReports/*.ips`, `backend-crashes.json`, Crashpad dir, renderer/GPU death lines | any new entry. **P0** when it ends the stream.                                                                                                                                                                                                                         |
| Preview downgrade                       | diagnostics fallback reason                                                               | any downgrade (AGENTS.md:54-62 says it must never be silent)                                                                                                                                                                                                           |
| Host overload                           | `host-overloaded` event                                                                   | any (the rig should never be overloaded, so this points at us)                                                                                                                                                                                                         |
| Start latency                           | remote ack → journal `live`                                                               | above 10 s, or a slope upward across churn cycles                                                                                                                                                                                                                      |

Each incident gets a **signature** (scenario-independent, e.g.
`leak:renderer`, `stream:noData-while-live`, `crash:videorc-backend:<top frame>`)
used to dedupe GitHub issues.

### Transparency

- **On stream:** the dashboard (S6) shows version, run id, scenario, uptime,
  memory per role as sparklines, dropped frames, bitrate, encoder speed, the
  last 5 health events, and open incident count. Viewers see the real numbers
  as they happen. It never shows keys, tokens, paths in home dirs, or chat
  identities.
- **Per run:** a markdown report + `verdict.json` + charts (PNG) pushed to a
  public reports repo (D3). The YouTube VOD description links to it.
- **Per incident:** one GitHub issue per new signature in `TheOrcDev/videorc`,
  labelled `soak`, with the run link, excerpted metrics and logs (redacted).
  Repeat hits add a comment with the new run link instead of a new issue.
- **P0:** Discord webhook ping to the owner (reusing the
  `scripts/notify-discord-release.mjs` pattern).

### Safety

- The soak Mac is a **dedicated machine with a dedicated macOS user**: no
  personal accounts, no iCloud, no signed-in browsers, no password manager.
  Everything on its screen is public.
- Do Not Disturb is always on, so no notification banner can show up on
  stream.
- The stream key lives only in Videorc's secrets file (0600, `secrets.rs`)
  and the harness config (0600). Every artifact goes through a redaction pass
  before publishing (reuse the `smoke:streaming-secrets` redaction checks),
  and publishing fails closed if a key-shaped string survives.
- **Kill switch:** the harness checks `soak-control.json` in the reports repo
  before every scenario step and every 60 s while live. `{"enabled": false}`
  stops the stream within a minute. The owner can also end the stream from
  YouTube Studio. The harness reads that as an incident and does not restart
  it until the next scheduled run.
- The harness only reaps the app PID it launched and the PIDs in Videorc's
  owned-process ledger. No `pgrep -f`, no broad scans (AGENTS.md:66).
- Stream title always starts with "Automated test" so viewers know what they
  are watching. Chat stays on with YouTube's "hold potentially inappropriate
  messages" and slow mode 30 s (D6).

## Owner decisions

These block or shape the work. Each has a recommendation.

- **D1 — Soak hardware (blocks S4).** Recommended: a dedicated Apple Silicon
  Mac mini (M4, 16 GB, wired Ethernet) plus an HDMI dummy plug, so a display
  always exists. ScreenCaptureKit reports no display when the screen is off,
  and the lock screen covers capture (`plans/148-diagnose-legacy-recording-startup-admission.md:57`,
  `plans/qa-fixes-2026-10-03.md:321`). A spare older Apple Silicon Mac also
  works. Intel Macs are not worth soaking.
- **D2 — How the soak goes live without a click (blocks S2).** Recommended: a
  product setting under Remote Control, "Allow Go Live from remote without
  confirmation", off by default, that lets `streamStart` skip the dialog
  **only after the normal preflight passes**. Stream Deck users get it too.
  Alternative: a soak-only env flag with a capability token, which never ships
  as a user-visible setting but tests a path users never take.
- **D3 — Where public reports live.** Recommended: a new public repo
  `TheOrcDev/videorc-soak` (reports, charts, `soak-control.json`). Evidence
  media must not go into the main repo (AGENTS.md:70). Alternative: GitHub
  issues only, no per-run reports.
- **D4 — Schedule.** Recommended: the daily schedule above. Alternative: 24/7
  marathons (more leak signal, but no VODs past 12 h and no idle/churn data).
- **D5 — Camera and mic.** Recommended: none in Phase A. In Phase C, optionally
  a USB webcam aimed at an analog clock, mic hardware-muted or absent.
- **D6 — Chat moderation.** Recommended: chat on, YouTube auto-hold, slow mode
  30 s, no auto-reply.
- **D7 — A separate Google Cloud project for the soak's YouTube API reads**
  (receiver watch + VOD title/description updates). Recommended: yes, so soak
  polling (about 300-500 units/day) never touches the shared Videorc quota.

## Slices

### Phase A: on air, unattended

### S1 — Metrics journal: the app writes its own time series

**Files:** `crates/videorc-backend/src/metrics_journal.rs` (new),
`crates/videorc-backend/src/diagnostics.rs` (`RuntimeResourceSampler`
~2243-2340), `crates/videorc-backend/src/recording.rs` (stream health
publish ~22953), settings plumbing, `apps/desktop/src/shared/backend.ts`
(contract), support bundle section in `support_bundle.rs`.

1. When enabled (setting `diagnostics.metricsJournal`, or env
   `VIDEORC_METRICS_JOURNAL=1`), append one NDJSON line every 5 s to
   `<userData>/logs/metrics/<yyyy-mm-dd>.ndjson`, plus one line per health
   event at the moment it happens.
2. Line schema v1: `ts`, `appVersion`, `sessionId`, `state` (idle / live /
   recording / both), per-leg `{targetId, platform, bitrateKbps, fps,
droppedFrames, duplicatedFrames, speed, state}`, `encoderQueueAgeMs`,
   `previewPresentFps`, `previewFallbackReason`, `backendRssBytes`,
   `ffmpegCount`, `hostLoad1PerCore`, `healthEventCodes[]`. No keys, no URLs
   with keys, no chat content. Add a contract fixture under
   `protocol-fixtures/`.
3. Rotate by day and cap at 200 MB total (oldest first). Off by default for
   users. When on, the last 2 h go into the support bundle.
4. Writes happen on a background task. Never block the encoder path, and
   drop lines rather than queueing without bound.

**Done when:** a streaming smoke writes a line every 5 s ±1 s with correct
leg stats; a contract test locks schema v1 and asserts no field holds a
`rtmp(s)://` URL or stream key; `pnpm smoke:multistream` and
`pnpm smoke:recording-studio` stay green with the journal on.
**STOP if:** the journal needs a lock on the encoder or compositor hot path.

### S2 — Remote Go Live without the dialog (opt-in, preflight still runs)

**Files:** `apps/desktop/src/renderer/src/lib/go-live-flow.ts:20-21`,
`apps/desktop/src/renderer/src/lib/remote-surface.ts` (~263-272),
`apps/desktop/src/renderer/src/hooks/use-studio.tsx` (`startSession`
~13416), Remote Control settings UI, `docs/remote-control.md`.

1. Add the setting from D2 (copy from the owner; shadcn-only UI per
   `.claude/skills/videorc-design/SKILL.md`).
2. `decideGoLiveStart(streamEnabled, {source: 'remote', remoteConfirmBypass})`
   returns `'start-directly'` only when the source is remote **and** the
   setting is on. The UI path is unchanged.
3. Preflight (`decideGoLivePreflight`) and partial-setup handling still run.
   On failure, the remote ack carries the preflight reason, not the generic
   "Complete any required confirmation" text.
4. The ack reports the outcome after the session actually starts or fails,
   so the harness gets a real yes/no.
5. Extend `smoke:remote-control` to cover `streamStart` both ways: the
   setting off still opens the dialog, the setting on goes live against a
   local RTMP sink.

**Done when:** the extended smoke passes both cases; unit tests cover the
decision table; with the setting off, nothing changes for UI or remote users.
**STOP if:** skipping the dialog would also skip a preflight check or the
YouTube quota guard.

### S3 — Keep the evidence: log retention and crash dumps

**Files:** `apps/desktop/src/main/backend-log-file.ts:18-19`,
`apps/desktop/src/main/index.ts` (startup), backend FFmpeg stderr consumer.

1. Read `VIDEORC_BACKEND_LOG_MAX_BYTES` and `VIDEORC_BACKEND_LOG_MAX_FILES`
   (bounded: at most 100 MB × 20). Defaults stay 2 MB × 2.
2. When the metrics journal is on, also tee raw FFmpeg stderr per session to
   `<userData>/logs/ffmpeg/<sessionId>.log`, with stream keys redacted at
   write time (reuse the existing URL redaction).
3. Start Electron `crashReporter` with `uploadToServer: false`, so minidumps
   land in the local Crashpad dir. Nothing is uploaded.

**Done when:** a unit test proves the rotation bounds; a smoke shows the
ffmpeg log exists with the key redacted; forcing a renderer crash in a dev
build leaves a minidump.
**STOP if:** crashReporter changes the packaged app's entitlements or needs a
new signing step.

### S4 — Soak machine setup runbook + `soak:doctor`

**Files:** `docs/soak/machine-setup.md` (new), `scripts/soak/doctor.mjs`,
`package.json` script `soak:doctor`, `config/soak/com.videorc.soak.plist`
(template), `config/soak/soak.config.example.json`.

1. Runbook: dedicated user, auto-login (FileVault off, an accepted trade-off
   on a machine with no personal data), screen lock off, display sleep never,
   dummy display, Do Not Disturb always on, automatic macOS updates off
   (update on the weekly reboot instead), Homebrew `ffmpeg yt-dlp node pnpm`,
   wired network, install Videorc from videorc.com, grant Screen Recording +
   System Audio once by hand.
2. YouTube side: in Studio → Stream, create a persistent key "Videorc soak
   1080p30", turn on Auto-start, set the default title "Automated test:
   Videorc soak" and description, chat settings per D6. Enter the key once in
   the soak profile's YouTube destination as manual RTMP.
3. `soak:doctor` checks each item and prints PASS/FAIL. Display present and
   awake; no lock; TCC grants (a 3 s screen-only test recording through
   remote control, analyzed by `recording-analyzer`); disk free above 100 GB;
   network reaches `a.rtmps.youtube.com:443`; Videorc version; harness
   config mode 0600; DND on; kill switch reachable.

**Done when:** `pnpm soak:doctor` passes on the soak Mac and fails clearly
with each check broken on purpose (lock enabled, display unplugged, grant
removed).
**STOP if:** capture cannot run with the display awake and unlocked under
auto-login (that would be a product bug; file it).

### S5 — Harness core: install, launch, drive, sample, tear down

**Files:** `scripts/soak/run.mjs`, `scripts/soak/install.mjs`,
`scripts/soak/sampler.mjs`, `scripts/soak/scenarios/{marathon,churn,idle,update}.mjs`,
`scripts/soak/lib/*.mjs` + tests, `package.json` scripts `soak:run`,
`soak:install-latest`.

1. **Install:** read `https://www.videorc.com/api/updates/latest-mac.yml`.
   If newer than the installed `CFBundleShortVersionString`, run the `update`
   scenario (real in-app path). If that fails, record an incident and fall
   back to downloading the zip, `codesign --verify --deep --strict` +
   `spctl -a -vv`, then replacing the app. Never run an unverified build.
2. **Launch:** `macosLaunchServicesAppSpawnSpec` with the soak profile
   (`VIDEORC_USER_DATA_DIR`, `VIDEORC_APP_DATA_DIR`, `VIDEORC_SECRETS_PATH`,
   `VIDEORC_RECORDINGS_DIR`, `VIDEORC_METRICS_JOURNAL=1`, log env from S3,
   `VIDEORC_DISABLE_AUTO_UPDATE=1` during scenarios). Wait for
   `remote-control.json` to appear and `remote.describe` to answer.
3. **Drive:** scenarios use `remoteRequest` intents only (`streamStart` via
   S2, `streamStop`, `sceneApply`, `recordStart/Stop`, `micToggle`). Each step
   waits on `remote.state` or a journal line, with a deadline.
4. **Sample:** census every 10 s → `census.csv`; `footprint` + `lsof` +
   thread count every 10 min on owned PIDs → `resources.csv`; tail the journal
   → copy into the run folder. Hold `caffeinate -d -i -s` for the whole run.
5. **Tear down:** `streamStop`, wait for state idle, quit the app cleanly,
   reap only ledger PIDs past a deadline, assert a clean ledger
   (`waitForCleanProcessState`). Collect new `~/Library/Logs/DiagnosticReports`
   files for Videorc / videorc-backend / ffmpeg, `backend-crashes.json`,
   Crashpad dumps, logs.
6. **Run folder:** `~/soak-runs/<date>-<scenario>-<shortid>/` with
   `manifest.json` (app version, harness commit, macOS version, hardware,
   scenario, start/end).
7. **Kill switch:** fetch `soak-control.json` before each step and every
   60 s while live.

**Done when:** `pnpm soak:run --scenario churn --cycles 3` on the soak Mac
goes live on YouTube 3 times with no clicks, leaves a clean ledger, and
writes a complete run folder; unit tests cover the scenario step engine and
deadlines with fake remote/journal sources.
**STOP if:** remote control has to be enabled by a click each launch (it
should persist, `remote_control.rs:160-171`).

### S6 — On-stream dashboard

**Files:** `scripts/soak/dashboard/` (static HTML/JS, no build step),
`scripts/soak/dashboard-server.mjs` (localhost only, SSE).

1. A fullscreen kiosk browser window on the soak Mac shows the dashboard. The
   harness serves it on `127.0.0.1` and pushes metrics by SSE from the census
   and journal.
2. It always has a moving element and a large timecode with milliseconds, so
   freezes are visible in the public output.
3. Every 10 s it fires the flash + click stimulus in the format
   `measure-av-sync.mjs` expects, captured through screen + system audio. This
   lets S7 measure A/V sync on the YouTube output.
4. Content allowlist: version, run id, scenario, uptime, charts, health event
   codes, incident count. A unit test renders it from a fixture and fails on
   any string that looks like a key, token, email or home-dir path.

**Done when:** a 5-min local recording of the dashboard passes
`measure-av-sync` (offset found, under 150 ms) and `recording-analyzer`
(no freeze); the redaction test passes.

### Phase B: what YouTube received, and automatic verdicts

### S7 — Receiver watch

**Files:** `scripts/soak/receiver/youtube-health.mjs`,
`scripts/soak/receiver/clip-puller.mjs` + tests.

1. **Health:** every 5 min, `liveStreams.list?part=status&mine=true` from the
   soak's own GCP project (D7), with a refresh token stored only in the
   harness config. Record `streamStatus`, `healthStatus.status`,
   `configurationIssues`. Hard budget: at most 600 units a day. Stop polling
   when the budget is spent.
2. **Clips:** every 30 min while live, `yt-dlp` records 120 s of the public
   live URL into the run folder. Run `recording-analyzer` (freeze, audio gaps)
   and `measure-av-sync` (offset). Keep the analysis JSON. Delete clip media
   after analysis unless it shows an incident (then keep it locally for 14
   days; it is never published in the main repo).
3. Each run also pulls the VOD after processing and analyzes the first and
   last 10 min.

**Done when:** on a live run the health log fills every 5 min and clips are
analyzed; stopping the encoder mid-run produces a `noData` reading within
2 polls.
**STOP if:** pulling the public stream breaks YouTube's terms for the
channel owner. Check before building; fall back to health polling only.

### S8 — Verdict engine, reports, issues

**Files:** `scripts/soak/verdict.mjs`, `scripts/soak/report.mjs`,
`scripts/soak/publish.mjs`, `config/soak/thresholds.v1.json` + tests.

1. Compute every signal in "Incident signals" from the run folder. Use the
   existing `process-memory-gate.mjs` slope/plateau code for leaks.
2. Write `verdict.json` (`pass` / `warn` / `incident` per signal, with
   evidence pointers) and `report.md` with charts (RSS per role, bitrate,
   dropped frames, speed, YouTube health timeline).
3. Publish: redaction pass (fail closed) → push the report to the reports
   repo → update the VOD description with the report link (soak GCP project,
   about 50 units) → for each incident signature, find an open `soak` issue
   with that signature and comment, or open a new one → Discord ping on P0.
4. Thresholds are report-only (`mode: "report"` in `thresholds.v1.json`)
   until S10.

**Done when:** feeding recorded fixture runs (one clean, one with a fake
renderer leak, one with `noData` while live) gives the expected verdicts;
a dry-run publish prints the issue it would open; a real run publishes a
report with no secrets (checked by the redaction test on the published
files).

### Phase C: faults and gates

### S9 — Fault injection

**Files:** `scripts/soak/scenarios/faults.mjs`,
`config/soak/sudoers.soak.example` (allows only the exact `dnctl`/`pfctl`
commands).

1. Network: dummynet pipe on the RTMP port only. 30 s of 100% loss, then
   30 s at 1 Mbps. Expect `stream-target-reconnecting` → `-resumed` and no
   P0 `noData` while the app shows On air.
2. Process: SIGSTOP an **owned** ffmpeg PID (from the ledger) for 0.5 s
   (must survive silently) and 6 s (must report, plan 087 / 161). Always
   SIGCONT in a `finally`.
3. Add `oauth-golive` once a day if D7 and the app's OAuth connection exist.

**Done when:** each fault produces the expected event sequence in the
journal, and the verdict engine marks a missing expected event as an
incident.
**STOP if:** a network rule can outlive the harness (always install with a
deadline and remove in `finally` plus at the next `soak:doctor`).

### S10 — Calibrate and turn on gates

1. After 14 days of report-only runs, run `scripts/soak/calibrate.mjs`: per
   signal, take p95 of clean runs plus margin. Write
   `config/soak/thresholds.v2.json` with `mode: "gate"`.
2. The owner reviews the proposed numbers (one PR).
3. Optional follow-up: make "4 h clean soak on the candidate" a release gate
   in the `videorc-release` skill.

**Done when:** thresholds v2 are merged and the next 3 runs use them.

## Out of scope

- Soaking unreleased candidates before promotion (follow-up after S10).
- Linux and Windows rigs (after Phase C; Linux needs portal restore tokens
  that never get refused).
- Multistream to Twitch/Kick/X from the rig. Phase A is YouTube only. A
  second YouTube key for the vertical leg can be added to `marathon` later.
- Camera and mic soak (D5).
- Changing defaults for real users. The journal, log size and crash dumps
  stay off or unchanged unless enabled.

## STOP conditions

- Any slice needs the stream key, tokens or chat identities in a log,
  report, dashboard or issue.
- S2 would let any surface go live without preflight, or with the setting off.
- The harness would need to kill a process it did not launch and that is
  not in the owned-process ledger.
- The soak would spend shared Videorc YouTube quota outside `oauth-golive`.
- A threshold has to become a gate before 14 days of report-only data exist.

## Verification summary

| Gate                                                                                                                                  | Why                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                                                    | every TS slice                                    |
| `pnpm test:scripts`                                                                                                                   | harness libs, verdict engine, dashboard redaction |
| `cargo fmt --check --all`, targeted `cargo test -p videorc-backend metrics_journal`, `cargo clippy -p videorc-backend -- -D warnings` | S1, S3 backend                                    |
| `pnpm --filter @videorc/desktop test`                                                                                                 | S2 decision table, S3 rotation                    |
| `pnpm smoke:remote-control` (extended)                                                                                                | S2                                                |
| `pnpm smoke:multistream`, `pnpm smoke:recording-studio` with the journal on                                                           | S1 must not hurt recording/streaming              |
| `pnpm soak:doctor` on the soak Mac                                                                                                    | S4                                                |
| `pnpm soak:run --scenario churn --cycles 3` on the soak Mac                                                                           | S5 end to end                                     |
| One full daily schedule with a published report                                                                                       | Phase B done                                      |
| Owner acceptance: watches one marathon VOD and one report                                                                             | the rig does what this plan says                  |

## Model lane note

Per `CLAUDE.md`: S1, S3, S5, S7 are clear implementation work → `gpt-5.5`
(fit 7-8). S2 is user-facing Go Live behaviour with a safety edge →
`fable-5` (fit 9). S6 is visual, viewer-facing → `opus-4.8` (fit 8). S4 is a
runbook plus checks → `gpt-5.5`. S8 (verdict judgement, issue dedupe,
redaction) and S9 (faults that touch the network) → `fable-5`. Per the
owner's "gates at the end" preference, write and commit the slices in each
phase first, then run the Rust and e2e gates once at the end of the phase.
