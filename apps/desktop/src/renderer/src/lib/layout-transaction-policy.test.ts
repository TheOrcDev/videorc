import { describe, expect, it } from 'vitest'

import {
  latestLayoutTransactionCommit,
  layoutTransactionBackendSnapshotIsStable,
  layoutTransactionFailureReconciliation,
  layoutTransactionProofDisposition,
  layoutTransactionUnprovenSeverity,
  liveBackgroundCommitDecision,
  NativePreviewPresentationProofError,
  shouldReloadSceneFromCaptureConfig
} from './layout-transaction-policy'

describe('layout transaction policy', () => {
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
