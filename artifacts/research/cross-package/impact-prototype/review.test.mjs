import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { packageEvidence } from './evidence.mjs'

const runtimeRoot = resolve('artifacts/paired-agent/candidate/runtime/node_modules/typelatch')
function fixture(api, consumer) {
  const root = mkdtempSync(join(tmpdir(), 'typelatch-impact-review-'))
  const put = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
  }
  put('package.json', { private: true, workspaces: ['packages/*'] })
  put('tsconfig.json', { compilerOptions: { target: 'ES2022', module: 'CommonJS', moduleResolution: 'node', strict: true }, include: ['packages/*/src/**/*.ts'] })
  put('packages/api/package.json', { name: '@demo/api', version: '1.0.0', types: 'src/index.ts' })
  put('packages/consumer/package.json', { name: '@demo/consumer', version: '1.0.0', dependencies: { '@demo/api': 'workspace:*' } })
  put('packages/api/src/index.ts', api)
  put('packages/consumer/src/index.ts', consumer)
  put('.gitignore', 'node_modules/\n')
  execFileSync('git', ['init', '--quiet', root])
  mkdirSync(join(root, 'node_modules/@demo'), { recursive: true })
  symlinkSync('../../packages/api', join(root, 'node_modules/@demo/api'))
  const add = (name, text) => {
    put(`packages/${name}/package.json`, { name: `@demo/${name}`, version: '1.0.0', types: 'src/index.ts' })
    put(`packages/${name}/src/index.ts`, text)
    symlinkSync(`../../packages/${name}`, join(root, `node_modules/@demo/${name}`))
  }
  return { root, put, add, close: () => rmSync(root, { recursive: true, force: true }) }
}
async function inspect(f, names) {
  return packageEvidence({ workspaceRoot: f.root, package: '@demo/api', exports: names }, { runtimeRoot })
}
const rows = result => result.direct.map(row => `${row.file}|${row.symbol}|${row.role}`).sort()

test('star reexport is a direct export boundary even without a downstream use', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'export * from "@demo/api"\n')
  try {
    const result = await inspect(f, ['parse'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|parse|reexport'])
  } finally { f.close() }
})

test('ordinary interface import is type evidence and does not invent a runtime export', async () => {
  const f = fixture('export interface Result { value: string }\n', 'import { Result } from "@demo/api"\nexport const result: Result = { value: "ok" }\n')
  try {
    const result = await inspect(f, ['Result'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|Result|type-only'])
  } finally { f.close() }
})

test('two exported names for one declaration retain the spelling actually imported', async () => {
  const f = fixture('export function parse(value: string) { return value }\nexport { parse as read }\n', 'import { parse } from "@demo/api"\nexport const result = parse("ok")\n')
  try {
    const result = await inspect(f, ['parse', 'read'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|parse|runtime'])
  } finally { f.close() }
})

test('namespace property uses resolve to the target export, with local shadows excluded', async () => {
  const f = fixture('export function parse(value: string) { return value }\nexport interface Result { value: string }\n', 'import * as api from "@demo/api"\nexport const result: api.Result = { value: api.parse("ok") }\nfunction local(api: { parse(value: string): string }) { return api.parse("local") }\n')
  try {
    const result = await inspect(f, ['parse', 'Result'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|Result|type-only', 'packages/consumer/src/index.ts|parse|runtime'].sort())
    assert(!result.direct.some(row => row.occurrences.some(item => item.line === 3)))
  } finally { f.close() }
})

test('namespace reexport and renamed namespace barrel retain each export boundary', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'import { service } from "@demo/bridge"\nexport const result = service.parse("ok")\n')
  f.add('barrel', 'export * as api from "@demo/api"\n')
  f.add('bridge', 'export { api as service } from "@demo/barrel"\n')
  try {
    const result = await inspect(f, ['parse'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), [
      'packages/barrel/src/index.ts|parse|reexport',
      'packages/bridge/src/index.ts|parse|reexport',
      'packages/consumer/src/index.ts|parse|runtime',
    ])
  } finally { f.close() }
})

test('unresolved intermediate static export blocks a complete impact result', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'import { parse } from "@demo/api"\nimport { read } from "@demo/barrel"\nexport const result = parse(read("ok"))\n')
  f.add('barrel', 'export { parse as read } from "./missing"\n')
  try {
    const result = await inspect(f, ['parse'])
    assert.equal(result.status, 'partial')
    assert(result.issues.some(row => /unresolved/u.test(row.code)))
  } finally { f.close() }
})

test('a solution-style package config cannot silently omit its referenced source project', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'import { parse } from "@demo/api"\nexport const result = parse("direct")\n')
  f.add('referenced', 'import { parse } from "@demo/api"\nexport const result = parse("referenced")\n')
  f.put('packages/referenced/tsconfig.json', { files: [], references: [{ path: './tsconfig.build.json' }] })
  f.put('packages/referenced/tsconfig.build.json', { extends: '../../tsconfig.json', compilerOptions: { composite: true }, include: ['src/**/*.ts'] })
  try {
    const result = await inspect(f, ['parse'])
    const found = result.direct.some(row => row.file === 'packages/referenced/src/index.ts' && row.symbol === 'parse')
    assert(found || result.status === 'partial', 'Referenced configured source was omitted while claiming an ok result')
    if (!found) assert(result.issues.some(row => /config|reference|project/u.test(row.code)))
  } finally { f.close() }
})

