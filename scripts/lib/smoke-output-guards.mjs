const PREVIEW_SURFACE_ERROR_PATTERNS = [
  "Error occurred in handler for 'preview-surface:",
  'Native preview compositor present failed:'
]

export function createPreviewSurfaceOutputGuard() {
  const failures = []
  return {
    inspectLine(line) {
      if (PREVIEW_SURFACE_ERROR_PATTERNS.some((pattern) => line.includes(pattern))) {
        failures.push(line.trim())
      }
    },
    assertClean() {
      if (failures.length === 0) {
        return
      }
      throw new Error(`Preview surface host emitted handler error(s): ${failures.join(' | ')}`)
    }
  }
}
