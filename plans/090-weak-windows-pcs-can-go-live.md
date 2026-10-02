# Plan 090: Weak Windows PCs can go live (Quick Sync, step-down, honest checks)

> Executor: read this plan, `AGENTS.md` and Plan 088 first. Work in your own
> worktree from current `origin/main`. Owner route: Diagnose then
> Implementation (fit 9), model lane `fable-5` (recording start path,
> encoder selection, Windows-only, hardware we do not own).

## Status

- Priority: P1. Effort: L overall. Risk: LOW for phases A and B, HIGH for C
  (new encoder path), MED for D.
- Status: **EXECUTED 2026-10-01, in review**, in one PR at the owner's
  request (branch `fix/088-go-live-shared-encode-fallback`). Built: A, B1,
  B2, B3, C1 to C6, D1, D2. Not built: C8. Owed, and only a Windows PC with
  Intel graphics can pay them: C0 and C7. See "What was built" below; where
  it differs from a slice's text, that section wins.
- Planned 2026-10-01 against `origin/main` `76eb1668`.
- Supersedes the remaining slices of Plan 088 (S2, S4, S5). Plan 088 keeps
  the investigation and the evidence.
- Depends on: Plan 065 (MF probe ladder, rejection cache), Plan 052/053
  (the Linux VAAPI selector this plan copies its shape from).

## What was built (2026-10-01)

Nothing here ran on Windows hardware. The Windows target compiles
(`pnpm check:windows`), and every decision that can be tested off-box is.

| Slice | Built as | Differs from the slice text |
| --- | --- | --- |
| A | Rejected split re-plans as one shared encode; Go Live waits for the check | Finding: default captions (`burnTarget: 'stream'`) forced a split on every record+stream session, so no bitrate ever unblocked it |
| B1 | One 30 s deadline around the blocking MF probe; a timeout is remembered as a rejection; no new probe while an abandoned one is stuck | 30 s, not 20: the full ladder on the reporter's PC took about 20 s. Renderer timeout left at 120 s (two profiles fit) |
| B2 | One log line per `stream.output.topology.probe`: duration, roles, profiles, path, encoder, verdict | Log line only; no new diagnostics field |
| B3 | Warning in the Go Live confirmation when nothing held steady in the performance check and the session encodes on the CPU | - |
| C1 | `h264_qsv` reported as an optional encoder by the package preflight | No runtime `-encoders` query: a build without it fails the probe and falls back to software |
| C2 | `WindowsQsv` and `WindowsQsvStandardPower` (low-power off) platforms; `hardware-qsv` backend name | No `-profile:v`/`-level` pin, like the Media Foundation arms; the VUI rewrite is applied |
| C3 | Child-process probe at the session profile with the session arguments, 15 s kill deadline, default then low-power off, cached per backend lifetime | **No cross-launch quarantine.** The deadline covers a hang; a PC that crashes inside the probe would probe again next launch. The probe proves the encoder starts, not that it keeps up; the performance check measures speed |
| C4 | Applied in `resolve_windows_encoded_bridge_decision` only when the bridge decision is raw; lifts the record-only software canvas cap; the stop-time drain policy covers QSV | - |
| C5 | `VIDEORC_WINDOWS_H264_ENCODER=auto|quick-sync|software`, a saved preference, and a Beta control in Settings → Recording shown only on Windows with an Intel adapter | Settings → Recording, not Output |
| C6 | Performance-check key includes a non-default preference; `--expect-fallback hardware-qsv` in the Windows stream smoke | No new named cases in `--list` |
| C8 | **Not built** | It would double the Media Foundation probe time on exactly the PCs that already wait longest, and nobody can run it. Do it with a tester |
| D1 | `tutorial-540p30` (960x540, 30 fps, 2500 kbps) as the ladder floor and a named preset | One rung, not several |
| D2 | A CPU-encoded stream steps down, for the session, to the output that held steady; recording shares it; broadcasts are prepared at it | Done in the renderer per session, not in backend provider planning. Left alone: hardware-encoded, stale or untrusted measurement, portrait, simulcast |
| Budget | The Go Live output logic loads on demand; two view-only modules left the startup bundle | Not in the plan: the work pushed the eager bundle 6.7 KB over its 2 MB budget |

### C0, for the reporter

Run in a Command Prompt. Send back everything it prints.

