'use client'

import { useId, useRef, useState } from 'react'
import type { ReactElement, ReactNode, RefObject } from 'react'

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
import {
  DEVICE_PICKER_NONE_VALUE,
  devicePickerCopy,
  devicePickerGroups,
  devicePickerListStatus,
  devicePickerTriggerView,
  sourceMatchesQuery
} from '@/lib/source-select-state'
import type {
  DevicePickerGroup,
  DevicePickerKind,
  DevicePickerTriggerView,
  PickerDevice
} from '@/lib/source-select-state'
import { cn } from '@/lib/utils'

// The one device picker. Screens, windows, cameras and microphones are chosen
// through the same popover list everywhere: one row per device at the menu
// item height, a muted status after a device that can't run, one status line
// while discovery runs or when nothing is found, and the same "no device"
// words. `searchable` only adds the search field; `trigger="inline"` only
// changes the closed look, for a row whose label sits beside it.

interface DevicePickerProps {
  /** Which source it chooses: decides the words ("Finding cameras…"). */
  kind: DevicePickerKind
  /** The accessible name, and the visible label of a field trigger. */
  label: string
  devices: readonly PickerDevice[]
  value: string | undefined
  /** The saved name, for a selected device the list doesn't hold. */
  selectedName?: string
  /** The selected device when found outside `devices` (a source the list hides). */
  selectedDevice?: PickerDevice
  /** The chosen device id, or undefined for the "no device" item. */
  onChange: (value: string | undefined) => void
  /** The "no device" item's words ("Off" for a camera or microphone). None when unset. */
  noneLabel?: string
  /** A selection that isn't a device, shown in place of one (the test pattern). */
  selectionLabel?: string
  /** Device discovery hasn't reported yet. */
  discoveryPending?: boolean
  /** Adds a search field above the list. */
  searchable?: boolean
  /** Screens and windows under their own headings. */
  groupByKind?: boolean
  /** `field`: a labelled form control. `inline`: a row's value, right-aligned. */
  trigger?: 'field' | 'inline'
  /** A status line under a field trigger (a live switch's progress). */
  description?: ReactNode
  /**
   * Says the selected device's status ("Not found") after its name. Turn it
   * off where the row's own status chip already says it.
   */
  statusInTrigger?: boolean
  disabled?: boolean
  /** Keeps a field trigger's label for screen readers only. */
  labelHidden?: boolean
}

// The list is the popover's whole body, edge to edge, as in shadcn's
// combobox: no inset and no gap around the Command. A field's list is as wide
// as its trigger; an inline one has its own width.
// oxlint-disable-next-line shadcn/no-restyle -- see above.
const FIELD_POPUP = 'w-(--anchor-width) min-w-56 gap-0 p-0'
// oxlint-disable-next-line shadcn/no-restyle -- see above.
const INLINE_POPUP = 'w-72 gap-0 p-0'

// The closed picker looks exactly like a select's trigger, so it reads
// selectTriggerClassName; inline, it is a row's right-aligned value with the
// hover block.
// oxlint-disable-next-line shadcn/require-static-classes -- see above.
const FIELD_TRIGGER = cn(selectTriggerClassName, 'w-full min-w-0')
// oxlint-disable-next-line shadcn/require-static-classes -- see above.
const INLINE_TRIGGER = cn(
  // oxlint-disable-next-line shadcn/require-static-classes -- see above.
  selectTriggerClassName,
  // oxlint-disable-next-line shadcn/no-restyle -- see above.
  'hover:bg-accent data-popup-open:bg-accent w-full min-w-0 justify-end border-transparent bg-transparent px-2 font-medium'
)

interface DevicePickerTriggerProps {
  id: string
  popupId: string
  open: boolean
  label: string
  inline: boolean
  searchable: boolean
  disabled: boolean
  describedBy?: string
  view: DevicePickerTriggerView
  statusInTrigger: boolean
}

function DevicePickerTrigger({
  id,
  popupId,
  open,
  label,
  inline,
  searchable,
  disabled,
  describedBy,
  view,
  statusInTrigger
}: DevicePickerTriggerProps): ReactElement {
  return (
    <PopoverTrigger
      disabled={disabled}
      id={id}
      render={
        <button
          aria-controls={open ? popupId : undefined}
          aria-describedby={describedBy}
          aria-expanded={open}
          aria-haspopup={searchable ? 'dialog' : 'listbox'}
          aria-label={label}
          className={inline ? INLINE_TRIGGER : FIELD_TRIGGER}
          data-placeholder={view.placeholder ? '' : undefined}
          data-size="default"
          data-slot="device-picker-trigger"
          role="combobox"
          type="button"
        />
      }
    >
      <span
        className={
          inline
            ? 'flex min-w-0 items-center justify-end gap-1.5'
            : 'flex min-w-0 flex-1 items-center gap-1.5'
        }
      >
        {/* A long name truncates in a narrow row: the title on the cut text
            itself reveals it. */}
        <span className="min-w-0 truncate" title={inline ? view.label : undefined}>
          {view.label}
        </span>
        {statusInTrigger && view.status ? (
          <span className="text-muted-foreground shrink-0 text-xs font-normal">{view.status}</span>
        ) : null}
      </span>
      <ChevronDownIcon aria-hidden className="text-muted-foreground pointer-events-none size-4" />
    </PopoverTrigger>
  )
}

