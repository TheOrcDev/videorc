import { parseAvatarCapability, type AvatarCapability } from '../../../shared/cloud-avatar'
/** Plan 249 S3. An exact role, not arbitrary screen/system audio. */
export const ROOM_MEDIA_VERSION = 2 as const
export const AUX_TRACK_NAME = 'videorc:v2:host-aux:stereo'
export const CAPABILITY_TOPIC = 'videorc.media-capability.v2'
export const CAPABILITY_TTL_MS = 25_000
export const ROOM_MEDIA_MANIFEST = {
  version: ROOM_MEDIA_VERSION,
  auxiliary: {
    name: AUX_TRACK_NAME,
    source: 'screen_share_audio',
    channels: 2,
    speechProcessing: false
  },
  productionQualified: false
} as const
export type ConsumerCapability = {
  v: 2
  identity: string
  participantSid: string
  graphics?: AvatarCapability
  auxiliary?: { trackSid: string; rms: number; observedAt: number }
}
export type CapabilityReceipt = ConsumerCapability & { at: number }
/**
 * Plan 249 S6 (D4): the one graphics lane a guest page may advertise. Guests
 * see what the stream shows in landscape, never a recording-only layer.
 */
export const GUEST_GRAPHICS_LANE = { output: 'stream', orientation: 'h' } as const
/** An egress takes its token's lane; a guest only the guest lane. */
export function graphicsLaneAllowed(
  identity: string,
  graphics: Pick<AvatarCapability, 'output' | 'orientation'>
): boolean {
  if (identity.startsWith('EG_')) return true
  return (
    identity.startsWith('g_') &&
    graphics.output === GUEST_GRAPHICS_LANE.output &&
    graphics.orientation === GUEST_GRAPHICS_LANE.orientation
  )
}
export function parseConsumerCapability(value: unknown): ConsumerCapability | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (
    v.v !== 2 ||
    typeof v.identity !== 'string' ||
    !/^(g_|EG_)[A-Za-z0-9_-]{1,128}$/.test(v.identity) ||
    typeof v.participantSid !== 'string' ||
    !/^PA_[A-Za-z0-9]{1,64}$/.test(v.participantSid)
  )
    return null
  const graphics = v.graphics === undefined ? null : parseAvatarCapability(v.graphics)
  if (v.graphics !== undefined && (!graphics || !graphicsLaneAllowed(v.identity, graphics)))
    return null
  let auxiliary: ConsumerCapability['auxiliary']
  if (v.auxiliary !== undefined) {
    if (!v.auxiliary || typeof v.auxiliary !== 'object') return null
    const a = v.auxiliary as Record<string, unknown>
    if (
      typeof a.trackSid !== 'string' ||
      !/^TR_[A-Za-z0-9]{1,64}$/.test(a.trackSid) ||
      typeof a.rms !== 'number' ||
      !Number.isFinite(a.rms) ||
      a.rms <= 0 ||
      a.rms > 1 ||
      typeof a.observedAt !== 'number' ||
      !Number.isSafeInteger(a.observedAt) ||
      a.observedAt <= 0
    )
      return null
    auxiliary = { trackSid: a.trackSid, rms: a.rms, observedAt: a.observedAt }
  }
  return {
    v: 2,
    identity: v.identity,
    participantSid: v.participantSid,
    ...(graphics ? { graphics } : {}),
    ...(auxiliary ? { auxiliary } : {})
  }
}
export function auxiliaryRole(
  identity: string,
  show: string,
  source: string,
  name: string
): boolean {
  return identity === `host:${show}` && source === 'screen_share_audio' && name === AUX_TRACK_NAME
}
export function capabilityCurrent(
  receipt: CapabilityReceipt | undefined,
  sid: string,
  now: number
): boolean {
  return (
    !!receipt &&
    receipt.participantSid === sid &&
    receipt.at <= now + 1000 &&
    now - receipt.at < CAPABILITY_TTL_MS
  )
}
