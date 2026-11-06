import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { cpus, platform, arch, totalmem } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..'),output=resolve(process.argv[2])
const hash=x=>createHash('sha256').update(x).digest('hex')
const paths=['package-lock.json','artifacts/research/large-monorepo/probes-public.json','artifacts/research/large-monorepo/probes-freeze.json','artifacts/research/large-monorepo/corpus-inventory.json','artifacts/research/large-monorepo/installed-qualification.json','artifacts/research/large-monorepo/truth-private/expected.json','artifacts/research/large-monorepo/truth-private/rubric.json','artifacts/paired-agent/candidate/artifact.json','artifacts/paired-agent/candidate/typelatch-0.4.0.tgz',
 ...['native.mjs','native.test.mjs','typelatch.mjs','run.mjs','freeze.mjs','isolate-git.mjs'].map(f=>'artifacts/research/large-monorepo/funnel/'+f),
 ...['adapter.mjs','adapter-qualified.json','adapter-refresh-qualified.json','collect.mjs','collect-qualified.json','runtime-manifest.json'].map(f=>'artifacts/research/competitors/'+f),
 ...['providers.mjs','collect.mjs','runtime-manifest.json','runtime-full-manifest.json','collect-qualified.json','collect-targeted-qualified.json'].map(f=>'artifacts/research/serena-baseline/'+f)]
for(let round=1;round<=3;round++)for(const provider of ['native','typelatch','typescript','serena','codegraph','graphify'])paths.push('artifacts/research/large-monorepo/screen-004/round-'+round+'/'+provider+'/prepared.json')
const files=[];for(const path of paths){const bytes=await readFile(join(root,path));files.push({path,bytes:bytes.length,sha256:hash(bytes)})}
const rgPath=await realpath(execFileSync('/usr/bin/which',['rg'],{encoding:'utf8'}).trim()),rgBytes=await readFile(rgPath)
const binary=await readFile(process.execPath)
const data={schemaVersion:1,status:'development-requalification-after-retained-setup-failures',createdAt:new Date().toISOString(),files,
 amendments:[{priorFreezeSha256:'aadb890c52896b6cf510e3300f0504e62301937bbe4f1e9ac00fabece3981de4',reason:'Retain ineligible screen003. Independent Git boundaries for all providers; bounded TypeScript hover and definitions replace whole-file trees; supported watcher readiness and explicit Graphify update. Same public questions and source bytes. Subsequent tool observations are development diagnostics, not heldout coding results.'},{priorFreezeSha256:'4862079713e5698f651c749dd4057c846727121f90733ea7415285c38f6977da',corpusQueriesExecuted:0,reason:'Strengthen shared native transitive API follow-up and late source slices, then add complete supplemental Serena runtime file inventory. Public questions, corpus, budgets, schedule and truth unchanged.'}],
 runtime:{node:{version:process.version,sha256:hash(binary)},ripgrep:{version:execFileSync(rgPath,['--version'],{encoding:'utf8'}).trim(),sha256:hash(rgBytes)},host:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,memoryBytes:totalmem()}},
 accounting:{modelTokens:'not measured in this tool screen',modelVisibleText:'structuredContent when present, otherwise concatenated text content; duplicate compatibility channels counted only in separate rawBytes',setup:'provider process and cold index readiness, excludes common corpus copying and dependency installation',actionTime:'full backend execution including native fallback; instrumented probe total includes journal overhead',budgets:'8 retrieval actions, 65536 bytes per answer;60000ms per probe and one shared60000ms mutation deadline',nativeBaseline:'Frozen expert-written retrieval recipes. Their source-authoring cost is not measured. Results cannot substitute for autonomous-agent trials.',coldCache:'fresh provider process and state; OS cache not flushed'},
 preparation:{eligible:'screen-004; reused source bytes reverified, independent Git root and identical tracked-source commit for every provider; old indexes and results retained',retainedIneligible:['screen-001: copied source symlink escaped corpus; no queries','screen-002: copy interrupted to change copy implementation; no queries','screen-003: parent Git ignore hides Typelatch source; collector output overflow and provider refresh setup failures; all captures retained']}}
await writeFile(join(output,'frozen.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'})
const publicPath=join(root,'docs/research/monorepo-tool-screen-freeze.json')
await writeFile(publicPath,JSON.stringify(data,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({frozenPath:relative(root,publicPath),sha256:hash(await readFile(publicPath)),files:files.length}))
