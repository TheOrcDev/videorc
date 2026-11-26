import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
test('D3 real Actions upload exports controller flag, quiescence and read-only state identity', async () => {
  const workflow = load(
    await readFile(
      new URL('../../.github/workflows/promote-macos-capture-decay-d3.yml', import.meta.url),
      'utf8'
    )
  )
  const upload = workflow.jobs.promote.steps.find(
    (step) => step.run === 'pnpm release:upload:macos'
  )
  assert.equal(workflow.concurrency.group, 'release-publication')
  assert.equal(
    upload.env.VIDEORC_RELEASE_CONTROLLER_ENABLED,
    '${{ vars.VIDEORC_RELEASE_CONTROLLER_ENABLED }}'
  )
  assert.equal(
    upload.env.VIDEORC_D3_CONTROLLER_QUIESCED,
    '${{ vars.VIDEORC_D3_CONTROLLER_QUIESCED }}'
  )
  assert.equal(
    upload.env.VIDEORC_RELEASE_CONTROL_S3_ACCESS_KEY_ID,
    '${{ secrets.VIDEORC_RELEASE_CONTROL_READ_S3_ACCESS_KEY_ID }}'
  )
  assert.equal(upload.env.VIDEORC_CAPTURE_DECAY_D3_EXACT_PROMOTION, '1')
})

test('Windows releases retain every JS gate when the optional CI input is omitted', async () => {
  const readWorkflow = async (name) =>
    load(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  const gates = await readWorkflow('release-windows-gates')
  const release = await readWorkflow('release-windows-alpha')
  assert.equal(gates.concurrency, undefined)
  assert.equal(gates.on.workflow_call.inputs.js.default, true)
  assert.equal(release.jobs.gates.uses, './.github/workflows/release-windows-gates.yml')
  assert.equal(release.jobs.gates.with.js, undefined)
  assert.equal(gates.jobs.js.if, '${{ inputs.js }}')
  assert.equal(gates.jobs['js-vitest'].if, '${{ inputs.js }}')
})

test('Windows Plan 260 gates run in sentinel dispatches without billing each PR', async () => {
  const [gpui, gates] = await Promise.all(
    ['gpui-compile', 'release-windows-gates'].map(async (name) =>
      load(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
    )
  )
  const windows = gpui.jobs['compile-windows']
  assert.ok(Object.hasOwn(gpui.on, 'workflow_dispatch'))
  assert.equal(windows.if, "github.event_name == 'workflow_dispatch'")
  assert.equal(windows['runs-on'], 'windows-latest')
  assert.equal(windows['timeout-minutes'], 120)
  assert.ok(windows.steps.some((step) => step.with?.components === 'clippy'))

  const stepName = 'Plan 260 crates (clippy + test)'
  const planSteps = windows.steps.filter((step) => step.name === stepName)
  assert.equal(planSteps.length, 1)
  assert.equal(planSteps[0].shell, 'pwsh')
  // Preserve the workspace targets, warnings-as-errors and both failure exits.
  const targets =
    '--workspace --exclude videorc-backend --exclude videorc-native-preview-addon --exclude videorc-wer-helper'
  assert.deepEqual(planSteps[0].run.trim().split('\n'), [
    `cargo clippy ${targets} --all-targets -- -D warnings`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    `cargo test ${targets}`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
  ])
  assert.ok(!gates.jobs.rust.steps.some((step) => step.name === stepName))
  assert.equal(gates.jobs.rust['timeout-minutes'], 80)
})
