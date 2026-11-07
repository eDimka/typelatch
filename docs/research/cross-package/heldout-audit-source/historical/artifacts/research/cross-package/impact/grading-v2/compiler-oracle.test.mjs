import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { deriveOracle } from './compiler-oracle.mjs'

test('declaration-impact oracle rejects facade slots and collapsed aliases',()=>{
 const root=mkdtempSync(join(tmpdir(),'impact-v2-identity-'))
 const put=(path,value)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value))}
 try {
  put('package.json',{name:'fixture-root',private:true})
  put('tsconfig.json',{compilerOptions:{baseUrl:'.',module:'commonjs',target:'es2022',paths:{a:['packages/a/src/index.ts'],b:['packages/b/src/index.ts']}},include:['packages/*/src/**/*.ts']})
  put('packages/a/package.json',{name:'a',version:'1.0.0'})
  put('packages/a/src/index.ts','export function foo() { return 1 }\nexport { foo as parse, foo as read }\n')
  put('packages/b/package.json',{name:'b',version:'1.0.0'})
  put('packages/b/src/index.ts','export { foo as publicFoo } from "a"\n')
  put('packages/c/package.json',{name:'c',version:'1.0.0'})
  put('packages/c/src/index.ts','import { foo } from "a"\nimport { publicFoo } from "b"\nimport * as api from "a"\nfoo(); publicFoo()\napi["foo"]()\n')
  mkdirSync(join(root,'node_modules'),{recursive:true})
  symlinkSync(realpathSync(resolve('artifacts/research/cross-package/impact/pnpm-workspace/node_modules/typescript')),join(root,'node_modules/typescript'))
  const receipt=join(root,'receipt.json');writeFileSync(receipt,JSON.stringify({stdout:JSON.stringify(['a','b','c'].map(name=>({name,path:join(root,'packages',name)})))}))
  const query={workspace:root,workspaceReceipt:receipt,config:'tsconfig.json'}
  const declared=deriveOracle({...query,targetPackage:'a',exports:['foo'],entry:'packages/a/src/index.ts'})
  assert.equal(declared.target.identityMode,'defining-package-declaration-impact')
  assert(declared.direct.some(row=>row.file==='packages/c/src/index.ts'&&row.role==='runtime'))
  const literal=declared.direct.find(row=>row.file==='packages/c/src/index.ts'&&row.role==='runtime')
  assert(literal.occurrences.some(row=>row.line===5),'Static literal member access is a compiler-bound use')
  assert(!declared.exclusionCandidates.some(row=>row.file==='packages/c/src/index.ts'&&row.symbol==='foo'&&row.reason==='string-or-comment-only'),'Static member keys are not text-only exclusions')
  assert.throws(()=>deriveOracle({...query,targetPackage:'b',exports:['publicFoo'],entry:'packages/b/src/index.ts'}),/defined outside/)
  assert.throws(()=>deriveOracle({...query,targetPackage:'a',exports:['parse','read'],entry:'packages/a/src/index.ts'}),/slots share one declaration/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
