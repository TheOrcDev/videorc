import { useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'

import { ChevronDownIcon } from '@/components/icons'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { selectTriggerClassName } from '@/components/ui/select'
import type { Device, SessionSourceKind } from '@/lib/backend'
import {
  DEVICE_PICKER_NONE_VALUE,
  devicePickerCopy,
  devicePickerGroups,
  devicePickerListStatus,
  devicePickerTriggerView,
  sourceMatchesQuery
} from '@/lib/source-select-state'
import { cn } from '@/lib/utils'

// Plan 174 S1.9: the one device picker. Screen, camera and microphone pick
// through the same popover list everywhere (Studio Inputs, the Studio
// Microphone section, Sources, scene repair): one row per device at the menu
// item height, a muted status after a device that cannot run, one status line
// while discovery runs or when nothing is found, and the same "no device"
// words. `searchable` only adds the search field; `trigger="inline"` only
// changes the closed look, for a row whose label sits beside it.

export interface DevicePickerProps {
  /** Which source it picks: decides the words ("Finding cameras…"). */
  kind: SessionSourceKind
  /** The accessible name, and the visible label of a field trigger. */
  label: string
  devices: Device[]
  value: string | undefined
  /** The saved name, for a selected device the list does not hold. */
  selectedName?: string
  /** The selected device when found outside `devices` (a source the list hides). */
  selectedDevice?: Device
  onChange: (value: string | undefined) => void
  /** The "no device" item's words ("Off" for a camera or microphone). None when unset. */
  noneLabel?: string
  /** A selection that is not a device, shown in place of the device (the test pattern). */
  selectionLabel?: string
  /** Device discovery has not reported yet. */
  discoveryPending?: boolean
  /** Adds a search field above the list. */
  searchable?: boolean
  /** Screens and windows under their own headings. */
  groupByKind?: boolean
  /** `field`: a labelled form control. `inline`: a row's value, right-aligned. */
  trigger?: 'field' | 'inline'
  /** A status line under a field trigger (the live switch status). */
  description?: ReactNode
  /**
   * Say the selected device's status ("Not found") after its name. Off where
   * the row's own status chip already says it (Sources).
   */
  statusInTrigger?: boolean
  disabled?: boolean
  /** Keep a field trigger's label for screen readers only. */
  labelHidden?: boolean
}

export function DevicePicker({
  kind,
  label,
  devices,
  value,
  selectedName,
  selectedDevice,
  onChange,
  noneLabel,
  selectionLabel,
  discoveryPending = false,
  searchable = false,
  groupByKind = false,
  trigger = 'field',
  description,
  statusInTrigger = true,
  disabled = false,
  labelHidden = false
}: DevicePickerProps): ReactElement {
  const id = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inline = trigger === 'inline'
  const selection = { kind, devices, value, selectedName, selectedDevice, discoveryPending }
  const view = devicePickerTriggerView({ ...selection, noneLabel, selectionLabel })

  const setOpenState = (next: boolean): void => {
    setOpen(next)
    if (!next) setQuery('')
  }

  const picker = (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger asChild>
        <button
          aria-controls={`${id}-popup`}
          aria-expanded={open}
          aria-haspopup={searchable ? 'dialog' : 'listbox'}
          aria-label={label}
          className={cn(
            selectTriggerClassName,
            'w-full min-w-0',
            inline &&
              'justify-end border-transparent bg-transparent px-2 font-medium hover:bg-accent data-[state=open]:bg-accent'
          )}
          data-placeholder={view.placeholder ? '' : undefined}
          data-size="default"
          data-slot="device-picker-trigger"
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
        >
          <span
            className={cn('flex min-w-0 items-center gap-1.5', inline ? 'justify-end' : 'flex-1')}
          >
            {/* A long name truncates in a narrow row: the title on the cut
                text itself reveals it (plan 174 S1.10, truncation only). */}
            <span className="min-w-0 truncate" title={inline ? view.label : undefined}>
              {view.label}
            </span>
            {statusInTrigger && view.status ? (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {view.status}
              </span>
            ) : null}
          </span>
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <DevicePickerList
        align={inline ? 'end' : 'start'}
        className={inline ? 'w-72' : 'w-(--radix-popover-trigger-width) min-w-56'}
        groups={devicePickerGroups({ ...selection, noneLabel, groupByKind, query })}
        id={`${id}-popup`}
        label={label}
        listRef={listRef}
        query={query}
        searchPlaceholder={searchable ? devicePickerCopy(kind).search : null}
        status={devicePickerListStatus({
          kind,
          deviceCount: devices.length,
          matchCount: devices.filter((device) => sourceMatchesQuery(device, query)).length,
          discoveryPending
        })}
        onQueryChange={setQuery}
        onSelect={(next) => {
          onChange(next === DEVICE_PICKER_NONE_VALUE ? undefined : next)
          setOpenState(false)
        }}
      />
    </Popover>
  )

  if (inline) return picker
  return (
    <Field>
      <FieldLabel className={labelHidden ? 'sr-only' : undefined} htmlFor={id}>
        {label}
      </FieldLabel>
      {picker}
      {/* Kept in the accessibility tree while empty, so the switch status is
          announced when it arrives; it takes no space until then. */}
      {description ? (
        <FieldDescription aria-live="polite" className="empty:sr-only">
          {description}
        </FieldDescription>
      ) : null}
    </Field>
  )
}

function DevicePickerList({
  id,
  label,
  align,
  className,
  groups,
  status,
  query,
  searchPlaceholder,
  listRef,
  onQueryChange,
  onSelect
}: {
  id: string
  label: string
  align: 'start' | 'end'
  className: string
  groups: ReturnType<typeof devicePickerGroups>
  status: string | null
  query: string
  /** The search field's placeholder, or null for no search field. */
  searchPlaceholder: string | null
  listRef: RefObject<HTMLDivElement | null>
  onQueryChange: (query: string) => void
  onSelect: (value: string) => void
}): ReactElement {
  // The highlight starts on the current choice, as a select's does.
  const current = groups
    .flatMap((group) => group.items)
    .find((item) => item.selected && !item.disabled)?.value
  return (
    <PopoverContent
      align={align}
      className={cn('gap-0 p-0', className)}
      id={id}
      onOpenAutoFocus={(event) => {
        // Without a search field the list takes focus: its keys move the
        // highlight and it names the highlighted row (aria-activedescendant).
        if (searchPlaceholder !== null) return
        event.preventDefault()
        listRef.current?.focus()
      }}
    >
      <Command defaultValue={current} shouldFilter={false}>
        {searchPlaceholder !== null ? (
          <CommandInput
            aria-label={`Search ${label}`}
            autoFocus
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={onQueryChange}
          />
        ) : null}
        <CommandList label={label} ref={listRef}>
          {groups.map((group, index) => (
            <CommandGroup className="p-1" heading={group.heading} key={group.heading ?? index}>
              {group.items.map((item) => (
                <CommandItem
                  className="min-h-7 gap-2 rounded-md py-1 pr-2 pl-2"
                  data-checked={item.selected}
                  disabled={item.disabled}
                  key={item.value}
                  value={item.value}
                  onSelect={() => onSelect(item.value)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.status ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{item.status}</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        {status ? (
          <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
            {status}
          </p>
        ) : null}
      </Command>
    </PopoverContent>
  )
}
