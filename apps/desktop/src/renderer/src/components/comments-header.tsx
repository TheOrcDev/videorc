import type { ReactElement } from 'react'

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import type { CommentHighlightAnchor } from '@/lib/backend'
import { COMMENT_HIGHLIGHT_ANCHORS, normalizeCommentHighlightAnchor } from '@/lib/backend'

export const HIGHLIGHT_ANCHOR_LABELS: Record<CommentHighlightAnchor, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right'
}

/** One anchor picker: the Stream Manager status bar's menu and its ⋯ fold share it. */
export function HighlightAnchorOptions({
  anchor,
  onChange
}: {
  anchor: CommentHighlightAnchor
  onChange: (anchor: CommentHighlightAnchor) => void
}): ReactElement {
  return (
    <>
      <DropdownMenuLabel>Show highlighted messages in</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={anchor}
        onValueChange={(value) => onChange(normalizeCommentHighlightAnchor(value))}
      >
        {COMMENT_HIGHLIGHT_ANCHORS.map((option) => (
          <DropdownMenuRadioItem key={option} value={option}>
            {HIGHLIGHT_ANCHOR_LABELS[option]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
