import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,constants} from 'node:fs';
import {join} from 'node:path';
import {gradeWorkspace} from './development-grade.mjs';
import {sourceFiles} from './prepare-development.mjs';
const here=import.meta.dirname,out=join(here,'development-001'),p=join(here,'private/pnpm-catalogs'),input=join(p,'qualification-input-'+(process.argv[2]||'001'));
if(existsSync(input))throw Error('Retain previous qualification');
const startedAt=new Date().toISOString(),start=performance.now(),initial=JSON.parse(readFileSync(join(out,'initial-manifest.json')));
cpSync(join(out,'workspace'),input,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE_FORCE});
const record={schemaVersion:1,status:'in-progress',startedAt,initialSha256:initial.sha256,results:{},criteria:'Baseline intended failures, complete reference success, and omission of each of three runtime package repairs rejected. No model sessions.'};
function persist(){record.elapsedMs=performance.now()-start;writeFileSync(join(out,'qualification.json'),JSON.stringify(record,null,2)+'\n');}
persist();
async function run(id){const result=await gradeWorkspace(input,initial);record.results[id]=result;persist();console.log(JSON.stringify({id,passed:result.passed,forbidden:result.integrity.forbidden,compile:result.checks?.compile.exitCode,semanticFailures:result.checks?.semantics?.result?.results?.filter(x=>!x.passed).map(x=>x.id),native:result.checks?.native?.exitCode,elapsedMs:result.elapsedMs}));return result;}
const baseline=await run('baseline');assert.equal(baseline.passed,false);assert.equal(baseline.checks.compile.exitCode,0);assert.equal(baseline.checks.semantics.result.failed,12);assert.equal(baseline.checks.native.exitCode,1);
function reference(){for(const path of sourceFiles)writeFileSync(join(input,path),readFileSync(join(p,'reference-files',path)));}
reference();assert.equal((await run('reference')).passed,true);
for(const packagePath of ['pkg-manager/core','deps/status','lockfile/settings-checker']){
  reference();for(const path of sourceFiles.filter(path=>path.startsWith(packagePath+'/')))writeFileSync(join(input,path),readFileSync(join(p,'baseline-source',path)));
  assert.equal((await run('partial-without-'+packagePath.replaceAll('/','-'))).passed,false);
}
record.status='qualified';record.finishedAt=new Date().toISOString();persist();
