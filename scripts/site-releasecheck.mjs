import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const documents = ['site/index.html', 'README.md', 'docs/USAGE.md']
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function collectInstallPins(sources) {
  const pins = []
  for (const { path, text } of sources) {
    const source = text.replace(/\\\r?\n\s*/g, ' ')
    const specs = []
    for (const install of source.matchAll(/\bnpm\s+(?:install|i)\s+([^\n\r<;]+)/g)) {
      for (const match of install[1].matchAll(/(?<![\w@/-])typelatch(?:@([^\s"'`<>;,|&]+))?(?![\w/-])/g))
        specs.push(match[1])
    }
    for (const match of source.matchAll(/--package(?:=|\s+)["']?typelatch(?:@([^\s"'`<>;,|&]+))?(?![\w/-])/g))
      specs.push(match[1])
    for (const match of source.matchAll(/\bnpx\s+(?:(?:--yes|-y)\s+)?typelatch(?:@([^\s"'`<>;,|&]+))?(?![\w@/-])/g))
      specs.push(match[1])
    if (!specs.length) throw new Error(`${path}: no Typelatch installation pin found`)
    for (const version of specs) {
      if (!version || !exactVersion.test(version))
        throw new Error(`${path}: installation requires an exact typelatch version, received ${version || 'no version'}`)
      pins.push({ path, version })
    }
  }
  return pins
}

export async function verifyPublishedPins(pins, { fetchImpl = fetch, deferUnpublished = false } = {}) {
  const versions = [...new Set(pins.map((pin) => pin.version))]
  if (!versions.length) throw new Error('No installation pins to verify')
  for (const version of versions) {
    if (!exactVersion.test(version)) throw new Error(`Invalid exact version: ${version}`)
    const sources = [...new Set(pins.filter((pin) => pin.version === version).map((pin) => pin.path))].join(', ')
    const label = `typelatch@${version} (${sources})`
    let response
    try {
      response = await fetchImpl(`https://registry.npmjs.org/typelatch/${encodeURIComponent(version)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
    } catch (error) {
      throw new Error(`${label}: npm registry request failed: ${error.message}`, { cause: error })
    }
    if (response.status === 404 && deferUnpublished) return null
    if (!response.ok)
      throw new Error(`${label}: npm registry returned HTTP ${response.status}; publication is not verified`)
    let metadata
    try {
      metadata = await response.json()
    } catch (error) {
      throw new Error(`${label}: npm registry returned invalid JSON`, { cause: error })
    }
    if (metadata?.name !== 'typelatch' || metadata?.version !== version)
      throw new Error(`${label}: npm registry package identity mismatch`)
    if (!metadata.dist?.tarball || !metadata.dist?.integrity)
      throw new Error(`${label}: npm registry artifact metadata is incomplete`)
  }
  return versions
}

export async function isLatestVersion(version, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl('https://registry.npmjs.org/typelatch/latest', {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  })
  if (!response.ok) throw new Error(`Cannot verify npm latest: HTTP ${response.status}`)
  const metadata = await response.json()
  if (metadata?.name !== 'typelatch' || !exactVersion.test(metadata.version)) throw new Error('Invalid npm latest identity')
  return metadata.version === version
}

async function main() {
  const root = resolve(import.meta.dirname, '..')
  const pins = collectInstallPins(documents.map((path) => ({
    path,
    text: readFileSync(resolve(root, path), 'utf8'),
  })))
  const versions = await verifyPublishedPins(pins, { deferUnpublished: process.env.TYPELATCH_DEFER_UNPUBLISHED === 'true' })
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  const ready = versions !== null && await isLatestVersion(version)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`)
  if (!ready) {
    console.log('Website deployment deferred: source version is not the published npm latest.')
    return
  }
  console.log(`Verified ${pins.length} installation pins against npm: ${versions.map((version) => `typelatch@${version}`).join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
