import { withGlobalShortcut } from './global-shortcut-bindings'
import { GLOBAL_SHORTCUT_ACTIONS } from './global-shortcuts'
import { readFileSync } from 'node:fs'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { BackendConnection, VideorcApi } from './backend'
import {
  COMMENT_HIGHLIGHT_ANCHORS,
  DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
  normalizeCommentHighlightAnchor
} from './backend'
import { CHAT_AVATAR_MAX_BYTES } from './chat-avatar-bytes'
import {
  MAX_NOTES_TEXT_LENGTH,
  boundedPassthroughElectronEventChannels,
  boundedPassthroughElectronInvokeChannels,
  electronEventRuntimeClassificationComplete,
  electronEventChannels,
  electronInvokeRuntimeClassificationComplete,
  electronInvokeApiMethods,
  isElectronInvokeChannel,
  runtimeValidatedElectronEventChannels,
  runtimeValidatedElectronInvokeChannels,
  validateElectronEventPayload,
  validateElectronInvokeArgs,
  validateElectronInvokeResult,
  type ElectronEventChannelInvariant,
  type ElectronInvokeArgs,
  type ElectronInvokeMappingInvariant,
  type ElectronInvokeResult
} from './electron-ipc-contract'

describe('Electron IPC contract', () => {
  it('maps every renderer-facing invoke channel to a real async API method', () => {
    expectTypeOf<ElectronInvokeMappingInvariant>().toEqualTypeOf<true>()
    // 124: plan 155 adds chat-gifs:cache and the GIF mode relay (push, get).
    // 121: plan 152 adds marker request/reply and capture context get/push.
    // 117: plan 151 added chat:open-link.
    // 125: plan 156 added the Activity auto-show switch channel (116: plan
    // 140 S6 part B added the Golem command answer pair; part A
    // the chat removal relay pair; S5 the Stream
    // Manager's reconnect-scopes channel; plan 119 the in-app player's
    // media:grant-session; plan 095 the highlight card's avatars:read; plan 071
    // the Stream Manager Show who followed channel; plan 068 the mark-clip
    // relay pair; plan 062 the shortcut recorder arm; plan 055 the dashboard
    // push and get; plan 050 retired glass:wallpaper:get).
    expect(Object.keys(electronInvokeApiMethods)).toHaveLength(125)
    expect(new Set(Object.values(electronInvokeApiMethods)).size).toBe(125)
    expectTypeOf<ElectronInvokeArgs<'resource:trash-session-deletion'>>().toEqualTypeOf<
      Parameters<VideorcApi['trashSessionDeletion']>
    >()
    expectTypeOf<
      ElectronInvokeResult<'backend:get-connection'>
    >().toEqualTypeOf<BackendConnection | null>()
  })

  it('keeps the preload invoke and event surface exactly aligned with the maps', () => {
    expectTypeOf<ElectronEventChannelInvariant>().toEqualTypeOf<true>()
    const preload = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8')
    const invoked = [...preload.matchAll(/\binvoke\(\s*'([^']+)'/g)].map((match) => match[1]).sort()
    const subscribed = [...preload.matchAll(/\bsubscribe\('([^']+)'/g)]
      .map((match) => match[1])
      .sort()

    expect(invoked).toEqual(Object.keys(electronInvokeApiMethods).sort())
    expect(subscribed).toEqual([...electronEventChannels].sort())
    expect([...runtimeValidatedElectronInvokeChannels].sort()).toEqual(
      Object.keys(electronInvokeApiMethods).sort()
    )
    expect([...runtimeValidatedElectronEventChannels].sort()).toEqual(
      [...electronEventChannels].sort()
    )
    expect(electronInvokeRuntimeClassificationComplete).toEqual({})
    expect(electronEventRuntimeClassificationComplete).toEqual({})
    expect(boundedPassthroughElectronInvokeChannels.length).toBeGreaterThan(0)
    expect(boundedPassthroughElectronEventChannels.length).toBeGreaterThan(0)
  })

  it('refuses undeclared channels before dispatch', () => {
    expect(isElectronInvokeChannel('system:open-path')).toBe(false)
    expect(isElectronInvokeChannel('resource:open-session')).toBe(true)
    expect(isElectronInvokeChannel('shell:exec')).toBe(false)
    expect(isElectronInvokeChannel('toString')).toBe(false)
    expect(() => validateElectronInvokeArgs('shell:exec', ['calc.exe'])).toThrow(
      'Electron IPC channel is not declared'
    )
  })

  it('validates account authorization URLs and callback identifiers', () => {
    expect(validateElectronInvokeArgs('account:refresh', [])).toEqual([])
    expect(
      validateElectronInvokeResult('account:refresh', {
        outcome: 'refreshed',
        snapshot: {
          status: 'signed-in',
          username: 'orc',
          avatarUrl: 'https://example.com/avatar.png'
        }
      })
    ).toEqual({
      outcome: 'refreshed',
      snapshot: {
        status: 'signed-in',
        username: 'orc',
        avatarUrl: 'https://example.com/avatar.png'
      }
    })
    expect(validateElectronInvokeResult('account:refresh', { outcome: 'deferred' })).toEqual({
      outcome: 'deferred'
    })
    expect(() =>
      validateElectronInvokeResult('account:refresh', {
        outcome: 'refreshed',
        snapshot: { status: 'signed-in', adminToken: 'must-not-cross-ipc' }
      })
    ).toThrow('account:refresh.result')
    // A bare snapshot (the pre-073 wire shape) and a deferral carrying data
    // are both rejected rather than guessed at.
    expect(() =>
      validateElectronInvokeResult('account:refresh', { status: 'signed-in', username: 'orc' })
    ).toThrow('account:refresh.result')
    expect(() =>
      validateElectronInvokeResult('account:refresh', {
        outcome: 'deferred',
        snapshot: { status: 'signed-out' }
      })
    ).toThrow('account:refresh.result')
    expect(
      validateElectronInvokeArgs('account:begin-sign-in', [
        'https://www.videorc.com/desktop/authorize/v2?state=abc'
      ])
    ).toHaveLength(1)
    expect(() =>
      validateElectronInvokeArgs('account:begin-sign-in', ['javascript:alert(1)'])
    ).toThrow('allowed URL')
    expect(() =>
      validateElectronInvokeArgs('account:begin-sign-in', ['https://www.videorc.com/account'])
    ).toThrow('desktop authorization URL')
    expect(() =>
      validateElectronInvokeArgs('account:begin-sign-in', [
        'https://www.videorc.com/desktop/authorize'
      ])
    ).toThrow('desktop authorization URL')
    expect(() =>
      validateElectronInvokeArgs('account:begin-sign-in', [
        'https://attacker.example/desktop/authorize/v2'
      ])
    ).toThrow('desktop authorization URL')
    expect(() =>
      validateElectronInvokeArgs('account:begin-sign-in', [
        'https://user:password@www.videorc.com/desktop/authorize/v2'
      ])
    ).toThrow('allowed URL')
    expect(() => validateElectronInvokeArgs('account:callback-ack', [''])).toThrow(
      'at least 1 characters'
    )
  })

  it('opens only http and https chat links, without credentials (plan 151)', () => {
    expect(validateElectronInvokeArgs('chat:open-link', ['https://videorc.com/download'])).toEqual([
      'https://videorc.com/download'
    ])
    expect(validateElectronInvokeArgs('chat:open-link', ['http://example.com'])).toEqual([
      'http://example.com'
    ])
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@videorc.com',
      `https://videorc.com/${'a'.repeat(3000)}`,
      42
    ]) {
      expect(() => validateElectronInvokeArgs('chat:open-link', [url])).toThrow()
    }
    expect(() => validateElectronInvokeArgs('chat:open-link', [])).toThrow()
  })

  it('caches only https GIF assets from allowlisted hosts, unmodified (plan 155)', () => {
    const url = 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif?cid=x'
    expect(validateElectronInvokeArgs('chat-gifs:cache', [url])).toEqual([url])
    for (const refused of [
      'http://media2.giphy.com/media/a/giphy.gif',
      'https://cdn.7tv.app/emote/x/2x.webp',
      'https://giphy.com.evil.example/a.gif',
      'https://user:pass@i.giphy.com/a.gif',
      `https://i.giphy.com/${'a'.repeat(3000)}`,
      42
    ]) {
      expect(() => validateElectronInvokeArgs('chat-gifs:cache', [refused])).toThrow()
    }
    expect(() => validateElectronInvokeArgs('chat-gifs:cache', [])).toThrow()
    // The result is null or a managed cache URL, never a remote one.
    expect(validateElectronInvokeResult('chat-gifs:cache', null)).toBeNull()
    const local = `videorc-asset://avatar/${'0'.repeat(32)}.gif`
    expect(validateElectronInvokeResult('chat-gifs:cache', local)).toBe(local)
    expect(() => validateElectronInvokeResult('chat-gifs:cache', url)).toThrow()
    expect(() =>
      validateElectronInvokeResult('chat-gifs:cache', 'videorc-asset://avatar/../x.gif')
    ).toThrow()
  })

  it('relays the GIF display mode as one of three words (plan 155, D6)', () => {
    for (const mode of ['animated', 'still', 'off']) {
      expect(validateElectronInvokeArgs('chat-gifs:push-mode', [mode])).toEqual([mode])
      expect(validateElectronInvokeResult('chat-gifs:get-mode', mode)).toBe(mode)
      expect(validateElectronEventPayload('chat-gifs:mode', mode)).toBe(mode)
    }
    expect(() => validateElectronInvokeArgs('chat-gifs:push-mode', ['paused'])).toThrow()
    expect(() => validateElectronInvokeArgs('chat-gifs:push-mode', [true])).toThrow()
    expect(() => validateElectronInvokeResult('chat-gifs:get-mode', null)).toThrow()
    expect(() => validateElectronEventPayload('chat-gifs:mode', { mode: 'off' })).toThrow()
    expect(validateElectronInvokeArgs('chat-gifs:get-mode', [])).toEqual([])
  })

  it('exactly validates provider OAuth callback queue results', () => {
    const callback = {
      id: 'A'.repeat(43),
      url: 'videorc://oauth/callback?state=provider-state&code=opaque',
      state: 'provider-state',
      receivedAtMs: 123
    }

    expect(validateElectronInvokeResult('oauth:callbacks-list', [callback])).toEqual([callback])
    expect(validateElectronInvokeResult('oauth:callback-ack', true)).toBe(true)
    expect(validateElectronInvokeResult('oauth:callback-ack', false)).toBe(false)
    expect(() => validateElectronInvokeResult('oauth:callback-ack', 'yes')).toThrow(
      'oauth:callback-ack.result'
    )

    for (const malformed of [
      { ...callback, id: 'too-short' },
      { ...callback, state: 'different-state' },
      { ...callback, url: 'https://attacker.example/callback?state=provider-state&code=opaque' },
      { ...callback, receivedAtMs: -1 },
      { ...callback, unexpected: true }
    ]) {
      expect(() => validateElectronInvokeResult('oauth:callbacks-list', [malformed])).toThrow()
    }
    expect(() =>
      validateElectronInvokeResult(
        'oauth:callbacks-list',
        Array.from({ length: 33 }, () => callback)
      )
    ).toThrow('at most 32 items')
  })

  it('rejects non-finite native preview geometry and unbounded file batches', () => {
    const bounds = {
      screenX: 0,
      screenY: 0,
      width: 1280,
      height: 720,
      scaleFactor: 2,
      orderAboveWindowId: 42,
      elevated: false
    }
    expect(validateElectronInvokeArgs('preview-surface:create', [bounds, 3])).toEqual([bounds, 3])
    expect(() =>
      validateElectronInvokeArgs('preview-surface:create', [{ ...bounds, width: Number.NaN }, 3])
    ).toThrow('finite number')
    expect(() =>
      validateElectronInvokeArgs('preview-surface:create', [
        { ...bounds, orderAboveWindowHandle: '0x0000000000000001' },
        3
      ])
    ).toThrow('orderAboveWindowHandle')
    expect(() =>
      validateElectronInvokeArgs('resource:trash-session-deletion', ['x'.repeat(1025)])
    ).toThrow('at most 1024')
  })

  it('validates the docked-preview slot report at runtime, including the slot enum', () => {
    const report = {
      epoch: 3,
      slot: 'scene',
      x: 240,
      y: 96,
      width: 800,
      height: 450,
      visibleFraction: 1,
      mounted: true
    }
    // The slot must SURVIVE the boundary: a TypeScript-only field would be
    // dropped by a structural passthrough and the Scene canvas would never
    // become the live surface.
    expect(validateElectronInvokeArgs('preview-window:report-dock-slot', [report])).toEqual([
      report
    ])
    expect(
      validateElectronInvokeArgs('preview-window:report-dock-slot', [{ ...report, slot: 'studio' }])
    ).toEqual([{ ...report, slot: 'studio' }])
    expect(() =>
      validateElectronInvokeArgs('preview-window:report-dock-slot', [
        { ...report, slot: 'inspector' }
      ])
    ).toThrow('one of studio, scene')
    expect(() =>
      validateElectronInvokeArgs('preview-window:report-dock-slot', [
        { ...report, slot: undefined }
      ])
    ).toThrow('one of studio, scene')
    expect(() =>
      validateElectronInvokeArgs('preview-window:report-dock-slot', [{ ...report, x: Number.NaN }])
    ).toThrow('finite number')
    expect(() =>
      validateElectronInvokeArgs('preview-window:report-dock-slot', [
        { ...report, visibleFraction: 1.5 }
      ])
    ).toThrow()
    expect(() =>
      validateElectronInvokeArgs('preview-window:report-dock-slot', [{ ...report, screenX: 12 }])
    ).toThrow('screenX')
  })

  it('accepts only the four highlight corners over IPC and normalises everything else', () => {
    for (const anchor of COMMENT_HIGHLIGHT_ANCHORS) {
      expect(validateElectronInvokeArgs('comments-window:set-highlight-anchor', [anchor])).toEqual([
        anchor
      ])
      expect(normalizeCommentHighlightAnchor(anchor)).toBe(anchor)
    }
    // The old top/bottom vocabulary and free-form values never reach main.
    for (const forged of ['top', 'bottom', 'center', '', 7, null]) {
      expect(() =>
        validateElectronInvokeArgs('comments-window:set-highlight-anchor', [forged])
      ).toThrow()
    }
    expect(() => validateElectronInvokeArgs('comments-window:set-highlight-anchor', [])).toThrow()
    // A prefs file written before the setting existed has no value at all.
    expect(DEFAULT_COMMENT_HIGHLIGHT_ANCHOR).toBe('bottom-left')
    for (const stale of [undefined, null, 'top', 'TOP-LEFT', 3, {}]) {
      expect(normalizeCommentHighlightAnchor(stale)).toBe(DEFAULT_COMMENT_HIGHLIGHT_ANCHOR)
    }
  })

  it('accepts only a boolean for the Activity auto-show switch (plan 156)', () => {
    for (const on of [true, false]) {
      expect(validateElectronInvokeArgs('comments-window:set-auto-show-activity', [on])).toEqual([
        on
      ])
    }
    for (const forged of ['yes', 'true', 1, 0, null, {}]) {
      expect(() =>
        validateElectronInvokeArgs('comments-window:set-auto-show-activity', [forged])
      ).toThrow()
    }
    expect(() => validateElectronInvokeArgs('comments-window:set-auto-show-activity', [])).toThrow()
  })

  it('lets the Stream Manager name a platform to reconnect, never the scopes (plan 140)', () => {
    for (const platform of ['twitch', 'kick']) {
      const command = { requestId: 'reconnect-1', platform }
      expect(validateElectronInvokeArgs('comments-window:reconnect-scopes', [command])).toEqual([
        command
      ])
    }
    // YouTube never needs it and X authorizes elsewhere; free-form values,
    // a missing request id, and a smuggled scope list never reach main.
    for (const forged of [
      { requestId: 'r', platform: 'youtube' },
      { requestId: 'r', platform: 'x' },
      { requestId: 'r', platform: 'Twitch' },
      { requestId: 'r', platform: '' },
      { requestId: '', platform: 'twitch' },
      { platform: 'twitch' },
      { requestId: 'r', platform: 'twitch', optionalScopes: ['moderator:manage:banned_users'] },
      'twitch',
      null
    ]) {
      expect(() =>
        validateElectronInvokeArgs('comments-window:reconnect-scopes', [forged])
      ).toThrow()
    }
    expect(() => validateElectronInvokeArgs('comments-window:reconnect-scopes', [])).toThrow()
    expect(validateElectronInvokeResult('comments-window:reconnect-scopes', true)).toBe(true)
    expect(() =>
      validateElectronInvokeResult('comments-window:reconnect-scopes', 'opened')
    ).toThrow()
  })

  it('relays one manual removal or one card answer, never a source (plan 140, S6)', () => {
    const operationId = '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f'
    const remove = {
      requestId: 'r-1',
      sessionId: 'session-1',
      action: 'remove',
      operationId,
      messageId: 'session-1:twitch:default:m-1'
    }
    const confirm = { requestId: 'r-2', sessionId: 'session-1', action: 'confirm', operationId }
    const cancel = { requestId: 'r-3', sessionId: 'session-1', action: 'cancel', operationId }
    for (const command of [remove, confirm, cancel]) {
      expect(validateElectronInvokeArgs('comments-window:moderation', [command])).toEqual([command])
      expect(validateElectronEventPayload('comments-window:moderation-request', command)).toEqual(
        command
      )
    }
    // The window never picks the source, a countdown, a reason, or a bulk
    // target, and the id must be a UUID the backend can bind.
    for (const forged of [
      { ...remove, source: 'orcle-voice' },
      { ...remove, confirmMode: 'countdown' },
      { ...remove, reason: 'toxic' },
      { ...remove, messageId: '' },
      { ...remove, operationId: 'not-a-uuid' },
      { ...remove, action: 'ban' },
      { ...confirm, messageId: 'session-1:twitch:default:m-1' },
      { ...cancel, sessionId: '' },
      { requestId: 'r-4', action: 'remove', operationId, messageId: 'm' },
      null
    ]) {
      expect(() => validateElectronInvokeArgs('comments-window:moderation', [forged])).toThrow()
      expect(() =>
        validateElectronEventPayload('comments-window:moderation-request', forged)
      ).toThrow()
    }

    const operation = {
      operationId,
      sessionId: 'session-1',
      messageId: 'session-1:twitch:default:m-1',
      platform: 'twitch',
      authorName: 'coders_x',
      excerpt: 'this stream is trash',
      source: 'manual',
      phase: 'removed',
      confirmMode: 'confirm',
      requiresExplicitConfirm: false,
      outcome: 'Removed from Twitch.',
      outcomeCode: 'removed',
      createdAt: '2026-10-04T12:00:00Z',
      updatedAt: '2026-10-04T12:00:01Z',
      // A newer optional field passes through whole.
      laterField: 'kept'
    }
    expect(validateElectronInvokeResult('comments-window:moderation', operation)).toEqual(operation)
    expect(() =>
      validateElectronInvokeResult('comments-window:moderation', { ...operation, phase: 'gone' })
    ).toThrow()
    const resolution = { requestId: 'r-1', ok: true, value: operation }
    expect(
      validateElectronInvokeArgs('comments-window:moderation-result-push', [resolution])
    ).toEqual([resolution])
    expect(
      validateElectronInvokeArgs('comments-window:moderation-result-push', [
        { requestId: 'r-1', ok: false, error: 'At most 10 messages can be removed per minute.' }
      ])
    ).toHaveLength(1)
    expect(() =>
      validateElectronInvokeArgs('comments-window:moderation-result-push', [
        { ...resolution, extra: true }
      ])
    ).toThrow()
    expect(validateElectronInvokeResult('comments-window:moderation-result-push', true)).toBe(true)
  })

  it('relays one answer to a Golem command by id, nothing more (plan 140, S6 part B)', () => {
    const choose = {
      requestId: 'r-1',
      sessionId: 'session-1',
      action: 'choose',
      commandId: 'cmd-1',
      index: 2
    }
    const confirm = {
      requestId: 'r-2',
      sessionId: 'session-1',
      action: 'confirm',
      commandId: 'cmd-1'
    }
    const cancel = {
      requestId: 'r-3',
      sessionId: 'session-1',
      action: 'cancel',
      commandId: 'cmd-1'
    }
    for (const command of [choose, confirm, cancel]) {
      expect(validateElectronInvokeArgs('comments-window:cohost-command', [command])).toEqual([
        command
      ])
      expect(
        validateElectronEventPayload('comments-window:cohost-command-request', command)
      ).toEqual(command)
    }
    for (const forged of [
      { ...choose, index: 3 },
      { ...choose, index: -1 },
      { ...choose, index: 1.5 },
      { ...confirm, index: 0 },
      { ...cancel, commandId: '' },
      { ...cancel, action: 'remove' },
      { ...confirm, messageId: 'm-1' },
      { requestId: 'r-4', action: 'cancel', commandId: 'cmd-1' },
      null
    ]) {
      expect(() => validateElectronInvokeArgs('comments-window:cohost-command', [forged])).toThrow()
      expect(() =>
        validateElectronEventPayload('comments-window:cohost-command-request', forged)
      ).toThrow()
    }
    expect(
      validateElectronInvokeArgs('comments-window:cohost-command-result-push', [
        { requestId: 'r-1', ok: false, error: 'No such command waits for that answer.' }
      ])
    ).toHaveLength(1)
    expect(() =>
      validateElectronInvokeArgs('comments-window:cohost-command-result-push', [
        { requestId: 'r-1', ok: true, extra: 1 }
      ])
    ).toThrow()
  })

  it('carries a bounded list of removals in a live comments view only (plan 140, S6)', () => {
    const operation = {
      operationId: '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f',
      sessionId: 's',
      messageId: 's:twitch:default:m-1',
      platform: 'twitch',
      authorName: 'coders_x',
      excerpt: 'spam',
      source: 'orcle-voice',
      phase: 'pending-confirm',
      confirmMode: 'confirm',
      requiresExplicitConfirm: true,
      confirmBy: '2026-10-04T12:00:20Z',
      createdAt: '2026-10-04T12:00:00Z',
      updatedAt: '2026-10-04T12:00:00Z'
    }
    const view = {
      mode: { kind: 'live' },
      snapshot: { sessionId: 's', providers: [], messages: [], unreadCount: 0, updatedAt: 'now' },
      moderationOperations: [operation]
    }
    expect(validateElectronInvokeArgs('comments-window:push-snapshot', [view])).toEqual([view])
    expect(validateElectronEventPayload('comments-window:snapshot', view)).toEqual(view)
    expect(validateElectronInvokeResult('comments-window:get-snapshot', view)).toEqual(view)
    for (const malformed of [
      { ...view, moderationOperations: Array.from({ length: 101 }, () => operation) },
      { ...view, moderationOperations: [{ ...operation, phase: 'unknown' }] },
      { ...view, moderationOperations: [{ ...operation, operationId: '' }] },
      { ...view, moderationOperations: operation },
      {
        ...view,
        mode: { kind: 'history', sessionId: 's', title: 'Stream', startedAt: 'then' }
      }
    ]) {
      expect(() => validateElectronEventPayload('comments-window:snapshot', malformed)).toThrow()
    }
  })

  it('semantically validates native host, scene, and compositor IPC', () => {
    const bounds = {
      screenX: 0,
      screenY: 0,
      width: 1280,
      height: 720,
      scaleFactor: 2,
      cornerRadius: 18
    }
    const layout = {
      layoutPreset: 'screen-camera',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rounded',
      cameraCornerRadiusPct: 10,
      cameraAspect: 'source',
      cameraChromaKeyEnabled: false,
      cameraChromaKeyColor: '#00FF00',
      cameraChromaKeySimilarityPct: 40,
      cameraChromaKeySmoothnessPct: 8,
      cameraChromaKeySpillPct: 10,
      cameraMargin: 24,
      cameraFit: 'fill',
      cameraMirror: true,
      cameraZoom: 1,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '50-50',
      sideBySideCameraSide: 'right',
      verticalScreenFraming: 'fill',
      sourceVisibility: { camera: false, capture: true }
    }
    const compositor = {
      state: 'live',
      targetFps: 30,
      width: 1920,
      height: 1080,
      sceneSources: [],
      sources: [
        {
          kind: 'screen',
          state: 'live',
          sourceId: 'screen:1',
          sequence: 42,
          width: 1920,
          height: 1080,
          sourceFps: 30,
          frameAgeMs: 12
        }
      ],
      framesRendered: 42,
      repeatedFrames: 0,
      droppedFrames: 0,
      updatedAt: '2026-07-12T00:00:00.000Z'
    }
    const surfaceStatus = {
      state: 'live',
      source: 'screen',
      transport: 'native-surface',
      backing: 'cametal-layer',
      targetFps: 30,
      width: 1280,
      height: 720,
      framesRendered: 42,
      droppedFrames: 0,
      framePollingSuppressed: true,
      sourcePixelsPresent: true,
      pendingHostCommandCount: 0,
      bounds,
      updatedAt: '2026-07-12T00:00:00.000Z'
    }

    for (const channel of [
      'preview-surface:apply-host-commands',
      'preview-surface:update-scene',
      'preview-surface:update-compositor'
    ] as const) {
      expect(boundedPassthroughElectronInvokeChannels).not.toContain(channel)
    }

    expect(
      validateElectronInvokeArgs('preview-surface:apply-host-commands', [
        [{ kind: 'create', bounds }, { kind: 'update-bounds', bounds }, { kind: 'destroy' }],
        7
      ])
    ).toHaveLength(2)
    expect(() =>
      validateElectronInvokeArgs('preview-surface:apply-host-commands', [[{ kind: 'create' }], 7])
    ).toThrow('preview bounds for create')
    expect(() =>
      validateElectronInvokeArgs('preview-surface:apply-host-commands', [
        [{ kind: 'destroy' }],
        Number.MAX_SAFE_INTEGER + 1
      ])
    ).toThrow('safe integer')

    expect(
      validateElectronInvokeArgs('preview-surface:update-scene', [
        { revision: 4, scene: null, layout, activeScreen: null }
      ])
    ).toHaveLength(1)
    expect(() =>
      validateElectronInvokeArgs('preview-surface:update-scene', [
        {
          revision: 4,
          scene: null,
          layout: { ...layout, layoutPreset: 'attacker-controlled' }
        }
      ])
    ).toThrow('one of screen-camera')

    for (const sourceVisibility of [
      null,
      { camera: 'false' },
      { capture: 0 },
      { microphone: false }
    ]) {
      expect(() =>
        validateElectronInvokeArgs('preview-surface:update-scene', [
          { revision: 4, scene: null, layout: { ...layout, sourceVisibility }, activeScreen: null }
        ])
      ).toThrow('sourceVisibility')
    }

    expect(validateElectronInvokeArgs('preview-surface:update-compositor', [compositor])).toEqual([
      compositor
    ])
    expect(
      validateElectronInvokeArgs('preview-surface:set-frame-polling-suppressed', [true, 7, true])
    ).toEqual([true, 7, true])
    expect(() =>
      validateElectronInvokeArgs('preview-surface:set-frame-polling-suppressed', [true, true])
    ).toThrow('set-frame-polling-suppressed.args')
    expect(() =>
      validateElectronInvokeArgs('preview-surface:update-compositor', [
        { ...compositor, state: 'attacker-controlled' }
      ])
    ).toThrow('one of stopped')
    expect(() =>
      validateElectronInvokeArgs('preview-surface:update-compositor', [
        {
          ...compositor,
          sources: [{ kind: 'screen', state: 'live', sequence: Number.MAX_SAFE_INTEGER + 1 }]
        }
      ])
    ).toThrow('safe integer')
    expect(
      validateElectronInvokeResult('preview-surface:update-compositor', surfaceStatus)
    ).toEqual(surfaceStatus)
    expect(
      validateElectronInvokeResult('preview-surface:set-frame-polling-suppressed', surfaceStatus)
    ).toEqual(surfaceStatus)
    expect(
      validateElectronInvokeResult('preview-surface:drain-host-commands', surfaceStatus)
    ).toEqual(surfaceStatus)
    const d3d11SurfaceStatus = {
      ...surfaceStatus,
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter'
    }
    expect(validateElectronInvokeResult('preview-surface:status', d3d11SurfaceStatus)).toEqual(
      d3d11SurfaceStatus
    )
    for (const invalid of [
      { ...surfaceStatus, bounds: { ...bounds, cornerRadius: -1 } },
      { ...surfaceStatus, bounds: { ...bounds, cornerRadius: 257 } }
    ]) {
      expect(() => validateElectronInvokeResult('preview-surface:status', invalid)).toThrow()
      expect(() =>
        validateElectronInvokeResult('preview-surface:drain-host-commands', invalid)
      ).toThrow()
    }
    for (const leaked of [
      { ...d3d11SurfaceStatus, nativeWindowHandle: '0x0000000000000001' },
      { ...d3d11SurfaceStatus, processId: 42 },
      { ...d3d11SurfaceStatus, sharedTextureHandle: '0x0000000000000002' },
      {
        ...d3d11SurfaceStatus,
        bounds: { ...bounds, orderAboveWindowHandle: '0x0000000000000001' }
      },
      {
        ...d3d11SurfaceStatus,
        windowsD3d11Presenter: {
          resourceHandle: '0x0000000000000003'
        }
      }
    ]) {
      expect(() => validateElectronInvokeResult('preview-surface:status', leaked)).toThrow(
        /renderer-facing/
      )
    }
    expect(() =>
      validateElectronInvokeResult('preview-surface:set-frame-polling-suppressed', true)
    ).toThrow('set-frame-polling-suppressed.result')
    expect(() =>
      validateElectronInvokeResult('preview-surface:update-compositor', {
        ...surfaceStatus,
        transport: 'remote-webview'
      })
    ).toThrow('one of native-surface')
  })

  it('validates security-sensitive main-to-renderer event payloads', () => {
    const callback = {
      id: 'callback-1',
      url: 'videorc://account/callback?code=opaque',
      state: '0123456789abcdef0123456789abcdef',
      intentGeneration: 7,
      receivedAtMs: 123,
      expiresAtMs: 456
    }
    expect(validateElectronEventPayload('account:callback', callback)).toEqual(callback)
    expect(() =>
      validateElectronEventPayload('account:callback', { ...callback, state: 'too-short' })
    ).toThrow('at least 32 characters')
    expect(() =>
      validateElectronEventPayload('account:callback', { ...callback, expiresAtMs: 122 })
    ).toThrow('callback deadline after receipt')
    expect(() =>
      validateElectronEventPayload('account:callback', { ...callback, intentGeneration: 0 })
    ).toThrow('positive safe integer')
    expect(() =>
      validateElectronEventPayload('backend:connection', {
        host: 'attacker.example',
        port: 443,
        token: '0123456789abcdef'
      })
    ).toThrow('one of 127.0.0.1')
    expect(
      validateElectronEventPayload('oauth:callback-url', {
        id: 'A'.repeat(43),
        url: 'videorc://oauth/callback?state=provider-state&code=opaque',
        state: 'provider-state',
        receivedAtMs: 123
      })
    ).toMatchObject({ state: 'provider-state' })
    expect(() =>
      validateElectronEventPayload('oauth:callback-url', {
        id: 'A'.repeat(43),
        url: 'videorc://oauth/callback?state=x&code=opaque',
        state: 'x',
        receivedAtMs: 123
      })
    ).toThrow('complete provider OAuth callback URL')
    expect(() => validateElectronEventPayload('shortcut:navigate', 'F12')).toThrow('one of 1, 2, 3')
  })

  it('bounds every fallback contract and Notes persistence payload', () => {
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 18; depth += 1) nested = { nested }

    expect(() => validateElectronInvokeArgs('app:set-native-theme', [nested])).toThrow(
      'bounded structured-clone value'
    )
    expect(() =>
      validateElectronEventPayload('backend:log', {
        level: 'info',
        message: 'test',
        timestamp: '2026-07-12T00:00:00.000Z',
        invalid: Number.NaN
      })
    ).toThrow('finite number')
    expect(() =>
      validateElectronInvokeArgs('notes-window:save-document', [
        { text: 'x'.repeat(MAX_NOTES_TEXT_LENGTH + 1) }
      ])
    ).toThrow(`at most ${MAX_NOTES_TEXT_LENGTH} characters`)
  })
})

