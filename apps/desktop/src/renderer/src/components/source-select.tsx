import { useId, lazy, Suspense, type ReactElement, type ReactNode } from 'react'

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { Device } from '@/lib/backend'
import { missingSelection, sourceSelectPlaceholder } from '@/lib/source-select-state'

const SearchableSourceSelect = lazy(() => import('./source-select-searchable'))
const NONE_VALUE = '__none__'

export function SourceSelect({
  label,
  devices,
  value,
  onChange,
  allowNone = false,
  placeholder,
  discoveryPending = false,
  description,
  disabled = false,
  searchable = false
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
  searchable?: boolean
}): ReactElement {
  const id = useId()
  // Q6 (plan 022): the select must never render a blank surface. A saved id
  // with no matching device gets a synthetic disabled item (so the trigger
  // has words), and the placeholder names loading/none-found explicitly.
  const missing = missingSelection(devices, value)

  if (searchable) {
    return (
      <Suspense
        fallback={
          <Field>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Select disabled>
              <SelectTrigger id={id} aria-label={label} className="w-full">
                <SelectValue
                  placeholder={
                    devices.find((device) => device.id === value)?.name ??
                    missing?.label ??
                    'Loading source search…'
                  }
                />
              </SelectTrigger>
            </Select>
          </Field>
        }
      >
        <SearchableSourceSelect
          label={label}
          devices={devices}
          value={value}
          onChange={onChange}
          allowNone={allowNone}
          placeholder={placeholder}
          discoveryPending={discoveryPending}
          description={description}
          disabled={disabled}
        />
      </Suspense>
    )
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        disabled={disabled}
        value={value ?? (allowNone ? NONE_VALUE : '')}
        onValueChange={(next) => onChange(next === NONE_VALUE || next === '' ? undefined : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue
            placeholder={placeholder ?? sourceSelectPlaceholder(devices.length, discoveryPending)}
          />
        </SelectTrigger>
        <SelectContent align="start" position="popper">
          <SelectGroup>
            {allowNone ? <SelectItem value={NONE_VALUE}>None</SelectItem> : null}
            {missing ? (
              <SelectItem disabled value={missing.value}>
                {missing.label}
              </SelectItem>
            ) : null}
            {devices.map((device) => (
              <SelectItem
                disabled={device.status !== 'available'}
                key={device.id}
                value={device.id}
              >
                {device.name}
                {device.status !== 'available' ? ` (${device.status})` : ''}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}
