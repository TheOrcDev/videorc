import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { normalizeLayoutSettings } from '../renderer/src/lib/capture'
import type {
  AccountCallbackEnvelope,
  CleanCutEdl,
  CleanCutGetResult,
  CleanCutJob,
  CleanCutStartParams,
  CleanCutTranscript,
  CleanCutUpdateEdlParams,
  ClipMark,
  ClipMarkedEvent,
  CohostAuthorParams,
  CohostCommandChooseParams,
  CohostCommandParams,
  CohostFlagParams,
  CohostPromiseParams,
  CohostQuestionParams,
  CohostRecapParams,
  CohostReportGetParams,
  CohostReportPayload,
  CohostReportSavedEvent,
  CohostSessionReport,
  CohostSettings,
  CohostSettingsPatch,
  CohostStartParams,
  CohostState,
  CompositorStatus,
  LayoutSettings,
  LiveChatMessage,
  ModerationOperation,
  ModerationOperationParams,
  ModerationRequestParams,
  OverlayLayout,
  PreviewSurfaceBounds,
  RecordingStatus,
  Scene,
  SessionCommentsListParams,
  SessionCommentsPage,
  SessionDeletionOperation,
  SessionChatTotals
} from './backend'
import { normalizeSessionCommentsListParams } from './backend'
import {
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult,
  type BackendRpcParams
} from './backend-rpc-contract'
import { localRemovalKind } from './chat-moderation'
import { applyCommentsSnapshotDelta } from './comments-snapshot-delta'
import { validateElectronEventPayload, validateElectronInvokeArgs } from './electron-ipc-contract'
import { normalizePreviewSurfaceBounds } from './native-preview-bounds'

