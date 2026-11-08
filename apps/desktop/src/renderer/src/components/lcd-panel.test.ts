import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  LCD_MESSAGE,
  LcdPanel,
  LcdPanelAction,
  LcdPanelHeader,
  LcdPanelKey,
  LcdPanelNavRow,
  LcdPanelPressRow,
  LcdPanelRow,
  LcdPanelSwitch,
  LcdPanelValue
} from './lcd-panel'

const noop = (): void => {}

describe('the Studio screen kit (plan 197)', () => {
  it('draws a section screen small, on the glass, in the theme ink', () => {
    const markup = renderToStaticMarkup(
      createElement(
        LcdPanel,
        null,
        createElement(LcdPanelRow, { label: 'Output' }, createElement(LcdPanelValue, null, '1080p'))
      )
    )
    const screen = /<div[^>]*data-slot="lcd-display"[^>]*>/.exec(markup)?.[0] ?? ''
    expect(screen).toContain('data-size="sm"')
    expect(screen).toContain('data-variant="primary"')
    expect(screen).toContain('[--lcd-display-bezel:var(--chip-fill-top)]')
    expect(screen).toContain(
      'dark:[--lcd-display-glass:color-mix(in_oklab,var(--glass-solid)_35%,transparent)]'
    )
    // The words stay sentence case in the DOM; the screen prints capitals.
    expect(markup).toMatch(/<span class="shrink-0 text-\(--lcd-display-ink-dim\)">Output<\/span>/)
    expect(markup).toMatch(/data-slot="lcd-display-value"[^>]*>1080p</)
  })

  it('goes to a page from a whole-row button with a right pixel chevron', () => {
    const markup = renderToStaticMarkup(
      createElement(LcdPanelNavRow, { label: 'Captions', value: 'Off', onNavigate: noop })
    )
    expect(markup).toMatch(/^<button[^>]*type="button"/)
    expect(markup).toContain('data-slot="lcd-panel-nav-row"')
    expect(markup).toContain('>Captions</span>')
    expect(markup).toContain('>Off</span>')
    expect(markup).toContain('viewBox="0 0 3 5"')
  })

  it('says a switch is On or Off in words and to assistive tech', () => {
    const on = renderToStaticMarkup(
      createElement(LcdPanelSwitch, {
        'aria-label': 'System audio',
        checked: true,
        onCheckedChange: noop
      })
    )
    expect(on).toContain('role="switch"')
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain('>On</button>')
    const off = renderToStaticMarkup(
      createElement(LcdPanelSwitch, {
        'aria-label': 'System audio',
        checked: false,
        onCheckedChange: noop
      })
    )
    expect(off).toContain('aria-checked="false"')
    expect(off).toContain('text-(--lcd-display-ink-dim)')
    expect(off).toContain('>Off</button>')
  })

  it('presses a row on and off, lit while on', () => {
    const on = renderToStaticMarkup(
      createElement(LcdPanelPressRow, {
        label: 'Be right back',
        pressed: true,
        onPressedChange: noop
      })
    )
    expect(on).toContain('aria-pressed="true"')
    expect(on).toMatch(/text-\(--lcd-display-lit\)">Be right back</)
    expect(on).toMatch(/>On<\/span>/)
    const off = renderToStaticMarkup(
      createElement(LcdPanelPressRow, {
        label: 'Be right back',
        pressed: false,
        disabled: true,
        onPressedChange: noop
      })
    )
    expect(off).toContain('aria-pressed="false"')
    expect(off).toContain('disabled=""')
    expect(off).toMatch(/>Off<\/span>/)
  })

  it('titles a screen with its heading lit and its one action, over a dotted rule', () => {
    const markup = renderToStaticMarkup(
      createElement(LcdPanelHeader, {
        action: createElement(LcdPanelAction, { onClick: noop, children: 'Open Sources' }),
        title: 'Sources'
      })
    )
    expect(markup).toMatch(/<h2 class="[^"]*text-\(--lcd-display-lit\)[^"]*">Sources<\/h2>/)
    expect(markup).toContain('>Open Sources</span>')
    expect(markup).toContain('viewBox="0 0 3 5"')
    expect(markup).toContain('data-slot="lcd-display-separator"')
    expect(
      renderToStaticMarkup(createElement(LcdPanelHeader, { headingLevel: 3, title: 'Mic' }))
    ).toContain('<h3')
  })

  it('draws Record in the record red and every other key in the ink, sentences dim', () => {
    const record = renderToStaticMarkup(createElement(LcdPanelKey, { tone: 'record' }, 'Record'))
    expect(record).toContain('border-(--live)')
    expect(record).toContain('hover:text-(--glass-solid)')
    expect(record).toContain('type="button"')
    expect(renderToStaticMarkup(createElement(LcdPanelKey, null, 'Go Live…'))).toContain(
      'border-(--lcd-display-lit)'
    )
    expect(LCD_MESSAGE).toContain('normal-case')
  })
})
