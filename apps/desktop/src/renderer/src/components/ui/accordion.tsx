import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion'

import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      className={cn('rounded-row flex w-full flex-col overflow-hidden border', className)}
      data-slot="accordion"
      {...props}
    />
  )
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      className={cn('data-open:bg-muted/50 not-last:border-b', className)}
      data-slot="accordion-item"
      {...props}
    />
  )
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          // Colours only, in 100 ms: the row never animates its layout.
          'group/accordion-trigger **:data-[slot=accordion-trigger-icon]:text-muted-foreground focus-visible:ring-ring relative flex flex-1 items-start justify-between gap-6 border border-transparent p-4 text-left text-sm font-medium transition-colors duration-100 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset data-disabled:pointer-events-none data-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4',
          className
        )}
        data-slot="accordion-trigger"
        {...props}
      >
        {children}
        <ChevronDownIcon
          className="pointer-events-none shrink-0 group-data-panel-open/accordion-trigger:hidden"
          data-slot="accordion-trigger-icon"
        />
        <ChevronUpIcon
          className="pointer-events-none hidden shrink-0 group-data-panel-open/accordion-trigger:inline"
          data-slot="accordion-trigger-icon"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      // Base UI measures the panel into --accordion-panel-height and marks
      // the first and last frames, so the height eases in 150 ms.
      className="h-(--accordion-panel-height) overflow-hidden px-4 text-sm transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0"
      data-slot="accordion-content"
      {...props}
    >
      <div
        className={cn(
          '[&_a]:hover:text-foreground pt-0 pb-4 [&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-4',
          className
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
