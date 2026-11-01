import { useMemo } from 'react'

import { useStudioCore } from '@/hooks/use-studio'
import { accountFromSnapshot, type VideorcAccount } from '@/lib/account'
import { VIDEORC_WEB_LINKS, beginVideorcSignIn, openVideorcWebLink } from '@/lib/videorc-web-links'

export type UseVideorcAccount = {
  account: VideorcAccount
  signIn: () => void
  openAccount: () => void
  signOut: () => void
}

// The single owner of the desktop's Videorc PRODUCT-account state and actions.
// The account comes from the backend (account.get, surfaced by the core studio context).
// Sign in opens a state + PKCE-bound /desktop/authorize/v2 transaction. The web
// app returns only an opaque, short-lived code through the videorc:// deep-link;
// the backend exchanges it server-to-server for a durable session token.
export function useVideorcAccount(): UseVideorcAccount {
  const { account: snapshot, signOutAccount } = useStudioCore()
  const account = useMemo(() => accountFromSnapshot(snapshot), [snapshot])

  return useMemo(
    () => ({
      account,
      signIn: beginVideorcSignIn,
      openAccount: () => openVideorcWebLink(VIDEORC_WEB_LINKS.account),
      signOut: () => void signOutAccount()
    }),
    [account, signOutAccount]
  )
}
