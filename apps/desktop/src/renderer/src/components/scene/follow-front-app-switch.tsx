import type { ReactElement } from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { setFollowFrontApp, updateFollowSettings, useFollowSettings } from '@/lib/follow-settings'

/**
 * "Follow the app in front" (plan 210 D10), macOS only (D12: absent
 * elsewhere, not disabled; the caller leaves it out). Per device, on by
 * default. Each scene made for an app follows once that app has stayed in
 * front briefly; Videorc itself and apps without a scene keep the current
 * scene. A scene's ⋯ can stop it. Its home is Studio's Scenes section (plan
 * 231 D8; the Scene page's list held it before).
 */
export function FollowFrontAppSwitch(): ReactElement {
  const follow = useFollowSettings()
  return (
    <div className="flex items-center gap-2" data-videorc-follow-front-app="">
      <Label
        className="text-meta font-normal text-muted-foreground"
        htmlFor="scene-follow-front-app"
      >
        Follow the app in front
      </Label>
      <Switch
        checked={follow.followFrontApp}
        id="scene-follow-front-app"
        size="sm"
        onCheckedChange={(checked) =>
          updateFollowSettings((current) => setFollowFrontApp(current, checked))
        }
      />
    </div>
  )
}
