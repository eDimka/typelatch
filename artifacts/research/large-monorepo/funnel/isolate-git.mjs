import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const base=resolve(dirname(fileURLToPath(import.meta.url)),'..'),input=join(base,'screen-003'),output=join(base,'screen-004')
const inventory=JSON.parse(await readFile(join(base,'corpus-inventory.json'))),hash=x=>createHash('sha256').update(x).digest('hex')
const entries=inventory.entries.filter(e=>['file','symlink'].includes(e.kind)),providers=['native','typelatch','typescript','serena','codegraph','graphify']
await mkdir(output,{recursive:true});const pathspec=join(output,'tracked-paths.bin');await writeFile(pathspec,Buffer.from(entries.map(x=>x.path+'\0').join('')))
const git=(workspace,...args)=>execFileSync('/usr/bin/git',['-C',workspace,'-c','core.hooksPath=/dev/null','-c','gc.auto=0',...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_DATE:'2026-11-06T00:00:00+00:00',GIT_COMMITTER_DATE:'2026-11-06T00:00:00+00:00'},maxBuffer:10000000}).trim()
for(let round=1;round<=3;round++)for(const provider of providers){
 const workspace=join(input,`round-${round}`,provider,'workspace'),dir=join(output,`round-${round}`,provider);await mkdir(dir,{recursive:true})
 const before={};for(const e of entries){if(e.kind==='file')assert.equal(hash(await readFile(join(workspace,e.path))),e.sha256);else assert.equal(await readlink(join(workspace,e.path)),e.target)}
 before.gitTopLevel=git(workspace,'rev-parse','--show-toplevel');before.indexedSourcePaths=git(workspace,'ls-files','--cached','--','.')
 const removedGeneratedLinks=[]
 if(provider==='codegraph'){try{const p=join(workspace,'.codegraph'),target=await readlink(p);assert.equal(target,join(input,`round-${round}`,provider,'state/index'));await unlink(p);removedGeneratedLinks.push({path:'.codegraph',target,reason:'Detach closed prior session state before new cold session'})}catch(e){if(e.code!=='ENOENT')throw e}}
 git(workspace,'init','-q','--initial-branch=benchmark');git(workspace,'config','core.autocrlf','false');git(workspace,'add','-f','--pathspec-from-file='+pathspec,'--pathspec-file-nul');git(workspace,'-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','-c','commit.gpgsign=false','commit','-qm','Freeze public pnpm source fixture')
 const after={gitTopLevel:git(workspace,'rev-parse','--show-toplevel'),head:git(workspace,'rev-parse','HEAD'),tree:git(workspace,'rev-parse','HEAD^{tree}'),trackedPaths:Number(git(workspace,'ls-files','-z').split('\0').filter(Boolean).length)}
 assert.equal(after.gitTopLevel,workspace);assert.equal(after.trackedPaths,entries.length)
 for(const e of entries){if(e.kind==='file')assert.equal(hash(await readFile(join(workspace,e.path))),e.sha256);else assert.equal(await readlink(join(workspace,e.path)),e.target)}
 await writeFile(join(dir,'prepared.json'),JSON.stringify({schemaVersion:1,workspace,sourceFilesVerified:2939,sourceLinksVerified:7,priorSource:join(input,`round-${round}`,provider),before,after,removedGeneratedLinks,note:'Reuse byte-verified corpus only; previous results and indexes remain unchanged. New independent Git metadata prevents enclosing repository ignore rules from selecting the corpus.'},null,2)+'\n');console.log(JSON.stringify({round,provider,head:after.head,paths:after.trackedPaths}))
}
