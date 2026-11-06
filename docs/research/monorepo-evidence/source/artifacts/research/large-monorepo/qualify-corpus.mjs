import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {parse} from 'yaml'
import {minimatch} from 'minimatch'
import {inventoryTree} from '../../../scripts/paired-agent-integrity.mjs'
const base=import.meta.dirname, root=resolve(base,'pnpm-source')
const git=args=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
const pin='eaae772717d3d36903960af125a2a2ff9d34fe09'
assert.equal(git(['rev-parse','HEAD']),pin)
assert.equal(git(['status','--porcelain']), '')
const files=git(['ls-files','-z']).split('\0').filter(Boolean)
const workspace=parse(readFileSync(join(root,'pnpm-workspace.yaml'),'utf8'))
const lock=parse(readFileSync(join(root,'pnpm-lock.yaml'),'utf8'))
const matches=path=>workspace.packages.filter(p=>!p.startsWith('!')).some(p=>minimatch(path,p,{dot:true}))&&!workspace.packages.filter(p=>p.startsWith('!')).some(p=>minimatch(path,p.slice(1),{dot:true}))
const projects=files.filter(p=>p.endsWith('/package.json')&&matches(dirname(p))).map(path=>({path:dirname(path),manifest:JSON.parse(readFileSync(join(root,path),'utf8'))})).sort((a,b)=>a.path.localeCompare(b.path))
const catalogs=[['default',workspace.catalog??{}],...Object.entries(workspace.catalogs??{})]
const aliases=catalogs.flatMap(([catalog,entries])=>Object.entries(entries).filter(([,specifier])=>typeof specifier==='string'&&specifier.startsWith('npm:')).map(([name,specifier])=>({catalog,name,specifier,consumers:projects.filter(project=>['dependencies','devDependencies','optionalDependencies','peerDependencies'].some(section=>project.manifest[section]?.[name]===(catalog==='default'?'catalog:':`catalog:${catalog}`))).map(project=>({path:project.path,name:project.manifest.name}))})))
const versions=new Map()
for(const key of Object.keys(lock.packages??{})){const identity=key.split('(')[0],separator=identity.lastIndexOf('@');if(separator<=0)continue;const name=identity.slice(0,separator),version=identity.slice(separator+1);if(!versions.has(name))versions.set(name,new Set());versions.get(name).add(version)}
const multipleVersions=[...versions].filter(([,value])=>value.size>1).map(([name,values])=>({name,versions:[...values].sort()})).sort((a,b)=>a.name.localeCompare(b.name))
const ownership=projects.map(({path,manifest})=>({path,name:manifest.name,version:manifest.version,lockImporter:lock.importers?.[path]??null,hasTsconfig:files.includes(path+'/tsconfig.json'),hasTestTsconfig:files.includes(path+'/tsconfig.test.json')}))
const configs=[],configParseErrors=[]
for(const path of files.filter(p=>/(^|\/)tsconfig[^/]*\.json$/.test(p))){try{const value=JSON.parse(readFileSync(join(root,path),'utf8'));configs.push({path,extends:value.extends??null,composite:value.compilerOptions?.composite??null,include:value.include??null,exclude:value.exclude??null,files:value.files??null,references:value.references??[]})}catch{configParseErrors.push(path)}}
const directVersions=new Map()
for(const project of ownership)for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const [name,entry] of Object.entries(project.lockImporter?.[section]??{})){if(!entry?.version||entry.version.startsWith('link:'))continue;if(!directVersions.has(name))directVersions.set(name,[]);directVersions.get(name).push({project:project.path,section,specifier:entry.specifier,version:entry.version})}
const distinctImporterVersions=[...directVersions].filter(([,entries])=>new Set(entries.map(entry=>entry.version)).size>1).map(([name,entries])=>({name,entries}))
const inventory=inventoryTree(root)
const summary={schemaVersion:1,qualifiedAt:new Date().toISOString(),repository:'https://github.com/pnpm/pnpm',tag:'v10.32.1',commit:pin,sourceTreeSha256:inventory.sha256,dependencyInstallation:'not attempted; source and lock identities only',counts:{trackedFiles:files.length,typescriptFiles:files.filter(p=>/\.(ts|tsx|mts|cts)$/.test(p)).length,javascriptFiles:files.filter(p=>/\.(js|jsx|mjs|cjs)$/.test(p)).length,typescriptFilesUnderSrc:files.filter(p=>/(^|\/)src\//.test(p)&&/\.(ts|tsx|mts|cts)$/.test(p)).length,workspacePackagesExcludingRoot:projects.length,workspaceFamilies:new Set(projects.map(p=>p.path.split('/')[0])).size,lockImporters:Object.keys(lock.importers??{}).length,lockPackageEntries:Object.keys(lock.packages??{}).length,packageNamesWithMultipleLockedVersions:multipleVersions.length,aliases:aliases.length,usedAliases:aliases.filter(a=>a.consumers.length).length,tsconfigs:configs.length,configParseErrors:configParseErrors.length,configsWithProjectReferences:configs.filter(c=>c.references.length).length,directNamesWithDistinctImporterVersions:distinctImporterVersions.length},packageManager:JSON.parse(readFileSync(join(root,'package.json'))).packageManager,typescriptCatalog:workspace.catalog.typescript,aliases,multipleVersions,distinctImporterVersions,projects:ownership,configs,configParseErrors,limits:['Locked versions are not proof of installed resolution or live compiler identity.','The snapshot is an older stable TypeScript corpus, not current pnpm main.','Fixtures and examples are counted separately from actual workspace ownership; no synthetic files were added.']}
writeFileSync(join(base,'corpus-inventory.json'),JSON.stringify(inventory,null,2)+'\n',{flag:'wx'})
writeFileSync(join(base,'corpus-qualification.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({commit:pin,sourceTreeSha256:inventory.sha256,counts:summary.counts,usedAliases:aliases.filter(a=>a.consumers.length).map(a=>({name:a.name,specifier:a.specifier,consumerCount:a.consumers.length})),directVersionExamples:distinctImporterVersions.slice(0,10)},null,2))
