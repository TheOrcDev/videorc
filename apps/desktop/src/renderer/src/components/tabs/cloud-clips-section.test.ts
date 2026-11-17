// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloudClipsSection } from './cloud-clips-section'
const mock = vi.hoisted(() => {
  const request = vi.fn()
  return { request, client: { requestTyped: request } }
})
vi.mock('@/hooks/use-studio', () => ({
  useStudioDiagnostics: () => ({ client: mock.client }),
  useStudioCore: () => ({ settings: {} })
}))
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mock.request.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const status = {
  available: false,
  enabled: false,
  generation: null,
  state: 'off',
  reason: 'Managed replay unqualified. Markers remain available.'
}
it('keeps unqualified cloud enablement disabled and displays costs without native capture', async () => {
  mock.request.mockImplementation(async (method: string) =>
    method === 'cloud.clips.jobs' ? [] : status
  )
  await act(async () => root.render(createElement(CloudClipsSection, { showId: 'sh_fixture' })))
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Enable cloud Clips'
  )!
  expect(button.disabled).toBe(true)
  expect(container.textContent).toContain('256 MiB')
  expect(container.textContent).toContain('192 MiB')
  expect(
    mock.request.mock.calls.every(([method]) =>
      ['cloud.clips.status', 'cloud.clips.jobs'].includes(method)
    )
  ).toBe(true)
})
it('explicit enable sends consent to the cloud owner only', async () => {
  mock.request.mockImplementation(async (method: string) =>
    method === 'cloud.clips.jobs' ? [] : { ...status, available: true }
  )
  await act(async () => root.render(createElement(CloudClipsSection, { showId: 'sh_fixture' })))
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Enable cloud Clips'
  )!
  await act(async () => button.click())
  expect(mock.request).toHaveBeenCalledWith('cloud.clips.enable', {
    showId: 'sh_fixture',
    consent: true,
    orientation: 'h',
    requestId: expect.any(String)
  })
  expect(mock.request.mock.calls.some(([method]) => method === 'session.start')).toBe(false)
})
