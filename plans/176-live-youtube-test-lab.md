# Plan 176: Live lab. Claude goes live on the Videorc YouTube channel and tests everything for real

> **Executor instructions**: Follow this plan slice by slice. Run every
> verification command and confirm the expected result before moving to the
> next slice. If anything in "STOP conditions" happens, stop and report. Do
> not improvise. When done, update this plan's entry in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 20d36819..HEAD -- apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/components/go-live-dialog.tsx apps/desktop/src/renderer/src/lib/go-live-flow.ts apps/desktop/src/renderer/src/lib/remote-surface.ts crates/videorc-backend/src/oauth.rs crates/videorc-backend/src/youtube.rs crates/videorc-backend/src/youtube_chat.rs crates/videorc-backend/src/youtube_quota.rs scripts/lib/app-launcher.mjs scripts/lib/remote-control-client.mjs`
> If `VIDEORC_REMOTE_DEBUG_PORT`, the runtime `VIDEORC_YOUTUBE_CLIENT_ID` /
> `VIDEORC_YOUTUBE_CLIENT_SECRET` override, or the Go Live dialog's privacy
> field changed, re-check "What exists today" against the live code first.

## Status

- **Priority**: P1. Many merged plans end with "live acceptance owed". This
  plan pays that debt in one place and keeps paying it on every release.
- **Effort**: L. Hookup (owner, about 45 min), five build slices (L1-L5,
  about 3 agent days), then six attended campaigns (C1-C6, 1-3 h each), then
  one release-gate slice (L6).
- **Risk**: MEDIUM. Streams are public or unlisted on a real channel, and
  there are secrets on disk. Product code changes are small and additive
  (L1 reuses plan 166 S1/S3). The harness runs only with the owner's go.
- **Depends on**: the owner's hookup (L0), decisions D1-D8 below.
- **Relationship to plan 166**: plan 166 is the unattended soak rig. This
  plan is the attended version that runs now, on the owner's Mac, with
  Claude driving and the owner watching. It builds the parts 166 needs
  anyway (metrics journal, log retention, test card, receiver watch) and
  adds a feature test matrix and a viewer chat bot. Plan 166 later only
  adds the unattended parts: remote Go Live without the dialog, the
  dedicated machine, the schedule, gates and fault automation.
- **Category**: test infrastructure + live acceptance
- **Planned at**: commit `20d36819` (origin/main), 2026-10-11
- **Executed**: not yet
- **Route**: Orchestrator, fit 10, model lane `fable-5` (multi-system,
  public-facing, secrets). Per-slice lanes in "Model lane note".

## Goal

Claude runs real live streams on the Videorc YouTube channel and checks
every live feature end to end. Checks come from both sides:

- **App side**: what Videorc thinks happened (session state, leg stats,
  health events, chat it received, memory and CPU).
- **YouTube side**: what YouTube actually got (broadcast state, ingest
  health, resolution and frame rate, chat messages that arrived, the VOD)
  plus analysis of the public output itself (freezes, audio gaps, A/V sync).

Each run writes a report. Each failure becomes a GitHub issue, and where
possible a fake-provider smoke, so the same bug is caught offline next time.
At the end, a 20-minute live suite becomes a release gate.

## What exists today (verified at `20d36819`)

