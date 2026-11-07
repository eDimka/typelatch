import {mkdirSync,readFileSync,writeFileSync,cpSync,chmodSync,constants,rmSync} from 'node:fs';
import {join} from 'node:path';
const here=import.meta.dirname,workspace=join(here,'development-001/workspace'),target=join(workspace,'.typelatch-benchmark');
mkdirSync(target,{recursive:true});
for(const file of ['check-runtime.mjs','native-registry-setup.cjs'])writeFileSync(join(target,file),readFileSync(join(here,file)));
let source=readFileSync(join(here,'private/pnpm-catalogs/semantic-check.mjs'),'utf8');
source=source.replace("const results=[];","cases.splice(0,cases.length,cases[0],cases[4],cases[6]);\nconst results=[];").replace(/^  await check\('checker\/unrelated-override'.*\n/m,'');
writeFileSync(join(target,'semantic-check.mjs'),source);
writeFileSync(join(target,'registry-is-positive.json'),readFileSync(join(here,'private/pnpm-catalogs/registry-is-positive.json')));
rmSync(join(target,'node20'),{force:true});
try{cpSync(join(here,'tools/node20/node-v20.16.0-darwin-arm64/bin/node'),join(target,'node20'),{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE_FORCE});}
catch(error){if(error.code!=='ENOSYS')throw error;const bytes=readFileSync(join(here,'tools/node20/node-v20.16.0-darwin-arm64/bin/node'));writeFileSync(join(target,'node20'),bytes);writeFileSync(join(here,'development-001/node20-copy-exception.json'),JSON.stringify({error:String(error),bytes:bytes.length,scope:'One extracted registry runtime binary only. Independent byte copy; all full fixture copies still require APFS cloning.'},null,2)+'\n');}
chmodSync(join(target,'node20'),0o755);
writeFileSync(join(target,'NODE-LICENSE'),readFileSync(join(here,'tools/node20/node-v20.16.0-darwin-arm64/LICENSE')));
const packageFile=join(workspace,'package.json'),pkg=JSON.parse(readFileSync(packageFile));pkg.scripts['test:typelatch-benchmark']='node .typelatch-benchmark/check-runtime.mjs';writeFileSync(packageFile,JSON.stringify(pkg,null,2)+'\n');
console.log(JSON.stringify({workspace,publicCases:10}));
