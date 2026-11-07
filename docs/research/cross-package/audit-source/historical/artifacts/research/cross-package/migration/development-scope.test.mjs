import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { inspectMigrationScope } from './development-scope.mjs'
const inspect = source => inspectMigrationScope(ts, [{ path: 'src/index.ts', source }])
test('migration guard rejects direct and transitive old-version fallback', () => {
  assert.equal(inspect("import glob from 'fast-glob'").passed, false)
  assert.equal(inspect("import { glob } from 'tinyglobby'; const old = require('../../../node_modules/.pnpm/fast-glob@3.3.3/node_modules/fast-glob')").passed, false)
  assert.equal(inspect("import {glob as find} from 'tinyglobby'").passed, true)
  assert.equal(inspect("const {glob} = require('tinyglobby')").passed, true)
  assert.equal(inspect("// import from 'tinyglobby'\nconst x = 1").passed, false)
})
