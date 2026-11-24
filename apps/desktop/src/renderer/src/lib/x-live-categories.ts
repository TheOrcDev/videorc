import type { StreamTargetMetadataDraft, XLiveCategory } from '@/lib/backend'

// The X destination's category picker in Stream details. X lists its live
// categories itself (`GET /2/broadcasts/categories`, sorted by viewership)
// and changes them rarely: the picker keeps X's order, stores the permanent
// `id` and shows the `name`. The last pick stays for the next stream, as X
// recommends. A saved category X no longer lists is left out of Go Live
// quietly (the backend); the picker shows No category and says why. Pure, so
// every rule is a test.

/** The Select's value for "no category" (Base UI reserves `null`). */
export const X_NO_CATEGORY = 'none'

export type XLiveCategoriesStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type XCategoryItem = { value: string; label: string }

export type XCategoryPick = {
  items: XCategoryItem[]
  value: string
  /** One quiet line under the picker, when there is something to say. */
  note: string | null
  /** The picker can't be used yet (X Live isn't authorized, or it's loading). */
  unavailable: boolean
}

export const X_CATEGORY_NEEDS_X_LIVE = 'Authorize X Live to pick a category.'
export const X_CATEGORIES_LOADING = 'Loading categories…'
export const X_CATEGORIES_FAILED = "X's categories didn't load."

export function xCategoryGone(name: string): string {
  return `X no longer lists “${name}”. Go Live leaves it out.`
}

export function xCategoryPick(
  categories: readonly XLiveCategory[],
  status: XLiveCategoriesStatus,
  saved: Pick<StreamTargetMetadataDraft, 'xCategoryId' | 'xCategoryName'>
): XCategoryPick {
  const savedId = saved.xCategoryId?.trim() || null
  const savedName = saved.xCategoryName?.trim() || savedId
  const listed = savedId !== null && categories.some((category) => category.id === savedId)
  const items: XCategoryItem[] = [
    { value: X_NO_CATEGORY, label: 'No category' },
    ...categories.map((category) => ({ value: category.id, label: category.name }))
  ]
  // Until X's list says otherwise, the saved pick stays on show.
  if (savedId !== null && !listed && status !== 'ready') {
    items.push({ value: savedId, label: savedName ?? savedId })
  }
  const value =
    savedId !== null && items.some((item) => item.value === savedId) ? savedId : X_NO_CATEGORY
  const gone = savedId !== null && !listed && status === 'ready'
  return {
    items,
    value,
    note:
      status === 'idle'
        ? X_CATEGORY_NEEDS_X_LIVE
        : status === 'failed'
          ? X_CATEGORIES_FAILED
          : gone
            ? xCategoryGone(savedName ?? savedId)
            : null,
    unavailable: status === 'idle' || (status === 'loading' && categories.length === 0)
  }
}

/** The draft patch for a pick: the id to send and the name to show. */
export function xCategoryPatch(
  value: string,
  items: readonly XCategoryItem[]
): Pick<StreamTargetMetadataDraft, 'xCategoryId' | 'xCategoryName'> {
  const item = value === X_NO_CATEGORY ? undefined : items.find((entry) => entry.value === value)
  return item
    ? { xCategoryId: item.value, xCategoryName: item.label }
    : { xCategoryId: undefined, xCategoryName: undefined }
}
