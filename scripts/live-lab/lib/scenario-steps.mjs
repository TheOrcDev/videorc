import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { YOUTUBE_4K_STREAM_GATES } from '../../lib/youtube-4k-stream-gate.mjs'
import { createCanvas } from './charts.mjs'
import { phraseOverlap } from './feature-events.mjs'
import { CAPTURE_CONFIG_KEY } from './seed.mjs'
import { isLiveJournalState } from './youtube-side.mjs'

// Plan 178 U9 step 2. The steps the suites are composed from (plan 176 test
// matrix, plan 166 scenarios), in the U6 step-engine format. Every wait is
// on bus events (journal lines, remote.state, feature events, observer
// snapshots) with a deadline; there are no fixed sleeps.
//
// Feature steps append a record to features.ndjson ({ id, kind, at, ... })
// so the frame checks (frame-checks.mjs) can look at the public output at
// that moment, and needs-eyes items ({ kind: 'needs-eyes', question }) so the
// report can put them in the owner digest. Neither ever fails a run.

export const FEATURES_FILE = 'features.ndjson'

// Output profiles for first light (plan 176 suite A). The ids are the app's
// own VideoPreset ids (apps/desktop/src/renderer/src/lib/capture.ts); the
// bitrate is what the verdict's 70% rule measures against.
export const OUTPUT_PROFILES = Object.freeze({
  '1080p30': { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
  '720p30': { preset: 'tutorial-720p30', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 },
  '1080p60': { preset: 'stream-1080p60', width: 1920, height: 1080, fps: 60, bitrateKbps: 9000 },
  '4k30': {
    preset: 'stream-youtube-4k30',
    width: YOUTUBE_4K_STREAM_GATES.stream.width,
    height: YOUTUBE_4K_STREAM_GATES.stream.height,
    fps: YOUTUBE_4K_STREAM_GATES.stream.fps,
    bitrateKbps: YOUTUBE_4K_STREAM_GATES.stream.bitrateKbps
  }
})

export const SCENE_IDS = Object.freeze({
  'screen-only': 1,
  'screen-camera': 2,
  'camera-only': 3,
  'side-by-side': 4,
  'picture-in-picture': 5
})

const MIN = 60_000

export function nowIso(ctx) {
  return new Date(ctx.clock?.now?.() ?? Date.now()).toISOString()
}

/** Appends one feature record (no secrets: ids, kinds, times, numbers). */
export async function recordFeature(ctx, record) {
  const entry = { at: nowIso(ctx), ...record }
  await appendFile(join(ctx.runDir, FEATURES_FILE), `${JSON.stringify(entry)}\n`).catch(() => {})
  ctx.events?.emit('feature-mark', entry)
  return entry
}

/** A by-eye question for the owner digest. Never fails a step. */
export function needsEyes(ctx, { id, question, frameHint = null }) {
  return recordFeature(ctx, { id, kind: 'needs-eyes', question, frameHint })
}

function skipped(ctx, id, reason) {
  ctx.log(`${id}: skipped (${reason})`)
  return { skipped: true, reason }
}

function latestJournal(ctx) {
  return ctx.observe?.latestJournal?.() ?? null
}

function liveLegs(line) {
  return (line?.legs ?? []).filter((leg) => leg.state === 'live')
}

/**
 * Stays live for `minutes`, checking every journal sample: a sample that says
 * the app left the live state ends the step early (fail). Event-based: the
 * wait resolves on the first sample at or after the hold end.
 */
export function liveHoldStep({ id = 'hold-live', minutes = 10, title = 'Hold live' } = {}) {
  const ms = (ctx) => (typeof minutes === 'function' ? minutes(ctx.params) : minutes) * MIN
  return {
    id,
    title,
    deadlineMs: 24 * 60 * MIN,
    async run(ctx) {
      const started = ctx.clock?.now?.() ?? Date.now()
      const until = started + ms(ctx)
      let samples = 0
      let notLive = null
      await ctx.waitFor(
        () => {
          const line = latestJournal(ctx)
          if (!line || line.tsMs < started) return null
          samples += 1
          if (!isLiveJournalState(line.state)) {
            notLive = { ts: line.ts, state: line.state }
            return true
          }
          return line.tsMs >= until
        },
        { deadlineMs: ms(ctx) + 2 * MIN, label: `${id}: ${Math.round(ms(ctx) / MIN)} min live` }
      )
      return { minutes: ms(ctx) / MIN, samples, notLive }
    },
    expect: (evidence) =>
      evidence.notLive === null ||
      `the app left the live state (${evidence.notLive.state}) at ${evidence.notLive.ts}`
  }
}

/** Waits for a journal sample with a live leg carrying bitrate. */
export function liveSampleStep({ id = 'live-sample', title = 'Live sample' } = {}) {
  return {
    id,
    title,
    deadlineMs: 90_000,
    async run(ctx) {
      const since = ctx.clock?.now?.() ?? Date.now()
      const line = await ctx.waitFor(
        () => {
          const latest = latestJournal(ctx)
          return latest &&
            latest.tsMs >= since &&
            isLiveJournalState(latest.state) &&
            liveLegs(latest).some((leg) => leg.bitrateKbps > 0)
            ? latest
            : null
        },
        { label: 'a journal sample with a live leg' }
      )
      return {
        state: line.state,
        legs: line.legs.map((leg) => ({
          targetId: leg.targetId,
          bitrateKbps: leg.bitrateKbps,
          fps: leg.fps,
          speed: leg.speed
        }))
      }
    }
  }
}

/**
 * Applies an output profile (plan 176 suite A variants) to every seeded
 * destination through the saved Studio config and a renderer reload. Runs
 * before Go Live. A profile the app does not know is a refusal.
 */
export function outputProfileStep({ id = 'output-profile', profileParam = 'profile' } = {}) {
  return {
    id,
    title: 'Output profile',
    deadlineMs: 90_000,
    async run(ctx) {
      const name = ctx.params?.[profileParam] ?? '1080p30'
      const profile = OUTPUT_PROFILES[name]
      if (!profile) throw new Error(`unknown output profile "${name}"`)
      const saved = JSON.parse(
        (await ctx.ui.evaluate(`localStorage.getItem(${JSON.stringify(CAPTURE_CONFIG_KEY)})`)) ??
          'null'
      )
      if (!saved?.streaming) throw new Error('the Studio config is not seeded')
      const next = {
        ...saved,
        streaming: {
          ...saved.streaming,
          defaultOutputPreset: profile.preset,
          targets: (saved.streaming.targets ?? []).map((target) =>
            target?.enabled
              ? { ...target, outputPreset: profile.preset, bitrateKbps: profile.bitrateKbps }
              : target
          )
        }
      }
      await ctx.ui.evaluate(
        `(() => { localStorage.setItem(${JSON.stringify(CAPTURE_CONFIG_KEY)}, ${JSON.stringify(JSON.stringify(next))}); return true })()`
      )
      await ctx.ui.reload()
      const check = JSON.parse(
        (await ctx.ui.evaluate(`localStorage.getItem(${JSON.stringify(CAPTURE_CONFIG_KEY)})`)) ??
          'null'
      )
      const applied = (check?.streaming?.targets ?? [])
        .filter((target) => target?.enabled)
        .every((target) => target.outputPreset === profile.preset)
      await recordFeature(ctx, { id, kind: 'profile', profile: name, ...profile })
      return { profile: name, preset: profile.preset, bitrateKbps: profile.bitrateKbps, applied }
    },
    expect: (evidence) => evidence.applied || 'the renderer did not keep the output preset'
  }
}

/** One sceneApply with its remote.state confirmation and a feature record. */
export function sceneSwitchStep({ id, preset, title = `Scene ${preset}` }) {
  const sceneId = SCENE_IDS[preset] ?? 0
  return {
    id,
    title,
    sceneId,
    deadlineMs: 45_000,
    async run(ctx) {
      const sent = await ctx.remote.intent('sceneApply', { layoutPreset: preset })
      if (!sent.ok) return { ok: false, message: sent.message }
      await ctx.waitFor(() => ctx.remote.state()?.layoutPreset === preset, {
        deadlineMs: 20_000,
        label: `scene ${preset}`
      })
      const mark = await recordFeature(ctx, { id, kind: 'scene', preset, sceneId })
      return { ok: true, preset, at: mark.at }
    },
    expect: (evidence) => evidence.ok || `sceneApply ${preset} refused: ${evidence.message ?? ''}`
  }
}

/** Renders a plain BRB card and imports it as a takeover screen of the lab profile. */
export async function ensureTakeoverAsset(ctx, { label = 'BRB' } = {}) {
  if (ctx.params?.takeoverAssetId) return ctx.params.takeoverAssetId
  const dir = join(ctx.runDir, 'assets')
  await mkdir(dir, { recursive: true })
  const canvas = createCanvas(1280, 720, '#1f2937')
  canvas.text(1280 / 2 - 3 * 6 * 12, 720 / 2 - 24, label, '#f9fafb', 12)
  const path = join(dir, 'brb.png')
  await writeFile(path, canvas.toPng())
  const screen = await ctx.rpc('screens.importImage', { path })
  const assetId = screen?.id ?? screen?.screen?.id ?? null
  if (!assetId) throw new Error('screens.importImage returned no screen id')
  return assetId
}

export function takeoverSteps({ idPrefix = 'takeover', holdMinutes = 1 } = {}) {
  return [
    {
      id: `${idPrefix}-show`,
      title: 'Takeover BRB',
      sceneId: 8,
      deadlineMs: 120_000,
      async run(ctx) {
        const assetId = await ensureTakeoverAsset(ctx)
        const sent = await ctx.remote.intent('takeoverShow', { assetId })
        if (!sent.ok) return { ok: false, message: sent.message }
        await ctx.waitFor(() => ctx.remote.state()?.activeTakeoverId === assetId, {
          deadlineMs: 20_000,
          label: 'takeover active'
        })
        const mark = await recordFeature(ctx, {
          id: `${idPrefix}-show`,
          kind: 'takeover',
          shown: true
        })
        await needsEyes(ctx, {
          id: `${idPrefix}-look`,
          question: 'Does the BRB takeover cover the whole stream picture?',
          frameHint: `${idPrefix}-show`
        })
        ctx.takeoverAssetId = assetId
        return { ok: true, assetId, at: mark.at }
      },
      expect: (evidence) => evidence.ok || `takeoverShow refused: ${evidence.message ?? ''}`
    },
    liveHoldStep({ id: `${idPrefix}-hold`, minutes: holdMinutes, title: 'BRB on air' }),
    {
      id: `${idPrefix}-hide`,
      title: 'Takeover off',
      sceneId: 1,
      deadlineMs: 60_000,
      async run(ctx) {
        const sent = await ctx.remote.intent('takeoverHide')
        if (!sent.ok) return { ok: false, message: sent.message }
        await ctx.waitFor(() => !ctx.remote.state()?.activeTakeoverId, {
          deadlineMs: 20_000,
          label: 'takeover cleared'
        })
        const mark = await recordFeature(ctx, {
          id: `${idPrefix}-hide`,
          kind: 'takeover',
          shown: false
        })
        return { ok: true, at: mark.at }
      },
      expect: (evidence) => evidence.ok || `takeoverHide refused: ${evidence.message ?? ''}`
    }
  ]
}

async function listRecordings(dir) {
  try {
    return (await readdir(dir)).filter((name) => /\.(mp4|mov|mkv)$/i.test(name))
  } catch {
    return []
  }
}

/** Record while live (plan 157 separate source files land beside the combined one). */
export function recordWhileLiveSteps({ idPrefix = 'record', minutes = 2 } = {}) {
  return [
    {
      id: `${idPrefix}-start`,
      title: 'Record while live',
      deadlineMs: 90_000,
      async run(ctx) {
        ctx.recordingsBefore = await listRecordings(ctx.profile?.recordingsDir ?? '')
        const sent = await ctx.remote.intent('recordStart')
        if (!sent.ok) return { ok: false, message: sent.message }
        const line = await ctx.waitFor(
          () => {
            const latest = latestJournal(ctx)
            return latest?.state === 'both' ? latest : null
          },
          { deadlineMs: 60_000, label: 'journal state both' }
        )
        await recordFeature(ctx, { id: `${idPrefix}-start`, kind: 'record', on: true })
        return { ok: true, state: line.state }
      },
      expect: (evidence) => evidence.ok || `recordStart refused: ${evidence.message ?? ''}`
    },
    liveHoldStep({ id: `${idPrefix}-hold`, minutes, title: 'Recording live' }),
    {
      id: `${idPrefix}-stop`,
      title: 'Stop recording',
      deadlineMs: 120_000,
      async run(ctx) {
        const sent = await ctx.remote.intent('recordStop')
        if (!sent.ok) return { ok: false, message: sent.message }
        const line = await ctx.waitFor(
          () => {
            const latest = latestJournal(ctx)
            return latest?.state === 'live' ? latest : null
          },
          { deadlineMs: 90_000, label: 'journal state live (recording stopped)' }
        )
        const after = await listRecordings(ctx.profile?.recordingsDir ?? '')
        const before = new Set(ctx.recordingsBefore ?? [])
        const files = after.filter((name) => !before.has(name))
        await recordFeature(ctx, {
          id: `${idPrefix}-stop`,
          kind: 'record',
          on: false,
          files: files.length
        })
        return { ok: true, state: line.state, newFiles: files.length }
      },
      expect: (evidence) =>
        (evidence.ok && evidence.newFiles > 0) ||
        (evidence.ok
          ? 'no recording file appeared'
          : `recordStop refused: ${evidence.message ?? ''}`)
    }
  ]
}

export function micToggleSteps({ idPrefix = 'mic' } = {}) {
  const toggle = (id, kind, muted, title) => ({
    id,
    title,
    deadlineMs: 30_000,
    async run(ctx) {
      const sent = await ctx.remote.intent(kind)
      if (!sent.ok) return { ok: false, message: sent.message }
      await ctx.waitFor(() => ctx.remote.state()?.micMuted === muted, {
        deadlineMs: 15_000,
        label: `micMuted ${muted}`
      })
      await recordFeature(ctx, { id, kind: 'mic', muted })
      return { ok: true, muted }
    },
    expect: (evidence) => evidence.ok || `${kind} refused: ${evidence.message ?? ''}`
  })
  return [
    toggle(`${idPrefix}-mute`, 'micMute', true, 'Mic mute'),
    toggle(`${idPrefix}-unmute`, 'micUnmute', false, 'Mic unmute')
  ]
}

export function systemAudioToggleSteps({ idPrefix = 'system-audio' } = {}) {
  const toggle = (id, kind, on, title) => ({
    id,
    title,
    deadlineMs: 30_000,
    onFail: 'continue',
    async run(ctx) {
      if (ctx.remote.state()?.systemAudioAvailable === false)
        return skipped(ctx, id, 'system audio is not available on this build or machine')
      const sent = await ctx.remote.intent(kind)
      if (!sent.ok) return { ok: false, message: sent.message }
      await ctx.waitFor(() => ctx.remote.state()?.systemAudioOn === on, {
        deadlineMs: 15_000,
        label: `systemAudioOn ${on}`
      })
      await recordFeature(ctx, { id, kind: 'system-audio', on })
      return { ok: true, on }
    },
    expect: (evidence) => evidence.ok || `${kind} refused: ${evidence.message ?? ''}`
  })
  return [
    toggle(`${idPrefix}-off`, 'systemAudioOff', false, 'System audio off'),
    toggle(`${idPrefix}-on`, 'systemAudioOn', true, 'System audio on')
  ]
}

function captionsOff(ctx) {
  const status = ctx.observe.featureEvents('captions-status').at(-1)
  if (!status) return null
  if (status.enabled === false || status.available === false) return 'captions are off'
  const text = `${status.state ?? ''} ${status.status ?? ''} ${status.phase ?? ''} ${status.reason ?? ''}`
  return /off|disabled|unavailable|kill|idle/i.test(text) ? `captions: ${text.trim()}` : null
}

/** Pure: the first final caption after `sinceMs` that carries the phrase. */
export function matchCaption(phraseText, captions, sinceMs, minOverlap = 0.6) {
  for (const caption of captions) {
    if (caption.captionKind !== 'final') continue
    const at = Date.parse(caption.ts)
    if (!Number.isFinite(at) || at < sinceMs) continue
    const overlap = phraseOverlap(phraseText, caption.text ?? '')
    if (overlap >= minOverlap) return { caption, overlap, latencyMs: at - sinceMs }
  }
  return null
}

/** Scripted speech into BlackHole, then the matching final caption (plans 077, 175). */
export function captionsStep({ id = 'captions', phraseId = 'caption-pangram' } = {}) {
  return {
    id,
    title: 'Captions',
    deadlineMs: 120_000,
    onFail: 'continue',
    async run(ctx) {
      const off = captionsOff(ctx)
      if (off) return skipped(ctx, id, off)
      const phrase = await ctx.speech.find(phraseId)
      if (!phrase) throw new Error(`unknown phrase ${phraseId}`)
      const played = await ctx.speech.play(phraseId)
      const sinceMs = Date.parse(played.playedAt)
      const match = await ctx
        .waitFor(() => matchCaption(phrase.text, ctx.observe.featureEvents('caption'), sinceMs), {
          deadlineMs: 60_000,
          label: 'a final caption with the phrase'
        })
        .catch(() => null)
      await recordFeature(ctx, {
        id,
        kind: 'caption',
        phraseId,
        at: played.playedAt,
        matched: Boolean(match),
        latencyMs: match?.latencyMs ?? null
      })
      if (!match && captionsOff(ctx)) return skipped(ctx, id, captionsOff(ctx))
      return { phraseId, matched: Boolean(match), latencyMs: match?.latencyMs ?? null }
    },
    expect: (evidence) => evidence.matched || 'no final caption carried the scripted phrase'
  }
}

/** A Buddy voice command (plan 140): highlight-last expects the highlight to go live. */
export function voiceCommandStep({ id = 'voice-highlight', phraseId = 'highlight-last' } = {}) {
  return {
    id,
    title: 'Voice command',
    deadlineMs: 120_000,
    onFail: 'continue',
    async run(ctx) {
      const phrase = await ctx.speech.find(phraseId)
      if (!phrase) throw new Error(`unknown phrase ${phraseId}`)
      if (phrase.destructive && ctx.params?.allowDestructiveVoice !== true)
        return skipped(ctx, id, 'destructive voice commands need params.allowDestructiveVoice')
      const buddy = ctx.observe.featureEvents('buddy-state').at(-1)
      if (!buddy || buddy.enabled === false || buddy.listening === false)
        return skipped(ctx, id, 'Buddy is not listening in the lab profile')
      const played = await ctx.speech.play(phraseId)
      const sinceMs = Date.parse(played.playedAt)
      const expectKind = phrase.expect?.kind ?? 'highlight'
      const seen = await ctx
        .waitFor(
          () =>
            ctx.observe
              .featureEvents('highlight')
              .find(
                (event) =>
                  Date.parse(event.ts) >= sinceMs &&
                  (expectKind === 'highlight' ? event.phase === 'live' : event.phase === 'idle')
              ) ?? null,
          { deadlineMs: 60_000, label: `highlight ${expectKind}` }
        )
        .catch(() => null)
      await recordFeature(ctx, {
        id,
        kind: 'highlight',
        via: 'voice',
        phraseId,
        at: seen?.ts ?? played.playedAt,
        matched: Boolean(seen)
      })
      return {
        phraseId,
        matched: Boolean(seen),
        latencyMs: seen ? Date.parse(seen.ts) - sinceMs : null
      }
    },
    expect: (evidence) => evidence.matched || 'the voice command had no visible effect'
  }
}

/** "clip that" while recording (plans 068, 097): expects a clip.marked event. */
export function clipMarkStep({ id = 'clip-mark', phraseId = 'clip-that', viaIntent = true } = {}) {
  return {
    id,
    title: 'Clip mark',
    deadlineMs: 90_000,
    onFail: 'continue',
    async run(ctx) {
      const since = ctx.clock?.now?.() ?? Date.now()
      let via = 'intent'
      const listening = ctx.observe.featureEvents('voice-marker-status').at(-1)?.listening
      if (listening && listening.listening !== false && !viaIntent) {
        await ctx.speech.play(phraseId)
        via = 'voice'
      } else {
        const sent = await ctx.remote.intent('clipMark')
        if (!sent.ok) return skipped(ctx, id, `clipMark refused: ${sent.message ?? 'no reason'}`)
      }
      const mark = await ctx
        .waitFor(
          () =>
            ctx.observe.featureEvents('clip-mark').find((event) => Date.parse(event.ts) >= since) ??
            null,
          { deadlineMs: 45_000, label: 'clip.marked' }
        )
        .catch(() => null)
      await recordFeature(ctx, { id, kind: 'clip-mark', via, saved: mark?.saved ?? false })
      return {
        via,
        marked: Boolean(mark),
        saved: mark?.saved ?? false,
        reason: mark?.reason ?? null
      }
    },
    expect: (evidence) => evidence.marked || 'no clip.marked event followed the mark'
  }
}

/** Pure: which scripted messages arrived (by text) and how long they took. */
export function chatArrivals(sent, chatEvents) {
  const byText = new Map()
  for (const event of chatEvents) {
    if (event.kind !== 'chat' || !event.text || event.isDeleted) continue
    if (!byText.has(event.text)) byText.set(event.text, event)
  }
  return sent.map((message) => {
    const arrived = byText.get(message.text) ?? null
    return {
      kind: message.kind,
      arrived: Boolean(arrived),
      appMessageId: arrived?.id ?? null,
      latencyMs: arrived ? Date.parse(arrived.ts) - Date.parse(message.sentAt) : null
    }
  })
}

/** The viewer bot posts suite C's script; arrivals are checked by text. */
export function chatSteps({ idPrefix = 'chat', slowModeSeconds = 30 } = {}) {
  return [
    {
      id: `${idPrefix}-live-chat`,
      title: 'Live chat id',
      deadlineMs: 6 * MIN,
      async run(ctx) {
        if (!ctx.observer) throw new Error('the YouTube observer is not running')
        const liveChatId = await ctx.waitFor(() => ctx.observer.liveChatId(), {
          label: 'the broadcast liveChatId from the observer'
        })
        ctx.liveChatId = liveChatId
        return { liveChatId: Boolean(liveChatId) }
      }
    },
    {
      id: `${idPrefix}-script`,
      title: 'Viewer bot posts',
      deadlineMs: 12 * MIN,
      async run(ctx) {
        if (!ctx.viewer) throw new Error('no viewer bot (the viewer role is not authorized)')
        const result = await ctx.viewer.runScript(ctx.liveChatId, {
          tag: ctx.run.runId,
          slowModeSeconds: ctx.params?.slowModeSeconds ?? slowModeSeconds,
          signal: ctx.signal
        })
        ctx.chatSent = result.sent
        ctx.chatDeleted = result.deleted
        await recordFeature(ctx, {
          id: `${idPrefix}-script`,
          kind: 'chat-script',
          sent: result.sent.length,
          deleted: Boolean(result.deleted)
        })
        return { sent: result.sent.length, deleted: Boolean(result.deleted) }
      },
      expect: (evidence) => evidence.sent > 0 || 'the viewer bot sent nothing'
    },
    {
      id: `${idPrefix}-arrival`,
      title: 'Messages arrive',
      deadlineMs: 3 * MIN,
      async run(ctx) {
        const sent = ctx.chatSent ?? []
        const arrivals = await ctx
          .waitFor(
            () => {
              const now = chatArrivals(sent, ctx.observe.featureEvents('chat'))
              return now.every((entry) => entry.arrived) ? now : null
            },
            { deadlineMs: 2 * MIN, label: 'every scripted message in the app' }
          )
          .catch(() => chatArrivals(sent, ctx.observe.featureEvents('chat')))
        ctx.chatArrivals = arrivals
        const latencies = arrivals.filter((a) => a.arrived).map((a) => a.latencyMs)
        await recordFeature(ctx, {
          id: `${idPrefix}-arrival`,
          kind: 'chat-arrival',
          sent: sent.length,
          arrived: latencies.length,
          missing: arrivals.filter((a) => !a.arrived).map((a) => a.kind),
          maxLatencyMs: latencies.length ? Math.max(...latencies) : null
        })
        return {
          sent: sent.length,
          arrived: latencies.length,
          missing: arrivals.filter((a) => !a.arrived).map((a) => a.kind),
          maxLatencyMs: latencies.length ? Math.max(...latencies) : null
        }
      },
      expect: (evidence) =>
        evidence.missing.length === 0 || `never arrived in the app: ${evidence.missing.join(', ')}`
    },
    {
      id: `${idPrefix}-reply`,
      title: 'App replies',
      deadlineMs: 6 * MIN,
      onFail: 'continue',
      async run(ctx) {
        const sessionId = latestJournal(ctx)?.sessionId
        if (!sessionId) return skipped(ctx, `${idPrefix}-reply`, 'no session id in the journal')
        const text = `[lab ${ctx.run.runId}] reply from Videorc`
        const sinceMs = ctx.clock?.now?.() ?? Date.now()
        await ctx.rpc('liveChat.send', { operationId: randomUUID(), sessionId, text })
        const seen = await ctx
          .waitFor(
            () =>
              ctx.observer
                .snapshots()
                .filter((snapshot) => Date.parse(snapshot.at) >= sinceMs)
                .flatMap((snapshot) => snapshot.chat?.newMessages ?? [])
                .find((message) => message.isChatOwner && message.text === text) ?? null,
            { deadlineMs: 5 * MIN, label: 'the reply on YouTube (observer)' }
          )
          .catch(() => null)
        await recordFeature(ctx, {
          id: `${idPrefix}-reply`,
          kind: 'chat-reply',
          seenOnYoutube: Boolean(seen)
        })
        return { seenOnYoutube: Boolean(seen) }
      },
      expect: (evidence) => evidence.seenOnYoutube || 'the observer never saw the reply on YouTube'
    },
    {
      id: `${idPrefix}-highlight`,
      title: 'Comment on stream',
      sceneId: 9,
      deadlineMs: 2 * MIN,
      onFail: 'continue',
      async run(ctx) {
        const target = (ctx.chatArrivals ?? []).find((entry) => entry.arrived && entry.appMessageId)
        if (!target)
          return skipped(ctx, `${idPrefix}-highlight`, 'no arrived message to put on stream')
        const sinceMs = ctx.clock?.now?.() ?? Date.now()
        const sent = await ctx.remote.intent('commentHighlight', { messageId: target.appMessageId })
        if (!sent.ok) return { ok: false, message: sent.message }
        const live = await ctx.waitFor(
          () =>
            ctx.observe
              .featureEvents('highlight')
              .find((event) => Date.parse(event.ts) >= sinceMs && event.phase === 'live') ?? null,
          { deadlineMs: 45_000, label: 'highlight live' }
        )
        const mark = await recordFeature(ctx, {
          id: `${idPrefix}-highlight`,
          kind: 'highlight',
          via: 'click',
          at: live.ts
        })
        await needsEyes(ctx, {
          id: 'highlight-card-look',
          question: 'Does the highlight card look right on the stream?',
          frameHint: `${idPrefix}-highlight`
        })
        return { ok: true, at: mark.at }
      },
      expect: (evidence) => evidence.ok || `commentHighlight refused: ${evidence.message ?? ''}`
    },
    {
      id: `${idPrefix}-deleted`,
      title: 'Viewer deletion',
      deadlineMs: 2 * MIN,
      onFail: 'continue',
      async run(ctx) {
        const deleted = ctx.chatDeleted
        const message = (ctx.chatSent ?? []).find((entry) => entry.id === deleted?.id)
        if (!deleted || !message)
          return skipped(ctx, `${idPrefix}-deleted`, 'the viewer bot deleted nothing')
        const seen = await ctx
          .waitFor(
            () =>
              ctx.observe
                .featureEvents('chat')
                .find((event) => event.isDeleted && event.text === message.text) ?? null,
            { deadlineMs: 90_000, label: 'the deleted message marked in the app' }
          )
          .catch(() => null)
        if (!seen) {
          await needsEyes(ctx, {
            id: 'chat-deletion-look',
            question: 'Did the deleted viewer message disappear from the Stream Manager?'
          })
        }
        return { markedDeleted: Boolean(seen) }
      }
    },
    {
      id: `${idPrefix}-links`,
      title: 'Link row',
      deadlineMs: 10_000,
      async run(ctx) {
        await needsEyes(ctx, {
          id: 'chat-link-row',
          question: 'Does right-click on the link message offer Open link and Copy link (plan 151)?'
        })
        return { recorded: true }
      }
    }
  ]
}

/** Pure: compare an observer stream reading with an expected profile. */
export function evaluateYoutubeHealth(snapshot, expected = null) {
  const stream = snapshot?.stream ?? null
  const problems = []
  if (!stream) problems.push('no stream reading')
  else {
    if (stream.streamStatus !== 'active') problems.push(`streamStatus ${stream.streamStatus}`)
    if (!['good', 'ok'].includes(stream.healthStatus))
      problems.push(`healthStatus ${stream.healthStatus ?? 'unknown'}`)
  }
  const matches = { resolution: null, frameRate: null }
  if (expected && stream) {
    const res = String(stream.resolution ?? '').toLowerCase()
    matches.resolution = res === 'variable' || res === '' ? null : res === `${expected.height}p`
    const fps = String(stream.frameRate ?? '').toLowerCase()
    matches.frameRate = fps === 'variable' || fps === '' ? null : fps === `${expected.fps}fps`
    if (matches.resolution === false) problems.push(`resolution ${stream.resolution}`)
    if (matches.frameRate === false) problems.push(`frameRate ${stream.frameRate}`)
  }
  return {
    ok: problems.length === 0,
    problems,
    matches,
    healthStatus: stream?.healthStatus ?? null
  }
}

/** Waits for an observer poll that says YouTube receives the stream in good health. */
export function youtubeHealthStep({ id = 'youtube-health', profileParam = 'profile' } = {}) {
  return {
    id,
    title: 'YouTube health',
    deadlineMs: 7 * MIN,
    async run(ctx) {
      if (!ctx.observer) throw new Error('the YouTube observer is not running')
      const since = ctx.clock?.now?.() ?? Date.now()
      const expected = ctx.params?.[profileParam] ? OUTPUT_PROFILES[ctx.params[profileParam]] : null
      let last = null
      const good = await ctx
        .waitFor(
          () => {
            const snapshot = ctx.observer.latest()
            if (!snapshot || Date.parse(snapshot.at) < since) return null
            last = evaluateYoutubeHealth(snapshot, expected)
            return last.ok ? last : null
          },
          { deadlineMs: 6 * MIN, label: 'a good YouTube stream reading' }
        )
        .catch(() => null)
      const verdict = good ?? last ?? { ok: false, problems: ['no observer poll'], matches: {} }
      if (verdict.matches?.resolution === null && expected) {
        await needsEyes(ctx, {
          id: 'youtube-resolution',
          question: `Does YouTube Studio show the stream at ${expected.width}x${expected.height}@${expected.fps}?`
        })
      }
      await recordFeature(ctx, { id, kind: 'youtube-health', ...verdict })
      return verdict
    },
    expect: (evidence) => evidence.ok || `YouTube side: ${evidence.problems.join(', ')}`
  }
}

/** One clip of the public output now (skipped unless the policy allows clip pulls). */
export function clipPullStep({ id = 'clip', seconds = 120 } = {}) {
  return {
    id,
    title: 'Public output clip',
    deadlineMs: seconds * 1000 + 6 * MIN,
    onFail: 'continue',
    async run(ctx) {
      if (!ctx.observer) throw new Error('the YouTube observer is not running')
      const result = await ctx.observer.pullClip({ seconds, reason: id })
      if (result.status === 'skipped') return skipped(ctx, id, result.reason)
      if (result.status === 'failed')
        return { ok: false, reason: result.reason, detail: result.detail }
      return {
        ok: result.incidents.length === 0,
        incidents: result.incidents.map((incident) => incident.signature),
        summary: {
          longestFreezeMs: result.summary.longestFreezeMs,
          maxAudioGapMs: result.summary.maxAudioGapMs,
          avOffsetMs: result.summary.avOffsetMs
        }
      }
    },
    expect: (evidence) =>
      evidence.ok || `clip: ${evidence.incidents?.join(', ') ?? evidence.reason ?? 'failed'}`
  }
}

/** After stop: the broadcast completes on YouTube and the VOD has an end time. */
export function vodStep({ id = 'vod' } = {}) {
  return {
    id,
    title: 'VOD',
    deadlineMs: 5 * MIN,
    async run(ctx) {
      if (!ctx.observer) throw new Error('the YouTube observer is not running')
      let snapshot = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        snapshot = await ctx.observer.poll()
        const lifecycle = snapshot.broadcast?.lifeCycleStatus
        if (lifecycle === 'complete' || snapshot.video?.actualEndTime) break
        await ctx
          .waitFor(
            () => {
              const latest = ctx.observer.latest()
              return latest && latest !== snapshot ? latest : null
            },
            { deadlineMs: 90_000, label: 'the next observer poll' }
          )
          .catch(() => null)
      }
      const vod = {
        videoId: snapshot?.broadcast?.id ?? null,
        lifecycle: snapshot?.broadcast?.lifeCycleStatus ?? null,
        actualStartTime: snapshot?.video?.actualStartTime ?? null,
        actualEndTime: snapshot?.video?.actualEndTime ?? null
      }
      await recordFeature(ctx, { id, kind: 'vod', ...vod })
      return vod
    },
    expect: (evidence) =>
      evidence.lifecycle === 'complete' ||
      Boolean(evidence.actualEndTime) ||
      `broadcast is ${evidence.lifecycle}`
  }
}

