import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash } from '../../../../scripts/paired-agent-runner.mjs'
import { validateSpec } from './run.mjs'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = path => JSON.parse(readFileSync(path))
const providers = read(join(root, 'provider-spec.json'))
const descriptors = ['migration/development-001/descriptor.json', 'impact/development/descriptor.json'].map(path => ({ path: join(root,path), value: read(join(root,path)) }))
const tasks = descriptors.map(({ value: d }) => ({
  id:d.id, category:d.category, split:d.split, mode:d.mode, description:d.description, scope:d.scope,
  policy:d.mode === 'edit' ? 'Only existing production TypeScript source may change. Keep tests, dependencies, manifests and configuration fixed. Generated compiler outputs may be rebuilt.' : 'The sole allowed new file is impact-answer.json. Preserve all existing files.',
  evaluationNotes:d.policy,
  ...(d.mode==='edit' ? {validationCommand:d.validationCommand,publicCases:d.publicCases} : {answerFile:d.answerFile}),
}))
const fixtures = Object.fromEntries(descriptors.map(({value:d}) => [d.id, Object.fromEntries(['workspace','initialManifest','qualification','sourceTrackingManifest','graderModule'].map(key => [key,key==='qualification' && typeof d[key]==='object'?d[key].path:d[key]]))]))
const impactInputs=['impact/development/grader.mjs','impact/grade-answer.mjs','impact/answer-schema.mjs','impact/development/truth.json','impact/development/answer-schema.json','impact/grader.test.mjs','impact/integrity.test.mjs','impact/development/prompt.txt','impact/compiler-oracle.mjs','impact/freeze-development.mjs','impact/run-command.mjs','impact/source-restoration.json','impact/pnpm-workspaces.json','impact/pnpm-dependent-filter.json','impact/pnpm-full-install.json','impact/pnpm-full-install-local-store.json','impact/pnpm-target-build.json','impact/pnpm-overrides-build.json','impact/pnpm-worker-build.json','impact/pnpm-overrides-tests.json','impact/pnpm-overrides-tests-local.json','impact/pnpm-overrides-tests-ready.json'].map(path=>join(root,path))
const extraInputs=[...descriptors.flatMap(({path,value:d})=>[path,...(d.frozenInputs??[])]),...impactInputs,...['assemble-development.mjs','publish-freeze.mjs','run.test.mjs','decision.test.mjs','review.test.mjs'].map(path=>join(root,'trial',path))]
const extractor=resolve(root,'../../../scripts/monorepo-tool-outputs.mjs')
const spec={...providers,status:'selected-and-ready',phase:'development',repeats:1,timeoutMs:900000,tasks,fixtures,
 sharedFrozenInputs:[...new Set(extraInputs)].map(path=>({path,kind:'file'})),
 supplementalOutputs:{extractor,extractorSha256:hash(readFileSync(extractor)),fileName:'tool-outputs.json'},
 toolUseQualification:{receipt:join(root,'provider-qualification-001/report.json'),sourceSpec:join(root,'provider-spec.json')},
}
validateSpec(spec)
for(const {path} of spec.sharedFrozenInputs)assert(existsSync(path),path)
const output=resolve(process.argv[2]??join(root,'development-spec-001.json'))
writeFileSync(output,JSON.stringify(spec,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify({output,sha256:hash(readFileSync(output)),tasks:tasks.map(t=>t.id)}))
