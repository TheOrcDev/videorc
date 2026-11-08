import {
  ArrowDownIcon,
  ArrowUpIcon,
  DeleteIcon,
  EditIcon,
  PlayIcon,
  ResetIcon,
  SpeakerOnIcon,
  StopIcon,
  UploadIcon
} from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { GroupedList, ListRow } from '@/components/list-row'
import { OfflineAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyContent, EmptyTitle } from '@/components/ui/empty'
import { Fader, FaderRange, FaderThumb, FaderTrack } from '@/components/ui/fader'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useSoundboard, useStarterSounds } from '@/hooks/use-soundboard'
import { formatDb } from '@/lib/audio/decibels'
import {
  SOUND_HOTKEYS,
  SOUND_MODES,
  SOUND_NAME_MAX_CHARS,
  SOUND_VOLUME_DB_MAX,
  SOUND_VOLUME_DB_MIN,
  type Sound,
  type SoundHotkey,
  type SoundUpdateParams
} from '@/lib/backend'
import {
  SOUND_MODE_LABELS,
  formatSoundDuration,
  missingStarterSlugs,
  soundImportBlockedReason,
  soundImportLabel,
  soundsSectionDescription
} from '@/lib/sounds'
import { OFFLINE_REASON } from '@/lib/user-error'

/** Videorc's slider knob on audiocn's thumb, like the Sources faders. */
const FADER_THUMB = 'bg-knob ring-knob-ring'
/** The Key menu's "no key" choice, a value of its own (an empty one reads as no selection). */
const NO_KEY = 'none'
const NO_KEY_ITEM = { [NO_KEY]: 'None' }

/**
 * Assets → Sounds (plan 189 S7): the one home that imports, renames, orders,
 * trims and removes the soundboard's sounds, and sets how a press plays each
 * one and its key. Studio's Soundboard plays them; Sources → Sounds holds the
 * board's level. Nothing here waits for a session to end. Remove waits behind
 * an Undo, not a question: a removed starter can come back.
 */
export function SoundsSection(): ReactElement {
  const board = useSoundboard()
  const starters = useStarterSounds()
  const [renaming, setRenaming] = useState<Sound | null>(null)
  const { sounds, loaded, offline } = board
  const playing = new Set(board.voices.map((voice) => voice.soundId))
  const importReason = soundImportBlockedReason({
    offline,
    phase: board.importPhase,
    count: sounds.length
  })
  const missingStarters = starters && loaded ? missingStarterSlugs(starters, sounds) : []

  const importButton = (testId: string): ReactElement => (
    <DisabledReason reason={importReason}>
      <Button
        data-testid={testId}
        disabled={importReason !== null}
        variant="outline"
        onClick={() => void board.importSounds()}
      >
        {board.importPhase !== 'idle' ? (
          <Spinner aria-hidden data-icon="inline-start" />
        ) : (
          <UploadIcon data-icon="inline-start" />
        )}
        {soundImportLabel(board.importPhase)}
      </Button>
    </DisabledReason>
  )

  return (
    <>
      <PanelSection
        action={importButton('sound-import')}
        data-videorc-sounds-section=""
        description={soundsSectionDescription(loaded ? sounds.length : null)}
        icon={SpeakerOnIcon}
        title="Sounds"
      >
        {offline ? <OfflineAlert /> : null}
        {sounds.length > 0 ? (
          <GroupedList aria-label="Sounds">
            {sounds.map((sound, index) => (
              <SoundRow
                disabled={offline}
                first={index === 0}
                key={sound.id}
                last={index === sounds.length - 1}
                playing={playing.has(sound.id)}
                sound={sound}
                onChange={(patch) => void board.updateSound(sound.id, patch)}
                onMove={(step) => void board.moveSound(sound.id, index + step)}
                onPlay={() => void (playing.has(sound.id) ? board.stop : board.play)(sound.id)}
                onRemove={() => board.removeSound(sound)}
                onRename={() => setRenaming(sound)}
              />
            ))}
          </GroupedList>
        ) : !loaded ? (
          // Never "No sounds yet" before the board is known (J2-8). Offline,
          // the alert above already says why.
          offline ? null : (
            <Empty className="py-12" data-videorc-sounds-loading="">
              <EmptyTitle>Loading sounds…</EmptyTitle>
            </Empty>
          )
        ) : (
          <Empty className="py-12" data-videorc-sounds-empty="">
            <EmptyTitle>No sounds yet</EmptyTitle>
            <EmptyContent>{importButton('sound-import-empty')}</EmptyContent>
          </Empty>
        )}
        {missingStarters.length > 0 ? (
          <DisabledReason reason={offline ? OFFLINE_REASON : null}>
            <Button
              className="self-start"
              data-testid="sound-restore-starters"
              disabled={offline || board.restoring}
              variant="ghost"
              onClick={() => void board.restoreStarters()}
            >
              {board.restoring ? (
                <Spinner aria-hidden data-icon="inline-start" />
              ) : (
                <ResetIcon data-icon="inline-start" />
              )}
              {board.restoring ? 'Restoring…' : 'Restore starter sounds'}
            </Button>
          </DisabledReason>
        ) : null}
      </PanelSection>
      {renaming ? (
        <RenameSoundDialog
          sound={renaming}
          onClose={() => setRenaming(null)}
          onRename={(name) => {
            setRenaming(null)
            void board.updateSound(renaming.id, { name })
          }}
        />
      ) : null}
    </>
  )
}

