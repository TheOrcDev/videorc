import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { XLiveEditSection } from '@/components/streaming/x-live-edit-section'
import type { StreamMetadataDraft, StreamTargetSettings } from '@/lib/backend'

import { X_NO_CATEGORY } from './x-live-categories'
import {
  X_LIVE_EDIT_TITLE,
  liveXTarget,
  xGoLiveTitle,
  xLiveChanges,
  xLiveFromAnswer,
  xLiveShownLine,
  xLiveStart
} from './x-live-edit'

const LIST = [
  { id: 'gaming', name: 'Gaming' },
  { id: 'music', name: 'Music' }
]

function draft(
  x: Partial<StreamMetadataDraft['targetOverrides'][number]> = {}
): StreamMetadataDraft {
  return {
    title: 'Shared title',
    description: '',
    defaultPrivacy: 'public',
    targetOverrides: [
      {
        platform: 'x',
        customize: false,
        title: '',
        description: '',
        privacy: 'public',
        updatedAt: 't',
        ...x
      }
    ],
    updatedAt: 't'
  }
}

describe('Live on X', () => {
  it('starts from the title and category Go Live sent', () => {
    expect(xGoLiveTitle(draft())).toBe('Shared title')
    expect(xGoLiveTitle(draft({ customize: true, title: ' Own ' }))).toBe('Own')
    expect(xGoLiveTitle(null)).toBe('Live from Videorc')
    expect(xLiveStart(draft({ xCategoryId: 'gaming' }), LIST)).toEqual({
      title: 'Shared title',
      categoryId: 'gaming'
    })
    // A category X no longer lists was left out of Go Live.
    expect(xLiveStart(draft({ xCategoryId: 'retro' }), LIST).categoryId).toBeNull()
  })

  it('sends only what changed, and an empty category id to clear it', () => {
    const shown = { title: 'Shared title', categoryId: 'gaming' }
    expect(xLiveChanges(shown, { title: 'Shared title', categoryValue: 'gaming' })).toBeNull()
    expect(xLiveChanges(shown, { title: ' Semifinal ', categoryValue: 'gaming' })).toEqual({
      title: 'Semifinal'
    })
    expect(xLiveChanges(shown, { title: 'Shared title', categoryValue: 'music' })).toEqual({
      liveCategoryId: 'music'
    })
    expect(xLiveChanges(shown, { title: 'Shared title', categoryValue: X_NO_CATEGORY })).toEqual({
      liveCategoryId: ''
    })
    // X refuses an empty title, so nothing is sent.
    expect(xLiveChanges(shown, { title: '   ', categoryValue: 'music' })).toBeNull()
  })

  it("shows X's answer, never the values asked for", () => {
    const before = { title: 'Shared title', categoryId: 'gaming' }
    const after = xLiveFromAnswer(
      { broadcastId: 'b', state: 'RUNNING', shareUrl: 'u', title: 'Semifinal' },
      before
    )
    expect(after).toEqual({ title: 'Semifinal', categoryId: null })
    expect(xLiveShownLine(after, LIST)).toBe('X shows “Semifinal” · No category')
    expect(xLiveShownLine({ title: 'Semifinal', categoryId: 'music' }, LIST)).toBe(
      'X shows “Semifinal” · Music'
    )
    expect(xLiveShownLine({ title: 'T', categoryId: 'talk' }, [], 'Talk')).toBe(
      'X shows “T” · Talk'
    )
  })

  it('finds the X destination on air with its broadcast', () => {
    const base = { id: 'x-1', platform: 'x', label: 'X', enabled: true } as StreamTargetSettings
    expect(liveXTarget([base])).toBeNull()
    expect(liveXTarget([{ ...base, status: { state: 'live' } } as StreamTargetSettings])).toBeNull()
    const live = {
      ...base,
      platformBroadcastId: '1AbC',
      status: { state: 'live' }
    } as StreamTargetSettings
    expect(liveXTarget([live])?.platformBroadcastId).toBe('1AbC')
  })

  it('draws the title, the category and what X shows', () => {
    const markup = renderToStaticMarkup(
      createElement(XLiveEditSection, {
        broadcastId: '1AbC',
        draft: draft({ xCategoryId: 'gaming', xCategoryName: 'Gaming' }),
        categories: LIST,
        categoriesStatus: 'ready',
        onUpdate: async () => ({ broadcastId: '1AbC', state: 'RUNNING', shareUrl: 'u' })
      })
    )
    expect(markup).toContain(X_LIVE_EDIT_TITLE)
    expect(markup).toContain('id="x-live-title"')
    expect(markup).toContain('value="Shared title"')
    expect(markup).toContain('id="x-live-category"')
    expect(markup).toContain('X shows “Shared title” · Gaming')
    expect(markup).toContain('Update X')
  })
})