| Building block                                             | Where                                                                                       | Use in the lab                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CDP into the real renderer, any build                      | `apps/desktop/src/main/index.ts:929-933` (`VIDEORC_REMOTE_DEBUG_PORT`)                      | Claude clicks the real Go Live dialog. **No product change is needed to go live without a human** (plan 166's D2 is unattended-only) |
| CDP-driven UI scripts                                      | `scripts/smoke-freeform-editor-app.mjs`, `scripts/preview-window-probe.mjs`                 | Pattern for the UI driver                                                                                                            |
| Remote control intents                                     | `docs/remote-control.md:59-69`; `scripts/lib/remote-control-client.mjs`                     | Scenes, takeover, record, mic, system audio, comment highlight, clip mark, stream stop                                               |
| LaunchServices launch, isolated profile                    | `scripts/lib/app-launcher.mjs`                                                              | Lab profile never touches the owner's real Videorc data                                                                              |
| Runtime YouTube OAuth client override                      | `crates/videorc-backend/src/oauth.rs:2944-2947`                                             | Lab Go Lives use the lab's own Google project, so they never spend the shared Videorc quota                                          |
| Go Live dialog privacy field (Public / Unlisted / Private) | `apps/desktop/src/renderer/src/components/go-live-dialog.tsx:202-219`                       | Early campaigns stream Unlisted                                                                                                      |
| YouTube chat read + send                                   | `crates/videorc-backend/src/youtube_chat.rs:36-37,72`                                       | Under test                                                                                                                           |
| Quota trial guardrails                                     | `scripts/lib/youtube-efficiency-probe.mjs` (plan 096), `probe:youtube-efficiency`           | Reused for the lab's quota budget                                                                                                    |
| Recording analyzer, A/V sync measure                       | `scripts/lib/recording-analyzer.mjs`, `scripts/measure-av-sync.mjs`                         | Run on clips pulled from the public stream                                                                                           |
| Process census + memory slope logic                        | `scripts/lib/process-census.mjs`, `scripts/lib/process-memory-gate.mjs`                     | Leak checks during long runs                                                                                                         |
| 4K YouTube gate                                            | `scripts/lib/youtube-4k-stream-gate.mjs`                                                    | 4K scenario                                                                                                                          |
| Fake YouTube API                                           | `scripts/lib/fake-youtube-api.mjs`, `smoke:youtube-quota`, `smoke:live-chat-fake-providers` | Where live findings get offline regressions                                                                                          |

**Gaps** (closed below): no on-disk time series of stream stats and logs
that overwrite themselves (L1, from plan 166); no test card or scripted
speech (L3); nothing reads the YouTube side (L4); no viewer to chat with
the stream (L4); no scenario runner or report (L5).

## How it works

```
 Owner's Mac
 ┌───────────────────────────────────────────────────────────────────────┐
 │ Claude Code session                                                   │
 │   pnpm live:run --scenario <name>                                     │
 │     │ launches Videorc (lab profile, CDP port, remote control)        │
 │     │ clicks Go Live through CDP, drives features through remote      │
 │     │ reads the metrics journal + health events (L1)                  │
 │     ▼                                                                 │
 │ Videorc ── captures the LAB DISPLAY only (virtual display, D1) ──────┼─RTMPS─► YouTube channel
 │            mic = BlackHole virtual device fed scripted speech (L3)    │            │
 │                                                                       │            │
 │ Lab display: fullscreen test card (L3): timecode, motion,             │            │
 │   flash+click every 10 s, run id, scenario                            │            │
 │                                                                       │            │
 │ YouTube observer (L4, lab Google project):                            │            │
 │   broadcaster token ── liveBroadcasts / liveStreams / videos ◄────────┼────────────┤
 │   viewer token ─────── posts chat as a real viewer ───────────────────┼──────────► │
 │   yt-dlp ───────────── 2-min clips of the public output ◄─────────────┼────────────┘
 │                                                                       │
 │ Report: ~/videorc-live-lab/runs/<id>/report.md + verdict.json         │
 └───────────────────────────────────────────────────────────────────────┘
 Owner: watches on phone, answers by-eye prompts in the Claude session.
```

### Decisions taken in this plan

- **Attended, not unattended.** Claude starts each run only after the owner
  says go, in the session. The owner watches the stream and answers by-eye
  prompts (Studio-only facts like Dual stream, how a card looks). This is
  what lets the lab start now instead of waiting for plan 166's hardware.
- **Capture only the lab display.** Videorc captures a virtual display
  (BetterDisplay or an HDMI dummy plug, D1) that shows only the test card.
  The owner's own screen, notifications and windows never reach the stream.
- **The lab's own Google Cloud project.** Every lab YouTube API call (the
  app's Go Live, the observer, the viewer chat bot) goes through a separate
  project in Testing mode, through the existing runtime override. Shared
  Videorc quota stays at zero, except one budgeted acceptance run on the
  bundled client per release (C6).
- **Scripted speech, not a live mic.** BlackHole 2ch is set as the lab
  profile's microphone. The harness plays known phrases into it (`say`
  output), so captions, voice commands and Buddy's listening are tested with
  known input. One owner-voice pass covers the real mic.
