'use client'

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import type { VariantProps } from 'class-variance-authority'

import { useFieldLabelledBy } from '@/components/ui/field-context'
// oxlint-disable-next-line unicorn/prefer-export-from -- shadcn's shape: one export list at the end.
import { tabsListVariants, tabsTriggerBaseClassName } from '@/components/ui/tabs-variants'
import { cn } from '@/lib/utils'

function Tabs({ className, orientation = 'horizontal', ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      data-orientation={orientation}
      data-slot="tabs"
      orientation={orientation}
      {...props}
    />
  )
}

// Tabs switch a view (a page or a pane). Choosing a value among 2–4 options is
// `SegmentedControl`, which shares this look.
function TabsList({
  className,
  variant = 'default',
  // The arrow keys switch the view as they move, as Videorc's tabs always
  // have. Pass `false` when showing a view is heavy: then Enter or Space does.
  activateOnFocus = true,
  'aria-labelledby': ariaLabelledBy,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const labelledBy = useFieldLabelledBy(ariaLabelledBy, props['aria-label'])
  return (
    <TabsPrimitive.List
      activateOnFocus={activateOnFocus}
      aria-labelledby={labelledBy}
      className={cn(tabsListVariants({ variant }), className)}
      data-slot="tabs-list"
      data-variant={variant}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        tabsTriggerBaseClassName,
        'aria-disabled:pointer-events-none aria-disabled:opacity-50',
        // Selected: primary text, and on the track the chrome plate, so the
        // choice reads at a glance without leaning on the focus ring.
        'data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:chrome-plate',
        // The line variant underlines the selected tab instead.
        'after:bg-foreground after:absolute after:opacity-0 after:transition-opacity after:duration-100 group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:-bottom-0.5 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100',
        className
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn(
        // Base UI makes a panel a tab stop: it shows when it has focus.
        'focus-visible:ring-ring flex-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset',
        className
      )}
      data-slot="tabs-content"
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
