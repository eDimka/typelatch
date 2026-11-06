import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './prepare-development.mjs'

export function inspectMigrationScope(ts, entries) {
  const files = entries.map(({ path, source }) => {
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true), imports = []
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0]) && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) imports.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(tree)
    const oldDependency = imports.filter(value => /(^|[/\\])fast-glob(?:@|[/\\]|$)/.test(value))
    return { path, imports, passed: imports.includes('tinyglobby') && oldDependency.length === 0, oldDependency }
  })
  return { passed: files.every(file => file.passed), files, boundary: 'Scope conformance for six actual migrated source modules: statically declared import/export/require/dynamic-import dependencies. This is separate from runtime behavior, and is not a proof about arbitrary computed module specifiers.' }
}
export function migrationScope(workspace) {
  const require = createRequire(join(workspace, 'package.json')), ts = require('typescript')
  return inspectMigrationScope(ts, sources.map(path => ({ path, source: readFileSync(join(workspace, path), 'utf8') })))
}
