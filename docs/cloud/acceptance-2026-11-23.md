# Videorc Cloud: public launch acceptance, 2026-11-23

> **Status: DRAFT.** The switch is on (2026-11-23, about 19:22 UTC), the
> billing pass and the switch-on smoke are recorded. Still open
> (`TODO(coordinator)`): the owner's own Max purchase, a Premium desktop
> showing the cloud, and the Linux and Windows cloud runs.
>
> Prices, costs, margins and production env values stay in the private web
> repo (`videorc-web`, plan 245 and plan 185). This public record names
> none of them.

## What launched

Videorc Cloud goes public with Videorc Max going on sale (web plan 245, the
last mile of desktop plan 184 and web plan 185):

- **Solo shows through the cloud** (plan 184 Phase 1, on managed media since
  plan 234): the stream stays on air when the computer drops, with Be right
  back, and resumes when it is back.
- **Talk shows with browser guests** (plan 184 Phase 2, plan 224): guests
  join from a link in a browser, with no app and no account.
- **Continue on another device** (plan 243): a live show moves to a phone, a
  browser or another computer without ending.
- **Cloud recordings** of talk shows, in the desktop Library and the web
  Library.
- **Videorc Max**, on sale next to Premium.

## The owner's sign-off

The owner (OrcDev) tested Videorc Cloud himself before the launch: a **solo
stream acceptance** and a **talk show with guests**. In the coordinator
chat on 2026-11-23 he confirmed the launch (W95 Q93: "Yes"). His relayed
note:

> "I tested everything already. Start going live everywhere and do
> everything."

What that covers, against plan 184's acceptance lines:

| Plan 184 acceptance                                                                                                                           | Recorded as                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Phase 1: a stream to the owner's real channels through the cloud; pull the network, quit and relaunch to resume, update the app mid-stream    | Owner sign-off ("solo stream acceptance"). The individual steps, durations and timings were not logged here. |
| Phase 2: a talk show with guests (one on a phone browser) to 3+ platforms; the recording downloads; kill the Mac mid-show and guests carry on | Owner sign-off ("a talk show with guests"). The individual steps were not logged here.                       |

`TODO(coordinator)`: if the owner has notes, links (the broadcast, the VOD,
the recording) or the guest count and platforms, add them here. Otherwise
this table stands as an owner attestation, not a step-by-step log.

## Decisions

- **Max launches with Cloud.** Max goes on sale together with Videorc Cloud
  for Premium. Its hours, guests and price are plan 185's and plan 245's
  (D1 = A: hours as built, no "unlimited").
- **Everything is named publicly:** talk shows with browser guests, continue
  from another device, and cloud recordings.
