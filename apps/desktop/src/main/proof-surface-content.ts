// What the Electron proof surface's page draws of its own (plan 238 S1).
// Until its first real frame the surface paints nothing: the page has no
// backdrop, and where the surface is a view inside the app window its base
// colour is clear too, so the stage's own startup card shows through. The page
// has no IPC; like the live-background status (plan 190) it reports each
// change as one prefixed console line. Pure: main/index.ts owns the surface.

/** The line the surface prints when it starts drawing pixels of its own. */
export const PROOF_SURFACE_CONTENT_LIVE_LINE = '[proof-preview] content live'

/** The line the surface prints when it stops drawing pixels of its own. */
export const PROOF_SURFACE_CONTENT_NONE_LINE = '[proof-preview] content none'

/**
 * Whether the surface's page has content, from one console line: true for
 * `content live`, false for `content none`, null for every other line.
 */
export function proofSurfaceContentFromConsoleLine(line: string): boolean | null {
  if (line === PROOF_SURFACE_CONTENT_LIVE_LINE) return true
  if (line === PROOF_SURFACE_CONTENT_NONE_LINE) return false
  return null
}

/** The base under the page's pixels: what shows around a stage that does not fill the view. */
export const PROOF_SURFACE_VIEW_BASE = '#101014'

/** No base: the stage under the view shows through. */
export const PROOF_SURFACE_VIEW_CLEAR = '#00000000'

/**
 * The in-window view's background colour. Opaque only while the page has
 * content; a view with nothing to draw must not cover the stage's card with a
 * dark box.
 */
export function proofSurfaceViewBackground(contentLive: boolean): string {
  return contentLive ? PROOF_SURFACE_VIEW_BASE : PROOF_SURFACE_VIEW_CLEAR
}

/**
 * Browser-side glue for the proof document, in the same scope as its layer
 * code.
 *
 * Content is a source layer whose image is live (a decoded frame, a picture,
 * the test pattern) or a live background whose canvas has drawn: the canvas
 * can draw before its poster decodes, or without it. Banners and the Buddy are
 * overlays and never count. Neither does a live compositor: on macOS the
 * native layer presents its pixels, not this page.
 *
 * Expects in scope: `document`, `console`, `layers` (entries shaped
 * `{ image }`) and `liveBackgrounds` (entries shaped `{ canvas }`).
 */
export const PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT = String.raw`
let proofSurfaceContentLive = false;

function proofSurfaceHasContent() {
  for (const entry of layers.values()) {
    if (entry.image?.dataset.live === '1') {
      return true;
    }
  }
  for (const live of liveBackgrounds.values()) {
    if (live.canvas?.dataset.drawn === '1') {
      return true;
    }
  }
  return false;
}

/** One console line per change (and the DOM for probes). None at load: the page starts with none. */
function publishProofSurfaceContent() {
  const next = proofSurfaceHasContent();
  if (next === proofSurfaceContentLive) {
    return;
  }
  proofSurfaceContentLive = next;
  document.body.dataset.proofContent = next ? 'live' : 'none';
  console.info('[proof-preview] content ' + (next ? 'live' : 'none'));
}
`
