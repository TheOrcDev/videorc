import type { ElectronInvokeChannel } from './electron-ipc-contract'

export const RENDERER_ROLE_ARGUMENT_PREFIX = '--videorc-renderer-role='

export type RendererRole = 'main' | 'notes' | 'comments' | 'captions'

const MAIN_ONLY = ['main'] as const
const MAIN_AND_NOTES = ['main', 'notes'] as const
const MAIN_AND_COMMENTS = ['main', 'comments'] as const
const MAIN_AND_CAPTIONS = ['main', 'captions'] as const

/**
 * The complete allowlist for renderer -> main invocations. Registration fails
 * closed when a channel is absent, so adding an IPC handler also requires an
 * explicit privilege decision here.
 */
export const IPC_INVOKE_ROLES = {
  'backend:get-connection': MAIN_ONLY,
  'backend:get-logs': MAIN_ONLY,
  'account:begin-sign-in': MAIN_ONLY,
  'account:sign-out': MAIN_ONLY,
  'account:callbacks-list': MAIN_ONLY,
  'account:callback-ack': MAIN_ONLY,
  'app:get-runtime-info': MAIN_ONLY,
  'app:retry-hardware-acceleration': MAIN_ONLY,
  'app:set-native-theme': MAIN_ONLY,
  'system:open-permissions': MAIN_ONLY,
  'system:request-media-access': MAIN_ONLY,
  'system:media-access-status': MAIN_ONLY,
  'system:reveal-permission-target': MAIN_ONLY,
  'resource:reveal-selection': MAIN_ONLY,
  'resource:authorize-output-directory': MAIN_ONLY,
  'resource:reveal-session': MAIN_ONLY,
  'resource:reveal-background': MAIN_ONLY,
  'resource:trash-session-deletion': MAIN_ONLY,
  'resource:open-session': MAIN_ONLY,
  'system:pick-file': MAIN_ONLY,
  'system:pick-directory': MAIN_ONLY,
  'system:check-directory': MAIN_ONLY,
  'screens:pick-image': MAIN_ONLY,
  'backgrounds:import-image': MAIN_ONLY,
  'backgrounds:bundled-assets': MAIN_ONLY,
  'backgrounds:asset-exists': MAIN_ONLY,
  'avatars:cache': MAIN_ONLY,
  'oauth:open-url': MAIN_ONLY,
  'oauth:callback-redirect-uri': MAIN_ONLY,
  'oauth:callbacks-list': MAIN_ONLY,
  'oauth:callback-ack': MAIN_ONLY,
  'obs:discover': MAIN_ONLY,
  'obs:read': MAIN_ONLY,
  'obs:read-stream-key': MAIN_ONLY,
  'glass:wallpaper:get': MAIN_ONLY,
  'preview-window:open': MAIN_ONLY,
  'preview-window:close': MAIN_ONLY,
  'preview-window:toggle': MAIN_ONLY,
  'preview-window:get-state': MAIN_ONLY,
  'preview-window:permission-required': MAIN_ONLY,
  'preview-window:set-always-on-top': MAIN_ONLY,
  'preview-window:set-mode': MAIN_ONLY,
  'preview-window:report-dock-slot': MAIN_ONLY,
  'preview-window:set-dock-overlay': MAIN_ONLY,
  'preview-window:set-aspect-ratio': MAIN_ONLY,
  'preview-surface:mode': MAIN_ONLY,
  'preview-surface:pump-mode': MAIN_ONLY,
  'preview-surface:create': MAIN_ONLY,
  'preview-surface:update-bounds': MAIN_ONLY,
  'preview-surface:apply-host-commands': MAIN_ONLY,
  'preview-surface:drain-host-commands': MAIN_ONLY,
  'preview-surface:update-scene': MAIN_ONLY,
  'preview-surface:update-compositor': MAIN_ONLY,
  'preview-surface:set-frame-polling-suppressed': MAIN_ONLY,
  'preview-surface:destroy': MAIN_ONLY,
  'preview-surface:status': MAIN_ONLY,
  'notes-window:open': MAIN_ONLY,
  'global-shortcuts:set': MAIN_ONLY,
  'notes-window:close': MAIN_ONLY,
  'notes-window:get-state': MAIN_AND_NOTES,
  'notes-window:set-always-on-top': MAIN_AND_NOTES,
  'notes-window:get-document': MAIN_ONLY,
  'notes-window:save-document': MAIN_AND_NOTES,
  'comments-window:open': MAIN_ONLY,
  'comments-window:close': MAIN_ONLY,
  'comments-window:toggle': MAIN_ONLY,
  'comments-window:get-state': MAIN_AND_COMMENTS,
  'comments-window:set-always-on-top': MAIN_AND_COMMENTS,
  'comments-window:push-snapshot': MAIN_ONLY,
  'comments-window:push-delta': MAIN_ONLY,
  'comments-window:get-snapshot': MAIN_AND_COMMENTS,
  'comments-window:set-view-mode': MAIN_AND_COMMENTS,
  'comments-window:highlight': MAIN_AND_COMMENTS,
  'comments-window:highlight-result-push': MAIN_ONLY,
  'comments-window:highlight-state-push': MAIN_ONLY,
  'comments-window:highlight-state-get': MAIN_AND_COMMENTS,
  'comments-window:viewers-push': MAIN_ONLY,
  'comments-window:viewers-get': MAIN_AND_COMMENTS,
  'comments-window:send': MAIN_AND_COMMENTS,
  'comments-window:send-result-push': MAIN_ONLY,
  'comments-window:clear': MAIN_AND_COMMENTS,
  'comments-window:clear-result-push': MAIN_ONLY,
  'captions-window:open': MAIN_ONLY,
  'captions-window:close': MAIN_ONLY,
  'captions-window:toggle': MAIN_ONLY,
  'captions-window:get-state': MAIN_AND_CAPTIONS,
  'captions-window:set-always-on-top': MAIN_AND_CAPTIONS,
  'captions-window:push-snapshot': MAIN_ONLY,
  'captions-window:get-snapshot': MAIN_AND_CAPTIONS,
  'captions-window:push-lines': MAIN_ONLY,
  'captions-window:get-lines': MAIN_ONLY,
  'updates:get-status': MAIN_ONLY,
  'updates:check': MAIN_ONLY,
  'updates:download': MAIN_ONLY,
  'updates:install': MAIN_ONLY
} as const satisfies Record<ElectronInvokeChannel, readonly RendererRole[]>

