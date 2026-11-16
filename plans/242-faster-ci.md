# Plan 242: Faster CI

The owner's ask (2026-11-16), quoting a post: "check if we could do something
like this to have less CI: Our frontend CI is now under 2 minutes. What we
did: tsc to bun check; oxlint, every rule we can turn on; shards filled by
recorded test time; PRs run only the tests the diff can reach; lint,
typecheck, build and tests all run in parallel". Then: "plan out all of
these properly".

## Status and scope

- **Status: PLANNED 2026-11-16** from `origin/main` `c179d81b5`. Nothing is
  built. Decisions D1–D8 are open; the recommended answer comes first in each.
- All five ideas from the post are in, mapped to what Videorc runs. So are four
  Windows changes the post does not cover, because they are where most of the
  wait is.
- One release-integrity bug was found while planning (S1). It exists today, and
  it must be fixed before any slice that adds a skip path.

## Where the time goes today (measured)

One ordinary code PR, the 11-15 scrollbar fix (`fix(studio): no gray scrollbar
track…`): CI run `43748937191`, Windows run `43748937113`, Linux run
`43748937112`. Jobs run in parallel, so the longest job sets the wait.

| Job | Wall | What fills it |
| --- | ---: | --- |
| Windows release source gates | 113 min | test compile 43 min, "Source and audio ownership" loop 38 min, full suite ×3 9 min, desktop tests 9 min, clippy 5 min, `cargo install cargo-audit` 5.4 min |
| Windows startup incident diagnostics | 52 min | backend build 15 min, two incident matrices 31 min, OpenH264 compare 4 min |
| macOS Rust (test + clippy + fmt) | 49 min | test compile 30 min, clippy 7 min + release clippy 2 min, tests 5 min, sentinel backend build 3 min |
| Windows installer artifact | 21 min | installer build 14 min, packaged smokes 7 min |
| Linux gates | 9 min | compile + test 7 min |
| JS (format + lint + tests) | 8 min | vitest 5.5 min, typecheck 36 s, format 29 s, lint 24 s, build 17 s |

- **Wait per code PR: 113 min.** Runner time per push: about 250 min. The
  repo is public, so the minutes are free, but GitHub caps concurrent jobs per
  account, so long jobs make the next PR queue.
- **The ownership loop** runs `cargo test -p videorc-backend $filter` once per
  filter per pass: 30 filters × 25 passes = 750 cargo launches at about 3 s
  each, each starting every test binary. The tests themselves take seconds.
- **The Windows test compile** uses the workspace dev profile (backend at
  opt-level 2, full debuginfo). macOS and Linux CI already write a CI-only
  profile (backend opt-level 0, line tables only) and set
  `RUST_MIN_STACK=8388608`. Windows does not.
- **Vitest:** 701 files, 331 s wall on one 4-core runner. Worker time: collect
  576 s, tests 168 s, prepare 61 s, environment 50 s, transform 24 s, so
  importing modules costs more than running tests. One file,
  `src/renderer/src/hooks/studio-provider.integration.test.ts`, takes 52 s by
  itself. The ten slowest files take 86 of the 168 s.
- **The backend is one crate**: 23 MB of Rust in 200 modules under one
  `main.rs`, with no `lib.rs`. Its test binary takes 30 min (macOS, opt-level 0)
  to 43 min (Windows, opt-level 2) to compile. Only splitting the crate fixes
  that (see "Not in this plan").
- **Which PRs could skip Rust:** of the last 40 merged PRs, 8 were docs or
  changelog only (already skipped), 7 changed app TypeScript that no Rust code
  reads, and 25 touched Rust, scripts, workflows, contract fixtures or a
  desktop file that Rust reads.

## The post's five ideas, for Videorc

| Idea | Videorc version | Slice |
| --- | --- | --- |
| A faster typechecker | TypeScript 7 (the native compiler; 7.0.2 is `latest` on npm) as the checker. TS 5.9 stays installed, because five guard tests and `scripts/lib/fake-cloud-web-managed.test.mjs` import its compiler API, and TS 7's package ships no JS API. | S13 |
| oxlint, every rule on | oxlint replaces ESLint. Checked 2026-11-16 in a scratch project: oxlint 1.93.0 enforces our Phosphor and Radix import bans with their messages, `no-unused-vars` with the `_` patterns, `rules-of-hooks` and `exhaustive-deps`. Then turn on more rule groups (D6). | S11, S12 |
| Shards balanced by recorded test time | Vitest 3.2.6's `--shard` splits by a hash of the path into equal file counts. A custom sequencer splits by recorded per-file time instead. | S7–S9 |
| PRs run only what the diff can reach | Jobs: a new "app TypeScript only" scope that skips Rust jobs. Tests: `vitest --changed` on PRs, with every test that reads files outside its imports always run. | S15, S16 |
| Everything in parallel | The JS job's steps become parallel jobs. The Windows gates split into a Rust job and a JS job. The macOS sentinel leaves the Rust job. | S4, S8, S14 |

