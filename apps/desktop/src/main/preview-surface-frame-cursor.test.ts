import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The proof surface (Windows idle, Linux) polls each source layer with the
// cursor of the last frame it drew, so an unchanged source answers 204. These
// run the page's own request builder from main/index.ts.
const here = dirname(fileURLToPath(import.meta.url))

type Poller = {
  requestedMaxWidth?: string | null
  generation?: string | null
  sequence?: number | null
}
type FrameRequestUrl = (url: string, poller: Poller, displayedWidth?: number) => string

function proofSurfaceFrameRequestUrl(): FrameRequestUrl {
  const source = readFileSync(join(here, 'index.ts'), 'utf8')
  const page = source.slice(source.indexOf('function nativePreviewSurfaceHtml('))
  const start = page.indexOf('function profiledFrameUrl(')
  const end = page.indexOf('function responseFrameCursor(')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return new Function(
    'framePollingMaxWidth',
    'framePollingCeilingWidth',
    `${page.slice(start, end)}\nreturn frameRequestUrl;`
  )(1920, 1920) as FrameRequestUrl
}

const frameRequestUrl = proofSurfaceFrameRequestUrl()
const SOURCE = 'http://127.0.0.1:4000/preview/source/screen.jpg?maxWidth=1280'

function cursorOf(url: string): { generation: string | null; sequence: string | null } {
  const parsed = new URL(url)
  return {
    generation: parsed.searchParams.get('afterGeneration'),
    sequence: parsed.searchParams.get('afterSequence')
  }
}

const NO_CURSOR = { generation: null, sequence: null }

describe('proof surface frame cursor', () => {
  it('sends the last drawn frame while the width holds', () => {
    const poller: Poller = {}
    expect(cursorOf(frameRequestUrl(SOURCE, poller, 960))).toStrictEqual(NO_CURSOR)
    poller.generation = 'run-a'
    poller.sequence = 41
    expect(cursorOf(frameRequestUrl(SOURCE, poller, 960))).toStrictEqual({
      generation: 'run-a',
      sequence: '41'
    })
  })

  it('asks for a whole frame after a resize until one arrives at the new width', () => {
    const poller: Poller = {}
    frameRequestUrl(SOURCE, poller, 960)
    poller.generation = 'run-a'
    poller.sequence = 41

    // The Preview grows: the first request at 1320 carries no cursor.
    const resized = frameRequestUrl(SOURCE, poller, 1320)
    expect(new URL(resized).searchParams.get('maxWidth')).toBe('1320')
    expect(cursorOf(resized)).toStrictEqual(NO_CURSOR)

    // That request fails, so no cursor is stored. A still source would
    // answer the old cursor with 204 and leave the 960 px frame stretched:
    // the retry must ask for a whole frame again.
    expect(cursorOf(frameRequestUrl(SOURCE, poller, 1320))).toStrictEqual(NO_CURSOR)

    // A frame at 1320 arrives: its cursor is used from then on.
    poller.generation = 'run-a'
    poller.sequence = 42
    expect(cursorOf(frameRequestUrl(SOURCE, poller, 1320))).toStrictEqual({
      generation: 'run-a',
      sequence: '42'
    })
  })
})
