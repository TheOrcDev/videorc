# 2026-08-24 macOS recording source-decay acceptance

This record tracks Plan 041's automated proof and required before/after
owner-device gate. Recordings, generated analyzer reports, screenshots, support
bundles, process samples, app data, and device identifiers remain outside Git.

## Status

- Overall verdict: **BLOCKED — permissioned ScreenCaptureKit motion proof did
  not reach recording**
- Root-cause verdict: **unproven**
- Candidate classification: verified lifecycle, capture-accounting, retained
  backing, and CVMetal correctness/headroom work; not an accepted incident fix
- Code baseline: `92f91493`
- Candidate runtime commit: `b43abaa7` on
  `codex/041-macos-recording-source-decay`
- Installed app inspected: `0.9.74`, bundle ID `dev.theorcdev.videorc`, signed
  by Team ID `C2PA37RB58`
- Host: macOS 26.5.1 (25F80), arm64

The untouched 0.9.74 app passed the real-device preview interaction work and
the device suite through its first 24 stages, but the old harness failed on a
main-process-only native-preview RPC before it could encode the first terminal
clip. The candidate corrected that harness ownership. Repeated focused
candidate runs then proved that Videorc's ScreenCaptureKit source itself was
live, but the captured pixels contained only the animated desktop wallpaper
and cursor—not either maintained motion-stimulus window. The fail-closed color
signature therefore rejected the source before encoding.

This is Plan 041's explicit STOP condition: a focused recording smoke failed
twice after a reasonable correction, and the permissioned real-device
acceptance could not run. No freshness threshold was weakened, no additional
media experiment was attempted, and synthetic evidence is not substituted for
the terminal clips.

## Fixed acceptance contract

Every accepted row must use one normally launched installed-app generation,
3840x2160 at 30 fps, ScreenCaptureKit screen plus AVFoundation camera, and
continuous visible motion for more than 60 seconds. A row passes only when all
of the following hold:

- screen and camera fresh delivery are each at least 28 fps;
- source freshness is at least 90 percent under motion;
- maximum served age is at most 200 ms;
- decoded unique-frame ratio is at least 95 percent;
- no corroborated freeze exceeds 400 ms;
- final accounting exists and reports no writer leak/lingering event;
- post-stop outer writer, FIFO writer, and capture-resource counts are zero;
- surface-backed live counts stay bounded and return to the idle baseline.

## Untouched 0.9.74 baseline

The installed version was verified, but no row below is accepted because the
first terminal recording never started.

| Clip | Installed version | Duration           | Screen evidence                    | Camera evidence | Artifact evidence | Final lifecycle state | Verdict |
| ---- | ----------------- | ------------------ | ---------------------------------- | --------------- | ----------------- | --------------------- | ------- |
| 1    | 0.9.74            | Not recorded       | Motion proof blocked before encode | Not measured    | Not available     | Not available         | BLOCKED |
| 2    | 0.9.74            | Not run after STOP | Not available                      | Not available   | Not available     | Not available         | BLOCKED |
| 3    | 0.9.74            | Not run after STOP | Not available                      | Not available   | Not available     | Not available         | BLOCKED |

## CVMetal ownership/cache candidate

The candidate keeps camera acquisition dimensions, queue depth, device
settings, and encoder profile unchanged. It now retains the CVMetalTexture
wrapper through GPU completion, reuses imports by process-monotonic storage
identity, periodically flushes the texture cache after completed work, and
reports source/backing/cache lifecycle evidence. Those contracts are covered
by deterministic tests, but the rows remain blocked because real-source motion
proof failed before recording.

| Clip | Candidate  | Duration           | Screen evidence                                           | Camera evidence | Artifact evidence | Import/backing/lifecycle evidence | Verdict |
| ---- | ---------- | ------------------ | --------------------------------------------------------- | --------------- | ----------------- | --------------------------------- | ------- |
| 1    | `b43abaa7` | Not recorded       | Backend source live; stimulus absent from captured pixels | Not measured    | Not available     | Deterministic gates only          | BLOCKED |
| 2    | `b43abaa7` | Not run after STOP | Not available                                             | Not available   | Not available     | Deterministic gates only          | BLOCKED |
| 3    | `b43abaa7` | Not run after STOP | Not available                                             | Not available   | Not available     | Deterministic gates only          | BLOCKED |

## Automated evidence