## Expected result (estimates until each PR measures them)

| PR kind | Today | After PRs A–D | After all |
| --- | ---: | ---: | ---: |
| Code PR, wait | 113 min | ~60 min (Windows Rust job) | ~45 min (macOS Rust job), if D4 brings the Windows compile under it |
| Code PR, runner time | ~250 min | ~165 min | ~145–165 min |
| Renderer-only TypeScript PR | 113 min | ~60 min | ~6–8 min |
| Main-process TypeScript PR | 113 min | ~60 min | ~21 min (Windows installer, D7) |
| Docs-only PR | ~1 min | ~1 min | ~1 min |
| JS gates alone | 8 min | ~2.5 min | ~2 min |

A code PR cannot get near 2 minutes while the backend is one crate.

## Ground rules for every slice

- **Release reuses CI results.** `scripts/lib/reuse-release-ci-gates.mjs`
  (`RELEASE_CI_GATE_SPECS`) lets the Windows and Linux alpha releases skip
  their source gates when the same commit's CI job passed on `main`. Called
  from `release-windows-alpha.yml` (`--spec windows-js`, `--spec
  windows-rust`) and `release-linux-alpha.yml` (`--spec linux-rust`). Any
  slice that renames, splits or skips a gate job updates those specs and their
  tests in the same commit.
- **Tests read the workflow files.** `scripts/lib/release-ci-scope-workflow.test.mjs`
  asserts job names, step names and commands; `ci-change-scope.test.mjs`,
  `reuse-release-ci-gates.test.mjs`, `smoke-command-callers.test.mjs`,
  `recording-studio-gates.test.mjs`, `capture-decay-release-acceptance.test.mjs`,
  `linux-alpha-release.test.mjs`, `linux-release-candidate.test.mjs` and
  `scripts/live-lab/lib/install.test.mjs` read workflows too. Update a test
  when the structure moves, but never drop an assertion that a gate command
  still runs somewhere.
- **No required status checks exist.** `main`'s only ruleset ("Require PRs
  for main") requires a PR and blocks deletion and force pushes. The skip-twin
  jobs (same name, Ubuntu, prints "skipped") are not needed for merging.
- **`release-windows-gates.yml` is also the release gate.** The Windows alpha
  release calls it directly (`gates:` job). A change there changes release
  evidence.
- **Pin actions by SHA** in `release-*.yml` files, as they already are.
- **Verification for workflow slices:** `pnpm test:scripts`, `pnpm
  format:check` (Prettier covers `.github/workflows/*.yml`), then the PR's own
  CI run is the real proof. Record the measured minutes in "As built". No
  heavy local smokes: these slices change no app code (owner, 11-14:
  proportionate verification).

## Decisions

Recommended answers come first.

- **D1, how it lands.** (a) Eight small PRs, A–H, in the order below. Each
  one is measured and can be reverted alone, and PR A must land before
  anything that adds a skip path. (b) One PR for the whole plan, the usual
  PR-per-plan flow. A slower CI or a missed test would be hard to pin to one
  change.
- **D2, what a version-only release commit reuses** once S1 stops skip twins
  counting as passes. (a) The newest first-parent ancestor whose diff to the
  release commit is version, changelog or docs only, and only if that
  ancestor's real gate jobs passed on `main`. The release log names the
  ancestor. This keeps releases as fast as #855 intended. (b) Nothing: every
  Windows alpha runs its own Rust gates on the legacy path, a full Windows
  compile and test per release (that job allows 90 min). With either answer, `main` pushes cancel each other
  (`cancel-in-progress`), so an ancestor often has no finished run, and the
  release then runs its own gates.
