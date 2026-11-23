# Videorc Cloud: public launch acceptance, 2026-11-23

> **Status: DRAFT.** The owner's sign-off and the decisions are recorded.
> The billing results and the switch-on smoke are placeholders
> (`TODO(coordinator)`), filled in at launch. This record merges when the
> launch switch is on and the smoke has passed.
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

`TODO(coordinator)`: from the billing thread's report
(`~/cloud-test/reports/2026-11-23-cloud-launch/billing/`). One row each,
pass or fail, with the evidence's name. No prices.

| Path                                   | Result | Evidence |
| -------------------------------------- | ------ | -------- |
| Buy Premium, monthly and yearly        | TODO   | TODO     |
| Buy Max, monthly and yearly            | TODO   | TODO     |
| Upgrade Premium → Max                  | TODO   | TODO     |
| Downgrade Max → Premium, at period end | TODO   | TODO     |
| Cancel                                 | TODO   | TODO     |
| Refund                                 | TODO   | TODO     |
| Webhook replay is idempotent           | TODO   | TODO     |
| A discount code                        | TODO   | TODO     |
| The emails sent                        | TODO   | TODO     |
| The desktop reads Max                  | TODO   | TODO     |
| S6: the logo on the live Max products  | TODO   | TODO     |

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
- [ ] Web PRs ready to merge with the switch: the legal update
      (videorc-web #193) and the launch blog post (videorc-web #194).

## The switch and its smoke (plan 245 S7)

`TODO(coordinator)`: fill in at launch.

- Switch flipped (Max on sale in Production) and redeployed at: `TODO`
  (deployment: `TODO`).
- `/max` answers 200: `TODO`
- The home page's pricing shows three plans: `TODO`
- `/terms` and `/privacy` show the cloud sections, LiveKit and the launch
  date: `TODO`
- A real Max checkout by the owner opens Creem live (completed and
  refunded, or stopped at Creem's page): `TODO`
- The owner's own account shows Max on `/account` and in the desktop:
  `TODO`
- A Premium account other than the owner's has its cloud hours
  (`GET /api/cloud/allowance` says enabled): `TODO`
- `/blog/videorc-cloud` is live: `TODO`

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
