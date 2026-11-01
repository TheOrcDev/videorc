import { useId, useRef, useState, type ReactElement } from 'react'

import {
  LCD_LIST_GROUP,
  LCD_LIST_ITEM,
  LCD_VALUE_BUTTON,
  LcdPanelRow,
  LcdPixelChevron,
  LcdPopupScreen
} from '@/components/lcd-panel'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DEVICE_PICKER_NONE_VALUE,
  devicePickerGroups,
  devicePickerListStatus,
  devicePickerTriggerView,
  type DevicePickerKind,
  type PickerDevice
} from '@/lib/source-select-state'
import { cn } from '@/lib/utils'

// The Retro LCD Studio's device dropdown (plan 197): the one device picker's
// words and list (lib/source-select-state, as @videorc's DevicePicker says
// them), drawn as a row on an LCD screen. Its own dim label and the value lit,
// and its list a small screen in the opaque popup. It goes inside an
// `LcdPanel`. Retro LCD is Videorc's alone, so this stays out of the registry.

export interface LcdDevicePickerProps {
  /** Which source it picks: decides the words ("Finding cameras…"). */
  kind: DevicePickerKind
  /** The accessible name, and the row's label unless `rowLabel` replaces it. */
  label: string
  devices: readonly PickerDevice[]
  value: string | undefined
  /** The saved name, for a selected device the list does not hold. */
  selectedName?: string
  /** The selected device when found outside `devices` (a source the list hides). */
  selectedDevice?: PickerDevice
  onChange: (value: string | undefined) => void
  /** The "no device" item's words ("Off" for a camera or microphone). None when unset. */
  noneLabel?: string
  /** A selection that is not a device, shown in place of the device (the test pattern). */
  selectionLabel?: string
  /** Device discovery has not reported yet. */
  discoveryPending?: boolean
  /** Screens and windows under their own headings. */
  groupByKind?: boolean
  /**
   * The row's visible label when the row is too narrow for `label` ("Mic").
   * Part of `label`, which stays the accessible name.
   */
  rowLabel?: string
  disabled?: boolean
}

export function LcdDevicePicker({
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
  groupByKind = false,
  rowLabel,
  disabled = false
}: LcdDevicePickerProps): ReactElement {
  const id = useId()
  const popupId = `${id}-popup`
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selection = { kind, devices, value, selectedName, selectedDevice, discoveryPending }
  const view = devicePickerTriggerView({ ...selection, noneLabel, selectionLabel })
  const groups = devicePickerGroups({ ...selection, noneLabel, groupByKind })
  const status = devicePickerListStatus({
    kind,
    deviceCount: devices.length,
    matchCount: devices.length,
    discoveryPending
  })
  // The highlight starts on the current choice, as a select's does.
  const current = groups
    .flatMap((group) => group.items)
    .find((item) => item.selected && !item.disabled)?.value

  return (
    <LcdPanelRow htmlFor={id} label={rowLabel ?? label}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={disabled}
          id={id}
          render={
            <button
              aria-controls={open ? popupId : undefined}
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-label={label}
              className={cn(
                LCD_VALUE_BUTTON,
                'data-popup-open:bg-(--lcd-display-ink-unlit)',
                view.placeholder && 'text-(--lcd-display-ink-dim)'
              )}
              data-placeholder={view.placeholder ? '' : undefined}
              data-slot="device-picker-trigger"
              role="combobox"
              type="button"
            />
          }
        >
          <span className="flex min-w-0 items-center justify-end gap-1.5">
            {/* A long name truncates in a narrow row: the title on the cut
                text itself reveals it (plan 174 S1.10, truncation only). */}
            <span className="min-w-0 truncate" title={view.label}>
              {view.label}
            </span>
            {view.status ? (
              <span className="shrink-0 text-(--lcd-display-ink-dim)">{view.status}</span>
            ) : null}
          </span>
          <LcdPixelChevron />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 gap-0 p-1"
          id={popupId}
          // The list takes focus: its keys move the highlight and it names
          // the highlighted row (aria-activedescendant).
          initialFocus={listRef}
        >
          <LcdPopupScreen>
            <Command defaultValue={current} shouldFilter={false}>
              <CommandList label={label} ref={listRef}>
                {groups.map((group, index) => (
                  <CommandGroup
                    className={LCD_LIST_GROUP}
                    heading={group.heading}
                    key={group.heading ?? group.items[0]?.value ?? index}
                  >
                    {group.items.map((item) => (
                      <CommandItem
                        className={LCD_LIST_ITEM}
                        data-checked={item.selected}
                        disabled={item.disabled}
                        key={item.value}
                        value={item.value}
                        onSelect={() => {
                          onChange(item.value === DEVICE_PICKER_NONE_VALUE ? undefined : item.value)
                          setOpen(false)
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.status ? <span className="shrink-0">{item.status}</span> : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
              {status ? (
                <p className="px-2 py-2 text-(--lcd-display-ink-dim)" role="status">
                  {status}
                </p>
              ) : null}
            </Command>
          </LcdPopupScreen>
        </PopoverContent>
      </Popover>
    </LcdPanelRow>
  )
}
