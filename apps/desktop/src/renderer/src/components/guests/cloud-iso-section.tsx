import { useEffect, useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Field, FieldGroup, FieldLabel, SettingsRow } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useStudioCloud, useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import type { CloudIsoAnswer } from '@/lib/backend'
import {
  ISO_DEFAULT_LIMITS,
  isoCostLine,
  isoCurrentTake,
  isoEnableBlockedReason,
  isoEnableParams,
  isoErrorText,
  isoGuestConsentRows,
  isoLimitsLine,
  isoMicrosPerFileMinute,
  isoParsedTakes,
  isoRoomRows,
  isoRefusalText,
  isoTakeNotes
} from '@/lib/cloud-iso-view'

// Plan 249 S22: Guests → Separate files. Off unless the host
// turns it on, and turning it on takes the confirmation below with its
// checkbox: only that confirmation sends `consent: true`. While separate
// cloud files aren't production-qualified, the switch stays on screen,
// disabled, with the reason. Never hidden.

/** How often the room's separate files are read again while they are on. */
export const ISO_STATUS_POLL_MS = 5_000

const STATUS_CHECK_FAILED = "Couldn't check separate files. Try again in a moment."
const ENABLE_FAILED = "Couldn't turn on separate files. Try again."
const DISABLE_FAILED = "Couldn't turn off separate files. Try again."
/** Codes that are an answer about availability, not a failed check. */
const AVAILABILITY_CODES = new Set(['cloud-iso-plan', 'cloud-iso-not-qualified'])

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

