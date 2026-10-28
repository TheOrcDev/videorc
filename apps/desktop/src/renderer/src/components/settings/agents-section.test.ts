// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentsSnapshot } from '@/lib/agents-store'
import type { AgentActivityEntry, AgentSummary, AgentsStatus } from '@/lib/backend'

import { AgentsSection } from './agents-section'

// Plan 209 S7: Settings → Remote → Agents in its four states (empty,
// connected, all ports busy, stopped), the bridge missing from the install,
// Remove behind a confirmation, and Connect's two steps.

const TOKEN = `vrc_agent_${'cd34'.repeat(16)}`
const BRIDGE = '/Applications/Videorc.app/Contents/Resources/videorc-mcp'

const mocked = vi.hoisted(() => ({
  snapshot: {} as AgentsSnapshot,
  actions: {} as Record<string, ReturnType<typeof vi.fn>>
}))
vi.mock('@/hooks/use-agents', () => ({
  useAgents: () => mocked.snapshot,
  useAgentsActions: () => mocked.actions
}))

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Claude Desktop',
    client: 'claude-desktop',
    createdAt: '2026-10-27T12:00:00Z',
    connected: false,
    ...overrides
  }
}

function status(overrides: Partial<AgentsStatus> = {}): AgentsStatus {
  const agents = overrides.agents ?? []
  return {
    enabled: true,
    port: 7440,
    agents,
    connectedCount: agents.filter((entry) => entry.connected).length,
    studioOpen: true,
    ...overrides
  }
}

function row(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    id: 'e1',
    at: new Date().toISOString(),
    agentId: 'a1',
    agentName: 'Claude Desktop',
    tool: 'add_marker',
    summary: '{"title":"Intro done"}',
    outcome: 'ok',
    ...overrides
  }
}

