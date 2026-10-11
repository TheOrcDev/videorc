import type {
  StreamMetadataDraft,
  StreamPlatform,
  StreamPrivacy,
  StreamTargetMetadataDraft,
  StreamTargetSettings
} from '@/lib/backend'
import { destinationLabel } from '@/lib/platform-copy'

/** The platforms that carry a per-destination row in Stream details. */
export type MetadataPlatform = 'youtube' | 'twitch' | 'kick' | 'x'

export function isMetadataPlatform(platform: StreamPlatform): platform is MetadataPlatform {
  return platform === 'youtube' || platform === 'twitch' || platform === 'kick' || platform === 'x'
}

export function metadataPlatformLabel(platform: StreamPlatform): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube'
    case 'twitch':
      return 'Twitch'
    case 'kick':
      return 'Kick'
    case 'x':
      return 'X'
    case 'tiktok':
      return 'TikTok'
    case 'instagram':
      return 'Instagram'
    default:
      return 'Custom'
  }
}

export interface VisibleMetadataOverride {
  override: StreamTargetMetadataDraft
  /** The first matching destination's label, else the platform name. */
  label: string
}

/**
 * The per-destination rows Stream details draws: one per native platform that
 * has at least one destination turned on (in use, plan 174 S3.5b, D-18) AND
 * a row in the draft, in Destinations order (first appearance). A Custom
 * RTMP-only setup yields nothing, and so does a draft with no rows (the
 * backend backfills them, but the renderer must not invent one).
 */
export function visibleMetadataOverrides(
  targets: readonly StreamTargetSettings[],
  overrides: readonly StreamTargetMetadataDraft[]
): VisibleMetadataOverride[] {
  const seen = new Set<MetadataPlatform>()
  const visible: VisibleMetadataOverride[] = []
  for (const target of targets) {
    if (!target.enabled || !isMetadataPlatform(target.platform) || seen.has(target.platform)) {
      continue
    }
    seen.add(target.platform)
    const override = overrides.find((item) => item.platform === target.platform)
    if (!override) {
      continue
    }
    visible.push({
      override,
      label: destinationLabel(target.label.trim()) || metadataPlatformLabel(target.platform)
    })
  }
  return visible
}

function privacyLabel(privacy: StreamPrivacy): string {
  switch (privacy) {
    case 'public':
      return 'Public'
    case 'unlisted':
      return 'Unlisted'
    default:
      return 'Private'
  }
}

/**
 * The one-line summary on a destination's accordion row. Quiet when fine:
 * where the title comes from, then only the platform settings that are set.
 */
export function metadataOverrideSummary(
  draft: Pick<StreamMetadataDraft, 'defaultPrivacy'>,
  override: StreamTargetMetadataDraft
): string {
  const parts: string[] = [override.customize ? 'Own title' : 'Shared title']
  switch (override.platform) {
    case 'youtube': {
      parts.push(privacyLabel(override.customize ? override.privacy : draft.defaultPrivacy))
      if (override.youtubeMadeForKids) {
        parts.push('Made for kids')
      }
      break
    }
    case 'twitch': {
      const category = override.twitchCategoryName?.trim()
      if (category) {
        parts.push(category)
      }
      const language = override.twitchLanguage?.trim().toLowerCase()
      if (language && language !== 'en') {
        parts.push(language)
      }
      break
    }
    case 'kick': {
      const category = override.kickCategoryName?.trim()
      if (category) {
        parts.push(category)
      }
      break
    }
    case 'x': {
      parts.push(override.xAnnounce === false ? 'No announcement' : 'Announces')
      break
    }
    default:
      break
  }
  return parts.join(' · ')
}

/**
 * Stream details' one state word (plan 174 S3.5b, D-5): edits not saved yet,
 * saved and checked, or saved with details that need attention. Nothing
 * before the first check: a fresh page is not "ready" by default.
 */
export function streamDetailsStatus({
  dirty,
  validation
}: {
  dirty: boolean
  validation: { valid: boolean; issues: readonly unknown[] } | null
}): { tone: 'good' | 'warn' | 'neutral'; label: string } | null {
  if (dirty) return { tone: 'neutral', label: 'Unsaved changes' }
  if (!validation) return null
  if (validation.valid) return { tone: 'good', label: 'Checked' }
  const count = validation.issues.length
  return {
    tone: 'warn',
    label:
      count === 1
        ? '1 detail needs attention'
        : count > 1
          ? `${count} details need attention`
          : 'Needs attention'
  }
}