export function CloudIsoSection(): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const { wsStatus } = useStudioCore()
  const { client } = useStudioDiagnostics()
  const showId = cloudStatus?.show?.id ?? null
  const room = cloudStatus?.room
  const roomOpen = room?.phase === 'open'
  const offline = wsStatus !== 'connected'

  const [forShow, setForShow] = useState(showId)
  const [answer, setAnswer] = useState<CloudIsoAnswer | null>(null)
  const [statusCode, setStatusCode] = useState<string | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [asking, setAsking] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [enableError, setEnableError] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  // A new show starts from nothing: never another show's answer.
  if (forShow !== showId) {
    setForShow(showId)
    setAnswer(null)
    setStatusCode(null)
    setStatusFailed(false)
  }

  const requested = answer?.iso?.request != null

  useEffect(() => {
    if (!client || !showId || !roomOpen) return
    let live = true
    const load = async (): Promise<void> => {
      try {
        const next = await client.requestTyped('cloud.iso.status', { showId })
        if (!live) return
        setAnswer(next)
        setStatusCode(null)
        setStatusFailed(false)
      } catch (error) {
        if (!live) return
        const code = errorCode(error)
        console.warn('[guests] separate files check failed:', code ?? error)
        setStatusCode(code)
        setStatusFailed(!code || !AVAILABILITY_CODES.has(code))
      }
    }
    void load()
    if (!requested) {
      return () => {
        live = false
      }
    }
    const timer = window.setInterval(() => void load(), ISO_STATUS_POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [client, requested, roomOpen, showId])

  const micros = isoMicrosPerFileMinute(answer?.availability)
  const blockedReason = isoEnableBlockedReason({
    offline,
    roomOpen,
    answer,
    errorCode: statusCode
  })
  // On, it can always be turned off while Videorc is connected.
  const switchReason = requested ? (offline ? blockedReason : null) : blockedReason
  const switchDisabled = busy || switchReason !== null

  const enable = async (): Promise<void> => {
    if (!client || !showId || !agreed) return
    setBusy(true)
    setEnableError(null)
    try {
      const next = await client.requestTyped(
        'cloud.iso.enable',
        isoEnableParams(showId, ISO_DEFAULT_LIMITS, micros)
      )
      setAnswer(next)
      setAsking(false)
      setAgreed(false)
      setRowError(null)
    } catch (error) {
      const code = errorCode(error)
      console.warn('[guests] separate files refused:', code ?? error)
      setEnableError(isoErrorText(code ?? undefined) ?? ENABLE_FAILED)
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    if (!client || !showId) return
    setBusy(true)
    setRowError(null)
    try {
      setAnswer(await client.requestTyped('cloud.iso.disable', { showId }))
    } catch (error) {
      const code = errorCode(error)
      console.warn('[guests] separate files stop failed:', code ?? error)
      setRowError(isoErrorText(code ?? undefined) ?? DISABLE_FAILED)
    } finally {
      setBusy(false)
    }
  }

  const request = answer?.iso?.request
  const limits = request
    ? { maxActiveEntries: request.maxActiveEntries, maxMinutes: request.maxMinutes }
    : ISO_DEFAULT_LIMITS
  const description = requested
    ? `On for this show. ${isoLimitsLine(limits)}`
    : (blockedReason ?? `Off. ${isoLimitsLine(limits)}`)
  const takes = isoParsedTakes(answer?.iso)
  const take = isoCurrentTake(takes)
  const unreadable = takes.some((entry) => !entry.ok)
  const consentRows = requested ? isoGuestConsentRows(room?.guests, answer?.iso?.guestConsent) : []
  const fileRows = take ? isoRoomRows(take, room?.guests) : []
  const refusal = isoRefusalText(answer?.iso)
  const notes = [...(refusal ? [refusal] : []), ...(take ? isoTakeNotes(take) : [])]

  return (
    <PanelSection
      data-testid="guests-iso"
      description="Videorc Cloud can also record each person and each source as its own file, beside the show's recording."
      title="Separate files"
    >
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="guests-iso-row"
          description={description}
          error={rowError ?? (statusFailed ? STATUS_CHECK_FAILED : null)}
          label="Record separate files"
        >
          <DisabledReason reason={switchDisabled ? switchReason : null}>
            <Switch
              checked={requested}
              data-testid="guests-iso-switch"
              disabled={switchDisabled}
              onCheckedChange={(on) => {
                if (on) {
                  setEnableError(null)
                  setAgreed(false)
                  setAsking(true)
                } else void disable()
              }}
            />
          </DisabledReason>
        </SettingsRow>
      </FieldGroup>

      {consentRows.length > 0 ? (
        <GroupedList aria-label="Guests' agreement" data-testid="guests-iso-consent" label="Guests">
          {consentRows.map((row) => (
            <ListRow
              compact
              data-testid="guests-iso-guest"
              key={row.guestId}
              statusIcons={<StatusDot label={row.status.label} tone={row.status.tone} />}
              title={row.name}
            />
          ))}
        </GroupedList>
      ) : null}

      {fileRows.length > 0 ? (
        <GroupedList
          aria-label="Separate files this take"
          data-testid="guests-iso-files"
          label="Files"
        >
          {fileRows.map((row) => (
            <ListRow
              compact
              context={row.detail}
              data-testid="guests-iso-file"
              key={row.id}
              statusIcons={<StatusDot label={row.status.label} tone={row.status.tone} />}
              title={row.title}
            />
          ))}
        </GroupedList>
      ) : null}

      {notes.map((note) => (
        <Alert data-testid="guests-iso-note" key={note} variant="warning">
          <AlertTitle>{note}</AlertTitle>
        </Alert>
      ))}
      {unreadable ? (
        <Alert variant="warning">
          <AlertTitle>A take&apos;s separate files couldn&apos;t be read.</AlertTitle>
        </Alert>
      ) : null}

      <ConfirmDialog
        cancelDisabled={busy}
        confirmDisabled={!agreed || busy}
        confirmLabel={busy ? 'Turning on…' : 'Turn on separate files'}
        confirmVariant="default"
        description="Videorc Cloud records each person and each source as its own file, beside the show's recording."
        open={asking}
        testId="guests-iso-enable"
        title="Record separate files?"
        onCancel={() => {
          if (busy) return
          setAsking(false)
          setAgreed(false)
          setEnableError(null)
        }}
        onConfirm={() => void enable()}
      >
        <div className="text-muted-foreground flex flex-col gap-3 text-sm">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>Your camera, microphone and screen, each as its own file.</li>
            <li>Your show sounds (soundboard and computer audio) combined in one file.</li>
            <li>
              Each guest who agrees: their camera, microphone, screen and screen audio, each as its
              own file.
            </li>
          </ul>
          <p>
            Guests are asked on their page first. Only guests who agree are recorded separately, and
            a guest who stops agreeing stops being recorded.
          </p>
          <p>
            {isoLimitsLine(limits)} Files are kept as long as the show&apos;s recording, then
            deleted.
          </p>
          <p data-testid="guests-iso-cost">{isoCostLine(limits, micros)}</p>
          <Field orientation="horizontal">
            <Checkbox
              checked={agreed}
              data-testid="guests-iso-agree"
              disabled={busy}
              onCheckedChange={(checked) => setAgreed(checked === true)}
            />
            <FieldLabel className="text-foreground">
              I agree to record separate files of this show.
            </FieldLabel>
          </Field>
          {enableError ? (
            <Alert data-testid="guests-iso-enable-error" variant="destructive">
              <AlertTitle>{enableError}</AlertTitle>
            </Alert>
          ) : null}
        </div>
      </ConfirmDialog>
    </PanelSection>
  )
}
