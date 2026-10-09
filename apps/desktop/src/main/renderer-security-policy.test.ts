import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Session } from 'electron'

import { describe, expect, it } from 'vitest'

import {
  IPC_INVOKE_ROLES,
  RENDERER_DOCUMENT_CSP,
  RendererSecurityRegistry,
  nativePreviewSurfaceDocumentCsp,
  rendererDocumentCspWithScriptHash,
  rendererRoleFromArguments,
  roleCanInvokeChannel,
  trustedRendererDevServerUrl
} from '../shared/renderer-security-policy'
import { electronInvokeApiMethods } from '../shared/electron-ipc-contract'
import { AUXILIARY_API_KEYS } from '../preload/api-policy'
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
  it('keeps the thumbnail picker exclusive to the Studio renderer', () => {
    expect(roleCanInvokeChannel('main', 'scheduled-streams:import-thumbnail')).toBe(true)
    for (const role of ['notes', 'comments', 'captions'] as const) {
      expect(roleCanInvokeChannel(role, 'scheduled-streams:import-thumbnail')).toBe(false)
    }
  })
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

  it('defaults web permissions closed: main-frame audio, sanitized writes from main and the Stream Manager', () => {
    const registry = new RendererSecurityRegistry()
    const trustedMainUrl = 'file:///Applications/Videorc/resources/index.html'
    const trustedCommentsUrl = 'file:///Applications/Videorc/resources/comments.html'
    registry.register(1, 'main')
    registry.trustDocument(1, trustedMainUrl)
    registry.register(2, 'comments')
    registry.trustDocument(2, trustedCommentsUrl)
    const trustedNotesUrl = 'file:///Applications/Videorc/resources/notes.html'
    registry.register(3, 'notes')
    registry.trustDocument(3, trustedNotesUrl)

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
    // The Stream Manager may write the clipboard (Copy, Copy link) and
    // nothing else: no microphone, no clipboard reads.
    const comments = { senderId: 2, frameUrl: trustedCommentsUrl }
    expect(request(comments)).toBe(false)
    expect(
      request({ ...comments, permission: 'clipboard-sanitized-write', mediaTypes: undefined })
    ).toBe(true)
    expect(request({ ...comments, permission: 'clipboard-read', mediaTypes: undefined })).toBe(
      false
    )
    expect(
      request({
        ...comments,
        frameUrl: 'https://attacker.example/',
        permission: 'clipboard-sanitized-write',
        mediaTypes: undefined
      })
    ).toBe(false)
    expect(
      request({
        senderId: 3,
        frameUrl: trustedNotesUrl,
        permission: 'clipboard-sanitized-write',
        mediaTypes: undefined
      })
    ).toBe(false)
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
    expect(roleCanInvokeChannel('comments', 'account:refresh')).toBe(false)
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
    // The Stream Manager reads the dashboard; only the main renderer writes it.
    expect(roleCanInvokeChannel('comments', 'comments-window:dashboard-get')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'comments-window:dashboard-push')).toBe(false)
    expect(roleCanInvokeChannel('main', 'comments-window:dashboard-push')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'comments-window:dashboard-get')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'captions-window:get-snapshot')).toBe(true)
    expect(roleCanInvokeChannel('captions', 'captions-window:push-snapshot')).toBe(false)
  })

  it('lets only the Studio renderer mint in-app playback grants (plan 119, S11)', () => {
    // The Comments window shares the videorc-asset: scheme in its CSP, so the
    // grant id must be the only key: no auxiliary window may ask for one, and
    // the preload never hands the method to them.
    expect(roleCanInvokeChannel('main', 'media:grant-session')).toBe(true)
    for (const role of ['notes', 'comments', 'captions'] as const) {
      expect(roleCanInvokeChannel(role, 'media:grant-session')).toBe(false)
      expect(AUXILIARY_API_KEYS[role]).not.toContain('grantSessionMedia')
    }
    const registry = new RendererSecurityRegistry()
    registry.register(21, 'comments')
    registry.trustDocument(21, 'http://localhost:5173/comments.html')
    expect(
      registry.invokeAllowed('media:grant-session', {
        senderId: 21,
        frameUrl: 'http://localhost:5173/comments.html',
        isMainFrame: true
      })
    ).toBe(false)
  })

  it('lets only the Comments window join main in caching chat avatars', () => {
    // The detached Comments window draws the same chat rows as Studio; the
    // host allowlist and the on-disk cache stay main-owned (avatar-cache.ts).
    expect(roleCanInvokeChannel('main', 'avatars:cache')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'avatars:cache')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'avatars:cache')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'avatars:cache')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('cacheChatAvatar')
    expect(AUXILIARY_API_KEYS.notes).not.toContain('cacheChatAvatar')
    expect(AUXILIARY_API_KEYS.captions).not.toContain('cacheChatAvatar')
  })

  it('lets only main and the Stream Manager open a chat link (plan 151)', () => {
    expect(roleCanInvokeChannel('main', 'chat:open-link')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'chat:open-link')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'chat:open-link')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'chat:open-link')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('openChatLink')
    expect(AUXILIARY_API_KEYS.notes).not.toContain('openChatLink')
    expect(AUXILIARY_API_KEYS.captions).not.toContain('openChatLink')
    // OAuth stays main's alone.
    expect(roleCanInvokeChannel('comments', 'oauth:open-url')).toBe(false)
  })

  it('lets only main and the Stream Manager cache a Twitch GIF (plan 155)', () => {
    expect(roleCanInvokeChannel('main', 'chat-gifs:cache')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'chat-gifs:cache')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'chat-gifs:cache')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'chat-gifs:cache')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('cacheChatGif')
    expect(AUXILIARY_API_KEYS.notes).not.toContain('cacheChatGif')
    expect(AUXILIARY_API_KEYS.captions).not.toContain('cacheChatGif')
    // The display mode relay: only the main renderer (the backend socket's
    // owner) pushes; the Stream Manager seeds and follows.
    expect(roleCanInvokeChannel('main', 'chat-gifs:push-mode')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'chat-gifs:push-mode')).toBe(false)
    expect(roleCanInvokeChannel('comments', 'chat-gifs:get-mode')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'chat-gifs:get-mode')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('getChatGifMode')
    expect(AUXILIARY_API_KEYS.comments).toContain('onChatGifMode')
    expect(AUXILIARY_API_KEYS.comments).not.toContain('pushChatGifMode')
  })

  it('lets only main and the Comments window read cached image bytes (plan 095)', () => {
    // The highlight card decodes avatars and emotes from bytes; the cache
    // directory stays main-owned and only its managed file names resolve.
    expect(roleCanInvokeChannel('main', 'avatars:read')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'avatars:read')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'avatars:read')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'avatars:read')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('readChatAvatar')
    expect(AUXILIARY_API_KEYS.notes).not.toContain('readChatAvatar')
    expect(AUXILIARY_API_KEYS.captions).not.toContain('readChatAvatar')
  })

  it('keeps the retired glass wallpaper feed out of every window (plan 050)', () => {
    // Real vibrancy replaced the blurred-wallpaper underlay; no window may
    // reach the old System Events wallpaper feed.
    for (const role of ['main', 'comments', 'captions', 'notes'] as const) {
      expect(roleCanInvokeChannel(role, 'glass:wallpaper:get')).toBe(false)
    }
    for (const keys of Object.values(AUXILIARY_API_KEYS)) {
      expect(keys).not.toContain('getGlassWallpaper')
    }
  })

  it('lets only main and the Chat window pick the highlight corner', () => {
    expect(roleCanInvokeChannel('main', 'comments-window:set-highlight-anchor')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'comments-window:set-highlight-anchor')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'comments-window:set-highlight-anchor')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'comments-window:set-highlight-anchor')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('setCommentsWindowHighlightAnchor')
  })

  it('lets only main and the Chat window flip Activity auto-show (plan 156)', () => {
    expect(roleCanInvokeChannel('main', 'comments-window:set-auto-show-activity')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'comments-window:set-auto-show-activity')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'comments-window:set-auto-show-activity')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'comments-window:set-auto-show-activity')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('setCommentsWindowAutoShowActivity')
  })

  it('lets only the Chat window start a scope reconnect, checked by sender (plan 140)', () => {
    // Same policy as Show who followed: main and the Chat window by role, and
    // the handler itself refuses any sender but the Chat window.
    expect(roleCanInvokeChannel('comments', 'comments-window:reconnect-scopes')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'comments-window:reconnect-scopes')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'comments-window:reconnect-scopes')).toBe(false)
    expect(AUXILIARY_API_KEYS.comments).toContain('reconnectScopesFromCommentsWindow')
    expect(AUXILIARY_API_KEYS.notes).not.toContain('reconnectScopesFromCommentsWindow')
    expect(AUXILIARY_API_KEYS.captions).not.toContain('reconnectScopesFromCommentsWindow')
    const handler = source('./index.ts').split("'comments-window:reconnect-scopes',")[1] ?? ''
    expect(handler.slice(0, 600)).toContain('event.sender.id !== commentsWindow.webContents.id')
  })

  it('lets only the Chat window ask for a chat removal, checked by sender (plan 140, S6)', () => {
    expect(roleCanInvokeChannel('comments', 'comments-window:moderation')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'comments-window:moderation')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'comments-window:moderation')).toBe(false)
    // Only Studio answers the relay.
    expect(roleCanInvokeChannel('comments', 'comments-window:moderation-result-push')).toBe(false)
    expect(roleCanInvokeChannel('main', 'comments-window:moderation-result-push')).toBe(true)
    expect(AUXILIARY_API_KEYS.comments).toContain('moderateFromCommentsWindow')
    expect(AUXILIARY_API_KEYS.comments).not.toContain('pushModerationResult')
    expect(AUXILIARY_API_KEYS.comments).not.toContain('onModerationRequest')
    expect(AUXILIARY_API_KEYS.notes).not.toContain('moderateFromCommentsWindow')
    expect(AUXILIARY_API_KEYS.captions).not.toContain('moderateFromCommentsWindow')
    const mainSource = source('./index.ts')
    const handler = mainSource.split("'comments-window:moderation',")[1] ?? ''
    expect(handler.slice(0, 700)).toContain('event.sender.id !== commentsWindow.webContents.id')
    expect(handler.slice(0, 700)).toContain('assertLiveCommentsCommandSession(command.sessionId)')
    const result = mainSource.split("'comments-window:moderation-result-push',")[1] ?? ''
    expect(result.slice(0, 400)).toContain('event.sender.id !== mainWindow.webContents.id')
  })

  it('lets only the Chat window answer Buddy, checked by sender (plan 140, S6 part B)', () => {
    expect(roleCanInvokeChannel('comments', 'comments-window:cohost-command')).toBe(true)
    expect(roleCanInvokeChannel('notes', 'comments-window:cohost-command')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'comments-window:cohost-command')).toBe(false)
    expect(roleCanInvokeChannel('comments', 'comments-window:cohost-command-result-push')).toBe(
      false
    )
    expect(AUXILIARY_API_KEYS.comments).toContain('sendCohostCommand')
    expect(AUXILIARY_API_KEYS.comments).not.toContain('pushCohostCommandResult')
    const mainSource = source('./index.ts')
    const handler = mainSource.split("'comments-window:cohost-command',")[1] ?? ''
    expect(handler.slice(0, 700)).toContain('event.sender.id !== commentsWindow.webContents.id')
    expect(handler.slice(0, 700)).toContain('assertLiveCommentsCommandSession(command.sessionId)')
    const result = mainSource.split("'comments-window:cohost-command-result-push',")[1] ?? ''
    expect(result.slice(0, 400)).toContain('event.sender.id !== mainWindow.webContents.id')
  })

  it('exposes an invoke to an auxiliary preload only when the channel policy admits that role', () => {
    const channelByApiMethod = new Map<string, string>(
      Object.entries(electronInvokeApiMethods).map(([channel, method]) => [method, channel])
    )
    for (const role of ['notes', 'comments', 'captions'] as const) {
      for (const key of AUXILIARY_API_KEYS[role]) {
        const channel = channelByApiMethod.get(key as string)
        if (!channel) {
          continue // event subscription, not an invoke
        }
        expect(roleCanInvokeChannel(role, channel), `${role} -> ${channel}`).toBe(true)
      }
    }
  })

  it('applies a restrictive CSP to every bundled renderer, Notes included', () => {
    for (const document of [
      '../renderer/index.html',
      '../renderer/comments.html',
      '../renderer/captions.html',
      '../renderer/notes.html'
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

    // Notes is a bundled renderer (plan 050): no inline document, no nonce.
    const mainSource = source('./index.ts')
    expect(mainSource).not.toContain(
      'data:text/html;charset=utf-8,${encodeURIComponent(\n    notesWindowHtml'
    )
    expect(mainSource).toContain("new URL('notes.html', rendererUrl)")
    // The native preview surface is the one inline document left.
    const nonce = 'abcdefghijklmnopqrstuvwxyz_123456'
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
    // The Notes renderer (plan 050 S4) bounds the text and answers the flush.
    const notesWindow = source('../renderer/src/components/notes-window.tsx')
    expect(notesWindow).toContain('maxLength = MAX_NOTES_TEXT_LENGTH')
    expect(notesWindow).toContain('onNotesFlushRequest?.(() => void save())')
    expect(preload).toContain("subscribe('notes-window:flush-request'")
    expect(apiPolicy).toContain("'onNotesFlushRequest'")
  })

  it('routes denied X documentation popups through the validated external opener', () => {
    // Plan 080 S5 moved the destination card (and its X block) out of the tab.
    const destinationCard = source('../renderer/src/components/streaming/destination-card.tsx')
    expect(destinationCard).toContain('openExternalUrl(xNativeCapability.docsUrl)')
    expect(destinationCard).toContain('openExternalUrl(xNativeCapability.apiOverviewUrl)')
  })
})
