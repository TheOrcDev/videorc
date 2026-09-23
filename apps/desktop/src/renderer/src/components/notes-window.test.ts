import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NotesWindow, notesWordCount } from './notes-window'

const render = (props: Parameters<typeof NotesWindow>[0] = {}): string =>
  renderToStaticMarkup(createElement(NotesWindow, props))

describe('NotesWindow', () => {
  it('renders the window-family header: title, text size and keep-on-top', () => {
    const markup = render()
    expect(markup).toContain('>Notes<')
    expect(markup).toContain('aria-label="Text size"')
    for (const label of ['S text', 'M text', 'L text']) {
      expect(markup).toContain(`aria-label="${label}"`)
    }
    expect(markup).toContain('aria-label="Keep notes in front of all apps"')
    expect(markup).toContain('[-webkit-app-region:drag]')
  })

  it('keeps the teleprompter private and bounded', () => {
    const markup = render({ maxLength: 1000 })
    // An I-beam over empty space would betray the capture-protected notes.
    expect(markup).toContain('cursor-default')
    expect(markup).toContain('maxLength="1000"')
    // Read-only until the saved document has loaded, so typing is never lost.
    expect(markup).toContain('readOnly=""')
    expect(markup).toContain('placeholder="Notes for this recording…"')
  })

  it('shows word count and save state in the status line', () => {
    const markup = render()
    expect(markup).toContain('>0 words<')
    // Line height survives the font-size merge.
    expect(markup).toContain('leading-[1.45]')
    expect(markup).toContain('field-sizing-fixed')
    expect(markup).not.toContain('field-sizing-content')
    expect(markup).toContain('>Saved<')
  })

  it('paints the recording-invisibility smoke marker loud red', () => {
    const plain = render()
    const marked = render({ smokeMarker: true })
    expect(plain).not.toContain('#ff0000')
    expect(marked).toContain('data-smoke-marker="true"')
    expect(marked.match(/bg-\[#ff0000\]/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(marked).toContain('text-[64px]')
  })
})

describe('notesWordCount', () => {
  it('counts words the way the old Notes window did', () => {
    expect(notesWordCount('')).toBe(0)
    expect(notesWordCount('   ')).toBe(0)
    expect(notesWordCount('one')).toBe(1)
    expect(notesWordCount(' intro\n\nand  outro ')).toBe(3)
  })
})
