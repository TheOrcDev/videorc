import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Plan 260 S1.3: the backend owns audio. The renderer opens a Web Audio
// context only behind the fences that wait for the Windows machines (the idle
// meter of a Windows microphone, S1.3a; the soundboard monitor, S1.3b; the
// join chime, S1.3c: on macOS and Linux the backend plays all three), and in
// the talk-show room's media until rooms move into the backend (S1.8). Each
// one that moves comes off this list.

/** The talk-show room's own media (and its dev fixture): they leave the
 * renderer with `livekit-client` in S1.8. */
const ROOM_AUDIO = [
  'lib/cloud-alpha-fixture.ts',
  'lib/room-aux-sink.ts',
  'lib/room-guest-speech.ts',
  'lib/room-microphone-source.ts',
  'lib/room-pcm-source.ts',
  'lib/room-speech-source.ts',
  'lib/room-system-audio-source.ts'
]

function rendererSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return rendererSources(path)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })
}

const sources = rendererSources(__dirname).map((path) => ({
  path: relative(__dirname, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8')
}))

describe('Web Audio in the renderer (plan 260 S1.3)', () => {
  it('creates an AudioContext only behind the Windows fences', () => {
    const creators = sources
      .filter(({ text }) => /\bnew\s+(?:webkit)?(?:Offline)?AudioContext\s*\(/.test(text))
      .map(({ path }) => path)
      .sort()
    expect(creators).toEqual(
      [
        'lib/browser-mic-visual-pipeline.ts',
        'lib/join-request-chime.ts',
        'lib/sound-monitor.ts',
        ...ROOM_AUDIO
      ].sort()
    )
  })

  it('loads the renderer monitor only where the backend does not play it', () => {
    const loaders = sources
      .filter(({ text }) => /import\(\s*['"]\.\/sound-monitor['"]\s*\)/.test(text))
      .map(({ path }) => path)
    expect(loaders).toEqual(['lib/soundboard-host.ts'])
    const host = sources.find(({ path }) => path === 'lib/soundboard-host.ts')!.text
    expect(host).toMatch(/rendererMonitor: rendererPlaysMonitor\(currentPlatform\(\)\)/)
  })

  it('keeps out the shared page context and the click that a ui:sync of the faders re-adds', () => {
    // @audiocn/core ships both with every `pnpm ui:sync fader parameter-slider`;
    // nothing in Videorc plays them. Delete them again after a sync.
    expect(existsSync(join(__dirname, 'hooks/use-audio-context.tsx'))).toBe(false)
    expect(existsSync(join(__dirname, 'lib/audio/click.ts'))).toBe(false)
  })
})
