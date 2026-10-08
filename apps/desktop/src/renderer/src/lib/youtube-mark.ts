import youtubeIconUrl from '../assets/brand/youtube/youtube-icon-red.svg'

// YouTube's official icon (plan 165, Google's ToS report III.F.2a): the file,
// its geometry and the 20 px floor, shared by the React mark (`YoutubeIcon`)
// and the on-stream highlight card. See assets/brand/youtube/README.md.

/** The official full-colour icon, unmodified (Vite inlines it as a data URI). */
export const YOUTUBE_ICON_URL: string = youtubeIconUrl

/** The mark is never drawn shorter than this (YouTube Branding Guidelines:
 * the icon's height "should never be smaller than 20dp"). */
export const YOUTUBE_MARK_MIN_PX = 20

/** The official file's artboard, which includes YouTube's clear space. */
export const YOUTUBE_ARTBOARD = { width: 602.187, height: 515.868 } as const

/** The red mark's bounds inside the artboard, in the file's own units. */
export const YOUTUBE_MARK = { x: 102.6875, y: 119.167969, width: 396, height: 277.402343 } as const

/** Width over height of the visible mark (about 1.43). */
export const YOUTUBE_MARK_ASPECT = YOUTUBE_MARK.width / YOUTUBE_MARK.height
