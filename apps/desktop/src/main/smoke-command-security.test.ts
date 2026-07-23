import { once } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PACKAGED_SMOKE_COMMAND_NAMES,
  SMOKE_BACKEND_RPC_METHOD_NAMES,
  createSmokeCommandCapability,
  handleSmokeCommandRequest,
  smokeCommandServerAllowed,
  smokePreviewFrameUrl,
  smokeRequestAuthorized,
  validateSmokeBackendRpcRequest,
  validateSmokeCommandPayload,
  validateSmokeResourceAuthorization
} from './smoke-command-security'

describe('smoke command security', () => {
  it('keeps normal packaged apps disabled and requires a harness-provided capability', () => {
    expect(smokeCommandServerAllowed(true, false)).toBe(true)
    expect(smokeCommandServerAllowed(true, true)).toBe(false)
    expect(smokeCommandServerAllowed(true, true, 'short')).toBe(false)
    expect(smokeCommandServerAllowed(true, true, 'x'.repeat(43))).toBe(true)
    expect(smokeCommandServerAllowed(false, false)).toBe(false)
  })

  it('requires the exact per-run bearer capability', () => {
    expect(smokeRequestAuthorized('Bearer secret', 'secret')).toBe(true)
    expect(smokeRequestAuthorized('Bearer wrong', 'secret')).toBe(false)
    expect(smokeRequestAuthorized(undefined, 'secret')).toBe(false)
    expect(smokeRequestAuthorized('Bearer ', '')).toBe(false)
  })

  it('creates a fresh 256-bit URL-safe capability for each server run', () => {
    const first = createSmokeCommandCapability()
    const second = createSmokeCommandCapability()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
  })

  it('keeps synthetic preview frames off the loopback HTTP server', () => {
    expect(smokePreviewFrameUrl()).toBe('videorc-asset://smoke-preview/frame.svg')
    expect(smokePreviewFrameUrl(1279.6)).toBe(
      'videorc-asset://smoke-preview/frame.svg?maxWidth=1280'
    )
  })

  it('accepts only known commands with bounded JSON params', () => {
    expect(
      validateSmokeCommandPayload({ command: 'open-tab', params: { tab: 'settings' } })
    ).toEqual({ command: 'open-tab', params: { tab: 'settings' } })
    expect(validateSmokeCommandPayload({ command: 'totally-unknown', params: {} })).toBeNull()
    expect(validateSmokeCommandPayload({ command: 'open-tab', params: [] })).toBeNull()
    expect(validateSmokeCommandPayload({ command: 'eval-js', params: {} })).toBeNull()
    expect(
      validateSmokeCommandPayload({
        command: 'authorize-smoke-resource',
        params: { kind: 'input-file', path: '/tmp/fixture.png' }
      })
    ).toEqual({
      command: 'authorize-smoke-resource',
      params: { kind: 'input-file', path: '/tmp/fixture.png' }
    })
    expect(
      validateSmokeCommandPayload({
        command: 'import-smoke-background',
        params: { path: '/tmp/fixture.png' }
      })
    ).toEqual({
      command: 'import-smoke-background',
      params: { path: '/tmp/fixture.png' }
    })
    expect(
      validateSmokeCommandPayload({
        command: 'open-tab',
        params: { nested: { constructor: 'blocked' } }
      })
    ).toBeNull()
  })

  it('authorizes only regular resources canonically contained by the smoke state directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'videorc-smoke-resource-'))
    const stateDirectory = join(parent, 'state')
    const outputDirectory = join(stateDirectory, 'recordings')
    const outsideDirectory = join(parent, 'state-sibling')
    const inputFile = join(stateDirectory, 'fixture.png')
    const outsideFile = join(outsideDirectory, 'outside.png')
    mkdirSync(outputDirectory, { recursive: true })
    mkdirSync(outsideDirectory)
    writeFileSync(inputFile, 'fixture')
    writeFileSync(outsideFile, 'outside')

    expect(
      validateSmokeResourceAuthorization({ kind: 'input-file', path: inputFile }, stateDirectory)
    ).toEqual({ kind: 'input-file', path: realpathSync(inputFile) })
    expect(
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: outputDirectory },
        stateDirectory
      )
    ).toEqual({ kind: 'output-directory', path: realpathSync(outputDirectory) })
    expect(
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: stateDirectory },
        stateDirectory
      )
    ).toEqual({ kind: 'output-directory', path: realpathSync(stateDirectory) })
    expect(() =>
      validateSmokeResourceAuthorization({ kind: 'input-file', path: outsideFile }, stateDirectory)
    ).toThrow(/inside the smoke state directory/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'input-file', path: outputDirectory },
        stateDirectory
      )
    ).toThrow(/regular file/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: inputFile },
        stateDirectory
      )
    ).toThrow(/directory/)
  })

  it('rejects missing, malformed, oversized, and direct-symlink smoke resources', () => {
    const parent = mkdtempSync(join(tmpdir(), 'videorc-smoke-resource-'))
    const stateDirectory = join(parent, 'state')
    const targetDirectory = join(stateDirectory, 'target')
    const linkedDirectory = join(stateDirectory, 'linked')
    mkdirSync(targetDirectory, { recursive: true })
    symlinkSync(targetDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: linkedDirectory },
        stateDirectory
      )
    ).toThrow(/symbolic link/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: join(stateDirectory, 'missing') },
        stateDirectory
      )
    ).toThrow(/does not exist/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'open-path', path: targetDirectory },
        stateDirectory
      )
    ).toThrow(/Invalid smoke resource authorization/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: targetDirectory, extra: true },
        stateDirectory
      )
    ).toThrow(/Invalid smoke resource authorization/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: 'x'.repeat(4_097) },
        stateDirectory
      )
    ).toThrow(/Invalid smoke resource authorization/)
    expect(() =>
      validateSmokeResourceAuthorization(
        { kind: 'output-directory', path: targetDirectory },
        undefined
      )
    ).toThrow(/Invalid smoke resource authorization/)
  })

  it('keeps the protected backend bridge on a small debug-only RPC allowlist', () => {
    expect(SMOKE_BACKEND_RPC_METHOD_NAMES).toEqual(
      new Set([
        'audio.test.inject-pcm',
        'captions.test.inject-audio',
        'captions.test.snapshot',
        'compositor.scene.update',
        'encoder_bridge.synthetic_record',
        'recording.start_test'
      ])
    )
    expect(
      validateSmokeBackendRpcRequest({
        method: 'captions.test.snapshot',
        params: {},
        timeoutMs: 30_000
      })
    ).toEqual({ method: 'captions.test.snapshot', params: {}, timeoutMs: 30_000 })
    expect(
      validateSmokeBackendRpcRequest({ method: 'resource.capability.issue', params: {} })
    ).toBeNull()
    expect(
      validateSmokeBackendRpcRequest({ method: 'captions.test.snapshot', params: [] })
    ).toBeNull()
    expect(
      validateSmokeBackendRpcRequest({
        method: 'captions.test.snapshot',
        params: {},
        timeoutMs: 300_001
      })
    ).toBeNull()
  })

  it('returns 401 before routing an unauthenticated request and 400 for malformed JSON', async () => {
    const capability = 'test-capability'
    const calls: Array<{ command: string; params: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      void handleSmokeCommandRequest(request, response, {
        capability,
        runCommand: async (command, params) => {
          calls.push({ command, params })
          return { accepted: true }
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    try {
      const address = server.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      if (!address || typeof address === 'string') return
      const origin = `http://127.0.0.1:${address.port}`
      const endpoint = `${origin}/command`

      const unauthenticated = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ command: 'open-tab', params: { tab: 'studio' } })
      })
      expect(unauthenticated.status).toBe(401)
      expect(await unauthenticated.json()).toMatchObject({ ok: false })
      expect(calls).toHaveLength(0)

      const unauthenticatedHealth = await fetch(`${origin}/health`)
      expect(unauthenticatedHealth.status).toBe(401)

      const authenticatedHealth = await fetch(`${origin}/health`, {
        headers: { Authorization: `Bearer ${capability}` }
      })
      expect(authenticatedHealth.status).toBe(200)
      expect(await authenticatedHealth.json()).toEqual({ ok: true })

      const malformed = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${capability}` },
        body: '{'
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toMatchObject({ ok: false })
      expect(calls).toHaveLength(0)

      const removedPreviewEndpoint = await fetch(`${origin}/preview-frame.png`, {
        headers: { Authorization: `Bearer ${capability}` }
      })
      expect(removedPreviewEndpoint.status).toBe(404)

      const accepted = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${capability}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command: 'open-tab', params: { tab: 'studio' } })
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ ok: true, result: { accepted: true } })
      expect(calls).toEqual([{ command: 'open-tab', params: { tab: 'studio' } }])
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('restricts an authenticated packaged harness to the preview gate command subset', async () => {
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('authorize-smoke-resource')).toBe(false)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('import-smoke-background')).toBe(false)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('inspect-packaged-bundled-background')).toBe(true)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('windows-live-audio-harness')).toBe(true)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('notes-window-open')).toBe(true)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('comments-window-open')).toBe(true)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('captions-window-open')).toBe(true)
    expect(PACKAGED_SMOKE_COMMAND_NAMES.has('eval-js')).toBe(false)
    const capability = 'x'.repeat(43)
    const server = createServer((request, response) => {
      void handleSmokeCommandRequest(request, response, {
        capability,
        allowedCommands: PACKAGED_SMOKE_COMMAND_NAMES,
        runCommand: async () => ({ accepted: true })
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    try {
      const address = server.address()
      if (!address || typeof address === 'string') return
      const response = await fetch(`http://127.0.0.1:${address.port}/command`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${capability}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          command: 'authorize-smoke-resource',
          params: { kind: 'input-file', path: '/tmp/fixture.png' }
        })
      })
      expect(response.status).toBe(403)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
