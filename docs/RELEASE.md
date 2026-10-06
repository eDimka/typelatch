# Releases

GitHub Actions owns the release build and publication. The only release trigger is a pushed annotated version tag. Local builds and tarballs are verification aids and must not be published.

## Version contract

Typelatch follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Its public compatibility surface includes CLI commands and JSON output, MCP tool schemas and results, documented public exports, configuration and persisted formats. Compatibility includes the documented guarantees around package identity and evidence states.

During 0.x development, compatible fixes increment PATCH. Features and incompatible changes increment MINOR. Incompatible changes require explicit migration notes. From 1.0, incompatible changes increment MAJOR, compatible additions and deprecations increment MINOR, and compatible fixes increment PATCH. Reviewers determine the semantic impact; tag syntax alone cannot determine compatibility.

Release tags use `vMAJOR.MINOR.PATCH`, with no leading zeros. Previews use `vMAJOR.MINOR.PATCH-alpha.N`, `-beta.N`, or `-rc.N`. Typelatch deliberately excludes other prerelease identifiers and build metadata. Those are project restrictions, not restrictions imposed by SemVer. Stable releases publish to npm `latest`; previews publish to `next`. A new publication must be newer than all published stable versions and its target distribution tag. Released versions and tag targets never change.

The tag, `package.json`, both root versions in `package-lock.json`, and one complete changelog section must agree. The MCP handshake reads package metadata so it cannot carry a separate version.

## One time repository setup

Enable immutable releases and protect `v*` tags against updates and deletion. Create the `npm-release` environment with a `v*` tag deployment policy. Allow `v*` tags in the existing `github-pages` environment as well as its `main` branch policy.

An npm package owner with account 2FA must configure a trusted publisher for package `typelatch`, repository `eDimka/typelatch`, workflow `release.yml`, environment `npm-release`, and direct publishing permission. Inspect existing configuration before adding it:

```sh
npx --yes --package=npm@11.21.0 npm trust list typelatch --json
npx --yes --package=npm@11.21.0 npm trust github typelatch \
  --file release.yml --repo eDimka/typelatch \
  --environment npm-release --allow-publish
```

Authenticate the owner account with `npm login` if necessary. This authentication provisions trust; it does not build or publish the package. Do not add an npm token to GitHub Actions. npm requires the first successful publication within two days of a new trust configuration. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [the trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Prepare and release

1. Gather completed changes in a release pull request. Choose the semantic increment, update package and lockfile versions together, write the changelog and migration notes, and update the website installation pins. For example, `npm version minor --no-git-tag-version` updates metadata without creating the release trigger.
2. Run `npm ci`, `npm run test:release`, `npm run release:check`, and `npm run site:check`. Review the package contents and release notes. CI also runs retrieval, workspace, support, agent walkthrough and browser checks.
3. Merge the reviewed release pull request after its checks pass. Fetch `origin/main` and identify the exact merged commit. Do not include unrelated development work.
4. Confirm repository and npm trust configuration, then create and push one annotated tag. For the prepared 0.3.0 release:

```sh
git fetch origin main
git tag -a v0.3.0 origin/main -m 'Typelatch 0.3.0'
git push origin refs/tags/v0.3.0
```

The tag must point to a commit on `main`. Push one release at a time and wait for completion before pushing the next. Workflow concurrency serializes publication, but GitHub can replace a pending run if several additional tags arrive.

## Actions phases

The [release workflow](../.github/workflows/release.yml) performs these phases:

1. Validate the tag and metadata, confirm an annotated tag on `main`, build with Node 24 and pinned npm, and pack one candidate. Record its commit, SHA256 and npm SHA512 integrity.
2. Pass that immutable artifact ID to the reusable CI workflow. Test and install those exact bytes on Linux and macOS with Node 22 and 24. Run the evidence suites without publication privileges.
3. Publish the preserved tarball using npm OIDC and provenance. The job has no package dependency installation or lifecycle execution. Verify the registry integrity and downloaded bytes.
4. In a separate job without OIDC permissions, install the exact registry version with a fresh cache and exercise CLI and MCP behavior.
5. Create a GitHub draft, attach the tarball, `SHA256SUMS` and `release.json`, then publish the immutable release. The GitHub write credential is isolated from npm publishing and package execution.
6. Build, check and deploy the website only for the current stable npm `latest` version. Previews and old release retries do not deploy the stable website.

The package check exercises CLI help, download integrity, retrieval, CLI and MCP workspace search, all seven tools, bundled data outside the checkout, successful validation and invalid TypeScript rejection. It also checks mixed lockfile ownership, saved project selection, live MCP scope refresh, and setup registration using stub clients from a fresh npm cache. The published artifact is checked against a fresh pack of the same source before installation.

Node.js 22.12 is the application runtime minimum. The publishing toolchain uses Node 24. Supported platforms are limited to successful Linux and macOS CI runs; Windows is not claimed.

## Recovery

Rerun failed jobs in the original Actions run. Downloads use the successful build's artifact ID, so a later run attempt cannot accidentally select different bytes. Artifacts remain available for 30 days.

If npm already contains the version, continue only when its identity and integrity match the preserved artifact. A mismatch fails the run. Existing GitHub assets must have matching digests; assets are never replaced. Rerunning an old release does not change npm distribution tags, GitHub latest status, or the stable website.

If the workflow or source requires a change, prepare a corrected version and a new tag. Do not move or delete a release tag, unpublish and replace a version, or fall back to local publication. If artifacts have expired, stop and make an explicit recovery decision. A local test pass, an uploaded artifact or a draft release is not evidence of publication. Completion requires the registry checks, published immutable GitHub release, and successful website deployment for a stable release.

The [research notes](research/release-automation.md) record the npm and GitHub guidance and the Vite and Vitest workflow patterns used for this design.
