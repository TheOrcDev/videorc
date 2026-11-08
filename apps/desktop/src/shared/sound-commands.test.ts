import { describe, expect, it } from 'vitest'

import {
  NO_SOUNDS_YET,
  SOUND_COMMAND_USAGE,
  classifySoundCommand,
  matchSoundName,
  playingSoundIds,
  pressStops,
  soundCompletions,
  soundboardSummary,
  type SoundSummary
} from './sound-commands'

// Plan 189 S9: the live controls see a sound as id, name and mode, and
// `/sound <name>` picks the first sound in board order the way the plan says.

const airhorn: SoundSummary = { id: 'airhorn', name: 'Airhorn', mode: 'oneShot' }
const applause: SoundSummary = { id: 'applause', name: 'Applause', mode: 'toggle' }
const crickets: SoundSummary = { id: 'crickets', name: 'Crickets', mode: 'loop' }
const sounds = [airhorn, applause, crickets]

describe('soundboardSummary', () => {
  it('projects id, name and mode, and what plays, without anything else the board carries', () => {
    const board = soundboardSummary(
      [
        { ...airhorn, file: 'airhorn.wav', levelDb: -2.7 } as SoundSummary,
        { ...applause, starter: 'applause' } as SoundSummary
      ],
      [
        {
          voiceId: 'v-1',
          soundId: 'airhorn',
          startedAtMs: 10,
          durationMs: 1610,
          loop: false,
          onAir: true
        } as never
      ]
    )
    expect(board).toEqual({
      sounds: [airhorn, applause],
      voices: [{ soundId: 'airhorn', startedAtMs: 10, durationMs: 1610, loop: false }]
    })
  })

  it('leaves out a sound waiting for its Undo, and its voices', () => {
    const board = soundboardSummary(
      sounds,
      [{ soundId: 'applause', startedAtMs: 1, durationMs: 2, loop: false }],
      new Set(['applause'])
    )
    expect(board.sounds.map((sound) => sound.id)).toEqual(['airhorn', 'crickets'])
    expect(board.voices).toEqual([])
  })
})

describe('pressStops', () => {
  it('stops only a playing Play/stop or Loop sound, as the pad does', () => {
    expect(pressStops('toggle', true)).toBe(true)
    expect(pressStops('loop', true)).toBe(true)
    expect(pressStops('oneShot', true)).toBe(false)
    expect(pressStops('hold', true)).toBe(false)
    expect(pressStops('toggle', false)).toBe(false)
  })
})

describe('matchSoundName', () => {
  it('takes the first sound in board order whose name starts with the words, any case', () => {
    expect(matchSoundName('AIR', sounds)).toBe(airhorn)
    expect(matchSoundName('  a ', sounds)).toBe(airhorn)
    expect(matchSoundName('app', sounds)).toBe(applause)
    expect(matchSoundName('horn', sounds)).toBeNull()
    expect(matchSoundName('   ', sounds)).toBeNull()
  })
})

describe('classifySoundCommand', () => {
  it('presses the named sound: the backend applies its mode', () => {
    expect(classifySoundCommand('airhorn', sounds)).toEqual({
      kind: 'sound',
      action: { action: 'press', id: 'airhorn' }
    })
    expect(classifySoundCommand('Cri', sounds)).toEqual({
      kind: 'sound',
      action: { action: 'press', id: 'crickets' }
    })
  })

  it('reserves "stop" for stopping them all, even with a sound named Stop', () => {
    expect(classifySoundCommand(' STOP ', sounds)).toEqual({
      kind: 'sound',
      action: { action: 'stopAll' }
    })
    expect(classifySoundCommand('stop', [{ id: 'stop', name: 'Stop', mode: 'oneShot' }])).toEqual({
      kind: 'sound',
      action: { action: 'stopAll' }
    })
  })

  it('says why not in the composer: no sounds, no name, an unknown name', () => {
    expect(classifySoundCommand('airhorn', [])).toEqual({ kind: 'error', message: NO_SOUNDS_YET })
    expect(classifySoundCommand('  ', sounds)).toEqual({
      kind: 'error',
      message: SOUND_COMMAND_USAGE
    })
    expect(classifySoundCommand('gong', sounds)).toEqual({
      kind: 'error',
      message: 'No sound called “gong”.'
    })
  })
})

describe('soundCompletions', () => {
  const board = {
    sounds,
    voices: [{ soundId: 'applause', startedAtMs: 1, durationMs: 2, loop: false }]
  }

  it('lists the sounds the draft starts, with what Enter does, then Stop all sounds', () => {
    expect(soundCompletions('/sound ', board)).toEqual([
      { value: '/sound Airhorn', hint: ' · Play' },
      // Playing Play/stop: a press stops it.
      { value: '/sound Applause', hint: ' · Stop' },
      { value: '/sound Crickets', hint: ' · Play' },
      { value: '/sound stop', hint: ' · Stop all sounds' }
    ])
    expect(soundCompletions('/SOUND a', board)?.map((entry) => entry.value)).toEqual([
      '/sound Airhorn',
      '/sound Applause'
    ])
    expect(soundCompletions('/sound st', board)).toEqual([
      { value: '/sound stop', hint: ' · Stop all sounds' }
    ])
  })

  it('is null for any other draft and empty with no sounds', () => {
    expect(soundCompletions('/banner logo', board)).toBeNull()
    expect(soundCompletions('hello', board)).toBeNull()
    expect(soundCompletions('/sound', { sounds: [], voices: [] })).toEqual([])
  })
})

describe('playingSoundIds', () => {
  it('collects the sound of every voice', () => {
    expect(playingSoundIds([{ soundId: 'a' }, { soundId: 'b' }, { soundId: 'a' }])).toEqual(
      new Set(['a', 'b'])
    )
  })
})
