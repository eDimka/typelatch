import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const slash = value => value.replaceAll('\\', '/')

export function deriveOracle({ workspace, workspaceReceipt, targetPackage, exports: targetNames, entry, config, productionOnly = true }) {
  workspace = realpathSync(workspace)
  const ts = createRequire(join(workspace, 'package.json'))('typescript')
  const packageRows = JSON.parse(read(workspaceReceipt).stdout).filter(row => row.name)
  const packages = packageRows.map(row => ({ ...read(join(row.path, 'package.json')), path: slash(relative(workspace, realpathSync(row.path))) }))
  assert(packages.every(row=>row.path!== '..'&&!row.path.startsWith('../')),'Package receipt points outside the source workspace')
  const owner = file => packages.filter(row => file.startsWith(`${row.path}/`)).sort((a,b) => b.path.length-a.path.length)[0]
  const configs = new Map()
  function parsedConfig(path) {
    if (configs.has(path)) return configs.get(path)
    const loaded = ts.readConfigFile(path, ts.sys.readFile)
    assert(!loaded.error, `Cannot read config ${path}`)
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(path), undefined, path)
    assert(!parsed.errors.length, `Cannot parse config ${path}: ${parsed.errors.map(e => e.messageText)}`)
    configs.set(path, parsed)
    return parsed
  }
  const base = parsedConfig(join(workspace, config)), options = { ...base.options }
  delete options.outDir; delete options.rootDir
  const sourcePaths = []
  function walk(dir) {
    for (const row of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules','.git','lib','dist','temp'].includes(row.name) || row.isSymbolicLink()) continue
      const path = join(dir, row.name)
      if (row.isDirectory()) walk(path)
      else if (/\.[cm]?tsx?$/u.test(row.name) && !row.name.endsWith('.d.ts')) sourcePaths.push(path)
    }
  }
  for (const pkg of packages) if (existsSync(join(workspace, pkg.path, 'src'))) walk(join(workspace, pkg.path, 'src'))
  if (!productionOnly) for (const pkg of packages) for (const sub of ['test','__tests__']) if (existsSync(join(workspace,pkg.path,sub))) walk(join(workspace,pkg.path,sub))
  const excludedSourceFiles = []
  for (let index=sourcePaths.length-1; index>=0; index--) {
    const path=sourcePaths[index], pkg=owner(slash(relative(workspace,path)))
    const nativeConfig=pkg && existsSync(join(workspace,pkg.path,'tsconfig.json')) ? parsedConfig(join(workspace,pkg.path,'tsconfig.json')) : base
    if(!nativeConfig.fileNames.includes(path)) { excludedSourceFiles.push(slash(relative(workspace,path))); sourcePaths.splice(index,1) }
  }
  const rootNames = [...new Set([...base.fileNames, ...sourcePaths])]
  const host = ts.createCompilerHost(options)
  host.resolveModuleNames = (names, containingFile) => {
    const pkg = owner(slash(relative(workspace, containingFile)))
    const localConfig = pkg && existsSync(join(workspace,pkg.path,'tsconfig.json')) ? parsedConfig(join(workspace,pkg.path,'tsconfig.json')) : base
    return names.map(name => ts.resolveModuleName(name, containingFile, localConfig.options, ts.sys).resolvedModule)
  }
  const program = ts.createProgram(rootNames, options, host), checker = program.getTypeChecker()
  const unalias = symbol => symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol
  const entrySource = program.getSourceFile(join(workspace,entry))
  assert(entrySource, 'Entry source is loaded')
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(entrySource))
  const declared = new Map(targetNames.map(name => {
    const symbol = exports.find(row => row.name === name)
    assert(symbol, `Missing target export ${name}`)
    return [name, unalias(symbol)]
  }))
  assert.equal(new Set(declared.values()).size,declared.size,'Requested export slots share one declaration; a slot-specific oracle is required')
  const declarationIdentity=[...declared].map(([name,symbol])=>{
    const declarations=(symbol.declarations??[]).map(node=>({file:slash(relative(workspace,node.getSourceFile().fileName)),start:node.getStart(),end:node.getEnd()}))
    assert(declarations.length>0,'Target declaration identity is unavailable')
    assert(declarations.every(node=>owner(node.file)?.name===targetPackage),'Target export is defined outside the requested package; facade-slot impact requires a separate oracle')
    return {export:name,declarations}
  })
  const targetIdentities = new Map()
  for (const [name, symbol] of declared) {
    targetIdentities.set(symbol, name)
    // Native package imports can resolve to built declarations. Bind the same
    // named export only after native resolution proves exact workspace identity.
    for (const source of program.getSourceFiles()) {
      const key = slash(relative(workspace, source.fileName)), pkg = owner(key)
      const typesEntry = byTargetTypesEntry()
      if (pkg?.name !== targetPackage || !source.isDeclarationFile || key !== typesEntry) continue
      const module = checker.getSymbolAtLocation(source)
      if (!module) continue
      const candidate = checker.getExportsOfModule(module).find(row => row.name === name)
      if (candidate) targetIdentities.set(unalias(candidate), name)
    }
  }
  function byTargetTypesEntry() {
    const pkg=packages.find(row=>row.name===targetPackage)
    return pkg?.types ? slash(join(pkg.path,pkg.types)) : null
  }
  const direct = new Map(), unresolved = [], aliases = [], exclusionCandidates = new Map()
  function exclusion(source,node,symbol,reason,binding=null) {
    const file=slash(relative(workspace,source.fileName)),key=`${file}|${symbol}|${reason}`
    if(!exclusionCandidates.has(key))exclusionCandidates.set(key,{file,symbol,reason,sha256:sha256(source.text),occurrences:[],binding})
    exclusionCandidates.get(key).occurrences.push({start:node.getStart(source),end:node.getEnd(),line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1})
  }
  function add(source, node, symbolName, role, localName, route) {
    const file = slash(relative(workspace, source.fileName)), pkg = owner(file)
    if (!pkg || pkg.name === targetPackage) return
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line+1
    const key = `${file}|${symbolName}|${role}`
    if (!direct.has(key)) direct.set(key, { file, package: pkg.name, packageVersion: pkg.version, symbol: symbolName, role, sha256: sha256(source.text), occurrences: [] })
    direct.get(key).occurrences.push({ line, start:node.getStart(source), end:node.getEnd(), text: source.text.split(/\r?\n/u)[line-1], localName, route })
  }
  function isTypePosition(node) {
    for (let n=node.parent; n && !ts.isStatement(n); n=n.parent) {
      if (ts.isTypeNode(n)) return true
      if (ts.isImportSpecifier(n)) return n.isTypeOnly || n.parent.parent.isTypeOnly
      if (ts.isExportSpecifier(n)) return n.isTypeOnly || n.parent.parent.isTypeOnly
    }
    return false
  }
  for (const path of sourcePaths) {
    const source = program.getSourceFile(path)
    if (!source) continue
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const symbol = checker.getSymbolAtLocation(node.moduleSpecifier)
        if (!symbol) unresolved.push({ file:slash(relative(workspace,path)), module:node.moduleSpecifier.text })
        if (ts.isExportDeclaration(node) && !node.exportClause && symbol) {
          for (const exp of checker.getExportsOfModule(symbol)) {
            const target = targetIdentities.get(unalias(exp))
            if (target) add(source,node,target,'reexport',exp.name,node.moduleSpecifier.text)
          }
        }
      }
      if (ts.isIdentifier(node)||ts.isStringLiteralLike(node)) {
        const original = checker.getSymbolAtLocation(node), symbol = unalias(original), target = targetIdentities.get(symbol)
        if (target) {
          let parent=node.parent, exportNode=null, importNode=null
          while(parent && !ts.isSourceFile(parent)) { if(ts.isExportDeclaration(parent)) exportNode=parent; if(ts.isImportDeclaration(parent)) importNode=parent; parent=parent.parent }
          const role = exportNode ? 'reexport' : (isTypePosition(node) || !(symbol.flags & ts.SymbolFlags.Value) ? 'type-only' : 'runtime')
          const route = (exportNode ?? importNode)?.moduleSpecifier?.text ?? null
          add(source,node,target,role,node.text,route)
          if (node.text !== target) aliases.push({file:slash(relative(workspace,path)),symbol:target,localName:node.text})
        }
        const parent=node.parent
        const namedBinding=(parent.name===node&&(ts.isFunctionDeclaration(parent)||ts.isClassDeclaration(parent)||ts.isInterfaceDeclaration(parent)||ts.isTypeAliasDeclaration(parent)||ts.isVariableDeclaration(parent)||ts.isEnumDeclaration(parent)||ts.isImportClause(parent)||ts.isNamespaceImport(parent)))||ts.isImportSpecifier(parent)
        if((namedBinding||ts.isStringLiteralLike(node))&&symbol&&!target&&(symbol.declarations?.length??0)>0)exclusion(source,node,node.text,'different-symbol',{declarations:symbol.declarations.map(declaration=>({file:slash(relative(workspace,declaration.getSourceFile().fileName)),start:declaration.getStart(),end:declaration.getEnd()}))})
      }
      if(ts.isStringLiteralLike(node)&&!checker.getSymbolAtLocation(node))for(const target of targetNames)if(node.text.includes(target))exclusion(source,node,target,'string-or-comment-only')
      ts.forEachChild(node,visit)
    }
    visit(source)
    const scanner=ts.createScanner(ts.ScriptTarget.Latest,false,ts.LanguageVariant.Standard,source.text)
    for(let token=scanner.scan();token!==ts.SyntaxKind.EndOfFileToken;token=scanner.scan())if(token===ts.SyntaxKind.SingleLineCommentTrivia||token===ts.SyntaxKind.MultiLineCommentTrivia)for(const target of targetNames)if(scanner.getTokenText().includes(target))exclusion(source,{getStart:()=>scanner.getTokenPos(),getEnd:()=>scanner.getTextPos()},target,'string-or-comment-only')
  }
  for(const file of excludedSourceFiles) {
    const source=ts.createSourceFile(file,readFileSync(join(workspace,file),'utf8'),ts.ScriptTarget.Latest,true)
    exclusionCandidates.set(`${file}|*|outside-source-scope`,{file,symbol:'*',reason:'outside-source-scope',sha256:sha256(source.text),occurrences:[{start:0,end:source.text.length,line:1}],scopeProof:'Excluded from the owning native TypeScript configuration',allowAnySourceQuote:true})
  }
  const graph = [], unresolvedPackageEdges = [], externalSameNamePackages = []
  const byName = new Map(packages.map(pkg => [pkg.name,pkg]))
  for (const pkg of packages) for (const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) for (const [name,range] of Object.entries(pkg[field] ?? {})) {
    const installedManifest = join(workspace,pkg.path,'node_modules',name,'package.json')
    if (!existsSync(installedManifest)) { if(byName.has(name)) unresolvedPackageEdges.push({from:pkg.name,to:name,kind:field,range}); continue }
    const installed=read(installedManifest), actualPath=slash(relative(workspace,dirname(realpathSync(installedManifest))))
    const targetPkg=byName.get(installed.name)
    if(targetPkg && actualPath===targetPkg.path && installed.version===targetPkg.version) graph.push({from:pkg.name,to:installed.name,alias:name,kind:field,range,version:installed.version,manifest:`${pkg.path}/package.json`})
    else if(targetPkg) externalSameNamePackages.push({from:pkg.name,alias:name,name:installed.name,version:installed.version,workspaceVersion:targetPkg.version,kind:field,range})
  }
  const reached = new Set([targetPackage]), witnesses = []
  let changed=true
  while(changed) { changed=false; for(const edge of graph) if(reached.has(edge.to) && !reached.has(edge.from)) { reached.add(edge.from); witnesses.push(edge); changed=true } }
  reached.delete(targetPackage)
  return { schemaVersion:1, compilerVersion:ts.version, workspace, target:{package:targetPackage,version:byName.get(targetPackage)?.version,exports:targetNames,entry,identityMode:'defining-package-declaration-impact',declarationIdentity},
    scope:{productionOnly,productionSourceFiles:sourcePaths.map(path=>slash(relative(workspace,path))).sort(),scannedSourceFiles:sourcePaths.length,loadedSourceFiles:program.getSourceFiles().length,config,excludedSourceFiles:excludedSourceFiles.sort(),configFiles:[...configs.keys()].map(path=>({path:slash(relative(workspace,path)),sha256:sha256(readFileSync(path))}))},
    direct:[...direct.values()].sort((a,b)=>`${a.file}|${a.symbol}|${a.role}`.localeCompare(`${b.file}|${b.symbol}|${b.role}`)),
    aliases, exclusionCandidates:[...exclusionCandidates.values()], packageDependents:[...reached].sort(), packageGraph:graph, packageWitnesses:witnesses,
    packages:packages.map(pkg=>({name:pkg.name,version:pkg.version,path:pkg.path,scripts:pkg.scripts ?? {}})),
    unresolvedModules:unresolved, unresolvedPackageEdges, externalSameNamePackages,
    limitations:['Static semantic symbol references are not dynamic execution coverage.','Package dependency reachability is a conservative review set, not proof of symbol use.','External applications and computed runtime loading are outside the finite source scope.'] }
}
