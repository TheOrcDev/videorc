// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { it, expect, vi } from 'vitest'
import type { BackendClient } from '@/backendClient'
import { useScreenPrivacy } from './use-screen-privacy'
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn() } }))
import { toast } from '@/lib/toast'

it('boots, follows events, re-reads on session transitions, and warns once per refusal id', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let state = { hidden: false }
  let emit!: (value: typeof state) => void
  const off = vi.fn()
  const request = vi.fn(async (method: string) => {
    if (method === 'screen.hide') throw { code: 'screen-hide-unavailable' }
    return state
  })
  const client = {
    request,
    on: (_: string, callback: typeof emit) => {
      emit = callback
      return off
    }
  } as unknown as BackendClient
  let result!: ReturnType<typeof useScreenPrivacy>
  function Probe({ session }: { session: string }) {
    result = useScreenPrivacy(client, session)
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(Probe, { session: 'idle' })))
    expect(request).toHaveBeenCalledWith('screen.privacy.get')
    expect(result.screenPrivacy.hidden).toBe(false)
    state = { hidden: true }
    await act(async () => emit(state))
    expect(result.screenPrivacy.hidden).toBe(true)
    request.mockClear()
    await act(async () => root.render(createElement(Probe, { session: 'recording' })))
    expect(request).toHaveBeenCalledExactlyOnceWith('screen.privacy.get')
    await act(async () => {
      await result.hideScreen()
    })
    expect(toast.warning).toHaveBeenCalledWith(
      "Hide screen isn't available on this recording. Stop and record again.",
      { id: 'screen-hide-unavailable' }
    )
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
  expect(off).toHaveBeenCalled()
})

it('serializes concurrent toggles against confirmed state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let hidden = false
  const request = vi.fn(async (method: string) => {
    if (method === 'screen.hide') hidden = true
    if (method === 'screen.show') hidden = false
    return { hidden }
  })
  const client = { request, on: () => () => {} } as unknown as BackendClient
  let result!: ReturnType<typeof useScreenPrivacy>
  function Probe() {
    result = useScreenPrivacy(client, 'idle')
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Probe)))
    await act(async () => {
      await Promise.all([result.toggleScreenHidden(), result.toggleScreenHidden()])
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'screen.privacy.get',
      'screen.privacy.get',
      'screen.hide',
      'screen.privacy.get',
      'screen.show'
    ])
    expect(result.screenPrivacy.hidden).toBe(false)
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('waits for connection and refreshes after reconnect', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const request = vi.fn().mockResolvedValue({ hidden: true })
  const client = { request, on: () => () => {} } as unknown as BackendClient
  function Probe({ connection }: { connection: string }) {
    useScreenPrivacy(client, 'idle', connection)
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Probe, { connection: 'connecting' })))
    expect(request).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(Probe, { connection: 'connected' })))
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => root.render(createElement(Probe, { connection: 'connecting' })))
    await act(async () => root.render(createElement(Probe, { connection: 'connected' })))
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