describe('cached chat image bytes IPC (plan 095)', () => {
  it('returns null or bounded bytes, never another structured-clone value', () => {
    const localUrl = 'videorc-asset://avatar/0123456789abcdef0123456789abcdef.png'
    expect(validateElectronInvokeArgs('avatars:read', [localUrl])).toEqual([localUrl])
    expect(() => validateElectronInvokeArgs('avatars:read', [''])).toThrow()
    expect(validateElectronInvokeResult('avatars:read', null)).toBeNull()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(validateElectronInvokeResult('avatars:read', bytes)).toBe(bytes)
    expect(() => validateElectronInvokeResult('avatars:read', new Uint8Array(0))).toThrow(
      'image bytes'
    )
    expect(() =>
      validateElectronInvokeResult('avatars:read', new Uint8Array(CHAT_AVATAR_MAX_BYTES + 1))
    ).toThrow('image bytes')
    expect(() => validateElectronInvokeResult('avatars:read', 'cG5n')).toThrow('image bytes')
    expect(() => validateElectronInvokeResult('avatars:read', { length: 4 })).toThrow('image bytes')
    expect(() => validateElectronInvokeResult('avatars:read', [0x89, 0x50])).toThrow('image bytes')
  })
})

describe('shortcut recorder IPC', () => {
  it('arms with a boolean and forwards only the physical key and modifier flags', () => {
    expect(validateElectronInvokeArgs('shortcut-recorder:set-armed', [true])).toEqual([true])
    expect(() => validateElectronInvokeArgs('shortcut-recorder:set-armed', ['yes'])).toThrow()
    const key = {
      type: 'keyDown',
      code: 'KeyM',
      meta: true,
      control: false,
      alt: false,
      shift: true
    }
    expect(validateElectronEventPayload('shortcut-recorder:key', key)).toEqual(key)
    expect(() =>
      validateElectronEventPayload('shortcut-recorder:key', { ...key, key: 'm' })
    ).toThrow()
    expect(() =>
      validateElectronEventPayload('shortcut-recorder:key', { ...key, type: 'char' })
    ).toThrow()
    expect(validateElectronEventPayload('shortcut-recorder:disarmed', undefined)).toBeUndefined()
  })
})

