import { createContext, type ComponentProps, type ReactElement, type ReactNode } from 'react'

import {
  LcdDisplay,
  LcdDisplayRow,
  LcdDisplaySeparator,
  LcdDisplayValue
} from '@/components/ui/lcd-display'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Plan 197: the Studio on audiocn's LCD screens (owner 2026-10-25: "make the
// entire studio in this style"). Each inspector section is one screen built
// from these parts. Labels are dim and values lit, as on the screen; the words
// stay sentence case in the DOM (the smokes read them) and the screen prints
// them in capitals. Device dropdowns are `DevicePicker trigger="lcd"`, which
// draws its value and its list with the classes below.

/**
 * How the Studio inspector draws (plan 197): `default` is the inspector's
 * rows and buttons; `lcd` is the Retro LCD option (Settings → General), every
 * section on a screen.
 */
export type StudioLook = 'default' | 'lcd'

/**
 * The look for parts deep inside a page, like the Sources meters: `default`
 * unless the page provides `lcd` with Retro LCD on.
 */
export const StudioLookContext = createContext<StudioLook>('default')

/**
 * The screen on Videorc's glass (plan 196, #813). The bezel is a glass chip in
 * both themes (the chip tokens: fill, rim, top highlight, drop). In dark the
 * screen lets the window glass through instead of an opaque black well, with
 * a softer recess and fainter scanlines. Each base variable is set again under
 * `dark:` so it replaces the screen's own dark value.
 */
export const LCD_ON_GLASS = [
  '[--lcd-display-bezel:var(--chip-fill-top)] dark:[--lcd-display-bezel:var(--chip-fill-top)]',
  '[--lcd-display-bezel-edge:var(--chip-fill-bottom)] dark:[--lcd-display-bezel-edge:var(--chip-fill-bottom)]',
  '[--lcd-display-bezel-ring:var(--chip-rim)] dark:[--lcd-display-bezel-ring:var(--chip-rim)]',
  '[--lcd-display-bezel-shadow:inset_0_1px_0_var(--chip-highlight),0_1px_2px_var(--chip-drop)] dark:[--lcd-display-bezel-shadow:inset_0_1px_0_var(--chip-highlight),0_1px_2px_var(--chip-drop)]',
  'dark:[--lcd-display-glass:color-mix(in_oklab,var(--glass-solid)_35%,transparent)]',
  'dark:[--lcd-display-recess:inset_0_1px_3px_var(--chip-drop),inset_0_0_0_1px_var(--chip-drop)]',
  'dark:[--lcd-display-scanline:color-mix(in_oklab,var(--chip-drop)_30%,transparent)]'
].join(' ')

/**
 * A section's screen is tighter than the docs' demo, so a row sits near the
 * 28 px desktop row, and its letters a little closer, so a device's name fits
 * the inspector's 20rem before it truncates.
 */
const PANEL_CONTENT =
  'tracking-[0.08em] [&_[data-slot=lcd-display-content]]:px-3 [&_[data-slot=lcd-display-content]]:py-1'

/**
 * One inspector section's screen: audiocn's `LcdDisplay` at the small size,
 * on the app's glass. Rows go inside; a separator between them is
 * `LcdDisplaySeparator`.
 */
export function LcdPanel({ className, ...props }: ComponentProps<typeof LcdDisplay>): ReactElement {
  return <LcdDisplay className={cn(LCD_ON_GLASS, PANEL_CONTENT, className)} size="sm" {...props} />
}

/**
 * A screen's title row (owner 2026-10-25: the sans-serif section headers
 * clashed with the screens): the section's heading lit, its one action on the
 * right, then a dotted rule. The heading keeps the page outline (an h2 under
 * the toolbar's h1, or h3 when nested).
 */