/** Quits the app while live (plan 176 suite E): the ledger must end clean. */
export function quitWhileLiveStep({ id = 'quit-while-live' } = {}) {
  return {
    id,
    title: 'Quit while live',
    deadlineMs: 2 * MIN,
    async run(ctx) {
      const before = ctx.ownedPids?.() ?? {}
      const result = await ctx.quitApp()
      await recordFeature(ctx, { id, kind: 'quit', state: result?.state ?? null })
      return { state: result?.state ?? 'unknown', ledgerPidsBefore: (before.ledger ?? []).length }
    },
    expect: (evidence) =>
      ['terminated', 'exited', 'quit', 'killed'].includes(evidence.state) ||
      `the app did not exit (${evidence.state})`
  }
}

/** The owner ends the stream in Studio (attended only); unattended it is needs-eyes. */
export function studioEndedStep({ id = 'studio-ended' } = {}) {
  return {
    id,
    title: 'Ended from Studio',
    deadlineMs: 6 * MIN,
    onFail: 'continue',
    async run(ctx) {
      if (ctx.params?.attended !== true) {
        await needsEyes(ctx, {
          id: 'studio-ended-unattended',
          question:
            'Attended only: end the stream from YouTube Studio and confirm the app leaves On air (plan 161).'
        })
        return skipped(ctx, id, 'owner-only (needs params.attended: true)')
      }
      ctx.log('Owner: end the stream from YouTube Studio now.')
      const incident = await ctx.waitFor(
        () => ctx.observe.incidents().find((entry) => entry.type === 'studio-ended') ?? null,
        { deadlineMs: 5 * MIN, label: 'the Studio end seen by the observer' }
      )
      const left = await ctx.waitFor(
        () => {
          const state = ctx.remote.state()
          return state && !state.sessionActive ? state.sessionState : null
        },
        { deadlineMs: 90_000, label: 'the app leaving On air' }
      )
      return { at: incident.at, appState: left }
    }
  }
}

