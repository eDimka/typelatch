import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const workspace = resolve(process.argv[2]);
const load = path => import(pathToFileURL(join(workspace, path)).href);
const {getOutdatedLockfileSetting} = await load('lockfile/settings-checker/lib/index.js');
const {checkDepsStatus} = await load('deps/status/lib/index.js');
const {mutateModules} = await load('pkg-manager/core/lib/index.js');
const {createTempStore} = await load('testing/temp-store/lib/index.js');
const {finishWorkers} = await load('worker/lib/index.js');
const {writeWantedLockfile} = await load('lockfile/fs/lib/index.js');
const cases = [
  {id:'changed-default', catalog:{default:{example:'2.0.0'}}, snapshot:{default:{example:{specifier:'1.0.0',version:'1.0.0'}}}, mismatch:true},
  {id:'changed-named', catalog:{stable:{example:'2.0.0'}}, snapshot:{stable:{example:{specifier:'1.0.0',version:'1.0.0'}}}, mismatch:true},
  {id:'removed-entry', catalog:{default:{}}, snapshot:{default:{example:{specifier:'1.0.0',version:'1.0.0'}}}, mismatch:true},
  {id:'changed-spelling', catalog:{default:{example:'=1.0.0'}}, snapshot:{default:{example:{specifier:'1.0.0',version:'1.0.0'}}}, mismatch:true},
  {id:'unchanged-default', catalog:{default:{example:'1.0.0'}}, snapshot:{default:{example:{specifier:'1.0.0',version:'1.0.0'}}}, mismatch:false},
  {id:'unreferenced-addition', catalog:{default:{example:'1.0.0',extra:'3.0.0'}}, snapshot:{default:{example:{specifier:'1.0.0',version:'1.0.0'}}}, mismatch:false},
  {id:'no-catalogs', catalog:{}, snapshot:undefined, mismatch:false},
];
const results=[];
const originalCwd=process.cwd();
const scratch=await mkdtemp(join(tmpdir(),'typelatch-catalog-check-'));
async function check(id,fn){try{await fn();results.push({id,passed:true});}catch(error){results.push({id,passed:false,error:String(error?.stack??error)});}}
function lockfile(c){return {lockfileVersion:'9.0',settings:{autoInstallPeers:true,excludeLinksFromLockfile:false},importers:{'.':{}},...(c.snapshot?{catalogs:c.snapshot}:{})};}
try {
  for(const c of cases){
    await check('checker/'+c.id,()=>assert.equal(getOutdatedLockfileSetting(lockfile(c),{catalogs:c.catalog,autoInstallPeers:true,excludeLinksFromLockfile:false,peersSuffixMaxLength:1000}),c.mismatch?'catalogs':null));
    await check('status/'+c.id,async()=>{
      const dir=join(scratch,'status-'+c.id);await mkdir(join(dir,'node_modules'),{recursive:true});
      const manifest={name:'independent-status',version:'1.0.0'};
      await writeFile(join(dir,'package.json'),JSON.stringify(manifest));
      await writeWantedLockfile(dir,lockfile(c));
      const old=new Date(Date.now()-20_000);await utimes(join(dir,'pnpm-lock.yaml'),old,old);
      await writeFile(join(dir,'node_modules/.pnpm-workspace-state-v1.json'),JSON.stringify({lastValidatedTimestamp:old.valueOf(),pnpmfiles:[],settings:{},projects:{},filteredInstall:false}));
      const result=await checkDepsStatus({rootProjectManifest:manifest,rootProjectManifestDir:dir,pnpmfile:[],catalogs:c.catalog,autoInstallPeers:true,excludeLinksFromLockfile:false,peersSuffixMaxLength:1000,linkWorkspacePackages:false});
      assert.equal(result.upToDate,!c.mismatch,JSON.stringify(result));
      if(c.mismatch)assert.match(result.issue,/Setting catalogs of lockfile .* is outdated/);
    });
    await check('core/'+c.id,async()=>{
      const dir=join(scratch,'core-'+c.id);await mkdir(dir,{recursive:true});process.chdir(dir);
      const manifest={name:'independent-install',version:'1.0.0'};
      await writeFile(join(dir,'package.json'),JSON.stringify(manifest));await writeWantedLockfile(dir,lockfile(c));
      const before=await readFile(join(dir,'pnpm-lock.yaml'),'utf8');
      const store=createTempStore({storeDir:join(dir,'.store')});
      let caught;
      try{await mutateModules([{mutation:'install',manifest,rootDir:dir}],{...store,lockfileDir:dir,allProjects:[{buildIndex:0,manifest,rootDir:dir}],lockfileOnly:true,frozenLockfile:true,ignoreScripts:true,catalogs:c.catalog,registries:{default:'http://127.0.0.1:9/'},neverBuiltDependencies:[]});}catch(error){caught=error;}finally{await store.storeController.close?.();process.chdir(originalCwd);}
      if(c.mismatch){assert.equal(caught?.code,'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH',String(caught));assert.match(caught.message,/catalogs/);assert.equal(await readFile(join(dir,'pnpm-lock.yaml'),'utf8'),before,'frozen rejection must preserve lockfile bytes');}else assert.equal(caught,undefined,String(caught));
    });
  }
  await check('checker/unrelated-override',()=>assert.equal(getOutdatedLockfileSetting({...lockfile(cases[6]),overrides:{example:'1.0.0'}},{catalogs:{},overrides:{example:'2.0.0'},peersSuffixMaxLength:1000}),'overrides'));
}finally{process.chdir(originalCwd);await finishWorkers();}
const result={schemaVersion:1,passed:results.every(x=>x.passed),cases:results.length,failed:results.filter(x=>!x.passed).length,results,scratch,scope:'Compiled production modules with real filesystem state. Core cases use empty projects and retained catalog metadata, avoiding package downloads; upstream native regression separately covers a real catalog dependency.'};
console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;
