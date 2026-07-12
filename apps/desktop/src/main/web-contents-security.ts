import type { App, BrowserWindow, Event, Session, WebContents } from 'electron'

import {
  RendererSecurityRegistry,
  rendererRoleArgument,
  type RendererRole
} from '../shared/renderer-security-policy'
import { rendererSecurityRegistry } from './secure-ipc'

type PermissionCheckHandler = Exclude<Parameters<Session['setPermissionCheckHandler']>[0], null>
type PermissionRequestHandler = Exclude<Parameters<Session['setPermissionRequestHandler']>[0], null>
type DisplayMediaRequestHandler = Exclude<
  Parameters<Session['setDisplayMediaRequestHandler']>[0],
  null
>

type RendererPermissionSession = Pick<
  Session,
  'setPermissionCheckHandler' | 'setPermissionRequestHandler' | 'setDisplayMediaRequestHandler'
>

export type RendererWebPermissionRequest = {
  senderId: number
  frameUrl: string
  isMainFrame: boolean
  permission: string
  mediaTypes?: readonly ('audio' | 'video' | 'unknown')[]
}

/**
 * Web-platform permissions are an independent authority boundary from preload
 * IPC and the OS camera/microphone status helpers. Keep the browser surface to
 * the two APIs the Studio actually uses: a visual-only audio meter and
 * sanitized clipboard writes from the main renderer.
 */
export function rendererWebPermissionAllowed(
  registry: RendererSecurityRegistry,
  request: RendererWebPermissionRequest
): boolean {
  if (
    !request.isMainFrame ||
    registry.role(request.senderId) !== 'main' ||
    !registry.documentTrusted(request.senderId, request.frameUrl)
  ) {
    return false
  }

  if (request.permission === 'clipboard-sanitized-write') {
    return true
  }
  if (request.permission !== 'media') {
    return false
  }

  const mediaTypes = request.mediaTypes
  return Boolean(mediaTypes?.length && mediaTypes.every((mediaType) => mediaType === 'audio'))
}

/** Install after app.whenReady(), before creating any BrowserWindow. */
export function installRendererSessionPermissions(
  targetSession: RendererPermissionSession,
  registry: RendererSecurityRegistry = rendererSecurityRegistry
): void {
  const checkHandler: PermissionCheckHandler = (contents, permission, _origin, details) =>
    Boolean(
      contents &&
      rendererWebPermissionAllowed(registry, {
        senderId: contents.id,
        frameUrl: details.requestingUrl ?? '',
        isMainFrame: details.isMainFrame,
        permission,
        mediaTypes: details.mediaType ? [details.mediaType] : undefined
      })
    )

  const requestHandler: PermissionRequestHandler = (contents, permission, callback, details) => {
    const mediaTypes =
      permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      rendererWebPermissionAllowed(registry, {
        senderId: contents.id,
        frameUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        permission,
        mediaTypes
      })
    )
  }

  const displayMediaHandler: DisplayMediaRequestHandler = (_request, callback) => callback({})

  // Electron otherwise auto-approves permission requests. Both handlers are
  // required because Chromium APIs commonly check first and request second.
  targetSession.setPermissionCheckHandler(checkHandler)
  targetSession.setPermissionRequestHandler(requestHandler)
  targetSession.setDisplayMediaRequestHandler(displayMediaHandler)
}

export function rendererWindowWebPreferences(role: RendererRole): {
  additionalArguments: string[]
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
}
export function rendererWindowWebPreferences(role: RendererRole) {
  return {
    additionalArguments: [rendererRoleArgument(role)],
    sandbox: true as const,
    contextIsolation: true as const,
    nodeIntegration: false as const
  }
}

export function registerRendererWindow(window: BrowserWindow, role: RendererRole): void {
  const senderId = window.webContents.id
  rendererSecurityRegistry.register(senderId, role)
  window.webContents.once('destroyed', () => rendererSecurityRegistry.unregister(senderId))
}

export function trustRendererDocument(window: BrowserWindow, url: string): void {
  rendererSecurityRegistry.trustDocument(window.webContents.id, url)
}

export function rendererWindowOpenDisposition(): { action: 'deny' } {
  return { action: 'deny' }
}

function preventUntrustedNavigation(contents: WebContents, event: Event, targetUrl: string): void {
  if (!rendererSecurityRegistry.navigationAllowed(contents.id, contents.getURL(), targetUrl)) {
    event.preventDefault()
  }
}

/** Install before any BrowserWindow is created. Every renderer denies popups,
 * webviews, cross-document navigations, and redirects by default. */
export function installWebContentsSecurity(app: App): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(rendererWindowOpenDisposition)
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('will-navigate', (event, targetUrl) =>
      preventUntrustedNavigation(contents, event, targetUrl)
    )
    contents.on('will-redirect', (event, targetUrl) =>
      preventUntrustedNavigation(contents, event, targetUrl)
    )
  })
}
