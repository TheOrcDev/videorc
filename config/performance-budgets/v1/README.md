# macOS performance budget v1

This directory defines the file contract for calibrated performance budgets. It does not contain
active budget data yet. `active-budget.schema.json` defines the reviewed profile shape that can be
populated after calibration. The release sentinel requires
`active/macos-release.json`; its loader will not launch the app unless exactly one profile matches
the current scenario, build mode, platform/architecture, and either its exact machine model or an
explicit workflow-owned hardware class.

`cross-machine-native-cadence.json` is the separately versioned product floor. Active hardware
profiles may require a higher presented FPS or a lower interval p95, but can never weaken those
cross-machine limits.

`pnpm perf:calibrate` accepts exactly three clean, packaged, 60-second warm-up plus 10-minute
measurement child reports. It verifies that the reports came from the same commit, executable
SHA-256, machine, macOS build, workload, and timing before writing:

- a detailed calibration summary containing the three observed values, median, and maximum for
  cadence, RSS slopes and plateaus, per-role memory/CPU, physical footprint, and open files;
- an unenforced budget candidate matching `budget-candidate.schema.json`.

The candidate intentionally has `thresholds: null` and `enforcement: disabled`. Observations are
not limits. A maintainer must review calibration evidence, choose explicit headroom, document the
hardware scope, and populate a reviewed profile matching `active-budget.schema.json` before the
release sentinel can run. An explicitly requested budget path or profile fails closed if the
scenario, machine model, build mode, required metrics, or profile schema do not match.

Store generated evidence in the workflow artifact directory. The `candidates/` and `active/`
subdirectories document the review states for any files deliberately checked into version control.
