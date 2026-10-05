import type { ReactElement } from 'react'

import { Field, FieldLabel } from '@/components/ui/field'
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

/** Settings → General: 7TV emotes (plan 089) and Twitch GIFs (plan 155) in
 * the Stream Manager's chat. One backend row, so one client for both. */
export function ChatEmoteSettingsFields(): ReactElement {
  const { settings, error, setSevenTv, setTwitchGifs } = useChatEmoteSettings()
  return (
    <>
      <SevenTvEmotesFieldView error={error} settings={settings} onSevenTvChange={setSevenTv} />
      <TwitchGifsFieldView settings={settings} onChange={setTwitchGifs} />
    </>
  )
}

export function SevenTvEmotesFieldView({
  settings,
  error,
  onSevenTvChange
}: {
  settings: ChatEmotesSettings | null
  error: string | null
  onSevenTvChange: (on: boolean) => void
}): ReactElement {
  const status = error ?? (settings ? sevenTvStatusLine(settings.sevenTvStatus) : null)
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel htmlFor="show-7tv-emotes">Show 7TV emotes in chat</FieldLabel>
          <p className="text-xs text-muted-foreground">
            Your channel&apos;s 7TV emotes, in Twitch, Kick and YouTube chat.
          </p>
          {status ? (
            <p className="text-xs text-muted-foreground" data-slot="seventv-status">
              {status}
            </p>
          ) : null}
        </div>
        <Switch
          checked={settings?.sevenTv ?? false}
          disabled={!settings}
          id="show-7tv-emotes"
          onCheckedChange={onSevenTvChange}
        />
      </div>
    </Field>
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
    <Field>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel htmlFor="twitch-gifs">GIFs in Twitch chat</FieldLabel>
          <p className="text-xs text-muted-foreground">
            GIFs Tier 2 and Tier 3 subscribers send from Twitch&apos;s GIF Keyboard. Still shows one
            frame; Off keeps the GIF&apos;s title only.
          </p>
        </div>
        <Select
          disabled={!settings}
          value={mode}
          onValueChange={(value) => onChange(value as TwitchGifMode)}
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
      </div>
    </Field>
  )
}
