import type { ReactElement } from 'react'

import { Field, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useChatEmoteSettings } from '@/hooks/use-chat-emote-settings'
import type { ChatEmotesSettings } from '@/lib/backend'
import { sevenTvStatusLine } from '@/lib/seventv-status'

/** Settings → General: 7TV emotes in the Stream Manager's chat (plan 089). */
export function SevenTvEmotesField(): ReactElement {
  const { settings, error, setSevenTv } = useChatEmoteSettings()
  return <SevenTvEmotesFieldView error={error} settings={settings} onSevenTvChange={setSevenTv} />
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
