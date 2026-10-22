import * as React from 'react'
import { type VariantProps } from 'class-variance-authority'
import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { useFieldLabelledBy } from '@/components/ui/field-context'
import { tabsListVariants, tabsTriggerBaseClassName } from '@/components/ui/tabs-variants'

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      {...props}
    />
  )
}

// Tabs switch a view (a page or a pane). Choosing a value among 2–4 options is
// `SegmentedControl`, which shares this look (plan 174 S1.7, D13).
function TabsList({
  className,
  variant = 'default',
  'aria-labelledby': ariaLabelledBy,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  const labelledBy = useFieldLabelledBy(ariaLabelledBy, props['aria-label'])
  return (
    <TabsPrimitive.List
      aria-labelledby={labelledBy}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        tabsTriggerBaseClassName,
        // Selected = a raised glass chip with primary text, keyed off Radix's
        // data-state="active" (#392: a data-active variant never matches), so
        // the choice reads at a glance without leaning on the focus ring.
        'data-[state=active]:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:glass-chip',
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        // Radix makes a panel a tab stop: it shows when it has focus (J1-9).
        'flex-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
