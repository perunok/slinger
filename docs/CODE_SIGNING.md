# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

The Windows installer of Slinger (`Slinger-<version>-win-x64.exe`) and the programs it installs (`Slinger.exe` and the
native modules built from this repository) are signed with a certificate issued to **SignPath Foundation**. The signature
tells Windows (and you) that the file was built from this repository and was not changed afterwards.

## How releases are built and signed

- Every release is built from the tagged commit of <https://github.com/perunok/slinger> by GitHub Actions on GitHub-hosted
  runners ([`.github/workflows/release.yml`](../.github/workflows/release.yml)). Nothing is built or signed on a personal machine.
- The workflow uploads the unsigned build to SignPath, which checks that it came from this repository's workflow run
  (origin verification) before signing. The signing key never leaves SignPath's hardware security module.
- Every signing request is approved by hand by an approver (below) before anything is signed.
- Only files built from this repository's source are signed. Third-party files that ship inside the installer as they are
  (for example the Chromium and FFmpeg libraries that come with Electron) are not signed by us.

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [Henok Moltotal (@perunok)](https://github.com/perunok) |
| Approvers | [Henok Moltotal (@perunok)](https://github.com/perunok) |

Changes from anyone outside these roles (pull requests) are reviewed by a reviewer before they are merged. Team members use
multi-factor authentication for GitHub and SignPath.

## Privacy

This program does not transfer any information to other networked systems unless you ask it to, except the update check,
which you can turn off. See the [privacy policy](../PRIVACY.md).

## Check a signature

Right-click the downloaded installer, **Properties > Digital Signatures**: the signer is *SignPath Foundation*. Or in PowerShell:

```powershell
Get-AuthenticodeSignature .\Slinger-0.27.1-win-x64.exe | Format-List Status, SignerCertificate
```

## Report a problem

If a file signed under this policy looks malicious or tampered with, do not run it; open an issue at
<https://github.com/perunok/slinger/issues> with the file's SHA-256 hash and where you got it.
SignPath Foundation can be reached at support@signpath.io.
