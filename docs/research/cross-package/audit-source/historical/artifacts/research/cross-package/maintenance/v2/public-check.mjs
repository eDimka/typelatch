import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join,resolve} from 'node:path';

const workspace=resolve(process.argv[2]||process.cwd());
const targets=['deps/status','lockfile/settings-checker','lockfile/verification','pkg-manager/core'];
const start=performance.now();
function run(args){
  const r=spawnSync(process.execPath,args,{cwd:workspace,env:{...process.env,CI:'1',NO_COLOR:'1',FORCE_COLOR:undefined},encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
  return {exitCode:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout,stderr:r.stderr};
}
for(const project of targets)for(const file of ['lib','tsconfig.tsbuildinfo'])rmSync(join(workspace,project,file),{recursive:true,force:true});
const compile=run([join(workspace,'node_modules/typescript/bin/tsc'),'-b',...targets]);
const completed=r=>r?.exitCode===0&&r.signal===null&&r.error===null;
const semantic=completed(compile)?run([join(workspace,'.typelatch-benchmark/semantic-check.mjs'),workspace]):null;
let result=null;try{result=JSON.parse(semantic?.stdout?.trim());}catch{}
const results=Array.isArray(result?.results)?result.results:[];
const passed=completed(compile)&&completed(semantic)&&result.passed===true&&result.cases===9&&results.length===9&&results.every(row=>row.passed===true);
console.log(JSON.stringify({schemaVersion:1,passed,cases:results.length,expectedCases:9,results,compile:{exitCode:compile.exitCode,signal:compile.signal,error:compile.error,...(!completed(compile)?{stdout:compile.stdout,stderr:compile.stderr}:{})},...(semantic&&!result?{semanticError:semantic}:{}),elapsedMs:performance.now()-start,scope:'Native TypeScript build and nine real production API/filesystem checks. No listening server. Independent grading additionally executes the upstream registry integration.'}));
process.exitCode=passed?0:1;
