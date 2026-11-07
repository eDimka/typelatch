import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inventoryTree} from '../../../../scripts/paired-agent-integrity.mjs';
const here=import.meta.dirname,out=join(here,'development-001'),workspace=join(out,'workspace'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>JSON.parse(readFileSync(path));
const qualificationFile=join(out,'qualification.json'),qualification=read(qualificationFile);assert.equal(qualification.status,'qualified');
const initial=read(join(out,'initial-manifest.json')),current=inventoryTree(workspace);assert.equal(current.sha256,initial.sha256,'Prepared fixture changed during qualification');
for(const [id,expected]of [['baseline',false],['reference',true]]){const r=read(join(here,'private/pnpm-catalogs/public-'+id+'-002.json'));const last=r.stdout.trim().split('\n').at(-1);const parsed=JSON.parse(last);assert.equal(parsed.passed,expected);assert.equal(parsed.cases,10);assert.equal(parsed.observedCases,10);}
const closure=[],sourceFixtureLinks=[],tracked=new Map(read(join(out,'source-tracking-manifest.json')).entries.map(row=>[row.path,row]));
for(const row of current.entries.filter(row=>row.kind==='symlink')){
  if(/(^|\/)(?:__fixtures__|fixtures)\//.test(row.path)&&tracked.has(row.path)){assert.deepEqual(row,tracked.get(row.path));sourceFixtureLinks.push({path:row.path,target:row.target,policy:'Literal upstream source fixture link, excluded from installed runtime closure'});continue;}
  const target=realpathSync(join(workspace,row.path));assert(target===workspace||target.startsWith(workspace+'/'),`External dependency link: ${row.path}`);closure.push({path:row.path,target:target.slice(workspace.length+1)});
}
const linkAudit={schemaVersion:1,passed:true,links:closure,sourceFixtureLinks,fixtureSha256:current.sha256};writeFileSync(join(out,'link-audit.json'),JSON.stringify(linkAudit,null,2)+'\n');
const compilerPath=realpathSync(join(workspace,'node_modules/typescript/package.json')),compiler=read(compilerPath);
const descriptor={
  id:'pnpm-catalog-consistency',category:'maintenance',split:'development',mode:'edit',
  description:'A configured catalog can drift from recorded lockfile specifiers while frozen installation and dependency-status checking still accept stale state. Make catalog consistency checks work across the affected production APIs and consumers. Changes or removal of recorded specifiers must be detected. Unchanged catalogs and newly added unused entries must remain accepted, unrelated lockfile checks must keep working, and rejection of a frozen installation must preserve lockfile bytes. Dependencies and project configuration are already prepared. Change only existing production TypeScript source. Run the supplied validation before and after the repair.',
  workspace,initialManifest:join(out,'initial-manifest.json'),sourceTrackingManifest:join(out,'source-tracking-manifest.json'),
  qualification:{status:'qualified',path:qualificationFile,sha256:sha(readFileSync(qualificationFile))},graderModule:join(here,'development-grade.mjs'),publicCases:10,validationCommand:'npm run test:typelatch-benchmark',
  scope:{productionPackages:3,upstreamChangedProductionPackages:4,behavioralPackages:['@pnpm/lockfile.settings-checker','@pnpm/core','@pnpm/deps.status'],additionalInterfacePackage:'@pnpm/lockfile.verification',boundaryGraph:[['@pnpm/core','@pnpm/lockfile.settings-checker'],['@pnpm/deps.status','@pnpm/lockfile.settings-checker'],['@pnpm/lockfile.settings-checker','@pnpm/lockfile.verification']]},
  policy:[
    'Only existing tracked production TypeScript source may change. Tests, scripts, dependencies, manifests, project configuration, file additions and deletions are protected.',
    'The historical upstream change is pinned to pnpm PR10231. Reference dependency declarations, lockfile and project references are preinstalled in the baseline, so dependency installation is outside the edit task.',
    'Public validation runs nine independent API and filesystem cases plus one exact upstream native catalog installation regression. Private validation runs twenty-two independent cases plus the same native regression. Other upstream native cases are explicitly filtered, not reported as passing.',
    'The independent core matrix uses empty projects with retained catalog metadata. The upstream regression separately exercises an actual catalog dependency using an isolated Verdaccio registry seeded with recorded npm metadata; validation makes no external registry requests.',
    'Node22.23.1 runs compilation and APIs. The native registry uses upstream-required Node20.16.0, pinned from the official archive. Authentication and audit plugins are disabled only in the isolated anonymous read-only test registry.',
    'All four target project lib directories and build-info files are absent from the prepared fixture. Public validation rebuilds them; the private grader separately clones the trusted fixture and copies only allowed submitted source, never agent-generated outputs.',
    'Three package omission controls are rejected. A fourth control keeps the new shared-checker API types and caller wiring while omitting the comparison logic; it compiles but fails twelve semantic checks and the upstream native regression. Either caller omission fails unchanged-catalog negative controls.',
    'Every native Jest invocation starts with a distinct empty temporary cache. Test infrastructure and source fixtures are immutable alongside the test files.',
    'This historical task covers explicitly supplied catalogs. The later upstream report about deployment lockfiles with catalog metadata but no workspace configuration is outside this fixture and is not claimed fixed.',
    'Development qualification only. No held-out performance conclusion follows from this task.',
  ],
  toolchain:{node:{path:process.execPath,version:process.version,sha256:sha(readFileSync(process.execPath))},compiler:{version:compiler.version,packageJson:compilerPath,sha256:sha(readFileSync(compilerPath))},registryNode:{version:'20.16.0',path:join(workspace,'.typelatch-benchmark/node20'),sha256:sha(readFileSync(join(workspace,'.typelatch-benchmark/node20')))},platform:process.platform,arch:process.arch},
  frozenInputs:[...['prepare-development.mjs','install-public-check.mjs','finalize-inputs.mjs','qualify-development.mjs','qualify-checker-behavior.mjs','write-descriptor.mjs','check-runtime.mjs','native-registry-setup.cjs','development-grade.mjs','development-grade.test.mjs','private/pnpm-catalogs/semantic-check.mjs','private/pnpm-catalogs/pin.json','private/pnpm-catalogs/reference-downloads.json','private/pnpm-catalogs/registry-seed-receipt.json','private/pnpm-catalogs/public-baseline-002.json','private/pnpm-catalogs/public-reference-002.json','development-001/source-tracking-manifest.json','development-001/qualification.json','development-001/preparation.json','development-001/link-audit.json','development-001/validator-amendment-002.json','development-001/guard-red-001.json','development-001/guard-green-001.json','tools/node20/receipt.json'].map(path=>join(here,path)),join(here,'../../../../scripts/paired-agent-integrity.mjs'),join(here,'../../../../scripts/paired-agent-runner.mjs')],
};
writeFileSync(join(out,'descriptor.json'),JSON.stringify(descriptor,null,2)+'\n');console.log(JSON.stringify({descriptor:join(out,'descriptor.json'),sourcePaths:read(descriptor.sourceTrackingManifest).entries.length,links:closure.length,fixtureSha256:current.sha256}));
