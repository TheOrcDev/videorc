# macOS performance budget v1

This directory defines the file contract for calibrated performance budgets. It does not contain
active budget data yet. `active-budget.schema.json` defines the reviewed profile shape that can be
populated after calibration. The release sentinel requires
`active/macos-release.json`; its loader will not launch the app unless exactly one profile matches
the current scenario, profile class (`short-sentinel` or `endurance`), app version, packaged build
identity, exact warm-up/measurement/sample interval, platform/architecture, and either its exact
machine model or an explicit workflow-owned hardware class. The calibrated commit and executable
SHA-256 remain immutable provenance. Runtime activation instead matches a packaged-app payload
digest over the app launcher, `app.asar`, Electron runtime, `videorc-backend`,
`native_preview_host_helper`, `videorc_native_preview.node`, `ffmpeg`, and `ffprobe`. The manifest
hashes `app.asar` directly and uses every Mach-O component's Code Directory hash, so
notarization/signature timestamps do not masquerade as code changes. A missing Code Directory hash
fails closed; there is no raw-binary fallback for unsigned Mach-O code. This lets the reviewed
budget file be committed after calibration without creating a HEAD self-reference while still
binding all runtime code that can affect the measured capture and encoding path.

Release activation evidence must be collected from the signed packaged app. Unsigned development
packages remain useful for investigation, but are not release activation evidence. Scheduled runs
must receive a pre-staged Developer ID-signed app and its source commit through the repository
variables, while workflow dispatch can provide both values as inputs. The commit must exactly match
the checked-out `GITHUB_SHA`; otherwise the workflow stops with the package-contract error before
measuring anything. The workflow never substitutes a newly built unsigned package and never claims
scheduled success without current signed-package evidence.

Scheduled and ordinary workflow-dispatch gates also require a reviewed active budget set through
`VIDEORC_PERF_SCHEDULED_ACTIVE_BUDGET_PATH` or the `active_budget_path` input. Each scenario selects
its unique matching profile and evaluates it in the gate process, including nested record-plus-stream
runs. Only a workflow dispatch with the explicit `calibration_mode` boolean sets
`VIDEORC_PERF_CALIBRATION=1` and clears active-budget enforcement so new three-run candidates can be
collected. Because this repository currently has no active budget data, enforcement runs stop with
that pre-measurement contract until maintainers review and activate calibration evidence.

`cross-machine-native-cadence.json` is the separately versioned product floor. Active hardware
profiles may require a higher presented FPS or a lower interval p95, but can never weaken those
cross-machine limits.

`pnpm perf:calibrate` accepts exactly three clean packaged child reports. A short-sentinel set uses
at least a 60-second warm-up and a measurement below 10 minutes; an endurance set uses at least a
60-second warm-up and a measurement of 10 minutes or longer. It verifies that reports came from the
same commit, executable and packaged-payload SHA-256 values, app version, profile class, machine,
macOS build, workload, and timing before writing:

- a detailed calibration summary containing the three observed values, median, and maximum for
  cadence, RSS slopes and plateaus, per-role memory plus average/p95 CPU, physical footprint, and
  open files;
- an unenforced budget candidate matching `budget-candidate.schema.json`.

Every three-run workload receives a separate primer run before its calibration set. Lifecycle-churn
calibration uses the same three-run endurance contract and evaluates memory, average/p95 CPU,
resource counts, and clean teardown without fabricating preview-cadence values. Detached preview,
recording/stream, and lifecycle gates evaluate any requested active budget against the metric
contract that the workload can actually collect.

The candidate intentionally has `thresholds: null` and `enforcement: disabled`. Observations are
not limits. A maintainer must review calibration evidence, choose explicit headroom, document the
hardware scope, and populate a reviewed profile matching `active-budget.schema.json` before the
release sentinel can run. An explicitly requested budget path or profile fails closed if the
scenario, machine model, build mode, required metrics, or profile schema do not match.

Active evidence also names the three unique run nonces and portable report paths, the calibration
generation time, and the calibration's canonical SHA-256 so review cannot silently drift away from
the evidence it approved.

Store generated evidence in the workflow artifact directory. The `candidates/` and `active/`
subdirectories document the review states for any files deliberately checked into version control.
