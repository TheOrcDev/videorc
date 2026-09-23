// The native edit menu (plan 050, D6): right-clicking an editable field gets
// the macOS Cut / Copy / Paste / Select All menu, with spelling suggestions
// first; selected text gets Copy. Everything else gets no menu at all.
//
// Installed on the main, Chat, and Captions windows only. Notes stays
// without one: its window is capture-protected, but a popup menu is a
// separate window that would appear on stream.

import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'

export interface ContextMenuFacts {
  isEditable: boolean
  selectionText: string
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

const MAX_SUGGESTIONS = 5

export function contextMenuTemplate(
  facts: ContextMenuFacts,
  replaceMisspelling: (word: string) => void
): MenuItemConstructorOptions[] {
  if (facts.isEditable) {
    const template: MenuItemConstructorOptions[] = []
    if (facts.misspelledWord) {
      const suggestions = facts.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
      template.push(
        ...(suggestions.length
          ? suggestions.map(
              (word): MenuItemConstructorOptions => ({
                label: word,
                click: () => replaceMisspelling(word)
              })
            )
          : [{ label: 'No Guesses Found', enabled: false }]),
        { type: 'separator' }
      )
    }
    template.push(
      { role: 'cut', enabled: facts.editFlags.canCut },
      { role: 'copy', enabled: facts.editFlags.canCopy },
      { role: 'paste', enabled: facts.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: facts.editFlags.canSelectAll }
    )
    return template
  }
  if (facts.selectionText.trim()) {
    return [{ role: 'copy', enabled: facts.editFlags.canCopy }]
  }
  return []
}

export function installContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, (word) => webContents.replaceMisspelling(word))
    if (template.length === 0) {
      return
    }
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(webContents) ?? undefined
    })
  })
}
