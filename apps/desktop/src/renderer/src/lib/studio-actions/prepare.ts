// Prepare (plan 209 S14): `update_stream_info` and `set_destinations`, the
// next stream's Stream details and Destinations, through the Studio's own
// paths. Stream details are checked with the same validation the Save button
// runs and saved like it; a destination turns on behind the same entitlement
// gate as its switch. Both wait while a session runs, like the Livestream page.

import { isStreamTargetStartReady } from '@/lib/capture'
import { streamingDestinationEnableGate } from '@/lib/entitlement-ui'
import { sessionLockReason } from '@/lib/lock-reason'
import { destinationLabel } from '@/lib/platform-copy'
import { metadataPlatformLabel } from '@/lib/stream-metadata-summary'
import type {
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamPlatform,
  StreamPrivacy,
  StreamTargetMetadataDraft,
  StreamingSettings
} from '../../../../shared/backend'
import type { AgentToolExecutor } from './agent'
import type { StudioPrepareAccess } from './context'

export const PREPARE_TOOL_COPY = {
  locked: sessionLockReason('Destinations, stream quality and stream details'),
  unavailable: "Stream details aren't available in this Studio.",
  loading: 'Stream details are still loading. Try again in a moment.',
  infoEmpty: 'Say what to change: title, description, privacy, category or destinations.',
  categoryPlatforms: 'Only Twitch and Kick take a category.',
  destinationsEmpty: 'Say which destinations to turn on or off: destinations.'
} as const

const PRIVACY: readonly StreamPrivacy[] = ['public', 'unlisted', 'private']
type CategoryPlatform = 'twitch' | 'kick'

function text(fields: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' ? value : undefined
}

class Refusal extends Error {}

/** A category by name: the exact name when the search has it, else its first match. */
async function resolveCategory(
  prepare: StudioPrepareAccess,
  platform: CategoryPlatform,
  query: string
): Promise<{ id: string | number; name: string }> {
  const wanted = query.trim()
  const results = await prepare.searchCategories(platform, wanted)
  const exact = results.find((result) => result.name.toLowerCase() === wanted.toLowerCase())
  const chosen = exact ?? results[0]
  if (!chosen) {
    throw new Refusal(`${metadataPlatformLabel(platform)} has no category called "${wanted}".`)
  }
  return chosen
}

function withCategory(
  override: StreamTargetMetadataDraft,
  category: { id: string | number; name: string }
): StreamTargetMetadataDraft {
  return override.platform === 'kick'
    ? { ...override, kickCategoryId: Number(category.id), kickCategoryName: category.name }
    : { ...override, twitchCategoryId: String(category.id), twitchCategoryName: category.name }
}

function categoryOf(override: StreamTargetMetadataDraft): string | undefined {
  const name =
    override.platform === 'kick' ? override.kickCategoryName : override.twitchCategoryName
  return name?.trim() || undefined
}

/** The draft as an agent reads it back: shared fields, then each platform's. */
function draftProjection(draft: StreamMetadataDraft): Record<string, unknown> {
  return {
    title: draft.title,
    description: draft.description,
    privacy: draft.defaultPrivacy,
    destinations: draft.targetOverrides.map((override) => {
      const category = categoryOf(override)
      return {
        platform: override.platform,
        title: override.customize ? override.title : draft.title,
        privacy: override.customize ? override.privacy : draft.defaultPrivacy,
        ownTitle: override.customize,
        ...(category ? { category } : {})
      }
    })
  }
}

interface DestinationInfo {
  platform: StreamPlatform
  title?: string
  description?: string
  privacy?: StreamPrivacy
  category?: string
}

function destinationInfo(value: unknown): DestinationInfo | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (typeof entry.platform !== 'string') return null
  return {
    platform: entry.platform as StreamPlatform,
    title: text(entry, 'title'),
    description: text(entry, 'description'),
    privacy: PRIVACY.find((privacy) => privacy === entry.privacy),
    category: text(entry, 'category')?.trim() || undefined
  }
}

