import { ChevronDownIcon } from '@/components/icons'
import { useEffect, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Kbd } from '@/components/ui/kbd'
import { PlatformGlyph } from '@/components/platform-glyph'
import type {
  ScheduledEventMetadata,
  ScheduledStreamEvent,
  ScheduledStreamOperation,
  ScheduledStreamProvider
} from '@/lib/backend'
import type { useScheduledStreams } from '@/hooks/use-scheduled-streams'
import { displayKeyGlyph } from '@/lib/platform'
import { scheduledProviderLabel, scheduledProviderNoun } from '@/lib/scheduled-streams'

function localWallTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** Two hours after a `datetime-local` value, in the same wall clock. */
export function defaultPlannedEnd(localStart: string): string {
  const start = new Date(localStart)
  if (Number.isNaN(start.getTime())) return ''
  return localWallTime(new Date(start.getTime() + 2 * 3_600_000))
}

function freshMetadata(provider: ScheduledStreamProvider): ScheduledEventMetadata {
  const local = localWallTime(new Date(Date.now() + 3_600_000))
  return {
    title: '',
    description: '',
    privacy: 'private',
    madeForKids: false,
    localStart: local,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  const submitKey = displayKeyGlyph('⌘', document.documentElement.dataset.platform)
  const [metadata, setMetadata] = useState(() => event?.requested ?? freshMetadata(provider))
  const [accountId, setAccountId] = useState(event?.accountId ?? '')
  const [audience, setAudience] = useState(event ? String(event.requested.madeForKids) : '')
  const [zoneOpen, setZoneOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [resolved, setResolved] = useState('')
  const [timeError, setTimeError] = useState('')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [preview, setPreview] = useState<string | null>(
    event?.requested.thumbnailAssetId
      ? `videorc-asset://scheduled-thumbnail/${event.requested.thumbnailAssetId}`
      : null
  )
  const [saving, setSaving] = useState(false)
  const [published, setPublished] = useState(event?.providerEventId ?? null)
  const [watchUrl, setWatchUrl] = useState(event?.watchUrl ?? null)
  const [identity, setIdentity] = useState({
    id: event?.id ?? crypto.randomUUID(),
    revision: event?.revision ?? 0
  })
  const zones = Intl.supportedValuesOf('timeZone')
  if (!zones.includes('UTC')) zones.unshift('UTC')
  const patch = (value: Partial<ScheduledEventMetadata>) => {
    setMetadata((old) => ({ ...old, ...value }))
    setDirty(true)
  }
  const request = state.request
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void request<{ startUtc: string }>('resolveTime', {
        localStart: metadata.localStart,
        timeZone: metadata.timeZone,
        offsetChoice: metadata.offsetChoice
      })
        .then(({ startUtc }) => {
          if (active) {
            setResolved(
              new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'long',
                timeZone: metadata.timeZone
              }).format(new Date(startUtc))
            )
            setTimeError('')
          }
        })
        .catch((error: Error) => {
          if (active) {
            setTimeError(error.message)
            setResolved('')
          }
        })
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [metadata.localStart, metadata.timeZone, metadata.offsetChoice, request])
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
  const valid =
    accountId &&
    metadata.title.trim() &&
    Array.from(metadata.title).length <= 100 &&
    Array.from(metadata.description).length <= 5000 &&
    !/[<>]/.test(metadata.title + metadata.description) &&
    (provider === 'x' || audience) &&
    !plannedEndError &&
    resolved &&
    !timeError
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
      setError(error instanceof Error ? error.message : String(error))
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
      setPreview(
        latest.requested.thumbnailAssetId
          ? `videorc-asset://scheduled-thumbnail/${latest.requested.thumbnailAssetId}`
          : null
      )
      setAudience(String(latest.requested.madeForKids))
      setIdentity({ id: latest.id, revision: latest.revision })
      setPublished(latest.providerEventId)
      setWatchUrl(latest.watchUrl)
      setConflict(false)
      setError('')
      setDirty(false)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
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
          className="h-[min(90vh,48rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden p-4 sm:max-w-xl sm:p-6"
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
          <ScrollArea className="min-h-0 overflow-hidden pr-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="schedule-channel">
                  {provider === 'x' ? 'X account' : 'YouTube channel'}
                </FieldLabel>
                <Select
                  value={accountId}
                  onValueChange={(value) => {
                    setAccountId(value)
                    setDirty(true)
                  }}
                  disabled={Boolean(event)}
                >
                  <SelectTrigger
                    id="schedule-channel"
                    aria-label={provider === 'x' ? 'X account' : 'YouTube channel'}
                  >
                    <SelectValue
                      placeholder={
                        provider === 'x' ? 'Choose connected account' : 'Choose connected channel'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(providerCapability?.accounts ?? state.capabilities?.accounts ?? []).map(
                        (account) => (
                          <SelectItem key={account.accountId} value={account.accountId}>
                            {account.accountLabel}
                          </SelectItem>
                        )
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="schedule-title">Title</FieldLabel>
                <Input
                  id="schedule-title"
                  value={metadata.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
                <FieldDescription>
                  {Array.from(metadata.title).length}/100 characters
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="schedule-description">Description</FieldLabel>
                <Textarea
                  id="schedule-description"
                  value={metadata.description}
                  onChange={(e) => patch({ description: e.target.value })}
                />
                <FieldDescription>
                  {Array.from(metadata.description).length}/5,000 characters
                </FieldDescription>
              </Field>
              <FieldSet>
                <FieldLegend className="text-[11px] font-semibold text-subtle" variant="label">
                  When
                </FieldLegend>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="schedule-start">Date and time</FieldLabel>
                    <Input
                      id="schedule-start"
                      type="datetime-local"
                      value={metadata.localStart}
                      onChange={(e) => patch({ localStart: e.target.value })}
                    />
                  </Field>
                  {provider === 'x' && (
                    <Field>
                      <FieldLabel htmlFor="schedule-end">Planned end</FieldLabel>
                      <Input
                        id="schedule-end"
                        type="datetime-local"
                        value={metadata.plannedEndLocal ?? ''}
                        onChange={(e) => patch({ plannedEndLocal: e.target.value || null })}
                      />
                      <FieldDescription>
                        {plannedEndError || 'X shows the planned length. Stop whenever you like.'}
                      </FieldDescription>
                    </Field>
                  )}
                  <Field>
                    <FieldLabel>Time zone</FieldLabel>
                    <Popover open={zoneOpen} onOpenChange={setZoneOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          aria-haspopup="dialog"
                          aria-label="Time zone"
                          className="justify-between font-normal"
                          variant="outline"
                        >
                          {metadata.timeZone}
                          <ChevronDownIcon data-icon="inline-end" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="p-0">
                        <Command>
                          <CommandInput placeholder="Search time zones" />
                          <CommandList>
                            <CommandEmpty>No time zones found.</CommandEmpty>
                            <CommandGroup>
                              {zones.map((zone) => (
                                <CommandItem
                                  key={zone}
                                  value={zone}
                                  onSelect={() => {
                                    patch({ timeZone: zone })
                                    setZoneOpen(false)
                                  }}
                                >
                                  {zone}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="schedule-offset">Repeated-time offset</FieldLabel>
                    <Select
                      value={metadata.offsetChoice ?? 'ask'}
                      onValueChange={(value) =>
                        patch({
                          offsetChoice: value === 'ask' ? null : (value as 'earlier' | 'later')
                        })
                      }
                    >
                      <SelectTrigger id="schedule-offset" aria-label="Repeated-time offset">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="ask">Ask if clocks repeat this time</SelectItem>
                          <SelectItem value="earlier">Earlier offset</SelectItem>
                          <SelectItem value="later">Later offset</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {timeError || `${resolved} · ${metadata.timeZone}`}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </FieldSet>
              <FieldSet>
                <FieldLegend className="text-[11px] font-semibold text-subtle" variant="label">
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
                    <>
                      <Field>
                        <FieldLabel htmlFor="schedule-privacy">Visibility</FieldLabel>
                        <Select
                          value={metadata.privacy}
                          onValueChange={(value) =>
                            patch({ privacy: value as ScheduledEventMetadata['privacy'] })
                          }
                        >
                          <SelectTrigger id="schedule-privacy" aria-label="Visibility">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="private">Private</SelectItem>
                              <SelectItem value="unlisted">Unlisted</SelectItem>
                              <SelectItem value="public">Public</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="schedule-audience">Made for kids?</FieldLabel>
                        <Select
                          value={audience}
                          disabled={Boolean(published)}
                          onValueChange={(value) => {
                            setAudience(value)
                            setDirty(true)
                          }}
                        >
                          <SelectTrigger id="schedule-audience" aria-label="Made for kids">
                            <SelectValue placeholder="Choose audience" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="false">No, not made for kids</SelectItem>
                              <SelectItem value="true">Yes, made for kids</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {event?.providerEventId && (
                          <FieldDescription>
                            Change audience in YouTube Studio, then refresh.
                          </FieldDescription>
                        )}
                      </Field>
                    </>
                  )}
                </FieldGroup>
              </FieldSet>
              <Field>
                <FieldLabel>Thumbnail</FieldLabel>
                {preview && (
                  <img
                    src={preview}
                    alt="Upcoming stream thumbnail"
                    className="aspect-video max-h-40 rounded-md object-contain"
                  />
                )}
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    void window.videorc
                      .importScheduledThumbnail()
                      .then((image) => {
                        if (image) {
                          patch({ thumbnailAssetId: image.id })
                          setPreview(image.previewUrl)
                        }
                      })
                      .catch((error: Error) => setError(error.message))
                  }}
                >
                  {metadata.thumbnailAssetId ? 'Replace thumbnail' : 'Choose thumbnail'}
                </Button>
                {metadata.thumbnailAssetId && !published && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      patch({ thumbnailAssetId: null })
                      setPreview(null)
                    }}
                  >
                    Remove thumbnail
                  </Button>
                )}
                <FieldDescription>
                  JPEG or PNG, up to 2 MB. Recommended: 1280 × 720, 16:9.
                </FieldDescription>
              </Field>
              {watchUrl && (
                <Alert>
                  <AlertDescription>
                    Event created.{' '}
                    <Button
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
                <Alert>
                  <AlertDescription>
                    This event changed while you were editing. Your entered values are preserved.
                    Reload the latest version to review it before saving.
                    <Button
                      variant="outline"
                      disabled={saving}
                      onClick={() => {
                        void reloadConflict()
                      }}
                    >
                      Reload latest changes
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {(error || providerCapability?.reason) && (
                <Alert>
                  <AlertDescription>{error || providerCapability?.reason}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="flex-row flex-wrap gap-2">
            <Button variant="ghost" disabled={saving} onClick={close}>
              Cancel
            </Button>
            {!published && (
              <Button
                variant="outline"
                disabled={!valid || saving || conflict}
                onClick={() => {
                  void submit(false)
                }}
              >
                Save draft
              </Button>
            )}
            <Button
              disabled={!valid || saving || conflict || !providerCapability?.available}
              onClick={() => {
                void submit(true)
              }}
            >
              {saving
                ? 'Saving…'
                : published
                  ? `Update ${providerNoun}`
                  : `Schedule on ${providerLabel}`}
              <Kbd aria-hidden="true">{submitKey}↵</Kbd>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>Your unsaved form edits will be lost.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
