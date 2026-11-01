import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  SOUND_IMPORT_EXTENSIONS,
  SOUND_PICK_LEFT_OUT_REASON,
  soundPickResult,
  isStarterSoundFileName,
  starterSoundRows,
  starterSoundRowsFor,
  starterSoundsDirectory
} from './sound-files'

describe('the starter sound folder (plan 189)', () => {
  it('reads the packaged resource, or the source tree in development', () => {
    expect(
      starterSoundsDirectory({
        packaged: true,
        resourcesPath: '/Applications/Videorc.app/Contents/Resources',
        workspaceRoot: '/Applications/Videorc.app/Contents'
      })
    ).toBe(join('/Applications/Videorc.app/Contents/Resources', 'sounds', 'starter'))
    expect(
      starterSoundsDirectory({
        packaged: false,
        resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
        workspaceRoot: '/repo'
      })
    ).toBe(resolve('/repo', 'apps/desktop/resources/sounds/starter'))
  })
})

describe('starter sound files (plan 189)', () => {
  it('accepts a bare .ogg basename and refuses paths, hops, hidden files and other types', () => {
    expect(isStarterSoundFileName('airhorn.ogg')).toBe(true)
    for (const bad of [
      '',
      '.ogg',
      '.airhorn.ogg',
      '../airhorn.ogg',
      'a/airhorn.ogg',
      'a\\airhorn.ogg',
      'air..horn.ogg',
      'air\0horn.ogg',
      'airhorn.wav',
      'airhorn.ogg.exe',
      7,
      null
    ]) {
      expect(isStarterSoundFileName(bad), String(bad)).toBe(false)
    }
  })

  it('offers each well-formed row in manifest order and says why it refused the rest', () => {
    const { rows, refused } = starterSoundRows({
      version: 1,
      sounds: [
        { slug: 'airhorn', name: 'Airhorn', hotkey: '1', file: 'airhorn.ogg', licence: 'CC0-1.0' },
        { slug: 'crickets', name: ' Crickets ', file: 'crickets.ogg' },
        { slug: 'escape', name: 'Escape', file: '../../etc/passwd.ogg' },
        { slug: 'wave', name: 'Wave', file: 'wave.wav' },
        { slug: 'Bad Slug', name: 'Bad', file: 'bad.ogg' },
        { slug: 'zero', name: 'Zero', hotkey: '0', file: 'zero.ogg' },
        { slug: 'nameless', name: '', file: 'nameless.ogg' },
        { slug: 'airhorn', name: 'Airhorn again', file: 'airhorn2.ogg' },
        // A key already taken is dropped, the sound kept.
        { slug: 'tada', name: 'Tada', hotkey: '1', file: 'tada.ogg' },
        'not a row'
      ]
    })
    expect(rows).toEqual([
      { slug: 'airhorn', name: 'Airhorn', hotkey: '1', file: 'airhorn.ogg' },
      { slug: 'crickets', name: 'Crickets', file: 'crickets.ogg' },
      { slug: 'tada', name: 'Tada', file: 'tada.ogg' }
    ])
    expect(refused).toHaveLength(7)
    expect(refused[0]).toContain('escape')
    expect(starterSoundRows({ version: 1 })).toEqual({
      rows: [],
      refused: ['The manifest has no sounds list.']
    })
    expect(starterSoundRows(null).rows).toEqual([])
  })

  it('filters to the asked slugs, keeping manifest order', () => {
    const { rows } = starterSoundRows({
      sounds: [
        { slug: 'airhorn', name: 'Airhorn', file: 'airhorn.ogg' },
        { slug: 'applause', name: 'Applause', file: 'applause.ogg' },
        { slug: 'laugh', name: 'Laugh', file: 'laugh.ogg' }
      ]
    })
    expect(
      starterSoundRowsFor(rows, ['laugh', 'airhorn', 'missing']).map((row) => row.slug)
    ).toEqual(['airhorn', 'laugh'])
    expect(starterSoundRowsFor(rows, undefined)).toHaveLength(3)
    expect(starterSoundRowsFor(rows, [])).toEqual([])
  })

  // The bundled manifest (plan 189 S1) lands on the plan branch beside this
  // code; every row of it must be offered, none refused.
  const bundledManifest = resolve(__dirname, '../../resources/sounds/starter/manifest.json')
  it.skipIf(!existsSync(bundledManifest))('offers every row of the bundled manifest', () => {
    const manifest = JSON.parse(readFileSync(bundledManifest, 'utf8')) as { sounds: unknown[] }
    const { rows, refused } = starterSoundRows(manifest)
    expect(refused).toEqual([])
    expect(rows).toHaveLength(manifest.sounds.length)
  })

  it('offers the formats the plan lists', () => {
    expect([...SOUND_IMPORT_EXTENSIONS]).toEqual([
      'wav',
      'mp3',
      'm4a',
      'aac',
      'ogg',
      'oga',
      'opus',
      'flac',
      'webm'
    ])
  })
})

describe('Import sounds… picks (release test 147, plan 0006)', () => {
  const issue = async (path: string) => {
    if (path.includes('gone'))
      throw new Error('Resource path does not exist or could not be resolved.')
    return { capabilityId: `cap:${path}`, kind: 'input-file' as const, displayName: path }
  }

  it('names a file it could not hand over instead of dropping it', async () => {
    const logged: string[] = []
    const result = await soundPickResult(
      ['/home/me/ok.wav', '/home/me/gone missing.wav'],
      issue,
      (path) => logged.push(path)
    )
    expect(result.selections.map((selection) => selection.capabilityId)).toEqual([
      'cap:/home/me/ok.wav'
    ])
    expect(result.leftOut).toEqual([
      { displayName: 'gone missing.wav', reason: SOUND_PICK_LEFT_OUT_REASON }
    ])
    expect(logged).toEqual(['/home/me/gone missing.wav'])
    // Never a path or the backend's own wording in what the renderer gets.
    expect(JSON.stringify(result.leftOut)).not.toContain('/home/me')
  })

  it('takes at most a full board of files', async () => {
    const paths = Array.from({ length: 30 }, (_, index) => `/s/${index}.wav`)
    const result = await soundPickResult(paths, issue)
    expect(result.selections).toHaveLength(24)
    expect(result.leftOut).toEqual([])
  })
})
