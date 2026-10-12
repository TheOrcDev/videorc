import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { isLinux } from './platform.mjs'
import {
  assertPulseSink,
  defaultSpeechDevice,
  findAudioDeviceIndex,
  loadPhrases,
  playPhrase,
  renderPhrase,
  speechFileExtension,
  speechStartDelay
} from './speech.mjs'

// Plan 178 U9. ctx.speech for scenarios: plays a phrase from phrases.json
// (or ad-hoc text) into BlackHole through U7's rig, rendered once per run,
// timed between the card's sync pulses, logged to speech.ndjson.

export function createSpeechRig({
  runDir,
  platform = process.platform,
  device = defaultSpeechDevice(platform),
  ffmpegPath = process.env.VIDEORC_LIVE_LAB_FFMPEG ?? 'ffmpeg',
  runner,
  now = () => Date.now(),
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
  log = () => {}
}) {
  const rendered = new Map()
  let phrases = null
  let deviceIndex = null
  const logPath = join(runDir, 'speech.ndjson')

  async function catalogue() {
    phrases ??= await loadPhrases()
    return phrases
  }

  async function find(phraseId) {
    const all = await catalogue()
    return (
      all.commands.find((entry) => entry.id === phraseId) ??
      all.captions.find((entry) => entry.id === phraseId) ??
      null
    )
  }

  async function render(id, text) {
    if (rendered.has(id)) return rendered.get(id)
    await mkdir(join(runDir, 'speech'), { recursive: true })
    const file = join(runDir, 'speech', `${id}.${speechFileExtension(platform)}`)
    await renderPhrase(text, file, runner ? { runner, platform } : { platform })
    rendered.set(id, file)
    return file
  }

  /**
   * Plays a phrase. `phraseId` names a phrases.json entry; `{ text }` plays
   * ad-hoc text (never from chat, never a secret). Resolves with the speech
   * log record ({ phraseId, text, playedAt, endedAt }).
   */
  async function play(phraseId, { text = null, durationMs = 4000 } = {}) {
    const entry = text ? { id: phraseId ?? 'adhoc', text } : await find(phraseId)
    if (!entry) throw new Error(`unknown phrase "${phraseId}"`)
    const file = await render(entry.id, entry.text)
    if (deviceIndex === null) {
      deviceIndex = isLinux(platform)
        ? await assertPulseSink(device, runner ? { runner, ffmpegPath } : { ffmpegPath })
        : await findAudioDeviceIndex(device, runner ? { runner, ffmpegPath } : { ffmpegPath })
    }
    const delay = speechStartDelay(now(), durationMs)
    if (delay > 0) await wait(delay)
    const record = await playPhrase({
      file,
      device,
      deviceIndex,
      phraseId: entry.id,
      text: entry.text,
      ffmpegPath,
      platform,
      ...(runner ? { runner } : {}),
      log: logPath
    })
    log(`Speech: played ${entry.id}.`)
    return record
  }

  return { play, find, catalogue }
}
