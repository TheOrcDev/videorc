# Plan 222: Videorc Cloud solo shows reach every Premium user

> **Executor instructions**: read `AGENTS.md`, `CLAUDE.md`, plan 184
> (`plans/184-videorc-cloud.md`, the design source of truth for Phase 1 and
> its Wire shape), plan 185 (`docs/plans/185-videorc-max-tier.md` in the
> private `videorc-web` repo) and this whole plan first.
> - Desktop work: your own worktree. Phase R works on
>   `origin/plan-184-videorc-cloud`; Phase P and everything after it work on
>   the new branch `plan-222-cloud-on-main`, cut from `origin/main` (P1).
> - Web work: your own worktree of `~/projects/videorcweb` on
>   `plan-185-max-and-cloud`. Runner work: `~/projects/videorc-cloud` on
>   `phase-1-runner`.
> - Never merge desktop #727, web #85 or `videorc-cloud` #1. #727 is
>   superseded by the port (P9), not merged.
> - Write and commit every slice of a phase first, then run the Rust gates
>   and the smokes once at the end of the phase ("Gates at the end").
> - Check every UI in light AND dark.
> - Never go live on a real channel unless the owner asks for a live test in
>   the session (`AGENTS.md`, "Live Tests On YouTube").
> - This plan redesigns nothing in Phase 1. Where it says "as plan 184 C5b
>   says", read that section and build that.

Drift check before any slice:

```sh
git -C ~/projects/videorc fetch origin
git -C ~/projects/videorc log --oneline d00550ea1..origin/main -- \
  crates/videorc-backend/src/recording.rs crates/videorc-backend/src/streaming.rs \
  crates/videorc-backend/src/main.rs apps/desktop/src/shared/backend-rpc-contract.ts \
  apps/desktop/src/renderer/src/hooks/use-studio.tsx package.json | wc -l
git -C ~/projects/videorc log --oneline 0e5bade39..origin/plan-184-videorc-cloud
git -C ~/projects/videorcweb-wt-185 fetch origin && git -C ~/projects/videorcweb-wt-185 log --oneline 3c8d1593..origin/main | wc -l
git -C ~/projects/videorc-cloud fetch origin && git -C ~/projects/videorc-cloud log --oneline b0557c9..origin/phase-1-runner
```

A non-zero first count means main moved under the seam: re-read "What
exists" (the line numbers) before porting. The other counts mean the branches
moved: re-read Phase R.

## Status

- **Status**: EXECUTING 2026-11-08. Phase R is committed on `plan-222-r`
  (R1 to R5; R6 unpushed). Phase P is committed on `plan-222-cloud-on-main`
  through P8; P9's gates and P-land follow (the executor's report names what
  ran and what is owed).
- **Priority**: P1. The owner's pick 1 and 2 of five on 2026-11-08 ("the
  stream never drops", "upload once, stream everywhere"). Umbrella: plan 221.
- **Effort**: XL. About 5 to 7 weeks of agent work in sequence, plus waits
  on the owner for a server account, DNS and a compliance answer. The code
  is built; the road is porting, production and proof.
- **Risk**: HIGH.
  - The port: the cloud seam lives in `recording.rs`, which grew by about
    14,500 lines on main since the cloud branch's base (P2).
  - Production: a live stream depends on our servers for the first time.
  - Nothing ships without a node, and the owner holds the account.
- **Planned at**: desktop `origin/main` `d00550ea1` (app 0.20.4);
  `origin/plan-184-videorc-cloud` `0e5bade39`; the local tag
  `backup/plan-184-local-2026-10-21` `95fbdce96`; web `plan-185-max-and-cloud`
  `5a75d03d` (web `origin/main` `3c8d1593`); runner `phase-1-runner`
  `b0557c9`.
- **Route**: Orchestrator (fit 10) owns the order and the merges.
  - Phase R, branch recovery: Implementation (fit 8) on `gpt-6.1-sol`;
    mechanical, with a Review pass (fit 9) on R3.
  - Phase P, the port onto main: Diagnose (fit 9) on `fable-5.1`. It has
    failed before in spirit (a trial merge conflicts in 17 files) and it
    touches recording output.
  - Phase L leftovers and Phase A acceptance: Implementation (fit 8) on
    `fable-5.1` for anything in `recording.rs` or `cloud_show.rs`;
    `gpt-6.1-sol` for harness and docs.
  - Phase I and O (nodes, deploys, watching, runbook): Implementation
    (fit 8) on `fable-5.1`, owner-assisted. Release-critical.
  - Phase Y compliance drafts: Research (fit 7) on `opus-5.5`; the owner
    sends them.
  - Phase U product and copy: UI/Product Design (fit 9) on `opus-5.5` with
    `.claude/skills/videorc-design/SKILL.md`.
  - One Review pass (fit 9, `fable-5.1`) before the kill switch flips for
    anyone but the owner. Releases: Release (fit 10) with `videorc-release`.

## The owner's ask (2026-11-08)

> "plan out thoroughly first 5 things you recommended, it can go from our
> cloud branch that we already started"

Features 1 and 2 of the five: **the stream never drops** (cloud hold and
failover) and **upload once, stream everywhere** (the cloud relay). Both are
plan 184 Phase 1, solo shows. This plan takes them from a three-week-old
draft branch to "every Premium user can turn on Videorc Cloud, and it works
in production".

## What a streamer gets

A Premium streamer on 0.21 or later:

1. Opens Setup → Livestream. Under the stream settings there is a "Videorc
   Cloud" section with one switch, "Stream through Videorc Cloud", on by
   default (D1), with "Your stream stays on air if this computer drops."
   under it. A "Test Videorc Cloud" row sends 10 seconds of test video and
   answers "Videorc Cloud works from here. Upload 6.1 of 6 Mbps."
2. Clicks Go Live as always. The button reads "Connecting to Videorc Cloud…"
   for a few seconds, then the stream is live on YouTube, Twitch, Kick and
   X. The computer uploads one 6 Mbps feed instead of four. Stream health
   reads "Cloud · 6 Mbps" and on hover shows one Videorc Cloud row above the
   platform rows.
3. Loses Wi-Fi for two minutes. Viewers see a "Be right back" card within
   1.6 s; the broadcast and the VOD stay in one piece. The Studio says the
   feed is reconnecting. Wi-Fi returns, and the picture is back about 3 s
   later with nothing to click.
4. The Mac dies. On relaunch the Studio says "You're still live through
   Videorc Cloud." with "Viewers see Be right back. The stream ends in
   27 min unless you resume." and Resume. Resume is live about 6 s after
   the click, on the same broadcast.
5. Updates the app mid-stream. Same as 4.
6. Runs out of cloud hours mid-show. Nothing happens to the show (plan 184
   D18). The next Go Live streams directly and says so once.
7. Reads on videorc.com: "Free multistream runs on your computer. With
   Premium it can go through Videorc Cloud, so it survives your computer."

The numbers above are what the smokes measured on 2026-10-21 (What exists).

## Words we use

New words on top of plan 184's table.

| Word | Meaning |
| --- | --- |
| **The cloud branch** | `plan-184-videorc-cloud`, desktop PR #727. Built against 0.9.143. Superseded by the port. |
| **The port branch** | `plan-222-cloud-on-main`: the cloud code re-applied on current `origin/main` (Phase P). The PR that can merge. |
| **Direct** | A stream from the computer to the platforms, as today. UI copy: "You're streaming directly from this computer". |
| **Kill switch** | Web env `VIDEORC_CLOUD_DISABLED`. Fails closed. Flipping it back rolls the cloud back for everyone at once. |
| **Cohort** | Web env `VIDEORC_CLOUD_USERS`: the accounts that get the cloud before `VIDEORC_CLOUD_PUBLIC` opens it to every Premium account. Fails closed. |
| **Lost show** | The desktop can't reach its show (control socket and feed both gone) and doesn't know whether the runner still pushes (L3). |

## What exists (facts)

### The cloud branch (desktop, PUBLIC repo)

- **Pushed head** `0e5bade39`, 49 commits on base `4c7980673`
  (2026-10-16, app 0.9.143). 64 files, +19,342 / −235. The big ones:
  `crates/videorc-backend/src/cloud_show.rs` (new, 6,023 lines),
  `recording.rs` (+1,804), `main.rs` (+458), `scripts/smoke-cloud-solo-app.mjs`
  (new, 2,222), `scripts/lib/fake-cloud-web.mjs` (new, 1,178),
  `scripts/lib/cloud-solo-gates.mjs` (new, 449), `use-studio.tsx` (+260),
  `backend-rpc-contract.ts` (+204), `backend.ts` (+198),
  `protocol-fixtures/high-risk-contracts.json` (+239),
  `docs/cloud/spike-srt-2026-10.md` (new, 668).
- **The local tag** `backup/plan-184-local-2026-10-21` = `95fbdce96`: 7
  commits on `13fd7ca56`, written by the 2026-10-21 "desktop fixer" on this
  Mac and never pushed (`~/cloud-test/reports/desktop-fixer-2026-10-21.md`).
  The pushed branch grew 16 commits from the same parent on the Linux box
  (ogre). Merge base: `13fd7ca56`. Side by side:

| Local (unpushed) | Pushed twin | Still needed? |
| --- | --- | --- |
| `ca6acde84` the fake web signs and checks node signatures v2 | `0ac93b53c` does the same (v2 both ways, the four pinned vectors, the replay guard, `node-heartbeat-stale`, the kill switch, 502/400 mapping) and also changes `cloud_show.rs` (9 lines, the error classification test) | **No.** Drop it. |
| `fb23cdbd1` hourly limits leave out creates the node never took | `17c944b95` does the same (and adds a `prepare_session` test for `429 cloud-show-limit`) | **No.** Drop it. |
| `6104d1d72` `smoke:cloud-solo` builds the backend with an async `prebuildDevBackend`, so its in-process fake web isn't deaf for 140 s (lane 3 F4) | none. `origin/plan-184-videorc-cloud` has no `prebuildDevBackend` (`git grep` empty); `010e702b5` only raised the Linux prebuild limit to 45 min | **Yes.** |
| `b9bb62fee` a show the runner holds stays visible and fed whatever the switch or rollout says: the remembered show (`app_settings` row `cloud.openShow`), `launch_check_due`, Go Live feeds a held show instead of opening direct legs beside it, the `VIDEORC_CLOUD_SOLO_ROLLBACK=1` smoke variant, 6 tests | `5bd26a89a` covers one third: the launch check also runs for a paid plan whose cloud block says off. No remembered show, no Go-Live rule (`git grep openShow\|remembered` is empty on the pushed branch) | **Yes, the other two thirds.** Rebuild on top of `5bd26a89a`; don't cherry-pick blind, both edit the same launch check in `cloud_show.rs` and `main.rs`. |
| `434db330c` the cloud copy loads with the surfaces that show it (`cloud-toasts.ts` eager, `cloud-show-view.ts`, `cloud-view.ts` lazy); −1,850 gzip from the eager bundle | none (the pushed branch has only `cloud-view.ts` and `cloud-test-outputs.ts` in `lib/`) | **Yes.** See the budget fact below. |
| `7002aa613`, `95fbdce96` plan 184 Progress rows (security review, v2 smoke, async prebuild, rollback visibility, renderer budget) | `b720a79d6` adds the Linux round's rows | **Yes, as text**: merge the rows into one table. |

