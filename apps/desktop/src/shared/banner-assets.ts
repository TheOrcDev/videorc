// Banner image files (plan 186). The backend stores `<id>.png` and
// `<id>.thumb.png` in the managed `Banners` dir beside `Screens`; only those
// basenames reach a renderer, never a path. Main serves them under the
// `videorc-asset://banner/<file>` host (`resolveManagedBannerFile`). Pure: no
// fs or electron, so the rules are verified in node.

/** The managed protocol host for banner images. */
export const BANNER_ASSET_HOST = 'banner'
/** The backend-managed folder under userData, beside `Screens`. */
export const BANNERS_FOLDER = 'Banners'
/** Longest basename the wire contract carries for a banner file. */
export const BANNER_FILE_NAME_MAX_CHARS = 255

/** A bare basename: no separators, no parent hops, no leading dot. */
export function isBannerFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= BANNER_FILE_NAME_MAX_CHARS &&
    !value.startsWith('.') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  )
}

/**
 * The managed URL a renderer or the proof surface loads a banner image from:
 * `videorc-asset://banner/<basename>`. Takes the basename defensively, the way
 * takeover cards build `videorc-asset://screen/<file>`.
 */
export function bannerAssetUrl(file: string): string {
  const normalized = file.replace(/\\/g, '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return `videorc-asset://${BANNER_ASSET_HOST}/${encodeURIComponent(basename)}`
}
