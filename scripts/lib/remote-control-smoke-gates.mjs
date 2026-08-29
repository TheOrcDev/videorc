export function syntheticCompositorReady(compositor, before = {}) {
  const sameRun =
    typeof compositor?.runId === 'string' &&
    compositor.runId.length > 0 &&
    compositor.runId === before?.runId
  const frameAdvanced = sameRun
    ? (compositor.framesRendered ?? 0) > (before?.framesRendered ?? 0)
    : (compositor?.framesRendered ?? 0) > 0

  return Boolean(
    compositor?.state === 'live' &&
    frameAdvanced &&
    compositor.sceneRevision != null &&
    compositor.frameSceneRevision === compositor.sceneRevision &&
    compositor.sceneSources?.some(
      (source) => source?.id === 'source:test-pattern' || source?.kind === 'test-pattern'
    )
  )
}