test('an underlying declaration imported outside the target export route is not target use', async () => {
  const f = fixture('export { parse } from "@demo/underlying"\n', 'import { parse } from "@demo/api"\nexport const result = parse("through-target")\n')
  f.add('underlying', 'export function parse(value: string) { return value }\n')
  f.add('unrelated', 'import { parse } from "@demo/underlying"\nexport const result = parse("not-through-target")\n')
  try {
    const result = await inspect(f, ['parse'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|parse|runtime'])
  } finally { f.close() }
})

test('declared plural lookalikes are separate-symbol candidates, not false direct users', async () => {
  const f = fixture('export function parseWantedDependency(value: string) { return value }\n', 'import { parseWantedDependency } from "@demo/api"\nexport function parseWantedDependencies(values: string[]) { return values.map(parseWantedDependency) }\n')
  try {
    const result = await inspect(f, ['parseWantedDependency'])
    assert(result.lookalikes.some(row => row.symbol === 'parseWantedDependencies' && row.reason === 'different-symbol'))
    assert(result.uncertainties.some(row => /lookalike/u.test(row.code)))
    assert(!result.direct.some(row => row.symbol === 'parseWantedDependencies'))
  } finally { f.close() }
})

test('root script candidates remain available when consumer packages have no local scripts', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'import { parse } from "@demo/api"\nparse("ok")\n')
  f.put('package.json', { private: true, workspaces: ['packages/*'], directories: { test: 'test' }, scripts: { check: 'tsc -b', 'test-unit': 'node test.js', build: 'tsc -b' } })
  try {
    const result = await inspect(f, ['parse'])
    for (const name of ['check', 'test-unit', 'build']) assert(result.validationTargets.some(row => row.package === '<root>' && row.script === name && row.evidence.file === 'package.json'))
  } finally { f.close() }
})

test('default imports preserve the requested default slot through a renamed barrel', async () => {
  const f = fixture('export default function parse(value: string) { return value }\n', 'import { decode } from "@demo/barrel"\nexport const value = decode("ok")\n')
  f.add('barrel', 'export { default as decode } from "@demo/api"\n')
  try {
    const result = await inspect(f, ['default'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/barrel/src/index.ts|default|reexport', 'packages/consumer/src/index.ts|default|runtime'])
  } finally { f.close() }
})

test('a type-only barrel export does not become a runtime class import downstream', async () => {
  const f = fixture('export class Result { value = "ok" }\n', 'import { Result } from "@demo/barrel"\nexport type Value = Result\n')
  f.add('barrel', 'export type { Result } from "@demo/api"\n')
  try {
    const result = await inspect(f, ['Result'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/barrel/src/index.ts|Result|reexport', 'packages/consumer/src/index.ts|Result|type-only'])
  } finally { f.close() }
})

test('an installed package alias can identify the exact target entry without canonical imports', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'import { parse } from "renamed"\nparse("ok")\n')
  f.put('packages/consumer/package.json', { name: '@demo/consumer', version: '1.0.0', dependencies: { renamed: 'npm:@demo/api@1.0.0' } })
  symlinkSync('../packages/api', join(f.root, 'node_modules/renamed'))
  try {
    const result = await inspect(f, ['parse'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|parse|runtime'])
    assert(result.packageDependents.some(row => row.package === '@demo/consumer'))
  } finally { f.close() }
})

test('a compiler-bound ambient module is not falsely labeled an unresolved static import', async () => {
  const f = fixture('export function parse(value: string) { return value }\n', 'import { parse } from "@demo/api"\nimport { value } from "native:platform"\nexport const result = parse(value)\n')
  f.put('packages/consumer/src/platform.ts', 'declare module "native:platform" { export const value: string }\n')
  try {
    const result = await inspect(f, ['parse'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/consumer/src/index.ts|parse|runtime'])
  } finally { f.close() }
})

test('importing a namespace container does not claim use of every enclosed export', async () => {
  const f = fixture('export function parse(value: string) { return value }\nexport interface Result { value: string }\n', 'import { api } from "@demo/barrel"\nexport const result = api.parse("ok")\n')
  f.add('barrel', 'export * as api from "@demo/api"\n')
  try {
    const result = await inspect(f, ['parse', 'Result'])
    assert.equal(result.status, 'ok', JSON.stringify(result.issues))
    assert.deepEqual(rows(result), ['packages/barrel/src/index.ts|Result|reexport', 'packages/barrel/src/index.ts|parse|reexport', 'packages/consumer/src/index.ts|parse|runtime'].sort())
  } finally { f.close() }
})
