// Plan 238 S3: the floating Preview window's waiting hint says the same
// startup steps as the Studio's card (shared/preview-startup.ts). Main has
// no device names, so it reads the sources from the compositor status and
// names them by kind ("Connecting your screen and camera").
//
// Pure: index.ts owns the window, the watchdog tick and the clock's state.

import type { CompositorStatus } from '../shared/backend'
import {
  PREVIEW_STARTUP_STALL_MS,
  PREVIEW_STARTUP_STEPS,
  type PreviewStartupSource,
  type PreviewStartupStep,
  previewStartupStep,
  previewStartupView
} from '../shared/preview-startup'
import { DARK_WINDOW_PALETTE } from './window-palette'

/** What the hint shows: the startup steps, or a warning with no steps. */
export interface PreviewWindowHint {
  title: string
  detail: string
  /** The step running, or null for a warning (no segments). */
  step: PreviewStartupStep | null
  stalled: boolean
}

/** The title over a warning reason (a fallback or a stall the watchdog declared). */
export const PREVIEW_WINDOW_WARNING_TITLE = 'Preview isn’t showing'

export function previewWindowWarningHint(detail: string): PreviewWindowHint {
  return { title: PREVIEW_WINDOW_WARNING_TITLE, detail, step: null, stalled: false }
}

/** When the step on screen began, so a step that runs too long can say so. */
export interface PreviewStartupClock {
  step: PreviewStartupStep
  startedAtMs: number
}

const BLOCKED_SOURCE_STATES: ReadonlySet<string> = new Set([
  'permission-needed',
  'source-missing',
  'device-missing',
  'failed'
])

/** The compositor's screen/window and camera, with whether each is live. */
export function compositorStartupSources(
  compositor: Pick<CompositorStatus, 'sources'> | null
): PreviewStartupSource[] {
  return (compositor?.sources ?? []).map((source) => ({
    kind: source.kind === 'camera' ? 'camera' : 'screen',
    name: null,
    live: source.state === 'live',
    blocked: BLOCKED_SOURCE_STATES.has(source.state)
  }))
}

/**
 * The startup hint for this moment and the clock to keep. A compositor that
 * did not answer (`null`) is step 1, like a backend not connected yet; a
 * status not read yet (`undefined`) trusts the connection and knows no
 * sources.
 */
export function previewWindowStartupHint(input: {
  backendConnected: boolean
  compositor: Pick<CompositorStatus, 'sources'> | null | undefined
  clock: PreviewStartupClock | null
  nowMs: number
}): { hint: PreviewWindowHint; clock: PreviewStartupClock } {
  const engineConnected = input.backendConnected && input.compositor !== null
  const sources = engineConnected ? compositorStartupSources(input.compositor ?? null) : []
  const step = previewStartupStep(engineConnected, sources)
  const clock =
    input.clock && input.clock.step === step ? input.clock : { step, startedAtMs: input.nowMs }
  const view = previewStartupView({
    engineConnected,
    sources,
    stalled: input.nowMs - clock.startedAtMs >= PREVIEW_STARTUP_STALL_MS
  })
  return {
    hint: { title: view.title, detail: view.detail, step: view.step, stalled: view.stalled },
    clock
  }
}

type SegmentState = 'done' | 'current' | 'stalled' | 'next'

export function previewWindowSegmentStates(hint: PreviewWindowHint): SegmentState[] {
  return PREVIEW_STARTUP_STEPS.map((segment) => {
    if (hint.step === null || segment > hint.step) {
      return 'next'
    }
    if (segment < hint.step) {
      return 'done'
    }
    return hint.stalled ? 'stalled' : 'current'
  })
}

/**
 * The hint the window's document opens with: step 1 before the backend is
 * connected, otherwise the first frame (the watchdog's first tick refines it).
 */
export function previewWindowInitialHint(backendConnected: boolean): PreviewWindowHint {
  return previewWindowStartupHint({
    backendConnected,
    compositor: undefined,
    clock: null,
    nowMs: 0
  }).hint
}

/** The hint's first paint before main knows anything: step 1. */
export const PREVIEW_WINDOW_INITIAL_HINT: PreviewWindowHint = previewWindowInitialHint(false)

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The hint's markup: title, the step in words, and the three segments
 * (hidden for a warning).
 */
export function previewWindowHintHtml(hint: PreviewWindowHint): string {
  const segments = previewWindowSegmentStates(hint)
    .map((state, index) => `<span data-step="${index + 1}" data-state="${state}"></span>`)
    .join('')
  return [
    `<div class="title">${escapeHtml(hint.title)}</div>`,
    `<div id="videorc-wait-detail">${escapeHtml(hint.detail)}</div>`,
    `<div class="steps"${hint.step === null ? ' hidden' : ''} aria-hidden="true">${segments}</div>`
  ].join('')
}

/**
 * The segments' CSS, from the dark palette (the Preview frame is dark in
 * both themes). The running step breathes on opacity alone, like the
 * Studio card's; reduced motion rests it at 60%.
 */
export const PREVIEW_WINDOW_STEPS_CSS = `
  .steps { display: flex; gap: 6px; margin-top: 6px; }
  .steps[hidden] { display: none; }
  .steps span { position: relative; width: 40px; height: 2px; border-radius: 999px;
    overflow: hidden; background: ${DARK_WINDOW_PALETTE.controlBg}; }
  .steps span::after { content: ''; position: absolute; inset: 0;
    background: ${DARK_WINDOW_PALETTE.textPrimary}; opacity: 0; }
  .steps span[data-state="done"]::after { opacity: 1; }
  .steps span[data-state="current"]::after { opacity: 0.6;
    animation: steps-breathe 1.2s ease-in-out infinite alternate; }
  .steps span[data-state="stalled"]::after { opacity: 0.6; }
  @keyframes steps-breathe { from { opacity: 0.3; } to { opacity: 0.7; } }
  @media (prefers-reduced-motion: reduce) {
    .steps span[data-state="current"]::after { animation: none; }
  }
`

/**
 * The script that repaints the hint in place: `null` hides the whole `.hint`
 * block (plan 024 S4: a z-order flash then uncovers only the solid base,
 * never the words).
 */
export function previewWindowHintScript(hint: PreviewWindowHint | null): string {
  if (hint === null) {
    return `(() => {
      const hint = document.querySelector('.hint');
      if (hint) { hint.style.display = 'none'; }
    })()`
  }
  return `(() => {
    const hint = document.querySelector('.hint');
    if (!hint) { return; }
    hint.innerHTML = ${JSON.stringify(previewWindowHintHtml(hint))};
    hint.style.display = 'flex';
  })()`
}
