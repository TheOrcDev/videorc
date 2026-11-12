import type {
  GoLiveDestinationPreflight,
  StreamMetadataDraft,
  StreamPrivacy,
  StreamTargetSettings
} from './backend'
import { destinationLabel, platformLabel } from './platform-copy'

// Going live where viewers can't find it (owner report, 2026-11-12: four
// platforms live at once, YouTube Unlisted, and nothing said so). Every
// YouTube destination in a Go Live that is Unlisted or Private asks the
// streamer once more, naming it and its privacy: the Go Live dialog with a
// confirm step on its primary, an agent's `go_live` with `allowNonPublic`.
// Pure, so the dialog, the headless path and their tests share one answer.

/** A privacy that keeps viewers out: anything but Public. */
export type NonPublicPrivacy = Exclude<StreamPrivacy, 'public'>

/** One YouTube destination this Go Live sends that isn't Public. */
export interface NonPublicYouTubeDestination {
  targetId: string
  /** The destination's name, as its row in the dialog shows it. */
  label: string
  privacy: NonPublicPrivacy
  /** The privacy is the scheduled event's own, not the dialog's Privacy field. */
  scheduled: boolean
}

/**
 * The privacy an instant YouTube broadcast is created with, as the backend
 * resolves it (`effective_youtube_metadata` in youtube.rs): YouTube's own
 * override when it is customised, else the draft's privacy. With no draft,
 * Private, the backend's default draft.
 */
export function effectiveInstantYouTubePrivacy(
  draft: Pick<StreamMetadataDraft, 'defaultPrivacy' | 'targetOverrides'> | null
): StreamPrivacy {
  const override = draft?.targetOverrides.find((target) => target.platform === 'youtube')
  if (override?.customize) return override.privacy
  return draft?.defaultPrivacy ?? 'private'
}

/**
 * The draft patch that sets the instant YouTube privacy, where the backend
 * reads it: the customised YouTube override when there is one, else the
 * draft's privacy. The dialog's Privacy field edits through this, so what it
 * shows is what YouTube gets.
 */
export function instantYouTubePrivacyPatch(
  draft: Pick<StreamMetadataDraft, 'targetOverrides'> | null,
  privacy: StreamPrivacy
): Partial<StreamMetadataDraft> {
  const overrides = draft?.targetOverrides ?? []
  if (!overrides.some((target) => target.platform === 'youtube' && target.customize)) {
    return { defaultPrivacy: privacy }
  }
  return {
    targetOverrides: overrides.map((target) =>
      target.platform === 'youtube' && target.customize ? { ...target, privacy } : target
    )
  }
}

function asPrivacy(value: string | undefined): StreamPrivacy | null {
  const word = value?.trim().toLowerCase()
  return word === 'public' || word === 'unlisted' || word === 'private' ? word : null
}

/**
 * Every YouTube destination this Go Live sends that isn't Public, in the
 * order they are saved. An instant one gets the draft's effective privacy; a
 * scheduled one its event's (the preflight's, else the saved copy). A
 * scheduled event whose privacy Videorc never learned is left out: there is
 * no value to name.
 */
export function nonPublicYouTubeDestinations({
  sentTargets,
  destinations = [],
  draft
}: {
  /** The destinations this Go Live sends (`goLiveConfirmGate`'s `sentTargets`). */
  sentTargets: readonly StreamTargetSettings[]
  /** The preflight's rows, for their label and scheduled event. */
  destinations?: readonly GoLiveDestinationPreflight[]
  draft: Pick<StreamMetadataDraft, 'defaultPrivacy' | 'targetOverrides'> | null
}): NonPublicYouTubeDestination[] {
  const instant = effectiveInstantYouTubePrivacy(draft)
  const found: NonPublicYouTubeDestination[] = []
  for (const target of sentTargets) {
    if (target.platform !== 'youtube') continue
    const row = destinations.find((destination) => destination.targetId === target.id)
    const scheduled = Boolean(target.scheduledEventId)
    const privacy = scheduled
      ? (asPrivacy(row?.scheduled?.privacy) ?? asPrivacy(target.scheduledPrivacy))
      : instant
    if (!privacy || privacy === 'public') continue
    found.push({
      targetId: target.id,
      label: destinationLabel(row?.label ?? target.label),
      privacy,
      scheduled
    })
  }
  return found
}

const PRIVACY_WORD: Record<NonPublicPrivacy, string> = {
  unlisted: 'Unlisted',
  private: 'Private'
}

const PRIVACY_MEANING: Record<NonPublicPrivacy, string> = {
  unlisted: 'Only people with the link can watch.',
  private: 'Only you can watch.'
}

/** A row's privacy line: "Unlisted. Only people with the link can watch." */
export function nonPublicPrivacyLine(privacy: NonPublicPrivacy): string {
  return `${PRIVACY_WORD[privacy]}. ${PRIVACY_MEANING[privacy]}`
}

/** "YouTube Vertical" as named, or "Main channel (YouTube)" for a name without it. */
function youtubeName(label: string): string {
  const youtube = platformLabel('youtube')
  return label.toLowerCase().includes(youtube.toLowerCase()) ? label : `${label} (${youtube})`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The words of the Go Live dialog's privacy step. */
export interface GoLivePrivacyConfirmCopy {
  /** "Go live unlisted?" */
  title: string
  /** "YouTube is Unlisted. Only people with the link can watch." */
  description: string
  /** "Go live unlisted", or "Go live anyway" for a mix. */
  confirmLabel: string
  /** "Change privacy" when the dialog's Privacy field can change it, else "Go back". */
  cancelLabel: string
}

/**
 * The privacy step's words for these destinations (never empty): one
 * sentence per privacy naming who has it and what it means, so a Go Live to
 * four platforms says plainly which one viewers won't find.
 */
export function goLivePrivacyConfirmCopy(
  nonPublic: readonly NonPublicYouTubeDestination[]
): GoLivePrivacyConfirmCopy {
  const privacies = (['unlisted', 'private'] as const).filter((privacy) =>
    nonPublic.some((destination) => destination.privacy === privacy)
  )
  const description = privacies
    .map((privacy) => {
      const names = [
        ...new Set(
          nonPublic
            .filter((destination) => destination.privacy === privacy)
            .map((destination) =>
              destination.scheduled
                ? `the scheduled event on ${youtubeName(destination.label)}`
                : youtubeName(destination.label)
            )
        )
      ]
      const verb = names.length > 1 ? 'are' : 'is'
      return `${capitalize(joinNames(names))} ${verb} ${PRIVACY_WORD[privacy]}. ${PRIVACY_MEANING[privacy]}`
    })
    .join(' ')
  const single = privacies.length === 1 ? privacies[0] : null
  const word = single ? PRIVACY_WORD[single].toLowerCase() : null
  return {
    title: word ? `Go live ${word}?` : 'Go live unlisted and private?',
    description,
    confirmLabel: word ? `Go live ${word}` : 'Go live anyway',
    cancelLabel: nonPublic.some((destination) => !destination.scheduled)
      ? 'Change privacy'
      : 'Go back'
  }
}

/** What an agent's `go_live` reads when it would go live non-public unasked. */
export const ALLOW_NON_PUBLIC_HINT =
  'Pass allowNonPublic: true to go live anyway, or change Privacy in Livestream → Setup.'

/** The agent's refusal: the dialog's own sentence, then how to go ahead. */
export function headlessNonPublicRefusal(
  nonPublic: readonly NonPublicYouTubeDestination[]
): string {
  return `${goLivePrivacyConfirmCopy(nonPublic).description} ${ALLOW_NON_PUBLIC_HINT}`
}
