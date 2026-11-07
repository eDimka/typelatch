import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { advertisedInstallCommand } from './site-releasecheck.mjs'

const root = resolve(import.meta.dirname, '..')
const installCommand = advertisedInstallCommand(readFileSync(resolve(root, 'site/index.html'), 'utf8'))
const tools = createRequire(resolve(process.env.TYPELATCH_BROWSER_TOOLS || root, 'package.json'))
const { chromium } = tools('playwright')
const { default: AxeBuilder } = tools('@axe-core/playwright')
const directory = resolve(process.env.TYPELATCH_QA_DIR || resolve(root, '_site-qa'))
mkdirSync(directory, { recursive: true })
const siteRoot = resolve(root, '_site')
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const file = resolve(
    siteRoot,
    '.' +
      decodeURIComponent(url.pathname.replace(/^\/typelatch(?=\/)/, '')).replace(
        /\/$/,
        '/index.html',
      ),
  )
  if (!file.startsWith(siteRoot + sep)) {
    response.writeHead(403).end()
    return
  }
  try {
    if (!statSync(file).isFile()) throw new Error('Not a file')
    const type =
      {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.woff2': 'font/woff2',
      }[extname(file)] || 'text/plain'
    response.writeHead(200, { 'Content-Type': type }).end(readFileSync(file))
  } catch {
    response.writeHead(404).end('Not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const url = `${origin}/typelatch/`
let browser
const report = { checkedAt: new Date().toISOString(), browser: '', viewports: [], onboarding: [], checks: [] }
const errors = []
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TYPELATCH_CHROMIUM ? { executablePath: process.env.TYPELATCH_CHROMIUM } : {}),
  })
  report.browser = browser.version()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const failedRequests = []
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(url)
  assert.match(await page.title(), /^Typelatch/)
  await page.evaluate(() => document.fonts.ready)
  assert.equal(
    await page.locator('.hero #hero-install-command').innerText(),
    installCommand,
  )
  assert.equal(await page.locator('.brand img').count(), 0)
  assert.equal(
    await page.locator('.recorded-outcomes a').count(),
    3,
    'Recorded outcomes are visible before switching views',
  )
  await page.locator('[data-proof="binding-proof"]').click()
  assert.equal(await page.locator('#use').isVisible(), true)
  assert.equal(await page.locator('#binding-proof').getAttribute('open'), '')
  await page.locator('[data-view="lookup"]').click()
  assert.match(await page.locator('.prompt-to-go h3').textContent(), /Make evidence\s+part/)
  const payload = JSON.parse(readFileSync(resolve(root, 'docs/showcase/recording.json'), 'utf8'))
  const transaction = payload.mcp
    .find((call) => call.id === 'transaction-symbol')
    .response.structuredContent.results.find(
      (item) => item.symbol === 'esm/kysely.TransactionBuilder',
    )
  assert.equal(
    await page
      .locator('pre[aria-label="Exact returned TransactionBuilder declaration"] code')
      .textContent(),
    transaction.signature,
  )
  report.checks.push(
    'Correct Typelatch page, immediate npm command, wordmark without a corner icon, exact recorded signature',
  )
  assert.equal(await page.locator('[data-demo-scene]').count(), 6)
  assert.equal(await page.locator('[data-demo-scene]:visible').count(), 1)
  for (let index = 0; index < 6; index++) {
    await page.locator(`[data-demo-step="${index}"]`).click()
    assert.equal(await page.locator(`[data-demo-scene="${index}"]`).isVisible(), true)
    assert.equal(await page.locator(`[data-demo-step="${index}"]`).getAttribute('aria-current'), 'true')
  }
  await page.locator('[data-demo-restart]').click()
  assert.equal(await page.locator('[data-demo-scene="0"]').isVisible(), true)
  await page.locator('[data-demo-play]').click()
  assert.equal(await page.locator('[data-demo-play]').innerText(), 'Pause')
  await page.locator('[data-demo-play]').click()
  assert.equal(await page.locator('[data-demo-play]').innerText(), 'Play walkthrough')
  await page.locator('[data-demo-step="3"]').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('[data-demo-scene="3"]').isVisible(), true)
  report.checks.push('All six walkthrough steps, keyboard selection, play, pause and restart')
  const paired = JSON.parse(readFileSync(resolve(root, 'docs/benchmarks/typelatch-040-candidate/paired-agent.json'), 'utf8'))
  await page.locator('a[href="#benchmark"]').first().click()
  assert.equal(await page.locator('#benchmark').isVisible(), true)
  assert.equal(await page.locator('[data-benchmark-run]').count(), paired.runs.length)
  await page.locator('#benchmark .benchmark-details summary').first().focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#benchmark .benchmark-details').first().getAttribute('open'), '')
  assert.match(await page.locator('.benchmark-method').innerText(), /Cached input tokens, already included/)
  assert.match(await page.locator('.benchmark-method').innerText(), /Typelatch index preparation/)
  assert.equal(await page.locator('a[href="evidence/paired-agent.json"]').count(), 1)
  assert.equal(await page.locator('a[href="evidence/automatic/paired-agent.json"]').count(), 1)
  assert.match(await page.locator('.benchmark-automatic').innerText(), /not pooled/)
  assert.match(await page.locator('#benchmark .benchmark-scope').first().innerText(), /did not meet the recorded performance gate/)
  assert.match((await page.locator('#benchmark .benchmark-scope').allTextContents()).join('\n'), /identical task and workflow instructions/)
  assert.equal(await page.locator('[data-comparison-image]').getAttribute('src'), 'assets/codex-comparison.png')
  await page.locator('[data-comparison-play]').click()
  assert.equal(await page.locator('[data-comparison-play]').innerText(), 'Stop replay')
  assert.equal(await page.locator('[data-comparison-image]').getAttribute('src'), 'assets/codex-comparison.gif')
  await page.locator('[data-comparison-play]').click()
  assert.equal(await page.locator('[data-comparison-image]').getAttribute('src'), 'assets/codex-comparison.png')
  assert.equal(await page.locator('[data-comparison-play]').getAttribute('aria-pressed'), 'false')
  report.checks.push('Every paired benchmark run, keyboard accounting disclosure and public evidence link')
  report.checks.push('Actual Codex comparison GIF starts on request and stops on its static poster')
  const monorepoPath = resolve(root, 'docs/benchmarks/monorepo-agent-study/report.json')
  const monorepo = existsSync(monorepoPath) ? JSON.parse(readFileSync(monorepoPath, 'utf8')) : null
  if (monorepo) {
    await page.locator('a[href="#monorepo-benchmark"]').first().click()
    assert.deepEqual(await page.locator('[data-monorepo-arm]').evaluateAll(nodes => nodes.map(node => node.dataset.monorepoArm)), ['native', 'competitor', 'typelatch', 'packet'])
    assert.equal(await page.locator('[data-monorepo-run]').count(), monorepo.runs.length)
    assert.match(await page.locator('#monorepo-benchmark .benchmark-scope').innerText(), /does not test scaling/)
    const disclosure = page.locator('#monorepo-benchmark > .wrap > .benchmark-details').first()
    await disclosure.locator('summary').focus()
    await page.keyboard.press('Enter')
    assert.equal(await disclosure.getAttribute('open'), '')
    const first = monorepo.runs[0]
    assert.equal(await page.locator(`[data-monorepo-run="${first.id}"] a`).getAttribute('href'), `evidence/monorepo-agent-study/${first.evidence}`)
    await disclosure.locator('summary').click()
    report.checks.push('Four maintenance conditions, all sixteen sessions, keyboard disclosure and exact evidence links')
  }
  const confirmation = await page.locator('#confirmation-benchmark').count() > 0
  const confirmationReplay = await page.locator('[data-confirmation-comparison-image]').count() > 0
  if (confirmation) {
    assert.equal(confirmationReplay, true, 'Final confirmation requires its verified preselected replay')
    assert.deepEqual(await page.locator('[data-confirmation-arm]').evaluateAll(nodes => nodes.map(node => node.dataset.confirmationArm)), ['native', 'impact', 'competitor', 'codegraph'])
    assert.equal(await page.locator('[data-confirmation-run]').count(), 16)
    assert.equal(await page.locator('[data-confirmation-gate]').getAttribute('data-confirmation-gate'), 'failed')
    assert.match(await page.locator('#confirmation-benchmark .benchmark-scope').innerText(), /same Vue snapshot/)
    report.checks.push('All four confirmation conditions and sixteen sessions retain the failed gate and separate audited grades')
  }
  const crossPackage = await page.locator('#cross-package-benchmark').count() > 0
  const impactReplay = await page.locator('[data-impact-comparison-image]').count() > 0
  const guidedPath = resolve(root, 'docs/benchmarks/monorepo-guided-study/report.json')
  const guided = existsSync(guidedPath) ? JSON.parse(readFileSync(guidedPath, 'utf8')) : null
  if (guided) {
    await page.locator('a[href="#guided-benchmark"]').first().click()
    assert.deepEqual(await page.locator('[data-guided-arm]').evaluateAll(nodes => nodes.map(node => node.dataset.guidedArm)), ['native', 'competitor', 'packet'])
    assert.equal(await page.locator('[data-guided-run]').count(), 12)
    assert.match(await page.locator('#guided-benchmark .benchmark-scope').innerText(), /unpublished Typelatch prototype/)
    const disclosure = page.locator('#guided-benchmark .guided-runs')
    await disclosure.locator('summary').focus()
    await page.keyboard.press('Enter')
    assert.equal(await disclosure.getAttribute('open'), '')
    await disclosure.locator('summary').click()
    assert.equal(await page.locator('[data-guided-comparison-image]').getAttribute('src'), 'assets/codex-guided-comparison.png')
    await page.locator('[data-guided-comparison-play]').click()
    assert.equal(await page.locator('[data-guided-comparison-image]').getAttribute('src'), 'assets/codex-guided-comparison.gif')
    assert.equal(await page.locator('[data-guided-comparison-play]').getAttribute('aria-pressed'), 'true')
    await page.locator('[data-guided-comparison-play]').click()
    assert.equal(await page.locator('[data-guided-comparison-image]').getAttribute('src'), 'assets/codex-guided-comparison.png')
    report.checks.push('Three guided conditions, all twelve sessions, separate reviewed outcome and retained history')
  }

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    const commandBottom = await page.locator('#hero-install-command').evaluate(
      (node) => node.getBoundingClientRect().bottom + scrollY,
    )
    const declarationFontSize = await page
      .locator('pre[aria-label="Exact returned TransactionBuilder declaration"] code')
      .evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
    assert.ok(commandBottom <= 844, `Install command is in the first viewport at ${width}px`)
    assert.ok(declarationFontSize >= 13, `Declaration stays readable at ${width}px`)
    report.onboarding.push({ width, viewportHeight: 844, commandBottom, declarationFontSize })
    if ([390, 1440].includes(width)) {
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: resolve(directory, `${width}-hero.png`) })
    }
    if (guided) {
      const section = page.locator('#guided-benchmark')
      for (const card of await section.locator('[data-guided-arm]').all()) {
        assert.equal(await card.locator('dt').count(), 6)
        assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth), true, `Primary guided metrics fit their card at ${width}px`)
        for (const value of await card.locator('dd').all()) assert.equal(await value.evaluate(node => { const bounds = node.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth }), true, `Critical guided metrics need no sideways scroll at ${width}px`)
      }
      await section.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true }))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Expanded guided evidence fits ${width}px`)
      await section.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = false }))
      if ([390, 1440].includes(width)) {
        await section.evaluate(node => scrollTo({ top: node.getBoundingClientRect().top + scrollY, behavior: 'instant' }))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.screenshot({ path: resolve(directory, `${width}-guided-heading.png`) })
        await section.locator('.guided-arm-cards').evaluate(node => scrollTo({ top: node.getBoundingClientRect().top + scrollY - 20, behavior: 'instant' }))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.screenshot({ path: resolve(directory, `${width}-guided-metrics.png`) })
        if (width === 390) for (const arm of ['native', 'competitor', 'packet']) {
          await section.locator(`[data-guided-arm="${arm}"]`).evaluate(node => scrollTo({ top: node.getBoundingClientRect().top + scrollY - 20, behavior: 'instant' }))
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          await page.screenshot({ path: resolve(directory, `${width}-guided-${arm}.png`) })
        }
      }
    }
    if (confirmation) {
      const section = page.locator('#confirmation-benchmark')
      for (const card of await section.locator('[data-confirmation-arm]').all()) {
        assert.equal(await card.locator('dt').count(), 7)
        assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth), true, `Confirmation cards fit ${width}px`)
        for (const value of await card.locator('dd').all()) assert.equal(await value.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth }), true, `Confirmation values need no sideways scroll at ${width}px`)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if ([390, 1440].includes(width)) for (const [label, target] of [['heading', section], ['metrics', section.locator('.confirmation-cards')], ['pairs', section.locator('.confirmation-pairs')]]) {
        await target.evaluate(node => scrollTo({ top: node.getBoundingClientRect().top + scrollY - 20, behavior: 'instant' }))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.screenshot({ path: resolve(directory, `${width}-confirmation-${label}.png`) })
      }
    }
    if (crossPackage) {
      const section = page.locator('#cross-package-benchmark')
      for (const card of await section.locator('[data-cross-package-arm]:visible').all()) {
        assert.equal(await card.locator('dt').count(), 7)
        assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth), true, `Cross package metrics fit at ${width}px`)
        for (const value of await card.locator('dd').all()) assert.equal(await value.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth }), true, `Cross package metrics need no sideways scroll at ${width}px`)
      }
      await section.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true }))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await section.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = false }))
      if ([390, 1440].includes(width)) {
        for (const [label, target] of [['heading', section], ['metrics', section.locator('.guided-arm-cards').first()]]) {
          await target.evaluate(node => scrollTo({ top: node.getBoundingClientRect().top + scrollY - 20, behavior: 'instant' }))
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          await page.screenshot({ path: resolve(directory, `${width}-cross-package-${label}.png`) })
        }
      }
    }
    if (monorepo) {
      const section = page.locator('#monorepo-benchmark')
      await section.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true }))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Expanded maintenance evidence fits ${width}px`)
      await section.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = false }))
      if ([390, 1440].includes(width)) {
        await section.evaluate(node => scrollTo({ top: node.getBoundingClientRect().top + scrollY, behavior: 'instant' }))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.screenshot({ path: resolve(directory, `${width}-monorepo.png`) })
        if (width === 390) {
          const table = section.locator('[aria-label="All four maintenance study conditions"]')
          await table.evaluate(node => { node.scrollLeft = node.scrollWidth })
          assert.ok(await table.evaluate(node => node.scrollLeft > 0), 'All mobile table columns can be reached')
          await page.screenshot({ path: resolve(directory, `${width}-monorepo-metrics.png`) })
          await table.evaluate(node => { node.scrollLeft = 0 })
        }
      }
    }
    for (const view of ['lookup', 'use']) {
      await page.locator(`[data-view="${view}"]`).click()
      assert.equal(await page.locator(`#${view}`).isVisible(), true)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      assert.equal(overflow, false, `No horizontal page overflow at ${width}px in ${view}`)
      await page.locator(`#${view} details`).evaluateAll((nodes) =>
        nodes.forEach((node) => {
          node.open = true
        }),
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `Expanded evidence fits ${width}px in ${view}`,
      )
      await page.locator(`#${view} details`).evaluateAll((nodes) =>
        nodes.forEach((node) => {
          node.open = false
        }),
      )
      if ([390, 1440].includes(width)) {
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
        writeFileSync(
          resolve(directory, `axe-${width}-${view}.json`),
          JSON.stringify(accessibility, null, 2),
        )
        assert.deepEqual(
          accessibility.violations.map((item) => ({
            id: item.id,
            impact: item.impact,
            nodes: item.nodes.map((node) => node.target),
          })),
          [],
          `Accessibility scan ${width}px ${view}`,
        )
        await page.screenshot({ path: resolve(directory, `${width}-${view}.png`), fullPage: true })
      }
      report.viewports.push({ width, view, expandedEvidence: 'fits' })
    }
  }
  await page.goto(url)
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').innerText(), 'Skip to content')
  await page.locator('[data-view="use"]').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#use').isVisible(), true)
  await page.locator('[data-view="lookup"]').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#lookup').isVisible(), true)
  await page.locator('#lookup details summary').first().focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#lookup details').first().getAttribute('open'), '')
  report.checks.push('Keyboard skip link, workflow navigation and native evidence disclosure')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await page.locator('[data-copy="hero-install-command"]').click()
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    installCommand,
  )
  assert.equal(await page.locator('[data-copy="hero-install-command"]').innerText(), 'Copied')
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard denied for test')
    }
  })
  await page.locator('[data-copy="install-command"]').click()
  assert.equal(
    await page.evaluate(() => window.getSelection().toString()),
    installCommand,
  )
  assert.match(await page.locator('#action-status').textContent(), /unavailable/)
  report.checks.push('Clipboard success and honest denied-permission selection fallback')
  if (impactReplay) {
    await page.locator('[data-impact-comparison-play]').click()
    assert.equal(await page.locator('[data-impact-comparison-image]').getAttribute('src'), 'assets/codex-impact-development.gif')
    assert.equal(await page.locator('[data-impact-comparison-play]').getAttribute('aria-pressed'), 'true')
    await page.locator('[data-impact-comparison-play]').click()
    assert.equal(await page.locator('[data-impact-comparison-image]').getAttribute('src'), 'assets/codex-impact-development.png')
  }
  if (confirmationReplay) {
    await page.locator('[data-confirmation-comparison-play]').click()
    assert.equal(await page.locator('[data-confirmation-comparison-image]').getAttribute('src'), 'assets/cross-package-confirmation.gif')
    assert.equal(await page.locator('[data-confirmation-comparison-play]').getAttribute('aria-pressed'), 'true')
    await page.locator('[data-confirmation-comparison-play]').click()
    assert.equal(await page.locator('[data-confirmation-comparison-image]').getAttribute('src'), 'assets/cross-package-confirmation.png')
  }
  const reduced = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  })
  const reducedPage = await reduced.newPage()
  await reducedPage.goto(url)
  assert.equal(await reducedPage.locator('[data-demo-play]').isVisible(), false)
  assert.equal(await reducedPage.locator('[data-comparison-play]').isVisible(), false)
  await reducedPage.locator('[data-comparison-image]').scrollIntoViewIfNeeded()
  await reducedPage.locator('[data-comparison-image]').evaluate(image => image.decode())
  assert.match(await reducedPage.locator('[data-comparison-image]').evaluate(image => image.currentSrc), /\/assets\/codex-comparison\.png$/)
  if (guided) {
    assert.equal(await reducedPage.locator('[data-guided-comparison-play]').isVisible(), false)
    await reducedPage.locator('[data-guided-comparison-image]').scrollIntoViewIfNeeded()
    await reducedPage.locator('[data-guided-comparison-image]').evaluate(image => image.decode())
    assert.match(await reducedPage.locator('[data-guided-comparison-image]').evaluate(image => image.currentSrc), /\/assets\/codex-guided-comparison\.png$/)
  }
  if (impactReplay) {
    assert.equal(await reducedPage.locator('[data-impact-comparison-play]').isVisible(), false)
    await reducedPage.locator('[data-impact-comparison-image]').scrollIntoViewIfNeeded()
    await reducedPage.locator('[data-impact-comparison-image]').evaluate(image => image.decode())
    assert.match(await reducedPage.locator('[data-impact-comparison-image]').evaluate(image => image.currentSrc), /\/assets\/codex-impact-development\.png$/)
  }
  if (confirmationReplay) {
    assert.equal(await reducedPage.locator('[data-confirmation-comparison-play]').isVisible(), false)
    await reducedPage.locator('[data-confirmation-comparison-image]').scrollIntoViewIfNeeded()
    await reducedPage.locator('[data-confirmation-comparison-image]').evaluate(image => image.decode())
    assert.match(await reducedPage.locator('[data-confirmation-comparison-image]').evaluate(image => image.currentSrc), /\/assets\/cross-package-confirmation\.png$/)
  }
  await reducedPage.locator('[data-demo-step="5"]').click()
  assert.equal(await reducedPage.locator('[data-demo-scene="5"]').isVisible(), true)
  await reducedPage.locator('[data-trace]').click()
  assert.equal(
    await reducedPage
      .locator('.trace-line')
      .first()
      .evaluate((node) => getComputedStyle(node, '::after').animationName),
    'none',
  )
  assert.equal(
    await reducedPage.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    'auto',
  )
  assert.match(
    await reducedPage.locator('#action-status').textContent(),
    /No new query was executed/,
  )
  report.checks.push(
    'Reduced motion has static tracing and no smooth scrolling, replay never claims live execution',
  )
  const staticContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  })
  const staticPage = await staticContext.newPage()
  await staticPage.goto(url)
  assert.equal(await staticPage.locator('[data-demo-scene]:visible').count(), 6)
  assert.equal(await staticPage.locator('[data-demo-play]').isVisible(), false)
  assert.equal(await staticPage.locator('[data-comparison-play]').isVisible(), false)
  assert.equal(await staticPage.locator('[data-comparison-image]').getAttribute('src'), 'assets/codex-comparison.png')
  if (guided) {
    assert.equal(await staticPage.locator('[data-guided-comparison-play]').isVisible(), false)
    assert.equal(await staticPage.locator('[data-guided-comparison-image]').getAttribute('src'), 'assets/codex-guided-comparison.png')
    assert.equal(await staticPage.locator('[data-guided-arm]').count(), 3)
  }
  if (impactReplay) {
    assert.equal(await staticPage.locator('[data-impact-comparison-play]').isVisible(), false)
    assert.equal(await staticPage.locator('[data-impact-comparison-image]').getAttribute('src'), 'assets/codex-impact-development.png')
  }
  if (confirmation) {
    assert.equal(await staticPage.locator('[data-confirmation-arm]').count(), 4)
    assert.equal(await staticPage.locator('[data-confirmation-gate]').getAttribute('data-confirmation-gate'), 'failed')
  }
  if (confirmationReplay) {
    assert.equal(await staticPage.locator('[data-confirmation-comparison-play]').isVisible(), false)
    assert.equal(await staticPage.locator('[data-confirmation-comparison-image]').getAttribute('src'), 'assets/cross-package-confirmation.png')
  }
  assert.equal(await staticPage.locator('#lookup').isVisible(), true)
  assert.equal(await staticPage.locator('#use').isVisible(), true)
  assert.equal(await staticPage.locator('[data-trace]').isVisible(), false)
  assert.equal(await staticPage.locator('#hero-install-command').isVisible(), true)
  await staticPage.locator('#lookup details summary').first().click()
  assert.equal(await staticPage.locator('#lookup details').first().getAttribute('open'), '')
  assert.equal(
    await staticPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  )
  report.checks.push('JavaScript disabled retains both workflows, setup and native disclosure')
  await page.emulateMedia({ media: 'print' })
  assert.equal(await page.locator('#lookup').isVisible(), true)
  assert.equal(await page.locator('#use').isVisible(), true)
  report.checks.push('Printed output includes both workflows')
  assert.deepEqual(errors, [])
  assert.deepEqual(failedRequests, [])
  report.checks.push('No page exceptions or failed local resources')
  const banner = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  })
  await banner.goto(pathToFileURL(resolve(root, 'site/brand-banner.html')).href)
  await banner.evaluate(() => document.fonts.ready)
  await banner.screenshot({
    path: process.argv.includes('--update-banner')
      ? resolve(root, 'site/assets/readme-banner.png')
      : resolve(directory, 'readme-banner.png'),
  })
  report.checks.push('README and social banner rendered from original local artwork')
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  server.close()
}