```bat
cd /d "%LOCALAPPDATA%\Programs\Videorc\resources\ffmpeg\bin"
ffmpeg -hide_banner -encoders | findstr /i "qsv h264_mf"
ffmpeg -hide_banner -f lavfi -i color=c=black:s=1920x1080:r=30 -t 10 -c:v h264_qsv -preset medium -async_depth 4 -bf 0 -b:v 6000k -maxrate 6000k -bufsize 12000k -g 60 -f null NUL
ffmpeg -hide_banner -f lavfi -i color=c=black:s=1280x720:r=30 -t 10 -c:v h264_qsv -preset medium -async_depth 4 -bf 0 -b:v 4000k -maxrate 4000k -bufsize 8000k -g 60 -f null NUL
ffmpeg -hide_banner -f lavfi -i color=c=black:s=1920x1080:r=30 -t 10 -c:v h264_qsv -low_power 0 -preset medium -async_depth 4 -bf 0 -b:v 6000k -maxrate 6000k -bufsize 12000k -g 60 -f null NUL
```

These are the arguments the app uses. If a line ends with a `speed=` figure
the encoder works; if it prints an error, that error is the answer.

To try it in the app once a build with this PR is installed: Settings →
Recording → Fallback video encoder → Intel Quick Sync, then Recording →
Output → Check again, then go live to a private broadcast.

## Goal

A Windows PC whose Media Foundation hardware encoder is rejected can still
go live, and gets the best stream that PC can actually deliver:

1. Go Live is never refused for a reason the app can resolve itself.
2. The Intel encoder is used when it works, even if Media Foundation
   cannot drive it.
3. When only software encoding is left, the stream drops to a size the CPU
   can hold, and the user is told before going live.

## The report this comes from

One Windows 0.9.124 user, Intel UHD Graphics 600 (evidence in Plan 088,
private files in `~/Downloads`, never commit them):

- Go Live was refused with a "Checking…" toast, then permanently with "A
  separate encoded livestream output is unavailable…". Matching the bitrate
  to 6000 kbps did not help. The owner hit the same refusal.
- Quick Sync through Media Foundation fails on every size down to 720p:
  `stage=process-output HRESULT=0x8000FFFF`, in both input topologies.
- Software OpenH264 measured 0.58x real time at 1080p30 and 0.685x at
  720p30. CPU compositor. Screen capture reached 13 to 18 fps.
- OBS streams fine on the same PC. OBS drives Quick Sync through Intel's
  own library, not Media Foundation.

## What is already established

| Fact | How it was checked |
| --- | --- |
| Default captions (`burnTarget: 'stream'`) make the renderer request a split (recording + stream encoders) for every record+stream session, even with captions off and equal profiles. That is why 6000 kbps never unblocked anyone. | Read `buildStreamOutputTopologyProbeParams`; failing test reproduced it |
| The backend already allows a shared raw encode when profiles match, and says a captions-off pre-arm must not block a start (`validate_caption_output_policy`, `recording.rs:18886`) | Read the code |
| The pinned Windows FFmpeg already contains `h264_qsv` (built with `--enable-libvpl`), plus `h264_amf` and `h264_nvenc`. No FFmpeg change is needed. | Downloaded the pinned zip, sha256 matched `vendor/ffmpeg/windows-pin.json`, `strings` on `ffmpeg.exe` |
| The Windows software fallback is the raw path: frames are piped to FFmpeg, which encodes with `libopenh264` (`recording.rs:12312`, args at `:12784`) | Read the code |
| Linux already has the pattern this plan needs: a preference, a real-arguments probe, a per-backend cached decision, a hang quarantine, and a software fallback (`recording.rs:12391` to `:12640`) | Read the code |

Not established: whether `h264_qsv` actually works on the reporter's PC,
and how much of his load is encoding versus capture and compositing. No
Windows machine was used for any of this.

## How OBS handles Quick Sync (read 2026-10-01)

Source: `obsproject/obs-studio` at `a8b04ac`, `plugins/obs-qsv11/`. OBS
links Intel's library (oneVPL) directly; we would reach the same library
through FFmpeg's `h264_qsv`, so the lessons carry over as FFmpeg options.

