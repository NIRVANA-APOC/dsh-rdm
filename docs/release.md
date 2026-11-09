# Release process

`dsh-rdm` is one npm package that bundles prebuilt kernels, so a release is not
just `npm publish`: the five native kernels are built first by
[`.github/workflows/prebuilt-kernels.yml`](../.github/workflows/prebuilt-kernels.yml)
and packed into the plugin tarball. The same tarball is then attached to the
GitHub release and published to npm, which keeps the two installation paths
byte-identical.

## What a release does

Pushing a `v*` tag — or dispatching **Prebuilt kernels** with the tag selected
— runs:

1. `build` — compiles `rdm-kernel` natively on linux-x64, linux-arm64,
   win32-x64, darwin-x64 and darwin-arm64 runners and smoke-tests each binary.
2. `package` — assembles `lib/` plus all five kernels, verifies the set,
   `npm pack`s the plugin tarball and records the kernel sha256 list.
3. `release` — creates the GitHub release `dsh-rdm v<version>` with the tarball,
   the individual kernels and the sha256 list. The tag must match
   `package.json`'s version, and **the release notes are the tag's `[X.Y.Z]`
   section from [`CHANGELOG.md`](../CHANGELOG.md)** — the run fails if that
   section is missing. Bump the version and add the changelog section before
   tagging; `node scripts/check-release.mjs` validates the pair locally.
4. `publish-npm` — publishes that exact tarball to
   [npmjs.com/package/dsh-rdm](https://www.npmjs.com/package/dsh-rdm) with npm
   trusted publishing over GitHub OIDC (`id-token: write`), then verifies the
   registry sha1/sha512 and the provenance attestation. The repository stores no
   `NPM_TOKEN` and no other npm credential.

Stable versions move the `latest` dist-tag; prerelease versions
(`vX.Y.Z-...`) publish under `next`.

## One-time npm setup (package owner, required before the first release)

npm cannot be configured from CI; the trusted publisher is registered on npm's
website. Do this immediately before the first release that should publish — a
newly created trusted publisher must complete its first successful publish
within two days, or it expires and must be re-created.

1. Enable two-factor authentication on the npm account that maintains
   `dsh-rdm` (npm requires 2FA for publishing and package settings).
2. Open <https://www.npmjs.com/package/dsh-rdm> → **Settings** →
   **Trusted publishing** → **Add trusted publisher** → **GitHub Actions**.
3. Enter exactly:

   | Field | Value |
   | --- | --- |
   | Organization or user | `NIRVANA-APOC` |
   | Repository | `dsh-rdm` |
   | Workflow filename | `prebuilt-kernels.yml` |
   | Environment name | leave blank |

   Use only the file name (`prebuilt-kernels.yml`), not a path. All fields are
   case-sensitive and are validated at publish time, not when the form is saved.
4. Under **Allowed actions**, enable **npm publish** (staging alone is not
   enough). Configurations created after 2026-09-03 default to
   `npm stage publish` only; a direct `npm publish` is rejected until this is
   enabled.
5. Save, then push the release tag / dispatch the workflow.

If the publish job fails with `ENEEDAUTH` or a bare 404 even though the form
looks right, the usual causes are: the workflow filename does not match
(including the `.yml`), the publish job lacks `id-token: write`, the
`repository.url` in `package.json` does not match
`https://github.com/NIRVANA-APOC/dsh-rdm`, or the configuration expired before
its first successful publish. Fix the mismatch by deleting and re-creating the
trusted publisher — npm does not validate the fields when they are saved.

Optional hardening after the first trusted publish succeeds: package
**Settings** → **Publishing access** → *Require two-factor authentication and
disallow tokens*. Trusted publishers keep working; long-lived tokens stop
working.

## Cutting a release

1. Bump `version` in `package.json`, refresh the README/verification docs as
   needed, run the build and test suite, then commit. Make sure the tag includes
   the current `.github/workflows/prebuilt-kernels.yml` (merge the workflow
   change before tagging, or the release will not publish to npm).
2. Tag and push:

   ```bash
   git tag v0.2.2
   git push origin v0.2.2
   ```

   Equivalently: **Actions → Prebuilt kernels → Run workflow**, select the tag
   under *Use workflow from*, and run (this is how `v0.1.2` was built).
3. Watch the run. The final **Publish to npm** job prints the packed manifest,
   the registry sha1 and the provenance line, and writes a job summary.
4. Verify from anywhere:

   ```bash
   npm view dsh-rdm@0.2.2 version dist.shasum dist.integrity dist.attestations
   npm view dsh-rdm dist-tags
   ```

   In a project that installed from npm, `npm audit signatures` checks the
   registry signatures and provenance attestations.

## Retries and idempotency

- **Version already exists with the same tarball.** The publish step is skipped
  with a notice, so *Re-run failed jobs* is safe and never tries to overwrite a
  version.
- **Version already exists with different bytes.** The job fails before
  contacting the registry: npm versions are immutable, so cut a new version
  rather than trying to replace one.
- **The publish failed after the GitHub release was created.** Open the failed
  run and use **Re-run failed jobs**. The `package` artifact from that run is
  reused, so npm receives exactly the bytes the release attached (artifact
  retention is 90 days). Re-dispatching the tag instead fails in the `release`
  job, because the release already exists.
- **The trusted publisher configuration was wrong.** Fix it on npmjs.com first.
  A misconfigured publish fails before any registry write, then re-run failed
  jobs.

## Why trusted publishing instead of a token

npm retired classic publish tokens at the end of 2025 and requires 2FA for
publishing. Trusted publishing replaces a long-lived `NPM_TOKEN` secret with a
short-lived OIDC token scoped to this repository, workflow file and (optionally)
environment. For a public repository publishing a public package it also
generates provenance automatically, which the publish job asserts via
`dist.attestations`.
