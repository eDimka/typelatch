import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { packageEvidence } from './evidence.mjs'
const runtimeRoot=resolve('artifacts/paired-agent/candidate/runtime/node_modules/typelatch')
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'typelatch-package-evidence-'))
 const put=(path,text)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof text==='string'?text:JSON.stringify(text,null,2)+'\n')}
 put('package.json',{private:true,workspaces:['packages/*']})
 put('tsconfig.json',{compilerOptions:{target:'ES2022',module:'CommonJS',moduleResolution:'node',strict:true},include:['packages/*/src/**/*.ts'],exclude:['**/excluded.ts']})
 for(const name of ['api','consumer','barrel','indirect','versioned'])put(`packages/${name}/package.json`,{name:`@demo/${name}`,version:'1.0.0',types:'src/index.ts',directories:{test:'test'},scripts:{test:'node tests.js',compile:'tsc'},...(name==='api'?{}:{dependencies:{[name==='indirect'?'@demo/barrel':'@demo/api']:'workspace:*'}})})
 put('packages/api/src/index.ts','export function parse(value: string) { return value }\nexport interface Result { value: string }\n')
 put('packages/consumer/src/index.ts','import { parse as decode, type Result } from "@demo/api"\nexport const result: Result = { value: decode("ok") }\nfunction isolated(decode: (value: string) => string) { return decode("local") }\n')
 put('packages/consumer/src/excluded.ts','import { parse } from "@demo/api"\nparse("excluded")\n')
 put('packages/consumer/test/index.ts','import { parse } from "@demo/api"\nparse("test")\n')
 put('packages/barrel/src/index.ts','export { parse as read } from "@demo/api"\n')
 put('packages/indirect/src/index.ts','import { read } from "@demo/barrel"\nexport const result = read("indirect")\n')
 put('packages/versioned/src/index.ts','import { parse } from "@demo/api"\nexport const result = parse("external")\n')
 put('external-api/package.json',{name:'@demo/api',version:'2.0.0',types:'index.d.ts'})
 put('external-api/index.d.ts','export declare function parse(value: string): number\n')
 mkdirSync(join(root,'node_modules/@demo'),{recursive:true})
 for(const name of ['api','barrel'])symlinkSync(`../../packages/${name}`,join(root,`node_modules/@demo/${name}`))
 mkdirSync(join(root,'packages/versioned/node_modules/@demo'),{recursive:true})
 symlinkSync('../../../../external-api',join(root,'packages/versioned/node_modules/@demo/api'))
 return {root,put,close:()=>rmSync(root,{recursive:true,force:true})}
}
test('configured cross-package aliases and reexports retain identity; other versions and shadows do not become users',async()=>{
 const f=fixture();try{
  const result=await packageEvidence({workspaceRoot:f.root,package:'@demo/api',exports:['parse','Result']},{runtimeRoot})
  assert.equal(result.target.version,'1.0.0')
  assert.deepEqual(result.direct.map(r=>`${r.file}|${r.symbol}|${r.role}`).sort(),[
   'packages/barrel/src/index.ts|parse|reexport',
   'packages/consumer/src/index.ts|parse|runtime',
   'packages/consumer/src/index.ts|Result|type-only',
   'packages/indirect/src/index.ts|parse|runtime',
  ].sort())
  assert(!result.direct.some(row=>row.occurrences.some(item=>item.line===3)))
  assert(!result.packageDependents.some(row=>row.package==='@demo/versioned'))
  assert(result.packageDependents.some(row=>JSON.stringify(row.chain)===JSON.stringify(['@demo/indirect','@demo/barrel','@demo/api'])))
  assert(result.excluded.some(row=>row.reason==='other-package-instance'))
  assert(result.validationTargets.some(row=>row.package==='@demo/consumer'&&row.script==='test'&&row.evidence.quote.includes('"test": "node tests.js"')))
 }finally{f.close()}
})
test('unknown exports and missing compiler resolution are explicit, not empty complete evidence',async()=>{
 const f=fixture();try{
  const result=await packageEvidence({workspaceRoot:f.root,package:'@demo/api',exports:['missing']},{runtimeRoot})
  assert.equal(result.status,'partial');assert(result.issues.some(row=>row.code==='unknown-export'));assert.equal(result.direct.length,0)
 }finally{f.close()}
})
