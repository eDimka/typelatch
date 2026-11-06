import assert from 'node:assert/strict'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
const sha=value=>createHash('sha256').update(value).digest('hex')
const inside=(root,file)=>{const value=relative(root,file);return value!== '..'&&!value.startsWith('../')&&!isAbsolute(value)}
const read=path=>JSON.parse(readFileSync(path,'utf8'))
const slash=value=>value.replaceAll('\\','/')
function nativePackage(root,from,name) {
 for(let dir=from;inside(root,dir);dir=dirname(dir)) {
  const file=join(dir,'node_modules',name,'package.json')
  if(existsSync(file)) {const path=realpathSync(file);if(!inside(root,path))return null;return {...read(path),root:dirname(path)}}
  if(dir===root)break
 }
 return null
}
function ownerOf(file,packages){return packages.find(pkg=>inside(pkg.root,file))}
function quote(source,node){const line=source.getLineAndCharacterOfPosition(node.getStart(source)).line;return {startLine:line+1,endLine:line+1,quote:source.text.split(/\r?\n/u)[line]}}
function scriptEvidence(ts,file,text,name){
 const source=ts.parseJsonText(file,text),object=source.statements[0]?.expression
 const scripts=object?.properties?.find(property=>property.name?.text==='scripts')?.initializer
 const node=scripts?.properties?.find(property=>property.name?.text===name)
 return node?quote(source,node):null
}

