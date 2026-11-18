// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BackendClient } from '@/backendClient'
import type { SrtInputState } from '@/lib/backend'
import { useSrtInputController } from './use-srt-input'

const state = { enabled: true, port: 9000 } as SrtInputState

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(client: BackendClient) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let result!: ReturnType<typeof useSrtInputController>
  function Probe() {
    result = useSrtInputController(client, 'connected')
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  return { current: () => result, unmount: () => act(async () => root.unmount()) }
}

it('reads the state again after a failed read, until it lands', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const requestTyped = vi
    .fn()
    .mockRejectedValueOnce(new Error('timed out'))
    .mockRejectedValueOnce(new Error('timed out'))
    .mockResolvedValue(state)
  const client = { requestTyped, on: () => () => {} } as unknown as BackendClient
  const probe = await mount(client)
  expect(probe.current().state).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(requestTyped).toHaveBeenCalledTimes(2)
  expect(probe.current().state).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  expect(requestTyped).toHaveBeenCalledTimes(3)
  expect(probe.current().state).toEqual(state)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(requestTyped).toHaveBeenCalledTimes(3)
  await probe.unmount()
})

it('stops reading again once a change event brings the state', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let emit!: (value: SrtInputState) => void
  const requestTyped = vi.fn().mockRejectedValue(new Error('timed out'))
  const client = {
    requestTyped,
    on: (_: string, callback: typeof emit) => {
      emit = callback
      return () => {}
    }
  } as unknown as BackendClient
  const probe = await mount(client)
  await act(async () => emit(state))
  expect(probe.current().state).toEqual(state)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(requestTyped).toHaveBeenCalledTimes(1)
  await probe.unmount()
})

it('waits at most 10 s between reads, and stops when it unmounts', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const requestTyped = vi.fn().mockRejectedValue(new Error('timed out'))
  const client = { requestTyped, on: () => () => {} } as unknown as BackendClient
  const probe = await mount(client)
  // Reads at 0, 1, 3, 7, 15 and 25 s: the gap stops growing at 10 s.
  await act(async () => vi.advanceTimersByTimeAsync(25_000))
  expect(requestTyped).toHaveBeenCalledTimes(6)
  await probe.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(requestTyped).toHaveBeenCalledTimes(6)
})
