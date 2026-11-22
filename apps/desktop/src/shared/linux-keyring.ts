// Plan 257 S18: main's refusal when Videorc account sign-in starts on a Linux
// desktop with no keyring Videorc can use. Shared so the renderer shows it as
// is instead of the generic "couldn't reach your system keyring" sentence.

export const LINUX_KEYRING_SIGN_IN_REFUSAL =
  'Signing in needs a keyring (Secret Service), and Videorc found none it can use. Install GNOME Keyring or KWallet, make sure it starts with your desktop, then restart Videorc. Health has the details.'