- **Unlisted first.** C1-C4 stream Unlisted. Public only from C5, when the
  basics are proven (D2).
- **Real UI path.** Go Live goes through the real dialog (preflight,
  destinations, metadata, confirmation), clicked through CDP. Only feature
  toggles use remote control intents, which are also a real user surface.
- **Every bug found live gets an offline guard** when the fake providers
  can express it. The live lab finds bugs; the fakes keep them fixed.

### What "hook me up" means (owner, L0)

Never paste a key, token, secret or password into the chat. Secrets go in
through `pnpm live:hookup`, which reads them with hidden input and writes
`~/.videorc-live-lab/config.json` (dir 0700, file 0600). Claude only ever
sees the last 4 characters.

1. **Channel.** Tell Claude the channel URL or handle. In YouTube Studio
   check: live streaming is enabled (the 24 h wait after first enablement is
   over, the phone is verified), the channel is **not** "made for kids"
   (that turns chat off), and no live-streaming restriction shows.
2. **Stream keys.** Studio → Create → Go live → Stream → create two
   persistent keys, "Videorc lab" and "Videorc lab vertical". Default
   settings: visibility Unlisted, Auto-start on, Auto-stop on, chat on, slow
   mode 30 s, hold potentially inappropriate messages.
3. **Lab Google Cloud project** (about 15 min):
   - Create project `videorc-live-lab`, enable YouTube Data API v3.
   - Google Auth Platform → Audience: External, **Testing**. Add two test
     users: the Google account that owns the channel, and your personal
     account (the "viewer").
   - Data Access: add `https://www.googleapis.com/auth/youtube.force-ssl`.
   - Clients: create a **Desktop** OAuth client.
4. **Run `! pnpm live:hookup`** in this session. It asks for the client id
   and secret and the two stream keys, then opens Google consent twice:
   once signed in as the channel account (pick the channel if it is a Brand
   Account), once as your personal account. Testing-mode refresh tokens die
   after 7 days; `live:doctor` warns on day 6, and you rerun the consent
   part.
5. **This Mac.** Install BetterDisplay (or plug in an HDMI dummy) for the lab
   display, and `brew install yt-dlp ffmpeg blackhole-2ch` (BlackHole asks
   for your password and may need a restart of Core Audio). Grant the
   Videorc build under test Screen Recording, Microphone and System Audio
   once. Turn on a Focus mode during runs.
6. **Go windows.** Say when it is OK to go live. Claude never starts a run
   on its own.

### Quota budget (lab project, 10,000 units/day)

Documented costs (confirm in the lab project's Cloud Console metrics during
C2): each insert, bind, transition and chat send costs 50; each list costs 1.

| Item                                      | Units          |
| ----------------------------------------- | -------------- |
| One OAuth Go Live + stop (app)            | about 300      |
| App chat polling, 30 min (after plan 094) | about 75       |
| Observer, every 2 min, 1 h                | about 90       |
| Viewer chat bot, 20 messages              | 1,000          |
| **Typical campaign day**                  | 2,500 to 4,000 |

The harness keeps a local unit counter and refuses to start a scenario that
would push the day past 8,000.

## Test matrix

