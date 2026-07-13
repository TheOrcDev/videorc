import { readFileSync } from 'node:fs'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { BackendConnection, VideorcApi } from './backend'
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
    expect(Object.keys(electronInvokeApiMethods)).toHaveLength(93)
    expect(new Set(Object.values(electronInvokeApiMethods)).size).toBe(93)
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
    const invoked = [...preload.matchAll(/\binvoke\('([^']+)'/g)].map((match) => match[1]).sort()
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
      validateElectronInvokeArgs('resource:trash-session-deletion', ['x'.repeat(1025)])
    ).toThrow('at most 1024')
  })

  it('semantically validates native host, scene, and compositor IPC', () => {
    const bounds = {
      screenX: 0,
      screenY: 0,
      width: 1280,
      height: 720,
      scaleFactor: 2
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
      sideBySideCameraSide: 'right'
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

    expect(validateElectronInvokeArgs('preview-surface:update-compositor', [compositor])).toEqual([
      compositor
    ])
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
