// Plan 232 S11: what `pnpm smoke:html-overlay` streams on each platform.
// HTML banners draw on macOS, Windows and Linux, so the smoke runs on all
// three. Linux streams the horizontal leg alone, as `smoke:banners` does:
// it has no vertical simulcast leg. macOS and Windows stream both, the
// vertical one being the auxiliary leg the banner leg plan must carry.

/** The stream receivers' orientations, in order, for `platform`. */
export function htmlOverlaySmokeStreamOrientations(platform) {
  return platform === 'linux' ? ['horizontal'] : ['horizontal', 'vertical']
}
