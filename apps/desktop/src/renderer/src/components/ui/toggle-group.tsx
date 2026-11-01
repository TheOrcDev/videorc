'use client'

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import type { VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { useFieldLabelledBy } from '@/components/ui/field-context'
import { toggleVariants } from '@/components/ui/toggle'
import { cn } from '@/lib/utils'

type ToggleGroupContextValue = VariantProps<typeof toggleVariants> & {
  spacing?: number
  orientation?: 'horizontal' | 'vertical'
}

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  orientation: 'horizontal',
  size: 'default',
  spacing: 2,
  variant: 'default'
})

// Filter chips: several on at once (`multiple`), or a filter row where one is
// on. Choosing one value among 2–4 options is `SegmentedControl`.
function ToggleGroup({
  className,
  variant,
  size,
  spacing = 2,
  orientation = 'horizontal',
  children,
  'aria-labelledby': ariaLabelledBy,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: 'horizontal' | 'vertical'
  }) {
  const labelledBy = useFieldLabelledBy(ariaLabelledBy, props['aria-label'])
  const context = React.useMemo<ToggleGroupContextValue>(
    () => ({ orientation, size, spacing, variant }),
    [orientation, size, spacing, variant]
  )
  return (
    <ToggleGroupPrimitive
      aria-labelledby={labelledBy}
      className={cn(
        'group/toggle-group data-[spacing=0]:data-[variant=outline]:rounded-row flex w-fit flex-row items-center gap-[--spacing(var(--gap))] data-vertical:flex-col data-vertical:items-stretch',
        className
      )}
      data-orientation={orientation}
      data-size={size}
      data-slot="toggle-group"
      data-spacing={spacing}
      data-variant={variant}
      orientation={orientation}
      style={{ '--gap': spacing } as React.CSSProperties}
      {...props}
    >
      <ToggleGroupContext.Provider value={context}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      className={cn(
        'group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-row group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-row group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-row group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-row data-pressed:text-foreground data-pressed:chrome-plate shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 group-data-[spacing=0]/toggle-group:shadow-none focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t',
        toggleVariants({
          size: context.size || size,
          variant: context.variant || variant
        }),
        className
      )}
      data-size={context.size || size}
      data-slot="toggle-group-item"
      data-spacing={context.spacing}
      data-variant={context.variant || variant}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
