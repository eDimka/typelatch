# Original visual assets

The Typelatch site uses original vector latch artwork, a typographic banner, an illustrated terminal walkthrough, and locally hosted fonts. The visual system pairs ink and paper with coral, lilac and lime. No third party logos, mascots or artwork are embedded.

## Earlier precision latch artwork

The retained `assets/latch-hero.webp` and `assets/latch-hero-small.webp` files are optimized versions of artwork generated specifically for this redesign on September 8, 2026 through the image generation tool. The composition shows a precision orange latch holding ivory source sheets. It is a product metaphor, not a screenshot, physical product claim, or visualization of measured data.

The current page uses its own inline vector latch instead of these bitmap files. The earlier direction asked for electric orange anodized aluminum, ivory ceramic declaration sheets, a near black studio environment, no chips or neon effects, and no fabricated legible code. The larger WebP is 1536 by 1024 pixels. The smaller version is 840 pixels wide. The original generated PNG was retained in the local generation working directory rather than shipped as an additional page download.

## Wordmark and banner

The brand is a plain Typelatch wordmark, with no corner symbol. The favicon is a typographic lowercase t. The README and social image is `assets/readme-banner.png`, rendered at 1200 by 630 pixels from the original `assets/readme-banner.svg` vector. `brand-banner.html` displays the same vector for browser inspection. The banner contains an original latch mark, a package declaration sheet, and typeset text. Its editable vector source preserves the artwork and wording together.

## Fonts

Archivo is by Omnibus Type. IBM Plex Mono is by IBM. Both are distributed under the SIL Open Font License. The Latin WOFF2 files are hosted locally, with their licenses retained under `assets/fonts/`. The font packages used to obtain them were `@fontsource-variable/archivo` and `@fontsource/ibm-plex-mono`. The site requires no external font request.

## Walkthrough animation

`assets/zero-to-hero.gif` and `assets/zero-to-hero.png` are original programmatic terminal illustrations, rendered from `demo.json` by `scripts/render-demo.py`. The GIF is 1080 by 760 pixels, lasts 27 seconds and has 60 authored frames before GIF optimization. The PNG is the static final scene. Both use the site paper, ink, coral, lilac and lime palette.

Setup is presented as instructions. The other scenes summarize the actual Codex CLI session in `docs/showcase/codex-session.json`, recorded on 6 November 2026. The narrative binds that file by SHA256 and records each scene's action index, exact request and relevant evidence. The agent was prompted to use Typelatch and started with an isolated exercise and prepared dependency indexes. Code excerpts may be formatted for the illustration. Timing and typing are authored for readability; this is a visual summary rather than a screen recording and does not measure comparative performance, token savings or execution speed. Its visible label identifies the source as a recorded Codex session.

Regenerate from the repository root with a Python environment that has Pillow installed:

```sh
python3 scripts/render-demo.py
```

For visual review, append `--proofs /absolute/path/to/temporary-proof-directory` to write a full PNG of each scene. The renderer rejects text that exceeds its layout. It uses installed macOS system fonts by default and checks for DejaVu or Liberation fonts on Linux. To select equivalent local fonts explicitly, pass `--sans-font /path/font.ttf --mono-font /path/mono.ttf`. Fonts are rasterized, not redistributed in these assets. Exact pixels can vary with the selected fonts and Pillow version. The renderer prints the input hash, asset sizes, dimensions and authored duration after export. Pillow is an optional asset authoring dependency; the package and website do not load it.

Keep the animation linked to the step through website and textual walkthrough so readers can inspect the same information without playing motion. Regenerate both assets whenever the narrative or publication status changes.

## Current brand banner

`assets/readme-banner.svg` is original vector artwork authored for this project. It uses the same coral latch, lilac API sheet and ink palette as the website. The PNG is generated from this vector with `rsvg-convert -o site/assets/readme-banner.png site/assets/readme-banner.svg`. `brand-banner.html` displays the same source at 1200 by 630 pixels. The vector uses system Arial and Andale Mono fallbacks; no external artwork is embedded.