interface HighRiskContractFixtures {
  schemaVersion: 2
  sessionChatTotals: {
    params: { sessionId: string }
    available: SessionChatTotals
    legacy: SessionChatTotals
  }
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
    mixedAudioWire: RecordingStatus
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
    eventMessages: LiveChatMessage[]
  }
  overlayLayout: {
    defaults: OverlayLayout
    placed: OverlayLayout
  }
  cohost: {
    startParams: CohostStartParams
    questionParams: CohostQuestionParams
    flagParams: CohostFlagParams
    promiseParams: CohostPromiseParams
    recapParams: CohostRecapParams
    authorParams: CohostAuthorParams
    settingsPatch: CohostSettingsPatch
    settings: CohostSettings
    state: CohostState
    offState: CohostState
    errorState: CohostState
    timeoutState: CohostState
    stateV2: CohostState
    legacyState: CohostState
    reportGetParams: CohostReportGetParams
    report: CohostSessionReport
    reportPayload: CohostReportPayload
    reportPayloadWithoutReport: CohostReportPayload
    reportSaved: CohostReportSavedEvent
    commandChooseParams: CohostCommandChooseParams
    commandParams: CohostCommandParams
    commandState: CohostState
    chooserState: CohostState
  }
  clip: {
    markedSaved: ClipMarkedEvent
    markedUnsaved: ClipMarkedEvent
    listParams: BackendRpcParams<'clip.marks.list'>
    marks: ClipMark[]
  }
  cleanCut: {
    startParams: CleanCutStartParams
    condensedStartParams: CleanCutStartParams
    getParams: BackendRpcParams<'cleanCut.get'>
    queuedJob: CleanCutJob
    readyJob: CleanCutJob
    failedJob: CleanCutJob
    edl: CleanCutEdl
    getResult: CleanCutGetResult
    updateEdlParams: CleanCutUpdateEdlParams
    renderParams: BackendRpcParams<'cleanCut.render'>
    transcriptParams: BackendRpcParams<'cleanCut.transcript'>
    renderingJob: CleanCutJob
    completedJob: CleanCutJob
    transcript: CleanCutTranscript
    transcriptWithoutLanguage: CleanCutTranscript
    condensedGetResult: CleanCutGetResult
  }
  moderation: {
    requestParams: ModerationRequestParams
    manualRequestParams: ModerationRequestParams
    confirmParams: ModerationOperationParams
    listParams: BackendRpcParams<'liveChat.moderationOperations.list'>
    pendingOperation: ModerationOperation
    removedOperation: ModerationOperation
    hiddenOperation: ModerationOperation
    removedMessage: LiveChatMessage
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
  it('keeps exact durable totals and unavailable legacy history identical across languages', () => {
    expect(
      validateBackendRpcParams('sessions.comments.totals', fixtures.sessionChatTotals.params)
    ).toStrictEqual(fixtures.sessionChatTotals.params)
    for (const totals of [
      fixtures.sessionChatTotals.available,
      fixtures.sessionChatTotals.legacy
    ]) {
      expect(validateBackendRpcResult('sessions.comments.totals', totals)).toStrictEqual(totals)
      expect(validateBackendEventPayload('liveChat.totals', totals)).toStrictEqual(totals)
    }
  })
  it('has the expected schema version', () => {
    expect(fixtures.schemaVersion).toBe(2)
  })

  it('keeps the chat moderation RPC params, operations and tombstones identical across languages', () => {
    // Plan 140 S4. The Rust side round-trips the same objects in
    // live_chat_moderation.rs (`shared_high_risk_contract_fixture_round_trips_moderation_shapes`).
    expect(
      validateBackendRpcParams('liveChat.moderation.request', fixtures.moderation.requestParams)
    ).toStrictEqual(fixtures.moderation.requestParams)
    expect(
      validateBackendRpcParams(
        'liveChat.moderation.request',
        fixtures.moderation.manualRequestParams
      )
    ).toStrictEqual(fixtures.moderation.manualRequestParams)
    for (const method of ['liveChat.moderation.confirm', 'liveChat.moderation.cancel'] as const) {
      expect(validateBackendRpcParams(method, fixtures.moderation.confirmParams)).toStrictEqual(
        fixtures.moderation.confirmParams
      )
    }
    expect(
      validateBackendRpcParams('liveChat.moderationOperations.list', fixtures.moderation.listParams)
    ).toStrictEqual(fixtures.moderation.listParams)
    const operations = [
      fixtures.moderation.pendingOperation,
      fixtures.moderation.removedOperation,
      fixtures.moderation.hiddenOperation
    ]
    for (const operation of operations) {
      for (const method of [
        'liveChat.moderation.request',
        'liveChat.moderation.confirm',
        'liveChat.moderation.cancel'
      ] as const) {
        expect(validateBackendRpcResult(method, operation)).toStrictEqual(operation)
      }
      expect(validateBackendEventPayload('liveChat.moderationOperation', operation)).toStrictEqual(
        operation
      )
    }
    expect(
      validateBackendRpcResult('liveChat.moderationOperations.list', operations)
    ).toStrictEqual(operations)
    // The contract's phase rules, pinned on the fixtures.
    expect(fixtures.moderation.pendingOperation).toMatchObject({
      source: 'orcle-voice',
      phase: 'pending-confirm',
      requiresExplicitConfirm: true,
      confirmBy: '2026-10-04T12:00:20Z'
    })
    expect(fixtures.moderation.pendingOperation).not.toHaveProperty('executeAt')
    expect(fixtures.moderation.removedOperation).toMatchObject({
      source: 'manual',
      requiresExplicitConfirm: false,
      outcomeCode: 'removed'
    })
    // YouTube: explicit confirmation even in countdown mode.
    expect(fixtures.moderation.hiddenOperation).toMatchObject({
      platform: 'youtube',
      confirmMode: 'countdown',
      requiresExplicitConfirm: true,
      outcomeCode: 'quota-paused'
    })
    expect(fixtures.moderation.hiddenOperation).not.toHaveProperty('executeAt')
    // Absent optionals are never null, and unknown keys are refused.
    expect(() =>
      validateBackendEventPayload('liveChat.moderationOperation', {
        ...fixtures.moderation.pendingOperation,
        outcome: null
      })
    ).toThrow('liveChat.moderationOperation')
    expect(() =>
      validateBackendEventPayload('liveChat.moderationOperation', {
        ...fixtures.moderation.pendingOperation,
        attempts: 1
      })
    ).toThrow('liveChat.moderationOperation')
    // The tombstone a removal writes: same row id, flagged as removed by you.
    expect(fixtures.moderation.removedMessage.id).toBe(
      fixtures.moderation.removedOperation.messageId
    )
    expect(localRemovalKind(fixtures.moderation.removedMessage)).toBe('removed')
    expect(fixtures.moderation.removedMessage).toMatchObject({
      isDeleted: true,
      eventType: 'deleted',
      messageText: 'Removed by you',
      rawProviderType: 'videorc.removed'
    })
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
    expect(fixtures.layout.legacyWire).not.toHaveProperty('sourceVisibility')
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
    // Plan 069: the one mixed track names its sources; an unmixed track omits them.
    const mixed = fixtures.recordingStatus.mixedAudioWire
    expect(jsonShape(validateBackendRpcResult('recording.status', mixed))).toEqual(mixed)
    expect(mixed.audioTracks?.[0]?.mixSources).toEqual(['microphone', 'system-audio'])
    expect(fixtures.recordingStatus.wire.audioTracks?.[0]).not.toHaveProperty('mixSources')
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

  it('keeps the Live Co-host RPC params, settings, and state identical across languages', () => {
    expect(validateBackendRpcParams('cohost.start', fixtures.cohost.startParams)).toStrictEqual(
      fixtures.cohost.startParams
    )
    for (const method of [
      'cohost.question.answered',
      'cohost.question.dismiss',
      'cohost.question.restore'
    ] as const) {
      expect(validateBackendRpcParams(method, fixtures.cohost.questionParams)).toStrictEqual(
        fixtures.cohost.questionParams
      )
    }
    expect(
      validateBackendRpcParams('cohost.flag.dismiss', fixtures.cohost.flagParams)
    ).toStrictEqual(fixtures.cohost.flagParams)
    for (const method of ['cohost.promise.done', 'cohost.promise.dismiss'] as const) {
      expect(validateBackendRpcParams(method, fixtures.cohost.promiseParams)).toStrictEqual(
        fixtures.cohost.promiseParams
      )
    }
    for (const method of ['cohost.recap.dismiss', 'cohost.recap.draft'] as const) {
      expect(validateBackendRpcParams(method, fixtures.cohost.recapParams)).toStrictEqual(
        fixtures.cohost.recapParams
      )
    }
    expect(
      validateBackendRpcParams('cohost.author.greeted', fixtures.cohost.authorParams)
    ).toStrictEqual(fixtures.cohost.authorParams)
    expect(() =>
      validateBackendRpcParams('cohost.author.greeted', {
        ...fixtures.cohost.authorParams,
        extra: true
      })
    ).toThrow()
    expect(
      validateBackendRpcParams('cohost.settings.set', fixtures.cohost.settingsPatch)
    ).toStrictEqual(fixtures.cohost.settingsPatch)
    expect(validateBackendRpcResult('cohost.settings.get', fixtures.cohost.settings)).toStrictEqual(
      fixtures.cohost.settings
    )
    for (const method of [
      'cohost.status',
      'cohost.start',
      'cohost.stop',
      'cohost.question.answered',
      'cohost.question.dismiss',
      'cohost.question.restore',
      'cohost.flag.dismiss',
      'cohost.promise.done',
      'cohost.promise.dismiss',
      'cohost.recap.dismiss',
      'cohost.recap.draft',
      'cohost.author.greeted'
    ] as const) {
      expect(validateBackendRpcResult(method, fixtures.cohost.state)).toStrictEqual(
        fixtures.cohost.state
      )
      expect(validateBackendRpcResult(method, fixtures.cohost.offState)).toStrictEqual(
        fixtures.cohost.offState
      )
    }
    expect(validateBackendEventPayload('cohost.state', fixtures.cohost.state)).toStrictEqual(
      fixtures.cohost.state
    )
    expect(validateBackendEventPayload('cohost.state', fixtures.cohost.offState)).toStrictEqual(
      fixtures.cohost.offState
    )
    expect(fixtures.cohost.offState).toMatchObject({
      sessionId: null,
      reason: null,
      detail: null,
      mood: null
    })
    // Presence fields (W1): the off shape is all defaults, the listening shape
    // carries a pending delta with its announced next pass.
    expect(fixtures.cohost.offState).toMatchObject({
      tickInFlight: false,
      pendingMessages: 0,
      nextTickAt: null,
      messagesSeen: 0,
      questionsTotal: 0
    })
    expect(fixtures.cohost.state).toMatchObject({
      tickInFlight: false,
      pendingMessages: 4,
      nextTickAt: '2026-08-22T10:00:28Z',
      messagesSeen: 84,
      questionsTotal: 5
    })
    // Tick wire v2: flag extras, an `unknown` flag kind, suggested highlights,
    // aggregated alerts and mood scores validate; a null where the backend
    // would omit the key does not (serde-null trap).
    expect(validateBackendEventPayload('cohost.state', fixtures.cohost.stateV2)).toStrictEqual(
      fixtures.cohost.stateV2
    )
    expect(fixtures.cohost.stateV2.flags.map((flag) => flag.kind)).toContain('unknown')
    for (const key of [
      'highlights',
      'alerts',
      'moodScores',
      'topic',
      'promises',
      'promiseReminder',
      'recap',
      'sayHi',
      'deadAirNudge'
    ] as const) {
      expect(() =>
        validateBackendEventPayload('cohost.state', { ...fixtures.cohost.stateV2, [key]: null })
      ).toThrow('cohost.state')
    }
    // Plan 068 S6: "Say hi" and the dead-air nudge ride the state; absent on
    // the legacy payload; an extra key on an entry is refused.
    expect(fixtures.cohost.stateV2.sayHi?.[0]).toStrictEqual({
      authorKey: '"twitch":viewer-fixture',
      name: 'x_Dark_Knight_x',
      platform: 'twitch',
      firstSeenAt: '2026-08-22T10:00:05Z'
    })
    expect(fixtures.cohost.stateV2.deadAirNudge?.key).toBe('dead-air-1-1')
    for (const key of ['sayHi', 'deadAirNudge'] as const) {
      expect(fixtures.cohost.legacyState).not.toHaveProperty(key)
    }
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...fixtures.cohost.stateV2,
        sayHi: [{ ...fixtures.cohost.stateV2.sayHi![0], greeted: true }]
      })
    ).toThrow('cohost.state')
    // Tick v3 (plan 068 S5): topic, promises, reminder, recap and the
    // on-topic flag ride the state; absent on the legacy payload; an unknown
    // trigger kind still validates.
    expect(fixtures.cohost.stateV2.topic).toBe('Mechanical keyboards')
    expect(fixtures.cohost.stateV2.promises?.[0]).toStrictEqual({
      id: 'p_fixture',
      text: 'Giveaway at 100 viewers',
      trigger: { kind: 'viewers', value: 100 },
      firstSeenAt: '2026-08-22T10:00:00Z'
    })
    expect(fixtures.cohost.stateV2.questions[0]?.onTopic).toBe(true)
    const futureTrigger = {
      ...fixtures.cohost.stateV2,
      promises: [
        { ...fixtures.cohost.stateV2.promises![0], trigger: { kind: 'followers', value: 5 } }
      ]
    }
    expect(validateBackendEventPayload('cohost.state', futureTrigger)).toStrictEqual(futureTrigger)
    for (const key of ['topic', 'promises', 'promiseReminder', 'recap'] as const) {
      expect(fixtures.cohost.legacyState).not.toHaveProperty(key)
    }
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...fixtures.cohost.stateV2,
        flags: [{ ...fixtures.cohost.stateV2.flags[0], target: null }]
      })
    ).toThrow('cohost.state')
    // Plan 060 S1: the engine's automatic on-stream command. Absent until the
    // engine made one (null is the serde trap), and a source this build does
    // not know still validates so one new engine source never drops the state.
    expect(fixtures.cohost.stateV2.autoHighlight).toStrictEqual({
      generation: 4,
      messageId: 'session-fixture:twitch:default:message-highlight',
      source: 'pick',
      refresh: false
    })
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...fixtures.cohost.stateV2,
        autoHighlight: null
      })
    ).toThrow('cohost.state')
    const futureSource = {
      ...fixtures.cohost.stateV2,
      autoHighlight: { ...fixtures.cohost.stateV2.autoHighlight, source: 'spotlight-v9' }
    }
    expect(validateBackendEventPayload('cohost.state', futureSource)).toStrictEqual(futureSource)
    expect(fixtures.cohost.legacyState).not.toHaveProperty('autoHighlight')
    // Plan 060 S3: the spotlight (the comment the streamer is talking about)
    // and the voice-resolved questions. Absent until they exist (null is the
    // serde trap); an unknown resolve reason still validates.
    expect(fixtures.cohost.stateV2.spotlight).toStrictEqual({
      messageId: 'session-fixture:twitch:default:message-highlight',
      questionId: 'q_fixture',
      score: 0.91,
      at: '2026-08-22T10:00:20Z',
      expiresAt: '2026-08-22T10:00:35Z'
    })
    expect(fixtures.cohost.stateV2.recentlyResolved).toHaveLength(1)
    expect(fixtures.cohost.stateV2.recentlyResolved?.[0]).toMatchObject({
      reason: 'voice',
      resolvedAt: '2026-08-22T10:00:20Z',
      question: fixtures.cohost.state.questions[0]
    })
    for (const key of ['spotlight', 'recentlyResolved', 'listening'] as const) {
      expect(() =>
        validateBackendEventPayload('cohost.state', { ...fixtures.cohost.stateV2, [key]: null })
      ).toThrow('cohost.state')
      expect(fixtures.cohost.legacyState).not.toHaveProperty(key)
    }
    // Plan 068: `listening` rides the state while a session runs; its optional
    // fields are omitted (never null) and `state` is a closed enum.
    expect(fixtures.cohost.stateV2.listening).toStrictEqual({
      state: 'blocked',
      reasonCode: 'listen-monthly-quota-exhausted',
      message: "Golem's listening allowance for this month is used up.",
      remainingSeconds: 0
    })
    expect(fixtures.cohost.state).not.toHaveProperty('listening')
    const listeningOn = { ...fixtures.cohost.stateV2, listening: { state: 'on' } }
    expect(validateBackendEventPayload('cohost.state', listeningOn)).toStrictEqual(listeningOn)
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...fixtures.cohost.stateV2,
        listening: { state: 'on', reasonCode: null }
      })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...fixtures.cohost.stateV2,
        listening: { state: 'humming' }
      })
    ).toThrow('cohost.state')
    expect(fixtures.cohost.settings.listen).toBe(false)
    expect(fixtures.cohost.settingsPatch.listen).toBe(true)
    const futureReason = {
      ...fixtures.cohost.stateV2,
      recentlyResolved: [
        { ...fixtures.cohost.stateV2.recentlyResolved![0], reason: 'moderator-v9' }
      ]
    }
    expect(validateBackendEventPayload('cohost.state', futureReason)).toStrictEqual(futureReason)
    // `voiceHighlight` (plan 060) is part of the settings shape both ways.
    expect(fixtures.cohost.settings.voiceHighlight).toBe(false)
    expect(fixtures.cohost.settingsPatch.voiceHighlight).toBe(true)
    // `detail` carries the failed tick's envelope verbatim, or a desktop code
    // with no HTTP status; a pre-`detail` payload validates unchanged.
    for (const shape of ['errorState', 'timeoutState', 'legacyState'] as const) {
      expect(validateBackendEventPayload('cohost.state', fixtures.cohost[shape])).toStrictEqual(
        fixtures.cohost[shape]
      )
      expect(validateBackendRpcResult('cohost.status', fixtures.cohost[shape])).toStrictEqual(
        fixtures.cohost[shape]
      )
    }
    expect(fixtures.cohost.errorState.detail).toStrictEqual({
      code: 'ai-gateway-error',
      message: 'The Golem tick failed on every configured model.',
      status: 502
    })
    expect(fixtures.cohost.timeoutState.detail).toStrictEqual({
      code: 'timeout',
      message: 'Golem did not answer within 12 s.',
      status: null
    })
    expect('detail' in fixtures.cohost.legacyState).toBe(false)
    // The legacy payload predates the presence fields; validating it proves
    // the schema (and serde on the Rust side) defaults them.
    for (const key of [
      'tickInFlight',
      'pendingMessages',
      'nextTickAt',
      'messagesSeen',
      'questionsTotal'
    ]) {
      expect(key in fixtures.cohost.legacyState).toBe(false)
    }
  })

  it('keeps the overlay layout wire shape identical across languages (plan 164)', () => {
    for (const layout of [fixtures.overlayLayout.defaults, fixtures.overlayLayout.placed]) {
      expect(validateBackendRpcResult('overlays.layout.get', layout)).toStrictEqual(layout)
      expect(validateBackendRpcParams('overlays.layout.set', layout)).toStrictEqual(layout)
      expect(validateBackendRpcResult('overlays.layout.set', layout)).toStrictEqual(layout)
    }
    expect(
      validateBackendRpcParams('overlays.layout.migrate_highlight_anchor', { anchor: 'top-right' })
    ).toStrictEqual({ anchor: 'top-right' })
    expect(() =>
      validateBackendRpcParams('overlays.layout.set', {
        ...fixtures.overlayLayout.defaults,
        extra: true
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('overlays.layout.set', {
        ...fixtures.overlayLayout.defaults,
        golem: { ...fixtures.overlayLayout.defaults.golem, horizontal: { x: 2, y: 0, w: 1, h: 1 } }
      })
    ).toThrow()
    // The shipped defaults: highlight bottom-left on both outputs, captions
    // off (today's burnTarget default), the Golem bottom-right.
    expect(fixtures.overlayLayout.defaults.highlight.showOnStream).toBe(true)
    expect(fixtures.overlayLayout.defaults.captions.showOnStream).toBe(false)
    expect(fixtures.overlayLayout.defaults.golem.horizontal.x).toBeCloseTo(0.7975, 6)
  })

  it('keeps the Golem overlay wire shapes strict (plan 164 Phase C)', () => {
    const idle = { personaId: 'default', state: 'idle', bubble: null }
    const talking = {
      personaId: 'a1b2c3',
      state: 'laugh',
      bubble: { text: 'Welcome to the horde', until: '2026-10-08T12:00:03.000Z' }
    }
    for (const snapshot of [idle, talking]) {
      expect(validateBackendRpcResult('cohost.golem.status', snapshot)).toStrictEqual(snapshot)
      expect(validateBackendEventPayload('cohost.golem.state', snapshot)).toStrictEqual(snapshot)
    }
    // The bubble is null or whole, never absent, and no field rides along.
    expect(() =>
      validateBackendEventPayload('cohost.golem.state', { personaId: 'x', state: 'idle' })
    ).toThrow()
    expect(() =>
      validateBackendEventPayload('cohost.golem.state', { ...idle, bubble: { text: 'x' } })
    ).toThrow()
    expect(() => validateBackendEventPayload('cohost.golem.state', { ...idle, extra: 1 })).toThrow()
    // The Say box is one utterance (`cohost.utterance.say`): a session when
    // the line may be posted, none when it is bubble-only.
    const say = { sessionId: 'session-1', text: 'Hello horde', state: 'talk' }
    expect(validateBackendRpcParams('cohost.utterance.say', say)).toStrictEqual(say)
    const bubbleOnly = { text: 'Hello horde' }
    expect(validateBackendRpcParams('cohost.utterance.say', bubbleOnly)).toStrictEqual(bubbleOnly)
    expect(() => validateBackendRpcParams('cohost.utterance.say', { text: '' })).toThrow()
    expect(() =>
      validateBackendRpcParams('cohost.utterance.say', { text: 'x', state: 'idle' })
    ).toThrow()
    const set = {
      target: 'auxiliary',
      pngBase64: 'iVBORw0KGgo=',
      rect: { x: 0.7975, y: 0.64, w: 0.18, h: 0.32 }
    }
    expect(validateBackendRpcParams('golem.overlay.set', set)).toStrictEqual(set)
    expect(() =>
      validateBackendRpcParams('golem.overlay.set', { ...set, rect: undefined })
    ).toThrow()
    const info = {
      active: true,
      primary: { active: true, width: 400, height: 520, revision: 3, styleRevision: 0 },
      auxiliary: { active: false, width: 0, height: 0, revision: 0, styleRevision: 0 }
    }
    expect(validateBackendRpcResult('golem.overlay.set', info)).toStrictEqual(info)
  })

  it('keeps Golem voice commands, their answers and settings identical across languages (plan 140 S3)', () => {
    // The Rust side round-trips the same objects in protocol.rs
    // (`shared_high_risk_contract_fixture_matches_cohost_dtos`).
    expect(
      validateBackendRpcParams('cohost.command.choose', fixtures.cohost.commandChooseParams)
    ).toStrictEqual(fixtures.cohost.commandChooseParams)
    for (const method of ['cohost.command.confirm', 'cohost.command.cancel'] as const) {
      expect(validateBackendRpcParams(method, fixtures.cohost.commandParams)).toStrictEqual(
        fixtures.cohost.commandParams
      )
    }
    for (const state of [fixtures.cohost.commandState, fixtures.cohost.chooserState]) {
      expect(validateBackendEventPayload('cohost.state', state)).toStrictEqual(state)
      for (const method of [
        'cohost.status',
        'cohost.command.choose',
        'cohost.command.confirm',
        'cohost.command.cancel'
      ] as const) {
        expect(validateBackendRpcResult(method, state)).toStrictEqual(state)
      }
    }
    // A removal card names its operation, its reason and when it expires.
    expect(fixtures.cohost.commandState.command).toMatchObject({
      kind: 'remove',
      status: 'confirm',
      operationId: '0f1e2d3c-4b5a-4968-8777-66554433aabb',
      reason: 'toxic',
      expiresAt: '2026-10-04T12:00:20Z'
    })
    expect(fixtures.cohost.commandState.command).not.toHaveProperty('candidates')
    expect(fixtures.cohost.commandState.commandAvailability).toStrictEqual({
      voiceCommands: 'on',
      remove: 'paused'
    })
    // A chooser lists its comments instead of one target.
    expect(fixtures.cohost.chooserState.command?.candidates).toHaveLength(2)
    expect(fixtures.cohost.chooserState.command).not.toHaveProperty('target')
    expect(fixtures.cohost.chooserState.command).not.toHaveProperty('operationId')
    expect(fixtures.cohost.chooserState).not.toHaveProperty('commandAvailability')
    // Absent, never null, on every older shape.
    for (const shape of ['state', 'offState', 'stateV2', 'legacyState'] as const) {
      expect(fixtures.cohost[shape]).not.toHaveProperty('command')
      expect(fixtures.cohost[shape]).not.toHaveProperty('commandAvailability')
    }
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...fixtures.cohost.commandState,
        command: null
      })
    ).toThrow('cohost.state')
    // The settings carry both new fields; the patch may.
    expect(fixtures.cohost.settings).toMatchObject({
      wakeWordRequired: false,
      removeConfirm: 'confirm'
    })
    expect(fixtures.cohost.settingsPatch).toMatchObject({
      wakeWordRequired: true,
      removeConfirm: 'countdown'
    })
    // Plan 164 S-A2: the persona and the automatic chat block ride the
    // settings (defaults: the bundled pack, everything automatic off) and
    // the patch (whole objects). Absent images are omitted, never null.
    expect(fixtures.cohost.settings.persona).toStrictEqual({
      id: 'default',
      name: 'Golem',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default'
    })
    expect(fixtures.cohost.settings.autoChat).toStrictEqual({
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    })
    expect(fixtures.cohost.settingsPatch.persona?.images).toStrictEqual({
      idle: 'persona-fixture/idle.png',
      laugh: 'persona-fixture/laugh.webp'
    })
    expect(fixtures.cohost.settingsPatch.autoChat?.greetings.templates[0]).toMatchObject({
      kind: 'follow',
      platform: 'twitch',
      state: 'laugh'
    })
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', {
        persona: { ...fixtures.cohost.settingsPatch.persona, images: { idle: null } }
      })
    ).toThrow('cohost.settings.set')
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', {
        autoChat: {
          ...fixtures.cohost.settingsPatch.autoChat,
          greetings: {
            enabled: true,
            templates: [
              {
                ...fixtures.cohost.settingsPatch.autoChat!.greetings.templates[0],
                kind: 'hype-train'
              }
            ]
          }
        }
      })
    ).toThrow('cohost.settings.set')
    // The report counts commands; the minimal report has none (never null).
    expect(fixtures.cohost.report.commands).toStrictEqual({
      highlighted: 3,
      cleared: 1,
      removed: 1,
      hiddenLocally: 1,
      cancelled: 1,
      expired: 0,
      failed: 0,
      notFound: 2
    })
    expect(fixtures.cohost.reportPayload.report).not.toHaveProperty('commands')
    expect(() =>
      validateBackendRpcResult('cohost.report.get', {
        ...fixtures.cohost.reportPayload,
        report: { ...fixtures.cohost.report, commands: { removed: 1 } }
      })
    ).toThrow('cohost.report.get')
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

  it('keeps the Golem report, its payload and the saved event identical across languages (plan 119 S1)', () => {
    expect(
      validateBackendRpcParams('cohost.report.get', fixtures.cohost.reportGetParams)
    ).toStrictEqual(fixtures.cohost.reportGetParams)
    expect(
      validateBackendRpcResult('cohost.report.get', fixtures.cohost.reportPayload)
    ).toStrictEqual(fixtures.cohost.reportPayload)
    expect(
      validateBackendRpcResult('cohost.report.latest', fixtures.cohost.reportPayload)
    ).toStrictEqual(fixtures.cohost.reportPayload)
    expect(validateBackendRpcResult('cohost.report.latest', null)).toBeNull()
    expect(
      validateBackendRpcResult('cohost.report.get', fixtures.cohost.reportPayloadWithoutReport)
    ).toStrictEqual(fixtures.cohost.reportPayloadWithoutReport)
    expect(fixtures.cohost.reportPayloadWithoutReport.report).toBeNull()
    expect(fixtures.cohost.reportPayloadWithoutReport.moments).toStrictEqual([])
    expect(
      validateBackendEventPayload('cohost.report.saved', fixtures.cohost.reportSaved)
    ).toStrictEqual(fixtures.cohost.reportSaved)

    // The full report carries every optional list; the payload's report is
    // the minimal shape, which proves the serde-null rule: absent, never null.
    const full = fixtures.cohost.report
    expect(
      validateBackendRpcResult('cohost.report.get', {
        ...fixtures.cohost.reportPayload,
        report: full
      })
    ).toStrictEqual({ ...fixtures.cohost.reportPayload, report: full })
    expect(full.version).toBe(1)
    expect(full.questions.items).toHaveLength(2)
    expect(full.questions.items?.[1]).not.toHaveProperty('askers')
    expect(full.questions.items?.[1]).not.toHaveProperty('platforms')
    const minimal = fixtures.cohost.reportPayload.report as CohostSessionReport
    expect(minimal.segments).toBe(2)
    for (const key of ['streamTitle', 'alerts']) {
      expect(key in minimal).toBe(false)
    }
    expect('items' in minimal.questions).toBe(false)
    expect('byKind' in minimal.flags).toBe(false)
    expect('open' in minimal.promises).toBe(false)
    expect(fixtures.cohost.reportPayload.moments.map((moment) => moment.source)).toStrictEqual([
      'voice',
      'manual',
      'chat'
    ])
  })

  it('keeps clip marks and the marked event identical across languages (plan 068 D6)', () => {
    for (const event of [fixtures.clip.markedSaved, fixtures.clip.markedUnsaved]) {
      expect(validateBackendEventPayload('clip.marked', event)).toStrictEqual(event)
      expect(validateBackendRpcResult('clip.mark', event)).toStrictEqual(event)
    }
    expect(fixtures.clip.markedSaved).not.toHaveProperty('reason')
    expect(fixtures.clip.markedUnsaved.reason).toBe('recording-off')
    expect(validateBackendRpcParams('clip.marks.list', fixtures.clip.listParams)).toStrictEqual(
      fixtures.clip.listParams
    )
    expect(validateBackendRpcResult('clip.marks.list', fixtures.clip.marks)).toStrictEqual(
      fixtures.clip.marks
    )
    expect(fixtures.clip.marks[1]).not.toHaveProperty('phrase')
  })

  it('keeps Clean cut jobs, the cut list and its params identical across languages (plan 119)', () => {
    const { cleanCut } = fixtures
    expect(validateBackendRpcParams('cleanCut.start', cleanCut.startParams)).toStrictEqual(
      cleanCut.startParams
    )
    expect(validateBackendRpcParams('cleanCut.start', cleanCut.condensedStartParams)).toStrictEqual(
      cleanCut.condensedStartParams
    )
    expect(validateBackendRpcParams('cleanCut.get', cleanCut.getParams)).toStrictEqual(
      cleanCut.getParams
    )
    for (const job of [cleanCut.queuedJob, cleanCut.readyJob, cleanCut.failedJob]) {
      expect(validateBackendRpcResult('cleanCut.start', job)).toStrictEqual(job)
      expect(validateBackendRpcResult('cleanCut.cancel', job)).toStrictEqual(job)
      expect(validateBackendEventPayload('cleanCut.status', job)).toStrictEqual(job)
    }
    expect(
      validateBackendRpcResult('cleanCut.list', [cleanCut.queuedJob, cleanCut.failedJob])
    ).toStrictEqual([cleanCut.queuedJob, cleanCut.failedJob])
    expect(validateBackendRpcResult('cleanCut.get', cleanCut.getResult)).toStrictEqual(
      cleanCut.getResult
    )
    expect(validateBackendRpcParams('cleanCut.updateEdl', cleanCut.updateEdlParams)).toStrictEqual(
      cleanCut.updateEdlParams
    )
    expect(
      validateBackendRpcResult('cleanCut.updateEdl', { job: cleanCut.readyJob, edl: cleanCut.edl })
    ).toStrictEqual({ job: cleanCut.readyJob, edl: cleanCut.edl })
    // Omitted, never null: the serde-null trap.
    expect(cleanCut.queuedJob).not.toHaveProperty('edlSummary')
    expect(cleanCut.readyJob).not.toHaveProperty('errorCode')
    expect(cleanCut.edl.removals[0]).not.toHaveProperty('confidence')
    expect(cleanCut.updateEdlParams).not.toHaveProperty('removeManual')
    expect(() =>
      validateBackendEventPayload('cleanCut.status', {
        ...cleanCut.failedJob,
        errorCode: undefined
      })
    ).toThrow()
    expect(() =>
      validateBackendEventPayload('cleanCut.status', {
        ...cleanCut.readyJob,
        edlSummary: undefined
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cleanCut.start', { ...cleanCut.startParams, mode: 'tight' })
    ).toThrow()
  })

  it('keeps the Clean cut render and transcript shapes identical across languages (plan 119 S13)', () => {
    const { cleanCut } = fixtures
    expect(validateBackendRpcParams('cleanCut.render', cleanCut.renderParams)).toStrictEqual(
      cleanCut.renderParams
    )
    expect(
      validateBackendRpcParams('cleanCut.transcript', cleanCut.transcriptParams)
    ).toStrictEqual(cleanCut.transcriptParams)
    for (const job of [cleanCut.renderingJob, cleanCut.completedJob]) {
      expect(validateBackendRpcResult('cleanCut.render', job)).toStrictEqual(job)
      expect(validateBackendEventPayload('cleanCut.status', job)).toStrictEqual(job)
    }
    expect(cleanCut.renderingJob.step).toBe('render')
    expect(cleanCut.renderingJob).not.toHaveProperty('outputSessionId')
    expect(cleanCut.completedJob.outputSessionId).toBe('session-fixture-clean-cut')
    expect(validateBackendRpcResult('cleanCut.transcript', cleanCut.transcript)).toStrictEqual(
      cleanCut.transcript
    )
    expect(
      validateBackendRpcResult('cleanCut.transcript', cleanCut.transcriptWithoutLanguage)
    ).toStrictEqual(cleanCut.transcriptWithoutLanguage)
    // `filler` is written only when true; `language` is null, never absent.
    expect(cleanCut.transcript.words[0]).not.toHaveProperty('filler')
    expect(cleanCut.transcript.words[1].filler).toBe(true)
    expect(cleanCut.transcriptWithoutLanguage.language).toBeNull()
    expect(() =>
      validateBackendRpcResult('cleanCut.transcript', {
        ...cleanCut.transcript,
        words: [{ ...cleanCut.transcript.words[0], filler: false }]
      })
    ).toThrow()
    expect(validateBackendRpcResult('cleanCut.get', cleanCut.condensedGetResult)).toStrictEqual(
      cleanCut.condensedGetResult
    )
    expect(cleanCut.condensedGetResult.jobs[0].condensedKeeps).toHaveLength(2)
    expect(cleanCut.getResult.jobs[0]).not.toHaveProperty('condensedKeeps')
  })

  it('loads chat rows with and without structured event details', () => {
    const [
      plain,
      cheer,
      resub,
      raid,
      superChat,
      follow,
      kicks,
      affiliated,
      streak,
      gif,
      powerUp,
      redemption
    ] = fixtures.comments.eventMessages
    expect(
      'details' in plain ||
        'reply' in plain ||
        'firstMessage' in plain ||
        'authorAffiliation' in plain
    ).toBe(false)
    expect(cheer.details).toEqual({ kind: 'cheer', bits: 1500 })
    expect(cheer.reply?.parentAuthorName).toBe('regular_viewer')
    expect(cheer.firstMessage).toBe(true)
    expect(resub.details).toMatchObject({ kind: 'subscription', subscription: 'resub', months: 8 })
    expect(raid.details).toEqual({ kind: 'raid', viewerCount: 234 })
    expect(superChat.details).toMatchObject({ kind: 'super-chat', amountMicros: 5_000_000 })
    expect(follow.eventType).toBe('follow')
    expect(kicks.details).toEqual({ kind: 'kicks', amount: 500, giftName: 'Rage Quit' })
    expect(streak.details).toEqual({
      kind: 'watch-streak',
      streakCount: 20,
      channelPointsAwarded: 450
    })
    expect(affiliated.authorAffiliation).toEqual({
      badgeUrl: 'https://pbs.twimg.com/profile_images/2/neon_normal.jpg',
      description: 'Neon',
      url: 'https://x.com/neondatabase'
    })
    // Plan 162: Activity-only Power-up and channel point rows.
    expect(powerUp.eventType).toBe('power-up')
    expect(powerUp.details).toEqual({
      kind: 'power-up',
      bits: 50,
      powerUp: 'gigantify-an-emote',
      emoteName: 'orcdevBONK'
    })
    expect(redemption.eventType).toBe('redemption')
    expect(redemption.details).toEqual({
      kind: 'redemption',
      reward: 'custom',
      channelPoints: 500,
      title: 'Hydrate',
      pointsName: 'Orc Gold'
    })
    // Plan 155: a Twitch GIF is a plain message with one `gif` fragment.
    expect(gif.eventType).toBe('message')
    expect(gif.fragments).toEqual([
      {
        type: 'gif',
        text: '[Y A Y Yes GIF]',
        imageUrl: 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif'
      }
    ])

    const snapshot = fixtures.comments.eventMessages.reduce(
      (current, message) => applyCommentsSnapshotDelta(current, { kind: 'message', message }),
      applyCommentsSnapshotDelta(null, {
        kind: 'clear',
        sessionId: 'session-fixture',
        updatedAt: '2026-09-24T10:00:00Z'
      })
    )
    expect(snapshot.messages).toStrictEqual(fixtures.comments.eventMessages)
  })
})