| Gate                                             | Result  | Notes                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo build -p videorc-backend`                 | PASS    | Warning-free build.                                                                                                                                                                                                                                   |
| `cargo clippy -p videorc-backend -- -D warnings` | PASS    | No warnings.                                                                                                                                                                                                                                          |
| `cargo fmt --check --all`                        | PASS    | Final format check.                                                                                                                                                                                                                                   |
| Focused writer lifecycle tests                   | PASS    | `stop_and_reap` 2/2, `encoder_bridge_lifecycle` 5/5, plus eight focused ownership/race/persistence cases.                                                                                                                                             |
| Focused capture/backing tests                    | PASS    | Drop reasons 4/4; surface backing helper 3/3 and main 3/3; camera target 1/1.                                                                                                                                                                         |
| Focused Metal cache tests                        | PASS    | GPU helper 8/8 and main 9/9.                                                                                                                                                                                                                          |
| `pnpm test:scripts`                              | PASS    | 1,087/1,087 tests across 206 suites.                                                                                                                                                                                                                  |
| Desktop typecheck, lint, and format              | PASS    | Direct desktop typecheck, repository lint, and 1,170-file format check passed.                                                                                                                                                                        |
| Desktop unit tests                               | PASS    | 1,505 passed, 1 skipped, 0 failed across 159 files.                                                                                                                                                                                                   |
| Analyzer CLI                                     | PASS    | 10.03-second synthetic clip: 301/301 unique frames, no freeze, 7 ms A/V skew, 1920x1080@30 BT.709.                                                                                                                                                    |
| Synthetic three-session decay gate               | PASS    | Three sessions in one backend generation; 30 fps, zero degraded bridge share, no stale-source service, and zero post-stop lifecycle counts. This does not prove real-device freshness.                                                                |
| Preview interaction stress                       | PASS    | About 60 fps, zero additional drops, native surface remained live/aligned/frontmost.                                                                                                                                                                  |
| Preview lifecycle probe                          | PASS    | 100/100 cycles with clean teardown and a flat backend plateau.                                                                                                                                                                                        |
| `pnpm smoke:recording-studio`                    | BLOCKED | Stages 1–24 passed, including artifact inspection, real launch, layout/scene/pump/focus/interaction/lifecycle/native reattach coverage. Stage 25 stopped before encode because the real screen source did not contain the maintained motion stimulus. |
| `pnpm smoke:recording-matrix`                    | NOT RUN | Mandatory STOP condition had already fired.                                                                                                                                                                                                           |
| `pnpm smoke:recording-studio:devices`            | BLOCKED | Required terminal real-device clips could not start with valid visible-motion proof.                                                                                                                                                                  |

The broad Recording Studio run's completed backend slices included live layout
(31), scene (43), recording (266 passed, 1 ignored), audio (23), and noise (20)
tests. Its detached preview lifecycle completed 100 cycles and interaction
stress reported no additional preview drops.

## Blocker evidence

Generated evidence remains outside the repository:

- Broad stage-25 visibility failure:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1787620158600`
- Focused native-stimulus backend proof:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1787621371576`
- Focused Chromium-stimulus backend proof and blocked-start report:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1787621434351`
  and
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1787621434351/videorc-session-2026-08-25T01-30-42-901Z.blocked-start.md`
- Synthetic three-session report root:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-session-decay-1787619496369`
- Preview lifecycle report:
  `docs/acceptance/artifacts/performance/preview-lifecycle-2026-08-25T01-08-53-867Z.json`
  (ignored generated artifact, not committed)

In the decisive focused run, the backend reported a live screen source and
delivered five proof frames, but the backend-captured top-down BGRA frame lacked
the required cyan, magenta, yellow, white, and dark stimulus signature. Visual
inspection showed the dynamic forest wallpaper and cursor only. Both the
native Swift and Chromium stimulus drivers were absent from the source pixels.

## Decision record

No causal branch is confirmed. The lifecycle registry, admission fence,
fallback generation cancellation, fail-closed oracle, capture/status
accounting, truthful retained-backing diagnostics, and CVMetal ownership/cache
corrections are verified independently and are suitable for review. They do
not establish that the original 4K screen-and-camera decay is fixed.

Plan 041 and Plan 034 remain BLOCKED. To resume, the owner must restore a
ScreenCaptureKit/TCC context that exposes a maintained motion-stimulus window,
then run the untouched-baseline and candidate batches as three consecutive
greater-than-60-second 4K30 screen-plus-camera clips in one normally launched
installed-app generation. Only those six accepted rows can close the incident.
