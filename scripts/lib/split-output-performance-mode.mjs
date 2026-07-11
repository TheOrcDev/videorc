export function splitOutputPreviewSurfaceDisabled(env = process.env) {
  if (env.VIDEORC_PERF_REPORT_PATH) return '0'
  return env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE ?? '1'
}
