import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';

export const sourceFiles=['deps/status/src/checkDepsStatus.ts','lockfile/settings-checker/src/getOutdatedLockfileSetting.ts','lockfile/verification/src/index.ts','pkg-manager/core/src/install/index.ts'];
export const projects=['deps/status','lockfile/settings-checker','lockfile/verification','pkg-manager/core'];
export function prepare(){
  const here=import.meta.dirname,p=join(here,'private/pnpm-catalogs'),output=join(here,'development-001'),workspace=join(output,'workspace');
  if(existsSync(workspace)&&!process.argv.includes('--resume-copy-overwrite-failure'))throw Error('Keep earlier prepared fixture');
  mkdirSync(output,{recursive:true});const start=performance.now();
  if(!existsSync(workspace))cpSync(join(p,'reference-source'),workspace,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE_FORCE});
  if(process.argv.includes('--resume-copy-overwrite-failure'))writeFileSync(join(output,'preparation-failure-001.json'),JSON.stringify({stage:'Small source overwrite after successful full APFS clone',error:'ENOSYS: cpSync COPYFILE_FICLONE_FORCE could not overwrite existing destination file',resolution:'Retain the completed independent clone; write the four baseline source byte buffers directly. No scored sessions or prior frozen inputs were changed.'},null,2)+'\n');
  for(const path of sourceFiles)writeFileSync(join(workspace,path),readFileSync(join(p,'baseline-source',path)));
  const retained=join(output,'retained-generated-input');mkdirSync(retained,{recursive:true});
  for(const project of projects)for(const child of ['lib','tsconfig.tsbuildinfo']){const from=join(workspace,project,child),to=join(retained,project,child);if(existsSync(from)){mkdirSync(dirname(to),{recursive:true});renameSync(from,to);}}
  const record={schemaVersion:1,workspace,elapsedMs:performance.now()-start,sourceFiles,projects,baselineCommit:'1e6de2539bf2df6477fcb8d9c016f7842f5c5e77',referenceCommit:'69ebe387643ae781182d7fa0fd59602484ae268d',adaptations:['Reference workspace dependency declarations, lockfile and project references are prewired in both arms. Dependency editing is outside the repair task.','Exact upstream updated catalog test file is available before the repair.','All four target project outputs are retained outside the fixture; each validation rebuilds them from submitted source.','The rest of the installed native compiler and project dependency closure stays identical across arms.'],restoredSource:sourceFiles.map(path=>({path,sha256:createHash('sha256').update(readFileSync(join(workspace,path))).digest('hex')}))};
  writeFileSync(join(output,'preparation.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({workspace,elapsedMs:record.elapsedMs}));
}
if(process.argv[1]===import.meta.filename)prepare();
