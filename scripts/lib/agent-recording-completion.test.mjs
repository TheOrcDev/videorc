import assert from 'node:assert/strict'
import test from 'node:test'

import { assessAgentRecordingCompletion } from './agent-recording-completion.mjs'

const completed = {
  id: 'owned-session',
  status: 'completed',
  finalizationState: 'finalized',
  mp4Path: '/private/take.mp4'
}

test('a normal published take passes, including legacy inline finalization', () => {
  assert.equal(assessAgentRecordingCompletion(completed, completed.id).pass, true)
  assert.equal(
    assessAgentRecordingCompletion({ ...completed, finalizationState: undefined }, completed.id)
      .pass,
    true
  )
})

test('a recovered fragment fails despite completed status and a finalized MP4', () => {
  // ogre: the local RTMP smoke accepted a 5.4s recovered fragment after both
  // raw FIFO writers failed, because its receiver still contained video.
  const verdict = assessAgentRecordingCompletion(
    { ...completed, interruptionRecovery: 'recovered' },
    completed.id
  )
  assert.equal(verdict.pass, false)
  assert.match(verdict.failures.join('; '), /interrupted/)
})

test('missing, foreign, active, failed and unpublished sessions cannot pass', () => {
  for (const session of [
    undefined,
    { ...completed, id: 'another-session' },
    { ...completed, status: 'running' },
    { ...completed, status: 'failed' },
    { ...completed, finalizationState: 'finalizing' },
    { ...completed, finalizationState: 'failed' },
    { ...completed, finalizationError: 'export failed' },
    { ...completed, interruptionRecovery: 'failed' },
    { ...completed, mp4Path: undefined },
    { ...completed, mp4Path: '' }
  ]) {
    assert.equal(assessAgentRecordingCompletion(session, completed.id).pass, false)
  }
  assert.equal(assessAgentRecordingCompletion(completed, undefined).pass, false)
})
