// Raw file:// subresource loads are blocked by the renderer origin, so every
// takeover card errored and read "Missing" while the upload sat safely in app
// storage. The managed videorc-asset://screen host serves the Screens dir by
// basename. Shared by the Assets cards and the talk show's Program monitor.
export function managedScreenAssetUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return `videorc-asset://screen/${encodeURIComponent(basename)}`
}
