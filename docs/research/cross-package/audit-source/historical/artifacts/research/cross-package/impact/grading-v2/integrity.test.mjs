import test from 'node:test'
import assert from 'node:assert/strict'
import { constants,cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { tmpdir } from 'node:os'

test('v2 accepts only the answer and rejects source and dependency mutations',async()=>{
 const base=resolve('artifacts/research/cross-package/impact/development-v2'),descriptor=JSON.parse(readFileSync(join(base,'descriptor.json'))),gold=JSON.parse(readFileSync(join(base,'gold-answer.json'))),initial=JSON.parse(readFileSync(descriptor.initialManifest)),{gradeWorkspace}=await import(descriptor.graderModule),temp=mkdtempSync(join(tmpdir(),'impact-v2-integrity-')),workspace=join(temp,'workspace')
 try {
  cpSync(descriptor.workspace,workspace,{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE_FORCE})
  const absent=gradeWorkspace(workspace,initial);assert.equal(absent.passed,false);assert.deepEqual(absent.integrity.changed,[])
  writeFileSync(join(workspace,'impact-answer.json'),JSON.stringify(gold));assert.equal(gradeWorkspace(workspace,initial).passed,true)
  const file=gold.direct[0].file,source=join(workspace,file),original=readFileSync(source)
  writeFileSync(source,Buffer.concat([original,Buffer.from('\n// mutation\n')]));const changed=gradeWorkspace(workspace,initial);assert.equal(changed.passed,false);assert(changed.integrity.changed.includes(file));writeFileSync(source,original)
  const dependency='node_modules/.pnpm/typescript@5.5.4/node_modules/typescript/package.json',dep=join(workspace,dependency),before=readFileSync(dep)
  writeFileSync(dep,Buffer.concat([before,Buffer.from('\n')]));const altered=gradeWorkspace(workspace,initial);assert.equal(altered.passed,false);assert(altered.integrity.changed.includes(dependency))
  assert(readFileSync(join(descriptor.workspace,file)).equals(original));assert(readFileSync(join(descriptor.workspace,dependency)).equals(before))
 }finally{rmSync(temp,{recursive:true,force:true})}
})
