import { LockIcon, WarningIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { DisabledReason } from '@/components/ui/disabled-reason'
import { SelectGroup, SelectItem, SelectSeparator } from '@/components/ui/select'
import type { EntitlementsSnapshot, PerformanceCheckResult } from '@/lib/backend'
import { customVideoPresetOption, videoPresets, type VideoPresetOption } from '@/lib/capture'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { outputVerdict } from '@/lib/performance-check'

/**
 * The preset select's `items`: what its trigger shows for each value, the
 * preset's name with the warning icon an experimental or legacy one carries.
 * The same presets as `VideoPresetSelectItems`, then Custom.
 */
export function videoPresetItems(
  options: VideoPresetOption[]
): { value: VideoPresetOption['value']; label: ReactNode }[] {
  return [
    ...options.map((option) => ({
      value: option.value,
      label:
        option.tone === 'warning' ? (
          <>
            {option.label}
            <WarningIcon aria-hidden className="size-3.5 text-warning" weight="fill" />
          </>
        ) : (
          option.label
        )
    })),
    { value: customVideoPresetOption.value, label: customVideoPresetOption.label }
  ]
}

/**
 * A preset select's items: the given presets, then Custom. The Output page
 * passes `recordingPresetOptions` (plan 174 S3.6, D-28): recording presets
 * only, so no Streaming or Legacy groups.
 */
export function VideoPresetSelectItems({
  entitlements,
  kind,
  options,
  performanceResult
}: {
  entitlements: EntitlementsSnapshot | null
  kind: 'recording' | 'streaming'
  options: VideoPresetOption[]
  /** When given, each preset shows what this computer measured for it. */
  performanceResult?: PerformanceCheckResult
}): ReactElement {
  return (
    <SelectGroup>
      {options.map((option) => (
        <VideoPresetSelectItem
          entitlements={entitlements}
          key={option.value}
          kind={kind}
          option={option}
          performanceResult={performanceResult}
        />
      ))}
      {options.length > 0 ? <SelectSeparator /> : null}
      <SelectItem value={customVideoPresetOption.value}>{customVideoPresetOption.label}</SelectItem>
    </SelectGroup>
  )
}

function VideoPresetSelectItem({
  entitlements,
  kind,
  option,
  performanceResult
}: {
  entitlements: EntitlementsSnapshot | null
  kind: 'recording' | 'streaming'
  option: VideoPresetOption
  performanceResult?: PerformanceCheckResult
}): ReactElement {
  const gate = videoProfileEntitlementGate({
    entitlements,
    kind,
    video: videoPresets[option.value]
  })

  const verdict = outputVerdict(videoPresets[option.value], performanceResult)

  // A locked preset says why on hover (plan 174 J1-2): the select skips it
  // from the keyboard, so the item itself is described, with no wrapper.
  return (
    <DisabledReason focusable={false} reason={gate.allowed ? null : gate.reason} side="right">
      <SelectItem disabled={!gate.allowed} value={option.value}>
        {option.label}
        {/* An experimental or legacy preset: the icon carries the tone, the
            name stays monochrome (plan 174 S1.8, C-19). */}
        {option.tone === 'warning' ? (
          <WarningIcon aria-hidden className="size-3.5 text-warning" weight="fill" />
        ) : null}
        {!gate.allowed ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            <LockIcon className="size-3" weight="fill" />
            {gate.upgradeUrl ? 'Premium' : 'Locked'}
          </span>
        ) : verdict !== 'unknown' ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {verdict === 'verified' ? 'Verified' : 'Too heavy'}
          </span>
        ) : null}
      </SelectItem>
    </DisabledReason>
  )
}
