import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Session } from 'electron'

import { describe, expect, it } from 'vitest'

import {
  IPC_INVOKE_ROLES,
  RENDERER_DOCUMENT_CSP,
  RendererSecurityRegistry,
  inlineRendererDocumentCsp,
  nativePreviewSurfaceDocumentCsp,
  rendererDocumentCspWithScriptHash,
  rendererRoleFromArguments,
  roleCanInvokeChannel,
  trustedRendererDevServerUrl
} from '../shared/renderer-security-policy'
import { electronInvokeApiMethods } from '../shared/electron-ipc-contract'
import {
  installRendererSessionPermissions,
  rendererWebPermissionAllowed,
  rendererWindowOpenDisposition,
  rendererWindowWebPreferences
} from './web-contents-security'

const sourcePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

function source(relative: string): string {
  return readFileSync(sourcePath(relative), 'utf8')
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1])
}

describe('renderer security policy', () => {
  it('derives only known preload roles from main-owned process arguments', () => {
    expect(rendererRoleFromArguments(['electron', '--videorc-renderer-role=comments'])).toBe(
      'comments'
    )
    expect(
      rendererRoleFromArguments([
        '--videorc-renderer-role=main',
        '--videorc-renderer-role=comments'
      ])
    ).toBe('comments')
    expect(rendererRoleFromArguments(['--videorc-renderer-role=admin'])).toBeNull()
    expect(rendererRoleFromArguments([])).toBeNull()
  })

  it('trusts a renderer dev server only on loopback and never in packaged builds', () => {
    expect(trustedRendererDevServerUrl('http://localhost:5173/', false)).toBe(
      'http://localhost:5173/'
    )
    expect(trustedRendererDevServerUrl('http://127.0.0.1:5173/', false)).toBe(
      'http://127.0.0.1:5173/'
    )
    expect(trustedRendererDevServerUrl('https://attacker.example/', false)).toBeNull()
    expect(trustedRendererDevServerUrl('http://localhost:5173/', true)).toBeNull()
  })

  it('keeps every privileged renderer sandboxed with context isolation', () => {
    const mainSource = source('./index.ts')
    for (const role of ['main', 'notes', 'comments', 'captions'] as const) {
      expect(rendererWindowWebPreferences(role)).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      })
      expect(mainSource).toContain(`rendererWindowWebPreferences('${role}')`)
      expect(mainSource).toContain(
        `registerRendererWindow(${role === 'main' ? 'mainWindow' : 'window'}, '${role}')`
      )
    }
    expect(mainSource).not.toContain('mainWindowSandboxEnabled')
  })

  it('requires the registered role, exact trusted document, and main frame for IPC', () => {
    const registry = new RendererSecurityRegistry()
    registry.register(17, 'comments')
    registry.trustDocument(17, 'http://localhost:5173/comments.html')

    expect(
      registry.invokeAllowed('comments-window:get-snapshot', {
        senderId: 17,
        frameUrl: 'http://localhost:5173/comments.html?t=123',
        isMainFrame: true
      })
    ).toBe(true)
    expect(
      registry.invokeAllowed('resource:trash-session-deletion', {
        senderId: 17,
        frameUrl: 'http://localhost:5173/comments.html',
        isMainFrame: true
      })
    ).toBe(false)
    expect(
      registry.invokeAllowed('comments-window:get-snapshot', {
        senderId: 17,
        frameUrl: 'https://attacker.example/comments.html',
        isMainFrame: true
      })
    ).toBe(false)
    expect(
      registry.invokeAllowed('comments-window:get-snapshot', {
        senderId: 17,
        frameUrl: 'http://localhost:5173/comments.html',
        isMainFrame: false
      })
    ).toBe(false)
  })

  it('defaults web permissions closed and grants only main-frame audio and sanitized writes', () => {
    const registry = new RendererSecurityRegistry()
    const trustedMainUrl = 'file:///Applications/Videorc/resources/index.html'
    const trustedCommentsUrl = 'file:///Applications/Videorc/resources/comments.html'
    registry.register(1, 'main')
    registry.trustDocument(1, trustedMainUrl)
    registry.register(2, 'comments')
    registry.trustDocument(2, trustedCommentsUrl)

    const request = (overrides: Partial<Parameters<typeof rendererWebPermissionAllowed>[1]>) =>
      rendererWebPermissionAllowed(registry, {
        senderId: 1,
        frameUrl: trustedMainUrl,
        isMainFrame: true,
        permission: 'media',
        mediaTypes: ['audio'],
        ...overrides
      })

    expect(request({})).toBe(true)
    expect(request({ permission: 'clipboard-sanitized-write', mediaTypes: undefined })).toBe(true)
    expect(request({ mediaTypes: ['video'] })).toBe(false)
    expect(request({ mediaTypes: ['unknown'] })).toBe(false)
    expect(request({ mediaTypes: undefined })).toBe(false)
    expect(request({ mediaTypes: [] })).toBe(false)
    for (const permission of [
      'clipboard-read',
      'display-capture',
      'fileSystem',
      'geolocation',
      'notifications',
      'openExternal',
      'speaker-selection'
    ]) {
      expect(request({ permission, mediaTypes: undefined })).toBe(false)
    }
    expect(request({ senderId: 2, frameUrl: trustedCommentsUrl })).toBe(false)
    expect(request({ senderId: 99 })).toBe(false)
    expect(request({ frameUrl: 'https://attacker.example/' })).toBe(false)
    expect(request({ isMainFrame: false })).toBe(false)
  })

  it('installs check, request, and display-capture denial before creating windows', () => {
    const installed: string[] = []
    const targetSession = {
      setPermissionCheckHandler(handler) {
        expect(handler).toBeTypeOf('function')
        installed.push('check')
      },
      setPermissionRequestHandler(handler) {
        expect(handler).toBeTypeOf('function')
        installed.push('request')
      },
      setDisplayMediaRequestHandler(handler) {
        expect(handler).toBeTypeOf('function')
        installed.push('display')
      }
    } satisfies Pick<
      Session,
      'setPermissionCheckHandler' | 'setPermissionRequestHandler' | 'setDisplayMediaRequestHandler'
    >

    installRendererSessionPermissions(targetSession, new RendererSecurityRegistry())
    expect(installed).toEqual(['check', 'request', 'display'])

    const mainSource = source('./index.ts')
    const readySource = mainSource.slice(mainSource.indexOf('app.whenReady().then'))
    const permissionInstallIndex = readySource.indexOf(
      'installRendererSessionPermissions(session.defaultSession)'
    )
    expect(permissionInstallIndex).toBeGreaterThanOrEqual(0)
    expect(permissionInstallIndex).toBeLessThan(readySource.indexOf('createWindow()'))
  })

  it('permits same-document navigation only and denies all window opens', () => {
    const registry = new RendererSecurityRegistry()
    registry.register(9, 'main')
    registry.trustDocument(9, 'file:///Applications/Videorc/resources/index.html')

    expect(
      registry.navigationAllowed(
        9,
        'file:///Applications/Videorc/resources/index.html',
        'file:///Applications/Videorc/resources/index.html#studio'
      )
    ).toBe(true)
    expect(
      registry.navigationAllowed(
        9,
        'file:///Applications/Videorc/resources/index.html',
        'file:///Applications/Videorc/resources/comments.html'
      )
    ).toBe(false)
    expect(
      registry.navigationAllowed(
        9,
        'file:///Applications/Videorc/resources/index.html',
        'https://attacker.example/'
      )
    ).toBe(false)
    expect(rendererWindowOpenDisposition()).toEqual({ action: 'deny' })
    expect(source('./index.ts')).toContain('installWebContentsSecurity(app)')
    expect(source('./web-contents-security.ts')).toContain("contents.on('will-attach-webview'")
  })

  it('keeps every registered invoke behind the centralized channel policy', () => {
    const registered = new Set([
      ...matches(source('./index.ts'), /secureIpcHandle\(\s*'([^']+)'/g),
      ...matches(source('./updater.ts'), /secureIpcHandle\(\s*'([^']+)'/g)
    ])
    expect([...registered].sort()).toEqual(Object.keys(IPC_INVOKE_ROLES).sort())
    expect(Object.keys(IPC_INVOKE_ROLES).sort()).toEqual(
      Object.keys(electronInvokeApiMethods).sort()
    )
    expect(source('./index.ts')).not.toContain('ipcMain.handle')
    expect(source('./updater.ts')).not.toContain('ipcMain.handle')
    expect(source('./index.ts')).not.toMatch(/\.webContents\.send\(/)
    expect(source('./updater.ts')).not.toMatch(/\.webContents\.send\(/)
    expect(source('./secure-ipc.ts')).toContain('validateElectronEventPayload(channel, payload)')
    expect(Object.values(IPC_INVOKE_ROLES).every((roles) => roles.includes('main'))).toBe(true)
  })

  it('routes product-account sign-out through Electron main rather than the renderer token', () => {
    const mainSource = source('./index.ts')
    const studioSource = source('../renderer/src/hooks/use-studio.tsx')

    expect(mainSource).toMatch(
      /requestBackendAdmin<VideorcAccountSnapshot>\([\s\S]{0,100}'account\.sign_out'/
    )
    expect(studioSource).toContain('window.videorc?.signOutAccount')
    expect(studioSource).not.toContain("client.request<VideorcAccountSnapshot>('account.sign_out')")
    expect(roleCanInvokeChannel('comments', 'account:sign-out')).toBe(false)
  })

  it('declares every preload invoke and keeps auxiliary roles least-privileged', () => {
    const preload = source('../preload/index.ts')
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*'[^']+'/)
    expect(preload).toContain('validateElectronInvokeArgs(channel, args)')
    expect(preload).toContain('validateElectronEventPayload(channel, payload)')
    expect(roleCanInvokeChannel('notes', 'notes-window:save-document')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'resource:open-session')).toBe(false)
    expect(roleCanInvokeChannel('comments', 'comments-window:send')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'comments-window:push-snapshot')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'captions-window:get-snapshot')).toBe(true)
    expect(roleCanInvokeChannel('captions', 'captions-window:push-snapshot')).toBe(false)
  })

  it('applies a restrictive CSP to every bundled renderer and a nonce to Notes', () => {
    for (const document of [
      '../renderer/index.html',
      '../renderer/comments.html',
      '../renderer/captions.html'
    ]) {
      const html = source(document)
      expect(html).toContain('http-equiv="Content-Security-Policy"')
      expect(html).toContain(`content="${RENDERER_DOCUMENT_CSP}"`)
    }
    expect(source('../renderer/index.html')).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)

    const refreshHash = 'Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='
    expect(rendererDocumentCspWithScriptHash(refreshHash)).toContain(
      `script-src 'self' 'sha256-${refreshHash}'`
    )
    expect(rendererDocumentCspWithScriptHash(refreshHash)).not.toContain("'unsafe-eval'")
    expect(rendererDocumentCspWithScriptHash(refreshHash, true)).toContain(
      `script-src 'self' 'sha256-${refreshHash}' 'unsafe-eval'`
    )
    expect(source('../../electron.vite.config.ts')).toContain("'Content-Security-Policy':")
    expect(source('../../electron.vite.config.ts')).toContain(
      "process.env.VIDEORC_SMOKE_COMMAND_SERVER === '1'"
    )
    expect(source('../../electron.vite.config.ts')).toContain(
      "process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1'"
    )
    expect(RENDERER_DOCUMENT_CSP).toContain('connect-src')
    expect(RENDERER_DOCUMENT_CSP).toContain('https://www.videorc.com')
    expect(
      RENDERER_DOCUMENT_CSP.split('; ').find((directive) => directive.startsWith('img-src'))
    ).not.toContain('https:')
    expect(source('../../electron.vite.config.ts')).toContain(
      'html.replace(RENDERER_DOCUMENT_CSP, rendererDevelopmentCsp)'
    )

    const nonce = 'abcdefghijklmnopqrstuvwxyz_123456'
    const inlineCsp = inlineRendererDocumentCsp(nonce)
    expect(inlineCsp).toContain(`script-src 'nonce-${nonce}'`)
    expect(inlineCsp).not.toContain("script-src 'unsafe-inline'")
    const mainSource = source('./index.ts')
    expect(mainSource).toContain('inlineRendererDocumentCsp(scriptNonce)')
    expect(mainSource).toContain('<script nonce="${scriptNonce}">')

    const nativePreviewCsp = nativePreviewSurfaceDocumentCsp(nonce)
    expect(nativePreviewCsp).toContain(`script-src 'nonce-${nonce}'`)
    expect(nativePreviewCsp).not.toContain("script-src 'unsafe-inline'")
    expect(nativePreviewCsp).toContain(
      'img-src data: blob: file: videorc-asset: http://127.0.0.1:* http://localhost:*'
    )
    expect(nativePreviewCsp).toContain(
      'connect-src videorc-asset: http://127.0.0.1:* http://localhost:*'
    )
    expect(nativePreviewCsp).not.toContain('https:')

    const proofSurfaceSource = mainSource.slice(
      mainSource.indexOf('function nativePreviewSurfaceHtml('),
      mainSource.indexOf('// Placement for the Electron proof surface window')
    )
    expect(proofSurfaceSource).toContain('nativePreviewSurfaceDocumentCsp(scriptNonce)')
    expect(proofSurfaceSource).toContain('http-equiv="Content-Security-Policy"')
    expect(proofSurfaceSource).toContain('<script nonce="${scriptNonce}">')
  })

  it('flushes bounded Notes state through preload IPC before close', () => {
    const mainSource = source('./index.ts')
    const preload = source('../preload/index.ts')
    const apiPolicy = source('../preload/api-policy.ts')

    expect(mainSource).not.toContain('__videorcNotesSnapshot')
    expect(mainSource).not.toContain("executeJavaScript('window.__videorcNotesSnapshot")
    expect(mainSource).toContain(
      "sendElectronEvent(window.webContents, 'notes-window:flush-request'"
    )
    expect(mainSource).toContain('maxlength="${MAX_NOTES_TEXT_LENGTH}"')
    expect(preload).toContain("subscribe('notes-window:flush-request'")
    expect(apiPolicy).toContain("'onNotesFlushRequest'")
  })

  it('routes denied X documentation popups through the validated external opener', () => {
    const streamingTab = source('../renderer/src/components/tabs/streaming-tab.tsx')
    expect(streamingTab).toContain('openExternalUrl(xNativeCapability.docsUrl)')
    expect(streamingTab).toContain('openExternalUrl(xNativeCapability.apiOverviewUrl)')
  })
})