describe('global layout shortcut IPC', () => {
  it('accepts every canonical action and rejects unknown payloads', () => {
    for (const action of GLOBAL_SHORTCUT_ACTIONS)
      expect(validateElectronEventPayload('global-shortcuts:triggered', action)).toBe(action)
    expect(() =>
      validateElectronEventPayload('global-shortcuts:triggered', 'layout:unknown')
    ).toThrow()
    expect(() =>
      validateElectronInvokeArgs('global-shortcuts:set', [{ layouts: { unknown: 'Control+1' } }])
    ).toThrow()
    expect(() =>
      validateElectronInvokeArgs('global-shortcuts:set', [{ layoutNext: 123 }])
    ).toThrow()
    expect(() =>
      validateElectronInvokeArgs('global-shortcuts:set', [
        { layoutNext: 'Control+Alt+N', layouts: { 'camera-only': 'Control+Alt+C' } }
      ])
    ).not.toThrow()
  })

  it('admits every single-action binding the Settings recorder can write', () => {
    // A hand-kept key list once missed clipMark (plan 068), which rejected the
    // whole config and dropped every global shortcut with it.
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      expect(() =>
        validateElectronInvokeArgs('global-shortcuts:set', [
          withGlobalShortcut({}, action, 'Control+Alt+S')
        ])
      ).not.toThrow()
    }
    expect(() =>
      validateElectronInvokeArgs('global-shortcuts:set', [{ systemAudioToggle: 'Control+Alt+S' }])
    ).not.toThrow()
    expect(() =>
      validateElectronInvokeArgs('global-shortcuts:set', [{ systemAudioMute: 'Control+Alt+S' }])
    ).toThrow()
  })
})

