// The native preview probe's WebSocket wire rate, by event name.
//
// `smoke:preview-performance:native` gates the unfiltered WebSocket rate. A
// bare "85.8 KiB/s exceeded 80 KiB/s" says nothing about what grew; the tap
// counts the bytes each event name put on the wire, and this names the biggest
// ones (2026-11-28: diagnostics.stats was 69% of it, 136 messages of 13 KB).

/**
 * @param {Record<string, number>} eventBytes bytes per event name
 * @param {Record<string, number>} eventCounts messages per event name
 * @param {number} seconds the measured window
 * @param {number} [top] how many events to name
 * @returns {{event:string, kibPerSecond:number, share:number, count:number, averageBytes:number}[]}
 */
export function wireRateByEvent(eventBytes, eventCounts, seconds, top = 3) {
  const total = Object.values(eventBytes ?? {}).reduce((sum, bytes) => sum + bytes, 0)
  if (!(total > 0) || !(seconds > 0)) return []
  return Object.entries(eventBytes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, top)
    .map(([event, bytes]) => {
      const count = eventCounts?.[event] ?? 0
      return {
        event,
        kibPerSecond: bytes / seconds / 1024,
        share: bytes / total,
        count,
        averageBytes: count > 0 ? Math.round(bytes / count) : bytes
      }
    })
}

/** "diagnostics.stats 58.8 KiB/s (69%, 136 x 13390 B); ..." or "" with nothing counted. */
export function describeWireRateByEvent(eventBytes, eventCounts, seconds, top = 3) {
  return wireRateByEvent(eventBytes, eventCounts, seconds, top)
    .map(
      (row) =>
        `${row.event} ${row.kibPerSecond.toFixed(1)} KiB/s ` +
        `(${Math.round(row.share * 100)}%, ${row.count} x ${row.averageBytes} B)`
    )
    .join('; ')
}