// ---------------------------------------------------------------------------
// Timelines (plan 166 marathon / churn / idle). Their length comes from params
// at run time, so each is one step that drives sub-steps itself. Every action
// is recorded in features.ndjson; the step's evidence counts them.
// ---------------------------------------------------------------------------

/** Runs sub-steps in order with their own expectations; throws on the first failure. */
export async function runSubSteps(ctx, steps) {
  const results = []
  for (const step of steps) {
    const value = await step.run(ctx)
    if (value?.skipped) {
      results.push({ id: step.id, status: 'skipped', reason: value.reason })
      continue
    }
    const verdict = typeof step.expect === 'function' ? step.expect(value, ctx) : true
    if (verdict !== true) {
      const error = new Error(
        `${step.id}: ${typeof verdict === 'string' ? verdict : 'expectation not met'}`
      )
      error.subStep = step.id
      throw error
    }
    results.push({ id: step.id, status: 'pass', value })
  }
  return results
}

/** Waits for the first journal sample at or after `untilMs` (event-based). */
async function waitUntil(ctx, untilMs, label) {
  return ctx.waitFor(
    () => {
      const line = latestJournal(ctx)
      return line && line.tsMs >= untilMs ? line : null
    },
    { deadlineMs: Math.max(0, untilMs - (ctx.clock?.now?.() ?? Date.now())) + 2 * MIN, label }
  )
}