| What OBS does | Where | What we take from it |
| --- | --- | --- |
| Tests the hardware in a **separate process** (`obs-qsv-test`) that kills itself after 10 s | `obs-qsv-test/obs-qsv-test.cpp` (`CHECK_TIMEOUT_MS`, `TimeoutThread`) | Our probe is already a separate FFmpeg process; give it a hard kill deadline and treat a timeout as "not available" (C3). A hung driver must never hang the backend. |
| Registers the encoder only when an **Intel adapter** is present | `obs-qsv11-plugin-main.c` `obs_module_load` | Gate the tier on an Intel adapter (already in C4/C5). |
| Turns the low-power encode mode on **only for Arc (DG2) and newer**; older chips use the standard mode. If the driver rejects the settings, it flips low-power off and retries | `QSV_Encoder_Internal.cpp:248` and `:455` | Never force low-power. Probe with FFmpeg's default first, then retry once with `-low_power 0`. The reporter's UHD 600 is far older than DG2. |
| Defaults: CBR, balanced speed (TU4), High profile, async depth 4 (1 only for "ultra-low" latency), buffer of 2x the bitrate | `obs-qsv11.c:165`, `:597`; `QSV_Encoder_Internal.cpp:258` | Start from the same: CBR at the session bitrate, balanced preset, async depth 4. Do not copy our Media Foundation "low latency" setup. |
| Uses 3 B-frames by default | `obs-qsv11.c:181` | We keep 0 B-frames (existing provider and timing assumptions). This is a deliberate difference; note it in the argument comment. |
| Has two encoders: GPU-texture input and system-memory input, and **falls back to system memory** when textures are not usable (other adapter, CPU scaling) | `obs-qsv11.c:836` `obs_qsv_create_tex` | Our tier is the system-memory shape (raw frames piped to FFmpeg). That is OBS's own fallback, so it is a supported way to drive the chip, just not the fastest. |
| Treats "device busy" as wait-and-retry, not a failure | `QSV_Encoder_Internal.cpp:789` | FFmpeg handles this internally; nothing to build, but a slow first frames must not fail the probe. |
| Handles pre-Tiger Lake chips through the legacy runtime path | `obs-qsv-test.cpp` ("Encoder information is not available before TGL") | The reporter's chip is in this class. C0 must prove FFmpeg's loader finds the legacy runtime on his PC. |

Two consequences beyond Phase C:

- **A lead for the Media Foundation failure (Plan 067).** Our MF probe asks
  for low-latency CBR on every chip. OBS deliberately avoids the aggressive
  mode on older Intel chips and retries without it. Whether our low-latency
  flag is what the UHD 600 rejects is unproven, but one extra probe rung
  with low latency off is cheap to try. Tracked as C8, not required for C.
- **Why OBS is smoother than we will be on his PC.** OBS keeps capture,
  compositing and encoding on the GPU when it can. Our fallback copies
  every frame through system memory. Quick Sync removes his encode cost,
  not his capture and compositing cost.

## Decisions

- **Rollout of Quick Sync: opt-in first.** Off by default, switched on per
  tester, default-on only after the criteria in C7. The owner asked for a
  full plan without choosing; this is the recommended option. Changing it
  only changes C5 and C7.
- **Below-floor PCs: warn and allow.** A block with no alternative is worse
  than an honest warning, and a saved check can be stale. Owner may flip it.
- **No encoder swap mid-session.** A failed encoder ends the session, as
  today. The safety is in the probe and the rollout, not in live recovery.

## Out of scope

- A release. AMD (`h264_amf`) and NVIDIA (`h264_nvenc`) tiers: same shape,
  separate plan once QSV has run real sessions.
- Fixing the Media Foundation path itself, the GPU compositor on low-end
  Intel, or screen-capture rate. Plan 067 owns the MF investigation.
- Changing the FFmpeg pin, new codec dependencies, anything on macOS/Linux.

---

## Phase A. Go Live stops refusing (BUILT, uncommitted)

Worktree `~/projects/videorc-wt-088`, branch
`fix/088-go-live-shared-encode-fallback`, renderer only. Files:
`hooks/use-studio.tsx`, `lib/capture.ts`,
`components/streaming/go-live-panel.tsx` and their tests.

- A rejected split re-plans as one shared encode; when the recording was
  set higher than the stream, it takes the stream's profile for that
  session (`resolveStreamOutputTopologyRequest`). Saved Output is untouched.
- Go Live waits for a running check and retries a failed one
  (`settleStreamOutputTopology`), before any platform broadcast is created.
- One plain notice; no HRESULT text in toasts.
- Still blocked, with a short reason: live captions burned into the stream
  only, and destinations with different profiles.

Verified: desktop tests 2,519 pass (including an end-to-end rejected-split
Go Live), typecheck, lint, format, build. Not verified: any Windows run;
enabling captions mid-session on a shared encode.

### A1. Land it