/**
 * One sound: play or stop it, its name and length, then how a press plays
 * it, its volume and its key, and the rare actions in ⋯. Markup from props,
 * so the tests render it.
 */
export function SoundRow({
  sound,
  playing,
  disabled,
  first,
  last,
  onPlay,
  onChange,
  onRename,
  onMove,
  onRemove
}: {
  sound: Sound
  playing: boolean
  /** Videorc is reconnecting: the section's alert says so, and nothing here acts. */
  disabled: boolean
  first: boolean
  last: boolean
  onPlay: () => void
  onChange: (patch: Omit<SoundUpdateParams, 'id'>) => void
  onRename: () => void
  onMove: (step: -1 | 1) => void
  onRemove: () => void
}): ReactElement {
  // The fader follows the drag here and saves once, when it lets go.
  const [draftVolume, setDraftVolume] = useState<number | null>(null)
  const volumeDb = draftVolume ?? sound.volumeDb
  const items: KebabMenuItem[] = [
    { id: 'rename', label: 'Rename…', icon: EditIcon, group: 'edit', onSelect: onRename },
    {
      id: 'move-up',
      label: 'Move up',
      icon: ArrowUpIcon,
      group: 'order',
      disabled: first,
      disabledReason: first ? 'This sound is already first.' : null,
      onSelect: () => onMove(-1)
    },
    {
      id: 'move-down',
      label: 'Move down',
      icon: ArrowDownIcon,
      group: 'order',
      disabled: last,
      disabledReason: last ? 'This sound is already last.' : null,
      onSelect: () => onMove(1)
    },
    { id: 'remove', label: 'Remove', icon: DeleteIcon, destructive: true, onSelect: onRemove }
  ]

  return (
    <ListRow
      className="group/kebab-host"
      context={<span className="tabular-nums">{formatSoundDuration(sound.durationMs)}</span>}
      data-playing={playing || undefined}
      data-videorc-sound-row={sound.id}
      leading={
        <Button
          aria-label={`${playing ? 'Stop' : 'Play'} ${sound.name}`}
          disabled={disabled}
          size="icon-xs"
          variant="ghost"
          onClick={onPlay}
        >
          {playing ? <StopIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </Button>
      }
      title={sound.name}
    >
      <Select
        disabled={disabled}
        items={SOUND_MODE_LABELS}
        value={sound.mode}
        onValueChange={(mode) => {
          if (mode !== null) onChange({ mode })
        }}
      >
        <SelectTrigger aria-label={`How ${sound.name} plays`} className="w-28" size="xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {SOUND_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {SOUND_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <div className="flex w-36 items-center gap-2">
        <Fader
          aria-label={`${sound.name} volume`}
          className="min-w-0 flex-1"
          disabled={disabled}
          fineStep={1}
          largeStep={6}
          max={SOUND_VOLUME_DB_MAX}
          min={SOUND_VOLUME_DB_MIN}
          origin={0}
          resetValue={0}
          step={1}
          value={volumeDb}
          onValueChange={(value) => setDraftVolume(Math.round(value))}
          onValueCommitted={(value) => {
            const next = Math.round(value)
            setDraftVolume(null)
            if (next !== sound.volumeDb) onChange({ volumeDb: next })
          }}
        >
          <FaderTrack>
            <FaderRange />
            <FaderThumb className={FADER_THUMB} />
          </FaderTrack>
        </Fader>
        <span className="w-[7ch] shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
          {formatDb(volumeDb)}
        </span>
      </div>
      {/* Picking a key another sound has moves it here (the backend's rule). */}
      <Select
        disabled={disabled}
        // A key is its own label; only "no key" needs words.
        items={NO_KEY_ITEM}
        value={sound.hotkey ?? NO_KEY}
        onValueChange={(key) => {
          if (key !== null) onChange({ hotkey: key === NO_KEY ? '' : (key as SoundHotkey) })
        }}
      >
        <SelectTrigger aria-label={`${sound.name} key`} className="w-20" size="xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={NO_KEY}>{NO_KEY_ITEM[NO_KEY]}</SelectItem>
            {SOUND_HOTKEYS.map((key) => (
              <SelectItem key={key} value={key}>
                {key}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <KebabMenu
        disabled={disabled}
        items={items}
        label={`Actions for ${sound.name}`}
        reveal="hover"
      />
    </ListRow>
  )
}

/** Rename… a sound: an unchanged or empty name saves nothing. */
function RenameSoundDialog({
  sound,
  onRename,
  onClose
}: {
  sound: Sound
  onRename: (name: string) => void
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(sound.name)
  const next = name.trim()
  const changed = next.length > 0 && next !== sound.name
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} data-testid="sound-rename-dialog" size="sm">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (changed) onRename(next)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename sound</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="sound-rename-name">Name</FieldLabel>
            <Input
              autoFocus
              id="sound-rename-name"
              maxLength={SOUND_NAME_MAX_CHARS}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button data-testid="sound-rename-save" disabled={!changed} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
