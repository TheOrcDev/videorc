// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiscordSection } from '@/components/streaming/discord-section'
import { StreamingTab } from './streaming-tab'

// Plan 187: the Discord announcement has a tab of its own on Destinations.
// One home per control: Setup no longer carries it.

vi.mock('@/hooks/use-discord-announce', () => ({
  useDiscordAnnounce: () => ({
    snapshot: null,
    preview: null,
    error: null,
    update: vi.fn(),
    saveWebhook: vi.fn(),
    removeWebhook: vi.fn(),
    sendTest: vi.fn()
  })
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    captureConfig: { streaming: { targets: [] } },
    isSessionActive: false
  })
}))

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Destinations → Discord (plan 187)', () => {
  it('shows the Discord section on its own tab, after Setup and Upcoming', async () => {
    await act(async () => {
      root.render(createElement(StreamingTab, { view: 'discord', onViewChange: vi.fn() }))
    })
    // The lazy chunk resolves on the next turns.
    for (
      let turn = 0;
      turn < 5 && !container.querySelector('[data-testid=discord-section]');
      turn++
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const tabs = [...container.querySelectorAll('[role=tab]')].map((tab) => tab.textContent)
    expect(tabs).toEqual(['Setup', 'Upcoming', 'Discord'])
    expect(container.querySelector('[role=tab][data-active]')?.textContent).toBe('Discord')
    expect(container.querySelector('[data-testid=discord-section]')).not.toBeNull()
  })

  it('names itself in the page header, like Upcoming, with no second "Discord" heading', () => {
    act(() => root.render(createElement(DiscordSection, { targets: [], sessionActive: false })))
    const headings = [...container.querySelectorAll('h2, h3')]
    expect(headings.map((heading) => heading.textContent)).toEqual(['Discord announcements'])
    expect(headings[0]?.className).toContain('sr-only')
    expect(container.querySelector('[data-slot=page-header]')?.textContent).toContain(
      'Tell your server when you go live.'
    )
    expect(container.querySelector('[data-slot=panel-section-header]')).toBeNull()
  })

  it('leaves Setup without a Discord section (one home per control)', () => {
    const page = read('./streaming-tab.tsx')
    expect(page).not.toContain('DiscordSection')
    expect(page).toMatch(
      /<TabsContent value="discord">[\s\S]*<DiscordTab \/>[\s\S]*<\/TabsContent>/
    )
  })
})