- Rebase on main, commit, open the PR, link Plans 088 and 090.
- Windows check by a tester (or the reporter on a pilot build): record +
  YouTube, default settings, click Go Live within two seconds of launch.
  Expected: it waits, then goes live; no red toast.
- Check what the backend does when captions are switched on mid-session on
  a shared raw encode. If it burns into the recording, say so in the notice.

Done when: PR merged and the Windows check is recorded in this file.

## Phase B. The check always answers, and says what it found

### B1. Backend deadline for the hardware probe (was 088 S2)

- Wrap the `spawn_blocking` hardware probe in
  `probe_windows_native_encoded_bridge` (`recording.rs:14603`) in one
  overall deadline. Start at 20 s; tune from B2's measurements.
- On expiry: `Rejected` verdict with a plain reason, stored in
  `WINDOWS_MF_PROBE_REJECTIONS` so `session.start` does not repeat the wait.
- Single-flight per rejection key; a late result may update the cache.
- Lower the renderer timeout for `stream.output.topology.probe`
  (`backendClient.ts:128`) from 120 s to the deadline plus slack.

Done when: a unit test with a never-returning probe gets `Rejected` inside
the deadline and an immediate cached answer on the second call;
`pnpm check:windows` compiles.

### B2. Probe timing and verdict in the support bundle (was 088 S4)

- One log line per topology probe: profile, roles, elapsed ms, verdict,
  cache hit, and which encoder tier answered (needed by Phase C).
- Make sure it reaches the bundle. Any new diagnostics field gets Rust and
  TS mirrors together and `skip_serializing_if` on every `Option`.

Done when: a bundle exported after a probe shows its duration and verdict.

### B3. Below-floor warning at Go Live (was 088 S5)

- In the Go Live confirmation, when the saved performance check has
  `belowFloor=true` and the verdict is software encoding, show one plain
  warning that viewers will see a stuttering picture. Warn and allow.
- Follow `videorc-design`. No new surface.

Done when: renderer tests cover below-floor + software (warning) and a
passing check (no warning).

## Phase C. Quick Sync through FFmpeg

The new tier sits between today's two: Media Foundation hardware (unchanged)
→ **FFmpeg `h264_qsv` on the raw path** → OpenH264 software (unchanged). It
is only considered after the Media Foundation probe is rejected, only on a
PC with an Intel adapter, and only after its own probe passes.

Copy the Linux VAAPI selector's structure. Do not invent a second pattern.

### C0. Evidence before code (needs the reporter or an Intel PC)

Send the reporter three commands to run with the bundled
`resources\ffmpeg\bin\ffmpeg.exe`, and keep the full output:

1. `ffmpeg -hide_banner -encoders` (confirm `h264_qsv` is listed on-box).
2. A 10 s 1080p30 synthetic encode to `NUL` with `h264_qsv`, CBR 6000 kbps,
   default low-power setting, reading the reported speed.
3. The same at 720p30, 4000 kbps.
4. If (2) or (3) fails: the same again with `-low_power 0` (what OBS falls
   back to on older chips).

Stop the phase if (2) and (3) both fail on his PC: Quick Sync through
FFmpeg is then not his fix, and the reason must be understood first.

Done when: outputs are recorded in this file (redacted) with the speed.

### C1. Capability gate

- Add `h264_qsv` to an **optional** encoder list in
  `scripts/lib/windows-ffmpeg-capabilities.mjs` and report it in the
  Windows FFmpeg fetch/verify step. Do not make it required: a future pin
  without it must degrade to software, not fail the build.
- Backend: detect at runtime that the bundled FFmpeg lists `h264_qsv`
  (once per backend lifetime, cached).

Done when: `node --test scripts/lib/windows-ffmpeg-capabilities.test.mjs`
covers present and absent.

### C2. Encoder platform and arguments

- New `FfmpegH264Platform::WindowsQsv` beside `WindowsSoftware`
  (`recording.rs:12013`), codec `h264_qsv`, input `nv12`.
- Arguments for live use, starting from OBS's defaults: CBR at the session
  bitrate with a 2x buffer, balanced preset, async depth 4, 2 s GOP as the
  provider plan requires, no B-frames (our choice, OBS uses 3). Leave
  low-power at FFmpeg's default; the selector may add `-low_power 0` when
  the probe needed it. Record the exact argument set and why in a comment, as the
  OpenH264 arm does (`:12784`). Keep the existing colorimetry and
  profile/level handling; check which of those `h264_qsv` accepts.
