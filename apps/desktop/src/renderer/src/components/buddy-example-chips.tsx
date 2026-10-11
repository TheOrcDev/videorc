import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'

/**
 * Example chips beside a text field (plan 174 S3.15a, G-3): a chip fills the
 * field only while it is empty. Over text the streamer wrote, it asks first,
 * so a stray click never throws away a personality or a description.
 * `onFill` gets the example to put in the field; the host decides whether
 * that also saves.
 */
export function BuddyExampleChips({
  examples,
  value,
  what,
  onFill,
  disabled = false
}: {
  examples: readonly string[]
  /** The field's current text: empty means a chip fills it at once. */
  value: string
  /** What the field holds, for the question: "personality", "description". */
  what: string
  onFill: (example: string) => void
  disabled?: boolean
}): ReactElement {
  const [replacing, setReplacing] = useState<string | null>(null)
  const pick = (example: string): void => {
    if (value.trim().length === 0 || value === example) onFill(example)
    else setReplacing(example)
  }
  return (
    <>
      {examples.map((example) => (
        <Button
          key={example}
          data-testid="buddy-example-chip"
          disabled={disabled}
          size="xs"
          type="button"
          variant="outline"
          onClick={() => pick(example)}
        >
          {example}
        </Button>
      ))}
      <ConfirmDialog
        cancelLabel="Keep mine"
        confirmLabel="Replace"
        confirmVariant="default"
        description={`What you wrote is replaced with "${replacing ?? ''}".`}
        open={replacing !== null}
        testId="buddy-example-replace"
        title={`Replace your ${what}?`}
        onCancel={() => setReplacing(null)}
        onConfirm={() => {
          if (replacing !== null) onFill(replacing)
          setReplacing(null)
        }}
      />
    </>
  )
}
