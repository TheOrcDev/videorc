/**
 * Which Windows media path a Record ran on (#1267), read from a
 * `diagnostics.stats` snapshot taken while it records.
 *
 * - `d3d11`: the unified D3D11 capture/compositor/Media Foundation authority
 *   is live; its encoder is built by the media thread.
 * - `cpu-compositor`: the D3D11 authority is not live; frames come from the
 *   CPU compositor through the Media Foundation encoded bridge.
 * - `null`: no snapshot, or a platform without the D3D11 diagnostics.
 */
export function windowsMediaPathFrom(diagnostics) {
  const media = diagnostics?.windowsD3d11Media
  if (!media || typeof media.state !== 'string') return { path: null, state: null }
  return {
    path: media.state === 'live' ? 'd3d11' : 'cpu-compositor',
    state: media.state
  }
}

/** Counts each path over the measured cycles, for the run summary line. */
export function summarizeWindowsMediaPaths(cycles) {
  const counts = { d3d11: 0, 'cpu-compositor': 0, unknown: 0 }
  for (const cycle of cycles) {
    const path = cycle?.windowsMediaPath?.path
    if (path === 'd3d11' || path === 'cpu-compositor') counts[path] += 1
    else counts.unknown += 1
  }
  return counts
}