describe('comments delivery IPC metadata', () => {
  const delivery = { ownerId: 'provider-current', generation: 1, sequence: 0, entries: [] }
  const view = {
    mode: { kind: 'live' },
    snapshot: { providers: [], messages: [], unreadCount: 0, updatedAt: 'now', delivery }
  }
  it('preserves adoption, clear and snapshot metadata through invoke/result/event mirrors', () => {
    for (const kind of ['adopt', 'clear']) {
      const delta = {
        kind,
        deliveryBoundary: { ownerId: delivery.ownerId, generation: delivery.generation },
        updatedAt: 'now'
      }
      expect(validateElectronInvokeArgs('comments-window:push-delta', [delta])).toEqual([delta])
      expect(validateElectronEventPayload('comments-window:delta', delta)).toEqual(delta)
    }
    expect(validateElectronInvokeArgs('comments-window:push-snapshot', [view])).toEqual([view])
    expect(validateElectronInvokeResult('comments-window:get-snapshot', view)).toEqual(view)
    expect(validateElectronEventPayload('comments-window:snapshot', view)).toEqual(view)
  })
  it.each([
    null,
    { ...delivery, ownerId: '' },
    { ...delivery, generation: NaN },
    { ...delivery, sequence: Infinity },
    { ...delivery, entries: Array(2001).fill(null) },
    { ...delivery, source: null },
    { ...delivery, secret: 'never allowed' }
  ])('rejects invalid delivery evidence at all snapshot boundaries', (invalid) => {
    const malformed = { ...view, snapshot: { ...view.snapshot, delivery: invalid } }
    expect(() => validateElectronInvokeArgs('comments-window:push-snapshot', [malformed])).toThrow()
    expect(() => validateElectronInvokeResult('comments-window:get-snapshot', malformed)).toThrow()
    expect(() => validateElectronEventPayload('comments-window:snapshot', malformed)).toThrow()
  })
  it('rejects malformed control boundaries and keeps the existing global payload limit', () => {
    for (const boundary of [
      null,
      { ownerId: 'owner', generation: -1 },
      { ownerId: 'owner', generation: 0, sequence: 0 }
    ]) {
      const delta = { kind: 'adopt', deliveryBoundary: boundary, updatedAt: 'now' }
      expect(() => validateElectronInvokeArgs('comments-window:push-delta', [delta])).toThrow()
      expect(() => validateElectronEventPayload('comments-window:delta', delta)).toThrow()
    }
    const huge = { ...view, nested: Array.from({ length: 10_000 }, () => Array(11).fill(1)) }
    expect(() => validateElectronInvokeArgs('comments-window:push-snapshot', [huge])).toThrow()
  })
})

