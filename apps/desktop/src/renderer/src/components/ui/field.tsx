'use client'

import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { useMemo } from 'react'
import type { ComponentProps, ReactNode } from 'react'

import { ErrorIcon } from '@/components/icons'
import {
  FieldIdsContext,
  useFieldDescriptionId,
  useFieldIds,
  useFieldLabelIds
} from '@/components/ui/field-context'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

function FieldSet({ className, ...props }: ComponentProps<'fieldset'>) {
  return (
    <fieldset
      className={cn(
        'flex flex-col gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
        className
      )}
      data-slot="field-set"
      {...props}
    />
  )
}

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      className={cn(
        'mb-3 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base',
        className
      )}
      data-slot="field-legend"
      data-variant={variant}
      {...props}
    />
  )
}

// Grouped: the macOS System Settings look. Fields become rows in one inset
// group, split by hairlines.
const FIELD_GROUP_GROUPED =
  'rounded-row border-border bg-inset divide-border gap-0 divide-y overflow-hidden border *:data-[slot=field]:px-3 *:data-[slot=field]:py-2.5'

function FieldGroup({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'div'> & { variant?: 'default' | 'grouped' }) {
  return (
    <div
      className={cn(
        'group/field-group @container/field-group flex w-full flex-col gap-6 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4',
        variant === 'grouped' && FIELD_GROUP_GROUPED,
        className
      )}
      data-slot="field-group"
      data-variant={variant}
      {...props}
    />
  )
}

const fieldVariants = cva('group/field data-[invalid=true]:text-destructive flex w-full gap-3', {
  defaultVariants: {
    orientation: 'vertical'
  },
  variants: {
    orientation: {
      horizontal:
        'flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      responsive:
        'flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      vertical: 'flex-col *:w-full [&>.sr-only]:w-auto'
    }
  }
})

// A Field names its control: FieldLabel points at it and FieldDescription
// describes it (field-context.ts).
function Field({
  className,
  orientation = 'vertical',
  ...props
}: ComponentProps<'div'> & VariantProps<typeof fieldVariants>) {
  const ids = useFieldIds()
  return (
    <FieldIdsContext.Provider value={ids}>
      <div
        className={cn(fieldVariants({ orientation }), className)}
        data-orientation={orientation}
        data-slot="field"
        role="group"
        {...props}
      />
    </FieldIdsContext.Provider>
  )
}

function FieldContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('group/field-content flex flex-1 flex-col gap-1 leading-snug', className)}
      data-slot="field-content"
      {...props}
    />
  )
}

function FieldLabel({ className, id, htmlFor, ...props }: ComponentProps<typeof Label>) {
  const field = useFieldLabelIds(id)
  return (
    <Label
      className={cn(
        'group/field-label peer/field-label has-data-checked:bg-input/30 has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-input/40 has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/50 has-[>[data-slot=field]]:rounded-row flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-[>[data-slot=field]]:border has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 *:data-[slot=field]:p-4',
        'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col',
        className
      )}
      data-slot="field-label"
      htmlFor={htmlFor ?? field.htmlFor}
      id={field.id}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex w-fit items-center gap-2 text-sm font-medium group-data-[disabled=true]/field:opacity-50',
        className
      )}
      data-slot="field-label"
      {...props}
    />
  )
}

// Every description reads at the metadata size (12 px). Inside a Field it
// describes the Field's controls through their aria-describedby.
function FieldDescription({ className, id, ...props }: ComponentProps<'p'>) {
  const descriptionId = useFieldDescriptionId(id)
  return (
    <p
      className={cn(
        'text-meta text-muted-foreground text-left leading-normal font-normal group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5',
        'last:mt-0 nth-last-2:-mt-1',
        '[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
        className
      )}
      data-slot="field-description"
      id={descriptionId}
      {...props}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: ComponentProps<'div'> & {
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2',
        className
      )}
      data-content={Boolean(children)}
      data-slot="field-separator"
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="bg-background text-muted-foreground relative mx-auto block w-fit px-2"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: ComponentProps<'div'> & {
  errors?: ({ message?: string } | undefined)[]
}) {
  const content = useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()]

    if (uniqueErrors.length === 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map(
          (error) => error?.message && <li key={error.message}>{error.message}</li>
        )}
      </ul>
    )
  }, [children, errors])

  if (!content) {
    return null
  }

  // Monochrome words with the error glyph in the destructive tone: the colour
  // marks it, and the text stays readable in both themes.
  return (
    <div
      className={cn('text-foreground flex items-start gap-1.5 text-xs font-normal', className)}
      data-slot="field-error"
      role="alert"
      {...props}
    >
      <ErrorIcon
        aria-hidden
        className="text-destructive mt-px size-3.5 shrink-0"
        data-slot="field-error-icon"
        weight="fill"
      />
      <div className="min-w-0">{content}</div>
    </div>
  )
}

/**
 * One settings row: the label and its 12 px description on the left, the
 * control on the right. A horizontal Field underneath, so the label names the
 * control and the description describes it. Rows sit in a
 * `FieldGroup variant="grouped"`. `error` is the row's own refusal or failure:
 * a FieldError under the description, announced when it appears.
 */
function SettingsRow({
  label,
  description,
  error,
  children,
  ...props
}: Omit<ComponentProps<typeof Field>, 'orientation' | 'title'> & {
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
}) {
  return (
    <Field data-settings-row="" orientation="horizontal" {...props}>
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </FieldContent>
      {children}
    </Field>
  )
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
  SettingsRow
}
