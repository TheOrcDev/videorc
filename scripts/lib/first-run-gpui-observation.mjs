// The GPUI app's `first-run-state` (apps/videorc, first_run/mod.rs
// `smoke_state`) as the observation `evaluateFirstRunSmokeStep` reads. The
// gate was written against Electron's renderer (`[data-first-run-*]`
// attributes and computed styles); this maps the same facts from the GPUI
// app's own state so one gate holds both apps. No browser, no filesystem.
//
// Not the same fact in both apps, and named so (the smoke reports each as a
// SKIP or in its header, never silently):
// - `pictureFilter` / `posterFilter` are CSS in Electron. The GPUI backdrop is
//   drawn from `Tone { inverse, shader_dim, brightness }`; the filters below
//   are that tone written as the CSS the gate expects (light: `invert(1)`,
//   under more contrast `invert(1) brightness(0.85)`; dark: the shader's Dim).
// - `sidebar` is false while setup is open: the GPUI setup is a full-window
//   overlay over the workspace, which stays mounted beneath it.
// - `canvasCount` is 1 while a backdrop player draws and 0 once it is gone
//   (reduced motion, setup closed): the player is the GPUI canvas.

export const GPUI_LIGHT_MORE_CONTRAST_BRIGHTNESS = 0.85

const parse = (raw) => {
  if (raw === null || raw === undefined) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

/** The tone as the CSS the gate expects, from the app's tone numbers. */
export function gpuiToneFacts(tone) {
  const light = tone.inverse === true
  const filter = (brightness) => `brightness(${brightness.toFixed(2)})`
  return {
    theme: light ? 'light' : 'dark',
    tone: light ? 'inverse' : 'normal',
    moreContrast: tone.increaseContrast === true,
    pictureFilter: light
      ? tone.brightness < 1
        ? `invert(1) brightness(${tone.brightness.toFixed(2)})`
        : 'invert(1)'
      : 'none',
    posterFilter: light ? 'none' : filter(1 - tone.shaderDim)
  }
}

/**
 * @param {object} fr `first-run-state`'s answer
 * @param {{recordRaw?: string|null, configRaw?: string|null, registryRaw?: string|null}} stored
 */
export function gpuiFirstRunObservation(fr, stored = {}) {
  const open = fr.open === true
  const tone = gpuiToneFacts(fr.tone)
  const backdrop = fr.backdrop ?? {}
  const rows = (fr.rows ?? []).map((row) => row.state)
  const record = parse(stored.recordRaw ?? fr.record)
  return {
    setup: open ? 'open' : null,
    mode: open ? fr.mode : null,
    cardStep: open ? fr.step : null,
    position: open ? `${fr.position}/${fr.count}` : undefined,
    rows,
    loading: open && fr.step === 'permissions' && fr.rowsReady !== true,
    sidebar: !open,
    primaryCount: fr.primary ? 1 : 0,
    primary: fr.primary ?? null,
    whatsNew: false,
    whatsNewOverSetup: false,
    workspaceBeforeSetup: false,
    setupEver: fr.openedEver === true,
    backdrop: open ? (backdrop.mode ?? null) : null,
    reason: backdrop.reason ?? null,
    look: open ? 'polished' : null,
    mountToMovingMs: backdrop.mountToMovingMs ?? null,
    canvasCount: backdrop.presentedFrames === null || backdrop.presentedFrames === undefined ? 0 : 1,
    retainedContextsLost: !open && (backdrop.presentedFrames ?? null) === null,
    theme: tone.theme,
    tone: open ? tone.tone : null,
    moreContrast: tone.moreContrast,
    pictureFilter: tone.pictureFilter,
    posterFilter: tone.posterFilter,
    layout: fr.look?.layoutPreset ?? undefined,
    background: fr.look?.liveBackground ?? undefined,
    goal: fr.goal ?? null,
    record,
    recordRaw: stored.recordRaw ?? fr.record ?? null,
    configRaw: stored.configRaw ?? null,
    config: parse(stored.configRaw),
    registryRaw: stored.registryRaw ?? null,
    registry: parse(stored.registryRaw),
    toasts: []
  }
}
