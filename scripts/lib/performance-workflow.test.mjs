import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const workflow = readFileSync(
  new URL('../../.github/workflows/performance-macos.yml', import.meta.url),
  'utf8'
)
const releaseWorkflow = readFileSync(
  new URL('../../.github/workflows/release-macos.yml', import.meta.url),
  'utf8'
)
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const lifecycleProbe = readFileSync(
  new URL('../preview-lifecycle-probe.mjs', import.meta.url),
  'utf8'
)
const realSourceBaseline = readFileSync(
  new URL('../real-source-baseline-app.mjs', import.meta.url),
  'utf8'
)
const hostedContractJob = workflow.slice(
  workflow.indexOf('  performance-contract:'),
  workflow.indexOf('  runner-availability:')
)
const authorizedEnduranceJob = workflow.slice(workflow.indexOf('  endurance:'))
const lifecycleChurnStep = workflow.slice(
  workflow.indexOf('      - name: Explicit lifecycle churn endurance'),
  workflow.indexOf('      - name: Periodic or failure-triggered allocator attribution')
)

describe('macOS performance workflow', () => {
  it('fails on a hosted watchdog before queueing an unavailable self-hosted runner', () => {
    assert.match(workflow, /runner-availability:/)
    assert.match(workflow, /runs-on: ubuntu-latest/)
    assert.match(workflow, /listSelfHostedRunnersForRepo/)
    assert.match(workflow, /secrets\.VIDEORC_RUNNER_MONITOR_TOKEN/)
    assert.match(workflow, /Administration \(read\) permission/)
    assert.match(workflow, /runner\.busy !== true/)
    assert.match(workflow, /Videorc performance runner is unavailable:/)
    assert.match(workflow, /endurance:[\s\S]*needs: runner-availability/)
  })

  it('runs every representative endurance workload with an explicit profile class', () => {
    for (const scenario of [
      'detached-native-preview',
      'record-1080p60',
      'record-vertical-4k30',
      'studio-live-mic-visuals',
      'lifecycle-churn',
      'record-4k',
      'record-4k-stream-1080p',
      'real-devices-1080p'
    ]) {
      assert.match(
        authorizedEnduranceJob,
        new RegExp(`--scenario ${scenario}[\\s\\S]{0,100}--profile-class endurance`),
        scenario
      )
    }
  })

  it('schedules allocator attribution weekly or after a workload failure', () => {
    assert.match(workflow, /Periodic or failure-triggered allocator attribution/)
    assert.match(workflow, /github\.event_name == 'schedule'/)
    assert.match(workflow, /steps\.native_preview\.outcome == 'failure'/)
    assert.match(workflow, /scripts\/perf-memory-probe\.mjs --report-only/)
  })

  it('requires reviewed lifecycle budgets outside the explicit calibration path', () => {
    assert.match(lifecycleProbe, /activePerformanceBudgetRequest\(\)/)
    assert.match(lifecycleProbe, /!calibrationMode && !budgetRequest/)
    assert.match(
      lifecycleProbe,
      /Object\.assign\(memoryThresholds, activeBudget\.probeConfig\.memory\)/
    )
    assert.match(lifecycleProbe, /requiredProcessMemoryTrendThresholdFailures\(memoryThresholds\)/)
    assert.match(lifecycleProbe, /metricContract: 'lifecycle'/)
    assert.match(hostedContractJob, /scripts\/lib\/process-memory-gate\.test\.mjs/)
  })

  it('primes and aggregates exactly three full lifecycle-churn calibration runs', () => {
    assert.match(authorizedEnduranceJob, /Prime lifecycle-churn workload/)
    assert.match(lifecycleChurnStep, /for calibration_run in 1 2 3/)
    assert.match(lifecycleChurnStep, /VIDEORC_PERF_GATE_REQUIRE_ACTIVE_BUDGET/)
    assert.match(authorizedEnduranceJob, /Aggregate packaged lifecycle-churn calibration/)
    for (const run of [1, 2, 3]) {
      assert.match(authorizedEnduranceJob, new RegExp(`lifecycle-churn-run-${run}\\.child\\.json`))
    }
  })

  it('primes every three-run workload outside its calibration set', () => {
    for (const scenario of [
      'detached-native-preview',
      'record-4k',
      'record-4k-stream-1080p',
      'real-devices-1080p',
      'record-1080p60',
      'record-vertical-4k30',
      'studio-live-mic-visuals',
      'lifecycle-churn'
    ]) {
      assert.match(
        authorizedEnduranceJob,
        new RegExp(`Prime [^\\n]*${scenario}[\\s\\S]{0,500}--scenario ${scenario}`),
        scenario
      )
    }
  })

  it('enforces reviewed memory, CPU, resource, cadence, and teardown budgets in recording gates', () => {
    assert.match(realSourceBaseline, /activePerformanceBudgetRequest\(\)/)
    assert.match(realSourceBaseline, /selectActivePerformanceBudget/)
    assert.match(realSourceBaseline, /evaluateActivePerformanceBudget/)
    assert.match(realSourceBaseline, /metricContract: 'recording'/)
  })

  it('requires reviewed profiles in scheduled gates and bypasses them only for explicit calibration', () => {
    assert.match(workflow, /calibration_mode:[\s\S]{0,160}type: boolean[\s\S]{0,160}default: false/)
    assert.match(workflow, /active_budget_path:/)
    assert.match(workflow, /VIDEORC_PERF_SCHEDULED_ACTIVE_BUDGET_PATH/)
    assert.match(
      authorizedEnduranceJob,
      /VIDEORC_PERF_CALIBRATION: \$\{\{ github\.event_name == 'workflow_dispatch'[\s\S]{0,160}'1' \|\| '0' \}\}/
    )
    assert.match(
      authorizedEnduranceJob,
      /Explicit calibration bypass selected; reviewed thresholds will not be enforced/
    )
    assert.match(
      authorizedEnduranceJob,
      /Scheduled and enforcement performance runs require a reviewed active budget set/
    )
    assert.match(authorizedEnduranceJob, /VIDEORC_PERF_GATE_REQUIRE_ACTIVE_BUDGET=1/)
    assert.match(authorizedEnduranceJob, /VIDEORC_PERF_GATE_REQUIRE_ACTIVE_BUDGET=0/)
    assert.doesNotMatch(lifecycleChurnStep, /VIDEORC_PERF_CALIBRATION: '1'/)

    for (const scenario of [
      'record-4k',
      'record-4k-stream-1080p',
      'real-devices-1080p',
      'record-1080p60',
      'record-vertical-4k30'
    ]) {
      assert.match(
        authorizedEnduranceJob,
        new RegExp(
          `VIDEORC_PERF_ACTIVE_BUDGET_PATH="\\$VIDEORC_PERF_GATE_ACTIVE_BUDGET_PATH"[\\s\\S]{0,220}VIDEORC_PERF_REQUIRE_ACTIVE_BUDGET="\\$VIDEORC_PERF_GATE_REQUIRE_ACTIVE_BUDGET"[\\s\\S]{0,220}pnpm perf:scenario --scenario ${scenario}[^\\n]*--gate`
        ),
        scenario
      )
    }
  })

  it('does not duplicate conditional keys in the packaged native-preview calibration step', () => {
    const calibrationStep = workflow.slice(
      workflow.indexOf('      - name: Aggregate packaged native-preview calibration'),
      workflow.indexOf('      - name: Preview lifecycle endurance')
    )
    assert.equal(calibrationStep.match(/^\s+if:/gm)?.length ?? 0, 1)
  })

  it('keeps all measurements on the authorized self-hosted runner', () => {
    assert.match(hostedContractJob, /runs-on: macos-15/)
    assert.match(hostedContractJob, /synthetic performance contract tests/)
    assert.doesNotMatch(hostedContractJob, /pnpm perf:scenario/)
    assert.doesNotMatch(hostedContractJob, /pnpm perf:calibrate/)
    assert.doesNotMatch(hostedContractJob, /package:desktop/)
    assert.match(authorizedEnduranceJob, /runs-on: \[self-hosted, macOS, videorc-performance\]/)
    assert.match(
      authorizedEnduranceJob,
      /logged-in macOS session with Screen Recording,[\s\S]*Camera, and Microphone permission/
    )
    assert.match(workflow, /packaged_app_executable:/)
    assert.match(workflow, /packaged_app_commit:/)
    assert.match(workflow, /VIDEORC_PERF_SCHEDULED_APP_EXECUTABLE/)
    assert.match(workflow, /VIDEORC_PERF_SCHEDULED_APP_COMMIT/)
    assert.doesNotMatch(authorizedEnduranceJob, /run: pnpm package:desktop/)
    assert.match(authorizedEnduranceJob, /No pre-staged signed performance app was configured/)
    assert.match(authorizedEnduranceJob, /does not match checked-out commit/)
    const signatureVerificationStep = authorizedEnduranceJob.slice(
      authorizedEnduranceJob.indexOf('      - name: Verify signed packaged app'),
      authorizedEnduranceJob.indexOf('      # Prime macOS capture')
    )
    assert.match(signatureVerificationStep, /Verify signed packaged app/)
    assert.doesNotMatch(signatureVerificationStep, /^\s+if:/m)
    assert.match(signatureVerificationStep, /codesign --verify --deep --strict/)
    assert.match(signatureVerificationStep, /Authority=Developer ID Application:/)
  })

  it('keeps the short sentinel separate and calibrates it only on authorized hardware', () => {
    const command = packageJson.scripts['smoke:packaged:native-preview:performance']
    assert.match(command, /--profile-class short-sentinel/)
    assert.match(command, /--measurement-seconds 120/)
    assert.doesNotMatch(command, /--profile-class endurance/)
    assert.match(authorizedEnduranceJob, /Authorized packaged native-preview short sentinel/)
    assert.match(authorizedEnduranceJob, /--profile-class short-sentinel/)
    assert.match(authorizedEnduranceJob, /--measurement-seconds 120/)
    assert.match(authorizedEnduranceJob, /for calibration_run in 1 2 3/)
    assert.match(authorizedEnduranceJob, /Aggregate authorized short-sentinel calibration/)
  })

  it('validates the signed payload without launching a device workload on hosted release CI', () => {
    const preflightIndex = releaseWorkflow.indexOf('pnpm perf:budget:preflight')
    const publishIndex = releaseWorkflow.indexOf(
      'Upload beta artifacts to private download storage'
    )
    assert.ok(preflightIndex > 0)
    assert.ok(publishIndex > preflightIndex)
    assert.match(releaseWorkflow, /--artifact-only/)
    assert.match(releaseWorkflow, /VIDEORC_PERF_RELEASE_BUDGET_PROFILE/)
    assert.match(releaseWorkflow, /--profile-class short-sentinel/)
    assert.match(releaseWorkflow, /--measurement-seconds 120/)
    assert.doesNotMatch(releaseWorkflow, /pnpm smoke:packaged:native-preview:performance/)
  })
})
