import { useId, useState, type ReactElement, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDownIcon } from '@/components/icons'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'

import type { Device } from '@/lib/backend'
import {
  missingSelection,
  sourceSelectPlaceholder,
  sourceMatchesQuery
} from '@/lib/source-select-state'

const NONE_VALUE = '__none__'

export default function SearchableSourceSelect({
  label,
  devices,
  value,
  onChange,
  allowNone = false,
  placeholder,
  discoveryPending = false,
  description,
  disabled = false
}: {
  label: string
  devices: Device[]
  value?: string
  onChange: (value: string | undefined) => void
  allowNone?: boolean
  placeholder?: string
  /** Device discovery hasn't reported yet — show "Finding devices…" over "none found". */
  discoveryPending?: boolean
  description?: ReactNode
  disabled?: boolean
}): ReactElement {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Q6 (plan 022): the select must never render a blank surface. A saved id
  // with no matching device gets a synthetic disabled item (so the trigger
  // has words), and the placeholder names loading/none-found explicitly.
  const missing = missingSelection(devices, value)

  const selected = devices.find((device) => device.id === value)
  const matches = devices.filter((device) => sourceMatchesQuery(device, query))
  const close = (): void => {
    setOpen(false)
    setQuery('')
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={`${id}-popup`}
            aria-haspopup="dialog"
            disabled={disabled}
            className="w-full justify-between"
          >
            <span className="truncate">
              {selected?.name ??
                missing?.label ??
                (allowNone && !value
                  ? 'None'
                  : (placeholder ?? sourceSelectPlaceholder(devices.length, discoveryPending)))}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={`${id}-popup`}
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              autoFocus
              aria-label={`Search ${label}`}
              placeholder="Search screens and windows…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {allowNone ? (
                <CommandGroup>
                  <CommandItem
                    value={NONE_VALUE}
                    onSelect={() => {
                      onChange(undefined)
                      close()
                    }}
                  >
                    None
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {missing ? (
                <CommandGroup>
                  <CommandItem disabled value={missing.value}>
                    {missing.label}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {discoveryPending ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  Finding devices…
                </p>
              ) : null}
              {!matches.length ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  {devices.length
                    ? 'No matching screens or windows'
                    : discoveryPending
                      ? 'Waiting for discovery'
                      : sourceSelectPlaceholder(0, false)}
                </p>
              ) : null}
              {(['screen', 'window'] as const).map((kind) => {
                const group = matches.filter((device) => device.kind === kind)
                return group.length ? (
                  <CommandGroup key={kind} heading={kind === 'screen' ? 'Screens' : 'Windows'}>
                    {group.map((device) => (
                      <CommandItem
                        key={device.id}
                        value={device.id}
                        disabled={device.status !== 'available'}
                        data-checked={value === device.id}
                        onSelect={() => {
                          onChange(device.id)
                          close()
                        }}
                      >
                        <span className="min-w-0 truncate">
                          {device.name}
                          {device.detail ? ` · ${device.detail}` : ''}
                          {device.status !== 'available' ? ` (${device.status})` : ''}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}