/**
 * Plan 166 marathon: `marathonHours` live at the seeded profile, a scene
 * switch every 10 min, local recording for 20 min every 2 h, a mic mute
 * toggle every hour, a clip pull every 30 min (skipped when clipPull is off).
 */
export function marathonTimelineStep({
  id = 'marathon',
  hoursParam = 'marathonHours',
  defaultHours = 8,
  sceneEveryMin = 10,
  recordEveryMin = 120,
  recordMinutes = 20,
  micEveryMin = 60,
  clipEveryMin = 30
} = {}) {
  return {
    id,
    title: 'Marathon',
    deadlineMs: 13 * 60 * MIN,
    async run(ctx) {
      const hours = Number(ctx.params?.[hoursParam]) || defaultHours
      const started = ctx.clock?.now?.() ?? Date.now()
      const end = started + hours * 60 * MIN
      const counts = { scenes: 0, records: 0, mics: 0, clips: 0, clipsSkipped: 0, ticks: 0 }
      const presets = ['screen-camera', 'screen-only']
      let tick = 0
      for (let at = started + sceneEveryMin * MIN; at <= end; at += sceneEveryMin * MIN) {
        const line = await waitUntil(ctx, at, `${id}: tick ${tick + 1}`)
        if (!isLiveJournalState(line.state)) {
          throw new Error(`${id}: the app left the live state (${line.state}) at ${line.ts}`)
        }
        tick += 1
        counts.ticks = tick
        const minute = tick * sceneEveryMin
        await runSubSteps(ctx, [
          sceneSwitchStep({ id: `${id}-scene-${tick}`, preset: presets[tick % presets.length] })
        ])
        counts.scenes += 1
        if (minute % micEveryMin === 0) {
          await runSubSteps(ctx, micToggleSteps({ idPrefix: `${id}-mic-${tick}` }))
          counts.mics += 1
        }
        if (minute % clipEveryMin === 0 && ctx.observer) {
          const result = await ctx.observer.pullClip({ reason: `${id}-clip-${tick}` })
          if (result.status === 'skipped') counts.clipsSkipped += 1
          else counts.clips += 1
        }
        if (minute % recordEveryMin === 0 && at + recordMinutes * MIN <= end) {
          await runSubSteps(
            ctx,
            recordWhileLiveSteps({ idPrefix: `${id}-record-${tick}`, minutes: recordMinutes })
          )
          counts.records += 1
        }
      }
      await waitUntil(ctx, end, `${id}: end of hour ${hours}`)
      await recordFeature(ctx, { id, kind: 'marathon', hours, ...counts })
      return { hours, ...counts }
    }
  }
}

