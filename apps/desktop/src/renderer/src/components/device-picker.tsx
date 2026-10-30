import { useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'

import { ChevronDownIcon } from '@/components/icons'
import {
  LCD_LIST_GROUP,
  LCD_LIST_ITEM,
  LCD_VALUE_BUTTON,
  LcdPanelRow,
  LcdPixelChevron,
  LcdPopupScreen
} from '@/components/lcd-panel'
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
// changes the closed look, for a row whose label sits beside it, and
// `trigger="lcd"` draws the row and its list on an LCD screen (the Studio,
// plan 197).

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
  /**
   * `field`: a labelled form control. `inline`: a row's value, right-aligned.
   * `lcd`: a row on an LCD screen (plan 197), its own dim label and the value
   * lit, opening its list as a small screen. It goes inside an `LcdPanel`.
   */
  trigger?: 'field' | 'inline' | 'lcd'
  /**
   * The LCD row's visible label when the row is too narrow for `label`
   * ("Mic"). Part of `label`, which stays the accessible name.
   */
  rowLabel?: string
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
  rowLabel,
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
  const lcd = trigger === 'lcd'
  const selection = { kind, devices, value, selectedName, selectedDevice, discoveryPending }
  const view = devicePickerTriggerView({ ...selection, noneLabel, selectionLabel })

  const setOpenState = (next: boolean): void => {
    setOpen(next)
    if (!next) setQuery('')
  }

  const picker = (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger
        render={
          <button
            aria-controls={`${id}-popup`}
            aria-expanded={open}
            aria-haspopup={searchable ? 'dialog' : 'listbox'}
            aria-label={label}
            className={
              lcd
                ? cn(
                    LCD_VALUE_BUTTON,
                    'data-popup-open:bg-(--lcd-display-ink-unlit)',
                    view.placeholder && 'text-(--lcd-display-ink-dim)'
                  )
                : cn(
                    selectTriggerClassName,
                    'w-full min-w-0',
                    inline &&
                      'justify-end border-transparent bg-transparent px-2 font-medium hover:bg-accent data-popup-open:bg-accent'
                  )
            }
            data-placeholder={view.placeholder ? '' : undefined}
            data-size="default"
            data-slot="device-picker-trigger"
            disabled={disabled}
            id={id}
            role="combobox"
            type="button"
          />
        }
      >
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            inline || lcd ? 'justify-end' : 'flex-1'
          )}
        >
          {/* A long name truncates in a narrow row: the title on the cut
                text itself reveals it (plan 174 S1.10, truncation only). */}
          <span className="min-w-0 truncate" title={inline || lcd ? view.label : undefined}>
            {view.label}
          </span>
          {statusInTrigger && view.status ? (
            <span
              className={
                lcd
                  ? 'shrink-0 text-(--lcd-display-ink-dim)'
                  : 'shrink-0 text-xs font-normal text-muted-foreground'
              }
            >
              {view.status}
            </span>
          ) : null}
        </span>
        {lcd ? (
          <LcdPixelChevron />
        ) : (
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        )}
      </PopoverTrigger>
      <DevicePickerList
        align={inline || lcd ? 'end' : 'start'}
        className={inline || lcd ? 'w-72' : 'w-(--anchor-width) min-w-56'}
        groups={devicePickerGroups({ ...selection, noneLabel, groupByKind, query })}
        id={`${id}-popup`}
        label={label}
        lcd={lcd}
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
  if (lcd) {
    return (
      <LcdPanelRow htmlFor={id} label={rowLabel ?? label}>
        {picker}
      </LcdPanelRow>
    )
  }
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
  lcd,
  listRef,
  onQueryChange,
  onSelect
}: {
  id: string
  label: string
  align: 'start' | 'end'
  className: string
  /** Draw the list as a small LCD screen inside the popup (plan 197). */
  lcd: boolean
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
  const command = (
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
          <CommandGroup
            className={lcd ? LCD_LIST_GROUP : 'p-1'}
            heading={group.heading}
            key={group.heading ?? index}
          >
            {group.items.map((item) => (
              <CommandItem
                className={lcd ? LCD_LIST_ITEM : 'min-h-7 gap-2 rounded-row py-1 pr-2 pl-2'}
                data-checked={item.selected}
                disabled={item.disabled}
                key={item.value}
                value={item.value}
                onSelect={() => onSelect(item.value)}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.status ? (
                  <span className={cn('shrink-0', !lcd && 'text-xs text-muted-foreground')}>
                    {item.status}
                  </span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {status ? (
        <p
          className={
            lcd
              ? 'px-2 py-2 text-(--lcd-display-ink-dim)'
              : 'px-3 py-2 text-sm text-muted-foreground'
          }
          role="status"
        >
          {status}
        </p>
      ) : null}
    </Command>
  )
  return (
    <PopoverContent
      align={align}
      className={cn('gap-0', lcd ? 'p-1' : 'p-0', className)}
      id={id}
      // Without a search field the list takes focus: its keys move the
      // highlight and it names the highlighted row (aria-activedescendant).
      initialFocus={searchPlaceholder === null ? listRef : true}
    >
      {lcd ? <LcdPopupScreen>{command}</LcdPopupScreen> : command}
    </PopoverContent>
  )
}
