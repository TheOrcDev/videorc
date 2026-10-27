// The Studio's agent tools (plan 209 S6): every `runsIn: studio` tool in
// protocol-fixtures/agent-tools.json, by its catalog name. Each one runs the
// executor a Stream Deck key runs (and so the same handler as the on-screen
// button), then answers with the sentence the agent reads and the tool's
// structured result. A parity test holds this record to the catalog: one
// executor per Studio tool and none besides.
//
// Nothing here toasts. D11 notices (`stop`, `notify`, `delete_recording`) are
// the Studio's, from the `notice` the backend puts on the `agents.activity`
// event.

import { layoutPresetLabel } from '@/lib/layout-labels'
import { soundboard } from '@/lib/soundboard-store'
import type { LayoutPreset } from '@/lib/backend'
import type { AgentToolExecutor } from './agent'
import { micMute, micUnmute, systemAudioOff, systemAudioOn } from './audio'
import { commentHighlight, commentHighlightClear } from './comments'
import type { StudioActionFields } from './context'
import { REMOTE_INTENT_COPY } from './copy'
import { sceneApply, takeoverHide, takeoverShow } from './scene'
import { recordStart, recordStop } from './session'
import { soundPlay, soundStop } from './sounds'
import { windowFront } from './windows'
// Plan 209 PR B, S13 to S15.
import { setBuddy } from './buddy'
import { deleteRecording, exportRecording } from './library'
import { setDestinations, updateStreamInfo } from './prepare'
import { getSettings, updateSettings } from './settings'

/** What an agent reads when a Studio tool refuses before any handler runs. */
export const AGENT_TOOL_COPY = {
  setAudioEmpty: 'Say what to change: microphone or systemAudio.',
  notifyEmpty: 'Say what the notice should say: message.',
  sceneMissing: REMOTE_INTENT_COPY.sceneMissing,
  sceneFailed: REMOTE_INTENT_COPY.sceneFailed
} as const

/** The agent's window names to the Studio's own (`windowFront`). */
const AGENT_WINDOWS: Readonly<Record<string, string>> = {
  'stream-manager': 'comments',
  notes: 'notes',
  preview: 'preview'
}

