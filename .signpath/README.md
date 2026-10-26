# SignPath setup

Windows releases are signed by [SignPath](https://signpath.io) under the SignPath Foundation open-source programme
(see [docs/CODE_SIGNING.md](../docs/CODE_SIGNING.md)). The release workflow (`.github/workflows/release.yml`, job `windows`)
signs in two steps, each a signing request that an approver approves in SignPath:

1. `app`: `Slinger.exe` from the unpacked app, before the installer is built around it.
2. `installer`: the NSIS installer `Slinger-<version>-win-x64.exe`.

## One-time setup (project owner)

1. Apply at <https://signpath.org/apply> for the free open-source subscription.
2. In SignPath: add the trusted build system **GitHub.com** and link it to the project; create the project (slug `slinger`)
   with the artifact configurations in [`artifact-configurations/`](artifact-configurations/) (slugs `app` and `installer`) and
   the signing policy SignPath Foundation provides (usually `release-signing`).
3. Create an API token for a CI user with *Submitter* rights on that policy.
4. In GitHub (Settings > Secrets and variables > Actions):
   - secret `SIGNPATH_API_TOKEN`: the token;
   - variable `SIGNPATH_ORGANIZATION_ID`: the organization id;
   - optional variables `SIGNPATH_PROJECT_SLUG` (default `slinger`) and `SIGNPATH_SIGNING_POLICY_SLUG` (default
     `release-signing`).

Without `SIGNPATH_API_TOKEN` the workflow builds an unsigned installer, as before. Tag pushes sign; a manual run signs only
with the **sign** input ticked.
