import {
  AlertIcon,
  ClipIcon,
  FolderIcon,
  LibraryIcon,
  LockIcon,
  ResetIcon,
  SpinnerIcon,
  SuccessIcon
} from '@/components/icons'
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'

import {
  CleanCutConsentDialog,
  type CleanCutConsentAsk
} from '@/components/clean-cut/clean-cut-consent-dialog'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useVideorcAccount } from '@/hooks/use-account'
import type { CleanCutClient } from '@/hooks/use-clean-cut'
import { setCleanCutAuto, useCleanCutAuto } from '@/hooks/use-clean-cut-auto'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import type { CleanCutJob, CleanCutMode } from '@/lib/backend'
import {
  CLEAN_CUT_AUTO_LABEL,
  CLEAN_CUT_DESCRIPTION,
  CLEAN_CUT_NO_RECORDINGS,
  CLEAN_CUT_TITLE,
  CONDENSED_DEFAULT_TARGET_MINUTES,
  CONDENSED_TARGET_MINUTES,
  cleanCutAutoStatus,
  cleanCutMinutesLeftLabel,
  cleanCutStatusView,
  cleanCutUnlock,
  condensedEligibility,
  condensedTargetSeconds,
  formatCutClock,
  latestCleanCutJob,
  recentCleanCutRecordings,
  type CleanCutAutoStatus,
  type CleanCutSession,
  type CleanCutStatusKind,
  type CleanCutStatusView
} from '@/lib/clean-cut-view'
import { cloudAiUploadGate } from '@/lib/entitlement-ui'
import { dayLabel, isActiveRecordingState } from '@/lib/format'
import { revealInFileManagerLabel } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { openVideorcWebLink } from '@/lib/videorc-web-links'
import { sessionIsLive } from '../../../../shared/capture-state'

/** Which cut the review opens. */
export interface CleanCutReviewTarget {
  sessionId: string
  mode: CleanCutMode
  jobId: string | null
}

/** Library's "Clean cut" ask: select this recording (the nonce re-applies the same one). */
export interface CleanCutFocus {
  sessionId: string
  nonce: number
}

const UNTITLED = 'Untitled recording'

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

/**
 * The Orcle tab's Clean cut tab (plan 119 S14, S19; plan 150 S7), in Settings'
 * two columns: Clean cut (the "every recording" switch, the monthly allowance
 * and, when it can't run, the one reason why) beside Recordings (the chosen
 * recording's cut with what to do next). Locked means disabled with one
 * reason: the switch and "Make a clean cut" are off while the reason shows;
 * the picker stays, because cuts already made stay reviewable. Starting needs the same sign-in, Premium and Cloud
 * AI consent as Orcle Live; consent is asked here, in a dialog that names
 * the audio upload.
 */
