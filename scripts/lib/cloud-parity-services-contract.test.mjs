import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertServicesContinuity,
  attributeReplies,
  replyAuthor,
  SERVICES_REPLY
} from './cloud-parity-services-contract.mjs'

const passing = () => ({
  providerMessages: [
    { id: 'm1' },
    { id: 'm2' },
    // Redelivered by the provider after the resume.
    { id: 'm2' },
    { id: 'm3' }
  ],
  transcript: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
  commandReplies: [
    { triggerId: 'm2', destinationId: 'yt', owner: 'b' },
    { triggerId: 'm3', destinationId: 'yt', owner: 'b' }
  ],
  expectedReplies: [
    { triggerId: 'm2', destinationId: 'yt' },
    { triggerId: 'm3', destinationId: 'yt' }
  ],
  automaticSends: [],
  failedDestinations: ['tw'],
  readers: [
    { owner: 'a', destinationId: 'yt', active: false },
    { owner: 'b', destinationId: 'yt', active: true }
  ],
  currentOwner: 'b',
  afterEndReplies: 0
})

test('services gate passes one delivery, one reply and one reader per destination', () => {
  assert.doesNotThrow(() => assertServicesContinuity(passing()))
  const withSidekick = {
    ...passing(),
    sidekickActivity: { beforeResume: 'live', afterResume: 'live' }
  }
  assert.doesNotThrow(() => assertServicesContinuity(withSidekick))
})

test('services gate rejects loss, duplicates, stale owners and failed-destination sends', () => {
  const cases = {
    lost: (e) => e.transcript.splice(0, 1),
    duplicateDelivery: (e) => e.transcript.push({ id: 'm2' }),
    duplicateReply: (e) =>
      e.commandReplies.push({ triggerId: 'm2', destinationId: 'yt', owner: 'b' }),
    staleOwnerReply: (e) =>
      e.commandReplies.push({ triggerId: 'm1', destinationId: 'yt', owner: 'a' }),
    missingReply: (e) => e.commandReplies.pop(),
    failedDestinationSend: (e) =>
      e.automaticSends.push({ triggerId: 'm3', destinationId: 'tw', owner: 'b' }),
    duplicateAutomaticSend: (e) =>
      e.automaticSends.push(
        { triggerId: 'm1', destinationId: 'yt', owner: 'b' },
        { triggerId: 'm1', destinationId: 'yt', owner: 'b' }
      ),
    oldReaderSurvives: (e) => (e.readers[0].active = true),
    twoReaders: (e) => e.readers.push({ owner: 'b', destinationId: 'yt', active: true }),
    answeredAfterEnd: (e) => (e.afterEndReplies = 1),
    idleSidekick: (e) => (e.sidekickActivity = { beforeResume: 'idle', afterResume: 'live' }),
    nothingEmitted: (e) => (e.providerMessages = [])
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const evidence = passing()
    mutate(evidence)
    assert.throws(() => assertServicesContinuity(evidence, { label: name }), undefined, name)
  }
})

test('replies are attributed to the viewer whose command asked', () => {
  assert.equal(replyAuthor(`@viewer_b ${SERVICES_REPLY}`), 'viewer_b')
  assert.equal(replyAuthor(SERVICES_REPLY), null)
  const post = (text) => ({ snippet: { textMessageDetails: { messageText: text } } })
  const triggers = [
    { id: 't1', author: 'viewer_b' },
    { id: 't2', author: 'viewer_d' }
  ]
  assert.deepEqual(
    attributeReplies(
      [post(`@viewer_d ${SERVICES_REPLY}`), post('unrelated'), post(`@ghost ${SERVICES_REPLY}`)],
      triggers,
      'host'
    ),
    [
      { triggerId: 't2', destinationId: 'youtube-managed', owner: 'host' },
      { triggerId: 'unattributed:ghost', destinationId: 'youtube-managed', owner: 'host' }
    ]
  )
})
