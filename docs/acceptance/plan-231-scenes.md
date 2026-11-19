# Plan 231: scenes acceptance — 2026-11-16

Status: final recording-studio verification is running. The two requested
post-ruling smart-scenes runs completed; both passed the corrected vertical
pixel check, but their strict Camera-only return gates are red on native SDK
fallbacks. No assertion or native timeout was relaxed. Final bundle results
will be appended below before handoff. S10's off-stream HUD is separate.

## Timing ruling and A/B verdict

Switch timing is **report-only**, as explicitly authorized by the orchestrator.
No relative failure threshold was introduced. Missing/refused cuts, black and
wrong-layout frames, Follow and privacy retain their hard gates. The historic
150 ms switch target remains visible in the metadata. Timing-host waits are
preserved: both requested runs set
`VIDEORC_SMART_SCENES_MAX_HOST_LOAD=10`. That waits before a recording; it does
not guarantee that load remains below 10 throughout it.

| Measurement                               | Main `8620b5fc2` p50 / p95 |                  Branch p50 / p95 | Per-recording load            |
| ----------------------------------------- | -------------------------: | --------------------------------: | ----------------------------- |
| Matched app ↔ app, shortcut path, 20 cuts |               189 / 229 ms |                      208 / 241 ms | Main 9.7→9.6; branch 9.9→9.5  |
| Camera only → app, main A2, 10 returns    |               283 / 359 ms |           Historical 229 / 325 ms | Main 9.6→12.7; branch 9.9→9.9 |
| Camera only → app, main A3, 10 returns    |               147 / 223 ms | Same historical branch comparison | Main 9.9→8.8                  |

Both sides had zero black/wrong-layout frames. The matched app-switch p95 is
+12 ms (+5.2%), less than one 30 fps frame. The orchestrator ruled that this
is within host noise and does not establish a plan-231 timing regression;
main misses 150 ms too. Main was already warm at the Camera-return click,
so these measurements do not establish a cold-start-at-return speedup.
The full method, anchor drift, sampled load ranges and artifacts are in
`/Users/orcdev/projects/plan-231-run/AB/notes.md`. Later timings are reported
with their actual load; they are not substituted for the matched A/B.

## Requested post-ruling smart-scenes runs

Both commands used `VIDEORC_SMOKE_SKIP_PREBUILD=1` and
`VIDEORC_SMART_SCENES_MAX_HOST_LOAD=10`.

| Run              | Result | App cuts; p50 / p95 / max; load     | Camera-return result; load                                                     | Log                                                            |
| ---------------- | ------ | ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| accepted-smart-1 | FAIL   | 20/20; 264 / 323 / 365 ms; 9.3→11.2 | First return reported restart; 0/10 completed; 9.7→19.2                        | `/Users/orcdev/projects/plan-231-run/S11/accepted-smart-1.log` |
| accepted-smart-2 | FAIL   | 20/20; 194 / 260 / 260 ms; 10.0→9.3 | Six returns in place, then discovery timeout/restart; 6/10 completed; 9.3→11.0 | `/Users/orcdev/projects/plan-231-run/S11/accepted-smart-2.log` |

Both passed v1 migration (Figma/T3 Code fixture apps, order, on-stream scene,
position 1, Follow, both layouts and untouched v1 data), three app additions
at the end without a program change, reorder/key mapping, the real slot
shortcut handler, rapid keys with the first key actually pending, both
stream legs in their own layouts, the Camera-only vertical cases, relaunch,
password-manager hide/show/manual preservation and out-of-sight recovery.
App cuts and rapid/vertical checks had zero black/wrong-layout frames.
Camera-only hold identity, frame-counter and generation checks passed before
the return that failed; the interrupted return loops are not ten-return passes.

Run 1's Follow gate has no usable pixel latencies at load 29.5→26.5, and its
Screen ISO hide analysis has no frames before/inside the hidden interval.
Recording, local RTMP and Clips each passed 98/98 frosted samples. Run 2
passes Follow at 608/542 ms (unchanged 650 ms budget), all four hide outputs
at 97/97 frosted samples, and password auto-hide at 2 ms. Run 1 auto-hide is
3 ms. All show-on-leave and manual-hide preservation assertions pass.

The native SDK failures are retained as reds. Run 1 logs discovery timeout
in its prewarm, then the existing 250 ms content-filter timeout on the return;
run 2 fails later on discovery timeout. Main A1/A2/A3 logs contain three
unique 250 ms configuration/filter timeout events, preserved in
`S11/existing-main-sdk-timeouts.json`. This establishes that the fallback
mechanism also exists on main; it does not turn the strict D18 gates into
passes or prove causality for every discovery failure on this host.

