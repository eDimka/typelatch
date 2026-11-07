import {spawnSync} from 'node:child_process';
import {rmSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const targets=['deps/status','lockfile/settings-checker','lockfile/verification','pkg-manager/core'];
function execute(command,args,cwd,env={}){
  const start=performance.now();const r=spawnSync(command,args,{cwd,env:{...process.env,CI:'1',NO_COLOR:'1',FORCE_COLOR:undefined,...env},encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
  let result=null;try{result=JSON.parse(r.stdout.trim());}catch{}
  return {exitCode:r.status,signal:r.signal,error:r.error?.message??null,elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,result};
}
export function runValidation(workspace,{semanticScript=join(workspace,'.typelatch-benchmark/semantic-check.mjs'),semanticCases=9}={}){
  const start=performance.now();
  for(const project of targets)for(const path of ['lib','tsconfig.tsbuildinfo'])rmSync(join(workspace,project,path),{recursive:true,force:true});
  const compile=execute(process.execPath,[join(workspace,'node_modules/typescript/bin/tsc'),'-b',...targets],workspace);
  const semantics=compile.exitCode===0?execute(process.execPath,[semanticScript,workspace],workspace):null;
  const nativeCache=compile.exitCode===0?mkdtempSync(join(tmpdir(),'typelatch-catalog-jest-')):null;
  const native=compile.exitCode===0?execute(process.execPath,['--experimental-vm-modules',join(workspace,'node_modules/jest/bin/jest.js'),'--runInBand','--runTestsByPath','test/catalogs.ts','--testNamePattern','^frozen lockfile error is thrown if catalog config changes$','--globalSetup',join(workspace,'.typelatch-benchmark/native-registry-setup.cjs'),'--collectCoverage=false','--cacheDirectory',nativeCache,'--json'],join(workspace,'pkg-manager/core'),{TYPELATCH_REGISTRY_NODE:join(workspace,'.typelatch-benchmark/node20'),TYPELATCH_REGISTRY_METADATA:join(workspace,'.typelatch-benchmark/registry-is-positive.json')}):null;
  const results=[...(semantics?.result?.results??[]),{id:'native/upstream-frozen-catalog-install',passed:native?.exitCode===0&&native?.result?.numPassedTests===1&&native?.result?.numFailedTests===0,error:native?.exitCode===0?undefined:native?.stderr?.slice(-5000)}];
  const completed=run=>run?.exitCode===0&&run.signal===null&&run.error===null;
  const passed=completed(compile)&&completed(semantics)&&semantics.result?.passed===true&&semantics.result?.cases===semanticCases&&semantics.result?.results?.length===semanticCases&&semantics.result.results.every(row=>row.passed===true)&&completed(native)&&native.result?.numPassedTests===1&&native.result?.numFailedTests===0;
  return {schemaVersion:1,passed,cases:semanticCases+1,observedCases:results.length,results,compile,semantics,native,nativeCache,elapsedMs:performance.now()-start};
}
if(process.argv[1]===import.meta.filename){const result=runValidation(resolve(process.argv[2]||process.cwd()));console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;}