- **The desktop fixer's open items** (its report, "Blocked or open"):
  item 4, the `destinationsSet` / `restarts` contract, is done on the pushed
  branch (`1e7d406c3`, plus `612c511a4` for `holdImageSet`). Items 2 and 3
  are open: Go Live while videorc.com is unreachable and a show is
  remembered still streams directly (D6), and two copy lines are wrong
  while a show is held with the cloud off (U4).
- **The seam, as built** (`origin/plan-184-videorc-cloud`,
  `crates/videorc-backend/src/recording.rs`):
  - `start_session_with_timeline` resolves targets, then
    `prepare_cloud_stream_targets(&state, &session_id, &params,
    stream_resolution)` returns a `CloudSeam { stream_targets, skipped,
    platform_rows }` (`recording.rs:3292-3302`, `21816`). In cloud mode the
    platform targets become one `StreamTarget` per orientation,
    `target_id` `videorc-cloud-horizontal` / `videorc-cloud-vertical`
    (`CLOUD_FEED_TARGET_PREFIX`, `recording.rs:21777`; tested at
    `22700-22714`), label `CLOUD_TARGET_LABEL`.
  - The platform rows are appended to the runtime after the feed and
    skipped entries, so FFmpeg leg positions stay exact
    (`recording.rs:4991-4995`); `apply_cloud_leg_states` (`22589`) lands
    the runner's leg states on them.
  - `StreamTarget` gained `tls_verification: Option<FeedTlsVerification>`
    (`11549-11595`): `tls_verify=1` plus `ca_file` as a fifo `format_opts`
    dictionary, a tee slave's options, or CLI args (plan 184 C1c).
  - `start_cloud_resume_session` sets `SessionPurpose::CloudResume`
    (`3118-3128`); a resume needs no ready target (`3276-3285`).
  - `release_cloud_show_after_failed_start` runs when the start fails
    (`3142-3144`).
  - The raw path (Linux, weak Windows): the branch gave the cloud feed's
    tee slave a `fifo_options` recovery set, then every RTMP slave
    (`6c10dc8bf`, `332e13fc2`, `994523806`; `FIFO_RECOVERY_OPTIONS` at
    `18002`). **Main did the same work independently** (below).
  - RPCs: `cloud.status`, `cloud.settings`, `cloud.settings.set`,
    `cloud.allowance.refresh`, `cloud.show.resume`, `cloud.show.end`,
    `cloud.selftest.run`; event `cloud.state`.
  - UI: `CloudSection` is rendered inside `GoLivePanel`
    (`go-live-panel.tsx:157` on the branch). Its copy as built: title
    "Videorc Cloud", switch "Stream through Videorc Cloud", description
    "Your stream stays on air if this computer drops.", row "Test Videorc
    Cloud". The Resume notice: "You're still live through Videorc Cloud."
    / "Viewers see Be right back. The stream ends in 27 min unless you
    resume." Toasts: "Videorc Cloud is part of Videorc Premium.", "Videorc
    Cloud is full right now. You're streaming directly from this
    computer.", "You've used this month's cloud hours. They come back
    Nov 1.", "Videorc Cloud restarted your show. Your platforms reconnect
    in a few seconds.", "Your livestream ends in 60 min. A Videorc Cloud
    show runs 12 hours at most." (`lib/cloud-view.ts` on the branch).
- **Measured on 2026-10-21** (`~/cloud-test/reports/lane-1-2026-10-21.md`,
  section 4, M4, 720p30): Go Live to live 5.5 s; feed cut to hold 1.55 to
  1.63 s; back 3.0 to 5.1 s after the network; app killed to hold 1.6 s;
  Resume click to live 5.8 to 7.8 s; largest receiver gap 34 ms; hold card
  coverage 99.6 to 100%; Stop 92 to 139 ms. On Linux (ogre) ten runs in a
  row passed (plan 184 Progress, "Cloud test fixes (desktop)").
- **The branch's CI**: every push to #727 runs paid CI; #727 was red on
  `cargo audit --deny warnings` for zbus advisories inherited from main
  ([[videorc-cloud-version]]). The branch's own advisory
  (RUSTSEC-2026-0383, `webpki-root-certs` 1.0.9) is fixed (`f1e8f8df4`).

### Main, where the seam must land now