- **Platforms: all three at launch** (owner, 2026-11-23: "yes we want all
  three platforms at launch"). Videorc Cloud and hosting talk shows are
  offered on the **macOS Beta** and on the **Windows 11 and Linux alphas**,
  always labelled alpha there, with nothing specific promised that hasn't
  run. Guests can join from any browser. What was known when this was
  decided:
  - Windows 11 alpha and Linux alpha 0.37.0 shipped owner-waived, with no
    physical acceptance (`docs/acceptance/windows-alpha/0.37.0-alpha.1.json`,
    `docs/acceptance/linux-alpha/0.37.0-alpha.1.json`).
  - Cloud has never run for real on Windows. On Linux it ran on the old
    node path (`smoke:cloud-solo` on 2026-10-21), never on LiveKit; plan 257
    S13 (screen share and desktop audio to guests) and S14 (Cloud on Linux)
    are still open.
  - Plan 184 D19: solo shows and talk-show hosts are macOS first.
  - The desktop doesn't hide the Cloud and Guests controls on Windows or
    Linux: they are gated by plan, not by OS. A paying alpha user can reach
    them.
  - `TODO(coordinator)`: the Linux cloud run on ogre (solo and a talk show
    with a guest, on LiveKit) and any Windows run. Record what passed and
    what didn't; the copy names only what passed.
- **Billing is proven in Creem test mode before the switch**, on a branch
  preview with its own database, never on production data (plan 245 D3).
  Any money bug blocks the launch.
- **Posts and emails go out only on the owner's Send.** The copy is drafted
  for him (X, Discord, Kit, the changelog text).

## Billing in Creem test mode (plan 245 S2, S3, S6)

Run on the plan 245 branch preview with its own Neon branch database and
Creem test mode, never on production data. Evidence is in the private launch
reports (`billing/progress.md`, `billing/db/`, `billing/chrome/`,
`billing/emails/`). Four money bugs were found and fixed before the switch
(videorc-web #195, #198, #199, #201; #200 for the webhook logs), each proven
again in test mode.

| Path                                   | Result                                                                                                                                     | Evidence                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Buy Premium, monthly and yearly        | Pass                                                                                                                                       | `db/*-pm-after-premium-month.txt`, `db/*-py-after-buy.txt`                             |
| Buy Max, monthly and yearly            | Pass                                                                                                                                       | `db/*-mm-after-buy.txt`, `db/*-my-after-buy.txt`                                       |
| A second checkout while subscribed     | Pass: refused, the account page changes the plan instead                                                                                   | terminal                                                                               |
| Upgrade Premium → Max, monthly         | Pass: Max at once, charged the difference                                                                                                  | `db/*-up-after-upgrade.txt`                                                            |
| Upgrade Premium monthly → Max yearly   | Failed (Creem's refund of the unused month briefly ended the plan); fixed in #195, then pass ×3                                            | `db/blocker-upgrade-refund-ends-plan.txt`, `db/fix-proof-yearly-upgrade-x3.txt`        |
| Downgrade Max → Premium, at period end | Pass: Max kept to the period end, nothing charged; undoing it also passes                                                                  | `db/*-dn-after-downgrade.txt`, `db/*-dn-after-keep-max.txt`                            |
| Yearly → monthly                       | Failed (Creem charged at once and dropped the year); fixed in #198: no self-serve yearly → monthly, and the dialogs say what Creem charges | `db/blocker2-yearly-to-monthly-charges-now.txt`, `db/fix2-proof-yearly-to-monthly.txt` |
| Cancel                                 | Pass: the plan stays to the period end, then ends                                                                                          | `db/*-cx-after-cancel.txt`                                                             |
| Refund, full and partial               | Pass: a full refund ends the plan; a partial one keeps it                                                                                  | `chrome/03-08`                                                                         |
| Webhook replay is idempotent           | Failed (a dashboard Resend carries a new event id); fixed in #201, then pass                                                               | `db/blocker4-resend-old-event.txt`, `db/fix4-proof-resend.txt`                         |
| A discount code                        | Pass: applied at checkout. Upgrading a discounted subscription is refused by Creem with nothing charged (contact support)                  | `chrome/09-12`, progress notes                                                         |
| The emails sent                        | Pass after #199: purchase and upgrade emails name the plan bought and what it gives                                                        | `emails/` (purchase and upgrade, monthly and yearly, light and dark)                   |
| The desktop reads Max                  | Pass: capabilities give Max's cloud hours, guests and retention, with a signed entitlement token                                           | `db/cap-mm.txt`, `db/cap-pm.txt`                                                       |
| S6: the logo on the live Max products  | Done: both live Max products show the logo; nothing bought                                                                                 | `chrome/20-33`                                                                         |

## Production before the switch

`TODO(coordinator)`: tick when done; values stay in Vercel and the private
web repo.

- [x] Cloud on: the kill switch is off and talk shows are allowed (checked
      2026-11-23, unchanged).
- [x] Shows run on managed media (LiveKit), with its keys and the
      recordings store set (checked 2026-11-23).
- [x] The owner's cost page is limited to the owner's account (checked
      2026-11-23).
- [x] The monthly cloud budget is set (the owner picked the number;
      set 2026-11-23, takes effect on the next production deploy).
- [x] The concurrent-show cap is raised for the public (the owner picked
      the number; set 2026-11-23, takes effect on the next production
      deploy).
- [x] The legal update (videorc-web #193) merged with the switch.
- [x] The launch blog post (videorc-web #194) merged on the owner's
      approval.

## The switch and its smoke (plan 245 S7)

- **Switch flipped:** Max on sale in Production at 19:20:56 UTC on
  2026-11-23; the legal update (#193) merged at 19:21:07 UTC, and its
  production deploy (`videorc-7ia9ie1zb`) was ready at about 19:21:52 UTC.
  **Videorc Cloud and Max have been live since about 19:22 UTC.** The same
  deploy applied the monthly budget and the show cap.
- Minutes before the switch, the same smoke saw `/max` 404, no cloud
  sections in the legal pages, and Max checkout refused as not on sale.
- `/max` answers 200: **pass**.
- The home page's pricing (`/#pricing`) shows three plans, Open Source,
  Premium and Max: **pass**.
- `/terms` and `/privacy` show the cloud sections, LiveKit and "Last
  updated: November 23, 2026": **pass**. The old "media server in the EU"
  wording is gone.
- A Max checkout from a throwaway production account opens Creem **live**
  (no test banner), monthly and yearly, with the Max product, its logo and
  the plan's prices: **pass**. Stopped at the payment form; nothing paid.
- The owner's own account shows Max on `/account` and in the desktop:
  `TODO(coordinator)`: the owner's purchase (plan 245 S7's done line).
- A Premium account other than the owner's has its cloud hours: **not run
  on production**, for want of a Premium session. While managed media is
  on, the capabilities route reports the cloud only to a Videorc desktop
  (0.26.0 or later), so a browser can't show it. Preview evidence
  (`db/cap-pm.txt`) has Premium's hours and guest. `TODO(coordinator)`:
  the owner's or a Premium tester's desktop showing Videorc Cloud on.
- The owner's cost page: not reached (owner-only).
- `/blog/videorc-cloud`: live since 20:12 UTC on the owner's approval
  (videorc-web #194, a23b3fd76), with its link-card image checked. The
  site's Cloud wording names all three platforms, alphas labelled, since
  20:14 UTC (videorc-web #202, f084d2aeb).

Screenshots: `~/.local/share/ghostex/i/cloud-launch-smoke/` on the owner's
Mac (`pre-*` before the switch, `live-*` after).

## Follow-ups (not launch blockers unless marked)

- **Label Cloud and hosting talk shows as alpha in the Windows and Linux
  apps**, since they're offered there before a full pass (plan 257 S13 and
  S14 for Linux; a Windows pass for both).
- **The web's unit suite has 21 pre-existing reds** on `main` in the
  managed-media and program tests (recorded since 2026-11-20). They are
  test drift, not a launch change, but they hide new reds in the cloud's
  own code until fixed.
- **The first month** (plan 245 S8): watch the owner's cost page weekly,
  spend against budget, accounts past 150% of their hours.
