import { CloseIcon, WarningIcon } from '@/components/icons'
import { useEffect, useId, useState, type KeyboardEvent, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  CohostActivityTemplateKind,
  CohostAutoChat,
  CohostGreetingPlatform,
  CohostGreetings,
  CohostGreetingTemplate,
  CohostUtteranceState,
  CohostWelcomeKind,
  CohostWelcomeLine
} from '@/lib/backend'
import { COHOST_ACTIVITY_TEMPLATE_KINDS, COHOST_WELCOME_KINDS } from '@/lib/backend'
import {
  BUDDY_GREETING_PLATFORM_LABELS,
  BUDDY_SAMPLE_FIELDS,
  BUDDY_TEMPLATE_FIELDS,
  BUDDY_TEMPLATE_KIND_PLATFORMS,
  BUDDY_TEMPLATE_KIND_TITLES,
  BUDDY_TEMPLATE_TEXT_MAX_CHARS,
  BUDDY_TEMPLATES_MAX,
  BUDDY_WELCOME_FIELDS,
  BUDDY_WELCOME_KEYS,
  BUDDY_WELCOME_TITLES,
  buddyDisplayName,
  builtinGreeting,
  greetingTemplateWarnings,
  greetingWelcomes,
  greetingsAi,
  newGreetingTemplate,
  resolveGreetingPreview,
  withWelcomeText,
  type BuddyGreetingKind
} from '@/lib/buddy-auto-chat-view'
import { inlineUserError } from '@/lib/user-error'
import { cn } from '@/lib/utils'

/** A greeting's editor adds a variant from the keyboard too (G-23). */
const ADD_VARIANT_ACCELERATOR = 'CmdOrCtrl+N'

const STATE_OPTIONS: SegmentedControlOption<CohostUtteranceState>[] = [
  { value: 'talk', label: 'Talk' },
  { value: 'laugh', label: 'Laugh' },
  { value: 'think', label: 'Think' }
]

/**
 * Greetings (plan 164 S-D5, plan 192, Buddy tab → Chat): what Buddy posts as
 * you when someone chats for the first time (the welcomes) or chat does
 * something (the Activity kinds). Every kind has a built-in line until you
 * write your own (plan 192 D1), so an empty list never means silence: a kind
 * with no line of yours shows its built-in one as a Default row, and editing
 * that row or switching it off makes it yours. One row per line; Enter or a
 * click opens the inline editor. The lines are free for every account, so
 * they never follow the tab's Premium lock; only "Write greetings with AI"
 * does, like Answers and Banter (D3). Saves on blur and on every switch; no
 * success toasts (videorc-design).
 */