Every scenario has app-side expectations (journal, health events, remote
state, chat received) and YouTube-side expectations (observer, clips). By-eye
items are marked 👁 and asked as a prompt.

| Suite                              | Scenarios                                                                                                                                                                                                                                                                                                                                                                                    | Closes owed acceptance from                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **A. First light**                 | Manual RTMP key, 1080p30, 10 min, stop. Then 720p30, 1080p60, 4K30 (4K gate). YouTube: ingest `good`, resolution and fps match, VOD exists. Clips: no freeze over 1 s, no audio gap over 100 ms, A/V offset under 150 ms.                                                                                                                                                                    | baseline                                           |
| **B. OAuth Go Live**               | Connect YouTube in the lab profile. Go Live dialog: title, description, privacy, thumbnail. Broadcast is created, waits for ingest, goes live, chat attaches. Stop → `complete`, VOD. Second Go Live reuses the stream. App's quota counter vs lab console metrics. Disconnect revokes.                                                                                                      | 083 thumbnail, 094 quota S5/S8, 096                |
| **C. Chat**                        | Viewer bot posts plain text, emoji, a link, a 200-char message, a burst of 10. Each arrives in the app; measure delay. App sends a reply; observer sees it on YouTube. Right-click link opens/copies. Click a row → on stream (`commentHighlight`), 👁 card on YouTube. Viewer deletes a message.                                                                                            | 084 chat send, 074/095 highlight, 151 links        |
| **D. On-stream features**          | Scene switches every 2 min (`sceneApply`). Takeover BRB show/hide. Record while live, then separate source files (157). Mic mute, system audio toggles. Source switch while live (046). Captions from scripted speech (077, 175 if merged). Voice commands and clip marks (140, 068, 097). Auto-highlight voice (060). Buddy reacts to chat and speech (164, 168, 172). 👁 each looks right. | 058, 060, 068, 077, 140, 157, 164, 168, 172        |
| **E. Resilience**                  | End the stream from YouTube Studio while the app is live (👁 owner clicks): app must leave On air (161). Network loss 30 s on the RTMP port (`dnctl`, needs owner sudo once): reconnect, no "On air" over a dead leg. SIGSTOP an **owned** ffmpeg PID 0.5 s and 6 s (087). Quit the app while live: clean teardown, no orphan PIDs.                                                          | 087, 161                                           |
| **F. Long + vertical + scheduled** | 2 h then 4 h marathon (memory slope, encoder speed, bitrate, VOD start/end analysed). Dual orientation: vertical leg on the second key, owner turns on Dual stream in Studio 👁 (no API exists). Scheduled stream: create an event in the app, go live into it.                                                                                                                              | 045, 049-like YouTube path, 061, 166 leak baseline |

Out of this matrix on purpose: Super Chats and memberships (a new channel
cannot get them; the fake providers cover them), Twitch/Kick/X (D7),
camera (one owner-present pass in C4, D6).

## Owner decisions

Each has a recommendation. D1-D3 block L0.

- **D1. Where it runs.** Recommended: the owner's Mac with a virtual lab
  display, attended. Alternative: a dedicated Mac now (plan 166 D1).
- **D2. Visibility.** Recommended: Unlisted for C1-C4, Public from C5 with
  "Automated test" in every title.
- **D3. Quota.** Recommended: the lab Google project for every lab call; the
  bundled client only in the C6 release run (about 300 shared units).
- **D4. Build under test.** Recommended: the latest public release by
  default (what users run); a locally built candidate of main when a
  campaign targets unreleased work. Every report records the version.
- **D5. Microphone.** Recommended: BlackHole with scripted speech, plus one
  owner-voice pass.
- **D6. Camera.** Recommended: one pass with the owner present (C4). No
  unattended camera ever.
- **D7. Other platforms.** Recommended: YouTube only in this plan. Twitch,
  Kick and X test accounts as a follow-up plan with the same harness.
