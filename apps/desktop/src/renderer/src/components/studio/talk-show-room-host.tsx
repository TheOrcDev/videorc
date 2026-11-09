import { useEffect } from 'react'

import {
  NO_TALK_SHOW,
  useTalkShowRoomController,
  type TalkShowContextValue,
  type TalkShowRoomControllerDeps
} from '@/hooks/use-talk-show-room'

// Plan 224 C-G4: the talk show's room controller, mounted lazily under the
// Studio provider so the eager bundle carries only the idle value. It draws
// nothing; it runs the controller and hands its value to the cloud context.
// Its state lives here, below the provider, so a room snapshot never
// re-renders the whole Studio.

export default function TalkShowRoomHost({
  deps,
  onValue
}: {
  deps: TalkShowRoomControllerDeps
  onValue: (value: TalkShowContextValue) => void
}): null {
  const value = useTalkShowRoomController(deps)
  useEffect(() => {
    onValue(value)
  }, [onValue, value])
  useEffect(() => () => onValue(NO_TALK_SHOW), [onValue])
  return null
}