export function BuddyGreetingsSection({
  locked = false
}: {
  /** Buddy Live's unlock reason shows above: the AI switch is disabled (plan 150, D7). */
  locked?: boolean
}): ReactElement | null {
  const { cohostSettings, cohostGate, patchCohostSettings } = useStudioCore()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  if (!cohostSettings) return null
  const autoChat = cohostSettings.autoChat
  const greetings = autoChat.greetings
  const templates = greetings.templates
  const welcomes = greetingWelcomes(greetings)
  const save = (next: CohostAutoChat): void => {
    setError(null)
    void patchCohostSettings({ autoChat: next }).catch((failure: unknown) =>
      setError(
        inlineUserError(failure, { action: 'save', object: 'the greetings' }, 'buddy-greetings')
      )
    )
  }
  // Every save spreads the stored block, so the AI switch and the welcomes
  // ride along with a line's edit, and the lines with theirs (plan 192).
  const saveGreetings = (next: CohostGreetings): void => save({ ...autoChat, greetings: next })
  const saveTemplates = (next: CohostGreetingTemplate[]): void =>
    saveGreetings({ ...greetings, templates: next })
  const saveWelcome = (kind: CohostWelcomeKind, next: CohostWelcomeLine): void =>
    saveGreetings({ ...greetings, welcomes: { ...welcomes, [BUDDY_WELCOME_KEYS[kind]]: next } })
  const replace = (template: CohostGreetingTemplate): void =>
    saveTemplates(templates.map((current) => (current.id === template.id ? template : current)))
  const full = templates.length >= BUDDY_TEMPLATES_MAX
  const add = (template: CohostGreetingTemplate, open = true): void => {
    if (full) {
      setError(`Remove a line first: there can be ${BUDDY_TEMPLATES_MAX}.`)
      return
    }
    saveTemplates([...templates, template])
    if (open) setEditing(template.id)
  }

  return (
    <PanelSection
      description="What Buddy posts as you when someone chats for the first time, follows, subs or raids. Free: every kind has a line until you write your own. Greetings go out only in the modes you turn on in Stream Manager, at most six a minute per platform."
      title="Greetings"
    >
      {/* A settings row sits in a grouped card like every Settings row (plan
          168 S-02), so its label and switch line up with the lines'. */}
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              {/* One name everywhere (plan 174 F-24): the Stream Manager's
                  summary chip says "Greetings" too. */}
              <FieldLabel htmlFor="buddy-greetings-enabled">Greetings</FieldLabel>
              <FieldDescription>
                New chatters, follows, subs, raids and the rest, each with its own line.
              </FieldDescription>
            </div>
            <Switch
              checked={greetings.enabled}
              id="buddy-greetings-enabled"
              onCheckedChange={(enabled) => saveGreetings({ ...greetings, enabled })}
            />
          </div>
        </Field>
        {/* Plan 192 D3: Premium and cloud AI, like Answers and Banter, so it
            follows the tab's lock; the lines below stay free. */}
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="buddy-greetings-ai">Write greetings with AI</FieldLabel>
              <FieldDescription>
                {`In ${buddyDisplayName(cohostSettings.persona.name)}'s voice. Your line is the example and the fallback.`}
              </FieldDescription>
            </div>
            <Switch
              checked={greetingsAi(greetings)}
              disabled={locked || !cohostGate.allowed}
              id="buddy-greetings-ai"
              onCheckedChange={(ai) => saveGreetings({ ...greetings, ai })}
            />
          </div>
        </Field>
      </FieldGroup>
      {/* Plan 192 S1.3: the welcomes lead, above the Activity kinds. */}
      <GroupedList aria-label="Welcomes" data-testid="buddy-welcomes" label="Welcomes">
        {COHOST_WELCOME_KINDS.map((kind) => (
          <WelcomeRow
            key={kind}
            editing={editing === `welcome:${kind}`}
            kind={kind}
            welcome={welcomes[BUDDY_WELCOME_KEYS[kind]]}
            onChange={(next) => saveWelcome(kind, next)}
            onEdit={(open) => setEditing(open ? `welcome:${kind}` : null)}
          />
        ))}
      </GroupedList>
      {/* Plan 192 S0.3: one place per kind, in a fixed order: your lines for
          it, or its built-in line as a Default row. */}
      <GroupedList
        aria-label="Activity greetings"
        data-testid="buddy-activity-greetings"
        label="Activity"
      >
        {COHOST_ACTIVITY_TEMPLATE_KINDS.flatMap((kind) => {
          const ofKind = templates.filter((template) => template.kind === kind)
          if (ofKind.length === 0) {
            return [
              <DefaultGreetingRow
                key={`default:${kind}`}
                editing={editing === `default:${kind}`}
                kind={kind}
                onCreate={add}
                onEdit={(open) => setEditing(open ? `default:${kind}` : null)}
              />
            ]
          }
          return ofKind.map((template) => (
            <GreetingRow
              key={template.id}
              editing={editing === template.id}
              template={template}
              onAddVariant={() => add(newGreetingTemplate(kind, { platform: template.platform }))}
              onChange={replace}
              onEdit={(open) => setEditing(open ? template.id : null)}
              onRemove={() => {
                setEditing(null)
                saveTemplates(templates.filter((current) => current.id !== template.id))
              }}
            />
          ))
        })}
      </GroupedList>
      <div className="flex flex-wrap items-center gap-2">
        <AddGreeting disabled={full} onAdd={(kind) => add(newGreetingTemplate(kind))} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {templates.length}/{BUDDY_TEMPLATES_MAX}
        </span>
      </div>
      {error ? <FieldError data-testid="cohost-save-error">{error}</FieldError> : null}
    </PanelSection>
  )
}

