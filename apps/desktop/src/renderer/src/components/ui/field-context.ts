import * as React from 'react'

/**
 * A Field names its control (plan 174 S0.5, J1-1). The FieldLabel and each
 * control keep their own id (an explicit one always wins) and register it with
 * the Field once they mount. The label then points `htmlFor` at the first
 * control a label can name (an input, textarea, select trigger, switch or
 * checkbox), and a control a label element cannot point at (a ToggleGroup, a
 * TabsList, a Slider thumb) takes `aria-labelledby` from the label instead,
 * unless it names itself. Nothing points at an id that is not on the page, and
 * two controls in one Field never share an id.
 *
 * Its own module, not field.tsx: every input primitive reads it, and none of
 * them should pull the Field's styles into its chunk.
 */
type Register = (id: string) => () => void

type FieldIds = {
  /** The first registered control: FieldLabel's default `htmlFor`. */
  controlId?: string
  /** The FieldLabel: the default `aria-labelledby` of a group or a slider. */
  labelId?: string
  registerControl: Register
  registerLabel: Register
}

const FieldIdsContext = React.createContext<FieldIds | null>(null)

function useRegistry(): [string | undefined, Register] {
  const [ids, setIds] = React.useState<readonly string[]>([])
  const register = React.useCallback<Register>((id) => {
    setIds((current) => [...current, id])
    return () =>
      setIds((current) => {
        const index = current.indexOf(id)
        return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)]
      })
  }, [])
  return [ids[0], register]
}

/** The Field's side: what its label and its controls registered. */
function useFieldIds(): FieldIds {
  const [controlId, registerControl] = useRegistry()
  const [labelId, registerLabel] = useRegistry()
  return React.useMemo(
    () => ({ controlId, labelId, registerControl, registerLabel }),
    [controlId, labelId, registerControl, registerLabel]
  )
}

/** An element's id: its own, or one made for it inside a Field, registered there. */
function useRegisteredId(
  id: string | undefined,
  register: Register | undefined
): string | undefined {
  const made = React.useId()
  const resolved = id ?? (register ? made : undefined)
  React.useLayoutEffect(() => {
    if (register && resolved) return register(resolved)
    return undefined
  }, [register, resolved])
  return resolved
}

/** The id of a control a label can name, so its FieldLabel points at it. */
function useFieldControlId(id: string | undefined): string | undefined {
  return useRegisteredId(id, React.useContext(FieldIdsContext)?.registerControl)
}

/** A FieldLabel's id, and the control it names when it has no `htmlFor` of its own. */
function useFieldLabelIds(id: string | undefined): { id?: string; htmlFor?: string } {
  const field = React.useContext(FieldIdsContext)
  return { id: useRegisteredId(id, field?.registerLabel), htmlFor: field?.controlId }
}

/**
 * `aria-labelledby` for a control no label element can point at: its own, or
 * its Field's label unless it carries an `aria-label`.
 */
function useFieldLabelledBy(
  labelledBy: string | undefined,
  label: string | undefined
): string | undefined {
  const field = React.useContext(FieldIdsContext)
  return labelledBy || (label ? undefined : field?.labelId)
}

export { FieldIdsContext, useFieldControlId, useFieldIds, useFieldLabelIds, useFieldLabelledBy }
