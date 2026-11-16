import assert from 'node:assert/strict'
export function assertFrostPixels(data, label) {
  assert.ok(data?.length >= 16 * 16 * 4, `${label}: no decoded pixels`)
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(
      [0, 1, 2].every((offset) => Math.abs(data[i + offset] - 128) <= 5) && data[i + 3] === 255,
      `${label}: a raw/secret pixel survived frost at pixel ${i / 4}`
    )
  }
}
export function assertPrivacyDrain({ blockedAt, appliedAt, lastRawAt }) {
  assert.ok(Number.isFinite(blockedAt) && Number.isFinite(appliedAt))
  assert.ok(
    lastRawAt === null || lastRawAt - blockedAt <= 500,
    'Old-frame drain exceeded the local 500 ms budget'
  )
  assert.ok(
    lastRawAt === null || lastRawAt < appliedAt,
    'Secret marker remained after applied-frost observation'
  )
}

/** Full composed page/artifact frames: reject the fixture's magenta secret field. */
export function assertNoSecretPixels(data, label) {
  assert.ok(data?.length >= 4096 && data.length % 4 === 0, `${label}: missing composed pixels`)
  for (let i = 0; i < data.length; i += 4)
    assert.ok(
      !(data[i] > 225 && data[i + 1] < 35 && data[i + 2] > 225),
      `${label}: secret marker remains`
    )
}
