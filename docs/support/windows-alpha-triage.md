# Windows Alpha support triage

Use this playbook for messages to `support@videorc.com` and for public Windows
Alpha issues. A report can be valuable without private artifacts; ask for the
smallest reproducible facts first.

## First response template

> Thanks for testing the Videorc Windows Alpha. We have recorded this report and
> will triage it against the current known issues. Please reply with the Videorc
> version, Windows 11 edition/version/build, CPU and GPU models, affected area or
> capture backend, minimal reproduction steps, expected/actual behavior, and
> whether the strict support-bundle verifier returned PASS, FAIL, or BLOCKED.
>
> Do not email credentials, stream URLs or keys, OAuth/API tokens, recordings,
> presigned links, device IDs, or raw support-bundle contents. Do not attach a
> support bundle yet. If private evidence is necessary, we will provide a private
> transfer path and ask for a bundle that passes
> `pnpm support-bundle:verify -- <file> --windows-acceptance`.

When the facts match a known issue, send the canonical workaround and known-
issues link. Do not promise a release date. When a published installer, update,
or signing failure could affect other testers, notify the release owner before
requesting more evidence.

## Label vocabulary

Apply `windows-alpha` plus one impact label, one area label, and one state label.

| Dimension | Labels                                                                                                                                                             | Use                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Impact    | `impact:blocker`, `impact:degraded`, `impact:cosmetic`                                                                                                             | Blocker means install, launch, recording integrity, privacy, security, or updater safety prevents supported use. |
| Area      | `area:hardware-compatibility`, `area:installer-signing`, `area:capture`, `area:audio`, `area:gpu-preview`, `area:updater`, `area:uninstall`, `area:support-bundle` | Choose the narrowest primary subsystem.                                                                          |
| State     | `triage:needs-info`, `triage:reproducing`, `triage:accepted`, `triage:known-issue`, `triage:fixed-candidate`                                                       | Reflect the next action, not sentiment or priority.                                                              |

Use `release:blocker` in addition to `impact:blocker` when the report invalidates
the current candidate or a required acceptance row. Only the release owner
removes it after a higher candidate has a dated PASS record.

## Escalation and response targets

| Condition                                                                                                              | Action                                                                                                                          | Initial response target |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Credential, privacy, security, malware, unexpected publisher, or signature/timestamp failure                           | Stop public artifact exchange, move security-sensitive details to a private advisory, and notify the release owner immediately. | Same working hour       |
| Install/launch failure on supported Windows 11 x64, corrupt recording, leaked child process, or broken accepted update | Apply `release:blocker`; disable or hold rollout if the production candidate is implicated.                                     | 4 working hours         |
| Hardware-specific capture/audio/GPU failure with a safe workaround                                                     | Record exact CPU/GPU/backend, add or link the known issue, and preserve workaround wording.                                     | 1 working day           |
| Cosmetic or documentation issue                                                                                        | Accept with reproducible details and schedule normally.                                                                         | 2 working days          |

## Privacy-safe handoff checklist

- Confirm app version, release ID, Windows build, CPU/GPU, and capture backend.
- Confirm whether the installer came from the authenticated production route or
  a named private candidate; never request a presigned URL.
- Record verifier verdict only in public systems.
- Before accepting a private support bundle, require the strict verifier PASS
  and provide an approved private transfer path.
- Keep recordings, bundles, user paths, device identifiers, and credentials out
  of GitHub, changelog entries, and committed acceptance notes.
- Link the final issue, known issue, candidate, and acceptance record without
  duplicating sensitive evidence.