export function CleanCutCard({
  client,
  focus,
  onReview,
  onOpenLibrarySession
}: {
  client: CleanCutClient
  focus: CleanCutFocus | null
  onReview: (target: CleanCutReviewTarget) => void
  onOpenLibrarySession: (sessionId: string) => void
}): ReactElement {
  const { sessions, account, entitlements, aiConsent, setAiConsent } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const { signIn } = useVideorcAccount()
  const auto = useCleanCutAuto()
  const sectionRef = useRef<HTMLDivElement>(null)
  const rows = sessions as readonly CleanCutSession[]
  const recordings = useMemo(() => recentCleanCutRecordings(rows), [rows])

  // null follows the newest recording, so the next one that ends takes its place.
  const [picked, setPicked] = useState<string | null>(null)
  const [appliedFocus, setAppliedFocus] = useState<number | null>(null)
  if (focus && focus.nonce !== appliedFocus) {
    setAppliedFocus(focus.nonce)
    setPicked(focus.sessionId)
  }
  // Once per ask: the card re-renders on every job update, the ask does not change.
  const focusNonce = focus?.nonce ?? null
  useEffect(() => {
    if (focusNonce !== null) sectionRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focusNonce])

  const selected =
    (picked ? rows.find((session) => session.id === picked) : undefined) ?? recordings[0] ?? null
  const options =
    selected && !recordings.some((session) => session.id === selected.id)
      ? [...recordings, selected]
      : recordings

  const [mode, setMode] = useState<CleanCutMode>('clean')
  const [targetMinutes, setTargetMinutes] = useState<number>(CONDENSED_DEFAULT_TARGET_MINUTES)
  const [ask, setAsk] = useState<CleanCutConsentAsk | null>(null)
  const [pending, setPending] = useState(false)

  const signedIn = account?.status === 'signed-in'
  const gate = cloudAiUploadGate(entitlements)
  const unlock = cleanCutUnlock({ signedIn, gate, capabilities: client.capabilities })
  const accountLocked = !signedIn || !gate.allowed
  const captureActive = isActiveRecordingState(recording.state)
  const autoStatus = cleanCutAutoStatus({ on: auto, unlock, consented: aiConsent, captureActive })
  const minutesLeft = signedIn ? cleanCutMinutesLeftLabel(client.capabilities) : null

  const job = selected ? latestCleanCutJob(client.jobs, selected.id, mode) : null
  const status = cleanCutStatusView(job, { captureActive, streaming: sessionIsLive(recording) })
  const condensed = selected ? condensedEligibility(selected) : null
  const condensedBlocked = mode === 'condensed' && condensed !== null && !condensed.eligible
  // Until the jobs are listed, a recording that already has its cut would
  // look uncut: starting it again would spend minutes on a second one.
  const cannotStart =
    !client.connected ||
    !client.jobsLoaded ||
    accountLocked ||
    client.capabilities?.available === false ||
    pending ||
    condensedBlocked
  // Cutting again is local work: it needs the connection, not the cloud.
  const cannotRetry = status.retry === 'render' ? !client.connected || pending : cannotStart

  const startCut = (request: {
    sessionId: string
    mode: CleanCutMode
    targetMinutes: number
  }): void => {
    setPending(true)
    void client
      .start({
        sessionId: request.sessionId,
        mode: request.mode,
        consentToUploadAudio: true,
        ...(request.mode === 'condensed'
          ? { targetDurationSeconds: condensedTargetSeconds(request.targetMinutes) }
          : {})
      })
      .catch((error: unknown) =>
        toast.error(
          request.mode === 'condensed'
            ? "Couldn't start the condensed cut"
            : "Couldn't start the clean cut",
          { description: errorMessage(error) }
        )
      )
      .finally(() => setPending(false))
  }

  const make = (): void => {
    if (!selected) return
    const request = { sessionId: selected.id, mode, targetMinutes }
    if (!aiConsent) {
      setAsk({ kind: 'start', ...request })
      return
    }
    startCut(request)
  }

  const turnAuto = (on: boolean): void => {
    if (!on) {
      setCleanCutAuto(false)
      return
    }
    if (!aiConsent) {
      setAsk({ kind: 'auto' })
      return
    }
    setCleanCutAuto(true)
  }

  const answer = (accepted: boolean): void => {
    const current = ask
    setAsk(null)
    if (!accepted || !current) return
    setAiConsent(true)
    if (current.kind === 'auto') setCleanCutAuto(true)
    else startCut(current)
  }

  const retry = (failed: CleanCutJob): void => {
    if (status.retry !== 'render') {
      make()
      return
    }
    setPending(true)
    void client
      .render(failed.id)
      .catch((error: unknown) =>
        toast.error("Couldn't cut it again", { description: errorMessage(error) })
      )
      .finally(() => setPending(false))
  }

  const cancel = (active: CleanCutJob): void => {
    void client
      .cancel(active.id)
      .catch((error: unknown) =>
        toast.error("Couldn't cancel the clean cut", { description: errorMessage(error) })
      )
  }

  const review = (target: CleanCutJob): void =>
    onReview({ sessionId: target.sourceSessionId, mode: target.mode, jobId: target.id })

  const unlockAction = unlock?.action ?? null
  const makeLabel = mode === 'condensed' ? 'Make a condensed cut' : 'Make a clean cut'

  return (
    <>
      <PanelSection
        action={
          minutesLeft ? (
            <Badge data-slot="clean-cut-minutes" variant="outline">
              {minutesLeft}
            </Badge>
          ) : null
        }
        description={CLEAN_CUT_DESCRIPTION}
        title={CLEAN_CUT_TITLE}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="clean-cut-auto-switch">{CLEAN_CUT_AUTO_LABEL}</FieldLabel>
            <CleanCutAutoStatusLine status={autoStatus} />
          </FieldContent>
          <Switch
            checked={auto}
            disabled={!auto && unlock !== null}
            id="clean-cut-auto-switch"
            onCheckedChange={turnAuto}
          />
        </Field>

        {unlock ? (
          <Alert data-slot="clean-cut-unlock">
            <LockIcon />
            <AlertTitle className="font-normal text-muted-foreground">{unlock.reason}</AlertTitle>
            {unlockAction ? (
              <AlertAction>
                <Button
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() =>
                    unlockAction.kind === 'sign-in'
                      ? signIn()
                      : openVideorcWebLink(unlockAction.url)
                  }
                >
                  {unlockAction.kind === 'sign-in' ? 'Sign in' : 'View Premium'}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}
      </PanelSection>
      <PanelSection
        description="Pick a recording to cut, or review a cut you made."
        title="Recordings"
      >
        <div
          className="flex min-w-0 scroll-mt-3 flex-col gap-3"
          data-slot="clean-cut"
          ref={sectionRef}
        >
          {selected ? (
            <div className="flex min-w-0 flex-col gap-2" data-slot="clean-cut-recording">
              <div className="flex flex-wrap items-center gap-2">
                <RecordingPicker
                  options={options}
                  selected={selected}
                  onSelect={(sessionId) =>
                    setPicked(sessionId === recordings[0]?.id ? null : sessionId)
                  }
                />
                <Tabs value={mode} onValueChange={(value) => setMode(value as CleanCutMode)}>
                  <TabsList aria-label="Kind of cut">
                    <TabsTrigger value="clean">Clean</TabsTrigger>
                    <TabsTrigger value="condensed">Condensed</TabsTrigger>
                  </TabsList>
                </Tabs>
                {mode === 'condensed' && !condensedBlocked && !status.busy ? (
                  <div className="flex items-center gap-2" data-slot="clean-cut-target">
                    <span className="text-xs text-muted-foreground">Length</span>
                    <ToggleGroup
                      aria-label="Condensed length"
                      size="sm"
                      spacing={1}
                      type="single"
                      value={String(targetMinutes)}
                      onValueChange={(value) => {
                        if (value) setTargetMinutes(Number(value))
                      }}
                    >
                      {CONDENSED_TARGET_MINUTES.map((minutes) => (
                        <ToggleGroupItem
                          key={minutes}
                          className="h-6 px-2 text-xs tabular-nums"
                          value={String(minutes)}
                        >
                          {minutes} min
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    {job && status.kind !== 'none' && status.kind !== 'cancelled' ? (
                      <Button
                        disabled={cannotStart}
                        size="xs"
                        type="button"
                        variant="outline"
                        onClick={make}
                      >
                        Make again
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {condensedBlocked && condensed && !condensed.eligible ? (
                <GroupedList>
                  <ListRow
                    data-slot="clean-cut-status"
                    data-status="unavailable"
                    icon={<ClipIcon aria-hidden className="text-muted-foreground" />}
                    interactive={false}
                    title="Not for this recording"
                    context={<span title={condensed.reason}>{condensed.reason}</span>}
                  />
                </GroupedList>
              ) : status.kind === 'failed' && job ? (
                <Alert data-slot="clean-cut-status" data-status="failed" variant="destructive">
                  <AlertIcon />
                  <AlertTitle>
                    {mode === 'condensed' ? 'The condensed cut failed' : 'The clean cut failed'}
                  </AlertTitle>
                  <AlertDescription className="text-xs">{status.detail}</AlertDescription>
                  <AlertAction className="flex items-center gap-1.5">
                    {status.canReview ? (
                      <Button size="xs" type="button" variant="ghost" onClick={() => review(job)}>
                        Review
                      </Button>
                    ) : null}
                    <Button
                      disabled={cannotRetry}
                      size="xs"
                      type="button"
                      variant="outline"
                      onClick={() => retry(job)}
                    >
                      <ResetIcon data-icon="inline-start" />
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              ) : (
                <GroupedList>
                  <ListRow
                    className="[&_[data-slot=list-row-title]]:shrink-0"
                    context={
                      status.detail ? (
                        <span title={status.detail}>{status.detail}</span>
                      ) : (
                        selectedFacts(selected)
                      )
                    }
                    data-slot="clean-cut-status"
                    data-status={status.kind}
                    icon={<StatusGlyph kind={status.kind} />}
                    interactive={false}
                    title={status.label}
                  >
                    <StatusActions
                      cannotStart={cannotStart}
                      job={job}
                      makeLabel={makeLabel}
                      status={status}
                      onCancel={cancel}
                      onMake={make}
                      onOpenLibrary={(outputSessionId) => onOpenLibrarySession(outputSessionId)}
                      onReview={review}
                    />
                  </ListRow>
                </GroupedList>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-slot="clean-cut-empty">
              {CLEAN_CUT_NO_RECORDINGS}
            </p>
          )}
        </div>
      </PanelSection>
      <CleanCutConsentDialog ask={ask} onAnswer={answer} />
    </>
  )
}

function selectedFacts(session: CleanCutSession): ReactNode {
  const facts = [
    typeof session.durationMs === 'number' ? formatCutClock(session.durationMs) : null,
    dayLabel(session.startedAt)
  ].filter(Boolean)
  return <span className="tabular-nums">{facts.join(' · ')}</span>
}

/** Recent recordings, newest first, named by title and when they ran. */
function RecordingPicker({
  options,
  selected,
  onSelect
}: {
  options: readonly CleanCutSession[]
  selected: CleanCutSession
  onSelect: (sessionId: string) => void
}): ReactElement {
  return (
    <Select value={selected.id} onValueChange={onSelect}>
      <SelectTrigger aria-label="Recording" className="max-w-72 min-w-0" size="sm">
        <SelectValue>
          <span className="truncate">{selected.title.trim() || UNTITLED}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" position="popper">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              <span className="max-w-64 truncate">{option.title.trim() || UNTITLED}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {dayLabel(option.startedAt)}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** A spinner while a worker runs; the tone lives in the icon, the words stay monochrome. */
function StatusGlyph({ kind }: { kind: CleanCutStatusKind }): ReactElement {
  if (kind === 'ready') return <SuccessIcon aria-hidden className="text-success" weight="fill" />
  if (
    kind === 'queued' ||
    kind === 'transcribing' ||
    kind === 'analyzing' ||
    kind === 'cutting' ||
    kind === 'checking'
  ) {
    return <SpinnerIcon aria-hidden className="animate-spin text-muted-foreground" />
  }
  return <ClipIcon aria-hidden className="text-muted-foreground" />
}

function StatusActions({
  job,
  status,
  makeLabel,
  cannotStart,
  onMake,
  onCancel,
  onReview,
  onOpenLibrary
}: {
  job: CleanCutJob | null
  status: CleanCutStatusView
  makeLabel: string
  cannotStart: boolean
  onMake: () => void
  onCancel: (job: CleanCutJob) => void
  onReview: (job: CleanCutJob) => void
  onOpenLibrary: (outputSessionId: string) => void
}): ReactElement | null {
  if (!job || status.kind === 'cancelled' || status.kind === 'none') {
    return (
      <Button disabled={cannotStart} size="sm" type="button" onClick={onMake}>
        <ClipIcon data-icon="inline-start" />
        {makeLabel}
      </Button>
    )
  }
  if (status.busy) {
    return (
      <>
        {status.canReview ? (
          <Button size="sm" type="button" variant="ghost" onClick={() => onReview(job)}>
            Review
          </Button>
        ) : null}
        <Button size="sm" type="button" variant="ghost" onClick={() => onCancel(job)}>
          Cancel
        </Button>
      </>
    )
  }
  const output = job.outputSessionId
  return (
    <>
      {status.canReview ? (
        <Button size="sm" type="button" variant="outline" onClick={() => onReview(job)}>
          Review
        </Button>
      ) : null}
      {output ? (
        <>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void window.videorc?.revealSession?.(output)}
          >
            <FolderIcon data-icon="inline-start" />
            {revealInFileManagerLabel()}
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => onOpenLibrary(output)}>
            <LibraryIcon data-icon="inline-start" />
            Open in Library
          </Button>
        </>
      ) : null}
    </>
  )
}

// As Orcle Live's line: on is a choice, not a health state, so only
// attention takes a colour.
const AUTO_TONE: Record<CleanCutAutoStatus['kind'], string> = {
  off: 'tone-neutral',
  on: 'tone-neutral',
  attention: 'tone-warning'
}

/** The glass dot carries the tone; the words stay monochrome. */
function CleanCutAutoStatusLine({ status }: { status: CleanCutAutoStatus }): ReactElement {
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
      data-slot="clean-cut-auto-status"
      data-status={status.kind}
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full glass-dot', AUTO_TONE[status.kind])}
      />
      <span className="font-medium text-foreground">{status.label}</span>
      {status.reason ? (
        <>
          <span aria-hidden>·</span>
          <span>{status.reason}</span>
        </>
      ) : null}
    </p>
  )
}
