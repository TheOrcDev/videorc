import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { StreamTargetMetadataDraft, XLiveCategory } from '@/lib/backend'
import {
  X_CATEGORIES_FAILED,
  X_CATEGORIES_LOADING,
  xCategoryPatch,
  xCategoryPick,
  type XLiveCategoriesStatus
} from '@/lib/x-live-categories'

/**
 * The X destination's Category in Stream details: X's own short list in its
 * order, so a plain Select (as Twitch's Language), not a search. The pick is
 * a platform setting like Twitch's and Kick's category: it applies whether or
 * not the row customizes its title.
 */
export function XCategoryField({
  override,
  categories,
  status,
  disabled,
  id = 'x-category',
  onPatch,
  onRetry
}: {
  override: Pick<StreamTargetMetadataDraft, 'xCategoryId' | 'xCategoryName'>
  categories: readonly XLiveCategory[]
  status: XLiveCategoriesStatus
  disabled: boolean
  id?: string
  onPatch: (patch: Pick<StreamTargetMetadataDraft, 'xCategoryId' | 'xCategoryName'>) => void
  onRetry?: () => void
}): ReactElement {
  const pick = xCategoryPick(categories, status, override)
  return (
    <Field>
      <FieldLabel htmlFor={id}>Category</FieldLabel>
      <Select
        disabled={disabled || pick.unavailable}
        items={pick.items}
        value={pick.value}
        onValueChange={(value) => {
          if (value !== null) onPatch(xCategoryPatch(value, pick.items))
        }}
      >
        <SelectTrigger aria-label="X category" className="w-full" id={id}>
          <SelectValue placeholder={status === 'loading' ? X_CATEGORIES_LOADING : 'No category'} />
        </SelectTrigger>
        <SelectContent>
          {pick.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pick.note ? (
        <FieldDescription>
          {pick.note}
          {pick.note === X_CATEGORIES_FAILED && onRetry ? (
            <>
              {' '}
              <Button
                className="h-auto p-0 align-baseline"
                disabled={disabled}
                size="xs"
                type="button"
                variant="link"
                onClick={onRetry}
              >
                Try again
              </Button>
            </>
          ) : null}
        </FieldDescription>
      ) : null}
    </Field>
  )
}