- New `EncodeBackend::HardwareQsv` with protocol and TS mirrors, so
  diagnostics and Technical details say "Intel Quick Sync", never
  "software". Update `repair.rs`/publish paths only if their encoder tables
  are exhaustive matches that would otherwise not compile.
- Every exhaustive `match` on `FfmpegH264Platform` gets an explicit arm
  (about 15 sites); none may fall through to the software arm silently.

Done when: argument unit tests assert the full `h264_qsv` argument list for
record, stream and record+stream; `cargo test -p videorc-backend ffmpeg`
passes; `pnpm check:windows` compiles.

### C3. Real-arguments probe

- Probe with the session's own arguments at the session's profile, feeding
  real-size frames through the same raw input shape, for long enough to
  see sustained output (not three tiny frames; Linux learned this in Plan
  052, and `h264_mf` once passed a null-output probe and then stalled,
  Plan 035).
- Pass requires: exit 0, at least N frames out, encode speed at or above
  real time, inside a hard deadline. On deadline the FFmpeg child is
  killed and the verdict is "not available" (OBS kills its test process
  after 10 s for the same reason).
- Two-step ladder like OBS: default settings, then once more with
  low-power off. The session uses exactly the step that passed.
- Wrap the probe in a hang quarantine like the Linux sentinel: if the host
  dies or the probe hangs, the next launch does not try that encoder again
  until the driver identity changes.
- Cache the decision per backend lifetime, keyed by FFmpeg binary, adapter
  + driver identity, and profile. Remember rejections with a TTL like the
  MF cache.

Done when: tests cover pass, non-zero exit, slow encode, timeout, and
quarantine after a simulated hang, all with a fake FFmpeg.

### C4. Selection

- `resolve_windows_h264_encoder`: when the session's bridge decision is the
  raw path (MF rejected or not requested) and the preference allows it,
  probe QSV; on pass use `WindowsQsv`, else `WindowsSoftware` with the
  rejection reason kept for diagnostics.
- Wire it where the raw fallback encoder is chosen today
  (`resolve_windows_encoded_bridge_decision`, `decision.fallback_ffmpeg_encoder`,
  `recording.rs:14354`), so the topology probe RPC and `session.start`
  resolve the same encoder.
- `resolve_windows_recordable_video` (`:14293`): a PC with a passing QSV
  tier is not "no usable GPU encoder"; the software cap must not apply.
- Raw-path special cases keyed on `WindowsSoftware` (`:1904`, `:16913`)
  need a deliberate decision each: does it apply to QSV too.

Done when: selector unit tests cover every combination of MF verdict,
preference, capability and QSV probe result.

### C5. Opt-in control

- Preference with three values: Automatic (today's behaviour, QSV not
  tried), Intel Quick Sync (try it, fall back to software), Software only.
  Env override `VIDEORC_WINDOWS_H264_ENCODER` for testers and smokes,
  mirroring `VIDEORC_LINUX_H264_ENCODER`.
- Settings → Output, Windows only, shown only when the bundled FFmpeg has
  `h264_qsv` and an Intel adapter is present. Label it Beta. Changing it
  clears the cached decision and re-runs the output check.
- Follow `videorc-design`; shadcn components only.

Done when: the setting round-trips, is hidden on macOS/Linux and on PCs
without an Intel adapter, and a renderer test covers it.

### C6. Measure it

- The performance check must run with the selected encoder, and its
  capability key must include the encoder choice so a result measured on
  software is not reused for QSV.
- Extend `smoke:windows-stream-performance` with a QSV case selected by
  the env override; it must fail on a startup timeout or missing evidence.

Done when: `pnpm smoke:windows-stream-performance -- --list` shows the QSV
cases and the performance-check tests cover the new key.

### C7. Tester acceptance and default-on criteria

- Reporter (or an equivalent Intel PC): opt in, run the performance check,
  record + stream for 10 minutes to a private YouTube broadcast, export
  the bundle. Record delivered fps, encoder speed, freezes, A/V sync.
- Default-on (Automatic tries QSV after an MF rejection) only when: at
  least three different Intel generations have each completed a 30 minute
  session with no encoder stall, and no opt-in user has reported a stall
  for two releases. That change is its own small PR.

Done when: results are recorded here, including a failure if that is the
outcome.

### C8. Optional: one more Media Foundation probe rung

Independent of C1 to C7. Add one rung to the existing MF probe ladder with
low-latency mode off, tried after the current rungs fail on an Intel
adapter. If it passes on the reporter's PC, his existing hardware path
works again with no new encoder tier, and separate recording + stream
encoders come back too. Unproven; do it only with a tester able to run it,
and record the result under Plan 067 either way.

