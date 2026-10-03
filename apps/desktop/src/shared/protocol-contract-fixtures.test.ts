import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { normalizeLayoutSettings } from '../renderer/src/lib/capture'
import type {
  AccountCallbackEnvelope,
  ClipMark,
  ClipMarkedEvent,
  CohostAuthorParams,
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
  }
  clip: {
    markedSaved: ClipMarkedEvent
    markedUnsaved: ClipMarkedEvent
    listParams: BackendRpcParams<'clip.marks.list'>
    marks: ClipMark[]
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
      message: "Orcle's listening allowance for this month is used up.",
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
      message: 'The Orcle tick failed on every configured model.',
      status: 502
    })
    expect(fixtures.cohost.timeoutState.detail).toStrictEqual({
      code: 'timeout',
      message: 'Orcle did not answer within 12 s.',
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

  it('keeps the Orcle report, its payload and the saved event identical across languages (plan 119 S1)', () => {
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

  it('loads chat rows with and without structured event details', () => {
    const [plain, cheer, resub, raid, superChat, follow, kicks, affiliated] =
      fixtures.comments.eventMessages
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
    expect(affiliated.authorAffiliation).toEqual({
      badgeUrl: 'https://pbs.twimg.com/profile_images/2/neon_normal.jpg',
      description: 'Neon',
      url: 'https://x.com/neondatabase'
    })

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
