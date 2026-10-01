// Pure gates for smoke-windows-main-window-recovery.mjs (plan 082).

export const WINDOWS_MICA_MIN_BUILD = 22621

/** The build from an os.release() string such as `10.0.26100`. */
export function windowsBuildFromRelease(release) {
  const build = Number.parseInt(String(release ?? '').split('.')[2] ?? '', 10)
  return Number.isFinite(build) ? build : undefined
}

function glassText(glass) {
  return glass ? `${glass.kind}/${glass.reason ?? 'none'}/${glass.paintCheck}` : 'missing'
}

/** A normal launch: the page mounts, and a Mica window's paint check says painted. */
export function evaluateDefaultLaunch({ mounted, glass, osRelease }) {
  const failures = []
  if (!mounted) failures.push('the main window never mounted its UI')
  if (!glass) {
    failures.push('runtime info carries no windowGlass')
    return failures
  }
  const micaExpected = (windowsBuildFromRelease(osRelease) ?? 0) >= WINDOWS_MICA_MIN_BUILD
  if (micaExpected && glass.kind !== 'mica') {
    failures.push(`expected the Mica window on build ${osRelease}, got ${glassText(glass)}`)
  }
  if (!micaExpected && glass.kind !== 'solid') {
    failures.push(`expected the solid window on build ${osRelease}, got ${glassText(glass)}`)
  }
  if (glass.kind === 'mica' && glass.paintCheck !== 'painted') {
    failures.push(`the Mica paint check did not report painted: ${glassText(glass)}`)
  }
  return failures
}

/** After the renderer is crashed on purpose: the UI is back and the log says why. */
export function evaluateCrashRecovery({ crashed, remounted, log }) {
  const failures = []
  if (!crashed) failures.push('the renderer could not be crashed, so recovery was not exercised')
  if (!remounted) failures.push('the main window did not remount its UI after its renderer died')
  if (!/Renderer process gone \(/.test(log ?? '')) {
    failures.push('backend.log has no "Renderer process gone" line')
  }
  if (!/Reloading the main window: its renderer process is gone/.test(log ?? '')) {
    failures.push('backend.log has no "Reloading the main window" line')
  }
  return failures
}

/** Software rendering must never get the transparent-backed Mica window. */
export function evaluateSoftwareRenderingLaunch({ mounted, glass, osRelease, softwareRendering }) {
  const failures = []
  if (!mounted) failures.push('the main window never mounted its UI under software rendering')
  if (softwareRendering !== true) failures.push('runtime info does not report software rendering')
  const micaCapable = (windowsBuildFromRelease(osRelease) ?? 0) >= WINDOWS_MICA_MIN_BUILD
  const expectedReason = micaCapable ? 'software-rendering' : 'platform'
  if (glass?.kind !== 'solid' || glass.reason !== expectedReason) {
    failures.push(`expected solid/${expectedReason}, got ${glassText(glass)}`)
  }
  return failures
}

/** A blank paint verdict drops Mica now, and the next launch starts solid. */
export function evaluateBlankFallback({ mounted, glass, stateFileExists, log }) {
  const failures = []
  if (!mounted) failures.push('the main window lost its UI during the Mica fallback')
  if (glass?.kind !== 'solid' || glass.reason !== 'paint-check-blank') {
    failures.push(`expected solid/paint-check-blank, got ${glassText(glass)}`)
  }
  if (glass?.paintCheck !== 'blank') {
    failures.push(`expected the paint check to report blank, got ${glassText(glass)}`)
  }
  if (!stateFileExists) failures.push('window-glass-fallback.json was not written')
  if (!/drew nothing on the Mica backdrop/.test(log ?? '')) {
    failures.push('backend.log has no Mica fallback line')
  }
  return failures
}

export function evaluateRememberedFallback({ mounted, glass }) {
  const failures = []
  if (!mounted) failures.push('the main window never mounted its UI on the remembered solid window')
  if (glass?.kind !== 'solid' || glass.reason !== 'paint-check-blank') {
    failures.push(`the next launch did not start solid: ${glassText(glass)}`)
  }
  return failures
}
