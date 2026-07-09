# Windows Code Signing (Azure Trusted Signing)

The Windows installer is signed with Azure Trusted Signing so testers stop
seeing the SmartScreen "Unknown publisher" warning. Signing happens in the
`windows.yml` installer job whenever the `AZURE_*` repo secrets are available;
fork PRs (no secrets) build unsigned instead of failing. The signing config is
the `apps/desktop/electron-builder.windows-signed.yml` overlay — deliberately
separate from the base config, because electron-builder hard-fails any build
that has `win.azureSignOptions` without Azure credentials in the environment.

## One-time Azure setup (owner, in the Azure portal)

1. **Create the Trusted Signing account.** Azure portal → "Trusted Signing
   Accounts" → Create. Pick a region (the overlay assumes **West Europe**,
   endpoint `https://weu.codesigning.azure.net` — if you pick another region,
   update `endpoint` in the overlay). SKU: Basic (~$9.99/month). Suggested
   name: `videorc-signing` (the overlay assumes this).
2. **Identity validation.** In the account: Identity validations → New →
   **Individual** (or Organization if/when Videorc is a registered business).
   This is the slow step — government ID verification, typically hours to a
   few days. The certificate CN will be your validated legal name.
3. **Certificate profile.** In the account: Certificate profiles → Create →
   type **Public Trust**, linked to the finished identity validation.
   Suggested name: `videorc-public-trust` (the overlay assumes this).
4. **CI service principal.** Microsoft Entra ID → App registrations → New
   (e.g. `videorc-ci-signing`) → create a **client secret** (note the expiry;
   it must be rotated). Then back on the Trusted Signing account: Access
   control (IAM) → add role assignment **Trusted Signing Certificate Profile
   Signer** → to that app registration.
5. **GitHub secrets** (repo `TheOrcDev/videorc`):

   ```sh
   gh secret set AZURE_TENANT_ID     # Entra ID → tenant (directory) ID
   gh secret set AZURE_CLIENT_ID     # app registration → application (client) ID
   gh secret set AZURE_CLIENT_SECRET # the client secret VALUE (not its ID)
   ```

6. **Confirm the overlay values.** `endpoint`, `codeSigningAccountName`, and
   `certificateProfileName` in `apps/desktop/electron-builder.windows-signed.yml`
   must match what you created in steps 1 and 3.

## How it runs

- `pnpm dist:desktop:windows:signed` — the signed variant of the Windows dist
  pipeline (Windows host only; needs the three `AZURE_*` env vars).
- The `windows.yml` installer job picks signed vs unsigned by whether
  `AZURE_CLIENT_ID` is present, then a fail-closed step asserts
  `Get-AuthenticodeSignature` returns `Valid` on the built exe whenever
  signing was requested.
- electron-builder installs the `TrustedSigning` PowerShell module itself and
  timestamps against `http://timestamp.acs.microsoft.com` by default.

## Expectations and follow-ups

- Trusted Signing certs are short-lived and rotated by the service; the
  timestamp countersignature keeps installers valid after rotation.
- SmartScreen reputation with Trusted Signing is effectively immediate, but a
  first-ever download of a brand-new binary can still occasionally prompt.
- TODO once the cert is issued: set `win.azureSignOptions.publisherName` in
  the overlay to the cert's exact subject CN, so electron-updater can verify
  update signatures when the Windows auto-update feed ships.
- TODO: client secrets expire — set a calendar reminder for the expiry chosen
  in step 4 and rotate `AZURE_CLIENT_SECRET`.