it('accepts representative full retained rows plus a reduced 2,000-entry journal within unchanged IPC limits', () => {
  const messages = Array.from({ length: 2000 }, (_, index) => ({
    id: `s:twitch:${index}`,
    providerMessageId: String(index),
    sessionId: 's',
    platform: 'twitch',
    authorName: 'Viewer',
    authorId: `viewer-${index}`,
    authorBadges: ['subscriber'],
    authorRoles: ['subscriber'],
    publishedAt: '2026-10-03T00:00:00Z',
    receivedAt: '2026-10-03T00:00:00Z',
    messageText: 'Hello @orc',
    fragments: [{ type: 'text', text: 'Hello @orc' }],
    eventType: 'paid',
    isDeleted: false,
    details: { kind: 'super-chat', amountMicros: 1_000_000, currency: 'USD', amountDisplay: '$1' }
  }))
  const entries = messages.map((message, index) => ({
    sequence: index + 1,
    message: {
      id: message.id,
      platform: message.platform,
      authorName: message.authorName,
      messageText: message.messageText,
      eventType: message.eventType,
      isDeleted: false,
      activity: true
    }
  }))
  const view = {
    mode: { kind: 'live' },
    snapshot: {
      sessionId: 's',
      providers: [],
      messages,
      unreadCount: 0,
      updatedAt: 'now',
      delivery: { ownerId: 'owner', generation: 0, sequence: 2000, entries }
    }
  }
  expect(validateElectronInvokeArgs('comments-window:push-snapshot', [view])).toEqual([view])
  expect(validateElectronEventPayload('comments-window:snapshot', view)).toEqual(view)
})

it('preserves and validates queue-loss revisions through delivery IPC mirrors', () => {
  const view = {
    mode: { kind: 'live' },
    snapshot: {
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: 'now',
      delivery: { ownerId: 'owner', generation: 0, sequence: 0, entries: [], lossRevision: 1 }
    }
  }
  expect(validateElectronInvokeArgs('comments-window:push-snapshot', [view])).toEqual([view])
  expect(validateElectronInvokeResult('comments-window:get-snapshot', view)).toEqual(view)
  expect(validateElectronEventPayload('comments-window:snapshot', view)).toEqual(view)
  for (const lossRevision of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      validateElectronEventPayload('comments-window:snapshot', {
        ...view,
        snapshot: { ...view.snapshot, delivery: { ...view.snapshot.delivery, lossRevision } }
      })
    ).toThrow()
})
