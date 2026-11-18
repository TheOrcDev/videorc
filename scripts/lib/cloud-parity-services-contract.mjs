import assert from 'node:assert/strict'

/** The fixture command's reply and the fake YouTube destination id. */
export const SERVICES_REPLY = 'Plan 249 services reply'
export const SERVICES_YOUTUBE_TARGET = 'youtube-managed'

/** Pure: which viewer a reply answers (`@name reply`). */
export function replyAuthor(text) {
  const match = /^@(\S+)\s/.exec(text ?? '')
  return match ? match[1] : null
}

/** Pure: the posts the provider received, attributed to the command that asked. */
export function attributeReplies(sent, triggers, owner) {
  return sent
    .filter((message) => message.snippet?.textMessageDetails?.messageText?.includes(SERVICES_REPLY))
    .map((message) => {
      const author = replyAuthor(message.snippet.textMessageDetails.messageText)
      const trigger = triggers.find((t) => t.author === author)
      return {
        triggerId: trigger?.id ?? `unattributed:${author}`,
        destinationId: SERVICES_YOUTUBE_TARGET,
        owner
      }
    })
}

/** Plan 249 S18 `services` acceptance evidence, recorded by the local fake
 * providers (no real credentials, provider messages or broadcasts) across a
 * room Go Live, a host kill/relaunch/Resume and a remote End. The runner is
 * `cloud-parity-services.mjs`; this gate judges what it recorded.
 *
 * evidence = {
 *   providerMessages: [{ id }],                 // every viewer row the fake provider served, redeliveries included
 *   transcript: [{ id }],                       // the app's transcript for the show after Resume (provider ids)
 *   commandReplies: [{ triggerId, destinationId, owner }], // posts the provider received
 *   expectedReplies: [{ triggerId, destinationId }],
 *   automaticSends: [{ triggerId, destinationId, owner }], // Sidekick's own sends
 *   failedDestinations: [destinationId],
 *   readers: [{ owner, destinationId, active }],          // after the remote End
 *   currentOwner,
 *   afterEndReplies: number,                    // replies to a command posted after the remote End
 *   sidekickActivity?: { beforeResume, afterResume }
 * }
 */
export function assertServicesContinuity(evidence, { label = 'services' } = {}) {
  const {
    providerMessages,
    transcript,
    commandReplies,
    expectedReplies,
    automaticSends,
    failedDestinations,
    readers,
    currentOwner,
    afterEndReplies,
    sidekickActivity
  } = evidence
  assert.ok(providerMessages.length > 0, `${label}: fake providers emitted nothing`)
  const delivered = new Map()
  for (const row of transcript) delivered.set(row.id, (delivered.get(row.id) ?? 0) + 1)
  for (const id of new Set(providerMessages.map((m) => m.id))) {
    const count = delivered.get(id) ?? 0
    assert.ok(count > 0, `${label}: provider message ${id} was lost across resume`)
    assert.equal(count, 1, `${label}: provider message ${id} delivered ${count} times`)
  }
  const once = (sends, kind) => {
    const counts = new Map()
    for (const send of sends) {
      assert.equal(
        send.owner,
        currentOwner,
        `${label}: stale owner ${send.owner} sent a ${kind} after replacement`
      )
      const key = `${send.triggerId}|${send.destinationId}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const [key, count] of counts) assert.equal(count, 1, `${label}: duplicate ${kind} ${key}`)
    return counts
  }
  const replies = once(commandReplies, 'command reply')
  for (const { triggerId, destinationId } of expectedReplies)
    assert.ok(
      replies.has(`${triggerId}|${destinationId}`),
      `${label}: reply to ${triggerId} on ${destinationId} missing after resume`
    )
  once(automaticSends, 'automatic send')
  for (const send of automaticSends)
    assert.ok(
      !failedDestinations.includes(send.destinationId),
      `${label}: automatic send to failed destination ${send.destinationId}`
    )
  const active = readers.filter((reader) => reader.active)
  assert.ok(
    active.every((reader) => reader.owner === currentOwner),
    `${label}: an old owner's reader survived replacement`
  )
  const perDestination = new Map()
  for (const reader of active)
    perDestination.set(reader.destinationId, (perDestination.get(reader.destinationId) ?? 0) + 1)
  for (const [destinationId, count] of perDestination)
    assert.equal(count, 1, `${label}: ${count} readers on ${destinationId}; exactly one expected`)
  assert.equal(afterEndReplies, 0, `${label}: a reader kept answering after the remote End`)
  if (sidekickActivity) {
    assert.equal(sidekickActivity.beforeResume, 'live', `${label}: Sidekick read the room as idle`)
    assert.equal(sidekickActivity.afterResume, 'live', `${label}: Sidekick lost the live lock`)
  }
}
