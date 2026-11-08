# Plan 221: Premium worth paying for

> **Executor instructions**: this is the umbrella for plans 222 to 225. It
> owns the order of work, the branches everything lands on, the decisions
> taken on the owner's behalf, and the list of things only the owner can do.
> Read it first, then the plan for your slice. Read `AGENTS.md` and
> `CLAUDE.md` from `origin/main`.
> - Work in your own worktree, cut from the integration branch head (U1),
>   not from the shared checkout.
> - Write and commit every slice of a phase first. Then run the Rust
>   compile and tests and the smokes once, at the end of the phase (owner
>   feedback "Gates at the end").
> - Check every UI in light AND dark.
> - Never go live on a real channel unless the owner asks for it in the
>   session.
> - Never merge #727, #85 or #1. The owner merges.

## Status

- **Status**: EXECUTING since 2026-11-08. The owner said: "when done with
  plan, execute the entire plan and put all to that pr we have".
- **Priority**: P1. This is the owner's answer to "our premium is not really
  giving much value to users".
- **Effort**: XXL. It is the sum of four plans:
  - 222: about 5 to 7 agent-weeks;
  - 223: about 2 to 3;
  - 224: about 8 to 12 after 222;
  - 225: about 3 to 4.
  The parallel waves below shorten the wall clock, not the work. The real
  gates are the owner's accounts (Only the owner can do).
- **Risk**: HIGH.
  - Videorc's first always-on server product (222, 224).
  - The first time viewer data is linked across platforms (225).
  - The first interruptions during a live stream (223).
- **Planned at**:
  - desktop `origin/main` `d00550ea1` (0.20.4);
  - the cloud branch `origin/plan-184-videorc-cloud` `0e5bade39`, plus the
    local tag `backup/plan-184-local-2026-10-21` `95fbdce96`;
  - web `plan-185-max-and-cloud` `5a75d03d` (web main `3c8d1593`);
  - runner `phase-1-runner` `b0557c9`.
- **Route**: Orchestrator (fit 10, `fable-5.1`). It owns the order, every
  merge into the integration branches, every push, and the review passes.
  Each plan names the route and lane for its slices.

## The owner's ask (2026-11-08)

> "currently our premium is not really giving much value to users, I want
> you to think about biggest value we can bring to our users, and that one
> shouldn't be video editing. give me 10 best possible premium features you
> can think of"

Of the ten, the owner picked the first five:

> "ok plan out thouroughly first 5 things you recommended, it can go from
> our cloud branch that we already started"

and then:

> "when done with plan, execute the entire plan and put all to that pr we
> have"

## What Premium becomes

Today Premium sells four AI helpers: live captions, Buddy Live, Clean cut,
and noise cleanup. None of them answers what a streamer pays for: my stream
survives, I grow, I earn. The five features below are the headline. The
four helpers stay, as supporting lines.

| # | Feature | Plan | Free (Basic) | Premium | Max |
| --- | --- | --- | --- | --- | --- |
| 1 | **The stream never drops.** If the computer or its internet fails, viewers see Be right back, and the broadcast, the VOD and the notification all survive. | 222 | — | ✓ within the monthly cloud hours | ✓ more hours |
| 2 | **Upload once, stream everywhere.** One feed goes up, and the cloud sends it to every platform. | 222 | Multistreaming from your own upload stays free | ✓ (same hours) | ✓ |
| 3 | **A watchdog that sees what viewers see.** A muted mic, a stalled picture, a platform gone dark, or chat saying "no sound". | 223 | Every desktop check, the alerts, the fixes, the history, and the phrase match in chat | Cloud-side checks, the phone push, and the AI chat read | ✓ |
| 4 | **Guests from a link.** Guests join from a browser, wait backstage, and the cloud composes and records the show. | 224 | — | 1 guest on stage, recordings kept 7 days | 5 on stage, 30 days |
| 5 | **Know your viewers across platforms.** One person across YouTube, Twitch, Kick, X and Facebook: first time, back after 3 weeks, regular, and what they asked last time. | 225 | The local store, flags, chips, the person card, Community, every way to link, and the report's counts | Buddy's memory, AI drafts using it, the audience summary, and encrypted sync | ✓ |

- **Prices stay public as they are**: Premium $39 a month or $390 a year,
  and Max $99. The hours, allowances and costs live in the private plan
  185.
