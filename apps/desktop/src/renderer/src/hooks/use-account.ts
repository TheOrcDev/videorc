import { useMemo } from 'react'

import { SIGNED_OUT_ACCOUNT, type VideorcAccount } from '@/lib/account'
import { VIDEORC_WEB_LINKS, openVideorcWebLink } from '@/lib/videorc-web-links'

export type UseVideorcAccount = {
  account: VideorcAccount
  signIn: () => void
  openAccount: () => void
  signOut: () => void
}

// The single owner of the desktop's Videorc PRODUCT-account state and actions.
// Real desktop web auth + token storage land here later (the rest of the UI
// reads this hook, never re-implementing account behavior). Until that backend
// exists it stays signed-out — no tokens are stored — and the actions just open
// the web account/login pages. Sign out is a no-op for now because there is no
// session to clear.
export function useVideorcAccount(): UseVideorcAccount {
  return useMemo(
    () => ({
      account: SIGNED_OUT_ACCOUNT,
      signIn: () => openVideorcWebLink(VIDEORC_WEB_LINKS.login),
      openAccount: () => openVideorcWebLink(VIDEORC_WEB_LINKS.account),
      signOut: () => {}
    }),
    []
  )
}
