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
  assert.equal(workflow.jobs.promote.concurrency.group, 'release-publication')
  assert.equal(workflow.jobs.promote.concurrency['cancel-in-progress'], false)
  assert.equal(workflow.concurrency['cancel-in-progress'], true)
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
