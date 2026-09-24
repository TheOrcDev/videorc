// Orcle's status control sits in a CSS container (`@container/chat-header`):
// the Stream Manager's Orcle pane header (plan 055, D5). Below 330 px of
// header it keeps only its dot and a screen-reader label, so the row never
// clips at the window's 320 px minimum.
// Class strings stay literal so Tailwind's scanner generates them.
export const CHAT_HEADER_CONTAINER = '@container/chat-header'
/** Text that leaves the eye (but not the screen reader) in the Tight tier. */
export const CHAT_HEADER_TIGHT_SR_ONLY = '@max-[330px]/chat-header:sr-only'
/** Decoration that disappears in the Tight tier. */
export const CHAT_HEADER_TIGHT_HIDDEN = '@max-[330px]/chat-header:hidden'
