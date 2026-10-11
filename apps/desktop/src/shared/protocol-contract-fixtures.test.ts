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
import type {
  CohostPetImportParams,
  CohostPetReactAccepted,
  CohostPetReactParams,
  CohostPetRemoveParams,
  BuddyPetSummary
} from './backend'
import type {
  CohostPetBuildIdParams,
  CohostPetIdentityParams,
  CohostPetSaveParams,
  CohostPetSheetGenerateParams,
  BuddyPetBuildProgressEvent,
  BuddyPetCreationAccepted,
  BuddyPetCreationStatus,
  BuddyPetIdentityReadEvent,
  BuddyPetSheetGeneratedEvent
} from './buddy-pet-creator'
import { normalizeSessionCommentsListParams } from './backend'
import type {
  CohostAvatarAccepted,
  CohostAvatarCreateParams,
  CohostAvatarDraft,
  CohostAvatarDraftStatus,
  CohostAvatarProgressEvent,
  CohostAvatarRedoParams,
  CohostAvatarRequestIdParams
} from './backend'
import type {
  CohostLibraryAccepted,
  CohostLibraryDeleteParams,
  CohostLibrarySyncParams,
  CohostLibraryUpdateParams,
  CohostLibraryUseParams,
  BuddyLibraryState
} from './buddy-library'
import { BUDDY_OFFICIAL_CATALOG, officialAliveFallback } from './buddy-library'
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
  buddyPets: {
    summary: BuddyPetSummary
    bundledSummary: BuddyPetSummary
    importParams: CohostPetImportParams
    removeParams: CohostPetRemoveParams
    reactParams: CohostPetReactParams
    reactAccepted: CohostPetReactAccepted
  }
  buddyLook: {
    createParams: CohostAvatarCreateParams
    createDescriptionParams: CohostAvatarCreateParams
    redoParams: CohostAvatarRedoParams
    requestIdParams: CohostAvatarRequestIdParams
    accepted: CohostAvatarAccepted
    progressWorking: CohostAvatarProgressEvent
    progressDone: CohostAvatarProgressEvent
    progressFailed: CohostAvatarProgressEvent
    draft: CohostAvatarDraft
    status: CohostAvatarDraftStatus
    statusNone: CohostAvatarDraftStatus
    createLibraryParams: CohostAvatarCreateParams
    libraryDraft: CohostAvatarDraft
  }
  buddyLibrary: {
    signedOut: BuddyLibraryState
    signedIn: BuddyLibraryState
    localOnly: BuddyLibraryState
    importing: BuddyLibraryState
    aliveUpload: BuddyLibraryState
    aliveDownload: BuddyLibraryState
    syncParams: CohostLibrarySyncParams
    useParams: CohostLibraryUseParams
    useOfficialParams: CohostLibraryUseParams
    updateParams: CohostLibraryUpdateParams
    deleteParams: CohostLibraryDeleteParams
    accepted: CohostLibraryAccepted
  }
  buddyPetCreator: {
    status: BuddyPetCreationStatus
    statusNone: BuddyPetCreationStatus
    identityParams: CohostPetIdentityParams
    identityUploadParams: CohostPetIdentityParams
    sheetParams: CohostPetSheetGenerateParams
    pilotParams: CohostPetSheetGenerateParams
    buildParams: CohostPetBuildIdParams
    saveParams: CohostPetSaveParams
    accepted: BuddyPetCreationAccepted
    identityRead: BuddyPetIdentityReadEvent
    sheetGenerated: BuddyPetSheetGeneratedEvent
    sheetFailed: BuddyPetSheetGeneratedEvent
    buildProgress: BuddyPetBuildProgressEvent
    buildFailed: BuddyPetBuildProgressEvent
    savedPack: BuddyPetSummary
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
      message: "Buddy's listening allowance for this month is used up.",
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
      message: 'The Buddy tick failed on every configured model.',
      status: 502
    })
    expect(fixtures.cohost.timeoutState.detail).toStrictEqual({
      code: 'timeout',
      message: 'Buddy did not answer within 12 s.',
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
        buddy: { ...fixtures.overlayLayout.defaults.buddy, horizontal: { x: 2, y: 0, w: 1, h: 1 } }
      })
    ).toThrow()
    // The shipped defaults: highlight bottom-left on both outputs, captions
    // off (today's burnTarget default), the Buddy bottom-right.
    expect(fixtures.overlayLayout.defaults.highlight.showOnStream).toBe(true)
    expect(fixtures.overlayLayout.defaults.captions.showOnStream).toBe(false)
    expect(fixtures.overlayLayout.defaults.buddy.horizontal.x).toBeCloseTo(0.7975, 6)
  })

  it('keeps the Buddy overlay wire shapes strict (plan 164 Phase C)', () => {
    const idle = { personaId: 'default', state: 'idle', bubble: null }
    const talking = {
      personaId: 'a1b2c3',
      state: 'laugh',
      bubble: { text: 'Welcome to the horde', until: '2026-10-08T12:00:03.000Z' }
    }
    for (const snapshot of [idle, talking]) {
      expect(validateBackendRpcResult('cohost.buddy.status', snapshot)).toStrictEqual(snapshot)
      expect(validateBackendEventPayload('cohost.buddy.state', snapshot)).toStrictEqual(snapshot)
    }
    // The bubble is null or whole, never absent, and no field rides along.
    expect(() =>
      validateBackendEventPayload('cohost.buddy.state', { personaId: 'x', state: 'idle' })
    ).toThrow()
    expect(() =>
      validateBackendEventPayload('cohost.buddy.state', { ...idle, bubble: { text: 'x' } })
    ).toThrow()
    expect(() => validateBackendEventPayload('cohost.buddy.state', { ...idle, extra: 1 })).toThrow()
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
    expect(validateBackendRpcParams('buddy.overlay.set', set)).toStrictEqual(set)
    expect(() =>
      validateBackendRpcParams('buddy.overlay.set', { ...set, rect: undefined })
    ).toThrow()
    const info = {
      active: true,
      primary: { active: true, width: 400, height: 520, revision: 3, styleRevision: 0 },
      auxiliary: { active: false, width: 0, height: 0, revision: 0, styleRevision: 0 }
    }
    expect(validateBackendRpcResult('buddy.overlay.set', info)).toStrictEqual(info)
    // Plan 168 S-B1: the bubble's raster is cleared when it ends, one target
    // or both; nothing else rides along.
    expect(validateBackendRpcParams('buddy.overlay.clear', {})).toStrictEqual({})
    expect(validateBackendRpcParams('buddy.overlay.clear', { target: 'primary' })).toStrictEqual({
      target: 'primary'
    })
    expect(() => validateBackendRpcParams('buddy.overlay.clear', { target: 'vertical' })).toThrow()
    expect(() => validateBackendRpcParams('buddy.overlay.clear', { rect: null })).toThrow()
    expect(validateBackendRpcResult('buddy.overlay.clear', info)).toStrictEqual(info)
  })

  it('keeps Buddy voice commands, their answers and settings identical across languages (plan 140 S3)', () => {
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
      name: 'Buddy',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
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

  it('keeps the Buddy report, its payload and the saved event identical across languages (plan 119 S1)', () => {
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

describe('Buddy pets wire (plan 168, Phase A)', () => {
  const pets = fixtures.buddyPets

  it('validates the pet RPCs exactly as the backend round-trips them', () => {
    expect(validateBackendRpcParams('cohost.pet.list', undefined)).toBeUndefined()
    expect(
      validateBackendRpcResult('cohost.pet.list', [pets.bundledSummary, pets.summary])
    ).toStrictEqual([pets.bundledSummary, pets.summary])
    expect(validateBackendRpcParams('cohost.pet.import', pets.importParams)).toStrictEqual(
      pets.importParams
    )
    expect(validateBackendRpcResult('cohost.pet.import', pets.summary)).toStrictEqual(pets.summary)
    expect(validateBackendRpcParams('cohost.pet.remove', pets.removeParams)).toStrictEqual(
      pets.removeParams
    )
    const removed = { packId: pets.removeParams.packId, settings: fixtures.cohost.settings }
    expect(validateBackendRpcResult('cohost.pet.remove', removed)).toStrictEqual(removed)
    expect(validateBackendRpcParams('cohost.pet.react', pets.reactParams)).toStrictEqual(
      pets.reactParams
    )
    expect(validateBackendRpcResult('cohost.pet.react', pets.reactAccepted)).toStrictEqual(
      pets.reactAccepted
    )
  })

  it('refuses unknown fields, bad pack ids and out-of-bounds summaries', () => {
    expect(() =>
      validateBackendRpcParams('cohost.pet.import', { ...pets.importParams, path: '/tmp/x' })
    ).toThrow('cohost.pet.import')
    for (const packId of ['bundled:', '../x', pets.summary.packId.toUpperCase(), 'buddy']) {
      expect(() => validateBackendRpcParams('cohost.pet.remove', { packId })).toThrow(
        'cohost.pet.remove'
      )
    }
    expect(() =>
      validateBackendRpcResult('cohost.pet.import', { ...pets.summary, cellSize: 64 })
    ).toThrow('cohost.pet.import')
    expect(() =>
      validateBackendRpcResult('cohost.pet.import', { ...pets.summary, source: 'web' })
    ).toThrow('cohost.pet.import')
    expect(() => validateBackendRpcParams('cohost.pet.react', { reaction: '' })).toThrow(
      'cohost.pet.react'
    )
  })

  it('carries the persona avatar: still by default, alive by pack id, nothing else', () => {
    expect(fixtures.cohost.settings.persona.avatar).toStrictEqual({ kind: 'still' })
    expect(fixtures.cohost.settingsPatch.persona?.avatar).toStrictEqual({
      kind: 'alive',
      packId: pets.summary.packId
    })
    const persona = fixtures.cohost.settingsPatch.persona!
    for (const avatar of [
      null,
      { kind: 'alive' },
      { kind: 'alive', packId: 'bundled:Buddy' },
      { kind: 'still', packId: pets.summary.packId },
      { kind: 'animated' }
    ]) {
      expect(() =>
        validateBackendRpcParams('cohost.settings.set', { persona: { ...persona, avatar } })
      ).toThrow('cohost.settings.set')
    }
    const { avatar: _avatar, ...withoutAvatar } = persona
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', { persona: withoutAvatar })
    ).toThrow('cohost.settings.set')
  })

  it('carries motion, reaction overrides and a greeting reaction (S-A4)', () => {
    const persona = fixtures.cohost.settingsPatch.persona!
    expect(persona.motion).toStrictEqual({ intensity: 0.8, sleepAfterSeconds: 0, breathing: false })
    expect(persona.reactions).toStrictEqual({
      follow: 'wave',
      tip: 'none',
      'destination-failed': 'worried'
    })
    expect(fixtures.cohost.settingsPatch.autoChat?.greetings.templates[0]?.reaction).toBe('proud')
    for (const motion of [
      { intensity: 1.5, sleepAfterSeconds: 180, breathing: true },
      { intensity: 0.5, sleepAfterSeconds: 10, breathing: true },
      { intensity: 0.5, sleepAfterSeconds: 1801, breathing: true },
      { intensity: 0.5, sleepAfterSeconds: 180 }
    ]) {
      expect(() =>
        validateBackendRpcParams('cohost.settings.set', { persona: { ...persona, motion } })
      ).toThrow('cohost.settings.set')
    }
    for (const reactions of [{ 'moderation-flag': 'laugh' }, { follow: 'Wave' }, { raid: '' }]) {
      expect(() =>
        validateBackendRpcParams('cohost.settings.set', { persona: { ...persona, reactions } })
      ).toThrow('cohost.settings.set')
    }
    const autoChat = fixtures.cohost.settingsPatch.autoChat!
    const template = autoChat.greetings.templates[0]!
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', {
        autoChat: {
          ...autoChat,
          greetings: { ...autoChat.greetings, templates: [{ ...template, reaction: null }] }
        }
      })
    ).toThrow('cohost.settings.set')
  })
})