- **D8. Release gate.** Recommended: after 3 green release-suite runs, add
  "20-min live suite green on the candidate" to the `videorc-release`
  skill (L6).

## Slices

### L0 — Hookup and `live:doctor`

**Files:** `scripts/live-lab/hookup.mjs`, `scripts/live-lab/doctor.mjs`,
`scripts/live-lab/lib/config.mjs` + tests, `package.json` scripts
`live:hookup`, `live:doctor`, `docs/live-lab.md` (the owner steps above).

1. `live:hookup`: hidden-input prompts, loopback OAuth consent for the
   broadcaster and viewer roles, writes the config 0600, prints only
   fingerprints. Re-runnable per role (`--role viewer`).
2. `live:doctor` prints PASS/FAIL for: config mode 0600; tokens refresh and
   `channels.list mine=true` returns the expected channel (broadcaster) and
   a different one (viewer); token age under 6 days; both stream keys
   present; lab display present and awake; BlackHole present; `yt-dlp`,
   `ffmpeg` present; `a.rtmps.youtube.com:443` reachable; today's lab quota
   count; build under test version and its TCC grants (3 s screen-only test
   recording analyzed by `recording-analyzer`).

**Done when:** `pnpm live:doctor` is all PASS on the owner's Mac, and each
check fails clearly when broken on purpose (wrong channel, display off,
config 0644).
**STOP if:** the channel account cannot authorize force-ssl in a Testing
project (then D3 needs a new answer).

### L1 — Metrics journal and log retention (plan 166 S1 + S3 steps 1-2)

Build plan 166 S1 (metrics journal, NDJSON every 5 s + per health event,
off by default, `VIDEORC_METRICS_JOURNAL=1`) and S3 steps 1-2 (bounded log
size env, redacted per-session FFmpeg stderr) exactly as written there,
including their done-when checks. Mark them done in plan 166 too.

**Done when:** plan 166 S1 and S3 (steps 1-2) done-when checks pass.
**STOP if:** plan 166 S1's own STOP condition hits (a lock on the encoder
or compositor hot path).

### L2 — Harness core: launch, drive, observe the app, tear down

**Files:** `scripts/live-lab/run.mjs`, `scripts/live-lab/lib/{launch,ui-driver,app-observer,teardown,kill-switch}.mjs` + tests,
`package.json` script `live:run`.

1. **Launch** the build under test through `app-launcher.mjs` with a lab
   profile (`VIDEORC_USER_DATA_DIR`, `VIDEORC_APP_DATA_DIR`,
   `VIDEORC_SECRETS_PATH`, `VIDEORC_RECORDINGS_DIR` under
   `~/videorc-live-lab/profile/`), `VIDEORC_REMOTE_DEBUG_PORT=0`,
   `VIDEORC_METRICS_JOURNAL=1`, `VIDEORC_DISABLE_AUTO_UPDATE=1`, and the lab
   client through `VIDEORC_YOUTUBE_CLIENT_ID` / `_SECRET`. First run seeds
   the lab profile: lab display as Screen, BlackHole as mic, the two keys as
   manual YouTube destinations, remote control on.
2. **UI driver** over CDP: open Go Live, fill title/description/privacy,
   pick destinations, confirm, read the outcome. Use stable `data-testid`
   selectors; add missing ones to the Go Live dialog (the only product edit
   in this slice).
3. **App observer**: tail the journal and health events, census every
   10 s, chat rows received (through the renderer, CDP).
4. **Kill switch**: Ctrl-C in the session, a `~/videorc-live-lab/STOP`
   file, or the owner ending the stream in Studio. Each one stops the
   stream within 10 s and runs teardown.
5. **Teardown**: `streamStop`, wait idle, quit, reap only the launched PID
   and ledger PIDs, assert a clean ledger, collect logs and crash reports.

