import { localOffsetMinutes, systemTimeZone } from '@/lib/local-time'
import { ChevronDownIcon } from '@/components/icons'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { SECTION_LABEL } from '@/components/section-label'
import { BroadcastInfoFields } from '@/components/streaming/broadcast-info-fields'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { PlatformGlyph } from '@/components/platform-glyph'
import { ThumbnailField } from '@/components/streaming/thumbnail-field'
import type {
  ScheduledEventMetadata,
  ScheduledStreamEvent,
  ScheduledStreamOperation,
  ScheduledStreamProvider,
  ScheduledTimeResolution
} from '@/lib/backend'
import type { useScheduledStreams } from '@/hooks/use-scheduled-streams'
import { broadcastInfoIssues } from '@/lib/broadcast-info'
import { openLivestreamView } from '@/lib/livestream-tabs'
import {
  formatGmtOffset,
  formatScheduledStart,
  timeZoneLabel,
  wallTimeAt
} from '@/lib/schedule-time'
import { scheduledProviderLabel, scheduledProviderNoun } from '@/lib/scheduled-streams'
import { userErrorMessage } from '@/lib/user-error'

/** YouTube's made-for-kids answer, as the select holds it (the API's boolean as a string). */
const AUDIENCE_ITEMS = [
  { value: 'false', label: 'No, not made for kids' },
  { value: 'true', label: 'Yes, made for kids' }
] as const

/** The backend's words for a repeated hour that has no earlier/later choice yet. */
const OCCURS_TWICE = 'This local time occurs twice. Choose the earlier or later offset.'

/** A failure in the form's words, never the raw error (plan 174 S2.4). */
function formError(error: unknown, action: string): string {
  return userErrorMessage(error, { action, object: 'the event' }).text
}

/**
 * Why the form can't be sent yet, one reason at a time and in the order the
 * fields read (plan 174 S3.5b, D-11): the primary button says it on hover
 * and focus, and each field says its own once touched.
 */
export function scheduleBlockedReason({
  provider,
  accountId,
  title,
  description,
  audience,
  plannedEndError,
  timeError,
  resolving
}: {
  provider: ScheduledStreamProvider
  accountId: string
  title: string
  description: string
  audience: string
  plannedEndError: string
  timeError: string
  resolving: boolean
}): string | null {
  if (!accountId) return provider === 'x' ? 'Choose an X account.' : 'Choose a YouTube channel.'
  const issues = broadcastInfoIssues({ title, description }, { titleRequired: true })
  if (issues.title) return title.trim() ? issues.title : 'Add a title.'
  if (issues.description) return issues.description
  if (timeError) return timeError
  if (plannedEndError) return plannedEndError
  if (provider !== 'x' && !audience) return "Choose whether it's made for kids."
  if (resolving) return 'Checking the time…'
  return null
}

/** Two hours after a `datetime-local` value, in the same wall clock. */
export function defaultPlannedEnd(localStart: string): string {
  const start = Date.parse(`${localStart}Z`)
  if (Number.isNaN(start)) return ''
  return wallTimeAt(start + 2 * 3_600_000, 0)
}

/** A new event starts an hour from now. */
const FRESH_START_LEAD_MS = 3_600_000

function freshMetadata(provider: ScheduledStreamProvider): ScheduledEventMetadata {
  // A placeholder on the local clock until `zoneOffsets` answers for the zone.
  const startMs = Date.now() + FRESH_START_LEAD_MS
  const local = wallTimeAt(startMs, localOffsetMinutes(startMs))
  return {
    title: '',
    description: '',
    privacy: 'private',
    madeForKids: false,
    localStart: local,
    timeZone: systemTimeZone(),
    offsetChoice: null,
    thumbnailAssetId: null,
    // X requires a planned end on every update; start from the usual two hours.
    plannedEndLocal: provider === 'x' ? defaultPlannedEnd(local) : null,
    availableForReplay: true
  }
}