The Follow single-flash inference is byte-for-byte identical to main's
analyzer. On the same failing frames both infer the end anchor and both
produce missing latencies. `S11/main-anchor-comparison.json` and its log
preserve that comparison. Diagnostic start anchoring gives 477/550 ms, but
is not a changed assertion or a promoted pass. The same inherited inference
is used for Screen ISO. Run 2 passes both without a code change.

Earlier full S11 runs passed all steps: app p50/p95 156/180 and 149/224 ms,
load 8.5→7.0 and 13.2→9.5; ten Camera returns 192/265 and 171/240 ms,
load 7.0→7.1 and 9.5→9.0. A later pre-ruling run passed ten returns at
204/264 ms, load 13.0→9.8, before its explained vertical expectation STOP.
Those results remain historical evidence, not replacements for the requested
post-ruling run results.

## Vertical-only expectation correction

The orchestrator decoded the prior STOP's vertical file with the maintained
decoder/verdict functions. Row 1 was clean. Row 2's seven flagged frames were
all before the cut: a uniform full-frame Camera-only placeholder has no
inset/border mark. It cuts to blue with the expected mark at 256 ms, with
zero after-cut black, old-window or wrong-layout frames, load 10.1→9.3.

Exactly one expectation changes: the second verticalOnly row's
`fromLayoutMark: true` becomes `false`, with the one-line full-frame Camera
only comment. Every assertion remains unchanged. Both new runs pass this
case. The plan's intent is unchanged. Original STOP artifacts remain in
`S11/STOP.md`; the supplied diagnostic is
`/Users/orcdev/projects/plan-231-run/DIAG/vertical-only.mjs`.

## Product ownership fences

The fixed-window probe found a separate product mutation: source confirmation
for the destination could arrive before the renderer changed active scene,
then autosave that window into the departing scene. Its provider regression
holds the RPC receipt and delivers that exact event; it fails before the
fix. Pending layout transactions now own the complete picture update while
microphone confirmation remains independent. A second red→green regression
holds a reload across a scene change; its checkpoint is fenced by the
request's original scene id and layout intent. No temporary debug hooks remain.

Both regressions pass in the full 227-test provider suite. The full native
window probe passes 20 idle + 20 recording + 20 layout-changing switches;
its 5,103 decoded recording frames contain zero black/other/wrong-layout.
Recording p50/p95 is 95/153 ms at load 11.3→7.8; layout-changing 118/158 ms
at 7.9→7.1. The strict artifact check passes. Main's ready-save focused
baseline passes 2/2 cuts at 156/162 ms, load 13.4→12.5. Logs are
`S11/verified-window-full.log`, `S11/verified-window-artifacts.log`,
`S11/main-window-ready-final.log` and `S11/main-window-ready-artifacts.log`.

## Harness changes

A layout edits a scene; a fresh profile has four defaults; additions append;
remove is awaited; legacy layout requests map to the first matching scene or
return a named refusal. Remote/MCP assertions use ordered, on-stream scene
projection. Seed helpers keep/clear v2 with the working scene, including the
pagehide rewrite. Synthetic fixtures explicitly belong to a test-pattern
scene instead of relying on a transient flag with a retained display id.
Camera selection is shared, so the original Camera Off fixture is restored
before Follow. A saved-scene remote key first switches away to prove a real
confirmed-state edge; display confirmation polls both renderer and persisted
shows after ACK. All exact ids, ACK correlation, allowlists and deadlines stay.

Password-manager setup now uses the production screen picker, which clears
the retained app choice, and asserts the same scene owns the exact display
before testing auto-hide. The old direct config helper retained the app and
D19 correctly refused/restored it. No privacy product change was needed.
The window probe copies before editing the next scene. The preview loop
scrolls its docked canvas back into view before asserting native presentation;
main and branch had both intentionally hidden it by scrolling inspector controls.

The decoder preserves one decoded sample per encoded timestamp; a passing
FFV1 gap/transition regression prevents CFR duplication and shifted cuts.
DEV-only hooks call existing Add/Edit, source picker and global shortcut
actions. Assertion changes are documented individually in external
`S11/assertion-changes.md`; full patches are retained there. The recording-
studio wrapper's explicit --keep-going checkpoints every constituent and
still returns failure if any step fails; default fail-fast is unchanged.

## Verification, budget and visual review

Typecheck, lint, 43 focused Node tests, the full desktop suite (709 files,
8,305 passed/one skipped), production build, scene-presets, scene-item-drag,
remote-control retry, layout/source loop and both multistream vertical gates
passed on the ownership-fence source. Lint has one inherited talk-show
useMemo warning. Targeted Rust passed 212/212 (75 live-layout, 70 scene,
17 remote-control, 12 agent-look, 15 agent-tools, 23 buddy-act), plus format.
Plain clippy fails on main #1397's live_status.rs dead code; the same command
with -A dead_code passes. No full Rust suite, per owner directive.

