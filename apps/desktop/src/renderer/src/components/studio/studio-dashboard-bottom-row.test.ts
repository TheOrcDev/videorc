// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { CloudStatus } from '@/lib/backend'
import { SCENES_OFF_WHILE_ROOM_OPEN } from '@/lib/guests-view'
import { StudioDashboardBottomRow } from './studio-dashboard-bottom-row'

// 0.28.1 (owner, 11-16): with the guest room open, the Studio's scenes stayed
// clickable and changed nothing on air. The stage's layouts are the show's
// picture there, so the Scenes section says so instead of offering scenes.
const studio = vi.hoisted(() => ({
  cloud: { cloudStatus: null as CloudStatus | null }
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCloud: () => studio.cloud
}))
vi.mock('@/components/studio/scenes-gallery', () => ({
  ScenesGallery: () => createElement('div', { 'data-testid': 'scenes-gallery' })
}))
vi.mock('@/components/studio/soundboard-section', () => ({
  SoundboardSection: () => null
}))
vi.mock('@/components/studio/vertical-leg-monitor', () => ({
  VerticalLegMonitor: () => null
}))

function withRoom(phase: 'open' | 'closing' | null): CloudStatus | null {
  if (!phase) return null
  return { room: { phase } } as unknown as CloudStatus
}

describe('StudioDashboardBottomRow', () => {
  it('offers the scenes when no room is open', () => {
    studio.cloud.cloudStatus = withRoom(null)
    const html = renderToStaticMarkup(createElement(StudioDashboardBottomRow))
    expect(html).toContain('data-testid="scenes-gallery"')
    expect(html).not.toContain(SCENES_OFF_WHILE_ROOM_OPEN)
  })

  it('points at the Show stage instead of the scenes while the room is open', () => {
    studio.cloud.cloudStatus = withRoom('open')
    const html = renderToStaticMarkup(createElement(StudioDashboardBottomRow))
    expect(html).not.toContain('data-testid="scenes-gallery"')
    expect(html).toContain('Scenes')
    expect(html).toContain(SCENES_OFF_WHILE_ROOM_OPEN)
  })
})
