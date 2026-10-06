import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

const workflow = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
const release = workflow('release')
const steps = job => job.steps ?? []

test('only pushed release tags can reach publication, after verification', () => {
  assert.deepEqual(Object.keys(release.on), ['push'])
  assert.deepEqual(release.on.push, { tags: ['v*'] })
  assert.deepEqual(release.permissions, { contents: 'read' })
  assert.equal(release.concurrency['cancel-in-progress'], false)
  assert.deepEqual(release.jobs.npm.needs, ['build', 'verify'])
  assert.deepEqual(release.jobs['github-release'].needs, ['build', 'registry-check'])
  assert.equal(release.jobs.npm.environment, 'npm-release')
})

test('privileged jobs never install or execute package code and credentials stay isolated', () => {
  for (const name of ['npm', 'github-release']) {
    const job = release.jobs[name]
    for (const step of steps(job)) {
      assert(!/npm (?:ci|run|exec)|npx\b|packagecheck/.test(step.run ?? ''), `${name} executes package code`)
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false)
    }
  }
  assert.deepEqual(release.jobs.npm.permissions, { contents: 'read', 'id-token': 'write' })
  assert.deepEqual(release.jobs['github-release'].permissions, { contents: 'write' })
  assert.equal(release.jobs['registry-check'].permissions?.['id-token'], undefined)
  assert(!JSON.stringify(release).includes('secrets.'))
})

test('every publisher and verification matrix uses the original artifact ID', () => {
  for (const name of ['npm', 'github-release']) {
    const download = steps(release.jobs[name]).find(step => step.uses?.startsWith('actions/download-artifact@'))
    assert.equal(download.with['artifact-ids'], '${{ needs.build.outputs.artifact-id }}')
    assert.equal(download.with.name, undefined)
  }
  assert.equal(release.jobs.verify.with['artifact-id'], '${{ needs.build.outputs.artifact-id }}')
  const ci = workflow('ci')
  assert(ci.on.workflow_call.inputs['artifact-id'])
  assert(steps(ci.jobs.verify).find(step => step.run === 'npm run release:check').env.TYPELATCH_PACKAGE.includes('inputs.release-version'))
})

test('actions are pinned and website only deploys the published stable release', () => {
  for (const name of ['release', 'ci', 'pages']) {
    const config = workflow(name)
    for (const job of Object.values(config.jobs)) for (const step of steps(job))
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/, `${name}: unpinned action`)
  }
  assert.equal(release.jobs.website.if, "needs.github-release.outputs.latest == 'true'")
  const pages = workflow('pages')
  assert(Object.hasOwn(pages.on, 'workflow_call'))
  assert(pages.jobs.deploy.if.includes("needs.build.outputs.ready == 'true'"))
})
