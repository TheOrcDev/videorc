import type { ReactElement, ReactNode, Ref } from 'react'

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { StreamPrivacy } from '@/lib/backend'
import {
  broadcastInfoIssues,
  broadcastPrivacyHint,
  broadcastTitleCounter
} from '@/lib/broadcast-info'

/** The stream details one surface edits; a field shows only when its value is given. */
export type BroadcastInfoValue = {
  title: string
  description: string
  /** Shown as "Privacy" when given. */
  privacy?: StreamPrivacy
  /** Shown as a "Made for kids" switch when given. */
  madeForKids?: boolean
}

const PRIVACY_OPTIONS: SegmentedControlOption<StreamPrivacy>[] = [
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'public', label: 'Public' }
]

/**
 * Stream details, one way everywhere (plan 174 S3.4, B-19 and D-21): the Go
 * Live dialog, Livestream → Setup and the Schedule dialog. One title rule
 * (a 100-character counter, no < or >, required only where it is about to go
 * live), one "Privacy" control (a SegmentedControl: three exclusive choices,
 * plan 174 S1.7) with what each choice means, one "Made for kids" switch, and
 * one thumbnail slot with its one hint (`broadcastThumbnailHint`).
 *
 * The caller owns the value and saving; this draws and validates. Ids are
 * `{idPrefix}-title`, `-description`, `-privacy` and `-made-for-kids`.
 */
export function BroadcastInfoFields({
  idPrefix,
  value,
  disabled = false,
  titleRequired = false,
  privacyNote,
  madeForKidsNote,
  thumbnail,
  titleRef,
  onChange
}: {
  idPrefix: string
  value: BroadcastInfoValue
  disabled?: boolean
  /** The surface is about to go live (or schedule): an empty title is an error. */
  titleRequired?: boolean
  /** What privacy doesn't cover, after its meaning ("Twitch, Kick and X are always public."). */
  privacyNote?: ReactNode
  /** Under the Made for kids switch (where to change it once published). */
  madeForKidsNote?: ReactNode
  /** The caller's ThumbnailField, with `broadcastThumbnailHint` as its hint. */
  thumbnail?: ReactNode
  /** The title input, for a dialog's initial focus. */
  titleRef?: Ref<HTMLInputElement>
  onChange: (patch: Partial<BroadcastInfoValue>) => void
}): ReactElement {
  const issues = broadcastInfoIssues(value, { titleRequired })
  return (
    <div className="flex flex-col gap-4" data-slot="broadcast-info-fields">
      <Field>
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor={`${idPrefix}-title`}>Title</FieldLabel>
          {/* The counter is a fact about the field, not its description. */}
          <span
            aria-hidden
            className="text-meta text-muted-foreground tabular-nums"
            data-slot="broadcast-title-counter"
          >
            {broadcastTitleCounter(value.title)}
          </span>
        </div>
        <Input
          ref={titleRef}
          aria-invalid={issues.title ? true : undefined}
          disabled={disabled}
          id={`${idPrefix}-title`}
          placeholder="Untitled livestream"
          value={value.title}
          onChange={(event) => onChange({ title: event.target.value })}
        />
        {issues.title ? <FieldError>{issues.title}</FieldError> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-description`}>Description</FieldLabel>
        <Textarea
          aria-invalid={issues.description ? true : undefined}
          className="min-h-20 resize-y"
          disabled={disabled}
          id={`${idPrefix}-description`}
          placeholder="Optional"
          value={value.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        {issues.description ? <FieldError>{issues.description}</FieldError> : null}
      </Field>

      {value.privacy !== undefined ? (
        <Field>
          <FieldLabel>Privacy</FieldLabel>
          <SegmentedControl
            disabled={disabled}
            id={`${idPrefix}-privacy`}
            options={PRIVACY_OPTIONS}
            value={value.privacy}
            onValueChange={(privacy) => onChange({ privacy })}
          />
          <FieldDescription>
            {broadcastPrivacyHint(value.privacy)}
            {privacyNote ? <> {privacyNote}</> : null}
          </FieldDescription>
        </Field>
      ) : null}

      {value.madeForKids !== undefined ? (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${idPrefix}-made-for-kids`}>Made for kids</FieldLabel>
            <FieldDescription>
              YouTube asks every stream to say whether it is made for kids.
              {madeForKidsNote ? <> {madeForKidsNote}</> : null}
            </FieldDescription>
          </FieldContent>
          <Switch
            checked={value.madeForKids}
            disabled={disabled}
            id={`${idPrefix}-made-for-kids`}
            onCheckedChange={(madeForKids) => onChange({ madeForKids })}
          />
        </Field>
      ) : null}

      {thumbnail}
    </div>
  )
}
