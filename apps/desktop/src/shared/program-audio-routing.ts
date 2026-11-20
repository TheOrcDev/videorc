export const AUDIO_ROUTING_TOPIC = 'videorc.audio-routing.v1'
export type ProgramAudioSettings = {
  speechGain: number
  auxiliaryGain: number
  speechMuted: boolean
  auxiliaryMuted: boolean
}
export type AudioRoutingPacket = ProgramAudioSettings & {
  v: 1
  show: string
  publisherSid: string
  sequence: number
  sentAt: number
}
export function parseAudioRouting(
  value: unknown,
  show: string,
  publisherSid: string,
  now: number
): AudioRoutingPacket | null {
  if (!value || typeof value !== 'object') return null
  const v = value as AudioRoutingPacket
  if (
    Object.keys(v).length !== 9 ||
    v.v !== 1 ||
    v.show !== show ||
    v.publisherSid !== publisherSid ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 1 ||
    !Number.isSafeInteger(v.sentAt) ||
    v.sentAt > now + 1000 ||
    now - v.sentAt >= 3000 ||
    ![v.speechGain, v.auxiliaryGain].every((x) => Number.isFinite(x) && x >= 0 && x <= 1) ||
    typeof v.speechMuted !== 'boolean' ||
    typeof v.auxiliaryMuted !== 'boolean'
  )
    return null
  return v
}
/**
 * What the program page plays (the web's `lib/cloud/program/audio-routing.ts`).
 * `settings` is the routing the page follows: this computer's fresh packet, the
 * last one it accepted once the lease lapsed, or null (the defaults) before any
 * packet and after another host session took the seat without routing of its
 * own. A lapsed lease is never whole-program silence (wire contract 5.7).
 */
export function programAudioGains(settings: ProgramAudioSettings | null, takeover: boolean) {
  if (!settings)
    return {
      speech: takeover ? 0 : 1,
      auxiliary: takeover ? 0 : 1,
      reason: takeover ? 'legacy-takeover-silence' : null
    }
  const speech = takeover || settings.speechMuted ? 0 : settings.speechGain
  const auxiliary = settings.auxiliaryMuted ? 0 : settings.auxiliaryGain
  return {
    speech,
    auxiliary,
    reason: takeover
      ? 'takeover-speech-silence'
      : speech === 0 && auxiliary === 0
        ? 'operator-program-silence'
        : null
  }
}
