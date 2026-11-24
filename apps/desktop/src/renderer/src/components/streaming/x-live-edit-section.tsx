import { useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { XCategoryField } from '@/components/streaming/x-category-field'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type {
  StreamMetadataDraft,
  XBroadcastUpdated,
  XLiveCategory,
  XUpdateBroadcastParams
} from '@/lib/backend'
import { X_NO_CATEGORY, type XLiveCategoriesStatus } from '@/lib/x-live-categories'
import {
  X_LIVE_EDIT_DESCRIPTION,
  X_LIVE_EDIT_TITLE,
  xLiveChanges,
  xLiveFromAnswer,
  xLiveShownLine,
  xLiveStart,
  xLiveUpdateFailed,
  type XLiveValues
} from '@/lib/x-live-edit'

/**
 * Live on X: the broadcast on air takes a new title or category at once
 * (`PUT /2/broadcasts/:id`). Shown only while X is live; keyed by the
 * broadcast, so a new stream starts from what its Go Live sent.
 */
export function XLiveEditSection({
  broadcastId,
  accountId,
  draft,
  categories,
  categoriesStatus,
  onUpdate,
  onRetryCategories
}: {
  broadcastId: string
  accountId?: string
  draft: StreamMetadataDraft | null
  categories: readonly XLiveCategory[]
  categoriesStatus: XLiveCategoriesStatus
  onUpdate: (params: XUpdateBroadcastParams) => Promise<XBroadcastUpdated>
  onRetryCategories?: () => void
}): ReactElement {
  const [shown, setShown] = useState<XLiveValues>(() => xLiveStart(draft, categories))
  const [answerName, setAnswerName] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState(shown.title)
  const [categoryValue, setCategoryValue] = useState(shown.categoryId ?? X_NO_CATEGORY)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const changes = xLiveChanges(shown, { title, categoryValue })
  const titleEmpty = title.trim().length === 0

  const update = async (): Promise<void> => {
    if (!changes || pending) return
    setPending(true)
    setFailure(null)
    try {
      const answer = await onUpdate({ accountId, broadcastId, ...changes })
      const next = xLiveFromAnswer(answer, shown)
      setShown(next)
      setAnswerName(answer.liveCategoryName)
      setTitle(next.title)
      setCategoryValue(next.categoryId ?? X_NO_CATEGORY)
    } catch (error) {
      setFailure(xLiveUpdateFailed(error instanceof Error ? error.message : String(error)))
    } finally {
      setPending(false)
    }
  }

  return (
    <PanelSection
      action={
        <Button disabled={!changes || pending} variant="secondary" onClick={() => void update()}>
          {pending ? 'Updating…' : 'Update X'}
        </Button>
      }
      description={X_LIVE_EDIT_DESCRIPTION}
      title={X_LIVE_EDIT_TITLE}
    >
      <div className="flex flex-col gap-3">
        <Field data-invalid={titleEmpty || undefined}>
          <FieldLabel htmlFor="x-live-title">Title</FieldLabel>
          <Input
            aria-invalid={titleEmpty}
            disabled={pending}
            id="x-live-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {titleEmpty ? <FieldError>X needs a title.</FieldError> : null}
        </Field>
        <XCategoryField
          categories={categories}
          disabled={pending}
          id="x-live-category"
          override={{
            xCategoryId: categoryValue === X_NO_CATEGORY ? undefined : categoryValue,
            xCategoryName: categories.find((category) => category.id === categoryValue)?.name
          }}
          status={categoriesStatus}
          onPatch={(patch) => setCategoryValue(patch.xCategoryId ?? X_NO_CATEGORY)}
          onRetry={onRetryCategories}
        />
        <FieldDescription role="status">
          {xLiveShownLine(shown, categories, answerName)}
        </FieldDescription>
        {failure ? <FieldError>{failure}</FieldError> : null}
      </div>
    </PanelSection>
  )
}
