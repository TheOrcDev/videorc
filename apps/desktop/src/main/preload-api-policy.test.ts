import { describe, expect, it } from 'vitest'

import type { VideorcApi } from '../shared/backend'
import { AUXILIARY_API_KEYS, apiForRendererRole } from '../preload/api-policy'

const fakeApi = Object.fromEntries(
  [...new Set(Object.values(AUXILIARY_API_KEYS).flat())].map((key) => [key, () => key])
) as unknown as VideorcApi

describe('preload API policy', () => {
  it('exposes only the methods required by each auxiliary renderer', () => {
    for (const role of ['notes', 'comments', 'captions'] as const) {
      expect(Object.keys(apiForRendererRole(fakeApi, role)).sort()).toEqual(
        [...AUXILIARY_API_KEYS[role]].sort()
      )
    }
  })

  it('fails closed when the preload has no main-owned role argument', () => {
    expect(apiForRendererRole(fakeApi, null)).toEqual({})
    expect(Object.isFrozen(apiForRendererRole(fakeApi, null))).toBe(true)
  })
})
