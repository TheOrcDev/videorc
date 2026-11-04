// The Chat window probe sizes the renderer, not the frame. On Windows a framed
// window's outer bounds include about 7 px of invisible resize border per
// side, so `setBounds({ width: 1280 })` leaves a 1266 px client (#1081). The
// probe asks for the outer width that gives the client it wants; on macOS the
// inset is 0 and the request is unchanged.

/** The window's client width from `comments-window-state`, falling back to its outer width. */
export function commentsWindowContentWidth(state) {
  return state?.contentBounds?.width ?? state?.bounds?.width
}

/** The outer width to request so the client area is `contentWidth` wide. */
export function commentsWindowFrameWidthFor(contentWidth, state) {
  const outer = state?.bounds?.width
  const content = state?.contentBounds?.width
  const inset = Number.isFinite(outer) && Number.isFinite(content) ? outer - content : 0
  return contentWidth + Math.max(0, inset)
}
