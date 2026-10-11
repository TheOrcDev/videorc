import { CloseIcon, WarningIcon } from '@/components/icons'
import { useEffect, useId, useState, type KeyboardEvent, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertTitle } from '@/components/ui/alert'
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
  CohostGreetingTemplate,
  CohostUtteranceState
} from '@/lib/backend'
import { COHOST_ACTIVITY_TEMPLATE_KINDS } from '@/lib/backend'
import {
  BUDDY_GREETING_PLATFORM_LABELS,
  BUDDY_GREETINGS_EMPTY_NOTE,
  BUDDY_SAMPLE_FIELDS,
  BUDDY_STARTER_TEMPLATES,
  BUDDY_TEMPLATE_FIELDS,
  BUDDY_TEMPLATE_KIND_PLATFORMS,
  BUDDY_TEMPLATE_KIND_TITLES,
  BUDDY_TEMPLATE_TEXT_MAX_CHARS,
  BUDDY_TEMPLATES_MAX,
  greetingTemplateWarnings,
  newGreetingTemplate,
  resolveGreetingPreview
} from '@/lib/buddy-auto-chat-view'
import { cn } from '@/lib/utils'

/** A greeting's editor adds a variant from the keyboard too (G-23). */
const ADD_VARIANT_ACCELERATOR = 'CmdOrCtrl+N'

const STATE_OPTIONS: SegmentedControlOption<CohostUtteranceState>[] = [
  { value: 'talk', label: 'Talk' },
  { value: 'laugh', label: 'Laugh' },
  { value: 'think', label: 'Think' }
]

/**
 * Greetings (plan 164 S-D5, Buddy tab → Chat): the messages the Buddy posts
 * as you when chat does something, written by you, no AI. One row per
 * template; Enter or a click opens the inline editor. Free for every
 * account, so it never follows the tab's Premium lock. Saves on blur and on
 * every switch; no success toasts (videorc-design).
 */
export function BuddyGreetingsSection(): ReactElement | null {
  const { cohostSettings, patchCohostSettings } = useStudioCore()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  if (!cohostSettings) return null
  const autoChat = cohostSettings.autoChat
  const templates = autoChat.greetings.templates
  const save = (next: CohostAutoChat): void => {
    setError(null)
    void patchCohostSettings({ autoChat: next }).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : "Couldn't save the greetings.")
    )
  }
  const saveTemplates = (next: CohostGreetingTemplate[]): void =>
    save({ ...autoChat, greetings: { ...autoChat.greetings, templates: next } })
  const replace = (template: CohostGreetingTemplate): void =>
    saveTemplates(templates.map((current) => (current.id === template.id ? template : current)))
  const add = (template: CohostGreetingTemplate): void => {
    if (templates.length >= BUDDY_TEMPLATES_MAX) return
    saveTemplates([...templates, template])
    setEditing(template.id)
  }
  const full = templates.length >= BUDDY_TEMPLATES_MAX

  return (
    <PanelSection
      description="What Buddy posts as you when chat does something, in your own words. Free. Greetings go out only in the modes you turn on in Stream Manager, at most six a minute per platform."
      title="Greetings"
    >
      {/* A settings row sits in a grouped card like every Settings row (plan
          168 S-02), so its label and switch line up with the templates'. */}
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              {/* One name everywhere (plan 174 F-24): the Stream Manager's
                  summary chip says "Greetings" too. */}
              <FieldLabel htmlFor="buddy-greetings-enabled">Greetings</FieldLabel>
              <FieldDescription>
                Follows, subs, cheers, raids and the rest, each with its own line.
              </FieldDescription>
            </div>
            <Switch
              checked={autoChat.greetings.enabled}
              id="buddy-greetings-enabled"
              onCheckedChange={(enabled) =>
                save({ ...autoChat, greetings: { ...autoChat.greetings, enabled } })
              }
            />
          </div>
        </Field>
      </FieldGroup>
      {templates.length === 0 && autoChat.greetings.enabled ? (
        // Plan 174 F-11: on with nothing to post says so, never silently.
        <Alert data-testid="buddy-greetings-empty-note" variant="quiet">
          <AlertTitle>{BUDDY_GREETINGS_EMPTY_NOTE}</AlertTitle>
        </Alert>
      ) : null}
      {templates.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-slot="buddy-greetings-empty">
          <span className="text-xs text-subtle">No greetings yet.</span>
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() =>
              saveTemplates(
                BUDDY_STARTER_TEMPLATES.map((starter) => newGreetingTemplate(starter.kind, starter))
              )
            }
          >
            Add the starter set
          </Button>
        </div>
      ) : (
        <GroupedList aria-label="Greeting templates">
          {templates.map((template) => (
            <GreetingRow
              key={template.id}
              editing={editing === template.id}
              template={template}
              onAddVariant={() =>
                add(newGreetingTemplate(template.kind, { platform: template.platform }))
              }
              onChange={replace}
              onEdit={(open) => setEditing(open ? template.id : null)}
              onRemove={() => {
                setEditing(null)
                saveTemplates(templates.filter((current) => current.id !== template.id))
              }}
            />
          ))}
        </GroupedList>
      )}
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
        statusIcons={
          warnings.length > 0 ? (
            <span className="flex" data-slot="buddy-greeting-alert" id={warningsId}>
              <WarningIcon aria-hidden className="size-3.5 text-warning" weight="fill" />
              <span className="sr-only">{warnings.join(' ')}</span>
            </span>
          ) : undefined
        }
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
        <GreetingEditor
          template={template}
          warnings={warnings}
          onAddVariant={onAddVariant}
          onChange={onChange}
          onClose={() => onEdit(false)}
          onRemove={onRemove}
        />
      ) : null}
    </div>
  )
}