function text(fields: StudioActionFields, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function soundName(soundId: string): string | undefined {
  return soundboard.getSnapshot().board?.sounds.find((sound) => sound.id === soundId)?.name
}

const startRecording: AgentToolExecutor = async (context) => {
  const outcome = await recordStart(context, {})
  return outcome.ok ? { ok: true, message: 'Recording.', result: { started: true } } : outcome
}

const stop: AgentToolExecutor = async (context) => {
  const stopped = context.sessionLive ? 'livestream' : 'recording'
  const outcome = await recordStop(context, {})
  if (!outcome.ok) return outcome
  return {
    ok: true,
    message: stopped === 'livestream' ? 'The livestream ended.' : 'The recording stopped.',
    result: { stopped }
  }
}

const switchScene: AgentToolExecutor = async (context, args) => {
  const sceneId = text(args, 'sceneId')
  if (!sceneId) return { ok: false, message: AGENT_TOOL_COPY.sceneMissing }
  const saved = context.savedScenes?.find((scene) => scene.id === sceneId)
  if (saved && context.applySavedScene) {
    return (await context.applySavedScene(saved.id))
      ? {
          ok: true,
          message: `Switched to ${saved.name}.`,
          result: { scene: { id: saved.id, name: saved.name, kind: 'saved' } }
        }
      : { ok: false, message: AGENT_TOOL_COPY.sceneFailed }
  }
  const outcome = await sceneApply(context, { layoutPreset: sceneId })
  if (!outcome.ok) return outcome
  const presets = context.knownLayoutPresets
  const bothOrientations =
    presets.some((preset) => preset.startsWith('vertical-')) &&
    presets.some((preset) => !preset.startsWith('vertical-'))
  const name =
    context.layoutLabels?.[sceneId] ??
    layoutPresetLabel(sceneId as LayoutPreset, { bothOrientations })
  return {
    ok: true,
    message: `Switched to ${name}.`,
    result: { scene: { id: sceneId, name, kind: 'layout' } }
  }
}

const setAudio: AgentToolExecutor = async (context, args) => {
  const microphone = args.microphone as { muted?: unknown } | undefined
  const systemAudio = args.systemAudio as { on?: unknown } | undefined
  const muted = typeof microphone?.muted === 'boolean' ? microphone.muted : undefined
  const on = typeof systemAudio?.on === 'boolean' ? systemAudio.on : undefined
  if (muted === undefined && on === undefined) {
    return { ok: false, message: AGENT_TOOL_COPY.setAudioEmpty }
  }
  const result: Record<string, unknown> = {}
  const said: string[] = []
  if (muted !== undefined) {
    const outcome = await (muted ? micMute : micUnmute)(context, {})
    if (!outcome.ok) return outcome
    result.microphone = { muted }
    said.push(muted ? 'The microphone is muted.' : 'The microphone is on.')
  }
  if (on !== undefined) {
    const outcome = await (on ? systemAudioOn : systemAudioOff)(context, {})
    if (!outcome.ok) {
      // A microphone change above stays; say both.
      return { ok: false, message: [...said, outcome.message].filter(Boolean).join(' ') }
    }
    result.systemAudio = { on }
    said.push(on ? 'System audio is on.' : 'System audio is off.')
  }
  return { ok: true, message: said.join(' '), result }
}

const setTakeover: AgentToolExecutor = async (context, args) => {
  const takeoverId = args.takeoverId
  if (takeoverId === null) {
    const outcome = await takeoverHide(context, {})
    return outcome.ok
      ? { ok: true, message: 'The takeover is down.', result: { takeoverId: null } }
      : outcome
  }
  const outcome = await takeoverShow(context, { assetId: takeoverId })
  return outcome.ok ? { ok: true, message: 'The takeover is up.', result: { takeoverId } } : outcome
}

const playSound: AgentToolExecutor = async (context, args) => {
  const soundId = text(args, 'soundId')
  const outcome = await soundPlay(context, soundId ? { soundId } : {})
  if (!outcome.ok || !soundId) return outcome
  const name = soundName(soundId)
  return { ok: true, message: name ? `Pressed ${name}.` : 'Pressed.', result: { soundId } }
}

const stopSounds: AgentToolExecutor = async (context, args) => {
  const soundId = text(args, 'soundId')
  const outcome = await soundStop(context, soundId ? { soundId } : {})
  if (!outcome.ok) return outcome
  if (!soundId) return { ok: true, message: 'Every sound stopped.', result: { all: true } }
  const name = soundName(soundId)
  return {
    ok: true,
    message: name ? `${name} stopped.` : 'Stopped.',
    result: { soundId, all: false }
  }
}

const setHighlight: AgentToolExecutor = async (context, args) => {
  const messageId = args.messageId
  if (messageId === null) {
    const outcome = await commentHighlightClear(context, {})
    return outcome.ok
      ? { ok: true, message: 'The comment is off the stream.', result: { messageId: null } }
      : outcome
  }
  const outcome = await commentHighlight(context, { messageId })
  return outcome.ok
    ? { ok: true, message: 'The comment is on the stream.', result: { messageId } }
    : outcome
}

const openWindow: AgentToolExecutor = async (context, args) => {
  const window = text(args, 'window')
  const studioWindow = window && Object.hasOwn(AGENT_WINDOWS, window) ? AGENT_WINDOWS[window] : ''
  const outcome = await windowFront(context, { window: studioWindow })
  return outcome.ok ? { ok: true, message: 'It is in front.', result: { window } } : outcome
}

/** The notice itself is the Studio's D11 notice, filled from the catalog's
 * `{agent}: {message}` onto the `agents.activity` event; this only checks
 * there is something to show. */
const notify: AgentToolExecutor = async (_context, args) => {
  const message = text(args, 'message')
  if (!message?.trim()) return { ok: false, message: AGENT_TOOL_COPY.notifyEmpty }
  return { ok: true, message: 'Shown in Videorc.', result: { shown: true } }
}

/** Every `runsIn: studio` tool, by catalog name. */
export const STUDIO_AGENT_TOOLS: Readonly<Record<string, AgentToolExecutor>> = {
  start_recording: startRecording,
  stop,
  switch_scene: switchScene,
  set_audio: setAudio,
  set_takeover: setTakeover,
  play_sound: playSound,
  stop_sounds: stopSounds,
  set_highlight: setHighlight,
  open_window: openWindow,
  notify,
  // Plan 209 PR B, S13 to S15 (buddy.ts, prepare.ts, settings.ts, library.ts).
  set_buddy: setBuddy,
  update_stream_info: updateStreamInfo,
  set_destinations: setDestinations,
  get_settings: getSettings,
  update_settings: updateSettings,
  delete_recording: deleteRecording,
  export_recording: exportRecording
}