/**
 * Plan 166 churn: `cycles` x (go live through the real dialog, 90 s live,
 * stop, 20 s idle). Start latency per cycle lands in features.ndjson.
 */
export function churnCyclesStep({
  id = 'churn',
  cyclesParam = 'cycles',
  defaultCycles = 40,
  liveSeconds = 90,
  idleSeconds = 20,
  goLiveSteps,
  stopStreamStep
} = {}) {
  if (typeof goLiveSteps !== 'function' || typeof stopStreamStep !== 'function') {
    throw new Error('churnCyclesStep needs goLiveSteps and stopStreamStep')
  }
  return {
    id,
    title: 'Churn',
    deadlineMs: 4 * 60 * MIN,
    async run(ctx) {
      const cycles = Number(ctx.params?.[cyclesParam]) || defaultCycles
      const latencies = []
      for (let cycle = 1; cycle <= cycles; cycle += 1) {
        ctx.log(`${id}: cycle ${cycle}/${cycles}`)
        const steps = goLiveSteps().filter((step) => step.id !== 'card-up')
        const results = await runSubSteps(ctx, steps)
        await runSubSteps(ctx, [liveSampleStep({ id: `${id}-${cycle}-sample` })])
        const liveAt = ctx.clock?.now?.() ?? Date.now()
        const latency = results.find((entry) => entry.id === 'go-live')?.value?.liveAfterMs ?? null
        await recordFeature(ctx, {
          id: `${id}-${cycle}`,
          kind: 'go-live',
          cycle,
          liveAfterMs: latency
        })
        if (Number.isFinite(latency)) latencies.push(latency)
        await waitUntil(ctx, liveAt + liveSeconds * 1000, `${id}: cycle ${cycle} live`)
        await runSubSteps(ctx, [stopStreamStep({ id: `${id}-${cycle}-stop` })])
        await waitUntil(
          ctx,
          (ctx.clock?.now?.() ?? Date.now()) + idleSeconds * 1000,
          `${id}: cycle ${cycle} idle`
        )
      }
      return {
        cycles,
        startLatencyMs: latencies,
        maxStartLatencyMs: latencies.length ? Math.max(...latencies) : null
      }
    }
  }
}

/** Plan 166 idle: the app open with the preview on, not live, for `minutes`. */
export function idleHoldStep({
  id = 'idle',
  minutesParam = 'idleMinutes',
  defaultMinutes = 120
} = {}) {
  return {
    id,
    title: 'Idle',
    deadlineMs: 5 * 60 * MIN,
    async run(ctx) {
      const minutes = Number(ctx.params?.[minutesParam]) || defaultMinutes
      const started = ctx.clock?.now?.() ?? Date.now()
      let samples = 0
      let wentLive = null
      await ctx.waitFor(
        () => {
          const line = latestJournal(ctx)
          if (!line || line.tsMs < started) return null
          samples += 1
          if (isLiveJournalState(line.state)) {
            wentLive = line.ts
            return true
          }
          return line.tsMs >= started + minutes * MIN
        },
        { deadlineMs: minutes * MIN + 2 * MIN, label: `${id}: ${minutes} min idle` }
      )
      return { minutes, samples, wentLive }
    },
    expect: (evidence) =>
      evidence.wentLive === null || `the app went live during idle at ${evidence.wentLive}`
  }
}
