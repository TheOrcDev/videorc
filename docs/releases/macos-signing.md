# macOS Signing And Notarization

Videorc beta DMGs use the same Apple Developer signing shape as AgentPacks:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

`CSC_LINK` should be the base64-encoded Developer ID Application `.p12` export
or another electron-builder supported certificate link. Do not commit the
certificate, password, Apple ID, or app-specific password.

## GitHub Secrets

Verify the source AgentPacks secret names:

```sh
gh secret list --repo TheOrcDev/agent-packs-desktop
```

Install the same named secrets on Videorc after exporting the unused
AgentPacks certificate material from the secure source of truth:

```sh
gh secret set CSC_LINK --repo TheOrcDev/videorc --body-file ./DeveloperIDApplication.p12.base64
gh secret set CSC_KEY_PASSWORD --repo TheOrcDev/videorc
gh secret set APPLE_ID --repo TheOrcDev/videorc
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo TheOrcDev/videorc
gh secret set APPLE_TEAM_ID --repo TheOrcDev/videorc
```

The local keychain identity currently expected for beta signing is:

```text
Developer ID Application: Uros Miric (C2PA37RB58)
```

## Create `CSC_LINK` From The Local Keychain

First confirm the identity and team id without printing any secret material:

```sh
security find-identity -v -p codesigning
security find-certificate -c "Developer ID Application: Uros Miric" -p \
  | openssl x509 -noout -subject -issuer -serial -dates
```

The expected team id is `C2PA37RB58`.

Recommended exact export path:

1. Open **Keychain Access**.
2. Find `Developer ID Application: Uros Miric (C2PA37RB58)`.
3. Export it as `DeveloperIDApplication.p12`.
4. Use a new random archive password. This value becomes `CSC_KEY_PASSWORD`.
5. Base64 encode the archive for Electron Builder:

   ```sh
   base64 -i DeveloperIDApplication.p12 -o DeveloperIDApplication.p12.base64
   ```

If the signing keychain only contains the intended Developer ID identity, a CLI
export can be used instead. This may prompt for keychain access:

```sh
tmp_dir="$(mktemp -d)"
CSC_KEY_PASSWORD="$(openssl rand -base64 32)"

security export \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -t identities \
  -f pkcs12 \
  -P "$CSC_KEY_PASSWORD" \
  -o "$tmp_dir/DeveloperIDApplication.p12"

base64 -i "$tmp_dir/DeveloperIDApplication.p12" \
  -o "$tmp_dir/DeveloperIDApplication.p12.base64"
```

Install the generated values:

```sh
gh secret set CSC_LINK --repo TheOrcDev/videorc --body-file "$tmp_dir/DeveloperIDApplication.p12.base64"
printf '%s' "$CSC_KEY_PASSWORD" | gh secret set CSC_KEY_PASSWORD --repo TheOrcDev/videorc --body-file -
```

Then set the notarization credentials:

```sh
gh secret set APPLE_ID --repo TheOrcDev/videorc
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo TheOrcDev/videorc
printf '%s' 'C2PA37RB58' | gh secret set APPLE_TEAM_ID --repo TheOrcDev/videorc --body-file -
```

Confirm the remote repository has the required release secrets before spending
an Actions run:

```sh
pnpm release:secrets:macos
```

Clean up local certificate artifacts immediately after the secrets are installed:

```sh
rm -rf "$tmp_dir"
unset CSC_KEY_PASSWORD
```

Run the preflight before cutting a beta:

```sh
pnpm release:preflight:macos
```

The release workflow also runs this preflight before the expensive verification
and packaging steps, so missing signing or notarization secrets fail early.
