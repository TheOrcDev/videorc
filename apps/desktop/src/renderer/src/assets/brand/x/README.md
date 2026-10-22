# X marks and verified checks (official)

These files come from X's **Partner Icon Kit**, sent to Videorc by X's API
team on 2026-10-08 for the Stream Manager and the rest of the app (plan 167).
The kit's glyphs come from X's current design system (`@x-clients/xds` in
x-web). Every file here is copied **byte-for-byte** from the kit.

## Files

| Shipped file                       | Kit path                                           | sha256                                                             | Used for                                     |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `x-logo-white.svg`                 | `01-x-logo/x-logo-white.svg`                       | `0cd6e00cd91336779fd6a233df7381de4dd14d3c7abecc5aba429b614eae7b93` | Stream highlight card, phone remote          |
| `x-logo-lockup-white-on-black.svg` | `01-x-logo/x-logo-lockup-white-on-black.svg`       | `97754a489565d5daafa5b05629cb00c206d38c8a630cb2f98c9fb5e78608310d` | Destination tile, dark mode                  |
| `x-logo-lockup-black-on-white.svg` | `01-x-logo/x-logo-lockup-black-on-white.svg`       | `ae97fa564e551993bc5e34de54626e586f5dd2a41d0267c277253cbcce36e50d` | Destination tile, light mode                 |
| `verified-premium-blue.svg`        | `03-verified-badges/verified-premium-blue.svg`     | `608ac8ab2dd3a63704aa168fca2e319bf6dd60f17fe55802f3715b1456f2fa60` | `verified_type: blue` (Premium / Premium+)   |
| `verified-business-gold.svg`       | `03-verified-badges/verified-business-gold.svg`    | `725ce3ce0bbd0f5919c69a21511d8032f79b82ba84703e9098b328442976fe1c` | `verified_type: business` (Verified Orgs)    |
| `verified-government-gray.svg`     | `03-verified-badges/verified-government-gray.svg`  | `616479fc4d4bae24718ec51de47a7776677a67767450374b3e8bb435413868da` | `verified_type: government`                  |

The bare mark in the app (`XPlatformIcon`) is the kit's path drawn inline,
`X_MARK_PATH` in `lib/x-mark.ts`, so it can switch between black and white
with the theme. `icons.test.ts` checks that it equals the path in
`x-logo-white.svg`, and that every hash above matches.

**Never edit these files by hand.** To update them, copy a newer kit and
update the hashes.

## Rules (from the kit's README)

- **One solid colour.** The X mark is black on light surfaces and white on
  dark. Never stretch, rotate, recolour with a gradient or add a shadow.
  Give it room.
- **At least 16px.** Preserve the aspect ratio. Videorc's platform marks are
  20px (plan 165), so this is met everywhere.
- **Verified checks keep X's production colours**: Premium `#1D9BF0`,
  Business the gold gradient, Government `#829AAB`. Never tint them and never
  invent a new badge colour. They are drawn as images, so CSS colour cannot
  reach them, and the gold file's gradient ids never enter the page.
- **Only what X sent.** A check shows only for the `verified_type` X put on
  the chat message. Anything else shows no check.