Desktop `origin/main` `d00550ea1`, 486 commits past the base, 81 of them
touching `recording.rs` (now 52,826 lines; the branch's is 41,876).

- **The seam is intact.** `start_session_with_timeline`
  (`recording.rs:4238`) still ends its target resolution in
  `let stream_targets = stream_resolution.ready;` /
  `let skipped_targets = stream_resolution.skipped;` (`4467-4468`), and
  `build_stream_runtime(&stream_targets, &skipped_targets,
  stream_tee_has_recording_leg)` feeds `StreamTargetsSnapshot` (`6731-6739`).
  `StreamTarget` is at `15056`, `StreamTargetResolution` at `15082`.
- **`StreamTargetsSnapshot` moved** into
  `crates/videorc-backend/src/streaming.rs:466`; `StreamTargetRuntime`
  (`streaming.rs:440`) gained plan 218's per-leg overflow count with
  `skip_serializing_if` (`449-454`). `recording.rs:2618` builds
  `crate::streaming::StreamTargetsSnapshot`.
- **Plan 161 already landed on main for the raw path**: `rtmp_tee_leg`
  gives every tee slave its own `fifo_options` from
  `RTMP_LEG_FIFO_RECOVERY_OPTIONS` (`recording.rs:22827-22834`, `22962-22976`;
  PR #917 `559c1d5be`), and #990 `e2fbf348e` makes a reconnected leg read
  as resumed. So the branch's `6c10dc8bf`, `332e13fc2` and `994523806` are
  **duplicates on main**, and the branch's `FIFO_RECOVERY_OPTIONS` must not
  be ported; the cloud slave reuses main's constant plus the TLS dictionary.
- **Plan 218 is merged** (#1186, 2026-11-05): a stream leg that overflows
  gets `stream-leg-overflow` events and the "Falling behind" badge, the
  stream bitrate steps down on a thin uplink, and `stream-health-attribution.ts`
  names `uplink` and `choppy`. In cloud mode the one feed leg is the leg that
  overflows, so this copy will name "Videorc Cloud" as the destination
  (P6 checks the words).
- **Plan 217 is PLANNED, not started** (`plans/217-…`, Status): split-output
  sessions would run two FFmpeg processes, the stream process keeping
  `RTMP_LEG_FIFO_RECOVERY_OPTIONS`, `StreamLegMonitor` and per-leg health.
  The cloud feed is a target like any other, so it rides in the stream
  process; `cloud_platform_rows` and `apply_cloud_leg_states` must follow
  the stream process's snapshot. Plan 217 did not merge (PR #217 is an
  unrelated 2026 cadence fix); this plan ports first (D3).
- **Also changed under the seam**: `bridge_compositor_ffmpeg_args_with_encoder`
  now has an `_and_replay` twin (`22043`, `22065`; plan 181's replay buffer),
  `append_bridge_copy_flv_output` is at `22767`, `ffmpeg_args_with_encoder`
  at `23029` with its `_and_replay` twin, `validate_outputs` at `25354`,
  `ready_stream_destination_counts_by_orientation` at `25326`,
  `apply_provider_output_plan_to_ready_targets` at `26083`,
  `build_stream_url` at `26921`, `resolve_stream_target` at `26986`,
  `validate_stream_publish_url` at `27031`, `resolve_stream_targets` at
  `27131`, `build_stream_runtime` at `28009`, `BRIDGE_FFMPEG_LOGLEVEL` at
  `28729`. Plans 205, 212, 198, 219 and the ISO work added code around the
  compositor and sources, not the target list.
- **`SessionPurpose`** on main is `Capture | PerformanceCheck`
  (`protocol.rs:1572-1576`). The branch adds `CloudResume` (serde-skipped).
  `websocket_handler_execution_policy_inventory_is_exhaustive`
  (`main.rs:17508`) pins the session-lifecycle RPC list;
  `cloud.show.resume` must join it (the branch did this in `97a5fb4a9`).
- **Entitlements** on main still read `is_premium` only
  (`entitlements.rs:52-111`); the branch's `plan` and `cloud` blocks
  (plan 185 T4, `5f7cf89fe`) are additive.
- **The renderer budget**: the eager gzip ceiling is 475,000 and main
  measures 471,209 ([[videorc-renderer-budget-gzip-drift]], 2026-11-03). The
  cloud branch added about 3,500 gzip to the eager bundle before the local
  split and about 1,650 after it (the desktop fixer's numbers, measured
  against 0.9.143). So the port lands at roughly 474,700 without
  `434db330c` and 472,850 with it. UNVERIFIED until P8 builds; a miss is
  the owner's call, never a ceiling raise by an agent.
- **X**: main shipped the X Livestream API migration in 0.20.3
  ([[videorc-x-livestream-api-migration]]). The branch's X code is
  pre-migration; the branch doesn't touch `x_live.rs`, so the port simply
  keeps main's.
- **Scripts on main** that this plan relies on exist in `package.json`:
  `smoke:multistream`, `smoke:multistream:vertical`, `smoke:stream-leg-eof`,
  `smoke:streaming-secrets`, `smoke:youtube-quota`, `smoke:recording-matrix`,
  `smoke:recording-studio`, `smoke:record-latency`, `smoke:stream-thin-uplink`,
  `smoke:encoder-bridge`, `smoke:local-gates`, `audit:rust`, `test:scripts`.
  `smoke:cloud-solo` exists only on the cloud branch and is not part of
  `smoke:local-gates` (it needs the private checkout).
- **The trial merge** of the branch into main conflicts in: `Cargo.lock`,
  `app-shell.tsx`, `studio-tab.tsx`, `use-studio.tsx`,
  `studio-provider.integration.test.ts`, `stream-manager-stats.ts` and its
  test, `user-error.ts`, `backend-rpc-contract.ts`,
  `protocol-contract-fixtures.test.ts`, `main.rs`, `protocol.rs`,
  `recording.rs`, `state.rs`, `package.json`,
  `protocol-fixtures/high-risk-contracts.json`, `oauth-smoke-launch.test.mjs`
  and `smoke-stream-leg-eof-app.mjs` (the orchestrator's trial,
  2026-11-08).

### The web (private)

- Branch `plan-185-max-and-cloud` at `5a75d03d`: 50 commits ahead of web
  `origin/main` `3c8d1593`, 18 behind. Both sides changed 19 files:
  `app/multistream/page.tsx`, `app/premium/page.tsx`, `app/terms/page.tsx`,
  `components/faq.tsx`, `footer.tsx`, `premium.tsx`, `pricing.tsx`,
  `db/schema.ts`, `docs/ai-gateway.md`, `lib/ai/capabilities.ts`,
  `lib/metadata.ts`, `lib/multistream-guide.ts`, `lib/og-image.tsx`,
  `lib/structured-data.ts`, `public/llms.txt` and four tests. Marketing
  pages mostly; `db/schema.ts` and `lib/ai/capabilities.ts` matter (P10).
- Plan 185 Progress: T1, T2, T3, T5 and T7 done in code; T6 (launch) not
  started; the privacy page, the Terms and the Creem test-mode pass are
  owed at launch. Lane 4 F3 (the late grant) is fixed (`97997240`). **Lane
  4 F2 (a refund ends the plan whatever was refunded) is open**: it needs
  the owner's charging decision and a Creem test-mode run (L5).
- `docs/cloud.md` holds the env (`VIDEORC_CLOUD_DISABLED`, `VIDEORC_CLOUD_USERS`,
  `VIDEORC_CLOUD_PUBLIC`, `VIDEORC_CLOUD_NODES`, `VIDEORC_CLOUD_NODE_SECRETS`,
  `VIDEORC_CLOUD_SHOW_SIGNING_KEY`, `VIDEORC_CLOUD_SRT_LATENCY_MS`,
  `VIDEORC_OWNER_USER_IDS`, `VIDEORC_CLOUD_MONTHLY_BUDGET_USD`, `CRON_SECRET`),
  "Stored and not stored", "Rollback", and "When the web can't hear a node"
  (the reaper asks `GET /v1/health` before ending a silent show; web
  `c99a611c`, `56c1b503`).
- Placement is least-loaded only (`lib/cloud/placement.ts:3, 40-43`); there
  is no region preference. Crons: `/api/cloud/reaper` every minute,
  `/api/cloud/reconcile` daily (`vercel.json`).
- Costs, margins and prices live only in plan 185 and
  `lib/cloud/cost-inputs.ts`. They stay there.

### The runner and node agent (private)

- `videorc-cloud` `phase-1-runner` at `b0557c9`; `origin/main` is the
  empty base, so there is nothing to port. No `.github/`, no CI.
- Workspace: `crates/protocol`, `runner`, `node-agent`, `devtool`; `dev/`
  (`run-local.sh`, `measure-hold.sh`, `analyze.py`, `gen-certs.sh`,
  `mediamtx.yml.tpl`); `deploy/systemd/videorc-node-agent.service` and
  `agent.env.example` (`73c34a6`, runners outlive the agent). No `ops/`
  (plan 184 I1 wanted `ops/` and `ops/check-node`).
- Since the Mac test run: platform keys never reach a leg FFmpeg's argument
  list (`502d37b`), the restarted runner gets its hold image back
  (`be842ef`), a certificate pin for custom RTMPS servers (`5410611`), the
  systemd unit.
- `docs/wire-notes.md:351-352` still says `GET /v1/health` is "Not used
  yet". The web's reaper uses it now (O4 fixes the note).
- `docs/spike-runner-2026-10.md:176-200`, "What waits for a Hetzner box":
  x264 vs NVENC per box, S0d costs, the lossy leg, RTMPS from the real
  desktop on a real node, the 12 h cap in real time, TLS with a real
  certificate. "Known gaps": the decoder respawns every 250 ms to 1 s during
  a hold (292 spawns in 5 min), the vertical output group has no harness
  run, the hold image path has no harness run.
- **Lost**: the LiveKit rooms spike branch `spike/s0a-rooms` (`379f9d4`)
  was never pushed; the worktree `~/projects/videorc-cloud-wt-rooms` is
  gone and the object is not in the clone (`git cat-file -t 379f9d4` fails).
  Phase 2 (plan 224) rebuilds it from the memory note's numbers.

### The test run of 2026-10-21

Reports in `~/cloud-test/reports/`: lanes 1, 3, 4 and 5, the desktop fixer
and the web fixer. Lanes 2 (chaos and soak) and 6 (UI by eye) have empty
evidence directories and no report: they never ran on the Mac. The Linux
round (ogre, 2026-10-20) covered the chaos scenarios (plan 184 Progress,
"Cloud test fixes (desktop)"). The owner's by-eye check in both themes is
still owed everywhere plan 184 says so.

The "one run in four misses EOF" question: on 2026-10-17 one `smoke:cloud-solo`
run had both receivers' FFmpegs never see the publisher's EOF although the
runner's legs exited 0 (plan 184 Progress, C8). The receivers log at info
since; the ten Linux runs and the four Mac runs on 2026-10-21 saw EOF every
time. Not reproduced since 2026-10-17. Platforms don't wait for EOF: YouTube
ends an auto-stop broadcast about a minute after video stops (Outside facts).
A1 keeps it as a soak metric.

## Outside facts (checked 2026-11-08)

- **YouTube.** Restream ("Stream live to 30+ platforms simultaneously from
  our cloud studio"), StreamYard, Upstream, Gyre and Grabyo are on YouTube's
  verified encoders list
  ([help](https://support.google.com/youtube/answer/2907883)), so a cloud
  relay pushing to YouTube's ingest is an ordinary verified-encoder shape.
  With `enableAutoStop` on, YouTube "automatically ends the broadcast about
  a minute after you stop transmitting video"
  ([life of a broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)).
  A runner on hold never stops transmitting, so auto-stop can't fire during
  a hold. The page says nothing about a brief data drop and return.
- **Twitch.** The ToS page needs a browser (both `twitch.tv/p/…/terms-of-service`
  and `legal.twitch.com` return a shell with no article text), so the exact
  §11 wording is UNVERIFIED today. Secondary sources agree on the shape:
  simulcasting is allowed; the Twitch experience must be no worse than
  elsewhere; don't send viewers away from Twitch; the written terms still
  name third-party services that merge other platforms' chat onto the
  Twitch stream, and Twitch's CEO said in February 2026 that this is no
  longer enforced ([upstream.so](https://upstream.so/blog/twitch-allows-unified-chat-simulcasting-rules/),
  [Lightstream](https://golightstream.com/how-to-comply-with-twitch-tos-when-simulcasting/)).
  A relay changes none of this: the cloud sends Twitch the same picture.
  The Community Guidelines allow "a temporary 'Be Right Back' static image"
  and forbid static images or VODs whose core purpose is Drops farming
  ([esports.gg quoting Twitch](https://esports.gg/news/streamers/twitch-to-start-combatting-drop-farming-and-other-spam-content/),
  [Insider Gaming](https://insider-gaming.com/twitch-drops-campaigns-rules/)).
  D12's 30-minute hold limit is what keeps a hold "temporary"; the Safety
  Center page itself needs a browser (UNVERIFIED direct).
- **Kick.** Kick's help centre tells streamers how to stream through
  Restream, Castr and Restreamer, with no conditions
  ([help](https://help.kick.com/en/articles/7135578-how-to-connect-your-kick-stream-to-restream-service)).
  The partner rules say "Avoid mirror streams, blank streams, or
  pre-recorded content" and nothing about static images or multistreaming
  ([rules](https://help.kick.com/en/articles/7901645-grounds-for-revoking-or-refusing-verification-or-the-kick-partner-program)).
  A long hold is a blank stream; the hold limit covers it.
- **X.** Live Studio (in Creator Studio) has replaced Media Studio Producer.
  A broadcast whose source stops sending video goes `TIMED OUT`: "Your
  livestream ended automatically because the source stopped sending video.
  Timed-out livestreams cannot be restarted and must be recreated"
  ([Live Studio](https://help.x.com/en/using-x/live-studio); the Producer
  page returns 403 to a fetch). The Livestream API models a persistent
  source and an ephemeral broadcast bound to it
  ([docs](https://docs.x.com/livestream-api/introduction)). So on X the
  cloud hold is the only thing that keeps a broadcast alive through a
  computer drop, and plan 184 D13's open check ("what X does when the RTMP
  stream stops without the API call") is answered: X ends it by itself.
  Third parties cite a 24 h cap (UNVERIFIED on X's own pages).
- **Facebook** (not a Videorc destination; here for the rules only).
  Meta's spec page lists RTMPS and an 8-hour maximum per broadcast; the
  page's current text didn't render to a fetch (UNVERIFIED direct),
  secondary sources agree ([Restream](https://support.restream.io/en/articles/4798898-stream-to-a-facebook-group),
  [Upstream](https://upstream.so/live-streaming-limits/)).
- **Hetzner locations.** Dedicated (Robot) servers exist in Falkenstein,
  Nuremberg and Helsinki only; Ashburn (VA), Hillsboro (OR) and Singapore
  are cloud-only, and "you cannot order dedicated root servers" there
  ([locations](https://docs.hetzner.com/cloud/general/locations/)). A US
  node is a cloud server with metered traffic, or another provider (D8).
- **Grafana Cloud Free**: 10k metric series, 50 GB logs, 50 GB traces,
  14-day retention, 3 users, community support
  ([pricing](https://grafana.com/pricing/)). Enough for two nodes (I4).
- **Versions.** libsrt 1.5.7 is the latest (released 28 Aug; 1.5.6 carried
  the CVE fixes) ([releases](https://github.com/Haivision/srt/releases)).
  MediaMTX 1.21.3 is the latest (25 Oct); the test run used 1.21.2
  ([releases](https://github.com/bluenviron/mediamtx/releases)).

## Decisions (⚑ = owner may override)

### D1. Videorc Cloud is on by default for every entitled account ⚑

- Recommendation: **on**, as plan 184 D11 says. The switch lives on the
  Livestream page; Go Live gets no new control.
- Why: the feature's value is the hold, and a hold only helps if it was on
  before the drop. A Premium user who never opened Setup still gets it. The
  fallback is silent and safe: when the cloud can't be reached, is full, or
  the hours are gone, Go Live streams directly and says why once.
- The cost of "on": every Premium Go Live spends cloud hours and node
  capacity. Plan 185 D4's allowance and the per-account 150% alert bound
  it. A beta cohort first (O2) tells us the real hours per account before
  it is on for everyone.
- Override: default off, with the switch and the Test row as the way in.

### D2. Port by re-applying commit groups on a fresh branch from main, not a rebase

- Recommendation: a new branch `plan-222-cloud-on-main` from `origin/main`,
  with the branch's work applied as about nine groups (P2 to P7), each a
  commit that compiles and passes its tests, in dependency order.
- **Where it lands (orchestrator, 2026-11-08):** the owner said "put all to
  that pr we have", so the port goes into #727 and no new PR opens. When P
  is done, slice P-land makes one merge commit on `plan-184-videorc-cloud`.
  - Its parents are the branch head (after R) and the port head.
  - Its tree is the port's tree, exactly.
  - Nothing is force-pushed, and the old history stays reachable.
  - #727's diff against main is then the port and nothing else.
  - From then on, `plan-184-videorc-cloud` is the desktop integration
    branch for plans 222 to 225.
- Why not a rebase: 49 commits would each stop in `recording.rs`, `main.rs`
  and `use-studio.tsx`, and three of them (`6c10dc8bf`, `332e13fc2`,
  `994523806`) redo work main already has. A group-wise re-apply writes
  each hunk once, at the lines main has now, and drops the duplicates.
- Why not a merge: 17 conflicting files resolved in one commit is
  unreviewable, and the duplicates would still be merged.

### D3. Port before plan 217, and tell plan 217 what moved

- Recommendation: this plan goes first. Plan 217 is not started; its design
  keeps the stream legs in one process with `StreamLegMonitor`, which is
  exactly where the cloud feed leg lives. P2 leaves a comment at the seam
  naming plan 217, and the Handoff tells plan 217's executor that
  `cloud_platform_rows` and `apply_cloud_leg_states` must follow the
  stream process's snapshot.
- Why: two large edits to the same 300 lines in parallel means one of them
  is redone.

### D4. Phase 1 launches on RTMPS; SRT (C1b) follows the beta ⚑

- Recommendation: the cohort goes live on RTMPS. C1b (L1) is built after
  the port passes its smokes and before the cloud opens to every Premium
  account.
- Why: plan 184 D10 already says RTMPS first. The node and web halves of
  C1b are built (runner `2b10405`, `d636ba2`; web `5cbcbce2`, `7d8312b9`);
  the desktop half needs an FFmpeg rebuild on three platforms and a
  notarization preflight change (`docs/cloud/spike-srt-2026-10.md`,
  section 5). That is a week that shouldn't sit between the port and the
  first real users. SRT's gains (a drop under 5 s loses nothing, feed
  ready in 0.4 s instead of 1.6 s, better loss recovery over long paths)
  matter most for US streamers (D8), who come after the EU beta.
- Override: C1b before the cohort.

### D5. Stream quality above 1080p60 streams directly in Phase 1 ⚑

- Recommendation: a session whose stream quality is the YouTube 4K30
  profile (`entitlements.rs:22`) streams directly with one toast: "Videorc
  Cloud carries up to 1080p60 for now. You're streaming directly from this
  computer." Reason `cloud-quality` (Wire shape). Up to 1080p60 goes
  through the cloud.
- Why: the runner re-encodes with x264 on the node's CPU (plan 184 D5);
  one 4K30 show would take the CPU of several 1080p60 shows, and S0a never
  measured 4K. This is a capability limit of the first nodes, not a tier
  rule: Premium still sells no resolution, and the direct path keeps 4K.
- Revisit when S0d (I6) has 4K numbers or a GEX45 with NVENC is in service.

### D6. A remembered show plus an unreachable videorc.com: Go Live streams directly ⚑

- Recommendation: keep today's behaviour (the desktop fixer's item 2).
  When the desktop remembers a show it doesn't hold, and videorc.com can't
  be reached to say whether that show is still live, Go Live streams
  directly after one toast: "Videorc couldn't check your last cloud show.
  You're streaming directly from this computer."
- Why: blocking Go Live whenever the web is down would stop all streaming
  during any web outage. The risk the other way (two publishers on one
  key while the runner still holds the show) exists only in the minutes
  between the Mac dying and the web outage starting; the hold limit ends
  the runner's side within 30 minutes.
- Override: refuse Go Live until the web answers.

### D7. A lost show falls back in seconds, not minutes (L3)

- Recommendation: when the desktop's control socket is gone and its feed
  leg has failed for 20 s and `GET /api/cloud/shows/current` still says
  live, the desktop reports it (`POST /api/cloud/shows/:id/lost`); the web
  probes the node's `GET /v1/health` at once and ends the show
  `node-unreachable` when the node doesn't answer; the desktop then opens
  direct legs with the toast "Videorc Cloud lost your show. Stop, then go
  live again to stream directly from this computer." (existing copy).
  Without the report the reaper takes up to 5 minutes plus a cron tick.
- Why: a node death means every platform is dark until the fallback. Five
  minutes dark on YouTube ends the broadcast (auto-stop after about a
  minute); twenty seconds doesn't. C2's rule stands: direct legs open only
  after the web confirms the show gone.

### D8. EU-first stays; a US node is a measured decision ⚑

- Recommendation: launch on the EU node(s). Measure every Test row and
  every show's first-frame time and hold count by region (O5). Add a US
  node when either holds for two weeks: more than a quarter of cloud
  shows start from US accounts, or the US median Test RTT is over 120 ms
  with more than one unexplained hold per show-hour. Hetzner's US sites
  are cloud-only with metered traffic (Outside facts), so the US node is a
  cloud server there or a bare-metal box elsewhere; the owner picks the
  provider when the data says so.
- Why: RTMPS over TCP at 6 Mbps works at 150 ms RTT; what hurts is loss
  recovery on a long path, which SRT (D4) addresses before a second
  region does. One region keeps I1 to I5 to one shape for the first
  cohort.

### D9. The hold does not count against "blank stream" rules, with the limit on

- The default hold is 30 minutes (plan 184 D12, owner-decided). Twitch
  allows a temporary Be right back image, and Kick says to avoid blank
  streams (Outside facts). The limit is what makes a hold temporary.
  Nothing changes; this plan records that the rules were re-checked.

### D10. Verification stays proportionate

- Phase R: node tests of the touched harness files and `pnpm test:scripts`.
- Phase P: the full Phase 1 gate list once, at the end, plus
  `smoke:cloud-solo` ten times in a row (A1's flake gate).
- Later phases: the smoke that proves the slice, and the bundle once before
  the kill switch flips for the cohort.

## Wire shape (additive)

Plan 184's Wire shape stands. This plan adds, every field optional and
every Rust `Option` with `skip_serializing_if = "Option::is_none"`:

- **`POST /api/cloud/shows`** (desktop → web) body gains
  `"preferredRegion": "eu" | "us"` (optional; the desktop sends the region
  its last Test measured as fastest, else nothing). The answer's `show`
  gains `"region": "eu"`. Placement prefers that region when a node there
  has room, else any node (O5).
- **`POST /api/cloud/shows/:id/lost`** (desktop → web, bearer): `{ "at":
  "…", "feedFailedSeconds": 20, "controlLost": true }` → `{ "show": {…} }`
  with the show's status after the probe (`live` or ended with
  `endReason`). The web probes `GET {agentUrl}/v1/health` once, 8 s. The
  web ends the show only when the node doesn't answer (D7).
- **`cloud.selftest.run`** result gains `"nodeId"`, `"region"` and
  `"handshakeMs"` (the time to the first RTMPS byte accepted) for the Test
  row's description: "Videorc Cloud works from here. Upload 6.1 of 6 Mbps ·
  Helsinki, 48 ms."
- **`CloudFallbackReason`** (`cloud_show.rs:233`, mirrored in
  `backend-rpc-contract.ts` and `backend.ts`) gains `cloud-quality` (D5)
  and `cloud-unchecked` (D6). Neither enum has shipped, so this is
  additive to nothing.
- **`cloud.state`** gains `"allowancePast": { "seconds": 720 }` while a
  show runs past the month's hours (U5's copy reads it).
- Everything new lands in `apps/desktop/src/shared/backend-rpc-contract.ts`
  and `protocol-fixtures/high-risk-contracts.json`, or main retires the
  pump ([[videorc-strict-contract-new-status-field-trap]]).
- Nothing adds a value to `captions.reasonCode` or `preferredTransport`.
  Max stays `tier: "premium"` plus `plan`.

## Phases and slices

Order: R → P → L → I and O (in parallel with L, owner-paced) → Y → U → A.
Each slice names its repo and ends with "Done when".

### Phase R: branch recovery (desktop, `plan-184-videorc-cloud`)

- **R1. Keep the pushed branch as the base.** Nothing is force-pushed. The
  7 local commits are read from the tag `backup/plan-184-local-2026-10-21`
  and re-applied as new commits on `0e5bade39`.
  - Done when `git log origin/plan-184-videorc-cloud..HEAD` shows only new
    commits and the tag is untouched.
- **R2. Drop `ca6acde84` and `fb23cdbd1`.** Their pushed twins `0ac93b53c`
  and `17c944b95` cover them (What exists). Check the one thing the local
  pair had that the pushed pair may lack: the four pinned signature vectors
  (`df450ce6…`, `d45deada…`, `f7913642…`, `7a9b7d28…`) in
  `scripts/lib/fake-cloud-web.test.mjs`.
  - Done when `node --test scripts/lib/fake-cloud-web.test.mjs` passes and
    greps for all four vector prefixes find them.
- **R3. Re-apply `b9bb62fee` on top of `5bd26a89a`**: the remembered show
  (`app_settings` row `cloud.openShow`, no token or key), `launch_check_due`
  extended with "or this desktop remembers a show", Go Live feeds a held
  show whatever the switch, the rollout or the hours say, asks the web
  first about a remembered show it doesn't hold, fails signed-out with the
  existing "Sign in to Videorc to resume the stream.", and the
  `VIDEORC_CLOUD_SOLO_ROLLBACK=1` smoke variant. The six tests come along.
  Review pass (fit 9) on this commit: it decides when direct legs may open.
  - Done when `cargo test -p videorc-backend cloud_show` passes with the six
    tests present and `smoke:cloud-solo` passes once with
    `VIDEORC_CLOUD_SOLO_ROLLBACK=1` (the one smoke this phase runs; it is
    the proof of the rule).
- **R4. Re-apply `6104d1d72`** (the async `prebuildDevBackend`, `skipPrebuild`,
  the cloud smoke prebuilding before its web listens) and `434db330c` (the
  `cloud-toasts.ts` / `cloud-show-view.ts` / `cloud-view.ts` split).
  - Done when `pnpm test:scripts` passes, `pnpm build` passes and
    `index.html` lists the same eager chunks as before.
- **R5. Merge the Progress rows.** `7002aa613`'s and `95fbdce96`'s rows
  (the lane 5 security review row word for word, v2 in the smoke, the
  async prebuild, a show stays visible after a rollback, the renderer
  budget) join `b720a79d6`'s table. Add rows for R2's drops.
  - Done when the table has one row per fix and no duplicate.
- **R6. No push yet.** A paid CI run on the 10-16 base would only report
  reds main has already fixed. The first push is P-land's.
  - Done when R1 to R5 are committed locally on `plan-184-videorc-cloud`,
    on top of `0e5bade39`.

### Phase P: the port onto main (desktop, new branch `plan-222-cloud-on-main`)

Each group is one commit (or two) that compiles. Read the branch's hunks
with `git diff 4c7980673 origin/plan-184-videorc-cloud -- <paths>` and
place them at main's lines. Where main already has the behaviour, drop the
hunk and say so in the commit message.

- **P1. Cut the branch.** `git worktree add ~/projects/videorc-wt-222
  -b plan-222-cloud-on-main origin/main`. No new PR: the port lands in
  #727 (D2, P-land).
  - Done when the worktree builds `pnpm typecheck` clean before any change.
- **P2. New modules and deps.** `cloud_show.rs` whole (6,023 lines, no
  conflict); `Cargo.toml` (+1 dep) and the Cargo.lock entries
  (`webpki-root-certs` at 1.0.10 or later); `videorc_api.rs` (+116: the
  cloud routes on the existing client); `state.rs` (+7); `entitlements.rs`
  (+165, the `plan` and `cloud` blocks); `protocol.rs` (+165:
  `SessionPurpose::CloudResume`, the cloud status and settings types;
  audit every `Option` for `skip_serializing_if`, the branch has 9 Options
  and 8 skips in this file's diff). `backend_authority.rs` (+6: a `.test.`
  RPC segment is smoke-only; `cloud.selftest.run` is deliberately not one).
  - Done when `cargo build -p videorc-backend` passes with `cloud_show`
    not yet wired (dead-code warnings allowed in this commit only).
- **P3. `main.rs` wiring.** The branch's 30 hunks: `mod cloud_show`, the
  runtime init in `run_backend`, the execution-policy lists (session-start
  and lifecycle policy for `cloud.show.resume`; the RPC policies for the
  seven `cloud.*` methods), the dispatch in `handle_text_message_with_role`
  (+114), the account refresh reading the `cloud` block (+207), the launch
  check (R3's `launch_check_due`), and `cloud.show.resume` in the
  `websocket_handler_execution_policy_inventory_is_exhaustive` list
  (`main.rs:17508`).
  - Done when `cargo test -p videorc-backend -- websocket_handler_execution_policy_inventory_is_exhaustive cloud_show`
    passes.
- **P4. The `recording.rs` seam.** In this order, each at main's line:
  1. `StreamTarget` (`15056`) gains `tls_verification`; `FeedTlsVerification`,
     `tls_verification_dict`, `tls_verification_cli_args` follow it.
  2. `start_session` (`4124`): `release_cloud_show_after_failed_start` on
     a failed start; `start_cloud_resume_session`.
  3. The resolution block (`4442-4468`): a resume needs no ready target;
     `prepare_cloud_stream_targets` replaces the two `let` lines; the
     `CloudSeam` destructure; `stream_url` from the feed targets.
  4. `build_stream_runtime` (`6731-6739`): `stream_runtime.extend(cloud_platform_rows)`
     after the call, before the snapshot, with the plan 217 comment (D3).
  5. The encoded bridge: `append_bridge_copy_flv_output` (`22767`) takes
     the TLS dictionary in the fifo's `format_opts` for a cloud target
     only; `bridge_compositor_ffmpeg_args_with_encoder` and its
     `_and_replay` twin pass the targets through unchanged (check that the
     branch's three hunks there were only the feed's TLS options and the
     `level+info` log level, which main already has).
  6. The raw path: `rtmp_tee_leg` (`22962`) takes an optional TLS
     dictionary for a cloud slave, using main's
     `RTMP_LEG_FIFO_RECOVERY_OPTIONS`. **Drop** the branch's
     `FIFO_RECOVERY_OPTIONS`, `use_fifo` slave wrapper and the
     `level+info` raw-path change: main has them (`559c1d5be`,
     `e2fbf348e`). Keep the double-escaping of the TLS dictionary (the
     branch's `6c10dc8bf` message explains it).
  7. `validate_outputs` (`25354`) and `ready_stream_destination_counts_by_orientation`
     (`25326`): the resume's exemption.
  8. After `build_stream_url` (`26921`): the cloud block (+147 and +1,340
     lines: `CLOUD_FEED_TARGET_PREFIX`, `prepare_cloud_stream_targets`,
     `cloud_feed_targets`, `cloud_feed_target` with
     `ingest_url_problem`, `cloud_feed_roots_pem`, `cloud_feed_extra_ca_pem`,
     `cloud_feed_tls_verification`, the C6b `CloudTestFeedPusher`,
     `apply_cloud_leg_states`, and their tests).
  9. `010e702b5` (unit tests never probe a GPU unless
     `VIDEORC_TEST_HARDWARE_PROBE=1`): check whether main has it; port only
     if not.
  - Done when the branch's `recording.rs` cloud tests pass on the port
    (`cargo test -p videorc-backend cloud_feed`, `apply_cloud_leg_states`,
    the swap test) and main's `rtmp_tee_legs_reconnect_through_their_own_fifo`
    and `build_stream_runtime_*` tests still pass.
- **P5. Shared contracts.** `backend-rpc-contract.ts` (+204),
  `backend.ts` (+198), `live-dashboard.ts` (+77, the cloud block with
  `feedKbps`), `protocol-contract-fixtures.test.ts`,
  `protocol-fixtures/high-risk-contracts.json` (+239),
  `protocol-fixtures/README.md`. Plus this plan's Wire shape additions.
  - Done when `pnpm --filter @videorc/desktop test -- protocol-contract-fixtures`
    and the Rust fixture round-trip test pass on both languages.
- **P6. The renderer.** `use-studio.tsx` (+260 on a 19,440-line file: the
  cloud context, Resume, the toasts), `studio-tab.tsx` (+49, the Resume
  notice), `go-live-dialog.tsx` and `go-live-dialog-host.tsx` ("Connecting
  to Videorc Cloud…" on the `starting` phase), `go-live-dialog-view.ts`,
  `cloud-section.tsx` into `go-live-panel.tsx`, `cloud-resume-notice.tsx`,
  the three `cloud-*view.ts` files from R4, `cloud-test-outputs.ts`,
  `state-labels.ts`, `session-start-failure.ts`, `user-error.ts`,
  `premium-upgrade.ts`, `account.ts`, `account-menu.tsx`, `sidebar.tsx`,
  `app-shell.tsx`, `live-dashboard-relay.ts`, `backendClient.ts`,
  `stream-manager-stats.ts` (+97; main's version changed for plan 218, so
  merge by hand: the cloud health label "Cloud · 6 Mbps" / "Be right back ·
  28 min left" / "Cloud resuming", and `feedKbps` when FFmpeg reports no
  bitrate), `studio-provider.integration.test.ts`. Then read
  `stream-health-attribution.ts` with the cloud leg in mind: when the one
  feed leg overflows, the words must name the upload ("Connection too
  slow"), never "Videorc Cloud could not receive"; add a test.
  - Done when `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and
    `pnpm --filter @videorc/desktop test` pass, and the cloud-view tests
    (341 + 96 lines on the branch) pass unchanged.
- **P7. Smokes and harness.** `scripts/smoke-cloud-solo-app.mjs`,
  `scripts/lib/fake-cloud-web.mjs` and `.test.mjs`,
  `scripts/lib/cloud-solo-gates.mjs` and `.test.mjs`,
  `scripts/lib/app-launcher.mjs` (R4's async prebuild; the Linux 45-minute
  limit), `package.json` (`smoke:cloud-solo`, and the two cloud globs added
  to `format` and `format:check`, merged into main's current globs),
  `oauth-smoke-launch.test.mjs`. The branch's Linux tweaks to
  `smoke-multistream-app.mjs`, `smoke-stream-leg-eof-app.mjs`,
  `smoke-recording-session.mjs` and `smoke-freeform-editor-app.mjs`
  (`0e5bade39`, `startSessionWhenScreenSettles`): check each against main's
  current file and port only what main lacks.
  - Done when `pnpm test:scripts` passes and `pnpm smoke:cloud-solo` passes
    once against runner `b0557c9` (or its current head) and the fake web.
- **P8. Docs and budget.** `plans/184-videorc-cloud.md` (whole, with R5's
  table and a "Ported in plan 222" line in Status), `docs/cloud/spike-srt-2026-10.md`,
  `docs/linux-dev-loop.md`. Also bring plans 183 and 221 to 225, and their
  `plans/README.md` rows, from `plan-221-premium-worth-paying`. P-land
  takes the port's tree exactly, so a file that exists only on the old
  branch disappears from #727. Then `pnpm build` and the renderer budget
  check.
  - Done when the eager gzip figure is written into the PR body with the
    ceiling (475,000) and the margin. Under 1,000 bytes of margin is a STOP
    (owner call).
- **P9. Gates at the end of Phase P** (Verification gates, Phase P list),
  then `smoke:cloud-solo` ten times in a row.
  - Done when every gate is green or its red is named as inherited, with
    main's run id, and the ten runs pass.
- **P-land. The port goes into #727** (the orchestrator).
  1. On `plan-184-videorc-cloud` (R's head), make one merge commit:
     `git commit-tree <port-head>^{tree} -p <R-head> -p <port-head> -m
     "Merge plan 222's port onto main into the cloud branch"`.
  2. Fast-forward the branch to it, and push. This is the first push, and it
     is a fast-forward, not a force-push.
  3. Update #727's title and body to "Plans 184 + 221–225 on main (DO NOT
     MERGE)", and point plan 184's Status at it.
  4. Then `gh pr checks 727` against main's last run of the same workflows.
  - Done when `git diff origin/main...origin/plan-184-videorc-cloud` equals
    `git diff origin/main...plan-222-cloud-on-main`, and the only reds on
    #727 are reds main has too, named in the PR body.
- **P10. The web port** (web, `plan-185-max-and-cloud`). Merge web
  `origin/main` into the branch (18 commits; a merge keeps #85's history
  intact). Resolve the 19 files: marketing pages keep main's SEO changes
  and the branch's Max/cloud copy behind `VIDEORC_MAX_ON_SALE` and
  `VIDEORC_CLOUD_PUBLIC`; `db/schema.ts` keeps both sides' tables and
  renumbers the branch's migrations after main's last; `lib/ai/capabilities.ts`
  keeps `d6b5d165`'s reason-code mapping (check whether main fixed the same
  bug since; if main's fix differs, keep one and its test).
  - Done when `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass
    on the merged branch and `tests/desktop-capabilities-contract.test.ts`
    still pins the closed set.
- **P11. The runner.** Nothing to port. Fast-forward `main` to
  `phase-1-runner` is the owner's merge at launch (I3 builds from it).
  - Done when `cargo test --workspace`, `cargo clippy --all-targets -- -D warnings`
    and `cargo fmt --check --all` pass at the head.

### Phase L: Phase 1 leftovers

- **L1. C1b, the desktop SRT feed** (desktop, after D4's timing). Build
  what `docs/cloud/spike-srt-2026-10.md` section 5 "Desktop" lists:
  libsrt 1.5.7 in `scripts/build-ffmpeg-macos.sh` with its checks and
  `preflight-macos-package.mjs`, the MPL-2.0 text and UDT notice in the
  bundle; the BtbN re-pin for Windows and Linux (`vendor/ffmpeg/*-pin.json`)
  to a build with libsrt 1.5.7; `srt://` in `validate_stream_publish_url`
  for the cloud feed only; the MPEG-TS fifo leg and tee slave
  (`pkt_size=1316`, `latency` in microseconds, `connect_timeout=1500`,
  `passphrase` and `pbkeylen=16` in options, never in the URL);
  `redact_stream_urls` learns `srt://`; the 3 s induction-handshake probe
  at start; leg health from the fifo's lines plus `state.feeds[].connected`;
  `smoke:cloud-solo` gains the SRT pass through a UDP relay and the
  passphrase in the leak scan. `smoke:recording-matrix` stays green.
  - Done when `smoke:cloud-solo` passes over SRT and over RTMPS (UDP
    blocked) on macOS, and `pnpm smoke:packaged` passes with the new
    FFmpeg.
- **L2. The feed leg under plan 218** (desktop). Prove the cloud feed with
  `pnpm smoke:stream-thin-uplink` shaped for one leg: the bitrate steps
  down, the runner's output stays at the show's settings, Stream health
  reads "Connection too slow" and the Cloud row, never a platform row.
  - Done when the smoke variant passes and the words are in a test.
- **L3. The lost show** (desktop + web; D7). Desktop: the 20 s rule and
  `POST /api/cloud/shows/:id/lost`; direct legs only after the web says
  ended. Web: the route, the health probe, `node-unreachable` as the end
  reason, a scenario test in the style of `tests/cloud-web-outage.test.ts`.
  Smoke: `smoke:cloud-solo` gains `VIDEORC_CLOUD_SOLO_NODE_DEATH=1`: SIGKILL
  the agent and the runner and black-hole the agent's port; the desktop
  must be direct within 30 s with one toast.
  - Done when the smoke variant passes and the fake web counts exactly one
    `lost` call.
- **L4. The 4K rule** (desktop; D5): `cloud-quality` fallback before the
  show is created; the toast copy above; a `prepare_session` test.
  - Done when a 4K30 stream quality streams directly with the reason and
    creates no show.
- **L5. Creem refunds** (web; lane 4 F2). The owner decides the charging
  rule (Open question 5). Then: a refund ends the plan only when it fully
  refunds the charge covering now; partial refunds and refunds of older
  periods log and change nothing; disputes still end the plan. Interval
  downgrades wait for the period end with `proration-none` if the owner
  says so. A Creem test-mode pass records which webhooks a yearly-to-monthly
  switch fires.
  - Done when `tests/billing-event-sequences.test.ts` covers the three
    refund shapes and the test-mode pass is written into plan 185.
- **L6. Runner tidy-ups** (runner). The decoder backs off to 2 s after the
  first minute of a hold (292 spawns per 5 minutes today); the vertical
  output group gets a harness run (`dev/measure-hold.sh --orientation
  vertical`); the custom hold image gets a harness run;
  `docs/wire-notes.md:351` drops `GET /v1/health` from "Not used yet".
  - Done when `hold_continuity -- --ignored` passes for both orientations
    and the agent log shows under 40 decoder spawns in a 5-minute hold.
- **L7. The fake web's reaper gap** (desktop harness). The fake has no
  reaper or health probe; L3's web behaviour is mirrored (`lost` → probe →
  end), and the fidelity diff in `~/cloud-test/lane-3/fidelity-diff.md` is
  moved into `scripts/lib/fake-cloud-web.mjs`'s header as the list of what
  it does not mirror.
  - Done when `node --test scripts/lib/fake-cloud-web.test.mjs` covers the
    `lost` route.

### Phase I: infrastructure (runner repo, owner-assisted)

Every slice names the owner's exact ask. Nothing here needs the desktop.

- **I1. Nodes.** Owner: open a Hetzner account, add the orchestrator's SSH
  key, and order one dedicated server in Falkenstein or Nuremberg (the
  type S0a could not decide without a box; start with the CPU class, an
  AX-series box, so x264 is measured first). A second box follows I6's
  numbers, before the cohort. Agent: `ops/provision.sh` (Debian or Ubuntu
  LTS, firewall: 22 from an allowlist, 1936/TCP RTMPS, 8890/UDP SRT,
  9443/TCP control, 80/443 for ACME only; chrony; unattended security
  updates only while drained), MediaMTX 1.21.3 pinned, a pinned GPL FFmpeg
  with x264, the agent's systemd unit from `deploy/systemd/`, and
  `ops/check-node` (ports listening, MediaMTX hook answering, certificate
  valid, agent heartbeat accepted).
  - Done when a fresh box passes `ops/check-node` from the script alone.
- **I2. Node agent in production shape.** The agent already registers,
  heartbeats, supervises, drains and ships usage (plan 184 Progress, I2).
  Add: log shipping (I4), self-update only while drained (I3), and a 20×
  start/stop loop test on the box.
  - Done when 20 runners start and stop on the node with no leaked process
    or port (`ss -lntup` before equals after).
- **I3. Deploys.** GitHub Actions in the private `videorc-cloud` repo
  (Actions are off in the other private repo; the owner turns them on
  here): build `videorc-runner` and `videorc-node-agent` for Linux x64 on a
  tag, upload to a private R2 bucket (the release tooling already speaks
  R2), `ops/deploy.sh <tag>` drains, installs, restarts. Owner: enable
  Actions, create the bucket and its token as repo secrets.
  - Done when a tag deploys to the node and `GET /v1/health` reports the
    new version.
- **I4. Watching.** Grafana Cloud Free (plan 184 decision; 10k series and
  50 GB logs are plenty for two nodes). The agent exposes per-show metrics
  (feed kbps, hold state, per-leg state, encoder fps and drops, CPU) on a
  loopback Prometheus endpoint; Grafana Alloy scrapes it and ships journald
  logs. Alerts to the owner's phone (Grafana IRM, 3 users): node heartbeat
  missing 60 s, a leg `failed` for 60 s, a runner crash, capacity above
  70%, certificate expiring in under 14 days, web 5xx rate on
  `/api/cloud/*` above 1% for 5 minutes (from Vercel logs or a synthetic),
  `cloud-full` returned at all. Owner: create the Grafana Cloud stack and
  hand the agent a write token.
  - Done when a kill of the runner on the node pages the owner's phone
    within 2 minutes and the show's hold shows on a dashboard.
- **I5. DNS and TLS.** Owner: create `eu-fsn-1.live.videorc.com` (and the
  second node's name) as plain A/AAAA records at the registrar, DNS-only,
  never behind Cloudflare's proxy ([[videorc-spain-laliga-cloudflare-block]]).
  Agent: ACME (lego or certbot) on the node for the node's name, a deploy
  hook that writes the chain where MediaMTX and the agent read it and
  reloads both; the agent refuses to start without a valid certificate off
  loopback (wire-notes "TLS is required off loopback"). Then the web's
  `VIDEORC_CLOUD_NODES` entry.
  - Done when the desktop's Test row passes against the real node with
    C1c's check on ("right roots pass, wrong CA fails" is already in the
    smoke; here it is the real certificate).
- **I6. S0d, costs measured.** On the box: `dev/measure-hold.sh` at
  1080p60 x264 `veryfast` and `faster`, shows per box until frames go
  late, CPU per show, VMAF at 6 Mbps out from 8 and 12 Mbps in; the lossy
  leg through `tc netem`; a 12 h show and a 30-minute hold in real time.
  Write the per-hour numbers into plan 185 and `lib/cloud/cost-inputs.ts`
  only. Nothing goes into the public repo.
  - Done when plan 185's cost table carries measured numbers and the daily
    cost alert uses them.

### Phase O: operations

- **O1. Kill switch drill** (web + desktop). With a show live on the real
  node: flip `VIDEORC_CLOUD_DISABLED=true`; the show keeps running, a new
  Go Live streams directly with "Videorc Cloud is off right now. You're
  streaming directly from this computer.", `current` and End still answer,
  a relaunched desktop finds the show (R3). Flip back; the next Go Live
  goes through the cloud. Write the steps into `docs/cloud.md` Rollback.
  - Done when the drill is run once on production with the owner's
    account and its log is in the runbook.
- **O2. Rollout order** (web env; plan 185 T6). (1) `plan_override = 'max'`
  for the owner and `VIDEORC_CLOUD_USERS` = the owner. (2) The desktop
  release that carries the port (Phase A first). (3) The beta cohort: 10 to
  20 Premium accounts the owner names, two weeks, with I4's dashboards
  watched daily. (4) `VIDEORC_CLOUD_PUBLIC=true` when A3 passes and the
  cohort's two weeks show no STOP condition. Each step is a dated line in
  plan 185's Progress.
  - Done when each step has its date and the numbers it was judged on
    (shows, hold minutes, holds per show-hour, fallbacks by reason).
- **O3. Support runbook** (private `videorc-cloud/docs/runbook.md`). One
  page per incident: a node is down (drain, DNS to the spare, end shows
  that can't resume); a runner crash loop (stop the agent's restarts,
  collect the state file, end the show); videorc.com is down (nothing to
  do, the reaper asks the node first); the certificate expired (renew by
  hand, reload); "my viewers see Be right back and I'm live" (the feed
  leg: ask for the support bundle from Health, check `cloud.state.feeds`,
  the node's MediaMTX log for the show path); "I lost my cloud hours" (the
  reconcile cron and `/account/cloud-costs`); a user asks what we store
  (`docs/cloud.md` "Stored and not stored"). Who gets paged, and the
  five-minute rule: when in doubt, end the show cleanly, never let two
  publishers share a key.
  - Done when every "When things break" row in plan 184 and in this plan
    points at a runbook page.
- **O4. Docs truth pass.** `docs/wire-notes.md` (health is used; the lost
  route; the region field), web `docs/cloud.md` (the lost route, the
  region, the rollout dates), desktop `docs/cloud/` gets a one-page
  `README.md` naming the three repos, the smoke and what it needs.
  - Done when a cold reader can run `smoke:cloud-solo` from the README
    alone.
- **O5. Latency by region.** The Test row's result carries `nodeId`,
  `region` and `handshakeMs` (Wire shape); the web logs them with the
  account's country (from the request, not stored per user beyond the
  aggregate); a weekly line in `/account/cloud-costs`: tests and shows by
  region, median handshake, holds per show-hour. `preferredRegion` in
  create and placement by region (a no-op with one region).
  - Done when the page shows the table and the Test row's description
    names the node's city and the handshake time.

### Phase Y: compliance (the owner sends; agents draft)

- **Y1. The YouTube answer.** A draft in
  `docs/compliance/youtube-tos-report-v2-cloud-draft.md` (desktop repo,
  public, so no secrets): what changes for Videorc Cloud users and only
  them: the YouTube stream key (`liveStreams` ingestion info, API data)
  travels from the user's computer to a Videorc media node over TLS, is
  held in the runner's memory for that show only, is never written to disk
  or a log, and is dropped at show end; every YouTube API call still goes
  from the user's computer; no Videorc server calls the YouTube API; chat
  is not relayed (plan 184 D17 stays). The current promise at
  `docs/compliance/youtube-tos-report-v1-reply.md:44-45` is quoted and the
  new sentence proposed. The privacy policy sentence goes with it.
  - Done when the owner has the draft and plan 185 Progress records the
    date it was sent. The cohort (O2 step 3) waits for the owner's word
    that it was sent (plan 184 D15: before anyone but the owner).
- **Y2. Privacy and Terms** (web, plan 184 W7, plan 185 T6). The privacy
  page's "None of it is uploaded unless you explicitly use a cloud
  feature." (`app/privacy/page.tsx:26`) gains the Videorc Cloud paragraph:
  the feed (video and audio) and the stream keys pass through Videorc's
  media nodes in memory during a show; what is stored (show times, node,
  hours); where (EU); nothing kept after the show. The Terms gain
  acceptable use for cloud shows and a new "Last updated" date. Both
  behind `VIDEORC_CLOUD_PUBLIC` until O2 step 4.
  - Done when the pages render both themes with the switch on and off and
    the owner has read the text.
- **Y3. Platform rules record.** The Outside facts above, with the two
  UNVERIFIED Twitch pages re-read in a browser by the owner or an agent
  with one, go into plan 184's Outside facts as a dated update.
  - Done when no Outside fact in plan 184 is older than this plan's date on
    relaying and holds.

### Phase U: product for Premium users (desktop, UI/Product Design)

Read `.claude/skills/videorc-design/SKILL.md` first. shadcn only; both
themes; nothing next to Record or Go Live; one home per control.

- **U1. Discovery.** No new surface. The Livestream page's Videorc Cloud
  section is the home (plan 184 C6). Add two cues that already have homes:
  the release notes entry (U7) and, once per account when the `cloud`
  block first says enabled, one toast with the existing id: "Videorc Cloud
  is on. Your stream stays on air if this computer drops. Set it up in
  Livestream." with an action "Open Livestream". The toast's type colours
  its icon only.
  - Done when the toast shows once per account (a backend-private
    `app_settings` flag), never during a session, and the Livestream page
    scrolls to the section.
- **U2. Upload once, shown.** In the Videorc Cloud section, under the
  switch: "Uploads once. 6 Mbps for 3 destinations; direct would be
  18 Mbps." computed in the renderer from the stream quality's bitrate,
  the vertical leg's bitrate, and the enabled destinations by orientation
  (plan 153's split quality: horizontal and vertical bitrates differ). With
  one destination: "Uploads once. 6 Mbps." The Stream health hover's Cloud
  row reads "Cloud · 6 Mbps up · 3 destinations". Numbers, never
  destination counts as a sales line.
  - Done when the line updates as destinations toggle and a unit test
    covers 1, 3 and dual-orientation cases.
- **U3. Dual orientation.** One feed per orientation (already built:
  `videorc-cloud-horizontal` and `videorc-cloud-vertical`). The runner's
  second output group gets its smoke: `smoke:cloud-solo` gains
  `VIDEORC_CLOUD_SOLO_VERTICAL=1` with a vertical receiver (the shape
  `smoke:multistream:vertical` uses), proving both feeds hold and resume
  and the vertical card is the vertical PNG (runner `b632892`, one PNG per
  shape). The upload math in U2 adds the vertical feed: "Uploads twice,
  once per orientation. 10.5 Mbps for 3 destinations; direct would be
  16.5 Mbps."
  - Done when the vertical variant passes with two feeds and both
    receivers keep one connection.
- **U4. Copy while a show is held with the cloud off** (the desktop
  fixer's item 3). The section's line "Go Live streams directly from this
  computer." becomes "A show is live through Videorc Cloud. Go Live feeds
  it." while a show is held; the Go Live primary reads "Connecting to
  Videorc Cloud…" whenever `goesThroughCloud` or a show is held.
  - Done when `cloud-view.test.ts` covers both states.
- **U5. Hours running out never cuts a show** (plan 184 D18). When
  `cloud.state.allowancePast.seconds` appears, one toast: "You're 12 min
  past this month's cloud hours. The show keeps going." Then the Cloud
  section reads "Cloud hours: 0 of {hours} left · past by 12 min · resets
  Dec 1." The next Go Live's fallback toast already exists ("You've used
  this month's cloud hours. They come back Dec 1.").
  - Done when the toast shows once per show and the section's line
    matches, in both themes.
- **U6. What the Studio says while the cloud holds.** Three states, all
  existing copy, checked by eye in both themes with
  `VIDEORC_CLOUD_SOLO_SHOTS_DIR`: the feed is gone but the desktop is up
  ("Reconnecting to Videorc Cloud", Stream health "Be right back · 28 min
  left"); the desktop relaunched (the Resume notice); the runner restarted
  ("Videorc Cloud restarted your show. Your platforms reconnect in a few
  seconds."). Fix only what the eye finds.
  - Done when the shots are in the PR and the owner has looked at them.
- **U7. videorc.com and release notes** (web + desktop changelog). Web
  copy (plan 185 D11, D12), behind `VIDEORC_CLOUD_PUBLIC`: the Premium
  page gets "Your stream stays on air if your computer doesn't. {hours}
  cloud hours a month." and the multistream page's "no cloud relay" line
  becomes "Free multistream runs on your computer. With Premium it can go
  through Videorc Cloud, so it survives your computer." No destination
  counts, no bitrates as a selling point, no "relay" in user copy. The
  release's changelog entry: "Videorc Cloud (Premium): go live through
  Videorc's servers and your stream stays on air if your computer drops.
  Upload once; the cloud sends it to every destination." The hour figure
  comes from plan 185 D9's code constant, never typed by hand.
  - Done when both pages pass `pnpm test` (the search-surface and
    structured-data tests) and the changelog entry is in the release
    record.

### Phase A: acceptance

- **A1. Soak and chaos matrix** (desktop + runner harness, local
  receivers; never a real channel). Run and record in
  `docs/cloud/acceptance-2026-MM-DD.md`:

| Scenario | How | Pass |
| --- | --- | --- |
| Flake rate | `pnpm smoke:cloud-solo` 10× in a row on a quiet Mac | 10 of 10; hold 1.4 to 1.8 s; largest gap ≤ 67 ms; receivers see EOF 10 of 10 |
| Feed cuts | `VIDEORC_CLOUD_SOLO_DROP_MS` at 2, 10, 60 and 300 s; 25 flaps in 10 min | every cut holds and resumes; no receiver reconnect |
| Hold limit | a 5-minute limit with the feed gone | the show ends `hold-expired` within 2 s of the limit |
| Mac death | SIGKILL the app group (the smoke's death step) | Resume live ≤ 8 s after the click; one show on the web |
| App update mid-stream | relaunch from a different build directory with the same state dir (the smoke's relaunch with `VIDEORC_APP_VERSION` bumped); then once for real on a packaged build (A2) | Resume works; `client.version` changes on the agent's log |
| Runner crash | SIGKILL the runner | platforms back ≤ 5 s; "Videorc Cloud restarted your show" once |
| Agent crash | SIGKILL and SIGTERM the agent | the runner and the platforms stay live (`73c34a6`) |
| Node death | L3's variant | direct within 30 s; one toast; no double publish |
| Web outage | fake web 503 for 6 minutes mid-hold (lane 3's shape) | the show survives; usage catches up |
| Rollback | `VIDEORC_CLOUD_SOLO_ROLLBACK=1` | the relaunched desktop finds the show |
| 12-hour cap | runner harness in virtual time plus one real 12 h run on the node (I6) | the warning at 11 h once; the end at 12 h |
| Dual orientation | U3's variant | both feeds hold and resume |

  - Done when the document has every row with numbers and a date.
- **A2. The packaged update.** Two signed macOS builds, N and N+1, both
  with the port. Go live through a local fake web and node on N (the
  packaged build has no smoke RPCs, so this is by hand with the real UI),
  install N+1 over it with the updater, relaunch, Resume.
  - Done when the Resume notice shows after the update and the receivers
    kept one connection.
- **A3. The owner's real live test.** Only when the owner asks in the
  session ("test it live"). Plan 184's Phase 1 acceptance: a 2-hour stream
  to the owner's real channels through the real node: pull the network for
  2 minutes; quit and relaunch, Resume; update the app mid-stream. It
  passes when each platform shows one broadcast, the VOD is one piece, the
  hours meter matches the node's usage to the minute, and X stayed live
  through the holds.
  - Done when the owner says so and the numbers are in plan 184 Progress.
- **A4. The release.** `videorc-release`: version, changelog (U7), the
  signed and notarized macOS build, the updater feed. The release goes out
  with the cloud dormant for everyone but the owner (O2 step 2 before
  step 3): a desktop without the cohort sees `cloud.enabled: false` and
  streams directly as today.
  - Done when the release record names the port PR and the kill switch
    state at release time.

## Verification gates

`AGENTS.md` is the source of truth for commands.

- **Phase R**: `node --test scripts/lib/fake-cloud-web.test.mjs
  scripts/lib/cloud-solo-gates.test.mjs scripts/lib/app-launcher.test.mjs`;
  `pnpm test:scripts`; `cargo test -p videorc-backend cloud_show`;
  `pnpm smoke:cloud-solo` once with `VIDEORC_CLOUD_SOLO_ROLLBACK=1`.
- **Phase P, once at the end**:
  - desktop: `cargo fmt --check --all`; `cargo clippy -p videorc-backend -- -D warnings`;
    `cargo test -p videorc-backend` (full, once; the heavy lock); `pnpm
    typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter
    @videorc/desktop test`, `pnpm test:scripts`, `pnpm build`;
    `pnpm audit:rust` (reds named against main's);
  - smokes: `pnpm smoke:cloud-solo` ×10, `pnpm smoke:multistream`, `pnpm
    smoke:multistream:vertical`, `pnpm smoke:stream-leg-eof`, `pnpm
    smoke:streaming-secrets`, `pnpm smoke:youtube-quota`, `pnpm
    smoke:recording-matrix`, `pnpm smoke:recording-studio`, `pnpm
    smoke:record-latency`, `pnpm smoke:stream-thin-uplink`, `pnpm
    smoke:encoder-bridge`;
  - web (P10): `pnpm typecheck && pnpm lint && pnpm test && pnpm build`;
  - runner (P11): `cargo fmt --check --all`, `cargo clippy --all-targets
    -- -D warnings`, `cargo test --workspace`, `cargo test -p videorc-runner
    hold_continuity -- --ignored`.
- **Phase L**: L1 adds `pnpm smoke:recording-matrix` and `pnpm
  smoke:packaged`; L2 `pnpm smoke:stream-thin-uplink`; L3 and U3 their
  `smoke:cloud-solo` variants; L5 the web suite.
- **Phases I and O**: `ops/check-node`, the alert drill (I4), the kill
  switch drill (O1).
- **Phase U**: `pnpm --filter @videorc/desktop test`, the cloud-view
  tests, both themes by eye with `VIDEORC_CLOUD_SOLO_SHOTS_DIR`.
- **Before the kill switch flips for the cohort**: one Review pass (fit 9)
  of the port PR's `cloud_show.rs` hand-over paths and the web's `lost`
  route; `pnpm smoke:local-gates` once on the merged main.
- Recording-studio and native-preview rules apply: the port touches the
  stream output, so `smoke:recording-studio` and `smoke:multistream` are
  not optional.

## When things break

Plan 184's table stands. These rows change or are new:

| What breaks | What viewers see | What the host sees | Recovery |
| --- | --- | --- | --- |
| A media node dies | Every show on it drops | Within 30 s: "Videorc Cloud lost your show. Stop, then go live again to stream directly from this computer." (L3) | The web confirms the node is gone; direct legs; the owner is paged (I4) |
| The desktop remembers a show and videorc.com is unreachable at Go Live | Nothing, or a double publish for minutes if the runner still holds | "Videorc couldn't check your last cloud show. You're streaming directly from this computer." (D6) | The hold limit ends the runner's side |
| The stream quality is 4K30 | Nothing | "Videorc Cloud carries up to 1080p60 for now. You're streaming directly from this computer." (D5) | Direct, as today |
| The upload is too thin for the feed | Lower bitrate, then skipped seconds | Stream health "Connection too slow", the Cloud row (plan 218, L2) | The bitrate steps down; the runner's output stays steady |
| Hours run out mid-show | Nothing | "You're 12 min past this month's cloud hours. The show keeps going." (U5) | The next show streams directly |
| The kill switch is flipped mid-show | Nothing | Nothing; the next Go Live streams directly and says why | End and `current` keep working (O1) |
| The port lands and the cloud is dormant | Nothing | Nothing | By design until the cohort (O2) |

## STOP conditions

Stop and ask the owner when:

- P8's eager bundle lands within 1,000 gzip bytes of the 475,000 ceiling.
  Never raise the ceiling.
- P4 finds the seam moved: `let stream_targets = stream_resolution.ready;`
  is gone from `start_session_with_timeline`, or plan 217 has started on
  main.
- A gate in Phase P fails and the same gate is green on `origin/main` at
  the same commit (an A/B against main, once; no chasing unrelated reds).
- Anything would store a stream key, an ingest key or a platform token at
  rest (plan 184 D15, X6).
- Anything would make a YouTube API call from a server, or the cohort
  would grow past the owner before Y1 is sent (plan 184 D13, D15).
- A change would add a control next to Record or Go Live, or a second home
  for the cloud switch.
- I6's measured cost per show-hour breaks plan 185's margins (plan 185
  holds the number).
- A platform's rules, re-read in a browser (Y3), forbid relaying or a
  30-minute hold.
- A soak row in A1 fails twice in a row on a quiet machine.

## Out of scope

- Phases 2, 3 and 4 of plan 184 (guests, the phone, Max extras): plans 224
  and the rest of plan 221.
- The viewer-side watchdog (plan 223) and cross-platform viewers (plan
  225). This plan's I4 watches nodes and legs, not what viewers see.
- Self-hosted LiveKit, a US node before D8's measurement, YouTube backup
  ingest from a second node (plan 184 X8).
- Chat through the cloud (plan 184 D17), cloud recording (Max), Facebook
  as a destination.
- Any change to the free multistream path's behaviour or limits.
- Raising the renderer budget ceiling.

## Open questions for the owner

1. **Default on?** (D1) Recommended: on for every entitled account, with
   the switch on the Livestream page to turn it off.
2. **SRT before or after the beta cohort?** (D4) Recommended: after. The
   cohort goes live on RTMPS.
3. **4K30 streams in Phase 1?** (D5) Recommended: they stream directly
   with one toast until a node has NVENC or S0d measures 4K.
4. **Go Live when videorc.com is unreachable and a show is remembered?**
   (D6) Recommended: stream directly after one toast; never block Go Live
   on the web.
5. **Creem refunds and interval switches** (L5): should yearly-to-monthly
   wait for the period end with no refund, and should only a full refund of
   the current charge end a plan? Recommended: yes to both, after a Creem
   test-mode run shows which webhooks fire.
6. **The first node**: one CPU box (AX class) in Falkenstein or Nuremberg
   now, a second before the cohort? Recommended: yes. The GPU question
   waits for I6's numbers.
7. **A US node**: on D8's two-week measurement, or now? Recommended: on
   the measurement. Hetzner's US sites are cloud-only.
8. **The beta cohort**: 10 to 20 Premium accounts you name, two weeks,
   before `VIDEORC_CLOUD_PUBLIC`? Recommended: yes.
9. **Premium's hour allowance**: the figure lives in plan 185 D9 and
   `lib/cloud/entitlement-plans`. Keep it, or raise it so the cloud is
   Premium's headline? Recommendation and numbers are in plan 185 (private);
   this plan reads the constant.
10. **The YouTube answer** (Y1): you send it before anyone but you goes
    live through the cloud with YouTube. Recommended: send it when the
    port passes A1, so the cohort doesn't wait on it.

## Handoff (cold start)

- **Goal**: every Premium account can turn on Videorc Cloud (plan 184
  Phase 1, solo shows) in a shipped desktop, on a production node, with
  the hold, Resume and "upload once" proven; the owner's real test passes.
- **Current state**: the code is built on three draft branches never to be
  merged: desktop `plan-184-videorc-cloud` `0e5bade39` (+7 local commits
  at tag `backup/plan-184-local-2026-10-21`, see Phase R), web
  `plan-185-max-and-cloud` `5a75d03d`, runner `phase-1-runner` `b0557c9`.
  The desktop branch is 486 commits behind main. Test reports:
  `~/cloud-test/reports/`. Design source of truth: plan 184. Money: plan
  185 (private).
- **Chosen route**: Orchestrator (fit 10) owns; Phase P on Diagnose (fit 9,
  `fable-5.1`); Phase U on UI/Product Design (fit 9, `opus-5.5`); Phase R
  and docs on Implementation (fit 8, `gpt-6.1-sol`); infra on
  Implementation (fit 8, `fable-5.1`).
- **Out of scope**: Phases 2 to 4, the watchdog, viewers, a US node before
  measurement, any budget raise.
- **Ordered steps**: R1 → R6; P1 → P11; L1 to L7 (L1 after D4's timing);
  I1 → I6 and O1 → O5 as the owner unblocks; Y1 → Y3; U1 → U7; A1 → A4.
  Phases I/O and Y run in parallel with L and U.
- **Verification**: the Phase P list once at the end of the port, then the
  slice's smoke per slice, then `smoke:local-gates` once before the cohort.
- **Blockers**: a Hetzner account and SSH access (I1); DNS records (I5); a
  Grafana Cloud stack (I4); Actions and an R2 bucket for the private repo
  (I3); the owner's YouTube answer (Y1); the owner's charging decision
  (L5); the owner's go for any real live test (A3). Never invent
  credentials. Parallel Rust compiles: at most 2 or 3; check `df -h` and
  swap before dispatch ([[videorc-parallel-executor-compile-thrash]]).
- **For plan 217's executor**: the cloud feed is a `StreamTarget` with
  `target_id` `videorc-cloud-<orientation>`; it must ride in the stream
  process, and `cloud_platform_rows` plus `apply_cloud_leg_states` follow
  the stream process's `StreamTargetsSnapshot`.
