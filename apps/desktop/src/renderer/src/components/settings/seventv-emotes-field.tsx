import type { ReactElement, ReactNode } from 'react'

import { Alert, AlertTitle } from '@/components/ui/alert'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useChatEmoteSettings } from '@/hooks/use-chat-emote-settings'
import type { ChatEmotesSettings, TwitchGifMode } from '@/lib/backend'
import { sevenTvStatusLine } from '@/lib/seventv-status'

/**
 * Settings → General → Stream Manager: 7TV emotes (plan 089) and Twitch GIFs
 * (plan 155) in the Stream Manager's chat. One backend row, so one client for
 * both. `children` are the section's other rows, in the same group.
 */
export function ChatEmoteSettingsFields({ children }: { children?: ReactNode }): ReactElement {
  const { settings, error, setSevenTv, setTwitchGifs } = useChatEmoteSettings()
  return (
    <ChatEmoteSettingsView
      error={error}
      settings={settings}
      onSevenTvChange={setSevenTv}
      onTwitchGifsChange={setTwitchGifs}
    >
      {children}
    </ChatEmoteSettingsView>
  )
}

/**
 * The two chat rows and their one failure. Both rows wait on the same backend
 * row, so a failure locks both and says why once, ahead of them (plan 174
 * I-8), instead of under one of the two disabled controls.
 */
export function ChatEmoteSettingsView({
  settings,
  error,
  onSevenTvChange,
  onTwitchGifsChange,
  children
}: {
  settings: ChatEmotesSettings | null
  error: string | null
  onSevenTvChange: (on: boolean) => void
  onTwitchGifsChange: (mode: TwitchGifMode) => void
  children?: ReactNode
}): ReactElement {
  return (
    <>
      {error ? (
        <Alert data-testid="chat-emote-error" variant="warning">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      <FieldGroup variant="grouped">
        {children}
        <SevenTvEmotesFieldView
          error={error}
          settings={settings}
          onSevenTvChange={onSevenTvChange}
        />
        <TwitchGifsFieldView settings={settings} onChange={onTwitchGifsChange} />
      </FieldGroup>
    </>
  )
}

export function SevenTvEmotesFieldView({
  settings,
  error,
  onSevenTvChange
}: {
  settings: ChatEmotesSettings | null
  /** Shown once above the rows; while it stands, the 7TV status line steps aside. */
  error: string | null
  onSevenTvChange: (on: boolean) => void
}): ReactElement {
  const status = !error && settings ? sevenTvStatusLine(settings.sevenTvStatus) : null
  return (
    <SettingsRow
      description={
        <>
          Your channel&apos;s 7TV emotes, in Twitch, Kick and YouTube chat.
          {status ? (
            <span className="block" data-slot="seventv-status">
              {status}
            </span>
          ) : null}
        </>
      }
      label="Show 7TV emotes in chat"
    >
      <Switch
        checked={settings?.sevenTv ?? false}
        disabled={!settings}
        id="show-7tv-emotes"
        onCheckedChange={onSevenTvChange}
      />
    </SettingsRow>
  )
}

export const TWITCH_GIF_MODE_OPTIONS: ReadonlyArray<{ value: TwitchGifMode; label: string }> = [
  { value: 'animated', label: 'Animated' },
  { value: 'still', label: 'Still' },
  { value: 'off', label: 'Off' }
]

/**
 * Settings → General → "GIFs in Twitch chat" (plan 155, D6). Animated is the
 * default; Still shows one frame; Off keeps the GIF's title and never
 * fetches the image. A system set to reduce motion shows stills whatever
 * this says.
 */
export function TwitchGifsFieldView({
  settings,
  onChange
}: {
  settings: ChatEmotesSettings | null
  onChange: (mode: TwitchGifMode) => void
}): ReactElement {
  const mode = settings?.twitchGifs ?? 'animated'
  const selected = TWITCH_GIF_MODE_OPTIONS.find((option) => option.value === mode)
  return (
    <SettingsRow
      description="GIFs Tier 2 and Tier 3 subscribers send from Twitch's GIF Keyboard. Still shows one frame; Off keeps the GIF's title only."
      label="GIFs in Twitch chat"
    >
      <Select
        disabled={!settings}
        value={mode}
        onValueChange={(value) => {
          if (value !== null) onChange(value)
        }}
      >
        <SelectTrigger className="w-32 shrink-0" id="twitch-gifs">
          <SelectValue>
            <span data-slot="twitch-gifs-mode">{selected?.label ?? 'Animated'}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TWITCH_GIF_MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  )
}
