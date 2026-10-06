# Website

The site is static HTML, CSS, and a small progressive enhancement script. It runs no agent and sends no query from the browser. Recorded requests, results, declaration excerpts, and assertion source are generated from [the frozen showcase](showcase/README.md). The build verifies the exact package identities and fixture hashes before rendering.

## Build and preview

The static build requires Node.js 22.12 or newer. It does not require npm dependencies.

```sh
npm run site:check
npm run site:build
python3 -m http.server 43821 --bind 127.0.0.1 --directory _site
```

Open `http://127.0.0.1:43821`. Use an unused port and confirm the page title begins with Typelatch. The preview command uses Python 3 only as a local file server.

`site/` contains the presentation source. `scripts/site.mjs` writes `_site/`, including complete recorded JSON and individual tool payloads. Do not edit generated files. The site works at the GitHub project path `/typelatch/` and without JavaScript. Native disclosures keep the original requests and source accessible. Reduced motion disables the short, user requested diagram animation. The trace control illustrates the recorded path and does not issue a new request.

## Browser verification

Install browser testing tools separately from the application dependencies:

```sh
npm install --prefix "$HOME/.cache/typelatch-site-tools" --no-package-lock --no-save \
  playwright@1.63.0 @axe-core/playwright@4.13.0
"$HOME/.cache/typelatch-site-tools/node_modules/.bin/playwright" install chromium
TYPELATCH_BROWSER_TOOLS="$HOME/.cache/typelatch-site-tools" \
  node scripts/site-browsercheck.mjs
```

The suite serves the built site on a fresh loopback port under `/typelatch/`. It checks the correct product identity, immediate installation command, exact recorded signature, direct assertion inspection, both views at five viewport widths, expanded evidence, automated accessibility, keyboard use, clipboard success and denial, reduced motion, no JavaScript, and print output. It also renders the original banner source for visual review.

Results and screenshots go to `_site-qa/`. Set `TYPELATCH_QA_DIR` to store them elsewhere. `TYPELATCH_CHROMIUM` can select an existing Chromium executable. Automated checks are not a substitute for visual review or a complete accessibility audit.

The [recorded delivery verification](verification/website.md) includes the actual checks, independent findings, and release check history. Its [browser report](verification/website-browser.json) records the tested viewports and automated accessibility results.

The [requirement acceptance map](verification/requirements.md) ties each deliverable to observed behavior. It includes actual npm installation, Codex registration, Claude Code server connection, GitHub Markdown rendering, and the unresolved public Pages deployment boundary.

The checked in README banner is generated from `site/brand-banner.html`. To regenerate it intentionally, pass `--update-banner` to the browser check, inspect the resulting artwork, and rebuild the website. Normal checks write the comparison render only to the QA directory.

## GitHub Pages

The [publishing workflow](../.github/workflows/pages.yml) builds and checks the site on pull requests and on pushes to `main`. The stable tag release workflow also calls it after npm and GitHub publication. Deployment requires static and browser checks, published installation pins, and a source version equal to npm `latest`. Pull requests run static and browser verification without requiring their future version to be published. A push to `main` with an unpublished candidate defers deployment until its tag release succeeds. The workflow uses pinned GitHub Actions, no site runtime secrets, and deployment permissions only in the deployment job.

The npm release check reads the exact Typelatch installation, direct `npx`, and `--package` pins in `site/index.html`, `README.md`, and `docs/USAGE.md`. It verifies each version against `https://registry.npmjs.org`, including the returned package identity and artifact metadata. A missing version, registry failure, or mismatched identity prevents deployment. Only a missing version on `main` is treated as an expected deferral; network and metadata errors still fail. The development version in `package.json` is not evidence of an npm release. Run the check separately from the offline static build:

```sh
node --test scripts/site-releasecheck.test.mjs
node scripts/site-releasecheck.mjs
```

Enable GitHub Pages in repository Settings, under Pages, with GitHub Actions as the deployment source. Push the verified commit and inspect the Publish website workflow. The target is `https://edimka.github.io/typelatch/`.

Adding this workflow does not itself establish that the public site has been deployed. Local preview results and GitHub deployment results are separate evidence. Documentation and website updates can publish independently when their installation commands use published versions and their source version remains npm `latest`. See [the release procedure](RELEASE.md) for tag and environment configuration.

## Evidence updates

Run [the capture procedure](showcase/README.md) to replace the frozen recording. The website build refuses an incomplete capture or source files that no longer match its hashes. A capture refresh is an explicit network and local execution operation, not part of a page load or website build.

The README uses a focused excerpt and links to the complete recording. It is not generated by the website build, so inspect its claims whenever the capture changes. Exact source locations, passing and failing controls, and unknown evidence must remain separate.
