import { Broadcast, CheckCircle, WarningCircle } from '@phosphor-icons/react'
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
import { useStudio } from '@/hooks/use-studio'
import type { GoLiveDestinationPreflight, StreamPlatform, StreamPrivacy } from '@/lib/backend'
import { type EntitlementUiGate } from '@/lib/entitlement-ui'

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
  onPatchDraft,
  onCancel,
  onConfirm,
  onContinuePartial,
  onResolveBlocker
}: {
  open: boolean
  pending: boolean
  partialSetup: ReturnType<typeof useStudio>['goLivePartialSetup']
  preflight: ReturnType<typeof useStudio>['goLivePreflight']
  entitlementGate: EntitlementUiGate
  draft: ReturnType<typeof useStudio>['streamMetadataDraft']
  onPatchDraft: ReturnType<typeof useStudio>['patchStreamMetadataDraft']
  onCancel: () => void
  onConfirm: () => void
  onContinuePartial: () => void
  onResolveBlocker: (targetId: string, resolution: 'disable' | 'manual-rtmp') => void
}): ReactElement {
  const entitlementBlocker = entitlementGate.allowed ? null : entitlementGate
  const entitlementUpgradeUrl = entitlementBlocker?.upgradeUrl
  const errorCount = preflight?.issues.filter((issue) => issue.severity === 'error').length ?? 0
  const entitlementIssueCount =
    entitlementBlocker &&
    !preflight?.issues.some((issue) => issue.message === entitlementBlocker.reason)
      ? 1
      : 0
  const issueCount = errorCount + entitlementIssueCount
  // "Resolve before going live" means exactly that: error-severity issues keep
  // the confirm button locked until resolved (disable the destination, switch
  // it to Manual RTMP, or fix it in the Streaming tab).
  const blocked = Boolean(entitlementBlocker) || (preflight ? !preflight.valid : false)

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
                {issueCount ? (
                  <Badge variant="destructive">
                    {issueCount} issue{issueCount === 1 ? '' : 's'}
                  </Badge>
                ) : (
                  <Badge variant="success">Ready</Badge>
                )}
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

            {preflight?.issues.length ? (
              <div className="flex flex-col gap-2 rounded-row border border-destructive/25 bg-destructive/5 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <WarningCircle className="size-4" weight="fill" />
                  Resolve before going live
                </div>
                <ul className="grid gap-1.5 text-sm text-muted-foreground">
                  {preflight.issues.map((issue, index) => (
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
            <Button disabled={pending || Boolean(entitlementBlocker)} onClick={onContinuePartial}>
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
