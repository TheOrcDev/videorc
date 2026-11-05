// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { MarkerContext } from '../../../shared/session-markers'
import { useMarkerContextPublisher } from './use-marker-context-publisher'

const clip = { available: true, seconds: 30, longSeconds: 60 } as const

// Buddy's answer lives in the Stream Manager's composer, which mounts only
// while a context exists. A `null` between two contexts (the old effect's
// cleanup on every dependency change) unmounted it for one render and the
// answer never showed (smoke:buddy-act, 2026-11-03).
it('pushes each new context without a null in between, and null once on unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const push = vi.fn()
  function Probe({ context }: { context: MarkerContext }) {
    useMarkerContextPublisher(context, push)
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  const first: MarkerContext = { available: false, clip, screen: { hidden: false } }
  await act(async () => root.render(createElement(Probe, { context: first })))
  expect(push.mock.calls).toEqual([[first]])

  // The same facts, a new object: nothing to say.
  await act(async () => root.render(createElement(Probe, { context: { ...first } })))
  expect(push).toHaveBeenCalledTimes(1)

  // A changed fact: the new context, and only that.
  const hidden: MarkerContext = { ...first, screen: { hidden: true } }
  await act(async () => root.render(createElement(Probe, { context: hidden })))
  expect(push.mock.calls).toEqual([[first], [hidden]])
  expect(push).not.toHaveBeenCalledWith(null)

  await act(async () => root.unmount())
  expect(push).toHaveBeenLastCalledWith(null)
  expect(push).toHaveBeenCalledTimes(3)
})