**Done when:** `pnpm live:run --scenario dry` goes live against a local
RTMP sink (no YouTube) through the clicked dialog, switches a scene, stops,
and leaves a clean ledger; unit tests cover the step engine with fake
sources.

### L3 — Test card and speech rig

**Files:** `scripts/live-lab/card/` (static HTML/JS), `scripts/live-lab/lib/{card-server,speech}.mjs` + tests,
`scripts/live-lab/phrases.json`.

1. Plan 166 S6 dashboard, shown fullscreen on the lab display: run id,
   scenario, step, big millisecond timecode, a moving element, flash +
   click every 10 s in the format `measure-av-sync.mjs` expects, live
   sparklines from the journal. Content allowlist and redaction test as in
   166 S6.
2. Speech: `say -o` renders phrases, the harness plays them to BlackHole at
   scripted times. Voice command phrases come from the parser's own tests,
   so the lab and the code agree on wording. Each played phrase is logged
   with its timestamp, so caption and command latency can be measured.

**Done when:** a 5-min local recording of the card passes
`measure-av-sync` (offset found, under 150 ms) and `recording-analyzer` (no
freeze); a scripted phrase shows up as a caption and a voice command event
in the journal.

### L4 — YouTube observer and viewer bot

**Files:** `scripts/live-lab/lib/{youtube-observer,viewer-bot,clip-puller,quota-ledger}.mjs` + tests (against `fake-youtube-api.mjs`).

