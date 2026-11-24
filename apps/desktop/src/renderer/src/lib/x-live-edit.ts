import type {
  StreamMetadataDraft,
  StreamTargetSettings,
  XBroadcastUpdated,
  XLiveCategory
} from '@/lib/backend'
import { X_NO_CATEGORY } from '@/lib/x-live-categories'

// Live on X: the title and category of the broadcast that is on air, changed
// while it runs (`PUT /2/broadcasts/:id`). The saved Stream details stay as
// they are; X's answer to the update is what the section shows, because a
// read right after can still return the old values. Pure, so every rule is a
// test.

/** What X shows now, as Videorc last knew it. */
export type XLiveValues = { title: string; categoryId: string | null }

/** The title Go Live sent: the X row's own when it customizes, else the shared one. */
export function xGoLiveTitle(draft: StreamMetadataDraft | null): string {
  const x = draft?.targetOverrides.find((row) => row.platform === 'x')
  const own = x?.customize ? x.title.trim() : ''
  return own || draft?.title.trim() || 'Live from Videorc'
}

/** The X destination on air with its broadcast, when there is one. */
export function liveXTarget(
  targets: readonly StreamTargetSettings[]
): (StreamTargetSettings & { platformBroadcastId: string }) | null {
  const target = targets.find(
    (entry) =>
      entry.platform === 'x' &&
      entry.status?.state === 'live' &&
      typeof entry.platformBroadcastId === 'string' &&
      entry.platformBroadcastId.length > 0
  )
  return target ? (target as StreamTargetSettings & { platformBroadcastId: string }) : null
}

/** What Go Live set: the draft's title and its category, when X lists it. */
export function xLiveStart(
  draft: StreamMetadataDraft | null,
  categories: readonly XLiveCategory[]
): XLiveValues {
  const saved = draft?.targetOverrides.find((row) => row.platform === 'x')?.xCategoryId?.trim()
  const listed = categories.length === 0 || categories.some((category) => category.id === saved)
  return { title: xGoLiveTitle(draft), categoryId: saved && listed ? saved : null }
}

/** X's answer as the values it now shows. */
export function xLiveFromAnswer(answer: XBroadcastUpdated, before: XLiveValues): XLiveValues {
  return {
    title: answer.title?.trim() || before.title,
    categoryId: answer.liveCategoryId?.trim() || null
  }
}

/**
 * Only what changed, as X takes it: a trimmed title, and the category's id
 * or `''` to clear it. Null when nothing changed or the title is empty.
 */
export function xLiveChanges(
  shown: XLiveValues,
  edit: { title: string; categoryValue: string }
): { title?: string; liveCategoryId?: string } | null {
  const title = edit.title.trim()
  if (!title) return null
  const categoryId = edit.categoryValue === X_NO_CATEGORY ? null : edit.categoryValue
  const changes: { title?: string; liveCategoryId?: string } = {}
  if (title !== shown.title) changes.title = title
  if (categoryId !== shown.categoryId) changes.liveCategoryId = categoryId ?? ''
  return Object.keys(changes).length > 0 ? changes : null
}

/** The line under the fields: what X shows now. */
export function xLiveShownLine(
  shown: XLiveValues,
  categories: readonly XLiveCategory[],
  answerName?: string
): string {
  const name = shown.categoryId
    ? (categories.find((category) => category.id === shown.categoryId)?.name ??
      answerName ??
      shown.categoryId)
    : 'No category'
  return `X shows “${shown.title}” · ${name}`
}

export const X_LIVE_EDIT_TITLE = 'Live on X'
export const X_LIVE_EDIT_DESCRIPTION =
  'Changes go to X now. Your saved stream details stay as they are.'

export function xLiveUpdateFailed(message: string): string {
  return `X didn't take the change: ${message}`
}