The maintained LGPL FFmpeg 8.1.1 build, capture-clock patch and bundle checks
passed through the shared slot with two jobs. The ignored camera-look parity
test then passed against that actual bundle; no PATH/GPL substitute was used.

The owner approved cap commit `23c6a3ca0`: raw 2,397,000 / gzip 493,000.
S11 does not edit the checker. The final asset gate passes at **2,389,940 raw /
491,709 gzip**, entry 1,073,492 / 227,140, with **7,060 / 1,291** headroom.
The ownership fences add 406 raw/84 gzip over c9c2e1d24's review build;
DEV hooks add no shipping UI. Report: `S11/renderer-asset-budget-accepted.json`;
logs `S11/verified-build.log` and `S11/accepted-renderer-assets.log`.

All six light/dark PNGs were opened and reviewed at 1280×860 logical pixels:
Studio, Sources and Scene page. No new visual issue was apparent; expected
dev microphone permission copy is visible. Paths are
`S11/shots/videorc-ui-{studio,sources,layout}-{dark,light}.png`.

## Known reds and attribution limits

The MCP Buddy/avatar wording assertion fails at B7 on both main and branch;
Sidekick act's Moved Sidekick versus Moved Avatar copy fails on both. The
Node remote test rejects the required /Users report path on both. The
no-microphone Camera ISO analyzer rejects digital silence on both at the
same first failing case. The preview interaction window oracle fails to
find its in-process window on both. The Silk shader p95 gate fails on both
(earlier main 5.492 ms at load 21.0, branch 6.233 ms at load 11.8, limit 1.5).
System-audio fails on both with different tone failures: branch dropouts/
truncation, main mostly no tone. This is not an exact cause comparison and
no healthy-main baseline is claimed. Comparison log paths appear in the
final gate table. These reds were not chased or relaxed.

Freeform-editor's final startup-artifact mismatch is pre-existing in the
brief (2026-11-03). Its known scene-item-drag setup red did not reproduce:
scene-item-drag passes. Layout-dock steps 27/35 are named pre-existing reds,
not new passes claimed by this slice. Guard-blocked attempts and the earlier
interrupted final run remain separate entries in the complete ledger.

## Owed checks

Windows clean-install Ctrl+Alt+Shift+1–9 registration, Windows CI and
smoke:hide-screen:windows remain owed. The dev app has no physical camera/
microphone TCC grants for the device acceptance bundle; synthetic evidence
does not claim that coverage. Closest native screen/preview probes and real
ScreenCaptureKit recording are recorded below. Owner hands-on acceptance of
the single-monitor app/key workflow and Scenes/Sources relationship remains
owed. D8 and D20 are approved decisions; S10's HUD remains separate.

## Evidence

All `S11/` paths are under `/Users/orcdev/projects/plan-231-run/`.
`results.md`/`results.jsonl` checkpoint completed commands immediately;
recording-studio also writes every constituent's JSON, log, duration and load.
Live-stream, memory, smoke-lock and build-slot guards were respected in the
foreground. Shadscan's established baseline/floor is 27; a fresh JSON audit
must meet it immediately before each local commit. No push or rebase.

<!-- FINAL_GATE_TABLE -->

## After the rebase onto main (2026-11-19)

Branch `plan-231-scenes-v2` (PR #1543), rebased onto `db2313f73`, dev
backend built in a slot, `VIDEORC_SMOKE_SKIP_PREBUILD=1`,
`VIDEORC_SMART_SCENES_MAX_HOST_LOAD=10`. The shared Mac was loaded by other
sessions (load 10–70, up to 8 GB swap), so timing is reported, not judged.

| Step                                     | Run 4                                                        | Run 5                                       |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| migration, new-scenes, reorder           | PASS                                                         | PASS                                        |
| switches (20 cuts)                       | PASS: p50/p95 196/241 ms, 0 black, 0 wrong layout            | PASS: 319/446 ms, 0 black, 0 wrong layout   |
| camera-return (10)                       | PASS: 265/407 ms, every return in place                      | Not judged: load stayed above 10 (33.5)     |
| rapid-keys, vertical-keys                | PASS                                                         | PASS                                        |
| relaunch, follow, hide, password-manager | PASS                                                         | PASS                                        |
| out-of-sight                             | FAIL: capture stopped 3 s into the hold (load 23, 8 GB swap) | PASS: notice 7.2 s, no recovery, back 5.8 s |

Before run 4, vertical-keys failed once (run 2) on five held frames of a real
camera's full-frame picture. Its texture read as a layout mark. The smoke now
judges only the incoming layout when it leaves a camera picture
(`fromLayoutMark: null`); the cut itself was clean.