describe('Buddy look wire (plan 169, Phase B)', () => {
  const look = fixtures.buddyLook

  it('validates the look RPCs and events exactly as the backend round-trips them', () => {
    for (const params of [look.createParams, look.createDescriptionParams]) {
      expect(validateBackendRpcParams('cohost.avatar.create', params)).toStrictEqual(params)
    }
    for (const method of ['cohost.avatar.create', 'cohost.avatar.redo'] as const) {
      expect(validateBackendRpcResult(method, look.accepted)).toStrictEqual(look.accepted)
    }
    expect(validateBackendRpcParams('cohost.avatar.redo', look.redoParams)).toStrictEqual(
      look.redoParams
    )
    for (const method of ['cohost.avatar.keep', 'cohost.avatar.discard'] as const) {
      expect(validateBackendRpcParams(method, look.requestIdParams)).toStrictEqual(
        look.requestIdParams
      )
    }
    expect(validateBackendRpcResult('cohost.avatar.keep', fixtures.cohost.settings)).toStrictEqual(
      fixtures.cohost.settings
    )
    expect(validateBackendRpcParams('cohost.avatar.draft.get', undefined)).toBeUndefined()
    for (const method of ['cohost.avatar.draft.get', 'cohost.avatar.discard'] as const) {
      for (const status of [look.status, look.statusNone]) {
        expect(validateBackendRpcResult(method, status)).toStrictEqual(status)
      }
    }
    for (const event of [look.progressWorking, look.progressDone, look.progressFailed]) {
      expect(validateBackendEventPayload('cohost.avatar.progress', event)).toStrictEqual(event)
    }
    expect(validateBackendEventPayload('cohost.avatar.draft', look.draft)).toStrictEqual(look.draft)
  })

  it('refuses the old style menu, idle redo, bad ids and paths outside a draft', () => {
    expect(() =>
      validateBackendRpcParams('cohost.avatar.create', { ...look.createParams, style: 'pixel' })
    ).toThrow('cohost.avatar.create')
    expect(() => validateBackendRpcParams('cohost.avatar.create', { description: '' })).toThrow(
      'cohost.avatar.create'
    )
    expect(() =>
      validateBackendRpcParams('cohost.avatar.redo', { ...look.redoParams, state: 'idle' })
    ).toThrow('cohost.avatar.redo')
    const { requestId } = look.requestIdParams
    for (const bad of ['../default', requestId.toUpperCase(), '']) {
      expect(() => validateBackendRpcParams('cohost.avatar.keep', { requestId: bad })).toThrow(
        'cohost.avatar.keep'
      )
    }
    for (const path of ['default/idle.png', `../drafts/${requestId}/idle.png`]) {
      expect(() =>
        validateBackendEventPayload('cohost.avatar.progress', { ...look.progressDone, path })
      ).toThrow('cohost.avatar.progress')
    }
    expect(() =>
      validateBackendEventPayload('cohost.avatar.draft', {
        ...look.draft,
        images: { ...look.draft.images, idle: 'default/idle.png' }
      })
    ).toThrow('cohost.avatar.draft')
    expect(() =>
      validateBackendRpcResult('cohost.avatar.draft.get', {
        running: { requestId, kind: 'build' }
      })
    ).toThrow('cohost.avatar.draft.get')
  })
})

