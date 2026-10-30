// The microphone and System audio (plan 069 S6), exactly as the Studio's own
// switches do them.

import { systemAudioTarget } from '@/lib/system-audio'
import type { StudioActionContext, StudioActionExecutor, StudioActionOutcome } from './context'
import { REMOTE_INTENT_COPY } from './copy'

async function setMicrophone(
  context: StudioActionContext,
  mode: 'mute' | 'unmute' | 'toggle'
): Promise<StudioActionOutcome> {
  return (await context.setMicrophoneMuted(mode))
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.microphone }
}

export const micMute: StudioActionExecutor = (context) => setMicrophone(context, 'mute')
export const micUnmute: StudioActionExecutor = (context) => setMicrophone(context, 'unmute')
export const micToggle: StudioActionExecutor = (context) => setMicrophone(context, 'toggle')

function setSystemAudio(
  context: StudioActionContext,
  mode: 'on' | 'off' | 'toggle'
): StudioActionOutcome {
  const [status, shown] = context.systemAudio
  const target = systemAudioTarget(mode, status, shown)
  if (target === null) return { ok: false, message: REMOTE_INTENT_COPY.systemAudio }
  // Accepted = requested. The key renders the confirmed mix from
  // remote.state, which follows once the session reports it.
  context.setSystemAudioEnabled(target)
  return { ok: true }
}

export const systemAudioOn: StudioActionExecutor = async (context) => setSystemAudio(context, 'on')
export const systemAudioOff: StudioActionExecutor = async (context) =>
  setSystemAudio(context, 'off')
export const systemAudioToggle: StudioActionExecutor = async (context) =>
  setSystemAudio(context, 'toggle')
