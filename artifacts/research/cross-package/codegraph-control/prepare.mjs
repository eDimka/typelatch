import assert from 'node:assert/strict';
import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,readlinkSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const here=import.meta.dirname,prior=resolve(here,'../../competitors/codegraph'),runtime=join(here,'runtime'),hash=v=>createHash('sha256').update(v).digest('hex');
const start=performance.now();
mkdirSync(join(here,'sources'),{recursive:true});
const sources=[['npm-latest.json','https://registry.npmjs.org/@colbymchenry/codegraph/latest'],['github-latest.json','https://api.github.com/repos/colbymchenry/codegraph/releases/latest'],['github-tag.json','https://api.github.com/repos/colbymchenry/codegraph/git/ref/tags/v1.6.2'],['mcp-server.md','https://raw.githubusercontent.com/colbymchenry/codegraph/v1.6.2/site/src/content/docs/reference/mcp-server.md'],['cli.md','https://raw.githubusercontent.com/colbymchenry/codegraph/v1.6.2/site/src/content/docs/reference/cli.md']];
const receipts=[];
for(const [file,url] of sources){const response=await fetch(url,{headers:{'User-Agent':'Typelatch-independent-research'}});assert(response.ok,`${url}: ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());writeFileSync(join(here,'sources',file),bytes,{flag:'wx'});receipts.push({file,url,sha256:hash(bytes),bytes:bytes.length,fetchedAt:new Date().toISOString()});}
const npm=JSON.parse(readFileSync(join(here,'sources/npm-latest.json'))),release=JSON.parse(readFileSync(join(here,'sources/github-latest.json'))),tag=JSON.parse(readFileSync(join(here,'sources/github-tag.json')));
assert.equal(npm.version,'1.6.2');assert.equal(npm.gitHead,'6560052a6f856855d3f71eee838fd66ccfa4285d');assert.equal(release.tag_name,'v1.6.2');assert.equal(tag.object.sha,npm.gitHead);
cpSync(join(prior,'install'),runtime,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE_FORCE});
const entries=[];function visit(base,relative=''){for(const name of readdirSync(base).sort()){const path=relative?relative+'/'+name:name,absolute=join(base,name),stat=lstatSync(absolute);if(stat.isDirectory())visit(absolute,path);else if(stat.isSymbolicLink())entries.push({path,symlink:readlinkSync(absolute)});else if(stat.isFile()){const bytes=readFileSync(absolute);entries.push({path,bytes:bytes.length,sha256:hash(bytes)});}else throw Error('Unsupported runtime entry '+path);}}visit(runtime);
assert.deepEqual(entries,JSON.parse(readFileSync(join(prior,'installed-files.json'))),'New runtime must equal the previously qualified full installed closure');
writeFileSync(join(here,'runtime-files.json'),JSON.stringify(entries,null,2)+'\n',{flag:'wx'});
writeFileSync(join(here,'preparation.json'),JSON.stringify({schemaVersion:1,preparedAt:new Date().toISOString(),elapsedMs:performance.now()-start,runtime,version:npm.version,sourceCommit:npm.gitHead,archive:npm.dist,sourceReceipts:receipts,runtimeFiles:entries.length,runtimeBytes:entries.reduce((n,e)=>n+(e.bytes??0),0),runtimeManifestSha256:hash(readFileSync(join(here,'runtime-files.json'))),priorManifestSha256:hash(readFileSync(join(prior,'installed-files.json'))),copyPolicy:'Independent APFS cloned files and verbatim relative symlinks. No install or mutation of the earlier runtime or root dependencies.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({prepared:true,runtime,files:entries.length,elapsedMs:performance.now()-start}));