- **The free promise holds.** Nothing above sells resolution, frame rate,
  bitrate or a destination count.

## The plans

| Plan | Feature | Repos | Hard prerequisites | Owner-gated |
| --- | --- | --- | --- | --- |
| [222](222-cloud-solo-shows-for-premium.md) | 1 and 2 | desktop, web, runner | none | nodes, DNS, YouTube answer, Creem |
| [223](223-stream-watchdog.md) | 3 | desktop; web (D); runner (C) | Phase C needs 222 P | Kick live test (A9), phone acceptance (D3) |
| [224](224-guests-from-a-link.md) | 4 | desktop, web, runner, LiveKit | 222 P and I (a node with DNS and TLS) | LiveKit project, recordings bucket, acceptance show |
| [225](225-know-your-viewers-across-platforms.md) | 5 | desktop, web | none | legal read of platform terms (H4) |
| [183](183-buddy-remembers-your-regulars.md) | parked base of 225 | — | — | — (225 answers its questions) |
| [184](184-videorc-cloud.md) | the cloud design | — | — | — (222 and 224 execute it) |

## Decisions

### U1. One integration branch per repo: the draft PRs that already exist

The owner said "put all to that pr we have". So:

| Repo | Branch | PR |
| --- | --- | --- |
| desktop (PUBLIC) | `plan-184-videorc-cloud` | #727 |
| web (PRIVATE) | `plan-185-max-and-cloud` | #85 |
| runner (PRIVATE) | `phase-1-runner` | `videorc-cloud` #1 |

- No new PRs open.
- Every executor cuts its branch from its repo's integration head. It
  commits its slices there, and the orchestrator merges them in with a
  merge commit, never a squash.
- Executors never push to an integration branch.
- Plans that say "PR 1, PR 2" or "from `origin/main`" mean "in this order,
  on the integration branch". Plan 225 D16 is marked superseded.

### U2. The port onto main comes first, and lands without a force-push

- The desktop cloud branch is 485 commits behind main. Plan 222 D2 re-applies
  its work in groups on `plan-222-cloud-on-main`, cut from `origin/main`.
- Slice P-land then makes one merge commit on `plan-184-videorc-cloud`:
  - its tree is the port's tree;
  - its parents are the old head and the port head.
- #727's diff against main becomes exactly the port. The old history stays
  reachable, and nothing is force-pushed.
- Desktop slices from plans 223 and 225 may start on `origin/main` before
  P-land. A branch cut from main merges cleanly onto a main-based port.

### U3. Owner questions take their recommended answers ⚑

- The owner asked for execution, not another round of questions. Plan 184
  went the same way ("go all to recommended").
- Every open question in 222 to 225 takes its recommended answer, listed in
  "Answers taken" below. The owner can override any of them; an override
  becomes a new slice.
- The exception is anything that needs the owner's hands, money, accounts
  or channels. That waits in "Only the owner can do", and the work around
  it carries on.

### U4. Packaging changes go into the private plan 185 and the web constants

- 224 D15 (B) gives Premium 1 guest and 7-day recordings. 222 Q9 asks
  whether Premium's cloud hours rise so the cloud can be its headline.
- Both are a plan 185 update plus a constants change in the web's plan
  table. The desktop already parses the allowance block (224 found this),
  so no wire change.
- The figures live only in plan 185 (private). This plan never prints them.

### U5. At most two heavy jobs at once

- On this Mac, a "heavy job" means:
  - a Rust compile or test run of `videorc-backend`;
  - a runner build that pulls libwebrtc;
  - an e2e smoke;
  - an FFmpeg build;
  - a LiveKit churn run.
- At most two run at the same time, and **at most one of them is a
  `videorc-backend` test or clippy build**.
  - Measured on 2026-11-08: two backend test targets at once put one
    `rustc` at about 5 GB, swap at 14.4 of 15 GB, and disk at 19 GB, and
    the port stopped on the floor.
  - The second slot is for light work only: web builds, the runner crate,
    and docs.
- Before starting one:
  - `df -h /` must show at least 20 GB free;
  - swap use must leave at least 1 GB.
- Past incidents: 9 parallel compiles once drove 30 GB of swap, and 7
  delegates once caused a kernel panic from a full disk.