function AddGreeting({
  disabled,
  onAdd
}: {
  disabled: boolean
  onAdd: (kind: CohostActivityTemplateKind) => void
}): ReactElement {
  return (
    <Select
      disabled={disabled}
      value=""
      onValueChange={(kind) => {
        if (kind) onAdd(kind as CohostActivityTemplateKind)
      }}
    >
      <SelectTrigger aria-label="Add a greeting" className="w-44" size="xs">
        <SelectValue placeholder={disabled ? 'Remove one to add another' : 'Add a greeting…'} />
      </SelectTrigger>
      <SelectContent>
        {COHOST_ACTIVITY_TEMPLATE_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {BUDDY_TEMPLATE_KIND_TITLES[kind]}
            <span className="ml-1 text-xs text-muted-foreground">
              {BUDDY_TEMPLATE_KIND_PLATFORMS[kind]
                .map((platform) => BUDDY_GREETING_PLATFORM_LABELS[platform])
                .join(', ')}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A row's warnings: a mark, read out as the title button's description. */
function RowWarnings({ id, warnings }: { id: string; warnings: string[] }): ReactElement | null {
  if (warnings.length === 0) return null
  return (
    <span className="flex" data-slot="buddy-greeting-alert" id={id}>
      <WarningIcon aria-hidden className="size-3.5 text-warning" weight="fill" />
      <span className="sr-only">{warnings.join(' ')}</span>
    </span>
  )
}

/** The tag on a row that posts Buddy's built-in line (plan 192 S0.3). */
function DefaultTag(): ReactElement {
  return (
    <Badge data-testid="buddy-greeting-default" variant="outline">
      Default
    </Badge>
  )
}

function GreetingRow({
  template,
  editing,
  onEdit,
  onChange,
  onAddVariant,
  onRemove
}: {
  template: CohostGreetingTemplate
  editing: boolean
  onEdit: (open: boolean) => void
  onChange: (template: CohostGreetingTemplate) => void
  onAddVariant: () => void
  onRemove: () => void
}): ReactElement {
  const warnings = greetingTemplateWarnings(template)
  const warningsId = useId()
  const title = BUDDY_TEMPLATE_KIND_TITLES[template.kind]
  return (
    <div data-slot="buddy-greeting" data-template-kind={template.kind}>
      {/* The title is the row's button, stretched over the row, so a click
          anywhere or Enter opens the editor. The switch is its sibling,
          never inside a button (plan 174 S0.5, G-8). */}
      <ListRow
        className="relative"
        interactive
        icon={
          template.platform ? (
            <ChatPlatformIcon decorative platform={template.platform} />
          ) : undefined
        }
        meta={
          <Switch
            aria-label={`${title} greeting on`}
            checked={template.enabled}
            size="sm"
            onCheckedChange={(enabled) => onChange({ ...template, enabled })}
          />
        }
        statusIcons={<RowWarnings id={warningsId} warnings={warnings} />}
        title={
          <ListRowButton
            aria-describedby={warnings.length > 0 ? warningsId : undefined}
            aria-expanded={editing}
            onClick={() => onEdit(!editing)}
          >
            {title}
          </ListRowButton>
        }
        context={
          <span className="min-w-0 truncate text-muted-foreground">{template.text || 'Empty'}</span>
        }
      />
      {editing ? (
        <LineEditor
          kind={template.kind}
          label={`${title} greeting text`}
          platform={template.platform}
          state={template.state}
          text={template.text}
          onAddVariant={onAddVariant}
          onClose={() => onEdit(false)}
          onCommit={(text) => onChange({ ...template, text })}
          onPlatform={(platform) => onChange({ ...template, platform })}
          onRemove={onRemove}
          onState={(state) => onChange({ ...template, state })}
        />
      ) : null}
    </div>
  )
}

/**
 * A kind with no line of yours (plan 192 S0.3): its built-in line, marked
 * Default. Editing it, or switching it off, makes it yours: a line of the
 * same kind, text and state (switched off: the built-in text, off).
 */
function DefaultGreetingRow({
  kind,
  editing,
  onEdit,
  onCreate
}: {
  kind: CohostActivityTemplateKind
  editing: boolean
  onEdit: (open: boolean) => void
  onCreate: (template: CohostGreetingTemplate, open?: boolean) => void
}): ReactElement {
  const builtin = builtinGreeting(kind)
  const title = BUDDY_TEMPLATE_KIND_TITLES[kind]
  return (
    <div data-default="" data-slot="buddy-greeting" data-template-kind={kind}>
      <ListRow
        alias={<DefaultTag />}
        className="relative"
        interactive
        meta={
          <Switch
            aria-label={`${title} greeting on`}
            checked
            size="sm"
            onCheckedChange={(enabled) => {
              if (!enabled) onCreate(newGreetingTemplate(kind, { enabled: false }), false)
            }}
          />
        }
        title={
          <ListRowButton aria-expanded={editing} onClick={() => onEdit(!editing)}>
            {title}
          </ListRowButton>
        }
        context={<span className="min-w-0 truncate text-muted-foreground">{builtin.text}</span>}
      />
      {editing ? (
        <LineEditor
          kind={kind}
          label={`${title} greeting text`}
          state={builtin.state}
          text={builtin.text}
          onClose={() => onEdit(false)}
          onCommit={(text) => onCreate(newGreetingTemplate(kind, { text }))}
          onPlatform={(platform) => onCreate(newGreetingTemplate(kind, { platform }))}
          onState={(state) => onCreate(newGreetingTemplate(kind, { state }))}
        />
      ) : null}
    </div>
  )
}

/**
 * A welcome (plan 192 S1.3): first-time or returning chatters, with its
 * switch and its line. An empty line is the built-in one, shown as the
 * placeholder and saved as absent. A welcome goes only to the chat the
 * message came from, so it has no platform choice.
 */
function WelcomeRow({
  kind,
  welcome,
  editing,
  onEdit,
  onChange
}: {
  kind: CohostWelcomeKind
  welcome: CohostWelcomeLine
  editing: boolean
  onEdit: (open: boolean) => void
  onChange: (welcome: CohostWelcomeLine) => void
}): ReactElement {
  const builtin = builtinGreeting(kind)
  const title = BUDDY_WELCOME_TITLES[kind]
  const text = welcome.text?.trim() ?? ''
  const warnings = greetingTemplateWarnings({ kind, text: text || builtin.text })
  const warningsId = useId()
  return (
    <div data-slot="buddy-welcome" data-welcome-kind={kind}>
      <ListRow
        alias={text ? undefined : <DefaultTag />}
        className="relative"
        interactive
        meta={
          <Switch
            aria-label={`${title} welcome on`}
            checked={welcome.enabled}
            size="sm"
            onCheckedChange={(enabled) => onChange({ ...welcome, enabled })}
          />
        }
        statusIcons={<RowWarnings id={warningsId} warnings={warnings} />}
        title={
          <ListRowButton
            aria-describedby={warnings.length > 0 ? warningsId : undefined}
            aria-expanded={editing}
            onClick={() => onEdit(!editing)}
          >
            {title}
          </ListRowButton>
        }
        context={
          <span className="min-w-0 truncate text-muted-foreground">{text || builtin.text}</span>
        }
      />
      {editing ? (
        <LineEditor
          fallback={builtin.text}
          fields={BUDDY_WELCOME_FIELDS}
          kind={kind}
          label={`${title} welcome text`}
          state={welcome.state ?? builtin.state}
          text={text}
          onClose={() => onEdit(false)}
          onCommit={(next) => onChange(withWelcomeText(welcome, next))}
          onState={(state) => onChange({ ...welcome, state })}
        />
      ) : null}
    </div>
  )
}

/**
 * One line's inline editor: the text (saved on blur), its state, the
 * fields, and a live preview with the warnings. A template adds its
 * platform, "Add variant" and Remove. A welcome passes `fallback`, its
 * built-in line: the placeholder, and what an empty text posts. A
 * template's text is never empty (the settings refuse it), so clearing it
 * keeps the line it had.
 */
function LineEditor({
  kind,
  label,
  text,
  state,
  platform,
  fallback,
  fields = BUDDY_TEMPLATE_FIELDS,
  onCommit,
  onState,
  onPlatform,
  onAddVariant,
  onRemove,
  onClose
}: {
  kind: BuddyGreetingKind
  /** The text box's accessible name. */
  label: string
  /** The saved text; empty for a welcome on its built-in line. */
  text: string
  state: CohostUtteranceState
  platform?: CohostGreetingPlatform
  fallback?: string
  fields?: readonly { field: string; hint: string }[]
  onCommit: (text: string) => void
  onState: (state: CohostUtteranceState) => void
  /** Absent hides the platform choice. */
  onPlatform?: (platform: CohostGreetingPlatform | undefined) => void
  onAddVariant?: () => void
  onRemove?: () => void
  onClose: () => void
}): ReactElement {
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])
  const effective = draft.trim() || fallback || ''
  const preview = resolveGreetingPreview(effective, BUDDY_SAMPLE_FIELDS[kind]).text
  const warnings = greetingTemplateWarnings({ kind, platform, text: effective })
  const commit = (): void => {
    const next = draft.trim()
    if (next === text) return
    if (!next && fallback === undefined) {
      setDraft(text)
      return
    }
    onCommit(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (onAddVariant && event.key === 'n' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      commit()
      onAddVariant()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      commit()
      onClose()
    }
  }
  const insertField = (field: string): void => {
    setDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}{${field}}`)
  }
  return (
    <div
      className="flex flex-col gap-2 border-t border-border px-3 py-2"
      data-slot="buddy-greeting-editor"
      onKeyDown={onKeyDown}
    >
      <Textarea
        aria-label={label}
        className="min-h-14"
        maxLength={BUDDY_TEMPLATE_TEXT_MAX_CHARS}
        placeholder={fallback ?? builtinGreeting(kind).text}
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {draft.length}/{BUDDY_TEMPLATE_TEXT_MAX_CHARS}
        </span>
        <SegmentedControl
          aria-label="Avatar state"
          options={STATE_OPTIONS}
          size="sm"
          value={state}
          onValueChange={onState}
        />
        {onPlatform ? (
          <Select
            value={platform ?? 'any'}
            onValueChange={(next) =>
              onPlatform(next === 'any' ? undefined : (next as CohostGreetingPlatform))
            }
          >
            <SelectTrigger aria-label="Platform" className="w-28" size="xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              {BUDDY_TEMPLATE_KIND_PLATFORMS[kind].map((option) => (
                <SelectItem key={option} value={option}>
                  {BUDDY_GREETING_PLATFORM_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <Button size="xs" type="button" variant="ghost">
              Fields
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <ul className="flex flex-col" data-slot="buddy-greeting-fields">
              {fields.map((entry) => (
                <li key={entry.field}>
                  <Button
                    className="w-full justify-start gap-2 px-2"
                    type="button"
                    variant="ghost"
                    onClick={() => insertField(entry.field)}
                  >
                    <code className="text-xs">{`{${entry.field}}`}</code>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {entry.hint}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        <span className="flex-1" />
        {onAddVariant ? (
          <Button
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => {
              commit()
              onAddVariant()
            }}
          >
            Add variant
            <ShortcutKeys accelerator={ADD_VARIANT_ACCELERATOR} />
          </Button>
        ) : null}
        {onRemove ? (
          <Button
            aria-label="Remove greeting"
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={onRemove}
          >
            <CloseIcon />
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground" data-slot="buddy-greeting-preview">
        <span className="text-subtle">Preview:</span> {preview || '…'}
      </p>
      {warnings.map((warning) => (
        <p
          key={warning}
          className={cn('text-xs text-muted-foreground')}
          data-slot="buddy-greeting-warning"
          role="note"
        >
          {warning}
        </p>
      ))}
    </div>
  )
}
