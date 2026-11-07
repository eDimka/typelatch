import {cpSync,mkdtempSync,readFileSync,writeFileSync,constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {inventoryTree} from '../../../../scripts/paired-agent-integrity.mjs';
import {runValidation} from './check-runtime.mjs';

const here=import.meta.dirname;
export function integrity(initial,current,tracking){
  const tracked=new Set(tracking.entries.map(row=>row.path));
  const projects=new Set(tracking.entries.filter(row=>/(^|\/)tsconfig\.json$/.test(row.path)).map(row=>dirname(row.path)));
  const generated=path=>!tracked.has(path)&&!path.split('/').includes('node_modules')&&[...projects].some(dir=>path===`${dir}/tsconfig.tsbuildinfo`||path.startsWith(`${dir}/lib/`));
  const before=new Map(initial.entries.filter(x=>x.kind!=='directory').map(x=>[x.path,x])),after=new Map(current.entries.filter(x=>x.kind!=='directory').map(x=>[x.path,x]));
  const changed=[],forbidden=[],generatedChanged=[];
  for(const path of new Set([...before.keys(),...after.keys()])){const a=before.get(path),b=after.get(path);if(JSON.stringify(a)===JSON.stringify(b))continue;if(generated(path)){generatedChanged.push(path);continue;}changed.push(path);if(!tracked.has(path)||!a||!b||a.kind!=='file'||b.kind!=='file'||a.mode!==b.mode||!/(^|\/)src\/.+\.ts$/.test(path)||/(^|\/)(?:test|tests|__tests__|__fixtures__|fixtures|__utils__|testing|node_modules)\//.test(path)||/(?:\.(?:test|spec|d)|(?:test-utils|testUtils))\.ts$/.test(path))forbidden.push(path);}
  return {passed:forbidden.length===0,changed:changed.sort(),forbidden:forbidden.sort(),generatedChanged:generatedChanged.sort()};
}
export async function gradeWorkspace(workspace,initial){
  const started=performance.now(),tracking=JSON.parse(readFileSync(join(here,'development-001/source-tracking-manifest.json'))),before=inventoryTree(workspace),guard=integrity(initial,before,tracking);
  if(!guard.passed)return {passed:false,integrity:guard,checks:null,elapsedMs:performance.now()-started};
  const trusted=join(here,'development-001/workspace'),gradeRoot=mkdtempSync(join(here,'private/pnpm-catalogs/grade-')),copy=join(gradeRoot,'workspace');
  const copyStart=performance.now();cpSync(trusted,copy,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE_FORCE});const copyMs=performance.now()-copyStart;
  for(const path of guard.changed)writeFileSync(join(copy,path),readFileSync(join(workspace,path)));
  const checks=runValidation(copy,{semanticScript:join(here,'private/pnpm-catalogs/semantic-check.mjs'),semanticCases:22});
  const after=inventoryTree(workspace),afterGuard=integrity(initial,after,tracking);
  const sourceStable=before.sha256===after.sha256;
  const result={passed:guard.passed&&afterGuard.passed&&sourceStable&&checks.passed,integrity:guard,sourceStable,checks,copyMs,gradeRoot,elapsedMs:performance.now()-started};
  writeFileSync(join(gradeRoot,'result.json'),JSON.stringify(result,null,2)+'\n');return result;
}
