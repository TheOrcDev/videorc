import { beforeEach, describe, expect, it } from 'vitest'

import {
  USER_ERROR_LOG_LIMIT,
  recentUserErrors,
  recordUserError,
  resetUserErrorLogForTests
} from './user-error-log'

// Plan 216 A5: the support bundle explains the last toast.

const COPY = {
  kind: 'known' as const,
  title: "Couldn't switch the scene",
  raw: 'camera never sent'
}

describe('the user-error ring', () => {
  beforeEach(() => resetUserErrorLogForTests())

  it('keeps time, action, object, code and the raw text of a shown error', () => {
    const error = Object.assign(new Error('raw'), { code: 'layout-camera-not-ready' })
    const record = recordUserError(
      COPY,
      error,
      { action: 'switch', object: 'the scene' },
      new Date('2026-11-03T14:51:46Z')
    )
    expect(record).toEqual({
      at: '2026-11-03T14:51:46.000Z',
      action: 'switch',
      object: 'the scene',
      code: 'layout-camera-not-ready',
      kind: 'known',
      title: "Couldn't switch the scene",
      raw: 'camera never sent'
    })
    expect(recentUserErrors()).toEqual([record])
  })

  it('leaves out what the error did not carry', () => {
    const record = recordUserError({ ...COPY, kind: 'unknown' }, new Error('raw'))
    expect(Object.keys(record)).toEqual(['at', 'kind', 'title', 'raw'])
  })

  it('is bounded: the oldest record goes when the ring is full', () => {
    for (let index = 0; index < USER_ERROR_LOG_LIMIT + 5; index += 1) {
      recordUserError({ ...COPY, raw: `error ${index}` }, new Error(`error ${index}`))
    }
    const ring = recentUserErrors()
    expect(ring).toHaveLength(USER_ERROR_LOG_LIMIT)
    expect(ring[0]?.raw).toBe('error 5')
    expect(ring.at(-1)?.raw).toBe(`error ${USER_ERROR_LOG_LIMIT + 4}`)
  })

  it('hands out a copy, never the ring itself', () => {
    recordUserError(COPY, new Error('raw'))
    const ring = recentUserErrors()
    ring.pop()
    expect(recentUserErrors()).toHaveLength(1)
  })
})
