// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHAT_COMMAND_MAX_COUNT,
  type ChatCommand,
  type ChatCommandSaveParams,
  type ChatCommandsState
} from '../../../../shared/chat-commands'
import { createChatCommandsStore, type ChatCommandsClient } from '@/lib/chat-commands-store'
import {
  CHAT_COMMANDS_HELP,
  ChatCommandsSection,
  chatCommandAddBlockedReason
} from './chat-commands-section'
import { chatCommandRoomLabel } from './chat-command-dialog'

// Plan 226 S3: Livestream → Setup → Chat commands. The list and its
// switches, Add command… and Edit… in one dialog (the fixed `!`, the
// counter, the X note, the preview), and Delete behind its question.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Base UI finishes opening and closing on animation frames.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function command(name: string, overrides: Partial<ChatCommand> = {}): ChatCommand {
  return {
    id: `id-${name}`,
    name,
    description: `about ${name}`,
    reply: `reply for ${name}`,
    enabled: true,
    createdAt: '2026-11-10T18:00:00Z',
    updatedAt: '2026-11-10T18:00:00Z',
    ...overrides
  }
}

/** The backend's answers: the whole state after every mutation, A–Z. */
function fakeBackend(commands: ChatCommand[] = [], listEnabled = true) {
  let state: ChatCommandsState = { commands, listEnabled }
  let refuseNext: string | null = null
  const sorted = (list: ChatCommand[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))
  const requestTyped = vi.fn(async (method: string, params?: unknown) => {
    if (refuseNext) {
      const message = refuseNext
      refuseNext = null
      throw new Error(message)
    }
    switch (method) {
      case 'chatCommands.list':
        return state
      case 'chatCommands.save': {
        const save = params as ChatCommandSaveParams
        const saved = command(save.name, { ...save, id: save.id ?? `id-${save.name}` })
        state = {
          ...state,
          commands: sorted([...state.commands.filter((entry) => entry.id !== saved.id), saved])
        }
        return state
      }
      case 'chatCommands.delete':
        state = {
          ...state,
          commands: state.commands.filter((entry) => entry.id !== (params as { id: string }).id)
        }
        return state
      case 'chatCommands.setListEnabled':
        state = { ...state, listEnabled: (params as { enabled: boolean }).enabled }
        return state
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  const client = { requestTyped, on: () => () => undefined } as unknown as ChatCommandsClient
  return {
    client,
    requestTyped,
    refuse: (message: string) => {
      refuseNext = message
    },
    saves: () =>
      requestTyped.mock.calls
        .filter(([method]) => method === 'chatCommands.save')
        .map(([, params]) => params)
  }
}

async function render(commands: ChatCommand[] = [], listEnabled = true) {
  const backend = fakeBackend(commands, listEnabled)
  const store = createChatCommandsStore()
  store.connect(backend.client)
  await act(async () => root.render(createElement(ChatCommandsSection, { store })))
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="chat-commands-list-enabled"]')).not.toBeNull()
  )
  return { backend, store }
}

const section = () => container.querySelector<HTMLElement>('[data-testid="chat-commands-section"]')!
const dialog = () => document.querySelector<HTMLElement>('[data-testid="chat-command-dialog"]')
const field = <T extends HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`)!
const rowNames = () =>
  [...container.querySelectorAll('[data-chat-command]')].map((row) =>
    row.getAttribute('data-chat-command')
  )

async function type(testId: string, text: string): Promise<void> {
  const element = field<HTMLInputElement | HTMLTextAreaElement>(testId)
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur(testId: string): Promise<void> {
  await act(async () => field(testId).dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
}

async function save(): Promise<void> {
  await act(async () =>
    field('chat-command-save')
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  )
}

async function openAdd(): Promise<HTMLElement> {
  await click(field('chat-command-add'))
  await vi.waitFor(() => expect(dialog()).not.toBeNull())
  return dialog()!
}

describe('Chat commands section (plan 226 S3)', () => {
  it('shows the empty state with the switch, Add command… and the help sentence', async () => {
    await render([])
    expect(section().id).toBe('chat-commands')
    expect(container.querySelector('[data-testid="chat-commands-empty"]')!.textContent).toBe(
      'No commands yet.'
    )
    expect(section().textContent).toContain('Answer !commands')
    expect(section().textContent).toContain('Lists your commands in chat.')
    expect(field<HTMLButtonElement>('chat-command-add').disabled).toBe(false)
    expect(field('chat-command-add').textContent).toBe('Add command…')
    expect(section().textContent).toContain(CHAT_COMMANDS_HELP)
    expect(CHAT_COMMANDS_HELP).toBe(
      'Viewers type !name in chat. Videorc answers as you, starting with @their name, in the chat they asked in.'
    )
  })

  it('adds a command: the fixed !, a reply on one line, the preview, then the row', async () => {
    const { backend } = await render([])
    const opened = await openAdd()
    expect(opened.textContent).toContain('Add command')
    await type('chat-command-name', '!Go')
    // The `!` is already in front: the one typed is dropped.
    expect(field<HTMLInputElement>('chat-command-name').value).toBe('Go')
    await type('chat-command-description', "why I'm learning Go")
    await type('chat-command-reply', 'It compiles fast,\nships one binary.')
    expect(field<HTMLTextAreaElement>('chat-command-reply').value).toBe(
      'It compiles fast, ships one binary.'
    )
    expect(field('chat-command-preview').textContent).toBe(
      '@viewer It compiles fast, ships one binary.'
    )
    await save()
    expect(backend.saves()).toEqual([
      {
        name: 'go',
        description: "why I'm learning Go",
        reply: 'It compiles fast, ships one binary.',
        enabled: true
      }
    ])
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(rowNames()).toEqual(['go'])
    const row = container.querySelector('[data-chat-command="go"]')!
    expect(row.textContent).toContain('!go')
    expect(row.textContent).toContain("why I'm learning Go")
  })

  it('edits a command from its row, keeping its id and switch', async () => {
    const { backend } = await render([command('faq'), command('go', { enabled: false })])
    expect(rowNames()).toEqual(['faq', 'go'])
    await click(container.querySelector('[aria-label="Edit !go"]'))
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Edit !go')
    expect(field<HTMLInputElement>('chat-command-name').value).toBe('go')
    expect(field<HTMLTextAreaElement>('chat-command-reply').value).toBe('reply for go')
    await type('chat-command-reply', 'Because it is fast.')
    await save()
    expect(backend.saves()).toEqual([
      {
        id: 'id-go',
        name: 'go',
        description: 'about go',
        reply: 'Because it is fast.',
        enabled: false
      }
    ])
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('shows a field error after its first blur, never on the first keystroke', async () => {
    const { backend } = await render([command('go')])
    await openAdd()
    await type('chat-command-name', 'GO')
    expect(dialog()!.textContent).not.toContain('!go already exists.')
    await blur('chat-command-name')
    expect(dialog()!.textContent).toContain('!go already exists.')
    // Save shows every field's error and sends nothing.
    await save()
    expect(dialog()!.textContent).toContain('Add a short description.')
    expect(dialog()!.textContent).toContain('Write the reply.')
    expect(backend.saves()).toEqual([])
  })

  it('refuses the built-in name', async () => {
    const { backend } = await render([])
    await openAdd()
    await type('chat-command-name', 'Commands')
    await type('chat-command-description', 'every command')
    await type('chat-command-reply', 'Here they are.')
    await save()
    expect(dialog()!.textContent).toContain('!commands is built in.')
    expect(backend.saves()).toEqual([])
  })

  it('puts a refusal from Videorc under its field, and keeps the dialog open', async () => {
    const { backend } = await render([])
    await openAdd()
    await type('chat-command-name', 'go')
    await type('chat-command-description', 'why Go')
    await type('chat-command-reply', 'Because.')
    backend.refuse('invalid-params: !go already exists.')
    await save()
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('!go already exists.'))
    const nameField = field('chat-command-name').closest('[data-slot="field"]')!
    expect(nameField.textContent).toContain('!go already exists.')
    // Changing the name clears it.
    await type('chat-command-name', 'golang')
    expect(dialog()!.textContent).not.toContain('!go already exists.')
  })

  it('counts the room left in the reply, and says how far over it is', async () => {
    await render([])
    await openAdd()
    const room = () => field('chat-command-reply-room').textContent
    expect(room()).toBe('170 characters left')
    await type('chat-command-reply', 'x'.repeat(169))
    expect(room()).toBe('1 character left')
    await type('chat-command-reply', 'x'.repeat(175))
    expect(room()).toBe('5 characters over')
    await blur('chat-command-reply')
    expect(dialog()!.textContent).toContain('Keep the reply to 170 characters.')
    expect(chatCommandRoomLabel('🚀'.repeat(170))).toBe('0 characters left')
  })

  it('says X gets the reply in 2 posts once @viewer_name and the reply pass 140', async () => {
    await render([])
    await openAdd()
    const note = () => document.querySelector('[data-testid="chat-command-x-note"]')
    await type('chat-command-reply', 'x'.repeat(127))
    expect(note()).toBeNull()
    await type('chat-command-reply', 'x'.repeat(128))
    expect(note()!.textContent).toBe('X gets this in 2 posts.')
  })

  it('turns a command and !commands on or off from their switches', async () => {
    const { backend } = await render([command('go')])
    await click(container.querySelector('[aria-label="Answer !go"]'))
    expect(backend.saves()).toEqual([
      { id: 'id-go', name: 'go', description: 'about go', reply: 'reply for go', enabled: false }
    ])
    await vi.waitFor(() =>
      expect(
        container.querySelector('[aria-label="Answer !go"]')!.getAttribute('aria-checked')
      ).toBe('false')
    )
    await click(container.querySelector('[data-testid="chat-commands-list-enabled"]'))
    expect(backend.requestTyped).toHaveBeenLastCalledWith('chatCommands.setListEnabled', {
      enabled: false
    })
  })

  it('deletes a command only after the question, from its ⋯ menu', async () => {
    const { backend } = await render([command('go')])
    await click(container.querySelector('[aria-label="Actions for !go"]'))
    await vi.waitFor(() => expect(document.querySelector('[role=menu]')).not.toBeNull())
    const items = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')]
    expect(items.map((item) => item.textContent)).toEqual(['Edit…', 'Delete'])
    await click(items.find((item) => item.textContent === 'Delete'))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-command-delete-dialog"]')).not.toBeNull()
    )
    const question = document.querySelector('[data-testid="chat-command-delete-dialog"]')!
    expect(question.textContent).toContain('Delete !go?')
    expect(question.textContent).toContain(
      'Its reply is deleted, and viewers who type !go get no answer.'
    )
    expect(backend.requestTyped).not.toHaveBeenCalledWith('chatCommands.delete', expect.anything())
    await click(document.querySelector('[data-testid="chat-command-delete-confirm"]'))
    expect(backend.requestTyped).toHaveBeenCalledWith('chatCommands.delete', { id: 'id-go' })
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="chat-commands-empty"]')).not.toBeNull()
    )
  })

  it('says why Add command… is off', () => {
    expect(chatCommandAddBlockedReason({ offline: false, loaded: true, count: 3 })).toBeNull()
    expect(chatCommandAddBlockedReason({ offline: true, loaded: true, count: 3 })).toBe(
      'Videorc is reconnecting. Try again in a moment.'
    )
    expect(chatCommandAddBlockedReason({ offline: false, loaded: false, count: 0 })).toBe(
      'Your chat commands are still loading.'
    )
    expect(
      chatCommandAddBlockedReason({ offline: false, loaded: true, count: CHAT_COMMAND_MAX_COUNT })
    ).toBe('You can have up to 100 commands. Delete one to add another.')
  })
})
