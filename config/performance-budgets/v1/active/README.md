# Active budgets

No v1 budget data is active. Activation requires explicit threshold values derived from reviewed
three-run packaged calibration evidence in a profile matching `../active-budget.schema.json`. Keep
short-sentinel and endurance windows separate, bind the exact app/build/hardware/timing identity,
match the calibrated packaged-app payload digest at runtime, and preserve the provenance commit,
executable digest, immutable calibration digest, run nonces, and report paths. The provenance
commit is deliberately not compared to runtime HEAD because adding this active file creates a new
commit without changing packaged application bytes. Do not copy observed maxima directly into
this directory as limits; review variance and document explicit headroom.

Preview profiles enforce cadence plus memory/CPU/resource/teardown limits. Recording and stream
profiles enforce their captured cadence plus memory/CPU/resource/teardown limits, while
lifecycle-churn profiles enforce memory/CPU/resource/teardown limits without inventing preview
wire metrics. Forced or escalated termination is never a clean teardown.

The release workflow requires `VIDEORC_PERF_RELEASE_BUDGET_PROFILE` to name the reviewed
short-sentinel profile. Hosted release CI performs artifact-only preflight against the signed
payload and does not pretend to run ScreenCaptureKit without the authorized runner's TCC grants.
The scheduled performance workflow requires `VIDEORC_PERF_SCHEDULED_ACTIVE_BUDGET_PATH`; a manual
dispatch may override that path or explicitly select calibration mode to collect unenforced
candidates.
