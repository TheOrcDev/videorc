import { type AppIcon, BuddyIcon } from '@/components/icons'
import { useStudioCore } from '@/hooks/use-studio'
import { buddyPictureUrl } from '@/lib/buddy-picture'

/**
 * The Buddy page's mark wearing the streamer's own Buddy: their owl, orc or
 * upload in place of the golem once the persona has a picture, the golem
 * until then. An `AppIcon`, so nav rows take it like any other icon; it reads
 * the persona itself, so only this leaf re-renders when the Buddy changes.
 */
export const OwnBuddyIcon: AppIcon = (props) => {
  const { cohostSettings } = useStudioCore()
  return <BuddyIcon {...props} picture={buddyPictureUrl(cohostSettings?.persona)} />
}
