import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { UsageStatsState } from '@/lib/backend'

import { UsageStatsFieldView } from './usage-stats-field'

const render = (state: UsageStatsState | null, error: string | null = null): string =>
  renderToStaticMarkup(
    createElement(UsageStatsFieldView, { state, error, onEnabledChange: () => undefined })
  )

describe('Settings → General → Privacy → Share anonymous usage stats', () => {
  it('waits for the backend with the switch disabled', () => {
    const markup = render(null)
    expect(markup).toContain('Share anonymous usage stats')
    expect(markup).toMatch(/<span(?=[^>]*role="switch")[^>]*aria-disabled="true"/)
    expect(markup).not.toContain('data-testid="usage-stats-error"')
  })

  it('shows the saved choice, enabled', () => {
    const on = render({ enabled: true, envDisabled: false })
    expect(on).toContain('aria-checked="true"')
    expect(on).not.toMatch(/<span(?=[^>]*role="switch")[^>]*aria-disabled="true"/)
    expect(render({ enabled: false, envDisabled: false })).toContain('aria-checked="false"')
  })

  it('says what is sent and what never is', () => {
    const markup = render({ enabled: true, envDisabled: false })
    expect(markup).toContain('Never stream keys, titles, chat or anything you record.')
    expect(markup).toContain('linked to your account')
  })

  it('locks the switch off, with the reason, when the launch turned sharing off', () => {
    const markup = render({ enabled: false, envDisabled: true })
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toMatch(/<span(?=[^>]*role="switch")[^>]*aria-disabled="true"/)
    expect(markup).toContain('Turned off when Videorc started. Reopen Videorc to change it.')
  })

  it('says why once, ahead of the row, when the setting could not be read', () => {
    const markup = render(null, "Couldn't read the privacy settings. Reopen Settings to try again.")
    expect(markup.indexOf('data-testid="usage-stats-error"')).toBeLessThan(
      markup.indexOf('Share anonymous usage stats')
    )
  })
})
