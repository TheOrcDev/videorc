import { readFileSync, renameSync } from 'node:fs'

import type { NotesDocument, NotesFontScale } from '../shared/backend'
import { writePrivateFileAtomically } from './secure-persistence-codec'

// The detached Notes window keeps its text, text size and window prefs in one
// JSON file (notes-window.json). QA F9: a failed read used to look like an
// empty file and a failed write like a save, so a disk error could report
// unsaved text as Saved, or write a blank document over the notes. Here a read
// either returns what is on disk or throws, a write lands whole (temp file,
// fsync, rename) or throws, and nothing is ever merged into a file that could
// not be read.

export type NotesWindowPrefs = {
  frame?: Electron.Rectangle
  alwaysOnTop?: boolean
  alwaysOnTopPreferenceVersion?: number
  open?: boolean
  text?: string
  fontScale?: NotesFontScale
}

export type NotesPersistenceFs = {
  readFile: (path: string) => string
  /** Replaces the file only once the new contents are durable. */
  writeFileAtomically: (path: string, contents: string) => void
  rename: (from: string, to: string) => void
}

export type NotesPersistenceOptions = {
  path: () => string
  /** False in smoke runs and with the Notes window off: nothing is written. */
  writesEnabled: () => boolean
  fs?: Partial<NotesPersistenceFs>
  now?: () => Date
  warn?: (message: string, error?: unknown) => void
}

export type NotesPersistence = {
  /** What is on disk; a missing file is empty. Throws when the file can't be read. */
  readPrefs: () => NotesWindowPrefs
  /** Window frame and open state only: never throws, never used to write. */
  readPrefsForWindow: () => NotesWindowPrefs
  /** Merges into the file on disk. Throws on a failed read or write. */
  writePrefs: (patch: NotesWindowPrefs) => void
  /** The saved document. Throws when the file can't be read. */
  loadDocument: () => NotesDocument
  /** Saves text and/or size and returns what is now on disk. Throws on failure. */
  saveDocument: (patch: Partial<NotesDocument>) => NotesDocument
}

export class NotesPersistenceError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'NotesPersistenceError'
  }
}

export function isNotesFontScale(value: unknown): value is NotesFontScale {
  return value === 'sm' || value === 'md' || value === 'lg'
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createNotesPersistence(options: NotesPersistenceOptions): NotesPersistence {
  const fs: NotesPersistenceFs = {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFileAtomically: (path, contents) => writePrivateFileAtomically(path, contents),
    rename: (from, to) => renameSync(from, to),
    ...options.fs
  }
  const now = options.now ?? (() => new Date())

  function readPrefs(): NotesWindowPrefs {
    const path = options.path()
    let raw: string
    try {
      raw = fs.readFile(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return {}
      }
      throw new NotesPersistenceError("Couldn't read your notes.", errorCode(error), {
        cause: error
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (isPlainObject(parsed)) {
      return parsed as NotesWindowPrefs
    }
    // A file that isn't a prefs object (a torn write from before writes were
    // atomic) is kept beside the new one, never written over.
    const aside = `${path}.unreadable-${now().getTime()}`
    try {
      fs.rename(path, aside)
    } catch (error) {
      throw new NotesPersistenceError("Couldn't read your notes.", errorCode(error), {
        cause: error
      })
    }
    options.warn?.(`Notes file was unreadable; kept it as ${aside}.`)
    return {}
  }

  function readPrefsForWindow(): NotesWindowPrefs {
    try {
      return readPrefs()
    } catch (error) {
      options.warn?.('Notes window prefs could not be read:', error)
      return {}
    }
  }

  function writePrefs(patch: NotesWindowPrefs): void {
    if (!options.writesEnabled()) {
      return
    }
    const next = { ...readPrefs(), ...patch }
    try {
      fs.writeFileAtomically(options.path(), JSON.stringify(next))
    } catch (error) {
      throw new NotesPersistenceError("Couldn't save your notes.", errorCode(error), {
        cause: error
      })
    }
  }

  function documentFrom(prefs: NotesWindowPrefs): NotesDocument {
    return {
      text: typeof prefs.text === 'string' ? prefs.text : '',
      fontScale: isNotesFontScale(prefs.fontScale) ? prefs.fontScale : 'md',
      updatedAt: now().toISOString()
    }
  }

  function loadDocument(): NotesDocument {
    return documentFrom(readPrefs())
  }

  function saveDocument(patch: Partial<NotesDocument>): NotesDocument {
    const hasText = typeof patch.text === 'string'
    const hasFontScale = isNotesFontScale(patch.fontScale)
    const current = loadDocument()
    if (!hasText && !hasFontScale) {
      // Nothing to change (the window's close acknowledgement while its
      // document never loaded): the file stays as it is.
      return current
    }
    const next: NotesDocument = {
      text: hasText ? (patch.text as string) : current.text,
      fontScale: hasFontScale ? (patch.fontScale as NotesFontScale) : current.fontScale,
      updatedAt: now().toISOString()
    }
    writePrefs({ text: next.text, fontScale: next.fontScale })
    return next
  }

  return { readPrefs, readPrefsForWindow, writePrefs, loadDocument, saveDocument }
}
