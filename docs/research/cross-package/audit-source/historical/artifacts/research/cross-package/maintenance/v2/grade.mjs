import {cpSync,mkdtempSync,readFileSync,writeFileSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {inventoryTree} from '../../../../../scripts/paired-agent-integrity.mjs';
import {integrity} from '../development-grade.mjs';
import {runValidation} from '../check-runtime.mjs';

const here=import.meta.dirname,maintenance=resolve(here,'..'),fixture=join(here,'fixture');
export async function gradeWorkspace(workspace,initial){
  const start=performance.now(),tracking=JSON.parse(readFileSync(join(fixture,'source-tracking-manifest.json'))),before=inventoryTree(workspace),guard=integrity(initial,before,tracking);
  if(!guard.passed)return {passed:false,integrity:guard,checks:null,elapsedMs:performance.now()-start};
  const gradeRoot=mkdtempSync(join(here,'private/grade-')),copy=join(gradeRoot,'workspace');
  const copyStart=performance.now();cpSync(join(fixture,'workspace'),copy,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE_FORCE});const copyMs=performance.now()-copyStart;
  for(const path of guard.changed)writeFileSync(join(copy,path),readFileSync(join(workspace,path)));
  const checks=runValidation(copy,{semanticScript:join(maintenance,'private/pnpm-catalogs/semantic-check.mjs'),semanticCases:22});
  const after=inventoryTree(workspace),sourceStable=before.sha256===after.sha256;
  const result={passed:guard.passed&&sourceStable&&checks.passed,integrity:guard,sourceStable,checks,copyMs,gradeRoot,elapsedMs:performance.now()-start};
  writeFileSync(join(gradeRoot,'result.json'),JSON.stringify(result,null,2)+'\n');return result;
}
