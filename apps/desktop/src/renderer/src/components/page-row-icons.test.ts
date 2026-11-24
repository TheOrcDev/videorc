// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import {
  AssetsIcon,
  AssetsRowIcon,
  BuddyPageIcon,
  BuddyPageRowIcon,
  CaptionsIcon,
  CaptionsRowIcon,
  HealthIcon,
  HealthRowIcon,
  LibraryIcon,
  LibraryRowIcon,
  LivestreamIcon,
  LivestreamRowIcon,
  SceneIcon,
  SceneRowIcon,
  StudioIcon,
  StudioRowIcon,
  type AppIcon
} from './icons'

function markup(icon: AppIcon, weight: 'regular' | 'fill' | 'duotone'): string {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(createElement(icon, { className: 'size-5', weight })))
  const html = container.innerHTML
  act(() => root.unmount())
  return html
}

const PAIRS: Array<[string, AppIcon, AppIcon]> = [
  ['Studio', StudioRowIcon, StudioIcon],
  ['Scene', SceneRowIcon, SceneIcon],
  ['Images', AssetsRowIcon, AssetsIcon],
  ['Destinations', LivestreamRowIcon, LivestreamIcon],
  ['Sidekick', BuddyPageRowIcon, BuddyPageIcon],
  ['Captions', CaptionsRowIcon, CaptionsIcon],
  ['Library', LibraryRowIcon, LibraryIcon],
  ['Health', HealthRowIcon, HealthIcon]
]

// The sidebar and ⌘K draw page rows in regular and fill only, so the eager
// bundle carries those two weights, not all six (renderer budget, plan 113).
describe('page row icons', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  it.each(PAIRS)('%s draws the full glyph in regular and fill', (_page, row, full) => {
    for (const weight of ['regular', 'fill'] as const) {
      expect(markup(row, weight)).toBe(markup(full, weight))
    }
  })

  it('draws any other weight as regular', () => {
    expect(markup(StudioRowIcon, 'duotone')).toBe(markup(StudioIcon, 'regular'))
  })
})
