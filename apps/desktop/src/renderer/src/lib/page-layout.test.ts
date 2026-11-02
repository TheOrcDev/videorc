import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { CONFIG_GRID_PAIR } from '@/components/page'

import {
  CAPTIONS_GRID,
  CAPTIONS_PREVIEW_PIN,
  CLEAN_CUT_REVIEW_GRID,
  CLEAN_CUT_REVIEW_PLAYER,
  CLEAN_CUT_REVIEW_PLAYER_PANE,
  LIVESTREAM_SETUP_GRID,
  PAGE_CONTAINER,
  PAGE_LEAD_COLUMN,
  PAGE_TRAIL_COLUMN,
  PAGE_WIDE_MIN_PX,
  SCENE_GRID
} from './page-layout'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const WIDE = `@min-[${PAGE_WIDE_MIN_PX}px]/page:`
const SIDEBAR_PX = 208
const VIEWPORT_BREAKPOINT = /(^|[\s'"`])(lg|xl|2xl):/

/** The page's content width in a main window this wide. */
const content = (windowWidth: number): number => windowWidth - SIDEBAR_PX

/** The tracks a grid class string lays out at a page width. */
function columnsAt(classes: string, pageWidth: number): number {
  const wide = pageWidth >= PAGE_WIDE_MIN_PX
  const tracks = new RegExp(`(?:^|\\s)${wide ? escape(WIDE) : ''}grid-cols-(\\S+)`).exec(classes)
  if (!tracks) return 1
  const value = tracks[1] as string
  return value.startsWith('[') ? value.split('_').length : Number(value)
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

const pages = [
  {
    name: 'Settings (ConfigGrid)',
    grid: read('../components/page.tsx'),
    file: '../components/page.tsx',
    uses: 'function ConfigGrid'
  },
  {
    name: 'Livestream → Setup',
    grid: LIVESTREAM_SETUP_GRID,
    file: '../components/tabs/streaming-tab.tsx',
    uses: 'LIVESTREAM_SETUP_GRID'
  },
  {
    name: 'Scene',
    grid: SCENE_GRID,
    file: '../components/tabs/layout-tab.tsx',
    uses: 'SCENE_GRID'
  },
  {
    name: 'Captions',
    grid: CAPTIONS_GRID,
    file: '../components/tabs/captions-tab.tsx',
    uses: 'CAPTIONS_GRID'
  },
  {
    name: 'Clean cut review',
    grid: CLEAN_CUT_REVIEW_GRID,
    file: '../components/clean-cut/clean-cut-review.tsx',
    uses: 'CLEAN_CUT_REVIEW_GRID'
  }
] as const

describe('Page layout (plan 213 C3)', () => {
  it('makes the shell pane body the page container', () => {
    expect(PAGE_CONTAINER).toBe('@container/page')
    expect(read('../components/app-shell.tsx')).toContain(
      '<PaneBody className={PAGE_CONTAINER} key={active}>'
    )
  })

  it('stays one column in a 960 px and a 1,100 px window, and two in the default 1,180 px one', () => {
    expect(content(960)).toBeLessThan(PAGE_WIDE_MIN_PX)
    expect(content(1100)).toBeLessThan(PAGE_WIDE_MIN_PX)
    expect(content(1180)).toBeGreaterThanOrEqual(PAGE_WIDE_MIN_PX)
  })

  describe.each(pages)('$name', ({ grid, file, uses }) => {
    it('keys on the page container, never the viewport', () => {
      const source = read(file)
      expect(source).toContain(uses)
      expect(source).not.toMatch(VIEWPORT_BREAKPOINT)
      expect(grid).toContain(`${WIDE}grid-cols-`)
    })

    it('is one column at the 960 px minimum and in a 1,100 px window', () => {
      expect(columnsAt(grid, content(960))).toBe(1)
      expect(columnsAt(grid, content(1100))).toBe(1)
    })

    it('is two columns from the wide width', () => {
      expect(columnsAt(grid, PAGE_WIDE_MIN_PX)).toBe(2)
      expect(columnsAt(grid, content(1280))).toBe(2)
    })
  })

  it('draws the column hairline and the stacked hairline only where they divide', () => {
    expect(PAGE_LEAD_COLUMN).toContain(`${WIDE}border-r`)
    expect(PAGE_LEAD_COLUMN).not.toMatch(/(^|\s)border-r(\s|$)/)
    expect(PAGE_TRAIL_COLUMN).toMatch(/(^|\s)border-t(\s|$)/)
    expect(PAGE_TRAIL_COLUMN).toContain(`${WIDE}border-t-0`)
    expect(CONFIG_GRID_PAIR).toContain(`${WIDE}content-stretch`)
  })

  it('pins the Captions preview only beside the controls', () => {
    expect(CAPTIONS_PREVIEW_PIN).toBe(`${WIDE}sticky ${WIDE}top-0`)
  })

  it("puts Clean cut's player beside its controls when narrow and over them when wide", () => {
    expect(CLEAN_CUT_REVIEW_GRID).toMatch(/(^|\s)flex-col(\s|$)/)
    expect(CLEAN_CUT_REVIEW_PLAYER_PANE).toContain(`${WIDE}flex-col`)
    expect(CLEAN_CUT_REVIEW_PLAYER_PANE).toContain(`${WIDE}overflow-y-auto`)
    expect(CLEAN_CUT_REVIEW_PLAYER).toContain(`${WIDE}w-full`)
  })
})
