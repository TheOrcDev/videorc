import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NotesWindow, notesWordCount } from './notes-window'

const render = (props: Parameters<typeof NotesWindow>[0] = {}): string =>
  renderToStaticMarkup(createElement(NotesWindow, props))

describe('NotesWindow', () => {
  it('renders the window-family header with the title only', () => {
    const markup = render()
    // Plan 174 S1.6b (I-29): the shared window header, its title an h1.
    expect(markup).toContain('data-slot="window-header-title">Notes</h1>')
    expect(markup).toContain('[-webkit-app-region:drag]')
    // Plan 174 S3.19: no controls in the title row.
    expect(markup).not.toContain('data-slot="window-header-actions"')
    const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'))
    expect(header).not.toContain('radiogroup')
    expect(header).not.toContain('Keep on top')
  })

  it('puts text size and keep-on-top in the footer status line', () => {
    const markup = render()
    const footer = markup.slice(markup.indexOf('<footer'), markup.indexOf('</footer>'))
    expect(footer).toContain('aria-label="Text size"')
    // One segmented control (plan 174 S1.7), each size named in full (I-24).
    expect(footer).toContain('role="radiogroup"')
    for (const label of ['Small text', 'Medium text', 'Large text']) {
      expect(footer).toContain(`aria-label="${label}"`)
    }
    expect(footer).toContain('aria-label="Keep on top"')
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
    // Visual only (I-24): a live region here announced every keystroke.
    expect(markup).not.toContain('aria-live')
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
