import { SceneIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { BuddyEmblem } from '@/components/buddy-emblem'
import { BuddyGreetingsSection } from '@/components/buddy-greetings-section'
import { BuddyLibrarySection } from '@/components/buddy-library-section'
import { BuddyPersonaSection } from '@/components/buddy-persona-section'
import { BuddyPetCreator } from '@/components/buddy-pet-creator'
import { BuddyPetSettings } from '@/components/buddy-pet-settings'
import { PageStack } from '@/components/page'
import { PageTabs } from '@/components/page-tabs'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { TabsContent } from '@/components/ui/tabs'
import { BuddyLookClientProvider } from '@/hooks/use-buddy-look'
import { useStudioCore } from '@/hooks/use-studio'
import { AVATAR_TABS, DEFAULT_AVATAR_TAB, type AvatarTabId } from '@/lib/avatar-tabs'
import { avatarPlacementView } from '@/lib/avatar-tab-view'
import { buddyDisplayName } from '@/lib/buddy-auto-chat-view'
import { closeBuddyPetCreator, useBuddyPetCreatorOpen } from '@/lib/buddy-pet-creator-nav'
import { buddyPictureUrl } from '@/lib/buddy-picture'
import { pageShortcutFor } from '@/components/workspace-nav'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * The Avatar page (plan 239): the character on the stream, in Livestream
 * just above Sidekick, the helper it speaks for. Two tabs in a strip under the
 * toolbar, built like Settings and Sidekick:
 *
 * - **Profile**: where the avatar shows, My avatars (the library), its name,
 *   personality and About you, the look (Still or Alive, Test, Create),
 *   reactions and motion. The Alive creator opens over it.
 * - **Greetings**: what it says when someone arrives. Free; writing them
 *   with AI is Sidekick's switch, in Sidekick → Chat.
 *
 * Sidekick, the helper that reads chat, keeps its own page (`ai`). The
 * avatar's code, wire and saved names stay `buddy`/`cohost` (plan 236 D1).
 * The selected tab lives in app-shell, so links open a named tab and Avatar
 * reopens on the one used last.
 */
export function AvatarTab({
  tab,
  onTabChange
}: {
  tab?: AvatarTabId
  onTabChange?: (tab: AvatarTabId) => void
}): ReactElement {
  // The shell owns the tab; a page rendered on its own (tests) keeps its own.
  const [ownTab, setOwnTab] = useState<AvatarTabId>(DEFAULT_AVATAR_TAB)
  const current = tab ?? ownTab
  const selectTab = (next: AvatarTabId): void => {
    if (onTabChange) onTabChange(next)
    else setOwnTab(next)
  }
  const creatorOpen = useBuddyPetCreatorOpen()

  return (
    <PageTabs
      label="Avatar sections"
      tabs={AVATAR_TABS}
      testId="avatar-tab"
      triggerAttribute="data-videorc-avatar-tab"
      value={current}
      onValueChange={selectTab}
    >
      <TabsContent className="flex flex-1 flex-col" value="profile">
        {creatorOpen ? <BuddyPetCreator onClose={closeBuddyPetCreator} /> : null}
        {/* Plan 170: My avatars, the look panel and the onboarding share one
            backend client and one look controller. */}
        <BuddyLookClientProvider>
          <PageStack className={creatorOpen ? 'hidden' : undefined}>
            <AvatarStatus />
            <BuddyLibrarySection />
            <BuddyPersonaSection />
            <BuddyPetSettings />
          </PageStack>
        </BuddyLookClientProvider>
      </TabsContent>
      <TabsContent className="flex flex-1 flex-col" value="greetings">
        <PageStack>
          <BuddyGreetingsSection />
        </PageStack>
      </TabsContent>
    </PageTabs>
  )
}

/**
 * The Profile tab's status row (plan 239): the avatar's picture and name,
 * where viewers see it, and the way to the Scene page, where it is placed
 * and switched on for the stream and the recording. The switches keep their
 * homes (the Scene canvas, the Stream Manager), so this row never holds a
 * third copy of them. While it is not on stream, one line says how.
 */
function AvatarStatus(): ReactElement {
  const { cohostSettings, overlayLayout, runtimeInfo } = useStudioCore()
  const name = buddyDisplayName(cohostSettings?.persona.name)
  const placement = avatarPlacementView(overlayLayout.buddy)

  return (
    <div className="flex flex-col gap-3 border-b border-border p-gutter" data-slot="avatar-status">
      <div className="flex flex-wrap items-center gap-3">
        <BuddyEmblem picture={buddyPictureUrl(cohostSettings?.persona)} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-sm font-medium text-foreground"
            data-slot="avatar-status-name"
          >
            {name}
          </span>
          <p
            className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
            data-placement={placement.kind}
            data-slot="avatar-placement"
          >
            <span
              aria-hidden
              className={cn('size-1.5 shrink-0 rounded-full glass-dot', placement.tone)}
            />
            <span className="font-medium text-foreground">{placement.label}</span>
          </p>
        </div>
        <Button
          className="shrink-0"
          type="button"
          variant="outline"
          onClick={() => openWorkspaceTab('layouts')}
        >
          <SceneIcon data-icon="inline-start" />
          Place on Scene
          <ShortcutKeys
            accelerator={pageShortcutFor('layouts')!}
            className="ml-0.5"
            platform={runtimeInfo?.platform}
          />
        </Button>
      </div>
      {!overlayLayout.buddy.showOnStream ? (
        // Plan 174 G-2: nothing else says how an avatar gets on stream.
        <Alert data-testid="buddy-on-stream-note" variant="quiet">
          <AlertTitle>
            {name} isn&apos;t on stream yet. In Stream Manager, turn on &ldquo;{name} on
            stream&rdquo; to show it.
          </AlertTitle>
        </Alert>
      ) : null}
    </div>
  )
}