export function LcdPanelHeader({
  title,
  action,
  headingLevel = 2
}: {
  title: string
  action?: ReactNode
  headingLevel?: 2 | 3
}): ReactElement {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <>
      <div
        className="flex min-h-8 min-w-0 items-center justify-between gap-4 py-1.5"
        data-slot="lcd-panel-header"
      >
        <Heading className="min-w-0 truncate font-normal text-(--lcd-display-lit)">{title}</Heading>
        {action ? <div className="flex shrink-0 items-center gap-3">{action}</div> : null}
      </div>
      <LcdDisplaySeparator />
    </>
  )
}

/** A header's way to the page that owns the section ("Open Sources"): dim words that light on hover. */
export function LcdPanelAction({
  children,
  onClick
}: {
  children: ReactNode
  onClick: () => void
}): ReactElement {
  return (
    <button
      className={cn(
        LCD_VALUE_BUTTON,
        'text-(--lcd-display-ink-dim) hover:text-(--lcd-display-lit)'
      )}
      type="button"
      onClick={onClick}
    >
      <span className="truncate">{children}</span>
      <LcdPixelChevron direction="right" />
    </button>
  )
}

/**
 * Words on the screen that are a sentence rather than a value (why a start is
 * blocked, a switch in progress, what a click does): dim, in sentence case
 * with plain spacing so a long line stays readable, and wrapping.
 */
export const LCD_MESSAGE =
  'py-1.5 normal-case leading-snug tracking-normal text-(--lcd-display-ink-dim)'

/**
 * A key's colours: the ink, or the record red, for its outline, its words and
 * its inverted fill. The outline is a border: `ring-inset` would also set the
 * ring to Videorc's `inset` colour token, which outranks the tone.
 */
const KEY_TONE = {
  ink: 'border-(--lcd-display-lit) text-(--lcd-display-lit) hover:bg-(--lcd-display-lit) focus-visible:bg-(--lcd-display-lit)',
  record: 'border-(--live) text-(--live) hover:bg-(--live) focus-visible:bg-(--live)'
} as const

/**
 * A key on the transport's screen (Record, Go Live, Stop): an outlined cell in
 * the ink, or in the record red, that inverts on hover and keyboard focus. Its
 * inverted words are the opaque solid, so they read on the lit fill. Keys sit
 * side by side and wrap under each other in a narrow inspector.
 */
