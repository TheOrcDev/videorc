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
const d3PromotionWorkflow = readFileSync(
  new URL('../../.github/workflows/promote-macos-capture-decay-d3.yml', import.meta.url),
  'utf8'
)
const macosReleaseUpload = readFileSync(
  new URL('../upload-macos-beta-release.mjs', import.meta.url),
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

  it('builds and retains the complete macOS updater feed before private publication', () => {
    assert.match(releaseWorkflow, /run: pnpm dist:desktop:release/)
    assert.doesNotMatch(releaseWorkflow, /run: pnpm dist:desktop:signed\s*$/m)
    assert.match(releaseWorkflow, /apps\/desktop\/release\/\*\.zip/)
    assert.match(releaseWorkflow, /apps\/desktop\/release\/\*\.zip\.blockmap/)
    assert.match(releaseWorkflow, /apps\/desktop\/release\/latest-mac\.yml/)
  })

  it('refuses to rebuild an accepted D3 candidate in the regular release workflow', () => {
    const sourceGateIndex = releaseWorkflow.indexOf(
      '      - name: Verify capture-decay D3 publication state'
    )
    const buildIndex = releaseWorkflow.indexOf(
      '      - name: Build signed and notarized macOS release'
    )

    assert.match(releaseWorkflow, /fetch-depth: 0/)
    assert.ok(sourceGateIndex >= 0 && sourceGateIndex < buildIndex)
    assert.match(releaseWorkflow.slice(sourceGateIndex, buildIndex), /--regular-release/)
    assert.doesNotMatch(releaseWorkflow, /attest-d3-publication:/)
    assert.doesNotMatch(releaseWorkflow, /capture-decay-d3-publication-receipt\.json/)
  })

  it('rechecks event-sensitive protected authority immediately before regular publication', () => {
    const buildIndex = releaseWorkflow.indexOf(
      '      - name: Build signed and notarized macOS release'
    )
    const recheckIndex = releaseWorkflow.indexOf(
      '      - name: Recheck protected publication authority'
    )
    const uploadIndex = releaseWorkflow.indexOf(
      '      - name: Upload beta artifacts to private download storage'
    )

    assert.ok(buildIndex >= 0 && recheckIndex > buildIndex && uploadIndex > recheckIndex)
    const recheckStep = releaseWorkflow.slice(recheckIndex, uploadIndex)
    assert.match(recheckStep, /GITHUB_REF_PROTECTED/)
    assert.match(recheckStep, /VIDEORC_GITHUB_API_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(
      recheckStep,
      /https:\/\/api\.github\.com\/repos\/TheOrcDev\/videorc\/git\/ref\/heads\/main/
    )
    assert.match(recheckStep, /unset VIDEORC_GITHUB_API_TOKEN/)
    assert.match(recheckStep, /head_sha="\$\(\/usr\/bin\/git rev-parse 'HEAD\^\{commit\}'\)"/)
    assert.match(recheckStep, /test "\$head_sha" = "\$GITHUB_SHA"/)
    assert.match(recheckStep, /case "\$GITHUB_EVENT_NAME" in/)
    assert.match(
      recheckStep,
      /workflow_dispatch\)[\s\S]*test "\$GITHUB_REF" = 'refs\/heads\/main'[\s\S]*test "\$head_sha" = "\$canonical_main_sha"/
    )
    assert.match(
      recheckStep,
      /push\)[\s\S]*\[\[ "\$GITHUB_REF" =~ \^refs\/tags\/v[\s\S]*refs\/videorc\/verified-release-tag[\s\S]*verified_tag_sha="\$\(\/usr\/bin\/git rev-parse 'refs\/videorc\/verified-release-tag\^\{commit\}'\)"[\s\S]*test "\$verified_tag_sha" = "\$GITHUB_SHA"[\s\S]*\/usr\/bin\/git merge-base --is-ancestor "\$verified_tag_sha" 'refs\/remotes\/origin\/main'/
    )
    assert.match(
      recheckStep,
      /\/usr\/bin\/git fetch --no-tags --force[\s\S]*https:\/\/github\.com\/TheOrcDev\/videorc\.git[\s\S]*refs\/heads\/main:refs\/remotes\/origin\/main/
    )
    assert.equal(
      [...recheckStep.matchAll(/\/usr\/bin\/git diff --quiet --ignore-submodules=none HEAD --/g)]
        .length,
      2
    )
    assert.match(recheckStep, /--protected-publication-ref --regular-release/)
    assert.ok(
      recheckStep.indexOf('unset VIDEORC_GITHUB_API_TOKEN') <
        recheckStep.indexOf('pnpm release:verify:capture-decay-d3')
    )
    assert.doesNotMatch(recheckStep, /git fetch --no-tags origin main/)
    assert.doesNotMatch(recheckStep, /VIDEORC_DOWNLOAD_S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/)
    assert.doesNotMatch(recheckStep.trimEnd(), /\n\s+- name:/)
  })

  it('promotes only the reviewed exact candidate without build or signing authority', () => {
    const firstMainGate = d3PromotionWorkflow.indexOf(
      '      - name: Require protected main dispatch'
    )
    const sourceTests = d3PromotionWorkflow.indexOf(
      '      - name: Verify source and D3 acceptance contract'
    )
    const candidateAuthority = d3PromotionWorkflow.indexOf(
      '      - name: Recheck accepted protected source before candidate download'
    )
    const download = d3PromotionWorkflow.indexOf(
      '      - name: Download immutable sealed candidate'
    )
    const verify = d3PromotionWorkflow.indexOf(
      '      - name: Verify downloaded signatures, notarization, feeds, and exact bytes'
    )
    const secondMainGate = d3PromotionWorkflow.indexOf(
      '      - name: Recheck accepted protected source before publication'
    )
    const publish = d3PromotionWorkflow.indexOf(
      '      - name: Promote exact sealed bytes to release storage'
    )

    assert.match(d3PromotionWorkflow, /workflow_dispatch:/)
    assert.doesNotMatch(d3PromotionWorkflow, /^\s+push:/m)
    assert.match(d3PromotionWorkflow, /environment: macos-d3-release/)
    assert.ok(
      firstMainGate >= 0 &&
        sourceTests > firstMainGate &&
        candidateAuthority > sourceTests &&
        download > candidateAuthority &&
        verify > download &&
        secondMainGate > verify &&
        publish > secondMainGate
    )
    assert.match(d3PromotionWorkflow, /GITHUB_REF_PROTECTED/)
    assert.match(d3PromotionWorkflow, /--protected-publication-ref --exact-promotion/)
    assert.doesNotMatch(d3PromotionWorkflow, /git fetch --no-tags origin main/)
    assert.doesNotMatch(d3PromotionWorkflow, /dist:desktop/)
    assert.doesNotMatch(d3PromotionWorkflow, /release:preflight:macos/)
    assert.doesNotMatch(d3PromotionWorkflow, /CSC_|APPLE_|notary|notarize|staple/i)
    assert.match(d3PromotionWorkflow, /VIDEORC_CAPTURE_DECAY_D3_EXACT_PROMOTION: '1'/)

    const downloadStep = d3PromotionWorkflow.slice(download, verify)
    const verifyStep = d3PromotionWorkflow.slice(verify, secondMainGate)
    const publishStep = d3PromotionWorkflow.slice(publish)
    const candidateAuthorityStep = d3PromotionWorkflow.slice(candidateAuthority, download)
    const publicationAuthorityStep = d3PromotionWorkflow.slice(secondMainGate, publish)
    for (const authorityStep of [candidateAuthorityStep, publicationAuthorityStep]) {
      assert.match(authorityStep, /VIDEORC_GITHUB_API_TOKEN: \$\{\{ github\.token \}\}/)
      assert.match(
        authorityStep,
        /https:\/\/api\.github\.com\/repos\/TheOrcDev\/videorc\/git\/ref\/heads\/main/
      )
      assert.match(authorityStep, /\/usr\/bin\/git diff --quiet --ignore-submodules=none HEAD --/)
      assert.match(
        authorityStep,
        /plutil -extract status raw -o - docs\/acceptance\/macos-capture-decay-d3\.json/
      )
      assert.match(authorityStep, /--protected-publication-ref --exact-promotion/)
      assert.match(authorityStep, /unset VIDEORC_GITHUB_API_TOKEN/)
      assert.match(authorityStep, /head_sha="\$\(\/usr\/bin\/git rev-parse 'HEAD\^\{commit\}'\)"/)
      assert.match(authorityStep, /test "\$head_sha" = "\$GITHUB_SHA"/)
      assert.match(authorityStep, /test "\$head_sha" = "\$canonical_main_sha"/)
      assert.match(authorityStep, /test "\$GITHUB_REF" = 'refs\/heads\/main'/)
      assert.ok(
        authorityStep.indexOf('unset VIDEORC_GITHUB_API_TOKEN') <
          authorityStep.indexOf('pnpm release:verify:capture-decay-d3')
      )
      assert.doesNotMatch(
        authorityStep,
        /VIDEORC_(?:MACOS_D3_CANDIDATE|RELEASE_UPLOAD)_S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/
      )
      assert.doesNotMatch(authorityStep.trimEnd(), /\n\s+- name:/)
    }
    assert.match(downloadStep, /VIDEORC_MACOS_D3_CANDIDATE_S3_ACCESS_KEY_ID/)
    assert.doesNotMatch(downloadStep, /VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID/)
    assert.match(
      verifyStep,
      /--write-publication-descriptor[\s\S]*candidate-publication-verification\.json/
    )
    assert.doesNotMatch(verifyStep, /VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID/)
    assert.match(publishStep, /VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID/)
    assert.match(publishStep, /VIDEORC_GITHUB_API_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(
      publishStep,
      /VIDEORC_MACOS_D3_PUBLICATION_VERIFICATION_DESCRIPTOR:[\s\S]*candidate-publication-verification\.json/
    )
    assert.doesNotMatch(publishStep, /VIDEORC_MACOS_D3_CANDIDATE_S3_ACCESS_KEY_ID/)

    const liveMainCheck = macosReleaseUpload.indexOf(
      'await assertCaptureDecayCurrentProtectedMain({'
    )
    const firstPublicWrite = macosReleaseUpload.indexOf('await publishReleaseUploadPhases({')
    assert.ok(liveMainCheck >= 0 && firstPublicWrite > liveMainCheck)
    assert.match(
      macosReleaseUpload.slice(liveMainCheck, firstPublicWrite),
      /delete process\.env\.VIDEORC_GITHUB_API_TOKEN/
    )
  })

  it('wires the reverified publication set into the tested resumable receipt helper', () => {
    assert.match(macosReleaseUpload, /assembleCaptureDecayD3PublicationReceipt/)
    assert.match(macosReleaseUpload, /requireCaptureDecayD3PublishedReservation/)
    assert.match(
      macosReleaseUpload,
      /const publishedReservation = requireCaptureDecayD3PublishedReservation\([\s\S]*publicationResults,[\s\S]*publicationWorkflow/
    )
    assert.match(macosReleaseUpload, /reservationArtifact: publishedReservation\.artifact/)
    assert.match(
      macosReleaseUpload,
      /assembleCaptureDecayD3PublicationReceipt\(\{[\s\S]*publicationResults: finalPublicationResults,[\s\S]*publicationWorkflow,[\s\S]*sealedCandidateManifest: verifiedCandidate\.document/
    )
    assert.doesNotMatch(
      macosReleaseUpload,
      /reservationArtifact: firstD3Publication\.reservation\.artifact/
    )
  })

  it('attests the receipt, seal, manifest, DMG, and every updater artifact in isolation', () => {
    const attestationJob = d3PromotionWorkflow.slice(
      d3PromotionWorkflow.indexOf('  attest:'),
      d3PromotionWorkflow.length
    )

    assert.match(attestationJob, /timeout-minutes: 15/)
    assert.match(attestationJob, /id-token: write/)
    assert.match(attestationJob, /attestations: write/)
    assert.match(attestationJob, /artifact-metadata: write/)
    assert.match(attestationJob, /promotion\/candidate\.json/)
    assert.match(attestationJob, /promotion\/candidate-seal-receipt\.json/)
    assert.match(attestationJob, /promotion\/capture-decay-d3-publication-receipt\.json/)
    assert.match(attestationJob, /promotion\/\*\.dmg/)
    assert.match(attestationJob, /promotion\/\*\.sha256/)
    assert.match(attestationJob, /promotion\/release\.json/)
    assert.match(attestationJob, /promotion\/\*\.zip/)
    assert.match(attestationJob, /promotion\/\*\.zip\.blockmap/)
    assert.match(attestationJob, /promotion\/latest-mac\.yml/)
    assert.match(attestationJob, /name: videorc-macos-capture-decay-d3-publication-attestation/)
  })

  it('pins every macOS release action to an immutable reviewed commit', () => {
    const actionReferences = [...releaseWorkflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map(
      (match) => match[1]
    )

    assert.deepEqual(actionReferences, [
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c',
      'taiki-e/install-action@37f7c5781271959fb65b6b35224e28652ff2b63d',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
    ])
    for (const reference of actionReferences) {
      assert.match(reference, /@[0-9a-f]{40}$/)
    }

    const promotionReferences = [...d3PromotionWorkflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map(
      (match) => match[1]
    )
    assert.deepEqual(promotionReferences, [
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c',
      'taiki-e/install-action@37f7c5781271959fb65b6b35224e28652ff2b63d',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
    ])
    for (const reference of promotionReferences) {
      assert.match(reference, /@[0-9a-f]{40}$/)
    }
  })

  it('runs the fixed capture-decay release gates in order through local gates', () => {
    const localGateSteps = packageJson.scripts['smoke:local-gates'].split(/\s*&&\s*/)
    const idleGateIndex = localGateSteps.indexOf('pnpm smoke:capture-decay-soak:gate')
    const longRecordingGateIndex = localGateSteps.indexOf(
      'pnpm smoke:capture-decay-soak:long-recording'
    )

    assert.ok(idleGateIndex >= 0, 'local gates must include the fixed idle capture-decay gate')
    assert.equal(
      longRecordingGateIndex,
      idleGateIndex + 1,
      'the fixed long-recording gate must immediately follow the idle gate'
    )

    const verificationStep = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Verify\n'),
      releaseWorkflow.indexOf('      - name: Retain capture-decay release evidence')
    )
    assert.match(verificationStep, /pnpm smoke:local-gates/)
    assert.doesNotMatch(verificationStep, /pnpm smoke:capture-decay-soak:(?:gate|long-recording)/)
  })

  it('retains idle and long-recording decay evidence even when a release gate fails', () => {
    assert.match(releaseWorkflow, /VIDEORC_CAPTURE_DECAY_OUTPUT_DIR:/)
    assert.match(releaseWorkflow, /VIDEORC_CAPTURE_DECAY_LONG_RECORDING_OUTPUT_DIR:/)
    const evidenceUpload = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Retain capture-decay release evidence'),
      releaseWorkflow.indexOf('      - name: Build signed and notarized macOS release')
    )
    assert.match(evidenceUpload, /if: always\(\)/)
    assert.match(evidenceUpload, /path: capture-decay-evidence\/\*\*/)
    assert.match(evidenceUpload, /if-no-files-found: error/)
    assert.doesNotMatch(evidenceUpload, /if-no-files-found: warn/)
    assert.match(evidenceUpload, /retention-days: 30/)
  })
})