function snapshot(overrides: Partial<AgentsSnapshot> = {}): AgentsSnapshot {
  return {
    status: status(),
    activity: [],
    activityAgentId: null,
    activityLoaded: true,
    bridge: { path: BRIDGE, exists: true },
    connectOpen: false,
    connectRequest: 0,
    offline: false,
    ...overrides
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.snapshot = snapshot()
  mocked.actions = {
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    create: vi.fn(async (name: string, client: string) => ({
      agent: agent({ id: 'new', name, client: client as AgentSummary['client'] }),
      token: TOKEN
    })),
    remove: vi.fn(async () => undefined),
    showActivityFor: vi.fn(async () => undefined),
    prepareBridge: vi.fn(async () => ({ path: BRIDGE, exists: true })),
    addToApp: vi.fn(async () => ({
      added: true,
      message: 'Added. Restart Claude Desktop to see Videorc.'
    })),
    openConnect: vi.fn(() => {
      mocked.snapshot = { ...mocked.snapshot, connectOpen: true }
    }),
    closeConnect: vi.fn(() => {
      mocked.snapshot = { ...mocked.snapshot, connectOpen: false }
    })
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => root.render(createElement(AgentsSection)))
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const text = (): string => document.body.textContent ?? ''
const agentsSwitch = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[aria-label="Let AI agents control Videorc"]')!

describe('AgentsSection states (plan 209 S7)', () => {
  it('empty: off by default, says what turning it on does, and turns it on', async () => {
    mocked.snapshot = snapshot({ status: status({ enabled: false }), activityLoaded: true })
    await render()
    expect(agentsSwitch().getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain(
      'Agents on this computer can run everything in Videorc: scenes, sounds, recording, going live, chat and your Library.'
    )
    expect(text()).toContain('Turn this on, then connect Claude, Cursor, Codex')
    expect(byTestId('agents-connect')).toBeNull()
    expect(byTestId('agents-list')).toBeNull()
    expect(byTestId('agents-activity')).toBeNull()
    await act(async () => agentsSwitch().click())
    expect(mocked.actions.enable).toHaveBeenCalledOnce()
  })

  it('waits for Videorc before the switch can change', async () => {
    mocked.snapshot = snapshot({ status: null })
    await render()
    expect(agentsSwitch().disabled).toBe(true)
  })

  it('on with no agents: Connect an agent… and the apps it works with', async () => {
    await render()
    expect(agentsSwitch().getAttribute('aria-checked')).toBe('true')
    expect(byTestId('agents-connect')?.textContent).toBe('Connect an agent…')
    expect(text()).toContain('Claude Desktop, Claude Code, Cursor, Codex, VS Code')
    await act(async () => byTestId('agents-connect')!.click())
    expect(mocked.actions.openConnect).toHaveBeenCalledOnce()
  })

  it('connected: each agent with its last action or Never used, and Activity', async () => {
    mocked.snapshot = snapshot({
      status: status({
        agents: [
          agent({
            connected: true,
            lastUsedAt: new Date().toISOString(),
            lastAction: { tool: 'add_marker', at: new Date().toISOString(), outcome: 'ok' }
          }),
          agent({ id: 'a2', name: 'Cursor', client: 'cursor' })
        ]
      }),
      activity: [
        row(),
        row({
          id: 'e2',
          tool: 'set_banner',
          summary: '{"shown":true}',
          outcome: 'refused',
          message: 'There is no banner with that id.'
        })
      ]
    })
    await render()
    const list = byTestId('agents-list')!
    expect(list.textContent).toContain('Claude Desktop')
    expect(list.textContent).toContain('Add a marker')
    expect(list.textContent).toContain('now')
    expect(list.querySelectorAll('[data-testid="agent-connected"]')).toHaveLength(1)
    expect(list.textContent).toContain('Connected')
    expect(list.textContent).toContain('Cursor')
    expect(list.textContent).toContain('Never used')
    expect(text()).toContain('1 connected right now.')

    const activity = byTestId('agents-activity')!
    const rows = activity.querySelectorAll('[data-slot="agent-activity-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Add a marker')
    expect(rows[0].textContent).toContain('Done')
    expect(rows[0].textContent).toContain('title: Intro done')
    expect(rows[1].textContent).toContain('Show or hide a banner')
    expect(rows[1].textContent).toContain('Refused')
    // A refusal shows why, never the arguments.
    expect(rows[1].textContent).toContain('There is no banner with that id.')
    expect(activity.querySelector('[aria-label="Activity from"]')).toBeTruthy()
  })

  it('busy ports: the reason in place, in copy and never the raw OS text', async () => {
    mocked.snapshot = snapshot({
      status: status({
        port: undefined,
        bindError:
          'Ports 7440–7449 are all in use (Address already in use (os error 48)). Quit the app using them and turn Agents on again.',
        bindErrorKind: 'ports-busy'
      })
    })
    await render()
    const alert = byTestId('agents-ports-busy')!
    expect(alert.textContent).toContain('Ports 7440 to 7449 are all in use')
    expect(alert.textContent).not.toContain('os error')
    expect(byTestId('agents-bind-failed')).toBeNull()
  })

  it('another bind failure: branches on the kind, never the words', async () => {
    mocked.snapshot = snapshot({
      status: status({
        port: undefined,
        // Words that look like busy ports; the kind says otherwise.
        bindError: 'Ports are all in use (Permission denied (os error 13)).',
        bindErrorKind: 'other'
      })
    })
    await render()
    expect(byTestId('agents-ports-busy')).toBeNull()
    const alert = byTestId('agents-bind-failed')!
    expect(alert.textContent).toContain("Videorc couldn't open a port for agents")
    expect(alert.textContent).not.toContain('os error')

    // Off, a stale failure says nothing.
    mocked.snapshot = snapshot({
      status: status({ enabled: false, bindError: 'x', bindErrorKind: 'ports-busy' })
    })
    await render()
    expect(byTestId('agents-ports-busy')).toBeNull()
    expect(byTestId('agents-bind-failed')).toBeNull()
  })

  it("stopped: off, the agents and Activity stay readable, and the line says they'll reconnect", async () => {
    mocked.snapshot = snapshot({
      status: status({ enabled: false, port: undefined, agents: [agent({ connected: false })] }),
      activity: [row()]
    })
    await render()
    expect(agentsSwitch().getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('Agents is off. Your agents connect again when you turn it on.')
    expect(byTestId('agents-connect')).toBeNull()
    expect(byTestId('agents-list')?.querySelector('[data-testid="agent-connected"]')).toBeNull()
    expect(byTestId('agents-activity')).toBeTruthy()
  })

  it('bridge missing: says so and keeps Connect disabled with the reason', async () => {
    mocked.snapshot = snapshot({ bridge: { path: BRIDGE, exists: false } })
    await render()
    expect(byTestId('agents-bridge-missing')?.textContent).toContain('missing its agent bridge')
    expect((byTestId('agents-connect') as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks before removing an agent, and removes it on confirm', async () => {
    mocked.snapshot = snapshot({ status: status({ agents: [agent()] }) })
    await render()
    const openMenu = async (): Promise<void> => {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="More actions for Claude Desktop"]'
      )!
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      })
      const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(
        (entry) => entry.textContent?.trim() === 'Remove…'
      )!
      await act(async () => item.click())
    }
    await openMenu()
    expect(byTestId('agent-remove-dialog')?.textContent).toContain('Remove Claude Desktop?')
    await act(async () => byTestId('agent-remove-cancel')!.click())
    expect(mocked.actions.remove).not.toHaveBeenCalled()
    await openMenu()
    await act(async () => byTestId('agent-remove-confirm')!.click())
    expect(mocked.actions.remove).toHaveBeenCalledExactlyOnceWith('a1')
  })
})

describe('Connect an agent… (plan 209 S7, D6)', () => {
  it('connects Claude Desktop by default and shows its line once, the token masked until shown', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mocked.snapshot = snapshot({ connectOpen: true })
    await render()
    const dialog = byTestId('connect-agent-dialog')!
    expect(dialog.textContent).toContain('Connect an agent')
    expect(document.querySelector<HTMLInputElement>('#connect-agent-name')!.value).toBe(
      'Claude Desktop'
    )
    await act(async () => byTestId('connect-agent-create')!.click())
    expect(mocked.actions.prepareBridge).toHaveBeenCalledOnce()
    expect(mocked.actions.enable).not.toHaveBeenCalled()
    expect(mocked.actions.create).toHaveBeenCalledExactlyOnceWith(
      'Claude Desktop',
      'claude-desktop'
    )

    const line = byTestId('connect-agent-line')!
    expect(byTestId('connect-agent-dialog')!.textContent).toContain('Shown once')
    expect(byTestId('connect-agent-dialog')!.textContent).toContain('claude_desktop_config.json')
    expect(line.textContent).toContain(BRIDGE)
    expect(line.textContent).not.toContain(TOKEN)
    const show = [...document.querySelectorAll('button')].find(
      (entry) => entry.textContent?.trim() === 'Show token'
    )!
    await act(async () => show.click())
    expect(byTestId('connect-agent-line')!.textContent).toContain(TOKEN)

    await act(async () => byTestId('connect-agent-copy')!.click())
    expect(writeText).toHaveBeenCalledOnce()
    const copied = JSON.parse((writeText.mock.calls[0] as unknown as [string])[0])
    expect(copied.mcpServers.videorc).toEqual({
      command: BRIDGE,
      args: [],
      env: { VIDEORC_AGENT_TOKEN: TOKEN }
    })
  })

  it('adds the agent to Claude Desktop in one click, and says to restart it (S22)', async () => {
    mocked.snapshot = snapshot({ connectOpen: true })
    await render()
    await act(async () => byTestId('connect-agent-create')!.click())
    const add = byTestId('connect-agent-add')!
    expect(add.textContent).toBe('Add to Claude Desktop')
    expect(byTestId('connect-agent-add-result')).toBeNull()
    await act(async () => add.click())
    expect(mocked.actions.addToApp).toHaveBeenCalledExactlyOnceWith('claude-desktop', TOKEN)
    const result = byTestId('connect-agent-add-result')!
    expect(result.textContent).toContain('Added. Restart Claude Desktop to see Videorc.')
    expect(result.getAttribute('data-variant')).toBe('success')
    // The line stays, for pasting anywhere else.
    expect(byTestId('connect-agent-line')!.textContent).toContain(BRIDGE)
  })

  it("shows main's sentence when the app's file was left alone, and the line stays (S22)", async () => {
    const sentence =
      "Cursor's mcp.json isn't plain JSON, so Videorc left it alone. Copy the line instead."
    mocked.actions.addToApp = vi.fn(async () => ({ added: false, message: sentence }))
    mocked.snapshot = snapshot({ connectOpen: true })
    await render()
    await act(async () => byTestId('connect-agent-create')!.click())
    await act(async () => byTestId('connect-agent-add')!.click())
    const result = byTestId('connect-agent-add-result')!
    expect(result.textContent).toContain(sentence)
    expect(result.getAttribute('data-variant')).toBe('warning')
    expect(byTestId('connect-agent-copy')).not.toBeNull()
  })

  it("says to copy the line when main can't be reached (S22)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mocked.actions.addToApp = vi.fn(async () => {
      throw new Error('ipc closed')
    })
    mocked.snapshot = snapshot({ connectOpen: true })
    await render()
    await act(async () => byTestId('connect-agent-create')!.click())
    await act(async () => byTestId('connect-agent-add')!.click())
    expect(byTestId('connect-agent-add-result')!.textContent).toContain(
      "Couldn't add Videorc to Claude Desktop. Copy the line instead."
    )
    expect(byTestId('connect-agent-add-result')!.textContent).not.toContain('ipc closed')
  })

  it('turns Agents on when it connects from ⌘K with Agents off', async () => {
    mocked.snapshot = snapshot({ status: status({ enabled: false }), connectOpen: true })
    await render()
    expect(byTestId('connect-agent-dialog')!.textContent).toContain('Connecting turns Agents on.')
    await act(async () => byTestId('connect-agent-create')!.click())
    expect(mocked.actions.enable).toHaveBeenCalledOnce()
    expect(mocked.actions.create).toHaveBeenCalledOnce()
  })

  it("never mints a token for a line whose bridge isn't there", async () => {
    mocked.actions.prepareBridge = vi.fn(async () => ({ path: BRIDGE, exists: false }))
    mocked.snapshot = snapshot({ connectOpen: true })
    await render()
    await act(async () => byTestId('connect-agent-create')!.click())
    expect(mocked.actions.create).not.toHaveBeenCalled()
    expect(byTestId('connect-agent-dialog')!.textContent).toContain('missing its agent bridge')
  })

  it('refuses to connect while Videorc runs from a disk image (review #19)', async () => {
    const dmg = '/Volumes/Videorc/Videorc.app/Contents/Resources/videorc-mcp'
    mocked.snapshot = snapshot({ bridge: { path: dmg, exists: true }, connectOpen: true })
    await render()
    expect(byTestId('connect-agent-move-first')!.textContent).toContain(
      'Move Videorc to Applications first.'
    )
    expect((byTestId('connect-agent-create') as HTMLButtonElement).disabled).toBe(true)

    // The path Connect prepares is checked too: no token, no line.
    mocked.snapshot = snapshot({ connectOpen: true })
    mocked.actions.prepareBridge = vi.fn(async () => ({ path: dmg, exists: true }))
    await render()
    await act(async () => byTestId('connect-agent-create')!.click())
    expect(mocked.actions.create).not.toHaveBeenCalled()
    expect(byTestId('connect-agent-line')).toBeNull()
    expect(byTestId('connect-agent-dialog')!.textContent).toContain(
      'Move Videorc to Applications first.'
    )
  })

  it("shows the backend's refusal under the name", async () => {
    mocked.actions.create = vi.fn(async () => {
      throw Object.assign(new Error('16 agents are connected. Remove one first.'), {
        code: 'agents'
      })
    })
    mocked.snapshot = snapshot({ connectOpen: true })
    await render()
    await act(async () => byTestId('connect-agent-create')!.click())
    expect(byTestId('connect-agent-dialog')!.textContent).toContain(
      '16 agents are connected. Remove one first.'
    )
    expect(byTestId('connect-agent-line')).toBeNull()
  })
})
