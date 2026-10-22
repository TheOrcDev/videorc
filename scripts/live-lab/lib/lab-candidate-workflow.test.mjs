import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import yaml from 'js-yaml'

import { RELEASE_BUNDLED_OAUTH_ENV } from '../../lib/release-bundled-oauth.mjs'
import {
  CANDIDATE_WORKFLOW_FILE,
  CANDIDATE_WORKFLOW_NAME,
  SIDECAR_FILE
} from './install-sources.mjs'
import { LAB_TEAM_ID } from './install-verify.mjs'

// Plan 178 U5: the lab candidate workflow signs builds of arbitrary refs, so
// its shape is pinned here: dispatch only, read-only token, its own
// concurrency group, no notarization or publication, and a 7-day artifact.

const source = readFileSync(
  new URL(`../../../.github/workflows/${CANDIDATE_WORKFLOW_FILE}`, import.meta.url),
  'utf8'
)
const workflow = yaml.load(source)
const steps = workflow.jobs.candidate.steps
const stepNamed = (name) => {
  const step = steps.find((candidate) => candidate.name === name)
  assert.ok(step, `step "${name}" exists`)
  return step
}

test('lab candidate workflow is dispatch-only with a required ref input', () => {
  assert.equal(workflow.name, CANDIDATE_WORKFLOW_NAME)
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.equal(workflow.on.workflow_dispatch.inputs.ref.required, true)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.concurrency.group, 'lab-candidate')
  assert.equal(workflow.jobs.candidate.permissions, undefined)
})

test('lab candidate workflow never notarizes, publishes or runs the release soak', () => {
  assert.doesNotMatch(source, /release-publication/)
  assert.doesNotMatch(source, /smoke:local-gates/)
  assert.doesNotMatch(source, /release:upload|release:manifest|dist:desktop:release|dist:release/)
  assert.doesNotMatch(source, /S3_|R2|HETZNER|NEON/)
  assert.doesNotMatch(source, /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|notarytool|stapler/)
  assert.doesNotMatch(source, /latest-mac\.yml|release\.json|changelog/i)
  assert.match(
    stepNamed('Build Developer-ID-signed app (not notarized)').run,
    /--config\.mac\.notarize=false/
  )
})

test('signing secrets reach only the signing check and the build step', () => {
  const withSigning = steps
    .filter((step) => step.env && 'CSC_LINK' in step.env)
    .map((step) => step.name)
  assert.deepEqual(withSigning, [
    'Check the signing certificate is configured',
    'Build Developer-ID-signed app (not notarized)'
  ])
  // Fork PR heads are refused before any secret is used.
  const refuseIndex = steps.findIndex((step) => step.id === 'source')
  const firstSecret = steps.findIndex((step) => JSON.stringify(step).includes('secrets.'))
  assert.ok(refuseIndex >= 0 && refuseIndex < firstSecret)
  assert.match(steps[refuseIndex].run, /git branch -r --contains/)
})

test('the backend build maps every bundled OAuth credential once', () => {
  const backend = stepNamed('Build backend, native preview and FFmpeg')
  for (const name of RELEASE_BUNDLED_OAUTH_ENV) {
    assert.equal(backend.env[name], `\${{ secrets.${name} }}`, name)
    assert.equal(source.split(`${name}: \${{ secrets.${name} }}`).length - 1, 1, name)
  }
})

test('version suffix, Team ID check, sidecar and 7-day artifact', () => {
  const sourceStep = steps.find((step) => step.id === 'source')
  assert.match(sourceStep.run, /-lab\.\$\{suffix\}/)
  const verify = stepNamed('Verify signature and write the sidecar')
  assert.equal(verify.env.LAB_TEAM_ID, LAB_TEAM_ID)
  assert.match(verify.run, /Signature=adhoc/)
  assert.match(verify.run, /TeamIdentifier=\$LAB_TEAM_ID/)
  assert.match(verify.run, new RegExp(SIDECAR_FILE.replace('.', '\\.')))
  for (const field of ['sha', 'ref', 'version', 'builtAt', 'teamId', 'runId', 'zip']) {
    assert.match(verify.run, new RegExp(`\\b${field}:`), `sidecar has ${field}`)
  }
  const upload = stepNamed('Upload lab candidate')
  assert.equal(upload.with['retention-days'], 7)
  assert.equal(upload.with.name, '${{ env.artifact }}')
  assert.match(verify.run, /artifact=lab-candidate-\$LAB_SHORT/)
})

test('every action is pinned to a commit', () => {
  const uses = steps.filter((step) => step.uses).map((step) => step.uses)
  assert.ok(uses.length >= 5)
  for (const reference of uses) {
    assert.match(reference, /@[0-9a-f]{40}$/)
  }
})
