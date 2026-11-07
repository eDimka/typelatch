// Run only after the coordinator permits preparation CPU work.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inventoryTree } from '../../../../../scripts/paired-agent-integrity.mjs'
import { answerSchema } from '../answer-schema.mjs'
import { gradeAnswer } from '../grade-answer.mjs'

const base=resolve('artifacts/research/cross-package/impact'),out=join(base,'private/heldout'),workspace=join(base,'vue-source')
mkdirSync(out,{recursive:true})
const hash=value=>createHash('sha256').update(value).digest('hex'),write=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n')
assert.equal(execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:workspace}).toString().trim(),'6eb29d345aa73746207f80c89ee8b37ff7b949c9')
assert.equal(execFileSync('/usr/bin/git',['diff','--name-only','HEAD'],{cwd:workspace}).toString().trim(),'')
const tracked=new Set(execFileSync('/usr/bin/git',['ls-files','-z'],{cwd:workspace}).toString().split('\0').filter(Boolean))
const initial=inventoryTree(workspace,{excludeDirectories:['.git','.typelatch','.serena','.codegraph','.graphify']})
write('initial-manifest.json',initial)
write('tracking-manifest.json',{root:workspace,entries:initial.entries.filter(row=>tracked.has(row.path)),sourceRevision:'6eb29d345aa73746207f80c89ee8b37ff7b949c9'})
write('answer-schema.json',answerSchema)
const truth=JSON.parse(readFileSync(join(base,'private/heldout-oracle.json'))),gold=JSON.parse(readFileSync(join(base,'private/heldout-gold.json')))
assert.equal(gradeAnswer(workspace,gold,truth).passed,true)
write('truth.json',truth)
write('gold-answer.json',gold)
writeFileSync(join(out,'grader.mjs'),`import { readFileSync } from 'node:fs'\nimport { gradeFixture } from '../../grade-answer.mjs'\nconst truth=JSON.parse(readFileSync(new URL('./truth.json',import.meta.url)))\nexport function gradeWorkspace(workspace,initial) { return gradeFixture(workspace,initial,truth,'impact-answer.json') }\n`)
const prompt=`Prepare a change impact report for Vue's public ShallowRef type contract. We propose removing its separate setter type parameter so the writable type must equal the readable type. Do not implement the change. Determine which existing internal consumers, public exports and native validation targets need review.

Affected means a direct static use or reexport of ShallowRef outside its defining package, not a proven runtime behavior change. Enumerate configured production source files under workspace package src directories, respecting native TypeScript configuration. Exclude tests, generated declarations, dependencies and configuration-excluded files from that direct set. Classify each file/export pair as runtime, type-only or reexport. A file may have multiple roles. Follow real native package aliases and public barrels without equating unrelated same-spelling display text with a type reference.

Separately enumerate all installed workspace package dependents reachable through declared dependency, dev dependency, optional dependency or peer dependency edges. Include a concrete dependency chain for each. This is a conservative review set, not proof that every dependent uses the changed type. Keep exact package versions and actual workspace versus external package identity.

List existing compile, test and _test package.json scripts for the target package and packages owning direct source consumers. If all such packages use centralized scripts instead, list the root check, test-unit and build scripts that actually exist. These are candidate validation targets, not claims that they were executed. Include a source-supported exclusion for same-spelling display text. Explicitly state limits for external consumers, computed loading, package reachability and unexecuted validation.

Write impact-answer.json in the repository root using the JSON schema below. Quotes must be exact source evidence with one-based line ranges of at most 21 lines. Use only negativeClaims that are independently supported exclusions. Leave every existing source, dependency, test and configuration file unchanged. Source discovery and analysis method are up to you.

Answer schema (illustrative values, not expected facts):
${JSON.stringify(answerSchema,null,2)}`
writeFileSync(join(out,'prompt.txt'),prompt+'\n')
write('qualification.json',{status:'qualified',kind:'analysis-fixture',sourceUnchanged:true,pinnedRevision:'6eb29d345aa73746207f80c89ee8b37ff7b949c9',oracle:'Native TypeScript alias identity and barrel exports plus independent installed-manifest graph, matched against native pnpm dependent filter',truthSha256:hash(readFileSync(join(out,'truth.json'))),initialManifestSha256:initial.sha256,answerSchemaSha256:hash(readFileSync(join(out,'answer-schema.json'))),goldPassed:true,agentTrials:0,nativeChecks:['../../vue-native-check.json','../../vue-ref-tests.json'],knownLimits:truth.limitations})
write('descriptor.json',{id:'vue-type-impact-heldout',category:'impact',split:'heldout',mode:'analysis',description:prompt,workspace,initialManifest:join(out,'initial-manifest.json'),sourceTrackingManifest:join(out,'tracking-manifest.json'),qualification:join(out,'qualification.json'),graderModule:join(out,'grader.mjs'),answerFile:'impact-answer.json',scope:{productionPackages:new Set([truth.target.package,...truth.direct.map(row=>row.package)]).size},policy:['Analysis only. The sole allowed new file is impact-answer.json.','Native configuration, source aliases and exact dependencies are identical for every condition.','Type references and public barrel exposure are distinct from runtime effects.','Setup costs are retained separately; no external application impact is asserted.','Held-out expected facts remain private until the generic provider is frozen.']})
console.log(JSON.stringify({status:'qualified',manifestSha256:initial.sha256,sourceFiles:tracked.size}))
