// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStatus, RemoteLanStatus } from '@/lib/backend'

import { RemoteSettings, pairedPhonesClause } from './remote-settings'

// Plan 174 S0.3 (I-15, I-16): regenerating the token, removing a phone and
// turning remote control off while phones are paired all disconnect a device
// mid-stream, so each asks first.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

const remoteStatus: RemoteControlStatus = {
  enabled: true,
  token: 'abcdefghijklmnop',
  port: 7700,
  connectedClients: 1,
  discoveryPath: null
}
const phoneStatus: RemoteLanStatus = {
  enabled: true,
  port: 7788,
  addresses: ['192.168.1.20'],
  devices: [{ id: 'phone-1', name: 'Pixel', createdAt: '2026-10-10T00:00:00Z', connected: true }]
}

let root: Root
let container: HTMLDivElement

function core(overrides: {
  remote?: Partial<RemoteControlStatus>
  phone?: RemoteLanStatus | null
}) {
  return {
    remoteControl: {
      status: { ...remoteStatus, ...overrides.remote },
      enable: vi.fn(async () => null),
      disable: vi.fn(async () => null),
      regenerate: vi.fn(async () => null),
      phone: {
        status: overrides.phone === undefined ? phoneStatus : overrides.phone,
        enable: vi.fn(async () => null),
        disable: vi.fn(async () => null),
        beginPairing: vi.fn(async () => null),
        cancelPairing: vi.fn(async () => null),
        revokeDevice: vi.fn(async () => null),
        renameDevice: vi.fn(async () => null)
      }
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = core({})
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text
  )
  expect(found, text).toBeTruthy()
  return found!
}
const remote = () =>
  (mocked.core as ReturnType<typeof core>).remoteControl as ReturnType<typeof core>['remoteControl']

async function openPhoneMenu(name: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(
    `[aria-label="More actions for ${name}"]`
  )!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
}
const menuItem = (text: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(
    (entry) => entry.textContent?.trim() === text
  )
  expect(found, text).toBeTruthy()
  return found!
}

async function render(): Promise<void> {
  await act(async () => root.render(createElement(RemoteSettings)))
}

describe('RemoteSettings confirms', () => {
  it('asks before regenerating the pairing token', async () => {
    await render()
    await act(async () => button('Regenerate').click())
    const dialog = byTestId('remote-token-regenerate-dialog')
    expect(dialog?.textContent).toContain('Regenerate the pairing token?')
    expect(dialog?.textContent).toContain('Every paired client is disconnected')
    await act(async () => byTestId('remote-token-regenerate-cancel')!.click())
    expect(remote().regenerate).not.toHaveBeenCalled()
    await act(async () => button('Regenerate').click())
    await act(async () => byTestId('remote-token-regenerate-confirm')!.click())
    expect(remote().regenerate).toHaveBeenCalledOnce()
  })

  it('asks before turning remote control off while a phone is paired, and says why', async () => {
    await render()
    const toggle = document.querySelector<HTMLButtonElement>(
      '[aria-label="Enable remote control"]'
    )!
    await act(async () => toggle.click())
    const dialog = byTestId('remote-control-off-dialog')
    expect(dialog?.textContent).toContain('Turn off remote control?')
    expect(dialog?.textContent).toContain(
      'Phone remote turns off with it: 1 paired phone is disconnected'
    )
    await act(async () => byTestId('remote-control-off-cancel')!.click())
    expect(remote().disable).not.toHaveBeenCalled()
    await act(async () => toggle.click())
    await act(async () => byTestId('remote-control-off-confirm')!.click())
    expect(remote().disable).toHaveBeenCalledOnce()
  })

  it('turns remote control off at once when no phone is paired', async () => {
    mocked.core = core({ phone: { ...phoneStatus, devices: [] } })
    await render()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Enable remote control"]')!.click()
    )
    expect(byTestId('remote-control-off-dialog')).toBeNull()
    expect(remote().disable).toHaveBeenCalledOnce()
  })

  it('asks before removing a phone', async () => {
    await render()
    await openPhoneMenu('Pixel')
    await act(async () => menuItem('Remove…').click())
    const dialog = byTestId('phone-remove-dialog')
    expect(dialog?.textContent).toContain('Remove Pixel?')
    expect(dialog?.textContent).toContain('It is disconnected now')
    await act(async () => byTestId('phone-remove-cancel')!.click())
    expect(remote().phone.revokeDevice).not.toHaveBeenCalled()
    await openPhoneMenu('Pixel')
    await act(async () => menuItem('Remove…').click())
    await act(async () => byTestId('phone-remove-confirm')!.click())
    expect(remote().phone.revokeDevice).toHaveBeenCalledExactlyOnceWith('phone-1')
  })

  it('renames a phone from its row (I-28)', async () => {
    await render()
    await openPhoneMenu('Pixel')
    await act(async () => menuItem('Rename…').click())
    const input = document.querySelector<HTMLInputElement>('#phone-rename-name')!
    expect(input.value).toBe('Pixel')
    const save = byTestId('phone-rename-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, 'Desk phone')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(remote().phone.renameDevice).toHaveBeenCalledExactlyOnceWith('phone-1', 'Desk phone')
    expect(byTestId('phone-rename-dialog')).toBeNull()
  })
})

describe('RemoteSettings rows (plan 174 S3.17)', () => {
  it('shows the pairing token as a read-only value its label names (I-22)', async () => {
    await render()
    const token = document.querySelector<HTMLInputElement>('#remote-token')!
    expect(token.tagName).toBe('INPUT')
    expect(token.readOnly).toBe(true)
    expect(token.value).toBe('abcdefgh…mnop')
    const label = [...document.querySelectorAll('label')].find(
      (entry) => entry.textContent === 'Pairing token'
    )
    expect(label?.getAttribute('for')).toBe('remote-token')
    expect(document.body.textContent).toContain('1 client connected.')
  })

  it('locks pairing with its reason when the network is the problem (I-8)', async () => {
    mocked.core = core({ phone: { ...phoneStatus, addresses: [] } })
    await render()
    const alert = [...document.querySelectorAll('[data-slot="alert"]')].find((entry) =>
      entry.textContent?.includes('No Wi-Fi or Ethernet network found.')
    )
    expect(alert).toBeTruthy()
    const pair = button('Pair a phone…')
    expect(pair.disabled).toBe(true)
    const reasonId = pair.closest('[data-slot="disabled-reason"]')?.getAttribute('aria-describedby')
    expect(document.getElementById(reasonId!)?.textContent).toContain('No Wi-Fi or Ethernet')
  })

  it('lists paired phones as rows with their state', async () => {
    await render()
    const list = document.querySelector(
      '[data-slot="grouped-list"]:has([aria-label="More actions for Pixel"])'
    )
    expect(list?.textContent).toContain('Pixel')
    expect(list?.textContent).toContain('Connected')
    expect(button('Pair a phone…').disabled).toBe(false)
  })

  it('never repeats the switch with an "Off." line when off (V-6)', async () => {
    mocked.core = core({ remote: { enabled: false }, phone: { ...phoneStatus, enabled: false } })
    await render()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/Off\. Turn on/)
    expect(text).not.toContain('token below')
    expect(text).toContain('Turning this on makes a pairing token')
  })
})

describe('pairedPhonesClause', () => {
  it('agrees with its count', () => {
    expect(pairedPhonesClause(1)).toBe('1 paired phone is')
    expect(pairedPhonesClause(3)).toBe('3 paired phones are')
  })
})
