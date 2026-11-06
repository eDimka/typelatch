import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createNative } from './native.mjs'
test('native helpers retain scope, alias identity and explicit omissions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'typelatch-native-screen-'));await mkdir(join(root,'src'));await mkdir(join(root,'node_modules'))
 await writeFile(join(root,'package.json'),JSON.stringify({name:'scratch',version:'1.0.0'}));await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{moduleResolution:'node'},include:['src']}))
 await writeFile(join(root,'src/index.ts'),"import { sync } from 'alias'; export const answer=sync('a')\n");await writeFile(join(root,'src/other.ts'),'export const unrelated=1\n')
 await symlink(resolve('node_modules/typescript'),join(root,'node_modules/typescript'),'dir');await mkdir(join(root,'node_modules/alias'))
 await writeFile(join(root,'node_modules/alias/package.json'),JSON.stringify({name:'real-package',version:'2.0.0',types:'index.d.ts'}));await writeFile(join(root,'node_modules/alias/index.d.ts'),'export declare function sync(x:string):number\n')
 // The compiler runtime is external, while every selected evidence file must stay inside the corpus.
 const native=await createNative(root);const found=await native.search({pattern:'answer'});assert.equal(found.matches.length,1);assert.equal(found.matches[0].file,'src/index.ts')
 const pkg=await native.package({file:'src/index.ts',importSpecifier:'alias'});assert.equal(pkg.package.name,'real-package');assert.equal(pkg.package.version,'2.0.0')
 assert.equal((await native.configs({files:['src/index.ts']})).files[0].configs.length,1)
 const absent=await native.search({pattern:'notHere',fixed:true});assert.equal(absent.matchCount,0);assert.equal(absent.omitted,false)
 await assert.rejects(native.read({files:[{path:'../secret'}]}),/outside corpus/)
 await mkdir(join(root,'node_modules/runtime-only'));await mkdir(join(root,'node_modules/@types/runtime-only'),{recursive:true})
 await writeFile(join(root,'node_modules/runtime-only/package.json'),JSON.stringify({name:'runtime-only',version:'6.0.0',main:'index.js'}));await writeFile(join(root,'node_modules/runtime-only/index.js'),'module.exports=function(){}\n')
 await writeFile(join(root,'node_modules/@types/runtime-only/package.json'),JSON.stringify({name:'@types/runtime-only',version:'5.0.0',types:'index.d.ts'}));await writeFile(join(root,'node_modules/@types/runtime-only/index.d.ts'),'declare function Runtime():void; export = Runtime\n')
 const externalTypes=await native.package({file:'src/index.ts',importSpecifier:'runtime-only'});assert.equal(externalTypes.package.name,'runtime-only');assert.equal(externalTypes.package.version,'6.0.0')
 await writeFile(join(root,'pnpm-workspace.yaml'),"packages:\n  - 'packages/*'\n  - '!packages/excluded'\n")
 for(const path of ['packages/real','packages/excluded','fixtures/decoy']){await mkdir(join(root,path),{recursive:true});await writeFile(join(root,path,'package.json'),JSON.stringify({name:path,dependencies:{target:'1.0.0'}}))}
 assert.deepEqual((await native.manifests({packageName:'target'})).matches.map(x=>x.name),['packages/real'])
})
