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

  it('gives the Stream Manager the dashboard to read, never to push', () => {
    const comments = apiForRendererRole(fakeApi, 'comments')
    expect(comments).toHaveProperty('getDashboard')
    expect(comments).toHaveProperty('onDashboard')
    expect(comments).not.toHaveProperty('pushDashboard')
  })

  it('gives the Stream Manager the banner list to read and a show or hide to ask, never a push', () => {
    const comments = apiForRendererRole(fakeApi, 'comments')
    expect(comments).toHaveProperty('getCommentsBanners')
    expect(comments).toHaveProperty('onCommentsBanners')
    expect(comments).toHaveProperty('bannerFromCommentsWindow')
    expect(comments).not.toHaveProperty('pushCommentsBanners')
    expect(comments).not.toHaveProperty('onBannerRequest')
    expect(comments).not.toHaveProperty('pushBannerResult')
    for (const role of ['notes', 'captions'] as const) {
      expect(apiForRendererRole(fakeApi, role)).not.toHaveProperty('bannerFromCommentsWindow')
    }
  })

  it('fails closed when the preload has no main-owned role argument', () => {
    expect(apiForRendererRole(fakeApi, null)).toEqual({})
    expect(Object.isFrozen(apiForRendererRole(fakeApi, null))).toBe(true)
  })
})
