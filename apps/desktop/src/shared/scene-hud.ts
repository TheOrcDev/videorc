import type { StreamManagerHideMethod } from './backend'

/**
 * The key HUD (plan 231 D20): when a key, the Stream Deck or the phone
 * switches the scene while no Videorc window is in front, a small chip names
 * the scene for a moment, off stream. Shared by main, the Studio renderer and
 * the HUD's own window.
 */

/** How long the chip holds before it fades. */
export const SCENE_HUD_HOLD_MS = 900
/** The fade: opacity only, no movement. Reduced motion skips it. */
export const SCENE_HUD_FADE_MS = 120
/** A scene's name is at most 80 characters (`uniqueSceneName`). */
export const SCENE_HUD_NAME_MAX_CHARS = 80
export const SCENE_HUD_REFUSAL_MAX_CHARS = 240
export const SCENE_HUD_KEY_MAX_CHARS = 128

/** What the scene shows, as its card draws it: the app's own icon or a glyph. */
export type SceneHudIcon =
  | { kind: 'app'; bundleId: string }
  | { kind: 'display' }
  | { kind: 'window' }
  | { kind: 'camera' }

/** The Studio's one message to main per switch. */
export interface SceneHudRequest {
  name: string
  icon: SceneHudIcon
  /** The key as an Electron accelerator, drawn by `ShortcutKeys`. */
  key?: string
  /** Why the switch didn't happen ("Figma isn't open"). */
  refusal?: string
}

/** What main hands the HUD window: the request, with the app's icon read. */
export interface SceneHudPresentation extends SceneHudRequest {
  /** Counts up per show, so a second switch replaces the first. */
  sequence: number
  iconDataUrl?: string
  platform: string
  /** Smoke only (screenshots): hold this long instead of 900 ms. */
  holdMs?: number
}

/**
 * The HUD window as the Studio needs to know it (main owns it). On macOS the
 * window stays on screen, fully transparent, so Videorc's ScreenCaptureKit
 * filter can find it by `windowId` (the filter only sees windows on screen).
 * On Windows `ready` means content protection held.
 */
export interface SceneHudWindowState {
  enabled: boolean
  method: StreamManagerHideMethod
  windowId?: number
  ready: boolean
}

export type SceneHudSkipReason =
  | 'disabled'
  | 'unsupported'
  | 'not-ready'
  | 'videorc-in-front'
  | 'invalid'

export type SceneHudShowResult = { shown: true } | { shown: false; reason: SceneHudSkipReason }

const BUNDLE_ID_PATTERN = /^[\w-]+(?:\.[\w-]+)+$/

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : undefined
}

/** Pure. The HUD's icon from anything, or null. */
export function sceneHudIcon(value: unknown): SceneHudIcon | null {
  if (!value || typeof value !== 'object') return null
  const icon = value as { kind?: unknown; bundleId?: unknown }
  if (icon.kind === 'display' || icon.kind === 'window' || icon.kind === 'camera') {
    return { kind: icon.kind }
  }
  if (
    icon.kind === 'app' &&
    typeof icon.bundleId === 'string' &&
    icon.bundleId.length <= 512 &&
    BUNDLE_ID_PATTERN.test(icon.bundleId)
  ) {
    return { kind: 'app', bundleId: icon.bundleId }
  }
  return null
}

/**
 * Pure. A request main can trust, or null: a name, a known icon, and the
 * key and refusal only when they are words. Main validates what the
 * renderer sends before it draws anything.
 */
export function sceneHudRequest(value: unknown): SceneHudRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = boundedText(raw.name, SCENE_HUD_NAME_MAX_CHARS)
  const icon = sceneHudIcon(raw.icon)
  if (!name || !icon) return null
  const key = boundedText(raw.key, SCENE_HUD_KEY_MAX_CHARS)
  const refusal = boundedText(raw.refusal, SCENE_HUD_REFUSAL_MAX_CHARS)
  return { name, icon, ...(key ? { key } : {}), ...(refusal ? { refusal } : {}) }
}

/**
 * Pure. The words on the chip: the scene's name, or for a refusal its words.
 * A refusal that already names the scene ("Figma isn't open") stands alone;
 * one that doesn't follows the name ("Camera only · Turn the camera on").
 */
export function sceneHudLine(request: Pick<SceneHudRequest, 'name' | 'refusal'>): string {
  if (!request.refusal) return request.name
  return request.refusal.toLocaleLowerCase().startsWith(request.name.toLocaleLowerCase())
    ? request.refusal
    : `${request.name} · ${request.refusal}`
}

export interface SceneHudApi {
  /** The HUD window's state, for the capture exclusion list (main renderer). */
  getSceneHudWindowState(): Promise<SceneHudWindowState>
  /** Settings → Shortcuts' switch: main makes or drops the window. */
  setSceneHudEnabled(enabled: boolean): Promise<SceneHudWindowState>
  /** One switch's chip; main checks focus, the platform and the window. */
  showSceneHud(request: SceneHudRequest): Promise<SceneHudShowResult>
  onSceneHudWindowState(callback: (state: SceneHudWindowState) => void): () => void
  /** The HUD window's own feed. */
  onSceneHudPresent(callback: (presentation: SceneHudPresentation) => void): () => void
}

// Kept out of the backend/RPC-owned declaration file, like the app icons.
declare module './backend' {
  // Module augmentation adds the separately owned HUD API.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface VideorcApi extends SceneHudApi {}
}
