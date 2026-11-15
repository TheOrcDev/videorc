// Plan 238: what the Preview says while it starts. Until the first real frame
// no preview surface paints anything of its own (S1); the stage under it
// (the Studio slot's card, the floating Preview window's hint) shows these
// steps instead. Every step comes from real state, never from a timer:
//
//   1. the capture engine (the backend) is not connected yet,
//   2. a source the scene uses has not sent a picture yet,
//   3. the sources are live and the first frame is on its way.
//
// Pure and shared: the renderer's card and main's floating-window hint say
// the same words.

export type PreviewStartupStep = 1 | 2 | 3

export const PREVIEW_STARTUP_STEPS: readonly PreviewStartupStep[] = [1, 2, 3]

export const PREVIEW_STARTUP_TITLE = 'Starting the preview'

/** How long one step may run before the card says what is stuck (D3 a). */
export const PREVIEW_STARTUP_STALL_MS = 20_000

export type PreviewStartupSourceKind = 'screen' | 'camera'

/** A source the scene uses, and whether it has sent a picture yet. */
export interface PreviewStartupSource {
  kind: PreviewStartupSourceKind
  /** The name the Studio shows for it ("LG HDR 4K", "ZV-E10M2"), if known. */
  name: string | null
  live: boolean
  /**
   * It cannot send a picture until something changes (device missing, access
   * needed, failed): the card says so at once instead of after the stall.
   */
  blocked?: boolean
}

export interface PreviewStartupInput {
  engineConnected: boolean
  /** Only the sources the scene uses. */
  sources: readonly PreviewStartupSource[]
  /** The current step has run past `PREVIEW_STARTUP_STALL_MS`. */
  stalled: boolean
}

/** The one fix a stalled step offers, if any. */
export type PreviewStartupAction = 'open-sources'

export interface PreviewStartupView {
  step: PreviewStartupStep
  title: string
  detail: string
  stalled: boolean
  action: PreviewStartupAction | null
}

export function previewStartupStep(
  engineConnected: boolean,
  sources: readonly PreviewStartupSource[]
): PreviewStartupStep {
  if (!engineConnected) {
    return 1
  }
  return sources.some((source) => !source.live) ? 2 : 3
}

/**
 * The name to say for a source: the Studio's name without any " · " detail
 * after it, or the kind in plain words.
 */
export function previewStartupSourceName(source: PreviewStartupSource): string {
  return shownName(source) ?? (source.kind === 'screen' ? 'your screen' : 'your camera')
}

function shownName(source: PreviewStartupSource): string | null {
  return source.name?.split(' · ')[0]?.trim() || null
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? ''
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** "LG HDR 4K and ZV-E10M2"; two unnamed sources read "your screen and camera". */
function sourceNames(sources: readonly PreviewStartupSource[]): string {
  const unnamed = sources.every((source) => shownName(source) === null)
  if (unnamed && sources.length === 2 && sources[0].kind !== sources[1].kind) {
    return 'your screen and camera'
  }
  return joinNames(sources.map(previewStartupSourceName))
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function previewStartupView(input: PreviewStartupInput): PreviewStartupView {
  const step = previewStartupStep(input.engineConnected, input.sources)
  const stalled = input.stalled
  if (step === 1) {
    return {
      step,
      title: PREVIEW_STARTUP_TITLE,
      detail: stalled
        ? 'The capture engine is taking longer than usual.'
        : 'Waiting for the capture engine',
      stalled,
      action: null
    }
  }
  if (step === 2) {
    const waiting = input.sources.filter((source) => !source.live)
    const names = sourceNames(waiting)
    const stuck = stalled || waiting.some((source) => source.blocked === true)
    return {
      step,
      title: PREVIEW_STARTUP_TITLE,
      detail: stuck
        ? `${capitalize(names)} ${waiting.length > 1 ? 'haven’t' : 'hasn’t'} sent a picture yet.`
        : `Connecting ${names}`,
      stalled: stuck,
      action: stuck ? 'open-sources' : null
    }
  }
  return {
    step,
    title: PREVIEW_STARTUP_TITLE,
    detail: stalled ? 'The first frame is taking longer than usual.' : 'Drawing the first frame',
    stalled,
    action: null
  }
}