1. Observer (broadcaster token), every 2 min while live:
   `liveBroadcasts.list` (lifecycle, privacy), `liveStreams.list`
   (`streamStatus`, `healthStatus`, `configurationIssues`, resolution/fps),
   `videos.list` (`liveStreamingDetails`), `liveChatMessages.list` (to see
   the app's own sent messages land).
2. Viewer bot (viewer token): posts scripted messages and deletes one;
   records send time to measure app-side arrival delay.
3. Clip puller: `yt-dlp` 120 s of the live URL every 15 min, then
   `recording-analyzer` + `measure-av-sync`. Keep analysis JSON. Delete
   media unless it shows an incident; never commit media.
4. Quota ledger: counts every call by documented cost, persists per day,
   refuses over 8,000.

**Done when:** tests against the fake API pass; on the first real run the
observer log fills and the viewer bot's message reaches the app.
**STOP if:** pulling clips of our own public stream is against YouTube's
terms for the channel owner (check first; fall back to observer only).

### L5 — Scenarios and reports

**Files:** `scripts/live-lab/scenarios/{first-light,oauth-golive,chat,features,resilience,marathon,vertical,scheduled,release}.mjs`,
`scripts/live-lab/lib/{verdict,report,redact}.mjs` + tests.

1. Each scenario is steps + expectations from the test matrix. All waits are
   on events with deadlines, never fixed sleeps (AGENTS.md).
2. 👁 steps pause and print one yes/no question; Claude relays it to the
   owner and records the answer in the run.
3. Report: `report.md` + `verdict.json` per run (pass / warn / fail per
   expectation, with evidence pointers), charts for memory, bitrate,
   dropped frames, YouTube health. Thresholds start from plan 166's table,
   report-only.
4. Redaction pass before anything leaves the run folder, fails closed on a
   key-shaped string (reuse `smoke:streaming-secrets` checks).

**Done when:** recorded fixture runs (clean, a dead leg while "On air", a
chat message that never arrives) give the expected verdicts.

### C1-C5 — Campaigns (attended runs, no new code unless a bug is found)

Run in order. Each campaign starts only after the owner says go.

| Campaign | Suites                      | Visibility | Rough length      |
| -------- | --------------------------- | ---------- | ----------------- |
| C1       | A                           | Unlisted   | 1 h               |
| C2       | B, C                        | Unlisted   | 1.5 h             |
| C3       | D                           | Unlisted   | 2 h               |
| C4       | E + camera/owner-voice pass | Unlisted   | 1.5 h             |
| C5       | F                           | Public     | 3-6 h over 2 days |

After each campaign:

1. Every failure: one GitHub issue in `TheOrcDev/videorc`, label
   `live-lab`, with the run report excerpt (redacted). Repeats comment on
   the open issue.
2. Bugs are fixed through the normal plan / PR flow, not inside this plan.
3. If the fake providers can express the bug, the fix PR adds an offline
   smoke case. Note which owed acceptances are now closed and update those
   plans' memory/README entries.

**Done when:** each campaign's suites are green or every red has an issue.

### L6 — Release live suite and handoff to plan 166

1. `live:run --scenario release`: 20 min, Unlisted, on the release
   candidate: first light 1080p30, OAuth Go Live on the **bundled** client
   (about 300 shared units, D3), 5 chat messages both ways, one scene
   switch, one takeover, one comment highlight, stop, VOD check.
2. After 3 green runs on 3 releases, propose (owner decision D8) adding it
   to the `videorc-release` skill as a pre-promotion step.
3. Write the handoff note into plan 166: which of its slices are now done
   (S1, S3 partly, S6, S7) and what remains for unattended runs.

**Done when:** the release suite has run green on one candidate, and plan
166 lists what this plan finished.

## Safety

- Only the lab display is captured. A Focus mode is on during runs. The
  test card shows no paths, emails or account names.
- Secrets live only in `~/.videorc-live-lab/config.json` (0600) and the lab
  profile's secrets file. Nothing secret goes into logs, reports, issues,
  the stream or the repo.
- The lab profile is separate from the owner's real Videorc data; the
  harness never opens the real profile.
- The harness reaps only the PID it launched and ledger PIDs. No `pgrep -f`.
- Network faults (E) install with a deadline and are removed in `finally`
  and by the next `live:doctor`.
- Every title starts with "Automated test".

## Out of scope

- Unattended runs, a dedicated machine, schedules, remote Go Live without
  the dialog (plan 166).
- Twitch, Kick, X (D7, follow-up plan).
- Super Chats, memberships, monetization features.
- Changing any default for real users. The journal and log options stay off
  unless enabled.

## STOP conditions

- Any slice would put a stream key, token, secret or chat identity into a
  log, report, issue, the stream or the repo.
- A lab call would spend the shared Videorc quota outside the C6/L6
  bundled-client run.
- The harness would need to kill a process it did not launch and that is
  not in the owned-process ledger.
- Anything other than the lab display would be captured.
- A run would start without the owner's go in the session.

## Verification summary

| Gate                                                                                                                                                   | Why                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                                                                     | every TS slice                       |
| `pnpm test:scripts`                                                                                                                                    | harness libs, verdicts, redaction    |
| plan 166 S1/S3 gates (`cargo test -p videorc-backend metrics_journal`, clippy, fmt, `smoke:multistream`, `smoke:recording-studio` with the journal on) | L1 must not hurt recording/streaming |
| `pnpm --filter @videorc/desktop test`                                                                                                                  | L2 test ids in the Go Live dialog    |
| `pnpm live:doctor`                                                                                                                                     | L0                                   |
| `pnpm live:run --scenario dry`                                                                                                                         | L2 end to end with no YouTube        |
| C1-C5 reports                                                                                                                                          | the lab works on the real channel    |
| Owner acceptance: watches one C5 VOD and reads its report                                                                                              | it does what this plan says          |

## Model lane note

Per `CLAUDE.md`: L0, L2, L4, L5 are clear implementation → `gpt-5.5` (fit
7-8). L1 follows plan 166's lanes. L3's test card is viewer-facing →
`opus-4.8` (fit 8). Campaigns C1-C5 and L6 are live, public, judgement-heavy
diagnosis → `fable-5` (fit 9-10). Per the owner's "gates at the end"
preference, write and commit L0-L5 first, then run the Rust and e2e gates
once before C1.
