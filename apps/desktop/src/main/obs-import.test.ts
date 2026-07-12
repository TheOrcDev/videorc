import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import {
  discoverObs,
  parseIni,
  parseObsFps,
  parseSceneCollection,
  parseService,
  readObsSetup,
  readObsStreamKey
} from './obs-import'

const FIXTURES = join(__dirname, 'obs-fixtures')
const collectionJson = readFileSync(join(FIXTURES, 'collection.json'), 'utf8')
const basicIni = readFileSync(join(FIXTURES, 'basic.ini'), 'utf8')
const serviceJson = readFileSync(join(FIXTURES, 'service.json'), 'utf8')

// O1 (OBS import plan): the reader is pure and fixture-driven. The fixture is
// a SCRUBBED copy of a real OBS collection (multi-scene, multi-camera) — the
// realistic case, not a toy.
describe('obs ini + fps parsing', () => {
  it('parses sections and tolerates comments/blank lines', () => {
    const ini = parseIni('# c\n[Video]\nBaseCX=3840\n\n;x\n[Output]\nMode=Simple\n')
    expect(ini.Video.BaseCX).toBe('3840')
    expect(ini.Output.Mode).toBe('Simple')
  })

  it('maps OBS fps encodings to container integers', () => {
    expect(parseObsFps({ FPSType: '0', FPSCommon: '24 NTSC' })).toBe(24)
    expect(parseObsFps({ FPSType: '0', FPSCommon: '29.97' })).toBe(30)
    expect(parseObsFps({ FPSType: '0', FPSCommon: '60' })).toBe(60)
    expect(parseObsFps({ FPSType: '1', FPSInt: '48' })).toBe(48)
    expect(parseObsFps({ FPSType: '2', FPSNum: '30000', FPSDen: '1001' })).toBe(30)
    expect(parseObsFps({})).toBe(30)
  })
})

describe('scene collection parsing', () => {
  const parsed = parseSceneCollection(collectionJson)

  it('classifies the real fixture sources into Videorc-facing kinds', () => {
    const kinds = new Set(parsed.sources.map((source) => source.kind))
    expect(kinds.has('camera')).toBe(true)
    expect(kinds.has('microphone')).toBe(true)
    // The mac ScreenCaptureKit source appears as display OR window/application
    expect(kinds.has('display') || kinds.has('application') || kinds.has('window')).toBe(true)
    // scene/group pseudo-sources never leak into the source list
    expect(parsed.sources.some((source) => source.obsKind === 'scene')).toBe(false)
  })

  it('keeps camera device names for matching', () => {
    const camera = parsed.sources.find((source) => source.kind === 'camera')
    expect(camera?.deviceName).toBeTruthy()
  })

  it('extracts scenes with items, transforms, and the current flag', () => {
    expect(parsed.scenes.length).toBeGreaterThan(1)
    expect(parsed.scenes.filter((scene) => scene.current)).toHaveLength(1)
    const withItems = parsed.scenes.find((scene) => scene.items.length > 0)
    expect(withItems).toBeTruthy()
    const item = withItems!.items[0]
    expect(item.sourceName).toBeTruthy()
    expect(typeof item.x).toBe('number')
    expect(typeof item.scaleX).toBe('number')
  })
})

describe('service parsing', () => {
  it('reads rtmp_common with a key without exposing it beyond the field', () => {
    const service = parseService(serviceJson)
    expect(service).toMatchObject({ type: 'rtmp_common', hasKey: true })
    expect(service?.service).toContain('YouTube')
  })

  it('returns undefined for unknown service types or bad json', () => {
    expect(parseService('{"type":"whip_custom","settings":{}}')).toBeUndefined()
    expect(parseService('not json')).toBeUndefined()
  })
})

