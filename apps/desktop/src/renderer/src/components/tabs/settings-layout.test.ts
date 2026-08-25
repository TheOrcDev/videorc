import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { REMOTE_CONTROL_OFF_HINT } from './settings-tab'

const settingsSource = readFileSync(new URL('./settings-tab.tsx', import.meta.url), 'utf8')
const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8')

/** The SettingsTab component body only — the helpers below it are not the layout. */
const settingsTabBody = settingsSource.slice(
  settingsSource.indexOf('export function SettingsTab'),
  settingsSource.indexOf('function AboutAndUpdates')
)

/** Section titles per column of the single ConfigGrid, in render order. */
function settingsColumns(): string[][] {
  const region = settingsTabBody.slice(
    settingsTabBody.indexOf('<ConfigGrid>'),
    settingsTabBody.indexOf('</ConfigGrid>')
  )
  const columns: string[][] = []
  for (const chunk of region.split('<div className="flex flex-col gap-5">').slice(1)) {
    const titles: string[] = []
    for (const match of chunk.matchAll(/title="([^"]+)"/g)) {
      titles.push(match[1] as string)
    }
    if (chunk.includes('<CohostSettingsSection />')) {
      titles.unshift('Co-host')
    }
    columns.push(titles)
  }
  return columns
}

describe('Settings layout', () => {
  it('sizes config-grid cards to their own content instead of stretching the row', () => {
    const configGrid = pageSource.slice(pageSource.indexOf('export function ConfigGrid'))
    expect(configGrid).toContain("cn('grid items-start gap-5 lg:grid-cols-2', className)")
  })

  it('lays every card out in ONE grid, so no column can wait on another', () => {
    // Two stacked grids left a void: a grid row is as tall as its tallest
    // column, and the second grid could not start until the first ended, so
    // whenever the (tall) co-host column outgrew the left one, the left column
    // stopped early and the gap stretched to the next grid. One grid with two
    // independent stacks cannot reproduce that.
    const grids = settingsTabBody.match(/<ConfigGrid>/g) ?? []
    expect(grids).toHaveLength(1)
  })

  it('splits the cards into two stacked, content-height columns', () => {
    expect(settingsColumns()).toEqual([
      ['Recording & storage', 'System access', 'Appearance & behavior', 'Import', 'Support'],
      ['Co-host', 'Global shortcuts', 'Remote control', 'Shortcuts']
    ])
  })

  it('never pins a Settings card to a fixed height', () => {
    expect(settingsTabBody).not.toMatch(/\b(?:min-)?h-\[/)
    expect(settingsTabBody).not.toMatch(/className="[^"]*\bh-\d/)
  })

  it('gives Remote control a one-line body when it is off, so it is never header-only', () => {
    expect(REMOTE_CONTROL_OFF_HINT).toBe(
      'Off — turn on to pair a Stream Deck or the Videorc remote.'
    )

    const remoteCard = settingsTabBody.slice(settingsTabBody.indexOf('title="Remote control"'))
    const enabledBranch = remoteCard.indexOf('{remoteStatus?.enabled ? (')
    const offBody = remoteCard.indexOf('{REMOTE_CONTROL_OFF_HINT}')

    expect(enabledBranch).toBeGreaterThan(-1)
    expect(offBody).toBeGreaterThan(enabledBranch)
    expect(remoteCard.slice(enabledBranch, offBody)).not.toContain(') : null}')
  })
})
