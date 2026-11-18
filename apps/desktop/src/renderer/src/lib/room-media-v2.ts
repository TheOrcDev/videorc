import { parseAvatarCapability, type AvatarCapability } from '../../../shared/cloud-avatar'
import { parseSceneCapability, type SceneCapability } from '../../../shared/cloud-scene'
import {
  parseHtmlLayerCapability,
  type HtmlLayerCapability
} from '../../../shared/cloud-html-layer'
/** Plan 249 S3. An exact role, not arbitrary screen/system audio. */
export const ROOM_MEDIA_VERSION = 2 as const
export const AUX_TRACK_NAME = 'videorc:v2:host-aux:stereo'
export const CAPABILITY_TOPIC = 'videorc.media-capability.v2'
export const CAPABILITY_TTL_MS = 25_000
/**
 * A relayed receipt's byte bound. Plan 249 S11 raised it from 1024: a receipt
 * carrying graphics, scene, auxiliary and html fields can pass 1 KiB.
 */
export const CAPABILITY_RECEIPT_MAX_BYTES = 2048
export const ROOM_MEDIA_MANIFEST = {
  version: ROOM_MEDIA_VERSION,
  auxiliary: {
    name: AUX_TRACK_NAME,
    source: 'screen_share_audio',
    channels: 2,
    speechProcessing: false
  },
  audioRouting: { version: 1, takeover: 'speech-only', legacy: 'all-program-silence' },
  productionQualified: false
} as const
export type ConsumerCapability = {
  v: 2
  identity: string
  participantSid: string
  audioRouting?: 1
  graphics?: AvatarCapability
  /** Plan 249 S12: the egress lane draws scenes; `applied` is its rendered revision. */
  scene?: SceneCapability
  /** Plan 249 S11: relayed only for a lane whose page token holds the (default-off) claim. */
  html?: HtmlLayerCapability
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
  if (v.audioRouting !== undefined && (v.audioRouting !== 1 || !v.identity.startsWith('EG_')))
    return null
  const graphics = v.graphics === undefined ? null : parseAvatarCapability(v.graphics)
  if (v.graphics !== undefined && (!graphics || !graphicsLaneAllowed(v.identity, graphics)))
    return null
  const scene = v.scene === undefined ? null : parseSceneCapability(v.scene)
  if (v.scene !== undefined && (!scene || !v.identity.startsWith('EG_'))) return null
  const html = v.html === undefined ? null : parseHtmlLayerCapability(v.html)
  if (v.html !== undefined && (!html || !v.identity.startsWith('EG_'))) return null
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
    ...(v.audioRouting === 1 ? { audioRouting: 1 as const } : {}),
    ...(graphics ? { graphics } : {}),
    ...(scene ? { scene } : {}),
    ...(html ? { html } : {}),
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
type ConsumerRoom = { remoteParticipants: ReadonlyMap<string, { identity: string; sid: string }> }
/**
 * The session a host publisher may serve under `identity`, or ''. LiveKit
 * leaves `hidden` grants (program and recorder egress pages) out of
 * `remoteParticipants`, so a hidden `EG_` page is known by its fresh
 * server-relayed receipt: the web relays one only after RoomService confirms
 * that identity's current SID. A visible session always wins; a guest is
 * served only while visible.
 */
export function consumerSid(
  room: ConsumerRoom,
  identity: string,
  receipt: CapabilityReceipt | undefined,
  now: number
): string {
  const visible = room.remoteParticipants.get(identity)
  if (visible) return visible.sid
  return identity.startsWith('EG_') &&
    receipt &&
    capabilityCurrent(receipt, receipt.participantSid, now)
    ? receipt.participantSid
    : ''
}
/** Every visible participant, then each hidden `EG_` page with a fresh receipt. */
export function roomConsumers(
  room: ConsumerRoom,
  receipts: ReadonlyMap<string, CapabilityReceipt>,
  now: number
): { identity: string; sid: string }[] {
  const consumers = [...room.remoteParticipants.values()].map(({ identity, sid }) => ({
    identity,
    sid
  }))
  for (const [identity, receipt] of receipts)
    if (!room.remoteParticipants.has(identity) && consumerSid(room, identity, receipt, now))
      consumers.push({ identity, sid: receipt.participantSid })
  return consumers
}
