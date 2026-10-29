/**
 * The proof surface's stage: the canvas fitted ("contain") and centred in the
 * surface window (B3, retest 154).
 *
 * Main keeps the Preview window at the canvas aspect, but a tiling window
 * manager (Hyprland tiles the Preview by default; Windows snap) ignores the
 * aspect lock, so the window can be any shape. Layers are placed in percent of
 * #scene-root; a root that filled a 16:9 tile stretched a 9:16 canvas over it.
 * The stage keeps the canvas shape and leaves bars outside it, so layer
 * percentages map uniformly again.
 *
 * Kept as one executable snippet, like the poller runtime, so the Node test
 * runs the same code Electron evaluates inside the surface page.
 */
export const PREVIEW_SURFACE_STAGE_RUNTIME_SCRIPT = String.raw`
// The stage rect in window pixels, or null when the stage is the whole window:
// an equal aspect (within a pixel of rounding), or no usable canvas or window
// size. Null keeps today's full-window root, pixel for pixel.
function previewSurfaceStageRect(windowWidth, windowHeight, canvasWidth, canvasHeight) {
  const usable = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!usable(windowWidth) || !usable(windowHeight) || !usable(canvasWidth) || !usable(canvasHeight)) {
    return null;
  }
  const scale = Math.min(windowWidth / canvasWidth, windowHeight / canvasHeight);
  const width = canvasWidth * scale;
  const height = canvasHeight * scale;
  if (windowWidth - width < 1 && windowHeight - height < 1) {
    return null;
  }
  const roundedWidth = Math.max(1, Math.round(width));
  const roundedHeight = Math.max(1, Math.round(height));
  return {
    left: Math.floor((windowWidth - roundedWidth) / 2),
    top: Math.floor((windowHeight - roundedHeight) / 2),
    width: roundedWidth,
    height: roundedHeight
  };
}
`
