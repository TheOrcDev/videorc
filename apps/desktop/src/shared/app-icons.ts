/**
 * App icons for New scene… and the scene list (plan 210 S4/S5). Main reads
 * each app's icon from its bundle and caches it per bundle id; the renderer
 * draws a generic glyph for any app it leaves out.
 */
export interface AppIconsApi {
  /** PNG data URLs (`data:image/png;base64,…`) by bundle id. */
  getAppIcons(bundleIds: string[]): Promise<Record<string, string>>
}

/** At most this many ids per call: one picker's worth of apps. */
export const APP_ICONS_MAX_IDS = 64

// Kept out of the backend/RPC-owned declaration file, like the front app.
declare module './backend' {
  // Module augmentation adds the separately owned icon API.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface VideorcApi extends AppIconsApi {}
}