describe('Buddy library wire (plan 170, Phase D)', () => {
  const library = fixtures.buddyLibrary
  const look = fixtures.buddyLook

  it('validates the library RPCs and event exactly as the backend round-trips them', () => {
    expect(validateBackendRpcParams('cohost.library.get', undefined)).toBeUndefined()
    for (const state of [
      library.signedOut,
      library.signedIn,
      library.localOnly,
      library.importing,
      library.aliveUpload,
      library.aliveDownload
    ]) {
      expect(validateBackendRpcResult('cohost.library.get', state)).toStrictEqual(state)
      expect(validateBackendEventPayload('cohost.library.changed', state)).toStrictEqual(state)
    }
    expect(validateBackendRpcParams('cohost.library.sync', library.syncParams)).toStrictEqual(
      library.syncParams
    )
    for (const params of [library.useParams, library.useOfficialParams]) {
      expect(validateBackendRpcParams('cohost.library.use', params)).toStrictEqual(params)
    }
    expect(validateBackendRpcParams('cohost.library.update', library.updateParams)).toStrictEqual(
      library.updateParams
    )
    expect(validateBackendRpcParams('cohost.library.delete', library.deleteParams)).toStrictEqual(
      library.deleteParams
    )
    for (const method of [
      'cohost.library.sync',
      'cohost.library.use',
      'cohost.library.update',
      'cohost.library.delete'
    ] as const) {
      expect(validateBackendRpcResult(method, library.accepted)).toStrictEqual(library.accepted)
    }
    // The signed-out state lists the whole official catalog, pictures by
    // slug; with no buddy roots, a bundled pack is not here and a pack that
    // downloads is available (plan 172 D4).
    expect(library.signedOut.official).toStrictEqual(
      BUDDY_OFFICIAL_CATALOG.map(({ description: _description, alive, ...entry }) => ({
        ...entry,
        alive: alive?.bundled ? 'none' : officialAliveFallback({ alive })
      }))
    )
  })

  it('carries the alive packs, their jobs and Save to my library (plan 172)', () => {
    expect(library.signedIn.mine![0]!.alive).toStrictEqual({
      packId: '0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a',
      cellSize: 640
    })
    expect(library.signedIn.mine![1]!.alive).toBeNull()
    expect(library.aliveDownload.official.map((entry) => entry.alive)).toStrictEqual([
      'bundled',
      'available'
    ])
    expect(
      [library.importing, library.aliveUpload, library.aliveDownload].map(
        (state) => state.busy?.kind
      )
    ).toStrictEqual(['import', 'alive-upload', 'alive-download'])
    expect(validateBackendRpcParams('cohost.library.saveToLibrary', undefined)).toBeUndefined()
    expect(() => validateBackendRpcParams('cohost.library.saveToLibrary', {})).toThrow(
      'cohost.library.saveToLibrary'
    )
    expect(
      validateBackendRpcResult('cohost.library.saveToLibrary', library.accepted)
    ).toStrictEqual(library.accepted)
    const entry = library.signedIn.mine![0]!
    for (const alive of [
      { packId: 'bundled:buddy', cellSize: 640 },
      { packId: entry.alive!.packId.toUpperCase(), cellSize: 640 },
      { packId: entry.alive!.packId, cellSize: 64 },
      { packId: entry.alive!.packId, cellSize: 640, version: 1 },
      undefined
    ]) {
      const { alive: _alive, ...rest } = entry
      expect(() =>
        validateBackendEventPayload('cohost.library.changed', {
          ...library.signedIn,
          mine: [alive === undefined ? rest : { ...entry, alive }]
        })
      ).toThrow('cohost.library.changed')
    }
    const official = library.signedOut.official[0]!
    for (const alive of ['alive', null, undefined]) {
      expect(() =>
        validateBackendRpcResult('cohost.library.get', {
          ...library.signedOut,
          official: [{ ...official, alive }]
        })
      ).toThrow('cohost.library.get')
    }
    // A persona may wear an official pack (official:<slug>), never a path.
    const patch = fixtures.cohost.settingsPatch
    const wearing = {
      persona: { ...patch.persona!, avatar: { kind: 'alive', packId: 'official:orc' } }
    }
    expect(validateBackendRpcParams('cohost.settings.set', wearing)).toStrictEqual(wearing)
    for (const packId of ['official:', 'official:Orc', 'official:../orc']) {
      expect(() =>
        validateBackendRpcParams('cohost.settings.set', {
          persona: { ...patch.persona!, avatar: { kind: 'alive', packId } }
        })
      ).toThrow('cohost.settings.set')
    }
  })

  it('carries the library on the persona, the create params and the draft', () => {
    const patch = fixtures.cohost.settingsPatch
    expect(patch.persona?.libraryAvatarId).toBe(library.useParams.avatarId)
    expect(validateBackendRpcParams('cohost.settings.set', patch)).toStrictEqual(patch)
    // The default persona has no link: absent, never null.
    expect('libraryAvatarId' in fixtures.cohost.settings.persona).toBe(false)
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', {
        persona: { ...patch.persona, libraryAvatarId: null }
      })
    ).toThrow('cohost.settings.set')
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', {
        persona: { ...patch.persona, libraryAvatarId: 'x'.repeat(65) }
      })
    ).toThrow('cohost.settings.set')
    expect(
      validateBackendRpcParams('cohost.avatar.create', look.createLibraryParams)
    ).toStrictEqual(look.createLibraryParams)
    expect(validateBackendEventPayload('cohost.avatar.draft', look.libraryDraft)).toStrictEqual(
      look.libraryDraft
    )
    expect(
      validateBackendRpcResult('cohost.avatar.draft.get', { draft: look.libraryDraft })
    ).toEqual({ draft: look.libraryDraft })
    for (const bad of [
      { ...look.createLibraryParams, name: '' },
      { ...look.createLibraryParams, name: 'n'.repeat(25) },
      { ...look.createLibraryParams, personality: 'p'.repeat(1201) },
      { ...look.createLibraryParams, context: 'c'.repeat(4001) }
    ]) {
      expect(() => validateBackendRpcParams('cohost.avatar.create', bad)).toThrow(
        'cohost.avatar.create'
      )
    }
    expect(() =>
      validateBackendEventPayload('cohost.avatar.draft', {
        ...look.libraryDraft,
        libraryAvatarId: 'official:golem'
      })
    ).toThrow('cohost.avatar.draft')
  })

  it('refuses unknown slugs, official edits, empty updates and pictures outside the cache', () => {
    expect(() =>
      validateBackendRpcParams('cohost.library.use', { avatarId: 'official:dragon' })
    ).toThrow('cohost.library.use')
    expect(() =>
      validateBackendRpcParams('cohost.library.use', {
        avatarId: library.useParams.avatarId.toUpperCase()
      })
    ).toThrow('cohost.library.use')
    expect(() =>
      validateBackendRpcParams('cohost.library.delete', { avatarId: 'official:golem' })
    ).toThrow('cohost.library.delete')
    expect(() =>
      validateBackendRpcParams('cohost.library.update', {
        avatarId: 'official:orc',
        name: 'Grok'
      })
    ).toThrow('cohost.library.update')
    expect(() =>
      validateBackendRpcParams('cohost.library.update', { avatarId: library.useParams.avatarId })
    ).toThrow('cohost.library.update')
    expect(() => validateBackendRpcParams('cohost.library.sync', { reason: 'timer' })).toThrow(
      'cohost.library.sync'
    )
    expect(() => validateBackendRpcResult('cohost.library.sync', { accepted: false })).toThrow(
      'cohost.library.sync'
    )
    const entry = library.signedIn.mine![0]!
    for (const idle of [
      'videorc-asset://buddy/default/idle.png',
      `videorc-asset://buddy/library/${entry.id}/idle.png`,
      `videorc-asset://buddy/library/${entry.id}/../idle-0a1b2c3d.png`,
      `file:///library/${entry.id}/idle-0a1b2c3d.png`
    ]) {
      expect(() =>
        validateBackendEventPayload('cohost.library.changed', {
          ...library.signedIn,
          mine: [{ ...entry, poses: { ...entry.poses, idle } }]
        })
      ).toThrow('cohost.library.changed')
    }
    expect(() =>
      validateBackendRpcResult('cohost.library.get', { ...library.signedOut, error: null })
    ).toThrow('cohost.library.get')
    expect(() =>
      validateBackendRpcResult('cohost.library.get', {
        ...library.signedOut,
        busy: { kind: 'generate' }
      })
    ).toThrow('cohost.library.get')
  })
})