/** The next draft for one call, or the sentence that refuses it. */
export async function nextStreamDraft(
  prepare: StudioPrepareAccess,
  draft: StreamMetadataDraft,
  args: Readonly<Record<string, unknown>>
): Promise<StreamMetadataDraft> {
  const title = text(args, 'title')
  const description = text(args, 'description')
  const privacy = PRIVACY.find((value) => value === args.privacy)
  const category = text(args, 'category')?.trim() || undefined
  const destinations = Array.isArray(args.destinations)
    ? args.destinations.map(destinationInfo)
    : []
  if (
    title === undefined &&
    description === undefined &&
    !privacy &&
    !category &&
    destinations.length === 0
  ) {
    throw new Refusal(PREPARE_TOOL_COPY.infoEmpty)
  }
  const next: StreamMetadataDraft = {
    ...draft,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(privacy ? { defaultPrivacy: privacy } : {}),
    targetOverrides: draft.targetOverrides.map((override) => ({ ...override }))
  }
  const replace = (override: StreamTargetMetadataDraft): void => {
    next.targetOverrides = next.targetOverrides.map((entry) =>
      entry.platform === override.platform ? override : entry
    )
  }

  if (category) {
    const categorized = next.targetOverrides.filter(
      (override) => override.platform === 'twitch' || override.platform === 'kick'
    )
    if (categorized.length === 0) throw new Refusal(PREPARE_TOOL_COPY.categoryPlatforms)
    for (const override of categorized) {
      replace(
        withCategory(
          override,
          await resolveCategory(prepare, override.platform as CategoryPlatform, category)
        )
      )
    }
  }

  for (const entry of destinations) {
    if (!entry) throw new Refusal('Each destination needs its platform.')
    const label = metadataPlatformLabel(entry.platform)
    const found = next.targetOverrides.find((override) => override.platform === entry.platform)
    if (!found) throw new Refusal(`${label} has no stream details in Videorc.`)
    let override = found
    if (entry.title !== undefined || entry.description !== undefined || entry.privacy) {
      // Its own title starts from the shared details, like the Own title switch.
      override = override.customize
        ? { ...override }
        : {
            ...override,
            customize: true,
            title: next.title,
            description: next.description,
            privacy: next.defaultPrivacy
          }
      if (entry.title !== undefined) override.title = entry.title
      if (entry.description !== undefined) override.description = entry.description
      if (entry.privacy) override.privacy = entry.privacy
    }
    if (entry.category) {
      if (entry.platform !== 'twitch' && entry.platform !== 'kick') {
        throw new Refusal(
          `${label} has no category in Videorc. ${PREPARE_TOOL_COPY.categoryPlatforms}`
        )
      }
      override = withCategory(
        override,
        await resolveCategory(prepare, entry.platform, entry.category)
      )
    }
    replace(override)
  }
  return next
}

export const updateStreamInfo: AgentToolExecutor = async (context, args) => {
  const prepare = context.prepare
  if (!prepare) return { ok: false, message: PREPARE_TOOL_COPY.unavailable }
  if (context.sessionActive || prepare.goLivePending) {
    return { ok: false, message: PREPARE_TOOL_COPY.locked }
  }
  const draft = prepare.draft
  if (!draft) return { ok: false, message: PREPARE_TOOL_COPY.loading }
  let next: StreamMetadataDraft
  try {
    next = await nextStreamDraft(prepare, draft, args)
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, message: error.message }
    throw error
  }
  // The Save button's own check; an agent saves only details Go Live accepts.
  const validation = await context.client.request<StreamMetadataValidation>(
    'streamTargets.metadata.validate',
    next
  )
  if (!validation.valid) {
    return {
      ok: false,
      message: validation.issues
        .map((issue) =>
          issue.platform
            ? `${metadataPlatformLabel(issue.platform)}: ${issue.message}`
            : issue.message
        )
        .join(' ')
    }
  }
  const saved = await prepare.saveDraft(next)
  return { ok: true, message: 'Stream details saved.', result: draftProjection(saved) }
}

function destinationsProjection(streaming: StreamingSettings): Record<string, unknown>[] {
  return streaming.targets.map((target) => ({
    id: target.id,
    platform: target.platform,
    label: destinationLabel(target.label),
    on: target.enabled,
    ready: isStreamTargetStartReady(target)
  }))
}

export const setDestinations: AgentToolExecutor = async (context, args) => {
  const prepare = context.prepare
  if (!prepare) return { ok: false, message: PREPARE_TOOL_COPY.unavailable }
  const asked = Array.isArray(args.destinations) ? args.destinations : []
  if (asked.length === 0) return { ok: false, message: PREPARE_TOOL_COPY.destinationsEmpty }
  if (context.sessionActive || prepare.goLivePending) {
    return { ok: false, message: PREPARE_TOOL_COPY.locked }
  }
  // Checked against the switches as they will stand, then applied together,
  // so a refusal changes nothing.
  let streaming = prepare.streaming
  const changes: { id: string; on: boolean }[] = []
  for (const entry of asked) {
    const { id, on } = (entry ?? {}) as { id?: unknown; on?: unknown }
    if (typeof id !== 'string' || typeof on !== 'boolean') {
      return { ok: false, message: 'Each destination needs its id and on.' }
    }
    const target = streaming.targets.find((candidate) => candidate.id === id)
    if (!target) {
      return {
        ok: false,
        message: `No destination has the id "${id}". list_destinations gives the ids.`
      }
    }
    if (on && !target.enabled) {
      const gate = streamingDestinationEnableGate({
        entitlements: prepare.entitlements,
        streaming,
        targetId: id
      })
      if (!gate.allowed) return { ok: false, message: gate.reason }
    }
    streaming = {
      ...streaming,
      targets: streaming.targets.map((candidate) =>
        candidate.id === id ? { ...candidate, enabled: on } : candidate
      ),
      enabledTargetIds: on
        ? [...new Set([...streaming.enabledTargetIds, id])]
        : streaming.enabledTargetIds.filter((enabledId) => enabledId !== id)
    }
    changes.push({ id, on })
  }
  for (const change of changes) prepare.patchTarget(change.id, { enabled: change.on })
  const destinations = destinationsProjection(streaming)
  const on = destinations.filter((destination) => destination.on).map((d) => d.label as string)
  return {
    ok: true,
    message: on.length
      ? `On for the next stream: ${on.join(', ')}.`
      : 'No destination is on for the next stream.',
    result: { destinations }
  }
}
