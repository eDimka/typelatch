# Release automation sources

Reviewed on 2026-10-06. These findings inform the release design. They do not establish that external npm or GitHub settings have been configured.

## Version contract

SemVer requires a declared public API, integer `MAJOR.MINOR.PATCH` without leading zeros, and immutable released contents. After 1.0, incompatible API changes require a major increment, compatible additions or deprecations require a minor increment, and compatible fixes require a patch increment. Version zero denotes initial development. Prereleases sort below their corresponding normal version; build metadata does not affect precedence. [SemVer 2.0.0](https://semver.org/)

Recommended Typelatch policy: document CLI behavior, MCP contracts, public exports and persisted formats as the compatibility surface. Use minor increments for features or breaking changes while on 0.x, with explicit migration notes for breaks. Accept only canonical `v<version>` release tags matching package and lockfile versions. Restrict prereleases to `alpha.N`, `beta.N` and `rc.N`, and reject build metadata. Those restrictions are project policy, since SemVer permits other identifiers and metadata. A format validator cannot determine whether an API change is semantically breaking; review remains necessary.

## Publishing identity

npm trusted publishing requires npm 11.5.1 or newer, Node 22.14.0 or newer, a GitHub hosted runner, and `id-token: write`. Bind the exact owner, repository, workflow filename and environment. The package repository URL must match. Public repositories publishing public packages receive automatic provenance. New configurations must publish successfully within two days. Explicitly allow direct publishing because new configurations default to staging. OIDC dist-tag mutation separately requires npm 11.21.0 or newer on the 11.x line, or 12.2.0 or newer, plus dist-tag permission. `npm whoami` does not validate this trust. With reusable publishing workflows, npm validates the caller filename. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Keep publication directly in `release.yml`, with environment `npm-release`. A reusable workflow used only for verification does not relocate the publish job. Prefer Node 24 and a deliberately pinned npm release. Do not require an npm token in the publish job.

Official CLI configuration is available from npm 11.15.0. It requires an existing package, write access and account 2FA; bypass 2FA granular tokens and basic authentication are unsupported. Inspect existing trust before creating a configuration. [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

```sh
npm trust list typelatch --json
npm trust github typelatch --file release.yml --repo eDimka/typelatch --environment npm-release --allow-publish
```

The CLI reference's single configuration limit conflicts with the newer trusted publishing guide. Do not rely on that stale limit. Trust setup success alone does not prove the first publish will authenticate.

## Build and publish phases

Use a tag push trigger and validate the exact version before publication. Build and test without publish privileges, pack once, then pass the resulting tarball and checksum to the publish job. Limit write permissions to the jobs that need them. Pin third party actions to verified full commit SHAs. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use)

Artifact uploads from v4 onward are immutable and require unique names. They expose an artifact ID and SHA256 digest. Overwriting deletes the previous artifact rather than preserving its identity. Retention is finite, and ordinary archive upload does not preserve executable file permissions. Store the already packed npm tarball and download by its build output artifact ID. [upload-artifact documentation](https://github.com/actions/upload-artifact)

Publish the tarball with an explicit dist-tag: `latest` for the newest stable release, `next` for accepted prereleases. npm defaults to `latest` and permanently reserves each published package name and version. Therefore a prerelease must never rely on the default tag, and a retry cannot replace an existing version. [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

Recommended retry policy: compare the registry's `dist.integrity` with the preserved tarball before skipping a publication already present. Fail on a mismatch, missing integrity or indeterminate registry response. After npm succeeds, a later GitHub failure should resume from the same verified artifact. Do not move `latest` backward when replaying an older release. An artifact name using only the current run attempt is insufficient when rerunning failed jobs without rerunning the successful build.

GitHub reruns retain the original SHA, ref and triggering actor's privileges. They are available for 30 days, with at most 50 reruns per run. Expired artifacts and changes required to a tagged workflow therefore need an explicit recovery decision, not silent rebuilding or moving the tag. [GitHub workflow reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

## Release immutability

Enable repository release immutability. Create a draft, upload the verified tarball and checksum, then publish. Publication locks assets and the associated tag; notes remain editable. [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [enabling release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)

Use `gh release create --verify-tag` to reject missing remote tags. Current GitHub CLI also performs draft creation, asset upload and publication internally when files are supplied to `gh release create`. For recovery, verify existing assets instead of replacing them. [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create)

Protect release tags before publication as well. GitHub rulesets can restrict tag creation, updates and deletion, with defined bypass actors. Immutability alone starts protecting a tag when its release is published. [Ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

## Established package examples

Vite separates release detection from its privileged publish job, uses a release environment, disables persisted checkout credentials, pins actions by SHA, uses OIDC and derives release notes from its changelog. Its current workflow detects release commits on branches; it is evidence for these controls rather than a tag trigger example. [Vite workflow at fea5b21](https://github.com/vitejs/vite/blob/fea5b21dd9524ed7308632407b996f1fe5942c9c/.github/workflows/publish.yml)

Vitest likewise isolates release detection, uses an environment and OIDC, disables package manager caching in the release job, builds before staging publication and marks release identity explicitly. It also uses branch release detection. [Vitest workflow at f5dd99e](https://github.com/vitest-dev/vitest/blob/f5dd99ed083ba9035f378438e7a9dc9c5ce1c674/.github/workflows/publish.yml)

Typelatch should retain the user's requested tag push trigger and adopt the relevant isolation and integrity controls. npm's own trusted publishing example demonstrates `push.tags: ['v*']`; a broad trigger still needs exact SemVer validation in the workflow. [npm GitHub Actions example](https://docs.npmjs.com/trusted-publishers/#github-actions-configuration)
