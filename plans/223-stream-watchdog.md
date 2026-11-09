# Plan 223: The stream watchdog: Videorc sees what viewers see

> **Executor instructions**: read `AGENTS.md`, `CLAUDE.md`, the
> `videorc-design` skill (every slice that touches UI), plan 161 (dead
> destinations), plan 218 (frame drops), plan 184 (the cloud) and this whole
> plan first. Then:
> - Work in your own worktree from `origin/main`. The shared checkout is
>   stale and other sessions switch its branches.
> - One PR per phase (A to E). Write and commit every slice of a phase first,
>   then run that phase's gates once (owner rule: gates at the end).
> - Check every UI in light AND dark.
> - Never go live on a real channel unless the owner asks for it in the
>   session (`AGENTS.md`, "Live Tests On YouTube").
> - Never merge the cloud draft PRs (desktop #727, web #85, `videorc-cloud`
>   #1). Phase C and Phase D build on them only after plan 222 says they
>   shipped.
> - Anything under "STOP conditions" means stop and report, not improvise.

> **Drift check (run first)**:
> `git diff --stat d00550ea1..origin/main -- crates/videorc-backend/src/session_audio.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/encoder_bridge.rs crates/videorc-backend/src/capture_health.rs crates/videorc-backend/src/platform_stream_watch.rs crates/videorc-backend/src/viewer_stats.rs crates/videorc-backend/src/live_chat.rs apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/lib/stream-health-attribution.ts apps/desktop/src/renderer/src/lib/session-runtime-notice.ts apps/desktop/src/renderer/src/components/studio/session-panel.tsx apps/desktop/src/renderer/src/components/stream-manager/stats-bar.tsx apps/desktop/src/main/updater.ts`
> Anchors below are symbol names plus the line they had at `d00550ea1`. A
> moved line is fine; re-find the symbol. A changed _behaviour_ (a threshold,
> a health code, a toast key) is a STOP: re-read "What exists" against the
> live code before continuing.

## Status

- **Status**: EXECUTING 2026-11-08. Phase A (A1 to A8), Phase B (B1, the
  desktop half of B2, B3), C3 and C4 (the desktop reads the runner's
  `program` block; Reconnect goes through the runner) and D2 (the desktop
  sends the push) are built on the desktop cloud branch (`plan-184-videorc-
  cloud`, draft #727). See "Progress" at the end. A9 (the Kick live test)
  and D3 (the phone acceptance) wait for the owner.
- **Priority**: P1. Part of the 2026-11-08 "Premium worth paying for" set
  (umbrella plan 221; this is feature 3 of 5).
- **Effort**: L. Five phases. Phase A (the desktop watchdog) is about a week
  of agent work and stands alone. Phases C and D wait for the cloud.
- **Risk**: MEDIUM.
  - The watchdog reads live signals that already exist; it adds no new
    capture, no new encoder and nothing drawn on the stream. The risk is
    false alarms: an alert that cries wolf gets switched off, and then the
    real one is missed. Every check below has guards and a debounce for
    that reason.
  - A system notification during a stream is a new kind of interruption.
    Repeat rules are strict.
  - The cloud and phone phases depend on draft code 485 commits behind
    main.
- **Planned at**: desktop `origin/main` `d00550ea1` (fetched 2026-11-08);
  cloud desktop branch `origin/plan-184-videorc-cloud` `0e5bade39`;
  `videorc-cloud` `phase-1-runner` `b0557c93`; web worktree
  `videorcweb-wt-185` detached at `5a75d03d`.
- **Route**: Orchestrator (fit 10) owns the order and the split.
  - Phase A backend (the checks, the alert store, thresholds, the leg wrap):
    Implementation (fit 9) on `fable-5.1`. Live behaviour across audio,
    encoder, platform polling and the contract; a mistake alarms every
    streamer.
  - Phase A UI (the alert card, the Session panel row, the Stream Manager
    chip, the Livestream page section, the copy): UI/Product Design (fit 9)
    on `opus-5.5`, with `videorc-design`.
  - Phase A smokes, the phrase tables of Phase B, the web routes of Phase D:
    Implementation (fit 8) on `gpt-6.1-sol`; a `fable-5.1` security pass on
    every web route that takes a push subscription or sends a push.
  - Phase C runner checks: Implementation (fit 9) on `fable-5.1`.
  - One Review pass (fit 9) per phase before it ships.
- **Depends on**: plan 161 (shipped: `reconnecting` / `warning` /
  `failed` destination states and the YouTube ingest poll), plan 218
  (shipped: `streamDelivery`, `stream-bitrate-floor`, `stream-leg-overflow`),
  issue 1064 (shipped: the `microphone-silent` watchdog and the
  `audio.levels` event). Phase C depends on plan 222 (the cloud relay
  shipping plan 184 Phase 1). Phase D depends on plan 184's W6 `/live`
  page (built, draft) and on a web session for the desktop account (exists).
  Phase D absorbs plan 184 X7 ("alerts on the host's phone").
- **Companion plans**: 222 (the cloud), 224 (guests), 225 (viewers). Plan
  185 (private) holds the tier ladder. No number about money is in this
  file.

## The owner's ask (2026-11-08)

> "plan out thoroughly first 5 things you recommended, it can go from our
> cloud branch that we already started"

Feature 3 of the five: **a watchdog that sees what viewers see**. The
nightmare to kill, in the owner's framing of the problem: forty minutes live
with a muted microphone, or one platform silently offline while the Studio
says On air.

## What a streamer gets

In one line: **while you're live, Videorc notices within seconds the things
viewers see and you don't, tells you where you'll see it (the Studio, the
Stream Manager, a system notification, your phone), and offers one tap to
fix it.**

1. **You muted to cough and forgot.** Thirty seconds later the Session
   panel says "Your microphone is muted on the livestream · 0:30", with
   **Unmute** and **I meant to**. The Stream Manager shows the same card.
   If Videorc isn't the front window, a system notification says it too.
   Nothing else interrupts you. If you stay muted, it reminds you every
   five minutes until you click one of the two buttons.
2. **Nothing is leaving the program.** The wrong microphone, a dead
   interface, a muted soundboard: "Viewers hear nothing" after 20 seconds
   of a silent master mix, whatever the cause.
3. **The picture stopped.** Not because your editor sat still for ten
   minutes (that is fine, and the watchdog knows the difference), but
   because the pipeline stopped producing frames: "The picture has stopped"
   within five seconds.
4. **One platform went dark.** Plan 161 already says "YouTube is
   reconnecting". The watchdog adds the clock and the escalation: after 20
   seconds of that, a system notification, and the plain truth about what
   can be done. For cloud shows, **Reconnect YouTube** works with one tap.
5. **YouTube says your stream has no audio.** The platform's own health
   report, read with the same API call Videorc already makes every minute,
   reaches you as a sentence, not as a code.
6. **Chat says "no sound??", "cant hear u", "sin audio".** Two different
   people in ninety seconds and the watchdog tells you, in any of fourteen
   languages, with their messages. Buddy never answers them for you.
7. **Afterwards**, the Library's session details list every alert, when it
   opened and when it cleared.
8. **With Premium**: the same checks run on Videorc's servers for a cloud
   show, on the exact picture and sound that leave for the platforms. The
   alert reaches your phone as a push notification from videorc.com/live.
   AI reads chat for trouble when the phrase list isn't sure.

## Words we use

| Word | Meaning |
| --- | --- |
| **Watchdog** | The feature: the checks, the alerts and where they show. UI copy says "Watchdog" only on its settings section; alerts say what is wrong. |
| **Check** | One rule that watches one signal (for example "mic muted while live"). Each has a threshold, guards and a fix. |
| **Alert** | An open problem the watchdog reports. It opens, may be acknowledged or snoozed, and clears when the signal recovers. |
| **Fix** | The one-tap action on an alert: Unmute, End takeover, Switch scene, Reconnect, Open Audio. Fixes reuse existing intents; the watchdog adds no new control of its own. |
| **Acknowledge** | "I saw it." Repeats stop. The alert stays until it clears. |
| **Snooze** | "Not now." The alert hides for 10 minutes, or for the rest of this stream ("I meant to"). |
| **Program** | The final picture and sound the platforms get (plan 184's word). The watchdog judges the program, never the preview. |
| **Source** | Where a check runs: this computer, Videorc Cloud (the runner), or a platform's API. Shown on the alert when it isn't this computer. |

## What exists (facts)

Desktop `origin/main` `d00550ea1`. `rec` = `crates/videorc-backend/src/recording.rs`,
`sa` = `crates/videorc-backend/src/session_audio.rs`,
`eb` = `crates/videorc-backend/src/encoder_bridge.rs`,
`renderer` = `apps/desktop/src/renderer/src`.

### Microphone: mute, silence, levels

- **Mute is a renderer setting applied as zero gain, not a backend state.**
  `protocol.rs:1688` `pub microphone_muted: bool` in `AudioSettings`;
  `audio.rs:957` `let gain = if settings.muted { 0.0 }`. The toggle is the
  RPC `audio.processing.update` (`main.rs:11283`, params `protocol.rs:1750`),
  whose result echoes `microphone_muted` and `confirmed_microphone_muted`
  (`protocol.rs:1771, 1777`; set at `rec:3517, 3685`). No status or event
  field carries the mute to the renderer; the renderer owns it and publishes
  it to the backend through `agent.surface.publish`
  (`renderer/lib/agent-surface.ts:197`, read at `agent_look.rs:283`).
- **A silence watchdog exists for digital silence (issue 1064).**
  `MicrophoneSilenceWatchdog` (`sa:1505`), floor `MICROPHONE_SILENCE_FLOOR =
  1.0e-4` (−80 dBFS, `sa:1470`), hold 3 s (`sa:1473`), recovery 500 ms
  (`sa:1474`). It reads the raw captured chunk before gain and mute
  (`sa:6166`) and skips a muted microphone (`sa:6165` `&& !settings.load().muted`).
  Health codes `microphone-silent` and `microphone-signal-recovered`
  (`rec:11365-11366`). A second, older check, `mic-silent`, fires once 10 s
  into a recording when the raw peak stays under 0.001
  (`rec:173-174, 11157`).
- **Its notice already speaks of the livestream.**
  `renderer/lib/session-runtime-notice.ts:16` `MICROPHONE_SILENT_CODE` and
  `:57-66`: "Your microphone is silent on the livestream" while live,
  "Microphone was silent during the livestream" after. It renders inside
  `SessionNotices` (`components/studio/session-panel.tsx:401`) as a
  `SessionRuntimeAlert`.
- **Nothing warns about an intentional mute.** `studio-health.ts`,
  `health-checks.ts`, `studio-toasts.ts` and `session-runtime-notice.ts` have
  no `muted` match. The only signs are passive: the Microphone row's "Muted"
  chip (`renderer/lib/source-status.ts:227`), the dimmed sliver with
  `aria-label="Microphone muted"` (`components/studio/session-mic-sliver.tsx:59`),
  and the agent sentence "The microphone is muted." (`agent_look.rs:285`).
  The meter words are "Receiving", "Muted", "Silent", "No signal"
  (`renderer/lib/state-labels.ts:212-216`).
- **Levels are on the wire 20 times a second.** Event `audio.levels`
  (`protocol.rs:2026` `AudioLevelsEvent`; contract
  `apps/desktop/src/shared/backend-rpc-contract.ts:4101-4115`), every 50 ms
  (`rec:166` `AUDIO_LEVELS_INTERVAL`), sent from `rec:10973` during a session.
  Readings `{peakDb, rmsDb}` for `microphone`, `systemAudio`, `sounds` and
  `master` ("The mix written to the recording and the stream"), plus
  `masterClippedSamples` and `microphoneSilent` (sent only while true).
  Readings are taken after gain and mute. **Nothing watches whether the
  master mix is silent.** NOT FOUND on main.
- **A speech gate exists for captions and Buddy.** `captions.rs:5729`
  `pcm_has_voice`: 50 ms windows (`:5699`), RMS floor 0.005623, about
  −45 dBFS (`:5701`). Buddy's dead-air check builds on it: `VoiceActivity`
  (`cohost.rs:2020`), `dead_air_due` (`cohost_ack.rs:917`),
  `DEAD_AIR_SILENCE` 20 s (`:39`). Clean cut's offline detector uses a
  −45 dBFS floor and "speech median minus 18 dB" (`clean_cut/rules.rs:26-28`,
  `clean_cut/silence.rs:270`), on a WAV after the recording.
- **Takeovers mute the microphone by design.**
  `renderer/lib/screen-takeover-microphone.ts:26-27` mutes when a takeover
  becomes active and records `{ priorMicrophoneMuted }`; `:35` restores it.
  Wiring: `commitActiveScreen` (`hooks/use-studio.tsx:4456-4495`). At launch
  the backend retires a takeover left active by the previous run
  (`main.rs:571` `retire_active_stream_screen_at_launch`). There is no
  built-in "Be right back": a takeover is an imported image; the active one
  is `activeScreenId` (`storage.rs:7172`), RPCs `screens.activate`,
  `screens.clear`, `screens.active` (`main.rs:5832-5833, 6056`), event
  `screens.active.changed` (`main.rs:8901`).

### The picture and the pipeline

- **A static screen is not a stall.** `capture_health.rs` watches 2 s rate
  windows for `camera-delivery`, `screen-delivery` and `compositor-render`
  (`:158-160`): degraded below 0.6× target (`:29`), a producer stall below
  1 fps (`:37`), three windows to change state (`:66, 68`). Its own comment
  (`:16-20`) says `screen-delivery` collapses when callbacks, publications
  and fresh serves all collapse, which is what ScreenCaptureKit does for a
  still screen. The compositor's freeze signal is `held_serves` far above
  `fresh_serves` (`compositor.rs:1477-1484`, `protocol.rs:3391`).
  Transitions go to `capture_recovery` (`compositor.rs:4749`).
- **The encoder bridge knows when the stream stops moving.**
  `stream-output-stalled` / `stream-output-resumed` (`eb:9108`) at
  `STREAM_OUTPUT_STALL_NOTICE_THRESHOLD` 2 s (`eb:134`);
  `STREAM_OUTPUT_WEDGED_TIMEOUT` (`eb:131`) and `OUTPUT_WEDGED_TIMEOUT` 30 s
  (`eb:118`); `encoder_bridge_over_budget_escalation` fails only after 30 s
  without progress (`eb:1331`). `stream-delivery-degraded` holds while more
  than 10 % of frames were skipped over 30 s and clears under 5 %
  (`eb:8883-8891`); `stream-bitrate-floor` warns once a minute (`eb:9002`).
  `audio-output-stalled` starts 250 ms behind with 15 s forgiveness
  (`sa:2817, 2824`; code at `rec:11307`).
- **No black-frame or frozen-picture detector exists on the desktop.**
  `freezedetect` appears only in the offline quality gate and repair
  (`rec:1125`, `repair.rs:344`). NOT FOUND live.
- **macOS record+stream streams from a separate aux compositor leg**
  ([[videorc-aux-leg-layer-trap]]). Any sample of "what the stream shows"
  must come from the stream's leg, never the recording's.
- **The debug stall seam.** `VIDEORC_TEST_VT_FIFO_PAUSE_MS`
  (`rec:174` `TRANSIENT_FIFO_TEST_PAUSE_MS_ENV`, macOS only) pauses the
  VideoToolbox FIFO; `pnpm smoke:output-stall`
  (`scripts/smoke-output-stall-app.mjs:1-22`) uses it with a synthetic tone
  microphone (`VIDEORC_CAPTION_CONTRACT_TEST` + `VIDEORC_LIVE_SOURCE_SWITCH_TEST`).

### Destinations and platform truth (plan 161, as built)

- Per-destination states: `connecting | live | reconnecting | warning |
  failed | …` (`StreamTargetState::Reconnecting` in `streaming.rs`; contract
  `'reconnecting'`). FFmpeg legs are read by `StreamLegMonitor` (`rec:28228`)
  from `-loglevel level+info` lines. A `Failed` destination is terminal:
  "FFmpeg reconnecting the socket never revives it" (plan 161, As built).
  **No RPC adds or restarts one destination while live.** NOT FOUND on
  `main.rs` (`streamTargets.add|restart|reconnect`). Plan 046 (change sources
  during recording and streaming) is listed in `plans/README.md:1475`; its
  state is not re-checked here.
- Health codes: `stream-target-not-receiving`, `-reconnecting`, `-resumed`,
  `-reconnected` (`rec:27755-27758`), `stream-output-failed` (`rec:27769`),
  `stream-leg-overflow` (`rec:27359`).
- **YouTube ingest poll**: `platform_stream_watch.rs` reads
  `items[0].status.streamStatus` and `healthStatus.status` (`:81-113`), every
  60 s (`YOUTUBE_INGEST_POLL_INTERVAL`, `:23`), first poll after 45 s (`:32`),
  the broadcast's `lifeCycleStatus` and `boundStreamId` every fifth poll
  (`:26, 117-145`). `active`+`noData`, `revoked`, `error`, `inactive`,
  `ready`, `created` → NotReceiving; a `complete` or `revoked` broadcast →
  Ended at once (`:72`). `PlatformLiveness::observe` (`:59`) demotes only
  after one Receiving and then two answers in a row
  (`NOT_RECEIVING_ANSWERS_BEFORE_WARNING`, `:29`). **`configurationIssues`
  is not read.** Quota: `youtube_reads_allowed` (`:221`) =
  `youtube_quota::paused_until().is_none() && budget_refuses(BudgetCall::Viewers).is_none()`;
  reads go through `send_attempt` (`:168`) and a 403 QuotaExhausted calls
  `record_quota_exhausted` (`:209`).
- **Viewer polls**: `viewer_stats.rs` every 60 s (`VIEWER_SAMPLE_INTERVAL`,
  `:31`; YouTube at `youtube_quota::viewer_sample_interval`, 120 s or more
  under `ShedExtras`, `:778-790`). Twitch: empty `data` is
  `CountFetch::Offline` (`:92, 487, 495`) → "Twitch shows the channel
  offline" (`twitch_platform_answer`, `:502`) → `observe_platform_stream`
  (`:661`, `rec:27671`). Kick: a count only when `is_live`, else `None`
  (`:263-272`), no liveness answer. X: `fetch_x_count` (`:553`) through
  `x_live::fetch_broadcast_viewer_count`, no liveness answer. Facebook: NOT
  FOUND in `viewer_stats.rs`.
- **Renderer notices**: `renderer/lib/stream-target-notices.ts` keys every
  notice for one destination as `stream-target:${targetId}` (`:52`):
  "Streaming to {label} stopped" (`:60`), "{label} is reconnecting" (`:69`,
  "Viewers there see nothing until it's back."), "{label} isn't receiving
  your stream" (`:79`, "Videorc is still sending it. Check the platform's
  live dashboard."), "{label} is back" (`:88`). Called from
  `hooks/use-studio.tsx:4810-4811`. Toasts: `studio-toasts.ts:65-75`
  `streamTargetToast`, id `stream-target:${id}`; `notifyOnce`
  (`notify-once.ts:54`) reuses an id within 30 s (`:10`); durations 4 s,
  8 s with a description, until closed with an action (`toast.ts:108`).
  **No snooze, acknowledge or "don't show again" exists anywhere.** NOT
  FOUND (the only `acknowledge` hits are OAuth and IPC plumbing).

### Where health shows today

- **Studio**: the transport row (Record, Go Live…, the clock and status
  pill) sits at the top of the inspector (`components/tabs/studio-tab.tsx:214-240`),
  then `<aside aria-label="Session inspector">` (`:243`) with `SessionPanel`
  (`:244`), Chat, Audio, Sources, Takeover. Nothing sits above the preview;
  the comment at `:201-203` says "never as a yellow top banner". Runtime
  notices render in `SessionNotices` (`session-panel.tsx:401`). The one live
  "Stream" fact is `LiveStreamHealthRow` (`session-panel.tsx:564-583`,
  `data-testid="session-stream-health"`, label "Stream"), from
  `streamHealthFact` (`renderer/lib/live-session-view.ts:74`): "Healthy" (good),
  the earliest failing stage (warn), "Checking…" (neutral). Clicking it opens
  Health. Destinations: `LiveDestinationRows` (`session-panel.tsx:507`), "N of
  M on air".
- **Stage ranking** lives in `renderer/lib/stream-health-attribution.ts`
  `classifyStreamHealthAttribution` (`:191-262`): device → audio → choppy
  (`streamDelivery.degraded`, `:219`) → uplink (`:302-321`) → capture →
  render → encoder → fallback → network (a target failed, warning or
  reconnecting, `:323`) → preview → healthy / unknown. Labels in
  `liveProblemLabel` (`:21-48`): "Capture device lost", "Audio dropping",
  "Stream skipping frames", "Connection too slow", "Capture running slow",
  "Rendering slow", "Encoder dropping frames", "Encoder fallback", "Delivery
  degraded", "Preview degraded", "Healthy", "Checking…".
- **Stream Manager**: no stream health stat on main. `StatId` is `'session'
  | 'viewers' | 'followers' | 'supporters' | 'tips' | 'chat'`
  (`renderer/lib/stream-manager-stats.ts:23`). The live chip is `SessionChip`
  (`components/stream-manager/stats-bar.tsx:59-67`,
  `<Badge data-testid="session-on-air" variant="live">ON AIR</Badge>`).
  Destination failures appear only as Activity rows "Destination failed" and
  "Back on air" (`renderer/lib/stream-activity.ts:457-469`, from
  `dashboard.destinationEvents`, `stream-manager.tsx:679`). (The cloud branch
  adds a `healthReading` with "Cloud · 6 Mbps" and "Be right back · 28 min
  left", `stream-manager-stats.ts:293-322` at `0e5bade39`; main has none.)
- **Livestream page**: `StreamFailureBanner` "Some destinations aren’t on
  air" (`components/tabs/streaming-tab.tsx:429-495`, rendered at `:278`), with
  "End livestream" and "Continue streaming"; its `dismissedKey` returns when
  the problem set changes (`:212-220`).
- **Health page**: `renderer/lib/health-checks.ts` `HealthCheckId` (`:29`):
  recording, slowdown, encoder, rendering, sources, camera, screen, preview,
  preview-speed, preview-path, destinations, memory, file-repair;
  `healthVerdict` (`:521`). It is used only on Health
  (`components/tabs/diagnostics-tab.tsx:139`). Health's "Log of this
  recording" (`diagnostics-tab.tsx:345-371`) lists session logs, which mirror
  health events.
- **Health events** are persisted: `emit_health_event(state, session_id,
  level, code, message)` (`rec:28603`) redacts stream URLs, writes
  `health_events` (`storage.rs:4764`, table at `:8060`), mirrors into
  `add_session_log` and emits `"health.event"` (`:28626`). RPC
  `sessions.healthEvents.list` (`main.rs:11906` → `list_health_events_page`,
  `storage.rs:4717`). TS `HealthEvent` (`apps/desktop/src/shared/backend.ts:3954`);
  the listener keeps the last 40 (`use-studio.tsx:8156`). **No UI lists past
  health events as such.** NOT FOUND.
- **System notifications**: exactly one. `apps/desktop/src/main/updater.ts:342-343`
  `if (notice && Notification.isSupported()) { new Notification({ ...notice,
  silent: true }).show() }`, copy "Videorc {version} is ready" / "Restart
  Videorc to finish updating, or it installs the next time you quit."
  (`updater-status.ts:127-135`), suppressed while recording or on air.
  `app.setAppUserModelId` is NOT FOUND in `apps/desktop/src/main`.
- **The post-stream report is Buddy's.** "Stream report"
  (`components/buddy-report-card.tsx:126`) lists what Buddy caught
  (`renderer/lib/buddy-report-view.ts:392-413`: Questions caught, Answered on
  air, Replied, Missed, Flags, Promises, First-timers, On screen), from
  `cohost.report.get` / `cohost.report.latest` and `cohost.report.saved`
  (`hooks/use-buddy-report.ts:55, 81-82`; `main.rs:10584, 10604`), shown on
  Buddy → Reports (`buddy-tab.tsx:174`) and from the Library row menu
  (`library-tab.tsx:1438`). It holds no health or destination data
  (`CohostSessionReport`, `backend.ts:7595`).
- **Remote intents** already exist for every fix this plan offers
  (`docs/remote-control.md:102-107, 114-115`): `micMute` / `micUnmute` /
  `micToggle`, `sceneApply {sceneId?, screenId?, layoutPreset?}`,
  `takeoverShow {assetId}` ("show a takeover image (BRB etc.)"),
  `takeoverHide`, `streamStart` / `streamStop`, `windowFront {window}`.
  They run through the renderer's intent executor, the same code as the
  buttons.

### Chat

- `LiveChatMessage` (`backend.ts:6185`): `platform`, `targetId?`,
  `sessionId`, `authorId?`, `authorName`, `authorBadges`,
  `authorAffiliation?`, text and `receivedAt`. **No chat-text keyword
  matching exists.** `chat-notice.ts:13` only checks the provider type;
  `cohost_auto_chat.rs:232` only checks whether a reply contains the
  author's name. Keyword grammar exists only for the streamer's own speech
  (`cohost_command.rs:1-30`, wake word "buddy"). No language detection. NOT
  FOUND.
- **Buddy's posting gate**: `cohost::send_approved` (`cohost.rs:8075`) is the
  only path from Buddy to chat, reached only from `approve_utterance`
  (`:8332`) after the streamer's click. Modes at `cohost_auto_chat.rs:7-14`
  (off / bubble never sends / suggest = cards). `buddy_say` only bubbles
  (`agent_chat.rs:11-13`).
- **AI gateway**: `/api/ai/cohost/tick` (`videorc_api.rs:27`), `/spotlight`
  (`:33`), `/greet` (`:38`), `/command` (`:49`), `/api/ai/buddy/act` (`:53`).
  Premium gate `premium_entitled()` → `FeatureId::LiveCohost`
  (`cohost.rs:11085-11090`).
- **Chat sources**: YouTube polls `liveChatMessages` (5 units a call);
  Twitch EventSub; Kick and X through the web relay (plan 184, What exists).

### Entitlements and the wire

- Shipped desktops read `tier: enumSchema(['basic', 'premium', 'developer'])`
  (`backend-rpc-contract.ts:845`) and `isPremium: boolean` (`backend.ts:4132,
  4239`). The renderer's lock helpers: `renderer/lib/lock-view.ts:43`,
  `entitlement-ui.ts:198`, `premium-upgrade.ts`.
- New status or event fields must be added to
  `apps/desktop/src/shared/backend-rpc-contract.ts` or main retires that
  pump ([[videorc-strict-contract-new-status-field-trap]]). A Rust `Option`
  on the wire needs `skip_serializing_if` ([[videorc-serde-null-contract-trap]]).
- The renderer's eager gzip ceiling is 475,000 bytes
  ([[videorc-renderer-budget-gzip-drift]]). Phrase tables for fourteen
  languages go in the backend, not the renderer.

### The cloud (draft, never merged)

- **Runner state frame** (`videorc-cloud` `b0557c93`,
  `crates/protocol/src/control.rs`): `ShowState` (`:448`) `{phase,
  endReason?, hold, liveSeconds, feeds, legs, desktopConnected,
  destinationsSet, restarts, holdImageSet}`; `FeedState` (`:403`)
  `{orientation, connected, kbps}`; `LegState` (`:433`) `{id, platform,
  label, orientation, state, since, error?}`; `LegPhase` (`:411`)
  connecting|live|reconnecting|failed|ended. Sent on change (polled every
  100 ms, `runner.rs:26`) and at least every 2 s (`control.rs:15`).
- **Feed loss**: `feed_lost_ms: 1500` (`crates/runner/src/switcher.rs:34`),
  freeze 1000 ms, fade 300 ms, 1000 ms steady to come back. The decoder's
  `-timeout` / `-rw_timeout` are 5 s (`feed.rs:133, 135`). **kbps** every 2 s
  from MediaMTX `bytes_received` (`runner.rs:28, 273-307`).
- **Leg health** (`crates/runner/src/fanout.rs`): exit-based. `live` after
  2 s with bytes written (`LEG_LIVE_AFTER`, `:38`); failure = child exit,
  queue overflow or key-proxy error; backoff 1→30 s (`:33-34`); `failed`
  after 20 failures in a row (`:36, 517`); 30 s of running resets the count
  (`:40`). A per-leg `restarts` counter exists (`:477`) but is not in the
  frame.
- **The runner judges no content.** `silencedetect`, `blackdetect`,
  `freezedetect`, `ebur128`, `astats`: NOT FOUND in runner code.
  `silent_frames` in `engine.rs:86, 386` counts PCM-ring underruns, logged
  every 10 s (`:409-427`). The runner does decode the feed to PCM and frames
  (that is how it switches to the hold), so the program is available to
  measure.
- **Node agent heartbeats** carry only `{showId, phase, startedAt?}` per
  show (`crates/protocol/src/agent_api.rs:229`), every 10 s
  (`node-agent/src/web.rs:19, 72`). No alert, webhook, email or push code
  exists. NOT FOUND.
- **Desktop cloud code** (`origin/plan-184-videorc-cloud` `0e5bade39`):
  event `cloud.state` (`cloud_show.rs:54`), payload `CloudStatus` (`:305`)
  with `legs: Vec<StreamTargetRuntime>`, `feeds`, `hold?`, `restart?`;
  `runner_leg_to_runtime` (`:905-921`); `apply_cloud_leg_states`
  (`recording.rs:22589`) copies state and message onto matching target ids.
  `cloud-view.ts:93` "…restarted your show. Your platforms reconnect in a few
  seconds." Hold choices `[300, 900, 1800, 3600]`, default 1800
  (`cloud_show.rs:58-59`).
- **The `/live` page exists** (web `5a75d03d`, `app/live/page.tsx`, 142
  lines): "The Live page (plan 184 W6): what the web knows about the account's
  cloud show, and End stream … in Phase 3 it grows into the phone page",
  re-reads every 10 s. `public/site.webmanifest` already has `"display":
  "standalone"` and 192/512 icons. No service worker, no push code, no
  `web-push` dependency. `resend` is a dependency (`package.json:70`).

## Outside facts (checked 2026-11-08)

- **YouTube `liveStreams` status**
  ([liveStreams](https://developers.google.com/youtube/v3/live/docs/liveStreams)):
  `status.streamStatus` ∈ `active | created | error | inactive | ready`;
  `status.healthStatus.status` ∈ `good | ok | bad | noData` ("`bad`: The
  stream has some issues for which the severity is `error`");
  `healthStatus.lastUpdateTimeSeconds`;
  `healthStatus.configurationIssues[]` with `type`, `severity` (`info |
  warning | error`; "`error`: The video cannot be broadcast to viewers"),
  `reason` and `description` ("Where possible, it also explains how to fix
  the problem"). Issue types include `noAudioStream` ("No audio"),
  `noVideoStream` ("No video"), `bitrateLow` and `videoIngestionStarved`
  ("Video output low"), `frameRateHigh`, `gopSizeLong`, `audioCodec`,
  `videoResolutionUnsupported`. The page assigns no severity per type.
- **YouTube quota**
  ([quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)):
  `liveStreams.list` 1 unit, `liveBroadcasts.list` 1, `liveChatMessages.list`
  5, `videos.list` 1; 10,000 units a day, reset at midnight Pacific. Reading
  `configurationIssues` costs nothing extra: it rides the `part=status` call
  the watch already makes.
- **Twitch Helix** has no ingest-health endpoint
  ([API reference](https://dev.twitch.tv/docs/api/reference/)): the reference
  index lists Get Streams, Get Stream Key, Create Stream Marker and nothing
  about ingest. Liveness is Get Streams returning the channel or not (plan
  161 S4, `viewer_stats.rs:487`).
- **Kick public API** ([livestreams](https://docs.kick.com/apis/livestreams)):
  `GET /public/v2/livestreams` lists "active livestreams" only (`id`,
  `title`, `started_at`, `viewer_count`, `broadcaster_user`, `channel`),
  `GET /public/v1/users/livestreams` by `user_id`. No bitrate, health or
  framerate field. Liveness is "present in the list". The current Kick
  viewer poll reads an `is_live` field (`viewer_stats.rs:263-272`); how
  quickly it flips after the ingest drops is UNVERIFIED.
- **X Livestream API** ([typical workflow](https://docs.x.com/livestream-api/typical-workflow),
  [introduction](https://docs.x.com/livestream-api/introduction)): a source's
  `is_stream_active` "becomes `true` within a few seconds" after the encoder
  starts; "Poll `GET /2/broadcasts/:id` for viewer counts, thumbnails,
  state"; states `RUNNING` and `ENDED`; "video must arrive within 5 minutes
  of going live". No polling interval or rate limit is given (UNVERIFIED).
  Videorc already polls this route for viewer counts
  (`x_live::fetch_broadcast_viewer_count`) and moved to the `/2/broadcasts`
  routes in 0.20.3 ([[videorc-x-livestream-api-migration]]).
- **Facebook Live Video API**
  ([Broadcasting guide](https://developers.facebook.com/documentation/live-video-api/guides/streaming)):
  `GET /<LIVE_VIDEO_ID>?fields=ingest_streams` returns per stream
  `stream_health { video_bitrate, audio_bitrate, video_framerate,
  video_gop_size, video_height, video_width }`; "Stream health data refreshes
  every 2 seconds, so limit queries to no more than once every 2 seconds";
  "A stream timeout will be detected and reported after 4 seconds of no data
  being received". Needs a token with `publish_video`. Facebook is not a
  viewer-poll platform on main; this is Phase E only.
- **Web Push on iPhone** ([WebKit, 2023](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)):
  "with iOS and iPadOS 16.4, we are adding support for Web Push to Home
  Screen web apps"; the manifest's `display` must be `standalone` or
  `fullscreen`; permission must be asked "in response to direct user
  interaction"; delivery is through Apple's push service, no Developer
  Program membership needed; the Badging API works for installed web apps.
  The standard Push API needs an active service worker
  ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API))
  and, with `applicationServerKey` set, every message "must use the VAPID
  authentication scheme, and include a JWT signed with the corresponding
  private key" ([MDN subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe));
  Chrome and Edge require `userVisibleOnly: true`.
- **Electron notifications**
  ([tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)):
  main-process notifications use `new Notification({...}).show()`; on Windows
  "your Electron app needs to have a Start Menu shortcut with an
  AppUserModelID", and "During development, you may have to call
  `app.setAppUserModelId()` yourself"; on macOS "your application will need
  to be code-signed in order for notification events to emit correctly".

## Decisions (⚑ = owner may override)

### D1. The watchdog judges the program, never the preview, and never pixels alone

- Every check reads what leaves for the platforms: the master mix the
  `audio.levels` sampler measures ("the mix written to the recording and the
  stream"), the stream encoder's progress, the destination legs, and the
  platforms' own answers. The preview is a window; viewers don't see it.
- A still picture is never an alert by itself. Coding streamers show an
  editor for minutes (`capture_health.rs:16-20` names the ScreenCaptureKit
  behaviour). "Picture stopped" fires only from frame progress: the stream
  encoder received no new frame (`stream-output-stalled` holding) or the
  compositor itself stopped rendering (`compositor-render` under 1 fps).
  Pixel stillness may only sharpen a stall alert's detail ("and the screen
  hasn't changed either"), never open one.

### D2. One alert model, four surfaces, one home for each control

- The backend owns the alerts: it opens, repeats, acknowledges, snoozes
  and clears them, and persists every transition as a health event. The
  renderer draws them. A hidden or throttled renderer never silences a
  check.
- Surfaces: (1) the Studio's Session panel, inside `SessionNotices`, where
  "Your microphone is silent on the livestream" already lives, and the
  "Stream" fact row (`LiveStreamHealthRow`) names the top open alert;
  (2) the Stream Manager's stats bar, as an alert chip beside ON AIR while
  an alert is open, with the same card on hover; (3) a system notification
  when Videorc isn't the front window, or when a critical alert has stayed
  open 60 s; (4) a push to the phone (Phase D, Premium).
- The same `WatchdogAlertCard` renders in (1) and (2). Its buttons are the
  fix and the acknowledgement. The fix reuses an existing intent
  (`micUnmute`, `takeoverHide`, `sceneApply`, `windowFront`) or an existing
  RPC; the watchdog adds **no new control next to Record or Go Live**, and
  no new control that exists anywhere else. Settings live on the Livestream
  page with the other stream settings (D7).

### D3. Severity decides the interruption

| Severity | Opens with | System notification | Repeat while open | Phone push |
| --- | --- | --- | --- | --- |
| **critical** (viewers get nothing: mic muted or silent, program silent, black, stopped picture, every destination down) | the card, a toast with the fix | at once | every 5 min until acknowledged | yes |
| **warning** (one destination down, a platform reports a problem, chat says trouble, at the bitrate floor) | the card, a toast | after 60 s open | every 10 min until acknowledged | yes |
| **notice** (mic muted while music plays, a long Be right back, Still there?) | the card | never | never | never |

- A toast's type colours its icon only ([[feedback-toasts-never-tinted]]).
  Alert toasts carry the fix as their action, so they stay until the
  clearing toast (success, "Microphone unmuted") replaces them under the
  same key `watchdog:<check>`.
- Acknowledge stops repeats; the card stays until the signal clears.
  Snooze hides the card for 10 minutes; "I meant to" hides it for the rest
  of the stream and tells the check so (a muted mic stays muted by choice).
- While a session is not live (recording only), the watchdog runs only the
  checks that already exist for recordings (the 1064 silence watchdog). The
  owner may extend it to recordings later ⚑ (recommended: not in v1; a
  recording can be re-done, a stream can't).

### D4. Thresholds and guards (the catalogue is the spec)

The catalogue below is binding. Thresholds that the owner may tune are
marked. Dev builds accept `VIDEORC_WATCHDOG_<CHECK>_AFTER_MS` overrides
for smokes; packaged builds refuse them, like every other dev-only
environment switch.

### D5. The split ⚑

- **Free, for every stream, direct or cloud**: every check that runs on this
  computer (the whole Phase A catalogue), the Studio and Stream Manager
  cards, system notifications, every one-tap fix the desktop can perform,
  the local alert history, and the cheap chat phrase match (Phase B1).
- **Premium**: the checks that run on Videorc's servers for a cloud show
  (Phase C; they see the exact program that leaves our servers, and
  "Reconnect {platform}" becomes a real one-tap fix because the runner owns
  the legs), the phone push (Phase D; a server holds the subscriptions and
  sends), and AI reading of chat when the phrase list isn't sure (Phase B2).
- Why: the owner's rule is that Premium sells only server-backed and AI
  features. Everything the desktop can see on its own stays free; that is
  what keeps "multistreaming stays free" honest and keeps trust. The free
  watchdog is also the best advertisement for the paid one: its card says
  "Source: this computer", and the Livestream page's Watchdog section says
  what the cloud adds.
- Recommended answer: as above. The alternative, Premium-only phone push
  plus everything else free, is the same list.

### D6. Chat is a signal for the streamer, never a trigger for Buddy

- Phase B matches chat text with phrase tables in fourteen languages,
  cheaply, in the backend. Two different people complaining about the same
  thing (sound, picture, lag) within 90 s open a warning. One person opens
  nothing (people joke, and "can you hear me?" is a question, not a report).
- Premium adds an AI read: when at least one candidate matched in the last
  two minutes, the last 20 messages (text and platform only) go to a typed
  question on the gateway, and a confident "yes, audio" opens the alert even
  from one complainer. Rate: at most one call every 2 minutes per stream.
- Buddy never posts about it. If Buddy is on, its bubble may say "Chat says
  they can't hear you." (the bubble is the one automatic thing, owner rule
  [[feedback-buddy-never-posts-on-its-own]]). Any reply to chat stays the
  streamer's click.

### D7. Settings live on the Livestream page

- Setup → Livestream gets a "Watchdog" section under the stream settings
  (where plan 184 D11 put "Stream through Videorc Cloud"): every check as a
  row with its switch; "Alert me after" for the muted microphone (15 s,
  30 s, 1 min, 2 min); "System notifications" (on); "Phone" (Premium: the
  link and QR to videorc.com/live, and the device list once subscribed).
  Every check is **on by default**. An empty list never means silence
  ([[feedback-features-work-with-defaults]]).

### D8. "Reconnect" tells the truth on a direct stream, and works on a cloud show

- On a direct stream every leg is a `fifo` output of the one FFmpeg, and a
  `failed` destination is terminal (What exists). FFmpeg can't add an output
  at runtime, and restarting the process cuts every other platform. Until
  plan 217 (one FFmpeg per leg) lands, the alert for a failed direct leg
  says exactly that: "Videorc can't reconnect {label} without a gap on the
  others. Keep going, or end the livestream and go live again." with
  **Open Livestream** (the page with End livestream / Continue streaming).
  A `reconnecting` leg says "Videorc is retrying every 2 seconds." and
  offers nothing but acknowledge; FFmpeg is already doing the work.
- On a cloud show the runner owns the legs. **Reconnect {label}** re-sends
  that one destination (`destinations.set` with the one id), which resets
  the runner's failure count and starts the leg again. No other platform
  notices.
- Recommended: ship the honest copy in Phase A; the one-leg restart on
  direct streams is plan 217's, not this plan's.

### D9. The runner measures the program it already decodes (Phase C)

- The runner decodes the feed to PCM and frames to run the hold switch.
  Phase C adds three cheap measurements on that decoded data and one on
  timestamps: master RMS per second (silence), mean luma of a 64×36 downscale
  per second (black), decoded-frame progress while `kbps > 0` (frozen feed,
  distinct from feed lost), and audio-video PTS skew (drift). They go into
  the state frame as one optional `program` block, additive. No FFmpeg
  detect filter, no second decode.
- The desktop turns them into the same alerts with "Source: Videorc Cloud".
  A desktop and a cloud reading of the same problem dedupe into one alert
  (the cloud reading wins the detail, because it is what left our servers).
- Phase C never stores or forwards audio or video. The measurements are
  numbers.

### D10. Black-picture detection on the desktop waits for a measurement ⚑

- A black check on the desktop needs a 1 Hz readback of a tiny mip of the
  stream leg's frame (the aux leg on macOS record+stream). The compositor
  already reads back for the JPEG preview path, so the cost is probably
  small, but the native preview's budgets are tight
  ([[videorc-live-background-p95-idle-gpu-clocks]]).
- Slice A7 measures it on this Mac: if the 1 Hz 64×36 readback adds under
  0.3 ms p95 to the compositor's frame on a 1080p60 session, ship it free;
  if not, the black check is cloud-only (Phase C) and the desktop card says
  so on the Watchdog section.
- Recommended: measure first; expect it to ship on the desktop.

### D11. The phone push is informational in v1

- A push says what is wrong and since when, and opens videorc.com/live.
  Acting from the phone (Unmute from a notification) needs a path back to
  the desktop; for cloud shows that is plan 184 Phase 3's control socket,
  for direct streams there is none. Phase D ships the push; the phone's fix
  buttons arrive with 184 P3 and a one-line follow-up here.
- The push carries no chat text, no stream key, no media: `check`,
  `severity`, `title`, `since`, `platform?`, `resolved`.

### D12. Email and Discord are not in v1 ⚑

- Email (Resend exists on the web) would reach the streamer minutes late
  and compete with the push. A Discord webhook (plan 187's client exists)
  posts into a channel the community reads; a problem alert belongs to the
  streamer alone, so it would need a second, private webhook.
- Recommended: neither in v1. Phase E lists both as optional slices if the
  owner wants a fallback for phones without push (Android Chrome and iOS
  16.4+ both have it; older iPhones don't).

### D13. Where the history lives

- Every alert transition is a health event (`watchdog-<check>` warn or
  error on open, `watchdog-<check>-cleared` info on clear, plus
  `-acknowledged` / `-snoozed` info). They are persisted today by
  `emit_health_event` and already mirror into the session log Health shows.
- The Library's session details gain an "Alerts" list built from
  `sessions.healthEvents.list` filtered to `watchdog-*`: "Microphone muted ·
  12:04 to 12:05 (0:52)". It stays local and free (D5). The Buddy report is
  Buddy's and does not change ([[feedback-buddy-page-under-studio]]).

## The check catalogue

Every check: signal, threshold, debounce, guards, where it runs, severity,
fix, copy. Copy is exact. Times in the copy are live clocks (`0:42`).

| Id | Signal and threshold | Debounce and guards | Runs on | Severity | Fix |
| --- | --- | --- | --- | --- | --- |
| `mic-muted` | `AudioSettings.microphone_muted` true (`protocol.rs:1688`) while the session is live, for **30 s** ⚑ (choices 15 s, 30 s, 1 min, 2 min) | Unmute resets the clock. Suppressed while a takeover is active (`screens.active`), since takeovers mute by design; the `brb-long` check covers that case. If `systemAudio` or `sounds` RMS averaged over the window is above −40 dBFS, severity drops to **notice** ("music segment"). "I meant to" silences it for this stream. | desktop | critical | Unmute (`micUnmute`), I meant to |
| `mic-silent` | exists: the 1064 watchdog (−80 dBFS, 3 s hold) | as built | desktop | critical | Open Audio (unchanged notice; the watchdog only gives it the repeat rules and the system notification) |
| `no-voice` | microphone unmuted, `pcm_has_voice` false (−45 dBFS RMS, 50 ms windows) for **5 min** ⚑ | Suppressed while a takeover is active, while `systemAudio` or `sounds` carry level (music), or while `mic-muted` is open. Clears on 2 s of voice. | desktop | warning | Open Audio |
| `program-silent` | master `rmsDb` below **−60 dBFS** for **20 s** continuous (master is the mix written to the stream, `protocol.rs:2026`) | Measured in the backend beside the 1064 watchdog, never in the renderer. While `mic-muted` is open, `program-silent` folds into it (one card, the mic one, with the detail "and nothing else is playing"). While a takeover is active, severity is **notice** (a silent hold is by design) and `brb-long` carries the clock. | desktop; cloud runner (C) | critical | Unmute if muted, else Open Audio |
| `picture-black` | mean luma of the stream leg's frame below 16/255 for **10 s**, sampled at 1 Hz from a 64×36 mip (D10) | Not a takeover whose image is itself dark (the takeover's own mean luma is checked once at activation; a dark takeover suppresses the check while it is active). Hide screen's frost is not black. | desktop if D10 passes; cloud runner (C) | critical | End takeover (`takeoverHide`) when one is active, else Switch scene (opens the Scenes list) |
| `picture-stopped` | `stream-output-stalled` holding for **5 s** without `stream-output-resumed` (`eb:9108`, threshold 2 s), or `compositor-render` producer stall (under 1 fps) for 3 windows (6 s, `capture_health.rs:37, 66`) | **Never** from `screen-delivery` alone (a still screen). The detail adds "The screen hasn't changed either" only when both hold. Clears on `stream-output-resumed` or a healthy render window. Cloud: feed `connected` with `kbps > 0` but no decoded frame for 3 s (a frozen feed, not a lost one). | desktop; cloud runner (C) | critical | Switch scene (re-applies the sources), Open Health |
| `destination-down` | plan 161's states: `reconnecting` for **20 s**, or `warning` (not receiving, already two polls), or `failed` | One alert per destination. Every destination down at once is one **critical** alert ("Nobody is receiving your stream"). | desktop (FFmpeg legs and the platform polls); cloud (runner legs) | warning; critical when all | direct: Open Livestream (D8); cloud: Reconnect {label} |
| `platform-health` | YouTube `healthStatus.status == bad`, or any `configurationIssues[]` entry with `severity == error`; `warning` entries after two polls in a row | Reads the same `liveStreams.list part=status` call (0 extra quota). Rides the plan 094 breaker exactly as the watch does (`youtube_reads_allowed`). Twitch has no health API. Kick: `is_live` false on 3 polls in a row after once true (reliability UNVERIFIED; slice A9 measures). X: `GET /2/broadcasts/:id` `state == ENDED` while we stream (sign-in X only; a stream-key X has no broadcast id). | desktop only (the compliance promise) | critical for `noAudioStream`, `noVideoStream`, X `ENDED`; warning otherwise | Open the platform's dashboard (link), plus the API's own `description` |
| `bitrate-floor` | `stream-bitrate-floor` (plan 218) holding for **2 min** | The adaptive controller is already doing what can be done; this names it. Clears on `stream-bitrate-restored`. | desktop; cloud feed `kbps` under 50 % of the chosen bitrate for 2 min | warning | Open Health |
| `av-drift` | cloud only: feed audio/video PTS skew above **300 ms** for 10 s | Not measurable on the desktop without a reference (plan 218: `baseline:stream:av-sync` can't on this Mac). | cloud runner (C) | warning | Open Health |
| `chat-says` | Phase B: ≥2 distinct authors in 90 s match the same class (`audio`, `video`, `lag`); Premium AI: one author plus a confident typed answer | Excludes the streamer's own messages (`authorAffiliation` broadcaster) and Buddy's. Emote-only messages never match. Negation-bearing phrases only ("no sound", "can't hear"), never bare "sound". At most one alert per class per 10 min. | desktop | warning | Unmute if muted, else Open Audio (`audio`); Switch scene (`video`); Open Health (`lag`) |
| `brb-long` | a takeover has been active for **10 min** while live, repeating every 10 min | None; it is a reminder. On a cloud show the hold's countdown (plan 184 D12) is already shown; `brb-long` fires there too at 10 min. | desktop; cloud | notice | End takeover (`takeoverHide`) |
| `still-there` ⚑ | no voice for 10 min **and** system idle (`powerMonitor.getSystemIdleTime()`, main process) for 10 min, while live | Off while a takeover is active. Recommended on by default, notice only, never a push. | desktop | notice | Show Be right back (`takeoverShow` with the chosen screen; "Choose a takeover" if none) |

### Copy (exact)

Titles are the card's heading and the toast's title; details are the
second line. `{label}` is the destination's label ("YouTube", "Twitch
(main)").

| Check | Title | Detail | Buttons |
| --- | --- | --- | --- |
| `mic-muted` | "Your microphone is muted on the livestream" | "Muted for 0:42. Viewers hear no voice." / notice form: "Muted for 0:42. Viewers hear your system audio." | **Unmute** · I meant to |
| `no-voice` | "No voice for 5 minutes" | "The microphone is on, but nothing is reaching it. Check the device and its level." | **Open Audio** · Got it |
| `program-silent` | "Viewers hear nothing" | "No sound has left the stream for 0:20." / with a takeover: "Be right back has been silent for 0:20." | **Unmute** or **Open Audio** · Got it |
| `picture-black` | "Viewers see a black picture" | "The stream has been black for 0:10." | **End takeover** or **Switch scene** · Got it |
| `picture-stopped` | "The picture has stopped" | "No new frame has reached the stream for 0:05. A still screen is fine; this is the pipeline." (+ " The screen hasn't changed either.") | **Switch scene** · Open Health · Got it |
| `destination-down` (reconnecting) | "{label} has been down for 0:20" | "Videorc is retrying every 2 seconds. Viewers there see nothing until it's back." | Got it |
| `destination-down` (failed, direct) | "Streaming to {label} stopped" | "Videorc can't reconnect {label} without a gap on the others. Keep going, or end the livestream and go live again." | **Open Livestream** · Got it |
| `destination-down` (failed or reconnecting, cloud) | "{label} has been down for 0:20" | "Videorc Cloud is retrying. Reconnect starts it over." | **Reconnect {label}** · Got it |
| `destination-down` (all) | "Nobody is receiving your stream" | "Every destination is down. {reason of the first}" | **Open Livestream** · Got it |
| `platform-health` | "{label} reports no audio" / "{label} reports no video" / "{label} reports a problem" | The API's `description`, else "Check {label}'s live dashboard." | **Open {label} dashboard** · Got it |
| `bitrate-floor` | "Connection too slow for 2 minutes" | "The stream is at half its bitrate and viewers still see skipping. Fewer destinations or a wired connection would help." | Open Health · Got it |
| `av-drift` | "Sound and picture are drifting apart" | "Videorc Cloud measures 0.4 s between them." | Open Health · Got it |
| `chat-says` (audio) | "Chat says they can't hear you" | "3 people in the last 2 minutes: “no sound??”, “cant hear u”, “sin audio”." | **Unmute** or **Open Audio** · Got it |
| `chat-says` (video) | "Chat says the stream is frozen" | "2 people in the last 2 minutes: “stream froze”, “pantalla negra”." | **Switch scene** · Got it |
| `chat-says` (lag) | "Chat says the stream is lagging" | "2 people in the last 2 minutes: “so laggy”, “buffering”." | Open Health · Got it |
| `brb-long` | "Be right back for 10 minutes" | "Viewers have seen the takeover since 12:04." | **End takeover** · Got it |
| `still-there` | "Still there?" | "No voice and no input for 10 minutes." | **Show Be right back** · Got it |
| cleared (every check) | toast only, success: "Microphone unmuted" / "Sound is back" / "Picture is back" / "{label} is back" / "Chat has gone quiet about it" | | |

System notification form: title "Videorc: your microphone is muted", body
"Muted for 0:42 on the livestream. Click to open the Studio." Clicking
brings the main window forward and focuses the card; it never runs the
fix by itself (a notification click is too easy to make by accident).
Phone push form: title "Your microphone is muted", body "Muted for 0:42 on
the livestream." The push opens videorc.com/live.

"Source: Videorc Cloud" appears as a small line under the detail when the
reading came from the runner. The desktop's own alerts carry no source
line.

## Wire shape (additive)

Change it here first, then in every repo it touches.

### Desktop backend ↔ renderer

- **Event `watchdog.alerts`**: the full list on every change.
  `{ sessionId, alerts: [{ id, check, severity: "critical|warning|notice",
  state: "open|acknowledged|snoozed", since, lastRepeatAt?, title, detail,
  source: "desktop|cloud|platform", platform?, targetId?, fixes: [{ kind:
  "unmute|end-takeover|switch-scene|open-audio|open-health|open-livestream|
  reconnect-destination|open-platform-dashboard|show-brb", label, url? }],
  snoozedUntil?, meantTo? }], withdrawn?: [id] }`. Every optional is
  `skip_serializing_if`. `withdrawn` (the review's M2) names the ids that
  left this update without a recovery (a fold, a replace, the session's
  end); it rides the event only, never the RPC's answer, and the renderer
  drops those toasts instead of saying "is back". A meant-to alert stays
  in the list as `snoozed` with `meantTo: true`, hidden, until its signal
  recovers. Add the schema to `backend-rpc-contract.ts` beside
  `audioLevelsEventSchema`.
- **RPCs**: `watchdog.alerts.list` → the same shape;
  `watchdog.alert.acknowledge { id }`; `watchdog.alert.snooze { id, scope:
  "ten-minutes|stream" }`; `watchdog.settings.get` / `watchdog.settings.set
  { checks: { [check]: { enabled } }, micMutedAfterSeconds: 15|30|60|120,
  systemNotifications: bool, phonePush: bool }`. Settings persist in
  `storage.rs` like other app settings.
- **Health events**: `watchdog-<check>` (level `warn` for warning/notice,
  `error` for critical) on open; `watchdog-<check>-cleared` (info);
  `watchdog-<check>-acknowledged`, `watchdog-<check>-snoozed` (info);
  `watchdog-<check>-withdrawn` (info: the card left without a recovery,
  so the history closes its row without an "is back"). The message is the
  card's title plus detail; for `chat-says` the count-and-class form only
  (the quotes stay on the card, L4). Through `emit_health_event`, so URLs
  are redacted and the session log mirrors it.
- **Renderer → main (IPC)**: `watchdog:notify { alertId, title, body }` and
  `watchdog:focus` for the system notification; main checks
  `mainWindow.isFocused()` and the alert's age before showing.
- **Fixes** run through the renderer's existing intent executor
  (`micUnmute`, `takeoverHide`, `takeoverShow`, `sceneApply`, `windowFront`)
  and existing navigation; nothing new on the remote allowlists.

### Runner → desktop (Phase C, `videorc-cloud` and the cloud branch)

- `ShowState` gains `program?: { audioRmsDb?, audioSilentSeconds?,
  blackSeconds?, frozenSeconds?, avSkewMs? }`, each `Option` with
  `skip_serializing_if`, sampled once a second, sent with the frame's usual
  cadence. Absent on a `starting` or `ended` show. Pin it in
  `docs/wire-notes.md`.
- Desktop `CloudStatus` gains `program?` with the same fields, and the
  contract gains them. `cloud.state` already carries `legs`.
- `destinations.set` with a single destination (already allowed by the
  frame's shape) is the Reconnect fix. The runner treats a re-sent id as
  "start this leg over, reset its failure count". Pin that too.

### Desktop → web → phone (Phase D, private web repo)

- Table `push_subscriptions { id, user_id, endpoint, p256dh, auth,
  user_agent, created_at, last_ok_at, failures }`. The endpoint is a
  capability URL; store it like a credential.
- `POST /api/alerts/subscribe` (the PWA, signed in): body is the browser's
  `PushSubscription` JSON. `DELETE` with the endpoint removes it.
- `POST /api/alerts/notify` (the desktop, with the account session it
  already holds): `{ alertId, check, severity, title, body, since,
  platform?, resolved: bool }`. The web sends a VAPID-signed push to every
  subscription of that user, with `TTL` 300 and `Urgency: high` for
  critical, drops a subscription after 3 straight 404/410, and rate-limits
  to 6 pushes per user per 10 minutes (the desktop's repeat rules already
  keep it under that). No chat text, no key, no media in the body.
- The service worker shows the notification and opens `/live` on click.
  The desktop sends only critical and warning alerts, once on open and once
  on clear (D3).

## Phases and slices

Each slice names its repo and a concrete "Done when". Routes and lanes:
Status above.

### Phase A: the desktop watchdog (free, every stream)

Goal: the catalogue's desktop checks, the alert model, the four desktop
surfaces, the fixes, the history, and the smoke. Stands alone; no cloud.

- **A1. The alert store and the check runner** (`videorc`,
  `crates/videorc-backend/src/watchdog/mod.rs`, `alerts.rs`, `checks.rs`).
  A pure `WatchdogState` with `open / acknowledge / snooze / clear / tick`,
  the repeat schedule of D3, the "I meant to" per-stream memory, and the
  fold rules (`program-silent` under `mic-muted`; every destination down →
  one alert). Settings load and save. RPCs and the `watchdog.alerts` event
  wired in `main.rs`; health events through `emit_health_event`. The runner
  ticks once a second from the session's audio-levels task and reads the
  session's live state (`SessionActivity`), so recording-only sessions run
  no new check (D3).
  - **Done when** `cargo test -p videorc-backend watchdog` covers: open
    after threshold, repeat cadence per severity, acknowledge stops repeats,
    snooze hides and returns, "I meant to" holds for the stream, fold rules,
    clear emits `-cleared`; the contract test round-trips a `watchdog.alerts`
    fixture; `pnpm typecheck` passes with the schema added.
- **A2. Audio checks** (`videorc`, `watchdog/checks.rs`, `sa`). `mic-muted`
  from the session's `AudioSettings` (the backend already holds the applied
  mute, `audio.rs:957`) with the takeover and music guards; `program-silent`
  from the master reading the `audio.levels` sampler computes (`rec:10973`),
  measured in the backend; `no-voice` from a `pcm_has_voice`-style gate on
  the post-gain microphone; the 1064 `microphone-silent` adopted into the
  alert model with its repeat rules (its notice copy unchanged).
  - **Done when** unit tests feed synthetic level sequences (muted 29 s → no
    alert; 30 s → open; music above −40 dBFS → notice; takeover active → no
    `mic-muted`, `program-silent` as notice; unmute → cleared within one
    tick) and `cargo clippy -p videorc-backend -- -D warnings` is clean.
- **A3. The picture-stopped check** (`videorc`, `watchdog/checks.rs`, `eb`,
  `capture_health.rs`). Subscribe to `stream-output-stalled` /
  `-resumed` and to the `compositor-render` stage's state. Open at 5 s of
  stall or three stalled render windows; never from `screen-delivery`. The
  "screen hasn't changed" detail only from `held_serves ≫ fresh_serves`
  alongside a stall.
  - **Done when** a unit test with a static-screen sequence (screen-delivery
    collapsed, compositor rendering, encoder progressing) opens nothing, and
    a stall sequence opens at 5 s; `pnpm smoke:output-stall` still passes
    (its 1.5 s pauses stay under the 5 s threshold, so no alert; the smoke
    asserts that).
- **A4. Destinations and platform health** (`videorc`, `watchdog/checks.rs`,
  `platform_stream_watch.rs`, `viewer_stats.rs`). Wrap plan 161's states
  into `destination-down` with the 20 s clock and the all-down fold. Read
  `configurationIssues[]` from the existing YouTube status call (0 extra
  units) and map `type` and `severity` to `platform-health`; keep the plan
  094 breaker gate untouched. X: read `state` from the broadcast poll the
  viewer count already makes; `ENDED` while live opens `platform-health`.
  Kick: count `is_live` misses (3 in a row after once live) behind a flag
  that A9's measurement flips.
  - **Done when** `cargo test -p videorc-backend platform_stream_watch`
    covers `bad` + `noAudioStream` → critical, a `warning` issue on one poll
    → nothing and on two → warning, the breaker open → no read; the
    `youtube` axum mock test returns `configurationIssues`; the daily quota
    log shows no new call kinds (`youtube-api-usage` unchanged).
- **A5. The card and the Studio surface** (`videorc`, `renderer`:
  `components/studio/watchdog-alert-card.tsx`, `session-panel.tsx`,
  `lib/live-session-view.ts`, `lib/stream-health-attribution.ts`,
  `lib/studio-toasts.ts`). `WatchdogAlertCard` as an `Alert` inside
  `SessionNotices`: title, detail, clock, source line, the fix button
  (primary), Got it / I meant to (quiet), a kebab with Snooze 10 min. The
  "Stream" fact row names the top open alert first (`streamHealthFact`
  gains a `watchdog` input ranked above every stage). Toasts keyed
  `watchdog:<check>` with the fix as action; the clearing toast replaces
  them. Fixes dispatch existing intents. Light and dark checked; copy from
  the table above, exactly.
  - **Done when** `pnpm --filter @videorc/desktop test` covers the card's
    button set per check, the fact row's ranking and the toast keys;
    `pnpm lint`, `pnpm format:check`, `pnpm ui:check` pass; two screenshots
    (dark, light) of a `mic-muted` card attached to the PR.
- **A6. The Stream Manager chip, the Livestream section, the history**
  (`videorc`, `renderer`: `stats-bar.tsx`, `streaming-tab.tsx`,
  `library-tab.tsx` session details). A chip beside ON AIR
  (`data-testid="session-alert"`, warning or destructive dot, the title in
  a few words) only while an alert is open, hover card = the same
  `WatchdogAlertCard`. Setup → Livestream "Watchdog" section (D7). The
  Library's session details list `watchdog-*` health events as "Alerts" with
  open and clear times.
  - **Done when** the chip appears and disappears with the alert in a
    component test; the section round-trips `watchdog.settings.set`; the
    Library list shows a fixture's two alerts; both themes checked.
- **A7. System notifications and the black-picture measurement**
  (`videorc`, `apps/desktop/src/main/watchdog-notify.ts`, `updater.ts`'s
  pattern; `compositor.rs`). Main shows a `Notification` when the renderer
  asks and the window isn't focused, or the alert is critical and 60 s old;
  click → `mainWindow.show()`, focus, `watchdog:focus` to the renderer. On
  Windows, call `app.setAppUserModelId` with the installer's app id at
  startup if the shortcut doesn't carry it (check the electron-builder
  config; UNVERIFIED). Then measure D10: a 1 Hz 64×36 readback of the
  stream leg's frame on a 1080p60 synthetic session; record the compositor
  p95 delta in the PR. If under 0.3 ms, add `picture-black` on the desktop
  with the dark-takeover guard; else leave it to Phase C and say so in the
  Watchdog section ("Black picture: Videorc Cloud only").
  - **Done when** a dev run shows one notification for a `mic-muted` alert
    with the Studio unfocused and none when focused; the PR carries the
    readback numbers and the D10 call.
- **A8. The smoke** (`videorc`, `scripts/smoke-stream-watchdog-app.mjs`,
  `package.json` `smoke:stream-watchdog`). The dev app goes live to two
  local RTMP sinks (the sink from `scripts/smoke-stream-leg-eof-app.mjs`)
  with the synthetic tone microphone (`VIDEORC_CAPTION_CONTRACT_TEST` +
  `VIDEORC_LIVE_SOURCE_SWITCH_TEST`, as `smoke:output-stall` does) and dev
  thresholds (`VIDEORC_WATCHDOG_MIC_MUTED_AFTER_MS=3000`,
  `…PROGRAM_SILENT_AFTER_MS=3000`, `…PICTURE_STOPPED_AFTER_MS=3000`,
  `…DESTINATION_DOWN_AFTER_MS=5000`). Scenarios, each asserted on
  `watchdog.alerts` and the `watchdog-*` health events: (1) `micMute`
  intent → `mic-muted` open within threshold + 1 s, `program-silent` folded
  (one alert), Unmute → cleared; (2) `takeoverShow` with a mid-grey image →
  no `mic-muted` (guard), `program-silent` as notice; (3)
  `VIDEORC_TEST_VT_FIFO_PAUSE_MS=6000` once → `picture-stopped` open, then
  cleared (macOS only; SKIP elsewhere naming the seam); (4) close one
  sink's socket for 10 s → `destination-down` warning for that leg only,
  resume → cleared (the other leg stays `live`); close both → the all-down
  critical fold; (5) a black PNG takeover → `picture-black` if A7 shipped
  it, else SKIP with the D10 note; (6) acknowledge stops the repeat (observe
  no second `lastRepeatAt` within the dev repeat window); (7) a leak scan
  over every event: no stream URL, no key. Then Stop within the
  `smoke:record-latency:gate` budget.
  - **Done when** the smoke passes three times in a row on an idle Mac and
    `pnpm smoke:stream-leg-eof`, `pnpm smoke:multistream` and
    `pnpm smoke:output-stall` still pass.
- **A9. Kick liveness measurement** (`videorc`, a dated note in
  `docs/acceptance/`). With the owner's go, go live to the owner's Kick
  channel for 3 minutes with a local sink as the second leg, stop pushing to
  Kick only (kill that sink's proxy) and record how many 60 s polls it takes
  for `is_live` to flip. Flip A4's Kick flag on if it is 3 or fewer, with the
  measured number in the Watchdog section's hover ("Kick reports offline
  about 2 minutes late").
  - **Done when** the note exists and A4's flag matches it. Without the
    owner's go, the slice is skipped and the flag stays off (Kick then has
    no liveness alert; the plan 161 behaviour is unchanged).

**Phase A acceptance (the owner)**: go live to YouTube and one more platform
(with the owner's go), mute for 40 s: the card, the toast and a system
notification arrive at 30 s; Unmute clears them. Pull the Ethernet cable for
30 s: "YouTube has been down for 0:20" and "{other} has been down for 0:20",
then "is back". In YouTube Studio, read the stream health panel and compare
with the `platform-health` card.

### Phase B: chat says there is a problem

- **B1. Phrase tables and the matcher** (`videorc`,
  `crates/videorc-backend/src/watchdog/chat_signals.rs`). Pure: a message
  → `Option<(Class, Phrase)>`; a window → an alert decision (≥2 distinct
  authors, 90 s, same class). Tables for en, es, pt, de, fr, it, nl, pl, ru,
  tr, ja, ko, zh, sv, each with negation-bearing phrases for `audio` ("no
  sound", "can't hear", "cant hear u", "muted", "no audio", "sin audio", "no
  se oye", "não ouço", "sem som", "kein ton", "hör dich nicht", "pas de son",
  "on t'entend pas", "niente audio", "non ti sento", "geen geluid", "brak
  dźwięku", "nie słyszę", "нет звука", "не слышно", "ses yok", "sesin
  gelmiyor", "音がない", "聞こえない", "소리가 안", "안 들려", "没有声音",
  "听不到", "inget ljud"), `video` ("frozen", "froze", "black screen", "no
  video", "congelado", "pantalla negra", "travou", "tela preta",
  "eingefroren", "schwarzer bildschirm", "figé", "écran noir", "bloccato",
  "schermo nero", "bevroren", "zawiesił", "czarny ekran", "завис", "чёрный
  экран", "dondu", "siyah ekran", "固まって", "画面が黒", "멈췄", "화면이 검",
  "卡住", "黑屏", "fryst") and `lag` ("lagging", "laggy", "buffering",
  "stuttering", "se traba", "lageando", "ruckelt", "ça lag", "scatta",
  "hapert", "laguje", "лагает", "takılıyor", "ラグ", "렉", "卡了", "laggar").
  Unicode case folding, emote stripping, the streamer's and Buddy's
  messages excluded. Wired into the merged chat stream the backend already
  keeps (`live_chat.rs`), opening `chat-says` through A1.
  - **Done when** `cargo test -p videorc-backend chat_signals` has one
    positive and one negative per language ("can you hear me?" from one
    chatter never opens; two chatters "no sound" and "sin audio" open
    `audio`); the renderer bundle is unchanged (`pnpm build` budget check).
- **B2. The AI read (Premium)** (`videorc`, `videorc_api.rs`; web, private,
  `app/api/ai/watchdog/chat/route.ts`). When B1 saw ≥1 candidate in the
  last 2 min and the account is Premium (`premium_entitled()`, the
  `LiveCohost` feature, same gate as Buddy), send the last 20 messages
  (text, platform, a per-call author index, no ids or names) to a typed
  question "Are viewers reporting a technical problem with the stream?
  Which: none, audio, video, lag?" with a confidence; at most once every
  2 min per stream. A confident class opens `chat-says` even from one
  author. Buddy's bubble, if Buddy is on, says the card's title; never a
  post. A Livestream-page switch "AI reads chat for problems" under the
  Watchdog section, on for Premium by default ⚑.
  - **Done when** the web route's tests cover the shape, the Premium gate
    and the rate limit; the desktop unit test proves one author + a
    confident answer opens, one author + "none" doesn't; a `fable-5.1`
    security pass on the route is in the PR; `pnpm smoke:cohost-fake` is
    unchanged.
- **B3. The chat smoke scenario** (`videorc`, extends A8 using
  `scripts/lib` fake chat providers from `smoke:live-chat-fake-providers`).
  Two fake authors post "no sound??" and "sin audio" within 10 s → `chat-says`
  (audio) with both quotes in the detail; one author posting "can you hear
  me?" three times → nothing; the streamer's own "no sound today, sorry" →
  nothing.
  - **Done when** the scenario passes in `pnpm smoke:stream-watchdog` and
    `pnpm smoke:live-chat-fake-providers` is unchanged.

### Phase C: the cloud runner sees what leaves our servers (Premium)

Starts only after plan 222 reports plan 184 Phase 1 merged and on nodes.
Build against the merged code, not the draft.

- **C1. Program measurements in the runner** (`videorc-cloud`,
  `crates/runner/src/engine.rs`, `crates/protocol/src/control.rs`,
  `docs/wire-notes.md`). Once a second on the decoded program: RMS of the
  mixed PCM (→ `audioRmsDb`, `audioSilentSeconds` under −60 dBFS); mean luma
  of a 64×36 downscale of the composed frame (→ `blackSeconds` under
  16/255); decoded-frame progress while the feed is `connected` with
  `kbps > 0` (→ `frozenSeconds`); audio-video PTS skew (→ `avSkewMs`). All
  in `program?` on `ShowState`, every field `skip_serializing_if`. During a
  hold, `audioSilentSeconds` and `blackSeconds` are expected and reported
  as such (`hold.active` is already in the frame; the desktop uses it).
  - **Done when** runner unit tests feed a silent feed, a black feed and a
    frozen-but-connected feed through the engine's test harness and assert
    the counters; `cargo clippy -- -D warnings` clean; `docs/wire-notes.md`
    pins the block and the single-destination `destinations.set` semantics.
- **C2. Reconnect one leg** (`videorc-cloud`, `fanout.rs`). A re-sent
  destination id restarts that leg and resets its failure count; the others
  are untouched. Pin it (C1's note).
  - **Done when** a fanout test drives a leg to `failed` (20 failures), re-
    sends it, and sees `connecting` then `live` with the other leg's
    connection never closed.
- **C3. The desktop reads it** (`videorc`, `cloud_show.rs`, `recording.rs`
  `apply_cloud_leg_states`, `watchdog/checks.rs`, the contract). `CloudStatus.program?`
  from the frame; the watchdog's `program-silent`, `picture-black`,
  `picture-stopped` and `av-drift` accept a cloud source and dedupe with the
  desktop's reading (D9); `destination-down` on a cloud show offers
  **Reconnect {label}** → `destinations.set` with the one id. The card's
  "Source: Videorc Cloud" line.
  - **Done when** the contract round-trips a `cloud.state` fixture with
    `program`; unit tests cover dedupe (both sources → one alert with the
    cloud detail) and the hold guard; `pnpm typecheck` passes.
- **C4. The cloud smoke scenario** (`videorc`, `scripts/smoke-cloud-solo-app.mjs`,
  `pnpm smoke:cloud-solo`). After the existing feed-cut and death checks:
  the publisher's audio switches to `anullsrc` for 25 s → the runner's
  `audioSilentSeconds` climbs, the desktop opens `program-silent` with
  source cloud within 25 s, the publisher's tone returns → cleared; kill
  one receiver until the runner marks the leg `failed` (shorten the failure
  cap through a dev env), click Reconnect → `connecting` then `live`, the
  other receiver's connection count still 1.
  - **Done when** the extended smoke passes three times in a row and the
    existing C8 checks (hold 1.5 to 1.7 s, resume, one connection per
    receiver) are unchanged.

### Phase D: the phone (Premium)

Needs plan 184's W6 `/live` page (built) and a web session for the
desktop account (exists). It does not need the phone camera or the control
socket (184 P2, P3).

- **D1. The PWA gets push** (web, private: `public/sw.js`,
  `app/live/page.tsx`, `lib/alerts/push.ts`, a migration for
  `push_subscriptions`, `app/api/alerts/subscribe/route.ts`,
  `app/api/alerts/notify/route.ts`, VAPID keys in the environment, the
  `web-push` dependency). The `/live` page gains "Get alerts on this phone"
  (a button, since iOS needs a gesture), an installed-app check with the
  iOS instruction "Add Videorc to your Home Screen first (Share → Add to
  Home Screen), then come back here." when not installed, and the device
  list with Remove. Notify route as in the wire shape, Premium-gated
  through the existing plan helpers (`getEffectivePlan`), rate-limited,
  subscriptions pruned on 404/410.
  - **Done when** `pnpm typecheck && pnpm test && pnpm build` pass with
    tests for the subscribe shape, the Premium gate, the rate limit and the
    pruning; a `fable-5.1` security pass is in the PR; `docs/cloud.md` (or
    a new `docs/alerts.md`) documents the routes and the "no chat text, no
    key, no media" rule; the privacy page says a push alert carries the
    alert's title and time only.
- **D2. The desktop sends** (`videorc`, `watchdog/push.rs`,
  `videorc_api.rs`). On open (critical and warning) and on clear, `POST
  /api/alerts/notify` with the account session; off when `phonePush` is
  false or the account isn't Premium; failures are logged once per stream
  and never shown as a toast (the phone is the fallback, not the primary).
  The Livestream section's "Phone" row: the link, a QR code (the renderer
  already draws QR for Phone remote), and "Alerts reach {n} devices" from a
  `GET /api/alerts/devices` the same session can call.
  - **Done when** a unit test with an axum mock proves the body shape (no
    URL, no key, no chat text), the Premium gate and the off switch;
    `pnpm smoke:streaming-secrets` extends its leak scan to the notify
    body.
- **D3. Owner acceptance.** The owner's iPhone, videorc.com/live added to
  the Home Screen, alerts on. A dev stream to a local sink, `micMute` for
  40 s: the phone buzzes within 10 s of the desktop card. Note the
  measured delay in the PR.
  - **Done when** the owner says so; no automated gate drives a real phone.

### Phase E: optional extras (⚑ each)

- **E1. Facebook health** (`videorc`): when a Facebook destination exists
  (plan 206's Page join), poll `ingest_streams.stream_health` every 30 s
  (the API allows 2 s; 30 s is plenty) and open `platform-health` on
  `video_bitrate` or `video_framerate` at zero for two polls. Needs the
  `publish_video` scope check.
- **E2. Email fallback** (web, Resend): critical alerts only, one email per
  alert, for accounts with no push device. Off by default.
- **E3. Private Discord webhook** (`videorc`, plan 187's client): a second
  webhook field "Alerts (private channel)". Off by default.
- **E4. `still-there`** if the owner wants it off by default instead.

## Verification gates

Use `AGENTS.md` as the source of truth. Run a phase's gates once, after its
slices are committed.

- **Every phase (`videorc`)**: `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, `pnpm ui:check`, `pnpm --filter @videorc/desktop
  test`, `cargo fmt --check --all`, `cargo clippy -p videorc-backend --
  -D warnings`, targeted `cargo test -p videorc-backend watchdog` (and
  `platform_stream_watch`, `chat_signals` where touched). No full Rust
  suite ([[user-videorc-skip-rust-suite]]).
- **Phase A smokes**: `pnpm smoke:stream-watchdog` (new), `pnpm
  smoke:stream-leg-eof`, `pnpm smoke:multistream`, `pnpm smoke:output-stall`,
  `pnpm smoke:youtube-quota` (the YouTube watch changed; the fake at
  `scripts/lib/fake-youtube-api.mjs:296-311` gains a `configurationIssues`
  variant), `pnpm smoke:remote-control` (intents reused, allowlists
  unchanged), `pnpm smoke:recording-studio` (record+stream unchanged),
  `pnpm smoke:streaming-secrets`. If A7 ships the desktop black check:
  `pnpm smoke:preview-performance:native` and `pnpm probe:live-background-cost`
  before and after, numbers in the PR.
- **Phase B**: `pnpm smoke:stream-watchdog` (with B3), `pnpm
  smoke:live-chat-fake-providers`, `pnpm smoke:cohost-fake`; web `pnpm
  typecheck && pnpm test && pnpm build`.
- **Phase C**: `videorc-cloud` `cargo fmt --check`, `cargo clippy -- -D
  warnings`, runner tests; desktop gates above; `pnpm smoke:cloud-solo` (with
  C4); `pnpm smoke:stream-leg-eof` with the cloud off.
- **Phase D**: web `pnpm typecheck && pnpm test && pnpm build`; desktop
  gates; `pnpm smoke:streaming-secrets`; the owner's phone (D3).
- **Parallel executors**: at most 2 or 3 Rust compiles at once
  ([[videorc-parallel-executor-compile-thrash]]); check `df` and swap first.

## When things break

| What breaks | What the streamer sees | What the watchdog does |
| --- | --- | --- |
| A check misfires (a false alarm) | A card they didn't need | "I meant to" or the check's switch on the Livestream page; the health event stays so the misfire can be read later |
| The renderer is hidden or throttled | Nothing changes | The backend owns the clocks; the system notification still fires from main |
| The backend restarts mid-stream | The session ends (today's behaviour) | Alerts die with the session; history is already persisted |
| The YouTube quota breaker opens | `platform-health` for YouTube stops | The watch already skips reads behind the breaker; FFmpeg leg states still drive `destination-down` |
| The runner frame lacks `program` (older runner) | Desktop checks only, no source line | Optional block; the desktop never waits for it |
| The web is down (Phase D) | No push | Logged once; the desktop surfaces are unaffected |
| The phone has no push (old iOS, not installed) | The `/live` page says why | E2's email if the owner enables it |
| A notification can't show (unsigned dev build on macOS) | No system notification in dev | `Notification.isSupported()` and the `failed` event are logged; packaged builds are signed |

## STOP conditions

Stop and report when:
- A check would need pixel change alone to open "picture stopped" (D1).
- A fix would need a new control next to Record or Go Live, or a second
  home for an existing control (D2).
- Any chat text, stream URL, key or media would leave the computer on a
  direct stream, or reach a log, the notify body or a push (D11; the leak
  scans in A8 and D2).
- A YouTube API call would run from a server, or `configurationIssues`
  would need a new call kind (it must ride `liveStreams.list part=status`).
- The D10 readback costs more than 0.3 ms p95 and someone wants to ship it
  anyway.
- The 1064 silence watchdog's thresholds or `stream-output-stalled`'s 2 s
  threshold would have to change to make a check work.
- Buddy would post anything because of an alert.
- Phase C or D would start before plan 222 reports the cloud merged, or
  would touch the three draft PRs.
- A platform's rules turn out to forbid the polling cadence (X and Kick
  rate limits are UNVERIFIED).

## Out of scope

- Restarting one leg of a direct stream (plan 217's split FFmpeg).
- Acting on alerts from the phone (plan 184 P3's control socket).
- Measuring A/V drift on the desktop (no reference; plan 218's note).
- A watchdog for recordings without a stream (D3, owner may extend).
- Changing Buddy's report or the Buddy page.
- Platform-side health for Twitch (no API) and TikTok, Instagram, Custom
  RTMP (no API at all; `destination-down` from FFmpeg legs covers them).
- A native phone app (plan 184 X11).

## Open questions for the owner

1. **Mic muted threshold**: 30 s by default (choices 15 s, 30 s, 1 min,
   2 min)? Recommended: 30 s. Fifteen seconds alarms a cough; two minutes
   is a long time for viewers.
2. **The split (D5)**: free = every desktop check, the cards, system
   notifications, the fixes, the history, the cheap chat match; Premium =
   cloud-side checks, phone push, AI chat read. Agree? Recommended: yes.
3. **Black picture on the desktop (D10)**: measure first, ship if under
   0.3 ms p95? Recommended: yes.
4. **`still-there`** (no voice and no input for 10 min): on by default as a
   notice? Recommended: on; it never pushes and never notifies.
5. **AI chat read (B2)**: on by default for Premium accounts, with a switch?
   Recommended: on, since Buddy already reads chat for Premium users.
6. **Email or a private Discord webhook as fallbacks (D12)**: in v1?
   Recommended: no; Phase E if asked.
7. **Recordings without a stream**: should `mic-muted` also warn while only
   recording? Recommended: not in v1 (a recording can be redone).
8. **Kick liveness (A9)**: may an agent go live on your Kick channel for 3
   minutes to measure how fast `is_live` flips? Recommended: yes, once, with
   you in the session.

## Handoff (cold start)

- **Goal**: the watchdog as above, Phase A first, then B; C and D after
  plan 222 reports the cloud merged.
- **Current state**: nothing built. Every fact in "What exists" was read at
  the refs in Status; re-run the drift check before touching code. The
  silence watchdog (issue 1064), the `audio.levels` event, plan 161's
  destination states and plan 218's delivery stats are the signals Phase A
  builds on; none of them change.
- **Chosen routes and lanes**: Status above. Phase A backend on
  `fable-5.1`; Phase A UI on `opus-5.5` with `videorc-design`; smokes and
  phrase tables on `gpt-6.1-sol`.
- **Out of scope**: the list above; in particular no one-leg restart on
  direct streams and no acting from the phone.
- **Ordered steps**: A1 → A2 → A3 → A4 (backend, one PR) with A5 → A6 → A7
  (UI, the same PR or a second one), A8 (the smoke), A9 (with the owner's
  go); then B1 → B2 → B3; C1 → C2 → C3 → C4 after plan 222; D1 → D2 → D3.
- **Verification**: the gates per phase above; `pnpm smoke:stream-watchdog`
  is the proof of Phase A.
- **Known blockers**: the owner's go for any real-channel test (A9, Phase A
  acceptance); plan 222 for Phase C and D's web work landing beside the
  cloud routes; Windows `AppUserModelId` for notifications is UNVERIFIED in
  the installer config; X and Kick polling rate limits are UNVERIFIED.

## Progress

| Slice | State |
| --- | --- |
| A1 the alert store and the runner | **Done** 2026-11-08. `crates/videorc-backend/src/watchdog/{mod,alerts,settings,checks}.rs`; the tick rides the session's `audio.levels` task once a second; RPCs `watchdog.alerts.list`, `watchdog.alert.acknowledge`, `watchdog.alert.snooze`, `watchdog.settings.get/set`, `watchdog.idle.report`, `watchdog.phone.devices`; event `watchdog.alerts`; health events through `emit_health_event`; `protocol-fixtures/watchdog.json` round-trips on both sides. |
| A2 audio checks | **Done**. `mic-muted` from the bus's applied mute (the takeover and music guards), `program-silent` from the master reading, `no-voice` from the post-gain microphone (−45 dBFS), the 1064 silence watchdog adopted as `mic-silent` (notice copy unchanged). Deviation: while the microphone is muted and the mute check is on, `program-silent` folds into the mic card from the start, so the mute's own threshold is never preempted by the 20 s silence clock. |
| A3 picture-stopped | **Done**. From `stream-output-stalled`/`-resumed` and the `compositor-render` latch; `screen-delivery` alone never opens it and only adds "The screen hasn't changed either." |
| A4 destinations and platform health | **Done**. `destination-down` with the 20 s clock, the all-down fold and the honest direct-leg copy (D8); YouTube `configurationIssues` read from the same `part=status` body (the plan 094 breaker untouched, a unit test proves it); X `ENDED` from the viewer poll; Kick's miss counter behind `watchdog::KICK_LIVENESS_ALERTS = false` (A9 flips it). The fake YouTube API gains `controls.configurationIssues`. |
| A5 the card and the Studio | **Done**. `components/studio/watchdog-alert-card.tsx` (lazy) inside `SessionNotices`; the Stream fact row names the top alert; toasts keyed `watchdog:<check>[:<target>]` with the fix as the action, the clearing toast replaces them; fixes run through the Studio's own actions (`micUnmute`, `takeoverHide`, the pages, `cloud.show.reconnectDestination`). Everything new is in a lazy chunk (`lib/watchdog-surface.ts`); the eager Studio keeps the list and three small effects. |
| A6 the chip, the section, the history | **Done**. `data-testid="session-alert"` beside ON AIR with the card on hover (a fix pressed there is relayed to the Studio through main; Got it and Snooze stay in the Studio); the Watchdog section on the Livestream page (every check, Alert me after, System notifications, Phone with the QR and the device count, AI reads chat); the Alerts list from `watchdog-*` health events. Deviation: the Library has no session-details panel, so the list lives on Health beside "Log of this recording", which already shows the session's log. |
| A7 notifications and the black measurement | **Done**. `main/watchdog-notify.ts` (pure decision + ledger, tests) behind `watchdog:notify`; the click brings the Studio forward and never runs the fix; Windows gets `app.setAppUserModelId` at ready. D10: the 64×36 sample runs on the watchdog's tick task (once a second) against the stream leg's frame store (the split stream store on macOS record+stream, else the primary), not on the compositor's frame thread, so the compositor's own p95 is untouched; the sample's cost is the luma bench in `watchdog/luma.rs` (numbers in the PR). `picture-black` ships on the desktop with the dark-takeover guard (the takeover's own PNG luma at activation: 16 to 47 suppresses, under 16 is black and alarms). |
| A8 the smoke | **Done**. `pnpm smoke:stream-watchdog` (`scripts/smoke-stream-watchdog-app.mjs`): the settings round trip, mute → fold → acknowledge → clear, the grey takeover guard, the black takeover, the FIFO-pause stall (macOS), one sink down → fold → back, the B3 chat scenarios, the leak scan, Stop. |
| A9 Kick measurement | Waits for the owner (a live Kick test). The flag stays off. |
| B1 phrase tables | **Done**. `watchdog/chat_signals.rs`, fourteen languages, one positive and one negative each; wired after chat delivery in `live_chat.rs`; the streamer's own lines (`broadcaster`) and deleted rows never count. |
| B2 the AI read (desktop half) | **Done**. `VideorcApiClient::post_watchdog_chat` to `POST /api/ai/watchdog/chat` (text, platform, a per-call author index; never ids or names), at most once every 2 min per stream, only after a candidate, Premium and the switch; the desktop's threshold is 0.7 on the raw probabilities; a 401/403 stops the stream's reads. Buddy may say the card's title in its bubble, never a post. |
| B3 the chat smoke | **Done**, in `smoke:stream-watchdog`. |
| C3 the desktop reads the runner | **Done**. `RunnerState.program` and `CloudStatus.program` (`CloudProgram`, every field optional), the contract and fixture; the checks dedupe both sources into one card with the cloud detail and the hold guard; `cloud.show.reconnectDestination { targetId }` sends `destinations.set` with the one id (C2's upsert). |
| C4 the cloud smoke scenario | **Done**: `VIDEORC_CLOUD_SOLO_WATCHDOG=1 pnpm smoke:cloud-solo`. Deviations: the runner has no dev env to shorten the 20-failure cap, so the leg scenario drives a `reconnecting` leg (the upsert restarts reconnecting legs too), not a `failed` one; and the scenario runs before the drops, not after, because a resumed show holds no keys on this computer. |
| D2 the desktop sends | **Done**. `watchdog/push.rs` builds the body (a count and a class for `chat-says`, never words; no URL, no key); `VideorcApiClient::post_alert_notify` on open and clear of critical and warning alerts, off without Premium or the switch; one session-log line per stream on failure, never a toast; `GET /api/alerts/devices` behind `watchdog.phone.devices` for the section's "Alerts reach {n} devices". |
| D3 owner acceptance | Waits for the owner's phone. |
| Review fixes (2026-11-09) | **Done** on `fix/223-review`, one commit per finding: M1 the `owner` role is the streamer in `observe_chat` (the fake echo wears it; one test per platform shape); M2 `Transition::Withdrawn` for the fold, the unfold, the mute replace, a takeover or guard, the switch and the session's end (no push, no toast, an info `-withdrawn` event; the event's `withdrawn` ids), and "I meant to" keeps the card listed as snoozed with `meantTo`; M3 the dark-takeover guard reads the live card's luma every tick; M4 the luma is decoded by the Screens transition through `spawn_blocking` and cached beside the path (`CachedTakeover`); M5 the notice carries its reason and a second ask lands at since + 60 s, main applying D2/D3; L1 the toast compares words without the clock and never re-issues for a seen or snoozed alert; L2 the compact card draws fixes only; L3 the history pairs by check and target; L4 `chat-says` is recorded as a count and a class (the bundle cuts older quotes); L5 the push and the notification wait for a live watch; L6 a platform signal ages out after three missed polls (`PLATFORM_HEALTH_STALE_AFTER`); L7 a host-shaped label becomes the platform's name in the push; L8 `smoke:output-stall` refuses a watchdog alert, and the AI read body is held to the web's schema; L9 the chip falls back to the platform, then the title. |

### Gates (2026-11-08, on `plan-184-videorc-cloud`)

- Rust: `cargo fmt --check --all`, `cargo clippy -p videorc-backend --all-targets -- -D warnings`, targeted `cargo test` (watchdog, platform_stream_watch, cloud_show, x_live, viewer_stats, protocol: 235) and the full `cargo test -p videorc-backend` (4,803 passed, 26 ignored).
- TypeScript: `pnpm typecheck`, `pnpm lint` (the inherited `setDeviceList` warning only), `pnpm format:check`, `pnpm --filter @videorc/desktop test` (656 files, 7,341 tests), `pnpm test:scripts` (3,160).
- `pnpm build` + `check:renderer-assets`: eager 2,338,620 raw / 480,088 gzip against the inherited 2,335,436 / 479,409 (+3,184 raw, +679 gzip; the ceilings 2,325,000 / 477,000 were already passed by the port, an owner call). The card, the surface, the section, the history and the words all load lazily; what stays eager is the alert list, one listener, one hydration effect, one mount effect and the two-word chip labels.
- D10 measurement: one 64×36 sample of a 1080p frame costs 2.7 µs p95 (BGRA) / 1.3 µs (Y plane) in a debug build (`watchdog::luma::tests::one_sample_on_a_1080p_frame_is_far_under_a_frame_budget`, `--nocapture`); it runs on the watchdog's own task once a second, never on the compositor's frame thread, so the compositor's p95 is untouched. Far under 0.3 ms: the desktop check ships.
- Smokes, all green on 2026-11-08: `pnpm smoke:stream-watchdog` (every scenario, the stall included, plus the dark and light screenshots of the mic card); `VIDEORC_CLOUD_SOLO_WATCHDOG=1 pnpm smoke:cloud-solo` (quiet before the mute, `program-silent` from the runner's reading 21.7 s after the mute with the cloud detail, cleared on the tone; the killed leg's card with Reconnect, the RPC accepted, the leg live again in 2.6 s, the other receiver's connection never closed; the existing drop checks unchanged: hold 1.6 s, back live 5.2 s and 5.9 s); `pnpm smoke:multistream`; `pnpm smoke:stream-leg-eof`; `pnpm smoke:live-chat-fake-providers`.
- Two more deviations found by the smokes: the C4 scenario runs before the drops, because a resumed show (after the computer died) keeps its keys on the runner and this computer cannot re-send one destination (`cloud.show.reconnectDestination` says so in plain words); and a resumed show's runner legs count as the hand-over for the watchdog's cloud reading (`carries_session`), since a Resume never sends `destinations.set`.

