// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamTargetRuntime } from '@/lib/backend'

import { StreamFailureBanner } from './streaming-tab'

// Plan 174 S0.1 (D-4): the failure banner's destructive action ends the
// whole livestream, says so, and asks through the End livestream dialog.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const failed: StreamTargetRuntime = {
  targetId: 'twitch',
  platform: 'twitch',
  label: 'Twitch',
  state: 'failed',
  message: 'Connection refused'
}

describe('StreamFailureBanner', () => {
  it('labels its destructive action End livestream and hands the click to the stop request', async () => {
    const onEndLivestream = vi.fn()
    const onDismiss = vi.fn()
    await act(async () =>
      root.render(
        createElement(StreamFailureBanner, { problems: [failed], onEndLivestream, onDismiss })
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'End livestream',
      'Continue streaming'
    ])
    expect(buttons.some((button) => button.textContent?.includes('Stop all'))).toBe(false)
    const end = buttons[0]
    expect(end.getAttribute('data-variant')).toBe('destructive')
    await act(async () => end.click())
    expect(onEndLivestream).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('says what viewers still see from the count on air, in the destination words (J2-19)', async () => {
    const props = { onEndLivestream: vi.fn(), onDismiss: vi.fn() }
    await act(async () =>
      root.render(createElement(StreamFailureBanner, { problems: [failed], ...props }))
    )
    expect(container.textContent).toContain('Some destinations aren’t on air')
    expect(container.textContent).toContain(
      'Failed: Twitch. No other destination is streaming, so viewers see nothing.'
    )
    expect(container.textContent).not.toContain('Stopped')
    await act(async () =>
      root.render(createElement(StreamFailureBanner, { problems: [failed], onAir: 2, ...props }))
    )
    expect(container.textContent).toContain(
      'Failed: Twitch. The other 2 destinations keep streaming.'
    )
  })

  it('is wired to the failure-banner origin, so a livestream asks first', () => {
    const source = readFileSync(join(__dirname, 'streaming-tab.tsx'), 'utf8')
    expect(source).toContain("requestStopSession('failure-banner')")
    expect(source).not.toMatch(/onEndLivestream=\{\(\) => void stopSession\(\)\}/)
  })
})