- S0f (224's churn run) and any timing measurement run alone, on a quiet
  machine, under `caffeinate -i`.

### U6. Pushes are batched

- #727 runs paid CI on every push, so the desktop is pushed once per wave,
  after the merges and the gates.
- After every push, `gh pr checks 727` is read against main's last run of
  the same workflows. Inherited reds are named in the PR body.
- Web #85 and runner #1 may be pushed per phase.

### U7. Nothing reaches users from these branches

- Everything stays on unmerged drafts, behind the existing switches:
  - `VIDEORC_CLOUD_PUBLIC` and `VIDEORC_MAX_ON_SALE` on the web;
  - the cloud rollout and kill switch;
  - each plan's own default-off flags where it has them.
- Only the owner's merges and switch flips ship it.

## Order of work

```
Wave 0  ─ 222 R (recovery commits, no gates) ─► 222 P (the port, heavy) ─► P-land ─► push #727
        ─ 222 P10 (web: merge web main into #85)          ─► push #85
        ─ 222 P11 (runner gates)  ·  224 S0h (facts refresh, no build)
        ─ 225 A–B (community store, linking, arrivals: from origin/main; 2nd heavy slot)

Wave 1  ─ 223 A–B (desktop watchdog + chat phrases)       ─┐
        ─ 225 C–E (chips, person card, Community, report) ─┤ merged into #727, one push
        ─ 222 L + U (leftovers, product copy, default on) ─┘
        ─ 224 S0a-r, S0b (rooms spike pushed; host in a room) ─ then S0f alone, quiet machine
        ─ web: 224 W-G1–W-G6, 225 F1–F2 + H2, 223 D1, U4 constants ─► push #85

Wave 2  ─ 224 R-G1–R-G9 (runner)  ·  223 C1–C2 (runner program checks) ─► push #1
        ─ 224 C-G1–C-G8  ·  223 C3, D2  ·  225 F3–F5 ─► merged into #727, one push

Wave 3  ─ smokes: cloud-solo ×10, stream-watchdog, cloud-talk-show, comments probes
        ─ the full local bundle once on #727's head (AGENTS.md), review pass per plan (fable-5.1)
        ─ 225 G (sync) only if H4's legal read says yes

Owner-paced, in parallel from Wave 0: 222 I (nodes, DNS, deploys), O (watching, runbook),
Y (the YouTube answer), LiveKit Cloud, Creem, the recordings bucket, and live tests on request.
```

- Waves are gates, not calendars. A wave starts when its prerequisite has
  landed.
- If the owner's accounts arrive early, 222 I moves up.

## Answers taken (U3) ⚑

| Plan | Question | Answer taken |
| --- | --- | --- |
| 222 | 1. Default on? | On for every entitled account, with a switch on the Livestream page |
| 222 | 2. SRT timing | After the beta cohort; the cohort goes live on RTMPS |
| 222 | 3. 4K30 streams | Stream directly with one toast, until a node has NVENC or S0d measures 4K |
| 222 | 4. Web unreachable with a remembered show | Stream directly after one toast; Go Live never blocks on the web |
| 222 | 5. Creem refunds and interval switches | Yes to both, after a Creem test-mode run (owner) |
| 222 | 6. First node | One CPU box in Falkenstein or Nuremberg now, a second before the cohort (owner buys) |
| 222 | 7. US node | On the two-week measurement (D8) |
| 222 | 8. Beta cohort | 10 to 20 Premium accounts the owner names, for two weeks |
| 222 | 9. Premium's hours | Raise them so the cloud is Premium's headline. The figure is in plan 185 (U4) |
| 222 | 10. The YouTube answer | The owner sends it when the port passes A1 |
| 223 | 1. Mic muted threshold | 30 s |
| 223 | 2. The free/Premium split | As in the table above |
| 223 | 3. Black picture on the desktop | Measure first; ship only under 0.3 ms p95 |
| 223 | 4. `still-there` | On, as a notice; it never pushes or notifies |
| 223 | 5. AI chat read | On for Premium, with a switch |
| 223 | 6. Email or Discord fallbacks | Not in v1 |
| 223 | 7. Warn while only recording | Not in v1 |
| 223 | 8. Kick live test (A9) | Yes, once, with the owner in the session. **Waits for the owner** |
| 224 | 1. Codec | VP8 now; H.264 when rust-sdks #1515 merges or a GPU node exists |
| 224 | 2. The door | The host lets every guest in; "Let anyone with the link in backstage" is off by default |
| 224 | 3. Packaging | B: Premium 1 guest and 7-day recordings; Max 5 guests and 30 days |
| 224 | 4. Where invites live | A Guests tab on the Livestream page |
| 224 | 5. Preview during a talk show | Hide it and show the Show stage, pending S0b |
| 224 | 6. Guest screen share | Off per guest until the host allows it |
| 224 | 7. Recording storage | A separate R2 bucket under the same account, with its own scoped key (owner creates) |
| 224 | 8. Invite while live | Into a running talk show: yes. Solo to talk show mid-stream: not in v1 |
| 224 | 9. Consent line | "This show goes out live on {platforms} and may be recorded. Your camera and voice are part of it." |
| 225 | 1 to 14 | Every recommended answer in plan 225's Open questions. Sync (10) is built last, and only if H4's legal read allows it |

## Only the owner can do

The work around each item carries on. Each item blocks only what it names.

1. **A Hetzner account and API token.** Blocks 222 I1 to I3 (real nodes)
   and everything after it that needs a public node: 222 A, and 224 S-G3
   and S-G4.
2. **DNS for `*.live.videorc.com`** and its TLS. Blocks the same.
3. **A LiveKit Cloud project and its keys, set in Vercel env.** Blocks
   224's hosted rooms. Until then, the work runs on a local
   `livekit-server --dev`.
4. **Creem**: the Max products and env, and a test-mode run of refunds and
   interval switches (222 L5).
5. **The YouTube compliance answer** (222 Y1). Agents draft it, and the
   owner sends it. No one but the owner goes live through the cloud with
   YouTube before it.
6. **The cloud recordings bucket** (224 Q7): a separate R2 bucket and a
   scoped key.
7. **Web push keys (VAPID), set in Vercel env** (223 D1). Agents generate
   the pair locally and never commit it, and the owner sets the env.
8. **The beta cohort list** (222 Q8).
9. **Live tests on real channels**, only when the owner asks in the
   session:
   - 223 A9 (Kick, 3 minutes);
   - 222 A (the owner's live test);
   - 224 S-G3 (a 1-hour talk show with 2 guests);
   - 223 D3 (phone push on the owner's iPhone).
10. **Phones for the browser matrix** (224 S0g): Safari on iOS 17 and 18,
    and Chrome on Android 14. Agents run desktop Safari and Chrome, and the
    owner opens the guest link on real phones.
11. **The legal read of platform terms** (225 H4), before 225's release and
    before any sync.
12. **Merging #727, #85 and #1**, and flipping any rollout switch.

## Verification

- Each plan's gates apply to its slices, with gates at the end of each
  phase.
- At the end of Wave 3, the whole local bundle runs once on #727's head, as
  `AGENTS.md` lists it (owner feedback "Full gates on main after a merge
  batch"). That includes `pnpm smoke:local-gates`, the recording-studio and
  native-preview probes the touched areas need, and `smoke:cloud-solo`,
  `smoke:stream-watchdog` and `smoke:cloud-talk-show`.
- Web: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` on #85.
- Runner: `cargo fmt --check --all`, `cargo clippy --all-targets -- -D
  warnings` and `cargo test --workspace` on #1.
- Before any switch flips for anyone but the owner, one review pass per
  plan (fit 9, `fable-5.1`), findings first.

## STOP conditions

Stop and ask the owner when:
- the port (222 P) can't keep a direct-path smoke green that main has green;
- the renderer's eager gzip budget would pass its ceiling (475,000);
- anything would store stream keys or platform tokens at rest, or make a
  YouTube API call from a server (plan 184 D13, D15);
- a change would put a control next to Record or Go Live;
- a platform's terms forbid what a plan does (relaying, a long hold,
  linking viewer accounts, or storing chat beyond its limit);
- disk or swap stays below U5's floor after the worktree clean-up
  (`pnpm clean:worktrees --apply`);
- a review pass finds a HIGH that changes a plan's design.

## Progress

| Wave | Item | State |
| --- | --- | --- |
| — | Plans 221 to 225 written; 183 recovered from an untracked copy | **Done** 2026-11-08 |
| 0 | 222 R (`plan-222-r` `aad92eb60`), P (`plan-222-cloud-on-main` `ce05fb46e`), P-land onto #727 | **Done** 2026-11-08. Every Phase P gate is green except the three below. Rust: 4,722 tests, clippy, fmt and audit. TS: typecheck, lint, format, vitest and test:scripts. `pnpm build`. `smoke:cloud-solo` ×10 plus the rollback run (largest gap 34 ms every run). 8 direct-path smokes. Recording matrix 20/20. The three: (1) **the renderer budget, an owner call**: eager gzip 479,188 against a 477,000 ceiling; main is 61 bytes under the ceiling by itself, and the port adds 2,249. (2) `smart-scenes` switches p95 168 ms, inherited host load. (3) `recording-studio` steps 12 to 44 were not run, because of the disk floor. |
| 0 | 222 P10, the web port onto web main (#85) | **Done** (`067d629b`) |
| 0 | 222 P11, the runner gates | **Done**, with runner #1 at `8b6d478` |
| 0 | 225 A–B, the community store and live arrivals | **Done** on `plan-225-community` `33eda7dc0` (cut from main `611f2de5f`); green. Merges into #727 next |
| 0 | 224 S0h, the facts refresh | Not started (folds into S0a-r) |
| 1 | Web: U4, 224 W-G1–6, 223 D1, 225 F1–F2, H2, 223 B2, 222 L3/L5/Y2/U7/O2 | **Done** on #85 (`be159d28`), after two security reviews (11 + 6 findings, all fixed with tests) |
| 1 | Runner: 222 L6, O4, I2, I3, I4, O3; 223 C1, C2 | **Done** on #1 (`8b6d478`). Owed: the hold-image harness re-run and the 5-minute hold spawn count (disk floor) |
| 1 | Desktop: 222 L2, L3, L4, L7 (+ the 225 A–B merge) | **Done** 2026-11-08 on #727 (`plan-184-videorc-cloud`, unpushed). Merge f9c73e701 (no conflicts); L2, L7, L3, L4 and two fix commits. Gates green except the inherited ones: the renderer budget (eager gzip 479,409 against 477,000; the port was 479,188, plan 225's eager wiring adds 221; owner call), lint's `setDeviceList` warning (on main), and `smart-scenes` p95 under host load. `smoke:cloud-solo` default + node-death + thin-uplink, cohost-fake, multistream, stream-leg-eof green; recording-studio: all 43 steps run for the first time on this code; 38 green, 5 red: 11 `smart-scenes` (switches p95 180 ms > 150, inherited host load), 15 `freeform-editor` (its last step, "frames that show no committed placement", red since plan 215 D), 25 `live-background` (silk 1080p30 p95 2.25 ms > 1.5, over since plan 190), 14 `separate-source-runtime` (1080p30 case: "audio track is digital silence … although a microphone was selected"; the host mic reported only silence in every smoke this session), and 27 `layout-source-loop` + 35 `preview-interaction-stress` (the Preview window `open: true, visible: false`, "Timed out waiting for in-process in persistent CGWindow oracle"; both reproduce on a rerun; never run on the port before; NOT A/B'd against main under the disk floor, the orchestrator's call) |
| 1 | Desktop: 223 A–B; 225 C–E; 222 U, Y1; 224 S0a-r, S0b, S0f | Not started |
| 2 | 224 R-G, C-G; 223 C3, D2; 225 F3–F5 | Not started |
| 3 | Smokes, the bundle, review passes; 225 G if allowed | Not started |

## Handoff (cold start)

- **Goal**: the five features above, on the three draft PRs, ready for the
  owner to merge and switch on.
- **Start with** Wave 0. Read 222's Phase R and Phase P whole before
  touching the cloud branch.
- **Where things are**:
  - the plans: `plans/221-*.md` to `plans/225-*.md` on #727;
  - the 2026-10-21 test reports: `~/cloud-test/reports/`;
  - the runner clone: `~/projects/videorc-cloud`;
  - the web worktree: `~/projects/videorcweb-wt-185`.
- **Private**: costs, margins, and the hour and guest figures are in
  `docs/plans/185-videorc-max-tier.md` in the private web repo. Never copy
  them here.
- **Never**: merge a PR, force-push an integration branch, go live
  unasked, or run more than two heavy jobs at once.