function GreetingEditor({
  template,
  warnings,
  onChange,
  onAddVariant,
  onRemove,
  onClose
}: {
  template: CohostGreetingTemplate
  warnings: string[]
  onChange: (template: CohostGreetingTemplate) => void
  onAddVariant: () => void
  onRemove: () => void
  onClose: () => void
}): ReactElement {
  const [draft, setDraft] = useState(template.text)
  useEffect(() => setDraft(template.text), [template.text])
  const preview = resolveGreetingPreview(draft, BUDDY_SAMPLE_FIELDS[template.kind]).text
  const draftWarnings =
    draft === template.text ? warnings : greetingTemplateWarnings({ ...template, text: draft })
  const commit = (): void => {
    const text = draft.trim()
    if (text === template.text) return
    onChange({ ...template, text })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'n' && (event.metaKey || event.ctrlKey)) {
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
        aria-label={`${BUDDY_TEMPLATE_KIND_TITLES[template.kind]} greeting text`}
        className="min-h-14"
        maxLength={BUDDY_TEMPLATE_TEXT_MAX_CHARS}
        placeholder="Welcome, {name}!"
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
          value={template.state}
          onValueChange={(state) => onChange({ ...template, state })}
        />
        <Select
          value={template.platform ?? 'any'}
          onValueChange={(platform) =>
            onChange({
              ...template,
              ...(platform === 'any'
                ? { platform: undefined }
                : { platform: platform as CohostGreetingPlatform })
            })
          }
        >
          <SelectTrigger aria-label="Platform" className="w-28" size="xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            {BUDDY_TEMPLATE_KIND_PLATFORMS[template.kind].map((platform) => (
              <SelectItem key={platform} value={platform}>
                {BUDDY_GREETING_PLATFORM_LABELS[platform]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="xs" type="button" variant="ghost">
              Fields
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <ul className="flex flex-col" data-slot="buddy-greeting-fields">
              {BUDDY_TEMPLATE_FIELDS.map((entry) => (
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
        <Button
          aria-label="Remove greeting"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onRemove}
        >
          <CloseIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" data-slot="buddy-greeting-preview">
        <span className="text-subtle">Preview:</span> {preview || '…'}
      </p>
      {draftWarnings.map((warning) => (
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