export function ScheduleStreamDialog({
  event,
  provider: requestedProvider,
  state,
  onClose
}: {
  event: ScheduledStreamEvent | null
  /** The platform section the form was opened from; a saved event keeps its own. */
  provider?: ScheduledStreamProvider
  state: ReturnType<typeof useScheduledStreams>
  onClose: () => void
}): ReactElement {
  const providers = state.capabilities?.providers ?? []
  const [provider] = useState<ScheduledStreamProvider>(
    () =>
      event?.provider ??
      requestedProvider ??
      providers.find((item) => item.available && item.accounts.length > 0)?.provider ??
      'youtube'
  )
  const providerCapability =
    providers.find((item) => item.provider === provider) ??
    (state.capabilities
      ? {
          provider,
          available: state.capabilities.available,
          reason: state.capabilities.reason,
          accounts: state.capabilities.accounts,
          fields: [],
          audienceEditable: false as const
        }
      : undefined)
  const providerLabel = scheduledProviderLabel(provider)
  const providerNoun = scheduledProviderNoun(provider)
  const [metadata, setMetadata] = useState(() => event?.requested ?? freshMetadata(provider))
  const [accountId, setAccountId] = useState(event?.accountId ?? '')
  const [audience, setAudience] = useState(event ? String(event.requested.madeForKids) : '')
  const [zoneOpen, setZoneOpen] = useState(false)
  const [titleTouched, setTitleTouched] = useState(Boolean(event))
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [resolution, setResolution] = useState<ScheduledTimeResolution | null>(null)
  const [timeError, setTimeError] = useState('')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [published, setPublished] = useState(event?.providerEventId ?? null)
  const [watchUrl, setWatchUrl] = useState(event?.watchUrl ?? null)
  const [identity, setIdentity] = useState({
    id: event?.id ?? crypto.randomUUID(),
    revision: event?.revision ?? 0
  })
  const patch = (value: Partial<ScheduledEventMetadata>) => {
    setMetadata((old) => ({ ...old, ...value }))
    setDirty(true)
  }
  const request = state.request
  // A new event's default start, an hour from now, in the zone's wall clock
  // as the backend's tz data has it. Kept only while the field is untouched.
  const [placeholderStart] = useState(() => (event ? null : metadata.localStart))
  useEffect(() => {
    if (!placeholderStart) return
    let active = true
    const startMs = Date.now() + FRESH_START_LEAD_MS
    void request<{ offsets: Record<string, number> }>('zoneOffsets', {
      timeZones: [metadata.timeZone],
      atUtc: new Date(startMs).toISOString()
    })
      .then(({ offsets }) => {
        const offset = offsets[metadata.timeZone]
        if (!active || offset === undefined) return
        const localStart = wallTimeAt(startMs, offset)
        setMetadata((old) =>
          old.localStart === placeholderStart
            ? {
                ...old,
                localStart,
                plannedEndLocal:
                  old.plannedEndLocal === defaultPlannedEnd(placeholderStart)
                    ? defaultPlannedEnd(localStart)
                    : old.plannedEndLocal
              }
            : old
        )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [placeholderStart, metadata.timeZone, request])
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void request<ScheduledTimeResolution>('resolveTime', {
        localStart: metadata.localStart,
        timeZone: metadata.timeZone,
        offsetChoice: metadata.offsetChoice,
        plannedEndLocal: provider === 'x' ? (metadata.plannedEndLocal ?? null) : null
      })
        .then((next) => {
          if (active) {
            setResolution(next)
            setTimeError(next.startUtc ? '' : OCCURS_TWICE)
          }
        })
        .catch((error: Error) => {
          if (active) {
            setTimeError(error.message)
            setResolution(null)
          }
        })
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [
    metadata.localStart,
    metadata.timeZone,
    metadata.offsetChoice,
    metadata.plannedEndLocal,
    provider,
    request
  ])
  const resolved = resolution?.startUtc ?? ''
  // X requires an end on every update, so the form never submits an open-ended
  // X broadcast; the local strings share one zone, so they compare directly.
  const plannedEndError =
    provider === 'x'
      ? !metadata.plannedEndLocal
        ? 'Choose a planned end.'
        : metadata.plannedEndLocal <= metadata.localStart
          ? 'The planned end must be after the start.'
          : ''
      : ''
  const blockedReason = scheduleBlockedReason({
    provider,
    accountId,
    title: metadata.title,
    description: metadata.description,
    audience,
    plannedEndError,
    timeError,
    resolving: !resolved
  })
  const valid = blockedReason === null
  // The repeated-hour choice appears only when the clocks go back over the
  // chosen time (D-31), labelled with the two real offsets.
  const offsets = resolution?.repeatedHourOffsets ?? null
  const ambiguous = offsets !== null
  const offsetItems = offsets
    ? ([
        { value: 'earlier', label: `The first, at ${formatGmtOffset(offsets[0])}` },
        { value: 'later', label: `The second, at ${formatGmtOffset(offsets[1])}` }
      ] as const)
    : []
  const zoneAt = resolved || undefined
  const accounts = providerCapability?.accounts ?? state.capabilities?.accounts ?? []
  const accountNoun = provider === 'x' ? 'X account' : 'YouTube channel'
  const sendLabel = published ? `Update ${providerNoun}` : `Schedule on ${providerLabel}`
  const submit = async (publish: boolean) => {
    if (!valid || saving || conflict || (publish && !providerCapability?.available)) return
    setSaving(true)
    setError('')
    let operationId = crypto.randomUUID()
    try {
      const values = {
        ...metadata,
        madeForKids: provider === 'x' ? false : audience === 'true',
        plannedEndLocal: provider === 'x' ? metadata.plannedEndLocal : null,
        availableForReplay: provider === 'x' ? (metadata.availableForReplay ?? true) : null
      }
      await state.mutate(published ? 'update' : 'saveDraft', {
        operationId,
        eventId: identity.id,
        expectedRevision: identity.revision,
        ...(published || identity.revision > 0 ? {} : { provider }),
        accountId,
        metadata: values
      })
      const saved = await state.request<ScheduledStreamEvent>('get', { eventId: identity.id })
      setIdentity({ id: saved.id, revision: saved.revision })
      if (publish && !saved.providerEventId) {
        operationId = crypto.randomUUID()
        await state.mutate('schedule', {
          operationId,
          eventId: saved.id,
          expectedRevision: saved.revision
        })
      }
      onClose()
    } catch (error) {
      const latest = await state
        .request<ScheduledStreamEvent>('get', { eventId: identity.id })
        .catch(() => null)
      const operation = await state
        .request<ScheduledStreamOperation | null>('operation', { operationId })
        .catch(() => null)
      const ownsFailure =
        operation?.eventId === identity.id && operation.error?.code !== 'external-change'
      if (!ownsFailure && latest) setConflict(true)
      if (latest && ownsFailure) {
        setIdentity({ id: latest.id, revision: latest.revision })
        setPublished(latest.providerEventId)
        setWatchUrl(latest.watchUrl)
      }
      setError(formError(error, published ? 'update' : 'save'))
    } finally {
      setSaving(false)
    }
  }
  const reloadConflict = async () => {
    setSaving(true)
    try {
      let latest = await state.request<ScheduledStreamEvent>('get', { eventId: identity.id })
      if (latest.providerEventId) {
        await state.mutate('refresh', { eventId: latest.id, expectedRevision: latest.revision })
        latest = await state.request<ScheduledStreamEvent>('get', { eventId: identity.id })
      }
      setMetadata(latest.requested)
      setAudience(String(latest.requested.madeForKids))
      setIdentity({ id: latest.id, revision: latest.revision })
      setPublished(latest.providerEventId)
      setWatchUrl(latest.watchUrl)
      setConflict(false)
      setError('')
      setDirty(false)
    } catch (error) {
      setError(formError(error, 'reload'))
    } finally {
      setSaving(false)
    }
  }
  const close = () => {
    if (saving) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent
          size="lg"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submit(true)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlatformGlyph platform={provider} />
              {event?.providerEventId
                ? `Edit ${providerLabel} ${providerNoun}`
                : `Schedule on ${providerLabel}`}
            </DialogTitle>
            <DialogDescription>
              {provider === 'x'
                ? 'Your broadcast appears on X. Start it manually from Videorc.'
                : 'Your event appears on YouTube. Start it manually from Videorc.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FieldGroup>
              <Field data-invalid={accounts.length === 0 ? true : undefined}>
                <FieldLabel htmlFor="schedule-channel">{accountNoun}</FieldLabel>
                <Select
                  items={accounts.map((account) => ({
                    value: account.accountId,
                    label: account.accountLabel
                  }))}
                  value={accountId}
                  onValueChange={(value) => {
                    if (value === null) return
                    setAccountId(value)
                    setDirty(true)
                  }}
                  disabled={Boolean(event) || accounts.length === 0}
                >
                  <SelectTrigger id="schedule-channel" aria-label={accountNoun}>
                    <SelectValue
                      placeholder={
                        provider === 'x' ? 'Choose connected account' : 'Choose connected channel'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {accounts.map((account) => (
                        <SelectItem key={account.accountId} value={account.accountId}>
                          {account.accountLabel}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {accounts.length === 0 ? (
                  // The select had nothing to choose and said nothing (D-11).
                  <FieldDescription>
                    {`Sign in to ${providerLabel} in Destinations → Setup first.`}{' '}
                    <Button
                      className="h-auto p-0"
                      size="xs"
                      variant="link"
                      onClick={() => {
                        openLivestreamView('setup')
                        onClose()
                      }}
                    >
                      Open Setup
                    </Button>
                  </FieldDescription>
                ) : null}
              </Field>
              <BroadcastInfoFields
                idPrefix="schedule"
                titleRequired={titleTouched}
                value={{
                  title: metadata.title,
                  description: metadata.description,
                  privacy: provider === 'x' ? undefined : metadata.privacy
                }}
                onChange={(value) => {
                  if (value.title !== undefined) setTitleTouched(true)
                  patch(value)
                }}
              />
              <FieldSet>
                <FieldLegend className={SECTION_LABEL} variant="label">
                  When
                </FieldLegend>
                <FieldGroup>
                  <Field data-invalid={timeError ? true : undefined}>
                    <FieldLabel htmlFor="schedule-start">Date and time</FieldLabel>
                    <Input
                      aria-invalid={timeError ? true : undefined}
                      id="schedule-start"
                      type="datetime-local"
                      value={metadata.localStart}
                      onChange={(e) => patch({ localStart: e.target.value })}
                    />
                    {timeError ? (
                      <FieldError>{timeError}</FieldError>
                    ) : resolved && resolution?.startOffsetMinutes != null ? (
                      <FieldDescription data-testid="schedule-start-summary">
                        {formatScheduledStart(resolved, resolution.startOffsetMinutes)}
                      </FieldDescription>
                    ) : null}
                  </Field>
                  {provider === 'x' && (
                    <Field data-invalid={plannedEndError ? true : undefined}>
                      <FieldLabel htmlFor="schedule-end">Planned end</FieldLabel>
                      <Input
                        aria-invalid={plannedEndError ? true : undefined}
                        id="schedule-end"
                        type="datetime-local"
                        value={metadata.plannedEndLocal ?? ''}
                        onChange={(e) => patch({ plannedEndLocal: e.target.value || null })}
                      />
                      {plannedEndError ? (
                        <FieldError>{plannedEndError}</FieldError>
                      ) : (
                        <FieldDescription>
                          X shows the planned length. Stop whenever you like.
                        </FieldDescription>
                      )}
                    </Field>
                  )}
                  <Field>
                    <FieldLabel>Time zone</FieldLabel>
                    <Popover open={zoneOpen} onOpenChange={setZoneOpen}>
                      <PopoverTrigger
                        render={
                          <Button
                            aria-haspopup="dialog"
                            aria-label="Time zone"
                            className="justify-between font-normal"
                            variant="outline"
                          />
                        }
                      >
                        {timeZoneLabel(metadata.timeZone, resolution?.startOffsetMinutes)}
                        <ChevronDownIcon data-icon="inline-end" />
                      </PopoverTrigger>
                      <PopoverContent className="p-0">
                        <TimeZoneList
                          atUtc={zoneAt}
                          request={request}
                          onSelect={(zone) => {
                            patch({ timeZone: zone })
                            setZoneOpen(false)
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  </Field>
                  {ambiguous ? (
                    <Field>
                      <FieldLabel htmlFor="schedule-offset">This time happens twice</FieldLabel>
                      <Select
                        items={offsetItems}
                        value={metadata.offsetChoice ?? ''}
                        onValueChange={(value) => {
                          if (value === 'earlier' || value === 'later') {
                            patch({ offsetChoice: value })
                          }
                        }}
                      >
                        <SelectTrigger id="schedule-offset" aria-label="This time happens twice">
                          <SelectValue placeholder="Choose which one" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {offsetItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        The clocks go back that night, so this time happens twice.
                      </FieldDescription>
                    </Field>
                  ) : null}
                </FieldGroup>
              </FieldSet>
              <FieldSet>
                <FieldLegend className={SECTION_LABEL} variant="label">
                  {providerLabel} settings
                </FieldLegend>
                <FieldGroup>
                  {provider === 'x' ? (
                    <Field orientation="horizontal">
                      <Switch
                        id="schedule-replay"
                        checked={metadata.availableForReplay ?? true}
                        onCheckedChange={(checked) => patch({ availableForReplay: checked })}
                      />
                      <FieldLabel htmlFor="schedule-replay">Keep replay available</FieldLabel>
                    </Field>
                  ) : (
                    <Field>
                      <FieldLabel htmlFor="schedule-audience">Made for kids</FieldLabel>
                      <Select
                        items={AUDIENCE_ITEMS}
                        value={audience}
                        disabled={Boolean(published)}
                        onValueChange={(value) => {
                          if (value === null) return
                          setAudience(value)
                          setDirty(true)
                        }}
                      >
                        <SelectTrigger id="schedule-audience" aria-label="Made for kids">
                          <SelectValue placeholder="Choose audience" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {AUDIENCE_ITEMS.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {event?.providerEventId
                          ? 'Change audience in YouTube Studio, then refresh.'
                          : "YouTube asks every stream to say whether it's made for kids."}
                      </FieldDescription>
                    </Field>
                  )}
                </FieldGroup>
              </FieldSet>
              <ThumbnailField
                alt="Upcoming stream thumbnail"
                assetId={metadata.thumbnailAssetId}
                disabled={saving}
                hint="JPEG or PNG, 16:9. Files over 2 MB are scaled down to fit."
                removable={!published}
                onChange={(thumbnailAssetId) => patch({ thumbnailAssetId })}
                onError={setError}
              />
              {watchUrl && (
                <Alert variant="success">
                  <AlertDescription>
                    Event created.{' '}
                    <Button
                      className="h-auto p-0"
                      variant="link"
                      onClick={() => {
                        void window.videorc.openOAuthUrl(watchUrl)
                      }}
                    >
                      Open event on {providerLabel}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {conflict && (
                <Alert variant="warning">
                  <AlertTitle>This event changed while you were editing</AlertTitle>
                  <AlertDescription>
                    Your entries are kept. Reload the latest version to review it before saving.
                  </AlertDescription>
                  <AlertAction>
                    <Button
                      disabled={saving}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        void reloadConflict()
                      }}
                    >
                      Reload latest changes
                    </Button>
                  </AlertAction>
                </Alert>
              )}
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : providerCapability?.reason ? (
                <Alert variant="warning">
                  <AlertDescription>{providerCapability.reason}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="flex-row flex-wrap gap-2">
            <Button variant="ghost" disabled={saving} onClick={close}>
              Cancel
            </Button>
            {!published && (
              <DisabledReason reason={!saving && !conflict ? blockedReason : null}>
                <Button
                  variant="outline"
                  disabled={!valid || saving || conflict}
                  onClick={() => {
                    void submit(false)
                  }}
                >
                  Save draft
                </Button>
              </DisabledReason>
            )}
            <DisabledReason
              reason={
                saving || conflict
                  ? null
                  : (blockedReason ??
                    (providerCapability?.available
                      ? null
                      : (providerCapability?.reason ??
                        `Scheduling on ${providerLabel} isn't available right now.`)))
              }
            >
              <Button
                disabled={!valid || saving || conflict || !providerCapability?.available}
                onClick={() => {
                  void submit(true)
                }}
              >
                {saving ? 'Saving…' : sendLabel}
                <ShortcutKeys accelerator="CmdOrCtrl+Enter" aria-hidden="true" />
              </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        description="Your unsaved form edits will be lost."
        open={discard}
        testId="schedule-discard"
        title="Discard changes?"
        onCancel={() => setDiscard(false)}
        onConfirm={onClose}
      />
    </>
  )
}

/**
 * Every time zone, named by its city and offset ("Madrid (GMT+2)", D-31) and
 * searchable by its id too. Built only while the picker is open; the offsets
 * come from the backend's tz data, cities alone until they arrive.
 */
function TimeZoneList({
  atUtc,
  request,
  onSelect
}: {
  /** The event's start, or now when it has none yet. */
  atUtc: string | undefined
  request: ReturnType<typeof useScheduledStreams>['request']
  onSelect: (zone: string) => void
}): ReactElement {
  const ids = useMemo(() => {
    const ids = Intl.supportedValuesOf('timeZone')
    if (!ids.includes('UTC')) ids.unshift('UTC')
    return ids
  }, [])
  // `null` until the backend answers; cities alone if it can't.
  const [offsets, setOffsets] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    let active = true
    void request<{ offsets: Record<string, number> }>('zoneOffsets', {
      timeZones: ids,
      ...(atUtc ? { atUtc } : {})
    })
      .then((next) => next.offsets)
      .catch(() => ({}))
      .then((next) => {
        if (active) setOffsets(next)
      })
    return () => {
      active = false
    }
  }, [atUtc, ids, request])
  // Labelled once per answer, not on every search keystroke.
  const zones = useMemo(
    () => (offsets ? ids.map((zone) => ({ zone, label: timeZoneLabel(zone, offsets[zone]) })) : []),
    [ids, offsets]
  )
  return (
    <Command>
      <CommandInput placeholder="Search time zones…" />
      <CommandList>
        <CommandEmpty>{offsets ? 'No time zones found.' : 'Loading time zones…'}</CommandEmpty>
        <CommandGroup>
          {zones.map(({ zone, label }) => (
            <CommandItem
              key={zone}
              keywords={[zone.replace(/_/g, ' ')]}
              value={zone}
              onSelect={() => onSelect(zone)}
            >
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
