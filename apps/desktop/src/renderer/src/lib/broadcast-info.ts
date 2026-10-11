import type { StreamPrivacy } from './backend'

// One set of stream-detail rules for every surface that edits them (plan 174
// S3.4, B-19 and D-21): the Go Live dialog, Livestream → Setup and the
// Schedule dialog used to count, validate and name the same fields three ways
// ("Privacy" here, "Visibility" there; a 100-character rule in one, none in
// the others). YouTube's limits are the strictest of the platforms', so they
// are the rule everywhere.

/** YouTube's title limit, counted in characters as people see them. */
export const BROADCAST_TITLE_MAX = 100
/** YouTube's description limit. */
export const BROADCAST_DESCRIPTION_MAX = 5000

/** Characters as a person counts them (an emoji is one), as YouTube counts. */
export function broadcastTextLength(text: string): number {
  return Array.from(text).length
}

export type BroadcastInfoIssues = {
  title: string | null
  description: string | null
}

/**
 * What is wrong with a title and a description, in the words shown under the
 * field. `titleRequired` is for a surface that is about to go live (or
 * schedule); an empty title elsewhere is a draft, not an error.
 */
export function broadcastInfoIssues(
  value: { title: string; description: string },
  { titleRequired = false }: { titleRequired?: boolean } = {}
): BroadcastInfoIssues {
  const angle = /[<>]/
  const title =
    titleRequired && value.title.trim() === ''
      ? 'Add a title before you go live.'
      : broadcastTextLength(value.title) > BROADCAST_TITLE_MAX
        ? `Keep the title to ${BROADCAST_TITLE_MAX} characters.`
        : angle.test(value.title)
          ? "Titles can't contain < or >."
          : null
  const description =
    broadcastTextLength(value.description) > BROADCAST_DESCRIPTION_MAX
      ? `Keep the description to ${BROADCAST_DESCRIPTION_MAX.toLocaleString()} characters.`
      : angle.test(value.description)
        ? "Descriptions can't contain < or >."
        : null
  return { title, description }
}

/** The counter under the title: "12/100". */
export function broadcastTitleCounter(title: string): string {
  return `${broadcastTextLength(title)}/${BROADCAST_TITLE_MAX}`
}

/** What a privacy choice means, said under the Privacy control. */
export function broadcastPrivacyHint(privacy: StreamPrivacy): string {
  switch (privacy) {
    case 'public':
      return 'Anyone can find it on YouTube.'
    case 'unlisted':
      return 'Only people with the link can watch it on YouTube.'
    case 'private':
      return 'Only you can watch it on YouTube.'
  }
}

/** The one thumbnail hint: where a thumbnail goes, and when it can't. */
export function broadcastThumbnailHint({ youtubeSignedIn }: { youtubeSignedIn: boolean }): string {
  return youtubeSignedIn
    ? 'Shown on YouTube. JPEG or PNG, 16:9, 1280 × 720 or larger.'
    : "Stream key destinations can't receive a thumbnail. Connect the YouTube account, or set it in YouTube Studio."
}