interface DevicePickerListProps {
  id: string
  label: string
  inline: boolean
  groups: DevicePickerGroup[]
  status: string | null
  query: string
  /** The search field's placeholder, or null for no search field. */
  searchPlaceholder: string | null
  listRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
  onSelect: (value: string) => void
}

function DevicePickerList({
  id,
  label,
  inline,
  groups,
  status,
  query,
  searchPlaceholder,
  listRef,
  inputRef,
  onQueryChange,
  onSelect
}: DevicePickerListProps): ReactElement {
  // The highlight starts on the current choice, as a select's does.
  const current = groups
    .flatMap((group) => group.items)
    .find((item) => item.selected && !item.disabled)?.value
  return (
    <PopoverContent
      align={inline ? 'end' : 'start'}
      className={inline ? INLINE_POPUP : FIELD_POPUP}
      id={id}
      // With a search field, the field takes focus. Without one the list
      // does: its keys move the highlight, and it names the highlighted row
      // (aria-activedescendant).
      initialFocus={searchPlaceholder === null ? listRef : inputRef}
    >
      <Command defaultValue={current} shouldFilter={false}>
        {searchPlaceholder === null ? null : (
          <CommandInput
            aria-label={`Search ${label}`}
            onValueChange={onQueryChange}
            placeholder={searchPlaceholder}
            ref={inputRef}
            value={query}
          />
        )}
        <CommandList label={label} ref={listRef}>
          {groups.map((group, index) => (
            <CommandGroup
              // Menu scale, not the palette's: a 4 px inset and 28 px rows.
              // oxlint-disable-next-line shadcn/no-restyle -- see above.
              className="p-1"
              heading={group.heading}
              key={group.heading ?? group.items[0]?.value ?? index}
            >
              {group.items.map((item) => (
                <CommandItem
                  // oxlint-disable-next-line shadcn/no-restyle -- Menu scale, as above.
                  className="min-h-7 gap-2 px-2 py-1"
                  data-checked={item.selected}
                  disabled={item.disabled}
                  key={item.value}
                  onSelect={() => onSelect(item.value)}
                  value={item.value}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.status ? (
                    <span className="text-muted-foreground shrink-0 text-xs">{item.status}</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        {status ? (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- An output element would not announce politely in every reader.
          <p className="text-muted-foreground px-3 py-2 text-sm" role="status">
            {status}
          </p>
        ) : null}
      </Command>
    </PopoverContent>
  )
}

/**
 * Chooses a screen, window, camera or microphone from a popover list, with
 * words for every state: discovery running, nothing found, a saved device
 * that's gone, a device that needs permission.
 */
function DevicePicker({
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
  const descriptionId = `${id}-description`
  const popupId = `${id}-popup`
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inline = trigger === 'inline'
  const selection = {
    devices,
    discoveryPending,
    kind,
    selectedDevice,
    selectedName,
    value
  }
  const view = devicePickerTriggerView({
    ...selection,
    noneLabel,
    selectionLabel
  })

  const setOpenState = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setQuery('')
    }
  }

  const picker = (
    <Popover onOpenChange={setOpenState} open={open}>
      <DevicePickerTrigger
        describedBy={description && !inline ? descriptionId : undefined}
        disabled={disabled}
        id={id}
        inline={inline}
        label={label}
        open={open}
        popupId={popupId}
        searchable={searchable}
        statusInTrigger={statusInTrigger}
        view={view}
      />
      <DevicePickerList
        groups={devicePickerGroups({
          ...selection,
          groupByKind,
          noneLabel,
          query
        })}
        id={popupId}
        inline={inline}
        inputRef={inputRef}
        label={label}
        listRef={listRef}
        onQueryChange={setQuery}
        onSelect={(next) => {
          onChange(next === DEVICE_PICKER_NONE_VALUE ? undefined : next)
          setOpenState(false)
        }}
        query={query}
        searchPlaceholder={searchable ? devicePickerCopy(kind).search : null}
        status={devicePickerListStatus({
          deviceCount: devices.length,
          discoveryPending,
          kind,
          matchCount: devices.filter((device) => sourceMatchesQuery(device, query)).length
        })}
      />
    </Popover>
  )

  if (inline) {
    return picker
  }
  return (
    <Field>
      <FieldLabel className={labelHidden ? 'sr-only' : undefined} htmlFor={id}>
        {label}
      </FieldLabel>
      {picker}
      {/* Kept in the accessibility tree while empty, so the status is
          announced when it arrives; it takes no space until then. */}
      {description ? (
        <FieldDescription aria-live="polite" className="empty:sr-only" id={descriptionId}>
          {description}
        </FieldDescription>
      ) : null}
    </Field>
  )
}

export { DevicePicker }
export type { DevicePickerProps }
export type { DevicePickerKind, PickerDevice, PickerDeviceStatus } from '@/lib/source-select-state'
