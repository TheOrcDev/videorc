import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_DEVICE,
  findAudioDeviceIndex,
  parseAudioToolboxDevices,
  playPhrase,
  renderPhrase,
  speechStartDelay
} from './speech.mjs'

const DEVICE_LIST = `Input #0, lavfi, from 'anullsrc=r=48000:cl=stereo':
[AudioToolbox @ 0x8d0c440c0] CoreAudio devices:
[AudioToolbox @ 0x8d0c440c0] [0]         MacBook Pro Microphone, BuiltInMicrophoneDevice
[AudioToolbox @ 0x8d0c440c0] [1]           MacBook Pro Speakers, BuiltInSpeakerDevice
[AudioToolbox @ 0x8d0c440c0] [2]                BlackHole 2ch, BlackHole2ch_UID
[AudioToolbox @ 0x8d0c440c0] [3]       Studio Display, Speakers, AppleUSBAudioEngine:1
[audiotoolbox @ 0x8d0c1c280] Error: AudioObjecTGetPropertyData UID (560947818)
`

function fakeRunner(responses = {}) {
  const calls = []
  const runner = async (command, args) => {
    calls.push({ command, args })
    if (args.includes('-list_devices')) return { code: 1, stdout: '', stderr: DEVICE_LIST }
    return responses[command] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

test('renderPhrase runs say -o with the text after --', async () => {
  const { runner, calls } = fakeRunner()
  const result = await renderPhrase('-r Buddy, show the last comment', '/tmp/p.aiff', {
    platform: 'darwin',
    runner,
    voice: 'Samantha',
    rate: 180
  })
  assert.deepEqual(result, { file: '/tmp/p.aiff', text: '-r Buddy, show the last comment' })
  assert.deepEqual(calls, [
    {
      command: 'say',
      args: [
        '-o',
        '/tmp/p.aiff',
        '-v',
        'Samantha',
        '-r',
        '180',
        '--',
        '-r Buddy, show the last comment'
      ]
    }
  ])
})

test('renderPhrase surfaces a say failure and refuses empty text', async () => {
  const { runner } = fakeRunner({ say: { code: 1, stdout: '', stderr: 'Voice not found' } })
  await assert.rejects(
    renderPhrase('hello', '/tmp/x.aiff', { platform: 'darwin', runner }),
    /say exited 1: Voice not found/
  )
  await assert.rejects(renderPhrase('  ', '/tmp/x.aiff', { platform: 'darwin', runner }), /empty/)
})

test('parses the AudioToolbox device list, names with commas included', () => {
  assert.deepEqual(parseAudioToolboxDevices(DEVICE_LIST), [
    { index: 0, name: 'MacBook Pro Microphone', uid: 'BuiltInMicrophoneDevice' },
    { index: 1, name: 'MacBook Pro Speakers', uid: 'BuiltInSpeakerDevice' },
    { index: 2, name: 'BlackHole 2ch', uid: 'BlackHole2ch_UID' },
    { index: 3, name: 'Studio Display, Speakers', uid: 'AppleUSBAudioEngine:1' }
  ])
})

test('finds the BlackHole index and explains a missing device', async () => {
  const { runner, calls } = fakeRunner()
  assert.equal(await findAudioDeviceIndex(DEFAULT_DEVICE, { runner }), 2)
  assert.equal(calls[0].command, 'ffmpeg')
  assert.ok(calls[0].args.includes('audiotoolbox'))
  await assert.rejects(
    findAudioDeviceIndex('BlackHole 16ch', { runner }),
    /not found .*BlackHole 2ch.*brew install blackhole-2ch/
  )
})

test('playPhrase plays to the device index in real time and logs the play', async () => {
  const { runner, calls } = fakeRunner()
  const times = [new Date('2026-10-12T10:00:00.000Z'), new Date('2026-10-12T10:00:02.100Z')]
  const logged = []
  const record = await playPhrase({
    platform: 'darwin',
    file: '/srv/lab/runs/x/phrases/highlight-last.aiff',
    phraseId: 'highlight-last',
    text: 'Buddy, show the last comment',
    runner,
    now: () => times.shift(),
    log: (entry) => logged.push(entry)
  })
  assert.deepEqual(record, {
    phraseId: 'highlight-last',
    text: 'Buddy, show the last comment',
    playedAt: '2026-10-12T10:00:00.000Z',
    endedAt: '2026-10-12T10:00:02.100Z',
    device: 'BlackHole 2ch'
  })
  assert.deepEqual(logged, [record])
  assert.doesNotMatch(JSON.stringify(record), /runs\/|\.aiff/)
  const play = calls[1]
  assert.equal(play.command, 'ffmpeg')
  assert.ok(play.args.includes('-re'))
  assert.equal(play.args[play.args.indexOf('-audio_device_index') + 1], '2')
  assert.equal(play.args[play.args.indexOf('-f') + 1], 'audiotoolbox')
})

test('playPhrase appends NDJSON to a log file and skips the lookup with deviceIndex', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-speech-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const logPath = join(dir, 'speech.ndjson')
  const { runner, calls } = fakeRunner()
  await playPhrase({
    platform: 'darwin',
    file: 'a.aiff',
    phraseId: 'a',
    text: 'one',
    deviceIndex: 5,
    runner,
    log: logPath
  })
  await playPhrase({
    platform: 'darwin',
    file: 'b.aiff',
    phraseId: 'b',
    text: 'two',
    deviceIndex: 5,
    runner,
    log: logPath
  })
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => !call.args.includes('-list_devices')))
  const lines = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    lines.map((line) => line.phraseId),
    ['a', 'b']
  )
})

test('playPhrase fails loudly when playback fails', async () => {
  const { runner } = fakeRunner({
    ffmpeg: { code: 1, stdout: '', stderr: 'Could not write header' }
  })
  await assert.rejects(
    playPhrase({ platform: 'darwin', file: 'a.aiff', deviceIndex: 2, runner }),
    /ffmpeg playback exited 1: Could not write header/
  )
  await assert.rejects(playPhrase({ platform: 'darwin', runner }), /rendered file/)
})

test('speech is scheduled clear of the 10 s sync pulses', () => {
  assert.equal(speechStartDelay(1_002_000, 3000), 0)
  assert.equal(speechStartDelay(1_000_200, 3000), 800)
  assert.equal(speechStartDelay(1_006_500, 3000), 4500)
  assert.equal(speechStartDelay(1_009_900, 3000), 1100)
  for (let now = 0; now < 20_000; now += 137) {
    const start = now + speechStartDelay(now, 2500)
    const end = start + 2500
    const phaseStart = start % 10_000
    assert.ok(phaseStart >= 1000, `start ${start}`)
    assert.ok(Math.floor(start / 10_000) === Math.floor((end + 1000 - 1) / 10_000), `end ${end}`)
  }
  assert.throws(() => speechStartDelay(0, 8500), /cannot fit/)
})
