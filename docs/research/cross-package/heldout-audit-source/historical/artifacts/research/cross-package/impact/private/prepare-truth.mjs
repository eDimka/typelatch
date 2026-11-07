import { readFileSync, writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { deriveOracle } from '../compiler-oracle.mjs'
const base=resolve('artifacts/research/cross-package/impact')
const cases=[{id:'development',workspace:join(base,'pnpm-workspace'),workspaceReceipt:join(base,'pnpm-workspaces.json'),targetPackage:'@pnpm/parse-wanted-dependency',exports:['parseWantedDependency','ParseWantedDependencyResult','ParsedWantedDependency'],entry:'packages/parse-wanted-dependency/src/index.ts',config:'packages/parse-wanted-dependency/tsconfig.json'},
{id:'heldout',workspace:join(base,'vue-source'),workspaceReceipt:join(base,'vue-workspaces.json'),targetPackage:'@vue/reactivity',exports:['ShallowRef'],entry:'packages/reactivity/src/index.ts',config:'tsconfig.json'}]
for(const config of cases) {
 const truth=deriveOracle(config)
 const packageNames=new Set([truth.target.package,...truth.direct.map(row=>row.package)])
 truth.validationTargets=[]
 for(const name of packageNames) {
  const pkg=truth.packages.find(row=>row.name===name),manifest=`${pkg.path}/package.json`,lines=readFileSync(join(config.workspace,manifest),'utf8').split('\n')
  for(const script of ['compile','test','_test']) if(pkg.scripts[script])truth.validationTargets.push({package:name,script,manifest,lines:[lines.findIndex(line=>line.includes(`"${script}":`))+1]})
 }
 if(!truth.validationTargets.length) {
  const manifest='package.json',data=JSON.parse(readFileSync(join(config.workspace,manifest))),lines=readFileSync(join(config.workspace,manifest),'utf8').split('\n')
  for(const script of ['check','test-unit','build'])if(data.scripts[script])truth.validationTargets.push({package:'<root>',script,manifest,lines:[lines.findIndex(line=>line.includes(`"${script}":`))+1]})
 }
 const exclusion=config.id==='development'?{file:'pkg-manager/core/src/parseWantedDependencies.ts',symbol:'parseWantedDependencies',reason:'different-symbol',match:'export function parseWantedDependencies'}:{file:'packages/runtime-core/src/customFormatter.ts',symbol:'ShallowRef',reason:'string-or-comment-only',match:'return `ShallowRef`'}
 const lines=readFileSync(join(config.workspace,exclusion.file),'utf8').split('\n'),line=lines.findIndex(line=>line.includes(exclusion.match))+1
 if(!line)throw Error('Exclusion source missing')
 truth.exclusions=[{file:exclusion.file,symbol:exclusion.symbol,reason:exclusion.reason,lines:[line]}]
 truth.requiredUncertainties=['external-consumers','dynamic-loading','package-reachability-not-symbol-use','unexecuted-validation']
 const filterPath=join(base,config.id==='development'?'pnpm-dependent-filter.json':'vue-dependent-filter.json')
 const filter=JSON.parse(JSON.parse(readFileSync(filterPath)).stdout).map(row=>row.name).filter(name=>name!==truth.target.package).sort()
 if(JSON.stringify(filter)!==JSON.stringify(truth.packageDependents))throw Error('Native dependent filter disagreement')
 truth.nativeDependentFilterAgreement={passed:true,path:filterPath,packageCount:filter.length}
 function quote(file,line) {return {startLine:line,endLine:line,quote:readFileSync(join(config.workspace,file),'utf8').split('\n')[line-1]}}
 function chain(from,visited=new Set()) {if(from===truth.target.package)return[from];if(visited.has(from))return null;const next=new Set([...visited,from]);for(const edge of truth.packageGraph.filter(row=>row.from===from)){const path=chain(edge.to,next);if(path)return[from,...path]}return null}
 const gold={schemaVersion:1,target:{package:truth.target.package,version:truth.target.version,exports:truth.target.exports},direct:truth.direct.map(row=>({file:row.file,package:row.package,symbol:row.symbol,role:row.role,evidence:quote(row.file,row.occurrences[0].line)})),
 packageDependents:truth.packageDependents.map(packageName=>({package:packageName,chain:chain(packageName)})),validationTargets:truth.validationTargets.map(row=>({package:row.package,script:row.script,evidence:{file:row.manifest,...quote(row.manifest,row.lines[0])}})),
 exclusions:truth.exclusions.map(row=>({file:row.file,symbol:row.symbol,reason:row.reason,evidence:quote(row.file,row.lines[0])})),uncertainties:truth.requiredUncertainties.map(code=>({code,detail:{'external-consumers':'Applications outside this pinned workspace are not enumerated.','dynamic-loading':'Computed loading and metaprogrammed names are outside static symbol proof.','package-reachability-not-symbol-use':'Dependency reachability is a conservative review set, not evidence of symbol use.','unexecuted-validation':'Listed scripts are review targets; passing all affected tests has not been established.'}[code]})),negativeClaims:[]}
 writeFileSync(join(base,'private',config.id+'-oracle.json'),JSON.stringify(truth,null,2)+'\n')
 writeFileSync(join(base,'private',config.id+'-gold.json'),JSON.stringify(gold,null,2)+'\n')
 console.log(JSON.stringify({id:config.id,direct:truth.direct.length,dependents:truth.packageDependents.length,targets:truth.validationTargets.length,excluded:truth.scope.excludedSourceFiles.length}))
}
