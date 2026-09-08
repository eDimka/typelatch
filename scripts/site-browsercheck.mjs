import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
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
    'npm install --global typelatch@0.2.0',
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
    'npm install --global typelatch@0.2.0',
  )
  assert.equal(await page.locator('[data-copy="hero-install-command"]').innerText(), 'Copied')
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard denied for test')
    }
  })
  await page.locator('[data-copy="codex-command"]').click()
  assert.equal(
    await page.evaluate(() => window.getSelection().toString()),
    'codex mcp add typelatch -- typelatch-mcp',
  )
  assert.match(await page.locator('#action-status').textContent(), /unavailable/)
  report.checks.push('Clipboard success and honest denied-permission selection fallback')
  const reduced = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  })
  const reducedPage = await reduced.newPage()
  await reducedPage.goto(url)
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
