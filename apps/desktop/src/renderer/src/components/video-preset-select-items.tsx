import { LockIcon } from '@/components/icons'
import type { ReactElement } from 'react'
import { Fragment } from 'react'

import { SelectGroup, SelectItem, SelectLabel, SelectSeparator } from '@/components/ui/select'
import type { EntitlementsSnapshot, PerformanceCheckResult } from '@/lib/backend'
import {
  customVideoPresetOption,
  legacyVideoPresetOptions,
  recordingVideoPresetOptions,
  streamingVideoPresetOptions,
  videoPresets,
  type LayoutOrientation,
  type VideoPresetOption
} from '@/lib/capture'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { outputVerdict } from '@/lib/performance-check'

// When the select edits the CANVAS, the Studio mode owns the orientation —
// only same-orientation presets are offered (Custom always stays). Stream-leg
// profile selects pass no orientation and keep the full list.
function matchesOrientation(option: VideoPresetOption, orientation: LayoutOrientation): boolean {
  const video = videoPresets[option.value]
  return orientation === 'vertical' ? video.height > video.width : video.width >= video.height
}

export function VideoPresetSelectItems({
  entitlements,
  kind,
  orientation,
  performanceResult
}: {
  entitlements: EntitlementsSnapshot | null
  kind: 'recording' | 'streaming'
  orientation?: LayoutOrientation
  /** When given, each preset shows what this computer measured for it. */
  performanceResult?: PerformanceCheckResult
}): ReactElement {
  const groups: { label: string; options: VideoPresetOption[] }[] = [
    { label: 'Recording', options: recordingVideoPresetOptions },
    { label: 'Streaming', options: streamingVideoPresetOptions },
    { label: 'Legacy', options: legacyVideoPresetOptions }
  ]
    .map((group) => ({
      ...group,
      options: orientation
        ? group.options.filter((option) => matchesOrientation(option, orientation))
        : group.options
    }))
    .filter((group) => group.options.length > 0)

  return (
    <SelectGroup>
      {groups.map((group) => (
        <Fragment key={group.label}>
          <SelectLabel>{group.label}</SelectLabel>
          {group.options.map((option) => (
            <VideoPresetSelectItem
              entitlements={entitlements}
              key={option.value}
              kind={kind}
              option={option}
              performanceResult={performanceResult}
            />
          ))}
          <SelectSeparator />
        </Fragment>
      ))}
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

  return (
    <SelectItem
      className={option.tone === 'warning' ? 'text-warning' : undefined}
      disabled={!gate.allowed}
      title={gate.allowed ? undefined : gate.reason}
      value={option.value}
    >
      {option.label}
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
  )
}