export async function packageEvidence(input,{runtimeRoot,signal=AbortSignal.timeout(120000)}={}) {
 const start=performance.now(),root=realpathSync(resolve(input.workspaceRoot))
 assert(runtimeRoot&&typeof input.package==='string'&&input.package.length>0)
 assert(Array.isArray(input.exports)&&input.exports.length>0&&input.exports.length<=30&&input.exports.every(name=>typeof name==='string'&&name.length>0))
 const names=[...new Set(input.exports)].sort(),issues=[],excluded=[]
 const {inventoryWorkspace}=await import(pathToFileURL(join(runtimeRoot,'dist/workspace/inventory.js')).href)
 const {workspacePatterns,matchesWorkspace}=await import(pathToFileURL(join(runtimeRoot,'dist/project-files.js')).href)
 const inventory=await inventoryWorkspace(root,false,signal)
 for(const message of inventory.issues)issues.push({code:'inventory-limit',detail:message})
 const observed=new Map(inventory.files.map(file=>[file.path,file]))
 const manifestFile=observed.get(join(root,'package.json'));assert(manifestFile,'Workspace package.json is required')
 const patterns=workspacePatterns(JSON.parse(manifestFile.text),observed.get(join(root,'pnpm-workspace.yaml'))?.text)
 const packages=inventory.projects.filter(path=>path===root||matchesWorkspace(slash(relative(root,path)),patterns)).map(path=>{
  const file=observed.get(join(path,'package.json'));return file?{...JSON.parse(file.text),root:path,manifest:file}:null
 }).filter(pkg=>pkg?.name).sort((a,b)=>b.root.length-a.root.length)
 const candidates=packages.filter(pkg=>pkg.name===input.package)
 assert.equal(candidates.length,1,'Exactly one declared workspace package must match; external package impact is not supported by this prototype')
 const target=candidates[0]
 let ts,compilerPath,compilerSource='workspace'
 try{compilerPath=createRequire(join(root,'package.json')).resolve('typescript');ts=createRequire(join(root,'package.json'))('typescript')}
 catch{compilerPath=createRequire(join(runtimeRoot,'package.json')).resolve('typescript');ts=createRequire(join(runtimeRoot,'package.json'))('typescript');compilerSource='bundled-fallback'}
 const configs=new Map(),fileConfig=new Map(),ambiguousFiles=new Set(),sourceNames=[]
 const issue=(value)=>{if(!issues.some(row=>JSON.stringify(row)===JSON.stringify(value)))issues.push(value)}
 const parseConfig=path=>{
  if(configs.has(path))return configs.get(path)
  const loaded=ts.readConfigFile(path,ts.sys.readFile)
  if(loaded.error){issue({code:'config-error',file:slash(relative(root,path))});configs.set(path,null);return null}
  const parsed=ts.parseJsonConfigFileContent(loaded.config,ts.sys,dirname(path),undefined,path)
  if(parsed.errors.some(error=>error.code!==18003)){issue({code:'config-error',file:slash(relative(root,path)),codes:parsed.errors.map(error=>error.code)});configs.set(path,null);return null}
  configs.set(path,{...parsed,path});return configs.get(path)
 }
 const configClosure=(path,seen=new Set())=>{
  if(seen.has(path))return [];seen.add(path)
  if(!inside(root,path)||!observed.has(path)){issue({code:'unsupported-project-reference',file:slash(relative(root,path))});return []}
  const parsed=parseConfig(path);if(!parsed)return []
  return [parsed,...(parsed.projectReferences??[]).flatMap(ref=>configClosure(ts.resolveProjectReferencePath(ref),seen))]
 }
 for(const pkg of packages) {
  signal.throwIfAborted()
  let configPath
  for(let dir=pkg.root;inside(root,dir);dir=dirname(dir)){if(observed.has(join(dir,'tsconfig.json'))){configPath=join(dir,'tsconfig.json');break}if(dir===root)break}
  if(!configPath){if(inventory.files.some(file=>inside(join(pkg.root,'src'),file.path)))issue({code:'missing-config',package:pkg.name});continue}
  for(const parsed of configClosure(configPath))for(const file of parsed.fileNames){
   if(!observed.has(file)||!inside(join(pkg.root,'src'),file)||ownerOf(file,packages)!==pkg||/\.d\.[cm]?ts$/u.test(file)||/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(slash(file)))continue
   const previous=fileConfig.get(file)
   if(previous&&previous.path!==parsed.path&&JSON.stringify(previous.options)!==JSON.stringify(parsed.options)){
    ambiguousFiles.add(file);issue({code:'ambiguous-project-config',file:slash(relative(root,file)),configs:[previous.path,parsed.path].map(p=>slash(relative(root,p))).sort()});continue
   }
   sourceNames.push(file);fileConfig.set(file,parsed)
  }
 }
 const roots=[...new Set(sourceNames)].filter(file=>!ambiguousFiles.has(file)).sort()
 const base=(observed.has(join(root,'tsconfig.json'))?parseConfig(join(root,'tsconfig.json')):null)??fileConfig.get(roots[0])
 assert(base,'A native TypeScript configuration is required')
 const options={...base.options,noEmit:true,skipLibCheck:true,allowJs:true};delete options.rootDir;delete options.outDir;delete options.composite;delete options.incremental;delete options.tsBuildInfoFile
 const configFor=file=>fileConfig.get(file)??(()=>{const pkg=ownerOf(file,packages);let path=pkg&&join(pkg.root,'tsconfig.json');return path&&existsSync(path)?parseConfig(path):null})()??base
 const host=ts.createCompilerHost(options),originalRead=host.readFile
 host.readFile=file=>observed.get(file)?.text??originalRead(file)
 host.resolveModuleNameLiterals=(literals,file,redirect,_options,source)=>{
  const local=configFor(file).options
  return literals.map(literal=>ts.resolveModuleName(literal.text,file,local,ts.sys,undefined,redirect,ts.getModeForUsageLocation?.(source,literal,local)))
 }
 const program=ts.createProgram({rootNames:roots,options,host}),checker=program.getTypeChecker()
 const unalias=symbol=>{try{return symbol&&(symbol.flags&ts.SymbolFlags.Alias)?checker.getAliasedSymbol(symbol):symbol}catch{return null}}
 const moduleCache=new Map(),targetModules=new Set(),targetEntries=new Set(),found=new Set()
 const moduleAt=literal=>{
  if(moduleCache.has(literal))return moduleCache.get(literal)
  const source=literal.getSourceFile(),local=configFor(source.fileName).options
  const result=ts.resolveModuleName(literal.text,source.fileName,local,ts.sys,undefined,undefined,ts.getModeForUsageLocation?.(source,literal,local)).resolvedModule
  const module=checker.getSymbolAtLocation(literal)
  // Ambient declarations such as node:fs have a compiler binding without a
  // filesystem resolution. They cannot establish an installed target identity.
  if(!result&&module?.declarations?.some(node=>ts.isModuleDeclaration(node))){moduleCache.set(literal,module);return module}
  if(!result){issue({code:'unresolved-static-module',file:slash(relative(root,source.fileName)),module:literal.text});moduleCache.set(literal,null);return null}
  if(!module){issue({code:'unresolved-module-symbol',file:slash(relative(root,source.fileName)),module:literal.text});moduleCache.set(literal,null);return null}
  const real=realpathSync(result.resolvedFileName)
  const bare=literal.text.match(/^(@[^/]+\/[^/]+|[^./][^/]*)/u)?.[1]
  const installed=bare&&nativePackage(root,dirname(source.fileName),bare)
  const exactName=literal.text===input.package
  if((exactName||installed?.root===target.root)&&literal.text===bare){
   if(inside(target.root,real)){
    targetModules.add(module);targetEntries.add(slash(relative(root,real)))
    for(const value of checker.getExportsOfModule(module))if(names.includes(value.name)&&unalias(value)?.declarations?.length)found.add(value.name)
   }else if(exactName)excluded.push({file:slash(relative(root,source.fileName)),reason:'other-package-instance',module:literal.text,resolved:slash(relative(root,real)),evidence:quote(source,literal)})
  }
  moduleCache.set(literal,module);return module
 }
 // Resolve static module boundaries up front. A broken intermediate barrel cannot
 // silently turn a partial reference graph into an empty complete result.
 for(const file of roots){
  const source=program.getSourceFile(file);if(!source)continue
  function scan(node){
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))moduleAt(node.moduleSpecifier)
   if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&ts.isStringLiteral(node.moduleReference.expression)){
    moduleAt(node.moduleReference.expression);issue({code:'unsupported-import-equals',file:slash(relative(root,file))})
   }
   if(ts.isImportTypeNode(node)||ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'))issue({code:'unsupported-loading-form',file:slash(relative(root,file)),line:quote(source,node).startLine})
   ts.forEachChild(node,scan)
  }
  scan(source)
 }
 const matches=new Map(),lookalikes=[],routeCache=new Map()
 const noValue=symbol=>!!symbol&&!(unalias(symbol)?.flags&ts.SymbolFlags.Value)
 const slot=(name,symbol)=>({kind:'slot',name,typeOnly:noValue(symbol)||(symbol.declarations??[]).some(node=>ts.isExportSpecifier(node)&&(node.isTypeOnly||node.parent.parent.isTypeOnly))})
 const asType=(routes,flag)=>flag?routes.map(route=>({...route,typeOnly:true})):routes
 const namespace=module=>module?[{kind:'namespace',module}]:[]
 const unique=routes=>routes.filter((route,index)=>routes.findIndex(other=>route.kind===other.kind&&(route.kind==='slot'?route.name===other.name:route.module===other.module))===index)
 const exportsOf=module=>module?checker.getExportsOfModule(module):[]
 function exportRoutes(module,name,trail=new Set()){
  if(!module)return []
  let cache=routeCache.get(module);if(!cache){cache=new Map();routeCache.set(module,cache)}
  if(cache.has(name))return cache.get(name)
  const symbol=exportsOf(module).find(value=>value.name===name)
  if(!symbol)return []
  if(targetModules.has(module))return names.includes(name)?[slot(name,symbol)]:[]
  const marker={module,name}
  if([...trail].some(row=>row.module===module&&row.name===name))return []
  const next=new Set([...trail,marker]),routes=[]
  for(const declaration of symbol.declarations??[]){
   if(ts.isExportSpecifier(declaration)){
    const statement=declaration.parent.parent
    if(statement.moduleSpecifier)routes.push(...asType(exportRoutes(moduleAt(statement.moduleSpecifier),(declaration.propertyName??declaration.name).text,next),declaration.isTypeOnly||statement.isTypeOnly))
    else routes.push(...asType(symbolRoutes(checker.getExportSpecifierLocalTargetSymbol(declaration),next),declaration.isTypeOnly||statement.isTypeOnly))
   }else if(ts.isNamespaceExport(declaration))routes.push(...asType(namespace(moduleAt(declaration.parent.moduleSpecifier)),declaration.parent.isTypeOnly))
   else if(ts.isImportSpecifier(declaration)||ts.isImportClause(declaration)||ts.isNamespaceImport(declaration))routes.push(...symbolRoutes(symbol,next))
   else if(ts.isExportAssignment(declaration)&&!declaration.isExportEquals)routes.push(...expressionRoutes(declaration.expression,next))
   else if(ts.isVariableDeclaration(declaration)&&declaration.initializer)routes.push(...expressionRoutes(declaration.initializer,next))
  }
  // Star exports borrow the referenced module's symbol declarations. Retain the
  // explicit export edge, rather than inferring identity from that declaration.
  for(const source of module.declarations??[]){
   if(!ts.isSourceFile(source))continue
   for(const statement of source.statements)if(ts.isExportDeclaration(statement)&&!statement.exportClause&&statement.moduleSpecifier){
    const other=moduleAt(statement.moduleSpecifier),value=exportsOf(other).find(value=>value.name===name)
    if(value&&unalias(value)===unalias(symbol))routes.push(...asType(exportRoutes(other,name,next),statement.isTypeOnly))
   }
  }
  const result=unique(routes);cache.set(name,result);return result
 }
 function symbolRoutes(symbol,trail=new Set()){
  if(!symbol)return []
  const routes=[]
  for(const declaration of symbol.declarations??[]){
   if(ts.isImportSpecifier(declaration))routes.push(...asType(exportRoutes(moduleAt(declaration.parent.parent.parent.moduleSpecifier),(declaration.propertyName??declaration.name).text,trail),declaration.isTypeOnly||declaration.parent.parent.isTypeOnly))
   else if(ts.isImportClause(declaration))routes.push(...asType(exportRoutes(moduleAt(declaration.parent.moduleSpecifier),'default',trail),declaration.isTypeOnly))
   else if(ts.isNamespaceImport(declaration))routes.push(...asType(namespace(moduleAt(declaration.parent.parent.moduleSpecifier)),declaration.parent.isTypeOnly))
   else if(ts.isExportSpecifier(declaration)){
    const statement=declaration.parent.parent
    if(statement.moduleSpecifier)routes.push(...asType(exportRoutes(moduleAt(statement.moduleSpecifier),(declaration.propertyName??declaration.name).text,trail),declaration.isTypeOnly||statement.isTypeOnly))
    else {const local=checker.getExportSpecifierLocalTargetSymbol(declaration);if(local!==symbol)routes.push(...asType(symbolRoutes(local,trail),declaration.isTypeOnly||statement.isTypeOnly))}
   }
  }
  return unique(routes)
 }
 function expressionRoutes(node,trail=new Set()){
  if(ts.isIdentifier(node))return symbolRoutes(checker.getSymbolAtLocation(node),trail)
  if(ts.isPropertyAccessExpression(node)||ts.isQualifiedName(node)){
   const base=expressionRoutes(node.expression??node.left,trail),name=(node.name??node.right).text
   return unique(base.flatMap(route=>route.kind==='namespace'?asType(exportRoutes(route.module,name,trail),route.typeOnly):[]))
  }
  if(ts.isElementAccessExpression(node)&&ts.isStringLiteralLike(node.argumentExpression))return unique(expressionRoutes(node.expression,trail).flatMap(route=>route.kind==='namespace'?asType(exportRoutes(route.module,node.argumentExpression.text,trail),route.typeOnly):[]))
  return []
 }
 function flatten(routes,seen=new Set()){
  const result=[]
  for(const route of routes){
   if(route.kind==='slot')result.push(route)
   else if(!seen.has(route.module)){
    const next=new Set([...seen,route.module])
    for(const value of exportsOf(route.module))result.push(...asType(flatten(exportRoutes(route.module,value.name),next),route.typeOnly))
   }
  }
  return unique(result)
 }
 function useRole(node){
  for(let value=node;value&&!ts.isSourceFile(value);value=value.parent){
   if(ts.isExportDeclaration(value))return 'reexport'
   if(ts.isImportClause(value)&&value.isTypeOnly||ts.isImportSpecifier(value)&&value.isTypeOnly||ts.isTypeNode(value))return 'type-only'
  }
  return 'runtime'
 }
 function add(source,node,pkg,routes,role){
  for(const route of role==='reexport'?flatten(routes):routes.filter(route=>route.kind==='slot')){
   const use=role==='reexport'?role:route.typeOnly?'type-only':role,key=`${source.fileName}|${route.name}|${use}`,position=quote(source,node)
   if(!matches.has(key))matches.set(key,{file:slash(relative(root,source.fileName)),package:pkg.name,version:pkg.version,symbol:route.name,role:use,evidence:position,occurrences:[]})
   const row=matches.get(key)
   if(!row.occurrences.some(value=>value.line===position.startLine))row.occurrences.push({line:position.startLine,localName:node.text??route.name,text:position.quote})
  }
 }
 const normalizedName=name=>name.toLowerCase().replace(/ies$/u,'y').replace(/s$/u,'')
 function similar(a,b){
  a=normalizedName(a);b=normalizedName(b)
  if(a===b)return true
  if(a.length<8||b.length<8||Math.abs(a.length-b.length)>2)return false
  let row=Array.from({length:b.length+1},(_,i)=>i)
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next}
  return row[b.length]<=2
 }
 const targetSymbols=new Set([...targetModules].flatMap(module=>exportsOf(module).filter(value=>names.includes(value.name)).map(unalias)))
 for(const file of roots){
  signal.throwIfAborted();const source=program.getSourceFile(file),pkg=ownerOf(file,packages)
  if(!source||!pkg||pkg.root===target.root)continue
  for(const statement of source.statements){
   if(ts.isImportDeclaration(statement)&&statement.importClause){
    const clause=statement.importClause,module=moduleAt(statement.moduleSpecifier)
    if(clause.name)add(source,clause.name,pkg,exportRoutes(module,'default'),clause.isTypeOnly?'type-only':'runtime')
    if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const item of clause.namedBindings.elements)add(source,item.name,pkg,exportRoutes(module,(item.propertyName??item.name).text),clause.isTypeOnly||item.isTypeOnly?'type-only':'runtime')
   }
   if(ts.isExportDeclaration(statement)){
    if(statement.moduleSpecifier){
     const module=moduleAt(statement.moduleSpecifier)
     if(!statement.exportClause||ts.isNamespaceExport(statement.exportClause))add(source,statement,pkg,namespace(module),'reexport')
     else for(const item of statement.exportClause.elements)add(source,item.name,pkg,exportRoutes(module,(item.propertyName??item.name).text),'reexport')
    }else if(statement.exportClause&&ts.isNamedExports(statement.exportClause))for(const item of statement.exportClause.elements)add(source,item.name,pkg,symbolRoutes(checker.getExportSpecifierLocalTargetSymbol(item)),'reexport')
   }
  }
  function visit(node){
   if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))return
   if(ts.isPropertyAccessExpression(node)||ts.isQualifiedName(node)||ts.isElementAccessExpression(node)){
    add(source,node.name??node.right??node,pkg,expressionRoutes(node),useRole(node))
    if(ts.isElementAccessExpression(node)&&!ts.isStringLiteralLike(node.argumentExpression)&&flatten(expressionRoutes(node.expression)).length)issue({code:'unsupported-computed-member',file:slash(relative(root,file)),line:quote(source,node).startLine})
   }
   if(ts.isIdentifier(node)){
    const symbol=checker.getSymbolAtLocation(node),routes=symbolRoutes(symbol)
    // Namespace containers are not individual export uses until a property or
    // explicit export edge identifies the requested slot.
    add(source,node,pkg,routes.filter(route=>route.kind==='slot'),useRole(node))
    if(routes.some(route=>route.kind==='namespace')&&flatten(routes).length&&!(ts.isPropertyAccessExpression(node.parent)&&node.parent.expression===node||ts.isQualifiedName(node.parent)&&node.parent.left===node||ts.isElementAccessExpression(node.parent)&&node.parent.expression===node))issue({code:'unsupported-namespace-value-use',file:slash(relative(root,file)),line:quote(source,node).startLine})
    if(!flatten(routes).length&&symbol&&unalias(symbol)?.declarations?.length&&!targetSymbols.has(unalias(symbol))&&names.some(name=>similar(node.text,name))&&(ts.isFunctionDeclaration(node.parent)||ts.isVariableDeclaration(node.parent)||ts.isClassDeclaration(node.parent)||ts.isInterfaceDeclaration(node.parent)||ts.isTypeAliasDeclaration(node.parent))&&node.parent.name===node)lookalikes.push({file:slash(relative(root,file)),symbol:node.text,reason:'different-symbol',evidence:quote(source,node)})
   }
   ts.forEachChild(node,visit)
  }
  visit(source)
 }
 for(const name of names)if(!found.has(name))issue({code:'unknown-export',symbol:name,detail:'No configured exact-package entry import resolved this export slot'})
 const graph=[]
 for(const pkg of packages)for(const kind of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const alias of Object.keys(pkg[kind]??{})){
  const installed=nativePackage(root,pkg.root,alias),destination=installed&&packages.find(value=>value.root===installed.root)
  if(destination&&!graph.some(edge=>edge.from===pkg.name&&edge.to===destination.name))graph.push({from:pkg.name,to:destination.name,kind,alias,version:destination.version})
  else if(!installed&&packages.some(value=>value.name===alias))issues.push({code:'unresolved-workspace-dependency',package:pkg.name,dependency:alias})
 }
 const chains=new Map([[target.name,[target.name]]]),queue=[target.name]
 while(queue.length){const current=queue.shift();for(const edge of graph.filter(row=>row.to===current))if(!chains.has(edge.from)){chains.set(edge.from,[edge.from,...chains.get(current)]);queue.push(edge.from)}}
 const direct=[...matches.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.symbol.localeCompare(b.symbol)||a.role.localeCompare(b.role))
 const validationTargets=[],owners=new Set([target.name,...direct.map(row=>row.package)])
 const scriptNames=/^(?:compile|build|check|typecheck|test|_test|test-unit)$/u
 const addScripts=pkg=>{for(const [script,command] of Object.entries(pkg.scripts??{})){
  if(!scriptNames.test(script))continue
  const evidence=scriptEvidence(ts,pkg.manifest.path,pkg.manifest.text,script)
  if(evidence)validationTargets.push({package:pkg.name,script,command,evidence:{file:slash(relative(root,pkg.manifest.path)),...evidence}})
 }}
 const ownerPackages=packages.filter(value=>owners.has(value.name)).sort((a,b)=>a.name.localeCompare(b.name))
 for(const pkg of ownerPackages)addScripts(pkg)
 if(ownerPackages.some(pkg=>!Object.keys(pkg.scripts??{}).some(name=>scriptNames.test(name)))){
  const rootPackage={...JSON.parse(manifestFile.text),name:'<root>',manifest:manifestFile}
  addScripts(rootPackage)
 }
 const uncertainty=[{code:'external-consumers',detail:'Only this installed workspace is inspected.'},{code:'dynamic-loading',detail:'Computed imports and generated runtime loading are not proven; detected unsupported static loading forms are explicit issues.'},{code:'package-reachability-not-symbol-use',detail:'Dependency chains identify conservative review candidates, not proven symbol users.'},{code:'unexecuted-validation',detail:'Listed scripts are candidates and have not been executed. Root scripts are fallback candidates when an owner lacks local validation scripts.'},{code:'lookalike-candidates',detail:'Declared names are compared with a bounded lexical heuristic and must have different checker symbols. This candidate list is not exhaustive and does not prove absence of other lookalikes.'}]
 for(const file of inventory.files)if(sha(readFileSync(file.path))!==file.hash)throw Error('Source changed during evidence collection: '+slash(relative(root,file.path)))
 return {schemaVersion:1,status:issues.length?'partial':'ok',target:{package:target.name,version:target.version,root:slash(relative(root,target.root)),exports:names,entries:[...targetEntries].sort()},direct,packageDependents:[...chains].filter(([name])=>name!==target.name).map(([packageName,chain])=>({package:packageName,chain})).sort((a,b)=>a.package.localeCompare(b.package)),validationTargets,excluded,lookalikes,uncertainties:uncertainty,issues,
  coverage:{packages:packages.length,configuredSourceFiles:roots.length,scope:'Configured package src files, excluding declarations. Binding program uses native per-file module resolution; it does not typecheck project build compatibility.',compilerVersion:ts.version,compilerSource,compilerSha256:sha(readFileSync(compilerPath)),snapshotSha256:sha(JSON.stringify(inventory.files.map(file=>[slash(relative(root,file.path)),file.hash]))),elapsedMs:performance.now()-start}}
}
