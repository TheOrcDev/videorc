import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, Menu: {} }))

import { contextMenuTemplate, type ContextMenuFacts } from './context-menu'

const facts = (overrides: Partial<ContextMenuFacts> = {}): ContextMenuFacts => ({
  isEditable: false,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  ...overrides
})

describe('contextMenuTemplate (plan 050, D6)', () => {
  it('gives editable fields the native edit menu', () => {
    const roles = contextMenuTemplate(facts({ isEditable: true }), () => {}).map(
      (item) => item.role ?? item.type
    )
    expect(roles).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll'])
  })

  it('mirrors what the field allows', () => {
    const template = contextMenuTemplate(
      facts({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true }
      }),
      () => {}
    )
    expect(template.find((item) => item.role === 'cut')?.enabled).toBe(false)
    expect(template.find((item) => item.role === 'paste')?.enabled).toBe(true)
  })

  it('puts spelling suggestions first and replaces the word', () => {
    const replace = vi.fn()
    const template = contextMenuTemplate(
      facts({
        isEditable: true,
        misspelledWord: 'recrod',
        dictionarySuggestions: ['record', 'recrods', 'a', 'b', 'c', 'd']
      }),
      replace
    )
    expect(template.slice(0, 5).map((item) => item.label)).toEqual([
      'record',
      'recrods',
      'a',
      'b',
      'c'
    ])
    expect(template[5]?.type).toBe('separator')
    template[0]?.click?.({} as never, undefined, {} as never)
    expect(replace).toHaveBeenCalledWith('record')
  })

  it('says so when a misspelling has no guesses', () => {
    const template = contextMenuTemplate(
      facts({ isEditable: true, misspelledWord: 'zzqx' }),
      () => {}
    )
    expect(template[0]).toMatchObject({ label: 'No Guesses Found', enabled: false })
  })

  it('offers Copy for selected text and nothing for the chrome', () => {
    expect(
      contextMenuTemplate(facts({ selectionText: 'Great stream!' }), () => {}).map(
        (item) => item.role
      )
    ).toEqual(['copy'])
    expect(contextMenuTemplate(facts({ selectionText: '   ' }), () => {})).toEqual([])
    expect(contextMenuTemplate(facts(), () => {})).toEqual([])
  })
})
