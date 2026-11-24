import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { XCategoryField } from '@/components/streaming/x-category-field'

import {
  X_CATEGORIES_FAILED,
  X_CATEGORY_NEEDS_X_LIVE,
  X_NO_CATEGORY,
  xCategoryGone,
  xCategoryPatch,
  xCategoryPick
} from './x-live-categories'

const LIST = [
  { id: 'gaming', name: 'Gaming' },
  { id: 'music', name: 'Music' },
  { id: 'sports', name: 'Sports' }
]

describe('the X category picker', () => {
  it("keeps X's order after No category and shows the saved pick", () => {
    const pick = xCategoryPick(LIST, 'ready', { xCategoryId: 'music', xCategoryName: 'Music' })
    expect(pick.items.map((item) => item.label)).toEqual([
      'No category',
      'Gaming',
      'Music',
      'Sports'
    ])
    expect(pick.value).toBe('music')
    expect(pick.note).toBeNull()
    expect(pick.unavailable).toBe(false)
  })

  it('is No category with nothing saved', () => {
    const pick = xCategoryPick(LIST, 'ready', {})
    expect(pick.value).toBe(X_NO_CATEGORY)
    expect(pick.note).toBeNull()
  })

  it('drops a category X no longer lists, and says so quietly', () => {
    const pick = xCategoryPick(LIST, 'ready', { xCategoryId: 'retro', xCategoryName: 'Retro' })
    expect(pick.value).toBe(X_NO_CATEGORY)
    expect(pick.items.some((item) => item.value === 'retro')).toBe(false)
    expect(pick.note).toBe(xCategoryGone('Retro'))
  })

  it('keeps the saved pick on show until the list has loaded', () => {
    const loading = xCategoryPick([], 'loading', { xCategoryId: 'retro', xCategoryName: 'Retro' })
    expect(loading.value).toBe('retro')
    expect(loading.items.at(-1)).toEqual({ value: 'retro', label: 'Retro' })
    expect(loading.unavailable).toBe(true)
    const failed = xCategoryPick([], 'failed', { xCategoryId: 'retro', xCategoryName: 'Retro' })
    expect(failed.value).toBe('retro')
    expect(failed.note).toBe(X_CATEGORIES_FAILED)
    expect(failed.unavailable).toBe(false)
  })

  it('waits for X Live before anything can be picked', () => {
    const pick = xCategoryPick([], 'idle', {})
    expect(pick.unavailable).toBe(true)
    expect(pick.note).toBe(X_CATEGORY_NEEDS_X_LIVE)
  })

  it('patches the id to send and the name to show, or clears both', () => {
    const { items } = xCategoryPick(LIST, 'ready', {})
    expect(xCategoryPatch('sports', items)).toEqual({
      xCategoryId: 'sports',
      xCategoryName: 'Sports'
    })
    expect(xCategoryPatch(X_NO_CATEGORY, items)).toEqual({
      xCategoryId: undefined,
      xCategoryName: undefined
    })
    expect(xCategoryPatch('unknown', items)).toEqual({
      xCategoryId: undefined,
      xCategoryName: undefined
    })
  })

  it('draws a labelled Select with the saved category and a retry when the list failed', () => {
    const ready = renderToStaticMarkup(
      createElement(XCategoryField, {
        override: { xCategoryId: 'gaming', xCategoryName: 'Gaming' },
        categories: LIST,
        status: 'ready',
        disabled: false,
        onPatch: () => {}
      })
    )
    expect(ready).toContain('for="x-category"')
    expect(ready).toContain('aria-label="X category"')
    expect(ready).toContain('Gaming')
    const failed = renderToStaticMarkup(
      createElement(XCategoryField, {
        override: {},
        categories: [],
        status: 'failed',
        disabled: false,
        onPatch: () => {},
        onRetry: () => {}
      })
    )
    expect(failed).toContain(X_CATEGORIES_FAILED.replaceAll("'", '&#x27;'))
    expect(failed).toContain('Try again')
  })
})