- **D3, the Windows startup incident diagnostics job** (52 min per code PR,
  added 09-28 in #472, labelled "diagnostics only"). (a) Run it on pushes to
  `main`, on manual dispatch, and on PRs that change its own tooling. (b)
  Nightly plus manual. (c) Manual only.
- **D4, the CI-only fast profile on Windows.** (a) Use it in
  `release-windows-gates.yml` for every caller, like macOS and Linux CI do,
  once one PR shows the 25-pass race tests stay green on three runs. Release
  reuse already takes `main`'s PR-CI results, so PR-only would protect little.
  (b) PR CI only, through a workflow input. (c) Keep opt-level 2.
- **D5, where recorded test times live.** (a) A committed
  `apps/desktop/vitest-timings.json`, refreshed with one command when the
  aggregator reports the slowest shard more than 30% over the mean. Every
  shard reads the same file, so the split is deterministic and needs no extra
  job. Stale times only unbalance shards; they never skip a test. (b) An
  Actions cache saved by `main` pushes, plus a prep job that hands every shard
  the same snapshot. No commits, but one more job on the critical path.
- **D6, how many oxlint rules.** (a) Parity first (S11). Then turn on the
  `suspicious` and `perf` categories and the correctness rules of the
  `typescript`, `react`, `import`, `unicorn` and `vitest` plugins. Fix each
  finding or turn the rule off with a one-line reason. Type-aware rules come
  later. (b) Parity only. (c) Everything now, including type-aware rules
  through `oxlint-tsgolint`.
- **D7, the Windows installer job on app-TypeScript PRs.** (a) Run it when
  `apps/desktop/src/main/`, `src/preload/`, `electron-builder*`,
  `electron.vite.config.ts` or the renderer `index.html` change. Skip it for
  other renderer-only changes. (b) Always run it (21 min). (c) Never for this
  kind.
- **D8, diff-scoped vitest on PRs.** (a) Build S16 only if, after PR D, the
  slowest vitest shard still takes over 90 s. (b) Build it regardless. (c)
  Skip it.

## Battle order

| PR | Slices | Depends on | Owner route, lane |
| --- | --- | --- | --- |
| A | S1 Release reuse proves the gate really ran | none | Release, fit 9, `fable-5.1` |
| B | S2 One cargo launch per pass · S3 Prebuilt cargo-audit · S4 Windows JS in its own job · S5 Incident diagnostics off PRs | A | Implementation, fit 8, `fable-5.1` (release gate file) |
| C | S6 CI-only fast profile on Windows | B | Diagnose, fit 9, `fable-5.1` |
| D | S7 Time-balanced shards · S8 Parallel JS jobs · S9 Split the 52 s test · S10 Pool experiment | A (S8), B (S8's Windows shards) | Implementation, fit 8, `gpt-6.1-sol` |
| E | S11 oxlint parity · S12 Rule ratchet | none | Implementation, fit 8, `gpt-6.1-sol` |
| F | S13 TypeScript 7 checker | none | Implementation, fit 8, `gpt-6.1-sol` |
| G | S14 macOS sentinel in its own job · S15 App-TypeScript scope | A, B | Orchestrator, fit 9, `fable-5.1` (decides which gates a PR skips) |
| H | S16 Diff-scoped vitest on PRs (D8) | D | Implementation, fit 7, `gpt-6.1-sol` |
| later | S17 macOS clippy in a parallel job | G | only if macOS Rust stays the slowest job |

E and F can land any time. F does not need E, because TS 5.9 stays installed
for typescript-eslint and the guard tests.

## Slices

### S1: Release reuse proves the gate really ran (PR A)

**Goal:** a skip-twin job can never stand in for a gate that did not run.

**The bug, proven:** the 0.28.1 Windows alpha (run `43751226461`, commit
`e180003ef`, a version-only release commit) skipped "Run Windows Rust source
gates". Its reuse step matched `gates / Windows release source gates` in that
commit's `windows.yml` run, which was the 3-second Ubuntu skip twin
(`gates-skip`), because `jobSucceeded()` checks only the job name and
conclusion. The twin's own log says "The Windows alpha release workflow still
runs its own protected-main source gates", which is the opposite of what
happened. The Linux skip twin has the same name as the Linux gates job, so
`--spec linux-rust` has the same hole. The JS spec is safe today only because
version-only releases still run the JS job.

**Touches:** `scripts/lib/reuse-release-ci-gates.mjs`,
`scripts/lib/reuse-release-ci-gates.test.mjs`, `scripts/reuse-release-ci-gates.mjs`
if the CLI output changes. No workflow changes.

**Steps:**

1. Change each spec from `jobNames` to `jobs: [{ name, requiredSteps }]`. A
   run qualifies only when every listed job completed with `success` and every
   required step is present in that job's `steps` with conclusion `success`.
   The jobs API already returns `steps[].name` and `steps[].conclusion`.
2. Initial required steps:
   - `windows-source-gates` (`windows.yml`, `gates / Windows release source
     gates`): `Clippy`, `Source and audio ownership (25 stability passes)`,
     `Test (3 stability passes)`, `Rust format`, `Desktop tests`,
     `TypeScript`, `ESLint`.
   - `windows-js-job` (`ci.yml`, `JS (format + lint + tests)`): `Format
     check`, `Lint`, `Typecheck`, `Desktop tests`, `Node logic tests`.
   - `linux-rust-job` (`linux.yml`): `Clippy`, `Test`.
3. Per D2 (a): add an ancestor fallback. Walk `git rev-list --first-parent
   -n 20 <sha>`. For each ancestor, classify the diff from it to the release
   commit with `classifyChangeScope` from `scripts/lib/ci-change-scope.mjs`.
   Stop at the first ancestor whose diff is not `version-release`,
   `docs-record` or `docs`. Try the same spec at each ancestor visited. A hit
   returns `reason: 'ancestor-same-source'` plus `ancestorSha`, and the
   workflow log prints both. Check that each calling release job checks out
   with `fetch-depth: 0`; add it where missing. With D2 (b), skip this step.
4. Tests: a skip-twin job (right name, only a "Skip…" step) is not reused; a
   real job missing one required step is not reused; a real job is reused; the
   ancestor walk stops at the first code commit and never reuses across it.

**Done when:** `pnpm test:scripts` is green with the new cases, and running
`node scripts/reuse-release-ci-gates.mjs --spec windows-rust` for `e180003ef`
(with `GH_TOKEN`, `GITHUB_REPOSITORY`, `EXPECTED_SOURCE_COMMIT`) prints
`reused: false` (today it would reuse the twin). With D2 (a), it prints the
ancestor result or `reused: false` with the reason.

**Out of scope:** renaming the skip twins; the step check makes their names
harmless. Changing `cancel-in-progress` on `main`.

### S2: One cargo launch per stability pass (PR B)

**Goal:** the ownership loop keeps its coverage and drops from 38 min to
about 3 min.

**Touches:** `.github/workflows/release-windows-gates.yml`, the step `Source
and audio ownership (25 stability passes)`. Keep the step name: S1's spec
and `release-ci-scope-workflow.test.mjs` read it.

**Steps:**

1. Before the loop, run `cargo test -p videorc-backend -- --list` once and
   collect the test names. For each of the 30 filters, require at least one
   listed name containing it (libtest filters are substring matches), or throw
   naming the filter. This replaces today's per-run "executed zero tests"
   check. Count the expected tests: names matching any filter, minus those
   that `-- --list --ignored` also lists.
2. In each of the 25 passes, run `cargo test -p videorc-backend -- <all 30
   filters>` once. Verified 2026-11-16: libtest runs every test matching any
   of several filters in one run ("2 passed; 1 filtered out"). Require exit 0
   and the summed `N passed` across the `test result:` lines to equal the
   expected count.
3. Run the six Node files in one `node --test --test-concurrency=1
   --test-reporter=tap <files>` per pass. Concurrency 1 keeps them in the
   order they run today. Require exit 0, `# fail 0` and `# pass` above zero.
4. Leave `Preview bounds concurrency (25 stability passes)` as is: after the
   compile its 24 extra passes take 18 s in total.

Running all filtered tests in one process means they share it, as the full
suite already does in `Test (3 stability passes)`, so no test faces a new
condition.

**Done when:** on the PR's Windows run the step takes 4 min or less and
logs 25 passes, each with the expected count. A planted filter that matches
nothing fails the step with that filter's name (try it on a scratch commit,
then drop the commit).

### S3: Prebuilt cargo-audit (PR B)

**Goal:** stop building cargo-audit from source on every run (5.4 min).

**Touches:** `release-windows-gates.yml`, step `Install Rust advisory
auditor`.

**Steps:** replace `cargo install cargo-audit --locked` with
`taiki-e/install-action` (`tool: cargo-audit`), pinned to a commit SHA like
the file's other actions. `ci.yml` already installs it this way.

**Done when:** the step takes under 30 s and `Rust advisory audit` still runs
`pnpm audit:rust` and passes.

### S4: Windows JS gates in their own job (PR B)

**Goal:** the Windows JS checks (about 11 min) run beside the Rust gates
instead of after them.

**Touches:** `release-windows-gates.yml`, `scripts/lib/reuse-release-ci-gates.mjs`
and its test, `scripts/lib/release-ci-scope-workflow.test.mjs`.

**Steps:**

1. Split the one job into three:
   - `rust`, named `Windows release Rust gates`: checkout, Rust, cache, pnpm,
     Node, install, `Clippy`, `Preview bounds…`, `Source and audio
     ownership…`, `Test (3 stability passes)`, `Rust format`, the auditor and
     `Rust advisory audit`. It keeps pnpm because the ownership loop runs Node
     tests.
   - `js`, named `Windows release JS gates`: checkout, pnpm, Node, install,
     `Tracked text integrity`, `Desktop tests`, `Node logic tests`, `Format`,
     `TypeScript`, `ESLint`, `JavaScript advisory audit`.
   - `gates`, named `Windows release source gates`, an aggregator: `needs:
     [rust, js]`, `if: always()`, and one step that fails unless both
     results are `success`. Keeping this name keeps the PR checks list and the
     release-alpha `gates:` caller unchanged.
2. Point the reuse specs at the real jobs: `windows-rust` →
   `gates / Windows release Rust gates` with its steps; the `windows-js`
   lookup → `gates / Windows release JS gates` with its steps, then the
   `ci.yml` JS job. The aggregator is never a reuse target.
3. Update `release-ci-scope-workflow.test.mjs` to assert the three jobs, the
   aggregator's needs, and that every step the old job ran exists in one of
   them.

**Done when:** a PR run shows the Rust and JS Windows jobs running at the
same time, with the aggregator green, and `pnpm test:scripts` is green.

### S5: Incident diagnostics off PRs (PR B, per D3)

**Goal:** stop the 52-minute diagnostics job from running on every code PR.

**Touches:** `.github/workflows/windows.yml` (the `incident` job and its skip
twin), `scripts/lib/ci-change-scope.mjs` and its test,
`.github/workflows/ci-change-scope.yml` (new output),
`docs/windows-dev-loop.md` ("Startup incident diagnostics (Plan 067)").

**Steps (D3 a):**

1. Add a scope output `windows_incident_tooling`: true when the diff touches
   the job's own tooling, which is `scripts/lib/windows-incident-*.mjs`,
   `scripts/smoke-windows-stream-performance.mjs`, and the OpenH264 and MF
   probe scripts and sources the job runs. Read the job's steps for the exact
   files.
2. The `incident` job runs when the event is `push` or `workflow_dispatch`,
   or when `windows_incident_tooling == 'true'`, still behind `windows_heavy`
   for pushes. The skip twin runs for the other PRs, with a message saying
   where the job runs now.
3. Say the same in `docs/windows-dev-loop.md`.

**Done when:** an ordinary code PR shows the incident job skipped, the next
`main` push runs it, and `pnpm test:scripts` is green.

### S6: CI-only fast profile on Windows (PR C, per D4)

**Goal:** cut the 43-minute Windows test compile.

**Touches:** `release-windows-gates.yml`, the `rust` job from S4.

**Steps:**

1. Add the step `ci.yml` uses ("CI-only fast backend build profile") in
   PowerShell: append to `$env:CARGO_HOME\config.toml` (or
   `$env:USERPROFILE\.cargo\config.toml` when `CARGO_HOME` is unset)
   `[profile.dev] debug = "line-tables-only"` and
   `[profile.dev.package.videorc-backend] opt-level = 0`. Write
   `RUST_MIN_STACK=8388608` to `$env:GITHUB_ENV`. Print the file.
2. Bump the rust-cache `shared-key` (`…-v1` → `…-v2`) so no run restores
   artifacts built under the old profile.
3. Run the PR's Windows workflow three times (re-run the jobs). Record the
   compile minutes, and whether `Preview bounds…` and `Source and audio
   ownership…` stayed green on all three.
4. If a race test fails at opt-level 0 and not at opt-level 2, stop: revert,
   and record the test and its failure in this plan. A test that only passes
   at one speed is a finding, not something to tune away.

**Done when:** three green runs, with the measured compile time recorded.
With D4 (b), the profile sits behind an input that `windows.yml` sets and the
release caller does not.

### S7: Time-balanced vitest shards (PR D)

**Goal:** vitest shards that each take about the same time, with no test
skipped or run twice.

**Touches (new):** `apps/desktop/vitest/partition.ts` and its test,
`apps/desktop/vitest/timing-sequencer.ts`,
`apps/desktop/vitest/timing-reporter.ts`, `apps/desktop/vitest-timings.json`
(D5 a), `apps/desktop/vitest.config.ts`, `apps/desktop/package.json` (script
`test:timings`), `scripts/check-vitest-shard-coverage.mjs`.

**Steps:**

1. `partitionByWeight(paths, weights, count)`: longest-first greedy (sort by
   weight descending, then path; put each file in the lightest bin, lowest
   index on ties). It is pure and deterministic. Tests: the union equals the
   input, no file appears twice, the same input gives the same output, and an
   unknown file gets the median known weight (1000 ms when none is known).
2. `TimingSequencer extends BaseSequencer` (from `vitest/node`) overrides only
   `shard(files)`: keys are paths relative to `apps/desktop`, weights come
   from `vitest-timings.json`, and it returns bin `index - 1`. `sort()` stays
   inherited. Read `BaseSequencer` in `node_modules/vitest/dist` (3.2.6) for
   the `TestSpecification` shape before writing it.
3. `timing-reporter.ts`, active only when `VIDEORC_VITEST_TIMINGS_OUT` is set:
   on `onTestRunEnd(testModules)` it writes each file's
   `diagnostic()` collect + setup + environment + prepare + run durations,
   rounded to 10 ms, with sorted keys. Collect time is most of the cost, so a
   test-time-only weight would mis-balance. Check the `diagnostic()` field
   names in 3.2.6 first.
4. `pnpm --filter @videorc/desktop test:timings` runs the whole suite with
   the reporter and rewrites `vitest-timings.json`. Commit the first one.
5. Move the include globs into one exported constant that `vitest.config.ts`
   and the coverage check both import. `scripts/check-vitest-shard-coverage.mjs`
   takes the shards' JSON reports and compares the files they ran with
   `git ls-files` for those globs: no file missing, none twice. It also prints
   each shard's time and the slowest-to-mean ratio.

**Done when:** locally, `vitest run --shard=k/4` for k = 1..4 with JSON
reports passes the coverage check over every test file, and the
slowest-to-mean ratio with the committed timings is 1.25 or less.

### S8: Parallel JS jobs (PR D)

**Goal:** the JS gates finish in about 2.5 min instead of 8.

**Touches:** `.github/workflows/ci.yml`, `release-windows-gates.yml` (the `js`
job from S4), the reuse specs and their test,
`release-ci-scope-workflow.test.mjs`.

**Steps:**

1. In `ci.yml`, replace the `js` job with parallel jobs, each `needs: scope`
   and `if: … outputs.js == 'true'`:
   - `js-checks` "JS checks": `pnpm audit:js`, `pnpm format:check`, `pnpm
     lint`, `pnpm typecheck`.
   - `js-build` "JS build and asset budget": `pnpm build`, `pnpm
     check:renderer-assets`.
   - `js-node` "Node logic tests": `pnpm test:scripts`, `pnpm smoke:sources`.
   - `js-vitest`, matrix `shard: [1, 2, 3, 4]`, named `Desktop tests
     (${{ matrix.shard }}/4)`: `vitest run --shard=${{ matrix.shard }}/4`
     with the default and JSON reporters; upload the JSON report.
   - `js`, named `JS (format + lint + tests)`, the aggregator: `needs` all of
     them, `if: always() && needs.scope.outputs.js == 'true'`. It fails unless
     every needed job succeeded, then downloads the reports and runs
     `scripts/check-vitest-shard-coverage.mjs`. When the ratio passes 1.3 it
     prints a warning that names `pnpm --filter @videorc/desktop
     test:timings`.
   - `js-skip` stays.
2. In the Windows `js` job, split vitest into a three-shard matrix the same
   way, with its own aggregator step. Desktop tests take 9 min on Windows.
3. Point the `windows-js-job` spec at all the new `ci.yml` jobs and their
   steps, so it requires every one, each shard included. The aggregator is
   never a reuse target.
4. Update `release-ci-scope-workflow.test.mjs` so every command the old JS
   job ran is still asserted somewhere in `ci.yml`.
5. Drive-by: delete `apps/desktop/electron.vite.config.1787864947110.mjs`, a
   leftover electron-vite temp file that got committed. Add
   `electron.vite.config.*.mjs` to `.gitignore`.

**Done when:** a PR run's JS aggregator goes green 3 min or less after the
scope job, the coverage check counts every test file, and `pnpm
test:scripts` is green.

### S9: Split the 52-second test file (PR D)

**Goal:** no single file sets the floor for a shard.

**Touches:** `apps/desktop/src/renderer/src/hooks/studio-provider.integration.test.ts`
and new sibling files.

**Steps:** split by top-level `describe` into three or four files, with
shared setup in a helper next to them. Change no test bodies. Refresh
`vitest-timings.json`.

**Done when:** the test count matches before and after (the vitest summary),
and each new file runs under 20 s.

**Out of scope:** the known flake in "resumes the cloud show through
cloud.show.resume". Note which new file holds it.

### S10: Pool experiment (PR D, measured)

**Goal:** find out whether vitest's collect time (576 s of worker time) drops
with a different pool.

**Steps:** on a branch, run the suite five times each with today's config,
`pool: 'threads'`, and `isolate: false`. The `--no-experimental-webstorage`
flag lives under `poolOptions.forks` today; find the threads equivalent.
Keep a change only if all five runs are green and the suite is at least 25%
faster. Otherwise record the numbers here and change nothing.

**Done when:** the numbers are recorded, plus the config change if one won.

### S11: oxlint replaces ESLint, same rules (PR E)

**Goal:** the same lint result in a few seconds.

**Touches:** root `package.json` (`lint` script, dev dependencies),
`.oxlintrc.json` (new), `eslint.config.mjs` (deleted), `pnpm-lock.yaml`.

**Steps:**

1. Generate a first config with `npx @oxlint/migrate` (1.93.0 on npm), then
   check it against `eslint.config.mjs` rule by rule:
   - the Radix `patterns` ban on all `apps/desktop/**/*.{ts,tsx}`;
   - the Phosphor `paths` ban on `apps/desktop/src/renderer/**`, except
     `components/icons.tsx`, `stream-manager/activity-icons.tsx` and
     `avatar-page-icon.tsx`. Use an `overrides` entry for those three that
     sets only the Radix ban;
   - `no-unused-vars` with the three `^_` ignore patterns;
   - `react-hooks` `rules-of-hooks` as error and `exhaustive-deps` as warn;
   - `no-undef` and `no-explicit-any` off;
   - the default `correctness` category, the closest match to
     `js.configs.recommended` plus `tseslint.configs.recommended`. List the
     differences in the PR.
2. `lint` becomes `oxlint apps/desktop && pnpm check:em-dashes`. Warnings stay
   non-fatal, as today.
3. Check every `eslint-disable` comment still suppresses its rule (oxlint
   reads them). Run with `--report-unused-disable-directives` and fix the
   names it reports.
4. Remove `eslint`, `@eslint/js`, `typescript-eslint` and
   `eslint-plugin-react-hooks`.

**Done when:** `pnpm lint` passes on the tree, a planted violation of each
rule above fails it (scratch file, then delete), and the CI lint step takes
under 5 s.

### S12: Turn on more rules (PR E, per D6)

**Goal:** catch more bugs, the "every rule we can turn on" part.

**Steps (D6 a):** turn on the `suspicious` and `perf` categories, then the
correctness rules of the `typescript`, `react`, `import`, `unicorn` and
`vitest` plugins, one group per commit. For each finding, either make a
mechanical fix that changes no behaviour, or turn the rule off with a
one-line reason in `.oxlintrc.json`. Any fix that changes behaviour goes to
its own PR, not here.

**Done when:** lint is green and this plan's "As built" lists each rule
turned off and why.

### S13: TypeScript 7 as the checker (PR F)

**Goal:** typecheck in seconds instead of 36 s.

**Touches:** `apps/desktop/package.json`, `apps/desktop/tsconfig.json`,
`tsconfig.node.json`, `tsconfig.web.json`, `pnpm-lock.yaml`.

**Steps:**

1. Add a dev dependency alias, `"typescript-native": "npm:typescript@7.0.2"`.
   Keep `typescript@^5.9.3`, because `renderer-buddy-name-guard`,
   `renderer-copy-guards`, `renderer-shortcut-guard`, `renderer-style-guards`,
   `renderer-toast-guards` and `scripts/lib/fake-cloud-web-managed.test.mjs`
   import its compiler API, and typescript-eslint needs `typescript <6.1`
   until S11 lands. TS 7's package ships no JS API.
2. Remove `baseUrl` from the three tsconfigs (TS 7 removed it) and write
   `paths` as `"@/*": ["./src/renderer/src/*"]`. TS 5.9 accepts that too.
3. Point `typecheck` at TS 7's compiler by its path inside the alias package.
   Both packages name their bin `tsc`, so do not rely on `.bin/tsc`. Check
   how `bin/tsc` finds its platform package (`@typescript/typescript-<os>-<arch>`
   optional dependencies) on macOS, Linux and Windows.
4. Run both compilers on the tree. If TS 7 reports an error TS 5.9 does not
   and TS 7 is right, fix the code. If TS 7 looks wrong, stop and report.

**Done when:** `pnpm typecheck` runs TS 7 and passes, the CI step takes
under 10 s on Linux and Windows, and the five guard tests still pass.

### S14: The macOS sentinel in its own job (PR G)

**Goal:** the only CI step that boots the app runs beside the Rust tests,
and can run without them (needed by S15).

**Touches:** `.github/workflows/ci.yml`, `scripts/lib/ci-change-scope.mjs`,
`ci-change-scope.yml` (new output `macos_sentinel`), and the tests.

**Steps:**

1. A new `sentinel` job, "macOS app sentinel", on `macos-15`, runs when
   `macos_sentinel == 'true'` (true for the code kind, and for app-ts in S15).
   Move these steps out of `rust`: build the backend binary, install
   dependencies, `pnpm smoke:process-memory:sentinel`, upload the report. It
   writes the same CI-only profile and `RUST_MIN_STACK`.
2. Give `rust` and `sentinel` one rust-cache `shared-key`. `rust` saves the
   cache and `sentinel` only restores it.
3. The Camera extension Swift tests stay in `rust`.
4. Update `release-ci-scope-workflow.test.mjs`.

**Done when:** a code PR run shows both jobs running at once, `rust` at about
45 min, and `sentinel` green in 8 min or less.

### S15: Skip Rust jobs for app-TypeScript-only PRs (PR G)

**Goal:** a PR that changes only app TypeScript that no Rust code reads skips
every Rust job.

**Touches:** `scripts/lib/ci-change-scope.mjs` and its test,
`ci-change-scope.yml`, `ci.yml`, `windows.yml`, `linux.yml`,
`release-windows-gates.yml` (new input), a new
`scripts/lib/ci-change-scope-rust-reads.test.mjs`.

**Steps:**

1. In the classifier, add `RUST_READS_DESKTOP`, the desktop paths Rust
   includes or reads. Found 2026-11-16 with a single-line grep, so the guard
   in step 4 must find them properly:
   - `apps/desktop/src/shared/` (`live_background/export.rs`);
   - `apps/desktop/src/renderer/src/assets/` (`buddy_pet.rs`,
     `remote_lan_server.rs`, `scene.rs`);
   - `apps/desktop/src/renderer/src/styles.css` and
     `apps/desktop/src/main/window-palette.ts` (`served_page_palette.rs`);
   - `apps/desktop/resources/` is outside `src/`, so it is already code.
2. Add the kind `app-ts`: every file is a docs path, a JS test path, or under
   `apps/desktop/src/` and not in `RUST_READS_DESKTOP`, with at least one
   such app file. Outputs: `macos_rust` false, `macos_sentinel` true,
   `linux_heavy` false, `windows_heavy` false, `windows_js` true (new),
   `windows_installer` per D7, `js` true. Also set `windows_js` true for the
   existing `js-test` kind, so test-only PRs run the Windows desktop tests.
   Every other kind keeps its outputs.
3. Give `release-windows-gates.yml` a boolean input `rust` (default true).
   The `rust` job runs only when it is true. The aggregator accepts a skipped
   `rust` only when the input is false. `windows.yml` calls the gates when
   `windows_heavy` or `windows_js` is true and passes `rust:
   windows_heavy`. Release reuse stays safe: S1 requires the Rust job's own
   steps, which a skipped job does not have.
4. The guard test scans every `.rs` and `build.rs` under `crates/` for
   `include_str!`, `include_bytes!`, `include!` and string literals containing
   `apps/desktop/`, including calls split across lines. It resolves each to a
   repo path and fails if the classifier would call that path `app-ts`. A new
   Rust read of a desktop file then fails CI until the list covers it.
5. Classifier tests: renderer-only → `app-ts`; `styles.css` → code;
   `window-palette.ts` → code; `src/shared/` → code; `src/main/` → `app-ts`
   with the installer on (D7 a); any `Cargo.toml`, `crates/`, `scripts/`,
   `.github/` or `protocol-fixtures/` file → code.

**Done when:** classifier and guard tests are green, and a real renderer-only
PR finishes in 10 min or less with the macOS Rust, Linux and Windows Rust
jobs skipped, and the sentinel, Windows JS and JS jobs green.

**Note:** `styles.css` is code because Rust reads it, so most CSS edits still
run Rust. A follow-up could move the tokens `served_page_palette.rs` reads
into their own file (see "Not in this plan").

### S16: Diff-scoped vitest on PRs (PR H, per D8)

**Goal:** a small PR runs the tests its diff can reach, not all 700.

**Touches:** `ci.yml` (`js-vitest`), a new
`scripts/select-vitest-mode.mjs` and its test.

**Steps:**

1. Only on `pull_request`, a select step outputs `full` or `subset`. It is
   `full` when the diff touches `package.json`, `pnpm-lock.yaml`,
   `apps/desktop/vitest.config.ts`, `apps/desktop/vitest/`, any tsconfig,
   `protocol-fixtures/`, `crates/`, `scripts/lib/` files the tests import, or
   more than 60 files. Pushes to `main` are always `full`.
2. `subset` runs two commands in one job: `vitest run --changed <base sha>`
   (Vitest follows the import graph), then the always-run set. The always-run
   set is every test file matching
   `readFileSync|readdirSync|readFile\(|readdir\(|globSync|existsSync|statSync|new URL\(`,
   computed at run time, never a hand-kept list. On 2026-11-16 that was 89 of
   702 files, 13 of which scan directories, among them the copy, style,
   shortcut, toast and name guards. These read files the import graph cannot
   see.
3. Positional vitest filters match substrings. Check with `vitest list
   --filesOnly` that the always-run filters select exactly those files.
4. `full` uses the S8 shard matrix.

**Done when:** a renderer-only PR's vitest runs in under 60 s, a PR touching
`protocol-fixtures/` runs the full shards, and the selector's tests cover
each fallback.

### S17: macOS clippy in a parallel job (later)

Only if, after PR G, macOS Rust is still the slowest job and macOS jobs are
not queueing. Move `Clippy` and `Clippy (release)` (9 min) into a second
macOS job that restores the same cache. It costs one more macOS runner per
PR.

## Not in this plan

- **Splitting the backend crate.** This is the real fix for 30–43 min test
  compiles: a `lib.rs` plus crates the compiler can build in parallel and
  cache when they don't change. It needs its own plan.
- **Moving the palette tokens Rust reads** out of `styles.css` into a small
  file of their own, so most CSS edits classify as `app-ts`.
- **`cancel-in-progress` on `main`.** Each push cancels the previous `main`
  run, so many merged commits never finish their gates, and release reuse
  then finds nothing. Changing that costs runner time; it is a separate call.
- Replacing Prettier (29 s), paid larger runners, and required status checks.
- Fixing the StudioProvider cloud-resume flake (S9 only moves it).

## As built

Empty until the first PR lands. Record each PR's measured minutes here.
