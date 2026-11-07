import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { deriveOracle } from '../compiler-oracle.mjs'

const base=resolve('artifacts/research/cross-package/impact/private/runtime-qualification'),workspace=join(base,'workspace')
mkdirSync(base,{recursive:true})
const config={workspace,workspaceReceipt:join(base,'workspaces.json'),targetPackage:'@vue/shared',exports:['normalizeClass'],entry:'packages/shared/src/index.ts',config:'tsconfig.json'}
const truth=deriveOracle(config)
const nativeNames=JSON.parse(JSON.parse(readFileSync(join(base,'dependent-filter.json'))).stdout).map(row=>row.name).filter(name=>name!==truth.target.package).sort()
assert.deepEqual(truth.packageDependents,nativeNames)
truth.nativeDependentFilterAgreement={passed:true,path:join(base,'dependent-filter.json'),packageCount:nativeNames.length}
const nativeManifest='package.json',manifest=JSON.parse(readFileSync(join(workspace,nativeManifest))),lines=readFileSync(join(workspace,nativeManifest),'utf8').split('\n')
truth.validationTargets=['check','test-unit','build'].map(script=>{assert(manifest.scripts[script]);return {package:'<root>',script,manifest:nativeManifest,lines:[lines.findIndex(line=>line.includes(`"${script}":`))+1]}})
const excludedFile='packages/compiler-core/src/runtimeHelpers.ts',excludedLines=readFileSync(join(workspace,excludedFile),'utf8').split('\n'),excludedLine=excludedLines.findIndex(line=>line.includes('[NORMALIZE_CLASS]: `normalizeClass`'))+1
assert(excludedLine>0)
truth.exclusions=[{file:excludedFile,symbol:'normalizeClass',reason:'string-or-comment-only',lines:[excludedLine],qualification:'A generated helper name is excluded only from direct compiler-resolved source references, never from possible generated-code impact.'}]
truth.requiredUncertainties=['external-consumers','dynamic-loading','package-reachability-not-symbol-use','unexecuted-validation']
function quote(file,line){return{startLine:line,endLine:line,quote:readFileSync(join(workspace,file),'utf8').split('\n')[line-1]}}
function chain(from,visited=new Set()){if(from===truth.target.package)return[from];if(visited.has(from))return null;const next=new Set([...visited,from]);for(const edge of truth.packageGraph.filter(row=>row.from===from)){const rest=chain(edge.to,next);if(rest)return[from,...rest]}return null}
const gold={schemaVersion:1,target:{package:truth.target.package,version:truth.target.version,exports:truth.target.exports},direct:truth.direct.map(row=>({file:row.file,package:row.package,symbol:row.symbol,role:row.role,evidence:quote(row.file,row.occurrences[0].line)})),packageDependents:truth.packageDependents.map(packageName=>({package:packageName,chain:chain(packageName)})),validationTargets:truth.validationTargets.map(row=>({package:row.package,script:row.script,evidence:{file:row.manifest,...quote(row.manifest,row.lines[0])}})),exclusions:truth.exclusions.map(row=>({file:row.file,symbol:row.symbol,reason:row.reason,evidence:quote(row.file,row.lines[0])})),uncertainties:truth.requiredUncertainties.map(code=>({code,detail:{'external-consumers':'Applications outside this frozen workspace are not enumerated.','dynamic-loading':'The compiler generates named helper calls. Their string registry is not a direct TypeScript reference, but excluding it from that set does not establish absence of generated-code impact. Other computed loading remains unknown.','package-reachability-not-symbol-use':'Installed package reachability is a conservative review set, not proof of direct symbol usage.','unexecuted-validation':'Listed scripts are candidate validation targets; passing every affected test is not established.'}[code]})),negativeClaims:[]}
// Independent native LanguageService query uses the repository root configuration,
// without the oracle's per-file module resolver or precomputed consumer list.
const ts=createRequire(join(workspace,'package.json'))('typescript'),loaded=ts.readConfigFile(join(workspace,'tsconfig.json'),ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(loaded.config,ts.sys,workspace)
const host={...ts.sys,getCompilationSettings:()=>parsed.options,getScriptFileNames:()=>parsed.fileNames,getScriptVersion:()=> '0',getScriptSnapshot:file=>ts.sys.fileExists(file)?ts.ScriptSnapshot.fromString(ts.sys.readFile(file)):undefined,getCurrentDirectory:()=>workspace,getDefaultLibFileName:options=>ts.getDefaultLibFilePath(options)}
const service=ts.createLanguageService(host),definition=join(workspace,'packages/shared/src/normalizeProp.ts'),source=readFileSync(definition,'utf8'),position=source.indexOf('normalizeClass(value:')
assert(position>=0)
const started=performance.now(),references=service.getReferencesAtPosition(definition,position),elapsedMs=performance.now()-started
const native={compilerVersion:ts.version,config:'tsconfig.json',definition:'packages/shared/src/normalizeProp.ts',position,elapsedMs,references}
service.dispose()
writeFileSync(join(base,'native-references.json'),JSON.stringify(native,null,2)+'\n')
writeFileSync(join(base,'truth-v1.json'),JSON.stringify(truth,null,2)+'\n')
writeFileSync(join(base,'gold-v1.json'),JSON.stringify(gold,null,2)+'\n')
console.log(JSON.stringify({status:'prepared',productionPackages:new Set([truth.target.package,...truth.direct.map(row=>row.package)]).size,directFacts:truth.direct.length,nativeReferences:references?.length}))