export type SecureIpcChannel = keyof typeof IPC_INVOKE_ROLES

export function rendererRoleFromArguments(arguments_: readonly string[]): RendererRole | null {
  // BrowserWindow.additionalArguments are appended to the renderer argv. Read
  // the final occurrence so an inherited app CLI argument cannot grant an aux
  // window the main renderer's preload surface.
  let raw: string | undefined
  for (let index = arguments_.length - 1; index >= 0; index -= 1) {
    const argument = arguments_[index]
    if (argument.startsWith(RENDERER_ROLE_ARGUMENT_PREFIX)) {
      raw = argument.slice(RENDERER_ROLE_ARGUMENT_PREFIX.length)
      break
    }
  }
  return raw === 'main' || raw === 'notes' || raw === 'comments' || raw === 'captions' ? raw : null
}

export function rendererRoleArgument(role: RendererRole): string {
  return `${RENDERER_ROLE_ARGUMENT_PREFIX}${role}`
}

export function trustedRendererDevServerUrl(
  rawUrl: string | undefined,
  isPackaged: boolean
): string | null {
  if (!rawUrl || isPackaged) {
    return null
  }
  try {
    const url = new URL(rawUrl)
    const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      !loopbackHost ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      return null
    }
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString()
  } catch {
    return null
  }
}

export function roleCanInvokeChannel(role: RendererRole, channel: string): boolean {
  const roles = IPC_INVOKE_ROLES[channel as SecureIpcChannel] as readonly RendererRole[] | undefined
  return roles?.includes(role) === true
}

function normalizedDocumentUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') {
      url.search = ''
    }
    return url.toString()
  } catch {
    return null
  }
}

interface RegisteredRenderer {
  role: RendererRole
  trustedDocuments: Set<string>
}

export interface RendererInvokeIdentity {
  senderId: number
  frameUrl: string
  isMainFrame: boolean
}

/**
 * Main-process authority for renderer identities. The role comes from the
 * BrowserWindow that main created, never from renderer-controlled content.
 */
export class RendererSecurityRegistry {
  readonly #renderers = new Map<number, RegisteredRenderer>()

  register(senderId: number, role: RendererRole): void {
    this.#renderers.set(senderId, { role, trustedDocuments: new Set() })
  }

  unregister(senderId: number): void {
    this.#renderers.delete(senderId)
  }

  trustDocument(senderId: number, rawUrl: string): void {
    const renderer = this.#renderers.get(senderId)
    const documentUrl = normalizedDocumentUrl(rawUrl)
    if (!renderer || !documentUrl) {
      throw new Error('Cannot trust a document for an unregistered renderer.')
    }
    renderer.trustedDocuments.add(documentUrl)
  }

  role(senderId: number): RendererRole | null {
    return this.#renderers.get(senderId)?.role ?? null
  }

  documentTrusted(senderId: number, rawUrl: string): boolean {
    const documentUrl = normalizedDocumentUrl(rawUrl)
    return Boolean(
      documentUrl && this.#renderers.get(senderId)?.trustedDocuments.has(documentUrl) === true
    )
  }

  invokeAllowed(channel: string, identity: RendererInvokeIdentity): boolean {
    const role = this.role(identity.senderId)
    return Boolean(
      role &&
      identity.isMainFrame &&
      roleCanInvokeChannel(role, channel) &&
      this.documentTrusted(identity.senderId, identity.frameUrl)
    )
  }

  navigationAllowed(senderId: number, currentUrl: string, targetUrl: string): boolean {
    const current = normalizedDocumentUrl(currentUrl)
    const target = normalizedDocumentUrl(targetUrl)
    return Boolean(
      current &&
      target &&
      current === target &&
      this.documentTrusted(senderId, current) &&
      this.documentTrusted(senderId, target)
    )
  }
}

export const RENDERER_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: videorc-asset: http://127.0.0.1:* http://localhost:*",
  "font-src 'self' data:",
  "media-src 'self' data: blob: file: videorc-asset:",
  "connect-src 'self' videorc-asset: https://www.videorc.com http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export function rendererDocumentCspWithScriptHash(
  scriptHash: string,
  allowSmokeRendererEvaluation = false
): string {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(scriptHash)) {
    throw new Error('Renderer CSP script hash is invalid.')
  }
  const evaluationSource = allowSmokeRendererEvaluation ? " 'unsafe-eval'" : ''
  return RENDERER_DOCUMENT_CSP.replace(
    "script-src 'self'",
    `script-src 'self' 'sha256-${scriptHash}'${evaluationSource}`
  )
}

export function inlineRendererDocumentCsp(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('Renderer CSP nonce is invalid.')
  }
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

export function nativePreviewSurfaceDocumentCsp(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('Native preview surface CSP nonce is invalid.')
  }
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob: file: videorc-asset: http://127.0.0.1:* http://localhost:*',
    'connect-src videorc-asset: http://127.0.0.1:* http://localhost:*',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}