describe('Buddy pet creator wire (plan 168, Phase F)', () => {
  const creator = fixtures.buddyPetCreator

  it('validates the creator RPCs and events exactly as the backend round-trips them', () => {
    for (const method of ['cohost.pet.creation.start', 'cohost.pet.creation.status'] as const) {
      expect(validateBackendRpcParams(method, undefined)).toBeUndefined()
      expect(validateBackendRpcResult(method, creator.status)).toStrictEqual(creator.status)
      expect(validateBackendRpcResult(method, creator.statusNone)).toStrictEqual(creator.statusNone)
    }
    expect(
      validateBackendRpcParams('cohost.pet.creation.cancel', creator.buildParams)
    ).toStrictEqual(creator.buildParams)
    for (const params of [creator.identityParams, creator.identityUploadParams]) {
      expect(validateBackendRpcParams('cohost.pet.identity', params)).toStrictEqual(params)
    }
    for (const params of [creator.sheetParams, creator.pilotParams]) {
      expect(validateBackendRpcParams('cohost.pet.sheet.generate', params)).toStrictEqual(params)
    }
    for (const method of [
      'cohost.pet.identity',
      'cohost.pet.sheet.generate',
      'cohost.pet.build'
    ] as const) {
      expect(validateBackendRpcResult(method, creator.accepted)).toStrictEqual(creator.accepted)
    }
    expect(validateBackendRpcParams('cohost.pet.build', creator.buildParams)).toStrictEqual(
      creator.buildParams
    )
    expect(validateBackendRpcParams('cohost.pet.save', creator.saveParams)).toStrictEqual(
      creator.saveParams
    )
    const saved = { pack: creator.savedPack, settings: fixtures.cohost.settings }
    expect(validateBackendRpcResult('cohost.pet.save', saved)).toStrictEqual(saved)
    expect(
      validateBackendEventPayload('cohost.pet.identity.read', creator.identityRead)
    ).toStrictEqual(creator.identityRead)
    for (const event of [creator.sheetGenerated, creator.sheetFailed]) {
      expect(validateBackendEventPayload('cohost.pet.sheet.generated', event)).toStrictEqual(event)
    }
    for (const event of [creator.buildProgress, creator.buildFailed]) {
      expect(validateBackendEventPayload('cohost.pet.build.progress', event)).toStrictEqual(event)
    }
  })

  it('refuses unknown fields, bad ids, paths and out-of-bounds notes', () => {
    const { buildId } = creator.buildParams
    for (const bad of ['../pets', buildId.toUpperCase(), 'bundled:buddy', '']) {
      expect(() => validateBackendRpcParams('cohost.pet.build', { buildId: bad })).toThrow(
        'cohost.pet.build'
      )
    }
    expect(() =>
      validateBackendRpcParams('cohost.pet.save', { ...creator.saveParams, packId: buildId })
    ).toThrow('cohost.pet.save')
    expect(() =>
      validateBackendRpcParams('cohost.pet.save', { ...creator.saveParams, name: '' })
    ).toThrow('cohost.pet.save')
    expect(() =>
      validateBackendRpcParams('cohost.pet.identity', {
        buildId,
        reference: { kind: 'path', path: '/etc/passwd' }
      })
    ).toThrow('cohost.pet.identity')
    expect(() =>
      validateBackendRpcParams('cohost.pet.sheet.generate', { ...creator.sheetParams, row: 'up3' })
    ).toThrow('cohost.pet.sheet.generate')
    const notes = creator.pilotParams.notes!
    for (const bad of [
      { ...notes, palette: ['x'.repeat(61)] },
      { ...notes, palette: [''] },
      { ...notes, proportions: '' },
      { ...notes, asymmetric: [{ feature: 'horn', side: 'up' }] },
      { ...notes, extra: true }
    ]) {
      expect(() =>
        validateBackendRpcParams('cohost.pet.sheet.generate', {
          ...creator.pilotParams,
          notes: bad
        })
      ).toThrow('cohost.pet.sheet.generate')
    }
    const creation = creator.status.creation!
    for (const file of [
      '../build-state.json',
      'sources/../x.png',
      '/tmp/a.png',
      'pack/buddy.json'
    ]) {
      expect(() =>
        validateBackendRpcResult('cohost.pet.creation.status', {
          creation: { ...creation, reference: { ...creation.reference!, file } }
        })
      ).toThrow('cohost.pet.creation.status')
    }
    expect(() =>
      validateBackendEventPayload('cohost.pet.build.progress', {
        ...creator.buildProgress,
        step: 'uploading'
      })
    ).toThrow('cohost.pet.build.progress')
  })
})
