import { Broadcast, CheckCircle, ClosedCaptioning, WarningCircle } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  CommentsReadState,
  CommentsWriteState,
  GoLiveDestinationPreflight,
  StreamPlatform,
  StreamPrivacy
} from '@/lib/backend'
import { type EntitlementUiGate } from '@/lib/entitlement-ui'
import type { GoLiveCaptionsReadiness } from '@/lib/captions-preflight'

// The Go Live confirmation flow: review destinations + metadata, resolve any
// error-severity blockers, then start the livestream. Extracted from StudioTab
// so the flagship Studio surface stays focused; the dialog rides the studio
// state machine (no second one) through the props StudioTab threads in.
export function GoLiveConfirmationDialog({
  open,
  pending,
  partialSetup,
  preflight,
  entitlementGate,
  draft,
  captionsReadiness,
  onPatchDraft,
  onCancel,
  onConfirm,
  onContinuePartial,
  onContinueWithoutCaptions,
  onResolveBlocker
}: {
  open: boolean
  pending: boolean
  partialSetup: ReturnType<typeof useStudioCore>['goLivePartialSetup']
  preflight: ReturnType<typeof useStudioCore>['goLivePreflight']
  entitlementGate: EntitlementUiGate
  draft: ReturnType<typeof useStudioCore>['streamMetadataDraft']
  captionsReadiness: GoLiveCaptionsReadiness
  onPatchDraft: ReturnType<typeof useStudioCore>['patchStreamMetadataDraft']
  onCancel: () => void
  onConfirm: () => void
  onContinuePartial: () => void
  onContinueWithoutCaptions: () => void
  onResolveBlocker: (targetId: string, resolution: 'disable' | 'manual-rtmp') => void
}): ReactElement {
  const entitlementBlocker = entitlementGate.allowed ? null : entitlementGate
  const entitlementUpgradeUrl = entitlementBlocker?.upgradeUrl
  const errorIssues = preflight?.issues.filter((issue) => issue.severity === 'error') ?? []
  const warningIssues = preflight?.issues.filter((issue) => issue.severity === 'warning') ?? []
  const errorCount = errorIssues.length
  const entitlementIssueCount =
    entitlementBlocker &&
    !preflight?.issues.some((issue) => issue.message === entitlementBlocker.reason)
      ? 1
      : 0
  const captionsIssueCount = captionsReadiness.blocksStart ? 1 : 0
  const issueCount = errorCount + entitlementIssueCount + captionsIssueCount
  // "Resolve before going live" means exactly that: error-severity issues keep
  // the confirm button locked until resolved (disable the destination, switch
  // it to Manual RTMP, or fix it in the Streaming tab).
  const blocked =
    Boolean(entitlementBlocker) ||
    captionsReadiness.blocksStart ||
    (preflight ? !preflight.valid : false)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-h-[88vh] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Confirm Go Live</DialogTitle>
          <DialogDescription>
            Review destinations and metadata before Videorc starts the livestream.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-3">
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="go-live-title">Title</FieldLabel>
                <Input
                  id="go-live-title"
                  disabled={pending || !draft}
                  value={draft?.title ?? ''}
                  onChange={(event) => onPatchDraft({ title: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="go-live-description">Description</FieldLabel>
                <Textarea
                  className="min-h-20"
                  disabled={pending || !draft}
                  id="go-live-description"
                  value={draft?.description ?? ''}
                  onChange={(event) => onPatchDraft({ description: event.target.value })}
                />
              </Field>
            </div>

            {captionsReadiness.kind !== 'disabled' ? (
              <GoLiveCaptionsStatus
                pending={pending}
                readiness={captionsReadiness}
                onContinueWithoutCaptions={onContinueWithoutCaptions}
              />
            ) : null}

            <Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel>Default privacy</FieldLabel>
                {draft?.defaultPrivacy && draft.defaultPrivacy !== 'public' ? (
                  <Badge variant="warning">Not public</Badge>
                ) : null}
              </div>
              <Select
                disabled={pending || !draft}
                value={draft?.defaultPrivacy ?? 'private'}
                onValueChange={(value) => onPatchDraft({ defaultPrivacy: value as StreamPrivacy })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="unlisted">Unlisted</SelectItem>
                  <SelectItem value="public">Public</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                {draft?.defaultPrivacy === 'public'
                  ? 'YouTube will be discoverable from the channel while live. '
                  : 'YouTube will not be discoverable from the channel while live. '}
                Twitch and X broadcasts are always public.
              </FieldDescription>
            </Field>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Destinations</span>
                <GoLiveDestinationSummary
                  issueCount={issueCount}
                  warningCount={warningIssues.length}
                />
              </div>
              <div className="grid gap-2">
                {preflight?.destinations.length ? (
                  preflight.destinations.map((destination) => (
                    <GoLiveDestinationRow
                      destination={destination}
                      key={destination.targetId}
                      pending={pending}
                      onResolveBlocker={onResolveBlocker}
                    />
                  ))
                ) : (
                  <div className="rounded-row border border-dashed p-3 text-sm text-muted-foreground">
                    No livestream destinations are enabled.
                  </div>
                )}
              </div>
            </div>

            {entitlementBlocker ? (
              <div className="flex flex-col gap-2 rounded-row border border-warning/35 bg-warning/10 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-warning-foreground dark:text-warning">
                  <WarningCircle className="size-4" weight="fill" />
                  {entitlementUpgradeUrl ? 'Premium issue' : 'Streaming entitlement issue'}
                </div>
                <p className="text-sm text-muted-foreground">{entitlementBlocker.reason}</p>
                {entitlementUpgradeUrl ? (
                  <Button
                    className="w-fit"
                    size="sm"
                    variant="outline"
                    onClick={() => openExternalUrl(entitlementUpgradeUrl)}
                  >
                    View Premium
                  </Button>
                ) : null}
              </div>
            ) : null}

            {errorIssues.length ? (
              <div className="flex flex-col gap-2 rounded-row border border-destructive/25 bg-destructive/5 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <WarningCircle className="size-4" weight="fill" />
                  Resolve before going live
                </div>
                <ul className="grid gap-1.5 text-sm text-muted-foreground">
                  {errorIssues.map((issue, index) => (
                    <li key={`${issue.platform ?? 'global'}-${issue.targetId ?? 'all'}-${index}`}>
                      {issue.platform ? `${platformLabel(issue.platform)}: ` : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {warningIssues.length ? (
              <div className="flex flex-col gap-2 rounded-row border border-warning/35 bg-warning/10 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <WarningCircle className="size-4 text-warning" weight="fill" />
                  Comments limitations
                </div>
                <ul className="grid gap-1.5 text-sm text-muted-foreground">
                  {warningIssues.map((issue, index) => (
                    <li key={`${issue.platform ?? 'global'}-${issue.targetId ?? 'all'}-${index}`}>
                      {issue.platform ? `${platformLabel(issue.platform)}: ` : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {partialSetup ? (
              <div className="flex flex-col gap-2 rounded-row border border-warning/35 bg-warning/10 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <WarningCircle className="size-4 text-warning" weight="fill" />
                  Some destinations failed setup
                </div>
                <ul className="grid gap-1.5 text-sm text-muted-foreground">
                  {partialSetup.failures.map((failure) => (
                    <li key={failure.targetId}>
                      {platformLabel(failure.platform)}: {failure.label} - {failure.message}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Ready: {partialSetup.readyLabels.join(', ')}
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button disabled={pending} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {partialSetup ? (
            <Button
              disabled={pending || Boolean(entitlementBlocker) || captionsReadiness.blocksStart}
              onClick={onContinuePartial}
            >
              <Broadcast data-icon="inline-start" weight="fill" />
              {pending ? 'Starting…' : 'Continue With Ready'}
            </Button>
          ) : (
            <Button disabled={pending || !preflight || blocked} onClick={onConfirm}>
              <Broadcast data-icon="inline-start" weight="fill" />
              {pending ? 'Checking…' : blocked ? 'Resolve Blockers First' : 'Confirm Go Live'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GoLiveCaptionsStatus({
  readiness,
  pending,
  onContinueWithoutCaptions
}: {
  readiness: GoLiveCaptionsReadiness
  pending: boolean
  onContinueWithoutCaptions: () => void
}): ReactElement {
  const blocked = readiness.kind === 'blocked'
  const ready = readiness.kind === 'ready'
  return (
    <div
      className={
        blocked
          ? 'flex flex-col gap-2 rounded-row border border-warning/35 bg-warning/10 p-3'
          : 'flex flex-col gap-2 rounded-row border border-border bg-muted/25 p-3'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ClosedCaptioning className="size-4 text-muted-foreground" weight="duotone" />
          Captions
        </div>
        <Badge variant={ready ? 'success' : blocked ? 'warning' : 'secondary'}>
          {ready ? <CheckCircle data-icon="inline-start" weight="fill" /> : null}
          {readiness.title.replace(/^Captions\s*/i, '')}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{readiness.description}</p>
      {blocked ? (
        <Button
          className="w-fit"
          disabled={pending}
          size="sm"
          variant="outline"
          onClick={onContinueWithoutCaptions}
        >
          Continue without captions
        </Button>
      ) : null}
    </div>
  )
}

function openExternalUrl(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

function GoLiveDestinationRow({
  destination,
  pending,
  onResolveBlocker
}: {
  destination: GoLiveDestinationPreflight
  pending: boolean
  onResolveBlocker: (targetId: string, resolution: 'disable' | 'manual-rtmp') => void
}): ReactElement {
  return (
    <div className="grid gap-2 rounded-row border bg-muted/25 p-3 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{destination.label}</span>
          <Badge variant={destination.ready ? 'success' : 'destructive'}>
            {destination.ready ? (
              <CheckCircle data-icon="inline-start" weight="fill" />
            ) : (
              <WarningCircle data-icon="inline-start" weight="fill" />
            )}
            {destination.ready ? 'Ready' : 'Blocked'}
          </Badge>
          <Badge variant="outline">
            {destination.authMode === 'oauth' ? 'OAuth' : 'Manual RTMP'}
          </Badge>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {destination.title || 'Untitled'}
        </p>
        {destination.accountLabel ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{destination.accountLabel}</p>
        ) : null}
        <GoLiveCommentsStatus
          message={destination.chatMessage}
          read={destination.chatRead}
          write={destination.chatWrite}
        />
        {!destination.ready ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {destination.authMode === 'oauth' ? (
              <Button
                disabled={pending}
                size="sm"
                variant="outline"
                onClick={() => onResolveBlocker(destination.targetId, 'manual-rtmp')}
              >
                Switch to Manual RTMP
              </Button>
            ) : null}
            <Button
              disabled={pending}
              size="sm"
              variant="outline"
              onClick={() => onResolveBlocker(destination.targetId, 'disable')}
            >
              Go live without {destination.label}
            </Button>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground sm:max-w-64 sm:text-right">
        {destination.message}
      </p>
    </div>
  )
}

export function GoLiveCommentsStatus({
  read,
  write,
  message
}: {
  read: CommentsReadState
  write: CommentsWriteState
  message: string
}): ReactElement {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div aria-label="Comments read and send status" className="flex flex-wrap gap-1.5">
        <Badge
          variant={
            read === 'ready'
              ? 'success'
              : read === 'failed'
                ? 'destructive'
                : read === 'connecting' || read === 'waiting-for-broadcast-context'
                  ? 'warning'
                  : 'outline'
          }
        >
          Read: {commentsReadLabel(read)}
        </Badge>
        <Badge
          variant={
            write === 'ready'
              ? 'success'
              : write === 'failed'
                ? 'destructive'
                : write === 'missing-scope'
                  ? 'warning'
                  : 'outline'
          }
        >
          Send: {commentsWriteLabel(write)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  )
}

export function GoLiveDestinationSummary({
  issueCount,
  warningCount
}: {
  issueCount: number
  warningCount: number
}): ReactElement {
  if (issueCount > 0) {
    return (
      <Badge variant="destructive">
        {issueCount} issue{issueCount === 1 ? '' : 's'}
      </Badge>
    )
  }
  if (warningCount > 0) {
    return (
      <Badge variant="warning">
        Ready · {warningCount} comment limitation{warningCount === 1 ? '' : 's'}
      </Badge>
    )
  }
  return <Badge variant="success">Ready</Badge>
}

function commentsReadLabel(state: CommentsReadState): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'connecting':
      return 'Connecting'
    case 'waiting-for-broadcast-context':
      return 'After publish'
    case 'ended':
      return 'Ended'
    case 'failed':
      return 'Failed'
    case 'unavailable':
      return 'Unavailable'
  }
}

function commentsWriteLabel(state: CommentsWriteState): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'missing-scope':
      return 'Reconnect needed'
    case 'read-only':
      return 'Receive only'
    case 'failed':
      return 'Failed'
    case 'unavailable':
      return 'Unavailable'
  }
}

function platformLabel(platform: StreamPlatform): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube'
    case 'twitch':
      return 'Twitch'
    case 'x':
      return 'X'
    case 'custom':
      return 'Custom RTMP'
  }
}