export function LcdPanelKey({
  tone = 'ink',
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & { tone?: keyof typeof KEY_TONE }): ReactElement {
  return (
    <button
      className={cn(
        'inline-flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-chip border-2 px-2 text-[0.85em] tracking-[0.04em] whitespace-nowrap uppercase outline-none hover:text-(--glass-solid) focus-visible:text-(--glass-solid) disabled:pointer-events-none disabled:border-(--lcd-display-ink-dim) disabled:text-(--lcd-display-ink-dim) [&_svg]:size-3.5 [&_svg]:shrink-0',
        KEY_TONE[tone],
        className
      )}
      type={type}
      {...props}
    />
  )
}

/** The dim name at the start of a row: a real label when it names a control. */
export function LcdPanelLabel({
  htmlFor,
  className,
  children
}: {
  htmlFor?: string
  className?: string
  children: ReactNode
}): ReactElement {
  const labelClassName = cn('shrink-0 text-(--lcd-display-ink-dim)', className)
  return htmlFor ? (
    <label className={labelClassName} htmlFor={htmlFor}>
      {children}
    </label>
  ) : (
    <span className={labelClassName}>{children}</span>
  )
}

/** A row: the dim label on the left, its value or control on the right. */
export function LcdPanelRow({
  label,
  htmlFor,
  className,
  children
}: {
  label: ReactNode
  /** The control the label names. */
  htmlFor?: string
  className?: string
  children?: ReactNode
}): ReactElement {
  return (
    <LcdDisplayRow className={cn('min-w-0 gap-4 py-2', className)}>
      <LcdPanelLabel htmlFor={htmlFor}>{label}</LcdPanelLabel>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
    </LcdDisplayRow>
  )
}

/**
 * The shared Gain faders on a screen (plan 201, D5), skinned from a wrapper
 * so the vendored audiocn fader stays as shipped: the track in the dim ink,
 * the range and the knob lit, the Gain label dim and its readout lit.
 */
export const LCD_FADER = [
  '[&_[data-slot=fader-track]]:bg-(--lcd-display-ink-dim)',
  '[&_[data-slot=fader-range]]:bg-(--lcd-display-lit) [&_[data-slot=fader-range]]:bg-none [&_[data-slot=fader-range]]:shadow-none',
  '[&_[data-slot=fader-thumb]]:bg-(--lcd-display-lit) [&_[data-slot=fader-thumb]]:bg-none [&_[data-slot=fader-thumb]]:shadow-none [&_[data-slot=fader-thumb]]:ring-(--lcd-display-glow)',
  '[&_[data-slot=source-control-row]>span:first-child]:w-auto [&_[data-slot=source-control-row]>span:first-child]:text-(--lcd-display-ink-dim)',
  '[&_[data-slot=source-control-value]]:text-(--lcd-display-lit) [&_[data-slot=source-control-value]_button]:text-(--lcd-display-lit) [&_[data-slot=source-control-value]_button:hover]:bg-(--lcd-display-ink-unlit)'
].join(' ')

/** A `StatusDot` on the screen: its words lit at the screen's size; the dot keeps its tone. */
export const LCD_STATUS_DOT = 'text-[1em] text-(--lcd-display-lit)'

/** A lit value that truncates to its row, with the screen's redraw flicker. */
export function LcdPanelValue({
  className,
  ...props
}: ComponentProps<typeof LcdDisplayValue>): ReactElement {
  return <LcdDisplayValue className={cn('min-w-0 truncate', className)} {...props} />
}

/** A pixel chevron, like the screen's own select: down opens a list, right goes to a page. */
export function LcdPixelChevron({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  return direction === 'down' ? (
    <svg
      aria-hidden
      className="h-1.5 w-2.5 shrink-0"
      fill="currentColor"
      shapeRendering="crispEdges"
      viewBox="0 0 5 3"
    >
      <path d="M0 0h1v1H0zM4 0h1v1H4zM1 1h1v1H1zM3 1h1v1H3zM2 2h1v1H2z" />
    </svg>
  ) : (
    <svg
      aria-hidden
      className="h-2.5 w-1.5 shrink-0"
      fill="currentColor"
      shapeRendering="crispEdges"
      viewBox="0 0 3 5"
    >
      <path d="M0 0h1v1H0zM0 4h1v1H0zM1 1h1v1H1zM1 3h1v1H1zM2 2h1v1H2z" />
    </svg>
  )
}

/**
 * A whole row that is one button: hover lights the unlit dots behind it, and
 * keyboard focus draws a ring in the ink. Shared by the rows that go to a
 * page and the rows that switch something.
 */
const ROW_BUTTON =
  '-mx-1 flex min-w-0 items-center justify-between gap-4 rounded-chip px-1 py-2 text-left uppercase outline-none hover:bg-(--lcd-display-ink-unlit) focus-visible:ring-1 focus-visible:ring-(--lcd-display-lit) disabled:pointer-events-none disabled:text-(--lcd-display-ink-dim)'

/**
 * A fact that goes to the page owning it (the screen's `NavigableRow`): the
 * label, the lit value and a pixel chevron. `hint` lists what a summarised
 * value stands for, on hover and on focus.
 */
export function LcdPanelNavRow({
  label,
  value,
  hint,
  onNavigate
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  onNavigate: () => void
}): ReactElement {
  const button = (
    <button className={ROW_BUTTON} data-slot="lcd-panel-nav-row" type="button" onClick={onNavigate}>
      <span className="shrink-0 text-(--lcd-display-ink-dim)">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-(--lcd-display-lit)">
        {/* A long value truncates: the title on the cut text reveals it (plan 174 S1.10). */}
        {typeof value === 'string' ? (
          <span className="truncate" title={value}>
            {value}
          </span>
        ) : (
          value
        )}
        <LcdPixelChevron direction="right" />
      </span>
    </button>
  )
  if (!hint) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent align="start">{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A row that turns one thing on or off (a takeover): the name, and On or Off
 * in its place on the right, lit while on. `aria-pressed` says the state.
 */
export function LcdPanelPressRow({
  label,
  pressed,
  disabled,
  onPressedChange
}: {
  label: string
  pressed: boolean
  disabled?: boolean
  onPressedChange: (pressed: boolean) => void
}): ReactElement {
  return (
    <button
      aria-pressed={pressed}
      className={ROW_BUTTON}
      data-slot="lcd-panel-press-row"
      disabled={disabled}
      type="button"
      onClick={() => onPressedChange(!pressed)}
    >
      <span
        className={cn(
          'min-w-0 truncate',
          pressed ? 'text-(--lcd-display-lit)' : 'text-(--lcd-display-ink-dim)'
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'shrink-0',
          pressed ? 'text-(--lcd-display-lit)' : 'text-(--lcd-display-ink-dim)'
        )}
      >
        {pressed ? 'On' : 'Off'}
      </span>
    </button>
  )
}

/** A boolean on the screen: On lit or Off dim, as a switch for assistive tech. */
export function LcdPanelSwitch({
  checked,
  disabled,
  onCheckedChange,
  ...props
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  'aria-label': string
}): ReactElement {
  return (
    <button
      aria-checked={checked}
      aria-label={props['aria-label']}
      className={cn(LCD_VALUE_BUTTON, !checked && 'text-(--lcd-display-ink-dim)')}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onCheckedChange(!checked)}
    >
      {checked ? 'On' : 'Off'}
    </button>
  )
}

/**
 * A value that is a button (a dropdown's value, a switch, Resume): lit text
 * with room for a focus ring in the ink, dim while disabled, as the screen's
 * own select trigger draws it.
 */
export const LCD_VALUE_BUTTON =
  '-mx-1 inline-flex min-w-0 items-center gap-2 rounded-chip px-1 py-0.5 text-(--lcd-display-lit) uppercase outline-none hover:bg-(--lcd-display-ink-unlit) focus-visible:ring-1 focus-visible:ring-(--lcd-display-lit) disabled:pointer-events-none disabled:text-(--lcd-display-ink-dim)'

/**
 * The list a dropdown opens: a small screen inside the app's opaque popup
 * (`glass-float`), so nothing behind it reads through (floating surfaces are
 * opaque). The screen keeps its own opaque glass here, not the see-through
 * one of `LCD_ON_GLASS`, and drops its bezel: the popup is the frame.
 */
export function LcdPopupScreen({ children }: { children: ReactNode }): ReactElement {
  return (
    <LcdDisplay
      className="bg-none p-0 shadow-none ring-0 [&_[data-slot=lcd-display-content]]:p-1"
      size="sm"
    >
      {children}
    </LcdDisplay>
  )
}

/** A choice in an LCD list: dim, lit when chosen, inverted while highlighted. */
export const LCD_LIST_ITEM =
  'min-h-0 gap-2 rounded-chip px-2 py-2 text-(--lcd-display-ink-dim) data-[checked=true]:text-(--lcd-display-lit) data-[selected=true]:bg-(--lcd-display-lit) data-[selected=true]:text-(--lcd-display-glass) data-[selected=true]:*:[svg]:text-(--lcd-display-glass)'

/**
 * An LCD list's group: headings in the dim ink, smaller than the choices (11
 * px and up), so a heading never reads as one more choice.
 */
export const LCD_LIST_GROUP =
  'p-0 text-(--lcd-display-ink-dim) **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-[0.8em] **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:text-(--lcd-display-ink-dim)'
