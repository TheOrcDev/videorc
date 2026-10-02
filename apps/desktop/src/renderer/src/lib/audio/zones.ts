import type { MeterZone, MeterZoneName } from '@/lib/audio/types'

/** Green below −20 dBFS, amber from −20, red from −9: the thresholds streamers know. */
export const DEFAULT_ZONES: MeterZone[] = [
  { fromDb: Number.NEGATIVE_INFINITY, zone: 'ok' },
  { fromDb: -20, zone: 'warn' },
  { fromDb: -9, zone: 'clip' }
]

/** A level at or above this counts as clipping for a clip light. */
export const CLIP_THRESHOLD_DB = -1
/** How long a clip light stays on after the last clip. */
export const CLIP_HOLD_MS = 1500

/** The zone a level falls in. */
export const zoneForDb = (db: number, zones: MeterZone[] = DEFAULT_ZONES): MeterZoneName => {
  let current: MeterZoneName = 'ok'
  for (const zone of zones) {
    if (db >= zone.fromDb) {
      current = zone.zone
    }
  }
  return current
}