describe('filesystem discovery + full read', () => {
  function fakeObsRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'videorc-obs-fixture-'))
    mkdirSync(join(root, 'basic', 'scenes'), { recursive: true })
    mkdirSync(join(root, 'basic', 'profiles', 'Fixture Profile'), { recursive: true })
    writeFileSync(join(root, 'basic', 'scenes', 'Fixture Collection.json'), collectionJson)
    writeFileSync(join(root, 'basic', 'profiles', 'Fixture Profile', 'basic.ini'), basicIni)
    writeFileSync(join(root, 'basic', 'profiles', 'Fixture Profile', 'service.json'), serviceJson)
    writeFileSync(
      join(root, 'global.ini'),
      '[Basic]\nSceneCollection=Fixture Collection\nProfile=Fixture Profile\n'
    )
    return root
  }

  it('discovers collections, profiles, and currents', () => {
    const discovery = discoverObs(fakeObsRoot())
    expect(discovery).toMatchObject({
      available: true,
      currentCollection: 'Fixture Collection',
      currentProfile: 'Fixture Profile'
    })
  })

  it('reports unavailable for a machine without OBS', () => {
    expect(discoverObs(join(tmpdir(), 'videorc-no-obs-here'))).toMatchObject({ available: false })
  })

  it('reads the full setup WITHOUT the stream key; the key comes separately', () => {
    const root = fakeObsRoot()
    const setup = readObsSetup('Fixture Collection', 'Fixture Profile', root)
    expect(setup).toMatchObject({
      canvasWidth: 3840,
      outputHeight: 2160,
      fps: 24,
      recordingPath: '/Users/orcdev/Movies'
    })
    expect(setup?.service).toMatchObject({ type: 'rtmp_common', hasKey: true })
    expect(JSON.stringify(setup)).not.toContain('fixture-not-a-real-key')
    expect(readObsStreamKey('Fixture Profile', root)).toBe('fixture-not-a-real-key')
  })

  it('falls back to the .bak twin when the primary is missing', () => {
    const root = fakeObsRoot()
    const scenes = join(root, 'basic', 'scenes')
    writeFileSync(join(scenes, 'BakOnly.json.bak'), collectionJson)
    const setup = readObsSetup('BakOnly', 'Fixture Profile', root)
    expect(setup?.scenes.length).toBeGreaterThan(0)
  })

  it('requires exact discovered collection and profile identifiers', () => {
    const root = fakeObsRoot()
    expect(readObsSetup('../Fixture Collection', 'Fixture Profile', root)).toBeNull()
    expect(readObsSetup('Fixture Collection', '../Fixture Profile', root)).toBeNull()
    expect(readObsSetup('Fixture Collection.json', 'Fixture Profile', root)).toBeNull()
    expect(readObsStreamKey('../Fixture Profile', root)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'does not discover or follow symlinked collection/profile entries',
    () => {
      const root = fakeObsRoot()
      const outside = mkdtempSync(join(tmpdir(), 'videorc-obs-outside-'))
      const outsideCollection = join(outside, 'outside.json')
      const outsideProfile = join(outside, 'outside-profile')
      writeFileSync(outsideCollection, collectionJson)
      mkdirSync(outsideProfile)
      writeFileSync(join(outsideProfile, 'basic.ini'), basicIni)
      writeFileSync(join(outsideProfile, 'service.json'), serviceJson)
      symlinkSync(outsideCollection, join(root, 'basic', 'scenes', 'Linked.json'))
      symlinkSync(outsideProfile, join(root, 'basic', 'profiles', 'Linked Profile'))

      const discovery = discoverObs(root)
      expect(discovery.collections).not.toContain('Linked')
      expect(discovery.profiles).not.toContain('Linked Profile')
      expect(readObsSetup('Linked', 'Fixture Profile', root)).toBeNull()
      expect(readObsStreamKey('Linked Profile', root)).toBeNull()

      // Revalidation at read time also rejects a once-valid entry that was
      // replaced by a symlink after the first discovery pass.
      const fixturePath = join(root, 'basic', 'scenes', 'Fixture Collection.json')
      unlinkSync(fixturePath)
      symlinkSync(outsideCollection, fixturePath)
      expect(readObsSetup('Fixture Collection', 'Fixture Profile', root)).toBeNull()
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'does not discover Windows profile junctions that escape the OBS root',
    () => {
      const root = fakeObsRoot()
      const outsideProfile = mkdtempSync(join(tmpdir(), 'videorc-obs-junction-profile-'))
      writeFileSync(join(outsideProfile, 'basic.ini'), basicIni)
      writeFileSync(join(outsideProfile, 'service.json'), serviceJson)
      symlinkSync(outsideProfile, join(root, 'basic', 'profiles', 'Linked Profile'), 'junction')

      expect(discoverObs(root).profiles).not.toContain('Linked Profile')
      expect(readObsStreamKey('Linked Profile', root)).toBeNull()
    }
  )
})
