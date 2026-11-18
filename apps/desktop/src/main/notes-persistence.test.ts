import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createNotesPersistence, NotesPersistenceError } from './notes-persistence'

// QA F9: a failed write reported unsaved text as Saved, and a failed first
// read looked like empty notes, so the close flush wrote a blank document
// over the saved one.

const PATH = '/isolated/notes-window.json'
const fsError = (code: string): Error => Object.assign(new Error(code), { code })

function memoryDisk(initial: Record<string, unknown> | string | null) {
  const files = new Map<string, string>()
  if (initial !== null) {
    files.set(PATH, typeof initial === 'string' ? initial : JSON.stringify(initial))
  }
  const faults = { read: [] as string[], write: [] as string[] }
  const persistence = createNotesPersistence({
    path: () => PATH,
    writesEnabled: () => true,
    now: () => new Date('2026-11-18T10:00:00Z'),
    fs: {
      readFile: (path) => {
        const fault = faults.read.shift()
        if (fault) throw fsError(fault)
        const contents = files.get(path)
        if (contents === undefined) throw fsError('ENOENT')
        return contents
      },
      writeFileAtomically: (path, contents) => {
        const fault = faults.write.shift()
        if (fault) throw fsError(fault)
        files.set(path, contents)
      },
      rename: (from, to) => {
        const contents = files.get(from)
        if (contents === undefined) throw fsError('ENOENT')
        files.set(to, contents)
        files.delete(from)
      }
    }
  })
  const durable = () => JSON.parse(files.get(PATH) ?? '{}')
  return { persistence, faults, files, durable }
}

describe('Notes persistence', () => {
  it('saves and loads notes, keeping the window prefs beside them', () => {
    const disk = memoryDisk({ text: 'Old', fontScale: 'md', open: true, alwaysOnTop: true })
    const saved = disk.persistence.saveDocument({ text: 'New notes', fontScale: 'lg' })
    expect(saved).toEqual({
      text: 'New notes',
      fontScale: 'lg',
      updatedAt: '2026-11-18T10:00:00.000Z'
    })
    expect(disk.durable()).toEqual({
      text: 'New notes',
      fontScale: 'lg',
      open: true,
      alwaysOnTop: true
    })
    expect(disk.persistence.loadDocument()).toMatchObject({ text: 'New notes', fontScale: 'lg' })
  })

  it('reads a missing file as empty notes', () => {
    const disk = memoryDisk(null)
    expect(disk.persistence.loadDocument()).toMatchObject({ text: '', fontScale: 'md' })
    disk.persistence.saveDocument({ text: 'First' })
    expect(disk.durable()).toEqual({ text: 'First', fontScale: 'md' })
  })

  it('throws a failed write instead of returning the unsaved text', () => {
    const disk = memoryDisk({ text: 'Existing notes', fontScale: 'md' })
    disk.faults.write.push('ENOSPC')
    let error: unknown
    try {
      disk.persistence.saveDocument({ text: 'New irreplaceable notes' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(NotesPersistenceError)
    expect((error as NotesPersistenceError).code).toBe('ENOSPC')
    expect(disk.durable().text).toBe('Existing notes')
  })

  it('throws a failed read, and never writes over notes it could not read', () => {
    const disk = memoryDisk({ text: 'Existing irreplaceable notes', fontScale: 'lg' })
    disk.faults.read.push('EIO')
    expect(() => disk.persistence.loadDocument()).toThrow(NotesPersistenceError)
    // Reads recover: the next load sees the notes, untouched.
    expect(disk.persistence.loadDocument()).toMatchObject({
      text: 'Existing irreplaceable notes',
      fontScale: 'lg'
    })
    // A window pref or a save merged over an unreadable file fails whole.
    disk.faults.read.push('EIO')
    expect(() => disk.persistence.writePrefs({ open: true })).toThrow(NotesPersistenceError)
    disk.faults.read.push('EIO')
    expect(() => disk.persistence.saveDocument({ fontScale: 'sm' })).toThrow(NotesPersistenceError)
    expect(disk.durable()).toEqual({ text: 'Existing irreplaceable notes', fontScale: 'lg' })
  })

  it('treats an empty patch as an acknowledgement and writes nothing', () => {
    const disk = memoryDisk({ text: 'Existing', fontScale: 'sm' })
    disk.faults.write.push('ENOSPC')
    expect(disk.persistence.saveDocument({})).toMatchObject({ text: 'Existing', fontScale: 'sm' })
    expect(disk.faults.write).toEqual(['ENOSPC'])
  })

  it('keeps an unreadable file aside instead of writing over it', () => {
    const disk = memoryDisk('{"text":"half a wri')
    expect(disk.persistence.loadDocument()).toMatchObject({ text: '' })
    const aside = `${PATH}.unreadable-${new Date('2026-11-18T10:00:00Z').getTime()}`
    expect(disk.files.get(aside)).toBe('{"text":"half a wri')
    expect(disk.files.has(PATH)).toBe(false)
  })

  it('writes nothing when writes are off (smoke runs, Notes disabled)', () => {
    const files: string[] = []
    const persistence = createNotesPersistence({
      path: () => PATH,
      writesEnabled: () => false,
      fs: {
        readFile: () => '{}',
        writeFileAtomically: (path) => void files.push(path),
        rename: () => undefined
      }
    })
    persistence.writePrefs({ open: true })
    expect(persistence.saveDocument({ text: 'Smoke' })).toMatchObject({ text: 'Smoke' })
    expect(files).toEqual([])
  })

  describe('on disk', () => {
    let dir: string | null = null
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = null
    })

    it('replaces the file whole and leaves no temp file', () => {
      dir = mkdtempSync(join(tmpdir(), 'videorc-notes-'))
      const path = join(dir, 'notes-window.json')
      writeFileSync(path, JSON.stringify({ text: 'Before', open: true }))
      const persistence = createNotesPersistence({ path: () => path, writesEnabled: () => true })
      persistence.saveDocument({ text: 'After' })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        text: 'After',
        fontScale: 'md',
        open: true
      })
      expect(readdirSync(dir)).toEqual(['notes-window.json'])
    })
  })
})
