import { describe, expect, it } from 'vitest'

import {
  latestLayoutTransactionCommit,
  idlePreviewLayoutProofRequired,
  layoutTransactionBackendSnapshotIsStable,
  layoutTransactionFailureReconciliation,
  layoutTransactionFailureDisposition,
  layoutTransactionProofDisposition,
  layoutTransactionUnprovenSeverity,
  liveBackgroundCommitDecision,
  NativePreviewPresentationProofError,
  shouldReloadSceneFromCaptureConfig
} from './layout-transaction-policy'

describe('layout transaction policy', () => {
  it('requires idle preview proof only when a detached preview can present', () => {
    expect(idlePreviewLayoutProofRequired({ surfaceCanPresent: false })).toBe(false)
    expect(idlePreviewLayoutProofRequired({ surfaceCanPresent: true })).toBe(true)
  })

  it('reconciles the UI to a current backend commit when presentation proof times out', () => {
    expect(
      layoutTransactionProofDisposition({
        latestIntentId: 42,
        committedIntentId: 42,
        proofSucceeded: false
      })
    ).toBe('apply-unproven')
  })

  it('applies a current commit after presentation proof succeeds', () => {
    expect(
      layoutTransactionProofDisposition({
        latestIntentId: 42,
        committedIntentId: 42,
        proofSucceeded: true
      })
    ).toBe('apply-proven')
  })

  it('never lets an older response overwrite the latest intent', () => {
    expect(
      layoutTransactionProofDisposition({
        latestIntentId: 43,
        committedIntentId: 42,
        proofSucceeded: false
      })
    ).toBe('ignore-stale')
  })

  it('live-commits a background change only after the session armed the watcher', () => {
    // Idle: never commit, stay disarmed.
    expect(
      liveBackgroundCommitDecision({
        sessionActive: false,
        armedFingerprint: 'a',
        fingerprint: 'b'
      })
    ).toEqual({ next: null, commit: false })
    // Session rising edge: start params already carry the background — arm only.
    expect(
      liveBackgroundCommitDecision({
        sessionActive: true,
        armedFingerprint: null,
        fingerprint: 'a'
      })
    ).toEqual({ next: 'a', commit: false })
    // Unchanged value (registry edited an inactive slot): no commit.
    expect(
      liveBackgroundCommitDecision({ sessionActive: true, armedFingerprint: 'a', fingerprint: 'a' })
    ).toEqual({ next: 'a', commit: false })
    // The visible background actually changed while live: commit once.
    expect(
      liveBackgroundCommitDecision({ sessionActive: true, armedFingerprint: 'a', fingerprint: 'b' })
    ).toEqual({ next: 'b', commit: true })
  })

  it('downgrades a preview-only presentation miss to a warning', () => {
    expect(
      layoutTransactionUnprovenSeverity(
        new NativePreviewPresentationProofError(
          'Native preview did not present committed scene revision 7.'
        )
      )
    ).toBe('presentation-warning')
  })

  it('keeps output-proof failures at error severity', () => {
    expect(
      layoutTransactionUnprovenSeverity(
        new Error('Live layout switch did not reach the active recording/streaming output')
      )
    ).toBe('output-error')
    expect(layoutTransactionUnprovenSeverity(undefined)).toBe('output-error')
  })

  it('reconciles commit A when superseding intent B fails after scene events were suppressed', () => {
    const committedA = {
      intentId: 42,
      sceneRevision: 7,
      scene: 'scene-a',
      layout: 'camera-only'
    }

    expect(
      layoutTransactionProofDisposition({
        latestIntentId: 43,
        committedIntentId: committedA.intentId,
        proofSucceeded: true
      })
    ).toBe('ignore-stale')

    expect(
      layoutTransactionFailureReconciliation({
        latestIntentId: 43,
        failedIntentId: 43,
        backendTruth: null,
        latestCommit: committedA
      })
    ).toEqual({ source: 'latest-commit', snapshot: committedA })
  })

  it('does not let a late older commit replace a newer backend checkpoint', () => {
    const committedA = { sceneRevision: 7, scene: 'scene-a' }
    const committedB = { sceneRevision: 8, scene: 'scene-b' }

    expect(latestLayoutTransactionCommit(committedB, committedA)).toBe(committedB)
  })

  it('prefers freshly read backend truth over the renderer checkpoint', () => {
    const committedA = { sceneRevision: 7, scene: 'scene-a' }
    const backendTruth = { sceneRevision: 8, scene: 'scene-b' }

    expect(
      layoutTransactionFailureReconciliation({
        latestIntentId: 43,
        failedIntentId: 43,
        backendTruth,
        latestCommit: committedA
      })
    ).toEqual({ source: 'backend-truth', snapshot: backendTruth })
  })

  it('requires outcome-unknown, a newer revision, and full scene equivalence', () => {
    const requestedScene = {
      layout: {
        layoutPreset: 'screen-camera',
        camera: { corner: 'bottom-right', size: 30 }
      },
      sources: [
        { kind: 'screen', deviceId: 'screen-1' },
        { kind: 'camera', deviceId: 'camera-1' }
      ],
      video: { width: 1920, height: 1080, fps: 30 },
      background: { assetId: 'background-1' }
    }

    expect(
      layoutTransactionFailureDisposition({
        failureCode: 'request-outcome-unknown',
        sceneRevisionBeforeRequest: 7,
        requestedScene,
        // Deliberately reverse key insertion order: semantic equality must not
        // depend on JSON object serialization order.
        backendTruth: {
          sceneRevision: 8,
          scene: {
            background: { assetId: 'background-1' },
            video: { fps: 30, height: 1080, width: 1920 },
            sources: [
              { deviceId: 'screen-1', kind: 'screen' },
              { deviceId: 'camera-1', kind: 'camera' }
            ],
            layout: {
              camera: { size: 30, corner: 'bottom-right' },
              layoutPreset: 'screen-camera'
            }
          }
        }
      })
    ).toBe('requested-scene-applied')
    expect(
      layoutTransactionFailureDisposition({
        failureCode: 'request-outcome-unknown',
        sceneRevisionBeforeRequest: 7,
        requestedScene,
        backendTruth: {
          sceneRevision: 8,
          scene: { ...requestedScene, background: { assetId: 'background-2' } }
        }
      })
    ).toBe('backend-scene-different')
    expect(
      layoutTransactionFailureDisposition({
        failureCode: 'request-outcome-unknown',
        sceneRevisionBeforeRequest: 7,
        requestedScene,
        backendTruth: null
      })
    ).toBe('backend-truth-unavailable')
  })

  it('never treats definitely-not-applied source/background commands as success', () => {
    const requestedScene = {
      layout: { layoutPreset: 'screen-only' },
      sources: [{ kind: 'screen', deviceId: 'screen-new' }],
      video: { width: 1920, height: 1080, fps: 30 },
      background: { assetId: 'background-new' }
    }

    for (const backendScene of [
      { ...requestedScene, sources: [{ kind: 'screen', deviceId: 'screen-old' }] },
      { ...requestedScene, background: { assetId: 'background-old' } }
    ]) {
      expect(
        layoutTransactionFailureDisposition({
          failureCode: 'command-expired-before-dispatch',
          sceneRevisionBeforeRequest: 7,
          requestedScene,
          backendTruth: { sceneRevision: 7, scene: backendScene }
        })
      ).toBe('definitely-not-applied')
    }
  })

  it('does not infer success without an authoritative newer scene revision', () => {
    const scene = {
      layout: { layoutPreset: 'screen-only' },
      sources: [{ kind: 'screen', deviceId: 'screen-1' }],
      video: { width: 1920, height: 1080, fps: 30 },
      background: null
    }
    expect(
      layoutTransactionFailureDisposition({
        failureCode: 'request-outcome-unknown',
        sceneRevisionBeforeRequest: 7,
        requestedScene: scene,
        backendTruth: { sceneRevision: 7, scene }
      })
    ).toBe('terminal-evidence-unavailable')
  })

  it('ignores a failed intent once a newer intent exists', () => {
    expect(
      layoutTransactionFailureReconciliation({
        latestIntentId: 44,
        failedIntentId: 43,
        backendTruth: { sceneRevision: 8, scene: 'scene-b' },
        latestCommit: { sceneRevision: 7, scene: 'scene-a' }
      })
    ).toBeNull()
  })

  it('rejects backend truth when a same-id scene changes across the compositor read', () => {
    expect(
      layoutTransactionBackendSnapshotIsStable({
        sceneBefore: { id: 'program', sources: ['camera'] },
        compositorSceneId: 'program',
        sceneAfter: { id: 'program', sources: ['screen'] }
      })
    ).toBe(false)
  })

  it('accepts backend truth when scene content stays stable across the compositor read', () => {
    expect(
      layoutTransactionBackendSnapshotIsStable({
        sceneBefore: { id: 'program', sources: ['camera'] },
        compositorSceneId: 'program',
        sceneAfter: { id: 'program', sources: ['camera'] }
      })
    ).toBe(true)
  })

  it('allows automatic capture-config scene reloads only while the session is idle', () => {
    expect(
      shouldReloadSceneFromCaptureConfig({
        connected: true,
        sceneEditMode: false,
        recordingState: 'idle',
        startRequestPending: false,
        stopRequestPending: false
      })
    ).toBe(true)
    expect(
      shouldReloadSceneFromCaptureConfig({
        connected: true,
        sceneEditMode: false,
        recordingState: 'starting',
        startRequestPending: false,
        stopRequestPending: false
      })
    ).toBe(false)
  })

  it('cancels an armed idle reload as soon as a local session transition begins', () => {
    expect(
      shouldReloadSceneFromCaptureConfig({
        connected: true,
        sceneEditMode: false,
        recordingState: 'idle',
        startRequestPending: true,
        stopRequestPending: false
      })
    ).toBe(false)
  })
})
