import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { normalizeLayoutSettings } from '../renderer/src/lib/capture'
import type {
  AccountCallbackEnvelope,
  CompositorStatus,
  LayoutSettings,
  PreviewSurfaceBounds,
  RecordingStatus,
  Scene,
  SessionCommentsListParams,
  SessionCommentsPage,
  SessionDeletionOperation
} from './backend'
import { normalizeSessionCommentsListParams } from './backend'
import {
  validateBackendRpcParams,
  validateBackendRpcResult,
  type BackendRpcParams
} from './backend-rpc-contract'
import { validateElectronEventPayload, validateElectronInvokeArgs } from './electron-ipc-contract'
import { normalizePreviewSurfaceBounds } from './native-preview-bounds'

interface HighRiskContractFixtures {
  schemaVersion: 2
  previewSurfaceBounds: {
    wire: PreviewSurfaceBounds
    normalized: PreviewSurfaceBounds
    legacyWire: PreviewSurfaceBounds
    legacyNormalized: PreviewSurfaceBounds
  }
  layout: {
    legacyWire: Partial<LayoutSettings>
    normalized: LayoutSettings
  }
  scene: { wire: Scene }
  recordingStatus: {
    wire: RecordingStatus
    minimalWire: RecordingStatus
    minimalNormalized: RecordingStatus
  }
  compositorStatus: { stoppedWire: CompositorStatus }
  account: {
    callbackEnvelope: AccountCallbackEnvelope
    completeSignInParams: BackendRpcParams<'account.complete_sign_in'>
  }
  comments: {
    listParamsWire: SessionCommentsListParams
    listParamsNormalized: SessionCommentsListParams & { limit: number }
    page: SessionCommentsPage
    terminalPage: SessionCommentsPage
    deleteParams: BackendRpcParams<'sessions.delete'>
    deletionOperation: SessionDeletionOperation
  }
}

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/high-risk-contracts.json', import.meta.url),
    'utf8'
  )
) as HighRiskContractFixtures

function jsonShape(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe('shared high-risk protocol fixture', () => {
  it('has the expected schema version', () => {
    expect(fixtures.schemaVersion).toBe(2)
  })

  it('keeps native preview bounds and detached stacking fields through IPC normalization', () => {
    expect(
      validateElectronInvokeArgs('preview-surface:update-bounds', [
        fixtures.previewSurfaceBounds.wire,
        7
      ])[0]
    ).toStrictEqual(fixtures.previewSurfaceBounds.wire)
    expect(jsonShape(normalizePreviewSurfaceBounds(fixtures.previewSurfaceBounds.wire))).toEqual(
      fixtures.previewSurfaceBounds.normalized
    )
    expect(
      jsonShape(normalizePreviewSurfaceBounds(fixtures.previewSurfaceBounds.legacyWire))
    ).toEqual(fixtures.previewSurfaceBounds.legacyNormalized)
    expect(fixtures.previewSurfaceBounds.normalized).toMatchObject({
      orderAboveWindowId: 4242,
      elevated: false
    })
  })

  it('normalizes legacy layouts and validates the exact scene wire shape', () => {
    expect(normalizeLayoutSettings(fixtures.layout.legacyWire)).toStrictEqual(
      fixtures.layout.normalized
    )
    expect(jsonShape(validateBackendRpcResult('scene.get', fixtures.scene.wire))).toEqual(
      fixtures.scene.wire
    )
  })

  it('validates full and defaulted recording status shapes', () => {
    expect(
      jsonShape(validateBackendRpcResult('recording.status', fixtures.recordingStatus.wire))
    ).toEqual(fixtures.recordingStatus.wire)
    expect(
      jsonShape(validateBackendRpcResult('recording.status', fixtures.recordingStatus.minimalWire))
    ).toEqual(fixtures.recordingStatus.minimalNormalized)
  })

  it('accepts the Rust stopped compositor wire shape without nullable metrics', () => {
    expect(
      jsonShape(
        validateBackendRpcResult('compositor.status', fixtures.compositorStatus.stoppedWire)
      )
    ).toEqual(fixtures.compositorStatus.stoppedWire)
    expect(fixtures.compositorStatus.stoppedWire).not.toHaveProperty('renderFps')
    expect(fixtures.compositorStatus.stoppedWire).not.toHaveProperty('frameAgeMs')
    expect(fixtures.compositorStatus.stoppedWire).not.toHaveProperty('frameTimeP95Ms')
  })

  it('validates the durable account callback envelope and PKCE completion params', () => {
    expect(
      validateElectronEventPayload('account:callback', fixtures.account.callbackEnvelope)
    ).toStrictEqual(fixtures.account.callbackEnvelope)
    expect(
      validateBackendRpcParams('account.complete_sign_in', fixtures.account.completeSignInParams)
    ).toStrictEqual(fixtures.account.completeSignInParams)
  })

  it('keeps comment pagination defaults and deletion DTOs identical', () => {
    expect(normalizeSessionCommentsListParams(fixtures.comments.listParamsWire)).toStrictEqual(
      fixtures.comments.listParamsNormalized
    )
    expect(
      jsonShape(
        validateBackendRpcParams('sessions.comments.list', fixtures.comments.listParamsNormalized)
      )
    ).toEqual(fixtures.comments.listParamsNormalized)
    expect(
      validateBackendRpcResult('sessions.comments.list', fixtures.comments.page)
    ).toStrictEqual(fixtures.comments.page)
    expect(
      validateBackendRpcResult('sessions.comments.list', fixtures.comments.terminalPage)
    ).toStrictEqual(fixtures.comments.terminalPage)
    expect(fixtures.comments.page.nextCursor).toContain('\n')
    expect(
      validateBackendRpcParams('sessions.delete', fixtures.comments.deleteParams)
    ).toStrictEqual(fixtures.comments.deleteParams)
    for (const method of ['sessions.delete', 'sessions.delete.pending']) {
      expect(validateBackendRpcResult(method, [fixtures.comments.deletionOperation])).toStrictEqual(
        [fixtures.comments.deletionOperation]
      )
    }
  })
})