Done when: the rung exists behind the same rejection cache, a unit test
covers the ladder order, and a tester result is recorded.

## Phase D. Stream at a size the PC can hold

Independent of Phase C; needed for PCs with no working hardware encoder at
all, and as the floor under QSV.

### D1. Lower rungs in the performance check

- Add rungs below 720p30 (candidates: 540p30, 480p30, and 720p at a lower
  frame rate only if a named preset and the providers accept it). Check
  `validate_named_video_profile` and each provider's minimums first; add
  named presets rather than `custom`.
- Keep the rule that the floor must be measured before the check may say
  the PC cannot hold it (`performance_check.rs:221`).
- Bump the capability key version so old results are re-measured.

Done when: unit tests cover the new ladder and `recommend`.

### D2. Stream step-down (finishes Plan 065 B3)

- When the effective encoder is software and the saved check says the
  requested stream profile is below real time, plan the stream at the
  highest rung that passed, through provider-aware planning (renderer
  `resolveProviderStreamOutputPlan` and backend
  `resolve_provider_stream_output_plan` stay mirrors).
- Keep the requested profile separately; expose requested and effective in
  diagnostics. Never change a destination's saved settings, never drop a
  destination.
- Tell the user in the Go Live confirmation, in the same notice style as
  Phase A: what it will stream at and why.
- If no rung passed, fall back to Phase B3's warning; do not pretend.

Done when: plan tests (Rust and TS) agree on the stepped-down profile for
shared, record+stream and multi-destination sessions, and an integration
test shows `session.start` carrying it.

---

## Order

A1 → B1, B2 → C0 → (C1, C2) → C3 → C4 → C5 → C6 → C7, with B3 and Phase D
in parallel once A1 is merged. C0 gates all of Phase C. Each phase is its
own PR.

## Risks to other users

| Who | Risk | Guard |
| --- | --- | --- |
| Windows users whose MF hardware path works | None intended: QSV is only considered after an MF rejection | Selector tests in C4 |
| macOS, Linux | None: Windows-only code | `cfg` gates; cross-platform tests still run the tables |
| Intel users on software fallback who opt in | A probe can pass and the encoder still stall in a real session; the session ends | Real-arguments probe (C3), quarantine, opt-in (C5), default-on criteria (C7) |
| Everyone on Windows | No FFmpeg change, so no new binary | Pin unchanged; `h264_qsv` optional in the gate |
| Low-end PCs | One more probe at first start | Cached per backend lifetime; deadline |
| Users whose stream is stepped down | Lower quality than they chose | Notice before going live; requested profile preserved |

## Verification

```sh
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test:scripts
pnpm --filter @videorc/desktop test
cargo fmt --check --all
cargo test -p videorc-backend ffmpeg
cargo test -p videorc-backend stream_output_topology
cargo test -p videorc-backend performance_check
cargo clippy -p videorc-backend -- -D warnings
cargo build --release -p videorc-backend
pnpm check:windows
pnpm build
```

Use `RUSTUP_TOOLCHAIN=1.98.0` while floating stable is broken. Run gates at
low priority if Videorc is live on this Mac. Phases B to D touch the start
path and encoding: also `pnpm smoke:recording-studio`,
`pnpm smoke:record-latency:gate` and `pnpm smoke:recording-matrix` on macOS
to prove nothing moved there. On Windows: `pnpm smoke:local-gates:windows`
and the stream-performance smoke on the candidate. Cross-compiling is not
hardware evidence; the tester runs in C0 and C7 are the acceptance.

## Stop conditions

- C0 fails on the reporter's PC: stop Phase C and find out why before
  writing code.
- A QSV probe passes and a real session stalls on any tester PC: do not
  widen the rollout; tighten C3 until the probe predicts it.
- A slice needs a different FFmpeg pin, a new dependency or a licence
  change: stop and ask.
- Never weaken a startup proof or a quality threshold to get a pass.

## Known gaps

- No Intel Windows machine is available to us; every hardware fact is
  second-hand until C0.
- On the reporter's PC, capture and compositing are also CPU-bound. Quick
  Sync removes the encode cost only. Phase D is what guarantees him a
  stream; Phase C decides how good it looks.
- The legacy Intel runtime that UHD 600 needs must be present in his
  driver for `h264_qsv` to load. OBS working suggests it is; C0 proves it.
