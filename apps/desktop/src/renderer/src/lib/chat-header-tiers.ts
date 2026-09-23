// The Chat window header is a CSS container (`@container/chat-header`), sized
// to its content box: the window width minus the 88px traffic-light gutter and
// the 12px right gutter. Three tiers, measured by probe:comments-window:
//   Full    ≥ 460px — today's layout, every control inline.
//   Compact < 460px — highlight position, keep on top and Clear view fold
//                     into one ⋯ menu.
//   Tight   < 330px — the viewer chip keeps only its number, Orcle only its
//                     dot. The viewer count is NEVER hidden while live.
// Class strings stay literal so Tailwind's scanner generates them.
export const CHAT_HEADER_CONTAINER = '@container/chat-header'
/** Visible in Full only. */
export const CHAT_HEADER_FULL_ONLY = '@max-[460px]/chat-header:hidden'
/** Visible below Full only (the ⋯ menu trigger). */
export const CHAT_HEADER_COMPACT_ONLY = 'hidden @max-[460px]/chat-header:inline-flex'
/** Text that leaves the eye (but not the screen reader) in the Tight tier. */
export const CHAT_HEADER_TIGHT_SR_ONLY = '@max-[330px]/chat-header:sr-only'
/** Decoration that disappears in the Tight tier. */
export const CHAT_HEADER_TIGHT_HIDDEN = '@max-[330px]/chat-header:hidden'
/** Keeps its box (a spacer) but not its text in the Tight tier. */
export const CHAT_HEADER_TIGHT_INVISIBLE = '@max-[330px]/chat-header:invisible'
